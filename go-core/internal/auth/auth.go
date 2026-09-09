// Package auth separates data-plane credentials from administrative authority.
package auth

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"strings"
)

var ErrUnauthorized = errors.New("invalid authorization")

type Tenant struct {
	AccessToken   string `json:"accessToken"`
	UpstreamToken string `json:"upstreamToken"`
}
type Config struct {
	Mode          string   `json:"mode"`
	AccessToken   string   `json:"accessToken"`
	AdminToken    string   `json:"adminToken"`
	UpstreamToken string   `json:"upstreamToken"`
	Tenants       []Tenant `json:"tenants,omitempty"`
}

// Principal must never be serialized into request logs: UpstreamToken is secret.
type Principal struct {
	UpstreamToken string `json:"-"`
	Fingerprint   string `json:"fingerprint"`
}

func (p Principal) String() string   { return "principal:" + p.Fingerprint }
func (p Principal) GoString() string { return p.String() }

type Authenticator struct{ config Config }

func validToken(s string) bool {
	if s == "" || len(s) > 8192 {
		return false
	}
	for _, c := range s {
		if c <= 32 || c >= 127 {
			return false
		}
	}
	return true
}

func New(c Config) (*Authenticator, error) {
	if c.Mode == "" {
		c.Mode = "strict"
	}
	if c.Mode != "strict" && c.Mode != "passthrough" {
		return nil, errors.New("invalid key mode")
	}
	// Unlike the Node loopback development bypass, this production primitive is
	// always fail closed. Admin access is disabled when AdminToken is absent.
	if c.Mode == "strict" && (!validToken(c.AccessToken) || !validToken(c.UpstreamToken)) {
		return nil, errors.New("strict mode requires access and upstream credentials")
	}
	for _, token := range []string{c.AccessToken, c.AdminToken, c.UpstreamToken} {
		if token != "" && !validToken(token) {
			return nil, errors.New("invalid credential configuration")
		}
	}
	if len(c.Tenants) > 256 {
		return nil, errors.New("too many tenant credentials")
	}
	seen := map[string]bool{c.AccessToken: true}
	for _, t := range c.Tenants {
		if c.Mode != "strict" || !validToken(t.AccessToken) || !validToken(t.UpstreamToken) || seen[t.AccessToken] {
			return nil, errors.New("invalid tenant credentials")
		}
		seen[t.AccessToken] = true
	}
	if c.AdminToken != "" && (seen[c.AdminToken] || c.AdminToken == c.UpstreamToken) {
		return nil, errors.New("administrative credential must be separate")
	}
	for _, t := range c.Tenants {
		if c.AdminToken != "" && t.UpstreamToken == c.AdminToken {
			return nil, errors.New("administrative credential must be separate")
		}
	}
	c.Tenants = append([]Tenant(nil), c.Tenants...)
	return &Authenticator{config: c}, nil
}

func equal(a, b string) bool {
	x, y := sha256.Sum256([]byte(a)), sha256.Sum256([]byte(b))
	return subtle.ConstantTimeCompare(x[:], y[:]) == 1
}

func bearer(header string) (string, bool) {
	// Reject ambiguous/multiple credentials and control characters rather than
	// allowing a malformed header to fall back to the server's upstream account.
	if len(header) < 8 || !strings.EqualFold(header[:7], "Bearer ") {
		return "", false
	}
	token := header[7:]
	return token, validToken(token) && !strings.Contains(token, ",")
}

func (a *Authenticator) Authenticate(header string) (Principal, error) {
	token, ok := bearer(header)
	if !ok {
		return Principal{}, ErrUnauthorized
	}
	if a.config.AdminToken != "" && equal(token, a.config.AdminToken) {
		return Principal{}, ErrUnauthorized
	}
	upstream := ""
	if a.config.Mode == "passthrough" {
		upstream = token
	} else {
		if equal(token, a.config.AccessToken) {
			upstream = a.config.UpstreamToken
		}
		for _, tenant := range a.config.Tenants {
			if equal(token, tenant.AccessToken) {
				upstream = tenant.UpstreamToken
			}
		}
	}
	if upstream == "" {
		return Principal{}, ErrUnauthorized
	}
	h := sha256.Sum256([]byte(token))
	return Principal{UpstreamToken: upstream, Fingerprint: hex.EncodeToString(h[:])}, nil
}

func (a *Authenticator) AdminAuthorized(header string) bool {
	token, ok := bearer(header)
	return ok && a.config.AdminToken != "" && equal(token, a.config.AdminToken)
}
