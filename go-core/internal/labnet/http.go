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
func Client(timeout time.Duration) *http.Client {
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.Proxy = nil
	t.DialContext = (&net.Dialer{Timeout: timeout, KeepAlive: 30 * time.Second}).DialContext
	return &http.Client{Timeout: timeout, Transport: t, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}
