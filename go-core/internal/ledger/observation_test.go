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

func TestObservationBoundedCheckpointRestartAndIDWindow(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ledger.wal")
	opts := Options{Observation: true}
	l := openTest(t, path, opts)
	require(t, l.Reserve("unresolved", amount(7), 0, "probe"))
	for i := 0; i < 7000; i++ {
		id := fmt.Sprintf("id-%d", i)
		require(t, l.Reserve(id, amount(1), 0, "answer"))
		require(t, l.Settle(id, amount(2), true))
	}
	want := l.Snapshot()
	if want.ActualMicros != 14000 || want.PendingMicros != 7 {
		t.Fatal(want)
	}
	if l.checkpointSeq < 8192 {
		t.Fatal("checkpoint not triggered")
	}
	for _, suffix := range []string{"", ".attempt-index", ".observation-checkpoint"} {
		info, err := os.Stat(path + suffix)
		require(t, err)
		if info.Size() > 4*1024*1024 {
			t.Fatalf("unbounded %s: %d", suffix, info.Size())
		}
	}
	require(t, l.Close())
	l = openTest(t, path, opts)
	if !reflect.DeepEqual(want, l.Snapshot()) {
		t.Fatal(l.Snapshot(), want)
	}
	require(t, l.Settle("id-6999", amount(2), true))
	if !reflect.DeepEqual(want, l.Snapshot()) {
		t.Fatal("duplicate settlement changed totals")
	}
	if !errors.Is(l.Settle("id-0", amount(2), true), ErrUnknown) {
		t.Fatal("old ID retained beyond window")
	}
	require(t, l.Settle("unresolved", nil, false))
	if l.Snapshot().EstimatedMicros != 7 {
		t.Fatal(l.Snapshot())
	}
}

func TestObservationModeGuards(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ledger.wal")
	l := openTest(t, path, Options{})
	require(t, l.Reserve("a", amount(1), 10, "answer"))
	require(t, l.Close())
	if _, err := Open(path, Options{Observation: true}); !errors.Is(err, ErrObservationMode) {
		t.Fatal(err)
	}
	path = filepath.Join(t.TempDir(), "observation.wal")
	l = openTest(t, path, Options{Observation: true})
	if !errors.Is(l.Reserve("a", amount(1), 10, "answer"), ErrObservationMode) {
		t.Fatal("observation accepted budget")
	}
	require(t, l.Close())
	if _, err := Open(path, Options{}); !errors.Is(err, ErrObservationMode) {
		t.Fatal(err)
	}
}

func TestObservationCheckpointBeforeTruncateCrashAndCrossDay(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ledger.wal")
	now := time.Date(2026, 9, 10, 5, 0, 0, 0, time.UTC)
	opts := Options{Observation: true, Now: func() time.Time { return now }}
	l := openTest(t, path, opts)
	require(t, l.Reserve("pending", amount(11), 0, "classifier"))
	require(t, l.Reserve("done", nil, 0, "probe"))
	require(t, l.Settle("done", amount(3), true))
	l.mu.Lock()
	err := l.writeCheckpoint(observationCheckpoint{Version: 1, Seq: l.seq, Snapshot: l.snap, Attempts: l.attempts})
	l.mu.Unlock()
	require(t, err)
	require(t, l.Close())
	l = openTest(t, path, opts)
	if l.Snapshot().ActualMicros != 3 || l.Snapshot().PendingMicros != 11 {
		t.Fatal(l.Snapshot())
	}
	now = now.Add(24 * time.Hour)
	require(t, l.Settle("pending", nil, false))
	s := l.Snapshot()
	if s.ActualMicros != 0 || s.EstimatedMicros != 11 || s.Sources["classifier"].EstimatedMicros != 11 || s.PendingReserves != 0 {
		t.Fatal(s)
	}
	require(t, l.Close())
	l = openTest(t, path, opts)
	if !reflect.DeepEqual(s, l.Snapshot()) {
		t.Fatal(s, l.Snapshot())
	}
}

func TestObservationCheckpointFailurePoisonsWriterAndReopens(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ledger.wal")
	opts := Options{Observation: true}
	l := openTest(t, path, opts)
	require(t, l.Reserve("a", amount(2), 0, "answer"))
	original := l.checkpointPath
	l.checkpointPath = filepath.Join(t.TempDir(), "missing", "checkpoint")
	// Force checkpoint on next durable mutation without thousands of writes.
	l.checkpointSeq = l.seq - observationCheckpointEvents // uint64 wrap deliberately exceeds threshold
	if err := l.Settle("a", amount(3), true); err == nil {
		t.Fatal("checkpoint failure acknowledged")
	}
	if !errors.Is(l.Reserve("b", amount(1), 0, "answer"), ErrClosed) {
		t.Fatal("failed writer stayed live")
	}
	l.checkpointPath = original
	require(t, l.Close())
	l = openTest(t, path, opts)
	require(t, l.Settle("a", amount(3), true))
	if l.Snapshot().ActualMicros != 3 {
		t.Fatal(l.Snapshot())
	}
}

func TestObservationRejectsCorruptCheckpoint(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ledger.wal")
	l := openTest(t, path, Options{Observation: true})
	require(t, l.Close())
	require(t, os.WriteFile(path+".observation-checkpoint", []byte(`{"event":{},"sha256":"bad"}`), 0600))
	if _, err := Open(path, Options{Observation: true}); err == nil {
		t.Fatal("accepted corrupt checkpoint")
	}
}

func TestObservationPendingLimitPreservesRecoveryAndAllowsSettlement(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ledger.wal")
	opts := Options{Observation: true}
	l := openTest(t, path, opts)
	l.mu.Lock()
	cp := observationCheckpoint{Version: 1, Seq: observationPendingLimit, Snapshot: Snapshot{Date: l.today(), PendingReserves: observationPendingLimit, PendingMicros: observationPendingLimit, Sources: map[string]Totals{}}, Attempts: map[string]attempt{}}
	for i := 0; i < observationPendingLimit; i++ {
		cp.Attempts[fmt.Sprint(i)] = attempt{LastSeq: uint64(i + 1), State: "reserve", Source: "answer", Estimate: amount(1)}
	}
	err := l.writeCheckpoint(cp)
	l.mu.Unlock()
	require(t, err)
	require(t, l.Close())
	l = openTest(t, path, opts)
	if !errors.Is(l.Reserve("new", amount(1), 0, "answer"), ErrPendingLimit) {
		t.Fatal("pending cap not enforced")
	}
	require(t, l.Reserve("0", amount(1), 0, "answer"))
	require(t, l.Settle("0", amount(1), true))
	require(t, l.Reserve("new", amount(1), 0, "answer"))
	if l.Snapshot().PendingReserves != observationPendingLimit {
		t.Fatal(l.Snapshot())
	}
}

func TestObservationStillValidatesCheckpointedWALPrefix(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ledger.wal")
	opts := Options{Observation: true}
	l := openTest(t, path, opts)
	require(t, l.Reserve("a", amount(1), 0, "answer"))
	l.mu.Lock()
	err := l.writeCheckpoint(observationCheckpoint{Version: 1, Seq: l.seq, Snapshot: l.snap, Attempts: l.attempts})
	l.mu.Unlock()
	require(t, err)
	require(t, l.Close())
	data, err := os.ReadFile(path)
	require(t, err)
	for i := range data {
		if data[i] == 'a' && i+6 < len(data) && string(data[i:i+6]) == "answer" {
			data[i] = 'X'
			break
		}
	}
	require(t, os.WriteFile(path, data, 0600))
	if _, err = Open(path, opts); err == nil {
		t.Fatal("skipped corrupt historical WAL prefix")
	}
}
