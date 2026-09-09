// Export only resolved semantic policy. URLs and credentials never cross this
// configuration boundary; the Go laboratory requires separate loopback targets.
import { semanticProvider, resolveSmallAcceptThreshold } from '../../src/semantic-router.mjs';
export function semanticPolicy(config) {
  const p = config.semanticRouter || {};
  const chat = p.openaiChat || {model:p.model};
  return {
    enabled: p.enabled === true, provider: semanticProvider(config), mode:p.mode || 'shadow',
    minCharacters:Number(p.minCharacters || 12), maxInputCharacters:Number(p.maxInputCharacters || 6000),
    confidenceThreshold:Number(p.confidenceThreshold ?? 0.7), smallAcceptThreshold:resolveSmallAcceptThreshold(p),
    finalAdoptionThreshold:Number(p.finalAdoptionThreshold ?? p.minConfidence ?? 0),
    activeTrafficPercent:Math.max(0,Math.min(100,Number(p.activeTrafficPercent ?? 100))),
    smallTimeoutMs:Number(p.httpJson?.timeoutMs || p.timeoutMs || 2000),
    largeTimeoutMs:Number(chat.timeoutMs || p.timeoutMs || 3500), maxOutputTokens:Number(p.maxOutputTokens || 180),
    largeModel:chat.model || '', useJsonMode:Boolean(p.useJsonMode)
  };
}
