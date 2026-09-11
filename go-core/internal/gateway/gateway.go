// Package gateway is the loopback-only migration laboratory, not a production
// drop-in. It deliberately cannot dial a production MaaS endpoint in this laboratory.
package gateway

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"runtime/trace"
	"strings"
	"sync"
	"time"

	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/analysis"
	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/auth"
	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/decision"
	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/features"
	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/labnet"
	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/scope"
	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/semantic"
)

const MaxBodyBytes = 2 << 20

type Options struct {
	Candidate            bool
	Bundle               *Bundle
	Authenticator        *auth.Authenticator
	Shared               *runtimeState
	NativeSemantics      bool
	SemanticOptions      semantic.Options
	SemanticBucketSecret []byte
	ScopeURL             string
	ScopeTTL             time.Duration
	ScopeTimeout         time.Duration
	Tenants              []Tenant
	NativeAnalysis       bool
	AssessorURL          string
	UpstreamURL          string
	AccessToken          string
	AssessorToken        string
	UpstreamToken        string
	AssessmentTimeout    time.Duration
	RequestTimeout       time.Duration
	MaxRequests          int
}

type Gateway struct {
	runtime           *runtimeState
	auth              *auth.Authenticator
	semantic          *semantic.Client
	tenantScope       *scope.Cache
	background        context.Context
	cancelBackground  context.CancelFunc
	backgroundMu      sync.Mutex
	backgroundClosing bool
	backgroundWorkers sync.WaitGroup
	backgroundSlots   chan struct{}
	closeOnce         sync.Once
	reviewsMu         sync.Mutex
	reviews           []Review
	sessionSecret     []byte
	analyzer          *analysis.Analyzer
	features          *features.Builder
	options           Options
	assessor          *url.URL
	upstream          *url.URL
	client            *http.Client
	transport         *http.Transport
	admission         *Admission
	requests          chan struct{}
}

func LoopbackURL(raw string) (*url.URL, error) {
	return labnet.URL(raw)
}

func New(o Options) (*Gateway, error) {
	nativeFeatures := o.Bundle != nil && o.Bundle.Features != nil
	var assessor *url.URL
	var err error
	if !nativeFeatures {
		assessor, err = LoopbackURL(o.AssessorURL)
		if err != nil {
			return nil, err
		}
	} else if !o.NativeAnalysis {
		return nil, errors.New("native features require native analysis")
	}
	if o.Candidate && (!nativeFeatures || o.Authenticator == nil || o.Shared == nil) {
		return nil, errors.New("candidate requires managed native runtime and authentication")
	}
	upstream, err := labnet.Endpoint(o.UpstreamURL, o.Candidate)
	if err != nil {
		return nil, err
	}
	if (o.Authenticator == nil && len(o.AccessToken) < 16) || (!nativeFeatures && len(o.AssessorToken) < 16) {
		return nil, errors.New("access and assessor tokens must each contain at least 16 characters")
	}
	if o.RequestTimeout <= 0 || o.AssessmentTimeout <= 0 || o.MaxRequests < 1 || o.MaxRequests > 10000 {
		return nil, errors.New("positive timeouts and bounded concurrency are required")
	}
	if o.NativeSemantics && !o.NativeAnalysis {
		return nil, errors.New("native semantics requires native analysis")
	}
	if len(o.Tenants) > 256 {
		return nil, errors.New("too many laboratory tenants")
	}
	seen := map[string]bool{o.AccessToken: true}
	for _, tenant := range o.Tenants {
		if len(tenant.AccessToken) < 16 || len(tenant.UpstreamToken) < 16 || seen[tenant.AccessToken] {
			return nil, errors.New("invalid or duplicate laboratory tenant credentials")
		}
		seen[tenant.AccessToken] = true
	}
	o.Tenants = append([]Tenant{}, o.Tenants...)
	o.SemanticBucketSecret = append([]byte{}, o.SemanticBucketSecret...)
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.Proxy = nil // Laboratory loopback traffic must never use an environment proxy.
	t.DialContext = (&net.Dialer{Timeout: 3 * time.Second, KeepAlive: 30 * time.Second}).DialContext
	t.MaxIdleConns = o.MaxRequests
	t.MaxIdleConnsPerHost = o.MaxRequests
	t.ResponseHeaderTimeout = o.RequestTimeout
	g := &Gateway{options: o, assessor: assessor, upstream: upstream, transport: t,
		client:    &http.Client{Transport: t, Timeout: o.AssessmentTimeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
		admission: NewAdmission(), requests: make(chan struct{}, o.MaxRequests)}
	g.runtime, g.auth = o.Shared, o.Authenticator
	if g.runtime != nil {
		g.admission = g.runtime.admission
		g.requests = g.runtime.requests
	}
	g.background, g.cancelBackground = context.WithCancel(context.Background())
	g.backgroundSlots = make(chan struct{}, 8)
	g.sessionSecret = make([]byte, 32)
	if _, e := rand.Read(g.sessionSecret); e != nil {
		g.Close()
		return nil, e
	}
	if g.runtime != nil {
		g.sessionSecret = g.runtime.sessionSecret
	}
	if o.Bundle != nil {
		if e := o.Bundle.validate(); e != nil {
			g.Close()
			return nil, e
		}
		if nativeFeatures {
			g.features, err = features.New(*o.Bundle.Features)
			if err != nil {
				g.Close()
				return nil, err
			}
		}
	}
	if o.NativeAnalysis && o.Bundle != nil {
		g.analyzer, err = analysis.New(o.Bundle.Analysis)
		if err != nil {
			g.Close()
			return nil, err
		}
		if o.Bundle.Analysis.SemanticRequired && !o.NativeSemantics {
			g.Close()
			return nil, errors.New("active semantic configuration requires native semantics")
		}
	} else if o.NativeAnalysis {
		u := *assessor
		u.Path = "/analysis-config"
		req, _ := http.NewRequest("GET", u.String(), nil)
		req.Header.Set("Authorization", "Bearer "+o.AssessorToken)
		res, e := g.client.Do(req)
		if e != nil {
			g.Close()
			return nil, errors.New("analysis configuration unavailable")
		}
		data, e := io.ReadAll(io.LimitReader(res.Body, MaxBodyBytes+1))
		res.Body.Close()
		var c analysis.Config
		if e != nil || res.StatusCode != 200 || len(data) > MaxBodyBytes || json.Unmarshal(data, &c) != nil {
			g.Close()
			return nil, errors.New("invalid analysis configuration")
		}
		g.analyzer, e = analysis.New(c)
		if c.SemanticRequired && !o.NativeSemantics {
			g.Close()
			return nil, errors.New("active semantic configuration requires --native-semantics")
		}
		if e != nil {
			g.Close()
			return nil, e
		}
	}
	if o.NativeSemantics {
		var p semantic.Policy
		if o.Bundle != nil {
			p = o.Bundle.Semantic
		}
		if e := func() error {
			if o.Bundle != nil {
				return nil
			}
			return g.loadPolicy("/semantic-config", &p)
		}(); e != nil {
			g.Close()
			return nil, e
		}
		if p.Enabled && p.Mode == "active" && len(o.SemanticBucketSecret) < 32 {
			g.Close()
			return nil, errors.New("active semantic rollout requires a separate stable secret of at least 32 bytes")
		}
		if len(g.options.SemanticBucketSecret) == 0 {
			g.options.SemanticBucketSecret = append([]byte{}, g.sessionSecret...)
		}
		opts := o.SemanticOptions
		opts.Candidate = o.Candidate
		opts.Policy = p
		if g.runtime != nil {
			opts.Billing = g.semanticBilling
			opts.Guard = g.runtime.semanticGuard
		}
		g.semantic, err = semantic.New(opts)
		if err != nil {
			g.Close()
			return nil, err
		}
	}
	if o.ScopeURL != "" {
		g.tenantScope, err = scope.NewCandidate(o.ScopeURL, o.ScopeTTL, o.ScopeTimeout, o.Candidate)
		if err != nil {
			g.Close()
			return nil, err
		}
	}
	return g, nil
}

func (g *Gateway) Close() {
	g.closeOnce.Do(func() {
		g.backgroundMu.Lock()
		g.backgroundClosing = true
		if g.cancelBackground != nil {
			g.cancelBackground()
		}
		g.backgroundMu.Unlock()
		g.backgroundWorkers.Wait()
		if g.semantic != nil {
			g.semantic.Close()
		}
		if g.tenantScope != nil {
			g.tenantScope.Close()
		}
		g.transport.CloseIdleConnections()
	})
}

func writeError(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"code": code, "message": code, "type": "migration_lab_error"}})
}

func decodeStrict(r io.Reader, target any) error {
	d := json.NewDecoder(r)
	d.DisallowUnknownFields()
	if err := d.Decode(target); err != nil {
		return err
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return errors.New("exactly one JSON value is required")
	}
	return nil
}

func (g *Gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-AMR-Experimental", "go-core-m2b")
	if g.runtime != nil {
		w.Header().Set("X-AMR-Experimental", "go-core-m3")
	}
	if r.Method == "GET" && r.URL.Path == "/health" {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "runtime": "go", "milestone": "m2b", "productionReady": false})
		return
	}
	if g.runtime != nil {
		w.Header().Set("X-AMR-Config-Revision", g.options.Bundle.Revision)
		if r.URL.Path == "/internal/v1/runtime" || r.URL.Path == "/internal/v1/decide" {
			if !g.auth.AdminAuthorized(r.Header.Get("Authorization")) {
				writeError(w, 403, "admin_required")
				return
			}
			if r.Method == "GET" && r.URL.Path == "/internal/v1/runtime" && r.URL.RawQuery == "" {
				g.runtimeStatus(w)
				return
			}
		}
		if g.runtime.failed.Load() {
			writeError(w, 503, "runtime_persistence_unavailable")
			return
		}
	}
	upstreamToken, authorized := g.authorize(r.Header.Get("Authorization"))
	if g.runtime != nil && r.URL.Path == "/internal/v1/decide" && g.auth.AdminAuthorized(r.Header.Get("Authorization")) {
		authorized = true
	}
	if !authorized {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if r.Method == "GET" && r.URL.Path == "/internal/v1/runtime" && r.URL.RawQuery == "" {
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+g.options.AccessToken)) != 1 {
			writeError(w, 403, "admin_required")
			return
		}
		g.runtimeStatus(w)
		return
	}
	if r.Method != "POST" || (r.URL.Path != "/v1/chat/completions" && r.URL.Path != "/internal/v1/decide") || r.URL.RawQuery != "" {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	select {
	case g.requests <- struct{}{}:
		defer func() { <-g.requests }()
	default:
		writeError(w, 503, "gateway_capacity_exhausted")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, MaxBodyBytes)
	defer r.Body.Close()
	if r.URL.Path == "/internal/v1/decide" {
		var input decision.Input
		if err := decodeStrict(r.Body, &input); err != nil {
			writeError(w, 400, "invalid_contract")
			return
		}
		d, err := decision.Decide(input)
		if err != nil {
			decisionError(w, err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(d)
		return
	}
	defer trace.StartRegion(r.Context(), "gateway.request").End()
	ctx, cancel := context.WithTimeout(r.Context(), g.options.RequestTimeout)
	defer cancel()
	data, err := io.ReadAll(r.Body)
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(w, 413, "request_too_large")
		} else {
			writeError(w, 400, "invalid_request_body")
		}
		return
	}
	var body map[string]json.RawMessage
	if json.Unmarshal(data, &body) != nil || body == nil {
		writeError(w, 400, "invalid_json")
		return
	}
	var requested string
	if raw := body["model"]; len(raw) > 0 && json.Unmarshal(raw, &requested) != nil {
		writeError(w, 400, "invalid_model")
		return
	}
	var messages []json.RawMessage
	if json.Unmarshal(body["messages"], &messages) != nil || len(messages) == 0 {
		writeError(w, 400, "invalid_messages")
		return
	}
	if raw, present := body["stream"]; present {
		var stream bool
		if json.Unmarshal(raw, &stream) != nil || bytes.Equal(raw, []byte("null")) {
			writeError(w, 400, "invalid_stream")
			return
		}
	}
	var native *analysis.Result
	if g.analyzer != nil {
		region := trace.StartRegion(ctx, "gateway.analysis")
		result, e := g.analyzer.Analyze(data)
		region.End()
		if e != nil {
			writeError(w, 400, "invalid_analysis_request")
			return
		}
		native = &result
	}
	assessmentRegion := trace.StartRegion(ctx, "gateway.assess")
	input, err := g.assess(ctx, data, native)
	assessmentRegion.End()
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			writeError(w, 504, "request_timeout")
			return
		}
		writeError(w, 502, err.Error())
		return
	}
	// The private adapter must not change the client's Auto identity.
	if requested == "" {
		requested = input.Policy.AutoModelID
	}
	if requested != input.RequestedModel {
		writeError(w, 502, "assessment_identity_mismatch")
		return
	}
	if g.tenantScope != nil {
		input = applyScope(input, g.tenantScope.Resolve(ctx, upstreamToken))
	}
	if ctx.Err() != nil {
		if ctx.Err() == context.DeadlineExceeded {
			writeError(w, 504, "request_timeout")
		}
		return
	}
	if g.runtime != nil {
		input.Runtime.Health = g.runtime.health.Snapshot()
		input.Runtime.NowMs = float64(time.Now().UnixMilli())
	}
	if g.semantic != nil && native != nil && requested == input.Policy.AutoModelID {
		input, err = g.reviewInput(ctx, r, w, data, *native, input, upstreamToken)
		if err != nil {
			decisionError(w, err)
			return
		}
	}
	if ctx.Err() != nil {
		if ctx.Err() == context.DeadlineExceeded {
			writeError(w, 504, "request_timeout")
		}
		return
	}
	sessionKey := SessionKey(r.Header.Get("X-Session-ID"), r.Header.Get("Authorization"), g.upstream.String(), g.sessionSecret)
	if g.runtime != nil {
		g.forwardRuntime(w, r, body, input, *native, sessionKey, upstreamToken)
		return
	}
	d, release, err := g.admission.SelectSession(input, sessionKey)
	if err != nil {
		decisionError(w, err)
		return
	}
	defer release()
	if ctx.Err() != nil {
		if ctx.Err() == context.DeadlineExceeded {
			writeError(w, 504, "request_timeout")
		}
		return
	}
	body["model"], _ = json.Marshal(d.SelectedModel)
	if err = applyReasoning(body, input, d); err != nil {
		writeError(w, 502, "unsupported_reasoning_parameter")
		return
	}
	payload, err := json.Marshal(body)
	if err != nil {
		writeError(w, 400, "invalid_json")
		return
	}
	w.Header().Set("X-AMR-Selected-Model", d.SelectedModel)
	var completion *completionBody
	upstreamOK := false
	proxy := &httputil.ReverseProxy{
		Transport: g.transport, FlushInterval: -1, ErrorLog: log.New(io.Discard, "", 0),
		Rewrite: func(p *httputil.ProxyRequest) {
			p.Out.URL = cloneURL(g.upstream)
			p.Out.Host = g.upstream.Host
			p.Out.Header = make(http.Header) // Never forward caller cookies or Authorization.
			p.Out.Header.Set("Content-Type", "application/json")
			if upstreamToken != "" {
				p.Out.Header.Set("Authorization", "Bearer "+upstreamToken)
			}
			p.Out.Body = io.NopCloser(bytes.NewReader(payload))
			p.Out.ContentLength = int64(len(payload))
			p.Out.GetBody = nil
			p.Out.TransferEncoding = nil
			p.Out.Trailer = nil
		},
		ModifyResponse: func(up *http.Response) error {
			upstreamOK = up.StatusCode >= 200 && up.StatusCode < 300
			completion = &completionBody{ReadCloser: up.Body, stream: strings.HasPrefix(up.Header.Get("Content-Type"), "text/event-stream")}
			up.Body = completion
			// A fixed endpoint cannot redirect requests or set browser credentials.
			if up.StatusCode >= 300 && up.StatusCode < 400 {
				return errors.New("upstream redirect rejected")
			}
			header := make(http.Header)
			for _, key := range []string{"Content-Type", "Cache-Control", "Retry-After"} {
				for _, value := range up.Header.Values(key) {
					header.Add(key, value)
				}
			}
			up.Header = header
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) {
			if ctx.Err() == context.DeadlineExceeded {
				writeError(w, 504, "upstream_timeout")
			} else {
				writeError(w, 502, "upstream_unavailable")
			}
		},
	}
	delivery := &deliveryWriter{ResponseWriter: w}
	proxy.ServeHTTP(delivery, r.WithContext(ctx))
	if ctx.Err() == nil && !delivery.failed && upstreamOK && completion != nil && completion.Complete() {
		g.admission.CompleteSession(sessionKey, input, d, float64(time.Now().UnixMilli()))
	}
}

func cloneURL(u *url.URL) *url.URL { v := *u; return &v }

func decisionError(w http.ResponseWriter, err error) {
	var de *decision.Error
	if errors.As(err, &de) {
		status := 422
		if de.Code == "model_capacity_exhausted" {
			status = 503
		}
		if de.Code == "invalid_contract" || de.Code == "unsupported_explicit_model" || de.Code == "invalid_model" || de.Code == "context_length_exceeded" || de.Code == "unsupported_capability" || de.Code == "completion_budget_too_low" {
			status = 400
		}
		if de.Code == "not_entitled" {
			status = 403
		}
		writeError(w, status, de.Code)
		return
	}
	writeError(w, 500, "decision_failed")
}

func applyReasoning(body map[string]json.RawMessage, in decision.Input, d decision.Decision) error {
	if !in.Policy.ReasoningEnabled {
		return nil
	}
	for _, m := range in.Models {
		if m.ID != d.SelectedModel || !m.ReasoningVerified {
			continue
		}
		parts := strings.Split(m.ReasoningParameter, ".")
		if len(parts) < 1 || len(parts) > 2 {
			return errors.New("unsupported path")
		}
		// Match supported transport parameters; never let configuration rewrite model/messages/auth.
		if m.ReasoningParameter != "reasoning_effort" && m.ReasoningParameter != "chat_template_kwargs.enable_thinking" && m.ReasoningParameter != "thinking.type" && m.ReasoningParameter != "reasoning.enabled" {
			return errors.New("unsupported reasoning parameter")
		}
		value := m.ReasoningValues[d.ReasoningLevel]
		if value == nil {
			value = m.ReasoningValues["standard"]
		}
		if value == nil {
			return nil
		}
		encoded, err := json.Marshal(value)
		if err != nil {
			return err
		}
		if len(parts) == 1 {
			if _, exists := body[parts[0]]; !exists {
				body[parts[0]] = encoded
			}
			return nil
		}
		nested := make(map[string]json.RawMessage)
		if raw, exists := body[parts[0]]; exists {
			if json.Unmarshal(raw, &nested) != nil || nested == nil {
				return errors.New("invalid reasoning object")
			}
		}
		if _, exists := nested[parts[1]]; exists {
			return nil
		}
		nested[parts[1]] = encoded
		body[parts[0]], err = json.Marshal(nested)
		return err
	}
	return nil
}
