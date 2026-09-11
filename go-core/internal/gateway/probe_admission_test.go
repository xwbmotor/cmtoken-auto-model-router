package gateway

import (
	"sync"
	"testing"
	"time"

	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/features"
)

func TestProbeAdmissionSharesBusinessCapacity(t *testing.T) {
	a := NewAdmission()
	in := inputFixture()
	in.Policy.LoadEnabled = true
	in.Models[0].Capacity = 1
	_, release, err := a.Select(in)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := a.AcquireProbe("model-a", 1, time.Second); ok {
		t.Fatal("probe admitted while business full")
	}
	release()
	lease, ok := a.AcquireProbe("model-a", 1, time.Second)
	if !ok {
		t.Fatal("free probe rejected")
	}
	if _, _, err := a.SelectSession(in, "session"); err == nil {
		t.Fatal("business exceeded probe-held capacity")
	}
	if _, ok := a.AcquireModel(in, "model-a"); ok {
		t.Fatal("fallback exceeded probe-held capacity")
	}
	a.ReleaseProbe(lease)
	_, release, err = a.Select(in)
	if err != nil {
		t.Fatal(err)
	}
	a.ReleaseProbe(lease)
	if a.Snapshot()["model-a"] != 1 {
		t.Fatal("old lease released business")
	}
	release()
	if len(a.Snapshot()) != 0 {
		t.Fatal("reservation leaked")
	}
}

func TestProbeAdmissionExpirationAcrossEntryPoints(t *testing.T) {
	for _, entry := range []string{"snapshot", "select", "fallback", "probe"} {
		t.Run(entry, func(t *testing.T) {
			a := NewAdmission()
			now := time.Unix(1000, 0)
			a.probeNow = func() time.Time { return now }
			old, ok := a.AcquireProbe("model-a", 1, time.Second)
			if !ok {
				t.Fatal("probe rejected")
			}
			now = now.Add(time.Second)
			in := inputFixture()
			in.Policy.LoadEnabled = true
			in.Models[0].Capacity = 1
			var release func()
			switch entry {
			case "snapshot":
				if a.Snapshot()["model-a"] != 0 {
					t.Fatal("expired probe retained")
				}
				return
			case "select":
				_, r, e := a.SelectSession(in, "")
				if e != nil {
					t.Fatal(e)
				}
				release = r
			case "fallback":
				r, ok := a.AcquireModel(in, "model-a")
				if !ok {
					t.Fatal("expired probe blocks fallback")
				}
				release = r
			case "probe":
				id, ok := a.AcquireProbe("model-a", 1, time.Second)
				if !ok {
					t.Fatal("expired probe blocks replacement")
				}
				release = func() { a.ReleaseProbe(id) }
			}
			a.ReleaseProbe(old)
			if a.Snapshot()["model-a"] != 1 {
				t.Fatal("expired lease deducted replacement")
			}
			release()
			if len(a.Snapshot()) != 0 {
				t.Fatal("active count leaked")
			}
		})
	}
}

func TestProbeAdmissionConcurrencyThresholdIsolationAndBounds(t *testing.T) {
	a := NewAdmission()
	var wg sync.WaitGroup
	var mu sync.Mutex
	var leases []string
	for range 100 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if id, ok := a.AcquireProbe("model-a", 10, time.Minute); ok {
				mu.Lock()
				leases = append(leases, id)
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if len(leases) != 8 || a.Snapshot()["model-a"] != 8 {
		t.Fatalf("80 percent gate failed: %d", len(leases))
	}
	other, ok := a.AcquireProbe("model-b", 1, time.Minute)
	if !ok {
		t.Fatal("different model blocked")
	}
	for _, id := range leases {
		wg.Add(1)
		go func(id string) { defer wg.Done(); a.ReleaseProbe(id); a.ReleaseProbe(id) }(id)
	}
	wg.Wait()
	if a.Snapshot()["model-b"] != 1 || a.Snapshot()["model-a"] != 0 {
		t.Fatal("model isolation or idempotent release failed")
	}
	a.ReleaseProbe(other)
	for _, ttl := range []time.Duration{0, -1, 121 * time.Second} {
		if _, ok := a.AcquireProbe("model-a", 0, ttl); ok {
			t.Fatal("invalid TTL accepted")
		}
	}
	for range 256 {
		if _, ok := a.AcquireProbe("model-a", 0, time.Second); !ok {
			t.Fatal("unlimited capacity probe rejected before lease bound")
		}
	}
	if _, ok := a.AcquireProbe("model-b", 0, time.Second); ok {
		t.Fatal("global lease bound exceeded")
	}
	if a.Snapshot()["model-a"] != 256 {
		t.Fatal("unlimited probes not counted")
	}
}

func TestProbeCapacityFollowsEnabledModelAndLoadPolicy(t *testing.T) {
	b := nativeBundle(t, "a")
	b.Features.Models[1]["enabled"] = false
	builder, err := features.New(*b.Features)
	if err != nil {
		t.Fatal(err)
	}
	if capacity, ok := builder.ProbeCapacity("model-a"); !ok || capacity != 8 {
		t.Fatalf("capacity=%d ok=%v", capacity, ok)
	}
	for _, id := range []string{"model-b", "missing"} {
		if _, ok := builder.ProbeCapacity(id); ok {
			t.Fatalf("unavailable model %s accepted", id)
		}
	}
	b.Features.Routing["loadBalancing"] = map[string]any{"enabled": false}
	builder, err = features.New(*b.Features)
	if err != nil {
		t.Fatal(err)
	}
	if capacity, ok := builder.ProbeCapacity("model-a"); !ok || capacity != 0 {
		t.Fatal("disabled load policy still restricts probes")
	}
}
