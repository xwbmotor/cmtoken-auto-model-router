// v0.5.2 新增：BudgetTracker 预占-结算数学（Codex 二审 P0：v0.5.1 公式系统性少记）
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetTracker } from '../src/budget.mjs';

const cfg = (over = {}) => ({ budget: { enabled: true, dailyBudgetYuan: 100, beansPerYuan: 70, timeZone: 'Asia/Shanghai', ...over } });

async function fresh(config) {
  const dir = await mkdtemp(join(tmpdir(), 'amr-budget-'));
  const t = new BudgetTracker(join(dir, 'ledger.json'), config, {});
  return { t, dir, ledger: () => readFile(join(dir, 'ledger.json'), 'utf8').then(JSON.parse) };
}

test('release cancels unstarted work without creating estimated or actual spend, and is idempotent', async () => {
  const { t, dir } = await fresh(cfg());
  try {
    const unstarted = await t.reserve(5), running = await t.reserve(3);
    await t.release(unstarted); await t.release(unstarted);
    assert.equal(t.snapshot().estimatedSpendYuan, 3);
    assert.equal(t.snapshot().settledSpendYuan, 0);
    assert.equal(t.snapshot().pendingReserves, 1);
    await t.settle(running, 2, true);
    assert.equal(t.snapshot().settledSpendYuan, 2);
  } finally { await t.pendingWrite.catch(() => {}); await rm(dir, { recursive: true, force: true }); }
});

test('reserve 预占进 estimatedSpendYuan，settle 按 usage 冲正（实际 > 预占）', async () => {
  const { t, dir, ledger } = await fresh(cfg());
  const id = await t.reserve(10);
  let s = t.snapshot();
  assert.equal(s.estimatedSpendYuan, 10, '预占 10 应记入 estimated');
  await t.settle(id, 15, true);
  s = t.snapshot();
  // v0.5.2 修复断言：预占 10、实际 15 → settled=15 且 estimated 归零（v0.5.1 会错记成 5）
  assert.equal(s.settledActualSpendYuan, 15, 'settledActual 应为 15（非 v0.5.1 的 5）');
  assert.equal(s.estimatedSpendYuan, 0, '预占冲正后 estimated 应归零');
  assert.equal(s.settles, 1);
  await t.pendingWrite.catch(() => {}); await rm(dir, { recursive: true, force: true });
});

test('实际 < 预占：回滚多占部分，settled 只记实际', async () => {
  const { t, dir } = await fresh(cfg());
  const id = await t.reserve(10);
  await t.settle(id, 4, true);
  const s = t.snapshot();
  assert.equal(s.settledActualSpendYuan, 4);
  assert.equal(s.estimatedSpendYuan, 0);
  await t.pendingWrite.catch(() => {}); await rm(dir, { recursive: true, force: true });
});

test('实际 == 预占：exactSettles + settled 同步入账（v0.5.1 提前 return 漏记 actual）', async () => {
  const { t, dir } = await fresh(cfg());
  const id = await t.reserve(7);
  await t.settle(id, 7, true);
  const s = t.snapshot();
  assert.equal(s.exactSettles, 1);
  assert.equal(s.settledActualSpendYuan, 7, '相等时 settled 也应入账');
  assert.equal(s.estimatedSpendYuan, 0);
  await t.pendingWrite.catch(() => {}); await rm(dir, { recursive: true, force: true });
});

test('无 usage（fromUsage=false）：估算结清且预占冲减（v0.5.3 修三审 P0：原实现不冲减，费用双记）', async () => {
  const { t, dir } = await fresh(cfg());
  const id = await t.reserve(3);
  await t.settle(id, null, false);
  const s = t.snapshot();
  assert.equal(s.estimatedSettles, 1);
  assert.equal(s.settledEstimatedSpendYuan, 3, '估算结清入 settledEstimated');
  assert.equal(s.estimatedSpendYuan, 0, '结算后预占必须冲减归零——v0.5.2 该值仍为 3（双重占用）');
  assert.equal(s.settledActualSpendYuan ?? 0, 0);
  assert.equal(t.pressure(), 0.03, '压力应含已结算估算：3/100');
  await t.pendingWrite.catch(() => {}); await rm(dir, { recursive: true, force: true });
});

test('三审 P0：pressure 必须计入已结算消费（预算耗尽触发降级）', async () => {
  const { t, dir } = await fresh(cfg());
  // 预占 90 → 压力 0.9；按实际 90 结算后压力必须保持 0.9（v0.5.2 原实现回落 0，降级永不触发）
  const id = await t.reserve(90);
  assert.equal(t.pressure(), 0.9);
  await t.settle(id, 90, true);
  assert.equal(t.snapshot().estimatedSpendYuan, 0, '结算后无在途预占');
  assert.equal(t.pressure(), 0.9, 'v0.5.3 核心：结算后压力不得回落——预算保护失效即此 bug');
  // 混合口径：已结算实际 90 + 在途预占 10 = 1.0 封顶
  const id2 = await t.reserve(10);
  assert.equal(t.pressure(), 1);
  await t.settle(id2, null, false);
  assert.equal(t.pressure(), 1, '估算结清同样计入');
  await t.pendingWrite.catch(() => {}); await rm(dir, { recursive: true, force: true });
});

test('多次请求累计：estimated 收敛到 0，settled 累加', async () => {
  const { t, dir } = await fresh(cfg());
  const a = await t.reserve(10); const b = await t.reserve(20);
  assert.equal(t.snapshot().estimatedSpendYuan, 30);
  await t.settle(a, 12, true); await t.settle(b, 18, true);
  const s = t.snapshot();
  assert.equal(s.estimatedSpendYuan, 0);
  assert.equal(s.settledActualSpendYuan, 30);
  assert.equal(t.reserves.size, 0, 'reserves 不残留');
  await t.pendingWrite.catch(() => {}); await rm(dir, { recursive: true, force: true });
});

test('reserve(null)（模型未定价）：记 unpriced 不建台账预占', async () => {
  const { t, dir } = await fresh(cfg());
  const id = await t.reserve(null);
  const s = t.snapshot();
  assert.equal(s.unpricedRequests, 1);
  assert.equal(s.pricedRequests ?? 0, 0);
  await t.settle(id, null, false); // 结算 no-op 不炸
  await t.pendingWrite.catch(() => {}); await rm(dir, { recursive: true, force: true });
});

test('ledger 落盘异步但最终一致（settle 不阻塞热路径）', async () => {
  const { t, dir, ledger } = await fresh(cfg());
  const id = await t.reserve(10);
  await t.settle(id, 15, true);
  await t.pendingWrite; // 等 batched write
  const disk = await ledger();
  assert.equal(disk.settledActualSpendYuan, 15);
  assert.equal(disk.estimatedSpendYuan, 0);
  await t.pendingWrite.catch(() => {}); await rm(dir, { recursive: true, force: true });
});

test('跨日保留旧在途预占，旧请求结算不能冲减新请求预占', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-06T15:59:50Z') });
  const { t, dir, ledger } = await fresh(cfg());
  try {
    const old = await t.reserve(10);
    context.mock.timers.tick(20000); // Asia/Shanghai midnight
    const next = await t.reserve(20);
    assert.equal(t.snapshot().date, '2026-09-07');
    assert.equal(t.snapshot().estimatedSpendYuan, 30);
    await t.settle(old, 12, true);
    assert.equal(t.snapshot().estimatedSpendYuan, 20);
    assert.equal(t.snapshot().settledActualSpendYuan, 12);
    assert.equal(t.pressure(), .32);
    await t.settle(next, null, false);
    assert.equal(t.snapshot().estimatedSpendYuan, 0);
    assert.equal(t.snapshot().settledEstimatedSpendYuan, 20);
    await t.pendingWrite;
    assert.equal((await ledger()).settledActualSpendYuan, 12);
  } finally { await t.pendingWrite; await rm(dir, { recursive: true, force: true }); }
});

test('跨日直接结算也先换日，重复结算不会多计', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-06T15:59:50Z') });
  const { t, dir } = await fresh(cfg());
  try {
    const old = await t.reserve(7);
    context.mock.timers.tick(20000);
    await t.settle(old, null, false);
    await t.settle(old, 9, true);
    const s = t.snapshot();
    assert.equal(s.date, '2026-09-07');
    assert.equal(s.estimatedSpendYuan, 0);
    assert.equal(s.settledEstimatedSpendYuan, 7);
    assert.equal(s.settledActualSpendYuan ?? 0, 0);
    assert.equal(s.pendingReserves, 0);
  } finally { await t.pendingWrite; await rm(dir, { recursive: true, force: true }); }
});

test('completed Go cost projection preserves other reservations, actual/estimated/unpriced totals and restart state', async () => {
  const { t, dir, ledger } = await fresh(cfg({ enabled: false }));
  try {
    const running = await t.reserve(9);
    await t.observeCompletedAttempt(2, 3, true);
    await t.observeCompletedAttempt(4, null, false);
    await t.observeCompletedAttempt(null, null, false);
    await t.observeCompletedAttempt(1, 0, true);
    const state = t.snapshot();
    assert.equal(state.pendingReserves, 1); assert.equal(state.estimatedSpendYuan, 9);
    assert.equal(state.answerActualCostYuan, 3); assert.equal(state.answerEstimatedCostYuan, 4);
    assert.equal(state.settledSpendYuan, 7); assert.equal(state.pricedRequests, 4); assert.equal(state.unpricedRequests, 1);
    await t.pendingWrite;
    const restarted = new BudgetTracker(join(dir, 'restart.json'), cfg({ enabled: false }), await ledger());
    assert.equal(restarted.snapshot().settledSpendYuan, 7);
    await t.settle(running, 8, true);
    assert.equal(t.snapshot().settledSpendYuan, 15); assert.equal(t.snapshot().pendingReserves, 0);
  } finally { await t.pendingWrite; await rm(dir, { recursive: true, force: true }); }
});
