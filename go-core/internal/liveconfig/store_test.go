package liveconfig

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
)

type config struct {
	Version int              `json:"version"`
	Values  map[string][]int `json:"values"`
}

func validate(raw []byte) (config, error) {
	var c config
	if err := json.Unmarshal(raw, &c); err != nil {
		return c, err
	}
	if c.Version < 1 || len(c.Values["x"]) != 1 || c.Values["x"][0] != c.Version {
		return c, errors.New("invalid secret-value")
	}
	return c, nil
}
func raw(n int) []byte { return []byte(fmt.Sprintf(`{"version":%d,"values":{"x":[%d]}}`, n, n)) }

func TestAtomicSnapshotsAndRollback(t *testing.T) {
	s, err := New(raw(1), validate)
	if err != nil {
		t.Fatal(err)
	}
	first, _ := s.Load()
	first.Value.Values["x"][0] = 100
	if _, err := s.Reload([]byte(`{"version":2,"values":{"x":[1]}}`), first.Revision); err != ErrInvalid || strings.Contains(err.Error(), "secret") {
		t.Fatal("validation error not redacted")
	}
	still, _ := s.Load()
	if still.Revision != first.Revision || still.Value.Values["x"][0] != 1 {
		t.Fatal("failed load changed snapshot")
	}
	newRevision, err := s.Reload(raw(2), first.Revision)
	if err != nil || newRevision == first.Revision {
		t.Fatal("reload")
	}
	if _, err := s.Reload(raw(3), first.Revision); err != ErrConflict {
		t.Fatal("stale publisher accepted")
	}
	if first.Value.Version != 1 {
		t.Fatal("in-flight request changed")
	}
	last, _ := s.Load()
	if last.Value.Version != 2 {
		t.Fatal("wrong active version")
	}
}

func TestConcurrentPublishRead(t *testing.T) {
	s, err := New(raw(1), validate)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 100; j++ {
				v, err := s.Load()
				if err != nil || v.Value.Version != v.Value.Values["x"][0] {
					t.Error("torn snapshot")
				}
				v.Value.Values["x"][0] = -1
			}
		}()
	}
	for i := 2; i < 100; i++ {
		if _, err := s.Reload(raw(i), ""); err != nil {
			t.Fatal(err)
		}
	}
	wg.Wait()
}

func TestConcurrentCompareAndSwap(t *testing.T) {
	s, _ := New(raw(1), validate)
	initial, _ := s.Load()
	results := make(chan error, 2)
	for i := 2; i <= 3; i++ {
		go func(n int) { _, err := s.Reload(raw(n), initial.Revision); results <- err }(i)
	}
	a, b := <-results, <-results
	if !((a == nil && b == ErrConflict) || (a == ErrConflict && b == nil)) {
		t.Fatal("CAS admitted two publishers")
	}
}
