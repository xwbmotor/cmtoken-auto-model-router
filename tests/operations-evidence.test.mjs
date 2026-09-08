import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OperationsEvidence, qualityEvidence, comparisonReadiness } from '../src/operations-evidence.mjs';
import { LatencyObservatory } from '../src/latency-observatory.mjs';

const context = { model: 'm', source: 'business', scope: 'credential-hash', inference: 'shape-hash', stream: false, reasoning: 'off', inputBand: 'short', outputBand: 'short' };
const window = (failed = 5, latency = 3000) => ({ key: 'shape', context, metric: 'attemptMs', current: { success: 20, failed, cancelled: 0, validCount: 20, p50Ms: latency }, baseline: { success: 30, failed: 0, cancelled: 0, validCount: 30, p50Ms: 1000 } });
function fixture() {
  let now = 1800000000000;
  const store = new OperationsEvidence({ now: () => now });
  const check = (windows = [window()], capacities = [], enabledModels = ['m'], revision = 'r1') => store.evaluate({ windows, capacities, revision, enabledModels });
  return { store, check, advance: () => now += 30000, now: () => now };
}
test('incidents require sustained checks, persist while evidence absent and recover only with new healthy evidence', () => {
  const f = fixture(); f.check(); assert.equal(f.store.snapshot().active.length, 0);
  f.advance(); f.check(); assert.equal(f.store.snapshot().active.length, 2);
  f.advance(); f.check([]); assert.ok(f.store.snapshot().active.every(e => e.awaitingData));
  f.advance(); f.check([window(0, 1000)]); assert.equal(f.store.snapshot().active.length, 2);
  f.advance(); f.check([window(0, 1000)]); assert.equal(f.store.snapshot().active.length, 0);
  assert.ok(f.store.snapshot().history.every(e => e.resolution === 'observed_recovery'));
});
test('low volume does not trigger, cancellation is not counted as failure, no overlapping windows', () => {
  const f = fixture(), w = window(0, 1000); w.current.success = 1; w.current.validCount = 1; w.current.cancelled = 100;
  f.check([w]); f.advance(); f.check([w]); assert.equal(f.store.snapshot().active.length, 0);
  const obs = new LatencyObservatory({ now: f.now });
  for (const offset of [1, 5, 6, 29, 30, 31]) obs.record({ ...context, at: f.now() - offset * 60000, ok: true, attemptMs: 1000 });
  obs.record({ ...context, at: f.now(), ok: true, attemptMs: 1 });
  obs.record({ ...context, source: 'probe', at: f.now() - 60000, ok: true, attemptMs: 1 });
  const actual = obs.incidentWindows()[0];
  assert.equal(actual.current.count, 2); assert.equal(actual.baseline.count, 3);
});
test('different scopes and inference conditions remain separate', () => {
  const now = 1800000000000, obs = new LatencyObservatory({ now: () => now });
  for (const scope of ['a', 'b']) for (const inference of ['x', 'y']) obs.record({ ...context, scope, inference, at: now - 60000, ok: true, attemptMs: 1000 });
  assert.equal(obs.incidentWindows().length, 4);
});
test('capacity is process scoped, disabled models close explicitly without claiming recovery', () => {
  const f = fixture(), capacity = [{ model: 'm', capacity: 10, inflight: 9, utilization: 0.9, scope: 'router_process' }];
  f.check([], capacity); f.advance(); f.check([], capacity); assert.equal(f.store.snapshot().active.length, 1);
  f.advance(); f.check([], capacity, [], 'r2');
  const event = f.store.snapshot().history[0]; assert.equal(event.status, 'closed'); assert.equal(event.resolution, 'model_disabled_or_removed');
  assert.equal(f.store.snapshot().configChanges.length, 1);
});
test('incident snapshots survive restart with trigger metadata, samples omit bodies and only match conditions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'amr-evidence-'));
  try {
    const f = fixture(); f.store.path = join(dir, 'events.json');
    f.store.record({ ...context, at: f.now(), ok: false, prompt: 'secret-body', authorization: 'secret-token' }, 'req-1');
    f.store.record({ ...context, scope: 'other', at: f.now(), ok: false }, 'req-other');
    f.check(); f.advance(); f.check(); await f.store.flush();
    const restored = new OperationsEvidence({ path: f.store.path, now: f.now }); await restored.restore();
    assert.equal(restored.snapshot().active.length, 2); assert.ok(restored.snapshot().active.every(e => e.awaitingData));
    const value = JSON.stringify(restored.snapshot()); assert.ok(!value.includes('secret-')); assert.ok(!value.includes('req-other')); assert.ok(value.includes('req-1'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('quality lineage separates missing, amended and historical values without rewriting model scores', () => {
  const models = [{ id: 'm', quality: { coding: .9, simple: .8, default: .7 }, qualitySource: { default: 'old' } }];
  const evidence = { mean: .8, configSource: 'old', validCount: 10, count: 10, duplicateCount: 0 };
  const result = qualityEvidence(models, { models: { m: { coding: evidence, simple: evidence } } });
  assert.deepEqual(result.models[0].scores.map(s => s.status), ['amended_or_mismatch', 'historical_judge', 'missing']);
  assert.equal(models[0].quality.coding, .9);
});
test('HTTP success cannot make a comparison eligible or supply business success labels', () => {
  const r = comparisonReadiness([{ ok: true, transportOk: true }]);
  assert.equal(r.readyForControlledTrial, false); assert.equal(r.taskSuccessLabels, 0); assert.ok(r.blockers.length > 0);
});
