package semantic

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func policyFixture() Policy {
	return Policy{Enabled: true, Provider: "cascade", Mode: "active", MinCharacters: 1, MaxInputCharacters: 6000, ConfidenceThreshold: .7, SmallAcceptThreshold: .7, FinalAdoptionThreshold: .6, ActiveTrafficPercent: 100, SmallTimeoutMS: 500, LargeTimeoutMS: 500, MaxOutputTokens: 180, LargeModel: "mock-classifier"}
}

var classifyBody = []byte(`{"messages":[{"role":"system","content":"SECRET SYSTEM SHOULD NOT CROSS"},{"role":"assistant","content":"SECRET HISTORY"},{"role":"user","content":"用通俗语言解释一下这是什么意思"}]}`)

func assessmentJSON(confidence float64) string {
	data, _ := json.Marshal(map[string]any{"task": "extraction", "tier": "simple", "complexity": .2, "confidence": confidence, "reason": "fixture"})
	return string(data)
}
func TestCascadeAndUsage(t *testing.T) {
	for _, tc := range []struct {
		name                 string
		smallConfidence      float64
		smallFail, largeFail bool
		level                string
		largeCalls           int64
	}{{"small", .9, false, false, "small", 0}, {"large", .4, false, false, "large", 1}, {"small-error", 0, true, false, "large", 1}, {"degraded", .4, false, true, "small-degraded", 1}, {"both-error", 0, true, true, "", 1}} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int64
			small := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]string
				json.NewDecoder(r.Body).Decode(&body)
				if len(body) != 1 || strings.Contains(body["text"], "SECRET") {
					t.Error("classification text leaked history or changed contract")
				}
				if r.Header.Get("Authorization") != "Bearer small-test-token-123" {
					t.Error("small auth")
				}
				if tc.smallFail {
					w.WriteHeader(500)
					return
				}
				io.WriteString(w, assessmentJSON(tc.smallConfidence))
			}))
			defer small.Close()
			large := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				b, _ := io.ReadAll(r.Body)
				if strings.Contains(string(b), "SECRET") || r.Header.Get("Authorization") != "Bearer large-test-token-123" {
					t.Error("large credential or text isolation")
				}
				if tc.largeFail {
					w.WriteHeader(503)
					return
				}
				json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": assessmentJSON(.95)}}}, "usage": map[string]int{"prompt_tokens": 20, "completion_tokens": 10}})
			}))
			defer large.Close()
			c, e := New(Options{Policy: policyFixture(), SmallURL: small.URL, LargeURL: large.URL, SmallToken: "small-test-token-123", LargeToken: "large-test-token-123", MaxConcurrent: 4, MaxLargeCalls: 20, MaxLargeTokens: 100000})
			if e != nil {
				t.Fatal(e)
			}
			defer c.Close()
			a, e := c.Classify(context.Background(), classifyBody)
			if tc.level == "" {
				if e == nil {
					t.Fatal("both failures accepted")
				}
			} else if e != nil || a.Cascade == nil || a.Cascade.Level != tc.level {
				t.Fatalf("got %+v %v", a, e)
			}
			if calls.Load() != tc.largeCalls {
				t.Fatalf("large calls %d", calls.Load())
			}
			s := c.Snapshot()
			if s.PendingTokens != 0 || s.Active != 0 {
				t.Fatalf("reservation leak %+v", s)
			}
			if tc.largeCalls == 1 && !tc.largeFail && s.ActualTokens != 30 {
				t.Fatalf("usage lost %+v", s)
			}
			if tc.largeFail && s.EstimatedTokens <= 0 {
				t.Fatal("missing usage was treated as free")
			}
		})
	}
}
func TestLargeGuardAtomicAndIdempotent(t *testing.T) {
	gate := make(chan struct{})
	started := make(chan struct{}, 3)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		started <- struct{}{}
		<-gate
		json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": assessmentJSON(.9)}}}, "usage": map[string]int{"prompt_tokens": 1, "completion_tokens": 1}})
	}))
	defer server.Close()
	p := policyFixture()
	p.Provider = "openai-chat"
	p.LargeTimeoutMS = 5000
	c, e := New(Options{Policy: p, LargeURL: server.URL, LargeToken: "large-test-token-123", MaxConcurrent: 32, MaxLargeCalls: 3, MaxLargeTokens: 100000})
	if e != nil {
		t.Fatal(e)
	}
	defer c.Close()
	var wg sync.WaitGroup
	var accepted atomic.Int64
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := c.Classify(context.Background(), classifyBody); err == nil {
				accepted.Add(1)
			}
		}()
	}
	for i := 0; i < 3; i++ {
		select {
		case <-started:
		case <-time.After(2 * time.Second):
			close(gate)
			t.Fatal("expected calls did not start")
		}
	}
	if s := c.Snapshot(); s.LargeCalls != 3 || s.PendingTokens <= 0 {
		t.Errorf("unexpected pending state %+v", s)
	}
	close(gate)
	wg.Wait()
	if s := c.Snapshot(); accepted.Load() != 3 || s.ActualTokens != 6 || s.PendingTokens != 0 || s.Active != 0 {
		t.Fatalf("guard overrun/leak %+v accepted=%d", s, accepted.Load())
	}
	settle, err := c.reserve(1)
	if err == nil {
		settle(nil)
		t.Fatal("call cap bypassed")
	}
}
func TestTokenGuardAndParseFailureStillCharge(t *testing.T) {
	c := &Client{options: Options{MaxLargeCalls: 10, MaxLargeTokens: 10}, guard: NewGuard(1)}
	settle, e := c.reserve(8)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = c.reserve(3); e == nil {
		t.Fatal("token cap bypassed")
	}
	settle(&Usage{Prompt: 1, Completion: 1})
	settle(nil)
	if s := c.Snapshot(); s.ActualTokens != 2 || s.EstimatedTokens != 0 || s.PendingTokens != 0 {
		t.Fatalf("double settle %+v", s)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": "invalid assessment"}}}, "usage": map[string]int{"prompt_tokens": 20, "completion_tokens": 5}})
	}))
	defer server.Close()
	p := policyFixture()
	p.Provider = "openai-chat"
	client, e := New(Options{Policy: p, LargeURL: server.URL, LargeToken: "large-test-token-123", MaxConcurrent: 1, MaxLargeCalls: 1, MaxLargeTokens: 100000})
	if e != nil {
		t.Fatal(e)
	}
	defer client.Close()
	if _, e = client.Classify(context.Background(), classifyBody); e == nil {
		t.Fatal("invalid assessment accepted")
	}
	if client.Snapshot().ActualTokens != 25 {
		t.Fatal("failed parsing erased paid usage")
	}
}
func TestCancellationStopsEscalation(t *testing.T) {
	started := make(chan struct{})
	small := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		close(started)
		<-r.Context().Done()
	}))
	defer small.Close()
	var largeCalls atomic.Int64
	large := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { largeCalls.Add(1) }))
	defer large.Close()
	c, e := New(Options{Policy: policyFixture(), SmallURL: small.URL, LargeURL: large.URL, LargeToken: "large-test-token-123", MaxConcurrent: 1, MaxLargeCalls: 10, MaxLargeTokens: 100000})
	if e != nil {
		t.Fatal(e)
	}
	defer c.Close()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { _, e := c.Classify(ctx, classifyBody); done <- e }()
	<-started
	cancel()
	select {
	case e := <-done:
		if e == nil {
			t.Fatal("cancelled assessment accepted")
		}
	case <-time.After(time.Second):
		t.Fatal("cancellation not propagated")
	}
	if largeCalls.Load() != 0 {
		t.Fatal("cancelled request escalated")
	}
}
func TestParseAndEndpointGuards(t *testing.T) {
	a, e := Parse("```json\n" + `{"task":"coding","tier":"simple","complexity":0.0625,"confidence":"0.8","reason":"ok"}` + "\n```")
	if e != nil || a.Complexity != .063 || a.Confidence != .8 {
		t.Fatalf("rounding/coercion mismatch %+v %v", a, e)
	}
	for _, raw := range []string{`{}`, `{"task":"other","tier":"simple","complexity":0,"confidence":1}`, `{"task":"coding","tier":"simple","complexity":-1,"confidence":1}`} {
		if _, e := Parse(raw); e == nil {
			t.Fatal("invalid assessment accepted")
		}
	}
	o := Options{Policy: policyFixture(), SmallURL: "https://example.com/classify", LargeURL: "http://127.0.0.1:9999/chat", LargeToken: "large-test-token-123", MaxConcurrent: 1, MaxLargeCalls: 1, MaxLargeTokens: 10000}
	if _, e := New(o); e == nil {
		t.Fatal("non-loopback provider accepted")
	}
}

func TestProductionEdgeUsesRuntimeBudgetInsteadOfLifetimeLabAllowance(t *testing.T) {
	c := &Client{options: Options{RuntimeBudgetOnly: true, MaxLargeCalls: 1, MaxLargeTokens: 1}, guard: NewGuard(1)}
	for i := 0; i < 501; i++ {
		settle, err := c.reserve(100)
		if err != nil {
			t.Fatalf("production review disabled at %d: %v", i, err)
		}
		settle(&Usage{Prompt: 10, Completion: 2})
	}
	s := c.Snapshot()
	if s.LargeCalls != 501 || s.ActualTokens != 6012 || s.PendingTokens != 0 {
		t.Fatalf("accounting lost: %+v", s)
	}
	c.options.RuntimeBudgetOnly = false
	if _, err := c.reserve(1); err == nil {
		t.Fatal("laboratory allowance bypassed")
	}
}
