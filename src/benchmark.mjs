// benchmark → quality 先验映射（纯函数，供 scripts/benchmark-to-quality.mjs 与测试复用）。
// 把通用评测基准的分数映射为路由评分用的 quality[task] 先验，作为冷启动初始值。
// 设计要点：只作「有据可依的起点」，不做长期评分主力——真实流量表现会通过校准判定覆盖它。

export function computeQualityPrior(modelBenchmarks, mapping, scaleFactor = 1) {
  const quality = {};
  const factor = Number.isFinite(Number(scaleFactor)) ? Number(scaleFactor) : 1;
  for (const [task, keys] of Object.entries(mapping || {})) {
    if (!Array.isArray(keys) || keys.length === 0) continue;
    const scores = keys
      .map((key) => Number(modelBenchmarks?.[key]))
      .filter((score) => Number.isFinite(score));
    if (!scores.length) continue;
    const avg = scores.reduce((sum, score) => sum + score, 0) / scores.length;
    quality[task] = Number((avg * factor).toFixed(3));
  }
  // default 维度：所有已知 benchmark 分数的平均（不乘 scaleFactor，作为跨任务的兜底质量）
  const all = Object.values(modelBenchmarks || {})
    .map((score) => Number(score))
    .filter((score) => Number.isFinite(score));
  if (all.length) quality.default = Number((all.reduce((sum, score) => sum + score, 0) / all.length).toFixed(3));
  return quality;
}
