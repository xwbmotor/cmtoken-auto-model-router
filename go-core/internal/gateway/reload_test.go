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
	"testing"
	"time"

	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/auth"
)

const reloadAdmin = "reload-admin-secret"

func reloadBundle(letter string) Bundle {
	var b Bundle
	b.Revision = `"` + strings.Repeat(letter, 64) + `"`
	b.Analysis.TaskRules.SimpleMaxComplexity = .3
	b.Analysis.TaskRules.ComplexMinComplexity = .7
	b.Analysis.Budget.DefaultEstimatedOutputTokens = 64
	b.Runtime = RuntimePolicy{MaxAttempts: 1, RequestTimeoutMS: 5000, CircuitBreakerFailures: 3, CircuitBreakerCooldownMS: 1000, TimeZone: "Asia/Shanghai", Prices: map[string]Price{"model-" + letter: {Input: billingPrice(2), Output: billingPrice(4)}}}
	return b
}

type reloadFixture struct {
	m             *Managed
	s             *httptest.Server
	mu            sync.Mutex
	bundle        Bundle
	authPath      string
	configStarted chan struct{}
	configRelease chan struct{}
}

func newReloadFixture(t *testing.T, cfg auth.Config, upstream http.HandlerFunc) *reloadFixture {
	t.Helper()
	f := &reloadFixture{bundle: reloadBundle("a"), authPath: filepath.Join(t.TempDir(), "auth.json")}
	f.writeAuth(t, cfg)
	adapter := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+assessorToken {
			t.Error("adapter credential mismatch")
			w.WriteHeader(401)
			return
		}
		if r.URL.Path == "/runtime-config" {
			f.mu.Lock()
			b, started, release := f.bundle, f.configStarted, f.configRelease
			f.mu.Unlock()
			if started != nil {
				select {
				case started <- struct{}{}:
				default:
				}
				select {
				case <-release:
				case <-r.Context().Done():
					return
				}
			}
			_ = json.NewEncoder(w).Encode(b)
			return
		}
		revision := r.Header.Get("X-AMR-Config-Revision")
		if revision != reloadBundle("a").Revision && revision != reloadBundle("b").Revision {
			w.WriteHeader(409)
			return
		}
		in := inputFixture()
		in.Models[0].Capacity = 32
		if revision == reloadBundle("b").Revision {
			in.Models[0].ID = "model-b"
		}
		w.Header().Set("X-AMR-Config-Revision", revision)
		_ = json.NewEncoder(w).Encode(in)
	}))
	t.Cleanup(adapter.Close)
	u := httptest.NewServer(upstream)
	t.Cleanup(u.Close)
	m, err := NewManaged(ManagedOptions{AuthFile: f.authPath, LedgerPath: filepath.Join(t.TempDir(), "ledger.jsonl"), Gateway: Options{AssessorURL: adapter.URL + "/assess", AssessorToken: assessorToken, AccessToken: accessToken, UpstreamURL: u.URL + "/v1/chat/completions", AssessmentTimeout: time.Second, RequestTimeout: 5 * time.Second, MaxRequests: 32}})
	if err != nil {
		t.Fatal(err)
	}
	f.m = m
	f.s = httptest.NewServer(m)
	t.Cleanup(m.Close)
	t.Cleanup(f.s.Close)
	return f
}
func (f *reloadFixture) writeAuth(t *testing.T, c auth.Config) {
	t.Helper()
	raw, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(f.authPath, raw, 0600); err != nil {
		t.Fatal(err)
	}
}
func (f *reloadFixture) setBundle(b Bundle) { f.mu.Lock(); f.bundle = b; f.mu.Unlock() }
func reloadCall(t *testing.T, handler http.Handler, method, path, token, revision string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, path, strings.NewReader(`{"model":"auto","messages":[{"role":"user","content":"Extract names"}]}`))
	r.Header.Set("Authorization", "Bearer "+token)
	if revision != "" {
		r.Header.Set("If-Match", revision)
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}
func (f *reloadFixture) revision(t *testing.T) string {
	t.Helper()
	w := reloadCall(t, f.m, "GET", "/internal/v1/config", reloadAdmin, "")
	if w.Code != 200 {
		t.Fatalf("config status %d", w.Code)
	}
	return w.Header().Get("ETag")
}

func TestManagedReloadPinsInflightCredentialsPolicyAndRevision(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	defer once.Do(func() { close(release) })
	f := newReloadFixture(t, auth.Config{AccessToken: accessToken, UpstreamToken: "old-upstream", AdminToken: reloadAdmin}, func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Model string `json:"model"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if r.Header.Get("Authorization") == "Bearer old-upstream" {
			close(started)
			select {
			case <-release:
			case <-r.Context().Done():
				return
			}
			if body.Model != "model-a" {
				t.Error("old request changed model")
			}
		} else if r.Header.Get("Authorization") != "Bearer new-upstream" || body.Model != "model-b" {
			t.Error("new request did not capture complete generation")
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": "ok"}}}, "model": body.Model, "usage": map[string]int{"prompt_tokens": 10, "completion_tokens": 2}})
	})
	oldRevision := f.revision(t)
	result := make(chan *httptest.ResponseRecorder, 1)
	go func() { result <- reloadCall(t, f.m, "POST", "/v1/chat/completions", accessToken, "") }()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("old request never reached upstream")
	}
	f.writeAuth(t, auth.Config{AccessToken: "new-access-token", UpstreamToken: "new-upstream", AdminToken: reloadAdmin})
	f.setBundle(reloadBundle("b"))
	w := reloadCall(t, f.m, "POST", "/internal/v1/config/reload", reloadAdmin, oldRevision)
	if w.Code != 200 || w.Header().Get("ETag") == oldRevision {
		t.Fatalf("reload failed %d %s", w.Code, w.Body.String())
	}
	newRevision := w.Header().Get("ETag")
	if w := reloadCall(t, f.m, "POST", "/v1/chat/completions", accessToken, ""); w.Code != 401 {
		t.Fatal("retired access key still active")
	}
	next := reloadCall(t, f.m, "POST", "/v1/chat/completions", "new-access-token", "")
	if next.Code != 200 || next.Header().Get("X-AMR-Runtime-Revision") != newRevision || next.Header().Get("X-AMR-Config-Revision") != reloadBundle("b").Revision {
		t.Fatalf("new generation inconsistent %d %s", next.Code, next.Body.String())
	}
	once.Do(func() { close(release) })
	select {
	case old := <-result:
		if old.Code != 200 || old.Header().Get("X-AMR-Runtime-Revision") != oldRevision || old.Header().Get("X-AMR-Config-Revision") != reloadBundle("a").Revision {
			t.Fatalf("old generation inconsistent %d %s", old.Code, old.Body.String())
		}
	case <-time.After(3 * time.Second):
		t.Fatal("old request stalled")
	}
}

func TestManagedReloadRejectsStaleInvalidAndUnauthorized(t *testing.T) {
	f := newReloadFixture(t, auth.Config{Mode: "passthrough", AdminToken: reloadAdmin}, func(w http.ResponseWriter, r *http.Request) {
		t.Error("administrative credential forwarded")
		w.WriteHeader(500)
	})
	revision := f.revision(t)
	for _, tc := range []struct {
		token, revision string
		status          int
	}{{"tenant", revision, 403}, {reloadAdmin, "", 428}, {reloadAdmin, `"stale"`, 409}} {
		w := reloadCall(t, f.m, "POST", "/internal/v1/config/reload", tc.token, tc.revision)
		if w.Code != tc.status {
			t.Fatalf("got %d want %d", w.Code, tc.status)
		}
	}
	if w := reloadCall(t, f.m, "POST", "/v1/chat/completions", reloadAdmin, ""); w.Code != 401 {
		t.Fatal("admin forwarded")
	}
	for _, path := range []string{"/internal/v1/config", "/internal/v1/runtime"} {
		if w := reloadCall(t, f.m, "GET", path, "tenant", ""); w.Code != 403 {
			t.Fatal("passthrough grants admin")
		}
	}
	for _, kind := range []string{"runtime", "re2", "auth"} {
		b := reloadBundle("b")
		switch kind {
		case "runtime":
			b.Runtime.MaxAttempts = 0
		case "re2":
			b.Analysis.TaskRules.Patterns = map[string][]string{"extraction": {"(?<=bad)pattern"}}
		case "auth":
			f.writeAuth(t, auth.Config{Mode: "strict"})
		}
		f.setBundle(b)
		w := reloadCall(t, f.m, "POST", "/internal/v1/config/reload", reloadAdmin, revision)
		if w.Code != 422 || f.revision(t) != revision {
			t.Fatalf("%s rejection changed snapshot/status=%d", kind, w.Code)
		}
	}
}

func TestManagedCloseAndReloadDoNotDeadlock(t *testing.T) {
	f := newReloadFixture(t, auth.Config{AccessToken: accessToken, UpstreamToken: "upstream", AdminToken: reloadAdmin}, func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, `{}`) })
	revision := f.revision(t)
	started, release := make(chan struct{}, 1), make(chan struct{})
	f.mu.Lock()
	f.configStarted = started
	f.configRelease = release
	f.mu.Unlock()
	reloaded, closed := make(chan struct{}), make(chan struct{})
	go func() {
		reloadCall(t, f.m, "POST", "/internal/v1/config/reload", reloadAdmin, revision)
		close(reloaded)
	}()
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("reload did not start")
	}
	go func() { f.m.Close(); close(closed) }()
	close(release)
	select {
	case <-reloaded:
	case <-time.After(3 * time.Second):
		t.Fatal("reload/close deadlock")
	}
	select {
	case <-closed:
	case <-time.After(3 * time.Second):
		t.Fatal("close/reload deadlock")
	}
	if w := reloadCall(t, f.m, "GET", "/health", "", ""); w.Code != 503 {
		t.Fatal("closed runtime still serving")
	}
}
