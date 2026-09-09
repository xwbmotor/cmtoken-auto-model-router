package analysis

import (
	"encoding/json"
	"strings"
	"testing"
)

func testConfig() Config {
	var c Config
	c.TaskRules.SimpleMaxComplexity = .34
	c.TaskRules.ComplexMinComplexity = .7
	return c
}
func TestClassificationExcludesAssistantButCapacityIncludesIt(t *testing.T) {
	a, _ := New(testConfig())
	body := map[string]any{"messages": []any{map[string]any{"role": "assistant", "content": strings.Repeat("代码", 900)}, map[string]any{"role": "user", "content": "今天星期几？"}}}
	data, _ := json.Marshal(body)
	r, e := a.Analyze(data)
	if e != nil || r.Task != "default" || r.Confidence != .98 || r.EstimatedInputTokens < 1000 {
		t.Fatalf("unexpected analysis: %+v %v", r, e)
	}
}
func TestOpaqueMediaAndOutputPrecedence(t *testing.T) {
	a, _ := New(testConfig())
	r, e := a.Analyze([]byte(`{"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"secret"}},{"type":"text","text":"你好"}]}],"max_completion_tokens":"22.2","max_tokens":500}`))
	if e != nil || !r.Requirements["vision"] || r.CapacityEstimate.UnknownMediaParts != 1 || r.EstimatedOutputTokens != 23 {
		t.Fatalf("unexpected analysis: %+v %v", r, e)
	}
}
func TestUnsupportedPatternsFailStartup(t *testing.T) {
	for _, pattern := range []map[string][]string{{"coding": {"(?<=x)y"}}, {"new-task": {"hello"}}} {
		c := testConfig()
		c.TaskRules.Patterns = pattern
		if _, e := New(c); e == nil {
			t.Fatal("unsupported pattern accepted")
		}
	}
}
func TestInvalidMessages(t *testing.T) {
	a, _ := New(testConfig())
	for _, s := range []string{`null`, `{}`, `{"messages":[null]}`, `{"messages":[{"role":4}]}`} {
		if _, e := a.Analyze([]byte(s)); e == nil {
			t.Fatal("invalid messages accepted")
		}
	}
}
