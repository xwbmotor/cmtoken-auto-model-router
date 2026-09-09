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

	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/decision"
	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/ledger"
)

// Explicit offline operation. Source is never modified or implicitly discovered.
func importLedger(args []string, out io.Writer) error {
	flags := flag.NewFlagSet("ledger-import", flag.ContinueOnError)
	source := flags.String("source", "", "frozen Node budget ledger JSON")
	target := flags.String("target", "", "new Go WAL path")
	expected := flags.String("source-sha256", "", "verified source SHA256")
	frozen := flags.Bool("source-frozen", false, "acknowledge Node writer has been stopped")
	zone := flags.String("time-zone", "Asia/Shanghai", "billing time zone")
	if e := flags.Parse(args); e != nil {
		return e
	}
	if !*frozen || *source == "" || *target == "" || len(*expected) != 64 {
		return errors.New("requires --source-frozen --source --target --source-sha256")
	}
	a, e := filepath.Abs(*source)
	if e != nil {
		return errors.New("invalid source path")
	}
	b, e := filepath.Abs(*target)
	if e != nil || a == b {
		return errors.New("source and target must be separate")
	}
	f, e := os.Open(a)
	if e != nil {
		return errors.New("source ledger unavailable")
	}
	info, statErr := f.Stat()
	if statErr != nil {
		f.Close()
		return errors.New("source ledger unavailable")
	}
	if targetInfo, err := os.Stat(b); err == nil && os.SameFile(info, targetInfo) {
		f.Close()
		return errors.New("source and target must be separate files")
	}
	raw, e := io.ReadAll(io.LimitReader(f, 2<<20+1))
	f.Close()
	if e != nil || len(raw) > 2<<20 {
		return errors.New("source ledger unreadable or too large")
	}
	sum := sha256.Sum256(raw)
	id := hex.EncodeToString(sum[:])
	if id != *expected {
		return errors.New("source ledger digest mismatch")
	}
	var src struct {
		Date      string   `json:"date"`
		Pending   *float64 `json:"estimatedSpendYuan"`
		Actual    *float64 `json:"settledActualSpendYuan"`
		Estimated *float64 `json:"settledEstimatedSpendYuan"`
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if decoder.Decode(&src) != nil || decoder.Decode(new(any)) != io.EOF {
		return errors.New("invalid Node ledger")
	}
	amount := func(v *float64) (int64, error) {
		if v == nil || math.IsNaN(*v) || math.IsInf(*v, 0) || *v < 0 || *v > 9e9 {
			return 0, errors.New("missing or invalid current Node ledger amounts")
		}
		return int64(math.Round(decision.RoundNumber(*v, 6) * 1e6)), nil
	}
	actual, e := amount(src.Actual)
	if e != nil {
		return e
	}
	estimated, e := amount(src.Estimated)
	if e != nil {
		return e
	}
	pending, e := amount(src.Pending)
	if e != nil {
		return e
	}
	l, e := ledger.Open(b, ledger.Options{TimeZone: *zone})
	if e != nil {
		return errors.New("target ledger unavailable")
	}
	defer l.Close()
	if e = l.ImportOpeningBalance(id, src.Date, actual, estimated, pending); e != nil {
		return fmt.Errorf("opening balance rejected: %w", e)
	}
	return json.NewEncoder(out).Encode(map[string]any{"sourceSha256": id, "imported": true, "snapshot": l.Snapshot()})
}
