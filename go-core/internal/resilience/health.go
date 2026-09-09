// Package resilience provides shared model health and request-driven circuit probes.
package resilience

import (
	"math"
	"sync"
	"time"

	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/decision"
)

type Config struct {
	CircuitBreakerFailures int
	CircuitBreakerCooldown time.Duration
}

type Outcome struct {
	OK            bool
	Status        int
	Err           error
	ClientGone    bool
	Scope         string
	OutputStarted bool
	NoRetry       bool
	Latency       time.Duration
}

type Classification struct {
	Scope             string
	CountModelFailure bool
	Retryable         bool
}

// Classify follows src/health.mjs. Retry safety additionally requires that no
// response output has reached the client. ClientGone must come from the client
// context, not an upstream timeout (which is evidence of provider failure).
func Classify(o Outcome) Classification {
	if o.ClientGone || (o.Err != nil && o.Err.Error() == "client_disconnected") {
		return Classification{Scope: "client"}
	}
	if o.OK {
		return Classification{Scope: "success"}
	}
	switch o.Status {
	case 401:
		return Classification{Scope: "credential"}
	case 402, 403:
		return Classification{Scope: "entitlement"}
	case 429:
		return Classification{Scope: "rate_limit"}
	}
	if o.Status >= 400 && o.Status < 500 && o.Status != 408 {
		return Classification{Scope: "request"}
	}
	if o.Scope == "capacity" || o.Scope == "configuration" {
		return Classification{Scope: o.Scope}
	}
	return Classification{Scope: "provider", CountModelFailure: true, Retryable: !o.NoRetry && !o.OutputStarted}
}

type State struct {
	CircuitState        string  `json:"circuitState"`
	ProbeInFlight       bool    `json:"probeInFlight"`
	ConsecutiveFailures int     `json:"consecutiveFailures"`
	Successes           int     `json:"successes"`
	Failures            int     `json:"failures"`
	EWMALatencyMs       float64 `json:"ewmaLatencyMs"`
	CircuitOpenUntil    int64   `json:"circuitOpenUntil"`
	LastSuccessAt       int64   `json:"lastSuccessAt"`
	DownSince           int64   `json:"downSince"`
	HalfOpenFailStreak  int     `json:"halfOpenFailStreak"`
	LastFailureAt       int64   `json:"lastFailureAt"`
	epoch               uint64
}

type Manager struct {
	mu     sync.Mutex
	cfg    Config
	states map[string]*State
	now    func() time.Time
}

func normalize(c Config) Config {
	if c.CircuitBreakerFailures <= 0 {
		c.CircuitBreakerFailures = 3
	}
	if c.CircuitBreakerCooldown <= 0 {
		c.CircuitBreakerCooldown = 30 * time.Second
	}
	return c
}

func New(c Config) *Manager {
	return &Manager{cfg: normalize(c), states: make(map[string]*State), now: time.Now}
}

// UpdateConfig changes thresholds for subsequent outcomes without clearing live
// health or probe ownership. An existing open circuit retains its deadline.
func (m *Manager) UpdateConfig(c Config) { m.mu.Lock(); defer m.mu.Unlock(); m.cfg = normalize(c) }

type Attempt struct {
	m              *Manager
	model          string
	epoch          uint64
	probe          bool
	cfg            Config
	once           sync.Once
	classification Classification
}

// Acquire is the authoritative atomic gate. No synthetic or paid probe calls
// are scheduled: the first real request after cooldown owns the sole probe.
func (m *Manager) Acquire(model string) (*Attempt, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.acquire(model, m.cfg)
}

// AcquireWithConfig pins this request's immutable configuration while sharing
// circuit state with requests from other configuration generations.
func (m *Manager) AcquireWithConfig(model string, cfg Config) (*Attempt, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.acquire(model, normalize(cfg))
}

func (m *Manager) acquire(model string, cfg Config) (*Attempt, bool) {
	s := m.states[model]
	if s == nil {
		s = &State{CircuitState: "closed"}
		m.states[model] = s
	}
	if s.CircuitState == "open" {
		if s.CircuitOpenUntil > m.now().UnixMilli() {
			return nil, false
		}
		s.CircuitState = "half_open"
	}
	probe := s.CircuitState == "half_open"
	if probe {
		if s.ProbeInFlight {
			return nil, false
		}
		s.ProbeInFlight = true
	}
	return &Attempt{m: m, model: model, epoch: s.epoch, probe: probe, cfg: cfg}, true
}

// Finish must be called on every acquired attempt, including cancellations and
// local rejection paths. Repeated or concurrent calls have exactly one effect.
func (a *Attempt) Finish(o Outcome) Classification {
	a.once.Do(func() {
		a.classification = Classify(o)
		m := a.m
		m.mu.Lock()
		defer m.mu.Unlock()
		s := m.states[a.model]
		if a.probe && a.epoch == s.epoch {
			s.ProbeInFlight = false
		}
		if a.classification.Scope != "success" && !a.classification.CountModelFailure {
			return
		}
		now := m.now().UnixMilli()
		latency := math.Max(0, float64(o.Latency)/float64(time.Millisecond))
		if s.EWMALatencyMs != 0 {
			s.EWMALatencyMs = math.Floor(s.EWMALatencyMs*0.8 + latency*0.2 + 0.5)
		} else {
			s.EWMALatencyMs = latency
		}
		if a.classification.Scope == "success" {
			s.Successes++
			s.LastSuccessAt = now
		} else {
			s.Failures++
			s.LastFailureAt = now
		}
		// Earlier in-flight requests may finish after a circuit opens. Count
		// their observations, but never let them steal or release a newer probe.
		if a.epoch != s.epoch {
			return
		}
		if a.classification.Scope == "success" {
			s.CircuitState = "closed"
			s.ConsecutiveFailures = 0
			s.CircuitOpenUntil = 0
			s.DownSince = 0
			s.HalfOpenFailStreak = 0
			if a.probe {
				s.epoch++
			}
			return
		}
		s.ConsecutiveFailures++
		if a.probe {
			s.HalfOpenFailStreak++
		}
		if a.probe || s.ConsecutiveFailures >= a.cfg.CircuitBreakerFailures {
			s.CircuitState = "open"
			s.CircuitOpenUntil = now + a.cfg.CircuitBreakerCooldown.Milliseconds()
			if s.DownSince == 0 {
				s.DownSince = now
			}
			s.epoch++
		}
	})
	return a.classification
}

func (m *Manager) States() map[string]State {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make(map[string]State, len(m.states))
	for id, s := range m.states {
		out[id] = *s
	}
	return out
}

// Snapshot feeds the routing decision engine; Acquire still guards the race
// between selection and execution. Occupied half-open probes are unavailable.
func (m *Manager) Snapshot() map[string]decision.Health {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make(map[string]decision.Health, len(m.states))
	for id, s := range m.states {
		until := s.CircuitOpenUntil
		if s.ProbeInFlight {
			until = m.now().UnixMilli() + max(1, m.cfg.CircuitBreakerCooldown.Milliseconds())
		}
		out[id] = decision.Health{CircuitOpenUntil: float64(until), EWMALatencyMs: s.EWMALatencyMs, ConsecutiveFailures: float64(s.ConsecutiveFailures)}
	}
	return out
}

// OfflineAlertDue mirrors the evidence window and duration in src/health.mjs.
func OfflineAlertDue(s State, now time.Time) bool {
	if s.DownSince == 0 || s.CircuitState == "closed" || s.LastFailureAt == 0 || now.UnixMilli()-s.LastFailureAt > 600000 {
		return false
	}
	down := now.UnixMilli() - s.DownSince
	return down >= 1800000 || (s.HalfOpenFailStreak >= 3 && down >= 600000)
}
