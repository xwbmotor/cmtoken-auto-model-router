package features

import (
	"encoding/json"
	"reflect"
	"sync"
	"testing"

	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/analysis"
)

func fixture(t *testing.T) Config {
	t.Helper()
	var c Config
	if e := json.Unmarshal([]byte(`{"schemaVersion":1,"version":"fixture","routing":{"mode":"active","qualityFloor":0.7,"qualityWeight":1,"costWeight":0.2,"latencyWeight":0.1,"selfHostedBonus":0.03,"uncertaintyPenalty":0.02,"taskPreferences":{"coding":{"model":"a","tolerance":0.02}}},"models":[{"id":"a","enabled":true,"quality":{"default":0.8,"coding":0.9},"capabilities":{"tools":true},"reasoningControl":{"values":{"off":{"nested":false}}},"benchmarkScores":{"subtasks":{"fixture":{"avg":0.95,"n":16}}}}]}`), &c); e != nil {
		t.Fatal(e)
	}
	return c
}
func sampleAnalysis() analysis.Result {
	sub := "fixture"
	return analysis.Result{Task: "coding", SubTask: &sub, Tier: "balanced", Complexity: .5, Requirements: map[string]bool{"tools": true}, Capacity: analysis.Capacity{EstimatedContextTokens: 128}}
}

func TestValidatedFieldsPreserveRequestHeaderDecoding(t *testing.T) {
	b, err := New(fixture(t))
	if err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{
		`{}`, `{"model":"a","max_tokens":128,"messages":[{"role":"user","content":"hello"}]}`,
		`{"max_completion_tokens":"64","max_tokens":128,"chat_template_kwargs":{"enable_thinking":false}}`,
		`{"model":null,"max_tokens":0}`, `{"model":123}`, `{"max_tokens":{}}`,
		`{"MODEL":"a","model":"auto"}`, `{"model":"auto","MODEL":"a"}`,
		`{"MAX_TOKENſ":128}`, `{"max_tokens":64,"max_tokens":128}`,
	} {
		var fields map[string]json.RawMessage
		if err := json.Unmarshal([]byte(raw), &fields); err != nil {
			t.Fatal(err)
		}
		want, wantErr := b.Input([]byte(raw), sampleAnalysis(), 1, 0)
		got, gotErr := b.InputFields([]byte(raw), fields, sampleAnalysis(), 1, 0)
		if (wantErr == nil) != (gotErr == nil) || !reflect.DeepEqual(want, got) {
			t.Fatalf("header decoding changed for %s: %v / %v", raw, wantErr, gotErr)
		}
	}
}
func TestGenerationOwnsConfigurationAndRequestMaps(t *testing.T) {
	c := fixture(t)
	b, e := New(c)
	if e != nil {
		t.Fatal(e)
	}
	object(c.Models[0]["quality"])["coding"] = .1
	object(c.Models[0]["capabilities"])["tools"] = false
	object(object(c.Routing["taskPreferences"])["coding"])["tolerance"] = .8
	in, e := b.Input([]byte(`{}`), sampleAnalysis(), 1, 0)
	if e != nil {
		t.Fatal(e)
	}
	if in.Models[0].Quality != .9 || !in.Models[0].Capabilities["tools"] || in.Policy.Preference.Tolerance != .02 {
		t.Fatal("source config changed compiled generation")
	}
	in.Models[0].Capabilities["tools"] = false
	object(in.Models[0].ReasoningValues["off"])["nested"] = true
	in.Models[0].Subscore.Average = .1
	in.Policy.Preference.Tolerance = .9
	in.Analysis.Requirements["tools"] = false
	in.Runtime.Inflight["a"] = 99
	next, e := b.Input([]byte(`{}`), sampleAnalysis(), 1, 0)
	if e != nil {
		t.Fatal(e)
	}
	if !next.Models[0].Capabilities["tools"] || object(next.Models[0].ReasoningValues["off"])["nested"] != false || next.Models[0].Subscore.Average != .95 || next.Policy.Preference.Tolerance != .02 || !next.Analysis.Requirements["tools"] || next.Runtime.Inflight["a"] != 0 {
		t.Fatal("request mutated shared configuration")
	}
}
func TestConcurrentFeatureConstruction(t *testing.T) {
	b, e := New(fixture(t))
	if e != nil {
		t.Fatal(e)
	}
	var workers sync.WaitGroup
	for range 8 {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for range 100 {
				in, e := b.Input([]byte(`{"max_tokens":64}`), sampleAnalysis(), 1, 0)
				if e != nil {
					t.Error(e)
					return
				}
				if in.Models[0].Quality != .9 || !in.Models[0].Capabilities["tools"] {
					t.Error("cross-request mutation")
					return
				}
				in.Models[0].Capabilities["tools"] = false
				in.Models[0].ReasoningValues["off"] = "changed"
			}
		}()
	}
	workers.Wait()
}
func TestInvalidGenerationRejectedBeforeRequests(t *testing.T) {
	for _, edit := range []func(*Config){
		func(c *Config) { c.SchemaVersion = 2 },
		func(c *Config) { delete(c.Routing, "qualityFloor") },
		func(c *Config) { c.Routing["sessionStickinessTtlMs"] = "Infinity" },
		func(c *Config) { object(c.Models[0]["quality"])["unused-task"] = 2.0 },
		func(c *Config) { c.Models = append(c.Models, c.Models[0]) },
	} {
		c := fixture(t)
		edit(&c)
		if _, e := New(c); e == nil {
			t.Fatal("invalid generation accepted")
		}
	}
}
