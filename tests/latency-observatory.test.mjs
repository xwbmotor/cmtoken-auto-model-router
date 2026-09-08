import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LatencyObservatory, latencyContext } from '../src/latency-observatory.mjs';

const NOW = Date.parse('2026-09-08T04:00:20Z'), MIN = 60000;
const ctx = (overrides = {}) => ({ model: 'm', scope: 'tenant-upstream', inference: 'mode-v1', source: 'business',
  stream: true, reasoning: 'off', inputBand: 'short', outputBand: 'short', ...overrides });
const sample = (overrides = {}) => ({ ...ctx(), at: NOW, ok: true, upstreamTtftMs: 100, ttftMs: 150, ...overrides });
function make(options = {}) { return new LatencyObservatory({ now: () => NOW, ...options }); }
async function disk(t) {
  const dir = await mkdtemp(join(tmpdir(), 'router-latency-observatory-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'state.json');
}

test('failure, cancellation and missing timing cannot look fast', () => {
  const o = make();
  o.record(sample({ upstreamTtftMs: 800 }));
  o.record(sample({ ok: false, upstreamTtftMs: 1, timeout: true }));
  o.record(sample({ ok: false, failureScope: 'client', upstreamTtftMs: 0 }));
  o.record(sample({ upstreamTtftMs: null }));
  o.record(sample({ upstreamTtftMs: -1 }));
  const r = o.recent(ctx(), 'upstreamTtftMs');
  assert.equal(r.count, 5); assert.equal(r.success, 3); assert.equal(r.failed, 1); assert.equal(r.cancelled, 1);
  assert.equal(r.timeout, 1); assert.equal(r.validCount, 1); assert.equal(r.meanMs, 800);
  assert.equal(r.p95Ms, null);
});

test('all comparison dimensions isolate samples, including probe traffic', () => {
  const o = make(); o.record(sample());
  for (const [key, value] of Object.entries({ model: 'other', scope: 'other', inference: 'other', source: 'probe',
    stream: false, reasoning: 'on', inputBand: 'long', outputBand: 'long' })) o.record(sample({ [key]: value, upstreamTtftMs: 1 }));
  assert.equal(o.recent(ctx(), 'upstreamTtftMs').validCount, 1);
  assert.equal(o.recent(ctx(), 'upstreamTtftMs').meanMs, 100);
  const probes = make(); for (let i = 0; i < 50; i++) probes.record(sample({ source: 'probe' }));
  assert.equal(probes.assessment(ctx()).status, 'no_data');
});

test('context hashes distinguish credentials, endpoints, and inference without exposing them', () => {
  const args = { model: { id: 'm' }, payload: { stream: true, max_tokens: 128 }, analysis: { estimatedInputTokens: 100 },
    baseUrl: 'https://upstream.invalid/v1', authorization: 'Bearer private-token' };
  const a = latencyContext(args);
  assert.notEqual(a.scope, latencyContext({ ...args, authorization: 'Bearer second-token' }).scope);
  assert.notEqual(a.scope, latencyContext({ ...args, baseUrl: 'https://other.invalid/v1' }).scope);
  assert.notEqual(a.inference, latencyContext({ ...args, payload: { ...args.payload, reasoning_effort: 'high' } }).inference);
  assert.equal(a.inputBand, 'short'); assert.equal(a.outputBand, 'short');
  assert.equal(JSON.stringify(a).includes('private-token'), false);
  const b = latencyContext({ ...args, analysis: { estimatedInputTokens: 9000 }, payload: { max_tokens: 3000 } });
  assert.equal(b.inputBand, 'long'); assert.equal(b.outputBand, 'long'); assert.equal(b.stream, false);
});

test('histograms merge sample weights and P95 appears only at 40 valid samples', () => {
  const o = make();
  for (let i = 0; i < 39; i++) o.record(sample({ at: NOW - MIN, upstreamTtftMs: 100 }));
  assert.equal(o.recent(ctx(), 'upstreamTtftMs').p95Ms, null);
  o.record(sample({ upstreamTtftMs: 10000 }));
  const r = o.recent(ctx(), 'upstreamTtftMs');
  assert.equal(r.validCount, 40); assert.equal(r.p50Ms, 100); assert.equal(r.p95Ms, 100);
  assert.equal(r.meanMs, Math.round((39 * 100 + 10000) / 40));
  const approximate = make(); for (let i = 0; i < 40; i++) approximate.record(sample({ upstreamTtftMs: i === 39 ? 130 : 110 }));
  assert.equal(approximate.recent(ctx(), 'upstreamTtftMs').p50Ms, 130);
});

test('minute windows disclose bucket resolution and exclude old buckets', () => {
  const o = make(); o.record(sample({ at: NOW - 31 * MIN })); o.record(sample({ at: NOW - 29 * MIN }));
  assert.equal(o.recent(ctx(), 'upstreamTtftMs').validCount, 1);
  assert.equal(o.recent(ctx(), 'upstreamTtftMs', 5).validCount, 0);
  assert.equal(o.dashboard([{ id: 'm' }]).windowResolutionMs, MIN);
});

test('assessment is bounded and requires enough samples, successful outcomes and fresh metric', () => {
  let clock = NOW; const o = make({ now: () => clock });
  for (let i = 0; i < 19; i++) o.record(sample());
  assert.equal(o.assessment(ctx()).status, 'insufficient');
  o.record(sample()); const ready = o.assessment(ctx(), {}, 0.2);
  assert.equal(ready.status, 'ready'); assert.ok(Math.abs(ready.adjustment) <= 0.05); assert.ok(ready.confidence <= 1);
  for (let i = 0; i < 3; i++) o.record(sample({ ok: false, upstreamTtftMs: 0 }));
  assert.equal(o.assessment(ctx()).status, 'unreliable'); assert.equal(o.assessment(ctx()).adjustment, 0);
  clock += 300000;
  o.record(sample({ at: clock, upstreamTtftMs: null }));
  assert.equal(o.assessment(ctx()).status, 'stale');
  assert.equal(o.assessment(ctx()).adjustment, 0);
  clock += 31 * MIN; assert.equal(o.assessment(ctx()).status, 'no_data');
});

test('assessment uses stream reasoning output and nonstream attempt metrics separately', () => {
  const o = make();
  for (let i = 0; i < 20; i++) {
    o.record(sample({ reasoning: 'on', upstreamFirstOutputMs: 1000 }));
    o.record(sample({ stream: false, attemptMs: 3000 }));
  }
  assert.equal(o.assessment(ctx({ reasoning: 'on' })).metric, 'upstreamFirstOutputMs');
  assert.equal(o.assessment(ctx({ stream: false })).metric, 'attemptMs');
  assert.equal(o.assessment(ctx({ stream: false })).p50Ms, 3000);
});

test('UTC+8 hour/day mapping and weekday/weekend filter use local calendar', () => {
  const clock = Date.parse('2026-09-07T02:00:00Z'); const o = make({ now: () => clock });
  o.record(sample({ at: Date.parse('2026-09-04T15:30:00Z') })); // Friday 23:30
  o.record(sample({ at: Date.parse('2026-09-04T16:30:00Z') })); // Saturday 00:30
  o.record(sample({ at: Date.parse('2026-09-06T16:30:00Z') })); // Monday 00:30
  const weekday = o.dashboard([{ id: 'm' }], { dayType: 'weekday' }).rows[0];
  const weekend = o.dashboard([{ id: 'm' }], { dayType: 'weekend' }).rows[0];
  assert.equal(weekday.hours[23].count, 1); assert.equal(weekday.hours[0].count, 1);
  assert.equal(weekend.hours[23].count, 0); assert.equal(weekend.hours[0].count, 1);
  assert.equal(weekday.today.count, 1); assert.equal(weekend.today.count, 1);
});

test('bucket cap limits both tiers and reports eviction', () => {
  const o = make({ maxBuckets: 3 });
  for (let i = 0; i < 20; i++) o.record(sample({ scope: `s${i}` }));
  assert.equal(o.minutes.size, 3); assert.equal(o.hours.size, 3); assert.ok(o.storage.evictedBuckets >= 34);
});

test('disk roundtrip preserves metric age, shadow and probe budget', async t => {
  const path = await disk(t); const o = make({ path });
  o.record(sample()); o.noteShadow({ changed: true });
  o.probeState = { day: '2026-09-08', calls: 5, lastRunAt: NOW, modelLastAt: { m: NOW } };
  await o.flush(true); assert.equal(o.storage.persistErrors, 0);
  const r = make({ path }); await r.restore();
  assert.deepEqual(r.recent(ctx(), 'upstreamTtftMs'), o.recent(ctx(), 'upstreamTtftMs'));
  assert.deepEqual(r.probeState, o.probeState); assert.deepEqual(r.shadow, o.shadow);
});

test('malformed snapshot blocks probes and clears partial aggregates', async t => {
  const path = await disk(t); await writeFile(path, '{broken');
  const o = make({ path }); await o.restore();
  assert.equal(o.storage.restoreErrors, 1); assert.equal(o.probeBudgetBlocked, true); assert.equal(o.minutes.size, 0);
});

test('invalid persisted probe budget cannot silently reset to zero', async t => {
  const path = await disk(t);
  await writeFile(path, JSON.stringify({ version: 1, minutes: [], hours: [], probeState: { day: '2026-09-08', calls: -1 } }));
  const o = make({ path }); await o.restore(); assert.equal(o.probeBudgetBlocked, true);
});

test('persisted probe state must validate its model timestamp map', async t => {
  const path = await disk(t);
  await writeFile(path, JSON.stringify({ version: 1, minutes: [], hours: [], probeState: { day: '2026-09-08', calls: 1, lastRunAt: NOW } }));
  const o = make({ path }); await o.restore(); assert.equal(o.probeBudgetBlocked, true);
});

test('corrupted histogram sample count is rejected on restore', async t => {
  const path = await disk(t); const o = make({ path }); o.record(sample());
  o.probeState = { day: '2026-09-08', calls: 0, lastRunAt: null, modelLastAt: {} }; await o.flush(true);
  const saved = JSON.parse(await readFile(path, 'utf8')); saved.minutes[0][1].stats.metrics.upstreamTtftMs.n = 100;
  await writeFile(path, JSON.stringify(saved));
  const restored = make({ path }); await restored.restore(); assert.equal(restored.storage.restoreErrors, 1);
  assert.equal(restored.minutes.size, 0);
});

test('future observations cannot increase confidence or enter current windows', () => {
  const o = make(); for (let i = 0; i < 40; i++) o.record(sample({ at: NOW + 1000 }));
  assert.equal(o.recent(ctx(), 'upstreamTtftMs').validCount, 0);
  assert.ok(o.assessment(ctx()).confidence <= 1);
});

test('nonboolean success marker never contributes a successful timing sample', () => {
  const o = make(); o.record(sample({ ok: 'false', upstreamTtftMs: 1 }));
  assert.equal(o.recent(ctx(), 'upstreamTtftMs').validCount, 0);
});
