package gateway

import (
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
	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/semantic"
)

func TestCandidateReviewUsesAuthorizedCredentialActiveAndBackground(t *testing.T) {
	for _, mode := range []string{"active", "shadow"} {
		for _, keyMode := range []string{"strict", "passthrough"} {
			t.Run(mode+"/"+keyMode, func(t *testing.T) {
				var classified atomic.Int32
				check := func(r *http.Request) {
					data, _ := io.ReadAll(r.Body)
					tenant := "alpha"
					if strings.Contains(string(data), "tenant-beta") {
						tenant = "beta"
					}
					want := "caller-" + tenant
					if keyMode == "strict" {
						want = "upstream-" + tenant
					}
					if r.Header.Get("Authorization") != "Bearer "+want {
						t.Error("review/answer used another tenant, router, admin, or static classifier credential")
					}
				}
				classifier := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					check(r)
					classified.Add(1)
					json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": `{"task":"reasoning","tier":"complex","complexity":0.9,"confidence":0.95}`}}}, "usage": map[string]int{"prompt_tokens": 2, "completion_tokens": 1}})
				}))
				defer classifier.Close()
				upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					check(r)
					io.WriteString(w, `{"choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":2,"completion_tokens":1}}`)
				}))
				defer upstream.Close()
				b := nativeBundle(t, "a")
				b.Semantic = reviewPolicy()
				b.Semantic.Provider = "openai-chat"
				b.Semantic.LargeModel = "model-a"
				b.Semantic.Mode = mode
				b.Semantic.ConfidenceThreshold = 1
				b.Analysis.SemanticRequired = true
				dir := t.TempDir()
				path := filepath.Join(dir, "runtime.json")
				writeNativeBundle(t, path, b)
				ac := auth.Config{Mode: keyMode, AccessToken: "caller-alpha", UpstreamToken: "upstream-alpha", AdminToken: "separate-admin-token"}
				if keyMode == "strict" {
					ac.Tenants = []auth.Tenant{{AccessToken: "caller-beta", UpstreamToken: "upstream-beta"}}
				}
				m, err := NewManaged(ManagedOptions{RuntimeConfigFile: path, LedgerPath: filepath.Join(dir, "ledger.wal"), Auth: ac, Gateway: Options{Candidate: true, NativeSemantics: true, UpstreamURL: upstream.URL, AssessmentTimeout: time.Second, MaxRequests: 8, SemanticBucketSecret: []byte(strings.Repeat("x", 32)), SemanticOptions: semantic.Options{LargeURL: classifier.URL, MaxConcurrent: 8, MaxLargeCalls: 10, MaxLargeTokens: 100000}}})
				if err != nil {
					t.Fatal(err)
				}
				defer m.Close()
				var wg sync.WaitGroup
				for _, tenant := range []string{"alpha", "beta"} {
					wg.Add(1)
					go func(tenant string) {
						defer wg.Done()
						r := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(`{"model":"auto","messages":[{"role":"user","content":"Please explain this ordinary statement tenant-`+tenant+` in plain language."}]}`))
						r.Header.Set("Authorization", "Bearer caller-"+tenant)
						w := httptest.NewRecorder()
						m.ServeHTTP(w, r)
						if w.Code != 200 {
							t.Errorf("request %d %s", w.Code, w.Body.String())
						}
						want := "applied"
						if mode == "shadow" {
							want = "shadow_pending"
						}
						if w.Header().Get("X-AMR-Semantic-Status") != want {
							t.Errorf("review status %s", w.Header().Get("X-AMR-Semantic-Status"))
						}
					}(tenant)
				}
				wg.Wait()
				m.active.g.backgroundWorkers.Wait()
				m.Close()
				if classified.Load() != 2 {
					t.Fatalf("classifier calls %d", classified.Load())
				}
			})
		}
	}
}
