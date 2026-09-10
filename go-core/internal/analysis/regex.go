package analysis

import (
	"strings"
	"unicode/utf16"
)

// Node's rules have no /u flag: dot and bounded repetitions count UTF-16
// units. Represent surrogate units as reserved valid runes for the RE2 engine.
// Every original non-BMP rune is encoded, so original input cannot collide.
func regexText(s string) string {
	var b strings.Builder
	for _, u := range utf16.Encode([]rune(s)) {
		if u >= 0xd800 && u <= 0xdfff {
			b.WriteRune(0x100000 + rune(u))
		} else {
			b.WriteRune(rune(u))
		}
	}
	return b.String()
}
func regexSource(s string) string {
	s = regexText(s)
	var b strings.Builder
	escaped, inClass := false, false
	for _, r := range s {
		if escaped {
			b.WriteRune(r)
			escaped = false
			continue
		}
		if r == '\\' {
			b.WriteRune(r)
			escaped = true
			continue
		}
		if r == '[' {
			inClass = true
		}
		if r == ']' {
			inClass = false
		}
		if r == '.' && !inClass {
			b.WriteString(`[^\n\r\x{2028}\x{2029}]`)
		} else {
			b.WriteRune(r)
		}
	}
	return b.String()
}

var toolSearch = mustRegex("search|web|检索|surf")
var toolOps = mustRegex("devops|deploy|ops")
