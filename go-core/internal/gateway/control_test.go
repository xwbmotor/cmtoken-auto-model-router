package gateway

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/auth"
)

func TestControlStatusProbeLeaseAndBusinessCapacity(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	t.Cleanup(func() { once.Do(func() { close(release) }) })
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		io.WriteString(w, `{"choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}`)
	}))
	t.Cleanup(up.Close)
	dir := t.TempDir()
	path := filepath.Join(dir, "runtime.json")
	b := nativeBundle(t, "a")
	b.Features.Routing["loadBalancing"] = map[string]any{"enabled": true, "limits": map[string]any{"model-a": 1, "model-b": 1}}
	b.Features.Models[1]["enabled"] = false
	writeNativeBundle(t, path, b)
	m, err := NewManaged(ManagedOptions{RuntimeConfigFile: path, LedgerPath: filepath.Join(dir, "ledger.wal"),
		Auth: auth.Config{AccessToken: accessToken, UpstreamToken: "upstream", AdminToken: reloadAdmin}, Gateway: Options{UpstreamURL: up.URL, MaxRequests: 8, AssessmentTimeout: time.Second}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.Close)
	server := httptest.NewServer(m)
	t.Cleanup(server.Close)
	t.Cleanup(func() { once.Do(func() { close(release) }) })
	call := func(method, path, token string, payload any) (int, map[string]any) {
		t.Helper()
		raw, _ := json.Marshal(payload)
		r, err := http.NewRequest(method, server.URL+path, bytes.NewReader(raw))
		if err != nil {
			t.Fatal(err)
		}
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		res, err := server.Client().Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var body map[string]any
		if err = json.NewDecoder(res.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		return res.StatusCode, body
	}
	status := func() map[string]any {
		t.Helper()
		code, body := call("GET", "/internal/v1/status", reloadAdmin, nil)
		if code != 200 {
			t.Fatalf("status %d", code)
		}
		return body
	}
	if code, _ := call("GET", "/internal/v1/status", "", nil); code != 403 {
		t.Fatalf("unauthorized status %d", code)
	}
	s := status()
	if s["revision"] != m.active.revision || s["configRevision"] != b.Revision || s["sessions"] != float64(0) || s["edgeEnabled"] != false || s["persistenceHealthy"] != true {
		t.Fatalf("status schema: %+v", s)
	}
	if _, ok := s["health"].(map[string]any); !ok {
		t.Fatal("health not object")
	}
	load := func() float64 {
		t.Helper()
		value := status()["inflight"].(map[string]any)["model-a"]
		if value == nil {
			return 0
		}
		return value.(float64)
	}
	payload := map[string]any{"model": "model-a", "ttlMs": 10000, "configRevision": b.Revision}
	if code, _ := call("POST", "/internal/v1/probe/acquire", "", payload); code != 403 {
		t.Fatal("unauthorized probe accepted")
	}
	bad := map[string]any{"model": "model-a", "ttlMs": 10000, "configRevision": `"` + strings.Repeat("b", 64) + `"`}
	if code, _ := call("POST", "/internal/v1/probe/acquire", reloadAdmin, bad); code != 409 {
		t.Fatal("stale revision accepted")
	}
	for _, ttl := range []any{0, -1, 120001, "invalid", 1.5} {
		bad = map[string]any{"model": "model-a", "ttlMs": ttl, "configRevision": b.Revision}
		if code, _ := call("POST", "/internal/v1/probe/acquire", reloadAdmin, bad); code != 400 {
			t.Fatalf("invalid TTL %v returned %d", ttl, code)
		}
	}
	bad = map[string]any{"model": "model-a", "ttlMs": 10000, "configRevision": b.Revision, "unknown": true}
	if code, _ := call("POST", "/internal/v1/probe/acquire", reloadAdmin, bad); code != 400 {
		t.Fatal("unknown field accepted")
	}
	if load() != 0 {
		t.Fatal("rejected requests reserved capacity")
	}
	code, body := call("POST", "/internal/v1/probe/acquire", reloadAdmin, payload)
	lease, _ := body["lease"].(string)
	if code != 200 || !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(lease) || load() != 1 {
		t.Fatalf("acquire: %d %+v", code, body)
	}
	chat := map[string]any{"model": "auto", "messages": []any{map[string]string{"role": "user", "content": "hello"}}}
	if code, _ := call("POST", "/v1/chat/completions", accessToken, chat); code != 503 {
		t.Fatalf("business bypassed probe slot: %d", code)
	}
	for range 2 {
		if code, body := call("POST", "/internal/v1/probe/release", reloadAdmin, map[string]string{"lease": lease}); code != 200 || body["released"] != true {
			t.Fatal("release failed")
		}
	}
	if load() != 0 {
		t.Fatal("release leaked slot")
	}
	done := make(chan int, 1)
	go func() { code, _ := call("POST", "/v1/chat/completions", accessToken, chat); done <- code }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("business did not reach provider")
	}
	if load() != 1 {
		t.Fatal("business occupancy missing")
	}
	if code, _ := call("POST", "/internal/v1/probe/acquire", reloadAdmin, payload); code != 409 {
		t.Fatal("probe bypassed business slot")
	}
	once.Do(func() { close(release) })
	if code := <-done; code != 200 {
		t.Fatalf("business response %d", code)
	}
	if load() != 0 {
		t.Fatal("business slot not released")
	}
}
