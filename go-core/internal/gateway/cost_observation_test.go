package gateway

import (
	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/auth"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestNodeCostAuthorityRequiresDisabledBudgetAndCannotReuseOldLedger(t *testing.T) {
	dir := t.TempDir()
	snapshot := filepath.Join(dir, "runtime.json")
	b := nativeBundle(t, "a")
	b.Runtime.BudgetEnabled = true
	writeNativeBundle(t, snapshot, b)
	o := ManagedOptions{RuntimeConfigFile: snapshot, LedgerPath: filepath.Join(dir, "runtime.wal"),
		Auth: auth.Config{AccessToken: accessToken, UpstreamToken: "provider-test-token", AdminToken: reloadAdmin},
		Gateway: Options{NodeCostObservation: true, EdgeURL: "http://127.0.0.1:1/internal/v1/go-events", EdgeToken: edgeTestToken,
			UpstreamURL: "http://127.0.0.1:2/v1/chat/completions", AssessmentTimeout: time.Second, MaxRequests: 8}}
	if m, err := NewManaged(o); err == nil {
		m.Close()
		t.Fatal("enabled budget used Node cost observation")
	}
	b.Runtime.BudgetEnabled = false
	writeNativeBundle(t, snapshot, b)
	withoutEdge := o
	withoutEdge.Gateway.EdgeURL = ""
	if m, err := NewManaged(withoutEdge); err == nil {
		m.Close()
		t.Fatal("missing observer was accepted")
	}
	m, err := NewManaged(o)
	if err != nil {
		t.Fatal(err)
	}
	amount := int64(7)
	if err := m.state.reserveCost("x", &amount, 0, "answer"); err != nil {
		t.Fatal(err)
	}
	if err := m.state.settleCost("x", &amount, true); err != nil {
		t.Fatal(err)
	}
	if err := m.state.record(attemptEvent{RequestID: "x"}); err != nil {
		t.Fatal(err)
	}
	m.Close()
	for _, suffix := range []string{"", ".events.jsonl"} {
		data, err := os.ReadFile(o.LedgerPath + suffix)
		if err != nil || len(data) != 0 {
			t.Fatal("redundant local cost events written")
		}
	}
	m, err = NewManaged(o)
	if err != nil {
		t.Fatal(err)
	}
	m.Close()
	o.Gateway.NodeCostObservation = false
	if m, err := NewManaged(o); err == nil {
		m.Close()
		t.Fatal("dormant ledger silently became cost authority")
	}
}
