// Versioned feature adapter. No routeRequest call, scoring, selection, credentials,
// upstream URLs, or request text crosses this contract.
import { analyzeRequest } from '../../src/router.mjs';
import { estimateRequestCapacity } from '../../src/request-capacity.mjs';

export function decisionInput(body, config, runtime = {}) {
  const r = config.routing;
  const analysis = { ...(runtime.analysisOverride || analyzeRequest(body, config)), ...estimateRequestCapacity(body, config) };
  const numeric = (value, fallback) => {
    const n = Number(value ?? fallback);
    if (!Number.isFinite(n)) throw new Error('Non-finite contract feature');
    return n;
  };
  const relative = r.relQualityCap;
  const relativeValue = typeof relative === 'number' || typeof relative === 'string' ? relative : relative?.[analysis.tier];
  const live = r.livePenalty || {};
  const reasoning = config.reasoningControl || {};
  const preference = r.taskPreferences?.[analysis.task];
  return {
    schemaVersion: 1, configVersion: String(config.version), requestedModel: body.model || r.autoModelId || 'auto',
    completionTokens: numeric(body.max_completion_tokens || body.max_tokens || 0),
    thinkingSpecified: body.chat_template_kwargs?.enable_thinking !== undefined,
    thinkingOff: body.chat_template_kwargs?.enable_thinking === false,
    analysis: { task: analysis.task, subTask: analysis.subTask || '', tier: analysis.tier,
      complexity: analysis.complexity, estimatedContextTokens: analysis.estimatedContextTokens,
      requirements: analysis.requirements || {} },
    policy: {
      scoreStrategy: r.scoreStrategy || 'weighted', mode: r.mode, shadowModel: r.shadowModel || '', autoModelId: r.autoModelId || 'auto',
      activeTrafficPercent: numeric(r.activeTrafficPercent, 100), qualityFloor: numeric(r.qualityFloor),
      qualityWeight: numeric(r.qualityWeight), costWeight: numeric(r.costWeight), providerCostWeight: numeric(r.providerCostWeight, 0),
      latencyWeight: numeric(r.latencyWeight), preferSelfHosted: Boolean(r.preferSelfHosted), selfHostedBonus: numeric(r.selfHostedBonus),
      uncertaintyPenalty: numeric(r.uncertaintyPenalty), complexQualityMargin: numeric(r.complexQualityMargin, 0),
      relativeQualityCap: numeric(relativeValue, analysis.tier === 'simple' ? 0.08 : analysis.tier === 'complex' ? 0.02 : 0.04),
      allowQualityDegradation: r.allowQualityDegradation === true, costTier: r.costTier || 'custom',
      subtaskSmoothK: numeric(r.subtaskSmoothK, 32), subtaskMinSamples: numeric(r.subtaskMinSamples, 4), subtaskMaxAdjust: numeric(r.subtaskMaxAdjust, 0.06),
      latencyScaleMs: numeric(live.latencyScaleMs, 300000), latencyMax: numeric(live.latencyMax, 0.2),
      errorStep: numeric(live.errorStep, 0.08), errorMax: numeric(live.errorMax, 0.3),
      budgetCostMultiplier: numeric(r.budgetCostMultiplier, 2), budgetDegradeThreshold: numeric(config.budget?.degradeThreshold, 0.9),
      loadEnabled: r.loadBalancing?.enabled === true, loadPenaltyWeight: numeric(r.loadBalancing?.penaltyWeight, 0.2),
      reasoningEnabled: reasoning.enabled === true, reasoningHighMin: numeric(reasoning.highMinComplexity, 0.78), reasoningOffMax: numeric(reasoning.offMaxComplexity, 0.3),
      preference: preference?.model ? { model: preference.model, tolerance: numeric(preference.tolerance, 0.02) } : null
    },
    models: config.models.map(model => {
      const sub = model.benchmarkScores?.subtasks?.[analysis.subTask];
      const control = model.reasoningControl || {};
      const limit = Number(r.loadBalancing?.limits?.[model.id]);
      return {
        id: model.id, enabled: Boolean(model.enabled), ownership: model.ownership || '', capabilities: model.capabilities || {},
        contextWindow: numeric(model.contextWindow, 0), quality: numeric(model.quality?.[analysis.task] ?? model.quality?.default, 0.75),
        subscore: sub && Number.isFinite(Number(sub.avg)) && sub.n > 0 ? { average: Number(sub.avg), samples: Number(sub.n) } : null,
        costIndex: numeric(model.costIndex || 0), providerCostIndex: numeric(model.costIndexProvider, 0.5), latencyIndex: numeric(model.latencyIndex || 0),
        reliabilityVerified: model.reliabilityStatus === 'verified', capacity: Number.isInteger(limit) && limit > 0 ? limit : 0,
        minimumCompletionTokens: numeric(model.minimumCompletionTokensForReliableAnswer, 0),
        verifiedThinkingOff: Boolean(control.verified && control.parameter === 'chat_template_kwargs.enable_thinking' && control.values?.off === false),
        reasoningVerified: Boolean(control.verified), reasoningParameter: control.parameter || 'reasoning_effort',
        reasoningValues: control.values || { off: 'low', standard: 'medium', high: 'high' }
      };
    }),
    runtime: {
      nowMs: numeric(runtime.now || Date.now()), trafficBucket: numeric(runtime.trafficBucket, 0), budgetPressure: numeric(runtime.budgetPressure || 0),
      allowedModelIds: runtime.allowedModelIds ? [...runtime.allowedModelIds] : null,
      health: Object.fromEntries(config.models.map(m => {
        const h = runtime.health?.[m.id] || {};
        return [m.id, { circuitOpenUntil: numeric(h.circuitOpenUntil, 0), ewmaLatencyMs: numeric(h.ewmaLatencyMs, 0), consecutiveFailures: numeric(h.consecutiveFailures, 0) }];
      })),
      inflight: Object.fromEntries(config.models.map(m => [m.id, Math.max(0, numeric(runtime.modelLoad?.[m.id]?.inflight, 0))])),
      marketAdjustments: Object.fromEntries(config.models.map(m => [m.id, numeric(runtime.marketSignals?.[analysis.task]?.[m.id], 0)]))
    }
  };
}

// Compare behavior, not language-specific wording or observation-only diagnostics.
export function selectionProjection(d) {
  return {
    configVersion: d.configVersion, requestedModel: d.requestedModel, selectedModel: d.selectedModel, suggestedModel: d.suggestedModel,
    reasoningLevel: d.reasoningLevel, shadow: d.shadow, rollout: d.rollout,
    qualityDegraded: d.qualityDegraded, preferenceApplied: d.preferenceApplied ?? Boolean(d.preference),
    fallbackOrder: d.fallbackOrder, qualifiedModelIds: d.qualifiedModelIds,
    rejected: d.rejected.map(r => ({ model: r.model, reasons: [...r.reasons].sort() })),
    candidates: d.candidates.map(c => ({ model: c.model, quality: c.quality, score: c.score, baseScore: c.baseScore,
      marketAdjust: c.marketAdjust, costIndex: c.costIndex, qualityQualified: c.qualityQualified,
      qualityEligible: c.qualityEligible, qualityLoss: c.qualityLoss, effectiveQualityFloor: c.effectiveQualityFloor, load: c.load }))
  };
}

export function referenceError(error) {
  if (error.code === 'model_capacity_exhausted') return error.code;
  if (error.message.includes('没有达到质量门槛')) return 'quality_gate';
  if (error.message.includes('没有满足硬性能力')) return 'no_candidates';
  if (error.message.includes('未知评分策略')) return 'unsupported_strategy';
  throw error;
}
