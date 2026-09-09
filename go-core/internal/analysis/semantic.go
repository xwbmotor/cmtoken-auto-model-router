package analysis

import (
	"encoding/json"
	"errors"
	"unicode/utf16"
)

func ClassifierText(raw []byte) (string, error) {
	var body map[string]any
	if json.Unmarshal(raw, &body) != nil || body == nil {
		return "", errors.New("invalid request JSON")
	}
	_, text, _ := texts(body)
	return text, nil
}
func UTF16Length(s string) int { return jsLen(s) }
func TailText(s string, limit int) string {
	u := utf16.Encode([]rune(s))
	if limit > 0 && len(u) > limit {
		u = u[len(u)-limit:]
	}
	return string(utf16.Decode(u))
}
func HeadText(s string, limit int) string {
	u := utf16.Encode([]rune(s))
	if len(u) > limit {
		u = u[:limit]
	}
	return string(utf16.Decode(u))
}

// Reclassifying a request preserves complete capacity and capability facts.
func Reclassify(base Result, raw []byte, task, tier string, complexity, confidence float64, reason string) Result {
	result := base
	result.Task = task
	result.Tier = tier
	result.Complexity = complexity
	result.Confidence = confidence
	if base.Requirements["tools"] {
		result.Task = "agent"
	} else {
		result.SubTask = nil
		text, _ := ClassifierText(raw)
		for _, r := range subPatterns[task] {
			if r.Pattern.MatchString(regexText(text)) {
				s := r.Name
				result.SubTask = &s
				break
			}
		}
	}
	result.Signals = append(append([]Signal{}, base.Signals...), Signal{Key: "semantic_review", Label: "语义复核：" + reason, Contribution: round3(complexity - base.Complexity)})
	return result
}
