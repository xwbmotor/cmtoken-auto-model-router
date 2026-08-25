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

// 十四审 P1/P2：auto 模型对外名可配（单一真源 config.routing.autoModelId，默认 "auto"）。
// 硬切改名（如「cmtoken-auto」）后：/v1/models 展示该名、请求判定按该名走 auto 路由；
// 旧名 "auto" 退化为普通字符串——若与池内模型 ID 不重合则按「模型不存在」400。
// 全链路判定必须经 isAutoRequest，不得散落 === 'auto' 字面量。
export function autoModelId(config) {
  return (config?.routing?.autoModelId && String(config.routing.autoModelId).trim()) || 'auto';
}
export function isAutoRequest(body, config) {
  const id = autoModelId(config);
  return !body?.model || body.model === id;
}
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

// —— v0.6.0 规则层置信度证据模型（四审：关键词命中恒 0.86 不科学）——
// 置信度反映证据强度而非命中即高。三个下调因素让边缘案例（否定句/元讨论/多任务冲突）
// 落到 confidenceThreshold(默认0.7) 以下进入语义复核，正常强命中保持 0.86 不复核。
// v0.6.1 五审 P2 修正：否定证据不再全文匹配即扣——「不要解释，直接写 Python 函数」「禁止
// 递归，写循环版本」本身是明确 coding 请求，全局否定词会误伤（复核预算浪费 + 时延增加）。
// 局部化规则：只有当否定词与任务动词在同一短语（被否定的动作紧跟其后）时才算「否定包裹」。
// 近邻窗 ±12 字符内出现任务动作词 = 否定与任务绑定；否则否定针对的是别的东西（说明/解释等）。
const NEGATION_PATTERN = /不要|不用|无需|禁止|避免|并非|而不是|暂不|先不|别写|别用|别管|别生成|别给/gi;
const META_QUESTION_PATTERN = /什么是|通俗.{0,6}(语言|方式|词语|地)?(解释|讲解|介绍|说明)|科普/i;
const META_SUMMARIZE_PATTERN = /(总结|概括|翻译|改写|解释|讲解|评审意见)(一下|下)?[^。？！]{0,10}(这段|上述|下面|以上|该段|这份)/i;

// 否定局部化（v0.6.1 五审 P2）：否定词到其后第一个分句边界（或 +10 字符）构成「否定作用域」。
// 「否定包裹任务」= 胜出任务正则的【全部】命中都落在否定作用域内——被否定的关键词撑不起任务
// 标签（「不要写代码」的 代码 被否定）；只要存在肯定命中（「不要解释，直接写函数」的 函数 在
// 作用域外）任务成立不扣分（「禁止递归，写循环版本」否定的是实现方式而非任务本身）。
const CLAUSE_BOUNDARY = /[，。；、,.;:？！?！\n]/;
function negationWrappedTask(text, taskRegex) {
  if (!taskRegex) return false;
  const negProbe = new RegExp(NEGATION_PATTERN.source, 'i');
  if (!negProbe.test(text)) return false;
  // 否定作用域列表
  const negG = new RegExp(NEGATION_PATTERN.source, 'gi');
  const scopes = [];
  let m;
  while ((m = negG.exec(text)) !== null) {
    let to = Math.min(text.length, m.index + m[0].length + 10);
    for (let i = m.index + m[0].length; i < to; i += 1) {
      if (CLAUSE_BOUNDARY.test(text[i])) { to = i; break; }
    }
    scopes.push([m.index, to]);
  }
  // 任务正则全部命中 vs 被否定命中
  const g = new RegExp(taskRegex.source, taskRegex.flags.includes('g') ? taskRegex.flags : taskRegex.flags + 'g');
  let matches = 0;
  let negated = 0;
  while ((m = g.exec(text)) !== null) {
    matches += 1;
    if (scopes.some(([a, b]) => m.index >= a && m.index < b)) negated += 1;
    if (m.index === g.lastIndex) g.lastIndex += 1; // 零宽匹配防死循环
  }
  return matches > 0 && matches === negated;
}

function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => typeof part === 'string' ? part : (part?.text || '')).join('\n');
}

export function requestText(body) {
  return (body.messages || []).map((m) => flattenContent(m.content)).join('\n');
}

// v0.6.1 五审 P2：语义分类器专用文本口径（L2/L3 与 L1 统一）。
// requestText 含 system+assistant+全部历史——成本估算需要它（token 计费按全部输入），但语义
// 分类不能用它：system 提示「你是编程助手」、assistant 历史里的代码都会把分类器拽向 coding。
// 口径：以最后一条 user 消息为主，补充有限的前置 user 上下文（最近 2 条），排除 system/assistant。
export function classifierText(body, contextTurns = 2) {
  const userMessages = (body.messages || []).filter((m) => m.role === 'user');
  if (userMessages.length === 0) return requestText(body); // 无 user 消息（罕见）：退回全量兜底
  const tail = userMessages.slice(-(contextTurns + 1));
  return tail.map((m) => flattenContent(m.content)).join('\n');
}

// 任务分类用的文本：v0.7.0 六审 P2 起分两个口径——
// ① taskText（语义口径）：与 L2/L3 的 classifierText 一致（user 为主、排除 system/assistant）。
//    L1 的 task 正则/否定包裹/trivial 判定用这个：assistant 历史里的大段代码会把「接着问个
//    普通问题」的请求拽向 coding，与 L2/L3 判定不一致 → 人为放大层间分歧率。
// ② requestText（规模口径）：全部消息。复杂度信号的 length/turns/structure 计量按请求真实
//    规模算（用户把长代码贴回来要求改写，工作量确实是 coding 级）。
function taskText(body) {
  return classifierText(body);
}

export function estimateInputTokens(text) {
  const cjk = (text.match(/[\u3400-\u9fff]/g) || []).length;
  return Math.max(1, Math.ceil(cjk / 1.6 + (text.length - cjk) / 4));
}

export function analyzeRequest(body, config) {
  const text = taskText(body);
  // v0.7.0 六审 P2：规模口径——复杂度信号（length/structure/objectives/clauses）按请求全量文本
  // 计量（含 assistant 历史：用户贴回长代码要求改写，工作量确实按 coding 级算）；语义口径
  // （task 正则/否定/trivial）用上面的 user-only text，与 L2/L3 判定一致。
  const fullText = requestText(body);
  const patterns = resolveTaskPatterns(config.taskRules);
  let task = 'default';
  for (const [name, regex] of Object.entries(patterns)) {
    if (regex.test(text)) { task = name; break; }
  }
  // v0.6.1 五审 P2：turns/trivial 只看 user 消息。原实现用全部消息数——常见 system+user 两条
  // 消息的「今天星期几」不再是 trivial（turns=2 > 1），置信度从 0.98 跌到 0.55 进复核，
  // 复现「简单问题难度/置信度不合理」。system 提示与 assistant 历史不是「用户追问」。
  const userTurns = Array.isArray(body.messages) ? body.messages.filter((m) => m.role === 'user').length : 0;
  const turns = Array.isArray(body.messages) ? body.messages.length : 0;
  const trimmed = text.trim();
  const trivial = userTurns === 1 && TRIVIAL_FACT_PATTERN.test(trimmed);
  const signals = [];
  const addSignal = (key, label, contribution) => {
    if (contribution > 0) signals.push({ key, label, contribution: Number(contribution.toFixed(3)) });
  };
  const taskBase = trivial ? 0.08 : ({ reasoning: 0.38, coding: 0.3, creative: 0.22, extraction: 0.14, default: 0.1 }[task] || 0.1);
  addSignal('task_base', trivial ? '直接事实查询' : `任务类型：${task}`, taskBase);
  const lengthSignal = fullText.length > 1500 ? 0.32 : fullText.length > 500 ? 0.22 : fullText.length > 200 ? 0.14 : fullText.length > 80 ? 0.07 : 0;
  addSignal('length', `输入长度 ${fullText.length} 字符`, lengthSignal);
  const turnSignal = Math.min(0.12, Math.max(0, turns - 2) * 0.02);
  addSignal('turns', `多轮上下文 ${turns} 条消息`, turnSignal);
  const structuralCount = (fullText.match(/```|步骤|约束|要求|目标|前提|保证|同时|并且|必须|however|constraints?|requirements?/gi) || []).length;
  const structureSignal = Math.min(0.15, structuralCount * 0.03);
  addSignal('structure', `${structuralCount} 个约束或结构信号`, structureSignal);
  const objectiveCount = new Set((fullText.match(MULTI_OBJECTIVE_PATTERN) || []).map((x) => x.toLowerCase())).size;
  const objectiveSignal = Math.min(0.18, objectiveCount * 0.025);
  addSignal('objectives', `${objectiveCount} 个优化维度`, objectiveSignal);
  const clauseCount = (fullText.match(/[，,；;？?]|以及|同时|并且|或者/g) || []).length;
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
  // —— v0.6.0 置信度证据模型：命中是证据但不是充分证据 ——
  // 基线：trivial 直接事实 0.98（模式锚定首尾，无歧义）；任务命中 0.86 基线；default 未命中 0.55。
  // 下调：①否定包裹——「不要写代码」不是 coding 请求（语义与关键词相反）；②元讨论/引用性提及
  // ——「什么是递归」是概念问答、「总结这段代码」的主任务是 summarize 而非命中词所属任务；
  // ③多任务冲突——两个任务正则都命中时单一标签的解释力下降。clamp [0.3, 0.9]。
  const matchedCount = (() => {
    if (task === 'default') return 0;
    let count = 0;
    for (const regex of Object.values(patterns)) if (regex.test(text)) count += 1;
    return count;
  })();
  const confidence = (() => {
    if (trivial) return { value: 0.98, factors: [] };
    let base = task === 'default' ? 0.55 : 0.86;
    const factors = [];
    if (task !== 'default' && negationWrappedTask(trimmed, patterns[task])) { base -= 0.35; factors.push('negation'); }
    if (task !== 'default' && (META_QUESTION_PATTERN.test(trimmed) || META_SUMMARIZE_PATTERN.test(trimmed))) { base -= 0.25; factors.push('meta-discussion'); }
    if (task !== 'default' && matchedCount >= 2) { base -= 0.2 * (matchedCount - 1); factors.push('multi-task-conflict'); }
    return { value: Number(Math.min(0.9, Math.max(0.3, base)).toFixed(3)), factors };
  })();
  return { task: finalTask, subTask, tier, complexity, confidence: confidence.value, confidenceFactors: confidence.factors, textLength: text.length, estimatedInputTokens: estimateInputTokens(text), requirements, signals };
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

// 能力硬过滤（fail-closed）：请求要求 tools/json/vision 而模型该能力未显式声明（null/undefined）
// 时拒绝——「未知能力」不能承接生产流量，否则带工具请求可能被发给不支持工具的模型白吃 4xx。
// chat/stream 例外放行（所有对话模型基线能力，历史配置普遍未显式声明）。
function capabilityEligible(model, requirements) {
  const missing = [];
  for (const [capability, required] of Object.entries(requirements)) {
    if (!required) continue;
    if (capability === 'chat' || capability === 'stream') continue;
    if (model.capabilities?.[capability] !== true) missing.push(capability);
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
    // 成本双指标：costIndex=用户侧结算价（豆价），costIndexProvider=平台侧资源消耗（卡/吞吐）。
    // 两个独立权重各自配置，默认 providerCostWeight=0（不改变既有行为）。
    const providerWeight = Number(config.routing.providerCostWeight ?? 0);
    return config.routing.qualityWeight * quality
      - effectiveCostWeight * Number(model.costIndex || 0)
      - providerWeight * Number(model.costIndexProvider ?? 0.5) // 无部署数据的模型取 0.5 中性值，不奖不罚
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
  // 与注释一致：满足质量线的候选里选「最低成本」（GraphRouter/MixLLM 的 cost-aware oracle 上界）；
  // 全部不达标时退化为「最高质量」（保守上界）
  const qualified = eligible.filter((m) => qualityOf(m) >= floor);
  if (qualified.length) {
    qualified.sort((a, b) => Number(a.costIndex) - Number(b.costIndex) || qualityOf(b) - qualityOf(a));
    return qualified[0];
  }
  eligible.sort((a, b) => qualityOf(b) - qualityOf(a) || Number(a.costIndex) - Number(b.costIndex));
  return eligible[0];
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
  // 相对质量损失上限按 tier 分档（simple 0.08 / standard 0.04 / complex 0.02），可被 routing.relQualityCap 覆盖
  const relCapAnchor = Number(config.routing?.relQualityCap?.[analysis.tier] ?? (analysis.tier === 'simple' ? 0.08 : analysis.tier === 'complex' ? 0.02 : 0.04));
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

    // 质量分三级来源——30 小类实测（分层平滑）> 大类实测 > 默认 0.75：
    // finalScore = sub*(n/(n+k)) + major*(k/(n+k))。v0.5.2 参数保守化（Codex 二审：k=8 时 n=5 小类
    // 权重 38.5%，debugging 0.580(n=5) 把 0.955 拉到 0.811，5 条样本撼动大类结论过于激进）：
    //   - k 默认 8→32：n=5 权重 13.5%、n=8 为 20%（同样 n 下小类话语权减半）
    //   - subtaskMinSamples 默认 4：n<4 视为无小类证据，直接用大类分
    //   - subtaskMaxAdjust 默认 0.06：小类对大类分的修正幅度封顶（±0.06），防小样本极端值击穿
    const subScore = model.benchmarkScores?.subtasks?.[analysis.subTask];
    const majorScore = Number(model.quality?.[analysis.task] ?? model.quality['default'] ?? 0.75);
    let quality = majorScore;
    if (subScore && Number.isFinite(Number(subScore.avg)) && subScore.n > 0) {
      const k = Number(config.routing?.subtaskSmoothK ?? 32);
      const minSamples = Number(config.routing?.subtaskMinSamples ?? 4);
      const maxAdjust = Number(config.routing?.subtaskMaxAdjust ?? 0.06);
      if (subScore.n >= minSamples) {
        const w = subScore.n / (subScore.n + k);
        const blended = Number(subScore.avg) * w + majorScore * (1 - w);
        quality = Math.max(majorScore - maxAdjust, Math.min(majorScore + maxAdjust, blended));
      }
    }
    const uncertainty = model.reliabilityStatus === 'verified' ? 0 : config.routing.uncertaintyPenalty;
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
      qualityLoss: 0,
      effectiveQualityFloor,
      costIndex: model.costIndex,
      latencyIndex: model.latencyIndex,
      calibrationStatus: model.calibrationStatus,
      reliabilityStatus: model.reliabilityStatus || model.calibrationStatus
    });
  }
  if (!candidates.length) throw new Error('没有满足硬性能力和健康状态要求的候选模型');
  // 相对质量损失上限：与「本任务最强候选」的质量差超过 tier 档位即出局（先按质量带过滤再优化成本——
  // 加权求和允许成本项淹没质量差，导致复杂任务低质量模型胜出）。全部超限退回绝对地板，仍无则全量兜底。
  const maxQuality = Math.max(...candidates.map((x) => x.quality));
  for (const x of candidates) x.qualityLoss = Number((maxQuality - x.quality).toFixed(4));
  let qualified = candidates.filter((x) => x.qualityQualified && x.qualityLoss <= relCapAnchor);
  if (!qualified.length) qualified = candidates.filter((x) => x.qualityQualified);
  if (!qualified.length) qualified = candidates;
  const pool = qualified;
  pool.sort((a, b) => b.score - a.score || a.costIndex - b.costIndex);
  const ordered = [...pool, ...candidates.filter((x) => !pool.includes(x)).sort((a, b) => b.score - a.score)];
  // 任务偏好分流：指定模型与最优模型的分差 ≤ 容差时选指定模型（quality 不受损前提下的定向分流，
  // 如并发余量大的模型接 extraction/creative；预算压力拉高成本权重时分差扩大，自然回落最优模型）
  // 任务偏好分流（v0.5.2 收紧）：目标必须在 qualified 池内（不可绕过相对质量闸门/绝对质量线），
  // 且分差 >= 0 才参与容差判断（原实现 target 分数高于 best 时负分差天然满足「<= 容差」，
  // 超限 fallback 模型可被偏好直接提升到首位）。fallback 保留在 ordered 尾部只作兜底。
  const prefs = config.routing?.taskPreferences || {};
  const pref = prefs[analysis.task];
  let preferenceApplied = false;
  let preferenceNote = null;
  if (pref?.model && pool.length > 1) {
    const best = pool[0];
    const target = pool.find((x) => x.model === pref.model);
    const diff = target ? best.score - target.score : null;
    if (target && best.model !== pref.model && diff >= 0 && diff <= Number(pref.tolerance ?? 0.02) + 1e-9) {
      ordered.splice(ordered.indexOf(target), 1);
      ordered.unshift(target);
      preferenceApplied = true;
      preferenceNote = `taskPreferences[${analysis.task}]: ${target.model} 与最优 ${best.model} 分差 ${diff.toFixed(3)} ≤ 容差 ${pref.tolerance}（qualified 池内）`;
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
    // 十四审：requestedModel 落客户端真实请求名（未指定=当前对外 auto 名），
    // 不再写死 'auto'——决策日志/市场信号按此归并 auto vs explicit。
    requestedModel: body.model || autoModelId(config), selectedModel, suggestedModel,
    shadow: !rolloutApplied, rollout: { activeTrafficPercent, trafficBucket: Number(trafficBucket.toFixed(2)), rolloutApplied }, analysis, candidates: candidates.sort((a, b) => b.score - a.score),
    preference: preferenceApplied ? { task: analysis.task, model: pref.model, note: preferenceNote } : null,
    reasoningLevel, rejected, fallbackOrder: ordered.map((x) => x.model), configVersion: config.version
  };
}
