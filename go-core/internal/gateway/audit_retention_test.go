package gateway

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func auditArchiveName(path string, stamp time.Time) string {
	return path + ".archive-" + stamp.UTC().Format(auditArchiveTime) + "-" + strings.Repeat("a", 32) + ".jsonl"
}

func TestAuditRotationRestartAndRetention(t *testing.T) {
	path := filepath.Join(t.TempDir(), "audit.jsonl")
	options := AuditOptions{MaxBytes: 40, MaxArchives: 2, MaxAge: time.Hour}
	j, err := openAuditWithOptions(path, options)
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"a", "b", "c", "d", "e", "f", "g"} {
		if err := j.append([]byte(`{"requestId":"` + id + `"}` + "\n")); err != nil {
			t.Fatal(err)
		}
	}
	if err := j.Close(); err != nil {
		t.Fatal(err)
	}
	archives, err := j.archives()
	if err != nil || len(archives) != 2 {
		t.Fatalf("archives %v %v", archives, err)
	}
	var retained []byte
	for _, archive := range archives {
		data, err := os.ReadFile(archive.path)
		if err != nil {
			t.Fatal(err)
		}
		retained = append(retained, data...)
	}
	data, _ := os.ReadFile(path)
	retained = append(retained, data...)
	if bytes.Contains(retained, []byte(`"a"`)) || !bytes.Contains(retained, []byte(`"g"`)) || bytes.Count(retained, []byte{'\n'}) != 5 {
		t.Fatalf("retained %s", retained)
	}
	j, err = openAuditWithOptions(path, options)
	if err != nil {
		t.Fatal(err)
	}
	defer j.Close()
	if err := j.append([]byte("{\"requestId\":\"h\"}\n")); err != nil {
		t.Fatal(err)
	}
}

func TestAuditInterruptedLinkRotationAndTailRecovery(t *testing.T) {
	path := filepath.Join(t.TempDir(), "audit.jsonl")
	data := []byte("{\"requestId\":\"a\"}\n{\"requestId\":")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	archive := auditArchiveName(path, time.Now())
	if err := os.Link(path, archive); err != nil {
		t.Fatal(err)
	}
	j, err := openAudit(path)
	if err != nil {
		t.Fatal(err)
	}
	defer j.Close()
	if _, err := os.Stat(archive); !os.IsNotExist(err) {
		t.Fatal("duplicate link survived recovery", err)
	}
	if err := j.append([]byte("{\"requestId\":\"b\"}\n")); err != nil {
		t.Fatal(err)
	}
	actual, _ := os.ReadFile(path)
	if bytes.Count(actual, []byte{'\n'}) != 2 {
		t.Fatalf("bad tail recovery %s", actual)
	}
}

func TestAuditRestartAfterActiveUnlinkPreservesArchive(t *testing.T) {
	path := filepath.Join(t.TempDir(), "audit.jsonl")
	archive := auditArchiveName(path, time.Now())
	data := []byte("{\"requestId\":\"saved\"}\n")
	if err := os.WriteFile(archive, data, 0600); err != nil {
		t.Fatal(err)
	}
	j, err := openAudit(path)
	if err != nil {
		t.Fatal(err)
	}
	defer j.Close()
	if err := j.append([]byte("{\"requestId\":\"new\"}\n")); err != nil {
		t.Fatal(err)
	}
	actual, _ := os.ReadFile(archive)
	if !bytes.Equal(actual, data) {
		t.Fatal("archive modified")
	}
}

func TestAuditPrunesExpiredArchivesAndLeavesForeignFiles(t *testing.T) {
	path := filepath.Join(t.TempDir(), "audit.jsonl")
	expired := auditArchiveName(path, time.Now().Add(-8*24*time.Hour))
	foreign := path + ".archive-unrelated.jsonl"
	for _, p := range []string{expired, foreign} {
		if err := os.WriteFile(p, []byte("{}\n"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	j, err := openAudit(path)
	if err != nil {
		t.Fatal(err)
	}
	defer j.Close()
	if _, err := os.Stat(expired); !os.IsNotExist(err) {
		t.Fatal("expired archive kept", err)
	}
	if _, err := os.Stat(foreign); err != nil {
		t.Fatal("foreign file removed", err)
	}
}

func TestAuditRejectsNonRegularPathsAndDamagedCompleteRecord(t *testing.T) {
	for _, mode := range []string{"active-directory", "archive-directory", "damaged"} {
		t.Run(mode, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "audit.jsonl")
			switch mode {
			case "active-directory":
				os.Mkdir(path, 0700)
			case "archive-directory":
				os.Mkdir(auditArchiveName(path, time.Now()), 0700)
			case "damaged":
				os.WriteFile(path, []byte("not-json\n"), 0600)
			}
			if j, err := openAudit(path); err == nil {
				j.Close()
				t.Fatal("unsafe path accepted")
			}
		})
	}
}

func TestAuditRotationFailureDoesNotAcknowledgeNewRecord(t *testing.T) {
	path := filepath.Join(t.TempDir(), "audit.jsonl")
	j, err := openAuditWithOptions(path, AuditOptions{MaxBytes: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer j.Close()
	if err := j.append([]byte("{\"requestId\":\"saved\"}\n")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(auditArchiveName(path, time.Now()), 0700); err != nil {
		t.Fatal(err)
	}
	if err := j.append([]byte("{\"requestId\":\"new\"}\n")); err == nil {
		t.Fatal("rotation failure acknowledged")
	}
	actual, _ := os.ReadFile(path)
	if bytes.Contains(actual, []byte("new")) || !bytes.Contains(actual, []byte("saved")) {
		t.Fatalf("unexpected data %s", actual)
	}
}

func TestAuditIdleMaintenanceRotatesAndPrunes(t *testing.T) {
	path := filepath.Join(t.TempDir(), "audit.jsonl")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	data := []byte("{\"requestId\":\"saved\"}\n")
	if _, err := f.Write(data); err != nil {
		t.Fatal(err)
	}
	options, _ := (AuditOptions{}).normalized()
	j := &auditJournal{file: f, path: path, options: options, size: int64(len(data)), activeSince: time.Now().Add(-8 * 24 * time.Hour)}
	j.syncFile = func() error { return j.file.Sync() }
	defer func() { j.file.Close() }()
	expired := auditArchiveName(path, time.Now().Add(-8*24*time.Hour))
	if err := os.WriteFile(expired, data, 0600); err != nil {
		t.Fatal(err)
	}
	if err := j.maintain(); err != nil {
		t.Fatal(err)
	}
	if j.size != 0 {
		t.Fatal("idle active file did not rotate")
	}
	archives, err := j.archives()
	if err != nil || len(archives) != 1 {
		t.Fatalf("archives %v %v", archives, err)
	}
	actual, _ := os.ReadFile(archives[0].path)
	if !bytes.Equal(actual, data) {
		t.Fatal("idle rotation lost data")
	}
	if _, err := os.Stat(expired); !os.IsNotExist(err) {
		t.Fatal("idle expired archive retained", err)
	}
}
