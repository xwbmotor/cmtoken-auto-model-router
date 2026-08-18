import test from 'node:test';
import assert from 'node:assert/strict';
import { computeCostIndex } from '../src/config.mjs';

test('computeCostIndex 由部署资源估算相对成本，最贵归一化到 1', () => {
  const models = [
    { id: 'cheap', deployment: { deviceType: '910B2', machines: 2, cardsPerMachine: 8, tps: 10000 } },
    { id: 'expensive', deployment: { deviceType: '910B2', machines: 4, cardsPerMachine: 8, tps: 5000 } },
  ];
  const result = computeCostIndex(models, { cardPrice: { '910B2': 1 } });
  // expensive：硬件是 cheap 的 2 倍、吞吐是 1/2，单位成本是 4 倍 → 归一化 1.0
  assert.equal(result.expensive, 1);
  assert.equal(result.cheap, 0.25);
});

test('computeCostIndex 跳过无 deployment 或字段不全的模型', () => {
  const models = [
    { id: 'a', deployment: { deviceType: '910B2', machines: 1, cardsPerMachine: 1, tps: 100 } },
    { id: 'b', deployment: null },
    { id: 'c', deployment: { deviceType: '910B2', machines: 1 } }, // 缺 tps
  ];
  const result = computeCostIndex(models, {});
  assert.deepEqual(Object.keys(result), ['a']);
});

test('computeCostIndex 卡型权重生效', () => {
  const models = [
    { id: 'b2', deployment: { deviceType: '910B2', machines: 1, cardsPerMachine: 1, tps: 100 } },
    { id: 'b4', deployment: { deviceType: '910B4', machines: 1, cardsPerMachine: 1, tps: 100 } },
  ];
  const result = computeCostIndex(models, { cardPrice: { '910B2': 1, '910B4': 2 } });
  assert.equal(result.b4, 1);
  assert.equal(result.b2, 0.5);
});

test('computeCostIndex 无有效部署时返回 null', () => {
  assert.equal(computeCostIndex([{ id: 'a', deployment: null }], {}), null);
});
