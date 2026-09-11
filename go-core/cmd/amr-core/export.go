package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"strconv"

	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/ledger"
)

// exportLedger creates a NEW Node-compatible rollback snapshot. It never edits
// either running service's state. The operator must stop both writers first.
func exportLedger(args []string, out io.Writer) error {
	flags := flag.NewFlagSet("ledger-export", flag.ContinueOnError)
	source := flags.String("source", "", "frozen Go WAL")
	target := flags.String("target", "", "new Node JSON snapshot (must not exist)")
	expected := flags.String("source-sha256", "", "verified frozen WAL SHA256")
	frozen := flags.Bool("source-frozen", false, "acknowledge both writers are stopped and traffic is closed")
	zone := flags.String("time-zone", "Asia/Shanghai", "billing time zone")
	if e := flags.Parse(args); e != nil {
		return e
	}
	if !*frozen || *source == "" || *target == "" || len(*expected) != 64 || flags.NArg() != 0 {
		return errors.New("requires --source-frozen --source --target --source-sha256")
	}
	if _, e := os.Stat(*source + ".node-observation"); e == nil || !os.IsNotExist(e) {
		return errors.New("Node cost observation is authoritative; preserve the Node snapshot")
	}
	f, e := os.Open(*source)
	if e != nil {
		return errors.New("source unavailable")
	}
	raw, e := io.ReadAll(io.LimitReader(f, (256<<20)+1))
	f.Close()
	if e != nil || len(raw) == 0 || len(raw) > 256<<20 {
		return errors.New("source empty, unreadable or exceeds 256 MiB offline limit")
	}
	sum := sha256.Sum256(raw)
	if hex.EncodeToString(sum[:]) != *expected {
		return errors.New("source digest mismatch")
	}
	// Replay a disposable copy because ledger recovery can truncate a partial tail.
	dir, e := os.MkdirTemp("", "amr-export-")
	if e != nil {
		return e
	}
	defer os.RemoveAll(dir)
	copyPath := filepath.Join(dir, "snapshot.wal")
	if e = os.WriteFile(copyPath, raw, 0600); e != nil {
		return e
	}
	l, e := ledger.Open(copyPath, ledger.Options{TimeZone: *zone})
	if e != nil {
		return errors.New("source WAL failed integrity validation")
	}
	snapshot := l.Snapshot()
	if e = l.Close(); e != nil {
		return e
	}
	validated, e := os.ReadFile(copyPath)
	if e != nil || !bytes.Equal(validated, raw) {
		return errors.New("partial WAL tail requires explicit recovery before export")
	}
	if snapshot.PendingReserves != 0 || snapshot.PendingMicros != 0 || snapshot.Unpriced != 0 {
		return errors.New("unsettled or unpriced attempts require reconciliation before rollback")
	}
	if snapshot.ActualMicros > 9e15 || snapshot.EstimatedMicros > 9e15-snapshot.ActualMicros {
		return errors.New("amount exceeds Node safe microyuan range")
	}
	amount := func(v int64) json.Number { return json.Number(fmt.Sprintf("%d.%06d", v/1000000, v%1000000)) }
	for _, micros := range []int64{snapshot.ActualMicros, snapshot.EstimatedMicros, snapshot.ActualMicros + snapshot.EstimatedMicros} {
		value, err := strconv.ParseFloat(string(amount(micros)), 64)
		if err != nil || int64(math.Round(value*1e6)) != micros || strconv.FormatFloat(value, 'f', 6, 64) != string(amount(micros)) {
			return errors.New("amount cannot round-trip through Node floating point at microyuan precision")
		}
	}
	// Preserve actual vs estimated totals. Prior per-source details stay in WAL;
	// Node exposes imported totals as legacy unattributed, and starts fresh counts.
	body, e := json.MarshalIndent(map[string]any{
		"date": snapshot.Date, "estimatedSpendYuan": 0,
		"settledActualSpendYuan": amount(snapshot.ActualMicros), "settledEstimatedSpendYuan": amount(snapshot.EstimatedMicros),
		"pricedRequests": 0, "unpricedRequests": 0,
		"migration": map[string]any{"source": "go-wal", "sourceSha256": *expected, "countersReset": true, "costAttribution": "legacy-unattributed", "timeZone": *zone},
	}, "", "  ")
	if e != nil {
		return e
	}
	body = append(body, '\n')
	// Re-check the frozen source after replay before producing a handoff artifact.
	current, e := os.ReadFile(*source)
	if e != nil || !bytes.Equal(current, raw) {
		return errors.New("source changed during export")
	}
	output, e := os.OpenFile(*target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if e != nil {
		return errors.New("target must be a new separate file in an existing directory")
	}
	_, e = output.Write(body)
	if e == nil {
		e = output.Sync()
	}
	closeErr := output.Close()
	if e != nil || closeErr != nil {
		os.Remove(*target)
		return errors.New("snapshot write failed")
	}
	resultHash := sha256.Sum256(body)
	return json.NewEncoder(out).Encode(map[string]any{"exported": true, "sourceSha256": *expected, "targetSha256": hex.EncodeToString(resultHash[:]), "snapshot": snapshot})
}
