package gateway

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/auth"
)

func TestManagedCredentialFileReplacesEnvironmentCredentials(t *testing.T) {
	adapter := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(reloadBundle("a"))
	}))
	defer adapter.Close()
	path := filepath.Join(t.TempDir(), "auth.json")
	// This is a complete new credential file; an omitted administrator disables
	// administration just as auth.New specifies. Environment keys must not revive.
	if err := os.WriteFile(path, []byte(`{"mode":"passthrough"}`), 0600); err != nil {
		t.Fatal(err)
	}
	m := &Managed{options: ManagedOptions{
		AuthFile: path,
		Auth:     auth.Config{Mode: "strict", AccessToken: "old-access", UpstreamToken: "old-upstream", AdminToken: "old-admin"},
		Gateway:  Options{AssessorURL: adapter.URL, AssessorToken: assessorToken, AssessmentTimeout: time.Second},
	}}
	c, err := m.readConfig()
	if err != nil {
		t.Fatal(err)
	}
	a, err := auth.New(c.Auth)
	if err != nil {
		t.Fatal(err)
	}
	if a.AdminAuthorized("Bearer old-admin") {
		t.Fatal("credential file omitted admin but startup environment credential remains authorized")
	}
	if c.Auth.AccessToken != "" || c.Auth.UpstreamToken != "" {
		t.Fatal("credential file retained startup environment credentials")
	}
}

func TestManagedSlowReaderReleasesCapacityAfterIdleTimeout(t *testing.T) {
	f := newReloadFixture(t, auth.Config{AccessToken: accessToken, UpstreamToken: "upstream", AdminToken: reloadAdmin}, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		chunk := `data: {"choices":[{"delta":{"content":"` + strings.Repeat("x", 16000) + `"}}]}` + "\n\n"
		for i := 0; i < 10000; i++ {
			if _, err := io.WriteString(w, chunk); err != nil {
				return
			}
			if err := http.NewResponseController(w).Flush(); err != nil {
				return
			}
		}
	})
	b := reloadBundle("a")
	b.Runtime.RequestTimeoutMS = 100
	f.setBundle(b)
	if _, err := f.m.Reload(f.revision(t)); err != nil {
		t.Fatal(err)
	}
	address := strings.TrimPrefix(f.s.URL, "http://")
	connection, err := net.Dial("tcp", address)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	if tcp, ok := connection.(*net.TCPConn); ok {
		_ = tcp.SetReadBuffer(1024)
	}
	body := `{"model":"auto","stream":true,"messages":[{"role":"user","content":"Extract names"}]}`
	_, err = fmt.Fprintf(connection, "POST /v1/chat/completions HTTP/1.1\r\nHost: %s\r\nAuthorization: Bearer %s\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n%s", address, accessToken, len(body), body)
	if err != nil {
		t.Fatal(err)
	}
	eventually(t, func() bool { return f.m.state.admission.Snapshot()["model-a"] == 1 })
	// Never read the response: upstream cancellation alone cannot interrupt a
	// blocked downstream socket Write. The idle timeout must cover both sides.
	eventually(t, func() bool {
		return f.m.state.admission.Snapshot()["model-a"] == 0 && f.m.state.ledger.Snapshot().PendingReserves == 0
	})
}
