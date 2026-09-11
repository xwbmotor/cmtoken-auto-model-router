package gateway

import (
	"context"
	"encoding/json"
	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/auth"
	"net/http"
	"os"
	"testing"
)

func TestManagedObservationDoesNotApplyDailyLimit(t *testing.T) {
	bundle := managedBundle()
	bundle.Runtime.BudgetEnabled = false
	bundle.Runtime.DailyLimitMicros = 1
	m, server := managedLab(t, managedInput(), bundle, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": "ok"}}}, "usage": map[string]int{"prompt_tokens": 10, "completion_tokens": 5}})
	})
	for i := 0; i < 2; i++ {
		res, err := http.DefaultClient.Do(request(context.Background(), server.URL, runtimeRequest))
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != 200 {
			t.Fatalf("disabled budget blocked request: %d", res.StatusCode)
		}
	}
	managedIdle(t, m)
	if m.state.ledger.Snapshot().ActualMicros <= bundle.Runtime.DailyLimitMicros {
		t.Fatal("cost not recorded beyond disabled limit")
	}
	if _, err := os.Stat(m.options.LedgerPath + ".observation-checkpoint"); err != nil {
		t.Fatal(err)
	}
	if got := m.active.g.diagnostics(nil).Runtime.CostStateMode; got != "observation" {
		t.Fatal(got)
	}
}

func TestBudgetModeChangeRequiresRestart(t *testing.T) {
	f := newReloadFixture(t, auth.Config{Mode: "passthrough", AdminToken: reloadAdmin}, func(w http.ResponseWriter, r *http.Request) {})
	f.mu.Lock()
	f.bundle.Runtime.BudgetEnabled = true
	f.bundle.Runtime.DailyLimitMicros = 1000000
	f.mu.Unlock()
	f.m.mu.Lock()
	previous := f.m.active.revision
	f.m.mu.Unlock()
	if _, err := f.m.Reload(previous); err == nil {
		t.Fatal("mode changed without separate state")
	}
	f.m.mu.Lock()
	defer f.m.mu.Unlock()
	if f.m.active.revision != previous || f.m.active.g.options.Bundle.Runtime.BudgetEnabled {
		t.Fatal("failed reload changed active runtime")
	}
}
