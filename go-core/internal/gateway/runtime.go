package gateway

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"sync/atomic"
	"time"

	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/analysis"
	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/features"
	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/ledger"
	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/resilience"
	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/semantic"
)

type Bundle struct {
	Revision string           `json:"revision"`
	Features *features.Config `json:"features,omitempty"`
	Analysis analysis.Config  `json:"analysis"`
	Semantic semantic.Policy  `json:"semantic"`
	Runtime  RuntimePolicy    `json:"runtime"`
}
type RuntimePolicy struct {
	MaxAttempts              int              `json:"maxAttempts"`
	RequestTimeoutMS         int64            `json:"requestTimeoutMs"`
	CircuitBreakerFailures   int              `json:"circuitBreakerFailures"`
	CircuitBreakerCooldownMS int64            `json:"circuitBreakerCooldownMs"`
	BudgetEnabled            bool             `json:"budgetEnabled"`
	DailyLimitMicros         int64            `json:"dailyLimitMicros"`
	TimeZone                 string           `json:"timeZone"`
	CacheHitRatio            float64          `json:"cacheHitRatio"`
	Prices                   map[string]Price `json:"prices"`
}

func (b Bundle) validate() error {
	p := b.Runtime
	if len(b.Revision) != 66 {
		return errors.New("invalid revision")
	}
	if _, e := hex.DecodeString(b.Revision[1:65]); e != nil {
		return errors.New("invalid revision")
	}
	if len(b.Revision) != 66 || b.Revision[0] != '"' || b.Revision[65] != '"' || p.MaxAttempts < 1 || p.MaxAttempts > 16 || p.RequestTimeoutMS < 1 || p.RequestTimeoutMS > 3600000 || p.CircuitBreakerFailures < 1 || p.CircuitBreakerFailures > 100 || p.CircuitBreakerCooldownMS < 1 || p.CircuitBreakerCooldownMS > 86400000 || p.DailyLimitMicros < 0 || p.DailyLimitMicros > 9e15 || !validNumber(p.CacheHitRatio) || p.CacheHitRatio > 1 || len(p.Prices) == 0 || len(p.Prices) > 1024 {
		return errors.New("invalid runtime policy")
	}
	if _, e := time.LoadLocation(p.TimeZone); e != nil {
		return errors.New("invalid billing time zone")
	}
	for id, price := range p.Prices {
		if id == "" || len(id) > 256 || !price.valid() {
			return errors.New("invalid model prices")
		}
	}
	if _, e := analysis.New(b.Analysis); e != nil {
		return e
	}
	if b.Features != nil {
		builder, e := features.New(*b.Features)
		if e != nil {
			return e
		}
		ids := builder.ModelIDs()
		if len(ids) != len(p.Prices) {
			return errors.New("feature and billing model sets differ")
		}
		for _, id := range ids {
			if _, ok := p.Prices[id]; !ok {
				return errors.New("feature model has no billing policy")
			}
		}
	}
	return b.Semantic.Validate()
}
func (p RuntimePolicy) healthConfig() resilience.Config {
	return resilience.Config{CircuitBreakerFailures: p.CircuitBreakerFailures, CircuitBreakerCooldown: time.Duration(p.CircuitBreakerCooldownMS) * time.Millisecond}
}
func (p RuntimePolicy) limit() int64 {
	if p.BudgetEnabled {
		return p.DailyLimitMicros
	}
	return 0
}

type runtimeState struct {
	ledger        *ledger.Ledger
	health        *resilience.Manager
	admission     *Admission
	requests      chan struct{}
	sessionSecret []byte
	semanticGuard *semantic.Guard
	audit         *auditJournal
	failed        atomic.Bool
}

// A separate bounded-schema audit journal never serializes request bodies,
// caller headers, classifier reasons, credentials, or full upstream errors.
type attemptEvent struct {
	RequestID       string `json:"requestId"`
	Revision        string `json:"revision"`
	Model           string `json:"model"`
	Attempt         int    `json:"attempt"`
	Status          int    `json:"status"`
	Outcome         string `json:"outcome"`
	DurationMS      int64  `json:"durationMs"`
	HeaderMS        int64  `json:"headerMs"`
	FirstByteMS     int64  `json:"firstByteMs"`
	EstimatedMicros *int64 `json:"estimatedMicros"`
	ActualMicros    *int64 `json:"actualMicros"`
	At              string `json:"at"`
}

func (s *runtimeState) record(e attemptEvent) error {
	data, err := json.Marshal(e)
	if err == nil {
		err = s.audit.append(append(data, '\n'))
	}
	if err != nil {
		s.failed.Store(true)
	}
	return err
}
