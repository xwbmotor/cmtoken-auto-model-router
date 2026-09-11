export function goDecision(event, config) {
  const explicit = event.decision.requestedModel !== (config.routing.autoModelId || 'auto');
  const analysis = { ...event.analysis, ...event.decisionAnalysis,
    routeMethod: explicit ? 'explicit' : event.semanticStatus === 'applied' ? 'semantic' : 'rules' };
  const explicitTask = analysis.task;
  if (explicit) { analysis.task = 'explicit'; analysis.tier = 'explicit'; }
  const d = { ...event.decision, analysis, policyRevision: event.configRevision, core: 'go',
    candidates: event.decision.candidates.map(c => {
      const m = config.models.find(model => model.id === c.model);
      return { ...c, ownership: m?.ownership, latencyIndex: m?.latencyIndex,
        calibrationStatus: m?.calibrationStatus, reliabilityStatus: m?.reliabilityStatus || m?.calibrationStatus };
    }),
    ...(explicit ? { explicitTask } : {}),
    semanticReview: { status: event.semanticStatus || 'not_eligible' }
  };
  if (d.preferenceApplied) d.preference = config.routing.taskPreferences?.[analysis.task];
  return d;
}

export function goAttempt(event) {
  const a = event.attempt;
  const usage = a.usage ? { prompt: a.usage.Prompt, completion: a.usage.Completion, cached: a.usage.Cached } : null;
  return { model: a.model, ok: a.ok, upstreamStarted: true, upstreamStatus: a.upstreamStatus || null,
    estimatedCostYuan: a.estimatedMicros === null ? null : a.estimatedMicros / 1000000,
    actualCostYuan: a.actualMicros === null ? null : a.actualMicros / 1000000,
    costFromUsage: a.actualMicros !== null, usage, latencyMs: a.latencyMs,
    failureScope: a.failureScope || null, headerMs: a.headerMs < 0 ? null : a.headerMs,
    timeout: a.timeout === true, timing: { ttftMs: a.ttftMs ?? null, firstOutputMs: a.firstOutputMs ?? null, completionMs: a.latencyMs } };
}

export function goOutcome(result) {
  const attempts = result.events.map(goAttempt), last = attempts.at(-1);
  const duration = Math.max(0, Date.now() - result.startedAt);
  return { ...last, ok: result.ok, transportOk: result.ok, taskSuccess: null, core: 'go',
    error: result.ok ? undefined : result.error || 'upstream_unavailable',
    latencyMs: duration, completionLatencyMs: duration, responseHeaderLatencyMs: result.headerLatencyMs,
    ttftMs: result.timing.firstContentMs, firstOutputMs: result.timing.firstOutputMs, timingVersion: 2,
    attempts, fallbackAttempt: Math.max(0, attempts.length - 1),
    totalAttemptCostYuan: attempts.some(a => a.actualCostYuan === null && a.estimatedCostYuan === null) ? null
      : attempts.reduce((sum, a) => sum + (a.actualCostYuan ?? a.estimatedCostYuan), 0),
    totalAttemptCostKind: attempts.some(a => a.actualCostYuan === null && a.estimatedCostYuan === null) ? 'unknown'
      : attempts.every(a => a.actualCostYuan !== null) ? 'actual' : 'estimated_or_mixed' };
}
