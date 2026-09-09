package gateway

import (
	"bufio"
	"bytes"
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

	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/decision"
)

const accessToken = "test-access-token-123456"
const assessorToken = "test-assessor-token-123456"

func inputFixture() decision.Input {
	return decision.Input{SchemaVersion: 1, ConfigVersion: "fixture", RequestedModel: "auto", CompletionTokens: 64,
		Analysis: decision.Analysis{Task: "extraction", Tier: "simple", Complexity: .1, EstimatedContextTokens: 100},
		Policy: decision.Policy{ScoreStrategy: "weighted", Mode: "active", AutoModelID: "auto", ActiveTrafficPercent: 100, QualityFloor: .72, QualityWeight: 1,
			RelativeQualityCap: .04, SubtaskSmoothK: 32, LatencyScaleMs: 300000, LoadEnabled: true, LoadPenaltyWeight: .2, ReasoningHighMin: .78, ReasoningOffMax: .3, BudgetDegradeThreshold: .9},
		Models:  []decision.Model{{ID: "model-a", Enabled: true, Ownership: "self_hosted", Quality: .9, Capacity: 1}},
		Runtime: decision.Runtime{NowMs: 1700000000000},
	}
}

func lab(t *testing.T, in decision.Input, upstream http.HandlerFunc, timeout time.Duration) (*Gateway, *httptest.Server) {
	t.Helper()
	a := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+assessorToken {
			t.Error("assessor auth not isolated")
		}
		_ = json.NewEncoder(w).Encode(in)
	}))
	t.Cleanup(a.Close)
	u := httptest.NewServer(upstream)
	t.Cleanup(u.Close)
	g, err := New(Options{AssessorURL: a.URL + "/assess", UpstreamURL: u.URL + "/v1/chat/completions", AccessToken: accessToken, AssessorToken: assessorToken, UpstreamToken: "mock-upstream-secret", AssessmentTimeout: time.Second, RequestTimeout: timeout, MaxRequests: 32})
	if err != nil {
		t.Fatal(err)
	}
	s := httptest.NewServer(g)
	t.Cleanup(s.Close)
	t.Cleanup(g.Close)
	return g, s
}

func request(ctx context.Context, base, data string) *http.Request {
	r, _ := http.NewRequestWithContext(ctx, "POST", base+"/v1/chat/completions", strings.NewReader(data))
	r.Header.Set("Authorization", "Bearer "+accessToken)
	r.Header.Set("Content-Type", "application/json")
	return r
}

func eventually(t *testing.T, fn func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if fn() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("condition did not become true")
}

func TestAdmissionReservesOnceAcrossConcurrentRequests(t *testing.T) {
	a := NewAdmission()
	in := inputFixture()
	in.Models[0].Capacity = 7
	var accepted atomic.Int32
	var wg sync.WaitGroup
	releases := make(chan func(), 100)
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, release, err := a.Select(in)
			if err == nil {
				accepted.Add(1)
				releases <- release
			}
		}()
	}
	wg.Wait()
	close(releases)
	if accepted.Load() != 7 || a.Snapshot()["model-a"] != 7 {
		t.Fatalf("overbooking: %d %+v", accepted.Load(), a.Snapshot())
	}
	for release := range releases {
		release()
		release()
	}
	if len(a.Snapshot()) != 0 {
		t.Fatal("reservation leak")
	}
}

func TestNonstreamBodyAndCredentials(t *testing.T) {
	in := inputFixture()
	in.Policy.ReasoningEnabled = true
	in.Models[0].ReasoningVerified = true
	in.Models[0].ReasoningParameter = "chat_template_kwargs.enable_thinking"
	in.Models[0].ReasoningValues = map[string]any{"off": false, "standard": true}
	g, s := lab(t, in, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer mock-upstream-secret" || r.Header.Get("Cookie") != "" || r.Header.Get("X-Forwarded-For") != "" {
			t.Error("caller credentials or forwarding identity leaked")
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["model"] != "model-a" || body["temperature"] != float64(0) {
			t.Errorf("body changed: %+v", body)
		}
		thinking := body["chat_template_kwargs"].(map[string]any)["enable_thinking"]
		if thinking != true {
			t.Error("client thinking override lost")
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Set-Cookie", "unsafe=1")
		_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"2"}}]}`)
	}, time.Second)
	r := request(context.Background(), s.URL, `{"model":"auto","messages":[{"role":"user","content":"1+1"}],"temperature":0,"chat_template_kwargs":{"enable_thinking":true}}`)
	r.Header.Set("Cookie", "private-cookie")
	r.Header.Set("X-Forwarded-For", "spoofed")
	res, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	payload, _ := io.ReadAll(res.Body)
	if res.StatusCode != 200 || !bytes.Contains(payload, []byte(`"content":"2"`)) || res.Header.Get("Set-Cookie") != "" {
		t.Fatalf("unexpected response %d %s", res.StatusCode, payload)
	}
	eventually(t, func() bool { return len(g.admission.Snapshot()) == 0 })
}

func TestSSEFlushesBeforeCompletionAndPreservesDone(t *testing.T) {
	finish := make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(finish) }) }
	defer unblock()
	g, s := lab(t, inputFixture(), func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"2\"}}]}\n\n")
		w.(http.Flusher).Flush()
		select {
		case <-finish:
		case <-r.Context().Done():
			return
		}
		_, _ = io.WriteString(w, "data: [DONE]\n\n")
	}, 3*time.Second)
	res, err := http.DefaultClient.Do(request(context.Background(), s.URL, `{"model":"auto","messages":[{"role":"user","content":"1+1"}],"stream":true}`))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	reader := bufio.NewReader(res.Body)
	line, err := reader.ReadString('\n')
	if err != nil || !strings.Contains(line, "content") {
		t.Fatalf("first event not flushed: %q %v", line, err)
	}
	if g.admission.Snapshot()["model-a"] != 1 {
		t.Fatal("released capacity before SSE completion")
	}
	unblock()
	rest, err := io.ReadAll(reader)
	if err != nil || !bytes.Contains(rest, []byte("data: [DONE]")) {
		t.Fatalf("incomplete SSE: %q %v", rest, err)
	}
	eventually(t, func() bool { return len(g.admission.Snapshot()) == 0 })
}

func TestCancellationReleasesReservationAndCancelsUpstream(t *testing.T) {
	cancelled := make(chan struct{})
	g, s := lab(t, inputFixture(), func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: first\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		close(cancelled)
	}, 3*time.Second)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	res, err := http.DefaultClient.Do(request(ctx, s.URL, `{"model":"auto","messages":[{"role":"user","content":"hello"}],"stream":true}`))
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	res.Body.Close()
	select {
	case <-cancelled:
	case <-time.After(2 * time.Second):
		t.Fatal("upstream not cancelled")
	}
	eventually(t, func() bool { return len(g.admission.Snapshot()) == 0 })
}

func TestTimeoutAndFailureNeverRetryOrLeakSlots(t *testing.T) {
	for _, mode := range []string{"timeout", "429", "redirect"} {
		t.Run(mode, func(t *testing.T) {
			var calls atomic.Int32
			g, s := lab(t, inputFixture(), func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				switch mode {
				case "timeout":
					_, _ = io.Copy(io.Discard, r.Body)
					<-r.Context().Done()
				case "429":
					w.WriteHeader(429)
					_, _ = io.WriteString(w, `{"error":"busy"}`)
				case "redirect":
					w.Header().Set("Location", "http://192.0.2.1/")
					w.WriteHeader(302)
				}
			}, 100*time.Millisecond)
			res, err := http.DefaultClient.Do(request(context.Background(), s.URL, `{"model":"auto","messages":[{"role":"user","content":"hello"}]}`))
			if err != nil {
				t.Fatal(err)
			}
			defer res.Body.Close()
			_, _ = io.ReadAll(res.Body)
			want := map[string]int{"timeout": 504, "429": 429, "redirect": 502}[mode]
			if res.StatusCode != want || calls.Load() != 1 {
				t.Fatalf("status %d; calls %d", res.StatusCode, calls.Load())
			}
			eventually(t, func() bool { return len(g.admission.Snapshot()) == 0 })
		})
	}
}

func TestSSETimeoutDoesNotFabricateDone(t *testing.T) {
	g, s := lab(t, inputFixture(), func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: first\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}, 100*time.Millisecond)
	res, err := http.DefaultClient.Do(request(context.Background(), s.URL, `{"model":"auto","messages":[{"role":"user","content":"hello"}],"stream":true}`))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	data, readErr := io.ReadAll(res.Body)
	if res.StatusCode != 200 || !bytes.Contains(data, []byte("data: first")) || bytes.Contains(data, []byte("[DONE]")) || readErr == nil {
		t.Fatalf("timeout must truncate, not fabricate a completed stream: %d %q %v", res.StatusCode, data, readErr)
	}
	eventually(t, func() bool { return len(g.admission.Snapshot()) == 0 })
}

func TestAssessorRedirectIsNotFollowed(t *testing.T) {
	var calls atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1) }))
	defer target.Close()
	assessor := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", target.URL)
		w.WriteHeader(307)
	}))
	defer assessor.Close()
	g, err := New(Options{AssessorURL: assessor.URL, UpstreamURL: target.URL, AccessToken: accessToken, AssessorToken: assessorToken, AssessmentTimeout: time.Second, RequestTimeout: time.Second, MaxRequests: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer g.Close()
	s := httptest.NewServer(g)
	defer s.Close()
	res, err := http.DefaultClient.Do(request(context.Background(), s.URL, `{"model":"auto","messages":[{"role":"user","content":"hello"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 502 || calls.Load() != 0 || len(g.admission.Snapshot()) != 0 {
		t.Fatal("assessment redirect was followed or reserved capacity")
	}
}

func TestRejectsUnauthorizedOversizedAndMalformedRequests(t *testing.T) {
	var calls atomic.Int32
	_, s := lab(t, inputFixture(), func(w http.ResponseWriter, r *http.Request) { calls.Add(1) }, time.Second)
	for _, tc := range []struct {
		name, body, auth string
		want             int
	}{
		{"unauthorized", `{}`, "", 401}, {"array", `[]`, accessToken, 400}, {"empty", `{"messages":[]}`, accessToken, 400},
		{"stream", `{"messages":[{}],"stream":"true"}`, accessToken, 400}, {"large", strings.Repeat("x", MaxBodyBytes+1), accessToken, 413},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := request(context.Background(), s.URL, tc.body)
			r.Header.Set("Authorization", "Bearer "+tc.auth)
			res, err := http.DefaultClient.Do(r)
			if err != nil {
				t.Fatal(err)
			}
			io.Copy(io.Discard, res.Body)
			res.Body.Close()
			if res.StatusCode != tc.want {
				t.Fatalf("%d != %d", res.StatusCode, tc.want)
			}
		})
	}
	if calls.Load() != 0 {
		t.Fatal("rejected input reached upstream")
	}
}

func TestOnlyExplicitLoopbackTargetsAreAllowed(t *testing.T) {
	for _, raw := range []string{"http://example.com:80/", "http://localhost:80/", "http://192.0.2.1:80/", "http://127.0.0.1/", "http://key@127.0.0.1:80/", "http://127.0.0.1:80/?token=x"} {
		if _, err := LoopbackURL(raw); err == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
	for _, raw := range []string{"http://127.0.0.1:8080/v1/chat/completions", "http://[::1]:8080/assess"} {
		if _, err := LoopbackURL(raw); err != nil {
			t.Fatal(err)
		}
	}
}
