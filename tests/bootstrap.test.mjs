import test from 'node:test';
import assert from 'node:assert/strict';
// v0.11.0：bootstrap CI 模块测试——可复现性/区间覆盖/差值显著性/边界
import { bootstrap, bootstrapDiff } from '../src/bootstrap.mjs';

test('bootstrap：点估计正确 + 区间覆盖真值 + 可复现（同 seed 同区间）', () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const r1 = bootstrap(values, { seed: 42 });
  const r2 = bootstrap(values, { seed: 42 });
  assert.strictEqual(r1.mean, 5.5);
  assert.strictEqual(r1.median, 5.5);
  assert.strictEqual(r1.n, 10);
  assert.ok(r1.lo < 5.5 && r1.hi > 5.5, `区间应跨点估计：[${r1.lo}, ${r1.hi}]`);
  assert.deepStrictEqual(r1, r2, '同 seed 必须完全可复现');
  // 不同 seed 区间应近似（统计稳定）
  const r3 = bootstrap(values, { seed: 7 });
  assert.ok(Math.abs(r3.lo - r1.lo) < 0.5 && Math.abs(r3.hi - r1.hi) < 0.5);
});

test('bootstrap：空/单样本/非数值边界', () => {
  assert.strictEqual(bootstrap([]).n, 0);
  assert.strictEqual(bootstrap(null).n, 0);
  assert.strictEqual(bootstrap([1, NaN, undefined, 2]).n, 2);
  const single = bootstrap([5]);
  assert.strictEqual(single.lo, 5); assert.strictEqual(single.hi, 5);
});

test('bootstrapDiff：明显差异显著、相同分布不显著', () => {
  // A 集中在 10，B 集中在 1 → 差异应显著（lo>0）
  const A = [9, 10, 10, 11, 10, 9.5, 10.5];
  const B = [0.5, 1, 1, 1.5, 1, 0.8, 1.2];
  const d = bootstrapDiff(A, B, { seed: 42 });
  assert.ok(d.significant === true, `lo=${d.lo} hi=${d.hi} 应显著`);
  assert.ok(d.lo > 0);
  // 同分布 → 不显著
  const X = [1, 2, 3, 4, 5, 6, 7];
  const Y = [1, 2, 3, 4, 5, 6, 7];
  const d2 = bootstrapDiff(X, Y, { seed: 42 });
  assert.strictEqual(d2.significant, false);
  assert.ok(d2.lo <= 0 && d2.hi >= 0, 'CI 应含 0');
  // 样本不足
  const d3 = bootstrapDiff([1], [2, 3]);
  assert.strictEqual(d3.nA, 1);
  assert.strictEqual(d3.significant, null);
});

test('bootstrap：median 统计量可用', () => {
  const values = [1, 2, 3, 100]; // 均值被离群点拉高，中位数稳健
  const m = bootstrap(values, { seed: 1, statistic: 'median' });
  assert.strictEqual(m.median, 2.5);
  assert.ok(m.lo <= 2.5 && m.hi >= 2.5);
});
