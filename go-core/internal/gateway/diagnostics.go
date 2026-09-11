package gateway

import (
	"os"
	"runtime"
)

// Process counters include all Go work in this process, not only this gateway.
// Sampling does not force GC; heap allocation is not RSS or a live-heap estimate.
type processDiagnostics struct {
	Scope          string `json:"scope"`
	PID            int    `json:"pid"`
	Goroutines     int    `json:"goroutines"`
	HeapAllocBytes uint64 `json:"heapAllocBytes"`
	HeapInuseBytes uint64 `json:"heapInuseBytes"`
	HeapObjects    uint64 `json:"heapObjects"`
	NumGC          uint32 `json:"numGC"`
}

type runtimeDiagnostics struct {
	ActiveRequests    int    `json:"activeRequests"`
	RequestCapacity   int    `json:"requestCapacity"`
	RetainedAttempts  int    `json:"retainedAttempts"`
	TotalAttempts     int    `json:"totalAttempts"`
	AttemptCacheLimit int    `json:"attemptCacheLimit"`
	CostStateMode     string `json:"costStateMode"`
}

type generationDiagnostics struct {
	Live           int    `json:"live"`
	Retired        int    `json:"retired"`
	ActiveHandlers int    `json:"activeHandlers"`
	Revision       string `json:"revision"`
}

type diagnostics struct {
	Process     processDiagnostics     `json:"process"`
	Runtime     runtimeDiagnostics     `json:"runtime"`
	Generations *generationDiagnostics `json:"generations,omitempty"`
}

func (g *Gateway) diagnostics(generations *generationDiagnostics) diagnostics {
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)
	cached, total, limit := g.runtime.ledger.AttemptStorage()
	mode := "observation"
	if g.options.Bundle.Runtime.BudgetEnabled {
		mode = "protected"
	}
	return diagnostics{
		Process:     processDiagnostics{Scope: "process", PID: os.Getpid(), Goroutines: runtime.NumGoroutine(), HeapAllocBytes: mem.HeapAlloc, HeapInuseBytes: mem.HeapInuse, HeapObjects: mem.HeapObjects, NumGC: mem.NumGC},
		Runtime:     runtimeDiagnostics{ActiveRequests: len(g.requests), RequestCapacity: cap(g.requests), RetainedAttempts: cached, TotalAttempts: total, AttemptCacheLimit: limit, CostStateMode: mode},
		Generations: generations,
	}
}

func (m *Managed) generationDiagnostics() generationDiagnostics {
	m.mu.Lock()
	defer m.mu.Unlock()
	d := generationDiagnostics{Live: len(m.all), Revision: m.active.revision}
	for gen := range m.all {
		d.ActiveHandlers += gen.refs
		if gen.retired {
			d.Retired++
		}
	}
	return d
}
