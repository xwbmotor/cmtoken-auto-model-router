import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { routeRequest } from '../src/router.mjs';
import { attachGoLatencyObservation } from '../src/go-core-observation.mjs';

const source = JSON.parse(readFileSync(new URL('../config/router.json', import.meta.url), 'utf8'));
const body = { messages: [{ role: 'user', content: 'hello' }] };
function fixture() {
  const c = structuredClone(source);
  c.models = ['a', 'b', 'c'].map((id, i) => ({ ...structuredClone(source.models.find(m => m.enabled)), id,
    ownership: 'self_hosted', enabled: true, quality: { default: .95 }, benchmarkScores: null,
    costIndex: .1 + i * .01, latencyIndex: .2, minimumCompletionTokensForReliableAnswer: 0 }));
  Object.assign(c.routing, { mode: 'active', activeTrafficPercent: 100, taskPreferences: {}, shadowModel: 'a',
    scoreStrategy: 'weighted', qualityFloor: .7, costWeight: 1, latencyWeight: .1, relQualityCap: .1,
    loadBalancing: { enabled: true, penaltyWeight: .2, limits: { a: 2, b: 2, c: 2 } },
    latencyObservation: { mode: 'shadow', switchMargin: .02 } });
  return c;
}
function compare(config, runtime = {}, assessment = (m, a, level, baseline) => ({ status: 'ready', adjustment: m.id === 'b' ? .1 : 0, baseline, level })) {
  const expectedCalls = [], actualCalls = [];
  const wrap = calls => (m, a, level, baseline) => { calls.push({ model: m.id, analysis: a, level, baseline }); return assessment(m, a, level, baseline); };
  const shared = { trafficBucket: 0, ...runtime };
  const expected = routeRequest(body, config, { ...shared, latencyAssessment: wrap(expectedCalls) });
  const withoutShadow = structuredClone(config); withoutShadow.routing.latencyObservation.mode = 'off';
  const native = routeRequest(body, withoutShadow, shared);
  const preserved = structuredClone(native);
  assert.equal(attachGoLatencyObservation(native, config, { ...runtime, latencyAssessment: wrap(actualCalls) }), native);
  assert.deepEqual(native.latencyShadow, expected.latencyShadow);
  assert.deepEqual(native.candidates.map(c => c.latencyEvidence), expected.candidates.map(c => c.latencyEvidence));
  assert.deepEqual(actualCalls.sort((a,b) => a.model.localeCompare(b.model)), expectedCalls.sort((a,b) => a.model.localeCompare(b.model)));
  const stripped = structuredClone(native); delete stripped.latencyShadow;
  for (const c of stripped.candidates) delete c.latencyEvidence;
  assert.deepEqual(stripped, preserved, 'observation must not alter any native routing fields');
  return native;
}

test('Go observation matches Node ready evidence and legacy latency baseline', () => {
  const d = compare(fixture(), { health: { a: { ewmaLatencyMs: 1200 }, b: { ewmaLatencyMs: 900000 } } });
  assert.equal(d.latencyShadow.reason, 'within_switch_margin');
  assert.equal(compare(fixture()).latencyShadow.reason, 'bounded_latency_advantage');
});
test('Go observation matches Node insufficient evidence', () => {
  const d = compare(fixture(), {}, (m, a, level, baseline) => ({ status: m.id === 'b' ? 'insufficient' : 'ready', adjustment: m.id === 'b' ? .1 : 0, baseline, level }));
  assert.equal(d.latencyShadow.reason, 'insufficient_comparable_evidence');
});
test('Go observation respects task preference in baseline and shadow ordering', () => {
  const c = fixture(); c.routing.taskPreferences.default = { model: 'c', tolerance: .2 };
  const d = compare(c); assert.equal(d.latencyShadow.baselineModel, 'c'); assert.equal(d.latencyShadow.changed, false);
});
test('Go observation excludes saturated candidates even with strong latency evidence', () => {
  const d = compare(fixture(), { modelLoad: { b: { inflight: 2 } } });
  assert.notEqual(d.latencyShadow.proposedModel, 'b');
});
test('Go observation uses explicit quality-degraded pool and ignores task preference', () => {
  const c = fixture(); c.routing.qualityFloor = 1; c.routing.allowQualityDegradation = true;
  c.routing.taskPreferences.default = { model: 'c', tolerance: 1 };
  const d = compare(c); assert.equal(d.qualityDegraded, true); assert.equal(d.latencyShadow.proposedModel, 'b');
});
test('Go observation cannot promote quality-ineligible model', () => {
  const c = fixture(); c.models[1].quality.default = .5;
  const d = compare(c); assert.notEqual(d.latencyShadow.proposedModel, 'b');
});
test('Go observation preserves switch margin and budget-degraded reasoning level', () => {
  const c = fixture(); c.routing.latencyObservation.switchMargin = .5;
  const d = compare(c, { budgetPressure: 1 }); assert.equal(d.latencyShadow.reason, 'within_switch_margin');
});
test('disabled and explicit observations are no-ops', () => {
  const c = fixture(); const d = routeRequest(body, c, { trafficBucket: 0 });
  delete d.latencyShadow; const old = structuredClone(d);
  c.routing.latencyObservation.mode = 'off';
  attachGoLatencyObservation(d, c, { latencyAssessment() { throw new Error('must not assess'); } });
  assert.deepEqual(d, old);
  c.routing.latencyObservation.mode = 'shadow'; d.analysis.task = 'explicit';
  attachGoLatencyObservation(d, c, { latencyAssessment() { throw new Error('must not assess'); } });
  assert.equal(d.latencyShadow, undefined);
});
