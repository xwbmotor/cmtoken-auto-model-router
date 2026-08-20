import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeRequest, costTierBand } from '../src/router.mjs';

// 成本档位带（cost_tier）测试：档位=参数预设+成本带双向过滤（band 非 ceiling）
// 参考 OpenRouter cost_tier 语义：质量档排除过于便宜的模型，省钱档排除超出预算带的模型。

function makeConfig(tier, overrides = {}) {
  return {
    models: [
      { id: 'cheap', ownership: 'self_hosted', enabled: true, costIndex: 0.1, latencyIndex: 0.2, quality: { default: 0.8, coding: 0.78 }, calibrationStatus: 'verified' },
      { id: 'mid', ownership: 'self_hosted', enabled: true, costIndex: 0.35, latencyIndex: 0.25, quality: { default: 0.86, coding: 0.85 }, calibrationStatus: 'verified' },
      { id: 'top', ownership: 'self_hosted', enabled: true, costIndex: 0.9, latencyIndex: 0.3, quality: { default: 0.94, coding: 0.96 }, calibrationStatus: 'verified' }
    ],
    routing: {
      mode: 'active', qualityFloor: 0.7, qualityWeight: 1, costWeight: 0.2, latencyWeight: 0.1,
      selfHostedBonus: 0, uncertaintyPenalty: 0, maxAttempts: 3, ...(tier ? { costTier: tier } : {}), ...overrides
    },
    taskRules: { patterns: {} }
  };
}

const body = { model: 'auto', messages: [{ role: 'user', content: '写一个函数' }] };

test('costTierBand: 未配置/无效档位返回 null（兼容旧配置）', () => {
  assert.equal(costTierBand(makeConfig(null)), null);
  assert.equal(costTierBand(makeConfig('nonsense')), null);
});

test('costTierBand: 四档边界定义正确', () => {
  assert.deepEqual(costTierBand(makeConfig('budget')), { label: '省钱', min: 0, max: 0.2 });
  assert.deepEqual(costTierBand(makeConfig('quality')), { label: '质量', min: 0.15, max: 1 });
});

test('budget 档排除贵模型（above_cost_tier）', () => {
  const d = routeRequest(body, makeConfig('budget'), { health: {} });
  assert.ok(d.rejected.some((r) => r.model === 'top' && r.reasons.includes('above_cost_tier')));
  assert.ok(d.rejected.some((r) => r.model === 'mid' && r.reasons.includes('above_cost_tier')));
  assert.equal(d.suggestedModel, 'cheap');
});

test('quality 档排除过于便宜的模型（below_cost_tier，band 非 ceiling）', () => {
  const d = routeRequest(body, makeConfig('quality'), { health: {} });
  assert.ok(d.rejected.some((r) => r.model === 'cheap' && r.reasons.includes('below_cost_tier')));
  // 带内（mid/top）仍按综合分排名：mid 便宜 0.11 分 ×0.2 权重 ≈ top 质量 0.11 分优势，mid 险胜
  assert.ok(['mid', 'top'].includes(d.suggestedModel));
  assert.ok(!d.candidates.some((c) => c.model === 'cheap'));
});

test('custom 档解除过滤（全部候选参与）', () => {
  const d = routeRequest(body, makeConfig('custom'), { health: {} });
  assert.equal(d.rejected.length, 0);
});

test('max 档只排除最低端', () => {
  const d = routeRequest(body, makeConfig('max'), { health: {} });
  assert.ok(d.rejected.some((r) => r.model === 'cheap' && r.reasons.includes('below_cost_tier')));
  assert.ok(!d.rejected.some((r) => r.model === 'mid'));
  assert.ok(['mid', 'top'].includes(d.suggestedModel));
});
