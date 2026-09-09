package decision

import (
	"errors"
	"testing"
)

func TestExplicitGuards(t *testing.T) {
	base := fixture()
	base.Policy.AllowExplicitModel = true
	base.RequestedModel = "b"
	base.Policy.QualityFloor = 1
	d, e := Decide(base)
	if e != nil || d.SelectedModel != "b" {
		t.Fatalf("explicit incorrectly uses auto quality gate: %+v %v", d, e)
	}
	for _, tc := range []struct {
		code   string
		change func(*Input)
	}{
		{"not_entitled", func(i *Input) { empty := []string{}; i.Runtime.AllowedModelIDs = &empty }},
		{"invalid_model", func(i *Input) { i.Models[1].Enabled = false }},
		{"context_length_exceeded", func(i *Input) { i.Models[1].ContextWindow = 1 }},
		{"unsupported_capability", func(i *Input) { i.Analysis.Requirements = map[string]bool{"vision": true} }},
		{"completion_budget_too_low", func(i *Input) { i.Models[1].MinimumCompletionTokens = 10000; i.CompletionTokens = 1 }},
		{"model_capacity_exhausted", func(i *Input) { i.Runtime.Inflight = map[string]int{"b": 1} }},
	} {
		t.Run(tc.code, func(t *testing.T) {
			in := fixture()
			in.Policy.AllowExplicitModel = true
			in.RequestedModel = "b"
			tc.change(&in)
			_, err := Decide(in)
			var de *Error
			if !errors.As(err, &de) || de.Code != tc.code {
				t.Fatalf("got %v", err)
			}
		})
	}
}
