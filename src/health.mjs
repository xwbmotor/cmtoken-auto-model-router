// v0.10.4：健康状态机独立模块（可单测）。
// 语义：EWMA 时延；成功清零计数/探针连败/downSince；失败累计并按阈值开熔断；
// downSince 只在熔断首次打开时设置（单次失败≠宕机）；半开探针失败计连败。
export function newHealthState() {
  return { circuitState: 'closed', probeInFlight: false, consecutiveFailures: 0, successes: 0, failures: 0,
    ewmaLatencyMs: 0, circuitOpenUntil: 0, lastSuccessAt: 0, downSince: 0, halfOpenFailStreak: 0, lastFailureAt: 0 };
}

// Only provider/transport failures are evidence about shared model health.
// A 429 has ambiguous account/provider scope, so it never opens a global circuit.
export function classifyUpstreamFailure(error, { clientGone = false } = {}) {
  if (clientGone || error?.message === 'client_disconnected') return { scope: 'client', countModelFailure: false, retryable: false };
  const status = Number(error?.upstreamStatus);
  if (status === 401) return { scope: 'credential', countModelFailure: false, retryable: false };
  if (status === 402 || status === 403) return { scope: 'entitlement', countModelFailure: false, retryable: false };
  if (status === 429) return { scope: 'rate_limit', countModelFailure: false, retryable: false };
  if (status >= 400 && status < 500 && status !== 408) return { scope: 'request', countModelFailure: false, retryable: false };
  if (error?.failureScope === 'capacity') return { scope: 'capacity', countModelFailure: false, retryable: false };
  if (error?.failureScope === 'configuration') return { scope: 'configuration', countModelFailure: false, retryable: false };
  return { scope: 'provider', countModelFailure: true, retryable: error?.retryable !== false };
}

export function releaseCircuitAttempt(state) {
  // A cancelled/unauthorized half-open probe provides no evidence of recovery.
  if (state) state.probeInFlight = false;
}

export function updateHealthState(state, ok, latencyMs, cfg = { circuitBreakerFailures: 3, circuitBreakerCooldownMs: 30000 }) {
  // v0.10.5：EWMA 恢复与 server 原实现等价——成功与失败都更新（失败/超时时延同样形成动态时延惩罚）
  state.ewmaLatencyMs = state.ewmaLatencyMs ? Math.round(state.ewmaLatencyMs * 0.8 + latencyMs * 0.2) : latencyMs;
  if (ok) {
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
