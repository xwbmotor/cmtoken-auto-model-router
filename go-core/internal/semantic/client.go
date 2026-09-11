package semantic

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/analysis"
	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/labnet"
)

type Options struct {
	Candidate                                  bool
	RuntimeBudgetOnly                          bool
	Guard                                      *Guard
	Billing                                    func(model string, input, output float64) (func(*Usage), error)
	Policy                                     Policy
	SmallURL, LargeURL, SmallToken, LargeToken string
	MaxConcurrent                              int
	MaxLargeCalls                              int64
	MaxLargeTokens                             float64
}
type Snapshot struct {
	LargeCalls      int64   `json:"largeCalls"`
	ActualTokens    float64 `json:"actualTokens"`
	EstimatedTokens float64 `json:"estimatedTokens"`
	PendingTokens   float64 `json:"pendingTokens"`
	Active          int     `json:"active"`
}
type Guard struct {
	mu    sync.Mutex
	state Snapshot
	slots chan struct{}
}

func NewGuard(concurrent int) *Guard { return &Guard{slots: make(chan struct{}, concurrent)} }

type Client struct {
	options      Options
	small, large *http.Client
	guard        *Guard
}

func New(o Options) (*Client, error) {
	if e := o.Policy.Validate(); e != nil {
		return nil, e
	}
	if o.MaxConcurrent < 1 || o.MaxConcurrent > 1024 || o.MaxLargeCalls < 0 || o.MaxLargeCalls > 1000000 || math.IsNaN(o.MaxLargeTokens) || o.MaxLargeTokens < 0 || o.MaxLargeTokens > 1e12 {
		return nil, errors.New("invalid semantic guard limits")
	}
	if o.Policy.Enabled && o.Policy.Provider != "disabled" {
		if o.Policy.Provider != "openai-chat" {
			if _, e := labnet.Endpoint(o.SmallURL, o.Candidate); e != nil {
				return nil, e
			}
		}
		if o.Policy.Provider != "http-json" {
			if _, e := labnet.Endpoint(o.LargeURL, o.Candidate); e != nil {
				return nil, e
			}
			if !o.Candidate && len(o.LargeToken) < 16 {
				return nil, errors.New("laboratory semantic large token must be provided separately")
			}
		}
	}
	if o.Guard == nil {
		o.Guard = NewGuard(o.MaxConcurrent)
	}
	if cap(o.Guard.slots) != o.MaxConcurrent {
		return nil, errors.New("semantic concurrency cannot change within shared guard")
	}
	return &Client{options: o, small: labnet.Client(time.Duration(o.Policy.SmallTimeoutMS) * time.Millisecond), large: labnet.Client(time.Duration(o.Policy.LargeTimeoutMS) * time.Millisecond), guard: o.Guard}, nil
}
func (c *Client) Close()         { c.small.CloseIdleConnections(); c.large.CloseIdleConnections() }
func (c *Client) Policy() Policy { return c.options.Policy }
func (c *Client) Snapshot() Snapshot {
	c.guard.mu.Lock()
	defer c.guard.mu.Unlock()
	s := c.guard.state
	s.Active = len(c.guard.slots)
	return s
}
func (c *Client) reserve(estimate float64) (func(*Usage), error) {
	c.guard.mu.Lock()
	defer c.guard.mu.Unlock()
	if !c.options.RuntimeBudgetOnly && (c.guard.state.LargeCalls >= c.options.MaxLargeCalls || c.guard.state.ActualTokens+c.guard.state.EstimatedTokens+c.guard.state.PendingTokens+estimate > c.options.MaxLargeTokens) {
		return nil, errors.New("semantic large-call budget exhausted")
	}
	c.guard.state.LargeCalls++
	c.guard.state.PendingTokens += estimate
	var once sync.Once
	return func(u *Usage) {
		once.Do(func() {
			c.guard.mu.Lock()
			defer c.guard.mu.Unlock()
			c.guard.state.PendingTokens -= estimate
			if u == nil {
				c.guard.state.EstimatedTokens += estimate
			} else {
				c.guard.state.ActualTokens += u.Prompt + u.Completion
			}
		})
	}, nil
}
func post(ctx context.Context, client *http.Client, endpoint, token string, value any) ([]byte, error) {
	data, e := json.Marshal(value)
	if e != nil {
		return nil, e
	}
	req, e := http.NewRequestWithContext(ctx, "POST", endpoint, bytes.NewReader(data))
	if e != nil {
		return nil, errors.New("invalid semantic request")
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, e := client.Do(req)
	if e != nil {
		return nil, errors.New("semantic provider unavailable")
	}
	defer res.Body.Close()
	b, e := io.ReadAll(io.LimitReader(res.Body, (1<<20)+1))
	if e != nil || len(b) > 1<<20 {
		return nil, errors.New("semantic response unreadable or too large")
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, errors.New("semantic provider rejected request")
	}
	return b, nil
}
func (c *Client) smallCall(ctx context.Context, text string) (Assessment, error) {
	started := time.Now()
	data, e := post(ctx, c.small, c.options.SmallURL, c.options.SmallToken, map[string]string{"text": text})
	if e != nil {
		return Assessment{}, e
	}
	var wrapped string
	if json.Unmarshal(data, &wrapped) == nil {
		data = []byte(wrapped)
	}
	a, e := Parse(string(data))
	a.Provider = "http-json"
	a.LatencyMS = time.Since(started).Milliseconds()
	return a, e
}
func (c *Client) largeCall(ctx context.Context, text string, prior *Assessment, token string) (Assessment, error) {
	if e := ctx.Err(); e != nil {
		return Assessment{}, e
	}
	prompt := classificationPrompt(text, prior)
	// Process-local laboratory guard. With unknown usage retain the full input
	// character allowance plus output reservation; never report it as actual usage.
	estimate := float64(analysis.UTF16Length(prompt) + c.options.Policy.MaxOutputTokens)
	settle, e := c.reserve(estimate)
	if e != nil {
		return Assessment{}, e
	}
	var usage *Usage
	defer func() { settle(usage) }()
	if c.options.Billing != nil {
		bill, e := c.options.Billing(c.options.Policy.LargeModel, float64(analysis.UTF16Length(prompt)), float64(c.options.Policy.MaxOutputTokens))
		if e != nil {
			return Assessment{}, e
		}
		defer func() { bill(usage) }()
	}
	body := map[string]any{"model": c.options.Policy.LargeModel, "messages": []map[string]string{{"role": "user", "content": prompt}}, "temperature": 0, "max_tokens": c.options.Policy.MaxOutputTokens, "stream": false}
	if c.options.Policy.UseJSONMode {
		body["response_format"] = map[string]string{"type": "json_object"}
	}
	started := time.Now()
	data, e := post(ctx, c.large, c.options.LargeURL, token, body)
	if e != nil {
		return Assessment{}, e
	}
	var payload struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Usage map[string]any `json:"usage"`
	}
	if json.Unmarshal(data, &payload) != nil {
		return Assessment{}, errors.New("invalid semantic chat envelope")
	}
	p, pok := payload.Usage["prompt_tokens"].(float64)
	q, qok := payload.Usage["completion_tokens"].(float64)
	if pok && qok && !math.IsNaN(p) && !math.IsNaN(q) && !math.IsInf(p, 0) && !math.IsInf(q, 0) && p >= 0 && q >= 0 && p <= 1e12 && q <= 1e12 && math.Trunc(p) == p && math.Trunc(q) == q {
		usage = &Usage{Prompt: p, Completion: q}
	}
	if len(payload.Choices) == 0 {
		return Assessment{}, errors.New("semantic chat has no choices")
	}
	a, e := Parse(payload.Choices[0].Message.Content)
	a.Provider = "openai-chat"
	a.Model = c.options.Policy.LargeModel
	a.LatencyMS = time.Since(started).Milliseconds()
	a.OverheadUsage = usage
	return a, e
}
func (c *Client) Classify(ctx context.Context, raw []byte) (Assessment, error) {
	return c.ClassifyWithCredential(ctx, raw, "")
}

// ClassifyWithCredential uses the already-authorized upstream credential for
// candidate L3 calls. It is request-local, including asynchronous reviews;
// it never mutates shared options or falls back to a server credential. Lab
// clients retain their separate configured classifier credential contract.
func (c *Client) ClassifyWithCredential(ctx context.Context, raw []byte, upstreamToken string) (Assessment, error) {
	if !c.options.Policy.Enabled {
		return Assessment{}, errors.New("semantic provider disabled")
	}
	if e := ctx.Err(); e != nil {
		return Assessment{}, e
	}
	token := c.options.LargeToken
	if c.options.Candidate && c.options.Policy.Provider != "http-json" && c.options.Policy.Provider != "disabled" {
		if strings.TrimSpace(upstreamToken) == "" || strings.ContainsAny(upstreamToken, "\r\n") {
			return Assessment{}, errors.New("semantic upstream credential required")
		}
		token = upstreamToken
	}
	select {
	case c.guard.slots <- struct{}{}:
		defer func() { <-c.guard.slots }()
	default:
		return Assessment{}, errors.New("semantic concurrency exhausted")
	}
	text, e := analysis.ClassifierText(raw)
	if e != nil {
		return Assessment{}, e
	}
	text = analysis.TailText(text, c.options.Policy.MaxInputCharacters)
	switch c.options.Policy.Provider {
	case "http-json":
		return c.smallCall(ctx, text)
	case "openai-chat":
		return c.largeCall(ctx, text, nil, token)
	case "cascade":
	default:
		return Assessment{}, errors.New("semantic provider disabled")
	}
	started := time.Now()
	small, smallErr := c.smallCall(ctx, text)
	smallMS := time.Since(started).Milliseconds()
	if smallErr == nil && small.Confidence >= c.options.Policy.SmallAcceptThreshold {
		small.Cascade = &Cascade{Level: "small", AcceptThreshold: c.options.Policy.SmallAcceptThreshold, SmallLatencyMS: smallMS, TotalLatencyMS: smallMS}
		return small, nil
	}
	if e := ctx.Err(); e != nil {
		return Assessment{}, e
	}
	var prior *Assessment
	if smallErr == nil {
		prior = &small
	}
	largeStarted := time.Now()
	large, largeErr := c.largeCall(ctx, text, prior, token)
	largeMS := time.Since(largeStarted).Milliseconds()
	metadata := &Cascade{Level: "large", AcceptThreshold: c.options.Policy.SmallAcceptThreshold, SmallLatencyMS: smallMS, LargeLatencyMS: &largeMS, TotalLatencyMS: smallMS + largeMS}
	if largeErr != nil {
		if smallErr != nil {
			return Assessment{}, errors.New("both semantic providers failed")
		}
		metadata.Level = "small-degraded"
		small.Cascade = metadata
		small.LatencyMS = metadata.TotalLatencyMS
		return small, nil
	}
	large.Cascade = metadata
	return large, nil
}
