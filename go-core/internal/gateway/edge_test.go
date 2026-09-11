package gateway

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/auth"
)

const edgeTestToken = "edge-test-secret-protected-token-0001"

func edgeTestManaged(t *testing.T, provider, events http.HandlerFunc) (*Managed, Bundle) {
	t.Helper()
	upstream := httptest.NewServer(provider)
	t.Cleanup(upstream.Close)
	receiver := httptest.NewServer(events)
	t.Cleanup(receiver.Close)
	dir := t.TempDir()
	path := filepath.Join(dir, "runtime.json")
	b := nativeBundle(t, "a")
	writeNativeBundle(t, path, b)
	m, err := NewManaged(ManagedOptions{RuntimeConfigFile: path,
		Auth:       auth.Config{AccessToken: accessToken, UpstreamToken: "provider-test-token", AdminToken: reloadAdmin},
		LedgerPath: filepath.Join(dir, "ledger.wal"), Gateway: Options{UpstreamURL: upstream.URL,
			AssessmentTimeout: time.Second, MaxRequests: 8, EdgeURL: receiver.URL + "/internal/v1/go-events", EdgeToken: edgeTestToken}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.Close)
	return m, b
}

func edgeTestCall(t *testing.T, m *Managed, revision, token string, signals map[string]map[string]float64) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(map[string]any{"model": "auto", "messages": []any{map[string]string{"role": "user", "content": "Say hello"}},
		"__amr_edge": edgeContext{ID: "12345678-1234-1234-1234-123456789abc", RequestID: "public-edge-request", ConfigRevision: revision, MarketSignals: signals}})
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("POST", "/v1/chat/completions", bytes.NewReader(body))
	r.Header.Set("Authorization", "Bearer "+accessToken)
	if token != "" {
		r.Header.Set("X-AMR-Edge-Token", token)
	}
	w := httptest.NewRecorder()
	m.ServeHTTP(w, r)
	return w
}

func TestEdgeRequiresTokenAndMatchingRevisionBeforeProviderCall(t *testing.T) {
	var calls atomic.Int64
	m, b := edgeTestManaged(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		io.WriteString(w, `{"choices":[{"message":{"content":"hello"}}]}`)
	}, func(w http.ResponseWriter, r *http.Request) {
		t.Error("rejected request emitted event")
		w.WriteHeader(204)
	})
	for _, tc := range []struct{ token, revision, code string }{
		{"", b.Revision, "trusted_edge_required"},
		{"wrong", b.Revision, "trusted_edge_required"},
		{edgeTestToken, `"` + strings.Repeat("b", 64) + `"`, "edge_config_revision_mismatch"},
	} {
		w := edgeTestCall(t, m, tc.revision, tc.token, nil)
		if w.Code != 503 || !strings.Contains(w.Body.String(), tc.code) {
			t.Fatalf("got %d %s; want %s", w.Code, w.Body.String(), tc.code)
		}
	}
	if calls.Load() != 0 {
		t.Fatalf("rejected edge context called provider %d times", calls.Load())
	}
}

func TestEdgeMarketSignalsAndEventSettlementPreserveProviderBoundary(t *testing.T) {
	var mu sync.Mutex
	var events []edgeEvent
	var models []string
	m, b := edgeTestManaged(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-AMR-Edge-Token") != "" || r.Header.Get("Authorization") != "Bearer provider-test-token" {
			t.Error("edge credential leaked or provider credential was replaced")
		}
		var body map[string]json.RawMessage
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if _, exists := body["__amr_edge"]; exists {
			t.Error("private edge metadata leaked to provider")
		}
		var model string
		_ = json.Unmarshal(body["model"], &model)
		mu.Lock()
		models = append(models, model)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"choices":[{"message":{"content":"hello"}}],"usage":{"prompt_tokens":10,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":3}}}`)
	}, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+edgeTestToken || r.URL.Path != "/internal/v1/go-events" {
			t.Error("event receiver contract mismatch")
		}
		var event edgeEvent
		if err := json.NewDecoder(r.Body).Decode(&event); err != nil {
			t.Error(err)
		}
		mu.Lock()
		events = append(events, event)
		mu.Unlock()
		w.WriteHeader(204)
	})
	w := edgeTestCall(t, m, b.Revision, edgeTestToken, nil)
	if w.Code != 200 {
		t.Fatalf("baseline: %d %s", w.Code, w.Body.String())
	}
	mu.Lock()
	if len(events) != 1 {
		mu.Unlock()
		t.Fatal("missing baseline event")
	}
	task := events[0].DecisionAnalysis.Task
	mu.Unlock()
	w = edgeTestCall(t, m, b.Revision, edgeTestToken, map[string]map[string]float64{task: {"model-b": .2}})
	if w.Code != 200 {
		t.Fatalf("market request: %d %s", w.Code, w.Body.String())
	}
	mu.Lock()
	defer mu.Unlock()
	if len(models) != 2 || models[0] != "model-a" || models[1] != "model-b" {
		t.Fatalf("market signals did not change selection: %v", models)
	}
	if len(events) != 2 {
		t.Fatalf("events: %d", len(events))
	}
	for i, e := range events {
		if e.ID != "12345678-1234-1234-1234-123456789abc" || e.ConfigRevision != b.Revision || e.Attempt.Index != 0 || e.Attempt.Model != models[i] || e.Decision.SelectedModel != models[i] || !e.Attempt.OK || e.Attempt.Status != 200 {
			t.Fatalf("incorrect attempt identity/selection: %+v", e)
		}
		if e.Attempt.Usage == nil || e.Attempt.Usage.Prompt != 10 || e.Attempt.Usage.Completion != 2 || e.Attempt.Usage.Cached != 3 || e.Attempt.ActualMicros == nil || *e.Attempt.ActualMicros != 12 {
			t.Fatalf("usage/settlement mismatch: %+v", e.Attempt)
		}
	}
	if w.Header().Get("X-Router-Selected-Model") != "model-b" || w.Header().Get("X-Request-ID") != "public-edge-request" {
		t.Fatal("public response metadata differs")
	}
}

func TestEdgeLostAcknowledgmentRetriesSameEventWithoutProviderRetry(t *testing.T) {
	var providerCalls, eventCalls atomic.Int64
	var mu sync.Mutex
	var payloads [][]byte
	m, b := edgeTestManaged(t, func(w http.ResponseWriter, r *http.Request) {
		providerCalls.Add(1)
		io.WriteString(w, `{"choices":[{"message":{"content":"hello"}}],"usage":{"prompt_tokens":10,"completion_tokens":2}}`)
	}, func(w http.ResponseWriter, r *http.Request) {
		payload, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
		}
		mu.Lock()
		payloads = append(payloads, payload)
		mu.Unlock()
		if eventCalls.Add(1) == 1 {
			// Side effect happened, but its HTTP acknowledgment is lost.
			conn, _, err := w.(http.Hijacker).Hijack()
			if err != nil {
				t.Error(err)
				return
			}
			conn.Close()
			return
		}
		w.WriteHeader(204)
	})
	w := edgeTestCall(t, m, b.Revision, edgeTestToken, nil)
	if w.Code != 200 {
		t.Fatalf("lost ACK: %d %s", w.Code, w.Body.String())
	}
	if providerCalls.Load() != 1 || eventCalls.Load() != 2 {
		t.Fatalf("provider=%d events=%d", providerCalls.Load(), eventCalls.Load())
	}
	mu.Lock()
	defer mu.Unlock()
	if len(payloads) != 2 || !bytes.Equal(payloads[0], payloads[1]) {
		t.Fatal("retry changed event identity or settlement payload")
	}
}
