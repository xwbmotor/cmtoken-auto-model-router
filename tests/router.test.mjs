import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { analyzeRequest, mergeSemanticAssessment, recommendReasoningLevel, routeRequest } from '../src/router.mjs';
import { parseSemanticAssessment, shouldUseSemanticRouter } from '../src/semantic-router.mjs';
import { estimateCostYuan, yuanToBeans } from '../src/budget.mjs';

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
  model.pricingYuanPerMillionTokens = null; // 模拟未录价模型
  assert.equal(estimateCostYuan({ max_tokens: 1000 }, analysis, model, config, 'off'), null);
  model.pricingYuanPerMillionTokens = { input: 2, output: 8, reasoning: 8 };
  assert.equal(estimateCostYuan({ max_tokens: 1000 }, analysis, model, config, 'off'), 0.01);
  assert.ok(estimateCostYuan({ max_tokens: 1000 }, analysis, model, config, 'high') > 0.01);
});

test('缓存命中价降低成本估算，命中率可配置', () => {
  const model = structuredClone(config.models[0]);
  model.pricingYuanPerMillionTokens = { input: 1.05, inputCached: 0.21, output: 4.2, reasoning: 4.2 };
  const analysis = { estimatedInputTokens: 1_000_000 };
  // 输入 1M tokens：全价 1.05 元；命中50%时有效输入价 0.63 → 输入部分 0.63 元
  const full = estimateCostYuan({ max_tokens: 1_000_000 }, analysis, model, config, 'off');
  const withCache = estimateCostYuan({ max_tokens: 1_000_000 }, analysis, model, { ...config, budget: { ...config.budget, cacheHitRatio: 0.5 } }, 'off');
  // full = 1.05(输入) + 4.2(输出) = 5.25；withCache = 0.63 + 4.2 = 4.83
  assert.ok(Math.abs(full - 5.25) < 0.001, `full=${full}`);
  assert.ok(Math.abs(withCache - 4.83) < 0.001, `withCache=${withCache}`);
});

test('yuanToBeans 按 beansPerYuan 换算算力豆', () => {
  assert.equal(yuanToBeans(1, { budget: { beansPerYuan: 70 } }), 70);
  assert.equal(yuanToBeans(0.015, { budget: { beansPerYuan: 70 } }), 1.05);
  assert.equal(yuanToBeans(1, {}), null); // 未配置汇率返回 null
});

// —— taskPreferences 容差分流（v0.4.14）——
test('taskPreferences 容差内分流到指定模型（extraction→qwen）', () => {
  const decision = routeRequest({ model: 'auto', messages: [{ role: 'user', content: '从下面材料提取关键信息并输出结构化 JSON：文章标题、作者、发表日期' }] }, config);
  assert.equal(decision.analysis.task, 'extraction');
  assert.equal(decision.suggestedModel, 'qwen36-35b');
  assert.ok(decision.preference, 'preference 字段应非空');
  assert.match(decision.preference.note, /taskPreferences\[extraction\]/);
});

test('taskPreferences 分差不超容差时不分流（coding 维持最优）', () => {
  const decision = routeRequest({ model: 'auto', messages: [{ role: 'user', content: '用 Go 实现并发安全的计数器并解释锁的作用' }] }, config);
  assert.equal(decision.analysis.task, 'coding');
  assert.equal(decision.suggestedModel, 'deepseekv4-flash');
  assert.equal(decision.preference, null);
});

test('预算压力拉高成本权重后容差分流自然失效回落最优模型', () => {
  // 2026-08-19 GLM5.3 实测校准后：extraction 档 dsf-qwen 分差在 budgetPressure=1 时为 0.0477，
  // 仍 ≤ 容差 0.05（旧数值时代是 0.0528>0.05 失效）。机制验证改为单元级：
  // 固定输入，容差 0.05 → 分流到偏好模型；容差 0.01 → 分差超容差回落最优模型。
  // 该写法不依赖任何 quality 具体数值，校准后永不需要改断言。
  const content = '从下面材料提取关键信息并输出结构化 JSON：文章标题、作者、发表日期';
  const calm = routeRequest({ model: 'auto', messages: [{ role: 'user', content }] }, config);
  const tight = JSON.parse(JSON.stringify(config));
  tight.routing.taskPreferences.extraction.tolerance = 0.005; // 分差 0.009 > 0.005：超容差回落最优（calm 时最优是 hy3）
  const tightDecision = routeRequest({ model: 'auto', messages: [{ role: 'user', content }] }, tight);
  assert.equal(calm.analysis.task, 'extraction');
  assert.equal(calm.suggestedModel, 'qwen36-35b'); // 容差 0.05：分差 0.048 内，分流到偏好模型
  assert.equal(tightDecision.suggestedModel, 'hy3-preview'); // 容差收紧到 0.005：分差 0.009 超容差，回落最优模型
});
