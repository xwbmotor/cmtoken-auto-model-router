package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/ledger"
)

func TestExportPreservesTotalsAndRefusesOverwriteOrChangedSource(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "go.wal")
	target := filepath.Join(dir, "node.json")
	l, e := ledger.Open(source, ledger.Options{TimeZone: "UTC"})
	if e != nil {
		t.Fatal(e)
	}
	actual := int64(1234567)
	estimate := int64(7654321)
	if e = l.Reserve("a", &actual, 0, "answer"); e != nil {
		t.Fatal(e)
	}
	if e = l.Settle("a", &actual, true); e != nil {
		t.Fatal(e)
	}
	if e = l.Reserve("b", &estimate, 0, "classifier"); e != nil {
		t.Fatal(e)
	}
	if e = l.Settle("b", nil, false); e != nil {
		t.Fatal(e)
	}
	l.Close()
	raw, _ := os.ReadFile(source)
	sum := sha256.Sum256(raw)
	args := []string{"--source", source, "--target", target, "--source-sha256", hex.EncodeToString(sum[:]), "--time-zone", "UTC"}
	var out bytes.Buffer
	if exportLedger(args, &out) == nil {
		t.Fatal("unfrozen accepted")
	}
	args = append(args, "--source-frozen")
	if e = exportLedger(args, &out); e != nil {
		t.Fatal(e)
	}
	var result map[string]any
	saved, _ := os.ReadFile(target)
	json.Unmarshal(saved, &result)
	if result["settledActualSpendYuan"] != 1.234567 || result["settledEstimatedSpendYuan"] != 7.654321 || result["estimatedSpendYuan"] != float64(0) {
		t.Fatalf("lost amounts: %v", result)
	}
	if exportLedger(args, &out) == nil {
		t.Fatal("overwritten target")
	}
	unchanged, _ := os.ReadFile(source)
	if !bytes.Equal(raw, unchanged) {
		t.Fatal("modified source")
	}
	args[3] = filepath.Join(dir, "next.json")
	os.WriteFile(source, append(raw, 'x'), 0600)
	if exportLedger(args, &out) == nil {
		t.Fatal("changed digest accepted")
	}
	newRaw, _ := os.ReadFile(source)
	newSum := sha256.Sum256(newRaw)
	args[5] = hex.EncodeToString(newSum[:])
	if exportLedger(args, &out) == nil {
		t.Fatal("partial tail accepted")
	}
}

func TestExportRefusesUnsettledAttempts(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "pending.wal")
	l, e := ledger.Open(source, ledger.Options{TimeZone: "UTC"})
	if e != nil {
		t.Fatal(e)
	}
	amount := int64(5)
	if e = l.Reserve("pending", &amount, 0, "answer"); e != nil {
		t.Fatal(e)
	}
	l.Close()
	raw, _ := os.ReadFile(source)
	sum := sha256.Sum256(raw)
	args := []string{"--source-frozen", "--source", source, "--target", filepath.Join(dir, "node.json"), "--source-sha256", hex.EncodeToString(sum[:]), "--time-zone", "UTC"}
	if exportLedger(args, &bytes.Buffer{}) == nil {
		t.Fatal("pending reserve exported")
	}
}

func TestExportRefusesLossOfMicroyuanPrecisionInNode(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "large.wal")
	l, e := ledger.Open(source, ledger.Options{TimeZone: "UTC"})
	if e != nil {
		t.Fatal(e)
	}
	amount := int64(8999999999999999)
	if e = l.Reserve("large", &amount, 0, "answer"); e != nil {
		t.Fatal(e)
	}
	if e = l.Settle("large", &amount, true); e != nil {
		t.Fatal(e)
	}
	l.Close()
	raw, _ := os.ReadFile(source)
	sum := sha256.Sum256(raw)
	args := []string{"--source-frozen", "--source", source, "--target", filepath.Join(dir, "node.json"), "--source-sha256", hex.EncodeToString(sum[:]), "--time-zone", "UTC"}
	if exportLedger(args, &bytes.Buffer{}) == nil {
		t.Fatal("lossy Node amount accepted")
	}
}
