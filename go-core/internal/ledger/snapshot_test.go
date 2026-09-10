package ledger

import (
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestSnapshotReadsDurableViewWhileWriterBlocked(t *testing.T) {
	l := openTest(t, filepath.Join(t.TempDir(), "ledger.wal"), Options{})
	require(t, l.Reserve("a", amount(100), 1000, "answer"))
	l.mu.Lock()
	// Simulate writer-owned state that has not passed the durable boundary.
	l.snap.PendingMicros = 999
	result := make(chan Snapshot, 1)
	go func() { result <- l.Snapshot() }()
	select {
	case s := <-result:
		if s.PendingMicros != 100 {
			t.Error("uncommitted state exposed", s)
		}
	case <-time.After(time.Second):
		t.Error("snapshot waited for writer")
	}
	l.snap.PendingMicros = 100
	l.mu.Unlock()
	require(t, l.Settle("a", amount(90), true))
	s := l.Snapshot()
	if s.PendingMicros != 0 || s.ActualMicros != 90 {
		t.Fatal(s)
	}
	s.Sources["answer"] = Totals{ActualMicros: 999}
	if l.Snapshot().Sources["answer"].ActualMicros != 90 {
		t.Fatal("caller mutated published view")
	}
}

func TestSnapshotConcurrentPublication(t *testing.T) {
	l := openTest(t, filepath.Join(t.TempDir(), "ledger.wal"), Options{})
	stop := make(chan struct{})
	var readers sync.WaitGroup
	for i := 0; i < 4; i++ {
		readers.Add(1)
		go func() {
			defer readers.Done()
			for {
				select {
				case <-stop:
					return
				default:
					s := l.Snapshot()
					if s.PendingMicros+s.ActualMicros > 100 || s.EstimatedMicros != 0 {
						t.Error("inconsistent publication", s)
						return
					}
					s.Sources["answer"] = Totals{}
				}
			}
		}()
	}
	require(t, l.Reserve("a", amount(100), 100, "answer"))
	require(t, l.Settle("a", amount(90), true))
	close(stop)
	readers.Wait()
}
