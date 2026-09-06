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
  const custom = structuredClone(config); custom.routing.mode = 'shadow'; custom.routing.shadowModel = 'Qwen3.8-27B';
  const decision = routeRequest({ messages: [{ role: 'user', content: '提取姓名并输出 JSON' }] }, custom);
  assert.equal(decision.selectedModel, 'Qwen3.8-27B');
  assert.equal(decision.shadow, true);
  assert.ok(decision.suggestedModel);
});

test('open circuit removes model from candidates', () => {
  const decision = routeRequest({ messages: [{ role: 'user', content: '你好' }] }, config, { now: 1000, health: { 'deepseekv4-flash': { circuitOpenUntil: 2000 } } });
  assert.ok(!decision.candidates.some((x) => x.model === 'deepseekv4-flash'));
  assert.ok(decision.rejected.some((x) => x.model === 'deepseekv4-flash' && x.reasons.includes('circuit_open')));
});

test('rejects a reasoning model when completion budget is known to be insufficient', () => {
  const custom = structuredClone(config); // 合成注入门槛：不依赖某个线上模型恰好配置了该字段
  custom.models.find((m) => m.id === 'Qwen3.8-27B').minimumCompletionTokensForReliableAnswer = 4096;
  const decision = routeRequest({ messages: [{ role: 'user', content: '分析一个复杂问题' }], max_tokens: 512 }, custom);
  assert.ok(decision.rejected.some((x) => x.model === 'Qwen3.8-27B' && x.reasons.includes('completion_budget_too_low')));
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

// —— taskPreferences 容差分流 ——
test('taskPreferences 容差内分流到指定模型（qualified 池内）', () => {
  // 语义：偏好目标必须在 qualified 池内（qualityQualified 且 qualityLoss ≤ relCap）。
  // 用合成配置锁定闸门机制（质量分校准会改变真实分差，测试不得绑定具体分值）：
  // 人为把 dsf 的 extraction 压到 0.60——远超 simple 档 relCap 0.08，必被闸出 qualified 池。
  const cfg = structuredClone(config);
  const dsf = cfg.models.find((m) => m.id === 'deepseekv4-flash');
  dsf.quality.extraction = 0.60;
  cfg.routing.taskPreferences.extraction = { model: 'deepseekv4-flash', tolerance: 0.2 };
  const rejected = routeRequest({ model: 'auto', messages: [{ role: 'user', content: '从下面材料提取关键信息并输出结构化 JSON：文章标题、作者、发表日期' }] }, cfg);
  assert.equal(rejected.analysis.task, 'extraction');
  assert.equal(rejected.preference, null, '超质量闸门的偏好目标不得被分流');
  assert.notEqual(rejected.suggestedModel, 'deepseekv4-flash');
  // 对照组：偏好目标在 qualified 池内且非第一 → 正常分流
  const cfg2 = structuredClone(config);
  cfg2.routing.taskPreferences.extraction = { model: 'Qwen3.8-27B', tolerance: 0.2 };
  const applied = routeRequest({ model: 'auto', messages: [{ role: 'user', content: '从下面材料提取关键信息并输出结构化 JSON：文章标题、作者、发表日期' }] }, cfg2);
  assert.equal(applied.analysis.task, 'extraction');
  assert.equal(applied.suggestedModel, 'Qwen3.8-27B');
  assert.ok(applied.preference, '池内偏好应生效');
  assert.match(applied.preference.note, /taskPreferences\[extraction\]/);
});

test('taskPreferences 分差不超容差时不分流（无偏好档位维持评分最优）', () => {
  const decision = routeRequest({ model: 'auto', messages: [{ role: 'user', content: '用 Go 实现并发安全的计数器并解释锁的作用' }] }, config);
  assert.equal(decision.analysis.task, 'coding');
  // 结构性断言（不绑具体模型 id，校准换最优也不碎）：coding 无 taskPreference 偏好时，
  // 建议模型 = 候选中评分最高者，且不发生偏好分流。
  const best = decision.candidates.reduce((a, b) => (b.score > a.score ? b : a));
  assert.equal(decision.suggestedModel, best.model);
  assert.equal(decision.preference, null);
});

test('预算压力拉高成本权重后容差分流自然失效回落最优模型', () => {
  // 纯合成 2 模型单元级测试（不依赖线上 quality 数值，校准永不需要改断言）：
  // syn-best 全档 0.95、syn-pref 全档 0.90，其余参数相同 → 任意档分差恒 0.05。
  // 容差 0.05（≥分差）→ 分流到偏好模型 syn-pref；
  // 容差 0.001（<分差）→ 偏好失效，回落最优 syn-best。
  // 预算压力场景由 budgetCostMultiplier 单测覆盖（成本权重放大不改本机制）。
  const base = config.models.find((m) => m.id === 'qwen36-35b');
  const synthetic = JSON.parse(JSON.stringify(config));
  const uniform = (v) => ({ default: v, simple: v, coding: v, reasoning: v, creative: v, extraction: v });
  synthetic.models = [
    { ...structuredClone(base), id: 'syn-best', displayName: 'Syn Best', quality: uniform(0.95), costIndex: 0.3, latencyIndex: 0.3 },
    { ...structuredClone(base), id: 'syn-pref', displayName: 'Syn Pref', quality: uniform(0.90), costIndex: 0.3, latencyIndex: 0.3 },
  ];
  synthetic.routing.taskPreferences = { extraction: { model: 'syn-pref', tolerance: 0.05 } };
  const content = '从下面材料提取关键信息并输出结构化 JSON：文章标题、作者、发表日期';
  const within = routeRequest({ model: 'auto', messages: [{ role: 'user', content }] }, synthetic);
  assert.equal(within.analysis.task, 'extraction');
  assert.equal(within.suggestedModel, 'syn-pref'); // 分差 0.05 ≤ 容差 0.05：分流到偏好模型
  synthetic.routing.taskPreferences.extraction.tolerance = 0.001;
  const beyond = routeRequest({ model: 'auto', messages: [{ role: 'user', content }] }, synthetic);
  assert.equal(beyond.suggestedModel, 'syn-best'); // 分差 0.05 > 容差 0.001：回落最优模型
});

test('numeric and object quality caps agree, and retries never leave a nonempty qualified pool', () => {
  const custom = structuredClone(config);
  Object.assign(custom.routing, { relQualityCap: .01, qualityFloor: .7, qualityWeight: 1, costWeight: 1, providerCostWeight: 0, latencyWeight: 0, preferSelfHosted: false, costTier: null, taskPreferences: {} });
  custom.models = custom.models.slice(0, 2);
  Object.assign(custom.models[0], { quality: { default: .95 }, costIndex: .8, benchmarkScores: {} });
  Object.assign(custom.models[1], { quality: { default: .88 }, costIndex: .1, benchmarkScores: {} });
  const body = { messages: [{ role: 'user', content: '你好' }] };
  for (const cap of [.01, '0.01', { simple: .01 }]) {
    custom.routing.relQualityCap = cap;
    const decision = routeRequest(body, custom);
    assert.equal(decision.selectedModel, custom.models[0].id);
    assert.deepEqual(decision.fallbackOrder, [custom.models[0].id]);
    assert.deepEqual(decision.qualifiedModelIds, [custom.models[0].id]);
    assert.equal(decision.candidates.find(c => c.model === custom.models[1].id).qualityEligible, false);
    assert.equal(decision.qualityDegraded, false);
  }
  custom.routing.qualityFloor = .99;
  assert.throws(() => routeRequest(body, custom), /没有达到质量门槛/);
  custom.routing.allowQualityDegradation = true;
  const degraded = routeRequest(body, custom);
  assert.equal(degraded.qualityDegraded, true);
  assert.equal(degraded.qualityDegradedReason, 'no_candidate_meets_quality_floor');
  assert.deepEqual(degraded.qualifiedModelIds, []);
  assert.equal(degraded.fallbackOrder.length, 2);
});

test('semantic task changes replace old subtasks, while tool requests retain the agent contract', () => {
  const body = { messages: [{ role: 'user', content: '总结这段代码' }] };
  const base = { ...analyzeRequest(body, config), task: 'coding', subTask: 'code-review' };
  const semantic = { task: 'extraction', tier: 'simple', complexity: .2, confidence: .95 };
  assert.equal(mergeSemanticAssessment(base, semantic, true).subTask, null);
  assert.equal(mergeSemanticAssessment(base, semantic, true, body).subTask, 'summarization');
  assert.equal(mergeSemanticAssessment(base, semantic, false, body).subTask, 'code-review');
  const agent = { ...base, task: 'agent', subTask: 'web-search', requirements: { ...base.requirements, tools: true } };
  const merged = mergeSemanticAssessment(agent, semantic, true, body);
  assert.equal(merged.task, 'agent');
  assert.equal(merged.subTask, 'web-search');
  assert.equal(merged.requirements.tools, true);
  assert.equal(merged.complexity, .2);
});
