package gateway

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/auth"
	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/decision"
)

func managedBundle() Bundle {
	b := Bundle{Revision: `"` + strings.Repeat("a", 64) + `"`, Semantic: reviewPolicy(), Runtime: RuntimePolicy{MaxAttempts: 2, RequestTimeoutMS: 2000, CircuitBreakerFailures: 2, CircuitBreakerCooldownMS: 30000, TimeZone: "UTC", BudgetEnabled: true, DailyLimitMicros: 1000000}}
	b.Analysis.TaskRules.SimpleMaxComplexity = .34
	b.Analysis.TaskRules.ComplexMinComplexity = .7
	b.Analysis.Budget.DefaultEstimatedOutputTokens = 64
	b.Semantic.Enabled = false
	one := 1.0
	b.Runtime.Prices = map[string]Price{"model-a": {Input: &one, Output: &one}, "model-b": {Input: &one, Output: &one}}
	return b
}

func managedInput() decision.Input {
	in := inputFixture()
	in.Models[0].Capacity = 8
	in.Models = append(in.Models, decision.Model{ID: "model-b", Enabled: true, Ownership: "self_hosted", Quality: .88, Capacity: 8})
	return in
}

func managedLab(t *testing.T, in decision.Input, bundle Bundle, upstream http.HandlerFunc) (*Managed, *httptest.Server) {
	t.Helper()
	adapter := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+assessorToken {
			t.Error("adapter credential mismatch")
		}
		switch r.URL.Path {
		case "/runtime-config":
			if r.Method != "GET" {
				t.Error("runtime config method changed")
			}
			_ = json.NewEncoder(w).Encode(bundle)
		case "/assess":
			if r.Method != "POST" || r.Header.Get("X-AMR-Native-Analysis") != "1" {
				t.Error("assessment protocol changed")
			}
			w.Header().Set("X-AMR-Config-Revision", bundle.Revision)
			_ = json.NewEncoder(w).Encode(in)
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(adapter.Close)
	u := httptest.NewServer(upstream)
	t.Cleanup(u.Close)
	m, err := NewManaged(ManagedOptions{Gateway: Options{AssessorURL: adapter.URL + "/assess", UpstreamURL: u.URL + "/v1/chat/completions", AssessorToken: assessorToken, AssessmentTimeout: time.Second, MaxRequests: 32}, Auth: auth.Config{Mode: "strict", AccessToken: accessToken, UpstreamToken: "mock-upstream-secret", AdminToken: "test-admin-secret-123456"}, LedgerPath: filepath.Join(t.TempDir(), "ledger.jsonl")})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.Close)
	s := httptest.NewServer(m)
	t.Cleanup(s.Close)
	return m, s
}

func managedIdle(t *testing.T, m *Managed) {
	t.Helper()
	eventually(t, func() bool {
		m.mu.Lock()
		active := 0
		for g := range m.all {
			active += g.refs
		}
		m.mu.Unlock()
		return active == 0 && len(m.state.admission.Snapshot()) == 0 && m.state.ledger.Snapshot().PendingReserves == 0
	})
}

func managedEvents(t *testing.T, m *Managed) []attemptEvent {
	t.Helper()
	managedIdle(t, m)
	raw, err := os.ReadFile(m.options.LedgerPath + ".events.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	var events []attemptEvent
	s := bufio.NewScanner(strings.NewReader(string(raw)))
	for s.Scan() {
		var event attemptEvent
		if err := json.Unmarshal(s.Bytes(), &event); err != nil {
			t.Fatal(err)
		}
		events = append(events, event)
	}
	if err := s.Err(); err != nil {
		t.Fatal(err)
	}
	return events
}

const runtimeRequest = `{"model":"auto","max_tokens":64,"messages":[{"role":"user","content":"Extract a name from Alice."}]}`
const runtimeStreamRequest = `{"model":"auto","stream":true,"max_tokens":64,"messages":[{"role":"user","content":"Extract a name from Alice."}]}`
const runtimeAnswer = `{"choices":[{"message":{"content":"Alice"}}],"usage":{"prompt_tokens":10,"completion_tokens":5}}`
const runtimeChunk = "data: {\"choices\":[{\"delta\":{\"content\":\"Alice\"}}]}\n\n"
const runtimeEnd = "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5}}\n\ndata: [DONE]\n\n"

func TestManagedFallbackBillsEachAttempt(t *testing.T) {
	var mu sync.Mutex
	var models []string
	m, s := managedLab(t, managedInput(), managedBundle(), func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer mock-upstream-secret" {
			t.Error("credential isolation failed")
		}
		var body struct {
			Model string `json:"model"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		models = append(models, body.Model)
		mu.Unlock()
		if body.Model == "model-a" {
			w.WriteHeader(500)
			return
		}
		_, _ = io.WriteString(w, runtimeAnswer)
	})
	res, err := http.DefaultClient.Do(request(context.Background(), s.URL, runtimeRequest))
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 200 || res.Header.Get("X-AMR-Selected-Model") != "model-b" || !strings.Contains(string(body), "Alice") {
		t.Fatalf("fallback failed %d %s", res.StatusCode, body)
	}
	events := managedEvents(t, m)
	mu.Lock()
	gotModels := strings.Join(models, ",")
	mu.Unlock()
	if gotModels != "model-a,model-b" || len(events) != 2 {
		t.Fatalf("unexpected attempts %s %+v", gotModels, events)
	}
	if events[0].EstimatedMicros == nil || *events[0].EstimatedMicros <= 0 || events[0].ActualMicros != nil || events[0].Outcome != "provider" {
		t.Fatalf("failed attempt lost estimate %+v", events[0])
	}
	if events[1].ActualMicros == nil || *events[1].ActualMicros != 15 || events[1].Outcome != "success" || events[1].RequestID != events[0].RequestID || events[1].Attempt == events[0].Attempt {
		t.Fatalf("successful attempt billing %+v", events[1])
	}
	snap := m.state.ledger.Snapshot()
	if snap.ActualMicros != 15 || snap.EstimatedMicros != *events[0].EstimatedMicros || snap.PendingMicros != 0 {
		t.Fatalf("ledger mismatch %+v", snap)
	}
	states := m.state.health.States()
	if states["model-a"].Failures != 1 || states["model-b"].Successes != 1 {
		t.Fatalf("wrong model health %+v", states)
	}
}

func TestManagedRejectionsNeverRetryOrOpenCircuit(t *testing.T) {
	for _, status := range []int{401, 403, 429} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			var calls atomic.Int32
			bundle := managedBundle()
			bundle.Runtime.CircuitBreakerFailures = 1
			m, s := managedLab(t, managedInput(), bundle, func(w http.ResponseWriter, r *http.Request) { calls.Add(1); w.WriteHeader(status) })
			res, err := http.DefaultClient.Do(request(context.Background(), s.URL, runtimeRequest))
			if err != nil {
				t.Fatal(err)
			}
			io.Copy(io.Discard, res.Body)
			res.Body.Close()
			managedIdle(t, m)
			if res.StatusCode != status || calls.Load() != 1 {
				t.Fatalf("rejection retried or status changed: %d calls=%d", res.StatusCode, calls.Load())
			}
			if state := m.state.health.States()["model-a"]; state.Failures != 0 || state.CircuitState != "closed" {
				t.Fatalf("credential/quota poisoned health %+v", state)
			}
		})
	}
}

func TestManagedPartialSSEHasNoRetryAndRetainsEstimate(t *testing.T) {
	var calls atomic.Int32
	m, s := managedLab(t, managedInput(), managedBundle(), func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, runtimeChunk)
		w.(http.Flusher).Flush()
	})
	res, err := http.DefaultClient.Do(request(context.Background(), s.URL, runtimeStreamRequest))
	if err != nil {
		t.Fatal(err)
	}
	body, readErr := io.ReadAll(res.Body)
	res.Body.Close()
	if readErr == nil || !strings.Contains(string(body), "Alice") || strings.Contains(string(body), "[DONE]") || strings.Contains(string(body), "upstream_unavailable") {
		t.Fatalf("partial stream was disguised: %q err=%v", body, readErr)
	}
	events := managedEvents(t, m)
	if calls.Load() != 1 || len(events) != 1 || events[0].ActualMicros != nil || events[0].EstimatedMicros == nil {
		t.Fatalf("partial stream retried or billing lost %+v", events)
	}
	if snap := m.state.ledger.Snapshot(); snap.EstimatedMicros <= 0 || snap.PendingMicros != 0 || snap.ActualMicros != 0 {
		t.Fatalf("estimate missing %+v", snap)
	}
}

func TestManagedStreamTimeoutIsIdleBased(t *testing.T) {
	t.Run("continued output survives total duration", func(t *testing.T) {
		var calls atomic.Int32
		bundle := managedBundle()
		bundle.Runtime.RequestTimeoutMS = 300
		m, s := managedLab(t, managedInput(), bundle, func(w http.ResponseWriter, r *http.Request) {
			calls.Add(1)
			w.Header().Set("Content-Type", "text/event-stream")
			for i := 0; i < 6; i++ {
				io.WriteString(w, runtimeChunk)
				w.(http.Flusher).Flush()
				select {
				case <-r.Context().Done():
					return
				case <-time.After(100 * time.Millisecond):
				}
			}
			io.WriteString(w, runtimeEnd)
		})
		started := time.Now()
		res, err := http.DefaultClient.Do(request(context.Background(), s.URL, runtimeStreamRequest))
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(res.Body)
		res.Body.Close()
		if err != nil || !strings.Contains(string(body), "[DONE]") || time.Since(started) < 500*time.Millisecond {
			t.Fatalf("active stream aborted err=%v body=%s", err, body)
		}
		managedIdle(t, m)
		if calls.Load() != 1 || m.state.ledger.Snapshot().ActualMicros != 15 {
			t.Fatal("active stream did not settle once")
		}
	})
	t.Run("stalled output cancels provider without retry", func(t *testing.T) {
		var calls atomic.Int32
		bundle := managedBundle()
		bundle.Runtime.RequestTimeoutMS = 100
		m, s := managedLab(t, managedInput(), bundle, func(w http.ResponseWriter, r *http.Request) {
			calls.Add(1)
			w.Header().Set("Content-Type", "text/event-stream")
			io.WriteString(w, runtimeChunk)
			w.(http.Flusher).Flush()
			<-r.Context().Done()
		})
		started := time.Now()
		res, err := http.DefaultClient.Do(request(context.Background(), s.URL, runtimeStreamRequest))
		if err != nil {
			t.Fatal(err)
		}
		_, err = io.ReadAll(res.Body)
		res.Body.Close()
		if err == nil || time.Since(started) > time.Second {
			t.Fatalf("idle timeout not enforced %v", err)
		}
		managedIdle(t, m)
		if calls.Load() != 1 || m.state.health.States()["model-a"].Failures != 1 {
			t.Fatal("idle timeout retried or lost health evidence")
		}
	})
}

func TestManagedClientCancellationReleasesAllReservations(t *testing.T) {
	var calls atomic.Int32
	entered := make(chan struct{})
	m, s := managedLab(t, managedInput(), managedBundle(), func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		if calls.Add(1) == 1 {
			close(entered)
		}
		<-r.Context().Done()
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		res, err := http.DefaultClient.Do(request(ctx, s.URL, runtimeRequest))
		if res != nil {
			res.Body.Close()
		}
		done <- err
	}()
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("upstream never called")
	}
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("cancelled request succeeded")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("cancellation stuck")
	}
	events := managedEvents(t, m)
	if calls.Load() != 1 || len(events) != 1 || events[0].Outcome != "client" {
		t.Fatalf("cancellation retried %+v", events)
	}
	if state := m.state.health.States()["model-a"]; state.Failures != 0 || state.ProbeInFlight {
		t.Fatalf("cancellation damaged health %+v", state)
	}
	if snap := m.state.ledger.Snapshot(); snap.PendingReserves != 0 || snap.PendingMicros != 0 || snap.EstimatedMicros <= 0 {
		t.Fatalf("cancelled sent attempt unsettled %+v", snap)
	}
}
