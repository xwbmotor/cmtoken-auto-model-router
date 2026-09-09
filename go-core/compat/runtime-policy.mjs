// Resolve production configuration defaults once per immutable generation.
// Credentials and endpoint URLs are deliberately supplied separately by the host.
import { getConfigRevision } from '../../src/config.mjs';
import { semanticPolicy } from './semantic-policy.mjs';

export function runtimeBundle(config) {
  const finite = (v, d) => { const n = Number(v ?? d); if (!Number.isFinite(n)) throw new Error('invalid runtime number'); return n; };
  const price = v => v == null ? null : finite(v);
  return {
    revision: getConfigRevision(config),
    analysis: { semanticRequired: config.semanticRouter?.enabled === true && config.semanticRouter.mode === 'active', taskRules: { simpleMaxComplexity: config.taskRules.simpleMaxComplexity, complexMinComplexity: config.taskRules.complexMinComplexity, patterns: config.taskRules.patterns }, budget: { defaultEstimatedOutputTokens: config.budget?.defaultEstimatedOutputTokens } },
    semantic: semanticPolicy(config),
    runtime: {
      maxAttempts: finite(config.routing.maxAttempts, 3),
      requestTimeoutMs: finite(config.routing.requestTimeoutMs, 120000),
      circuitBreakerFailures: finite(config.routing.circuitBreakerFailures, 3),
      circuitBreakerCooldownMs: finite(config.routing.circuitBreakerCooldownMs, 30000),
      budgetEnabled: config.budget?.enabled === true,
      dailyLimitMicros: Math.round(finite(config.budget?.dailyBudgetYuan, 0) * 1000000),
      timeZone: config.budget?.timeZone || 'Asia/Shanghai',
      cacheHitRatio: finite(config.budget?.cacheHitRatio, 0),
      prices: Object.fromEntries(config.models.map(m => [m.id, {
        input: price(m.pricingYuanPerMillionTokens?.input), output: price(m.pricingYuanPerMillionTokens?.output),
        inputCached: price(m.pricingYuanPerMillionTokens?.inputCached), reasoning: price(m.pricingYuanPerMillionTokens?.reasoning)
      }]))
    }
  };
}
