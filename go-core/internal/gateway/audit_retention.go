package gateway

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

// AuditOptions limits local audit retention; it is independent of billing/WAL
// recovery. Zero values select defaults. The containing directory must be
// private to the runtime, whose ledger lock also serializes audit ownership.
type AuditOptions struct {
	MaxBytes    int64
	MaxArchives int
	MaxAge      time.Duration
}

func (o AuditOptions) normalized() (AuditOptions, error) {
	if o.MaxBytes == 0 {
		o.MaxBytes = 16 << 20
	}
	if o.MaxArchives == 0 {
		o.MaxArchives = 8
	}
	if o.MaxAge == 0 {
		o.MaxAge = 7 * 24 * time.Hour
	}
	if o.MaxBytes < 1 || o.MaxBytes > 1<<40 || o.MaxArchives < 1 || o.MaxArchives > 1024 || o.MaxAge < time.Minute {
		return o, errors.New("invalid audit retention limits")
	}
	return o, nil
}

func auditRegular(path string) error {
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return errors.New("audit path is not a regular file")
	}
	return nil
}

// Unix directory fsync makes rename/create/removal durable. Windows does not
// expose directory fsync through os.File.Sync; file data is still synced.
func auditSyncDir(path string) error {
	if runtime.GOOS == "windows" {
		return nil
	}
	f, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}

const auditArchiveTime = "20060102T150405.000000000Z"

type auditArchive struct {
	path  string
	stamp time.Time
}

func (j *auditJournal) archives() ([]auditArchive, error) {
	entries, err := os.ReadDir(filepath.Dir(j.path))
	if err != nil {
		return nil, err
	}
	prefix := filepath.Base(j.path) + ".archive-"
	var files []auditArchive
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasPrefix(name, prefix) {
			continue
		}
		suffix := strings.TrimPrefix(name, prefix)
		// Only this exact namespaced format is owned by retention. Unrelated
		// files are never removed (nor counted as managed audit storage).
		if len(suffix) != len(auditArchiveTime)+1+32+6 || !strings.HasSuffix(suffix, ".jsonl") {
			continue
		}
		stamp, err := time.Parse(auditArchiveTime, suffix[:len(auditArchiveTime)])
		if err != nil || suffix[len(auditArchiveTime)] != '-' {
			continue
		}
		if _, err := hex.DecodeString(suffix[len(auditArchiveTime)+1 : len(suffix)-6]); err != nil {
			continue
		}
		path := filepath.Join(filepath.Dir(j.path), name)
		if err := auditRegular(path); err != nil {
			return nil, err
		}
		files = append(files, auditArchive{path, stamp})
	}
	sort.Slice(files, func(a, b int) bool { return files[a].path < files[b].path })
	return files, nil
}

func (j *auditJournal) prune(keep int) error {
	files, err := j.archives()
	if err != nil {
		return err
	}
	cutoff := time.Now().UTC().Add(-j.options.MaxAge)
	removed := false
	for i, file := range files {
		if i >= len(files)-keep && !file.stamp.Before(cutoff) {
			continue
		}
		if err := auditRegular(file.path); err != nil {
			return err
		}
		if err := os.Remove(file.path); err != nil {
			return err
		}
		removed = true
	}
	if removed {
		return auditSyncDir(j.path)
	}
	return nil
}

func (j *auditJournal) maintain() error {
	if j.size > 0 && time.Since(j.activeSince) >= j.options.MaxAge {
		if err := j.rotate(); err != nil {
			return err
		}
	}
	return j.prune(j.options.MaxArchives)
}

func (j *auditJournal) rotate() error {
	// Prune only acknowledged historical archives. Never discard the active
	// file to make room, even on failed rotation or disk-full recovery.
	if err := j.prune(j.options.MaxArchives - 1); err != nil {
		return err
	}
	if err := j.syncFile(); err != nil {
		return err
	}
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return err
	}
	archive := j.path + ".archive-" + time.Now().UTC().Format(auditArchiveTime) + "-" + hex.EncodeToString(random[:]) + ".jsonl"
	// A hard link provides atomic no-replace publication: an existing target
	// can never be overwritten. A crash before removing the active name can
	// leave both names linked; open repairs that before accepting writes.
	if err := os.Link(j.path, archive); err != nil {
		return err
	}
	if err := auditSyncDir(j.path); err != nil {
		return err
	}
	if err := j.file.Close(); err != nil {
		return err
	}
	if err := os.Remove(j.path); err != nil {
		return err
	}
	if err := auditSyncDir(j.path); err != nil {
		return err
	}
	f, err := os.OpenFile(j.path, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	j.file = f
	j.size = 0
	return auditSyncDir(j.path)
}

// A rotation interrupted after linking and before unlinking is rolled back by
// removing only the duplicate archive name, leaving the active data intact.
func (j *auditJournal) recoverRotation() error {
	active, err := j.file.Stat()
	if err != nil {
		return err
	}
	files, err := j.archives()
	if err != nil {
		return err
	}
	for _, file := range files {
		info, err := os.Lstat(file.path)
		if err != nil {
			return err
		}
		if os.SameFile(active, info) {
			if err := os.Remove(file.path); err != nil {
				return err
			}
		}
	}
	return auditSyncDir(j.path)
}
