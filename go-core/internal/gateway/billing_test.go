package gateway

import (
	"fmt"
	"math"
	"testing"
)

func billingPrice(v float64) *float64 { return &v }
func requireMicros(t *testing.T, actual *int64, expected int64) {
	t.Helper()
	if actual == nil {
		t.Fatalf("missing cost, expected %d micros", expected)
	}
	if *actual != expected {
		t.Fatalf("cost = %d, expected %d micros", *actual, expected)
	}
}

// Values verified with Node Number(x.toFixed(6)); binary half boundaries must
// not be implemented as a naive round(x * 1e6).
func TestBillingNodeDecimalBoundaries(t *testing.T) {
	for _, tc := range []struct {
		yuan   float64
		micros int64
	}{
		{0, 0}, {0.0000005, 0}, {0.0000015, 2}, {0.0000025, 3},
		{1.2345665, 1234566}, {1.2345675, 1234568},
		{0.0000004999999999, 0}, {0.0000005000000001, 1},
	} {
		t.Run(fmt.Sprint(tc.yuan), func(t *testing.T) { requireMicros(t, moneyMicros(tc.yuan), tc.micros) })
	}
	for _, n := range []float64{-1, math.NaN(), math.Inf(1), math.Inf(-1), 9e9 + 1} {
		if moneyMicros(n) != nil {
			t.Fatal("unsafe monetary amount accepted")
		}
	}
}

func TestBillingUsageRejectsInvalidTokenCounts(t *testing.T) {
	for _, field := range []string{"prompt_tokens", "completion_tokens", "cached_tokens"} {
		for _, value := range []string{`null`, `"1"`, `NaN`, `1e309`, `-1`, `0.5`, `1000000000001`, `true`, `[]`, `{}`} {
			t.Run(field+"="+value, func(t *testing.T) {
				prompt, completion, cached := "100", "20", "10"
				switch field {
				case "prompt_tokens":
					prompt = value
				case "completion_tokens":
					completion = value
				case "cached_tokens":
					cached = value
				}
				raw := fmt.Sprintf(`{"usage":{"prompt_tokens":%s,"completion_tokens":%s,"prompt_tokens_details":{"cached_tokens":%s}}}`, prompt, completion, cached)
				if parseUsage([]byte(raw)) != nil {
					t.Fatal("invalid token count accepted")
				}
			})
		}
	}
	for _, raw := range []string{`{}`, `{"usage":null}`, `{"usage":[]}`, `{"usage":{"prompt_tokens":1}}`, `{"usage":{"completion_tokens":1}}`, `{"usage":{"prompt_tokens":1,"completion_tokens":1,"prompt_tokens_details":{"cached_tokens":2}}}`, `{"usage":{"prompt_tokens":1,"completion_tokens":1,"prompt_tokens_details":[]}}`} {
		if parseUsage([]byte(raw)) != nil {
			t.Fatalf("invalid usage accepted: %s", raw)
		}
	}
}

func TestBillingActualDoesNotChargeReasoningTwice(t *testing.T) {
	p := Price{Input: billingPrice(2), Output: billingPrice(4), InputCached: billingPrice(.5), Reasoning: billingPrice(100)}
	// 60 uncached * 2 + 40 cached * .5 + 20 completion * 4 = 220 micros.
	// reasoning_tokens is already part of completion_tokens (Node server.mjs).
	u := parseUsage([]byte(`{"usage":{"prompt_tokens":100,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":40},"completion_tokens_details":{"reasoning_tokens":15}}}`))
	requireMicros(t, p.actual(u), 220)
	p.InputCached = nil
	requireMicros(t, p.actual(u), 280)
	for _, raw := range []string{`{"usage":{"prompt_tokens":0,"completion_tokens":0}}`, `{"usage":{"prompt_tokens":0,"completion_tokens":0,"prompt_tokens_details":null}}`, `{"usage":{"prompt_tokens":0,"completion_tokens":0,"prompt_tokens_details":{}}}`} {
		requireMicros(t, p.actual(parseUsage([]byte(raw))), 0)
	}
	if p.actual(nil) != nil || (Price{}).actual(u) != nil {
		t.Fatal("missing usage/price produced actual spend")
	}
}

func TestBillingEstimateMatchesNodeBudgetFormula(t *testing.T) {
	p := Price{Input: billingPrice(2), Output: billingPrice(4), InputCached: billingPrice(.5), Reasoning: billingPrice(10)}
	// Node budget.mjs: cache-weighted input + output + estimated reasoning.
	for _, tc := range []struct {
		level string
		want  int64
	}{{"off", 220}, {"standard", 250}, {"high", 320}} {
		requireMicros(t, p.estimate(100, 20, tc.level, .4), tc.want)
	}
	requireMicros(t, p.estimate(100, 20, "off", -1), 280)
	requireMicros(t, p.estimate(100, 20, "off", 2), 130)
	p.InputCached = nil
	p.Reasoning = nil
	requireMicros(t, p.estimate(100, 20, "high", .4), 320)
	if (Price{}).estimate(100, 20, "off", 0) != nil || p.estimate(math.NaN(), 20, "off", 0) != nil || p.estimate(-1, 20, "off", 0) != nil {
		t.Fatal("invalid estimate was priced")
	}
}

func TestBillingPriceValidation(t *testing.T) {
	for _, field := range []string{"input", "output", "cached", "reasoning"} {
		for _, bad := range []float64{-1, math.NaN(), math.Inf(1), 1e6 + 1} {
			p := Price{Input: billingPrice(1), Output: billingPrice(1)}
			switch field {
			case "input":
				p.Input = &bad
			case "output":
				p.Output = &bad
			case "cached":
				p.InputCached = &bad
			case "reasoning":
				p.Reasoning = &bad
			}
			if p.valid() {
				t.Fatal("invalid price accepted")
			}
		}
	}
	if !(Price{}).valid() || !(Price{Input: billingPrice(0), Output: billingPrice(1e6)}).valid() {
		t.Fatal("unpriced/free price rejected")
	}
}
