package gateway

import (
	"context"
	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/decision"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestSessionIsolationAndEligibility(t *testing.T) {
	if SessionKey("same", "Bearer tenant-a", "upstream", []byte("secret")) == SessionKey("same", "Bearer tenant-b", "upstream", []byte("secret")) {
		t.Fatal("cross-tenant session collision")
	}
	in := inputFixture()
	in.Policy.SessionTTLMS = 1000
	in.Policy.SessionMaxGap = .05
	d := decision.Decision{RequestedModel: "auto", SelectedModel: "a", QualifiedModelIDs: []string{"a", "b"}, Candidates: []decision.Candidate{{Model: "a", Score: .9}, {Model: "b", Score: .88}}}
	s := Session{Model: "b", Task: in.Analysis.Task, Tier: in.Analysis.Tier, ExpiresAt: in.Runtime.NowMs + 100}
	if ChooseSession(&s, in, d) != "b" {
		t.Fatal("eligible session lost")
	}
	d.QualifiedModelIDs = []string{"a"}
	if ChooseSession(&s, in, d) != "a" {
		t.Fatal("ineligible session reused")
	}
	d.QualifiedModelIDs = []string{"a", "b"}
	s.ExpiresAt = in.Runtime.NowMs
	if ChooseSession(&s, in, d) != "a" {
		t.Fatal("expired session reused")
	}
	s.ExpiresAt++
	s.Task = "coding"
	if ChooseSession(&s, in, d) != "a" {
		t.Fatal("changed task reused")
	}
}
func TestSessionCannotOverbookOrRefreshBeforeSuccess(t *testing.T) {
	in := inputFixture()
	in.Policy.SessionTTLMS = 1000
	in.Policy.SessionMaxGap = .05
	in.Models = append(in.Models, decision.Model{ID: "model-b", Enabled: true, Ownership: "self_hosted", Quality: .89, Capacity: 1})
	a := NewAdmission()
	a.sessions["key"] = Session{Model: "model-b", Task: in.Analysis.Task, Tier: in.Analysis.Tier, ExpiresAt: in.Runtime.NowMs + 100}
	first, release, e := a.SelectSession(in, "key")
	if e != nil || first.SelectedModel != "model-b" {
		t.Fatalf("%+v %v", first, e)
	}
	defer release()
	second, release2, e := a.SelectSession(in, "key")
	if e != nil || second.SelectedModel != "model-a" {
		t.Fatalf("saturated sticky model selected: %+v %v", second, e)
	}
	release2()
	if a.sessions["key"].ExpiresAt != in.Runtime.NowMs+100 {
		t.Fatal("reservation refreshed session before delivery")
	}
	a.CompleteSession("key", in, first, in.Runtime.NowMs)
	if a.sessions["key"].ExpiresAt != in.Runtime.NowMs+1000 {
		t.Fatal("successful completion did not refresh session")
	}
}
func TestCompletionRequiresRealEnd(t *testing.T) {
	for _, tc := range []struct {
		stream bool
		body   string
		want   bool
	}{{true, "data: {\"choices\":[]}\n\ndata: [DONE]\n\n", false}, {true, "data: partial\n", false}, {false, `{"choices":[{"message":{"content":"ok"}}]}`, true}, {false, `{"error":"failed"}`, false}, {false, `{`, false}} {
		b := &completionBody{ReadCloser: io.NopCloser(strings.NewReader(tc.body)), stream: tc.stream}
		if b.Complete() {
			t.Fatal("premature completion")
		}
		_, _ = io.Copy(io.Discard, b)
		if b.Complete() != tc.want {
			t.Fatalf("completion mismatch for %s", tc.body)
		}
	}
}

func TestSessionStoredOnlyAfterValidHTTPDelivery(t *testing.T) {
	for _, tc := range []struct {
		name, contentType, body string
		want                    int
	}{{"plain", "application/json", `{"choices":[{"message":{"content":"ok"}}]}`, 1}, {"empty", "application/json", `{"choices":[{"message":{"content":""}}]}`, 0}, {"sse", "text/event-stream", "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n", 1}, {"truncated", "text/event-stream", "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n", 0}} {
		t.Run(tc.name, func(t *testing.T) {
			in := inputFixture()
			in.Policy.SessionTTLMS = 60000
			in.Policy.SessionMaxGap = .05
			g, s := lab(t, in, func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", tc.contentType)
				io.WriteString(w, tc.body)
			}, time.Second)
			req := request(context.Background(), s.URL, `{"model":"auto","messages":[{"role":"user","content":"hi"}]}`)
			req.Header.Set("X-Session-ID", "session")
			res, e := http.DefaultClient.Do(req)
			if e != nil {
				t.Fatal(e)
			}
			io.Copy(io.Discard, res.Body)
			res.Body.Close()
			eventually(t, func() bool { return len(g.admission.Snapshot()) == 0 })
			g.admission.mu.Lock()
			n := len(g.admission.sessions)
			g.admission.mu.Unlock()
			if n != tc.want {
				t.Fatalf("stored %d sessions", n)
			}
		})
	}
}
