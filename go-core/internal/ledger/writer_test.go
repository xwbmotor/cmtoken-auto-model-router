package ledger

import (
	"errors"
	"fmt"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func waitQueued(t *testing.T, l *Ledger, n int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for len(l.queue) != n {
		if time.Now().After(deadline) {
			t.Fatalf("queued %d, want %d", len(l.queue), n)
		}
		time.Sleep(time.Millisecond)
	}
}
func reserveAsync(l *Ledger, id string, limit int64) <-chan error {
	done := make(chan error, 1)
	go func() { done <- l.Reserve(id, amount(1), limit, "answer") }()
	return done
}
func waitSignal(t *testing.T, c <-chan struct{}) {
	t.Helper()
	select {
	case <-c:
	case <-time.After(5 * time.Second):
		t.Fatal("writer barrier timeout")
	}
}

func unblockOnCleanup(t *testing.T, c chan struct{}) {
	t.Helper()
	t.Cleanup(func() {
		select {
		case <-c:
		default:
			close(c)
		}
	})
}

func TestQueuedMutationsShareSyncAndKeepAtomicBudget(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ledger.wal")
	l := openTest(t, path, Options{})
	entered, release := make(chan struct{}), make(chan struct{})
	unblockOnCleanup(t, release)
	var calls atomic.Int64
	l.syncFile = func() error {
		if calls.Add(1) == 1 {
			close(entered)
			<-release
		}
		return l.file.Sync()
	}
	first := reserveAsync(l, "first", 5)
	waitSignal(t, entered)
	results := make([]<-chan error, 10)
	for i := range results {
		results[i] = reserveAsync(l, fmt.Sprint(i), 5)
	}
	waitQueued(t, l, len(results))
	select {
	case err := <-first:
		t.Fatalf("ack before sync: %v", err)
	default:
	}
	close(release)
	require(t, <-first)
	accepted := 0
	for _, done := range results {
		err := <-done
		if err == nil {
			accepted++
		} else if !errors.Is(err, ErrBudget) {
			t.Fatal(err)
		}
	}
	if accepted != 4 || calls.Load() != 2 || l.Snapshot().PendingMicros != 5 {
		t.Fatal(accepted, calls.Load(), l.Snapshot())
	}
	require(t, l.Close())
	l = openTest(t, path, Options{})
	if l.Snapshot().PendingMicros != 5 {
		t.Fatal("acknowledged batch lost", l.Snapshot())
	}
}

func TestBatchBoundAndCloseDrainAcceptedMutations(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ledger.wal")
	l := openTest(t, path, Options{})
	entered, release := make(chan struct{}), make(chan struct{})
	unblockOnCleanup(t, release)
	var calls atomic.Int64
	l.syncFile = func() error {
		if calls.Add(1) == 1 {
			close(entered)
			<-release
		}
		return l.file.Sync()
	}
	first := reserveAsync(l, "first", 0)
	waitSignal(t, entered)
	results := make([]<-chan error, 130)
	for i := range results {
		results[i] = reserveAsync(l, fmt.Sprint(i), 0)
	}
	waitQueued(t, l, len(results))
	closed := make(chan error, 1)
	go func() { closed <- l.Close() }()
	waitQueued(t, l, len(results)+1)
	if !errors.Is(l.Reserve("late", amount(1), 0, "answer"), ErrClosed) {
		t.Error("accepted mutation after close boundary")
	}
	select {
	case err := <-closed:
		t.Fatalf("closed before draining: %v", err)
	default:
	}
	close(release)
	require(t, <-first)
	for _, done := range results {
		require(t, <-done)
	}
	require(t, <-closed)
	if calls.Load() != 4 {
		t.Fatal("batch exceeds 64 operations or fails to combine queued writes", calls.Load())
	}
	l = openTest(t, path, Options{})
	if l.Snapshot().PendingReserves != 131 || l.Snapshot().PendingMicros != 131 {
		t.Fatal(l.Snapshot())
	}
}

func TestFailedBatchSyncRejectsAllAndRestoresCommittedState(t *testing.T) {
	l := openTest(t, filepath.Join(t.TempDir(), "ledger.wal"), Options{})
	firstEntered, firstRelease := make(chan struct{}), make(chan struct{})
	batchEntered, batchRelease := make(chan struct{}), make(chan struct{})
	unblockOnCleanup(t, firstRelease)
	unblockOnCleanup(t, batchRelease)
	injected := errors.New("injected sync failure")
	var calls atomic.Int64
	l.syncFile = func() error {
		if calls.Add(1) == 1 {
			close(firstEntered)
			<-firstRelease
			return l.file.Sync()
		}
		close(batchEntered)
		<-batchRelease
		return injected
	}
	first := reserveAsync(l, "first", 0)
	waitSignal(t, firstEntered)
	settled := make(chan error, 1)
	go func() { settled <- l.Settle("first", amount(1), true) }()
	results := []<-chan error{settled}
	for i := 0; i < 8; i++ {
		results = append(results, reserveAsync(l, fmt.Sprint(i), 0))
	}
	waitQueued(t, l, len(results))
	close(firstRelease)
	require(t, <-first)
	waitSignal(t, batchEntered)
	for _, done := range results {
		select {
		case err := <-done:
			t.Fatalf("batch acknowledged before fsync: %v", err)
		default:
		}
	}
	close(batchRelease)
	for _, done := range results {
		if err := <-done; !errors.Is(err, injected) {
			t.Fatal(err)
		}
	}
	s := l.Snapshot()
	if s.PendingMicros != 1 || s.PendingReserves != 1 || s.ActualMicros != 0 || len(l.attempts) != 1 {
		t.Fatal("staged batch escaped rollback", s)
	}
	if !errors.Is(l.Reserve("late", amount(1), 0, "answer"), ErrClosed) {
		t.Fatal("failed writer accepted new mutation")
	}
}
