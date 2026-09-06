import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateRequestCapacity } from '../src/request-capacity.mjs';
import { analyzeRequest, classifierText, routeRequest } from '../src/router.mjs';
import { estimateCostYuan } from '../src/budget.mjs';

const config = {
  taskRules: { simpleMaxComplexity: .35, complexMinComplexity: .7 },
  budget: { defaultEstimatedOutputTokens: 800 },
  routing: { mode: 'active', qualityFloor: .7, qualityWeight: 1, costWeight: .2, latencyWeight: .1, uncertaintyPenalty: 0 },
  models: ['short', 'long'].map((id, i) => ({ id, enabled: true, ownership: 'self_hosted', quality: { default: .9 }, costIndex: .2, latencyIndex: .1, contextWindow: i ? 131072 : 1024, capabilities: { tools: true, json: true } }))
};

test('full history and system text count toward capacity and input cost, without changing classification text', () => {
  const body = { messages: [{ role: 'system', content: 'a'.repeat(20000) }, { role: 'assistant', content: 'b'.repeat(20000) }, { role: 'user', content: '你好' }], max_tokens: 100 };
  assert.equal(classifierText(body), '你好');
  const analysis = analyzeRequest(body, config);
  assert.equal(analysis.task, 'default');
  assert.ok(analysis.estimatedInputTokens > 10000);
  assert.equal(analysis.estimatedContextTokens, analysis.estimatedInputTokens + 100);
  const decision = routeRequest(body, config);
  assert.equal(decision.selectedModel, 'long');
  assert.ok(decision.rejected.some(r => r.model === 'short' && r.reasons.includes('context_too_long')));
  const model = { pricingYuanPerMillionTokens: { input: 1, output: 0 } };
  assert.ok(estimateCostYuan(body, analysis, model, config) > .01);
  // Semantic/replay metadata cannot bypass the request's capacity check.
  assert.equal(routeRequest(body, config, { analysisOverride: { ...analysis, estimatedInputTokens: 1, estimatedContextTokens: 1 } }).selectedModel, 'long');
});

test('tool definitions, calls, tool results and response schemas contribute to input capacity', () => {
  const bare = { messages: [{ role: 'user', content: '检查订单' }], max_tokens: 64 };
  const body = { ...bare,
    tools: [{ type: 'function', function: { name: 'lookup', description: 'x'.repeat(6000), parameters: { type: 'object' } } }],
    response_format: { type: 'json_schema', json_schema: { name: 'output', schema: { description: 'y'.repeat(6000) } } },
    messages: [...bare.messages, { role: 'assistant', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: 'z'.repeat(6000) } }] }, { role: 'tool', tool_call_id: 'call-1', content: 'w'.repeat(6000) }]
  };
  assert.ok(estimateRequestCapacity(body, config).estimatedInputTokens > estimateRequestCapacity(bare, config).estimatedInputTokens + 6000);
  assert.equal(routeRequest(body, config).selectedModel, 'long');
});

test('completion reservation participates in the window and max_completion_tokens has precedence', () => {
  const body = { messages: [{ role: 'user', content: 'hi' }], max_tokens: 16, max_completion_tokens: 2048 };
  const capacity = estimateRequestCapacity(body, config);
  assert.equal(capacity.estimatedOutputTokens, 2048);
  assert.equal(routeRequest(body, config).selectedModel, 'long');
  assert.equal(estimateRequestCapacity({ messages: [] }, config).estimatedOutputTokens, 800);
});

test('opaque media exposes an estimate and never mistakes a base64 URL for text tokens', () => {
  const body = { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(100000) } }] }] };
  const capacity = estimateRequestCapacity(body, config);
  assert.deepEqual(capacity.capacityEstimate, { method: 'heuristic', unknownMediaParts: 1, estimatedMediaTokens: 4096 });
  assert.ok(capacity.estimatedInputTokens >= 4096 && capacity.estimatedInputTokens < 5000);
});
