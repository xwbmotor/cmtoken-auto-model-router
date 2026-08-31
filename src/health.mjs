// v0.10.4：健康状态机独立模块（可单测）。
// 语义：EWMA 时延；成功清零计数/探针连败/downSince；失败累计并按阈值开熔断；
// downSince 只在熔断首次打开时设置（单次失败≠宕机）；半开探针失败计连败。
export function newHealthState() {
  return { circuitState: 'closed', probeInFlight: false, consecutiveFailures: 0, successes: 0, failures: 0,
    ewmaLatencyMs: 0, circuitOpenUntil: 0, lastSuccessAt: 0, downSince: 0, halfOpenFailStreak: 0, lastFailureAt: 0 };
}

export function updateHealthState(state, ok, latencyMs, cfg = { circuitBreakerFailures: 3, circuitBreakerCooldownMs: 30000 }) {
  if (ok) {
    state.ewmaLatencyMs = state.ewmaLatencyMs ? Math.round(state.ewmaLatencyMs * 0.8 + latencyMs * 0.2) : latencyMs;
    state.circuitState = 'closed'; state.probeInFlight = false; state.consecutiveFailures = 0; state.successes += 1;
    state.circuitOpenUntil = 0; state.lastSuccessAt = Date.now(); state.downSince = 0; state.halfOpenFailStreak = 0;
    return state;
  }
  const wasProbe = state.circuitState === 'half_open';
  state.probeInFlight = false;
  state.consecutiveFailures += 1; state.failures += 1;
  state.lastFailureAt = Date.now();
  if (wasProbe) state.halfOpenFailStreak = (state.halfOpenFailStreak || 0) + 1;
  if (wasProbe || state.consecutiveFailures >= cfg.circuitBreakerFailures) {
    state.circuitState = 'open';
    state.circuitOpenUntil = Date.now() + cfg.circuitBreakerCooldownMs;
    if (!state.downSince) state.downSince = Date.now(); // 只在熔断首次打开时设置
  }
  return state;
}

// 下线告警判定（与 /admin/api/model-offline-alerts 同语义）：
// 非关闭态 + 10 分钟内有失败证据 + （持续≥30min 或 半开连败≥3 且≥10min）
export function offlineAlertDue(state, now = Date.now()) {
  if (!state.downSince) return false;
  if (state.circuitState === 'closed') return false;
  if (!state.lastFailureAt || (now - state.lastFailureAt) > 600000) return false;
  const downMin = (now - state.downSince) / 60000;
  const probeStreak = state.halfOpenFailStreak || 0;
  return downMin >= 30 || (probeStreak >= 3 && downMin >= 10);
}
