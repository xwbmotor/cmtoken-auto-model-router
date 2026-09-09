package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestOfflineImportRequiresFrozenSourceDigestAndPreservesAmounts(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "node.json")
	target := filepath.Join(dir, "go.wal")
	raw, _ := json.Marshal(map[string]any{"date": time.Now().UTC().Format("2006-01-02"), "estimatedSpendYuan": 1.25, "settledActualSpendYuan": 2.5, "settledEstimatedSpendYuan": .75})
	if e := os.WriteFile(source, raw, 0600); e != nil {
		t.Fatal(e)
	}
	hash := sha256.Sum256(raw)
	args := []string{"--source", source, "--target", target, "--source-sha256", hex.EncodeToString(hash[:]), "--time-zone", "UTC"}
	var out bytes.Buffer
	if importLedger(args, &out) == nil {
		t.Fatal("unfrozen source accepted")
	}
	args = append(args, "--source-frozen")
	alias := filepath.Join(dir, "source-alias.json")
	if e := os.Link(source, alias); e != nil {
		t.Fatal(e)
	}
	aliasArgs := append([]string{}, args...)
	aliasArgs[3] = alias
	if importLedger(aliasArgs, &out) == nil {
		t.Fatal("same-file alias accepted as target")
	}
	unchanged, _ := os.ReadFile(source)
	if !bytes.Equal(raw, unchanged) {
		t.Fatal("source alias modified")
	}
	for i := 0; i < 2; i++ {
		out.Reset()
		if e := importLedger(args, &out); e != nil {
			t.Fatal(e)
		}
	}
	var decoded map[string]any
	if json.Unmarshal(out.Bytes(), &decoded) != nil {
		t.Fatal("invalid import report")
	}
	snap := decoded["snapshot"].(map[string]any)
	if snap["actualMicros"] != float64(2500000) || snap["estimatedMicros"] != float64(2000000) || snap["pendingReserves"] != float64(0) {
		t.Fatalf("lost opening balance: %v", snap)
	}
	reread, _ := os.ReadFile(source)
	if !bytes.Equal(raw, reread) {
		t.Fatal("source modified")
	}
	if e := os.WriteFile(source, []byte(`{}`), 0600); e != nil {
		t.Fatal(e)
	}
	if importLedger(args, &out) == nil {
		t.Fatal("changed source digest accepted")
	}
}
