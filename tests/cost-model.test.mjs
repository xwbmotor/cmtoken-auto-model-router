import test from 'node:test';
import assert from 'node:assert/strict';
import { computeCostIndex, computeCostIndexFromPricing } from '../src/config.mjs';

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

test('computeCostIndexFromPricing 按定价与流量构成归一化，最贵为 1', () => {
  // 真实录入价：MiniMax-M3 vs DeepSeek V4 Flash，10:1 构成
  const models = [
    { id: 'm3', pricingYuanPerMillionTokens: { input: 3.78, output: 15.12 } },
    { id: 'dsf', pricingYuanPerMillionTokens: { input: 0.5, output: 1.0 } },
  ];
  const result = computeCostIndexFromPricing(models, { pricingMix: { input: 10, output: 1 } });
  assert.equal(result.m3, 1);
  // dsf 加权单价 = (10×0.5 + 1×1.0)/11 = 0.5455；m3 = (10×3.78+1×15.12)/11 = 4.811
  assert.ok(Math.abs(result.dsf - 0.5455 / 4.811) < 0.002, `dsf=${result.dsf}`);
});

test('computeCostIndexFromPricing 构成比例影响相对成本', () => {
  const models = [
    { id: 'a', pricingYuanPerMillionTokens: { input: 1, output: 10 } },
    { id: 'b', pricingYuanPerMillionTokens: { input: 2, output: 1 } },
  ];
  // 输入为主(10:1)：a=1.818, b=1.909；输出为主(1:10)：a=9.182, b=1.091 → a 反转为最贵
  const inputHeavy = computeCostIndexFromPricing(models, { pricingMix: { input: 10, output: 1 } });
  const outputHeavy = computeCostIndexFromPricing(models, { pricingMix: { input: 1, output: 10 } });
  assert.ok(inputHeavy.b === 1 && inputHeavy.a > 0.9);
  assert.ok(outputHeavy.a === 1 && outputHeavy.b < 0.3);
});

test('computeCostIndexFromPricing 跳过缺价模型，不足两个返回 null', () => {
  const models = [
    { id: 'a', pricingYuanPerMillionTokens: { input: 1 } }, // 缺 output
    { id: 'b', pricingYuanPerMillionTokens: null },
    { id: 'c', pricingYuanPerMillionTokens: { input: 1, output: 2 } },
  ];
  assert.equal(computeCostIndexFromPricing(models, { pricingMix: { input: 10, output: 1 } }), null);
});
