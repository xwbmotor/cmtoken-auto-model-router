package gateway

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"
)

func TestNativeFrontAdvertisesPublicIdleLifetime(t *testing.T) {
	front, err := NewNativeFront(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	}), "http://127.0.0.1:8789", strings.Repeat("s", 40))
	if err != nil {
		t.Fatal(err)
	}
	defer front.Close()
	for _, tc := range []struct {
		protocol int
		close    bool
		want     string
	}{
		{1, false, "timeout=300"}, {1, true, ""}, {2, false, ""},
	} {
		r := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(`{}`))
		r.Header.Set("Authorization", "Bearer fixture")
		r.ProtoMajor, r.Close = tc.protocol, tc.close
		w := httptest.NewRecorder()
		front.ServeHTTP(w, r)
		if got := w.Header().Get("Keep-Alive"); got != tc.want {
			t.Fatalf("protocol %d close %v: keep-alive %q", tc.protocol, tc.close, got)
		}
	}
	if NativeIdleTimeout != 300*time.Second {
		t.Fatal("public timeout contract changed")
	}
}

func TestNativeCompletionWaitsForAckAndNeverForwardsCredentials(t *testing.T) {
	const secret = "native-session-secret-for-test-00000001"
	var revision string
	var providerCalls atomic.Int64
	var reject atomic.Bool
	received, release := make(chan []byte, 2), make(chan struct{})
	var releaseOnce sync.Once
	defer releaseOnce.Do(func() { close(release) })
	m, b := edgeTestManaged(t, func(w http.ResponseWriter, r *http.Request) {
		providerCalls.Add(1)
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["__amr_edge"] != nil {
			t.Error("forged edge context leaked")
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"choices":[{"message":{"content":"hello"}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}`)
	}, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+edgeTestToken {
			t.Error("missing edge authentication")
		}
		if r.Method == "GET" && r.URL.Path == "/internal/v1/go-context" {
			h := hmac.New(sha256.New, []byte(secret))
			h.Write([]byte("go-native-front-v1"))
			_ = json.NewEncoder(w).Encode(nativeContext{ConfigRevision: revision, SessionProof: hex.EncodeToString(h.Sum(nil)), MarketSignals: map[string]map[string]float64{}})
			return
		}
		raw, _ := io.ReadAll(r.Body)
		received <- raw
		if reject.Load() {
			w.WriteHeader(422)
			return
		}
		<-release
		w.WriteHeader(204)
	})
	revision = b.Revision
	m.active.g.options.SemanticBucketSecret = []byte(secret)
	front, err := NewNativeFront(m, strings.TrimSuffix(m.options.Gateway.EdgeURL, "/internal/v1/go-events"), edgeTestToken)
	if err != nil {
		t.Fatal(err)
	}
	defer front.Close()
	server := httptest.NewServer(front)
	defer server.Close()
	call := func() error {
		r, _ := http.NewRequest("POST", server.URL+"/v1/chat/completions", strings.NewReader(`{"messages":[{"role":"user","content":"hello"}],"__amr_edge":{"id":"forged"}}`))
		r.Header.Set("Authorization", "Bearer "+accessToken)
		r.Header.Set("X-Session-ID", "private-session")
		res, e := server.Client().Do(r)
		if e != nil {
			return e
		}
		defer res.Body.Close()
		_, e = io.ReadAll(res.Body)
		return e
	}
	completed := make(chan error, 1)
	go func() { completed <- call() }()
	var raw []byte
	select {
	case raw = <-received:
	case <-time.After(3 * time.Second):
		t.Fatal("no completion event")
	}
	for _, private := range []string{accessToken, edgeTestToken, secret, "provider-test-token", "private-session", "forged"} {
		if strings.Contains(string(raw), private) {
			t.Errorf("private value in callback: %s", private)
		}
	}
	var event struct {
		Kind    string        `json:"kind"`
		Request nativeRequest `json:"request"`
		Result  struct {
			OK     bool   `json:"ok"`
			Answer string `json:"answerText"`
		} `json:"result"`
	}
	if json.Unmarshal(raw, &event) != nil || event.Kind != "native_complete" || !event.Result.OK || event.Result.Answer != "hello" || len(event.Request.Events) != 1 {
		t.Fatalf("invalid outcome: %s", raw)
	}
	select {
	case <-completed:
		t.Fatal("HTTP completed before callback ACK")
	case <-time.After(20 * time.Millisecond):
	}
	releaseOnce.Do(func() { close(release) })
	if err := <-completed; err != nil {
		t.Fatal(err)
	}
	reject.Store(true)
	if err := call(); err == nil {
		t.Fatal("failed event ACK appeared successful")
	}
	if providerCalls.Load() != 2 {
		t.Fatalf("unexpected provider retry: %d", providerCalls.Load())
	}
}

func TestNativeFrontPrivateIsolationAndCompatibility(t *testing.T) {
	nodeCalls, goCalls := 0, 0
	node := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		nodeCalls++
		w.Header().Set("X-Test-Host", r.Host)
		io.WriteString(w, "node")
	}))
	defer node.Close()
	front, err := NewNativeFront(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		goCalls++
		if r.Context().Value(nativeFrontKey{}) == nil {
			t.Error("missing trusted context")
		}
		io.WriteString(w, "go")
	}), node.URL, edgeTestToken)
	if err != nil {
		t.Fatal(err)
	}
	defer front.Close()
	for _, tc := range []struct {
		method, path, origin, encoding, want string
		status                               int
	}{
		{"POST", "/v1/chat/completions", "", "", "go", 200},
		{"POST", "/v1/chat/completions?compat=1", "", "", "node", 200},
		{"POST", "/v1/chat/completions", "https://example.test", "", "node", 200},
		{"POST", "/v1/chat/completions", "", "gzip", "node", 200},
		{"GET", "/admin", "", "", "node", 200},
		{"GET", "/internal/v1/runtime", "", "", "not_found", 404},
		{"POST", "/internal/v1/go-events", "", "", "not_found", 404},
	} {
		r := httptest.NewRequest(tc.method, "http://original.test"+tc.path, strings.NewReader("{}"))
		r.Header.Set("Authorization", "Bearer public-key")
		r.Header.Set("Origin", tc.origin)
		r.Header.Set("Content-Encoding", tc.encoding)
		w := httptest.NewRecorder()
		front.ServeHTTP(w, r)
		if w.Code != tc.status || !strings.Contains(w.Body.String(), tc.want) {
			t.Fatalf("%s: %d %s", tc.path, w.Code, w.Body.String())
		}
		if tc.want == "node" && w.Header().Get("X-Test-Host") != "original.test" {
			t.Fatal("public host changed")
		}
	}
	if goCalls != 1 || nodeCalls != 4 {
		t.Fatalf("unexpected dispatch: Go=%d Node=%d", goCalls, nodeCalls)
	}
}

func TestNativeAnswerCaptureFragmentedUTF8AndReasoningTiming(t *testing.T) {
	w := &nativeWriter{ResponseWriter: httptest.NewRecorder(), started: time.Now(), status: 200}
	w.Header().Set("Content-Type", "text/event-stream")
	_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"think\"}}]}\n\n"))
	if w.firstOutputMS == nil || w.firstContentMS != nil {
		t.Fatal("reasoning must not establish content TTFT")
	}
	data := []byte("data: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}\n\ndata: [DONE]\n\n")
	for _, b := range data {
		if _, err := w.Write([]byte{b}); err != nil {
			t.Fatal(err)
		}
	}
	if w.answer.String() != "你好" || w.firstContentMS == nil || w.firstOutputMS == nil {
		t.Fatalf("missing output: %q", w.answer.String())
	}
}

func TestNativeAnswerRetentionUsesFirstChoiceAndUTF16Limit(t *testing.T) {
	w := &nativeWriter{ResponseWriter: httptest.NewRecorder(), started: time.Now(), status: 200}
	raw, _ := json.Marshal(map[string]any{"choices": []any{
		map[string]any{"message": map[string]string{"content": strings.Repeat("中", 65533) + "😀尾多余"}},
		map[string]any{"message": map[string]string{"content": "different choice"}},
	}})
	w.observe(raw)
	if w.answerUnits != 65536 || !utf8.ValidString(w.answer.String()) || !strings.HasSuffix(w.answer.String(), "😀尾") || strings.Contains(w.answer.String(), "different choice") {
		t.Fatal("answer capture contract changed")
	}
}
