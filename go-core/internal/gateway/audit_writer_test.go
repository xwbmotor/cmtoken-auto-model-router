package gateway

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func auditTestState(t *testing.T) (*runtimeState, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "audit.jsonl")
	j, err := openAudit(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { j.Close() })
	return &runtimeState{audit: j}, path
}
func auditRecordAsync(s *runtimeState, id string) <-chan error {
	done := make(chan error, 1)
	go func() { done <- s.record(attemptEvent{RequestID: id, Status: 200, Outcome: "success"}) }()
	return done
}
func auditWaitQueued(t *testing.T, j *auditJournal, n int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for len(j.queue) != n {
		if time.Now().After(deadline) {
			t.Fatalf("audit queued %d, want %d", len(j.queue), n)
		}
		time.Sleep(time.Millisecond)
	}
}
func auditUnblockCleanup(t *testing.T, c chan struct{}) {
	t.Helper()
	t.Cleanup(func() {
		select {
		case <-c:
		default:
			close(c)
		}
	})
}
func auditWait(t *testing.T, c <-chan struct{}) {
	t.Helper()
	select {
	case <-c:
	case <-time.After(5 * time.Second):
		t.Fatal("audit barrier timeout")
	}
}

func TestAuditBatchDurabilityBoundAndCloseDrain(t *testing.T) {
	s, path := auditTestState(t)
	j := s.audit
	entered, release := make(chan struct{}), make(chan struct{})
	auditUnblockCleanup(t, release)
	var syncs atomic.Int64
	j.syncFile = func() error {
		if syncs.Add(1) == 1 {
			close(entered)
			<-release
		}
		return j.file.Sync()
	}
	first := auditRecordAsync(s, "first")
	auditWait(t, entered)
	results := make([]<-chan error, 130)
	for i := range results {
		results[i] = auditRecordAsync(s, fmt.Sprint(i))
	}
	auditWaitQueued(t, j, len(results))
	select {
	case err := <-first:
		t.Fatalf("audit ack before sync: %v", err)
	default:
	}
	closed := make(chan error, 1)
	go func() { closed <- j.Close() }()
	auditWaitQueued(t, j, len(results)+1)
	if err := s.record(attemptEvent{RequestID: "late"}); !errors.Is(err, os.ErrClosed) {
		t.Fatal(err)
	}
	select {
	case err := <-closed:
		t.Fatalf("audit closed before drain: %v", err)
	default:
	}
	close(release)
	if err := <-first; err != nil {
		t.Fatal(err)
	}
	for _, done := range results {
		if err := <-done; err != nil {
			t.Fatal(err)
		}
	}
	if err := <-closed; err != nil {
		t.Fatal(err)
	}
	if syncs.Load() != 4 {
		t.Fatal("audit batch bound or combination failed", syncs.Load())
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	lines := bytes.Split(bytes.TrimSpace(raw), []byte{'\n'})
	if len(lines) != 131 {
		t.Fatal(len(lines))
	}
	seen := map[string]bool{}
	for _, line := range lines {
		var e attemptEvent
		if json.Unmarshal(line, &e) != nil || seen[e.RequestID] || e.RequestID == "late" {
			t.Fatal("corrupt or duplicate audit line")
		}
		seen[e.RequestID] = true
	}
	reopened, err := openAudit(path)
	if err != nil {
		t.Fatal(err)
	}
	reopened.Close()
}

func TestAuditFailedSyncRejectsBatchAndFailsRuntimeClosed(t *testing.T) {
	s, _ := auditTestState(t)
	j := s.audit
	firstEntered, firstRelease := make(chan struct{}), make(chan struct{})
	batchEntered, batchRelease := make(chan struct{}), make(chan struct{})
	auditUnblockCleanup(t, firstRelease)
	auditUnblockCleanup(t, batchRelease)
	injected := errors.New("injected audit sync failure")
	var syncs atomic.Int64
	j.syncFile = func() error {
		if syncs.Add(1) == 1 {
			close(firstEntered)
			<-firstRelease
			return j.file.Sync()
		}
		close(batchEntered)
		<-batchRelease
		return injected
	}
	first := auditRecordAsync(s, "first")
	auditWait(t, firstEntered)
	results := make([]<-chan error, 8)
	for i := range results {
		results[i] = auditRecordAsync(s, fmt.Sprint(i))
	}
	auditWaitQueued(t, j, len(results))
	close(firstRelease)
	if err := <-first; err != nil {
		t.Fatal(err)
	}
	auditWait(t, batchEntered)
	for _, done := range results {
		select {
		case err := <-done:
			t.Fatalf("audit batch ack before sync: %v", err)
		default:
		}
	}
	close(batchRelease)
	for _, done := range results {
		if err := <-done; !errors.Is(err, injected) {
			t.Fatal(err)
		}
	}
	if !s.failed.Load() {
		t.Fatal("audit failure did not fail runtime closed")
	}
	if err := s.record(attemptEvent{RequestID: "late"}); !errors.Is(err, injected) {
		t.Fatal("failed audit resumed", err)
	}
	if syncs.Load() != 2 {
		t.Fatal("failed journal attempted more syncs")
	}
}

func TestAuditWriteFailurePoisonsJournal(t *testing.T) {
	s, _ := auditTestState(t)
	if err := s.audit.file.Close(); err != nil {
		t.Fatal(err)
	}
	if s.record(attemptEvent{RequestID: "a"}) == nil || !s.failed.Load() {
		t.Fatal("write error accepted")
	}
	if s.record(attemptEvent{RequestID: "b"}) == nil {
		t.Fatal("failed audit resumed")
	}
}
