package gateway

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/auth"
)

func readDiagnostics(t *testing.T, m *Managed) diagnostics {
	t.Helper()
	w := reloadCall(t, m, "GET", "/internal/v1/runtime", reloadAdmin, "")
	if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("runtime status %d", w.Code)
	}
	var response struct {
		Diagnostics diagnostics `json:"diagnostics"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	return response.Diagnostics
}

func TestManagedDiagnosticsRemainAdminOnlyAndReadOnly(t *testing.T) {
	f := newReloadFixture(t, auth.Config{AccessToken: accessToken, UpstreamToken: "upstream", AdminToken: reloadAdmin}, func(w http.ResponseWriter, r *http.Request) {})
	for _, token := range []string{"", accessToken, "wrong-admin"} {
		w := reloadCall(t, f.m, "GET", "/internal/v1/runtime", token, "")
		if w.Code != 403 || strings.Contains(w.Body.String(), "diagnostics") {
			t.Fatalf("diagnostics accessible without admin: %d", w.Code)
		}
	}
	d := readDiagnostics(t, f.m)
	if d.Process.Scope != "process" || d.Process.PID != os.Getpid() || d.Process.Goroutines < 1 || d.Process.HeapAllocBytes == 0 || d.Process.HeapInuseBytes < d.Process.HeapAllocBytes || d.Process.HeapObjects == 0 {
		t.Fatalf("invalid process counters: %+v", d.Process)
	}
	if d.Runtime.ActiveRequests != 0 || d.Runtime.RequestCapacity != 32 || d.Runtime.RetainedAttempts != 0 || d.Generations == nil || d.Generations.Live != 1 || d.Generations.Retired != 0 || d.Generations.ActiveHandlers != 1 {
		t.Fatalf("invalid idle diagnostics: %+v", d)
	}
	if d.Generations.Revision != f.revision(t) {
		t.Fatal("generation revision mismatch")
	}
	f.m.state.failed.Store(true)
	readDiagnostics(t, f.m) // Persistence failure must not hide diagnostic evidence.
	if !f.m.state.failed.Load() {
		t.Fatal("diagnostic read cleared failure")
	}
}

func TestManagedDiagnosticsTrackActiveAndRetiredGeneration(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	f := newReloadFixture(t, auth.Config{AccessToken: accessToken, UpstreamToken: "upstream", AdminToken: reloadAdmin}, func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-release
		io.WriteString(w, runtimeAnswer)
	})
	done := make(chan int, 1)
	go func() {
		w := reloadCall(t, f.m, "POST", "/v1/chat/completions", accessToken, "")
		done <- w.Code
	}()
	<-started
	d := readDiagnostics(t, f.m)
	if d.Runtime.ActiveRequests != 1 || d.Runtime.RetainedAttempts != 1 {
		t.Fatalf("active counters: %+v", d.Runtime)
	}
	f.setBundle(reloadBundle("b"))
	if _, err := f.m.Reload(f.revision(t)); err != nil {
		close(release)
		t.Fatal(err)
	}
	d = readDiagnostics(t, f.m)
	if d.Generations.Live != 2 || d.Generations.Retired != 1 || d.Generations.ActiveHandlers != 2 {
		close(release)
		t.Fatalf("old generation not visible: %+v", d.Generations)
	}
	close(release)
	if status := <-done; status != 200 {
		t.Fatalf("request status %d", status)
	}
	d = readDiagnostics(t, f.m)
	if d.Runtime.ActiveRequests != 0 || d.Runtime.RetainedAttempts != 1 || d.Generations.Live != 1 || d.Generations.Retired != 0 || d.Generations.ActiveHandlers != 1 {
		t.Fatalf("did not drain: %+v %+v", d.Runtime, d.Generations)
	}
	if f.m.state.ledger.Snapshot().PendingReserves != 0 {
		t.Fatal("ledger did not settle")
	}
}
