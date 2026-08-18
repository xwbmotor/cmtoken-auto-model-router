import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { analyzeRequest, mergeSemanticAssessment, recommendReasoningLevel, routeRequest } from '../src/router.mjs';
import { parseSemanticAssessment, shouldUseSemanticRouter } from '../src/semantic-router.mjs';
import { estimateCostYuan } from '../src/budget.mjs';

const config = JSON.parse(await readFile(new URL('../config/router.json', import.meta.url), 'utf8'));

test('classifies coding request and prefers a self-hosted model', () => {
  const decision = routeRequest({ model: 'auto', messages: [{ role: 'user', content: '请分析这段 Java 代码的并发 bug 并重构' }] }, config);
  assert.equal(decision.analysis.task, 'coding');
  assert.equal(config.models.find((m) => m.id === decision.suggestedModel).ownership, 'self_hosted');
  assert.ok(!decision.fallbackOrder.includes('Minimax-M3'));
});

test('detects tool, JSON, stream and vision requirements', () => {
  const analysis = analyzeRequest({
    stream: true,
    tools: [{ type: 'function' }],
    response_format: { type: 'json_object' },
    messages: [{ role: 'user', content: [{ type: 'text', text: '识别图片' }, { type: 'image_url', image_url: { url: 'https://example.invalid/a.png' } }] }]
  }, config);
  assert.deepEqual(analysis.requirements, { chat: true, stream: true, tools: true, json: true, vision: true });
});

test('rejects a model that explicitly lacks a required capability', () => {
  const custom = structuredClone(config);
  custom.models.forEach((m) => { m.capabilities.tools = m.id === 'qwen36-35b'; });
  const decision = routeRequest({ messages: [{ role: 'user', content: '调用工具查询' }], tools: [{ type: 'function' }] }, custom);
  assert.equal(decision.selectedModel, 'qwen36-35b');
  assert.ok(decision.rejected.some((x) => x.reasons.includes('missing_tools')));
});

test('shadow mode records suggestion but sends configured shadow model', () => {
  const custom = structuredClone(config); custom.routing.mode = 'shadow'; custom.routing.shadowModel = 'minimax-m25';
  const decision = routeRequest({ messages: [{ role: 'user', content: '提取姓名并输出 JSON' }] }, custom);
  assert.equal(decision.selectedModel, 'minimax-m25');
  assert.equal(decision.shadow, true);
  assert.ok(decision.suggestedModel);
});

test('open circuit removes model from candidates', () => {
  const decision = routeRequest({ messages: [{ role: 'user', content: '你好' }] }, config, { now: 1000, health: { 'deepseekv4-flash': { circuitOpenUntil: 2000 } } });
  assert.ok(!decision.candidates.some((x) => x.model === 'deepseekv4-flash'));
  assert.ok(decision.rejected.some((x) => x.model === 'deepseekv4-flash' && x.reasons.includes('circuit_open')));
});

test('rejects a reasoning model when completion budget is known to be insufficient', () => {
  const decision = routeRequest({ messages: [{ role: 'user', content: '分析一个复杂问题' }], max_tokens: 512 }, config);
  assert.ok(decision.rejected.some((x) => x.model === 'minimax-m25' && x.reasons.includes('completion_budget_too_low')));
});

test('recognizes common Chinese reasoning and creative expressions', () => {
  assert.equal(analyzeRequest({ messages: [{ role: 'user', content: '比较三种分布式事务方案并给出取舍' }] }, config).task, 'reasoning');
  assert.equal(analyzeRequest({ messages: [{ role: 'user', content: '为企业助手写三条宣传语' }] }, config).task, 'creative');
});

test('separates a multi-objective routing design from a trivial weekday question', () => {
  const complexPrompt = '我现在有个maas服务，通过一个apikey有5个模型可以选择，但不同的模型成本不一样，而且现在需要用户手动选择任务用哪个模型，我现在想做个模型的auto模式，相当于在这5个模型上还有个路由层，根据任务的难易、任务的效果、使用的成本、模型的效果、输出的时延等综合选择一个最优的选择，目标是降低成本的消耗的前提下，保证模型任务输出的效率，这个要怎么做？我是openapi的协议。有auto的成熟方案吗，或者可以基于一些成熟现成的框架和开源项目来做，例如oneapi？';
  const complex = analyzeRequest({ messages: [{ role: 'user', content: complexPrompt }] }, config);
  const trivial = analyzeRequest({ messages: [{ role: 'user', content: '今天星期几？' }] }, config);
  assert.equal(complex.task, 'reasoning');
  assert.equal(trivial.task, 'default');
  assert.ok(complex.complexity >= 0.7, `expected complex >= 0.7, got ${complex.complexity}`);
  assert.ok(trivial.complexity <= 0.1, `expected trivial <= 0.1, got ${trivial.complexity}`);
  assert.ok(complex.complexity - trivial.complexity >= 0.6);
});

test('only sends sufficiently ambiguous requests to semantic review', () => {
  const ambiguousBody = { messages: [{ role: 'user', content: '帮我处理一下这份材料，看看怎么调整比较合适' }] };
  const trivialBody = { messages: [{ role: 'user', content: '今天星期几？' }] };
  assert.equal(shouldUseSemanticRouter(analyzeRequest(ambiguousBody, config), ambiguousBody, config), true);
  assert.equal(shouldUseSemanticRouter(analyzeRequest(trivialBody, config), trivialBody, config), false);
});

test('parses and applies a structured semantic assessment', () => {
  const assessment = parseSemanticAssessment('```json\n{"task":"reasoning","tier":"complex","complexity":0.88,"confidence":0.91,"reason":"多目标方案权衡"}\n```');
  const base = analyzeRequest({ messages: [{ role: 'user', content: '帮我处理一下方案' }] }, config);
  const merged = mergeSemanticAssessment(base, assessment, true);
  assert.equal(merged.routeMethod, 'semantic');
  assert.equal(merged.complexity, 0.88);
  assert.equal(recommendReasoningLevel(merged, config), 'high');
});

test('keeps semantic shadow result without changing the rule decision', () => {
  const base = analyzeRequest({ messages: [{ role: 'user', content: '帮我处理一下方案' }] }, config);
  const shadow = mergeSemanticAssessment(base, { task: 'reasoning', tier: 'complex', complexity: 0.9, confidence: 0.9, reason: '复杂' }, false);
  assert.equal(shadow.complexity, base.complexity);
  assert.equal(shadow.routeMethod, 'rules_semantic_shadow');
  assert.equal(shadow.semantic.complexity, 0.9);
});

test('estimates real-unit cost only after model pricing is configured', () => {
  const model = structuredClone(config.models[0]);
  const analysis = { estimatedInputTokens: 1000 };
  assert.equal(estimateCostYuan({ max_tokens: 1000 }, analysis, model, config, 'off'), null);
  model.pricingYuanPerMillionTokens = { input: 2, output: 8, reasoning: 8 };
  assert.equal(estimateCostYuan({ max_tokens: 1000 }, analysis, model, config, 'off'), 0.01);
  assert.ok(estimateCostYuan({ max_tokens: 1000 }, analysis, model, config, 'high') > 0.01);
});
