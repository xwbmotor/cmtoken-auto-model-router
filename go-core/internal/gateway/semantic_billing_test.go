package gateway

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/auth"
	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/semantic"
)

func TestManagedClassifierFailedParseBillsUsageAndReloadPreservesGuard(t *testing.T) {
	b := managedBundle()
	b.Semantic = reviewPolicy()
	b.Semantic.Provider = "openai-chat"
	b.Semantic.Mode = "active"
	b.Semantic.ConfidenceThreshold = 1
	b.Semantic.ActiveTrafficPercent = 100
	b.Semantic.LargeModel = "classifier"
	b.Analysis.SemanticRequired = true
	b.Runtime.Prices["classifier"] = Price{Input: billingPrice(1), Output: billingPrice(2)}
	adapter := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/runtime-config" {
			_ = json.NewEncoder(w).Encode(b)
			return
		}
		w.Header().Set("X-AMR-Config-Revision", b.Revision)
		_ = json.NewEncoder(w).Encode(managedInput())
	}))
	defer adapter.Close()
	var calls atomic.Int32
	classifier := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"invalid classifier JSON"}}],"usage":{"prompt_tokens":10,"completion_tokens":5}}`)
	}))
	defer classifier.Close()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":2,"completion_tokens":1}}`)
	}))
	defer upstream.Close()
	m, e := NewManaged(ManagedOptions{Gateway: Options{NativeSemantics: true, AssessorURL: adapter.URL + "/assess", AssessorToken: assessorToken, UpstreamURL: upstream.URL, AssessmentTimeout: time.Second, MaxRequests: 16, SemanticBucketSecret: []byte(strings.Repeat("x", 32)), SemanticOptions: semantic.Options{LargeURL: classifier.URL, LargeToken: strings.Repeat("y", 24), MaxConcurrent: 8, MaxLargeCalls: 1, MaxLargeTokens: 100000}}, Auth: auth.Config{AccessToken: accessToken, UpstreamToken: "upstream-token"}, LedgerPath: filepath.Join(t.TempDir(), "ledger.wal")})
	if e != nil {
		t.Fatal(e)
	}
	defer m.Close()
	server := httptest.NewServer(m)
	defer server.Close()
	call := func() {
		res, e := http.DefaultClient.Do(request(context.Background(), server.URL, `{"model":"auto","messages":[{"role":"user","content":"Please analyze this ordinary statement with enough text for semantic eligibility."}]}`))
		if e != nil {
			t.Fatal(e)
		}
		defer res.Body.Close()
		if res.StatusCode != 200 {
			data, _ := io.ReadAll(res.Body)
			t.Fatalf("%d %s", res.StatusCode, data)
		}
		_, _ = io.Copy(io.Discard, res.Body)
		managedIdle(t, m)
	}
	call()
	if calls.Load() != 1 {
		t.Fatal("classifier not called")
	}
	if cost := m.state.ledger.Snapshot().Sources["classifier"].ActualMicros; cost != 20 {
		t.Fatalf("failed parse lost actual usage: %d", cost)
	}
	if _, e = m.Reload(m.active.revision); e != nil {
		t.Fatal(e)
	}
	call()
	if calls.Load() != 1 {
		t.Fatal("reload reset classifier call allowance")
	}
	if cost := m.state.ledger.Snapshot().Sources["classifier"].ActualMicros; cost != 20 {
		t.Fatalf("duplicate classifier bill: %d", cost)
	}
}
