// 校准判定：决定一个模型是否从「未校准（pilot/unverified）」翻为「已校准（verified）」。
// 判定依据是运行时健康状态累计的真实表现（成功数 + 失败数），而非 benchmark 先验。
// 这是「benchmark 冷启动先验 → 实时后验」闭环的后半段：跑够样本、失败率达标即解除 uncertaintyPenalty。

export function shouldPromoteVerified(model, healthState, calibration) {
  if (!calibration?.enabled) return null;
  if (!model || model.reliabilityStatus === 'verified') return null;
  if (!healthState) return null;
  const total = (Number(healthState.successes) || 0) + (Number(healthState.failures) || 0);
  const minSamples = Number(calibration.minSamples ?? 200);
  if (!Number.isFinite(minSamples) || total < minSamples) return null;
  const failureRate = (Number(healthState.failures) || 0) / total;
  const maxFailureRate = Number(calibration.maxFailureRate ?? 0.05);
  if (failureRate > maxFailureRate) return null;
  return { samples: total, failureRate: Number(failureRate.toFixed(4)) };
}
