package gateway

import (
	"encoding/json"
	"math"

	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/decision"
)

// Prices are yuan per million tokens; the ledger stores integer micro-yuan.
type Price struct {
	Input       *float64 `json:"input"`
	Output      *float64 `json:"output"`
	InputCached *float64 `json:"inputCached"`
	Reasoning   *float64 `json:"reasoning"`
}
type tokenUsage struct{ Prompt, Completion, Cached float64 }

func validNumber(n float64) bool { return !math.IsNaN(n) && !math.IsInf(n, 0) && n >= 0 && n <= 1e12 }
func (p Price) valid() bool {
	for _, v := range []*float64{p.Input, p.Output, p.InputCached, p.Reasoning} {
		if v != nil && (!validNumber(*v) || *v > 1e6) {
			return false
		}
	}
	return true
}
func moneyMicros(v float64) *int64 {
	if !validNumber(v) || v > 9e9 {
		return nil
	}
	n := int64(math.Round(decision.RoundNumber(v, 6) * 1e6))
	return &n
}
func (p Price) estimate(input, output float64, level string, cache float64) *int64 {
	if p.Input == nil || p.Output == nil || !validNumber(input) || !validNumber(output) {
		return nil
	}
	cache = math.Max(0, math.Min(1, cache))
	cached, reasoning := *p.Input, *p.Output
	if p.InputCached != nil {
		cached = *p.InputCached
	}
	if p.Reasoning != nil {
		reasoning = *p.Reasoning
	}
	ratio := 0.0
	if level == "high" {
		ratio = .5
	} else if level == "standard" {
		ratio = .15
	}
	return moneyMicros((input*(*p.Input*(1-cache)+cached*cache) + output*(*p.Output) + output*ratio*reasoning) / 1e6)
}
func (p Price) actual(u *tokenUsage) *int64 {
	if u == nil || p.Input == nil || p.Output == nil {
		return nil
	}
	if !validNumber(u.Prompt) || !validNumber(u.Completion) || !validNumber(u.Cached) || math.Trunc(u.Prompt) != u.Prompt || math.Trunc(u.Completion) != u.Completion || math.Trunc(u.Cached) != u.Cached || u.Cached > u.Prompt {
		return nil
	}
	cached := *p.Input
	if p.InputCached != nil {
		cached = *p.InputCached
	}
	// completion_tokens already includes reasoning tokens, matching the Node ledger.
	return moneyMicros(((u.Prompt-u.Cached)*(*p.Input) + u.Cached*cached + u.Completion*(*p.Output)) / 1e6)
}
func parseUsage(data []byte) *tokenUsage {
	var envelope struct {
		Usage map[string]json.RawMessage `json:"usage"`
	}
	if json.Unmarshal(data, &envelope) != nil || envelope.Usage == nil {
		return nil
	}
	number := func(raw json.RawMessage) (float64, bool) {
		var n float64
		if len(raw) == 0 || string(raw) == "null" || json.Unmarshal(raw, &n) != nil || !validNumber(n) || math.Trunc(n) != n {
			return 0, false
		}
		return n, true
	}
	p, ok := number(envelope.Usage["prompt_tokens"])
	if !ok {
		return nil
	}
	c, ok := number(envelope.Usage["completion_tokens"])
	if !ok {
		return nil
	}
	cached := 0.0
	if raw := envelope.Usage["prompt_tokens_details"]; len(raw) > 0 && string(raw) != "null" {
		var details map[string]json.RawMessage
		if json.Unmarshal(raw, &details) != nil {
			return nil
		}
		if v, present := details["cached_tokens"]; present {
			cached, ok = number(v)
			if !ok || cached > p {
				return nil
			}
		}
	}
	return &tokenUsage{p, c, cached}
}
