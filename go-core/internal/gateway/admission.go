package gateway

import (
	"sync"

	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/decision"
)

// Admission owns this process's reservations. Selection and reservation share a
// lock so two simultaneous requests cannot both consume the last available slot.
type Admission struct {
	mu       sync.Mutex
	active   map[string]int
	sessions map[string]Session
}

func NewAdmission() *Admission {
	return &Admission{active: make(map[string]int), sessions: make(map[string]Session)}
}

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
	return a.SelectSession(in, "")
}

// AcquireModel rechecks a pinned fallback against current capacity and health.
// It cannot widen the original qualified fallback list supplied by the caller.
func (a *Admission) AcquireModel(in decision.Input, model string) (func(), bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	in.Runtime.Inflight = a.active
	d, e := decision.Decide(in)
	if e != nil {
		return nil, false
	}
	allowed := d.SelectedModel == model
	for _, id := range d.FallbackOrder {
		if id == model {
			allowed = true
		}
	}
	if !allowed {
		return nil, false
	}
	for _, m := range in.Models {
		if m.ID == model && in.Policy.LoadEnabled && m.Capacity > 0 && a.active[model] >= m.Capacity {
			return nil, false
		}
	}
	a.active[model]++
	var once sync.Once
	return func() {
		once.Do(func() {
			a.mu.Lock()
			defer a.mu.Unlock()
			a.active[model]--
			if a.active[model] == 0 {
				delete(a.active, model)
			}
		})
	}, true
}
func (a *Admission) SelectSession(in decision.Input, key string) (decision.Decision, func(), error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	in.Runtime.Inflight = a.active
	d, err := decision.Decide(in)
	if err != nil {
		return d, nil, err
	}
	if key != "" && in.Policy.SessionTTLMS > 0 {
		if current, ok := a.sessions[key]; ok {
			d.SelectedModel = ChooseSession(&current, in, d)
		}
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

// Record only complete client delivery, with bounded process-local state.
func (a *Admission) CompleteSession(key string, in decision.Input, d decision.Decision, now float64) {
	if key == "" || in.Policy.SessionTTLMS <= 0 || d.Shadow || d.RequestedModel != in.Policy.AutoModelID {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	for k, s := range a.sessions {
		if s.ExpiresAt <= now {
			delete(a.sessions, k)
		}
	}
	if len(a.sessions) >= 10000 {
		if _, exists := a.sessions[key]; !exists {
			return
		}
	}
	a.sessions[key] = Session{Model: d.SelectedModel, Task: in.Analysis.Task, Tier: in.Analysis.Tier, SubTask: in.Analysis.SubTask, ExpiresAt: now + in.Policy.SessionTTLMS}
}
