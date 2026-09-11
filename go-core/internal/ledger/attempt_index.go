package ledger

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"os"
)

// The WAL is authoritative. This disposable, non-mmap index is rebuilt on every
// Open, keeping exact historical IDs without retaining their objects in RAM.
// Bucket heads have fixed size; collisions compare the full ID, never a hash alone.
const attemptCacheLimit = 4096
const indexBuckets = 65536
const indexMagic = "AMRIDX01"
const indexRecordLimit = 8192

type attemptIndex struct {
	file  *os.File
	heads [indexBuckets]int64
	end   int64
	count int
}

func openAttemptIndex(path string) (*attemptIndex, error) {
	// Do not truncate an unrelated file or follow an existing symlink.
	if info, err := os.Lstat(path); err == nil {
		if !info.Mode().IsRegular() {
			return nil, errors.New("attempt index must be a regular file")
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	fail := func(err error) (*attemptIndex, error) { f.Close(); return nil, err }
	info, err := f.Stat()
	if err != nil {
		return fail(err)
	}
	if info.Size() > 0 {
		var magic [len(indexMagic)]byte
		n, readErr := f.ReadAt(magic[:], 0)
		// A process can die while creating the header; accept only its prefix.
		if (readErr != nil && readErr != io.EOF) || n == 0 || string(magic[:n]) != indexMagic[:n] {
			return fail(errors.New("unrecognized attempt index file"))
		}
	}
	if err = f.Truncate(0); err != nil {
		return fail(err)
	}
	if _, err = f.WriteAt([]byte(indexMagic), 0); err != nil {
		return fail(err)
	}
	return &attemptIndex{file: f, end: int64(len(indexMagic))}, nil
}

func indexBucket(id string) uint16 {
	h := sha256.Sum256([]byte(id))
	return binary.LittleEndian.Uint16(h[:2])
}

// Records are [previous offset, payload length, checksum, JSON payload]. An
// index read/write error poisons the writer; reopening rebuilds from the WAL.
func (x *attemptIndex) put(id string, a attempt, fresh bool) error {
	payload, err := json.Marshal(struct {
		ID      string
		Attempt attempt
	}{id, a})
	if err != nil {
		return err
	}
	if len(payload) > indexRecordLimit {
		return errors.New("attempt index record too large")
	}
	bucket := indexBucket(id)
	line := make([]byte, 44+len(payload))
	binary.LittleEndian.PutUint64(line[:8], uint64(x.heads[bucket]))
	binary.LittleEndian.PutUint32(line[8:12], uint32(len(payload)))
	h := sha256.New()
	h.Write(line[:12])
	h.Write(payload)
	sum := h.Sum(nil)
	copy(line[12:44], sum[:])
	copy(line[44:], payload)
	n, err := x.file.WriteAt(line, x.end)
	if err != nil {
		return err
	}
	if n != len(line) {
		return io.ErrShortWrite
	}
	x.heads[bucket] = x.end
	x.end += int64(n)
	if fresh {
		x.count++
	}
	return nil
}

func (x *attemptIndex) get(id string) (attempt, bool, error) {
	for offset := x.heads[indexBucket(id)]; offset != 0; {
		var header [44]byte
		if offset < int64(len(indexMagic)) || offset+44 > x.end {
			return attempt{}, false, errors.New("invalid index offset")
		}
		if _, err := x.file.ReadAt(header[:], offset); err != nil {
			return attempt{}, false, err
		}
		n := int(binary.LittleEndian.Uint32(header[8:12]))
		previous := int64(binary.LittleEndian.Uint64(header[:8]))
		if n <= 0 || n > indexRecordLimit || offset+44+int64(n) > x.end || previous < 0 || previous >= offset {
			return attempt{}, false, errors.New("invalid index record")
		}
		payload := make([]byte, n)
		if _, err := x.file.ReadAt(payload, offset+44); err != nil {
			return attempt{}, false, err
		}
		h := sha256.New()
		h.Write(header[:12])
		h.Write(payload)
		sum := h.Sum(nil)
		if string(sum[:]) != string(header[12:44]) {
			return attempt{}, false, errors.New("attempt index checksum mismatch")
		}
		var row struct {
			ID      string
			Attempt attempt
		}
		if err := json.Unmarshal(payload, &row); err != nil {
			return attempt{}, false, err
		}
		if row.ID == id {
			return row.Attempt, true, nil
		}
		offset = previous
	}
	return attempt{}, false, nil
}

func (l *Ledger) lookup(id string) (attempt, bool, error) {
	if a, ok := l.attempts[id]; ok {
		return a, true, nil
	}
	if l.index == nil {
		return attempt{}, false, nil
	} // isolated validation trial
	a, ok, err := l.index.get(id)
	if err != nil {
		l.broken = true
		return attempt{}, false, err
	}
	if ok {
		l.attempts[id] = a
	}
	return a, ok, nil
}

func (l *Ledger) trimCache() {
	if l.observation {
		return
	}
	if len(l.attempts) > attemptCacheLimit {
		// Replace the map to release its backing storage as well as its entries.
		// Called only after every staged record has reached the derived index.
		l.attempts = make(map[string]attempt)
	}
}
