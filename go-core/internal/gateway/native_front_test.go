package gateway

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

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
	data := []byte("data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"think\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}\n\ndata: [DONE]\n\n")
	for _, b := range data {
		if _, err := w.Write([]byte{b}); err != nil {
			t.Fatal(err)
		}
	}
	if w.answer.String() != "你好" || w.firstContentMS == nil || w.firstOutputMS == nil {
		t.Fatalf("missing output: %q", w.answer.String())
	}
}
