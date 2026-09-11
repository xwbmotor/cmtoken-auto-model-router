// Package labnet keeps every experimental dependency on explicit loopback URLs.
package labnet

import (
	"errors"
	"net"
	"net/http"
	"net/url"
	"time"
)

func URL(raw string) (*url.URL, error) {
	u, e := url.Parse(raw)
	if e != nil || u == nil {
		return nil, errors.New("invalid laboratory endpoint")
	}
	ip := net.ParseIP(u.Hostname())
	if (u.Scheme != "http" && u.Scheme != "https") || ip == nil || !ip.IsLoopback() || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Port() == "" {
		return nil, errors.New("laboratory endpoints require literal loopback IPs and explicit ports without credentials, query or fragment")
	}
	return u, nil
}

// Endpoint permits configured HTTPS dependencies only in explicit candidate mode.
// Plain HTTP remains limited to literal loopback. URLs never come from a request.
func Endpoint(raw string, candidate bool) (*url.URL, error) {
	if !candidate {
		return URL(raw)
	}
	if u, err := URL(raw); err == nil {
		return u, nil
	}
	u, err := url.Parse(raw)
	if err != nil || u == nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Opaque != "" {
		return nil, errors.New("candidate external endpoints require HTTPS without credentials, query or fragment")
	}
	return u, nil
}
func Client(timeout time.Duration) *http.Client {
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.Proxy = nil
	t.DialContext = (&net.Dialer{Timeout: timeout, KeepAlive: 30 * time.Second}).DialContext
	return &http.Client{Timeout: timeout, Transport: t, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}
