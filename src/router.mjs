// 任务分类正则：内置为缺省值；config.taskRules.patterns 提供可覆盖子集（key=任务名，value=字符串数组按 | 合并）
const DEFAULT_TASK_PATTERNS = {
  coding: /代码|编程|程序|函数|接口|报错|异常|debug|bug|python|java|javascript|typescript|golang|rust|sql|regex|算法|并发|重构|单元测试/i,
  reasoning: /推理|证明|分析原因|根因|权衡|取舍|对比|评估|规划|方案|设计|架构|框架|路由|综合选择|怎么做|如何实现|分布式事务|数学|逻辑|为什么|比较.*优缺点|reason|prove|analy[sz]e|architecture/i,
  creative: /创作|文案|故事|诗|广告|宣传语|口号|营销|改写.*风格|脑暴|起名|剧本|slogan|creative|story|poem|copywriting/i,
  extraction: /提取|抽取|分类|标签|结构化|转换为.*json|只返回|识别字段|extract|classify|parse|json/i
};

function resolveTaskPatterns(taskRules) {
  const merged = { ...DEFAULT_TASK_PATTERNS };
  if (taskRules && taskRules.patterns && typeof taskRules.patterns === 'object') {
    for (const [name, sources] of Object.entries(taskRules.patterns)) {
      if (!Array.isArray(sources) || sources.length === 0) continue;
      try { merged[name] = new RegExp(sources.join('|'), 'i'); } catch { /* 保留默认 */ }
    }
  }
  return merged;
}

const TRIVIAL_FACT_PATTERN = /^(请问)?(今天|现在|当前)?(是)?(星期几|周几|几号|日期是什么|几点了)[？?。\s]*$/i;
const MULTI_OBJECTIVE_PATTERN = /成本|费用|质量|效果|时延|延迟|效率|性能|可用性|稳定性|框架|开源|兼容|协议|部署|安全|并发|扩展性/gi;

function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => typeof part === 'string' ? part : (part?.text || '')).join('\n');
}

export function requestText(body) {
  return (body.messages || []).map((m) => flattenContent(m.content)).join('\n');
}

export function estimateInputTokens(text) {
  const cjk = (text.match(/[\u3400-\u9fff]/g) || []).length;
  return Math.max(1, Math.ceil(cjk / 1.6 + (text.length - cjk) / 4));
}

export function analyzeRequest(body, config) {
  const text = requestText(body);
  const patterns = resolveTaskPatterns(config.taskRules);
  let task = 'default';
  for (const [name, regex] of Object.entries(patterns)) {
    if (regex.test(text)) { task = name; break; }
  }
  const turns = Array.isArray(body.messages) ? body.messages.length : 0;
  const trimmed = text.trim();
  const trivial = turns <= 1 && TRIVIAL_FACT_PATTERN.test(trimmed);
  const signals = [];
  const addSignal = (key, label, contribution) => {
    if (contribution > 0) signals.push({ key, label, contribution: Number(contribution.toFixed(3)) });
  };
  const taskBase = trivial ? 0.08 : ({ reasoning: 0.38, coding: 0.3, creative: 0.22, extraction: 0.14, default: 0.1 }[task] || 0.1);
  addSignal('task_base', trivial ? '直接事实查询' : `任务类型：${task}`, taskBase);
  const lengthSignal = text.length > 1500 ? 0.32 : text.length > 500 ? 0.22 : text.length > 200 ? 0.14 : text.length > 80 ? 0.07 : 0;
  addSignal('length', `输入长度 ${text.length} 字符`, lengthSignal);
  const turnSignal = Math.min(0.12, Math.max(0, turns - 2) * 0.02);
  addSignal('turns', `多轮上下文 ${turns} 条消息`, turnSignal);
  const structuralCount = (text.match(/```|步骤|约束|要求|目标|前提|保证|同时|并且|必须|however|constraints?|requirements?/gi) || []).length;
  const structureSignal = Math.min(0.15, structuralCount * 0.03);
  addSignal('structure', `${structuralCount} 个约束或结构信号`, structureSignal);
  const objectiveCount = new Set((text.match(MULTI_OBJECTIVE_PATTERN) || []).map((x) => x.toLowerCase())).size;
  const objectiveSignal = Math.min(0.18, objectiveCount * 0.025);
  addSignal('objectives', `${objectiveCount} 个优化维度`, objectiveSignal);
  const clauseCount = (text.match(/[，,；;？?]|以及|同时|并且|或者/g) || []).length;
  const clauseSignal = Math.min(0.12, Math.max(0, clauseCount - 1) * 0.018);
  addSignal('clauses', `${clauseCount + 1} 个问题分句`, clauseSignal);
  const hasVision = (body.messages || []).some((m) => Array.isArray(m.content) && m.content.some((p) => ['image_url', 'input_image'].includes(p?.type)));
  const requirements = {
    chat: true,
    stream: Boolean(body.stream),
    tools: Array.isArray(body.tools) && body.tools.length > 0,
    json: Boolean(body.response_format),
    vision: hasVision
  };
  const capabilitySignal = (requirements.tools ? 0.05 : 0) + (requirements.vision ? 0.04 : 0) + (requirements.json ? 0.03 : 0);
  addSignal('capabilities', '需要特殊模型能力', capabilitySignal);
  const complexity = Number(Math.min(1, signals.reduce((sum, signal) => sum + signal.contribution, 0)).toFixed(3));
  const tier = complexity >= config.taskRules.complexMinComplexity ? 'complex'
    : complexity <= config.taskRules.simpleMaxComplexity ? 'simple' : 'balanced';
  return { task, tier, complexity, confidence: trivial ? 0.98 : task === 'default' ? 0.55 : 0.86, textLength: text.length, estimatedInputTokens: estimateInputTokens(text), requirements, signals };
}

export function mergeSemanticAssessment(base, semantic, applied = true) {
  if (!semantic) return { ...base, routeMethod: 'rules' };
  if (!applied) return { ...base, routeMethod: 'rules_semantic_shadow', semantic };
  const delta = Number((semantic.complexity - base.complexity).toFixed(3));
  return {
    ...base,
    task: semantic.task,
    tier: semantic.tier,
    complexity: semantic.complexity,
    confidence: semantic.confidence,
    routeMethod: 'semantic',
    semantic,
    signals: [...base.signals, { key: 'semantic_review', label: `语义复核：${semantic.reason || semantic.tier}`, contribution: delta }]
  };
}

export function recommendReasoningLevel(analysis, config) {
  const policy = config.reasoningControl || {};
  if (analysis.complexity >= Number(policy.highMinComplexity ?? 0.78)) return 'high';
  if (analysis.complexity <= Number(policy.offMaxComplexity ?? 0.3)) return 'off';
  if (analysis.task === 'extraction' && analysis.complexity < 0.6) return 'off';
  return 'standard';
}

function capabilityEligible(model, requirements) {
  const missing = [];
  for (const [capability, required] of Object.entries(requirements)) {
    if (required && model.capabilities?.[capability] === false) missing.push(capability);
  }
  return missing;
}

function livePenalty(modelId, health, config) {
  const state = health?.[modelId];
  if (!state) return 0;
  const p = config.routing?.livePenalty || {};
  const latencyScaleMs = Number(p.latencyScaleMs ?? 300000);
  const latencyMax = Number(p.latencyMax ?? 0.2);
  const errorStep = Number(p.errorStep ?? 0.08);
  const errorMax = Number(p.errorMax ?? 0.3);
  const latencyPenalty = state.ewmaLatencyMs ? Math.min(latencyMax, state.ewmaLatencyMs / latencyScaleMs) : 0;
  const errorPenalty = Math.min(errorMax, (state.consecutiveFailures || 0) * errorStep);
  return latencyPenalty + errorPenalty;
}

// 评分策略注册表：config.routing.scoreStrategy 选择，未来可加 'learned' 等
const SCORE_STRATEGIES = {
  weighted({ model, quality, config, uncertainty, dynamicPenalty, selfBonus, effectiveCostWeight }) {
    return config.routing.qualityWeight * quality
      - effectiveCostWeight * Number(model.costIndex || 0)
      - config.routing.latencyWeight * Number(model.latencyIndex || 0)
      - uncertainty - dynamicPenalty + selfBonus;
  }
};

export function resolveScoreStrategy(config) {
  const name = config.routing?.scoreStrategy || 'weighted';
  const fn = SCORE_STRATEGIES[name];
  if (!fn) throw new Error(`未知评分策略: ${name}`);
  return { name, fn };
}

export function routeRequest(body, config, runtime = {}) {
  const analysis = runtime.analysisOverride || { ...analyzeRequest(body, config), routeMethod: 'rules' };
  const now = runtime.now || Date.now();
  const health = runtime.health || {};
  const candidates = [];
  const rejected = [];
  for (const model of config.models) {
    const reasons = [];
    if (!model.enabled) reasons.push('disabled');
    const circuit = health[model.id]?.circuitOpenUntil || 0;
    if (circuit > now) reasons.push('circuit_open');
    if (model.contextWindow && analysis.estimatedInputTokens > model.contextWindow) reasons.push('context_too_long');
    const requestedCompletionTokens = Number(body.max_completion_tokens || body.max_tokens || 0);
    if (requestedCompletionTokens > 0 && model.minimumCompletionTokensForReliableAnswer
      && requestedCompletionTokens < model.minimumCompletionTokensForReliableAnswer) reasons.push('completion_budget_too_low');
    reasons.push(...capabilityEligible(model, analysis.requirements).map((x) => `missing_${x}`));
    if (reasons.length) { rejected.push({ model: model.id, reasons }); continue; }

    const quality = Number(model.quality?.[analysis.task] ?? model.quality.default);
    const uncertainty = model.calibrationStatus === 'verified' ? 0 : config.routing.uncertaintyPenalty;
    const selfBonus = config.routing.preferSelfHosted && model.ownership === 'self_hosted' ? config.routing.selfHostedBonus : 0;
    const dynamicPenalty = livePenalty(model.id, health, config);
    const complexMargin = analysis.tier === 'complex' ? Number(config.routing.complexQualityMargin || 0) : 0;
    const effectiveQualityFloor = Math.min(1, config.routing.qualityFloor + complexMargin);
    const budgetPressure = Math.max(0, Math.min(1, Number(runtime.budgetPressure || 0)));
    const budgetCostMultiplier = Number(config.routing.budgetCostMultiplier ?? 2);
    const effectiveCostWeight = config.routing.costWeight * (1 + budgetPressure * budgetCostMultiplier);
    const { fn: scoreFn } = resolveScoreStrategy(config);
    const score = scoreFn({ model, quality, config, uncertainty, dynamicPenalty, selfBonus, effectiveCostWeight });
    candidates.push({
      model: model.id,
      ownership: model.ownership,
      quality,
      score: Number(score.toFixed(4)),
      qualityQualified: quality >= effectiveQualityFloor,
      effectiveQualityFloor,
      costIndex: model.costIndex,
      latencyIndex: model.latencyIndex,
      calibrationStatus: model.calibrationStatus
    });
  }
  if (!candidates.length) throw new Error('没有满足硬性能力和健康状态要求的候选模型');
  const qualified = candidates.filter((x) => x.qualityQualified);
  const pool = qualified.length ? qualified : candidates;
  pool.sort((a, b) => b.score - a.score || a.costIndex - b.costIndex);
  const ordered = [...pool, ...candidates.filter((x) => !pool.includes(x)).sort((a, b) => b.score - a.score)];
  const suggestedModel = ordered[0].model;
  const activeTrafficPercent = Math.max(0, Math.min(100, Number(config.routing.activeTrafficPercent ?? 100)));
  const trafficBucket = Number(runtime.trafficBucket ?? Math.random() * 100);
  const rolloutApplied = config.routing.mode === 'active' && trafficBucket < activeTrafficPercent;
  const selectedModel = rolloutApplied ? suggestedModel : config.routing.shadowModel;
  let reasoningLevel = recommendReasoningLevel(analysis, config);
  if (Number(runtime.budgetPressure || 0) >= Number(config.budget?.degradeThreshold ?? 0.9)) {
    reasoningLevel = reasoningLevel === 'high' ? 'standard' : 'off';
  }
  return {
    requestedModel: body.model || 'auto', selectedModel, suggestedModel,
    shadow: !rolloutApplied, rollout: { activeTrafficPercent, trafficBucket: Number(trafficBucket.toFixed(2)), rolloutApplied }, analysis, candidates: candidates.sort((a, b) => b.score - a.score),
    reasoningLevel, rejected, fallbackOrder: ordered.map((x) => x.model), configVersion: config.version
  };
}
