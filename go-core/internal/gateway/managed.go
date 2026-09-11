package gateway

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/auth"
	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/labnet"
	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/ledger"
	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/liveconfig"
	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/resilience"
	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/semantic"
)

type ManagedOptions struct {
	Gateway           Options
	Auth              auth.Config
	AuthFile          string
	RuntimeConfigFile string
	LedgerPath        string
	Audit             AuditOptions
}
type generationConfig struct {
	Auth   auth.Config `json:"auth"`
	Bundle Bundle      `json:"bundle"`
}
type generation struct {
	g        *Gateway
	revision string
	refs     int
	retired  bool
}

// Managed owns the one authoritative runtime and atomically publishes complete
// gateway generations. Existing requests retain their old credential/policy view.
type Managed struct {
	options       ManagedOptions
	mu            sync.Mutex
	reloadMu      sync.Mutex
	active        *generation
	all           map[*generation]bool
	closing       bool
	draining      bool
	workers       sync.WaitGroup
	state         *runtimeState
	store         *liveconfig.Store[generationConfig]
	zone          string
	budgetEnabled bool
}

func validateGeneration(raw []byte) (generationConfig, error) {
	var c generationConfig
	if decodeStrict(bytes.NewReader(raw), &c) != nil {
		return c, errors.New("invalid generation")
	}
	if _, e := auth.New(c.Auth); e != nil {
		return c, e
	}
	return c, c.Bundle.validate()
}
func (m *Managed) readConfig() (generationConfig, error) {
	c := generationConfig{Auth: m.options.Auth}
	if m.options.AuthFile != "" {
		c.Auth = auth.Config{}
		f, e := os.Open(m.options.AuthFile)
		if e != nil {
			return c, errors.New("credential configuration unavailable")
		}
		raw, e := io.ReadAll(io.LimitReader(f, 1<<20+1))
		f.Close()
		if e != nil || len(raw) > 1<<20 || decodeStrict(bytes.NewReader(raw), &c.Auth) != nil {
			return c, errors.New("invalid credential configuration")
		}
	}
	if m.options.RuntimeConfigFile != "" {
		f, e := os.Open(m.options.RuntimeConfigFile)
		if e != nil {
			return c, errors.New("runtime snapshot unavailable")
		}
		raw, e := io.ReadAll(io.LimitReader(f, MaxBodyBytes+1))
		f.Close()
		if e != nil || len(raw) > MaxBodyBytes || decodeStrict(bytes.NewReader(raw), &c.Bundle) != nil || c.Bundle.Features == nil {
			return c, errors.New("invalid native runtime snapshot")
		}
		return c, nil
	}
	u, e := LoopbackURL(m.options.Gateway.AssessorURL)
	if e != nil {
		return c, e
	}
	u.Path = "/runtime-config"
	client := labnet.Client(m.options.Gateway.AssessmentTimeout)
	defer client.CloseIdleConnections()
	req, _ := http.NewRequest("GET", u.String(), nil)
	req.Header.Set("Authorization", "Bearer "+m.options.Gateway.AssessorToken)
	req.Header.Set("X-AMR-Native-Features", "1")
	res, e := client.Do(req)
	if e != nil {
		return c, errors.New("runtime configuration unavailable")
	}
	defer res.Body.Close()
	raw, e := io.ReadAll(io.LimitReader(res.Body, MaxBodyBytes+1))
	if e != nil || res.StatusCode != 200 || len(raw) > MaxBodyBytes || decodeStrict(bytes.NewReader(raw), &c.Bundle) != nil {
		return c, errors.New("invalid runtime configuration")
	}
	return c, nil
}
func (m *Managed) build(c generationConfig) (*Gateway, error) {
	a, e := auth.New(c.Auth)
	if e != nil {
		return nil, e
	}
	o := m.options.Gateway
	o.NativeAnalysis = true
	o.Bundle = &c.Bundle
	o.Authenticator = a
	o.Shared = m.state
	o.RequestTimeout = time.Duration(c.Bundle.Runtime.RequestTimeoutMS) * time.Millisecond
	return New(o)
}
func NewManaged(o ManagedOptions) (*Managed, error) {
	if o.RuntimeConfigFile != "" {
		if _, err := os.Stat(o.RuntimeConfigFile + ".pending"); err == nil || !os.IsNotExist(err) {
			return nil, errors.New("unresolved snapshot publication; reconcile before restart")
		}
	}
	if o.LedgerPath == "" {
		return nil, errors.New("managed runtime requires a dedicated ledger path")
	}
	if o.Gateway.AssessmentTimeout <= 0 || o.Gateway.MaxRequests < 1 || o.Gateway.MaxRequests > 10000 {
		return nil, errors.New("invalid managed limits")
	}
	m := &Managed{options: o, all: map[*generation]bool{}}
	c, e := m.readConfig()
	if e != nil {
		return nil, e
	}
	raw, _ := json.Marshal(c)
	m.store, e = liveconfig.New(raw, validateGeneration)
	if e != nil {
		return nil, e
	}
	snapshot, e := m.store.Load()
	if e != nil {
		return nil, e
	}
	c = snapshot.Value
	m.zone = c.Bundle.Runtime.TimeZone
	m.budgetEnabled = c.Bundle.Runtime.BudgetEnabled
	if o.Gateway.NodeCostObservation && (m.budgetEnabled || o.Gateway.EdgeURL == "") {
		return nil, errors.New("Node cost observation requires trusted edge and disabled budget protection")
	}
	hasMarker, e := checkCostAuthority(o.LedgerPath, o.Gateway.NodeCostObservation)
	if e != nil {
		return nil, e
	}
	l, e := ledger.Open(o.LedgerPath, ledger.Options{TimeZone: m.zone, Observation: !m.budgetEnabled})
	if e != nil {
		return nil, errors.New("cost state unavailable (locked, corrupt, inaccessible, or storage mode mismatch; preserve existing files)")
	}
	if o.Gateway.NodeCostObservation && !hasMarker {
		if e = writeCostAuthority(o.LedgerPath); e != nil {
			l.Close()
			return nil, e
		}
	}
	audit, e := openAuditWithOptions(o.LedgerPath+".events.jsonl", o.Audit)
	if e != nil {
		l.Close()
		return nil, errors.New("audit journal unavailable")
	}
	m.state = &runtimeState{ledger: l, audit: audit, health: resilience.New(c.Bundle.Runtime.healthConfig()), admission: NewAdmission(), requests: make(chan struct{}, o.Gateway.MaxRequests), sessionSecret: make([]byte, 32), semanticGuard: semantic.NewGuard(o.Gateway.SemanticOptions.MaxConcurrent)}
	m.state.nodeCostObservation = o.Gateway.NodeCostObservation
	if _, e = rand.Read(m.state.sessionSecret); e != nil {
		audit.Close()
		l.Close()
		return nil, e
	}
	g, e := m.build(c)
	if e != nil {
		audit.Close()
		l.Close()
		return nil, e
	}
	m.active = &generation{g: g, revision: snapshot.Revision}
	m.all[m.active] = true
	return m, nil
}
func (m *Managed) Reload(expected string) (string, error) {
	m.reloadMu.Lock()
	defer m.reloadMu.Unlock()
	m.mu.Lock()
	if m.closing || m.draining {
		m.mu.Unlock()
		return "", errors.New("runtime closing")
	}
	current := m.active.revision
	m.mu.Unlock()
	if expected == "" || expected != current {
		return "", liveconfig.ErrConflict
	}
	c, e := m.readConfig()
	if e != nil {
		return "", e
	}
	if c.Bundle.Runtime.TimeZone != m.zone {
		return "", errors.New("billing time zone requires controlled restart")
	}
	if c.Bundle.Runtime.BudgetEnabled != m.budgetEnabled {
		return "", errors.New("budget protection mode requires controlled restart and a separate compatible state path")
	}
	raw, e := json.Marshal(c)
	if e != nil {
		return "", errors.New("invalid generation")
	}
	if _, e = validateGeneration(raw); e != nil {
		return "", e
	}
	g, e := m.build(c)
	if e != nil {
		return "", e
	}
	revision, e := m.store.Reload(raw, expected)
	if e != nil {
		g.Close()
		return "", e
	}
	m.mu.Lock()
	old := m.active
	old.retired = true
	next := &generation{g: g, revision: revision}
	m.active = next
	m.all[next] = true
	closeOld := old.refs == 0
	if closeOld {
		m.workers.Add(1)
	}
	m.mu.Unlock()
	if closeOld {
		m.retire(old)
	}
	return revision, nil
}
func (m *Managed) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	m.mu.Lock()
	if m.closing || m.draining {
		m.mu.Unlock()
		writeError(w, 503, "runtime_draining")
		return
	}
	gen := m.active
	gen.refs++
	m.workers.Add(1)
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		gen.refs--
		closeOld := gen.retired && gen.refs == 0
		if closeOld {
			m.workers.Add(1)
		}
		m.mu.Unlock()
		if closeOld {
			m.retire(gen)
		}
		m.workers.Done()
	}()
	w.Header().Set("X-AMR-Runtime-Revision", gen.revision)
	if r.URL.Path == "/internal/v1/probe/acquire" || r.URL.Path == "/internal/v1/probe/release" {
		if !gen.g.auth.AdminAuthorized(r.Header.Get("Authorization")) {
			writeError(w, 403, "admin_required")
			return
		}
		if r.Method != "POST" || r.URL.RawQuery != "" || gen.g.features == nil {
			writeError(w, 404, "not_found")
			return
		}
		var input struct {
			Model          string `json:"model"`
			TTLMS          int64  `json:"ttlMs"`
			ConfigRevision string `json:"configRevision"`
			Lease          string `json:"lease"`
		}
		if decodeStrict(http.MaxBytesReader(w, r.Body, 2048), &input) != nil {
			writeError(w, 400, "invalid_probe_request")
			return
		}
		defer r.Body.Close()
		lease := ""
		if r.URL.Path == "/internal/v1/probe/acquire" {
			if input.ConfigRevision != gen.g.options.Bundle.Revision {
				writeError(w, 409, "configuration_revision_conflict")
				return
			}
			capacity, ok := gen.g.features.ProbeCapacity(input.Model)
			if !ok || input.TTLMS <= 0 || input.TTLMS > 120000 {
				writeError(w, 400, "invalid_probe_request")
				return
			}
			lease, ok = m.state.admission.AcquireProbe(input.Model, capacity, time.Duration(input.TTLMS)*time.Millisecond)
			if !ok {
				writeError(w, 409, "probe_capacity_exhausted")
				return
			}
		} else {
			if len(input.Lease) != 64 {
				writeError(w, 400, "invalid_probe_lease")
				return
			}
			m.state.admission.ReleaseProbe(input.Lease)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(map[string]any{"revision": gen.revision, "configRevision": gen.g.options.Bundle.Revision, "lease": lease, "released": r.URL.Path == "/internal/v1/probe/release"})
		return
	}
	if r.URL.Path == "/internal/v1/status" {
		if !gen.g.auth.AdminAuthorized(r.Header.Get("Authorization")) {
			writeError(w, 403, "admin_required")
			return
		}
		if r.Method != "GET" || r.URL.RawQuery != "" {
			writeError(w, 404, "not_found")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		m.mu.Lock()
		backgroundReviews := 0
		for generation := range m.all {
			backgroundReviews += len(generation.g.backgroundSlots)
		}
		m.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"revision": gen.revision, "configRevision": gen.g.options.Bundle.Revision,
			"nodeCostObservation": m.state.nodeCostObservation,
			"activeRequests":      len(m.state.requests), "backgroundReviews": backgroundReviews,
			"health": m.state.health.States(), "inflight": m.state.admission.Snapshot(), "sessions": m.state.admission.SessionCount(float64(time.Now().UnixMilli())),
			"persistenceHealthy": !m.state.failed.Load(), "edgeErrors": m.state.edgeErrors.Load(), "edgeEnabled": gen.g.options.EdgeURL != ""})
		return
	}
	if r.URL.Path == "/internal/v1/runtime" && r.Method == "GET" && r.URL.RawQuery == "" {
		if !gen.g.auth.AdminAuthorized(r.Header.Get("Authorization")) {
			writeError(w, 403, "admin_required")
			return
		}
		w.Header().Set("X-AMR-Config-Revision", gen.g.options.Bundle.Revision)
		gen.g.runtimeStatus(w, m.generationDiagnostics())
		return
	}
	if r.URL.Path == "/internal/v1/config" || r.URL.Path == "/internal/v1/config/reload" {
		if !gen.g.auth.AdminAuthorized(r.Header.Get("Authorization")) {
			writeError(w, 403, "admin_required")
			return
		}
		if r.URL.RawQuery != "" {
			writeError(w, 404, "not_found")
			return
		}
		if r.Method == "GET" && r.URL.Path == "/internal/v1/config" {
			w.Header().Set("ETag", gen.revision)
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Cache-Control", "no-store")
			_ = json.NewEncoder(w).Encode(map[string]string{"revision": gen.revision, "configRevision": gen.g.options.Bundle.Revision})
			return
		}
		if r.Method == "POST" && r.URL.Path == "/internal/v1/config/reload" {
			if r.Header.Get("If-Match") == "" {
				writeError(w, 428, "configuration_revision_required")
				return
			}
			if r.Header.Get("If-Match") != gen.revision {
				writeError(w, 409, "configuration_revision_conflict")
				return
			}
			revision, e := m.Reload(r.Header.Get("If-Match"))
			if e != nil {
				if errors.Is(e, liveconfig.ErrConflict) {
					writeError(w, 409, "configuration_revision_conflict")
				} else {
					writeError(w, 422, "configuration_reload_rejected")
				}
				return
			}
			w.Header().Set("ETag", revision)
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Cache-Control", "no-store")
			_ = json.NewEncoder(w).Encode(map[string]string{"revision": revision})
			return
		}
		writeError(w, 404, "not_found")
		return
	}
	if r.URL.Path == "/health" && r.Method == "GET" {
		status := 200
		if m.state.failed.Load() {
			status = 503
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(map[string]any{"milestone": "m3", "productionReady": false, "persistenceHealthy": status == 200})
		return
	}
	gen.g.ServeHTTP(w, r)
}
func (m *Managed) retire(gen *generation) {
	// With no HTTP references left, no new review can enter this generation.
	// Preserve immediate disposal for the usual case without background work.
	if len(gen.g.backgroundSlots) == 0 {
		m.closeRetired(gen)
	} else {
		go m.closeRetired(gen)
	}
}

func (m *Managed) closeRetired(gen *generation) {
	defer m.workers.Done()
	ctx, cancel := context.WithTimeout(context.Background(), GracefulDrainTimeout)
	defer cancel()
	_ = gen.g.Drain(ctx)
	gen.g.Close()
	m.mu.Lock()
	delete(m.all, gen)
	m.mu.Unlock()
}

// Drain runs after the HTTP servers have stopped. Retired generations remain
// tracked until their background reviews finish, including across publication.
func (m *Managed) Drain(ctx context.Context) error {
	m.reloadMu.Lock()
	m.mu.Lock()
	m.draining = true
	generations := make([]*generation, 0, len(m.all))
	for gen := range m.all {
		generations = append(generations, gen)
	}
	m.mu.Unlock()
	m.reloadMu.Unlock()
	var result error
	for _, gen := range generations {
		if err := gen.g.Drain(ctx); err != nil {
			result = err
		}
	}
	return result
}

func (m *Managed) Close() {
	m.reloadMu.Lock()
	m.mu.Lock()
	if m.closing {
		m.mu.Unlock()
		m.reloadMu.Unlock()
		return
	}
	m.closing = true
	m.mu.Unlock()
	m.reloadMu.Unlock()
	m.workers.Wait()
	m.mu.Lock()
	generations := m.all
	m.all = map[*generation]bool{}
	m.mu.Unlock()
	for gen := range generations {
		gen.g.Close()
	}
	m.state.audit.Close()
	m.state.ledger.Close()
}
