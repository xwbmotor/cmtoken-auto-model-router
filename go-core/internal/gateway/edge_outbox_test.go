package gateway

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestOutboxRecoversEncryptedPendingEvents(t *testing.T) {
	var available atomic.Bool
	delivered := make(chan []byte, 8)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		if !available.Load() {
			w.WriteHeader(503)
			return
		}
		delivered <- raw
		w.WriteHeader(204)
	}))
	defer server.Close()
	dir := filepath.Join(t.TempDir(), "outbox")
	q, e := openEdgeOutbox(dir, server.URL, "fixture-token")
	if e != nil {
		t.Fatal(e)
	}
	payload := []byte(`{"kind":"native_complete","private":"do-not-store-plaintext"}`)
	if e = q.enqueue(payload); e != nil {
		t.Fatal(e)
	}
	q.close()
	files, _ := filepath.Glob(filepath.Join(dir, "*.evt"))
	if len(files) != 1 {
		t.Fatalf("pending files %d", len(files))
	}
	raw, _ := os.ReadFile(files[0])
	if bytes.Contains(raw, []byte("do-not-store-plaintext")) {
		t.Fatal("plaintext in outbox")
	}
	available.Store(true)
	restored, e := openEdgeOutbox(dir, server.URL, "fixture-token")
	if e != nil {
		t.Fatal(e)
	}
	defer restored.close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if e = restored.drain(ctx); e != nil {
		t.Fatal(e)
	}
	if got := <-delivered; !bytes.Equal(got, payload) {
		t.Fatal("payload changed during recovery")
	}
	files, _ = filepath.Glob(filepath.Join(dir, "*.evt"))
	if len(files) != 0 {
		t.Fatal("acknowledged event not removed")
	}
}

func TestOutboxRetriesSameBytesAfterLostAcknowledgment(t *testing.T) {
	var calls atomic.Int32
	var first []byte
	var mu sync.Mutex
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		mu.Lock()
		defer mu.Unlock()
		if calls.Add(1) == 1 {
			first = raw
			connection, _, _ := w.(http.Hijacker).Hijack()
			connection.Close()
			return
		}
		if !bytes.Equal(first, raw) {
			t.Error("retry changed event")
		}
		w.WriteHeader(204)
	}))
	defer server.Close()
	q, e := openEdgeOutbox(filepath.Join(t.TempDir(), "outbox"), server.URL, "fixture-token")
	if e != nil {
		t.Fatal(e)
	}
	defer q.close()
	if e = q.enqueue([]byte(`{"id":"stable"}`)); e != nil {
		t.Fatal(e)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	if e = q.drain(ctx); e != nil {
		t.Fatal(e)
	}
	if calls.Load() < 2 {
		t.Fatal("lost ack did not retry")
	}
}

func TestOutboxRejectsCorruptRecoveryWithoutDeletingEvidence(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503) }))
	defer server.Close()
	dir := filepath.Join(t.TempDir(), "outbox")
	q, e := openEdgeOutbox(dir, server.URL, "fixture-token")
	if e != nil {
		t.Fatal(e)
	}
	if e = q.enqueue([]byte(`{"id":"saved"}`)); e != nil {
		t.Fatal(e)
	}
	q.close()
	files, _ := filepath.Glob(filepath.Join(dir, "*.evt"))
	raw, _ := os.ReadFile(files[0])
	raw[len(raw)-1] ^= 1
	os.WriteFile(files[0], raw, 0600)
	if recovered, e := openEdgeOutbox(dir, server.URL, "fixture-token"); e == nil {
		recovered.close()
		t.Fatal("corrupt record accepted")
	}
	if _, e = os.Stat(files[0]); e != nil {
		t.Fatal("corrupt evidence removed")
	}
}
