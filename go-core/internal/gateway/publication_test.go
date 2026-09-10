package gateway

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestUnresolvedPublicationRefusesStartup(t *testing.T) {
	path := filepath.Join(t.TempDir(), "runtime.json")
	if err := os.WriteFile(path+".pending", []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	_, err := NewManaged(ManagedOptions{RuntimeConfigFile: path})
	if err == nil || !strings.Contains(err.Error(), "unresolved snapshot publication") {
		t.Fatalf("unexpected startup outcome: %v", err)
	}
}
