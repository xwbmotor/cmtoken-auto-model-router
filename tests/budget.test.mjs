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

test('无 usage（fromUsage=false）：保留估算口径结清，不动 actual', async () => {
  const { t, dir } = await fresh(cfg());
  const id = await t.reserve(3);
  await t.settle(id, null, false);
  const s = t.snapshot();
  assert.equal(s.estimatedSettles, 1);
  assert.equal(s.settledEstimatedSpendYuan, 3, '估算结清入 settledEstimated');
  assert.equal(s.settledActualSpendYuan ?? 0, 0);
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