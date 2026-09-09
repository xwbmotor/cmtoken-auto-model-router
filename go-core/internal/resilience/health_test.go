package resilience

import (
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestClassification(t *testing.T) {
	for _, tc := range []struct {
		name          string
		o             Outcome
		scope         string
		health, retry bool
	}{
		{"success", Outcome{OK: true}, "success", false, false},
		{"credential", Outcome{Status: 401}, "credential", false, false},
		{"payment", Outcome{Status: 402}, "entitlement", false, false},
		{"forbidden", Outcome{Status: 403}, "entitlement", false, false},
		{"quota", Outcome{Status: 429}, "rate_limit", false, false},
		{"bad request", Outcome{Status: 400}, "request", false, false},
		{"not found", Outcome{Status: 404}, "request", false, false},
		{"timeout", Outcome{Status: 408}, "provider", true, true},
		{"unavailable", Outcome{Status: 503}, "provider", true, true},
		{"transport", Outcome{Err: errors.New("connection reset")}, "provider", true, true},
		{"client cancellation", Outcome{ClientGone: true, Status: 503}, "client", false, false},
		{"legacy cancellation", Outcome{Err: errors.New("client_disconnected")}, "client", false, false},
		{"local capacity", Outcome{Scope: "capacity"}, "capacity", false, false},
		{"configuration", Outcome{Scope: "configuration"}, "configuration", false, false},
		{"stream started", Outcome{Status: 503, OutputStarted: true}, "provider", true, false},
		{"explicit unsafe", Outcome{Status: 503, NoRetry: true}, "provider", true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := Classify(tc.o)
			if got.Scope != tc.scope || got.CountModelFailure != tc.health || got.Retryable != tc.retry {
				t.Fatalf("got %+v", got)
			}
		})
	}
}

func fixture() (*Manager, *time.Time) {
	now := time.Unix(1700000000, 0)
	m := New(Config{CircuitBreakerFailures: 2, CircuitBreakerCooldown: time.Second})
	m.now = func() time.Time { return now }
	return m, &now
}

func finish(t *testing.T, m *Manager, o Outcome) {
	t.Helper()
	a, ok := m.Acquire("a")
	if !ok {
		t.Fatal("unexpected refusal")
	}
	a.Finish(o)
}

func TestCircuitLifecycle(t *testing.T) {
	m, now := fixture()
	finish(t, m, Outcome{Status: 500, Latency: 100 * time.Millisecond})
	if s := m.States()["a"]; s.DownSince != 0 || s.CircuitState != "closed" {
		t.Fatalf("one failure marked down: %+v", s)
	}
	finish(t, m, Outcome{Status: 503, Latency: 200 * time.Millisecond})
	s := m.States()["a"]
	if s.CircuitState != "open" || s.EWMALatencyMs != 120 || s.DownSince != now.UnixMilli() {
		t.Fatalf("bad open state %+v", s)
	}
	if _, ok := m.Acquire("a"); ok {
		t.Fatal("open circuit admitted request")
	}
	*now = now.Add(time.Second)
	probe, ok := m.Acquire("a")
	if !ok {
		t.Fatal("missing probe")
	}
	if m.Snapshot()["a"].CircuitOpenUntil <= float64(now.UnixMilli()) {
		t.Fatal("occupied probe not excluded from decision")
	}
	if _, ok := m.Acquire("a"); ok {
		t.Fatal("second probe admitted")
	}
	probe.Finish(Outcome{Status: 500})
	if s := m.States()["a"]; s.HalfOpenFailStreak != 1 || s.DownSince != now.Add(-time.Second).UnixMilli() {
		t.Fatalf("bad probe failure %+v", s)
	}
	*now = now.Add(time.Second)
	finish(t, m, Outcome{OK: true})
	s = m.States()["a"]
	if s.CircuitState != "closed" || s.ConsecutiveFailures != 0 || s.DownSince != 0 || s.HalfOpenFailStreak != 0 || s.Successes != 1 || s.Failures != 3 {
		t.Fatalf("bad recovery %+v", s)
	}
}

func TestNoEvidenceReleasesProbeWithoutRecovery(t *testing.T) {
	for _, o := range []Outcome{{ClientGone: true}, {Status: 401}, {Status: 402}, {Status: 403}, {Status: 429}, {Status: 400}, {Scope: "configuration"}} {
		m, now := fixture()
		finish(t, m, Outcome{Status: 500})
		finish(t, m, Outcome{Status: 500})
		*now = now.Add(time.Second)
		finish(t, m, o)
		if s := m.States()["a"]; s.ProbeInFlight || s.CircuitState != "half_open" || s.Failures != 2 || s.Successes != 0 {
			t.Fatalf("non-evidence changed health %+v", s)
		}
		if _, ok := m.Acquire("a"); !ok {
			t.Fatal("released probe could not be reacquired")
		}
	}
}

func TestConcurrentSingleProbeAndExactlyOnceFinish(t *testing.T) {
	m, now := fixture()
	finish(t, m, Outcome{Status: 500})
	finish(t, m, Outcome{Status: 500})
	*now = now.Add(time.Second)
	var accepted atomic.Int64
	var wg sync.WaitGroup
	var probe *Attempt
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if a, ok := m.Acquire("a"); ok {
				accepted.Add(1)
				probe = a
			}
		}()
	}
	wg.Wait()
	if accepted.Load() != 1 {
		t.Fatalf("admitted %d probes", accepted.Load())
	}
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); probe.Finish(Outcome{OK: true}); m.Snapshot(); m.States() }()
	}
	wg.Wait()
	if s := m.States()["a"]; s.Successes != 1 {
		t.Fatalf("Finish counted multiple times %+v", s)
	}
}

func TestStaleAttemptCannotReleaseNewProbe(t *testing.T) {
	m, now := fixture()
	old, _ := m.Acquire("a")
	finish(t, m, Outcome{Status: 500})
	finish(t, m, Outcome{Status: 500})
	*now = now.Add(time.Second)
	probe, _ := m.Acquire("a")
	old.Finish(Outcome{OK: true})
	if _, ok := m.Acquire("a"); ok {
		t.Fatal("stale completion released new probe")
	}
	probe.Finish(Outcome{OK: true})
	if _, ok := m.Acquire("a"); !ok {
		t.Fatal("recovery did not close")
	}
}

func TestConfigCapturedPerAttempt(t *testing.T) {
	m, now := fixture()
	a, _ := m.AcquireWithConfig("a", Config{CircuitBreakerFailures: 1, CircuitBreakerCooldown: 2 * time.Second})
	m.UpdateConfig(Config{CircuitBreakerFailures: 10, CircuitBreakerCooldown: time.Minute})
	a.Finish(Outcome{Status: 503})
	if s := m.States()["a"]; s.CircuitState != "open" || s.CircuitOpenUntil != now.Add(2*time.Second).UnixMilli() {
		t.Fatalf("request config not pinned %+v", s)
	}
}

func TestOfflineAlertEvidence(t *testing.T) {
	now := time.Unix(1700000000, 0)
	s := State{CircuitState: "open", DownSince: now.Add(-30 * time.Minute).UnixMilli(), LastFailureAt: now.UnixMilli()}
	if !OfflineAlertDue(s, now) {
		t.Fatal("long outage absent")
	}
	s.LastFailureAt = now.Add(-11 * time.Minute).UnixMilli()
	if OfflineAlertDue(s, now) {
		t.Fatal("stale evidence alerted")
	}
	s.LastFailureAt = now.UnixMilli()
	s.DownSince = now.Add(-10 * time.Minute).UnixMilli()
	s.HalfOpenFailStreak = 3
	if !OfflineAlertDue(s, now) {
		t.Fatal("probe outage absent")
	}
	s.CircuitState = "closed"
	if OfflineAlertDue(s, now) {
		t.Fatal("recovered alerted")
	}
}
