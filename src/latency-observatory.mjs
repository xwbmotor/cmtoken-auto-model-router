import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

// Histograms retain all accepted observations, not just a reservoir of fast requests.
// Quantiles are bucket upper bounds; overflow uses the observed maximum.
export const LATENCY_BOUNDS = [25, 50, 100, 150, 250, 400, 600, 1000, 1500, 2000, 3000, 5000, 7500, 10000, 15000, 20000, 30000, 45000, 60000, 90000, 120000, 180000, 300000, 600000, 1200000, 3600000, 7200000];
export const LATENCY_METRICS = ['ttftMs', 'firstOutputMs', 'completionMs', 'attemptMs', 'upstreamTtftMs', 'upstreamFirstOutputMs'];
const MINUTE = 60000, HOUR = 3600000, RETENTION = 14 * 24 * HOUR;
const dimensions = ['model', 'scope', 'inference', 'source', 'stream', 'reasoning', 'inputBand', 'outputBand'];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
const band = (n, low, high) => Number(n) <= low ? 'short' : Number(n) <= high ? 'medium' : 'long';

export function latencyContext({ model, payload, analysis = {}, baseUrl, authorization, scope, source = 'business' }) {
  const controls = {
    reasoning_effort: payload.reasoning_effort ?? null,
    thinking: payload.thinking ?? null,
    chat_template_kwargs: payload.chat_template_kwargs ?? null,
    reasoning: payload.reasoning ?? null
  };
  const toolRequest = Boolean(payload.tools?.length || payload.functions?.length);
  const disabled = payload.chat_template_kwargs?.enable_thinking === false || payload.thinking?.type === 'disabled' || payload.reasoning_effort === 'none';
  const enabled = payload.chat_template_kwargs?.enable_thinking === true || payload.thinking?.type === 'enabled' || ['low', 'medium', 'high'].includes(payload.reasoning_effort);
  return {
    model: model.id, source, stream: payload.stream === true,
    scope: scope ?? hash([baseUrl, authorization || '', model.id]),
    inference: hash([controls, model.reasoningControl || null, analysis.task || null, toolRequest, payload.response_format || null, payload.temperature ?? null, payload.top_p ?? null]),
    toolRequest,
    reasoning: disabled ? 'off' : enabled ? 'on' : 'unknown',
    inputBand: band(analysis.estimatedInputTokens ?? 0, 1024, 8192),
    outputBand: band(payload.max_completion_tokens ?? payload.max_tokens ?? analysis.estimatedOutputTokens ?? 1024, 256, 2048)
  };
}

function blank() { return { count: 0, success: 0, failed: 0, cancelled: 0, timeout: 0, lastAt: 0, metrics: {} }; }
function histogram() { return { n: 0, sum: 0, max: 0, lastAt: 0, bins: {} }; }
function metricAdd(h, n) {
  if (!Number.isFinite(n) || n < 0) return;
  const i = LATENCY_BOUNDS.findIndex(bound => n <= bound);
  const key = i < 0 ? LATENCY_BOUNDS.length : i;
  h.n++; h.sum += n; h.max = Math.max(h.max, n); h.bins[key] = (h.bins[key] || 0) + 1;
}
function add(s, row) {
  s.count++; s.lastAt = Math.max(s.lastAt, row.at);
  const cancelled = row.failureScope === 'client';
  if (row.ok) s.success++; else if (cancelled) s.cancelled++; else s.failed++;
  if (row.timeout) s.timeout++;
  // A quick error or cancellation is never evidence that a model is fast.
  if (row.ok) for (const key of LATENCY_METRICS) {
    const value = row[key];
    if (Number.isFinite(value) && value >= 0) { const h = s.metrics[key] ||= histogram(); metricAdd(h, value); h.lastAt = Math.max(h.lastAt, row.at); }
  }
}
function merge(a, b) {
  for (const k of ['count', 'success', 'failed', 'cancelled', 'timeout']) a[k] += b[k] || 0;
  a.lastAt = Math.max(a.lastAt, b.lastAt);
  for (const [key, value] of Object.entries(b.metrics)) {
    const h = a.metrics[key] ||= histogram();
    h.n += value.n; h.sum += value.sum; h.max = Math.max(h.max, value.max);
    h.lastAt = Math.max(h.lastAt, value.lastAt || 0);
    for (const [i, n] of Object.entries(value.bins)) h.bins[i] = (h.bins[i] || 0) + n;
  }
  return a;
}
function quantile(h, q) {
  if (!h?.n) return null;
  let count = 0;
  for (let i = 0; i <= LATENCY_BOUNDS.length; i++) {
    count += h.bins[i] || 0;
    if (count >= Math.ceil(h.n * q)) return Math.min(h.max, LATENCY_BOUNDS[i] ?? h.max);
  }
  return null;
}
function view(s, metric) {
  const h = s.metrics[metric];
  return { count: s.count, success: s.success, failed: s.failed, cancelled: s.cancelled, timeout: s.timeout,
    lastAt: s.lastAt ? new Date(s.lastAt).toISOString() : null, validCount: h?.n || 0,
    metricLastAt: h?.lastAt ? new Date(h.lastAt).toISOString() : null,
    p50Ms: quantile(h, 0.5), p95Ms: h?.n >= 40 ? quantile(h, 0.95) : null,
    p95Reliable: (h?.n || 0) >= 40, meanMs: h?.n ? Math.round(h.sum / h.n) : null };
}

export class LatencyObservatory {
  constructor({ path = null, now = Date.now, maxBuckets = 24000 } = {}) {
    this.path = path; this.now = now; this.maxBuckets = maxBuckets;
    this.minutes = new Map(); this.hours = new Map(); this.lastPrune = 0;
    this.storage = { evictedBuckets: 0, persistErrors: 0, restoreErrors: 0 };
    this.shadow = { count: 0, changed: 0, lastAt: null };
    this.evidenceWindows = new Map(); this.evidenceStartedAt = new Date(now()).toISOString();
    this.probeState = { day: '', calls: 0, lastRunAt: null, modelLastAt: {} };
    this.pending = null; this.dirty = false;
  }
  prune() {
    const now = this.now();
    for (const [map, before] of [[this.minutes, now - 31 * MINUTE], [this.hours, now - RETENTION]]) {
      for (const [key, bucket] of map) if (bucket.at < before) map.delete(key);
      while (map.size > this.maxBuckets) { map.delete(map.keys().next().value); this.storage.evictedBuckets++; }
    }
    this.lastPrune = now;
    for (const [at] of this.evidenceWindows) if (at < now - 31 * MINUTE) this.evidenceWindows.delete(at);
  }
  record(row) {
    if (!row.model || typeof row.ok !== 'boolean' || !Number.isFinite(row.at) || row.at > this.now() || row.at < this.now() - RETENTION) return;
    const dims = Object.fromEntries(dimensions.map(key => [key, row[key]]));
    const signature = JSON.stringify(dimensions.map(key => row[key]));
    for (const [map, width] of [[this.minutes, MINUTE], [this.hours, HOUR]]) {
      const at = Math.floor(row.at / width) * width, key = `${at}:${signature}`;
      let bucket = map.get(key);
      if (!bucket) { bucket = { at, ...dims, stats: blank() }; map.set(key, bucket); }
      add(bucket.stats, row);
    }
    this.dirty = true;
    if (this.now() - this.lastPrune > MINUTE || this.minutes.size > this.maxBuckets || this.hours.size > this.maxBuckets) this.prune();
  }
  recent(context, metric, minutes = 30) {
    const result = blank(), now = this.now();
    const signature = JSON.stringify(dimensions.map(key => context[key]));
    for (let at = Math.floor((now - minutes * MINUTE) / MINUTE) * MINUTE; at <= now; at += MINUTE) {
      const bucket = this.minutes.get(`${at}:${signature}`);
      if (bucket) merge(result, bucket.stats);
    }
    return view(result, metric);
  }
  incidentWindows() {
    // Complete minute buckets give non-overlapping 5 / 25 minute windows.
    const end = Math.floor(this.now() / MINUTE) * MINUTE, groups = new Map();
    for (const b of this.minutes.values()) {
      if (b.source !== 'business' || b.at < end - 30 * MINUTE || b.at >= end) continue;
      const context = Object.fromEntries(dimensions.map(k => [k, b[k]]));
      const key = hash(context);
      let g = groups.get(key);
      if (!g) { g = { key, context, current: blank(), baseline: blank() }; groups.set(key, g); }
      merge(b.at >= end - 5 * MINUTE ? g.current : g.baseline, b.stats);
    }
    return [...groups.values()].map(g => {
      const metric = g.context.stream ? 'upstreamFirstOutputMs' : 'attemptMs';
      return { key: g.key, context: g.context, metric, windowEnd: end,
        current: view(g.current, metric), baseline: view(g.baseline, metric) };
    });
  }
  assessment(context, { minSamples = 20, staleMs = 300000, scaleMs = 10000, maxAdjust = 0.05 } = {}, baselinePenalty = 0, latencyWeight = 0.14) {
    // Synthetic short probes do not determine business latency rankings.
    const metric = context.stream ? (context.reasoning === 'on' || context.toolRequest ? 'upstreamFirstOutputMs' : 'upstreamTtftMs') : 'attemptMs';
    const stats = this.recent({ ...context, source: 'business' }, metric);
    const age = stats.metricLastAt ? Math.max(0, this.now() - Date.parse(stats.metricLastAt)) : Infinity;
    const usable = stats.validCount >= minSamples && age < staleMs && stats.success / Math.max(1, stats.success + stats.failed) >= 0.9;
    const confidence = usable ? Math.min(1, stats.validCount / (minSamples * 2)) * Math.max(0, 1 - age / staleMs) : 0;
    const target = stats.p50Ms == null ? baselinePenalty : latencyWeight * Math.min(1, stats.p50Ms / scaleMs);
    const adjustment = Math.max(-maxAdjust, Math.min(maxAdjust, baselinePenalty - target)) * confidence;
    return { metric, ...stats, adjustment: Number(adjustment.toFixed(5)), confidence: Number(confidence.toFixed(3)),
      status: !stats.validCount ? 'no_data' : stats.validCount < minSamples ? 'insufficient' : age >= staleMs ? 'stale' : !usable ? 'unreliable' : 'ready' };
  }
  noteShadow(value, candidates = []) {
    if (!value) return;
    this.shadow.count++; if (value.changed) this.shadow.changed++;
    this.shadow.lastAt = new Date(this.now()).toISOString(); this.dirty = true;
    const assessed = candidates.filter(c => c.latencyEvidence && !c.load?.saturated && c.qualityEligible);
    if (!assessed.length) return;
    const at = Math.floor(this.now() / MINUTE) * MINUTE;
    const bucket = this.evidenceWindows.get(at) || { requests: 0, anyReady: 0, allReady: 0, models: Object.create(null) };
    bucket.requests++;
    const ready = assessed.filter(c => c.latencyEvidence.status === 'ready').length;
    if (ready) bucket.anyReady++;
    if (ready === assessed.length) bucket.allReady++;
    for (const c of assessed) {
      const counts = bucket.models[c.model] ||= Object.create(null);
      const status = c.latencyEvidence.status;
      counts[status] = (counts[status] || 0) + 1;
    }
    this.evidenceWindows.set(at, bucket);
    for (const [minute] of this.evidenceWindows) if (minute < at - 31 * MINUTE) this.evidenceWindows.delete(minute);
  }
  evidenceCoverage() {
    const result = { windowMinutes: 30, startedAt: this.evidenceStartedAt, requests: 0, anyReady: 0, allReady: 0, models: Object.create(null) };
    for (const [at, b] of this.evidenceWindows) {
      if (at < Math.floor((this.now() - 30 * MINUTE) / MINUTE) * MINUTE || at > this.now()) continue;
      for (const key of ['requests', 'anyReady', 'allReady']) result[key] += b[key];
      for (const [id, counts] of Object.entries(b.models)) {
        const total = result.models[id] ||= Object.create(null);
        for (const [status, n] of Object.entries(counts)) total[status] = (total[status] || 0) + n;
      }
    }
    return result;
  }
  hasFreshBusiness(scope, minSamples = 20) {
    // Only suppress availability probes for the same upstream credential scope.
    // This does not make these mixed workload samples eligible for ranking.
    const stats = blank(), cutoff = this.now() - 5 * MINUTE;
    for (const b of this.minutes.values()) if (b.scope === scope && b.source === 'business' && b.at >= cutoff) merge(stats, b.stats);
    return (stats.metrics.upstreamFirstOutputMs?.n || 0) >= minSamples && stats.success / Math.max(1, stats.success + stats.failed) >= 0.9;
  }
  dashboard(models, filters = {}) {
    this.prune();
    const metric = LATENCY_METRICS.includes(filters.metric) ? filters.metric : 'ttftMs';
    const source = filters.source === 'probe' ? 'probe' : 'business';
    const now = this.now();
    const local = at => new Date(at + 8 * HOUR);
    const today = local(now).toISOString().slice(0, 10);
    const matches = bucket => bucket.source === source && ['stream', 'reasoning', 'inputBand', 'outputBand'].every(key => !filters[key] || filters[key] === 'all' || String(bucket[key]) === filters[key]);
    const rows = models.map(model => {
      const recent5 = blank(), recent30 = blank(), day = blank(), hours = Array.from({ length: 24 }, blank);
      for (const bucket of this.minutes.values()) {
        if (bucket.model !== model.id || !matches(bucket) || bucket.at > now) continue;
        if (bucket.at >= Math.floor((now - 30 * MINUTE) / MINUTE) * MINUTE) merge(recent30, bucket.stats);
        if (bucket.at >= Math.floor((now - 5 * MINUTE) / MINUTE) * MINUTE) merge(recent5, bucket.stats);
      }
      for (const bucket of this.hours.values()) {
        if (bucket.model !== model.id || !matches(bucket) || bucket.at > now) continue;
        const date = local(bucket.at), weekend = [0, 6].includes(date.getUTCDay());
        if (date.toISOString().slice(0, 10) === today) merge(day, bucket.stats);
        if (filters.dayType === 'weekday' && weekend || filters.dayType === 'weekend' && !weekend) continue;
        merge(hours[date.getUTCHours()], bucket.stats);
      }
      return { model: model.id, name: model.name || model.id, recent5: view(recent5, metric), recent30: view(recent30, metric), today: view(day, metric), hours: hours.map((s, hour) => ({ hour, ...view(s, metric) })) };
    });
    return { at: new Date(now).toISOString(), timeZone: 'Asia/Shanghai', retentionDays: 14,
      quantileMethod: 'histogram_upper_bound', windowResolutionMs: MINUTE, metric, source,
      storage: { ...this.storage, minuteBuckets: this.minutes.size, hourBuckets: this.hours.size, maxBucketsPerTier: this.maxBuckets }, rows, shadow: { ...this.shadow }, evidenceCoverage: this.evidenceCoverage() };
  }
  async restore() {
    if (!this.path) return;
    try {
      if ((await stat(this.path)).size > 64 * 1024 * 1024) throw new Error('Snapshot exceeds size limit');
      const saved = JSON.parse(await readFile(this.path, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.minutes) || !Array.isArray(saved.hours)) throw new Error('Invalid latency snapshot');
      for (const tier of ['minutes', 'hours']) {
        for (const item of saved[tier].slice(-this.maxBuckets)) {
          if (!Array.isArray(item) || !Number.isFinite(item[1]?.at) || item[1].at > this.now() || !item[1]?.stats?.metrics) throw new Error('Invalid bucket');
          const b = item[1];
          if (b.stats.lastAt > this.now()) throw new Error('Future observation');
          for (const n of ['count', 'success', 'failed', 'cancelled', 'lastAt']) if (!Number.isInteger(b.stats[n]) || b.stats[n] < 0) throw new Error('Invalid counts');
          if (b.stats.count !== b.stats.success + b.stats.failed + b.stats.cancelled) throw new Error('Inconsistent counts');
          for (const [key, h] of Object.entries(b.stats.metrics)) {
            if (!LATENCY_METRICS.includes(key) || !Number.isInteger(h.n) || !Number.isFinite(h.sum) || !Number.isFinite(h.max) || !h.bins || h.n < 0 || h.n > b.stats.success || h.sum < 0 || h.max < 0 || !Number.isFinite(h.lastAt) || h.lastAt > this.now() || Object.entries(h.bins).some(([i,n]) => !/^\d+$/.test(i) || Number(i) > LATENCY_BOUNDS.length || !Number.isInteger(n) || n < 0) || Object.values(h.bins).reduce((a,b) => a+b,0) !== h.n || h.sum > h.max * h.n + 0.001) throw new Error('Invalid histogram');
          }
          this[tier].set(item[0], b);
        }
      }
      const p = saved.probeState;
      if (!p || !(p.day === '' && p.calls === 0 || /^\d{4}-\d{2}-\d{2}$/.test(p.day)) || !Number.isInteger(p.calls) || p.calls < 0 || !p.modelLastAt || typeof p.modelLastAt !== 'object' || Array.isArray(p.modelLastAt) || Object.values(p.modelLastAt).some(n => !Number.isFinite(n) || n < 0 || n > this.now()) || (p.lastRunAt != null && (!Number.isFinite(p.lastRunAt) || p.lastRunAt < 0 || p.lastRunAt > this.now()))) throw new Error('Invalid probe budget');
      this.probeState = p;
      if (Number.isInteger(saved.shadow?.count) && Number.isInteger(saved.shadow?.changed)) this.shadow = saved.shadow;
      this.storage.evictedBuckets = Number(saved.evictedBuckets) || 0;
      this.prune();
    } catch (error) {
      if (error.code !== 'ENOENT') { this.storage.restoreErrors++; this.minutes.clear(); this.hours.clear(); this.probeBudgetBlocked = true; }
    }
  }
  async flush(force = false) {
    if (!this.path) return;
    if (this.pending) { await this.pending; if (force && this.dirty) return this.flush(true); return; }
    if (!this.dirty && !force) return;
    this.prune(); this.dirty = false;
    const data = JSON.stringify({ version: 1, minutes: [...this.minutes], hours: [...this.hours], probeState: this.probeState, shadow: this.shadow, evictedBuckets: this.storage.evictedBuckets });
    this.pending = (async () => {
      try {
        if (Buffer.byteLength(data) > 64 * 1024 * 1024) throw new Error('Snapshot exceeds size limit');
        await mkdir(dirname(this.path), { recursive: true });
        const tmp = `${this.path}.${process.pid}.tmp`;
        await writeFile(tmp, data, { mode: 0o600 }); await rename(tmp, this.path);
      } catch { this.storage.persistErrors++; this.dirty = true; }
    })();
    await this.pending; this.pending = null;
  }
}
