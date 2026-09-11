package analysis

import (
	"math/rand"
	"reflect"
	"strings"
	"testing"
	"unicode"
)

func TestFoldRuneMatchesUnicodeAcrossAllCodePoints(t *testing.T) {
	for r := rune(-1); r <= unicode.MaxRune; r++ {
		want := r
		for n := unicode.SimpleFold(r); n != r; n = unicode.SimpleFold(n) {
			if n < want {
				want = n
			}
		}
		if got := foldRune(r); got != want {
			t.Fatalf("fold %U: got %U want %U", r, got, want)
		}
	}
}

func TestFastRegexPreservesRE2Matching(t *testing.T) {
	patterns := []string{
		`a|ab`, `ab|a`, `a?ab`, `a??ab`, `(ab|a)b?`, `(?i)requirements?|constraint(s)?`,
		`(?i)k|s|Σ`, `(?i:k)(?-i:s)`, `(?i)[a-z]`, `[，,；;？?]|以及|同时|并且|或者`,
		`a*`, `a+`, `a{2,3}`, `^a|b$`, `\bhi\b`, `a|`, `.*`, `(?i)解析.{0,4}文件|CODE`,
		`(?i)(代码|debug).*错误|什么是`, `😀|😁`, "\ufffd", `(ab|cd|ef|gh|ij|kl|mn|op|qr){4}`,
		structural.re.String(), objectives.re.String(), clauses.re.String(), negation.re.String(), meta.re.String(),
	}
	for _, rule := range taskPatterns {
		patterns = append(patterns, "(?i)"+rule.source)
	}
	texts := []string{"", "aab abab ab", "requirements REQUIREMENT constraints", "KkK Ssſ Σσς",
		"ks Ks kS KS", "同时同时，,；;？?以及或者", "解析😀😀文件", "解析😀😀😀文件", "代码\n错误 什么是",
		"代码\r错误\u2028解析文件", "😀😁", "a\xffb", strings.Repeat("项目需求、约束条件和执行记录。", 64)}
	rng := rand.New(rand.NewSource(7412))
	alphabet := []rune("abksKSKſΣσς代码错误同时要求，?😀\n")
	for i := 0; i < 300; i++ {
		var text strings.Builder
		for j, n := 0, rng.Intn(60); j < n; j++ {
			text.WriteRune(alphabet[rng.Intn(len(alphabet))])
		}
		texts = append(texts, text.String())
	}
	for _, source := range patterns {
		p := mustRegex(source)
		for _, input := range texts {
			text := regexText(input)
			if got, want := p.MatchString(text), p.re.MatchString(text); got != want {
				t.Fatalf("match %q %q: %v != %v", source, input, got, want)
			}
			for _, n := range []int{-1, 0, 1, 3} {
				got, want := p.FindAllStringIndex(text, n), p.re.FindAllStringIndex(text, n)
				if !reflect.DeepEqual(got, want) {
					t.Fatalf("indices %q %q n=%d: %v != %v", source, input, n, got, want)
				}
				if !reflect.DeepEqual(p.FindAllString(text, n), p.re.FindAllString(text, n)) {
					t.Fatalf("strings %q %q n=%d", source, input, n)
				}
			}
		}
	}
}

func TestFiniteScannerAndConservativeFallback(t *testing.T) {
	for _, p := range []*fastRegex{structural, objectives, clauses, negation} {
		if p.trie == nil {
			t.Fatalf("fixed hot rule did not use scanner: %s", p.re)
		}
	}
	for _, source := range []string{`(?i:a)b`, `a*`, `^a`, `(a|b|c|d|e|f|g|h|i){4}`} {
		if mustRegex(source).trie != nil {
			t.Fatalf("unsafe finite expansion: %s", source)
		}
	}
	p := mustRegex(`(?i)解析.{0,4}文件|debug.*失败`)
	if len(p.guards) == 0 || p.possible("项目需求和执行记录") {
		t.Fatal("necessary-literal rejection not applied")
	}
}

// The oracle is Go's existing RE2 path, including its empty-match behavior.
// Seeded cases run in ordinary CI; fuzzing explores expression/text mutations.
func FuzzFastRegex(f *testing.F) {
	for _, seed := range [][2]string{
		{`a|ab`, "ababa"}, {`a??ab`, "aaab"}, {`(?i)requirements?`, "REQUIREMENTS requirement"},
		{`(?i)k|s`, "KſkS"}, {`(?i:a)b`, "Ab AB"}, {`a|`, "aaa"},
		{`(?i)解析.{0,4}文件|debug.*失败`, "解析😀😀文件"}, {`[，,；;？?]|以及`, "，以及"},
	} {
		f.Add(seed[0], seed[1])
	}
	f.Fuzz(func(t *testing.T, source, input string) {
		if len(source) > 256 || len(input) > 2048 {
			t.Skip()
		}
		p, err := compileRegex(source)
		if err != nil {
			return
		}
		text := regexText(input)
		if p.MatchString(text) != p.re.MatchString(text) {
			t.Fatalf("match mismatch %q %q", source, input)
		}
		for _, n := range []int{-1, 0, 1, 3} {
			if !reflect.DeepEqual(p.FindAllStringIndex(text, n), p.re.FindAllStringIndex(text, n)) {
				t.Fatalf("indices mismatch %q %q n=%d", source, input, n)
			}
			if !reflect.DeepEqual(p.FindAllString(text, n), p.re.FindAllString(text, n)) {
				t.Fatalf("strings mismatch %q %q n=%d", source, input, n)
			}
		}
	})
}
