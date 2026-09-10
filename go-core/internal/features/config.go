// Package features resolves the per-request Node decisionInput contract in Go.
// Configuration is compiled once per immutable runtime generation. The control
// plane still validates router.json and derives pool-wide cost indexes.
package features

import (
	"encoding/json"
	"errors"
	"math"
	"strconv"
	"strings"

	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/decision"
)

// Config is the versioned, credential-free projection of validated router config.
// Numeric fields retain their JSON types so missing/null, zero and numeric strings
// follow the Node contract rather than Go's implicit zero-value defaults.
type Config struct {
	SchemaVersion    int              `json:"schemaVersion"`
	Version          string           `json:"version"`
	Routing          map[string]any   `json:"routing"`
	Models           []map[string]any `json:"models"`
	Budget           map[string]any   `json:"budget"`
	ReasoningControl map[string]any   `json:"reasoningControl"`
}

type modelConfig struct {
	base     decision.Model
	quality  map[string]float64
	subtasks map[string]decision.Subscore
}

// Builder has no request state and can be shared by concurrent requests. It owns
// its compiled maps; neither the source config nor returned inputs can mutate it.
type Builder struct {
	version     string
	policy      decision.Policy
	relative    map[string]float64
	preferences map[string]decision.Preference
	models      []modelConfig
}

func object(v any) map[string]any { m, _ := v.(map[string]any); return m }
func stringValue(v any) string    { s, _ := v.(string); return s }
func trueValue(v any) bool        { b, ok := v.(bool); return ok && b }
func falseValue(v any) bool       { b, ok := v.(bool); return ok && !b }
func truth(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case float64:
		return x != 0 && !math.IsNaN(x)
	default:
		return true
	}
}
func or(v, fallback any) any {
	if truth(v) {
		return v
	}
	return fallback
}
func coalesce(v, fallback any) any {
	if v != nil {
		return v
	}
	return fallback
}

// Only the JSON subset of JavaScript Number is needed. Arrays use JS's comma
// joined primitive conversion (not Number(element), which differs for booleans).
func number(v any) float64 {
	switch x := v.(type) {
	case nil:
		return 0
	case float64:
		return x
	case json.Number:
		return number(string(x))
	case bool:
		if x {
			return 1
		}
		return 0
	case string:
		x = strings.TrimFunc(x, func(r rune) bool {
			return strings.ContainsRune("\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff", r)
		})
		if x == "" {
			return 0
		}
		if len(x) > 2 && x[0] == '0' {
			base := 0
			switch x[1] {
			case 'x', 'X':
				base = 16
			case 'b', 'B':
				base = 2
			case 'o', 'O':
				base = 8
			}
			if base != 0 {
				n, e := strconv.ParseUint(x[2:], base, 64)
				if e == nil {
					return float64(n)
				}
				return math.NaN()
			}
		}
		// strconv accepts hexadecimal floats and underscores; ECMAScript does not.
		if strings.ContainsAny(x, "_pPxX") {
			return math.NaN()
		}
		n, e := strconv.ParseFloat(x, 64)
		if e == nil {
			return n
		}
	case []any:
		parts := make([]string, len(x))
		for i, item := range x {
			parts[i] = arrayString(item)
		}
		return number(strings.Join(parts, ","))
	}
	return math.NaN()
}
func arrayString(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case bool:
		return strconv.FormatBool(x)
	case float64:
		return strconv.FormatFloat(x, 'g', -1, 64)
	case []any:
		parts := make([]string, len(x))
		for i, v := range x {
			parts[i] = arrayString(v)
		}
		return strings.Join(parts, ",")
	default:
		return "[object Object]"
	}
}
func finite(n float64) bool { return !math.IsNaN(n) && !math.IsInf(n, 0) && math.Abs(n) <= 1e15 }

func New(c Config) (*Builder, error) {
	if c.SchemaVersion != 1 || c.Version == "" || c.Routing == nil || len(c.Models) == 0 || len(c.Models) > 1024 {
		return nil, errors.New("invalid feature configuration")
	}
	var invalid bool
	n := func(v, fallback any) float64 {
		x := number(coalesce(v, fallback))
		if !finite(x) {
			invalid = true
		}
		return x
	}
	r, reasoning := c.Routing, c.ReasoningControl
	live, load := object(r["livePenalty"]), object(r["loadBalancing"])
	b := &Builder{version: c.Version, relative: map[string]float64{}, preferences: map[string]decision.Preference{}}
	b.policy = decision.Policy{
		AllowExplicitModel: trueValue(r["allowExplicitModel"]), SessionTTLMS: n(r["sessionStickinessTtlMs"], 0.0), SessionMaxGap: n(r["sessionStickinessMaxGap"], .05),
		ScoreStrategy: stringValue(or(r["scoreStrategy"], "weighted")), Mode: stringValue(r["mode"]), ShadowModel: stringValue(or(r["shadowModel"], "")), AutoModelID: stringValue(or(r["autoModelId"], "auto")),
		ActiveTrafficPercent: n(r["activeTrafficPercent"], 100.0), QualityFloor: n(r["qualityFloor"], math.NaN()),
		QualityWeight: n(r["qualityWeight"], math.NaN()), CostWeight: n(r["costWeight"], math.NaN()), ProviderCostWeight: n(r["providerCostWeight"], 0.0),
		LatencyWeight: n(r["latencyWeight"], math.NaN()), PreferSelfHosted: truth(r["preferSelfHosted"]), SelfHostedBonus: n(r["selfHostedBonus"], math.NaN()),
		UncertaintyPenalty: n(r["uncertaintyPenalty"], math.NaN()), ComplexQualityMargin: n(r["complexQualityMargin"], 0.0),
		AllowQualityDegradation: trueValue(r["allowQualityDegradation"]), CostTier: stringValue(or(r["costTier"], "custom")),
		SubtaskSmoothK: n(r["subtaskSmoothK"], 32.0), SubtaskMinSamples: n(r["subtaskMinSamples"], 4.0), SubtaskMaxAdjust: n(r["subtaskMaxAdjust"], .06),
		LatencyScaleMs: n(live["latencyScaleMs"], 300000.0), LatencyMax: n(live["latencyMax"], .2), ErrorStep: n(live["errorStep"], .08), ErrorMax: n(live["errorMax"], .3),
		BudgetCostMultiplier: n(r["budgetCostMultiplier"], 2.0), BudgetDegradeThreshold: n(c.Budget["degradeThreshold"], .9),
		LoadEnabled: trueValue(load["enabled"]), LoadPenaltyWeight: n(load["penaltyWeight"], .2),
		ReasoningEnabled: trueValue(reasoning["enabled"]), ReasoningHighMin: n(reasoning["highMinComplexity"], .78), ReasoningOffMax: n(reasoning["offMaxComplexity"], .3),
	}
	for tier, fallback := range map[string]float64{"simple": .08, "balanced": .04, "complex": .02} {
		v := r["relQualityCap"]
		switch v.(type) {
		case float64, string:
		default:
			v = object(v)[tier]
		}
		b.relative[tier] = n(v, fallback)
		if b.relative[tier] < 0 || b.relative[tier] > 1 {
			invalid = true
		}
	}
	for task, value := range object(r["taskPreferences"]) {
		p := object(value)
		if truth(p["model"]) {
			pref := decision.Preference{Model: stringValue(p["model"]), Tolerance: n(p["tolerance"], .02)}
			if pref.Model == "" || pref.Tolerance < 0 {
				invalid = true
			}
			b.preferences[task] = pref
		}
	}
	limits := object(load["limits"])
	for _, m := range c.Models {
		if truth(m["capabilities"]) && object(m["capabilities"]) == nil {
			return nil, errors.New("invalid feature capabilities")
		}
		control := object(m["reasoningControl"])
		values := object(control["values"])
		mc := modelConfig{quality: map[string]float64{}, subtasks: map[string]decision.Subscore{}}
		mc.base = decision.Model{
			ID: stringValue(m["id"]), Enabled: truth(m["enabled"]), Ownership: stringValue(or(m["ownership"], "")),
			ContextWindow: n(m["contextWindow"], 0.0), CostIndex: n(or(m["costIndex"], 0.0), math.NaN()), ProviderCostIndex: n(m["costIndexProvider"], .5), LatencyIndex: n(or(m["latencyIndex"], 0.0), math.NaN()),
			ReliabilityVerified: m["reliabilityStatus"] == "verified", MinimumCompletionTokens: n(m["minimumCompletionTokensForReliableAnswer"], 0.0),
			VerifiedThinkingOff: truth(control["verified"]) && control["parameter"] == "chat_template_kwargs.enable_thinking" && falseValue(values["off"]),
			ReasoningVerified:   truth(control["verified"]), ReasoningParameter: stringValue(or(control["parameter"], "reasoning_effort")),
			Capabilities: map[string]bool{}, ReasoningValues: map[string]any{},
		}
		for key, value := range object(m["capabilities"]) {
			v, ok := value.(bool)
			if !ok {
				invalid = true
			}
			mc.base.Capabilities[key] = v
		}
		if !truth(control["values"]) {
			values = map[string]any{"off": "low", "standard": "medium", "high": "high"}
		}
		for key, value := range values {
			mc.base.ReasoningValues[key] = cloneJSON(value)
		}
		if truth(control["values"]) && values == nil {
			invalid = true
		}
		limit, present := limits[mc.base.ID]
		if present {
			v := number(limit)
			if finite(v) && v > 0 && math.Trunc(v) == v {
				mc.base.Capacity = int(v)
			}
		}
		quality := object(m["quality"])
		mc.base.Quality = n(quality["default"], .75)
		for task, value := range quality {
			if value != nil {
				q := n(value, .75)
				if q < 0 || q > 1 {
					invalid = true
				}
				mc.quality[task] = q
			}
		}
		for task, value := range object(object(m["benchmarkScores"])["subtasks"]) {
			s := object(value)
			avg, avgPresent := s["avg"]
			a, count := number(avg), number(s["n"])
			if avgPresent && finite(a) && count > 0 {
				if !finite(count) || a < 0 || a > 1 {
					invalid = true
				}
				mc.subtasks[task] = decision.Subscore{Average: a, Samples: count}
			}
		}
		b.models = append(b.models, mc)
	}
	if invalid {
		return nil, errors.New("invalid feature configuration values")
	}
	// Validate the static contract before publishing the generation. Request- and
	// task-dependent fields are set below or were checked while compiling maps.
	probe := decision.Input{SchemaVersion: 1, ConfigVersion: b.version, RequestedModel: b.policy.AutoModelID, Policy: b.policy,
		Analysis: decision.Analysis{Task: "default", Tier: "balanced", EstimatedContextTokens: 1}, Runtime: decision.Runtime{NowMs: 1}}
	probe.Policy.RelativeQualityCap = b.relative["balanced"]
	for _, m := range b.models {
		probe.Models = append(probe.Models, m.base)
	}
	if e := probe.Validate(); e != nil {
		return nil, e
	}
	return b, nil
}

func cloneJSON(v any) any {
	switch x := v.(type) {
	case map[string]any:
		m := make(map[string]any, len(x))
		for k, v := range x {
			m[k] = cloneJSON(v)
		}
		return m
	case []any:
		a := make([]any, len(x))
		for i, v := range x {
			a[i] = cloneJSON(v)
		}
		return a
	default:
		return v
	}
}

func (b *Builder) ModelIDs() []string {
	ids := make([]string, len(b.models))
	for i, m := range b.models {
		ids[i] = m.base.ID
	}
	return ids
}
