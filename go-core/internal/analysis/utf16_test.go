package analysis

import (
	"math/rand"
	"strings"
	"testing"
	"unicode/utf16"
	"unicode/utf8"
)

// Preserve the original UTF-16 conversion as an independent reference,
// including malformed UTF-8, supplementary characters and reserved runes.
func TestUTF16TextCompatibility(t *testing.T) {
	check := func(s string) {
		t.Helper()
		units := utf16.Encode([]rune(s))
		var want strings.Builder
		for _, u := range units {
			r := rune(u)
			if u >= 0xd800 && u <= 0xdfff {
				r += 0x100000
			}
			want.WriteRune(r)
		}
		if jsLen(s) != len(units) || regexText(s) != want.String() {
			t.Fatalf("UTF-16 mismatch for %q", s)
		}
	}
	for _, s := range []string{"", "项目约束", "😀\ufffd\U0010d800", "\xff\xfe\xc0\x80", "a\xed\xa0\x80b", "\xf0\x90", "x\ufffd\xff"} {
		check(s)
	}
	var all strings.Builder
	for r := rune(0); r <= utf8.MaxRune; r++ {
		if utf8.ValidRune(r) {
			all.WriteRune(r)
		}
	}
	check(all.String())
	rng := rand.New(rand.NewSource(7413))
	for i := 0; i < 1000; i++ {
		data := make([]byte, rng.Intn(256))
		_, _ = rng.Read(data)
		check(string(data))
	}
}

func TestLiteralStartFilterMatchesRawUTF8(t *testing.T) {
	for _, source := range []string{"(?i)k|s|Σ", "\ufffd|文", "文|a", "(?i)é|Ö"} {
		p := mustRegex(source)
		for _, text := range []string{"\xff\x80文", "éÖKſς", "\xc0\xaf\ufffd", "\xe6\x96\x87", "\xe6\x96a", "x\ufffd文"} {
			got, want := p.FindAllString(text, -1), p.re.FindAllString(text, -1)
			if strings.Join(got, "|") != strings.Join(want, "|") {
				t.Fatalf("raw UTF-8 mismatch: %q %q", source, text)
			}
		}
	}
}
