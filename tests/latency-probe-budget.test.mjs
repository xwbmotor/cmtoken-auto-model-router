import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetTracker } from '../src/budget.mjs';
import { renderPrometheusMetrics } from '../src/metrics.mjs';

async function tracker(t) {
  const dir = await mkdtemp(join(tmpdir(), 'amr-probe-budget-'));
  const b = new BudgetTracker(join(dir, 'ledger.json'), { budget: { enabled: true, dailyBudgetYuan: 100, timeZone: 'Asia/Shanghai' } }, {});
  t.after(async () => { await b.pendingWrite; await rm(dir, { recursive: true, force: true }); });
  return b;
}
function balanced(s) {
  assert.equal(s.totalCostYuan, s.answerActualCostYuan + s.answerEstimatedCostYuan + s.routingOverheadCostYuan
    + s.probeActualCostYuan + s.probeEstimatedCostYuan + s.legacyUnattributedCostYuan);
}

test('probe usage and estimated settlements remain in total budget but not business answers', async t => {
  const b = await tracker(t);
  await b.settle(await b.reserve(3), 2, true, 'probe');
  await b.settle(await b.reserve(5), null, false, 'probe');
  await b.settle(await b.reserve(7), 6, true);
  await b.settle(await b.reserve(4), null, false);
  await b.chargeRouterOverhead(1);
  const s = b.snapshot();
  assert.equal(s.probeActualCostYuan, 2); assert.equal(s.probeEstimatedCostYuan, 5);
  assert.equal(s.probeSettles, 1); assert.equal(s.probeEstimatedSettles, 1);
  assert.equal(s.answerActualCostYuan, 6); assert.equal(s.answerEstimatedCostYuan, 4);
  assert.equal(s.answerSettles, 1); assert.equal(s.answerEstimatedSettles, 1);
  assert.equal(s.totalCostYuan, 18); assert.equal(s.pressure, .18); assert.equal(s.legacyUnattributedCostYuan, 0);
  balanced(s);
  await b.pendingWrite; const saved = JSON.parse(await readFile(b.path, 'utf8'));
  const restored = new BudgetTracker(b.path, b.config, saved); balanced(restored.snapshot());
  assert.equal(restored.snapshot().probeActualCostYuan, 2);
});

test('duplicate probe settlement cannot charge again or reattribute to answer', async t => {
  const b = await tracker(t); const id = await b.reserve(3);
  await b.settle(id, 2, true, 'probe'); await b.settle(id, 9, true); await b.settle(id, null, false, 'probe');
  const s = b.snapshot(); assert.equal(s.totalCostYuan, 2); assert.equal(s.probeSettles, 1);
  assert.equal(s.answerSettles, 0); assert.equal(s.probeEstimatedSettles, 0); balanced(s);
});

test('probe rollover clears old category spend and attributes outstanding probe on settlement day', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-08T15:59:50Z') });
  const b = await tracker(t);
  await b.settle(await b.reserve(4), 3, true, 'probe');
  await b.settle(await b.reserve(2), null, false, 'probe');
  const pending = await b.reserve(7);
  t.mock.timers.tick(20000);
  const before = b.snapshot();
  assert.equal(before.date, '2026-09-09'); assert.equal(before.probeActualCostYuan, 0);
  assert.equal(before.probeEstimatedCostYuan, 0); assert.equal(before.probeSettles, 0); assert.equal(before.probeEstimatedSettles, 0);
  assert.equal(before.estimatedSpendYuan, 7);
  await b.settle(pending, null, false, 'probe'); const s = b.snapshot();
  assert.equal(s.probeEstimatedCostYuan, 7); assert.equal(s.answerEstimatedCostYuan, 0); balanced(s);
});

test('probe gauges expose actual and estimated categories and preserve total', async t => {
  const b = await tracker(t);
  await b.settle(await b.reserve(3), 2, true, 'probe');
  await b.settle(await b.reserve(5), null, false, 'probe');
  const text = renderPrometheusMetrics({ budget: b.snapshot() });
  assert.match(text, /# TYPE router_budget_probe_actual_cost_yuan gauge/);
  assert.match(text, /router_budget_probe_actual_cost_yuan 2\n/);
  assert.match(text, /router_budget_probe_estimated_cost_yuan 5\n/);
  assert.match(text, /router_budget_answer_actual_cost_yuan 0\n/);
  assert.match(text, /router_budget_total_cost_yuan 7\n/);
});
