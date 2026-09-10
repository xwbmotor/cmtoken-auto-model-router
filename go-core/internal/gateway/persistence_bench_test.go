package gateway

import (
	"fmt"
	"path/filepath"
	"testing"

	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/ledger"
)

// Includes both durable WAL fsyncs and the supplementary audit fsync; it never
// disables durability to improve the benchmark. The filesystem is host-specific.
func BenchmarkCapacityPersistence(b *testing.B) {
	dir := b.TempDir()
	l, err := ledger.Open(filepath.Join(dir, "ledger.wal"), ledger.Options{})
	if err != nil {
		b.Fatal(err)
	}
	defer l.Close()
	audit, err := openAudit(filepath.Join(dir, "audit.jsonl"))
	if err != nil {
		b.Fatal(err)
	}
	defer audit.Close()
	s := runtimeState{ledger: l, audit: audit}
	var estimate int64 = 100
	var seq int64
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		seq++
		id := fmt.Sprint(seq)
		if err := l.Reserve(id, &estimate, 0, "answer"); err != nil {
			b.Fatal(err)
		}
		if err := l.Settle(id, &estimate, true); err != nil {
			b.Fatal(err)
		}
		if err := s.record(attemptEvent{RequestID: id, Status: 200, Outcome: "success"}); err != nil {
			b.Fatal(err)
		}
	}
	if s.failed.Load() || l.Snapshot().PendingReserves != 0 {
		b.Fatal("persistence did not complete")
	}
}
