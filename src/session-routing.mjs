import { createHmac } from 'node:crypto';

// Full, process-private digest: two tenants can use the same public session id.
export function sessionRoutingKey({ sessionId, authorization, upstream }, secret) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) return null;
  const credential = String(authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!credential) return null;
  return createHmac('sha256', secret).update(JSON.stringify([upstream, credential, sessionId])).digest('hex');
}

export function chooseSessionModel(current, decision, routing, now = Date.now()) {
  if (!current || current.expiresAt <= now || decision.shadow || decision.analysis?.task === 'explicit') return decision.selectedModel;
  const eligible = decision.qualifiedModelIds || [];
  if (!eligible.includes(current.model)) return decision.selectedModel;
  if (current.task !== decision.analysis?.task || current.tier !== decision.analysis?.tier
      || (current.subTask || null) !== (decision.analysis?.subTask || null)) return decision.selectedModel;
  const sticky = decision.candidates?.find(c => c.model === current.model);
  const selected = decision.candidates?.find(c => c.model === decision.selectedModel);
  const gap = selected?.score - sticky?.score;
  const maxGap = Number(routing.sessionStickinessMaxGap ?? 0.05);
  return Number.isFinite(gap) && gap <= maxGap + 1e-9 ? current.model : decision.selectedModel;
}
