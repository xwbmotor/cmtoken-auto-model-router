// Package ledger implements a single-writer, synchronous durable attempt ledger.
// Amounts are integer millionths of one yuan; no request bodies or credentials belong here.
package ledger

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"sync"
	"time"
	_ "time/tzdata"
)

var (
	ErrBudget   = errors.New("daily budget exhausted")
	ErrLocked   = errors.New("ledger already has a writer")
	ErrConflict = errors.New("attempt id conflicts with an existing record")
	ErrUnknown  = errors.New("unknown attempt id")
	ErrClosed   = errors.New("ledger is closed or requires recovery")
)

type Options struct {
	TimeZone string
	Now      func() time.Time
}
type Totals struct {
	ActualMicros    int64 `json:"actualMicros"`
	EstimatedMicros int64 `json:"estimatedMicros"`
}
type Snapshot struct {
	Date            string            `json:"date"`
	PendingMicros   int64             `json:"pendingMicros"`
	ActualMicros    int64             `json:"actualMicros"`
	EstimatedMicros int64             `json:"estimatedMicros"`
	PendingReserves int               `json:"pendingReserves"`
	Unpriced        int64             `json:"unpriced"`
	Sources         map[string]Totals `json:"sources"`
}
type attempt struct {
	Estimate  *int64
	Source    string
	State     string
	Actual    *int64
	FromUsage bool
}
type OpeningBalance struct {
	SourceID        string `json:"sourceID"`
	Date            string `json:"date"`
	ActualMicros    int64  `json:"actualMicros"`
	EstimatedMicros int64  `json:"estimatedMicros"`
	PendingMicros   int64  `json:"pendingMicros"`
}

type event struct {
	Opening   *OpeningBalance `json:"opening,omitempty"`
	Version   int             `json:"version"`
	Seq       uint64          `json:"seq"`
	Date      string          `json:"date"`
	Op        string          `json:"op"`
	ID        string          `json:"id"`
	Amount    *int64          `json:"amount,omitempty"`
	Source    string          `json:"source,omitempty"`
	FromUsage bool            `json:"fromUsage,omitempty"`
}
type record struct {
	Event  json.RawMessage `json:"event"`
	SHA256 string          `json:"sha256"`
}
type Ledger struct {
	mu       sync.Mutex
	file     *os.File
	now      func() time.Time
	zone     *time.Location
	seq      uint64
	snap     Snapshot
	attempts map[string]attempt
	index    *attemptIndex
	broken   bool
	opening  *OpeningBalance
	queue    chan *mutation
	submitMu sync.RWMutex
	closing  bool
	stopped  chan struct{}
	closeErr error
	batch    *commitBatch
	syncFile func() error
}

func Open(path string, options Options) (*Ledger, error) {
	zoneName := options.TimeZone
	if zoneName == "" {
		zoneName = "Asia/Shanghai"
	}
	zone, err := time.LoadLocation(zoneName)
	if err != nil {
		return nil, fmt.Errorf("ledger timezone: %w", err)
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = lockFile(f); err != nil {
		f.Close()
		return nil, err
	}
	l := &Ledger{file: f, now: options.Now, zone: zone, attempts: make(map[string]attempt)}
	l.index, err = openAttemptIndex(path + ".attempt-index")
	if err != nil {
		unlockFile(f)
		f.Close()
		return nil, err
	}
	if err = l.replay(); err != nil {
		l.index.file.Close()
		unlockFile(f)
		f.Close()
		return nil, err
	}
	if err = syncParent(path); err != nil {
		l.index.file.Close()
		unlockFile(f)
		f.Close()
		return nil, err
	}
	l.rollover(l.today())
	l.queue = make(chan *mutation, 256)
	l.stopped = make(chan struct{})
	l.syncFile = f.Sync
	go l.writeLoop()
	return l, nil
}
func (l *Ledger) today() string { return l.now().In(l.zone).Format("2006-01-02") }
func (l *Ledger) rollover(day string) {
	if l.snap.Date != day {
		l.snap = Snapshot{Date: day, PendingMicros: l.snap.PendingMicros, PendingReserves: l.snap.PendingReserves, Sources: make(map[string]Totals)}
	}
}
func same(a, b *int64) bool { return a == nil && b == nil || a != nil && b != nil && *a == *b }
func copyAmount(a *int64) *int64 {
	if a == nil {
		return nil
	}
	v := *a
	return &v
}
func validAmount(a *int64) bool { return a == nil || *a >= 0 }
func add(a, b int64) (int64, error) {
	if b < 0 || a > math.MaxInt64-b {
		return 0, errors.New("ledger amount overflow")
	}
	return a + b, nil
}

// ImportOpeningBalance imports one frozen Node ledger for the current accounting day.
// sourceID must be its lowercase SHA256 digest. Old unresolved reserves become
// conservative estimated spend because Node does not persist attempt identities.
func (l *Ledger) ImportOpeningBalance(sourceID, date string, actual, estimated, pending int64) error {
	return l.mutate(func() error {
		if l.broken || l.file == nil {
			return ErrClosed
		}
		o := OpeningBalance{sourceID, date, actual, estimated, pending}
		if l.opening != nil {
			if *l.opening == o {
				return nil
			}
			return ErrConflict
		}
		digest, err := hex.DecodeString(sourceID)
		if err != nil || len(digest) != 32 || hex.EncodeToString(digest) != sourceID || date != l.today() {
			return errors.New("opening balance requires source SHA256 and current accounting date")
		}
		if l.seq != 0 {
			return errors.New("opening balance requires an empty ledger")
		}
		return l.commit(event{Op: "opening", Opening: &o})
	})
}

// Reserve is durably committed before returning. Repeating identical IDs is idempotent.
// Use a fresh ID for every upstream attempt, including probes and classifier calls.
// A positive limit enables an atomic admission guard; unpriced attempts fail closed.
func (l *Ledger) Reserve(id string, estimate *int64, dailyLimit int64, source string) error {
	return l.mutate(func() error {
		if l.broken || l.file == nil {
			return ErrClosed
		}
		if id == "" || len(id) > 512 || !validAmount(estimate) {
			return errors.New("invalid reservation")
		}
		if source != "answer" && source != "probe" && source != "classifier" {
			return errors.New("invalid ledger source")
		}
		old, ok, err := l.lookup(id)
		if err != nil {
			return err
		}
		if ok {
			if same(old.Estimate, estimate) && old.Source == source {
				return nil
			}
			return ErrConflict
		}
		l.rollover(l.today())
		if dailyLimit > 0 {
			if estimate == nil {
				return ErrBudget
			}
			total, err := add(l.snap.PendingMicros, l.snap.ActualMicros)
			if err != nil {
				return err
			}
			total, err = add(total, l.snap.EstimatedMicros)
			if err != nil {
				return err
			}
			if total > dailyLimit || *estimate > dailyLimit-total {
				return ErrBudget
			}
		}
		return l.commit(event{Op: "reserve", ID: id, Amount: copyAmount(estimate), Source: source})
	})
}

// Settle keeps missing usage in the estimated column. Actual may exceed the admission estimate.
func (l *Ledger) Settle(id string, actual *int64, fromUsage bool) error {
	return l.mutate(func() error {
		if l.broken || l.file == nil {
			return ErrClosed
		}
		if !validAmount(actual) {
			return errors.New("invalid settlement")
		}
		old, ok, err := l.lookup(id)
		if err != nil {
			return err
		}
		if !ok {
			return ErrUnknown
		}
		if !fromUsage || actual == nil {
			actual = nil
			fromUsage = false
		}
		if old.State == "settle" {
			if same(old.Actual, actual) && old.FromUsage == fromUsage {
				return nil
			}
			return ErrConflict
		}
		if old.State != "reserve" {
			return ErrConflict
		}
		return l.commit(event{Op: "settle", ID: id, Amount: copyAmount(actual), FromUsage: fromUsage})
	})
}

// Release is only valid when the caller knows upstream generation never started.
func (l *Ledger) Release(id string) error {
	return l.mutate(func() error {
		if l.broken || l.file == nil {
			return ErrClosed
		}
		old, ok, err := l.lookup(id)
		if err != nil {
			return err
		}
		if !ok {
			return ErrUnknown
		}
		if old.State == "release" {
			return nil
		}
		if old.State != "reserve" {
			return ErrConflict
		}
		return l.commit(event{Op: "release", ID: id})
	})
}

// RetainedAttempts counts cached records, not the complete on-disk history.
func (l *Ledger) RetainedAttempts() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.attempts)
}

// AttemptStorage reports a coherent cache and durable-history diagnostic.
func (l *Ledger) AttemptStorage() (cached, total, limit int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.attempts), l.index.count, attemptCacheLimit
}

func (l *Ledger) Snapshot() Snapshot {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.rollover(l.today())
	s := l.snap
	s.Sources = make(map[string]Totals, len(l.snap.Sources))
	for k, v := range l.snap.Sources {
		s.Sources[k] = v
	}
	return s
}
func (l *Ledger) Close() error {
	l.submitMu.Lock()
	if !l.closing {
		l.closing = true
		l.queue <- &mutation{close: true}
	}
	l.submitMu.Unlock()
	<-l.stopped
	return l.closeErr
}

// apply validates arithmetic before mutating. Failed writes poison the writer until reopen.
func (l *Ledger) apply(e event) error {
	if !validAmount(e.Amount) {
		return errors.New("negative ledger amount")
	}
	l.rollover(e.Date)
	if e.Op == "opening" {
		if e.Seq != 1 || l.opening != nil || e.Opening == nil || e.Opening.Date != e.Date {
			return errors.New("invalid opening record")
		}
		o := *e.Opening
		digest, err := hex.DecodeString(o.SourceID)
		if err != nil || len(digest) != 32 || hex.EncodeToString(digest) != o.SourceID || o.ActualMicros < 0 || o.EstimatedMicros < 0 || o.PendingMicros < 0 {
			return errors.New("invalid opening balance")
		}
		estimated, err := add(o.EstimatedMicros, o.PendingMicros)
		if err != nil {
			return err
		}
		if _, err = add(o.ActualMicros, estimated); err != nil {
			return err
		}
		l.snap.ActualMicros = o.ActualMicros
		l.snap.EstimatedMicros = estimated
		l.snap.Sources["legacy"] = Totals{ActualMicros: o.ActualMicros, EstimatedMicros: estimated}
		l.opening = &o
		return nil
	}
	if e.Opening != nil {
		return errors.New("unexpected opening balance")
	}
	if e.Op == "reserve" {
		_, ok, err := l.lookup(e.ID)
		if err != nil {
			return err
		}
		if ok {
			return ErrConflict
		}
		if e.ID == "" || (e.Source != "answer" && e.Source != "probe" && e.Source != "classifier") {
			return errors.New("invalid reservation record")
		}
		pending := l.snap.PendingMicros
		err = nil
		if e.Amount != nil {
			pending, err = add(pending, *e.Amount)
			if err != nil {
				return err
			}
		}
		if err := validateTotal(pending, l.snap.ActualMicros, l.snap.EstimatedMicros); err != nil {
			return err
		}
		l.snap.PendingMicros = pending
		l.snap.PendingReserves++
		if e.Amount == nil {
			l.snap.Unpriced++
		}
		l.attempts[e.ID] = attempt{Estimate: copyAmount(e.Amount), Source: e.Source, State: "reserve"}
		return nil
	}
	a, ok, lookupErr := l.lookup(e.ID)
	if lookupErr != nil {
		return lookupErr
	}
	if !ok {
		return ErrUnknown
	}
	if a.State != "reserve" {
		return ErrConflict
	}
	if e.Op != "release" && e.Op != "settle" {
		return errors.New("invalid ledger operation")
	}
	actual, estimated := l.snap.ActualMicros, l.snap.EstimatedMicros
	t := l.snap.Sources[a.Source]
	if e.Op == "settle" {
		var err error
		if e.FromUsage && e.Amount != nil {
			actual, err = add(actual, *e.Amount)
			if err != nil {
				return err
			}
			t.ActualMicros, err = add(t.ActualMicros, *e.Amount)
			if err != nil {
				return err
			}
		} else if a.Estimate != nil {
			estimated, err = add(estimated, *a.Estimate)
			if err != nil {
				return err
			}
			t.EstimatedMicros, err = add(t.EstimatedMicros, *a.Estimate)
			if err != nil {
				return err
			}
		}
	}
	pending := l.snap.PendingMicros
	if a.Estimate != nil {
		pending -= *a.Estimate
	}
	if err := validateTotal(pending, actual, estimated); err != nil {
		return err
	}
	l.snap.PendingMicros = pending
	l.snap.PendingReserves--
	l.snap.ActualMicros = actual
	l.snap.EstimatedMicros = estimated
	l.snap.Sources[a.Source] = t
	a.State = e.Op
	a.Actual = copyAmount(e.Amount)
	a.FromUsage = e.FromUsage
	l.attempts[e.ID] = a
	return nil
}
func (l *Ledger) commit(e event) error {
	e.Version = 1
	e.Seq = l.seq + 1
	e.Date = l.today()
	// Validate using a shallow map copy (attempt values are immutable).
	trial := &Ledger{snap: l.snap, opening: l.opening, attempts: make(map[string]attempt, 1)}
	trial.snap.Sources = make(map[string]Totals, len(l.snap.Sources))
	for k, v := range l.snap.Sources {
		trial.snap.Sources[k] = v
	}
	if a, ok := l.attempts[e.ID]; ok {
		trial.attempts[e.ID] = a
	}
	if err := trial.apply(e); err != nil {
		return err
	}
	payload, err := json.Marshal(e)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(payload)
	line, err := json.Marshal(record{Event: payload, SHA256: hex.EncodeToString(sum[:])})
	if err != nil {
		return err
	}
	line = append(line, '\n')
	l.batch.data = append(l.batch.data, line...)
	if e.Op != "opening" {
		if _, exists := l.batch.undo[e.ID]; !exists {
			old, ok := l.attempts[e.ID]
			l.batch.undo[e.ID] = priorAttempt{value: old, exists: ok}
		}
	}
	l.snap = trial.snap
	if e.Op != "opening" {
		l.attempts[e.ID] = trial.attempts[e.ID]
	}
	l.opening = trial.opening
	l.seq = e.Seq
	return nil
}
func (l *Ledger) replay() error {
	reader := bufio.NewReaderSize(l.file, 64*1024+1)
	var offset int64
	for {
		line, err := reader.ReadSlice('\n')
		if err == io.EOF {
			if len(line) > 0 {
				// Never truncate an unrelated existing JSON file (for example the
				// Node ledger accidentally supplied as the Go target).
				if offset == 0 && !bytes.HasPrefix(line, []byte(`{"event":`)) {
					return errors.New("not a Go ledger journal")
				}
				if err = l.file.Truncate(offset); err != nil {
					return err
				}
				if err = l.file.Sync(); err != nil {
					return err
				}
			}
			break
		}
		if err != nil {
			return err
		}
		if len(line) > 64*1024 {
			return errors.New("ledger record too large")
		}
		var r record
		if err = json.Unmarshal(bytes.TrimSpace(line), &r); err != nil {
			return fmt.Errorf("corrupt ledger record at byte %d", offset)
		}
		sum := sha256.Sum256(r.Event)
		if hex.EncodeToString(sum[:]) != r.SHA256 {
			return fmt.Errorf("ledger checksum mismatch at byte %d", offset)
		}
		var e event
		if json.Unmarshal(r.Event, &e) != nil || e.Version != 1 || e.Seq != l.seq+1 {
			return fmt.Errorf("invalid ledger sequence at byte %d", offset)
		}
		if _, err = time.Parse("2006-01-02", e.Date); err != nil {
			return errors.New("invalid ledger date")
		}
		if err = l.apply(e); err != nil {
			return fmt.Errorf("ledger replay: %w", err)
		}
		if e.Op != "opening" {
			if err = l.index.put(e.ID, l.attempts[e.ID], e.Op == "reserve"); err != nil {
				return err
			}
			l.trimCache()
		}
		l.seq = e.Seq
		offset += int64(len(line))
	}
	_, err := l.file.Seek(0, io.SeekEnd)
	return err
}

func validateTotal(pending, actual, estimated int64) error {
	total, err := add(pending, actual)
	if err != nil {
		return err
	}
	_, err = add(total, estimated)
	return err
}
