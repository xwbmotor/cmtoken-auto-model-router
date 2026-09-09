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
