// 令牌桶限流器：按 key 计数，超限返回 retryAfterMs。
// 用途：防止共享同一 ROUTER_ACCESS_KEY 的调用方打爆上游 MaaS、成本失控。
// 桶按需创建，10 分钟未用自动清理，避免内存泄漏。

export function createRateLimiter({ rpm = 120, burst = rpm } = {}) {
  let refillRate = rpm / 60000; // tokens per millisecond
  let capacity = burst;
  const buckets = new Map(); // key -> { tokens, lastRefill }
  const idleMs = 10 * 60 * 1000; // 10 分钟未访问的桶自动清理

  function check(key, now = Date.now()) {
    let b = buckets.get(key);
    if (!b) {
      b = { tokens: capacity, lastRefill: now };
      buckets.set(key, b);
    }
    const elapsed = now - b.lastRefill;
    if (elapsed > 0) {
      b.tokens = Math.min(capacity, b.tokens + elapsed * refillRate);
      b.lastRefill = now;
    }
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { allowed: true };
    }
    const retryAfterMs = Math.max(1, Math.ceil((1 - b.tokens) / refillRate));
    return { allowed: false, retryAfterMs };
  }

  function prune(now = Date.now()) {
    for (const [key, b] of buckets) {
      if (now - b.lastRefill > idleMs) buckets.delete(key);
    }
  }

  function update({ rpm: r, burst: b }) {
    if (Number.isFinite(r) && r > 0) { refillRate = r / 60000; }
    if (Number.isFinite(b) && b > 0) { capacity = b; }
  }

  return { check, prune, update, size: () => buckets.size };
}
