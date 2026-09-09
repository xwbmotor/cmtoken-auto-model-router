package gateway

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
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
		}
	}
	return n, e
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
