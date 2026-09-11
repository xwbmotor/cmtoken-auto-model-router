package gateway

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"sync"
	"time"

	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/ledger"
	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/semantic"
)

func newRequestID() (string, error) {
	var b [16]byte
	if _, e := rand.Read(b[:]); e != nil {
		return "", e
	}
	return hex.EncodeToString(b[:]), nil
}
func (g *Gateway) semanticBilling(model string, input, output float64) (func(*semantic.Usage), error) {
	if g.runtime.failed.Load() {
		return nil, errors.New("runtime persistence unavailable")
	}
	id, e := newRequestID()
	if e != nil {
		return nil, e
	}
	price := g.options.Bundle.Runtime.Prices[model]
	estimate := price.estimate(input, output, "off", 0)
	if e = g.runtime.reserveCost(id+"-classifier", estimate, g.options.Bundle.Runtime.limit(), "classifier"); e != nil {
		if !errors.Is(e, ledger.ErrBudget) {
			g.runtime.failed.Store(true)
		}
		return nil, e
	}
	started := time.Now()
	var once sync.Once
	return func(u *semantic.Usage) {
		once.Do(func() {
			var actual *int64
			if u != nil {
				actual = price.actual(&tokenUsage{Prompt: u.Prompt, Completion: u.Completion})
			}
			if e := g.runtime.settleCost(id+"-classifier", actual, actual != nil); e != nil {
				g.runtime.failed.Store(true)
			}
			_ = g.runtime.record(attemptEvent{RequestID: id, Revision: g.options.Bundle.Revision, Model: model, Outcome: "classifier_settled", EstimatedMicros: estimate, ActualMicros: actual, DurationMS: time.Since(started).Milliseconds(), At: time.Now().UTC().Format(time.RFC3339Nano)})
		})
	}, nil
}
