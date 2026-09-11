import { recommendReasoningLevel } from './router.mjs';

// Mirror router.mjs's observation-only calculation over the already computed
// native candidates. Never reroute or alter the actual selection/fallback order.
export function attachGoLatencyObservation(decision, config, { health = {}, latencyAssessment, budgetPressure = 0 } = {}) {
  if (config.routing?.latencyObservation?.mode !== 'shadow' || decision.analysis?.task === 'explicit') return decision;
  const analysis = decision.analysis;
  if (latencyAssessment) {
    let level = recommendReasoningLevel(analysis, config);
    if (Number(budgetPressure || 0) >= Number(config.budget?.degradeThreshold ?? 0.9)) level = level === 'high' ? 'standard' : 'off';
    const models = new Map(config.models.map(model => [model.id, model]));
    for (const candidate of decision.candidates) {
      const model = models.get(candidate.model);
      if (!model) continue;
      const p = config.routing.livePenalty || {};
      const legacyLatency = Math.min(Number(p.latencyMax ?? 0.2), Number(health?.[model.id]?.ewmaLatencyMs || 0) / Number(p.latencyScaleMs ?? 300000));
      const evidence = latencyAssessment(model, analysis, level, Number(config.routing.latencyWeight || 0) * Number(model.latencyIndex || 0) + legacyLatency);
      if (evidence) candidate.latencyEvidence = evidence;
    }
  }
  const pool = decision.candidates.filter(candidate => (decision.qualityDegraded || candidate.qualityEligible) && !candidate.load?.saturated);
  // A successful auto decision always has a nonempty pool. Invalid/incomplete
  // event data must not invent an alternative route or shadow recommendation.
  if (!pool.length) return decision;
  const shadowPool = pool.map(c => ({ ...c, score: c.score + (c.latencyEvidence?.adjustment || 0) }))
    .sort((a, b) => b.score - a.score || a.costIndex - b.costIndex);
  const pref = config.routing.taskPreferences?.[analysis.task];
  const preferred = !decision.qualityDegraded && pref?.model ? shadowPool.find(c => c.model === pref.model) : null;
  if (preferred && shadowPool[0].score - preferred.score <= Number(pref.tolerance ?? 0.02) + 1e-9) {
    shadowPool.splice(shadowPool.indexOf(preferred), 1); shadowPool.unshift(preferred);
  }
  const baseline = decision.suggestedModel;
  const base = shadowPool.find(c => c.model === baseline), proposed = shadowPool[0];
  const ready = base?.latencyEvidence?.status === 'ready' && proposed?.latencyEvidence?.status === 'ready';
  const changed = ready && proposed.model !== baseline && proposed.score - base.score >= Number(config.routing.latencyObservation.switchMargin ?? 0.02);
  decision.latencyShadow = { mode: 'shadow', scope: 'qualified_candidates_before_session', baselineModel: baseline,
    proposedModel: changed ? proposed.model : baseline, changed: Boolean(changed),
    reason: !ready ? 'insufficient_comparable_evidence' : changed ? 'bounded_latency_advantage' : 'within_switch_margin' };
  return decision;
}
