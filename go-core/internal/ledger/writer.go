package ledger

import (
	"errors"
	"io"
)

// A caller is acknowledged only after its batch is durable. There is no timer
// or deliberate batching delay: only mutations already queued are combined.
type mutation struct {
	run    func() error
	result chan error
	close  bool
}
type priorAttempt struct {
	value  attempt
	exists bool
}
type commitBatch struct {
	data    []byte
	undo    map[string]priorAttempt
	snap    Snapshot
	seq     uint64
	opening *OpeningBalance
}

func (l *Ledger) mutate(run func() error) error {
	m := &mutation{run: run, result: make(chan error, 1)}
	// Close cannot pass the enqueue boundary of an accepted submission.
	l.submitMu.RLock()
	if l.closing {
		l.submitMu.RUnlock()
		return ErrClosed
	}
	l.queue <- m
	l.submitMu.RUnlock()
	return <-m.result
}

func (l *Ledger) writeLoop() {
	for {
		first := <-l.queue
		closing := first.close
		group := make([]*mutation, 0, 64)
		if !closing {
			group = append(group, first)
		collect:
			for len(group) < cap(group) {
				select {
				case next := <-l.queue:
					if next.close {
						closing = true
						break collect
					}
					group = append(group, next)
				default:
					break collect
				}
			}
			l.flush(group)
		}
		if closing {
			l.mu.Lock()
			f := l.file
			l.file = nil
			unlockFile(f)
			l.closeErr = errors.Join(f.Close(), l.index.file.Close())
			l.mu.Unlock()
			close(l.stopped)
			return
		}
	}
}

func (l *Ledger) flush(group []*mutation) {
	l.mu.Lock()
	b := &commitBatch{undo: make(map[string]priorAttempt), snap: l.snap, seq: l.seq, opening: l.opening}
	l.batch = b
	results := make([]error, len(group))
	for i, m := range group {
		results[i] = m.run()
	}
	l.batch = nil
	if len(b.data) > 0 {
		n, err := l.file.Write(b.data)
		if err == nil && n != len(b.data) {
			err = io.ErrShortWrite
		}
		if err == nil {
			err = l.syncFile()
		}
		if err == nil {
			for id, old := range b.undo {
				if err = l.index.put(id, l.attempts[id], !old.exists); err != nil {
					break
				}
			}
		}
		if err == nil && l.observation && l.seq-l.checkpointSeq >= observationCheckpointEvents {
			err = l.saveCheckpoint()
		}
		if err != nil {
			// Never expose staged totals or acknowledge a mutation on a failed
			// write/sync. Recovery decides the durable prefix on the next Open.
			l.snap, l.seq, l.opening = b.snap, b.seq, b.opening
			for id, old := range b.undo {
				if old.exists {
					l.attempts[id] = old.value
				} else {
					delete(l.attempts, id)
				}
			}
			l.broken = true
			for i := range results {
				if results[i] == nil {
					results[i] = err
				}
			}
		}
	}
	if !l.broken {
		l.trimCache()
	}
	l.mu.Unlock()
	for i, m := range group {
		m.result <- results[i]
	}
}
