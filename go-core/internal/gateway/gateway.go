// Package gateway is the loopback-only migration laboratory, not a production
// drop-in. It deliberately cannot dial a production MaaS endpoint in milestone 1.
package gateway

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"

	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/decision"
)

const MaxBodyBytes = 2 << 20

type Options struct {
	AssessorURL       string
	UpstreamURL       string
	AccessToken       string
	AssessorToken     string
	UpstreamToken     string
	AssessmentTimeout time.Duration
	RequestTimeout    time.Duration
	MaxRequests       int
}

type Gateway struct {
	options   Options
	assessor  *url.URL
	upstream  *url.URL
	client    *http.Client
	transport *http.Transport
	admission *Admission
	requests  chan struct{}
}

func LoopbackURL(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u == nil {
		return nil, errors.New("invalid endpoint")
	}
	ip := net.ParseIP(u.Hostname())
	if (u.Scheme != "http" && u.Scheme != "https") || ip == nil || !ip.IsLoopback() || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Port() == "" {
		return nil, errors.New("milestone 1 endpoints must use literal loopback IPs and explicit ports, without credentials/query/fragment")
	}
	return u, nil
}

func New(o Options) (*Gateway, error) {
	assessor, err := LoopbackURL(o.AssessorURL)
	if err != nil {
		return nil, err
	}
	upstream, err := LoopbackURL(o.UpstreamURL)
	if err != nil {
		return nil, err
	}
	if len(o.AccessToken) < 16 || len(o.AssessorToken) < 16 {
		return nil, errors.New("access and assessor tokens must each contain at least 16 characters")
	}
	if o.RequestTimeout <= 0 || o.AssessmentTimeout <= 0 || o.MaxRequests < 1 || o.MaxRequests > 10000 {
		return nil, errors.New("positive timeouts and bounded concurrency are required")
	}
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.Proxy = nil // Laboratory loopback traffic must never use an environment proxy.
	t.DialContext = (&net.Dialer{Timeout: 3 * time.Second, KeepAlive: 30 * time.Second}).DialContext
	t.MaxIdleConns = o.MaxRequests
	t.MaxIdleConnsPerHost = o.MaxRequests
	t.ResponseHeaderTimeout = o.RequestTimeout
	return &Gateway{options: o, assessor: assessor, upstream: upstream, transport: t,
		client:    &http.Client{Transport: t, Timeout: o.AssessmentTimeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
		admission: NewAdmission(), requests: make(chan struct{}, o.MaxRequests)}, nil
}

func (g *Gateway) Close() { g.transport.CloseIdleConnections() }

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
	w.Header().Set("X-AMR-Experimental", "go-core-m1")
	if r.Method == "GET" && r.URL.Path == "/health" {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "runtime": "go", "milestone": "m1", "productionReady": false})
		return
	}
	if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+g.options.AccessToken)) != 1 {
		writeError(w, http.StatusUnauthorized, "unauthorized")
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
	assessment, err := http.NewRequestWithContext(ctx, "POST", g.assessor.String(), bytes.NewReader(data))
	if err != nil {
		writeError(w, 500, "assessment_request_failed")
		return
	}
	assessment.Header.Set("Content-Type", "application/json")
	assessment.Header.Set("Authorization", "Bearer "+g.options.AssessorToken)
	response, err := g.client.Do(assessment)
	if err != nil {
		writeError(w, 502, "assessment_unavailable")
		return
	}
	inputBytes, err := io.ReadAll(io.LimitReader(response.Body, MaxBodyBytes+1))
	response.Body.Close()
	if response.StatusCode != 200 || err != nil || len(inputBytes) > MaxBodyBytes {
		writeError(w, 502, "assessment_failed")
		return
	}
	var input decision.Input
	if decodeStrict(bytes.NewReader(inputBytes), &input) != nil {
		writeError(w, 502, "invalid_assessment_contract")
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
	d, release, err := g.admission.Select(input)
	if err != nil {
		decisionError(w, err)
		return
	}
	defer release()
	if ctx.Err() != nil {
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
	proxy := &httputil.ReverseProxy{
		Transport: g.transport, FlushInterval: -1, ErrorLog: log.New(io.Discard, "", 0),
		Rewrite: func(p *httputil.ProxyRequest) {
			p.Out.URL = cloneURL(g.upstream)
			p.Out.Host = g.upstream.Host
			p.Out.Header = make(http.Header) // Never forward caller cookies or Authorization.
			p.Out.Header.Set("Content-Type", "application/json")
			if g.options.UpstreamToken != "" {
				p.Out.Header.Set("Authorization", "Bearer "+g.options.UpstreamToken)
			}
			p.Out.Body = io.NopCloser(bytes.NewReader(payload))
			p.Out.ContentLength = int64(len(payload))
			p.Out.GetBody = nil
			p.Out.TransferEncoding = nil
			p.Out.Trailer = nil
		},
		ModifyResponse: func(up *http.Response) error {
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
	proxy.ServeHTTP(w, r.WithContext(ctx))
}

func cloneURL(u *url.URL) *url.URL { v := *u; return &v }

func decisionError(w http.ResponseWriter, err error) {
	var de *decision.Error
	if errors.As(err, &de) {
		status := 422
		if de.Code == "model_capacity_exhausted" {
			status = 503
		}
		if de.Code == "invalid_contract" || de.Code == "unsupported_explicit_model" {
			status = 400
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
