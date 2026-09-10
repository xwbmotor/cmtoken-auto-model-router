// Configuration-only projection. No requests, credentials, endpoints, prompts,
// model metadata or unrelated management configuration enter the Go snapshot.
const pick = (value, keys) => Object.fromEntries(keys.filter(k => value?.[k] !== undefined).map(k => [k, value[k]]));
export function featureConfig(config) {
  const routing = pick(config.routing, [
    'allowExplicitModel', 'sessionStickinessTtlMs', 'sessionStickinessMaxGap', 'scoreStrategy', 'mode', 'shadowModel', 'autoModelId',
    'activeTrafficPercent', 'qualityFloor', 'qualityWeight', 'costWeight', 'providerCostWeight', 'latencyWeight', 'preferSelfHosted',
    'selfHostedBonus', 'uncertaintyPenalty', 'complexQualityMargin', 'relQualityCap', 'allowQualityDegradation', 'costTier',
    'subtaskSmoothK', 'subtaskMinSamples', 'subtaskMaxAdjust', 'budgetCostMultiplier'
  ]);
  routing.livePenalty = pick(config.routing.livePenalty, ['latencyScaleMs', 'latencyMax', 'errorStep', 'errorMax']);
  routing.loadBalancing = pick(config.routing.loadBalancing, ['enabled', 'penaltyWeight', 'limits']);
  routing.taskPreferences = Object.fromEntries(Object.entries(config.routing.taskPreferences || {}).map(([task, p]) => [task, pick(p, ['model', 'tolerance'])]));
  return {
    schemaVersion: 1, version: String(config.version), routing,
    budget: pick(config.budget, ['degradeThreshold']),
    reasoningControl: pick(config.reasoningControl, ['enabled', 'highMinComplexity', 'offMaxComplexity']),
    models: config.models.map(m => ({
      ...pick(m, ['id', 'enabled', 'ownership', 'capabilities', 'contextWindow', 'quality', 'costIndex', 'costIndexProvider', 'latencyIndex', 'reliabilityStatus', 'minimumCompletionTokensForReliableAnswer']),
      reasoningControl: pick(m.reasoningControl, ['verified', 'parameter', 'values']),
      benchmarkScores: { subtasks: Object.fromEntries(Object.entries(m.benchmarkScores?.subtasks || {}).map(([task, s]) => [task, pick(s, ['avg', 'n'])])) }
    }))
  };
}
