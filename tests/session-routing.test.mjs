import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionRoutingKey, chooseSessionModel } from '../src/session-routing.mjs';

const decision = () => ({ selectedModel: 'best', analysis: { task: 'coding', tier: 'complex', subTask: 'debugging' },
  qualifiedModelIds: ['best'], candidates: [{ model: 'cheap', score: 1.0 }, { model: 'best', score: 0.9 }],
  fallbackOrder: ['best', 'cheap'] });
const current = () => ({ model: 'cheap', task: 'coding', tier: 'complex', subTask: 'debugging', expiresAt: 5000 });

test('session cannot reselect a candidate outside the quality gate, even with a higher score', () => {
  assert.equal(chooseSessionModel(current(), decision(), {}, 1000), 'best');
});
test('eligible same-shape session can retain model, but task/subtask changes invalidate it', () => {
  const d = decision(); d.qualifiedModelIds.push('cheap'); d.candidates[0].score = 0.89;
  assert.equal(chooseSessionModel(current(), d, {}, 1000), 'cheap');
  assert.equal(chooseSessionModel({ ...current(), subTask: 'frontend-ui' }, d, {}, 1000), 'best');
  assert.equal(chooseSessionModel({ ...current(), expiresAt: 999 }, d, {}, 1000), 'best');
  d.candidates[0].score = 0.1;
  assert.equal(chooseSessionModel(current(), d, {}, 1000), 'best');
});
test('session digest separates tenant and upstream, normalizes Bearer, and contains no credentials', () => {
  const args = { sessionId: 'conversation-1', authorization: 'Bearer secret-a', upstream: 'https://one/v1' };
  const key = sessionRoutingKey(args, 'test-private-secret');
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(key, sessionRoutingKey({ ...args, authorization: 'bearer secret-a' }, 'test-private-secret'));
  assert.notEqual(key, sessionRoutingKey({ ...args, authorization: 'Bearer secret-b' }, 'test-private-secret'));
  assert.notEqual(key, sessionRoutingKey({ ...args, upstream: 'https://two/v1' }, 'test-private-secret'));
  assert.equal(sessionRoutingKey({ ...args, authorization: '' }, 'test-private-secret'), null);
});
