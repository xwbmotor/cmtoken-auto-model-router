package scope

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestCredentialIsolationAndSingleFlight(t *testing.T) {
	gate := make(chan struct{})
	started := make(chan struct{}, 1)
	var calls atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Header.Get("Authorization") == "Bearer tenant-a" {
			select {
			case started <- struct{}{}:
			default:
			}
			<-gate
			io.WriteString(w, `{"data":[{"id":"a"},{"id":"a"}]}`)
		} else {
			io.WriteString(w, `{"data":[{"id":"b"}]}`)
		}
	}))
	defer server.Close()
	cache, e := New(server.URL, time.Minute, time.Second)
	if e != nil {
		t.Fatal(e)
	}
	defer cache.Close()
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ids := cache.Resolve(context.Background(), "tenant-a")
			if len(ids) != 1 || ids[0] != "a" {
				t.Errorf("unexpected scope %v", ids)
			}
		}()
	}
	<-started
	close(gate)
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatalf("cold cache stampede: %d", calls.Load())
	}
	ids := cache.Resolve(context.Background(), "tenant-a")
	ids[0] = "tampered"
	if cache.Resolve(context.Background(), "tenant-a")[0] != "a" {
		t.Fatal("caller mutated cached authorization")
	}
	if ids := cache.Resolve(context.Background(), "tenant-b"); len(ids) != 1 || ids[0] != "b" {
		t.Fatal("tenant cache leaked")
	}
	cache.mu.Lock()
	for key := range cache.entries {
		if len(key) != 64 {
			t.Error("cache retained raw credential")
		}
	}
	cache.mu.Unlock()
}
func TestStaleRefreshReturnsImmediatelyAndIsDeduplicated(t *testing.T) {
	var calls atomic.Int64
	refreshStarted := make(chan struct{})
	gate := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := calls.Add(1)
		if n > 1 {
			close(refreshStarted)
			<-gate
		}
		json.NewEncoder(w).Encode(map[string]any{"data": []any{map[string]any{"id": map[bool]string{true: "old", false: "new"}[n == 1]}}})
	}))
	defer server.Close()
	cache, e := New(server.URL, time.Minute, time.Second)
	if e != nil {
		t.Fatal(e)
	}
	defer cache.Close()
	cache.Resolve(context.Background(), "tenant")
	cache.mu.Lock()
	cache.entries[cache.key("tenant")].at = time.Now().Add(-2 * time.Minute)
	cache.mu.Unlock()
	if ids := cache.Resolve(context.Background(), "tenant"); len(ids) != 1 || ids[0] != "old" {
		t.Fatal("stale value was not returned")
	}
	<-refreshStarted
	for i := 0; i < 20; i++ {
		if ids := cache.Resolve(context.Background(), "tenant"); ids[0] != "old" {
			t.Fatal("refresh blocked or erased prior snapshot")
		}
	}
	close(gate)
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		ids := cache.Resolve(context.Background(), "tenant")
		if len(ids) == 1 && ids[0] == "new" {
			if calls.Load() != 2 {
				t.Fatal("duplicate refresh")
			}
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("refresh did not complete")
}
func TestFailureEmptyAndRedirectRemainUnknown(t *testing.T) {
	for _, body := range []string{`{"data":[]}`, `{"data":[{"id":2}]}`, `{`, `null`} {
		t.Run(body, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, body) }))
			defer server.Close()
			cache, e := New(server.URL, time.Minute, time.Second)
			if e != nil {
				t.Fatal(e)
			}
			defer cache.Close()
			if cache.Resolve(context.Background(), "token") != nil {
				t.Fatal("invalid scope became authoritative")
			}
		})
	}
	var reached atomic.Int64
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { reached.Add(1) }))
	defer target.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, 302) }))
	defer redirect.Close()
	cache, _ := New(redirect.URL, time.Minute, time.Second)
	defer cache.Close()
	if cache.Resolve(context.Background(), "token") != nil || reached.Load() != 0 {
		t.Fatal("redirect followed")
	}
}
func TestCloseCancelsOutstandingRefresh(t *testing.T) {
	started := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { close(started); <-r.Context().Done() }))
	defer server.Close()
	cache, _ := New(server.URL, time.Minute, time.Second)
	done := make(chan struct{})
	go func() { cache.Resolve(context.Background(), "token"); close(done) }()
	<-started
	cache.Close()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("close left scope request running")
	}
	if cache.Resolve(context.Background(), "token") != nil {
		t.Fatal("closed cache made another request")
	}
}
