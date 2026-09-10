package gateway

import (
	"io"
	"os"
	"sync"
)

// Audit records keep their existing line format. Only already-queued records
// share a sync; append never reports success before that sync completes.
type auditEntry struct {
	data   []byte
	result chan error
	close  bool
}
type auditJournal struct {
	file     *os.File
	queue    chan *auditEntry
	submitMu sync.RWMutex
	closing  bool
	stopped  chan struct{}
	closeErr error
	failure  error // owned by writeLoop; a failed journal never resumes writes
	syncFile func() error
}

func (j *auditJournal) append(data []byte) error {
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
	for {
		first := <-j.queue
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
				n, err := j.file.Write(data)
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
