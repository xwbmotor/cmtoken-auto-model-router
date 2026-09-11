package gateway

import (
	"crypto/sha256"
	"math"
	"sync"
	"time"
)

// RateLimitPolicy is exported by the management service with resolved defaults.
// A missing policy retains compatibility with older laboratory snapshots.
type RateLimitPolicy struct {
	Enabled bool `json:"enabled"`
	RPM     int  `json:"rpm"`
	Burst   int  `json:"burst"`
}

type rateBucket struct {
	tokens float64
	last   time.Time
}

// Shared across configuration generations; never retains raw credentials.
type tenantRateLimiter struct {
	mu      sync.Mutex
	buckets map[[32]byte]rateBucket
	pruned  time.Time
}

func (l *tenantRateLimiter) check(authorization string, p *RateLimitPolicy, now time.Time) (bool, int) {
	if p == nil || !p.Enabled {
		return true, 0
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.buckets == nil {
		l.buckets = make(map[[32]byte]rateBucket)
	}
	if l.pruned.IsZero() || now.Sub(l.pruned) >= time.Minute {
		for key, bucket := range l.buckets {
			if now.Sub(bucket.last) > 10*time.Minute {
				delete(l.buckets, key)
			}
		}
		l.pruned = now
	}
	key := sha256.Sum256([]byte(authorization))
	b, exists := l.buckets[key]
	if !exists {
		// Do not evict active buckets: that would let credential churn reset limits.
		if len(l.buckets) >= 20000 {
			return false, 60
		}
		b = rateBucket{tokens: float64(p.Burst), last: now}
	}
	if elapsed := now.Sub(b.last).Seconds(); elapsed > 0 {
		b.tokens = math.Min(float64(p.Burst), b.tokens+elapsed*float64(p.RPM)/60)
		b.last = now
	}
	allowed := b.tokens >= 1
	retry := 0
	if allowed {
		b.tokens--
	} else {
		retry = max(1, int(math.Ceil((1-b.tokens)*60/float64(p.RPM))))
	}
	l.buckets[key] = b
	return allowed, retry
}
