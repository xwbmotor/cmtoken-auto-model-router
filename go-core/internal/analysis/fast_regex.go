package analysis

import (
	"regexp"
	"regexp/syntax"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Only bounded, nonempty finite expressions use the trie. Other expressions
// retain RE2, optionally preceded by a necessary-literal rejection filter.
// Compilation and traversal preserve leftmost-first alternative priority.
type fastRegex struct {
	re           *regexp.Regexp
	trie         *literalNode
	fold         bool
	guards       []string
	starts       [256]bool
	filterStarts bool
}
type literalNode struct {
	next map[rune]*literalNode
	rank int
}

const literalLimit = 256

func foldRune(r rune) rune {
	best := r
	for n := unicode.SimpleFold(r); n != r; n = unicode.SimpleFold(n) {
		if n < best {
			best = n
		}
	}
	return best
}
func folded(s string) string { return strings.Map(foldRune, s) }

func compileRegex(source string) (*fastRegex, error) {
	source = regexSource(source)
	re, err := regexp.Compile(source)
	if err != nil {
		return nil, err
	}
	p := &fastRegex{re: re}
	ast, err := syntax.Parse(source, syntax.Perl)
	if err != nil {
		return p, nil
	}
	mode := -1
	if words, ok := finiteWords(ast, &mode); ok {
		root := &literalNode{rank: -1}
		for rank, word := range words {
			if word == "" {
				return p, nil
			} // RE2 owns empty-match semantics.
			node := root
			for _, r := range word {
				if mode == 1 {
					r = foldRune(r)
				}
				if node.next == nil {
					node.next = map[rune]*literalNode{}
				}
				if node.next[r] == nil {
					node.next[r] = &literalNode{rank: -1}
				}
				node = node.next[r]
			}
			if node.rank < 0 {
				node.rank = rank
			}
		}
		p.trie, p.fold = root, mode == 1
		p.filterStarts = true
		for r := range root.next {
			// Invalid UTF-8 is one RuneError per byte in RE2. Keep rune
			// traversal for this case instead of entering a continuation byte.
			if r == utf8.RuneError {
				p.filterStarts = false
			}
			p.starts[string(r)[0]] = true
			if p.fold {
				for c := unicode.SimpleFold(r); c != r; c = unicode.SimpleFold(c) {
					p.starts[string(c)[0]] = true
				}
			}
		}
	} else {
		p.guards = requiredLiterals(ast)
	}
	return p, nil
}
func mustRegex(source string) *fastRegex {
	p, err := compileRegex(source)
	if err != nil {
		panic(err)
	}
	return p
}

// Reject mixed case-sensitive/insensitive finite expressions conservatively.
// Non-cased runes do not constrain the mode. Large expansions fall back to RE2.
func finiteWords(r *syntax.Regexp, mode *int) ([]string, bool) {
	switch r.Op {
	case syntax.OpEmptyMatch:
		return []string{""}, true
	case syntax.OpLiteral:
		for _, c := range r.Rune {
			if unicode.SimpleFold(c) == c {
				continue
			}
			m := 0
			if r.Flags&syntax.FoldCase != 0 {
				m = 1
			}
			if *mode >= 0 && *mode != m {
				return nil, false
			}
			*mode = m
		}
		return []string{string(r.Rune)}, len(r.Rune) <= literalLimit
	case syntax.OpCharClass:
		var words []string
		for i := 0; i < len(r.Rune); i += 2 {
			if r.Rune[i+1]-r.Rune[i] >= literalLimit {
				return nil, false
			}
			for c := r.Rune[i]; c <= r.Rune[i+1]; c++ {
				// Case-folded classes have already been expanded by the parser.
				// Leave all cased classes to RE2 to avoid changing scoped flags.
				if unicode.SimpleFold(c) != c {
					return nil, false
				}
				words = append(words, string(c))
				if len(words) > literalLimit {
					return nil, false
				}
			}
		}
		return words, true
	case syntax.OpCapture:
		return finiteWords(r.Sub[0], mode)
	case syntax.OpQuest:
		words, ok := finiteWords(r.Sub[0], mode)
		if !ok || len(words) >= literalLimit {
			return nil, false
		}
		if r.Flags&syntax.NonGreedy != 0 {
			return append([]string{""}, words...), true
		}
		return append(words, ""), true
	case syntax.OpAlternate, syntax.OpConcat:
		var words []string
		if r.Op == syntax.OpConcat {
			words = []string{""}
		}
		for _, sub := range r.Sub {
			next, ok := finiteWords(sub, mode)
			if !ok {
				return nil, false
			}
			if r.Op == syntax.OpAlternate {
				if len(words)+len(next) > literalLimit {
					return nil, false
				}
				words = append(words, next...)
			} else {
				if len(words)*len(next) > literalLimit {
					return nil, false
				}
				var product []string
				for _, a := range words {
					for _, b := range next {
						if len(a)+len(b) > literalLimit*4 {
							return nil, false
						}
						product = append(product, a+b)
					}
				}
				words = product
			}
		}
		return words, true
	}
	return nil, false
}

// Every successful match must contain at least one returned literal. Case
// folding is deliberately a superset filter, never a replacement for RE2 here.
func requiredLiterals(r *syntax.Regexp) []string {
	switch r.Op {
	case syntax.OpLiteral:
		if len(r.Rune) > 0 {
			return []string{folded(string(r.Rune))}
		}
	case syntax.OpCapture, syntax.OpPlus:
		return requiredLiterals(r.Sub[0])
	case syntax.OpRepeat:
		if r.Min > 0 {
			return requiredLiterals(r.Sub[0])
		}
	case syntax.OpConcat:
		var best []string
		score := 0
		for _, sub := range r.Sub {
			words := requiredLiterals(sub)
			min := int(^uint(0) >> 1)
			for _, w := range words {
				if len(w) < min {
					min = len(w)
				}
			}
			if len(words) > 0 && min > score {
				best, score = words, min
			}
		}
		return best
	case syntax.OpAlternate:
		var words []string
		for _, sub := range r.Sub {
			next := requiredLiterals(sub)
			if len(next) == 0 || len(words)+len(next) > literalLimit {
				return nil
			}
			words = append(words, next...)
		}
		return words
	}
	return nil
}
func (p *fastRegex) possible(text string) bool {
	if len(p.guards) == 0 {
		return true
	}
	text = folded(text)
	for _, word := range p.guards {
		if strings.Contains(text, word) {
			return true
		}
	}
	return false
}
func (p *fastRegex) first(text string, from int) (int, int) {
	for start := from; start < len(text); {
		if p.filterStarts {
			// A valid literal starts at an ASCII or UTF-8 leading byte,
			// never a continuation byte. No decoding/folding is needed
			// for bytes that cannot begin any alternative.
			for start < len(text) && !p.starts[text[start]] {
				start++
			}
			if start == len(text) {
				break
			}
		}
		node, end, rank := p.trie, -1, literalLimit
		for offset, c := range text[start:] {
			width := utf8.RuneLen(c)
			if c == utf8.RuneError {
				_, width = utf8.DecodeRuneInString(text[start+offset:])
			}
			if p.fold {
				c = foldRune(c)
			}
			node = node.next[c]
			if node == nil {
				break
			}
			if node.rank >= 0 && node.rank < rank {
				rank, end = node.rank, start+offset+width
			}
		}
		if end >= 0 {
			return start, end
		}
		_, width := utf8.DecodeRuneInString(text[start:])
		start += width
	}
	return -1, -1
}
func (p *fastRegex) MatchString(text string) bool {
	if p.trie != nil {
		start, _ := p.first(text, 0)
		return start >= 0
	}
	return p.possible(text) && p.re.MatchString(text)
}
func (p *fastRegex) FindAllStringIndex(text string, n int) [][]int {
	if p.trie == nil {
		if !p.possible(text) {
			return nil
		}
		return p.re.FindAllStringIndex(text, n)
	}
	var matches [][]int
	for from := 0; n < 0 || len(matches) < n; {
		start, end := p.first(text, from)
		if start < 0 {
			break
		}
		matches = append(matches, []int{start, end})
		from = end
	}
	return matches
}
func (p *fastRegex) FindAllString(text string, n int) []string {
	if p.trie == nil {
		if !p.possible(text) {
			return nil
		}
		return p.re.FindAllString(text, n)
	}
	var matches []string
	for from := 0; n < 0 || len(matches) < n; {
		start, end := p.first(text, from)
		if start < 0 {
			break
		}
		matches = append(matches, text[start:end])
		from = end
	}
	return matches
}
