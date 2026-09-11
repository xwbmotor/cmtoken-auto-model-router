package ledger

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"time"
)

const observationCheckpointMagic = "AMROBS01\n"
const observationCheckpointEvents = 4096
const observationPendingLimit = 20000
const observationCheckpointMaxBytes = 32 * 1024 * 1024

var ErrObservationMode = errors.New("ledger observation mode requires budget disabled and a dedicated journal path; mode changes require controlled restart")
var ErrPendingLimit = errors.New("observation ledger unresolved attempt limit reached; reconcile pending attempts before admitting more")

type observationCheckpoint struct {
	Version  int                `json:"version"`
	Seq      uint64             `json:"seq"`
	Snapshot Snapshot           `json:"snapshot"`
	Attempts map[string]attempt `json:"attempts"`
	Opening  *OpeningBalance    `json:"opening,omitempty"`
}

func (l *Ledger) loadCheckpoint() error {
	info, err := os.Lstat(l.checkpointPath)
	if os.IsNotExist(err) {
		if !l.observation {
			return nil
		}
		stat, err := l.file.Stat()
		if err != nil {
			return err
		}
		if stat.Size() != 0 {
			return ErrObservationMode
		}
		l.rollover(l.today())
		return l.writeCheckpoint(observationCheckpoint{Version: 1, Snapshot: l.snap, Attempts: l.attempts})
	}
	if err != nil {
		return err
	}
	if !l.observation {
		return ErrObservationMode
	}
	if !info.Mode().IsRegular() || info.Size() > observationCheckpointMaxBytes {
		return errors.New("invalid observation checkpoint file")
	}
	data, err := os.ReadFile(l.checkpointPath)
	if err != nil {
		return err
	}
	data = bytes.TrimPrefix(data, []byte(observationCheckpointMagic))
	var r record
	if json.Unmarshal(data, &r) != nil {
		return errors.New("corrupt observation checkpoint")
	}
	sum := sha256.Sum256(r.Event)
	if hex.EncodeToString(sum[:]) != r.SHA256 {
		return errors.New("observation checkpoint checksum mismatch")
	}
	var cp observationCheckpoint
	if json.Unmarshal(r.Event, &cp) != nil || cp.Version != 1 || cp.Attempts == nil || cp.Snapshot.Sources == nil {
		return errors.New("invalid observation checkpoint")
	}
	if len(cp.Attempts) > observationPendingLimit+observationCheckpointEvents {
		return ErrPendingLimit
	}
	if _, err := time.Parse("2006-01-02", cp.Snapshot.Date); err != nil {
		return errors.New("invalid checkpoint date")
	}
	var sourceActual, sourceEstimated int64
	for source, total := range cp.Snapshot.Sources {
		if source != "answer" && source != "probe" && source != "classifier" && source != "legacy" {
			return errors.New("invalid checkpoint source")
		}
		sourceActual, err = add(sourceActual, total.ActualMicros)
		if err != nil {
			return err
		}
		sourceEstimated, err = add(sourceEstimated, total.EstimatedMicros)
		if err != nil {
			return err
		}
	}
	if sourceActual != cp.Snapshot.ActualMicros || sourceEstimated != cp.Snapshot.EstimatedMicros {
		return errors.New("checkpoint source totals mismatch")
	}
	var pending int64
	count := 0
	for id, a := range cp.Attempts {
		if id == "" || len(id) > 512 || a.LastSeq == 0 || a.LastSeq > cp.Seq || !validAmount(a.Estimate) || !validAmount(a.Actual) || (a.Source != "answer" && a.Source != "probe" && a.Source != "classifier") {
			return errors.New("invalid checkpoint attempt")
		}
		switch a.State {
		case "reserve":
			count++
			if a.Estimate != nil {
				pending, err = add(pending, *a.Estimate)
				if err != nil {
					return err
				}
			}
		case "settle", "release":
		default:
			return errors.New("invalid checkpoint attempt state")
		}
	}
	if count > observationPendingLimit || cp.Snapshot.PendingReserves != count || cp.Snapshot.PendingMicros != pending || cp.Snapshot.ActualMicros < 0 || cp.Snapshot.EstimatedMicros < 0 || cp.Snapshot.Unpriced < 0 {
		return errors.New("invalid checkpoint totals")
	}
	if err = validateTotal(pending, cp.Snapshot.ActualMicros, cp.Snapshot.EstimatedMicros); err != nil {
		return err
	}
	l.seq, l.checkpointSeq, l.snap, l.attempts, l.opening = cp.Seq, cp.Seq, cp.Snapshot, cp.Attempts, cp.Opening
	return nil
}

// The WAL lock stays held throughout checkpoint replacement and WAL truncation.
// A crash before truncation leaves a checksummed prefix which replay skips.
func (l *Ledger) writeCheckpoint(cp observationCheckpoint) error {
	payload, err := json.Marshal(cp)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(payload)
	data, err := json.Marshal(record{Event: payload, SHA256: hex.EncodeToString(sum[:])})
	if err != nil {
		return err
	}
	data = append([]byte(observationCheckpointMagic), data...)
	if len(data) > observationCheckpointMaxBytes {
		return errors.New("observation checkpoint exceeds size limit")
	}
	name := l.checkpointPath + ".tmp"
	f, err := openCheckpointTemp(name)
	if err != nil {
		return err
	}
	defer os.Remove(name)
	if err = f.Chmod(0600); err == nil {
		var n int
		n, err = f.Write(data)
		if err == nil && n != len(data) {
			err = io.ErrShortWrite
		}
	}
	if err == nil {
		err = f.Sync()
	}
	err = errors.Join(err, f.Close())
	if err != nil {
		return err
	}
	if err = os.Rename(name, l.checkpointPath); err != nil {
		return err
	}
	return syncParent(l.checkpointPath)
}

func (l *Ledger) seedIndex() error {
	for id, a := range l.attempts {
		if err := l.index.put(id, a, true); err != nil {
			return err
		}
	}
	return nil
}

func (l *Ledger) saveCheckpoint() error {
	retained := make(map[string]attempt)
	for id, a := range l.attempts {
		if a.State == "reserve" || l.seq-a.LastSeq < observationCheckpointEvents {
			retained[id] = a
		}
	}
	cp := observationCheckpoint{Version: 1, Seq: l.seq, Snapshot: l.snap, Attempts: retained, Opening: l.opening}
	if err := l.writeCheckpoint(cp); err != nil {
		return fmt.Errorf("checkpoint: %w", err)
	}
	if err := l.file.Truncate(0); err != nil {
		return err
	}
	if _, err := l.file.Seek(0, io.SeekStart); err != nil {
		return err
	}
	if err := l.file.Sync(); err != nil {
		return err
	}
	// Derived index can always be regenerated from the checkpoint and WAL.
	path := l.index.file.Name()
	if err := l.index.file.Close(); err != nil {
		return err
	}
	rebuilt, err := openAttemptIndex(path)
	if err != nil {
		return err
	}
	l.index = rebuilt
	l.attempts = retained
	if err = l.seedIndex(); err != nil {
		return err
	}
	l.checkpointSeq = l.seq
	return nil
}

// One dedicated staging pathname bounds crash leftovers across repeated restarts.
// Only recognized regular files may be reused. Empty files and magic prefixes are
// possible if the process dies between creating the file and writing its header.
func openCheckpointTemp(path string) (*os.File, error) {
	if info, err := os.Lstat(path); err == nil {
		if !info.Mode().IsRegular() {
			return nil, errors.New("checkpoint temp must be a regular file")
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	fail := func(err error) (*os.File, error) { f.Close(); return nil, err }
	var header [len(observationCheckpointMagic)]byte
	n, err := f.ReadAt(header[:], 0)
	if (err != nil && err != io.EOF) || string(header[:n]) != observationCheckpointMagic[:n] {
		return fail(errors.New("unrecognized checkpoint temp file"))
	}
	if err = f.Truncate(0); err != nil {
		return fail(err)
	}
	return f, nil
}
