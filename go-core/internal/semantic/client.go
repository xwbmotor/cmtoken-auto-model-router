package semantic

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"sync"
	"time"

	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/analysis"
	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/labnet"
)

type Options struct {
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
type Client struct {
	options      Options
	small, large *http.Client
	slots        chan struct{}
	mu           sync.Mutex
	state        Snapshot
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
			if _, e := labnet.URL(o.SmallURL); e != nil {
				return nil, e
			}
		}
		if o.Policy.Provider != "http-json" {
			if _, e := labnet.URL(o.LargeURL); e != nil {
				return nil, e
			}
			if len(o.LargeToken) < 16 {
				return nil, errors.New("laboratory semantic large token must be provided separately")
			}
		}
	}
	return &Client{options: o, small: labnet.Client(time.Duration(o.Policy.SmallTimeoutMS) * time.Millisecond), large: labnet.Client(time.Duration(o.Policy.LargeTimeoutMS) * time.Millisecond), slots: make(chan struct{}, o.MaxConcurrent)}, nil
}
func (c *Client) Close()         { c.small.CloseIdleConnections(); c.large.CloseIdleConnections() }
func (c *Client) Policy() Policy { return c.options.Policy }
func (c *Client) Snapshot() Snapshot {
	c.mu.Lock()
	defer c.mu.Unlock()
	s := c.state
	s.Active = len(c.slots)
	return s
}
func (c *Client) reserve(estimate float64) (func(*Usage), error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.state.LargeCalls >= c.options.MaxLargeCalls || c.state.ActualTokens+c.state.EstimatedTokens+c.state.PendingTokens+estimate > c.options.MaxLargeTokens {
		return nil, errors.New("semantic large-call budget exhausted")
	}
	c.state.LargeCalls++
	c.state.PendingTokens += estimate
	var once sync.Once
	return func(u *Usage) {
		once.Do(func() {
			c.mu.Lock()
			defer c.mu.Unlock()
			c.state.PendingTokens -= estimate
			if u == nil {
				c.state.EstimatedTokens += estimate
			} else {
				c.state.ActualTokens += u.Prompt + u.Completion
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
func (c *Client) largeCall(ctx context.Context, text string, prior *Assessment) (Assessment, error) {
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
	body := map[string]any{"model": c.options.Policy.LargeModel, "messages": []map[string]string{{"role": "user", "content": prompt}}, "temperature": 0, "max_tokens": c.options.Policy.MaxOutputTokens, "stream": false}
	if c.options.Policy.UseJSONMode {
		body["response_format"] = map[string]string{"type": "json_object"}
	}
	started := time.Now()
	data, e := post(ctx, c.large, c.options.LargeURL, c.options.LargeToken, body)
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
	if pok && qok && !math.IsNaN(p) && !math.IsNaN(q) && !math.IsInf(p, 0) && !math.IsInf(q, 0) && p >= 0 && q >= 0 && p <= 1e12 && q <= 1e12 {
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
	if !c.options.Policy.Enabled {
		return Assessment{}, errors.New("semantic provider disabled")
	}
	if e := ctx.Err(); e != nil {
		return Assessment{}, e
	}
	select {
	case c.slots <- struct{}{}:
		defer func() { <-c.slots }()
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
		return c.largeCall(ctx, text, nil)
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
	large, largeErr := c.largeCall(ctx, text, prior)
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
