package ledger

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

// These tests exercise eviction and replay at volume, not fsync durability.
// Existing writer/recovery tests cover acknowledgement and failed syncs. Flush
// the real WAL explicitly before reopening a volume fixture.
func cacheVolumeFixture(t *testing.T, l *Ledger) {
	t.Helper()
	l.mu.Lock()
	l.syncFile = func() error { return nil }
	l.mu.Unlock()
}

func TestAttemptCacheHashCollisionKeepsExactIDs(t *testing.T) {
	seen := make(map[uint16][]string)
	var ids []string
	for i := 0; i < indexBuckets*3; i++ {
		id := fmt.Sprintf("collision-%d", i)
		bucket := indexBucket(id)
		seen[bucket] = append(seen[bucket], id)
		if len(seen[bucket]) == 3 {
			ids = seen[bucket]
			break
		}
	}
	if len(ids) != 3 {
		t.Fatal("failed to construct collision fixture")
	}
	l := openTest(t, filepath.Join(t.TempDir(), "ledger.wal"), Options{})
	require(t, l.Reserve(ids[0], amount(11), 0, "answer"))
	require(t, l.Settle(ids[0], amount(7), true))
	require(t, l.Reserve(ids[1], amount(22), 0, "probe"))
	require(t, l.Release(ids[1]))
	l.mu.Lock()
	clear(l.attempts)
	l.mu.Unlock()
	require(t, l.Settle(ids[0], amount(7), true))
	require(t, l.Release(ids[1]))
	if !errors.Is(l.Release(ids[2]), ErrUnknown) {
		t.Fatal("unreserved colliding ID was treated as an existing attempt")
	}
	require(t, l.Reserve(ids[2], amount(33), 0, "classifier"))
	require(t, l.Settle(ids[2], nil, false))
	if s := l.Snapshot(); s.ActualMicros != 7 || s.EstimatedMicros != 33 || s.PendingReserves != 0 {
		t.Fatal(s)
	}
}

func TestAttemptCacheIndexReadFailurePoisonsWriter(t *testing.T) {
	for _, damage := range []string{"closed", "corrupt"} {
		t.Run(damage, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "ledger.wal")
			l := openTest(t, path, Options{})
			require(t, l.Reserve("old", amount(15), 0, "answer"))
			before := l.Snapshot()
			l.mu.Lock()
			clear(l.attempts)
			var err error
			if damage == "closed" {
				err = l.index.file.Close()
			} else {
				// Corrupt the checksum while retaining the recognized magic.
				_, err = l.index.file.WriteAt(make([]byte, 32), l.index.heads[indexBucket("old")]+12)
			}
			l.mu.Unlock()
			require(t, err)
			if err = l.Reserve("old", amount(15), 0, "answer"); err == nil || errors.Is(err, ErrConflict) {
				t.Fatalf("damaged index accepted cold retry or invented conflict: %v", err)
			}
			if !errors.Is(l.Reserve("new", amount(1), 0, "answer"), ErrClosed) {
				t.Fatal("index failure did not poison subsequent mutations")
			}
			if got := l.Snapshot(); !reflect.DeepEqual(before, got) {
				t.Fatalf("failed lookup changed totals: before=%+v got=%+v", before, got)
			}
			closeErr := l.Close()
			if damage != "closed" {
				require(t, closeErr)
			}
			l = openTest(t, path, Options{})
			require(t, l.Reserve("old", amount(15), 0, "answer"))
			require(t, l.Settle("old", amount(12), true))
			if s := l.Snapshot(); s.ActualMicros != 12 || s.PendingReserves != 0 {
				t.Fatal(s)
			}
		})
	}
}

func TestAttemptCacheIndexWriteFailureRequiresWALRecovery(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ledger.wal")
	l := openTest(t, path, Options{})
	require(t, l.Reserve("hot", amount(15), 0, "answer"))
	before := l.Snapshot()
	l.mu.Lock()
	err := l.index.file.Close()
	l.mu.Unlock()
	require(t, err)
	// The cache hit allows validation to finish; only the derived-index write
	// fails, after the settlement has been durably appended to the WAL.
	if err := l.Settle("hot", amount(12), true); err == nil || !errors.Is(err, os.ErrClosed) {
		t.Fatalf("index write failure not returned: %v", err)
	}
	if got := l.Snapshot(); !reflect.DeepEqual(before, got) {
		t.Fatalf("failed index write exposed staged accounting: before=%+v got=%+v", before, got)
	}
	if !errors.Is(l.Release("hot"), ErrClosed) {
		t.Fatal("index write failure did not poison writer")
	}
	_ = l.Close() // Deliberately closed index may make Close return ErrClosed.
	l = openTest(t, path, Options{})
	require(t, l.Settle("hot", amount(12), true))
	if s := l.Snapshot(); s.ActualMicros != 12 || s.PendingMicros != 0 || s.PendingReserves != 0 {
		t.Fatalf("WAL recovery lost or duplicated uncertain settlement: %+v", s)
	}
}

func fillAttemptCache(t *testing.T, l *Ledger, prefix string) {
	t.Helper()
	for i := 0; i < attemptCacheLimit+8; i++ {
		id := fmt.Sprintf("%s-%d", prefix, i)
		require(t, l.Reserve(id, amount(0), 0, "probe"))
		require(t, l.Release(id))
	}
	assertAttemptCacheBound(t, l)
}

func assertAttemptCacheBound(t *testing.T, l *Ledger) {
	t.Helper()
	if got := l.RetainedAttempts(); got > attemptCacheLimit {
		t.Fatalf("resident attempts = %d, limit = %d", got, attemptCacheLimit)
	}
}

func assertAttemptCold(t *testing.T, l *Ledger, ids ...string) {
	t.Helper()
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, id := range ids {
		if _, ok := l.attempts[id]; ok {
			t.Errorf("fixture did not evict %q; disk lookup would not be exercised", id)
		}
	}
}

func syncAndCloseCacheFixture(t *testing.T, l *Ledger) {
	t.Helper()
	l.mu.Lock()
	err := l.file.Sync()
	l.mu.Unlock()
	require(t, err)
	require(t, l.Close())
}

func TestAttemptCacheColdIdempotencyAndConflicts(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ledger.wal")
	l := openTest(t, path, Options{})
	cacheVolumeFixture(t, l)
	require(t, l.Reserve("actual", amount(100), 0, "answer"))
	require(t, l.Settle("actual", amount(83), true))
	require(t, l.Reserve("estimated", amount(70), 0, "classifier"))
	require(t, l.Settle("estimated", nil, false))
	require(t, l.Reserve("released", amount(90), 0, "probe"))
	require(t, l.Release("released"))
	require(t, l.Reserve("unpriced", nil, 0, "answer"))
	require(t, l.Settle("unpriced", nil, false))
	fillAttemptCache(t, l, "fill")
	assertAttemptCold(t, l, "actual", "estimated", "released", "unpriced")

	check := func() {
		t.Helper()
		before := l.Snapshot()
		require(t, l.Reserve("actual", amount(100), 1, "answer"))
		require(t, l.Settle("actual", amount(83), true))
		require(t, l.Reserve("estimated", amount(70), 1, "classifier"))
		require(t, l.Settle("estimated", amount(999), false))
		require(t, l.Reserve("released", amount(90), 1, "probe"))
		require(t, l.Release("released"))
		require(t, l.Reserve("unpriced", nil, 1, "answer"))
		require(t, l.Settle("unpriced", nil, true))
		for name, err := range map[string]error{
			"reserve amount":  l.Reserve("actual", amount(101), 0, "answer"),
			"reserve source":  l.Reserve("actual", amount(100), 0, "probe"),
			"reserve nil":     l.Reserve("unpriced", amount(0), 0, "answer"),
			"settle amount":   l.Settle("actual", amount(84), true),
			"settle usage":    l.Settle("actual", amount(83), false),
			"settle released": l.Settle("released", amount(90), true),
			"release settled": l.Release("actual"),
		} {
			if !errors.Is(err, ErrConflict) {
				t.Errorf("%s: got %v, want ErrConflict", name, err)
			}
		}
		if !errors.Is(l.Settle("never-reserved", amount(1), true), ErrUnknown) || !errors.Is(l.Release("never-reserved"), ErrUnknown) {
			t.Error("missing disk record must remain unknown")
		}
		if after := l.Snapshot(); !reflect.DeepEqual(before, after) {
			t.Fatalf("cold retries changed accounting: before=%+v after=%+v", before, after)
		}
		assertAttemptCacheBound(t, l)
	}
	check()
	// Evict touched records again so recovery cannot accidentally test only the
	// final records in the journal.
	fillAttemptCache(t, l, "refill")
	syncAndCloseCacheFixture(t, l)
	l = openTest(t, path, Options{})
	assertAttemptCacheBound(t, l)
	assertAttemptCold(t, l, "actual", "estimated", "released", "unpriced")
	check()
	if s := l.Snapshot(); s.ActualMicros != 83 || s.EstimatedMicros != 70 || s.PendingMicros != 0 || s.PendingReserves != 0 {
		t.Fatal(s)
	}
}

func TestAttemptCacheEvictedPendingAcrossDayAndRestart(t *testing.T) {
	now := time.Date(2026, 9, 9, 23, 59, 0, 0, time.UTC)
	options := Options{TimeZone: "UTC", Now: func() time.Time { return now }}
	path := filepath.Join(t.TempDir(), "ledger.wal")
	l := openTest(t, path, options)
	cacheVolumeFixture(t, l)
	require(t, l.Reserve("pending-actual", amount(100), 0, "answer"))
	require(t, l.Reserve("pending-estimated", amount(70), 0, "classifier"))
	require(t, l.Reserve("pending-release", amount(30), 0, "probe"))
	fillAttemptCache(t, l, "fill")
	assertAttemptCold(t, l, "pending-actual", "pending-estimated", "pending-release")
	if s := l.Snapshot(); s.PendingMicros != 200 || s.PendingReserves != 3 {
		t.Fatal(s)
	}
	syncAndCloseCacheFixture(t, l)
	now = now.Add(2 * time.Minute)
	l = openTest(t, path, options)
	assertAttemptCacheBound(t, l)
	assertAttemptCold(t, l, "pending-actual", "pending-estimated", "pending-release")
	if s := l.Snapshot(); s.Date != "2026-09-10" || s.PendingMicros != 200 || s.PendingReserves != 3 || s.ActualMicros != 0 {
		t.Fatal(s)
	}
	if !errors.Is(l.Reserve("over-budget", amount(1), 200, "answer"), ErrBudget) {
		t.Fatal("evicted pending reservations did not constrain next-day budget")
	}
	require(t, l.Settle("pending-actual", amount(120), true))
	require(t, l.Settle("pending-estimated", nil, false))
	require(t, l.Release("pending-release"))
	want := l.Snapshot()
	if want.PendingReserves != 0 || want.PendingMicros != 0 || want.ActualMicros != 120 || want.EstimatedMicros != 70 || want.Sources["answer"].ActualMicros != 120 || want.Sources["classifier"].EstimatedMicros != 70 {
		t.Fatal(want)
	}
	require(t, l.Close())
	l = openTest(t, path, options)
	require(t, l.Settle("pending-actual", amount(120), true))
	require(t, l.Settle("pending-estimated", nil, false))
	require(t, l.Release("pending-release"))
	if got := l.Snapshot(); !reflect.DeepEqual(want, got) {
		t.Fatalf("replayed cross-day settlement changed totals: want=%+v got=%+v", want, got)
	}
	assertAttemptCacheBound(t, l)
}
