package ledger

import (
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func amount(v int64) *int64 { return &v }
func openTest(t *testing.T, path string, options Options) *Ledger {
	t.Helper()
	l, e := Open(path, options)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { l.Close() })
	return l
}
func require(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
func TestRestartRetainsPendingAndSeparatesSettlement(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ledger.wal")
	l := openTest(t, path, Options{})
	require(t, l.Reserve("a", amount(100), 1000, "answer"))
	require(t, l.Reserve("b", amount(200), 1000, "classifier"))
	require(t, l.Settle("b", amount(250), true))
	require(t, l.Close())
	l = openTest(t, path, Options{})
	s := l.Snapshot()
	if s.PendingMicros != 100 || s.ActualMicros != 250 || s.PendingReserves != 1 {
		t.Fatal(s)
	}
	require(t, l.Settle("a", nil, false))
	require(t, l.Settle("a", nil, false))
	s = l.Snapshot()
	if s.PendingMicros != 0 || s.EstimatedMicros != 100 || s.ActualMicros != 250 || s.Sources["classifier"].ActualMicros != 250 {
		t.Fatal(s)
	}
	if !errors.Is(l.Settle("a", amount(100), true), ErrConflict) {
		t.Fatal("conflicting settlement accepted")
	}
	require(t, l.Close())
	l = openTest(t, path, Options{})
	require(t, l.Settle("a", nil, false))
	if l.Snapshot().EstimatedMicros != 100 {
		t.Fatal("duplicate restart charge")
	}
}
func TestSingleWriterLock(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ledger.wal")
	l := openTest(t, path, Options{})
	other, e := Open(path, Options{})
	if other != nil {
		other.Close()
	}
	if !errors.Is(e, ErrLocked) {
		t.Fatalf("second writer: %v", e)
	}
	require(t, l.Close())
	openTest(t, path, Options{})
}
func TestTruncatedTailRecovery(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ledger.wal")
	l := openTest(t, path, Options{})
	require(t, l.Reserve("a", amount(20), 0, "answer"))
	require(t, l.Close())
	f, e := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
	require(t, e)
	_, e = f.WriteString(`{"event":{"version":1`)
	require(t, e)
	require(t, f.Close())
	l = openTest(t, path, Options{})
	if l.Snapshot().PendingMicros != 20 {
		t.Fatal(l.Snapshot())
	}
	require(t, l.Settle("a", amount(17), true))
	require(t, l.Close())
	l = openTest(t, path, Options{})
	if l.Snapshot().ActualMicros != 17 {
		t.Fatal(l.Snapshot())
	}
}
func TestCompleteCorruptionFailsClosed(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ledger.wal")
	require(t, os.WriteFile(path, []byte("{}\n"), 0600))
	if l, e := Open(path, Options{}); e == nil {
		l.Close()
		t.Fatal("corruption accepted")
	}
}
func TestExistingNonJournalJSONIsNeverTruncated(t *testing.T) {
	path := filepath.Join(t.TempDir(), "node-ledger.json")
	original := []byte(`{"date":"2026-09-09","estimatedSpendYuan":12.5}`)
	require(t, os.WriteFile(path, original, 0600))
	if l, e := Open(path, Options{}); e == nil {
		l.Close()
		t.Fatal("Node JSON accepted as WAL")
	}
	actual, e := os.ReadFile(path)
	require(t, e)
	if string(actual) != string(original) {
		t.Fatal("existing ledger was modified")
	}
}
func TestConcurrentAtomicBudget(t *testing.T) {
	l := openTest(t, filepath.Join(t.TempDir(), "ledger.wal"), Options{})
	var accepted atomic.Int64
	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			err := l.Reserve(fmt.Sprint(i), amount(10), 100, "answer")
			if err == nil {
				accepted.Add(1)
			} else if !errors.Is(err, ErrBudget) {
				t.Error(err)
			}
		}(i)
	}
	wg.Wait()
	if accepted.Load() != 10 || l.Snapshot().PendingMicros != 100 {
		t.Fatal(accepted.Load(), l.Snapshot())
	}
}
func TestRolloverCarriesPending(t *testing.T) {
	now := time.Date(2026, 9, 9, 23, 59, 0, 0, time.UTC)
	l := openTest(t, filepath.Join(t.TempDir(), "ledger.wal"), Options{TimeZone: "UTC", Now: func() time.Time { return now }})
	require(t, l.Reserve("a", amount(100), 0, "answer"))
	require(t, l.Reserve("b", amount(50), 0, "answer"))
	require(t, l.Settle("b", amount(40), true))
	now = now.Add(time.Hour)
	s := l.Snapshot()
	if s.PendingMicros != 100 || s.ActualMicros != 0 {
		t.Fatal(s)
	}
	require(t, l.Reserve("c", amount(20), 120, "answer"))
	require(t, l.Settle("a", amount(90), true))
	s = l.Snapshot()
	if s.PendingMicros != 20 || s.ActualMicros != 90 {
		t.Fatal(s)
	}
}
func TestReleaseUnknownUnpricedOverflow(t *testing.T) {
	l := openTest(t, filepath.Join(t.TempDir(), "ledger.wal"), Options{})
	if !errors.Is(l.Reserve("a", nil, 100, "answer"), ErrBudget) {
		t.Fatal("unpriced budget accepted")
	}
	require(t, l.Reserve("a", nil, 0, "answer"))
	require(t, l.Settle("a", amount(5), true))
	if l.Snapshot().ActualMicros != 5 {
		t.Fatal("known actual discarded")
	}
	require(t, l.Reserve("b", amount(2), 0, "answer"))
	require(t, l.Release("b"))
	require(t, l.Release("b"))
	if l.Snapshot().PendingMicros != 0 {
		t.Fatal(l.Snapshot())
	}
	if !errors.Is(l.Settle("missing", nil, false), ErrUnknown) {
		t.Fatal("missing accepted")
	}
	require(t, l.Reserve("huge", amount(math.MaxInt64-5), 0, "answer"))
	if l.Reserve("overflow", amount(1), 0, "answer") == nil {
		t.Fatal("overflow accepted")
	}
	if l.Snapshot().PendingReserves != 1 {
		t.Fatal(l.Snapshot())
	}
}
