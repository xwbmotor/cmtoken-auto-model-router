// Package liveconfig publishes complete validated JSON configuration snapshots.
package liveconfig

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sync"
	"sync/atomic"
)

const MaxBytes = 8 << 20

var ErrConflict = errors.New("configuration revision conflict")
var ErrInvalid = errors.New("invalid configuration")

type Snapshot[T any] struct {
	Revision string
	Value    T
}
type document struct {
	revision string
	value    []byte
}
type Store[T any] struct {
	mu       sync.Mutex
	current  atomic.Pointer[document]
	validate func([]byte) (T, error)
}

// New requires a validator for the entire configuration, including cross-field
// invariants. T must be a JSON configuration DTO, without custom JSON methods.
// Validation errors are redacted because they may contain credential values.
func New[T any](raw []byte, validate func([]byte) (T, error)) (*Store[T], error) {
	if validate == nil {
		return nil, ErrInvalid
	}
	s := &Store[T]{validate: validate}
	if _, err := s.Reload(raw, ""); err != nil {
		return nil, err
	}
	return s, nil
}

// Load decodes a private copy; callers may mutate nested maps/slices without
// changing current or in-flight snapshots. Capture exactly once per request.
func (s *Store[T]) Load() (Snapshot[T], error) {
	d := s.current.Load()
	if d == nil {
		return Snapshot[T]{}, ErrInvalid
	}
	var v T
	if json.Unmarshal(d.value, &v) != nil {
		return Snapshot[T]{}, ErrInvalid
	}
	return Snapshot[T]{Revision: d.revision, Value: v}, nil
}

// Reload serializes publishers, validates the complete candidate, then swaps
// one pointer. Failed validation/CAS leaves the last known good snapshot intact.
// The revision identifies original bytes, matching Node's quoted SHA-256 ETag.
func (s *Store[T]) Reload(raw []byte, expectedRevision string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	old := s.current.Load()
	if expectedRevision != "" && (old == nil || old.revision != expectedRevision) {
		return "", ErrConflict
	}
	if len(raw) == 0 || len(raw) > MaxBytes || !json.Valid(raw) {
		return "", ErrInvalid
	}
	input := append([]byte(nil), raw...)
	h := sha256.Sum256(input)
	revision := "\"" + hex.EncodeToString(h[:]) + "\""
	if old != nil && old.revision == revision {
		return revision, nil
	}
	v, err := s.validate(input)
	if err != nil {
		return "", ErrInvalid
	}
	encoded, err := json.Marshal(v)
	if err != nil || len(encoded) > MaxBytes {
		return "", ErrInvalid
	}
	var check T
	if json.Unmarshal(encoded, &check) != nil {
		return "", ErrInvalid
	}
	s.current.Store(&document{revision: revision, value: encoded})
	return revision, nil
}
