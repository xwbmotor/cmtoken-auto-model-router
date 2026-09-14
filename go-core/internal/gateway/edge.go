package gateway

// The Node HTTP edge retains the public HTTP and management contracts. Only an
// authenticated loopback edge can supply live market signals and receive request
// outcomes; none of this metadata is sent to the model provider or audit journal.
import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"time"

	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/analysis"
	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/decision"
	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/labnet"
)

type edgeContext struct {
	ID              string                        `json:"id"`
	RequestID       string                        `json:"requestId"`
	ConfigRevision  string                        `json:"configRevision"`
	MarketSignals   map[string]map[string]float64 `json:"marketSignals"`
	adoptedAnalysis *analysis.Result
	native          *nativeRequest
}

type edgeContextKey struct{}

func (g *Gateway) readEdge(r *http.Request, body map[string]json.RawMessage) (*edgeContext, error) {
	if g.options.EdgeURL == "" {
		return nil, nil
	}
	if front, ok := r.Context().Value(nativeFrontKey{}).(*NativeFront); ok {
		return g.readNativeEdge(front, r, body)
	}
	if subtle.ConstantTimeCompare([]byte(r.Header.Get("X-AMR-Edge-Token")), []byte(g.options.EdgeToken)) != 1 {
		return nil, errors.New("trusted_edge_required")
	}
	var edge edgeContext
	if decodeStrict(bytes.NewReader(body["__amr_edge"]), &edge) != nil || len(edge.ID) != 36 || len(edge.RequestID) < 1 || len(edge.RequestID) > 256 || len(edge.MarketSignals) > 16 {
		return nil, errors.New("invalid_edge_context")
	}
	if edge.ConfigRevision != g.options.Bundle.Revision {
		return nil, errors.New("edge_config_revision_mismatch")
	}
	for task, signals := range edge.MarketSignals {
		if len(task) > 64 || len(signals) > 1024 {
			return nil, errors.New("invalid_market_signals")
		}
		for model, value := range signals {
			if len(model) > 256 || math.IsNaN(value) || math.IsInf(value, 0) || math.Abs(value) > 1 {
				return nil, errors.New("invalid_market_signals")
			}
		}
	}
	delete(body, "__amr_edge")
	return &edge, nil
}

func applyEdgeSignals(in *decision.Input, edge *edgeContext) {
	if edge == nil {
		return
	}
	for id := range in.Runtime.MarketAdjustments {
		in.Runtime.MarketAdjustments[id] = edge.MarketSignals[in.Analysis.Task][id]
	}
}

type edgeAttempt struct {
	TTFTMS          *int64      `json:"ttftMs"`
	FirstOutputMS   *int64      `json:"firstOutputMs"`
	Timeout         bool        `json:"timeout"`
	Index           int         `json:"index"`
	Model           string      `json:"model"`
	OK              bool        `json:"ok"`
	Status          int         `json:"upstreamStatus"`
	FailureScope    string      `json:"failureScope"`
	DurationMS      int64       `json:"latencyMs"`
	HeaderMS        int64       `json:"headerMs"`
	FirstByteMS     int64       `json:"firstByteMs"`
	EstimatedMicros *int64      `json:"estimatedMicros"`
	ActualMicros    *int64      `json:"actualMicros"`
	Usage           *tokenUsage `json:"usage"`
}

type edgeEvent struct {
	ID               string            `json:"id"`
	ConfigRevision   string            `json:"configRevision"`
	Decision         decision.Decision `json:"decision"`
	Analysis         analysis.Result   `json:"analysis"`
	DecisionAnalysis decision.Analysis `json:"decisionAnalysis"`
	SemanticStatus   string            `json:"semanticStatus"`
	Attempt          edgeAttempt       `json:"attempt"`
}

// The edge deduplicates by opaque request ID + attempt index. A lost HTTP ack
// can be retried without duplicating counters, costs or downstream log records.
// Request cancellation must not cancel reporting of an already incurred cost.
func (g *Gateway) reportEdge(edge *edgeContext, event edgeEvent) error {
	if edge == nil {
		return nil
	}
	event.ID = edge.ID
	event.ConfigRevision = edge.ConfigRevision
	if edge.native != nil {
		edge.native.Events = append(edge.native.Events, event)
		return nil
	}
	payload, err := json.Marshal(event)
	if err != nil {
		return errors.New("edge_event_invalid")
	}
	return g.postEdge(payload)
}

func (g *Gateway) reportEdgeReview(edge *edgeContext, review Review) error {
	if edge == nil {
		return nil
	}
	value := map[string]any{"kind": "semantic", "id": edge.ID, "configRevision": edge.ConfigRevision, "review": review}
	if edge.native != nil {
		value["nativeMetadata"] = edge.native.Metadata
	}
	payload, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return g.postEdge(payload)
}

func (g *Gateway) postEdge(payload []byte) error {
	if g.runtime != nil && g.runtime.outbox != nil {
		var envelope struct {
			Kind     string          `json:"kind"`
			Metadata json.RawMessage `json:"nativeMetadata"`
		}
		if json.Unmarshal(payload, &envelope) != nil {
			return errors.New("invalid edge envelope")
		}
		if envelope.Kind == "native_complete" || len(envelope.Metadata) > 0 {
			payload = append(append([]byte{}, payload[:len(payload)-1]...), []byte(fmt.Sprintf(",\"receiptAt\":%d}", time.Now().UnixMilli()))...)
			return g.runtime.outbox.enqueue(payload)
		}
	}

	for retry := 0; retry < 2; retry++ {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		req, _ := http.NewRequestWithContext(ctx, "POST", g.options.EdgeURL, bytes.NewReader(payload))
		req.Header.Set("Authorization", "Bearer "+g.options.EdgeToken)
		req.Header.Set("Content-Type", "application/json")
		res, e := g.edgeClient.Do(req)
		if e == nil {
			_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 4096))
			res.Body.Close()
			cancel()
			if res.StatusCode == 204 {
				return nil
			}
			if res.StatusCode >= 400 && res.StatusCode < 500 {
				return errors.New("edge_event_rejected")
			}
		} else {
			cancel()
		}
	}
	return errors.New("edge_event_unavailable")
}

func validateEdge(o Options) error {
	if o.EdgeURL == "" {
		if o.EdgeToken != "" {
			return errors.New("edge URL required")
		}
		return nil
	}
	u, err := labnet.URL(o.EdgeURL)
	if err != nil || u.Path != "/internal/v1/go-events" || u.RawQuery != "" || len(o.EdgeToken) < 32 || o.Bundle == nil || o.Shared == nil {
		return errors.New("edge requires managed runtime, fixed loopback event path and protected token")
	}
	return nil
}
