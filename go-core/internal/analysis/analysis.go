// Package analysis implements the request semantics of the Node L1 reference.
package analysis

import (
	"bytes"
	"encoding/json"
	"errors"
	"math"
	"strconv"
	"strings"
	"unicode/utf16"
)

type Config struct {
	SemanticRequired bool `json:"semanticRequired"`
	TaskRules        struct {
		SimpleMaxComplexity  float64             `json:"simpleMaxComplexity"`
		ComplexMinComplexity float64             `json:"complexMinComplexity"`
		Patterns             map[string][]string `json:"patterns"`
	} `json:"taskRules"`
	Budget struct {
		DefaultEstimatedOutputTokens any `json:"defaultEstimatedOutputTokens"`
	} `json:"budget"`
}
type Signal struct {
	Key          string  `json:"key"`
	Label        string  `json:"label"`
	Contribution float64 `json:"contribution"`
}
type Capacity struct {
	EstimatedInputTokens   float64 `json:"estimatedInputTokens"`
	EstimatedOutputTokens  float64 `json:"estimatedOutputTokens"`
	EstimatedContextTokens float64 `json:"estimatedContextTokens"`
	CapacityEstimate       struct {
		Method               string `json:"method"`
		UnknownMediaParts    int    `json:"unknownMediaParts"`
		EstimatedMediaTokens int    `json:"estimatedMediaTokens"`
	} `json:"capacityEstimate"`
}
type Result struct {
	Task              string          `json:"task"`
	SubTask           *string         `json:"subTask"`
	Tier              string          `json:"tier"`
	Complexity        float64         `json:"complexity"`
	Confidence        float64         `json:"confidence"`
	ConfidenceFactors []string        `json:"confidenceFactors"`
	TextLength        int             `json:"textLength"`
	Requirements      map[string]bool `json:"requirements"`
	Signals           []Signal        `json:"signals"`
	Capacity
}
type Rule struct {
	Name    string
	Pattern *fastRegex
}
type Analyzer struct {
	config   Config
	patterns []Rule
}

func New(c Config) (*Analyzer, error) {
	if math.IsNaN(c.TaskRules.SimpleMaxComplexity) || math.IsNaN(c.TaskRules.ComplexMinComplexity) || c.TaskRules.SimpleMaxComplexity < 0 || c.TaskRules.ComplexMinComplexity > 1 || c.TaskRules.SimpleMaxComplexity >= c.TaskRules.ComplexMinComplexity {
		return nil, errors.New("invalid complexity thresholds")
	}
	a := &Analyzer{config: c}
	for _, r := range taskPatterns {
		source := r.source
		if p := c.TaskRules.Patterns[r.name]; len(p) > 0 {
			source = strings.Join(p, "|")
		}
		compiled, err := compileRegex("(?i)" + strings.ReplaceAll(source, `\/`, `/`))
		if err != nil {
			return nil, errors.New("task pattern is not supported by Go RE2: " + r.name)
		}
		a.patterns = append(a.patterns, Rule{r.name, compiled})
	}
	// Unknown task labels cannot enter the typed decision contract.
	for key, p := range c.TaskRules.Patterns {
		found := false
		for _, r := range taskPatterns {
			if r.name == key {
				found = true
			}
		}
		if !found && len(p) > 0 {
			return nil, errors.New("unsupported task label: " + key)
		}
	}
	return a, nil
}
func jsLen(s string) int { return len(utf16.Encode([]rune(s))) }
func truth(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case float64:
		return x != 0
	default:
		return true
	}
}
func object(v any) map[string]any { m, _ := v.(map[string]any); return m }
func array(v any) []any           { a, _ := v.([]any); return a }
func str(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}
func flatten(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	parts := []string{}
	for _, p := range array(v) {
		if s, ok := p.(string); ok {
			parts = append(parts, s)
		} else {
			parts = append(parts, str(object(p)["text"]))
		}
	}
	return strings.Join(parts, "\n")
}
func texts(body map[string]any) (string, string, int) {
	full := []string{}
	users := []string{}
	for _, m := range array(body["messages"]) {
		o := object(m)
		s := flatten(o["content"])
		full = append(full, s)
		if o["role"] == "user" {
			users = append(users, s)
		}
	}
	count := len(users)
	if count == 0 {
		return strings.Join(full, "\n"), strings.Join(full, "\n"), 0
	}
	if count > 3 {
		users = users[count-3:]
	}
	return strings.Join(full, "\n"), strings.Join(users, "\n"), count
}
func number(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case bool:
		if x {
			return 1
		}
		return 0
	case nil:
		return 0
	case string:
		n, e := strconv.ParseFloat(strings.TrimSpace(x), 64)
		if e == nil {
			return n
		}
	case []any:
		if len(x) == 0 {
			return 0
		}
		if len(x) == 1 {
			return number(x[0])
		}
	}
	return math.NaN()
}
func encode(v any) []byte {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	_ = e.Encode(v)
	s := strings.TrimSuffix(b.String(), "\n")
	s = strings.ReplaceAll(strings.ReplaceAll(s, `\u2028`, "\u2028"), `\u2029`, "\u2029")
	return []byte(s)
}
func capacity(body map[string]any, c Config) Capacity {
	result := Capacity{}
	result.CapacityEstimate.Method = "heuristic"
	var scrub func(any) any
	scrub = func(v any) any {
		switch x := v.(type) {
		case []any:
			out := make([]any, len(x))
			for i, p := range x {
				out[i] = scrub(p)
			}
			return out
		case map[string]any:
			switch str(x["type"]) {
			case "image_url", "input_image", "input_audio", "audio", "video", "video_url", "file":
				result.CapacityEstimate.UnknownMediaParts++
				return map[string]any{"type": x["type"], "media": "[opaque]"}
			}
			out := map[string]any{}
			for k, p := range x {
				out[k] = scrub(p)
			}
			return out
		default:
			return v
		}
	}
	input := map[string]any{}
	for _, k := range []string{"messages", "tools", "functions", "tool_choice", "function_call", "response_format"} {
		if v, ok := body[k]; ok {
			input[k] = scrub(v)
		}
	}
	text := string(encode(input))
	cjk := 0
	for _, r := range text {
		if r >= 0x3400 && r <= 0x9fff {
			cjk++
		}
	}
	result.CapacityEstimate.EstimatedMediaTokens = result.CapacityEstimate.UnknownMediaParts * 4096
	result.EstimatedInputTokens = math.Max(1, math.Ceil(float64(cjk)/1.6+float64(jsLen(text)-cjk)/4)) + float64(result.CapacityEstimate.EstimatedMediaTokens)
	result.EstimatedOutputTokens = 800
	for _, v := range []any{body["max_completion_tokens"], body["max_tokens"], c.Budget.DefaultEstimatedOutputTokens} {
		n := number(v)
		if !math.IsNaN(n) && !math.IsInf(n, 0) && n > 0 {
			result.EstimatedOutputTokens = math.Ceil(n)
			break
		}
	}
	result.EstimatedContextTokens = result.EstimatedInputTokens + result.EstimatedOutputTokens
	return result
}

var structural = mustRegex("(?i)```|步骤|约束|要求|目标|前提|保证|同时|并且|必须|however|constraints?|requirements?")
var objectives = mustRegex("成本|费用|质量|效果|时延|延迟|效率|性能|可用性|稳定性|框架|开源|兼容|协议|部署|安全|并发|扩展性")
var clauses = mustRegex("[，,；;？?]|以及|同时|并且|或者")
var trivialRE = mustRegex(`^(请问)?(今天|现在|当前)?(是)?(星期几|周几|几号|日期是什么|几点了)[？?。\s]*$`)
var negation = mustRegex("不要|不用|无需|禁止|避免|并非|而不是|暂不|先不|别写|别用|别管|别生成|别给")
var meta = mustRegex("什么是|通俗.{0,6}(语言|方式|词语|地)?(解释|讲解|介绍|说明)|(总结|概括|翻译|改写|解释|讲解|评审意见)(一下|下)?[^。？！]{0,10}(这段|上述|下面|以上|该段|这份)|科普")

func negated(text string, re *fastRegex) bool {
	scopes := [][2]int{}
	for _, m := range negation.FindAllStringIndex(text, -1) {
		end := m[1]
		units := 0
		for _, r := range text[end:] {
			if strings.ContainsRune("，。；、,.;:？！?！\n", r) || units >= 10 {
				break
			}
			if r >= 0x10d800 && r <= 0x10dfff {
				units++
			} else {
				units += jsLen(string(r))
			}
			end += len(string(r))
		}
		scopes = append(scopes, [2]int{m[0], end})
	}
	if len(scopes) == 0 {
		return false
	}
	matches := re.FindAllStringIndex(text, -1)
	if len(matches) == 0 {
		return false
	}
	for _, m := range matches {
		found := false
		for _, s := range scopes {
			if m[0] >= s[0] && m[0] < s[1] {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}
func round3(v float64) float64 {
	s := strconv.FormatFloat(v, 'f', 3, 64)
	n, _ := strconv.ParseFloat(s, 64)
	return n
}
func (a *Analyzer) Analyze(raw []byte) (Result, error) {
	var body map[string]any
	if json.Unmarshal(raw, &body) != nil || body == nil {
		return Result{}, errors.New("invalid request JSON")
	}
	messages, ok := body["messages"].([]any)
	if !ok || len(messages) == 0 {
		return Result{}, errors.New("invalid messages")
	}
	for _, m := range messages {
		if _, ok := object(m)["role"].(string); !ok {
			return Result{}, errors.New("invalid message role")
		}
	}
	full, text, userTurns := texts(body)
	fullLength, textLength := jsLen(full), jsLen(text)
	full, text = regexText(full), regexText(text)
	task := "default"
	var winner *fastRegex
	matched := 0
	for _, r := range a.patterns {
		if r.Pattern.MatchString(text) {
			matched++
			if task == "default" {
				task = r.Name
				winner = r.Pattern
			}
		}
	}
	trivial := userTurns == 1 && trivialRE.MatchString(strings.TrimSpace(text))
	result := Result{Task: task, ConfidenceFactors: []string{}, Signals: []Signal{}, TextLength: textLength, Capacity: capacity(body, a.config)}
	add := func(key, label string, v float64) {
		if v > 0 {
			result.Signals = append(result.Signals, Signal{key, label, round3(v)})
		}
	}
	base := map[string]float64{"default": .1, "coding": .3, "reasoning": .38, "creative": .22, "extraction": .14}[task]
	label := "任务类型：" + task
	if trivial {
		base = .08
		label = "直接事实查询"
	}
	add("task_base", label, base)
	length := fullLength
	size := 0.
	switch {
	case length > 1500:
		size = .32
	case length > 500:
		size = .22
	case length > 200:
		size = .14
	case length > 80:
		size = .07
	}
	add("length", "输入长度 "+strconv.Itoa(length)+" 字符", size)
	turns := len(messages)
	add("turns", "多轮上下文 "+strconv.Itoa(turns)+" 条消息", math.Min(.12, math.Max(0, float64(turns-2))*.02))
	count := len(structural.FindAllString(full, -1))
	add("structure", strconv.Itoa(count)+" 个约束或结构信号", math.Min(.15, float64(count)*.03))
	unique := map[string]bool{}
	for _, s := range objectives.FindAllString(full, -1) {
		unique[s] = true
	}
	add("objectives", strconv.Itoa(len(unique))+" 个优化维度", math.Min(.18, float64(len(unique))*.025))
	count = len(clauses.FindAllString(full, -1))
	add("clauses", strconv.Itoa(count+1)+" 个问题分句", math.Min(.12, math.Max(0, float64(count-1))*.018))
	vision := false
	for _, m := range messages {
		for _, p := range array(object(m)["content"]) {
			typ := str(object(p)["type"])
			vision = vision || typ == "image_url" || typ == "input_image"
		}
	}
	req := map[string]bool{"chat": true, "stream": truth(body["stream"]), "tools": len(array(body["tools"])) > 0, "json": truth(body["response_format"]), "vision": vision}
	result.Requirements = req
	capSignal := 0.
	if req["tools"] {
		capSignal += .05
	}
	if vision {
		capSignal += .04
	}
	if req["json"] {
		capSignal += .03
	}
	add("capabilities", "需要特殊模型能力", capSignal)
	for _, s := range result.Signals {
		result.Complexity += s.Contribution
	}
	result.Complexity = round3(math.Min(1, result.Complexity))
	result.Tier = "balanced"
	if result.Complexity >= a.config.TaskRules.ComplexMinComplexity {
		result.Tier = "complex"
	} else if result.Complexity <= a.config.TaskRules.SimpleMaxComplexity {
		result.Tier = "simple"
	}
	for _, r := range subPatterns[task] {
		if r.Pattern.MatchString(text) {
			s := r.Name
			result.SubTask = &s
			break
		}
	}
	if req["tools"] {
		result.Task = "agent"
		names := []string{}
		for _, t := range array(body["tools"]) {
			o := object(t)
			name := str(object(o["function"])["name"])
			if name == "" {
				name = str(o["name"])
			}
			names = append(names, name)
		}
		s := "workflow-execution"
		toolText := strings.ToLower(strings.Join(names, " "))
		if toolSearch.MatchString(toolText) {
			s = "web-search"
		} else if toolOps.MatchString(toolText) {
			s = "devops"
		}
		result.SubTask = &s
	}
	result.Confidence = .55
	if task != "default" {
		result.Confidence = .86
		trimmed := strings.TrimSpace(text)
		if negated(trimmed, winner) {
			result.Confidence -= .35
			result.ConfidenceFactors = append(result.ConfidenceFactors, "negation")
		}
		if meta.MatchString(trimmed) {
			result.Confidence -= .25
			result.ConfidenceFactors = append(result.ConfidenceFactors, "meta-discussion")
		}
		if matched >= 2 {
			result.Confidence -= .2 * float64(matched-1)
			result.ConfidenceFactors = append(result.ConfidenceFactors, "multi-task-conflict")
		}
	}
	result.Confidence = round3(math.Min(.9, math.Max(.3, result.Confidence)))
	if trivial {
		result.Confidence = .98
		result.ConfidenceFactors = []string{}
	}
	return result, nil
}
