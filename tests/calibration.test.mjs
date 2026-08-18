import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldPromoteVerified } from '../src/calibration.mjs';
import { computeQualityPrior } from '../src/benchmark.mjs';

// ---------- shouldPromoteVerified（翻 verified 判定） ----------
test('calibration 未启用时返回 null', () => {
  assert.equal(shouldPromoteVerified({ calibrationStatus: 'pilot' }, { successes: 1000, failures: 0 }, { enabled: false }), null);
});

test('已 verified 的模型不再重复判定', () => {
  assert.equal(shouldPromoteVerified({ calibrationStatus: 'verified' }, { successes: 1000, failures: 0 }, { enabled: true, minSamples: 100 }), null);
});

test('样本不足时不翻 verified', () => {
  assert.equal(shouldPromoteVerified({ calibrationStatus: 'pilot' }, { successes: 50, failures: 0 }, { enabled: true, minSamples: 200 }), null);
});

test('失败率超标时不翻 verified', () => {
  assert.equal(shouldPromoteVerified({ calibrationStatus: 'pilot' }, { successes: 900, failures: 100 }, { enabled: true, minSamples: 200, maxFailureRate: 0.05 }), null);
});

test('样本达标且失败率达标时返回判定结果', () => {
  const verdict = shouldPromoteVerified({ calibrationStatus: 'pilot' }, { successes: 990, failures: 10 }, { enabled: true, minSamples: 200, maxFailureRate: 0.05 });
  assert.ok(verdict);
  assert.equal(verdict.samples, 1000);
  assert.equal(verdict.failureRate, 0.01);
});

test('缺少 calibrationStatus 字段的模型也可判定', () => {
  const verdict = shouldPromoteVerified({}, { successes: 200, failures: 0 }, { enabled: true, minSamples: 200 });
  assert.ok(verdict);
});

// ---------- computeQualityPrior（benchmark → quality 映射） ----------
test('按映射表折算 task 维度 quality 先验', () => {
  const mapping = { coding: ['terminal_bench', 'scicode'], reasoning: ['gpqa_diamond'] };
  const scores = { terminal_bench: 0.5, scicode: 0.3, gpqa_diamond: 0.6 };
  const quality = computeQualityPrior(scores, mapping, 1);
  assert.equal(quality.coding, 0.4);    // (0.5 + 0.3) / 2
  assert.equal(quality.reasoning, 0.6);
  assert.equal(quality.default, 0.467); // (0.5 + 0.3 + 0.6) / 3
});

test('scaleFactor 只作用于 task 维度，default 不缩放', () => {
  const mapping = { coding: ['terminal_bench'] };
  const scores = { terminal_bench: 0.5 };
  const quality = computeQualityPrior(scores, mapping, 0.9);
  assert.equal(quality.coding, 0.45);  // 0.5 * 0.9
  assert.equal(quality.default, 0.5);  // 不缩放
});

test('缺失的 benchmark 分数自动跳过该 task', () => {
  const mapping = { coding: ['terminal_bench', 'scicode'], reasoning: ['hle'] };
  const scores = { terminal_bench: 0.5 };
  const quality = computeQualityPrior(scores, mapping, 1);
  assert.equal(quality.coding, 0.5);          // 只有 terminal_bench
  assert.equal(quality.reasoning, undefined); // hle 缺失 → 跳过
  assert.equal(quality.default, 0.5);
});

test('无任何 benchmark 分数时返回空对象', () => {
  const quality = computeQualityPrior({}, { coding: ['terminal_bench'] }, 1);
  assert.deepEqual(quality, {});
});
