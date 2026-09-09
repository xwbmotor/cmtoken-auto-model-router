package gateway

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/analysis"
	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/decision"
	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/semantic"
)

const tenantAccess = "tenant-access-token-123"
const tenantUpstream = "tenant-upstream-token-123"

func reviewPolicy() semantic.Policy {
	return semantic.Policy{Enabled: true, Provider: "http-json", Mode: "active", MinCharacters: 1, MaxInputCharacters: 6000, ConfidenceThreshold: .7, SmallAcceptThreshold: .7, FinalAdoptionThreshold: .7, ActiveTrafficPercent: 100, SmallTimeoutMS: 2000, LargeTimeoutMS: 2000, MaxOutputTokens: 180, LargeModel: "classifier"}
}
func semanticLab(t *testing.T, p semantic.Policy, small http.HandlerFunc, scopeHandler http.HandlerFunc, timeouts ...time.Duration) (*Gateway, *httptest.Server, *atomic.Int64) {
	t.Helper()
	var assessments atomic.Int64
	var upstreamCalls atomic.Int64
	adapter := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+assessorToken {
			t.Error("adapter credential changed")
		}
		switch r.URL.Path {
		case "/analysis-config":
			io.WriteString(w, `{"taskRules":{"simpleMaxComplexity":0.34,"complexMinComplexity":0.7},"budget":{"defaultEstimatedOutputTokens":800}}`)
		case "/semantic-config":
			json.NewEncoder(w).Encode(p)
		case "/assess":
			if r.Header.Get("X-AMR-Native-Analysis") != "1" {
				t.Error("missing native analysis provenance")
			}
			var envelope struct {
				Analysis analysis.Result `json:"analysis"`
				Request  struct {
					Model string `json:"model"`
				} `json:"request"`
			}
			json.NewDecoder(r.Body).Decode(&envelope)
			in := inputFixture()
			in.Policy.AllowExplicitModel = true
			in.Policy.LoadEnabled = false
			in.Policy.ActiveTrafficPercent = 50
			in.Policy.ShadowModel = "model-a"
			in.RequestedModel = envelope.Request.Model
			if in.RequestedModel == "" {
				in.RequestedModel = "auto"
			}
			sub := ""
			if envelope.Analysis.SubTask != nil {
				sub = *envelope.Analysis.SubTask
			}
			in.Analysis = decision.Analysis{Task: envelope.Analysis.Task, Tier: envelope.Analysis.Tier, SubTask: sub, Complexity: envelope.Analysis.Complexity, EstimatedContextTokens: envelope.Analysis.EstimatedContextTokens, Requirements: envelope.Analysis.Requirements}
			in.Models = []decision.Model{{ID: "model-a", Enabled: true, Ownership: "self_hosted", Quality: .95, Capabilities: map[string]bool{"tools": true}}, {ID: "model-b", Enabled: true, Ownership: "self_hosted", Quality: .94, Capabilities: map[string]bool{"tools": true}}}
			if in.Analysis.Task == "reasoning" {
				in.Models[0].Quality = .96
				in.Models[1].Quality = .98
			}
			if assessments.Add(1)%2 == 1 {
				in.Runtime.TrafficBucket = 5
			} else {
				in.Runtime.TrafficBucket = 95
			}
			json.NewEncoder(w).Encode(in)
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(adapter.Close)
	classifier := httptest.NewServer(small)
	t.Cleanup(classifier.Close)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/models" && scopeHandler != nil {
			scopeHandler(w, r)
			return
		}
		upstreamCalls.Add(1)
		if auth := r.Header.Get("Authorization"); auth != "Bearer mock-upstream-secret" && auth != "Bearer "+tenantUpstream {
			t.Error("upstream received wrong credential")
		}
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		json.NewEncoder(w).Encode(map[string]any{"model": body["model"], "choices": []any{map[string]any{"message": map[string]string{"content": "answer"}}}})
	}))
	t.Cleanup(upstream.Close)
	opts := Options{NativeAnalysis: true, NativeSemantics: true, AssessorURL: adapter.URL + "/assess", UpstreamURL: upstream.URL + "/chat", AccessToken: accessToken, AssessorToken: assessorToken, UpstreamToken: "mock-upstream-secret", AssessmentTimeout: time.Second, RequestTimeout: 3 * time.Second, MaxRequests: 32, SemanticBucketSecret: []byte("stable-semantic-bucket-secret-123456789"), SemanticOptions: semantic.Options{SmallURL: classifier.URL, SmallToken: "small-private-token-123", MaxConcurrent: 8, MaxLargeCalls: 10, MaxLargeTokens: 100000}, Tenants: []Tenant{{AccessToken: tenantAccess, UpstreamToken: tenantUpstream}}}
	if scopeHandler != nil {
		opts.ScopeURL = upstream.URL + "/models"
		opts.ScopeTTL = time.Minute
		opts.ScopeTimeout = time.Second
	}
	if len(timeouts) > 0 {
		opts.RequestTimeout = timeouts[0]
	}
	g, e := New(opts)
	if e != nil {
		t.Fatal(e)
	}
	server := httptest.NewServer(g)
	t.Cleanup(server.Close)
	t.Cleanup(g.Close)
	return g, server, &upstreamCalls
}

const semanticRequest = `{"model":"auto","messages":[{"role":"user","content":"请用通俗语言解释一下这段话的含义"}]}`

func smallAssessment(confidence float64) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer small-private-token-123" {
			w.WriteHeader(403)
			return
		}
		io.Copy(io.Discard, r.Body)
		json.NewEncoder(w).Encode(map[string]any{"task": "reasoning", "tier": "complex", "complexity": .9, "confidence": confidence, "reason": "test"})
	}
}
func TestActiveSemanticPreservesTrafficBucketAndScope(t *testing.T) {
	for _, scoped := range []bool{false, true} {
		t.Run(map[bool]string{false: "unscoped", true: "tenant"}[scoped], func(t *testing.T) {
			var scopeHandler http.HandlerFunc
			if scoped {
				scopeHandler = func(w http.ResponseWriter, r *http.Request) {
					if r.Header.Get("Authorization") != "Bearer "+tenantUpstream {
						t.Error("scope used wrong tenant credential")
					}
					io.WriteString(w, `{"data":[{"id":"model-a"}]}`)
				}
			}
			g, s, calls := semanticLab(t, reviewPolicy(), smallAssessment(.9), scopeHandler)
			req := request(context.Background(), s.URL, semanticRequest)
			if scoped {
				req.Header.Set("Authorization", "Bearer "+tenantAccess)
			}
			res, e := http.DefaultClient.Do(req)
			if e != nil {
				t.Fatal(e)
			}
			defer res.Body.Close()
			data, _ := io.ReadAll(res.Body)
			want := "model-b"
			if scoped {
				want = "model-a"
			}
			if res.StatusCode != 200 || res.Header.Get("X-AMR-Semantic-Status") != "applied" || res.Header.Get("X-AMR-Selected-Model") != want {
				t.Fatalf("unexpected selection: %s %s", res.Header, data)
			}
			if calls.Load() != 1 {
				t.Fatal("semantic review generated duplicate answer")
			}
			g.reviewsMu.Lock()
			reviews := append([]Review{}, g.reviews...)
			g.reviewsMu.Unlock()
			if len(reviews) != 1 || reviews[0].ProposedTask != "reasoning" {
				t.Fatalf("missing review %v", reviews)
			}
		})
	}
}
func TestLowConfidenceAndFailureKeepRules(t *testing.T) {
	for _, tc := range []struct {
		name    string
		handler http.HandlerFunc
		status  string
	}{{"low", smallAssessment(.2), "rejected_low_confidence"}, {"failure", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(500) }, "error"}} {
		t.Run(tc.name, func(t *testing.T) {
			_, s, _ := semanticLab(t, reviewPolicy(), tc.handler, nil)
			res, e := http.DefaultClient.Do(request(context.Background(), s.URL, semanticRequest))
			if e != nil {
				t.Fatal(e)
			}
			defer res.Body.Close()
			io.Copy(io.Discard, res.Body)
			if res.StatusCode != 200 || res.Header.Get("X-AMR-Selected-Model") != "model-a" || res.Header.Get("X-AMR-Semantic-Status") != tc.status {
				t.Fatalf("rules fallback lost: %v", res.Header)
			}
		})
	}
}
func TestShadowDoesNotWaitOrGenerateAnotherAnswer(t *testing.T) {
	for _, hold := range []bool{false, true} {
		t.Run(map[bool]string{false: "shadow", true: "hold"}[hold], func(t *testing.T) {
			started := make(chan struct{})
			gate := make(chan struct{})
			p := reviewPolicy()
			p.Mode = "shadow"
			status := "shadow_pending"
			if hold {
				p.Mode = "active"
				p.ActiveTrafficPercent = 0
				status = "rollout_hold"
			}
			g, s, calls := semanticLab(t, p, func(w http.ResponseWriter, r *http.Request) {
				io.Copy(io.Discard, r.Body)
				close(started)
				select {
				case <-gate:
					smallAssessment(.9)(w, r)
				case <-r.Context().Done():
				}
			}, nil)
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			res, e := http.DefaultClient.Do(request(ctx, s.URL, semanticRequest))
			if e != nil {
				close(gate)
				t.Fatal(e)
			}
			io.Copy(io.Discard, res.Body)
			res.Body.Close()
			if res.Header.Get("X-AMR-Semantic-Status") != status || res.Header.Get("X-AMR-Selected-Model") != "model-a" {
				close(gate)
				t.Fatalf("incorrect shadow route %v", res.Header)
			}
			<-started
			close(gate)
			eventually(t, func() bool { g.reviewsMu.Lock(); defer g.reviewsMu.Unlock(); return len(g.reviews) == 1 })
			if calls.Load() != 1 {
				t.Fatal("shadow sent a second answer")
			}
		})
	}
}
func TestExplicitScopeAndRuntimeEndpointIsolation(t *testing.T) {
	var smallCalls atomic.Int64
	g, s, calls := semanticLab(t, reviewPolicy(), func(w http.ResponseWriter, r *http.Request) { smallCalls.Add(1); smallAssessment(.9)(w, r) }, func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, `{"data":[{"id":"model-a"}]}`) })
	req := request(context.Background(), s.URL, strings.Replace(semanticRequest, `"auto"`, `"model-b"`, 1))
	req.Header.Set("Authorization", "Bearer "+tenantAccess)
	res, e := http.DefaultClient.Do(req)
	if e != nil {
		t.Fatal(e)
	}
	io.Copy(io.Discard, res.Body)
	res.Body.Close()
	if res.StatusCode != 403 || calls.Load() != 0 || smallCalls.Load() != 0 {
		t.Fatal("explicit tenant restriction failed")
	}
	for _, tc := range []struct {
		token  string
		status int
	}{{tenantAccess, 403}, {accessToken, 200}} {
		req, _ := http.NewRequest("GET", s.URL+"/internal/v1/runtime", nil)
		req.Header.Set("Authorization", "Bearer "+tc.token)
		res, e := http.DefaultClient.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		body, _ := io.ReadAll(res.Body)
		res.Body.Close()
		if res.StatusCode != tc.status || strings.Contains(string(body), tenantUpstream) || strings.Contains(string(body), tenantAccess) {
			t.Fatal("runtime endpoint leaked credentials or permissions")
		}
	}
	if len(g.admission.Snapshot()) != 0 {
		t.Fatal("rejected request reserved capacity")
	}
}

func TestSemanticRequestDeadlineDoesNotReturnEmptySuccess(t *testing.T) {
	var started atomic.Int64
	g, s, calls := semanticLab(t, reviewPolicy(), func(w http.ResponseWriter, r *http.Request) {
		started.Add(1)
		io.Copy(io.Discard, r.Body)
		<-r.Context().Done()
	}, nil, 200*time.Millisecond)
	res, e := http.DefaultClient.Do(request(context.Background(), s.URL, semanticRequest))
	if e != nil {
		t.Fatal(e)
	}
	data, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 504 || !strings.Contains(string(data), "request_timeout") || started.Load() != 1 || calls.Load() != 0 || len(g.admission.Snapshot()) != 0 {
		t.Fatalf("deadline produced answer or reservation: %d %s", res.StatusCode, data)
	}
}
