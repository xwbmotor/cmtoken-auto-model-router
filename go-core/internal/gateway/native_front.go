package gateway

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httputil"
	"path"
	"runtime/trace"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

type nativeFrontKey struct{}

// Match Node's public idle policy, including its client-visible lifetime hint.
const NativeIdleTimeout = 300 * time.Second

// NativeFront exposes only the completion handler. Management and compatibility
// requests retain the Node HTTP contract; Go control endpoints stay private.
type NativeFront struct {
	core              http.Handler
	proxy             *httputil.ReverseProxy
	client            *http.Client
	contextURL, token string
	mu                sync.Mutex
	cached            nativeContext
	at                time.Time
}
type nativeContext struct {
	ConfigRevision string                        `json:"configRevision"`
	SessionProof   string                        `json:"sessionProof"`
	MarketSignals  map[string]map[string]float64 `json:"marketSignals"`
}

func NewNativeFront(core http.Handler, nodeURL, token string) (*NativeFront, error) {
	u, err := LoopbackURL(nodeURL)
	if err != nil || u.Path != "" && u.Path != "/" || u.RawQuery != "" || len(token) < 32 || core == nil {
		return nil, errors.New("native front requires fixed loopback Node origin and protected token")
	}
	p := httputil.NewSingleHostReverseProxy(u)
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.Proxy = nil
	t.MaxIdleConnsPerHost = 256
	p.Transport = t
	p.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) { writeError(w, 502, "node_edge_unavailable") }
	return &NativeFront{core: core, proxy: p, client: &http.Client{Transport: t, Timeout: 2 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
		contextURL: strings.TrimSuffix(u.String(), "/") + "/internal/v1/go-context", token: token}, nil
}
func (f *NativeFront) Close() { f.client.CloseIdleConnections() }
func (f *NativeFront) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.ProtoMajor == 1 && !r.Close {
		// Without this hint, clients such as Undici retire an otherwise reusable
		// connection after their shorter default despite our 300-second timeout.
		w.Header().Set("Keep-Alive", "timeout=300")
	}
	if strings.HasPrefix(path.Clean(r.URL.Path), "/internal/") {
		writeError(w, 404, "not_found")
		return
	}
	// Unusual transports and browser-origin policy remain on the established edge.
	if r.Method != "POST" || r.URL.Path != "/v1/chat/completions" || r.URL.RawQuery != "" ||
		r.Header.Get("Origin") != "" || r.Header.Get("Content-Encoding") != "" ||
		!strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
		f.proxy.ServeHTTP(w, r)
		return
	}
	writer := &nativeWriter{ResponseWriter: w, started: time.Now(), status: 200}
	if r.Header.Get("X-Request-ID") == "" || len(r.Header.Get("X-Request-ID")) > 256 {
		id, err := newRequestID()
		if err != nil {
			writeError(w, 503, "request_identity_unavailable")
			return
		}
		r.Header.Set("X-Request-ID", id)
	}
	w.Header().Set("X-Request-ID", r.Header.Get("X-Request-ID"))
	f.core.ServeHTTP(writer, r.WithContext(context.WithValue(r.Context(), nativeFrontKey{}, f)))
}
func (f *NativeFront) current(ctx context.Context) (nativeContext, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if time.Since(f.at) < time.Second {
		return f.cached, nil
	}
	req, _ := http.NewRequestWithContext(ctx, "GET", f.contextURL, nil)
	req.Header.Set("Authorization", "Bearer "+f.token)
	res, err := f.client.Do(req)
	if err != nil {
		return nativeContext{}, errors.New("edge_context_unavailable")
	}
	defer res.Body.Close()
	var c nativeContext
	if res.StatusCode != 200 || decodeStrict(io.LimitReader(res.Body, MaxBodyBytes), &c) != nil || len(c.ConfigRevision) != 66 {
		return c, errors.New("edge_context_unavailable")
	}
	f.cached, f.at = c, time.Now()
	return c, nil
}

type nativeMetadata struct {
	RequestID          string            `json:"requestId"`
	KeyFingerprint     string            `json:"keyFingerprint"`
	SessionFingerprint string            `json:"sessionFingerprint"`
	LatencyScopes      map[string]string `json:"latencyScopes"`
}
type nativeRequest struct {
	messagesValid bool
	Metadata      nativeMetadata             `json:"metadata"`
	Body          map[string]json.RawMessage `json:"body"`
	Events        []edgeEvent                `json:"events"`
}

func (g *Gateway) readNativeEdge(f *NativeFront, r *http.Request, body map[string]json.RawMessage) (*edgeContext, error) {
	defer trace.StartRegion(r.Context(), "gateway.nativeContext").End()
	c, err := f.current(r.Context())
	if err != nil {
		return nil, err
	}
	if c.ConfigRevision != g.options.Bundle.Revision {
		f.mu.Lock()
		f.at = time.Time{}
		f.mu.Unlock()
		c, err = f.current(r.Context())
		if err != nil || c.ConfigRevision != g.options.Bundle.Revision {
			return nil, errors.New("edge_config_revision_mismatch")
		}
	}
	proof := hmac.New(sha256.New, g.options.SemanticBucketSecret)
	proof.Write([]byte("go-native-front-v1"))
	if !hmac.Equal([]byte(c.SessionProof), []byte(hex.EncodeToString(proof.Sum(nil)))) {
		return nil, errors.New("edge_session_secret_mismatch")
	}
	id, err := newRequestID()
	if err != nil {
		return nil, err
	}
	requestID := r.Header.Get("X-Request-ID")
	if requestID == "" || len(requestID) > 256 {
		requestID = id
	}
	key := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
	kh := sha256.Sum256([]byte(key))
	metadata := nativeMetadata{RequestID: requestID, KeyFingerprint: hex.EncodeToString(kh[:])[:8], LatencyScopes: map[string]string{}}
	if session := strings.TrimSpace(r.Header.Get("X-Session-ID")); session != "" {
		h := hmac.New(sha256.New, g.options.SemanticBucketSecret)
		h.Write([]byte("session-fp:" + session))
		metadata.SessionFingerprint = "sidfp:" + hex.EncodeToString(h.Sum(nil))[:16]
	}
	upstreamToken, _ := g.authorize(r.Header.Get("Authorization"))
	base := strings.TrimSuffix(g.upstream.String(), "/chat/completions")
	for model := range g.options.Bundle.Runtime.Prices {
		// Match JSON.stringify without Go's optional HTML escaping.
		var buf bytes.Buffer
		enc := json.NewEncoder(&buf)
		enc.SetEscapeHTML(false)
		_ = enc.Encode([]string{base, upstreamToken, model})
		h := sha256.Sum256(bytes.TrimSuffix(buf.Bytes(), []byte{'\n'}))
		metadata.LatencyScopes[model] = hex.EncodeToString(h[:])[:24]
	}
	delete(body, "__amr_edge")
	return &edgeContext{ID: id, RequestID: requestID, ConfigRevision: c.ConfigRevision, MarketSignals: c.MarketSignals,
		native: &nativeRequest{Metadata: metadata, Body: body, Events: []edgeEvent{}}}, nil
}

// Observe only bounded answer text, never Authorization or raw session IDs.
type nativeWriter struct {
	http.ResponseWriter
	started                       time.Time
	status                        int
	headerMS                      *int64
	firstContentMS, firstOutputMS *int64
	failed                        bool
	pending                       []byte
	answer                        strings.Builder
	answerUnits                   int
	timing                        completionBody
}

func (w *nativeWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w *nativeWriter) WriteHeader(status int) {
	if w.headerMS != nil {
		return
	}
	n := time.Since(w.started).Milliseconds()
	w.headerMS = &n
	w.status = status
	// Final HTTP EOF follows durable accounting and the Node completion ack.
	w.Header().Del("Content-Length")
	w.ResponseWriter.WriteHeader(status)
}
func (w *nativeWriter) Write(data []byte) (int, error) {
	w.timing.startedAt = w.started
	if w.headerMS == nil {
		w.WriteHeader(200)
	}
	n, err := w.ResponseWriter.Write(data)
	if err != nil || n != len(data) {
		w.failed = true
	}
	if w.status >= 200 && w.status < 300 {
		if strings.HasPrefix(w.Header().Get("Content-Type"), "text/event-stream") {
			for _, line := range bytes.SplitAfter(data[:n], []byte{'\n'}) {
				if len(w.pending)+len(line) > 65536 {
					w.pending = nil
					continue
				}
				w.pending = append(w.pending, line...)
				if bytes.HasSuffix(line, []byte{'\n'}) {
					w.timing.observeTimingLine(strings.TrimRight(string(w.pending), "\r\n"))
					w.firstContentMS, w.firstOutputMS = w.timing.FirstContentMS(), w.timing.FirstOutputMS()
					if bytes.HasPrefix(w.pending, []byte("data:")) {
						w.observe(bytes.TrimSpace(w.pending[5:]))
					}
					w.pending = nil
				}
			}
		} else if len(w.pending)+n <= MaxBodyBytes {
			w.pending = append(w.pending, data[:n]...)
		}
	}
	return n, err
}
func (w *nativeWriter) observe(data []byte) {
	var value struct {
		Choices []struct {
			Delta struct {
				Content any `json:"content"`
			} `json:"delta"`
			Message struct {
				Content any `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if json.Unmarshal(data, &value) != nil {
		return
	}
	for i, choice := range value.Choices {
		if i > 0 {
			break
		}
		content := choice.Delta.Content
		if content == nil {
			content = choice.Message.Content
		}
		var text string
		switch v := content.(type) {
		case string:
			text = v
		case []any:
			for _, part := range v {
				if s, ok := part.(string); ok {
					text += s
				}
				if p, ok := part.(map[string]any); ok {
					if s, ok := p["text"].(string); ok {
						text += s
					}
				}
			}
		}
		// Match the existing JavaScript 65,536 UTF-16-unit retention limit,
		// keeping UTF-8 code points intact at the boundary.
		end := 0
		for at, r := range text {
			units := 1
			if r > 0xffff {
				units = 2
			}
			if w.answerUnits+units > 65536 {
				break
			}
			w.answerUnits += units
			end = at + utf8.RuneLen(r)
		}
		w.answer.WriteString(text[:end])
	}
}
func (g *Gateway) finishNative(w *nativeWriter, r *http.Request, edge *edgeContext) {
	defer trace.StartRegion(r.Context(), "gateway.nativeComplete").End()
	if edge == nil || edge.native == nil {
		return
	}
	if !edge.native.messagesValid {
		return
	}
	// Push buffered response bytes before classifying delivery. HTTP EOF still
	// waits for the outcome acknowledgment; flush errors remain failures.
	if w.headerMS != nil {
		if err := http.NewResponseController(w).Flush(); err != nil {
			w.failed = true
		}
	}
	if !strings.HasPrefix(w.Header().Get("Content-Type"), "text/event-stream") {
		w.observe(w.pending)
		w.timing.observeOutputTiming(w.pending)
		w.firstContentMS, w.firstOutputMS = w.timing.FirstContentMS(), w.timing.FirstOutputMS()
	}
	lastOK := len(edge.native.Events) > 0 && edge.native.Events[len(edge.native.Events)-1].Attempt.OK
	payload, err := nativeCompletionPayload(edge, map[string]any{"startedAt": w.started.UnixMilli(), "headerLatencyMs": w.headerMS,
		"timing":     map[string]any{"firstContentMs": w.firstContentMS, "firstOutputMs": w.firstOutputMS},
		"answerText": w.answer.String(), "ok": lastOK && !w.failed && r.Context().Err() == nil && !g.runtime.failed.Load(),
		"clientGone": w.failed || r.Context().Err() != nil, "stream": bytes.Equal(edge.native.Body["stream"], []byte("true")), "status": w.status})
	if err == nil {
		err = g.postEdge(payload)
	}
	if err != nil {
		g.runtime.edgeErrors.Add(1)
		panic(http.ErrAbortHandler)
	}
}

func nativeCompletionPayload(edge *edgeContext, result map[string]any) ([]byte, error) {
	body, err := marshalValidatedObject(edge.native.Body)
	if err != nil {
		return nil, err
	}
	request, err := json.Marshal(struct {
		Metadata nativeMetadata `json:"metadata"`
		Events   []edgeEvent    `json:"events"`
	}{edge.native.Metadata, edge.native.Events})
	if err != nil {
		return nil, err
	}
	// Both envelopes are freshly encoded objects without the appended field.
	// Insert the already validated body without JSON reformatting the history.
	request = append(request[:len(request)-1], `,"body":`...)
	request = append(request, body...)
	request = append(request, '}')
	payload, err := json.Marshal(map[string]any{"kind": "native_complete", "id": edge.ID,
		"configRevision": edge.ConfigRevision, "result": result})
	if err != nil {
		return nil, err
	}
	payload = append(payload[:len(payload)-1], `,"request":`...)
	payload = append(payload, request...)
	return append(payload, '}'), nil
}
