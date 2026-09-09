package decision

import (
	"errors"
	"math"
	"testing"
)

func fixture() Input {
	return Input{SchemaVersion: 1, ConfigVersion: "test", RequestedModel: "auto",
		Analysis: Analysis{Task: "coding", Tier: "balanced", Complexity: .5, EstimatedContextTokens: 100},
		Policy: Policy{ScoreStrategy: "weighted", Mode: "active", AutoModelID: "auto", ActiveTrafficPercent: 100,
			QualityFloor: .72, QualityWeight: 1, RelativeQualityCap: .04, SubtaskSmoothK: 32, LatencyScaleMs: 300000,
			BudgetDegradeThreshold: .9, ReasoningHighMin: .78, ReasoningOffMax: .3, LoadEnabled: true, LoadPenaltyWeight: .2},
		Models:  []Model{{ID: "a", Enabled: true, Ownership: "self_hosted", Quality: .9, Capacity: 1}, {ID: "b", Enabled: true, Ownership: "self_hosted", Quality: .88, Capacity: 1}},
		Runtime: Runtime{NowMs: 1700000000000, Inflight: map[string]int{}},
	}
}

func TestDecimalMatchesJavaScriptBoundaries(t *testing.T) {
	for _, tc := range []struct {
		x      float64
		digits int
		want   float64
	}{{.125, 2, .13}, {-.125, 2, -.13}, {1.005, 2, 1}, {2.675, 2, 2.67}, {39.995, 2, 39.99}, {0, 4, 0}} {
		if got := decimal(tc.x, tc.digits); got != tc.want {
			t.Fatalf("%v toFixed(%d): %v != %v", tc.x, tc.digits, got, tc.want)
		}
	}
}

func TestQualityGateIsNotRelaxedBySaturation(t *testing.T) {
	in := fixture()
	in.Models[1].Quality = .6
	in.Runtime.Inflight["a"] = 1
	in.Policy.AllowQualityDegradation = true
	_, err := Decide(in)
	var de *Error
	if !errors.As(err, &de) || de.Code != "model_capacity_exhausted" {
		t.Fatalf("must not send work to lower quality model: %v", err)
	}
}

func TestLocalLoadChangesSelection(t *testing.T) {
	in := fixture()
	d, err := Decide(in)
	if err != nil || d.SelectedModel != "a" {
		t.Fatalf("initial decision: %+v %v", d, err)
	}
	in.Runtime.Inflight["a"] = 1
	d, err = Decide(in)
	if err != nil || d.SelectedModel != "b" {
		t.Fatalf("saturated decision: %+v %v", d, err)
	}
	in.Runtime.Inflight["b"] = 1
	_, err = Decide(in)
	if err == nil {
		t.Fatal("full pool must reject")
	}
	in.Policy.LoadEnabled = false
	d, err = Decide(in)
	if err != nil || d.SelectedModel != "a" {
		t.Fatal("disabled protection must not filter capacity")
	}
}

func TestNullAndEmptyEntitlementsDiffer(t *testing.T) {
	in := fixture()
	empty := []string{}
	in.Runtime.AllowedModelIDs = &empty
	if _, err := Decide(in); err == nil {
		t.Fatal("empty entitlement list must reject all")
	}
	in.Runtime.AllowedModelIDs = nil
	if _, err := Decide(in); err != nil {
		t.Fatal(err)
	}
}

func TestShadowAndPreferenceCannotBypassQuality(t *testing.T) {
	in := fixture()
	in.Policy.Mode = "shadow"
	in.Policy.ShadowModel = "b"
	in.Models[1].Quality = .6
	in.Policy.Preference = &Preference{Model: "b", Tolerance: 1}
	d, err := Decide(in)
	if err != nil || d.SelectedModel != "a" || d.PreferenceApplied || d.Rollout.SafetyOverride == "" {
		t.Fatalf("unsafe selection: %+v %v", d, err)
	}
}

func TestThinkingBudgetRespectsExplicitIntent(t *testing.T) {
	in := fixture()
	in.CompletionTokens = 64
	in.Policy.ReasoningEnabled = true
	in.Analysis.Complexity = .1
	for i := range in.Models {
		in.Models[i].MinimumCompletionTokens = 1024
		in.Models[i].VerifiedThinkingOff = true
	}
	if _, err := Decide(in); err != nil {
		t.Fatal(err)
	}
	in.ThinkingSpecified = true
	in.ThinkingOff = false
	if _, err := Decide(in); err == nil {
		t.Fatal("explicit thinking must not be silently disabled")
	}
	in.ThinkingOff = true
	if _, err := Decide(in); err != nil {
		t.Fatal(err)
	}
}

func TestContractValidation(t *testing.T) {
	for name, mutate := range map[string]func(*Input){
		"infinite-weight": func(in *Input) { in.Policy.CostWeight = math.Inf(1) },
		"nan-health":      func(in *Input) { in.Runtime.Health = map[string]Health{"a": {EWMALatencyMs: math.NaN()}} },
		"version":         func(in *Input) { in.SchemaVersion = 2 }, "strategy": func(in *Input) { in.Policy.ScoreStrategy = "learned" },
		"duplicate": func(in *Input) { in.Models[1].ID = "a" }, "negative-count": func(in *Input) { in.Runtime.Inflight["a"] = -1 },
		"explicit-model": func(in *Input) { in.RequestedModel = "a" }, "missing-analysis": func(in *Input) { in.Analysis.EstimatedContextTokens = 0 },
	} {
		t.Run(name, func(t *testing.T) {
			in := fixture()
			mutate(&in)
			if _, err := Decide(in); err == nil {
				t.Fatal("must reject invalid contract")
			}
		})
	}
}

func BenchmarkDecision(b *testing.B) {
	in := fixture()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		if _, err := Decide(in); err != nil {
			b.Fatal(err)
		}
	}
}
