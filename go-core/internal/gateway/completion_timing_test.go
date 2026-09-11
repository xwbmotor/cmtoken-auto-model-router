package gateway

import (
	"io"
	"strings"
	"testing"
	"time"
)

type completionTimingReader struct {
	chunks []string
	clock  *time.Time
}

func (r *completionTimingReader) Read(p []byte) (int, error) {
	if len(r.chunks) == 0 {
		return 0, io.EOF
	}
	*r.clock = r.clock.Add(10 * time.Millisecond)
	n := copy(p, r.chunks[0])
	r.chunks[0] = r.chunks[0][n:]
	if r.chunks[0] == "" {
		r.chunks = r.chunks[1:]
	}
	return n, nil
}
func (r *completionTimingReader) Close() error { return nil }

func timingBody(chunks ...string) *completionBody {
	start := time.Unix(1000, 0)
	clock := start
	return &completionBody{stream: true, startedAt: start, now: func() time.Time { return clock },
		ReadCloser: &completionTimingReader{chunks: chunks, clock: &clock}}
}

func assertCompletionMS(t *testing.T, name string, got *int64, want int64) {
	t.Helper()
	if got == nil || *got != want {
		t.Fatalf("%s: got %v, want %d", name, got, want)
	}
}

func TestCompletionTimingSeparatesReasoningFromContentAtCompleteEvents(t *testing.T) {
	b := timingBody(": heartbeat\n\ndata: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n",
		"data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"think\"}}]}\n\n",
		"data: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}\n", "\n",
		"data: {\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":2}}\n\ndata: [DONE]\n\n")
	buf := make([]byte, 4096)
	for i := 0; i < 3; i++ {
		if _, err := b.Read(buf); err != nil {
			t.Fatal(err)
		}
	}
	if b.FirstContentMS() != nil {
		t.Fatal("content timestamp preceded SSE blank-line delimiter")
	}
	assertCompletionMS(t, "first output", b.FirstOutputMS(), 20)
	_, _ = io.Copy(io.Discard, b)
	assertCompletionMS(t, "first content", b.FirstContentMS(), 40)
	if !b.Complete() || b.usage == nil || b.usage.Prompt != 10 || b.usage.Completion != 2 {
		t.Fatal("completion or usage changed")
	}
}

func TestCompletionTimingHandlesUTF8ChunkBoundariesAndMultilineSSE(t *testing.T) {
	data := "data: {\"choices\": [\n" + "data: {\"delta\": {\"content\": \"你好\"}}]}\r\n\r\n"
	chunks := make([]string, len(data))
	// Split every byte, including UTF-8 continuation bytes.
	for i := 0; i < len(data); i++ {
		chunks[i] = data[i : i+1]
	}
	b := timingBody(chunks...)
	_, _ = io.Copy(io.Discard, b)
	assertCompletionMS(t, "UTF8 content", b.FirstContentMS(), int64(len(data)*10))
	assertCompletionMS(t, "UTF8 output", b.FirstOutputMS(), int64(len(data)*10))
}

func TestCompletionTimingToolAndFunctionOnlyHaveNoContentTTFT(t *testing.T) {
	for _, fragment := range []string{`"tool_calls":[{"index":0,"function":{"name":"f"}}]`, `"function_call":{"name":"f"}`, `"reasoning":"think"`} {
		b := timingBody("data: {\"choices\":[{\"delta\":{" + fragment + "}}]}\n\ndata: [DONE]\n\n")
		_, _ = io.Copy(io.Discard, b)
		if b.FirstContentMS() != nil {
			t.Fatal("non-content output assigned content TTFT")
		}
		assertCompletionMS(t, "non-content output", b.FirstOutputMS(), 10)
	}
}

func TestCompletionTimingIgnoresEmptyOtherChoicesMalformedAndIncompleteEvents(t *testing.T) {
	for _, data := range []string{
		"data: {\"choices\":[{\"delta\":{}},{\"delta\":{\"content\":\"other\"}}]}\n\n",
		"data: {\"choices\":[{\"delta\":{\"content\":\"\",\"function_call\":{}}}]}\n\n",
		"data: {bad}\n\ndata: [DONE]\n\n",
		"data: {\"choices\":[{\"delta\":{\"content\":\"incomplete\"}}]}\n",
		"data: {\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":2}}\n\n",
	} {
		b := timingBody(data)
		_, _ = io.Copy(io.Discard, b)
		if b.FirstContentMS() != nil || b.FirstOutputMS() != nil {
			t.Fatalf("unexpected timing for %s", data)
		}
	}
}

func TestCompletionTimingEventMemoryBoundAndRecovery(t *testing.T) {
	b := timingBody(strings.Repeat("data: "+strings.Repeat("x", 1000)+"\n", 100), "\n",
		"data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n")
	buf := make([]byte, 128*1024)
	_, _ = b.Read(buf)
	if len(b.timingEvent) > 65536 || !b.timingEventOverflow || b.FirstContentMS() != nil {
		t.Fatal("oversize SSE event was not bounded/ignored")
	}
	_, _ = io.Copy(io.Discard, b)
	assertCompletionMS(t, "recovery", b.FirstContentMS(), 30)
}

func TestCompletionTimingNonstreamAndUnsetStart(t *testing.T) {
	start := time.Unix(1000, 0)
	for _, enabled := range []bool{true, false} {
		b := &completionBody{ReadCloser: io.NopCloser(strings.NewReader(`{"choices":[{"message":{"content":"hello"}}],"usage":{"prompt_tokens":10,"completion_tokens":2}}`)), now: func() time.Time { return start.Add(25 * time.Millisecond) }}
		if enabled {
			b.startedAt = start
		}
		_, _ = io.Copy(io.Discard, b)
		if !b.Complete() || b.usage == nil {
			t.Fatal("nonstream completion changed")
		}
		if enabled {
			assertCompletionMS(t, "nonstream", b.FirstContentMS(), 25)
		} else if b.FirstContentMS() != nil {
			t.Fatal("unset start generated a fake duration")
		}
	}
}
