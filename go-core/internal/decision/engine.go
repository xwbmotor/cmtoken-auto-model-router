package decision

import (
	"math"
	"math/big"
	"sort"
)

// decimal follows Number(x.toFixed(digits)): round the exact binary64 value,
// with ties away from zero. Multiplying floats first introduces double rounding.
func decimal(x float64, digits int) float64 {
	if x == 0 {
		return 0
	}
	r := new(big.Rat).SetFloat64(math.Abs(x))
	factor := int64(1)
	for i := 0; i < digits; i++ {
		factor *= 10
	}
	r.Mul(r, new(big.Rat).SetInt64(factor))
	q, rem := new(big.Int), new(big.Int)
	q.QuoRem(r.Num(), r.Denom(), rem)
	if rem.Lsh(rem, 1).Cmp(r.Denom()) >= 0 {
		q.Add(q, big.NewInt(1))
	}
	value, _ := new(big.Rat).SetFrac(q, big.NewInt(factor)).Float64()
	return math.Copysign(value, x)
}

func clamp(x, low, high float64) float64 { return math.Max(low, math.Min(high, x)) }

func (in Input) Validate() error {
	finite := func(values ...float64) bool {
		for _, v := range values {
			if math.IsNaN(v) || math.IsInf(v, 0) || math.Abs(v) > 1e15 {
				return false
			}
		}
		return true
	}
	p := in.Policy
	if !finite(p.SessionTTLMS, p.SessionMaxGap) || p.SessionTTLMS < 0 || p.SessionTTLMS > 86400000 || p.SessionMaxGap < 0 || p.SessionMaxGap > 1 {
		return failure("invalid_contract", "invalid session policy")
	}
	if !finite(in.CompletionTokens, in.Analysis.Complexity, in.Analysis.EstimatedContextTokens, in.Runtime.NowMs, in.Runtime.TrafficBucket, in.Runtime.BudgetPressure,
		p.ActiveTrafficPercent, p.QualityFloor, p.QualityWeight, p.CostWeight, p.ProviderCostWeight, p.LatencyWeight, p.SelfHostedBonus, p.UncertaintyPenalty,
		p.ComplexQualityMargin, p.RelativeQualityCap, p.SubtaskSmoothK, p.SubtaskMinSamples, p.SubtaskMaxAdjust, p.LatencyScaleMs, p.LatencyMax,
		p.ErrorStep, p.ErrorMax, p.BudgetCostMultiplier, p.BudgetDegradeThreshold, p.LoadPenaltyWeight, p.ReasoningHighMin, p.ReasoningOffMax) {
		return failure("invalid_contract", "numeric features must be finite and bounded")
	}
	if p.Preference != nil && (!finite(p.Preference.Tolerance) || p.Preference.Tolerance < 0) {
		return failure("invalid_contract", "invalid preference tolerance")
	}
	for _, h := range in.Runtime.Health {
		if !finite(h.CircuitOpenUntil, h.EWMALatencyMs, h.ConsecutiveFailures) || h.EWMALatencyMs < 0 || h.ConsecutiveFailures < 0 {
			return failure("invalid_contract", "invalid health features")
		}
	}
	for _, v := range in.Runtime.MarketAdjustments {
		if !finite(v) {
			return failure("invalid_contract", "invalid market adjustment")
		}
	}
	if in.SchemaVersion != 1 {
		return failure("invalid_contract", "schemaVersion must be 1")
	}
	if in.Policy.ScoreStrategy != "weighted" {
		return failure("unsupported_strategy", "only weighted scoring is implemented")
	}
	if in.Policy.Mode != "active" && in.Policy.Mode != "shadow" {
		return failure("invalid_contract", "invalid routing mode")
	}
	if in.Analysis.Tier != "simple" && in.Analysis.Tier != "balanced" && in.Analysis.Tier != "complex" {
		return failure("invalid_contract", "invalid analysis tier")
	}
	if in.Analysis.Task == "" || in.Analysis.EstimatedContextTokens < 1 || in.Policy.AutoModelID == "" || in.ConfigVersion == "" {
		return failure("invalid_contract", "missing analysis or configuration identity")
	}
	if in.RequestedModel != "" && in.RequestedModel != in.Policy.AutoModelID && !in.Policy.AllowExplicitModel {
		return failure("unsupported_explicit_model", "this milestone accepts Auto requests only")
	}
	if len(in.Models) == 0 || len(in.Models) > 1024 {
		return failure("invalid_contract", "model count must be between 1 and 1024")
	}
	if in.Runtime.TrafficBucket < 0 || in.Runtime.TrafficBucket >= 100 || in.Runtime.NowMs <= 0 {
		return failure("invalid_contract", "explicit clock and traffic bucket are required")
	}
	if in.Policy.SubtaskSmoothK <= 0 || in.Policy.LatencyScaleMs <= 0 {
		return failure("invalid_contract", "score denominators must be positive")
	}
	for _, value := range []float64{in.Policy.QualityFloor, in.Policy.RelativeQualityCap, in.Analysis.Complexity} {
		if math.IsNaN(value) || value < 0 || value > 1 {
			return failure("invalid_contract", "quality bounds and complexity must be in [0,1]")
		}
	}
	seen := make(map[string]bool)
	for _, m := range in.Models {
		if !finite(m.ContextWindow, m.Quality, m.CostIndex, m.ProviderCostIndex, m.LatencyIndex, m.MinimumCompletionTokens) {
			return failure("invalid_contract", "invalid model numbers")
		}
		if m.Subscore != nil && (!finite(m.Subscore.Average, m.Subscore.Samples) || m.Subscore.Average < 0 || m.Subscore.Average > 1 || m.Subscore.Samples < 0) {
			return failure("invalid_contract", "invalid subtask score")
		}
		if m.ID == "" || seen[m.ID] || m.ID == in.Policy.AutoModelID || m.Capacity < 0 {
			return failure("invalid_contract", "invalid or duplicate model identity/capacity")
		}
		seen[m.ID] = true
		if m.Quality < 0 || m.Quality > 1 || m.CostIndex < 0 || m.LatencyIndex < 0 {
			return failure("invalid_contract", "invalid model scores")
		}
	}
	for _, n := range in.Runtime.Inflight {
		if n < 0 {
			return failure("invalid_contract", "inflight must not be negative")
		}
	}
	return nil
}

func AssessLoad(m Model, p Policy, inflight int) Load {
	l := Load{Inflight: inflight, Scope: "router_process"}
	if m.Capacity <= 0 {
		return l
	}
	l.Capacity = &m.Capacity
	u := float64(inflight) / float64(m.Capacity)
	l.Utilization = &u
	if p.LoadEnabled {
		fraction := math.Min(1, u)
		l.Penalty = p.LoadPenaltyWeight * fraction * fraction
		l.Saturated = inflight >= m.Capacity
	}
	return l
}

func reasoning(in Input) string {
	if in.Analysis.Complexity >= in.Policy.ReasoningHighMin {
		return "high"
	}
	if in.Analysis.Complexity <= in.Policy.ReasoningOffMax || (in.Analysis.Task == "extraction" && in.Analysis.Complexity < 0.6) {
		return "off"
	}
	return "standard"
}

func completionEligible(in Input, m Model, level string) bool {
	if !(in.CompletionTokens > 0 && m.MinimumCompletionTokens > 0 && in.CompletionTokens < m.MinimumCompletionTokens) {
		return true
	}
	if !m.VerifiedThinkingOff {
		return false
	}
	if in.ThinkingSpecified {
		return in.ThinkingOff
	}
	return in.Policy.ReasoningEnabled && level == "off"
}

func Decide(in Input) (Decision, error) {
	if err := in.Validate(); err != nil {
		return Decision{}, err
	}
	p, a, r := in.Policy, in.Analysis, in.Runtime
	d := Decision{SchemaVersion: 1, ConfigVersion: in.ConfigVersion, RequestedModel: in.RequestedModel,
		Candidates: []Candidate{}, Rejected: []Rejection{}, FallbackOrder: []string{}, QualifiedModelIDs: []string{}}
	if d.RequestedModel == "" {
		d.RequestedModel = p.AutoModelID
	}
	level := reasoning(in)
	allowed := make(map[string]bool)
	if r.AllowedModelIDs != nil {
		for _, id := range *r.AllowedModelIDs {
			allowed[id] = true
		}
	}
	if d.RequestedModel != p.AutoModelID {
		for _, m := range in.Models {
			if m.ID != d.RequestedModel || !m.Enabled {
				continue
			}
			if r.AllowedModelIDs != nil && !allowed[m.ID] {
				return Decision{}, failure("not_entitled", "model is outside tenant entitlement")
			}
			if m.ContextWindow > 0 && a.EstimatedContextTokens > m.ContextWindow {
				return Decision{}, failure("context_length_exceeded", "request exceeds context window")
			}
			for key, needed := range a.Requirements {
				if needed && key != "chat" && key != "stream" && !m.Capabilities[key] {
					return Decision{}, failure("unsupported_capability", "model lacks required capability")
				}
			}
			if !completionEligible(in, m, level) {
				return Decision{}, failure("completion_budget_too_low", "output budget is insufficient")
			}
			if p.LoadEnabled && m.Capacity > 0 && r.Inflight[m.ID] >= m.Capacity {
				return Decision{}, failure("model_capacity_exhausted", "model is at capacity")
			}
			d.SelectedModel = m.ID
			d.SuggestedModel = m.ID
			d.ReasoningLevel = level
			d.FallbackOrder = []string{m.ID}
			d.QualifiedModelIDs = []string{m.ID}
			return d, nil
		}
		return Decision{}, failure("invalid_model", "model does not exist or is disabled")
	}
	for _, m := range in.Models {
		reasons := []string{}
		if !m.Enabled {
			reasons = append(reasons, "disabled")
		}
		if m.Ownership == "unknown" {
			reasons = append(reasons, "ownership_unconfirmed")
		}
		if r.AllowedModelIDs != nil && !allowed[m.ID] {
			reasons = append(reasons, "not_entitled")
		}
		h := r.Health[m.ID]
		if h.CircuitOpenUntil > r.NowMs {
			reasons = append(reasons, "circuit_open")
		}
		if m.ContextWindow > 0 && a.EstimatedContextTokens > m.ContextWindow {
			reasons = append(reasons, "context_too_long")
		}
		if !completionEligible(in, m, level) {
			reasons = append(reasons, "completion_budget_too_low")
		}
		minCost, maxCost, band := 0.0, 1.0, true
		switch p.CostTier {
		case "budget":
			maxCost = 0.2
		case "balanced":
			maxCost = 0.5
		case "quality":
			minCost = 0.15
		case "max":
			minCost = 0.2
		default:
			band = false
		}
		if band {
			if m.CostIndex < minCost {
				reasons = append(reasons, "below_cost_tier")
			} else if m.CostIndex > maxCost {
				reasons = append(reasons, "above_cost_tier")
			}
		}
		// Canonical ordering is part of the contract; unknown requirements fail closed.
		capabilities := make([]string, 0, len(a.Requirements))
		for key, needed := range a.Requirements {
			if needed && key != "chat" && key != "stream" && !m.Capabilities[key] {
				capabilities = append(capabilities, key)
			}
		}
		sort.Strings(capabilities)
		for _, key := range capabilities {
			reasons = append(reasons, "missing_"+key)
		}
		if len(reasons) > 0 {
			d.Rejected = append(d.Rejected, Rejection{Model: m.ID, Reasons: reasons})
			continue
		}
		quality := m.Quality
		if sub := m.Subscore; sub != nil && sub.Samples > 0 && sub.Samples >= p.SubtaskMinSamples {
			w := sub.Samples / (sub.Samples + p.SubtaskSmoothK)
			quality = clamp(sub.Average*w+m.Quality*(1-w), m.Quality-p.SubtaskMaxAdjust, m.Quality+p.SubtaskMaxAdjust)
		}
		uncertainty, bonus := 0.0, 0.0
		if !m.ReliabilityVerified {
			uncertainty = p.UncertaintyPenalty
		}
		if p.PreferSelfHosted && m.Ownership == "self_hosted" {
			bonus = p.SelfHostedBonus
		}
		dynamic := math.Min(p.LatencyMax, h.EWMALatencyMs/p.LatencyScaleMs) + math.Min(p.ErrorMax, h.ConsecutiveFailures*p.ErrorStep)
		floor := p.QualityFloor
		if a.Tier == "complex" {
			floor += p.ComplexQualityMargin
		}
		floor = math.Min(1, floor)
		costWeight := p.CostWeight * (1 + clamp(r.BudgetPressure, 0, 1)*p.BudgetCostMultiplier)
		base := p.QualityWeight*quality - costWeight*m.CostIndex - p.ProviderCostWeight*m.ProviderCostIndex - p.LatencyWeight*m.LatencyIndex - uncertainty - dynamic + bonus
		load := AssessLoad(m, p, r.Inflight[m.ID])
		market := r.MarketAdjustments[m.ID]
		d.Candidates = append(d.Candidates, Candidate{Model: m.ID, Quality: quality, BaseScore: decimal(base, 4),
			Score: decimal(base+market-load.Penalty, 4), MarketAdjust: decimal(market, 4), CostIndex: m.CostIndex,
			QualityQualified: quality >= floor, EffectiveQualityFloor: floor, Load: load})
	}
	if len(d.Candidates) == 0 {
		return Decision{}, failure("no_candidates", "no model meets capability and health requirements")
	}
	maxQuality := d.Candidates[0].Quality
	for _, c := range d.Candidates {
		maxQuality = math.Max(maxQuality, c.Quality)
	}
	qualified := []Candidate{}
	for i := range d.Candidates {
		c := &d.Candidates[i]
		c.QualityLoss = decimal(maxQuality-c.Quality, 4)
		c.QualityEligible = c.QualityQualified && c.QualityLoss <= p.RelativeQualityCap
		if c.QualityEligible {
			qualified = append(qualified, *c)
			if !c.Load.Saturated {
				d.QualifiedModelIDs = append(d.QualifiedModelIDs, c.Model)
			}
		}
	}
	d.QualityDegraded = len(qualified) == 0
	if d.QualityDegraded && !p.AllowQualityDegradation {
		return Decision{}, failure("quality_gate", "no model meets the quality gate")
	}
	if d.QualityDegraded {
		qualified = d.Candidates
	}
	pool := []Candidate{}
	for _, c := range qualified {
		if !c.Load.Saturated {
			pool = append(pool, c)
		}
	}
	if len(pool) == 0 {
		return Decision{}, failure("model_capacity_exhausted", "all quality-eligible models have exhausted this process capacity")
	}
	sort.SliceStable(pool, func(i, j int) bool {
		if pool[i].Score == pool[j].Score {
			return pool[i].CostIndex < pool[j].CostIndex
		}
		return pool[i].Score > pool[j].Score
	})
	if pref := p.Preference; !d.QualityDegraded && pref != nil && len(pool) > 1 {
		for i := 1; i < len(pool); i++ {
			gap := pool[0].Score - pool[i].Score
			if pool[i].Model == pref.Model && gap >= 0 && gap <= pref.Tolerance+1e-9 {
				chosen := pool[i]
				copy(pool[1:i+1], pool[:i])
				pool[0] = chosen
				d.PreferenceApplied = true
				break
			}
		}
	}
	for _, c := range pool {
		d.FallbackOrder = append(d.FallbackOrder, c.Model)
	}
	d.SuggestedModel = pool[0].Model
	traffic := clamp(p.ActiveTrafficPercent, 0, 100)
	applied := p.Mode == "active" && r.TrafficBucket < traffic
	d.Rollout = Rollout{ActiveTrafficPercent: traffic, TrafficBucket: decimal(r.TrafficBucket, 2), RolloutApplied: applied}
	d.Shadow = !applied
	d.SelectedModel = p.ShadowModel
	if applied {
		d.SelectedModel = d.SuggestedModel
	}
	safe := false
	for _, c := range d.Candidates {
		if c.Model == d.SelectedModel {
			safe = (d.QualityDegraded || c.QualityEligible) && !c.Load.Saturated
			break
		}
	}
	if !safe {
		d.SelectedModel = d.SuggestedModel
		d.Rollout.SafetyOverride = "configured_shadow_model_not_eligible"
	}
	if r.BudgetPressure >= p.BudgetDegradeThreshold {
		if level == "high" {
			level = "standard"
		} else {
			level = "off"
		}
	}
	d.ReasoningLevel = level
	sort.SliceStable(d.Candidates, func(i, j int) bool { return d.Candidates[i].Score > d.Candidates[j].Score })
	return d, nil
}
