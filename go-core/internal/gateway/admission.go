package gateway

import (
	"sync"

	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/decision"
)

// Admission owns this process's reservations. Selection and reservation share a
// lock so two simultaneous requests cannot both consume the last available slot.
type Admission struct {
	mu     sync.Mutex
	active map[string]int
}

func NewAdmission() *Admission { return &Admission{active: make(map[string]int)} }

func (a *Admission) Snapshot() map[string]int {
	a.mu.Lock()
	defer a.mu.Unlock()
	snapshot := make(map[string]int, len(a.active))
	for id, count := range a.active {
		snapshot[id] = count
	}
	return snapshot
}

func (a *Admission) Select(in decision.Input) (decision.Decision, func(), error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	in.Runtime.Inflight = a.active
	d, err := decision.Decide(in)
	if err != nil {
		return d, nil, err
	}
	a.active[d.SelectedModel]++
	var once sync.Once
	release := func() {
		once.Do(func() {
			a.mu.Lock()
			defer a.mu.Unlock()
			a.active[d.SelectedModel]--
			if a.active[d.SelectedModel] == 0 {
				delete(a.active, d.SelectedModel)
			}
		})
	}
	return d, release, nil
}
