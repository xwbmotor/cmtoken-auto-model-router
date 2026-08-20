import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MarketSignal } from '../src/market-signal.mjs';
import { routeRequest } from '../src/router.mjs';

// 市场信号引擎（OpenRouter wisdom-of-market 内网飞轮版）测试：
// 1) 样本不足自动休眠（minSamplePerTask）2) 幅度有界 3) 失败降权 4) 显式点名加成 5) router 热路径融入

function fakeLog(rows) {
  return { recent: async () => rows };
}
function row(at, task, model, ok = true, requested = 'auto') {
  const atIso = new Date(Date.now() - at * 24 * 3600 * 1000).toISOString();
  return { at: atIso, decision: { requestedModel: requested, selectedModel: model, analysis: { task } }, outcome: { ok, model } };
}

function makeConfig() {
  return {
    models: [
      { id: 'a', ownership: 'self_hosted', enabled: true, costIndex: 0.1, latencyIndex: 0.2, quality: { default: 0.85, coding: 0.84 }, calibrationStatus: 'verified' },
      { id: 'b', ownership: 'self_hosted', enabled: true, costIndex: 0.3, latencyIndex: 0.25, quality: { default: 0.87, coding: 0.88 }, calibrationStatus: 'verified' }
    ],
    routing: { mode: 'active', qualityFloor: 0.7, qualityWeight: 1, costWeight: 0.2, latencyWeight: 0.1, selfHostedBonus: 0, uncertaintyPenalty: 0, maxAttempts: 3 },
    taskRules: { patterns: {} }
  };
}

const body = { model: 'auto', messages: [{ role: 'user', content: '写代码函数 debug' }] };

test('样本不足自动休眠：adjust 恒 0', async () => {
  const ms = new MarketSignal({ decisionLog: fakeLog([row(0, 'coding', 'a'), row(0, 'coding', 'a')]), minSamplePerTask: 8 });
  await ms.rebuild();
  assert.equal(ms.adjustFor('coding', 'a'), 0);
  assert.equal(ms.status().tasksActive, 0);
});

test('份额赢家获正向加成（幅度有界 ≤ maxAdjust）', async () => {
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push(row(0, 'coding', 'a'));      // a 占 10/12 = 83%
  for (let i = 0; i < 2; i++) rows.push(row(0, 'coding', 'b'));
  const ms = new MarketSignal({ decisionLog: fakeLog(rows), minSamplePerTask: 8, maxAdjust: 0.05, minShareGap: 0.15 });
  await ms.rebuild();
  const adjA = ms.adjustFor('coding', 'a');
  const adjB = ms.adjustFor('coding', 'b');
  assert.ok(adjA > 0, `a 应有正加成，得到 ${adjA}`);
  assert.equal(adjA, 0.05);   // 明显赢家 = 满额
  assert.equal(adjB, 0);      // 落后者不罚（跑分已定位，信号只奖不追罚）
  assert.equal(ms.status().tasksActive, 1);
});

test('高失败率降权（-maxAdjust）', async () => {
  const rows = [];
  for (let i = 0; i < 8; i++) rows.push(row(0, 'coding', 'a', i < 3)); // 5/8 失败 = 62.5%
  for (let i = 0; i < 4; i++) rows.push(row(0, 'coding', 'b', true));
  const ms = new MarketSignal({ decisionLog: fakeLog(rows), minSamplePerTask: 8, maxAdjust: 0.05, minShareGap: 0.15 });
  await ms.rebuild();
  assert.equal(ms.adjustFor('coding', 'a'), -0.05);
});

test('窗口外数据不计入（7 天滚动窗）', async () => {
  const rows = [row(10, 'coding', 'a'), row(10, 'coding', 'a')]; // 10 天前
  const ms = new MarketSignal({ decisionLog: fakeLog(rows), minSamplePerTask: 2 });
  await ms.rebuild();
  assert.equal(ms.status().tasksTracked, 0);
});

test('显式点名加成（explicitBoost 封顶 0.02）', async () => {
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push(row(0, 'coding', 'a'));
  for (let i = 0; i < 2; i++) rows.push(row(0, 'coding', 'b'));
  for (let i = 0; i < 20; i++) rows.push(row(0, 'coding', 'b', true, 'b')); // 点名 b 20 次
  const ms = new MarketSignal({ decisionLog: fakeLog(rows), minSamplePerTask: 8, maxAdjust: 0.05, minShareGap: 0.15 });
  await ms.rebuild();
  // b: share 落后无正加成，但 explicitBoost 封顶 0.02 → 总调整 = 0.02
  assert.ok(Math.abs(ms.adjustFor('coding', 'b') - 0.02) < 1e-9, `b 应得 +0.02，得到 ${ms.adjustFor('coding', 'b')}`);
});

test('router 热路径：marketSignals 注入改变排序（分差 < adjust 时翻转）', () => {
  const cfg = makeConfig();
  const noSignal = routeRequest(body, cfg, { health: {} });
  // 无信号时 a 略优（便宜 0.04 盖过质量差 0.04）；给 b 注入 +0.05 → b 应翻转为第一
  const withSignal = routeRequest(body, cfg, { health: {}, marketSignals: { coding: { b: 0.05 } } });
  const aNo = noSignal.candidates.find((c) => c.model === 'a').score;
  const bNo = noSignal.candidates.find((c) => c.model === 'b').score;
  assert.ok(aNo > bNo, '无信号时 a 应领先');
  assert.equal(withSignal.suggestedModel, 'b');
  // 候选透出 baseScore/marketAdjust 供调试
  const bCand = withSignal.candidates.find((c) => c.model === 'b');
  assert.ok(bCand.marketAdjust > 0);
  assert.ok(Math.abs(bCand.baseScore + bCand.marketAdjust - bCand.score) < 1e-6);
});

test('无信号注入时行为与旧版一致（回归）', () => {
  const cfg = makeConfig();
  const d = routeRequest(body, cfg, { health: {} });
  for (const c of d.candidates) {
    assert.equal(c.marketAdjust, 0);
    assert.equal(c.score, c.baseScore);
  }
});
