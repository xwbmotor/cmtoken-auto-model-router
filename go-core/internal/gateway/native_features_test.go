package gateway

import (
	"encoding/json"
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
	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/features"
	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/semantic"
)

func nativeBundle(t *testing.T, letter string) Bundle {
	t.Helper()
	b := managedBundle()
	b.Revision = `"` + strings.Repeat(letter, 64) + `"`
	var c features.Config
	if e := json.Unmarshal([]byte(`{"schemaVersion":1,"version":"native","routing":{"mode":"active","activeTrafficPercent":100,"qualityFloor":0.7,"qualityWeight":1,"costWeight":0,"latencyWeight":0,"selfHostedBonus":0,"uncertaintyPenalty":0,"loadBalancing":{"enabled":true,"limits":{"model-a":8,"model-b":8}}},"models":[{"id":"model-a","enabled":true,"contextWindow":128000,"quality":{"default":0.95,"reasoning":0.99},"capabilities":{"chat":true,"stream":true}},{"id":"model-b","enabled":true,"contextWindow":128000,"quality":{"default":0.9,"reasoning":0.9},"capabilities":{"chat":true,"stream":true}}]}`), &c); e != nil {
		t.Fatal(e)
	}
	if letter == "b" {
		c.Models[0]["quality"] = map[string]any{"default": .9, "reasoning": .9}
		c.Models[1]["quality"] = map[string]any{"default": .95, "reasoning": .99}
	}
	b.Features = &c
	return b
}
func writeNativeBundle(t *testing.T, path string, b Bundle) {
	t.Helper()
	raw, e := json.Marshal(b)
	if e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(path, raw, 0600); e != nil {
		t.Fatal(e)
	}
}

func TestNativeBootstrapSurvivesAdapterShutdown(t *testing.T) {
	var calls atomic.Int64
	adapter := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path != "/runtime-config" || r.Header.Get("X-AMR-Native-Features") != "1" {
			t.Error("unexpected adapter call")
			w.WriteHeader(500)
			return
		}
		_ = json.NewEncoder(w).Encode(nativeBundle(t, "a"))
	}))
	t.Cleanup(adapter.Close)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":10,"completion_tokens":2}}`)
	}))
	t.Cleanup(upstream.Close)
	m, e := NewManaged(ManagedOptions{Auth: auth.Config{AccessToken: accessToken, UpstreamToken: "upstream", AdminToken: reloadAdmin}, LedgerPath: filepath.Join(t.TempDir(), "ledger.wal"), Gateway: Options{AssessorURL: adapter.URL, AssessorToken: assessorToken, UpstreamURL: upstream.URL, AssessmentTimeout: time.Second, MaxRequests: 8}})
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(m.Close)
	adapter.Close()
	for range 3 {
		w := reloadCall(t, m, "POST", "/v1/chat/completions", accessToken, "")
		if w.Code != 200 {
			t.Fatalf("adapter shutdown broke requests: %d %s", w.Code, w.Body.String())
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("request path called adapter %d times", calls.Load())
	}
	before := m.active.revision
	if _, e = m.Reload(before); e == nil {
		t.Fatal("reload should require reachable configuration source")
	}
	if m.active.revision != before {
		t.Fatal("failed reload replaced active generation")
	}
	if w := reloadCall(t, m, "POST", "/v1/chat/completions", accessToken, ""); w.Code != 200 {
		t.Fatal("failed reload interrupted existing generation")
	}
}

func TestNativeSnapshotPinsSemanticReassessmentAcrossReload(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	var unblock sync.Once
	t.Cleanup(func() { unblock.Do(func() { close(release) }) })
	var classifyCalls atomic.Int64
	classifier := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if classifyCalls.Add(1) == 1 {
			close(started)
			select {
			case <-release:
			case <-r.Context().Done():
				return
			}
		}
		io.WriteString(w, `{"task":"reasoning","tier":"complex","complexity":0.9,"confidence":0.95}`)
	}))
	t.Cleanup(classifier.Close)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		_ = json.NewEncoder(w).Encode(map[string]any{"model": body["model"], "choices": []any{map[string]any{"message": map[string]string{"content": "ok"}}}, "usage": map[string]int{"prompt_tokens": 10, "completion_tokens": 2}})
	}))
	t.Cleanup(upstream.Close)
	dir := t.TempDir()
	path := filepath.Join(dir, "runtime.json")
	b := nativeBundle(t, "a")
	b.Semantic = reviewPolicy()
	b.Analysis.SemanticRequired = true
	writeNativeBundle(t, path, b)
	m, e := NewManaged(ManagedOptions{RuntimeConfigFile: path, Auth: auth.Config{AccessToken: accessToken, UpstreamToken: "upstream", AdminToken: reloadAdmin}, LedgerPath: filepath.Join(dir, "ledger.wal"), Gateway: Options{
		// This deliberately invalid adapter URL and empty token must be unused.
		AssessorURL: "not-an-adapter", UpstreamURL: upstream.URL, AssessmentTimeout: time.Second, MaxRequests: 8, NativeSemantics: true,
		SemanticBucketSecret: []byte(strings.Repeat("x", 32)), SemanticOptions: semantic.Options{SmallURL: classifier.URL, MaxConcurrent: 8, MaxLargeCalls: 10, MaxLargeTokens: 100000},
	}})
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(m.Close)
	// Release a blocked classifier before Close on a failed assertion.
	t.Cleanup(func() { unblock.Do(func() { close(release) }) })
	oldRevision := m.active.revision
	send := func() *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(semanticRequest))
		r.Header.Set("Authorization", "Bearer "+accessToken)
		w := httptest.NewRecorder()
		m.ServeHTTP(w, r)
		return w
	}
	oldResult := make(chan *httptest.ResponseRecorder, 1)
	go func() { oldResult <- send() }()
	select {
	case <-started:
	case w := <-oldResult:
		t.Fatalf("request bypassed semantic barrier: %d %s", w.Code, w.Body.String())
	case <-time.After(3 * time.Second):
		t.Fatal("semantic request did not start")
	}
	b = nativeBundle(t, "b")
	b.Semantic = reviewPolicy()
	b.Analysis.SemanticRequired = true
	writeNativeBundle(t, path, b)
	newRevision, e := m.Reload(oldRevision)
	if e != nil {
		t.Fatal(e)
	}
	if newRevision == oldRevision {
		t.Fatal("generation revision unchanged")
	}
	// Old classification finishes only after the new feature policy is published.
	unblock.Do(func() { close(release) })
	select {
	case w := <-oldResult:
		if w.Code != 200 || w.Header().Get("X-AMR-Selected-Model") != "model-a" || w.Header().Get("X-AMR-Semantic-Status") != "applied" || w.Header().Get("X-AMR-Runtime-Revision") != oldRevision {
			t.Fatalf("old semantic reassessment changed generation: %d %s", w.Code, w.Body.String())
		}
	case <-time.After(3 * time.Second):
		t.Fatal("old request did not complete")
	}
	next := send()
	if next.Code != 200 || next.Header().Get("X-AMR-Selected-Model") != "model-b" || next.Header().Get("X-AMR-Runtime-Revision") != newRevision {
		t.Fatal("new request did not use new features")
	}
	for _, corrupt := range []func(*Bundle){
		func(b *Bundle) { b.Features = nil },
		func(b *Bundle) { b.Features.Routing["qualityFloor"] = "Infinity" },
		func(b *Bundle) { delete(b.Runtime.Prices, "model-b") },
	} {
		bad := nativeBundle(t, "a")
		corrupt(&bad)
		writeNativeBundle(t, path, bad)
		if _, e = m.Reload(newRevision); e == nil {
			t.Fatal("invalid native generation accepted")
		}
		if m.active.revision != newRevision {
			t.Fatal("rejected snapshot replaced active generation")
		}
	}
	if w := reloadCall(t, m, "POST", "/v1/chat/completions", accessToken, ""); w.Code != 200 || w.Header().Get("X-AMR-Selected-Model") != "model-b" {
		t.Fatal("invalid snapshot disrupted active requests")
	}
}
