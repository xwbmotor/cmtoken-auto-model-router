package gateway

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/analysis"
	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/decision"
	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/semantic"
)

type Tenant struct {
	AccessToken   string `json:"accessToken"`
	UpstreamToken string `json:"upstreamToken"`
}

func (g *Gateway) authorize(header string) (string, bool) {
	if g.auth != nil {
		p, e := g.auth.Authenticate(header)
		return p.UpstreamToken, e == nil
	}
	token, ok := "", false
	if subtle.ConstantTimeCompare([]byte(header), []byte("Bearer "+g.options.AccessToken)) == 1 {
		token = g.options.UpstreamToken
		ok = true
	}
	for _, tenant := range g.options.Tenants {
		if subtle.ConstantTimeCompare([]byte(header), []byte("Bearer "+tenant.AccessToken)) == 1 {
			token = tenant.UpstreamToken
			ok = true
		}
	}
	return token, ok
}
func (g *Gateway) loadPolicy(path string, out any) error {
	u := *g.assessor
	u.Path = path
	req, e := http.NewRequest("GET", u.String(), nil)
	if e != nil {
		return errors.New("invalid_policy_request")
	}
	req.Header.Set("Authorization", "Bearer "+g.options.AssessorToken)
	res, e := g.client.Do(req)
	if e != nil {
		return errors.New("policy_unavailable")
	}
	defer res.Body.Close()
	data, e := io.ReadAll(io.LimitReader(res.Body, MaxBodyBytes+1))
	if e != nil || res.StatusCode != 200 || len(data) > MaxBodyBytes || decodeStrict(bytes.NewReader(data), out) != nil {
		return errors.New("invalid_policy_response")
	}
	return nil
}
func (g *Gateway) assess(ctx context.Context, data []byte, native *analysis.Result) (decision.Input, error) {
	var input decision.Input
	payload := data
	if native != nil {
		payload, _ = json.Marshal(map[string]any{"nativeAnalysisVersion": 1, "request": json.RawMessage(data), "analysis": native})
	}
	req, e := http.NewRequestWithContext(ctx, "POST", g.assessor.String(), bytes.NewReader(payload))
	if e != nil {
		return input, errors.New("assessment_request_failed")
	}
	if g.options.Bundle != nil {
		req.Header.Set("X-AMR-Config-Revision", g.options.Bundle.Revision)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+g.options.AssessorToken)
	if native != nil {
		req.Header.Set("X-AMR-Native-Analysis", "1")
	}
	if g.semantic != nil {
		req.Header.Set("X-AMR-Native-Semantics", "1")
	}
	res, e := g.client.Do(req)
	if e != nil {
		return input, errors.New("assessment_unavailable")
	}
	defer res.Body.Close()
	if g.options.Bundle != nil && res.Header.Get("X-AMR-Config-Revision") != g.options.Bundle.Revision {
		return input, errors.New("assessment_revision_mismatch")
	}
	raw, e := io.ReadAll(io.LimitReader(res.Body, MaxBodyBytes+1))
	if e != nil || res.StatusCode != 200 || len(raw) > MaxBodyBytes {
		return input, errors.New("assessment_failed")
	}
	if decodeStrict(bytes.NewReader(raw), &input) != nil {
		return input, errors.New("invalid_assessment_contract")
	}
	return input, nil
}
func applyScope(in decision.Input, ids []string) decision.Input {
	if len(ids) == 0 {
		return in
	}
	set := map[string]bool{}
	for _, id := range ids {
		set[id] = true
	}
	intersects := false
	for _, m := range in.Models {
		if m.Enabled && set[m.ID] {
			intersects = true
		}
	}
	if !intersects {
		return in
	}
	allowed := append([]string{}, ids...)
	if in.Runtime.AllowedModelIDs != nil {
		allowed = []string{}
		for _, id := range *in.Runtime.AllowedModelIDs {
			if set[id] {
				allowed = append(allowed, id)
			}
		}
	}
	in.Runtime.AllowedModelIDs = &allowed
	return in
}

type Review struct {
	RequestID     string            `json:"requestId"`
	Status        string            `json:"status"`
	Rollout       semantic.Rollout  `json:"rollout"`
	BaseTask      string            `json:"baseTask"`
	BaseModel     string            `json:"baseModel"`
	ProposedTask  string            `json:"proposedTask,omitempty"`
	ProposedModel string            `json:"proposedModel,omitempty"`
	Confidence    float64           `json:"confidence"`
	Cascade       *semantic.Cascade `json:"cascade,omitempty"`
	Usage         *semantic.Usage   `json:"usage,omitempty"`
}

func (g *Gateway) recordReview(v Review) {
	g.reviewsMu.Lock()
	defer g.reviewsMu.Unlock()
	if len(g.reviews) == 100 {
		copy(g.reviews, g.reviews[1:])
		g.reviews = g.reviews[:99]
	}
	g.reviews = append(g.reviews, v)
}
func (g *Gateway) runtimeStatus(w http.ResponseWriter) {
	g.reviewsMu.Lock()
	reviews := append([]Review{}, g.reviews...)
	g.reviewsMu.Unlock()
	var guard any
	if g.semantic != nil {
		guard = g.semantic.Snapshot()
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if g.runtime != nil {
		_ = json.NewEncoder(w).Encode(map[string]any{"milestone": "m3", "productionReady": false, "revision": g.options.Bundle.Revision, "ledger": g.runtime.ledger.Snapshot(), "health": g.runtime.health.States(), "persistenceHealthy": !g.runtime.failed.Load(), "inflight": g.admission.Snapshot(), "semanticGuard": guard, "reviews": reviews})
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"milestone": "m2b", "productionReady": false, "semanticGuard": guard, "reviews": reviews, "inflight": g.admission.Snapshot()})
}
func (g *Gateway) backgroundReview(run func(context.Context)) bool {
	g.backgroundMu.Lock()
	defer g.backgroundMu.Unlock()
	if g.backgroundClosing {
		return false
	}
	select {
	case g.backgroundSlots <- struct{}{}:
	default:
		return false
	}
	g.backgroundWorkers.Add(1)
	go func() {
		defer g.backgroundWorkers.Done()
		defer func() { <-g.backgroundSlots }()
		ctx, cancel := context.WithTimeout(g.background, g.options.RequestTimeout)
		defer cancel()
		run(ctx)
	}()
	return true
}
func (g *Gateway) reviewInput(ctx context.Context, r *http.Request, w http.ResponseWriter, raw []byte, baseAnalysis analysis.Result, base decision.Input) (decision.Input, error) {
	base.Runtime.Inflight = g.admission.Snapshot()
	baseDecision, e := decision.Decide(base)
	if e != nil {
		return base, e
	}
	p := g.semantic.Policy()
	if !p.Eligible(baseAnalysis, raw) {
		w.Header().Set("X-AMR-Semantic-Status", "not_eligible")
		return base, nil
	}
	nonce := make([]byte, 16)
	if _, e := rand.Read(nonce); e != nil {
		return base, e
	}
	requestID := hex.EncodeToString(nonce)
	w.Header().Set("X-AMR-Request-ID", requestID)
	bucket := semantic.Bucket(g.options.SemanticBucketSecret, r.Header.Get("X-Session-ID"), r.Header.Get("Authorization"), requestID)
	initial := Review{RequestID: requestID, Rollout: bucket, BaseTask: base.Analysis.Task, BaseModel: baseDecision.SuggestedModel}
	evaluate := func(reviewCtx context.Context, active bool) (decision.Input, string) {
		review := initial
		review.Status = "error"
		defer func() { g.recordReview(review) }()
		a, err := g.semantic.Classify(reviewCtx, raw)
		if err != nil {
			return base, review.Status
		}
		review.Confidence = a.Confidence
		review.Cascade = a.Cascade
		review.Usage = a.OverheadUsage
		reason := a.Reason
		if reason == "" {
			reason = a.Tier
		}
		merged := analysis.Reclassify(baseAnalysis, raw, a.Task, a.Tier, a.Complexity, a.Confidence, reason)
		proposed, err := g.assess(reviewCtx, raw, &merged)
		if err != nil {
			return base, review.Status
		}
		if proposed.RequestedModel != base.RequestedModel || proposed.ConfigVersion != base.ConfigVersion {
			return base, review.Status
		}
		// Reassessment must preserve the original experiment and tenant/runtime view.
		proposed.Runtime = base.Runtime
		selected, err := decision.Decide(proposed)
		if err != nil {
			return base, review.Status
		}
		review.ProposedTask = merged.Task
		review.ProposedModel = selected.SuggestedModel
		if !active {
			review.Status = "shadow_complete"
			return base, review.Status
		}
		if a.Confidence < p.FinalAdoptionThreshold {
			review.Status = "rejected_low_confidence"
			return base, review.Status
		}
		review.Status = "applied"
		return proposed, review.Status
	}
	if p.Mode == "shadow" || float64(bucket.Bucket) >= p.ActiveTrafficPercent {
		status := "shadow_pending"
		if p.Mode == "active" {
			status = "rollout_hold"
		}
		if !g.backgroundReview(func(background context.Context) { _, _ = evaluate(background, false) }) {
			status = "shadow_capacity_exhausted"
			initial.Status = status
			g.recordReview(initial)
		}
		w.Header().Set("X-AMR-Semantic-Status", status)
		return base, nil
	}
	selected, status := evaluate(ctx, true)
	w.Header().Set("X-AMR-Semantic-Status", status)
	return selected, nil
}
