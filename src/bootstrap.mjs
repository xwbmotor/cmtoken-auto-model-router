// v0.11.0：bootstrap 置信区间（无依赖、可复现）。
// 用途：交错评测给每个模型的质量分/时延估计配 CI——小样本下点估计会骗人，
// CI 宽度本身也是信息（区间太宽=样本不足，不下结论）。
// 语义：
//   bootstrapMean(values, {repeats, alpha, seed}) → { mean, lo, hi, n }
//   bootstrapMedian(...) 同构
// seed 固定 → 同一输入永远同一区间（可复现，写进评测报告可复核）。
// 实现：Mulberry32 PRNG（32bit，快且够用）+ 经典 percentile bootstrap。

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  return sorted[base];
}

// statistic: 'mean' | 'median'
export function bootstrap(values, { repeats = 2000, alpha = 0.05, seed = 42, statistic = 'mean' } = {}) {
  const arr = (values || []).filter((v) => typeof v === 'number' && Number.isFinite(v));
  const n = arr.length;
  if (!n) return { mean: null, median: null, lo: null, hi: null, n: 0 };
  const mean = arr.reduce((a, b) => a + b, 0) / n;
  const sorted0 = [...arr].sort((a, b) => a - b);
  const median = quantile(sorted0, 0.5);
  if (n < 2) return { mean, median, lo: arr[0], hi: arr[0], n };

  const rand = mulberry32(seed);
  const estimates = new Array(repeats);
  for (let r = 0; r < repeats; r++) {
    let sum = 0;
    if (statistic === 'median') {
      const sample = new Array(n);
      for (let i = 0; i < n; i++) sample[i] = arr[Math.floor(rand() * n)];
      sample.sort((a, b) => a - b);
      estimates[r] = quantile(sample, 0.5);
    } else {
      for (let i = 0; i < n; i++) sum += arr[Math.floor(rand() * n)];
      estimates[r] = sum / n;
    }
  }
  estimates.sort((a, b) => a - b);
  return { mean, median, lo: quantile(estimates, alpha / 2), hi: quantile(estimates, 1 - alpha / 2), n };
}

// 两个独立样本的差值 CI（A−B）：CI 不含 0 → 差异显著（alpha 水平）。
// 返回 { diff, lo, hi, significant }；样本不足（任一 <2）返回 n:0。
export function bootstrapDiff(valuesA, valuesB, { repeats = 2000, alpha = 0.05, seed = 42, statistic = 'mean' } = {}) {
  const a = (valuesA || []).filter((v) => typeof v === 'number' && Number.isFinite(v));
  const b = (valuesB || []).filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (a.length < 2 || b.length < 2) return { diff: null, lo: null, hi: null, significant: null, nA: a.length, nB: b.length };
  const rand = mulberry32(seed);
  const statFn = (sample) => {
    if (statistic === 'median') {
      const s = [...sample].sort((x, y) => x - y);
      return quantile(s, 0.5);
    }
    return sample.reduce((x, y) => x + y, 0) / sample.length;
  };
  const estimates = new Array(repeats);
  for (let r = 0; r < repeats; r++) {
    const sa = new Array(a.length); const sb = new Array(b.length);
    for (let i = 0; i < a.length; i++) sa[i] = a[Math.floor(rand() * a.length)];
    for (let i = 0; i < b.length; i++) sb[i] = b[Math.floor(rand() * b.length)];
    estimates[r] = statFn(sa) - statFn(sb);
  }
  estimates.sort((x, y) => x - y);
  const lo = quantile(estimates, alpha / 2); const hi = quantile(estimates, 1 - alpha / 2);
  return { diff: statFn(a) - statFn(b), lo, hi, significant: lo > 0 || hi < 0, nA: a.length, nB: b.length };
}
