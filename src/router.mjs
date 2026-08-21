// 成本档位带定义：档位=[min,max]（基于 costIndex 0~1，锚点=池内最贵模型单价）。
// 语义档位（OpenRouter cost_tier 思路）：预算/均衡/质量/顶配——带内双向过滤，
// 高档位同样排除过于便宜的模型（band 不是 ceiling）。null=未启用档位（兼容旧配置）。
const COST_TIERS = {
  budget:  { label: '省钱', min: 0,    max: 0.2 },
  balanced:{ label: '均衡', min: 0,    max: 0.5 },
  quality: { label: '质量', min: 0.15, max: 1 },
  max:     { label: '顶配', min: 0.2,  max: 1 }
};
export function costTierBand(config) {
  const tier = config.routing?.costTier;
  if (!tier || !COST_TIERS[tier]) return null;
  return COST_TIERS[tier];
}

// 市场信号：决策日志聚合的活信号（份额/点名/失败率），样本不足自动休眠、幅度有界
import { adjustFor as marketAdjustFor } from './market-signal-runtime.mjs';
// 任务分类正则：内置为缺省值；config.taskRules.patterns 提供可覆盖子集（key=任务名，value=字符串数组按 | 合并）
const DEFAULT_TASK_PATTERNS = {
  coding: /代码|编程|程序|函数|接口|报错|异常|debug|bug|review|评审|前端|vue|react|css|组件|docker|k8s|kubernetes|ci\/cd|nginx|yaml|部署配置|shell|bash|命令行|解析.{0,4}文件|csv|python|java|javascript|typescript|golang|rust|sql|regex|算法|并发安全|重构|单元测试/i,
  reasoning: /推理|证明|分析原因|根因|权衡|取舍|对比|评估|规划|方案|设计|架构|分层|框架|路由|综合选择|怎么做|如何实现|分布式事务|数学|逻辑|为什么|比较.*优缺点|研究报告|调研报告|行业趋势|reason|prove|analy[sz]e|architecture/i,
  creative: /创作|文案|故事|诗|广告|宣传语|口号|营销|改写.*风格|脑暴|起名|剧本|扮演|角色扮演|slogan|creative|story|poem|copywriting|roleplay|写.{0,4}(故事|小说)/i,
  extraction: /提取|抽取|分类|归类|标签|结构化|转换为|转换|映射|清洗|格式化|只返回|识别字段|extract|classify|parse|json/i
};

// 小类细分（OpenRouter subcategory 语义）：在已识别大类内按线索细分，只影响展示不影响打分
const SUBTASK_PATTERNS = {
  // —— CODE 代码（9 小类）——
  coding: [
    [/报错|异常|bug|debug|错误|排查|修复|stack ?trace|为什么.*不(工作|生效)/i, 'debugging'],
    [/评审|review|code review|看看.{0,8}代码|检查.{0,8}(代码|实现)/i, 'code-review'],
    [/sql|查询.*表|select |join |数据库查询|索引优化/i, 'sql-database'],
    [/前端|vue|react|css|页面|组件|界面|ui ?(设计|稿|还原)/i, 'frontend-ui'],
    [/部署|docker|k8s|kubernetes|ci\/cd|jenkins|nginx|yaml|helm|配置文件|环境变量/i, 'devops-config'],
    [/shell|bash|命令行|执行命令|脚本执行|powershell|终端命令/i, 'shell-execution'],
    [/(读|写|解析|打开|生成).{0,6}(文件|csv|excel|日志文件)|file ?i\/o/i, 'file-io'],
    [/仓库扫描|全库|整个代码库|repo scan|代码库分析|扫描.{0,4}仓库/i, 'repo-scanning']
  ],
  // —— AGENTS 智能体（6 小类；multi-step-planning 归推理族触发）——
  reasoning: [
    [/漏洞|渗透|安全审计|攻击面|安全扫描/i, 'security-audit'],
    [/金融|交易|股票|风控|行情|投资/i, 'finance-trading'],
    [/客服|售后|客户咨询|工单回复|投诉处理/i, 'customer-support'],
    [/翻译|translate|中译英|英译中/i, 'translation'],
    [/摘要|总结|压缩|提炼|summar/i, 'summarization'],
    [/规划|排期|路线图|分几期|怎么做|分步|步骤/i, 'multi-step-planning'],
    [/调研|报告|研究|综述|白皮书|架构|方案|系统设计|技术选型/i, 'research-reports'],
    [/数学|证明|方程|概率|微积分|求解|计算/i, 'math']
  ],
  // —— WRITING & CHAT 写作与对话（内容族小类）——
  creative: [
    [/扮演|角色扮演|roleplay|写.{0,4}(故事|小说|剧本)/i, 'roleplay-fiction'],
    [/文案|宣传|营销|slogan|口号|起名|标题|内容写作/i, 'content-writing']
  ],
  // —— DATA 数据（6 小类）——
  extraction: [
    [/分类|标签|归类|打标|classify/i, 'classification'],
    [/转换|清洗|映射|格式化|transform/i, 'data-transformation'],
    [/摘要|总结|压缩|提炼|summar/i, 'summarization'],
    [/翻译|translate|中译英|英译中/i, 'translation'],
    [/提取|抽取|结构化|抽取字段|extract|json/i, 'data-extraction']
  ],
  // default 族的展示层小类（未命中走 qa-knowledge 兜底）
  default: [
    [/客服|售后|客户咨询|工单回复|投诉处理/i, 'customer-support'],
    [/金融|交易|股票|风控|行情|投资/i, 'finance-trading'],
    [/漏洞|渗透|安全审计|攻击面|安全扫描/i, 'security-audit'],
    [/翻译|translate|中译英|英译中/i, 'translation'],
    [/摘要|总结|压缩|提炼|summar/i, 'summarization'],
    [/你好|嗨|hello|hi\b|在吗|聊天/i, 'conversation']
  ]
};

function resolveSubTask(task, text) {
  const rules = SUBTASK_PATTERNS[task];
  if (!rules) return null;
  for (const [re, sub] of rules) if (re.test(text)) return sub;
  return null;
}

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

// 任务分类用的文本：排除系统提示词（模板词如「你是研发助手」会把所有请求都拽向 coding）
function taskText(body) {
  return (body.messages || []).filter((m) => m.role !== 'system').map((m) => flattenContent(m.content)).join('\n');
}

export function estimateInputTokens(text) {
  const cjk = (text.match(/[\u3400-\u9fff]/g) || []).length;
  return Math.max(1, Math.ceil(cjk / 1.6 + (text.length - cjk) / 4));
}

export function analyzeRequest(body, config) {
  const text = taskText(body);
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
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  // 工具调用请求 → Agent 大类（OpenRouter: Workflow Execution / Web search），打分仍用 default 档（quality.agent 未实测）
  const finalTask = hasTools ? 'agent' : task;
  let subTask = resolveSubTask(task, text);
  if (hasTools) {
    const toolNames = (body.tools || []).map((t) => String(t?.function?.name || t?.name || '')).join(' ').toLowerCase();
    subTask = /search|web|检索|surf/.test(toolNames) ? 'web-search' : /devops|deploy|ops/.test(toolNames) ? 'devops' : 'workflow-execution';
  }
  return { task: finalTask, subTask, tier, complexity, confidence: trivial ? 0.98 : task === 'default' ? 0.55 : 0.86, textLength: text.length, estimatedInputTokens: estimateInputTokens(text), requirements, signals };
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

// —— 路由基线（论文标准锚点，用于"换组件值不值"的量化对比）——
// Zero-Router：把请求随机分给 Pareto 前沿上的模型（CARROT 的必备 sanity check——
// 路由器打不过它说明评测集缺乏路由信号，而非路由器差）。
// Pareto 前沿：没有任何模型在成本与时延上同时不劣于它的模型集合。
export function paretoFrontier(models) {
  const usable = models.filter((m) => m.enabled !== false && Number.isFinite(Number(m.costIndex)) && Number.isFinite(Number(m.latencyIndex)));
  return usable.filter((m) => !usable.some((o) => o !== m
    && Number(o.costIndex) <= Number(m.costIndex) && Number(o.latencyIndex) <= Number(m.latencyIndex)
    && (Number(o.costIndex) < Number(m.costIndex) || Number(o.latencyIndex) < Number(m.latencyIndex))));
}

// Oracle：事后最优——逐请求选"满足质量线的最低成本模型"（GraphRouter/MixLLM 评估协议的上界参照）。
export function oracleChoice(body, config, runtime = {}) {
  const analysis = runtime.analysisOverride || { ...analyzeRequest(body, config), routeMethod: 'rules' };
  const eligible = config.models.filter((m) => {
    if (m.enabled === false) return false;
    if (m.contextWindow && analysis.estimatedInputTokens > m.contextWindow) return false;
    return !capabilityEligible(m, analysis.requirements).length;
  });
  if (!eligible.length) return null;
  // 质量回退链：任务无实测跑分（如 agent/web-search 小类）→ 用 default 档，避免 NaN 参与排序
  const qualityOf = (m) => Number(m.quality?.[analysis.task] ?? m.quality['default'] ?? 0.75);
  const floor = Number(config.routing?.qualityFloor || 0.72);
  const qualified = eligible.filter((m) => qualityOf(m) >= floor);
  const pool = qualified.length ? qualified : eligible;
  pool.sort((a, b) => qualityOf(b) - qualityOf(a) || Number(a.costIndex) - Number(b.costIndex));
  return pool[0];
}

// Zero-Router 决策：确定性哈希把同一请求始终分给同一前沿模型（可复现，避免随机抖动干扰对比）
export function zeroRouterChoice(body, config, runtime = {}) {
  const front = paretoFrontier(config.models);
  if (!front.length) return null;
  const text = requestText(body);
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  const model = front[((h % front.length) + front.length) % front.length]; // FNV-1a 溢出可产生负数，负数取模得负索引 → 归一化到 [0, len)
  const reasons = [];
  if (model.capabilities && capabilityEligible(model, runtime.analysis?.requirements || {}).length) return null;
  return model;
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
    // 套餐动态候选池：客户端 key 的 v1/models 可用集不含该模型 → 该租户无权调用（not_entitled）
    if (runtime.allowedModelIds && !runtime.allowedModelIds.has(model.id)) reasons.push('not_entitled');
    const circuit = health[model.id]?.circuitOpenUntil || 0;
    if (circuit > now) reasons.push('circuit_open');
    if (model.contextWindow && analysis.estimatedInputTokens > model.contextWindow) reasons.push('context_too_long');
    const requestedCompletionTokens = Number(body.max_completion_tokens || body.max_tokens || 0);
    if (requestedCompletionTokens > 0 && model.minimumCompletionTokensForReliableAnswer
      && requestedCompletionTokens < model.minimumCompletionTokensForReliableAnswer) reasons.push('completion_budget_too_low');
    // 成本档位带（OpenRouter cost_tier 语义）：tier 是「带」不是「上限」——
    // 高档位排除过于便宜的模型（防止低端拉低质量），低档位排除超出预算带的模型。
    const tierBand = costTierBand(config);
    if (tierBand) {
      if (model.costIndex < tierBand.min) reasons.push('below_cost_tier');
      else if (model.costIndex > tierBand.max) reasons.push('above_cost_tier');
    }
    reasons.push(...capabilityEligible(model, analysis.requirements).map((x) => `missing_${x}`));
    if (reasons.length) { rejected.push({ model: model.id, reasons }); continue; }

    const quality = Number(model.quality?.[analysis.task] ?? model.quality['default'] ?? 0.75);
    const uncertainty = model.calibrationStatus === 'verified' ? 0 : config.routing.uncertaintyPenalty;
    const selfBonus = config.routing.preferSelfHosted && model.ownership === 'self_hosted' ? config.routing.selfHostedBonus : 0;
    const dynamicPenalty = livePenalty(model.id, health, config);
    const complexMargin = analysis.tier === 'complex' ? Number(config.routing.complexQualityMargin || 0) : 0;
    const effectiveQualityFloor = Math.min(1, config.routing.qualityFloor + complexMargin);
    const budgetPressure = Math.max(0, Math.min(1, Number(runtime.budgetPressure || 0)));
    const budgetCostMultiplier = Number(config.routing.budgetCostMultiplier ?? 2);
    const effectiveCostWeight = config.routing.costWeight * (1 + budgetPressure * budgetCostMultiplier);
    const { fn: scoreFn } = resolveScoreStrategy(config);
    const baseScore = scoreFn({ model, quality, config, uncertainty, dynamicPenalty, selfBonus, effectiveCostWeight });
    // 市场信号微调（有界 ±maxAdjust，默认 0.05）：静态跑分是先验，真实使用是后验，两者互补
    const marketAdjust = marketAdjustFor(config, analysis.task, model.id, runtime);
    const score = baseScore + marketAdjust;
    candidates.push({
      model: model.id,
      ownership: model.ownership,
      quality,
      score: Number(score.toFixed(4)),
      baseScore: Number(baseScore.toFixed(4)),
      marketAdjust: Number(marketAdjust.toFixed(4)),
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
  // 任务偏好分流：指定模型与最优模型的分差 ≤ 容差时选指定模型（quality 不受损前提下的定向分流，
  // 如并发余量大的模型接 extraction/creative；预算压力拉高成本权重时分差扩大，自然回落最优模型）
  const prefs = config.routing?.taskPreferences || {};
  const pref = prefs[analysis.task];
  let preferenceApplied = false;
  let preferenceNote = null;
  if (pref?.model && ordered.length > 1) {
    const best = ordered[0];
    const target = ordered.find((x) => x.model === pref.model);
    if (target && best.model !== pref.model && best.score - target.score <= Number(pref.tolerance ?? 0.02) + 1e-9) {
      ordered.splice(ordered.indexOf(target), 1);
      ordered.unshift(target);
      preferenceApplied = true;
      preferenceNote = `taskPreferences[${analysis.task}]: ${target.model} 与最优 ${best.model} 分差 ${(best.score - target.score).toFixed(3)} ≤ 容差 ${pref.tolerance}`;
    }
  }
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
    preference: preferenceApplied ? { task: analysis.task, model: pref.model, note: preferenceNote } : null,
    reasoningLevel, rejected, fallbackOrder: ordered.map((x) => x.model), configVersion: config.version
  };
}
