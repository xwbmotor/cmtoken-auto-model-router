package gateway

import (
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestTenantRateLimitIsolationRefillAndDisabled(t *testing.T) {
	var l tenantRateLimiter
	p := &RateLimitPolicy{Enabled: true, RPM: 60, Burst: 2}
	now := time.Unix(100, 0)
	for i := 0; i < 2; i++ {
		if ok, _ := l.check("Bearer tenant-a", p, now); !ok {
			t.Fatal("initial burst rejected")
		}
	}
	if ok, retry := l.check("Bearer tenant-a", p, now); ok || retry != 1 {
		t.Fatalf("exhausted: %v %d", ok, retry)
	}
	if ok, _ := l.check("Bearer tenant-b", p, now); !ok {
		t.Fatal("cross-tenant limit")
	}
	if ok, _ := l.check("Bearer tenant-a", p, now.Add(time.Second)); !ok {
		t.Fatal("refill missing")
	}
	p.Enabled = false
	if ok, _ := l.check("Bearer tenant-a", p, now); !ok {
		t.Fatal("disabled limit")
	}
}

func TestTenantRateLimitConcurrentAndBounded(t *testing.T) {
	var l tenantRateLimiter
	p := &RateLimitPolicy{Enabled: true, RPM: 60, Burst: 10}
	now := time.Unix(100, 0)
	var passed atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if ok, _ := l.check("tenant", p, now); ok {
				passed.Add(1)
			}
		}()
	}
	wg.Wait()
	if passed.Load() != 10 {
		t.Fatalf("passed %d", passed.Load())
	}
	for i := 0; len(l.buckets) < 20000; i++ {
		var key [32]byte
		key[0] = byte(i)
		key[1] = byte(i >> 8)
		key[2] = 1
		l.buckets[key] = rateBucket{last: now}
	}
	if ok, _ := l.check("new-tenant", p, now); ok {
		t.Fatal("unbounded buckets")
	}
	if ok, _ := l.check("new-tenant", p, now.Add(11*time.Minute)); !ok {
		t.Fatal("idle buckets not pruned")
	}
	if len(l.buckets) != 1 {
		t.Fatalf("buckets=%d", len(l.buckets))
	}
}

func TestManagedTenantRateLimitBeforeUpstream(t *testing.T) {
	b := managedBundle()
	b.Runtime.RateLimit = &RateLimitPolicy{Enabled: true, RPM: 1, Burst: 1}
	var calls atomic.Int32
	_, s := managedLab(t, managedInput(), b, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}`))
	})
	for i, want := range []int{200, 429} {
		req, _ := http.NewRequest("POST", s.URL+"/v1/chat/completions", strings.NewReader(`{"messages":[{"role":"user","content":"hello"}],"max_tokens":64}`))
		req.Header.Set("Authorization", "Bearer "+accessToken)
		res, e := http.DefaultClient.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		res.Body.Close()
		if res.StatusCode != want {
			t.Fatalf("request %d status=%d", i, res.StatusCode)
		}
		if want == 429 && res.Header.Get("Retry-After") == "" {
			t.Fatal("missing retry hint")
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("upstream calls=%d", calls.Load())
	}
}
