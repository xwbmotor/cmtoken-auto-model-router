package semantic

import (
	"encoding/json"
	"errors"
	"math"
	"strconv"
	"strings"

	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/analysis"
	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/decision"
)

// Defaults are resolved by the existing configuration owner, then frozen at
// startup. Endpoint URLs and credentials are supplied separately by the lab.
type Policy struct {
	Enabled                bool    `json:"enabled"`
	Provider               string  `json:"provider"`
	Mode                   string  `json:"mode"`
	MinCharacters          int     `json:"minCharacters"`
	MaxInputCharacters     int     `json:"maxInputCharacters"`
	ConfidenceThreshold    float64 `json:"confidenceThreshold"`
	SmallAcceptThreshold   float64 `json:"smallAcceptThreshold"`
	FinalAdoptionThreshold float64 `json:"finalAdoptionThreshold"`
	ActiveTrafficPercent   float64 `json:"activeTrafficPercent"`
	SmallTimeoutMS         int     `json:"smallTimeoutMs"`
	LargeTimeoutMS         int     `json:"largeTimeoutMs"`
	MaxOutputTokens        int     `json:"maxOutputTokens"`
	LargeModel             string  `json:"largeModel"`
	UseJSONMode            bool    `json:"useJsonMode"`
}
type Usage struct {
	Prompt     float64 `json:"prompt"`
	Completion float64 `json:"completion"`
}
type Cascade struct {
	Level           string  `json:"level"`
	AcceptThreshold float64 `json:"acceptThreshold"`
	SmallLatencyMS  int64   `json:"smallLatencyMs"`
	LargeLatencyMS  *int64  `json:"largeLatencyMs"`
	TotalLatencyMS  int64   `json:"totalLatencyMs"`
}
type Assessment struct {
	Task          string   `json:"task"`
	Tier          string   `json:"tier"`
	Complexity    float64  `json:"complexity"`
	Confidence    float64  `json:"confidence"`
	Reason        string   `json:"reason"`
	Provider      string   `json:"provider,omitempty"`
	Model         string   `json:"model,omitempty"`
	LatencyMS     int64    `json:"latencyMs,omitempty"`
	Cascade       *Cascade `json:"cascade,omitempty"`
	OverheadUsage *Usage   `json:"overheadUsage,omitempty"`
}

func (p Policy) Validate() error {
	if !p.Enabled || p.Provider == "disabled" {
		return nil
	}
	if p.Provider != "http-json" && p.Provider != "openai-chat" && p.Provider != "cascade" {
		return errors.New("unsupported semantic provider")
	}
	if p.Mode != "shadow" && p.Mode != "active" {
		return errors.New("invalid semantic mode")
	}
	for _, v := range []float64{p.ConfidenceThreshold, p.SmallAcceptThreshold, p.FinalAdoptionThreshold} {
		if math.IsNaN(v) || math.IsInf(v, 0) || v < 0 || v > 1 {
			return errors.New("invalid semantic threshold")
		}
	}
	if math.IsNaN(p.ActiveTrafficPercent) || p.ActiveTrafficPercent < 0 || p.ActiveTrafficPercent > 100 || p.MinCharacters < 0 || p.MaxInputCharacters < 1 || p.MaxInputCharacters > 100000 || p.SmallTimeoutMS < 1 || p.SmallTimeoutMS > 60000 || p.LargeTimeoutMS < 1 || p.LargeTimeoutMS > 60000 || p.MaxOutputTokens < 1 || p.MaxOutputTokens > 10000 {
		return errors.New("invalid semantic limits")
	}
	if p.Provider != "http-json" && p.LargeModel == "" {
		return errors.New("missing semantic model")
	}
	return nil
}
func (p Policy) Eligible(base analysis.Result, raw []byte) bool {
	if !p.Enabled || p.Provider == "disabled" {
		return false
	}
	text, e := analysis.ClassifierText(raw)
	return e == nil && analysis.UTF16Length(strings.TrimSpace(text)) >= p.MinCharacters && base.Confidence < p.ConfidenceThreshold
}
func coerce(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case nil:
		return 0
	case bool:
		if x {
			return 1
		}
		return 0
	case string:
		if strings.TrimSpace(x) == "" {
			return 0
		}
		n, e := strconv.ParseFloat(strings.TrimSpace(x), 64)
		if e == nil {
			return n
		}
	case []any:
		if len(x) == 0 {
			return 0
		}
		if len(x) == 1 {
			return coerce(x[0])
		}
	}
	return math.NaN()
}
func Parse(content string) (Assessment, error) {
	raw := strings.TrimSpace(content)
	start, end := strings.Index(raw, "{"), strings.LastIndex(raw, "}")
	if start < 0 || end <= start {
		return Assessment{}, errors.New("semantic response has no JSON object")
	}
	var v map[string]any
	if json.Unmarshal([]byte(raw[start:end+1]), &v) != nil {
		return Assessment{}, errors.New("invalid semantic JSON")
	}
	task, _ := v["task"].(string)
	tier, _ := v["tier"].(string)
	if task != "default" && task != "coding" && task != "reasoning" && task != "creative" && task != "extraction" {
		return Assessment{}, errors.New("invalid semantic task")
	}
	if tier != "simple" && tier != "balanced" && tier != "complex" {
		return Assessment{}, errors.New("invalid semantic tier")
	}
	complexity, ok := v["complexity"]
	confidence, ok2 := v["confidence"]
	c, q := coerce(complexity), coerce(confidence)
	if !ok || !ok2 || math.IsNaN(c) || math.IsNaN(q) || c < 0 || c > 1 || q < 0 || q > 1 {
		return Assessment{}, errors.New("invalid semantic confidence or complexity")
	}
	reason, _ := v["reason"].(string)
	return Assessment{Task: task, Tier: tier, Complexity: decision.RoundNumber(c, 3), Confidence: decision.RoundNumber(q, 3), Reason: analysis.HeadText(reason, 240)}, nil
}
