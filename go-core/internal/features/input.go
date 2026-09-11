package features

import (
	"encoding/json"
	"errors"
	"maps"
	"strings"

	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/analysis"
	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/decision"
)

// Input uses a caller-supplied clock and traffic bucket, making replay exact and
// keeping runtime health, tenant scope, budget and load outside configuration.
type requestHeader struct {
	Model               any `json:"model"`
	MaxCompletionTokens any `json:"max_completion_tokens"`
	MaxTokens           any `json:"max_tokens"`
	ChatTemplateKwargs  any `json:"chat_template_kwargs"`
}

func (b *Builder) Input(raw []byte, a analysis.Result, now, bucket float64) (decision.Input, error) {
	var header requestHeader
	if json.Unmarshal(raw, &header) != nil {
		return decision.Input{}, errors.New("invalid feature request")
	}
	return b.input(header, a, now, bucket)
}

// InputFields reuses an already validated request envelope. Large message/tool
// values are irrelevant to these header features and need not be parsed again.
func (b *Builder) InputFields(rawRequest []byte, fields map[string]json.RawMessage, a analysis.Result, now, bucket float64) (decision.Input, error) {
	// Preserve the existing decoder's case-insensitive matching and input order
	// when unusual header spellings are present. The common exact-key path can
	// reuse the envelope without scanning unrelated message content.
	for key := range fields {
		for _, expected := range []string{"model", "max_completion_tokens", "max_tokens", "chat_template_kwargs"} {
			if key != expected && strings.EqualFold(key, expected) {
				return b.Input(rawRequest, a, now, bucket)
			}
		}
	}
	var header requestHeader
	for _, field := range []struct {
		key   string
		value *any
	}{
		{"model", &header.Model}, {"max_completion_tokens", &header.MaxCompletionTokens},
		{"max_tokens", &header.MaxTokens}, {"chat_template_kwargs", &header.ChatTemplateKwargs},
	} {
		if raw, exists := fields[field.key]; exists && json.Unmarshal(raw, field.value) != nil {
			return decision.Input{}, errors.New("invalid feature request")
		}
	}
	return b.input(header, a, now, bucket)
}

func (b *Builder) input(header requestHeader, a analysis.Result, now, bucket float64) (decision.Input, error) {
	var in decision.Input
	model := or(header.Model, b.policy.AutoModelID)
	requested, ok := model.(string)
	if !ok {
		return in, errors.New("invalid requested model")
	}
	completion := number(or(header.MaxCompletionTokens, or(header.MaxTokens, 0.0)))
	if !finite(completion) || !finite(now) || now <= 0 || !finite(bucket) || bucket < 0 || bucket >= 100 {
		return in, errors.New("invalid request feature numbers")
	}
	relative, ok := b.relative[a.Tier]
	if !ok || a.Task == "" {
		return in, errors.New("invalid feature analysis")
	}
	thinking, specified := object(header.ChatTemplateKwargs)["enable_thinking"]
	in = decision.Input{SchemaVersion: 1, ConfigVersion: b.version, RequestedModel: requested, CompletionTokens: completion,
		ThinkingSpecified: specified, ThinkingOff: falseValue(thinking), Policy: b.policy,
		Analysis: decision.Analysis{Task: a.Task, Tier: a.Tier, Complexity: a.Complexity, EstimatedContextTokens: a.EstimatedContextTokens, Requirements: maps.Clone(a.Requirements)},
		Runtime:  decision.Runtime{NowMs: now, TrafficBucket: bucket, Health: map[string]decision.Health{}, Inflight: map[string]int{}, MarketAdjustments: map[string]float64{}},
		Models:   make([]decision.Model, len(b.models))}
	if in.Analysis.Requirements == nil {
		in.Analysis.Requirements = map[string]bool{}
	}
	if a.SubTask != nil {
		in.Analysis.SubTask = *a.SubTask
	}
	in.Policy.RelativeQualityCap = relative
	if pref, ok := b.preferences[a.Task]; ok {
		in.Policy.Preference = &pref
	}
	for i, mc := range b.models {
		m := mc.base
		m.Capabilities = maps.Clone(mc.base.Capabilities)
		m.ReasoningValues = cloneJSON(mc.base.ReasoningValues).(map[string]any)
		if q, ok := mc.quality[a.Task]; ok {
			m.Quality = q
		}
		if sub, ok := mc.subtasks[in.Analysis.SubTask]; ok {
			m.Subscore = &sub
		}
		in.Models[i] = m
		in.Runtime.Health[m.ID] = decision.Health{}
		in.Runtime.Inflight[m.ID] = 0
		in.Runtime.MarketAdjustments[m.ID] = 0
	}
	return in, nil
}
