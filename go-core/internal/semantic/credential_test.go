package semantic

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

func TestCandidateConcurrentCredentialsStayRequestLocal(t *testing.T) {
	var arrived atomic.Int32
	release := make(chan struct{})
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, _ := io.ReadAll(r.Body)
		want := "upstream-alpha"
		if strings.Contains(string(data), "tenant-beta") {
			want = "upstream-beta"
		}
		if r.Header.Get("Authorization") != "Bearer "+want {
			t.Error("cross-request credential mismatch")
		}
		if arrived.Add(1) == 2 {
			close(release)
		}
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": assessmentJSON(.95)}}}})
	}))
	defer s.Close()
	p := policyFixture()
	p.Provider = "openai-chat"
	p.LargeTimeoutMS = 3000
	c, err := New(Options{Candidate: true, Policy: p, LargeURL: s.URL, LargeToken: "never-use-server-token", MaxConcurrent: 2, MaxLargeCalls: 10, MaxLargeTokens: 100000})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	var wg sync.WaitGroup
	for _, tenant := range []string{"alpha", "beta"} {
		wg.Add(1)
		go func(tenant string) {
			defer wg.Done()
			raw := []byte(`{"messages":[{"role":"user","content":"tenant-` + tenant + `"}]}`)
			if _, err := c.ClassifyWithCredential(context.Background(), raw, "upstream-"+tenant); err != nil {
				t.Error(err)
			}
		}(tenant)
	}
	wg.Wait()
	if arrived.Load() != 2 || c.options.LargeToken != "never-use-server-token" {
		t.Fatal("shared options changed or requests lost")
	}
}

func TestCandidateMissingCredentialCannotFallbackOrSpendGuard(t *testing.T) {
	for _, provider := range []string{"openai-chat", "cascade"} {
		t.Run(provider, func(t *testing.T) {
			var calls atomic.Int32
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); w.WriteHeader(500) }))
			defer s.Close()
			p := policyFixture()
			p.Provider = provider
			c, err := New(Options{Candidate: true, Policy: p, SmallURL: s.URL, LargeURL: s.URL, LargeToken: "never-use-server-token", MaxConcurrent: 1, MaxLargeCalls: 10, MaxLargeTokens: 100000})
			if err != nil {
				t.Fatal(err)
			}
			defer c.Close()
			if _, err := c.Classify(context.Background(), classifyBody); err == nil {
				t.Fatal("missing credential accepted")
			}
			if calls.Load() != 0 || c.Snapshot().LargeCalls != 0 {
				t.Fatal("missing credential caused network or billing")
			}
			c.options.LargeToken = ""
			if other, err := New(c.options); err != nil {
				t.Fatal("candidate required static token", err)
			} else {
				other.Close()
			}
		})
	}
}

func TestLabKeepsDedicatedClassifierCredential(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer lab-classifier-token" {
			t.Error("lab credential contract changed")
		}
		json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": assessmentJSON(.95)}}}})
	}))
	defer s.Close()
	p := policyFixture()
	p.Provider = "openai-chat"
	c, err := New(Options{Policy: p, LargeURL: s.URL, LargeToken: "lab-classifier-token", MaxConcurrent: 1, MaxLargeCalls: 10, MaxLargeTokens: 100000})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if _, err := c.ClassifyWithCredential(context.Background(), classifyBody, "tenant-upstream-token"); err != nil {
		t.Fatal(err)
	}
}
