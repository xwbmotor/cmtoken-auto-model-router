// This worker deliberately imports only the pure routing calculation. It has no
// gateway, semantic classifier, upstream client, receipt store or training loop.
import { parentPort, workerData } from 'node:worker_threads';
import { routeRequest, autoModelId } from './router.mjs';

try {
  const { body, config, allowedModelIds } = workerData;
  const decision = routeRequest({ ...body, model: autoModelId(config) }, config, {
    allowedModelIds: new Set(allowedModelIds), trafficBucket: 0, marketSignals: {}
  });
  const analysis = decision.analysis;
  // Explicit projection: no message text, matching excerpts, free-form error or
  // client-supplied identifiers enter the result or the metadata audit stream.
  parentPort.postMessage({ ok: true, decision: {
    suggestedModel: decision.suggestedModel,
    fallbackOrder: decision.fallbackOrder,
    analysis: {
      task: analysis.task, subTask: analysis.subTask, tier: analysis.tier,
      complexity: analysis.complexity, confidence: analysis.confidence,
      confidenceFactors: analysis.confidenceFactors,
      textLength: analysis.textLength,
      estimatedInputTokens: analysis.estimatedInputTokens,
      estimatedOutputTokens: analysis.estimatedOutputTokens,
      estimatedContextTokens: analysis.estimatedContextTokens,
      requirements: analysis.requirements,
      signals: analysis.signals.map(({ key, contribution }) => ({ key, contribution })),
      routeMethod: 'rules'
    },
    candidates: decision.candidates.map(c => ({
      model: c.model, score: c.score, baseScore: c.baseScore, quality: c.quality,
      qualityEligible: c.qualityEligible, costIndex: c.costIndex,
      latencyIndex: c.latencyIndex, qualityLoss: c.qualityLoss
    })),
    rejected: decision.rejected.filter(r => allowedModelIds.includes(r.model)),
    reasoningLevel: decision.reasoningLevel,
    qualityDegraded: decision.qualityDegraded,
    qualifiedModelIds: decision.qualifiedModelIds,
    configVersion: config.version
  } });
} catch (error) {
  const code = error?.code === 'model_capacity_exhausted' ? 'model_capacity_exhausted'
    : error?.message?.startsWith('没有达到质量门槛') ? 'quality_gate' : 'no_candidates';
  parentPort.postMessage({ ok: false, code });
}
