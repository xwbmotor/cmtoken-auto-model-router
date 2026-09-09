// Package scope mirrors Node's model-scope compatibility behavior: this cache
// is a routing hint, while authorization remains the upstream's responsibility.
package scope

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/labnet"
)

type entry struct {
	ids    []string
	known  bool
	at     time.Time
	flight chan struct{}
}
type Cache struct {
	url     string
	ttl     time.Duration
	client  *http.Client
	secret  []byte
	mu      sync.Mutex
	entries map[string]*entry
	ctx     context.Context
	cancel  context.CancelFunc
	workers sync.WaitGroup
	closing bool
	slots   chan struct{}
}

func New(endpoint string, ttl, timeout time.Duration) (*Cache, error) {
	if _, e := labnet.URL(endpoint); e != nil {
		return nil, e
	}
	if ttl <= 0 || ttl > 24*time.Hour || timeout <= 0 || timeout > time.Minute {
		return nil, errors.New("invalid scope cache limits")
	}
	ctx, cancel := context.WithCancel(context.Background())
	c := &Cache{url: endpoint, ttl: ttl, client: labnet.Client(timeout), secret: make([]byte, 32), entries: map[string]*entry{}, ctx: ctx, cancel: cancel, slots: make(chan struct{}, 16)}
	if _, e := rand.Read(c.secret); e != nil {
		cancel()
		return nil, e
	}
	return c, nil
}
func (c *Cache) Close() {
	c.mu.Lock()
	c.closing = true
	c.cancel()
	c.mu.Unlock()
	c.workers.Wait()
	c.client.CloseIdleConnections()
}
func (c *Cache) key(token string) string {
	m := hmac.New(sha256.New, c.secret)
	m.Write([]byte(c.url))
	m.Write([]byte{0})
	m.Write([]byte(token))
	return hex.EncodeToString(m.Sum(nil))
}
func copyIDs(ids []string) []string {
	if ids == nil {
		return nil
	}
	return append([]string{}, ids...)
}
func (c *Cache) fetch(ctx context.Context, token string) []string {
	req, e := http.NewRequestWithContext(ctx, "GET", c.url, nil)
	if e != nil {
		return nil
	}
	req.Header.Set("Authorization", "Bearer "+token)
	res, e := c.client.Do(req)
	if e != nil {
		return nil
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil
	}
	data, e := io.ReadAll(io.LimitReader(res.Body, (1<<20)+1))
	if e != nil || len(data) > 1<<20 {
		return nil
	}
	var payload struct {
		Data []struct {
			ID any `json:"id"`
		} `json:"data"`
	}
	if json.Unmarshal(data, &payload) != nil {
		return nil
	}
	seen := map[string]bool{}
	var ids []string
	for _, m := range payload.Data {
		if id, ok := m.ID.(string); ok && id != "" && !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	return ids
}

// First misses join one request; expired hits return the old snapshot immediately
// while exactly one bounded background refresh runs. Failure caches nil like Node.
func (c *Cache) Resolve(ctx context.Context, token string) []string {
	if token == "" || ctx.Err() != nil {
		return nil
	}
	key := c.key(token)
	c.mu.Lock()
	if c.closing {
		c.mu.Unlock()
		return nil
	}
	hit := c.entries[key]
	if hit != nil && hit.known && time.Since(hit.at) < c.ttl {
		ids := copyIDs(hit.ids)
		c.mu.Unlock()
		return ids
	}
	if hit != nil && hit.flight != nil {
		ids, known, done := copyIDs(hit.ids), hit.known, hit.flight
		c.mu.Unlock()
		if known {
			return ids
		}
		select {
		case <-ctx.Done():
			return nil
		case <-done:
			return c.Resolve(ctx, token)
		}
	}
	if hit == nil {
		if len(c.entries) >= 10000 {
			for k, v := range c.entries {
				if v.flight == nil && time.Since(v.at) > c.ttl {
					delete(c.entries, k)
				}
			}
			if len(c.entries) >= 10000 {
				c.mu.Unlock()
				return nil
			}
		}
		hit = &entry{}
		c.entries[key] = hit
	}
	select {
	case c.slots <- struct{}{}:
	default:
		ids := copyIDs(hit.ids)
		c.mu.Unlock()
		return ids
	}
	done := make(chan struct{})
	hit.flight = done
	old, known := copyIDs(hit.ids), hit.known
	c.workers.Add(1)
	c.mu.Unlock()
	go func() {
		defer c.workers.Done()
		defer func() { <-c.slots }()
		ids := c.fetch(c.ctx, token)
		c.mu.Lock()
		hit.ids = ids
		hit.at = time.Now()
		hit.known = true
		hit.flight = nil
		close(done)
		c.mu.Unlock()
	}()
	if known {
		return old
	}
	select {
	case <-ctx.Done():
		return nil
	case <-done:
		c.mu.Lock()
		ids := copyIDs(hit.ids)
		c.mu.Unlock()
		return ids
	}
}
