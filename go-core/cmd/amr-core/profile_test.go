package main

import (
	"context"
	"os"
	"path/filepath"
	"runtime/trace"
	"testing"
)

func TestLabProfileLifecycleAndNoOverwrite(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "profile")
	stop, err := startLabProfile(dir)
	if err != nil {
		t.Fatal(err)
	}
	trace.StartRegion(context.Background(), "gateway.request").End()
	if err := stop(); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"cpu.pprof", "block.pprof", "mutex.pprof", "runtime.trace", "complete"} {
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil || len(data) == 0 {
			t.Fatalf("missing profile %s: %v", name, err)
		}
	}
	if _, err := startLabProfile(dir); err == nil {
		t.Fatal("overwrote prior profile")
	}
	stop, err = startLabProfile("")
	if err != nil || stop() != nil {
		t.Fatal("disabled profiling failed")
	}
}
