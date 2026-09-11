package gateway

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"sync"
	"time"
)

// Audit records keep their existing line format. Only already-queued records
// share a sync; append never reports success before that sync completes.
type auditEntry struct {
	data   []byte
	result chan error
	close  bool
}
type auditJournal struct {
	file        *os.File
	queue       chan *auditEntry
	submitMu    sync.RWMutex
	closing     bool
	stopped     chan struct{}
	closeErr    error
	failure     error // owned by writeLoop; a failed journal never resumes writes
	syncFile    func() error
	path        string
	size        int64
	options     AuditOptions
	activeSince time.Time
}

func (j *auditJournal) append(data []byte) error {
	if len(data) == 0 || len(data) > 16384 || data[len(data)-1] != '\n' || bytes.Contains(data[:len(data)-1], []byte{'\n'}) || !json.Valid(data[:len(data)-1]) {
		return errors.New("invalid audit record")
	}
	e := &auditEntry{data: data, result: make(chan error, 1)}
	j.submitMu.RLock()
	if j.closing {
		j.submitMu.RUnlock()
		return os.ErrClosed
	}
	j.queue <- e
	j.submitMu.RUnlock()
	return <-e.result
}

func (j *auditJournal) Close() error {
	j.submitMu.Lock()
	if !j.closing {
		j.closing = true
		j.queue <- &auditEntry{close: true}
	}
	j.submitMu.Unlock()
	<-j.stopped
	return j.closeErr
}

func (j *auditJournal) writeLoop() {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		var first *auditEntry
		select {
		case first = <-j.queue:
		case <-ticker.C:
			if j.failure == nil {
				j.failure = j.maintain()
			}
			continue
		}
		closing := first.close
		group := make([]*auditEntry, 0, 64)
		if !closing {
			group = append(group, first)
		collect:
			for len(group) < cap(group) {
				select {
				case next := <-j.queue:
					if next.close {
						closing = true
						break collect
					}
					group = append(group, next)
				default:
					break collect
				}
			}
			if j.failure == nil {
				bytes := 0
				for _, e := range group {
					bytes += len(e.data)
				}
				data := make([]byte, 0, bytes)
				for _, e := range group {
					data = append(data, e.data...)
				}
				var err error
				if j.size > 0 && j.size+int64(len(data)) > j.options.MaxBytes {
					err = j.rotate()
				}
				var n int
				if err == nil {
					if j.size == 0 {
						j.activeSince = time.Now()
					}
					n, err = j.file.Write(data)
					j.size += int64(n)
				}
				if err == nil && n != len(data) {
					err = io.ErrShortWrite
				}
				if err == nil {
					err = j.syncFile()
				}
				j.failure = err
			}
			for _, e := range group {
				e.result <- j.failure
			}
		}
		if closing {
			j.closeErr = j.file.Close()
			close(j.stopped)
			return
		}
	}
}
