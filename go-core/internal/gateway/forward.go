package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"runtime/trace"
	"strconv"
	"strings"
	"time"

	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/analysis"
	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/decision"
	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/ledger"
	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/resilience"
)

func (g *Gateway) forwardRuntime(w http.ResponseWriter, r *http.Request, body map[string]json.RawMessage, in decision.Input, native analysis.Result, sessionKey, token string) {
	edge, _ := r.Context().Value(edgeContextKey{}).(*edgeContext)
	if edge != nil && edge.adoptedAnalysis != nil {
		native = *edge.adoptedAnalysis
	}
	controller := http.NewResponseController(w)
	defer controller.SetWriteDeadline(time.Time{})
	if g.runtime.failed.Load() {
		writeError(w, 503, "runtime_persistence_unavailable")
		return
	}
	policy := g.options.Bundle.Runtime
	region := trace.StartRegion(r.Context(), "gateway.budgetSnapshot")
	snap := g.runtime.ledger.Snapshot()
	region.End()
	if limit := policy.limit(); limit > 0 {
		in.Runtime.BudgetPressure = float64(snap.PendingMicros+snap.ActualMicros+snap.EstimatedMicros) / float64(limit)
	}
	in.Runtime.Health = g.runtime.health.Snapshot()
	in.Runtime.NowMs = float64(time.Now().UnixMilli())
	region = trace.StartRegion(r.Context(), "gateway.admission")
	d, firstRelease, e := g.admission.SelectSession(in, sessionKey)
	region.End()
	if e != nil {
		decisionError(w, e)
		return
	}
	defer firstRelease()
	id, e := newRequestID()
	if e != nil {
		writeError(w, 503, "request_identity_unavailable")
		return
	}
	w.Header().Set("X-AMR-Request-ID", id)
	if edge != nil {
		w.Header().Set("X-Request-ID", edge.RequestID)
		w.Header().Set("X-Router-Suggested-Model", d.SuggestedModel)
		task, method := in.Analysis.Task, "rules"
		if w.Header().Get("X-AMR-Semantic-Status") == "applied" {
			method = "semantic"
		}
		if in.RequestedModel != in.Policy.AutoModelID {
			task = "explicit"
			method = "explicit"
		}
		w.Header().Set("X-Router-Task", task)
		w.Header().Set("X-Router-Route-Method", method)
		w.Header().Set("X-Router-Cost-Tier", in.Policy.CostTier)
		w.Header().Set("X-Router-Policy-Version", d.ConfigVersion)
		w.Header().Set("X-Router-Policy-Revision", g.options.Bundle.Revision)
		w.Header().Set("X-Router-Quality-Degraded", strconv.FormatBool(d.QualityDegraded))
		w.Header().Set("X-Router-Shadow", strconv.FormatBool(d.Shadow))
		w.Header().Set("X-Router-Reasoning-Level", d.ReasoningLevel)
	}
	order := []string{d.SelectedModel}
	for _, m := range d.FallbackOrder {
		if m != d.SelectedModel {
			order = append(order, m)
		}
	}
	count := policy.MaxAttempts
	if in.RequestedModel != in.Policy.AutoModelID {
		count = 1
	}
	if len(order) > count {
		order = order[:count]
	}
	stream := bytes.Equal(body["stream"], []byte("true"))
	lastStatus, lastCode := 503, "model_capacity_exhausted"
	for index, model := range order {
		if edge != nil {
			w.Header().Set("X-Router-Selected-Model", model)
		}
		if r.Context().Err() != nil {
			return
		}
		if g.runtime.failed.Load() {
			writeError(w, 503, "runtime_persistence_unavailable")
			return
		}
		release := firstRelease
		if index > 0 {
			in.Runtime.Health = g.runtime.health.Snapshot()
			in.Runtime.NowMs = float64(time.Now().UnixMilli())
			var ok bool
			release, ok = g.admission.AcquireModel(in, model)
			if !ok {
				continue
			}
		}
		claim, ok := g.runtime.health.AcquireWithConfig(model, policy.healthConfig())
		if !ok {
			release()
			continue
		}
		// Clone from the caller body on every attempt: model-specific reasoning must
		// not leak from a failed model into the next model's transport parameters.
		outgoing := make(map[string]json.RawMessage, len(body))
		for k, v := range body {
			outgoing[k] = v
		}
		attemptDecision := d
		attemptDecision.SelectedModel = model
		outgoing["model"], _ = json.Marshal(model)
		if e = applyReasoning(outgoing, in, attemptDecision); e != nil {
			claim.Finish(resilience.Outcome{Scope: "configuration"})
			release()
			writeError(w, 502, "unsupported_reasoning_parameter")
			return
		}
		if stream {
			options := map[string]json.RawMessage{}
			if raw, present := outgoing["stream_options"]; present && (json.Unmarshal(raw, &options) != nil || options == nil) {
				claim.Finish(resilience.Outcome{Scope: "configuration"})
				release()
				writeError(w, 400, "invalid_stream_options")
				return
			}
			options["include_usage"] = json.RawMessage("true")
			outgoing["stream_options"], _ = json.Marshal(options)
		}
		payload, _ := json.Marshal(outgoing)
		price := policy.Prices[model]
		estimate := price.estimate(native.EstimatedInputTokens, native.EstimatedOutputTokens, d.ReasoningLevel, policy.CacheHitRatio)
		attemptID := id + "-" + strconv.Itoa(index)
		region = trace.StartRegion(r.Context(), "gateway.reserve")
		e = g.runtime.ledger.Reserve(attemptID, estimate, policy.limit(), "answer")
		region.End()
		if e != nil {
			claim.Finish(resilience.Outcome{Scope: "configuration"})
			release()
			if errors.Is(e, ledger.ErrBudget) {
				writeError(w, 429, "daily_budget_exhausted")
			} else {
				g.runtime.failed.Store(true)
				writeError(w, 503, "runtime_persistence_unavailable")
			}
			return
		}
		if r.Context().Err() != nil {
			if g.runtime.ledger.Release(attemptID) != nil {
				g.runtime.failed.Store(true)
			}
			claim.Finish(resilience.Outcome{ClientGone: true})
			release()
			return
		}
		timeout := time.Duration(policy.RequestTimeoutMS) * time.Millisecond
		ctx, cancel := context.WithCancel(r.Context())
		timer := time.AfterFunc(timeout, cancel)
		started := time.Now()
		headerMS, firstByteMS := int64(-1), int64(-1)
		req, _ := http.NewRequestWithContext(ctx, "POST", g.upstream.String(), bytes.NewReader(payload))
		req.Header.Set("Content-Type", "application/json")
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		region = trace.StartRegion(r.Context(), "gateway.upstreamHeaders")
		res, callErr := g.transport.RoundTrip(req)
		region.End()
		status := 0
		outputStarted, complete := false, false
		var usage *tokenUsage
		var ttftMS, firstOutputMS *int64
		outcome := resilience.Outcome{}
		if callErr == nil {
			headerMS = time.Since(started).Milliseconds()
			status = res.StatusCode
			if status >= 200 && status < 300 {
				if stream && !strings.HasPrefix(res.Header.Get("Content-Type"), "text/event-stream") {
					callErr = errors.New("invalid stream content type")
					outcome.NoRetry = true
					res.Body.Close()
				} else {
					observer := &completionBody{ReadCloser: res.Body, stream: stream, startedAt: started, onRead: func() {
						if firstByteMS < 0 {
							firstByteMS = time.Since(started).Milliseconds()
						}
					}}
					if stream {
						buffer := make([]byte, 32768)
						for {
							n, readErr := observer.Read(buffer)
							if n > 0 {
								if firstByteMS < 0 {
									firstByteMS = time.Since(started).Milliseconds()
								}
								timer.Reset(timeout)
								if !outputStarted {
									w.Header().Set("X-AMR-Selected-Model", model)
									w.Header().Set("Content-Type", "text/event-stream")
									w.Header().Set("Cache-Control", "no-store")
									w.WriteHeader(status)
									outputStarted = true
								}
								_ = controller.SetWriteDeadline(time.Now().Add(timeout))
								written, writeErr := w.Write(buffer[:n])
								if writeErr == nil && written != n {
									writeErr = io.ErrShortWrite
								}
								if writeErr == nil {
									writeErr = controller.Flush()
								}
								if writeErr != nil {
									callErr = writeErr
									outcome.ClientGone = true
									break
								}
							}
							if readErr != nil {
								if readErr != io.EOF {
									callErr = readErr
								}
								break
							}
						}
					} else {
						response, readErr := io.ReadAll(io.LimitReader(observer, MaxBodyBytes+1))
						if len(response) > MaxBodyBytes {
							callErr = errors.New("upstream response too large")
							outcome.NoRetry = true
						} else if readErr != nil {
							callErr = readErr
						} else if observer.Complete() {
							firstByteMS = time.Since(started).Milliseconds()
							if ctx.Err() == nil {
								w.Header().Set("X-AMR-Selected-Model", model)
								w.Header().Set("Content-Type", "application/json")
								w.Header().Set("Cache-Control", "no-store")
								w.WriteHeader(status)
								outputStarted = true
								_ = controller.SetWriteDeadline(time.Now().Add(timeout))
								n, writeErr := w.Write(response)
								if writeErr != nil || n != len(response) {
									callErr = io.ErrShortWrite
									outcome.ClientGone = true
								}
							}
						}
					}
					observer.Close()
					usage = observer.usage
					ttftMS, firstOutputMS = observer.FirstContentMS(), observer.FirstOutputMS()
					complete = callErr == nil && observer.Complete() && ctx.Err() == nil
					if !complete && callErr == nil {
						callErr = errors.New("incomplete upstream response")
					}
				}
			} else {
				res.Body.Close()
				callErr = errors.New("upstream rejected request")
				if status >= 300 && status < 400 {
					outcome.Scope = "configuration"
				}
			}
		}
		timedOut := ctx.Err() != nil && r.Context().Err() == nil
		timer.Stop()
		cancel()
		duration := time.Since(started)
		actual := price.actual(usage)
		region = trace.StartRegion(r.Context(), "gateway.settle")
		if g.runtime.ledger.Settle(attemptID, actual, actual != nil) != nil {
			g.runtime.failed.Store(true)
		}
		region.End()
		outcome.OK = complete
		outcome.Status = status
		outcome.Err = callErr
		outcome.OutputStarted = outputStarted
		outcome.ClientGone = outcome.ClientGone || r.Context().Err() != nil
		outcome.Latency = duration
		classification := claim.Finish(outcome)
		release()
		region = trace.StartRegion(r.Context(), "gateway.audit")
		_ = g.runtime.record(attemptEvent{RequestID: id, Revision: g.options.Bundle.Revision, Model: model, Attempt: index, Status: status, Outcome: classification.Scope, DurationMS: duration.Milliseconds(), HeaderMS: headerMS, FirstByteMS: firstByteMS, EstimatedMicros: estimate, ActualMicros: actual, At: time.Now().UTC().Format(time.RFC3339Nano)})
		region.End()
		if err := g.reportEdge(edge, edgeEvent{Decision: d, Analysis: native, DecisionAnalysis: in.Analysis, SemanticStatus: w.Header().Get("X-AMR-Semantic-Status"), Attempt: edgeAttempt{Index: index, Model: model, OK: complete, Status: status, FailureScope: classification.Scope, DurationMS: duration.Milliseconds(), HeaderMS: headerMS, FirstByteMS: firstByteMS, EstimatedMicros: estimate, ActualMicros: actual, Usage: usage, TTFTMS: ttftMS, FirstOutputMS: firstOutputMS, Timeout: timedOut}}); err != nil {
			g.runtime.edgeErrors.Add(1)
			if outputStarted {
				panic(http.ErrAbortHandler)
			}
			writeError(w, 503, "edge_event_unavailable")
			return
		}
		if complete {
			if !g.runtime.failed.Load() {
				g.admission.CompleteSession(sessionKey, in, attemptDecision, float64(time.Now().UnixMilli()))
			}
			return
		}
		if outputStarted {
			panic(http.ErrAbortHandler)
		} // Never append JSON or fake [DONE] to a partial stream.
		if outcome.ClientGone {
			return
		}
		lastStatus, lastCode = 502, "upstream_unavailable"
		if timedOut {
			lastStatus, lastCode = 504, "upstream_timeout"
		} else if status >= 400 && status < 500 {
			lastStatus, lastCode = status, "upstream_rejected"
		}
		if !classification.Retryable {
			break
		}
	}
	writeError(w, lastStatus, lastCode)
}
