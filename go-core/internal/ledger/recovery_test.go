package ledger

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestOpeningBalance(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ledger.wal")
	l := openTest(t, path, Options{})
	digest := strings.Repeat("a", 64)
	date := l.today()
	require(t, l.ImportOpeningBalance(digest, date, 10, 20, 30))
	require(t, l.ImportOpeningBalance(digest, date, 10, 20, 30))
	s := l.Snapshot()
	if s.ActualMicros != 10 || s.EstimatedMicros != 50 || s.PendingMicros != 0 || s.Sources["legacy"].EstimatedMicros != 50 {
		t.Fatal(s)
	}
	if !errors.Is(l.Reserve("a", amount(41), 100, "answer"), ErrBudget) {
		t.Fatal("imported balance bypassed")
	}
	require(t, l.Reserve("a", amount(40), 100, "answer"))
	require(t, l.Close())
	l = openTest(t, path, Options{})
	require(t, l.ImportOpeningBalance(digest, date, 10, 20, 30))
	if !errors.Is(l.ImportOpeningBalance(digest, date, 11, 20, 30), ErrConflict) {
		t.Fatal("conflicting import accepted")
	}
	if l.Snapshot().PendingMicros != 40 || l.Snapshot().EstimatedMicros != 50 {
		t.Fatal(l.Snapshot())
	}
}
func TestOpeningRejectsUnsafeInputs(t *testing.T) {
	l := openTest(t, filepath.Join(t.TempDir(), "ledger.wal"), Options{})
	digest := strings.Repeat("a", 64)
	for _, v := range []struct {
		d       string
		a, e, p int64
	}{{"2000-01-01", 1, 2, 3}, {l.today(), -1, 0, 0}, {l.today(), 9223372036854775807, 1, 0}} {
		if l.ImportOpeningBalance(digest, v.d, v.a, v.e, v.p) == nil {
			t.Fatal("unsafe import accepted")
		}
	}
	if l.ImportOpeningBalance("invalid", l.today(), 1, 2, 3) == nil {
		t.Fatal("invalid hash accepted")
	}
	require(t, l.Reserve("a", amount(1), 0, "answer"))
	if l.ImportOpeningBalance(digest, l.today(), 1, 2, 3) == nil {
		t.Fatal("nonempty import accepted")
	}
}
func TestFailedWritePoisonsWriterAndPreservesPriorReservation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ledger.wal")
	l := openTest(t, path, Options{})
	require(t, l.Reserve("a", amount(10), 0, "answer"))
	require(t, l.file.Close())
	if l.Settle("a", amount(5), true) == nil {
		t.Fatal("closed fd write succeeded")
	}
	if !errors.Is(l.Reserve("b", amount(1), 0, "answer"), ErrClosed) {
		t.Fatal("failed writer remained writable")
	}
	l.Close()
	l = openTest(t, path, Options{})
	if l.Snapshot().PendingMicros != 10 || l.Snapshot().ActualMicros != 0 {
		t.Fatal(l.Snapshot())
	}
}
func TestCrashChild(t *testing.T) {
	path := os.Getenv("LEDGER_CRASH_TEST_PATH")
	if path == "" {
		return
	}
	l, err := Open(path, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if err = l.Reserve("crashed-attempt", amount(123), 0, "answer"); err != nil {
		t.Fatal(err)
	}
	if os.Getenv("LEDGER_CRASH_TEST_BATCH") == "1" {
		results := make(chan error, 32)
		for i := 0; i < 32; i++ {
			go func(i int) { results <- l.Reserve(fmt.Sprintf("batch-%d", i), amount(1), 0, "answer") }(i)
		}
		for i := 0; i < 32; i++ {
			if err := <-results; err != nil {
				t.Fatal(err)
			}
		}
	}
	fmt.Println("LEDGER_READY")
	time.Sleep(30 * time.Second)
	l.Close()
}
func TestProcessKillReleasesLockRetainsReservation(t *testing.T) {
	t.Run("single", func(t *testing.T) { testProcessKill(t, false) })
	t.Run("concurrent", func(t *testing.T) { testProcessKill(t, true) })
}
func testProcessKill(t *testing.T, batch bool) {
	path := filepath.Join(t.TempDir(), "ledger.wal")
	cmd := exec.Command(os.Args[0], "-test.run=^TestCrashChild$")
	cmd.Env = append(os.Environ(), "LEDGER_CRASH_TEST_PATH="+path)
	var extra int64
	if batch {
		cmd.Env = append(cmd.Env, "LEDGER_CRASH_TEST_BATCH=1")
		extra = 32
	}
	stdout, err := cmd.StdoutPipe()
	require(t, err)
	cmd.Stderr = os.Stderr
	require(t, cmd.Start())
	t.Cleanup(func() {
		if cmd.Process != nil {
			cmd.Process.Kill()
		}
	})
	ready := make(chan bool, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			if scanner.Text() == "LEDGER_READY" {
				ready <- true
				return
			}
		}
		ready <- false
	}()
	select {
	case ok := <-ready:
		if !ok {
			t.Fatal("child never ready")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("child readiness timeout")
	}
	if l, e := Open(path, Options{}); !errors.Is(e, ErrLocked) {
		if l != nil {
			l.Close()
		}
		t.Fatalf("live child lock: %v", e)
	}
	require(t, cmd.Process.Kill())
	_ = cmd.Wait()
	l := openTest(t, path, Options{})
	s := l.Snapshot()
	if s.PendingMicros != 123+extra || s.PendingReserves != 1+int(extra) {
		t.Fatal(s)
	}
	require(t, l.Settle("crashed-attempt", nil, false))
	if l.Snapshot().EstimatedMicros != 123 || l.Snapshot().PendingMicros != extra {
		t.Fatal(l.Snapshot())
	}
}
