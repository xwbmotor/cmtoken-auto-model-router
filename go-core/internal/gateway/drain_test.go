package gateway

import (
	"context"
	"errors"
	"io"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/auth"
)

func TestDrainPreservesCompletedResponseShadowReviewAndHonorsCancellation(t *testing.T) {
	for _, cancelDrain := range []bool{false, true} {
		t.Run(map[bool]string{false: "complete", true: "deadline"}[cancelDrain], func(t *testing.T) {
			started, release := make(chan struct{}), make(chan struct{})
			var once sync.Once
			unblock := func() { once.Do(func() { close(release) }) }
			defer unblock()
			policy := reviewPolicy()
			policy.Mode = "shadow"
			g, server, calls := semanticLab(t, policy, func(w http.ResponseWriter, r *http.Request) {
				io.Copy(io.Discard, r.Body)
				close(started)
				select {
				case <-release:
					smallAssessment(.9)(w, r)
				case <-r.Context().Done():
				}
			}, nil)
			response, err := http.DefaultClient.Do(request(context.Background(), server.URL, semanticRequest))
			if err != nil {
				t.Fatal(err)
			}
			io.Copy(io.Discard, response.Body)
			response.Body.Close()
			if response.StatusCode != 200 || calls.Load() != 1 {
				t.Fatal("answer was not delivered before the review")
			}
			<-started
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan error, 1)
			go func() { done <- g.Drain(ctx) }()
			eventually(t, func() bool { g.backgroundMu.Lock(); defer g.backgroundMu.Unlock(); return g.backgroundClosing })
			if g.backgroundReview(func(context.Context) {}) {
				t.Fatal("draining gateway accepted new background work")
			}
			if cancelDrain {
				cancel()
			} else {
				unblock()
			}
			select {
			case err = <-done:
				if cancelDrain && !errors.Is(err, context.Canceled) || !cancelDrain && err != nil {
					t.Fatalf("unexpected drain result: %v", err)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("drain did not finish")
			}
			eventually(t, func() bool { g.reviewsMu.Lock(); defer g.reviewsMu.Unlock(); return len(g.reviews) == 1 })
			g.reviewsMu.Lock()
			status := g.reviews[0].Status
			g.reviewsMu.Unlock()
			if want := map[bool]string{false: "shadow_complete", true: "error"}[cancelDrain]; status != want {
				t.Fatalf("review status=%s want=%s", status, want)
			}
		})
	}
}

func TestPublicationRetainsBackgroundGenerationWithoutBlockingNewRequests(t *testing.T) {
	f := newReloadFixture(t, auth.Config{AccessToken: accessToken, UpstreamToken: "upstream", AdminToken: reloadAdmin}, func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, `{}`) })
	revision := f.revision(t)
	f.m.mu.Lock()
	old := f.m.active
	f.m.mu.Unlock()
	release := make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	defer unblock()
	finished := make(chan error, 1)
	if !old.g.backgroundReview(func(ctx context.Context) {
		select {
		case <-release:
		case <-ctx.Done():
		}
		finished <- ctx.Err()
	}) {
		t.Fatal("review was not started")
	}
	f.setBundle(reloadBundle("b"))
	if _, err := f.m.Reload(revision); err != nil {
		t.Fatal(err)
	}
	if w := reloadCall(t, f.m, "GET", "/health", "", ""); w.Code != 200 {
		t.Fatal("retired review blocked the new generation")
	}
	f.m.mu.Lock()
	retained := f.m.all[old]
	f.m.mu.Unlock()
	if !retained {
		t.Fatal("publication discarded an unfinished review generation")
	}
	select {
	case err := <-finished:
		t.Fatalf("publication terminated the review early: %v", err)
	default:
	}
	unblock()
	if err := <-finished; err != nil {
		t.Fatalf("review was cancelled by publication: %v", err)
	}
	eventually(t, func() bool { f.m.mu.Lock(); defer f.m.mu.Unlock(); return !f.m.all[old] })
}
