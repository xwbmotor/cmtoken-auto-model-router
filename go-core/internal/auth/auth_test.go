package auth

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestStrictCredentials(t *testing.T) {
	c := Config{AccessToken: "route-secret", UpstreamToken: "server-secret", AdminToken: "admin-secret", Tenants: []Tenant{{"tenant-secret", "tenant-upstream"}}}
	a, err := New(c)
	if err != nil {
		t.Fatal(err)
	}
	c.Tenants[0].UpstreamToken = "mutated"
	for header, want := range map[string]string{"Bearer route-secret": "server-secret", "Bearer tenant-secret": "tenant-upstream"} {
		p, err := a.Authenticate(header)
		if err != nil || p.UpstreamToken != want || len(p.Fingerprint) != 64 {
			t.Fatalf("incorrect identity: %v", err)
		}
		data, _ := json.Marshal(p)
		if strings.Contains(string(data), "secret") || strings.Contains(string(data), "upstream") {
			t.Fatal("credential leaked")
		}
		if strings.Contains(fmt.Sprintf("%+v %#v", p, p), want) {
			t.Fatal("formatted principal leaked credential")
		}
	}
	for _, header := range []string{"", "Bearer server-secret", "Bearer admin-secret", "Bearer incorrect", "Bearer route-secret other", "Bearer route-secret\r\nX:y", "Bearer route-secret,other"} {
		if _, err := a.Authenticate(header); err != ErrUnauthorized {
			t.Fatal("invalid credential accepted")
		}
	}
	if !a.AdminAuthorized("Bearer admin-secret") || a.AdminAuthorized("Bearer tenant-secret") || a.AdminAuthorized("Bearer route-secret") {
		t.Fatal("administrative boundary")
	}
}

func TestPassthroughNeverFallsBack(t *testing.T) {
	a, err := New(Config{Mode: "passthrough", UpstreamToken: "server-secret", AdminToken: "admin-secret"})
	if err != nil {
		t.Fatal(err)
	}
	p, err := a.Authenticate("Bearer caller-secret")
	if err != nil || p.UpstreamToken != "caller-secret" {
		t.Fatal("wrong upstream token")
	}
	for _, header := range []string{"", "Basic caller-secret", "Bearer ", "Bearer  caller-secret", "Bearer caller\tsecret", "Bearer admin-secret"} {
		if _, err := a.Authenticate(header); err != ErrUnauthorized {
			t.Fatal("missing credential falls back")
		}
	}
	if a.AdminAuthorized("Bearer caller-secret") {
		t.Fatal("passthrough grants admin")
	}
	a, _ = New(Config{Mode: "passthrough"})
	if a.AdminAuthorized("Bearer anything") {
		t.Fatal("empty admin key grants access")
	}
}

func TestInvalidConfiguration(t *testing.T) {
	for _, c := range []Config{{}, {Mode: "unexpected"}, {AccessToken: "r", UpstreamToken: "u", AdminToken: "r"}, {AccessToken: "r", UpstreamToken: "u", Tenants: []Tenant{{"r", "t"}}}, {Mode: "passthrough", Tenants: []Tenant{{"r", "t"}}}} {
		if _, err := New(c); err == nil {
			t.Fatal("invalid configuration accepted")
		}
	}
}
