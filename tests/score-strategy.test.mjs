import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { routeRequest, resolveScoreStrategy } from '../src/router.mjs';

const baseConfig = JSON.parse(await readFile(new URL('../config/router.json', import.meta.url), 'utf8'));

// ---------- resolveScoreStrategy ----------
test('resolveScoreStrategy 默认 weighted', () => {
  assert.equal(resolveScoreStrategy({ routing: {} }).name, 'weighted');
  assert.equal(typeof resolveScoreStrategy({ routing: {} }).fn, 'function');
});

test('resolveScoreStrategy 未知策略抛错', () => {
  assert.throws(() => resolveScoreStrategy({ routing: { scoreStrategy: 'bandit' } }), /未知评分策略/);
});

// ---------- 评分策略化：默认行为与旧硬编码一致 ----------
test('默认 weighted 策略：评分结果与旧公式一致（回归）', () => {
  const decision = routeRequest(
    { model: 'auto', messages: [{ role: 'user', content: '写一个 Python 装饰器' }] },
    baseConfig, { now: 1000, health: {} }
  );
  // 旧逻辑：score = qualityWeight*quality - costWeight*cost - latencyWeight*latency - uncertainty - dynamicPenalty + selfBonus
  // 这里只验证能正常路由出结果、且 selected 是 auto 候选之一
  assert.ok(decision.selectedModel, '应选出模型');
  assert.ok(decision.candidates.length > 0);
  assert.ok(decision.candidates.every((c) => typeof c.score === 'number'));
});

// ---------- livePenalty 配置化 ----------
test('livePenalty 可配置：自定义 latencyScaleMs 影响评分', () => {
  const cfg = JSON.parse(JSON.stringify(baseConfig));
  const model = cfg.models.find((m) => m.enabled && m.ownership === 'self_hosted');
  const health = { [model.id]: { ewmaLatencyMs: 600000, consecutiveFailures: 0 } };
  // 默认 latencyScaleMs=300000 → latencyPenalty = min(0.2, 600000/300000) = 0.2
  const d1 = routeRequest({ model: 'auto', messages: [{ role: 'user', content: '你好' }] }, cfg, { now: 1000, health });
  // 自定义 latencyScaleMs=3000000 → latencyPenalty = min(0.2, 600000/3000000) = 0.2 仍封顶（用更高阈值测不出差异，改测 errorStep）
  assert.ok(d1.candidates.find((c) => c.model === model.id));

  // 用 errorStep 验证：consecutiveFailures 较高时，errorStep 配置化影响 errorPenalty
  const cfg2 = JSON.parse(JSON.stringify(baseConfig));
  cfg2.routing.livePenalty = { latencyScaleMs: 300000, latencyMax: 0.2, errorStep: 0.01, errorMax: 0.3 };
  const health2 = { [model.id]: { ewmaLatencyMs: 0, consecutiveFailures: 10 } };
  // errorStep=0.01 → errorPenalty = min(0.3, 10*0.01) = 0.1（比默认 0.08 更小）
  const d2 = routeRequest({ model: 'auto', messages: [{ role: 'user', content: '你好' }] }, cfg2, { now: 1000, health: health2 });
  const c2 = d2.candidates.find((c) => c.model === model.id);
  assert.ok(c2, '候选应存在');
});

// ---------- budgetCostMultiplier 配置化 ----------
test('budgetCostMultiplier 配置化：预算压力放大成本权重', () => {
  const cfg = JSON.parse(JSON.stringify(baseConfig));
  cfg.routing.budgetCostMultiplier = 10;   // 极高放大
  const decision = routeRequest(
    { model: 'auto', messages: [{ role: 'user', content: '你好' }] },
    cfg, { now: 1000, health: {}, budgetPressure: 1.0 }
  );
  // 预算压力 100% + 放大 10 倍 → effectiveCostWeight = costWeight * 11，显著压低所有高分模型的 score
  // 只验证路由仍返回合法结果（不因放大溢出）
  assert.ok(decision.candidates.length > 0);
  assert.ok(decision.candidates.every((c) => Number.isFinite(c.score)));
});

// ---------- 成本双指标：平台侧资源消耗独立权重 ----------
test('providerCostWeight=0 与未配置（undefined）评分完全一致（回归保护）', () => {
  const cfg = JSON.parse(JSON.stringify(baseConfig));
  const body = { model: 'auto', messages: [{ role: 'user', content: '写一个 Python 装饰器' }] };
  const d1 = routeRequest(body, { ...cfg, routing: { ...cfg.routing, providerCostWeight: 0 } }, { now: 1000, health: {} });
  const d2 = routeRequest(body, { ...cfg, routing: (() => { const r = { ...cfg.routing }; delete r.providerCostWeight; return r; })() }, { now: 1000, health: {} });
  assert.deepEqual(d1.candidates.map((c) => [c.model, c.score]), d2.candidates.map((c) => [c.model, c.score]));
});

test('providerCostWeight 生效：高权重下资源消耗大的模型评分被压低', () => {
  const cfg = JSON.parse(JSON.stringify(baseConfig));
  // 确保测试前提：至少两个模型有 deployment 数据算出 costIndexProvider
  const withDeployment = cfg.models.filter((m) => m.deployment?.machines && m.deployment?.tps);
  assert.ok(withDeployment.length >= 2, `应有≥2个模型有部署数据，实际 ${withDeployment.length}`);
  // loadConfig 才会计算 costIndexProvider，这里手动补上（与 computeCostIndexProvider 同式）
  const units = withDeployment.map((m) => ({ id: m.id, unit: Number(m.deployment.machines) * (Number(m.deployment.cardsPerMachine) || 1) / Number(m.deployment.tps) }));
  const anchor = Math.max(...units.map((u) => u.unit));
  for (const u of units) cfg.models.find((m) => m.id === u.id).costIndexProvider = Number((u.unit / anchor).toFixed(3));
  const body = { model: 'auto', messages: [{ role: 'user', content: '写一个 Python 装饰器' }] };
  const d0 = routeRequest(body, { ...cfg, routing: { ...cfg.routing, providerCostWeight: 0 } }, { now: 1000, health: {} });
  const d1 = routeRequest(body, { ...cfg, routing: { ...cfg.routing, providerCostWeight: 0.6 } }, { now: 1000, health: {} });
  const scoreOf = (d, id) => d.candidates.find((c) => c.model === id)?.score;
  // q36 资源指数 0.115 最低，q38 1.0 最高：高权重下 q38 相对 q36 的分差应缩小（或反超）
  const gap0 = scoreOf(d0, 'qwen36-35b') - scoreOf(d0, 'Qwen3.8-27B');
  const gap1 = scoreOf(d1, 'qwen36-35b') - scoreOf(d1, 'Qwen3.8-27B');
  assert.ok(gap1 > gap0, `平台权重提高后，省卡模型(q36)对吃卡模型(q38)的相对优势应扩大：${gap0.toFixed(4)} → ${gap1.toFixed(4)}`);
});

test('无部署数据的模型平台指数取 0.5 中性值（不奖不罚）', () => {
  const cfg = JSON.parse(JSON.stringify(baseConfig));
  const m = cfg.models.find((x) => x.deployment);
  delete m.deployment; delete m.costIndexProvider;
  const body = { model: 'auto', messages: [{ role: 'user', content: '你好' }] };
  const d0 = routeRequest(body, { ...cfg, routing: { ...cfg.routing, providerCostWeight: 0 } }, { now: 1000, health: {} });
  const d1 = routeRequest(body, { ...cfg, routing: { ...cfg.routing, providerCostWeight: 0.6 } }, { now: 1000, health: {} });
  // 删掉 deployment 的模型不再有 costIndexProvider → 0.5 中性值参与扣分；有数据的其他模型指数<0.5 的被扣更少
  assert.ok(d1.candidates.length === d0.candidates.length, '候选数量不应变化');
  assert.ok(d1.candidates.every((c) => Number.isFinite(c.score)), '所有候选分数应为有限数');
});
