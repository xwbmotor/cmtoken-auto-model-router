package main

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"runtime/pprof"
	"runtime/trace"
)

// Explicit laboratory diagnostics only. Profiles contain stacks and fixed
// region names, never request bodies, credentials or model responses.
func startLabProfile(dir string) (func() error, error) {
	if dir == "" {
		return func() error { return nil }, nil
	}
	if err := os.Mkdir(dir, 0700); err != nil {
		return nil, err // Do not overwrite an earlier experiment.
	}
	open := func(name string) (*os.File, error) {
		return os.OpenFile(filepath.Join(dir, name), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	}
	cpu, err := open("cpu.pprof")
	if err != nil {
		return nil, err
	}
	tr, err := open("runtime.trace")
	if err != nil {
		cpu.Close()
		return nil, err
	}
	if err = pprof.StartCPUProfile(cpu); err != nil {
		cpu.Close()
		tr.Close()
		return nil, err
	}
	if err = trace.Start(tr); err != nil {
		pprof.StopCPUProfile()
		cpu.Close()
		tr.Close()
		return nil, err
	}
	previousMutex := runtime.SetMutexProfileFraction(1)
	runtime.SetBlockProfileRate(1000000)
	return func() error {
		trace.Stop()
		pprof.StopCPUProfile()
		err := errors.Join(cpu.Close(), tr.Close())
		for _, name := range []string{"block", "mutex"} {
			f, e := open(name + ".pprof")
			if e == nil {
				e = errors.Join(pprof.Lookup(name).WriteTo(f, 0), f.Close())
			}
			err = errors.Join(err, e)
		}
		runtime.SetBlockProfileRate(0)
		runtime.SetMutexProfileFraction(previousMutex)
		if err == nil {
			err = os.WriteFile(filepath.Join(dir, "complete"), []byte("ok\n"), 0600)
		}
		return err
	}, nil
}
