import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelLoadTracker, loadAssessment } from '../src/model-load.mjs';

test('capacity reservations are atomic, independent by model, and released once', () => {
  const tracker = createModelLoadTracker();
  const routing = { loadBalancing: { enabled: true, limits: { a: 1, b: 2 } } };
  const release = tracker.acquire({ id: 'a' }, routing);
  assert.equal(tracker.acquire({ id: 'a' }, routing), null);
  assert.equal(loadAssessment({ id: 'a' }, routing, tracker.snapshot()).saturated, true);
  const other = tracker.acquire({ id: 'b' }, routing);
  release(); release();
  assert.equal(loadAssessment({ id: 'a' }, routing, tracker.snapshot()).inflight, 0);
  assert.equal(loadAssessment({ id: 'b' }, routing, tracker.snapshot()).inflight, 1);
  other(); assert.deepEqual(tracker.snapshot(), {});
});

test('unknown/global deployment concurrency is not mistaken for a local admission limit', () => {
  const model = { id: 'a', deployment: { totalConcurrency: 1 } };
  const assessment = loadAssessment(model, { loadBalancing: { enabled: true } }, { a: { inflight: 20 } });
  assert.equal(assessment.capacity, null);
  assert.equal(assessment.penalty, 0);
  assert.equal(assessment.saturated, false);
});

test('load penalty reflects bounded local utilization and can be disabled', () => {
  const routing = { loadBalancing: { enabled: true, penaltyWeight: 0.2, limits: { a: 10 } } };
  assert.equal(loadAssessment({ id: 'a' }, routing, { a: { inflight: 5 } }).penalty, 0.05);
  assert.equal(loadAssessment({ id: 'a' }, routing, { a: { inflight: 30 } }).penalty, 0.2);
  routing.loadBalancing.enabled = false;
  assert.equal(loadAssessment({ id: 'a' }, routing, { a: { inflight: 30 } }).saturated, false);
});
