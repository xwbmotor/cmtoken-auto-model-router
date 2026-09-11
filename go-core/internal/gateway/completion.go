package gateway

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
)

// Observe a bounded copy without delaying any upstream bytes. A broken or
// unrecognizable response may be forwarded but must never establish stickiness.
type completionBody struct {
	io.ReadCloser
	stream, done, eof, overflow bool
	output                      bool
	pending                     []byte
	data                        []byte
	usage                       *tokenUsage
	onRead                      func()
	startedAt                   time.Time
	now                         func() time.Time
	firstContentMs              *int64
	firstOutputMs               *int64
	timingEvent                 []byte
	timingEventOverflow         bool
}

func (b *completionBody) Read(p []byte) (int, error) {
	n, e := b.ReadCloser.Read(p)
	if n > 0 && b.onRead != nil {
		b.onRead()
	}
	if b.stream {
		if !b.overflow {
			b.pending = append(b.pending, p[:n]...)
			for {
				i := bytes.IndexByte(b.pending, '\n')
				if i < 0 {
					break
				}
				line := strings.TrimSuffix(string(b.pending[:i]), "\r")
				b.observeTimingLine(line)
				if strings.HasPrefix(line, "data:") && strings.TrimSpace(strings.TrimPrefix(line, "data:")) == "[DONE]" {
					b.done = true
				}
				if strings.HasPrefix(line, "data:") {
					if u := parseUsage([]byte(strings.TrimSpace(strings.TrimPrefix(line, "data:")))); u != nil {
						b.usage = u
					}
				}
				if strings.HasPrefix(line, "data:") && hasOutput([]byte(strings.TrimSpace(strings.TrimPrefix(line, "data:")))) {
					b.output = true
				}
				b.pending = b.pending[i+1:]
			}
			if len(b.pending) > 65536 {
				b.pending = nil
				b.timingEvent = nil
				b.timingEventOverflow = true
				b.overflow = true
			}
		}
	} else if !b.overflow {
		if len(b.data)+n > MaxBodyBytes {
			b.data = nil
			b.overflow = true
		} else {
			b.data = append(b.data, p[:n]...)
		}
	}
	if e == io.EOF {
		b.eof = true
		if !b.stream && !b.overflow {
			b.usage = parseUsage(b.data)
			b.observeOutputTiming(b.data)
		}
	}
	return n, e
}

// Nil means no corresponding output was observed. Content TTFT is intentionally
// distinct from reasoning/tool output and from onRead's first-byte timestamp.
func (b *completionBody) FirstContentMS() *int64 { return b.firstContentMs }
func (b *completionBody) FirstOutputMS() *int64  { return b.firstOutputMs }

func (b *completionBody) observeTimingLine(line string) {
	if b.firstContentMs != nil {
		return
	}
	if line == "" {
		if !b.timingEventOverflow && len(b.timingEvent) != 0 {
			b.observeOutputTiming(b.timingEvent)
		}
		b.timingEvent = nil
		b.timingEventOverflow = false
		return
	}
	if !strings.HasPrefix(line, "data:") || b.timingEventOverflow {
		return
	}
	data := strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " ")
	if len(b.timingEvent)+len(data)+1 > 65536 {
		b.timingEvent = nil
		b.timingEventOverflow = true
		return
	}
	if len(b.timingEvent) != 0 {
		b.timingEvent = append(b.timingEvent, '\n')
	}
	b.timingEvent = append(b.timingEvent, data...)
}

func (b *completionBody) observeOutputTiming(data []byte) {
	if b.startedAt.IsZero() || b.firstContentMs != nil {
		return
	}
	type message struct {
		Content          string                     `json:"content"`
		ReasoningContent string                     `json:"reasoning_content"`
		Reasoning        string                     `json:"reasoning"`
		ToolCalls        []json.RawMessage          `json:"tool_calls"`
		FunctionCall     map[string]json.RawMessage `json:"function_call"`
	}
	var value struct {
		Choices []struct {
			Delta   *message `json:"delta"`
			Message *message `json:"message"`
		} `json:"choices"`
		Error json.RawMessage `json:"error"`
	}
	if json.Unmarshal(data, &value) != nil || len(value.Choices) == 0 || len(value.Error) != 0 {
		return
	}
	m := value.Choices[0].Delta
	if m == nil {
		m = value.Choices[0].Message
	}
	if m == nil {
		return
	}
	content := m.Content != ""
	output := content || m.ReasoningContent != "" || m.Reasoning != "" || len(m.ToolCalls) > 0 || len(m.FunctionCall) > 0
	if !output {
		return
	}
	now := time.Now
	if b.now != nil {
		now = b.now
	}
	ms := max(int64(0), now().Sub(b.startedAt).Milliseconds())
	if b.firstOutputMs == nil {
		b.firstOutputMs = &ms
	}
	if content {
		b.firstContentMs = &ms
	}
}
func (b *completionBody) Complete() bool {
	if !b.eof || b.overflow {
		return false
	}
	if b.stream {
		return b.done && b.output
	}
	return hasOutput(b.data)
}

func hasOutput(data []byte) bool {
	type message struct {
		Content      string            `json:"content"`
		ToolCalls    []json.RawMessage `json:"tool_calls"`
		FunctionCall json.RawMessage   `json:"function_call"`
	}
	var v struct {
		Choices []struct {
			Message message `json:"message"`
			Delta   message `json:"delta"`
			Text    string  `json:"text"`
		} `json:"choices"`
		Error json.RawMessage `json:"error"`
	}
	if json.Unmarshal(data, &v) != nil || len(v.Error) > 0 {
		return false
	}
	for _, c := range v.Choices {
		if strings.TrimSpace(c.Text) != "" {
			return true
		}
		for _, m := range []message{c.Message, c.Delta} {
			if strings.TrimSpace(m.Content) != "" || len(m.ToolCalls) > 0 || (len(m.FunctionCall) > 0 && string(m.FunctionCall) != "null") {
				return true
			}
		}
	}
	return false
}

type deliveryWriter struct {
	http.ResponseWriter
	failed bool
}

func (w *deliveryWriter) Write(p []byte) (int, error) {
	n, e := w.ResponseWriter.Write(p)
	if e != nil || n != len(p) {
		w.failed = true
	}
	return n, e
}
func (w *deliveryWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w *deliveryWriter) FlushError() error {
	e := http.NewResponseController(w.ResponseWriter).Flush()
	if e != nil {
		w.failed = true
	}
	return e
}
