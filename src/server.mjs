import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { extname, join, normalize } from 'node:path';
import { loadConfig, projectRoot, saveConfig, validateConfig } from './config.mjs';
import { analyzeRequest, mergeSemanticAssessment, routeRequest, paretoFrontier, oracleChoice, zeroRouterChoice, recommendReasoningLevel } from './router.mjs';
import { resolveModelScope, scopeIntersectsConfig, scopeAllows, scopeCacheStats } from './model-scope.mjs';
import { classifySemantically, shouldUseSemanticRouter } from './semantic-router.mjs';
import { BudgetTracker, estimateCostYuan } from './budget.mjs';
import { FeedbackLog } from './feedback.mjs';
import { DecisionLog } from './decision-log.mjs';
import { logger } from './logger.mjs';
import { renderPrometheusMetrics } from './metrics.mjs';
import { renderMarkdown } from './markdown.mjs';
import { createShutdownManager, installCrashHandlers } from './shutdown.mjs';
import { createRateLimiter } from './rate-limiter.mjs';
import { shouldPromoteVerified } from './calibration.mjs';
import { MarketSignal } from './market-signal.mjs';
import { registerMarketSignal } from './market-signal-runtime.mjs';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 8787);
// 长流式 chat 的客户端可能挂 60~120 分钟，必须显式放宽默认 5 秒 keepAlive/headers 超时
const serverKeepAliveMs = Number(process.env.HTTP_KEEPALIVE_MS || 300000);    // 5 分钟
const serverHeadersTimeoutMs = Number(process.env.HTTP_HEADERS_TIMEOUT_MS || 310000); // 比 keepAlive 略高
let config = await loadConfig();
const budgetTracker = await BudgetTracker.create(projectRoot, config);
const decisionLog = await DecisionLog.create(projectRoot, config);
// 市场信号引擎（OpenRouter wisdom-of-market 内网飞轮）：聚合决策日志的份额/点名/失败率，
// 样本不足自动休眠、幅度有界（±0.05），进程级单例供 router 热路径查询
const marketSignal = new MarketSignal({ decisionLog });
marketSignal.updateConfig(config);
marketSignal.rebuild().catch(() => {});
registerMarketSignal(marketSignal);
const feedbackLog = await FeedbackLog.create(projectRoot, config);
const rateLimiter = createRateLimiter({ rpm: Number(config.rateLimit?.rpm ?? 120), burst: Number(config.rateLimit?.burst ?? config.rateLimit?.rpm ?? 120) });
// 管理端鉴权失败专用限流桶：比业务限流严得多（10次/分钟），封暴力破解
const adminAuthLimiter = createRateLimiter({ rpm: 10, burst: 10 });
const health = {};
const sessions = new Map();
const recent = [];
const semanticReviews = [];
// 路由体检（OpenRouter 评测叙事模板的内网版）：同一批代表任务上，auto 路由 vs 每个单模型固定基线
// 的加权质量/平均成本/平均时延对比——「auto 比 X 便宜多少/质量高多少」一句话有数可查。
// 模拟口径（读配置跑分），不调模型、零成本。
function buildRoutingReport() {
  const rows = SIMULATION_SAMPLES.map((sample) => {
    const decision = routeRequest(sample.body, config, { health, preview: true });
    return { sample: sample.id, task: decision.analysis.task, model: decision.selectedModel,
      quality: decision.candidates[0]?.quality ?? 0,
      costIndex: decision.candidates[0]?.costIndex ?? 0, latencyIndex: decision.candidates[0]?.latencyIndex ?? 0 };
  });
  const enabled = config.models.filter((m) => m.enabled !== false);
  const estimate = (modelId) => {
    const m = enabled.find((x) => x.id === modelId);
    return rows.map((r) => {
      const q = Number(m?.quality?.[r.task] ?? m?.quality?.default ?? 0);
      return { quality: q, costIndex: Number(m?.costIndex ?? 0), latencyIndex: Number(m?.latencyIndex ?? 0) };
    });
  };
  const avg = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
  const auto = { name: 'auto 路由', rows: rows.map((r) => ({ quality: r.quality, costIndex: r.costIndex, latencyIndex: r.latencyIndex })) };
  const baselines = enabled.map((m) => ({ name: `固定 ${m.displayName || m.id}`, rows: estimate(m.id) }));
  const summarize = (arm) => {
    const q = avg(arm.rows.map((r) => r.quality));
    const c = avg(arm.rows.map((r) => r.costIndex));
    const l = avg(arm.rows.map((r) => r.latencyIndex));
    return { name: arm.name, quality: Number(q.toFixed(3)), costIndex: Number(c.toFixed(3)), latencyIndex: Number(l.toFixed(3)) };
  };
  const arms = [auto, ...baselines].map(summarize);
  const base = arms.find((a) => a.name.startsWith('auto'));
  const strongest = arms.filter((a) => a !== base).sort((a, b) => b.quality - a.quality)[0];
  const cheapest = arms.filter((a) => a !== base).sort((a, b) => a.costIndex - b.costIndex)[0];
  const highlights = [];
  if (strongest) highlights.push(`对比最强单模型 ${strongest.name}：质量 ${base.quality} vs ${strongest.quality}（${base.quality >= strongest.quality ? '+' : ''}${(base.quality - strongest.quality).toFixed(3)}），成本指数 ${base.costIndex} vs ${strongest.costIndex}（省 ${(((strongest.costIndex - base.costIndex) / (strongest.costIndex || 1)) * 100).toFixed(0)}%）`);
  if (cheapest) highlights.push(`对比最便宜单模型 ${cheapest.name}：成本接近（${base.costIndex} vs ${cheapest.costIndex}），质量 ${base.quality} vs ${cheapest.quality}（${base.quality >= cheapest.quality ? '高' : '低'} ${Math.abs(base.quality - cheapest.quality).toFixed(3)}）`);
  return { sampleCount: rows.length, arms, highlights, perSample: rows };
}

const counters = { startedAt: new Date().toISOString(), total: 0, auto: 0, explicit: 0, success: 0, errors: 0, fallback: 0, selected: {}, selectedBy: {}, suggested: {}, task: {}, outcome: { auto: { success: 0, error: 0 }, explicit: { success: 0, error: 0 } }, semantic: { eligible: 0, attempted: 0, succeeded: 0, disagreed: 0, errors: 0, applied: 0, escalated: 0 } };
// 真实业务规模输入构造器：模拟样本不再是「一句话玩具提问」，而是带系统提示词+多轮上下文的真实调用形态。
// 用户侧输入 token 是模拟成本失真的主因（真实调用输入常为几十~上千 token，而一句话提问只有几个）。
const SYS_TPL = (role) => `你是广东移动内部${role}助手。请基于以下知识库内容回答，不要编造，引用请标注来源段落编号。知识库：{
  "营业厅业务规范": "……（约2000字业务规范节选）……",
  "计费系统接口文档": "……（约1500字接口说明）……",
  "客服话术库": "……（约1200字标准话术）……"
}。回答需分层：先一句话结论，再展开分析，最后给行动建议。`;
const HISTORY_TPL = (n) => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `第${i + 1}轮：业务背景与追问（每轮约120字，含工单号、地市、时间、客户等级等上下文）。${'背景细节填充。'.repeat(6)}` }));
const withContext = (question, { sysRole = '客服', turns = 2, docChars = 0 } = {}) => {
  const messages = [];
  messages.push({ role: 'system', content: SYS_TPL(sysRole) + (docChars ? `
附文档：${'业务文档内容。'.repeat(Math.ceil(docChars / 7))}` : '') });
  if (turns) messages.push(...HISTORY_TPL(turns));
  messages.push({ role: 'user', content: question });
  return messages;
};

const SIMULATION_SAMPLES = [
  { id: 'weekday', label: '直接事实', body: { messages: withContext('今天星期几？', { turns: 0 }), max_tokens: 64 } },
  { id: 'classification', label: '工单分类', body: { messages: withContext('把“商品破损申请退款”分类为售前、售后或咨询，只返回标签。', { sysRole: '工单', turns: 3 }), max_tokens: 64 } },
  { id: 'extraction', label: '结构化抽取', body: { messages: withContext('抽取姓名和城市并严格输出 JSON：张晓明居住在广州。', { sysRole: '数据', turns: 1, docChars: 1400 }), response_format: { type: 'json_object' }, max_tokens: 256 } },
  { id: 'summary', label: '普通摘要', body: { messages: withContext('将一份800字会议纪要压缩为五条行动项，并标明负责人和截止时间。', { sysRole: '办公', turns: 2, docChars: 800 }), max_tokens: 512 } },
  { id: 'coding', label: '代码分析', body: { messages: withContext('分析 Java 计数器 n++ 的并发安全问题，给出最小修复和单元测试。', { sysRole: '研发', turns: 2 }), max_tokens: 1024 } },
  { id: 'sql', label: 'SQL生成', body: { messages: withContext('编写 PostgreSQL 查询，统计最近30天每个用户的订单金额并按金额降序。', { sysRole: '研发', turns: 1, docChars: 600 }), max_tokens: 512 } },
  { id: 'reasoning', label: '复杂推理', body: { messages: withContext('比较 Saga、TCC 和本地消息表三种分布式事务方案，从一致性、成本、复杂度和恢复能力给出取舍。', { sysRole: '架构', turns: 3 }), max_tokens: 4096 } },
  { id: 'architecture', label: '架构设计', body: { messages: withContext('设计一个每秒一万请求的幂等支付回调系统，说明去重、事务、重试、监控、成本和扩容方案。', { sysRole: '架构', turns: 2, docChars: 2000 }), max_tokens: 4096 } },
  { id: 'creative', label: '创意文案', body: { messages: withContext('为企业内部 AI 助手写三条简洁宣传语，每条不超过18字。', { sysRole: '办公', turns: 1 }), max_tokens: 512 } },
  { id: 'tools', label: '工具调用', body: { messages: withContext('查询订单状态并总结异常原因。', { sysRole: '客服', turns: 2 }), tools: [{ type: 'function', function: { name: 'get_order', parameters: { type: 'object' } } }], max_tokens: 512 } },
  { id: 'deep-consult', label: '深度咨询', body: { messages: withContext('我们是省级运营商，需要为全省 21 个地市的营业厅设计一套智能问答系统的落地方案。请完整回答以下问题：第一，系统架构如何分层，渠道侧、应用侧、模型侧、数据侧各自的职责边界是什么，如何避免重复建设；第二，模型选型上自建与采购如何权衡，涉及成本、数据安全、迭代速度、可控性四个维度，并给出量化依据；第三，知识库建设分几期，每期的目标、范围、验收标准和风险是什么；第四，全省推广的节奏怎么安排，试点、扩容、全面上线三个阶段的准入门槛和退出条件分别是什么；第五，运营保障体系怎么建，包括监控指标、告警阈值、值班响应、故障演练的具体要求。回答必须同时满足：给出明确结论、每条结论有依据、', { sysRole: '咨询', turns: 3 }), max_tokens: 8192 } },
  { id: 'code-refactor', label: '代码重构', body: { messages: withContext('我们有一个 30 万行的 Java 单体系统，交易核心模块每到大促就出现数据库连接池耗尽和慢 SQL 告警。请做一次完整的重构设计：1）先用三段论分析根因，区分架构问题、代码问题和容量问题，并说明验证方法；2）给出目标架构，要求读写分离、热点数据本地缓存、异步削峰，同时保证分布式事务一致性，说明每种一致性方案（强一致、最终一致、补偿）的适用场景和代价；3）制定分步迁移计划，每一步要可回滚，给出灰度策略和观察指标；4）列出迁移过程中的十大风险及对应预案；5）给出容量估算模型：假设峰值 QPS 从当前 2000 涨到 12000，按读写比 8:2、缓存命中率 90% 目标推演数据库、缓存、应用层的扩容需求。', { sysRole: '架构', turns: 2, docChars: 3000 }), max_tokens: 8192 } }
];

// 分类器评测/回放的 Python 解析（v0.5.2）：CLASSIFIER_PYTHON > .venv（探活通过才用）> PATH python。
// Codex 二审：.venv 的 python.exe 可能记录失效绝对路径——existsSync 不等于可执行，spawn error 静默炸。
let classifierPythonCache = null;
async function resolveClassifierPython() {
  if (classifierPythonCache) return classifierPythonCache;
  // v0.5.3 修三审：探活从 `--version` 升级为 import 级（sklearn/joblib）。
  // 原实现 --version 通过即选中——PATH 上存在「能启动但没装 sklearn」的 python 时，
  // dump/回放直接 ImportError。分类器评测依赖的是 sklearn 栈，不是 python 本身。
  const probe = (cmd) => new Promise((resolve) => {
    const p = spawn(cmd, ['-c', 'import sklearn, joblib'], { stdio: 'ignore', windowsHide: true });
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
  const venvPython = join(projectRoot, '.venv', 'Scripts', 'python.exe');
  const candidates = [];
  if (process.env.CLASSIFIER_PYTHON) candidates.push(process.env.CLASSIFIER_PYTHON);
  if (existsSync(venvPython)) candidates.push(venvPython);
  candidates.push('python');
  for (const c of candidates) {
    if (await probe(c)) { classifierPythonCache = c; return c; }
  }
  return null;
}

// 启动安全校验（按 KEY_MODE 分支——passthrough 客户端直接持 MaaS key，ROUTER_ACCESS_KEY 无意义）：
// - 非本机绑定时 ADMIN_TOKEN 恒必填（管理页必须落锁）
// - strict 模式额外要求 ROUTER_ACCESS_KEY（否则任何人都能以路由器身份白嫖上游）
// - passthrough 模式不要求 ROUTER_ACCESS_KEY（客户端 key 真伪由上游 401 判定）
// - v0.5.2：非本机绑定时 METRICS_TOKEN 也必填（否则 /metrics 暴露模型清单/流量规模/预算——信息泄露面）
if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
  if (!process.env.ADMIN_TOKEN) throw new Error('绑定到非本机地址时必须设置 ADMIN_TOKEN');
  if (!process.env.METRICS_TOKEN) throw new Error('绑定到非本机地址时必须设置 METRICS_TOKEN（/metrics 防公开）');
  if (process.env.ROUTER_KEY_MODE !== 'passthrough' && !process.env.ROUTER_ACCESS_KEY) {
    throw new Error('strict 模式绑定到非本机地址时必须设置 ROUTER_ACCESS_KEY（passthrough 模式可省）');
  }
}

function json(res, status, value, extraHeaders = {}) {
  const payload = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload), ...extraHeaders });
  res.end(payload);
}

function errorJson(res, status, message, type = 'router_error') {
  json(res, status, { error: { message, type, code: status } });
}

// 不同路径的请求体上限差异巨大：聊天体含图片/工具可达数十 MB；管理 API/预览/模拟 < 1 MB；metrics 不读 body
const BODY_LIMITS = {
  '/v1/chat/completions': 50 * 1024 * 1024,  // 50MB：vision base64 + 长工具 schema + 长上下文
  '/admin/api/config': 1 * 1024 * 1024,
  '/admin/api/preview': 1 * 1024 * 1024,
  '/admin/api/simulate': 1 * 1024 * 1024
};
const DEFAULT_BODY_LIMIT = 64 * 1024;  // 健康检查、reload、metrics、decisions 等 GET/POST 小体

async function readJson(req) {
  const text = await readRawBody(req);
  try { return JSON.parse(text); } catch { throw new Error('请求体不是合法 JSON'); }
}
async function readRawBody(req) {
  const limit = BODY_LIMITS[req.url ? new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname : ''] ?? DEFAULT_BODY_LIMIT;
  const chunks = [];
  let size = 0;
  let overLimit = false;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) { overLimit = true; continue; } // 不 destroy 连接（会 RST 掉客户端 fetch）：继续读完再返回 400
    chunks.push(chunk);
  }
  if (overLimit) throw new Error(`请求体超过 ${Math.round(limit / 1024)}KB 上限`);
  return Buffer.concat(chunks);
}

function safeEqual(a, b) {
  if (!a || !b) return false;
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

function authorized(req, envName) {
  const required = process.env[envName];
  if (!required) return true;
  return safeEqual(req.headers.authorization, `Bearer ${required}`);
}

function record(entry) {
  recent.unshift(entry);
  if (recent.length > 200) recent.length = 200;
  // routeMethod 分布（三层 UI：L1 规则定案占比 = rules / (rules+semantic)）
  if (entry.routeMethod) {
    const by = counters.routeMethod ||= {};
    by[entry.routeMethod] = (by[entry.routeMethod] || 0) + 1;
  }
}

// key 指纹筛选（最近请求面板）：内存环形缓冲里也带 keyFingerprint（v0.4.27）
let recentKeyFilter = null;
function setRecentKeyFilter(fp) { recentKeyFilter = fp; }

// 切换影响预估：heldout 全量回放。dump=evaluate_classifier.py --dump 的逐条输出
// （gold/clf/rule 任务标签 + 小模型 confidence/tier/complexity + text 原文）。
// 三种决策链对比（与 runtime 真实代码路径一致）：
//   rules-only     ：现状 shadow——路由只看规则层分析
//   partial-active ：现有 active 模式语义——仅规则置信 < confidenceThreshold（即未命中桶 0.55）时采纳小模型
//   full-active    ：激进——所有请求都采纳小模型任务标签（需 confidenceThreshold>0.98 才等效）
// 输出：任务判准率、模型分布、质量/成本均值、误判方向分解（漏判难任务=质量风险 / 多判难任务=成本浪费）。
function replayHeldout(dump, policyConfig) {
  // 任务难度序（用于误判方向）：default < creative/extraction < coding/reasoning
  const taskRank = { default: 0, creative: 1, extraction: 1, coding: 2, reasoning: 2 };
  const semanticPolicy = { ...policyConfig.semanticRouter, enabled: true, provider: policyConfig.semanticRouter?.provider || 'http-json' };
  const init = () => ({ taskAcc: 0, count: 0, modelDist: {}, qualitySum: 0, costSum: 0, misread: { underCalled: 0, overCalled: 0, taskSwapped: 0 }, modelShifts: {} });
  const result = { rules: init(), partial: init(), full: init() };
  for (const row of dump) {
    const body = { model: 'auto', messages: [{ role: 'user', content: String(row.text || '') }] };
    const baseAnalysis = analyzeRequest(body, policyConfig);
    const baseModel = routeRequest(body, policyConfig, { health: {}, analysisOverride: baseAnalysis, trafficBucket: 0 }).suggestedModel;
    const semantic = { task: row.clf, tier: row.tier, complexity: row.complexity, confidence: row.confidence, reason: 'replay' };
    const fullAnalysis = mergeSemanticAssessment(baseAnalysis, semantic, true);
    const fullModel = routeRequest(body, policyConfig, { health: {}, analysisOverride: fullAnalysis, trafficBucket: 0 }).suggestedModel;
    // partial：与 runtime active 一致——shouldUseSemanticRouter（规则 conf < threshold 且文本够长）→ 采纳小模型
    const consulted = shouldUseSemanticRouter(baseAnalysis, body, { ...policyConfig, semanticRouter: semanticPolicy });
    const adopted = consulted && row.confidence >= 0.5;
    const partialAnalysis = adopted ? fullAnalysis : baseAnalysis;
    const partialModel = adopted ? fullModel : baseModel;
    const q = (modelId) => {
      const m = policyConfig.models.find((item) => item.id === modelId);
      return Number(m?.quality?.[row.gold] ?? m?.quality?.default ?? 0);
    };
    const c = (modelId) => Number(policyConfig.models.find((item) => item.id === modelId)?.costIndex || 0);
    const aggRow = (agg, predictedTask, modelId) => {
      agg.count += 1;
      agg.taskAcc += predictedTask === row.gold ? 1 : 0;
      agg.modelDist[modelId] = (agg.modelDist[modelId] || 0) + 1;
      agg.qualitySum += q(modelId);
      agg.costSum += c(modelId);
      if (predictedTask !== row.gold) {
        const pr = taskRank[predictedTask] ?? 0;
        const gr = taskRank[row.gold] ?? 0;
        if (pr < gr) agg.misread.underCalled += 1;       // 漏判难任务 → 质量风险
        else if (pr > gr) agg.misread.overCalled += 1;    // 多判难任务 → 成本浪费
        else agg.misread.taskSwapped += 1;                // 同档互错 → 影响小
      }
    };
    aggRow(result.rules, baseAnalysis.task, baseModel);
    aggRow(result.partial, partialAnalysis.task, partialModel);
    aggRow(result.full, fullAnalysis.task, fullModel);
    if (baseModel !== partialModel) {
      const key = `${baseModel}→${partialModel}`;
      result.partial.modelShifts[key] = (result.partial.modelShifts[key] || 0) + 1;
    }
  }
  const finalize = (agg) => ({
    taskAcc: Number((agg.taskAcc / (agg.count || 1)).toFixed(4)),
    avgQuality: Number((agg.qualitySum / (agg.count || 1)).toFixed(3)),
    avgCost: Number((agg.costSum / (agg.count || 1)).toFixed(3)),
    misread: agg.misread,
    modelDist: agg.modelDist,
    modelShifts: agg.modelShifts
  });
  return { heldoutSize: dump.length, rules: finalize(result.rules), partial: finalize(result.partial), full: finalize(result.full) };
}

function simulatePolicy(policyConfig) {
  const rows = SIMULATION_SAMPLES.map((sample) => {
    const decision = routeRequest({ model: 'auto', ...sample.body }, policyConfig, { health: {}, trafficBucket: 0 });
    const candidate = decision.candidates.find((item) => item.model === decision.suggestedModel);
    const model = policyConfig.models.find((item) => item.id === decision.suggestedModel);
    const costYuan = estimateCostYuan(sample.body, decision.analysis, model, policyConfig, decision.reasoningLevel || 'off');
    const latencyMs = model?.avgLatencyMs ?? Math.round(Number(candidate?.latencyIndex || 0) * 43787);
    return { id: sample.id, label: sample.label, task: decision.analysis.task, subTask: decision.analysis.subTask || '', complexity: decision.analysis.complexity, tier: decision.analysis.tier, model: decision.suggestedModel, quality: candidate?.quality || 0, costIndex: Number(candidate?.costIndex || 0), costIndexProvider: Number(model?.costIndexProvider ?? 0.5), latencyIndex: Number(candidate?.latencyIndex || 0), costYuan: costYuan == null ? null : Number(costYuan), latencyMs, signals: decision.analysis.signals, requirements: decision.analysis.requirements };
  });
  const distribution = {};
  for (const row of rows) distribution[row.model] = (distribution[row.model] || 0) + 1;
  const average = (field) => {
    const values = rows.map((row) => row[field]).filter((value) => value != null && Number.isFinite(Number(value)));
    if (!values.length) return null;
    return Number((values.reduce((sum, value) => sum + Number(value), 0) / values.length).toFixed(3));
  };
  const selfIds = new Set(policyConfig.models.filter((model) => model.ownership === 'self_hosted').map((model) => model.id));
  // 固定单模型基线（「不做 auto」的具象化）：给每个模型算「全部流量都给它」的 质量均值/用户成本/平台成本/时延，
  // 与当前策略对比得百分比——回答「这套策略相对直接用某个模型，成本省多少、质量变化多少」。
  const singleModelBaselines = policyConfig.models.map((model) => {
    const picks = rows.map((row) => {
      const q = Number(model.quality?.[row.task] ?? model.quality?.default ?? 0);
      return { quality: q, costIndex: Number(model.costIndex || 0), costIndexProvider: Number(model.costIndexProvider ?? 0.5), latencyIndex: Number(model.latencyIndex || 0) };
    });
    const avg = (f) => Number((picks.reduce((s, p) => s + p[f], 0) / picks.length).toFixed(3));
    return {
      model: model.id,
      displayName: model.displayName || model.id,
      averageQuality: avg('quality'),
      averageCostIndex: avg('costIndex'),
      averageCostIndexProvider: avg('costIndexProvider'),
      averageLatencyIndex: avg('latencyIndex'),
      feasible: rows.every((row) => !row.requirements || Object.entries(row.requirements).every(([cap, req]) => !req || model.capabilities?.[cap] !== false))
    };
  });
  const vsCheapest = singleModelBaselines.length
    ? singleModelBaselines.reduce((a, b) => (a.averageCostIndex <= b.averageCostIndex ? a : b))
    : null;
  const vsStrongest = singleModelBaselines.length
    ? singleModelBaselines.reduce((a, b) => (a.averageQuality >= b.averageQuality ? a : b))
    : null;
  const pct = (a, b) => (a == null || b == null || b === 0 ? null : Number((((a - b) / b) * 100).toFixed(1)));
  const comparison = {
    // 对比锚点：全用最便宜模型（成本下界/质量受损）与全用最强模型（质量上界/成本失控）
    anchors: { cheapest: vsCheapest?.model, strongest: vsStrongest?.model },
    current: {
      quality: average('quality'),
      costIndex: average('costIndex'),
      costIndexProvider: average('costIndexProvider'),
      latencyIndex: average('latencyIndex')
    },
    currentVsCheapest: { costDeltaPct: pct(average('costIndex'), vsCheapest?.averageCostIndex), qualityDeltaPct: pct(average('quality'), vsCheapest?.averageQuality) },
    currentVsStrongest: { costDeltaPct: pct(average('costIndex'), vsStrongest?.averageCostIndex), qualityDeltaPct: pct(average('quality'), vsStrongest?.averageQuality) },
    singleModelBaselines
  };

  // 论文标准锚点：Zero-Router（Pareto 前沿哈希分发）与 Oracle（逐请求事后最优）。
  // 同一批样本上聚合质量/成本/时延，回答"当前路由距随机基线和理论上界各差多少"。
  const baselines = { zeroRouter: { label: '随机基线（Pareto 前沿）' }, oracle: { label: '事后最优上界' } };
  for (const [key, chooser] of [['zeroRouter', (body, cfg) => zeroRouterChoice(body, cfg)], ['oracle', (body, cfg) => oracleChoice(body, cfg)]]) {
    const picks = [];
    let fallbackCount = 0;
    SIMULATION_SAMPLES.forEach((sample, index) => {
      const analysis = analyzeRequest(sample.body, policyConfig);
      const chosen = chooser(sample.body, policyConfig, { analysis });
      const modelId = chosen?.id ?? rows[index].model; // 选择器放弃时退回当前路由决策，计数标注
      if (!chosen) fallbackCount += 1;
      const model = policyConfig.models.find((m) => m.id === modelId);
      picks.push({
        model: modelId,
        quality: Number(model?.quality?.[analysis.task] ?? model?.quality?.default ?? 0),
        costIndex: Number(model?.costIndex || 0),
        latencyIndex: Number(model?.latencyIndex || 0)
      });
    });
    const avg = (f) => Number((picks.reduce((s, p) => s + p[f], 0) / picks.length).toFixed(3));
    baselines[key] = { label: baselines[key].label, modelDistribution: picks.reduce((acc, p) => ({ ...acc, [p.model]: (acc[p.model] || 0) + 1 }), {}), averageQuality: avg('quality'), averageCostIndex: avg('costIndex'), averageLatencyIndex: avg('latencyIndex'), fallbackCount };
  }
  return { rows, distribution, averageQuality: average('quality'), averageCostIndex: average('costIndex'), averageLatencyIndex: average('latencyIndex'), averageCostYuan: average('costYuan'), averageLatencyMs: average('latencyMs'), selfHostedRate: Number((rows.filter((row) => selfIds.has(row.model)).length / rows.length).toFixed(3)), paretoFrontier: paretoFrontier(policyConfig.models).map((m) => m.id), baselines, comparison };
}

// 敏感度分析：对三个运营滑条（成本敏感度/速度敏感度/最低质量目标）各做一次翻转点扫描。
// 回答运营的两个问题：「这个滑条再拉多少才会改变路由？」「拉到头也变不了，是为什么？」
// 实现：以 proposed 为基线，单变量步进（step=0.02），记录每个代表样本的模型翻转点；
// 若扫完全程 12 个样本零翻转，再诊断原因——某模型在当前任务分布下 Pareto 支配（质量/成本/时延全优），
// 此时任何权重组合都选它，滑条自然「无感」。
function simulateSensitivity(proposed) {
  const axes = [
    { key: 'costWeight', label: '成本敏感度', min: 0, max: 0.6 },
    { key: 'latencyWeight', label: '速度敏感度', min: 0, max: 0.6 },
    { key: 'qualityFloor', label: '最低质量目标', min: 0.6, max: 0.95 }
  ];
  const STEP = 0.02;
  const proposedAt = (cfg) => SIMULATION_SAMPLES.map((sample) => {
    try { return routeRequest({ model: 'auto', ...sample.body }, cfg, { health: {}, trafficBucket: 0 }).suggestedModel; } catch { return null; }
  });
  const basePicks = proposedAt(proposed);
  const result = {};
  for (const axis of axes) {
    const flips = []; // { at, from, to, count }
    let prevPicks = basePicks;
    let prevValue = Number(proposed.routing[axis.key]);
    const lo = Math.min(axis.min, prevValue), hi = Math.max(axis.max, prevValue);
    for (let v = lo; v <= hi + 1e-9; v += STEP) {
      const value = Number(v.toFixed(2));
      if (Math.abs(value - prevValue) < 1e-9) continue;
      const cfg = structuredClone(proposed);
      cfg.routing[axis.key] = value;
      const picks = proposedAt(cfg);
      const changedIdx = [];
      picks.forEach((m, i) => { if (m !== prevPicks[i]) changedIdx.push(i); });
      if (changedIdx.length) {
        const from = prevPicks[changedIdx[0]], to = picks[changedIdx[0]];
        flips.push({ at: value, from, to, count: changedIdx.length, labels: changedIdx.map((i) => SIMULATION_SAMPLES[i].label) });
      }
      prevPicks = picks; prevValue = value;
    }
    const currentValue = Number(proposed.routing[axis.key]);
    const nextFlip = flips.find((f) => f.at > currentValue);
    result[axis.key] = {
      label: axis.label,
      currentValue,
      range: { min: axis.min, max: axis.max },
      totalFlips: flips.reduce((s, f) => s + f.count, 0),
      flips: flips.slice(0, 8),
      nextFlip: nextFlip ? { at: nextFlip.at, from: nextFlip.from, to: nextFlip.to, count: nextFlip.count } : null,
      dominated: !flips.length ? proposeDominanceReason(proposed) : null
    };
  }
  return result;
}

// 无翻转时的原因诊断：找当前分布下被选中次数最多的模型，验证它是否对所有启用模型 Pareto 支配
function proposeDominanceReason(cfg) {
  const enabled = cfg.models.filter((m) => m.enabled !== false);
  if (enabled.length < 2) return '启用模型不足 2 个，无切换空间';
  const picks = {};
  for (const sample of SIMULATION_SAMPLES) {
    try { const m = routeRequest({ model: 'auto', ...sample.body }, cfg, { health: {}, trafficBucket: 0 }).suggestedModel; picks[m] = (picks[m] || 0) + 1; } catch {}
  }
  const top = Object.entries(picks).sort((a, b) => b[1] - a[1])[0];
  if (!top) return null;
  const [topId, topCount] = top;
  const topModel = enabled.find((m) => m.id === topId);
  if (!topModel) return null;
  // 逐任务验证：top 模型的质量分是否对每个对手全面 ≥，且成本/时延也更低（全任务支配才是真支配）
  const tasks = ['default', ...Object.keys(topModel.quality || {})];
  const dominating = enabled.filter((other) => other.id !== topId).every((other) =>
    tasks.every((t) => Number(topModel.quality?.[t] ?? topModel.quality.default) >= Number(other.quality?.[t] ?? other.quality.default))
    && Number(topModel.costIndex) <= Number(other.costIndex)
    && Number(topModel.latencyIndex) <= Number(other.latencyIndex));
  if (dominating) return `「${topModel.displayName || topId}」质量/成本/时延全面领先（Pareto 支配），调权重不会改变选择——这是阵容现状，不是配置问题`;
  return null;
}


function updateHealth(model, ok, latencyMs) {
  const state = health[model] ||= { circuitState: 'closed', probeInFlight: false, consecutiveFailures: 0, successes: 0, failures: 0, ewmaLatencyMs: 0, circuitOpenUntil: 0 };
  state.ewmaLatencyMs = state.ewmaLatencyMs ? Math.round(state.ewmaLatencyMs * 0.8 + latencyMs * 0.2) : latencyMs;
  if (ok) {
    state.circuitState = 'closed'; state.probeInFlight = false; state.consecutiveFailures = 0; state.successes += 1; state.circuitOpenUntil = 0;
  } else {
    const wasProbe = state.circuitState === 'half_open';
    state.probeInFlight = false;
    state.consecutiveFailures += 1; state.failures += 1;
    if (wasProbe || state.consecutiveFailures >= config.routing.circuitBreakerFailures) {
      state.circuitState = 'open';
      state.circuitOpenUntil = Date.now() + config.routing.circuitBreakerCooldownMs;
    }
  }
}

function claimCircuitAttempt(model) {
  const state = health[model];
  if (!state || state.circuitState === 'closed') return true;
  if (state.circuitState === 'open') {
    if (state.circuitOpenUntil > Date.now()) return false;
    state.circuitState = 'half_open';
  }
  if (state.probeInFlight) return false;
  state.probeInFlight = true;
  return true;
}

// 校准判定：模型累计真实表现达到阈值且失败率达标时，从 pilot/unverified 翻为 verified。
// 翻 verified 后 router.mjs 的 uncertaintyPenalty 自动归零（benchmark 先验让位给实时后验）。
// 持久化到 config（fire-and-forget），重启后仍保持 verified。
function maybePromoteVerified(model) {
  const modelConfig = config.models.find((item) => item.id === model);
  const verdict = shouldPromoteVerified(modelConfig, health[model], config.calibration);
  if (!verdict) return;
  modelConfig.reliabilityStatus = 'verified';
  modelConfig.calibrationStatus = 'verified'; // 旧字段同步写（未升级的旧 UI 仍读此字段）
  logger.info('model_calibrated', { model, samples: verdict.samples, failureRate: verdict.failureRate });
  saveConfig(config).then((next) => { config = next;
  if (marketSignal) { marketSignal.updateConfig(config); marketSignal.rebuild().catch(() => {}); } }).catch((error) => logger.warn('model_calibrated_save_failed', { model, error: error.message }));
}

function sessionModel(req, decision) {
  const id = req.headers['x-session-id'];
  if (!id) return decision.selectedModel;
  const current = sessions.get(id);
  // v0.5.4 修四审：粘性加闸（原实现只要旧模型还在 fallback 列表就沿用 30 分钟——
  // 先问简单题再问复杂题也会被钉在旧模型上，逐问题路由被会话粘性吞掉）。
  // 闸门三条件（与四审建议一致）：
  //   1. 旧模型仍是本请求的合格候选（在 fallbackOrder 中）
  //   2. 任务类型/难度未变（同 task 且同 tier——复杂度升档必须允许重新路由）
  //   3. 新旧最优分差小（best.score − sticky.score ≤ 阈值，默认 0.05——旧模型明显劣化时让位）
  if (current && current.expiresAt > Date.now() && decision.fallbackOrder.includes(current.model)) {
    const sameShape = current.task === decision.analysis.task && current.tier === decision.analysis.tier;
    const stickyScore = decision.candidates?.find((c) => c.model === current.model)?.score;
    const bestScore = decision.candidates?.[0]?.score;
    const stickyGap = Number.isFinite(stickyScore) && Number.isFinite(bestScore)
      ? bestScore - stickyScore
      : null;
    const maxStickyGap = Number(config.routing?.sessionStickinessMaxGap ?? 0.05);
    if (sameShape && (stickyGap == null || stickyGap <= maxStickyGap + 1e-9)) {
      return current.model; // 同型请求且旧模型仍接近最优：保持粘性（连续对话体验/上游前缀缓存）
    }
  }
  sessions.set(id, { model: decision.selectedModel, expiresAt: Date.now() + config.routing.sessionStickinessTtlMs, task: decision.analysis.task, tier: decision.analysis.tier });
  return decision.selectedModel;
}

// —— 调用方归因：key 指纹（sha256 前 8 位十六进制）——
// 只存指纹不存 key：多租户「按 key 筛选最近请求 / 消耗归因」够用，且明文日志不落敏感凭证。
function keyFingerprint(authorizationHeader) {
  const raw = String(authorizationHeader || '').replace(/^Bearer\s+/i, '').trim();
  if (!raw) return null;
  return createHash('sha256').update(raw).digest('hex').slice(0, 8);
}

function upstreamRequestBody(body, model, reasoningLevel) {
  const payload = { ...body, model };
  const modelConfig = config.models.find((item) => item.id === model);
  if (config.reasoningControl?.enabled && modelConfig?.reasoningControl?.verified) {
    const parameter = modelConfig.reasoningControl.parameter || 'reasoning_effort';
    const values = modelConfig.reasoningControl.values || { off: 'low', standard: 'medium', high: 'high' };
    // 尊重客户端显式意图：客户端已传同名参数（含点路径叶子）就不覆盖
    const parts = String(parameter).split('.');
    let node = payload; let clientSet = true;
    for (const part of parts) { if (node?.[part] === undefined) { clientSet = false; break; } node = node[part]; }
    if (!clientSet) setDeepParameter(payload, parameter, values[reasoningLevel] ?? values.standard);
  }
  return payload;
}

// 点路径参数注入（如 "chat_template_kwargs.enable_thinking" → body.chat_template_kwargs.enable_thinking）。
// 只覆盖叶子值，不整棵替换客户端已传的同名子对象（其他键保留）。
function setDeepParameter(payload, dottedPath, value) {
  const parts = String(dottedPath).split('.');
  let node = payload;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (!node[parts[i]] || typeof node[parts[i]] !== 'object') node[parts[i]] = {};
    node = node[parts[i]];
  }
  node[parts.at(-1)] = value;
}

// —— 上游 key 模式 ——
// strict（默认）: 客户端持 ROUTER_ACCESS_KEY，路由器用服务端 MAAS_API_KEY 调上游。
// passthrough: 客户端的 Authorization 头原样转发 MaaS——供 MaaS 网关分流 model=auto 场景：
//   同一 URL 同一租户 key 调 auto 与直连模型完全一致，计费/配额自然落到调用方租户。
// —— 飞轮：上游回包 usage 捕获（流式需解析 SSE chunk）：返回 {prompt,completion,cached} 或 null ——
function extractUsage(contentType, body) {
  try {
    if (!contentType?.includes('text/event-stream')) {
      const parsed = JSON.parse(body);
      const u = parsed?.usage;
      return u ? { prompt: u.prompt_tokens ?? null, completion: u.completion_tokens ?? null, reasoning: u.completion_tokens_details?.reasoning_tokens ?? null, cached: u.prompt_tokens_details?.cached_tokens ?? null } : null;
    }
    // 流式：OpenAI 协议最后一块 chunk 带 usage（需请求带 stream_options.include_usage 或网关默认附加）
    const lines = String(body).split('\n').filter((l) => l.startsWith('data:'));
    for (let i = lines.length - 1; i >= 0; i--) {
      const payload = lines[i].slice(5).trim();
      if (payload === '[DONE]') continue;
      const parsed = JSON.parse(payload);
      if (parsed?.usage) return { prompt: parsed.usage.prompt_tokens ?? null, completion: parsed.usage.completion_tokens ?? null, reasoning: parsed.usage.completion_tokens_details?.reasoning_tokens ?? null, cached: parsed.usage.prompt_tokens_details?.cached_tokens ?? null };
    }
    return null;
  } catch { return null; }
}

// 实际成本（对账口径）：按上游 usage 真实 token 结算，元/百万token 定价
function computeActualCostFromUsage(usage, modelConfig) {
  const p = modelConfig?.pricingYuanPerMillionTokens;
  if (!p || usage?.prompt == null || usage?.completion == null) return null;
  const cached = usage.cached || 0;
  const inputPrice = p.input ?? 0;
  const cachedPrice = p.inputCached ?? p.input ?? 0;
  const cost = ((usage.prompt - cached) * inputPrice + cached * cachedPrice + usage.completion * (p.output ?? 0)) / 1_000_000;
  return Number.isFinite(cost) ? Number(cost.toFixed(6)) : null;
}

async function callUpstream(body, model, signal, reasoningLevel = 'off', clientAuthHeader = null) {
  const base = (process.env.UPSTREAM_BASE_URL || process.env.MAAS_BASE_URL || config.upstreamBaseUrl).replace(/\/$/, '');
  const passthrough = process.env.ROUTER_KEY_MODE === 'passthrough';
  let key = passthrough ? clientAuthHeader : (process.env.UPSTREAM_API_KEY || process.env.MAAS_API_KEY);
  // passthrough 但客户端没带 key：退回服务端 key（仍可用），只是计费落不到租户
  if (!key && passthrough) key = process.env.UPSTREAM_API_KEY || process.env.MAAS_API_KEY;
  if (!key) {
    const error = new Error('尚未设置 MAAS_API_KEY；请使用轮换后的新 Key');
    error.retryable = false;
    throw error;
  }
  return fetch(`${base}/chat/completions`, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', authorization: passthrough ? key : 'Bearer ' + key },
    body: JSON.stringify(upstreamRequestBody(body, model, reasoningLevel))
  });
}

// 上游连通性探针（/health/ready 用）：轻量 /models 请求，30 秒 TTL 缓存
let probeCache = { at: 0, result: null };
const PROBE_TTL_MS = 30000;

async function probeUpstream() {
  const now = Date.now();
  if (probeCache.result && now - probeCache.at < PROBE_TTL_MS) return probeCache.result;
  const base = (process.env.UPSTREAM_BASE_URL || process.env.MAAS_BASE_URL || config.upstreamBaseUrl)?.replace(/\/$/, '');
  const key = process.env.UPSTREAM_API_KEY || process.env.MAAS_API_KEY;
  // passthrough 且无服务端 key：改探无鉴权可达性（401/403 也证明上游活着）——
  // passthrough 本就可不配服务端 key，「没配 key 就永远 not_ready」是 strict 语义误用
  const passthroughNoKey = process.env.ROUTER_KEY_MODE === 'passthrough' && !key;
  if (!base || (!key && !passthroughNoKey)) {
    const result = { reachable: false, error: 'upstream_not_configured' };
    probeCache = { at: now, result };
    return result;
  }
  if (passthroughNoKey) {
    try {
      const res = await fetch(`${base}/models`, { signal: AbortSignal.timeout(Number(process.env.UPSTREAM_PROBE_TIMEOUT_MS || 10000)) });
      const result = { reachable: true, status: res.status, error: null, mode: 'passthrough_unauthenticated' };
      probeCache = { at: now, result };
      return result;
    } catch (error) {
      const result = { reachable: false, error: error.name || 'fetch_error', mode: 'passthrough_unauthenticated' };
      probeCache = { at: now, result };
      return result;
    }
  }
  try {
    const res = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(Number(process.env.UPSTREAM_PROBE_TIMEOUT_MS || 10000)) });
    const result = { reachable: res.ok, status: res.status, error: res.ok ? null : `status_${res.status}` };
    probeCache = { at: now, result };
    return result;
  } catch (error) {
    const result = { reachable: false, error: error.name || 'fetch_error' };
    probeCache = { at: now, result };
    return result;
  }
}

function semanticOptions(clientAuthHeader = null) {
  // v0.6.0：passthrough 模式下大模型分类器允许透传本次客户端 key（四审：原实现只读服务端
  // key，passthrough 无服务端 key 时 cascade 升级必报「缺少上游 API Key」）。客户端 key 优先。
  // v0.6.1 五审 P1 修正：仅 passthrough 允许客户端 key。strict 模式下客户端 Authorization 是
  // ROUTER_ACCESS_KEY（本路由的准入凭证），不是 MaaS key——拿它打 MaaS 必 401，还会把 Router
  // Key 泄漏给上游。strict 一律用服务端 key。
  const serverKey = process.env.UPSTREAM_API_KEY || process.env.MAAS_API_KEY;
  const passthrough = process.env.ROUTER_KEY_MODE === 'passthrough';
  const clientKey = passthrough && clientAuthHeader ? String(clientAuthHeader).replace(/^Bearer\s+/i, '') : null;
  const apiKey = clientKey || serverKey;
  return {
    baseUrl: process.env.UPSTREAM_BASE_URL || process.env.MAAS_BASE_URL || config.upstreamBaseUrl,
    apiKey
  };
}

function recordSemanticReview(review) {
  semanticReviews.unshift(review);
  if (semanticReviews.length > 100) semanticReviews.length = 100;
}

// v0.6.1 五审 P1：路由开销（L3 大模型分类调用）入账。返回 { overheadUsage, overheadCostYuan,
// classifierLatencyMs }——由调用方并进 review/决策日志，金额现金入预算台账（已确定无需预占冲正）。
function routingOverhead(assessment) {
  if (!assessment?.overheadUsage) return null;
  const modelConfig = config.models.find((item) => item.id === assessment.model);
  const costYuan = computeActualCostFromUsage(assessment.overheadUsage, modelConfig);
  // 现金入账进 settledActual（有真实 usage 支撑），不进在途预占 estimatedSpendYuan——
  // 预占语义是「未结算」，分类费已确定，走 estimated 会虚增 pendingReserves 压力。budget.enabled=false 也照记（对账口径）。
  if (costYuan != null) budgetTracker.chargeRouterOverhead(costYuan).catch?.(() => {});
  counters.routingOverhead ??= { calls: 0, costYuan: 0, promptTokens: 0, completionTokens: 0 };
  counters.routingOverhead.calls += 1;
  counters.routingOverhead.costYuan = Number((counters.routingOverhead.costYuan + (costYuan || 0)).toFixed(6));
  counters.routingOverhead.promptTokens += assessment.overheadUsage.prompt || 0;
  counters.routingOverhead.completionTokens += assessment.overheadUsage.completion || 0;
  return { overheadUsage: assessment.overheadUsage, overheadCostYuan: costYuan, classifierLatencyMs: assessment.latencyMs || null };
}

function classifyAndCompare(body, baseAnalysis, baseDecision, { track = true, clientAuthHeader = null, allowedModelIds = null } = {}) {
  if (track) counters.semantic.attempted += 1;
  return classifySemantically(body, config, semanticOptions(clientAuthHeader)).then((assessment) => {
    if (track) counters.semantic.succeeded += 1;
    if (track && assessment?.escalatedFrom) counters.semantic.escalated = (counters.semantic.escalated || 0) + 1;
    const semanticAnalysis = mergeSemanticAssessment(baseAnalysis, assessment, true);
    // v0.6.1 五审 P1：语义重路由沿用首次路由的租户候选范围。原实现只传 health/analysisOverride/
    // budgetPressure/trafficBucket——L2/L3 重判 task/tier 后第二次 routeRequest 拿全量模型池打分，
    // active 模式可能提出租户无权调用的模型（上游 403/404 + 无谓 fallback）。shadow 的 proposed
    // 对比同样要用同口径候选池，否则分歧率统计失真。
    const proposed = routeRequest(body, config, { health, analysisOverride: semanticAnalysis, budgetPressure: budgetTracker.pressure(), trafficBucket: baseDecision.rollout.trafficBucket, ...(allowedModelIds ? { allowedModelIds } : {}) });
    const disagreed = assessment.tier !== baseAnalysis.tier || assessment.task !== baseAnalysis.task || proposed.suggestedModel !== baseDecision.suggestedModel;
    if (track && disagreed) counters.semantic.disagreed += 1;
    // v0.6.1 五审 P2：cascade 分层计数（small 直采 / large 升级 / small-degraded 降级）——
    // 运营调 smallAcceptThreshold 时需要看到 L3 调用率（=成本）的对应变化
    if (track && assessment?.cascade?.level) {
      counters.semantic.byCascadeLevel ??= {};
      counters.semantic.byCascadeLevel[assessment.cascade.level] = (counters.semantic.byCascadeLevel[assessment.cascade.level] || 0) + 1;
    }
    const review = { at: new Date().toISOString(), assessment, base: { task: baseAnalysis.task, tier: baseAnalysis.tier, complexity: baseAnalysis.complexity, model: baseDecision.suggestedModel }, proposed: { task: semanticAnalysis.task, tier: semanticAnalysis.tier, complexity: semanticAnalysis.complexity, model: proposed.suggestedModel }, disagreed };
    // v0.6.1 五审 P1：L3 大模型分类调用成本入账（原实现完全不入预算台账——真实付费的黑洞）。
    // 按 assessment.model 的 token 定价 × 真实 usage 现金入账（非预占：金额已确定无需冲正）；
    // 决策日志随 review.assessment 携带 overheadUsage/overheadCostYuan；shadow 阶段该成本由
    // 平台承担（只观察不改路由），active 阶段计入该请求总成本。
    const overhead = routingOverhead(assessment);
    if (overhead) Object.assign(review, overhead);
    if (track) recordSemanticReview(review);
    return { assessment, semanticAnalysis, proposed, review };
  }).catch((error) => {
    if (track) {
      counters.semantic.errors += 1;
      recordSemanticReview({ at: new Date().toISOString(), error: error.message });
    }
    throw error;
  });
}

async function resolveAutoDecision(body, { preview = false, clientAuthHeader = null } = {}) {
  const baseAnalysis = { ...analyzeRequest(body, config), routeMethod: 'rules' };
  const runtime = { health, analysisOverride: baseAnalysis, budgetPressure: budgetTracker.pressure(), ...(preview ? { trafficBucket: 0 } : {}) };
  // 套餐动态候选池：按客户端 key 解析 v1/models 可用集，交集非空才启用过滤（防命名不匹配全灭），失败回退全量
  const scope = await resolveModelScope({
    baseUrl: process.env.UPSTREAM_BASE_URL || process.env.MAAS_BASE_URL || config.upstreamBaseUrl,
    // 套餐查询用客户端 key（passthrough 语义：查调用方租户的可用集，不是服务端账号的）；
    // 客户端没带 key（strict）才回落服务端 key——此时本就无租户语义
    apiKey: clientAuthHeader ? clientAuthHeader.replace(/^Bearer\s+/i, '') : (process.env.UPSTREAM_API_KEY || process.env.MAAS_API_KEY),
    authorizationHeader: clientAuthHeader,
    passthrough: process.env.ROUTER_KEY_MODE === 'passthrough'
  });
  const scopeActive = scope && scopeIntersectsConfig(scope, config.models);
  if (scopeActive) runtime.allowedModelIds = scope;
  const baseDecision = routeRequest(body, config, runtime);
  if (!shouldUseSemanticRouter(baseAnalysis, body, config)) return baseDecision;
  if (!preview) counters.semantic.eligible += 1;
  if (config.semanticRouter.mode === 'shadow' && !preview) {
    classifyAndCompare(body, baseAnalysis, baseDecision, { clientAuthHeader, allowedModelIds: runtime.allowedModelIds || null }).catch(() => {});
    return { ...baseDecision, semanticReview: { status: 'shadow_pending' } };
  }
  try {
    const result = await classifyAndCompare(body, baseAnalysis, baseDecision, { track: !preview, clientAuthHeader, allowedModelIds: runtime.allowedModelIds || null });
    if (config.semanticRouter.mode === 'active') {
      // v0.6.0：采纳线独立成 finalAdoptionThreshold（四审：原 minConfidence 双语义——
      // cascade 里当升级线、这里当采纳线）。语义复核最终结果（无论来自小模型直接采纳、
      // 大模型复核、还是大模型挂了的降级小模型）confidence 低于此线 → 退回规则层决策，只记观察。
      // 兼容：未配置 finalAdoptionThreshold 时读 minConfidence（旧配置语义不变）。
      const adoptionThreshold = Number(config.semanticRouter.finalAdoptionThreshold ?? config.semanticRouter.minConfidence ?? 0);
      if (result.assessment.confidence < adoptionThreshold) {
        counters.semantic.rejectedLowConfidence = (counters.semantic.rejectedLowConfidence || 0) + 1;
        return { ...baseDecision, semanticReview: { status: 'rejected_low_confidence', ...result.review } };
      }
      counters.semantic.applied += 1;
      return { ...result.proposed, semanticReview: { status: 'applied', ...result.review } };
    }
    return { ...baseDecision, analysis: mergeSemanticAssessment(baseAnalysis, result.assessment, false), semanticReview: { status: 'shadow_complete', ...result.review } };
  } catch (error) {
    return { ...baseDecision, semanticReview: { status: 'error', error: error.message } };
  }
}

async function proxyCompletion(req, res) {
  if (shutdownManager.draining) return errorJson(res, 503, '服务正在下线，请稍后重试', 'server_draining');
  // passthrough 模式：客户端持的就是 MaaS key（MaaS 网关分流场景），只要求非空——真伪由上游 401 判定；
  // strict 模式：客户端必须持 ROUTER_ACCESS_KEY。
  if (process.env.ROUTER_KEY_MODE === 'passthrough') {
    if (!req.headers.authorization) return errorJson(res, 401, '缺少 Authorization（请携带 MaaS apikey）', 'authentication_error');
  } else if (!authorized(req, 'ROUTER_ACCESS_KEY')) return errorJson(res, 401, 'Router API Key 无效', 'authentication_error');
  if (config.rateLimit?.enabled !== false) {
    // 桶 key 用 SHA-256 摘要而非原始 Authorization 头：避免完整凭证滞留内存（heap dump/日志误打暴露面）
    const authKey = req.headers.authorization
      ? createHash('sha256').update(req.headers.authorization).digest('hex').slice(0, 16)
      : 'anonymous';
    const verdict = rateLimiter.check(authKey);
    if (!verdict.allowed) {
      return json(res, 429, { error: { message: '请求过于频繁，请稍后重试', type: 'rate_limit_exceeded', code: 429 } }, { 'retry-after': String(Math.ceil(verdict.retryAfterMs / 1000)) });
    }
  }
  let body;
  try { body = await readJson(req); } catch (error) { return errorJson(res, 400, error.message, 'invalid_request_error'); }
  if (!Array.isArray(body.messages)) return errorJson(res, 400, 'messages 必须是数组', 'invalid_request_error');
  counters.total += 1;
  const auto = !body.model || body.model === 'auto';
  let decision;
  if (auto) {
    counters.auto += 1;
    try { decision = await resolveAutoDecision(body, { clientAuthHeader: req.headers.authorization }); }
    catch (error) { counters.errors += 1; return errorJson(res, 503, error.message); }
  } else {
    counters.explicit += 1;
    const model = config.models.find((x) => x.id === body.model && x.enabled);
    if (!config.routing.allowExplicitModel) return errorJson(res, 403, '当前策略不允许显式选择模型');
    if (!model) return errorJson(res, 400, `模型不存在或未启用: ${body.model}`, 'invalid_request_error');
    // explicit：reasoningLevel 不再硬编码 off——按请求本身复杂度定档（点名思考型模型问复杂问题应保留思考）
    const explicitAnalysis = analyzeRequest(body, config);
    const explicitLevel = recommendReasoningLevel(explicitAnalysis, config);
    decision = { requestedModel: body.model, selectedModel: body.model, suggestedModel: body.model, shadow: false, analysis: { ...explicitAnalysis, task: 'explicit', tier: 'explicit', routeMethod: 'explicit' }, explicitTask: explicitAnalysis.task, reasoningLevel: explicitLevel, candidates: [], rejected: [], fallbackOrder: [body.model], configVersion: config.version };
  }
  decision.selectedModel = sessionModel(req, decision);
  // 思考预算守卫：选中的是思考型模型但客户端给的 max_tokens 低于其安全下限时强制关思考——
  // 否则思考与正文共享预算，思考烧完 content 为空（finish=length）；保住正文输出优先于深度思考
  const selectedModelConfig = config.models.find((item) => item.id === decision.selectedModel);
  if (decision.reasoningLevel !== 'off' && selectedModelConfig?.reasoningControl?.verified) {
    const requestedCompletionTokens = Number(body.max_completion_tokens || body.max_tokens || 0);
    const minForThinking = Number(selectedModelConfig.minimumCompletionTokensForReliableAnswer || 0);
    if (requestedCompletionTokens > 0 && minForThinking > 0 && requestedCompletionTokens < minForThinking) {
      decision.reasoningLevel = 'off';
      decision.reasoningGuard = `思考预算不足（${requestedCompletionTokens} < ${minForThinking}）：已强制关闭思考保正文输出`;
    }
  }
  counters.suggested[decision.suggestedModel] = (counters.suggested[decision.suggestedModel] || 0) + 1;
  counters.task[decision.analysis.task] = (counters.task[decision.analysis.task] || 0) + 1;
  const fallback = decision.fallbackOrder.filter((m) => m !== decision.selectedModel);
  const attempts = [decision.selectedModel, ...fallback].slice(0, auto ? config.routing.maxAttempts : 1);
  // 记账上下文（try/catch 外声明——v0.5.2 修复 v0.5.1 作用域 bug：markStreamOutcome/reserveId 原声明在 try 内，
  // catch 不可见，断流时先抛 ReferenceError 掩盖原始错误）。生命周期（每个 attempt 恰好一次）：
  //   reserve(估算) → [成功: markOutcome(true) + settle(实际 usage；无 usage 保留估算)] | [失败: markOutcome(false) + settle(null) 保留估算]
  let reserveId = null;
  let estimatedCostYuan = null;
  let settledAttempt = false; // 预算落账闸（防 fallback 重试路径双结算）
  let outcomeSettled = true;  // 成功/失败落账闸（true=无在途 attempt，调用 no-op）
  let actxCtx = null;         // { model, started, ttftMs, isStream } 当前 attempt 快照
  // —— 客户端断开哨兵 + 非流式交付守卫（v0.5.3，Codex 三审 P1）——
  // 哨兵在 attempts 循环前注册：客户端在任何阶段断开（含服务端还在等上游响应头时）都能捕获；
  // 非流式 close 时按「writableFinished && delivered」判成功/失败。流式 close 交给流转发循环的
  // 异常路径（断流时 res.write 抛错或上游迭代器抛错进 catch），此守卫不重复落账（outcomeSettled 闸兜底）。
  let clientGone = false;
  const delivery = { delivered: false, usage: null, log: null, guardActive: false };
  // v0.6.1 五审 P1：决策日志幂等闸。预算（settledAttempt）与成功计数（outcomeSettled）各有闸门，
  // 唯独 decisionLog.write 无闸——成功流式会双写（close 守卫 + res.end 回调各一次，本地 200 条
  // 实测 9 个重复 requestId），污染市场信号/胜率/训练集。收敛为请求级唯一写入口：无论成功、
  // 失败、断开，每个请求恰好落一条 outcome 日志（顺带补齐 mid-flight 断流/客户端早退此前
  // 完全不落日志的缺口——同一正确性类别）。
  let requestLogWritten = false;
  const writeOutcomeLog = (outcome) => {
    if (requestLogWritten) return;
    requestLogWritten = true;
    decisionLog.write({ sessionId: req.headers['x-session-id'] || null, requestId: req.requestId, keyFingerprint: keyFingerprint(req.headers.authorization), redactedBody: decisionLog.redact(body) }, decision, outcome);
  };
  const onClientClose = () => {
    clientGone = true;
    if (!delivery.guardActive) {
      // attempt 前段（等上游响应头/读上游 body）客户端断开：无在途响应可交付，记客户端写失败
      // （v0.5.3：原实现只置标志不落账——成功失败都不记、reserve 等结算泄漏到进程重启）
      if (!outcomeSettled) {
        markOutcome(false, new Error('client_disconnected'));
        settleAttempt(null, false);
        writeOutcomeLog({ ok: false, model: actxCtx?.model, error: 'client_disconnected', latencyMs: actxCtx ? Date.now() - actxCtx.started : null });
        logger.warn('client_abandoned_upstream_wait', { requestId: req.requestId });
      }
      return;
    }
    if (res.writableFinished && delivery.delivered) {
      markOutcome(true);
      settleWithUsageGlobal(delivery.usage);
      if (delivery.log) writeOutcomeLog(delivery.log.outcome);
    } else {
      markOutcome(false, new Error('client_disconnected'));
      settleAttempt(null, false);
      writeOutcomeLog({ ok: false, model: actxCtx?.model, error: 'client_disconnected', latencyMs: actxCtx ? Date.now() - actxCtx.started : null });
      logger.warn('client_write_failed', { requestId: req.requestId, delivered: delivery.delivered, writableFinished: res.writableFinished });
    }
  };
  res.once('close', onClientClose);
  // settleWithUsage 需引用当前 attempt 的 selectedConfig——提升为请求级（每次 attempt 刷新）
  let settleWithUsageGlobal = () => {};
  const settleAttempt = (actualYuan, fromUsage) => {
    if (settledAttempt) return;
    settledAttempt = true;
    if (reserveId == null) return;
    const id = reserveId; reserveId = null;
    budgetTracker.settle(id, actualYuan, fromUsage).catch(() => {});
  };
  const markSelectedBy = (model) => {
    counters.selected[model] = (counters.selected[model] || 0) + 1;
    const selectedBy = counters.selectedBy[model] ||= { explicit: 0, auto: 0, autoPreference: 0 };
    if (!auto) selectedBy.explicit += 1;
    else if (decision.preference?.model === model) { selectedBy.autoPreference += 1; selectedBy.auto += 1; }
    else selectedBy.auto += 1;
  };
  // 单次落账（v0.5.2）：成功只在「响应体完整交付」后记；失败只在 mid-flight 中断记
  // （attempt 前段失败由 catch 的 updateHealth+post-loop counters.errors 记，不在此重复）
  const markOutcome = (ok, err) => {
    if (outcomeSettled || !actxCtx) return; outcomeSettled = true;
    const c = actxCtx;
    if (ok) {
      updateHealth(c.model, true, c.ttftMs);
      maybePromoteVerified(c.model);
      counters.success += 1;
      counters.outcome[c.auto ? 'auto' : 'explicit'].success += 1;
      markSelectedBy(c.model);
      counters.ttft ??= { count: 0, sumMs: 0 };
      counters.ttft.count += 1; counters.ttft.sumMs += c.ttftMs;
      if (c.isStream) { counters.stream ??= { completed: 0, aborted: 0 }; counters.stream.completed += 1; }
    } else {
      updateHealth(c.model, false, Date.now() - c.started);
      counters.failures += 1;
      counters.outcome[c.auto ? 'auto' : 'explicit'].error += 1;
      if (c.isStream) { counters.stream ??= { completed: 0, aborted: 0 }; counters.stream.aborted += 1; }
      if (err) logger.warn(c.isStream ? 'stream_aborted' : 'client_write_failed', { requestId: req.requestId, model: c.model, error: String(err.message || err) });
    }
  };
  // v0.5.3 修三审 P1：controller 改为每 attempt 独立创建。原实现在循环外创建单例——
  // 第一次超时 abort 后 signal 永久失效，后续 fallback 复用已 aborted 的 signal 立即失败，
  // 「每次尝试独立计时」只重置了 timer 没重建 controller，超时必然污染整个 fallback 链。
  let controller = null;
  // 超时语义（v0.4.26 修复流式长回答被掐）：
  //   非流式 = 整请求总超时；流式 = 闲置超时（收到任何上游数据即续命）。
  //   旧实现对流式也用一次性总超时——dsf 长回答（31 tok/s，10k 字≈110s+）撞 120s 线被 abort，
  //   客户端表现为流中断后反复续写仍截断。闲置超时只杀真堵死（无数据流动）的连接。
  const timeoutMs = Number(config.routing.requestTimeoutMs) || 120000;
  let timer = null;
  const armTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error(`上游请求超时（${body.stream ? '数据停滞' : '总时长'} 超过 ${Math.round(timeoutMs / 1000)}s）`)), timeoutMs);
  };
  let lastError;
  for (let i = 0; i < attempts.length; i += 1) {
    const model = attempts[i];
    if (!claimCircuitAttempt(model)) continue;
    const started = Date.now();
    controller = new AbortController(); // 新 attempt 新 signal（三审 P1：超时 abort 不再泄漏到 fallback）
    armTimer(); // 每次尝试独立计时（旧实现 timer 在循环外只设一次，attempt 2 继承剩余预算）
    try {
      // 飞轮：流式请求带上 stream_options.include_usage，上游会在最后一个 chunk 附带 usage
      if (body.stream === true) body.stream_options = { ...(body.stream_options || {}), include_usage: true };
      const upstream = await callUpstream(body, model, controller.signal, decision.reasoningLevel, req.headers.authorization);
      const latency = Date.now() - started;
      if (!upstream.ok) {
        const message = (await upstream.text()).slice(0, 2000);
        logger.warn('upstream_error', { requestId: req.requestId, model, status: upstream.status, body: message });
        lastError = new Error(`上游 ${model} 调用失败（HTTP ${upstream.status}）`);
        lastError.retryable = [408, 429, 500, 502, 503, 504].includes(upstream.status);
        throw lastError;
      }
      // 客户端已在等待上游期间断开（v0.5.3）：响应无处交付，记失败结账直接返回——
      // 不 reserve、不 fallback（无人接收结果，重试只是烧钱）、不写死 socket
      if (clientGone) {
        actxCtx = { model, started, ttftMs: Date.now() - started, isStream: body.stream === true, auto };
        outcomeSettled = false;
        markOutcome(false, new Error('client_disconnected'));
        logger.warn('client_abandoned_upstream_wait', { requestId: req.requestId, model, latencyMs: Date.now() - started });
        writeOutcomeLog({ ok: false, model, error: 'client_disconnected', latencyMs: Date.now() - started });
        clearTimeout(timer);
        return res.destroy();
      }
      // 飞轮：转发前先判定是否流式——流式不缓冲整个响应（内存安全），usage 从 SSE 尾块解析
      const isStream = body.stream === true;
      let usage = null;
      // 记账纪律：首包到达 ≠ 成功。非流式：响应体整体读完才算成功（text() 后记）；
      // 流式：此处只留 TTFT 观测，成功/失败在流尾落账（markStreamOutcome），中断只记失败不双记。
      const firstByteLatencyMs = latency;
      const selectedConfig = config.models.find((item) => item.id === model);
      estimatedCostYuan = estimateCostYuan(body, decision.analysis, selectedConfig, config, decision.reasoningLevel);
      // 预算预占-结算：请求开始预占估算额，结束按实际 usage 冲正（无 usage 保留估算并标记 estimated）
      reserveId = await budgetTracker.reserve(estimatedCostYuan);
      settledAttempt = false; outcomeSettled = false; // 新 attempt：重置两道落账闸
      actxCtx = { model, started, ttftMs: firstByteLatencyMs, isStream: body.stream === true, auto };
      // 有 usage 按实际 token 冲正；无 usage 保留估算并标记 estimated（v0.5.2：settleWithUsage 统一入口）
      settleWithUsageGlobal = (u) => {
        if (u && u.prompt != null && u.completion != null) {
          const actual = computeActualCostFromUsage(u, selectedConfig);
          if (actual != null) { settleAttempt(actual, true); return; }
        }
        settleAttempt(null, false);
      };
      const settleWithUsage = settleWithUsageGlobal;
      // 飞轮：非流式在此整体缓冲解析 usage（拿到实际 token 数）；流式在转发循环中从尾块提取
      let responseText = null;
      if (!isStream && upstream.body) {
        responseText = await upstream.text();
        usage = extractUsage(upstream.headers.get('content-type'), responseText);
        // v0.5.4 fix four-review P1: recheck clientGone after body read. During the read the close guard
        // already settled via guardActive=false branch (outcomeSettled=true, reserve closed) — continuing here would
        // write to a dead socket and add tokens nobody received. Early return prevents ghost success.
        if (clientGone) {
          clearTimeout(timer);
          logger.warn('client_abandoned_during_body_read', { requestId: req.requestId, model });
          writeOutcomeLog({ ok: false, model, error: 'client_disconnected_during_body_read', usage, latencyMs: latency });
          return;
        }
        // Success accounting stays with the close guard (v0.5.3 fix): delivered-then-finished semantics.
      }
      // 实际成本：有 usage 时按真实 token 结算（对账口径），否则保留预估值
      const actualCostYuan = usage ? computeActualCostFromUsage(usage, selectedConfig) : null;
      if (actualCostYuan != null) { counters.tokens ??= {}; counters.tokens.prompt = (counters.tokens.prompt || 0) + usage.prompt; counters.tokens.completion = (counters.tokens.completion || 0) + usage.completion; }
      // 日志先组装不落盘（流式的 usage 在流尾才知道）——转发完成后统一 write
      const logEntry = { sessionId: req.headers['x-session-id'] || null, requestId: req.requestId, keyFingerprint: keyFingerprint(req.headers.authorization), redactedBody: decisionLog.redact(body) };
      const logOutcome = { ok: true, model, latencyMs: latency, fallbackAttempt: i, estimatedCostYuan, actualCostYuan, usage };
      record({ at: new Date().toISOString(), requested: decision.requestedModel, selected: model, suggested: decision.suggestedModel, task: decision.analysis.task, complexity: decision.analysis.complexity, routeMethod: decision.analysis.routeMethod, reasoningLevel: decision.reasoningLevel, reasoningApplied: Boolean(selectedModelConfig?.reasoningControl?.verified) && decision.reasoningLevel !== 'off', keyFingerprint: keyFingerprint(req.headers.authorization), estimatedCostYuan, actualCostYuan, latencyMs: latency, fallbackAttempt: i, ok: true });
      const headers = {
        'content-type': upstream.headers.get('content-type') || (body.stream ? 'text/event-stream' : 'application/json'),
        'cache-control': 'no-cache',
        'x-router-selected-model': model,
        'x-router-suggested-model': decision.suggestedModel,
        'x-router-task': decision.analysis?.task || '',
        'x-router-cost-tier': config.routing?.costTier || 'custom',
        'x-router-policy-version': String(config.version),
        'x-router-shadow': String(decision.shadow),
        'x-router-reasoning-level': decision.reasoningLevel,
        'x-router-route-method': decision.analysis.routeMethod || 'rules'
      };
      res.writeHead(200, headers);
      if (!upstream.body) { clearTimeout(timer); delivery.delivered = true; delivery.guardActive = true; return void res.end(); } // 无 body 上游（304 类）：close 守卫结清
      if (responseText !== null) {
        // 非流式：一次性写回。成功落账由 close 守卫按「writableFinished && delivered」判定——
        // v0.5.3 修三审 P1：v0.5.2 在 text() 读毕即记成功，客户端已断开时记了假成功。
        delivery.usage = usage;
        delivery.log = { entry: logEntry, outcome: usage ? { ...logOutcome, usage, actualCostYuan: usage.prompt != null && usage.completion != null ? computeActualCostFromUsage(usage, selectedConfig) : logOutcome.actualCostYuan } : logOutcome };
        delivery.delivered = true;
        delivery.guardActive = true;
        clearTimeout(timer); return void res.end(responseText);
      }
      // 流式：逐块转发（背压安全），并从 SSE 尾块提取 usage（飞轮：实际 token 消耗）
      // 超时续命：每收到一个 chunk 重置闲置计时器——只要上游还在产 token 就不掐（v0.4.26）
      // 注意：undici 的 chunk 是 Uint8Array，toString('utf8') 不生效（会输出字节数字）——必须 Buffer 化
      const tailChunks = []; let tailBytes = 0;
      const trimTail = () => { if (tailBytes > 8192) { const merged = Buffer.concat(tailChunks).subarray(-4096); tailChunks.length = 0; tailChunks.push(merged); tailBytes = merged.length; } };
      for await (const chunk of upstream.body) {
        if (body.stream === true) armTimer(); // 流式闲置超时：有数据流动就续命
        if (!res.write(chunk)) await new Promise((resolve) => res.once('drain', resolve));
        tailChunks.push(Buffer.from(chunk)); tailBytes += chunk.length; trimTail();
      }
      const sseTail = Buffer.concat(tailChunks).toString('utf8');
      if (isStream && !usage) usage = extractUsage('text/event-stream', sseTail);
      // v0.5.4 修四审 P1：流式成功不再在上游迭代完成时立即落账（原实现 markOutcome(true) 在
      // res.end() 前——只证明上游完整，不证明客户端收完尾部数据）。改为 res.end() 回调后落账。
      // 时序陷阱（首轮实现踩中）：undici 客户端收完 body 会立即关连接，close 事件可抢在
      // end 回调之前到达——若此刻守卫未激活（guardActive=false），成功流被误记 client_disconnected。
      // 因此发起 end() 前先激活守卫并标记 delivered：close 与 end 回调谁先到都只落一次账
      // （outcomeSettled 闸互斥；writableFinished 区分「收完才关」与「没收完就断」）。
      delivery.usage = usage;
      delivery.log = { entry: logEntry, outcome: usage ? { ...logOutcome, usage, actualCostYuan: usage.prompt != null && usage.completion != null ? computeActualCostFromUsage(usage, selectedConfig) : logOutcome.actualCostYuan } : logOutcome };
      delivery.delivered = true;
      delivery.guardActive = true;
      const streamDone = new Promise((resolve) => res.end(() => resolve()));
      await streamDone;
      markOutcome(true);
      settleWithUsage(usage);
      // v0.6.1 五审 P1：改走请求级幂等闸（原直接 decisionLog.write——close 守卫若先到已写一条，
      // 此处再写即双写；200 条实测 9 个重复 requestId 全部为流式）
      writeOutcomeLog({ ...logOutcome, usage, actualCostYuan: usage && usage.prompt != null && usage.completion != null ? computeActualCostFromUsage(usage, selectedConfig) : logOutcome.actualCostYuan });
      // 流式尾块拿到 usage 后补算实际成本并更新 token 计数器
      if (usage && selectedConfig?.pricingYuanPerMillionTokens && usage.prompt != null && usage.completion != null) {
        const actual = computeActualCostFromUsage(usage, selectedConfig);
        if (actual != null) { counters.tokens ??= {}; counters.tokens.prompt = (counters.tokens.prompt || 0) + usage.prompt; counters.tokens.completion = (counters.tokens.completion || 0) + usage.completion; }
      }
      clearTimeout(timer); return;
    } catch (error) {
      lastError = error;
      delivery.guardActive = false; // 本 attempt 已死，close 守卫不再按交付状态落账（防旧 attempt 污染下一 attempt）
      if (clientGone && !res.headersSent) { settleAttempt(null, false); outcomeSettled = true; clearTimeout(timer); return; } // 客户端已断：不再 fallback，直接结束（错误已无法送达）
      if (res.headersSent) {
        // mid-flight 中断（流式断流/非流式写回失败）：单次失败落账 + 预算保留估算
        // （v0.5.2：markOutcome/settleAttempt 声明在 try 外，此处可见——原实现引用 try 内 const 抛 ReferenceError）
        // v0.6.1 五审 P1：补决策日志（原实现只记 metrics 不落日志——与双写同属「每请求恰一条」缺口）
        markOutcome(false, error);
        settleAttempt(null, false);
        writeOutcomeLog({ ok: false, model, error: String(error.message || error).slice(0, 500), latencyMs: Date.now() - started, fallbackAttempt: i });
        clearTimeout(timer); res.destroy(error); return;
      }
      // attempt 前段失败（尚未发送响应头）：预算结算 + 健康降权，请求级错误由循环外 counters.errors 统一记
      settleAttempt(null, false);
      outcomeSettled = true; // 该 attempt 已死，防后续误落成功账
      updateHealth(model, false, Date.now() - started);
      if (error.retryable !== false && i + 1 < attempts.length) { counters.fallback += 1; continue; }
      break;
    }
  }
  clearTimeout(timer);
  counters.errors += 1;
  counters.outcome[auto ? 'auto' : 'explicit'].error += 1;
  const failure = { at: new Date().toISOString(), requested: decision.requestedModel, selected: attempts.at(-1), suggested: decision.suggestedModel, task: decision.analysis.task, reasoningLevel: decision.reasoningLevel, reasoningApplied: false, keyFingerprint: keyFingerprint(req.headers.authorization), ok: false, error: lastError?.message };
  record(failure);
  // v0.6.1 五审 P1：走请求级幂等闸（防 attempt 前段 close 守卫已写过失败日志后这里再写一条）
  writeOutcomeLog({ ok: false, model: attempts.at(-1), error: (lastError?.message || '').slice(0, 500) });
  return errorJson(res, 502, lastError?.message || '所有候选模型均调用失败', 'upstream_error');
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
async function staticFile(pathname, res) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const safe = normalize(relative).replace(/^(\.\.[/\\])+/, '');
  const file = join(projectRoot, 'public', safe);
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' }); res.end(body); return true;
  } catch { return false; }
}

const server = http.createServer(async (req, res) => {
  const requestId = req.headers['x-request-id'] || randomUUID();
  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  // CORS 收紧：仅同源（管理页自身）放行。旧值 '*' 允许任意网页跨域调用管理 API——
  // 本机绑定+未设 ADMIN_TOKEN 时，浏览器里任意恶意页面可静默读写配置（CSRF/驱动式攻击）。
  const origin = req.headers.origin;
  if (origin) {
    const host = req.headers.host;
    const sameOrigin = !host || new URL(origin).host === host;
    if (!sameOrigin) {
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      return errorJson(res, 403, '跨域请求被拒绝（管理端仅允许同源访问）', 'cors_forbidden');
    }
  }
  if (req.method === 'OPTIONS') { res.setHeader('access-control-allow-headers', 'authorization,content-type,x-session-id,x-request-id'); res.writeHead(204); return res.end(); }
  if (req.method === 'GET' && url.pathname === '/metrics') {
    // Prometheus 抓取端点：默认要求 METRICS_TOKEN（未设置时仅本机绑定可用——见下方 host 判断）
    if (process.env.METRICS_TOKEN && !safeEqual(req.headers.authorization, `Bearer ${process.env.METRICS_TOKEN}`)) {
      // 鉴权失败限速（与 admin 同一个更严的桶）：防 metrics token 暴力破解
      const verdict = adminAuthLimiter.check('admin-auth-fail:' + (req.socket.remoteAddress || 'unknown'));
      if (!verdict.allowed) return json(res, 429, { error: { message: '鉴权失败次数过多，请稍后再试', type: 'rate_limit_exceeded', code: 429 } }, { 'retry-after': String(Math.ceil(verdict.retryAfterMs / 1000)) });
      return errorJson(res, 401, 'Metrics Token 无效', 'authentication_error');
    }
    const disk = await decisionLog.diskUsage();
    const body = renderPrometheusMetrics({ counters, health, budget: budgetTracker.snapshot(), decisionLog: { ...decisionLog.snapshot(), diskUsage: disk }, config, sessions: sessions.size, draining: shutdownManager.draining, inflight: shutdownManager.inflightCount() });
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
    return res.end(body);
  }
  if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { status: shutdownManager.draining ? 'draining' : 'ok', configVersion: config.version, upstreamConfigured: Boolean(process.env.UPSTREAM_API_KEY || process.env.MAAS_API_KEY), upstreamMode: process.env.UPSTREAM_BASE_URL ? 'gateway' : 'direct_maas', uptimeSeconds: Math.round(process.uptime()), inflight: shutdownManager.inflightCount() });
  if (req.method === 'GET' && url.pathname === '/health/ready') {
    const probe = await probeUpstream();
    const ready = probe.reachable && !shutdownManager.draining;
    return json(res, ready ? 200 : 503, { ready, status: ready ? 'ready' : 'not_ready', upstreamReachable: probe.reachable, upstreamStatus: probe.status ?? null, upstreamError: probe.error ?? null, configVersion: config.version, checkedAt: new Date().toISOString() });
  }
  if (req.method === 'GET' && url.pathname === '/v1/models') return json(res, 200, { object: 'list', data: [{ id: 'auto', object: 'model', owned_by: 'router' }, ...config.models.filter((m) => m.enabled).map((m) => ({ id: m.id, object: 'model', owned_by: m.ownership }))] });
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') return proxyCompletion(req, res);
  if (url.pathname.startsWith('/admin/api/') && !authorized(req, 'ADMIN_TOKEN')) {
    // 鉴权失败也限流（独立更严的桶）：否则 ADMIN_TOKEN 可被无限暴力破解
    const failKey = 'admin-auth-fail:' + (req.socket.remoteAddress || 'unknown');
    const verdict = adminAuthLimiter.check(failKey);
    if (!verdict.allowed) return json(res, 429, { error: { message: '鉴权失败次数过多，请稍后再试', type: 'rate_limit_exceeded', code: 429 } }, { 'retry-after': String(Math.ceil(verdict.retryAfterMs / 1000)) });
    return errorJson(res, 401, 'Admin Token 无效', 'authentication_error');
  }
  if (req.method === 'GET' && url.pathname === '/admin/api/config') return json(res, 200, config);
  // 模型数据模板下载 + 上传导入：benchmark 榜单分 / evalGate 实测 / 小类实测 三层数据
  if (req.method === 'GET' && url.pathname === '/admin/api/model-data/template') {
    return json(res, 200, {
      note: '模型能力数据导入模板。填 benchmarkScores 段后上传；subtasks/evalGate 可选填，留空则保留现值。models 数组每项只需 id + 要更新的字段。',
      models: [
        {
          id: '模型ID（必填，须与模型管理中的模型 ID 一致）',
          benchmarkScores: {
            scores: { gpqa_diamond: 0.881, swe_bench: 0.526, livecodebench: 0.804 },
            scoresMeta: { source: '官方榜单名称/链接', at: '2026-08-21' },
            evalGate: { default: 0.92, simple: 0.97, coding: 0.88, reasoning: 0.919, creative: 0.881, extraction: 0.85, total: 0.89 },
            subtasks: { 'code-generation': { avg: 0.79, n: 8 }, debugging: { avg: 0.84, n: 8 } }
          }
        }
      ]
    });
  }
  // Excel 模板（CSV with BOM，Excel 双击打开不乱码）：一行一模型，分数列即 benchmarkScores.scores
  if (req.method === 'GET' && url.pathname === '/admin/api/model-data/template-xlsx') {
    const esc = (v) => /[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? '');
    const header = ['模型ID(必填)', '榜单名/来源', '录入日期', 'gpqa_diamond', 'swe_bench', 'livecodebench', 'evalGate-total', 'evalGate-default', 'evalGate-coding', 'evalGate-reasoning', 'evalGate-creative', 'evalGate-extraction', 'evalGate-simple'];
    const rows = [header];
    for (const m of config.models) {
      const bs = m.benchmarkScores || {};
      const s = bs.scores || {}; const g = bs.evalGate || {};
      rows.push([m.id, bs.scoresMeta?.source || '', bs.scoresMeta?.at || '', s.gpqa_diamond ?? '', s.swe_bench ?? '', s.livecodebench ?? '', g.total ?? '', g.default ?? '', g.coding ?? '', g.reasoning ?? '', g.creative ?? '', g.extraction ?? '', g.simple ?? '']);
    }
    const csv = '\uFEFF' + rows.map((r) => r.map(esc).join(',')).join('\r\n');
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="model-data-template.csv"' });
    return res.end(csv);
  }
  // CSV 导入：与 JSON 导入同一合并语义（模板下载 → Excel 编辑 → 上传回来）
  if (req.method === 'POST' && url.pathname === '/admin/api/model-data/import-xlsx') {
    try {
      const raw = (await readRawBody(req)).toString('utf-8').replace(/^\uFEFF/, '');
      const lines = raw.split(/\r?\n/).filter((l) => l.trim());
      if (lines.length < 2) return errorJson(res, 400, 'CSV 至少需要表头+一行数据', 'invalid_request_error');
      const parseLine = (line) => {
        const cells = []; let cur = ''; let inQ = false;
        for (let i = 0; i < line.length; i++) {
          const ch = line[i];
          if (inQ) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') inQ = false; else cur += ch; }
          else if (ch === '"') inQ = true;
          else if (ch === ',') { cells.push(cur); cur = ''; } else cur += ch;
        }
        cells.push(cur);
        return cells.map((c) => c.trim());
      };
      const header = parseLine(lines[0]);
      const applied = []; const skipped = [];
      const col = (name) => header.findIndex((h) => h.includes(name));
      for (const line of lines.slice(1)) {
        const cells = parseLine(line);
        const id = cells[0];
        if (!id) continue;
        const target = config.models.find((m) => m.id === id);
        if (!target) { skipped.push(`${id} 不存在`); continue; }
        const num = (i) => { const v = Number(cells[i]); return cells[i] !== '' && Number.isFinite(v) ? v : null; };
        const bs = target.benchmarkScores ||= {};
        const scores = {}; let hasScore = false;
        for (const k of ['gpqa_diamond', 'swe_bench', 'livecodebench']) { const i = col(k); if (i >= 0) { const v = num(i); if (v != null) { scores[k] = v; hasScore = true; } } }
        if (hasScore) Object.assign(bs.scores ||= {}, scores);
        const gate = {}; let hasGate = false;
        for (const k of ['total', 'default', 'coding', 'reasoning', 'creative', 'extraction', 'simple']) { const i = col('evalGate-' + k); if (i >= 0) { const v = num(i); if (v != null) { gate[k] = v; hasGate = true; } } }
        if (hasGate) Object.assign(bs.evalGate ||= {}, gate);
        const src = cells[col('榜单名')] || '';
        if (src) { bs.scoresMeta ||= {}; bs.scoresMeta.source = src; bs.scoresMeta.at = cells[col('录入日期')] || new Date().toISOString().slice(0, 10); }
        else { bs.scoresMeta ||= {}; bs.scoresMeta.at = new Date().toISOString().slice(0, 10); }
        bs.updatedAt = new Date().toISOString().slice(0, 10);
        applied.push(id);
      }
      if (!applied.length) return errorJson(res, 400, `全部 ${skipped.length} 条被跳过：${skipped.join('；')}`, 'invalid_request_error');
      config = await saveConfig(config);
      return json(res, 200, { ok: true, applied, skipped, format: 'csv' });
    } catch (error) { return errorJson(res, 400, error.message, 'invalid_request_error'); }
  }
  if (req.method === 'POST' && url.pathname === '/admin/api/model-data/import') {
    try {
      const body = await readJson(req);
      const incoming = Array.isArray(body?.models) ? body.models : null;
      if (!incoming || !incoming.length) return errorJson(res, 400, '导入文件需含 models 数组（见模板）', 'invalid_request_error');
      const applied = []; const skipped = [];
      for (const item of incoming) {
        if (!item?.id || typeof item.id !== 'string') { skipped.push(`${JSON.stringify(item?.id)} 缺有效 id`); continue; }
        const target = config.models.find((m) => m.id === item.id);
        if (!target) { skipped.push(`${item.id} 不存在`); continue; }
        const bs = item.benchmarkScores;
        if (!bs || typeof bs !== 'object') { skipped.push(`${item.id} 缺 benchmarkScores`); continue; }
        const cur = target.benchmarkScores ||= {};
        // 合并语义：浅合并各层；值为 null 表示删除该键（用于修正录错的数据）
        const mergeLayer = (layer, incoming) => {
          if (!incoming || typeof incoming !== 'object') return;
          const dst = cur[layer] ||= {};
          for (const [k, v] of Object.entries(incoming)) {
            if (v === null) delete dst[k]; else dst[k] = v;
          }
        };
        mergeLayer('scores', bs.scores);
        mergeLayer('scoresMeta', bs.scoresMeta);
        mergeLayer('evalGate', bs.evalGate);
        mergeLayer('subtasks', bs.subtasks);
        mergeLayer('subtasksMeta', bs.subtasksMeta);
        if (bs.source) cur.source = String(bs.source);
        cur.updatedAt = new Date().toISOString().slice(0, 10);
        applied.push(item.id);
      }
      if (!applied.length) return errorJson(res, 400, `全部 ${skipped.length} 条被跳过：${skipped.join('；')}`, 'invalid_request_error');
      config = await saveConfig(config);
      return json(res, 200, { ok: true, applied, skipped });
    } catch (error) { return errorJson(res, 400, error.message, 'invalid_request_error'); }
  }
  if (req.method === 'PUT' && url.pathname === '/admin/api/config') {
    try { config = await saveConfig(await readJson(req)); budgetTracker.updateConfig(config); decisionLog.updateConfig(config); return json(res, 200, config); }
    catch (error) { return errorJson(res, 400, error.message, 'invalid_config'); }
  }
  if (req.method === 'POST' && url.pathname === '/admin/api/preview') {
    try { return json(res, 200, await resolveAutoDecision(await readJson(req), { preview: true })); }
    catch (error) { return errorJson(res, 400, error.message); }
  }
  if (req.method === 'POST' && url.pathname === '/admin/api/simulate') {
    try {
      const body = await readJson(req);
      const proposedConfig = validateConfig(body.proposedConfig);
      const current = simulatePolicy(config);
      const proposed = simulatePolicy(proposedConfig);
      const changed = proposed.rows.filter((row, index) => row.model !== current.rows[index].model).length;
      return json(res, 200, { sampleCount: SIMULATION_SAMPLES.length, changed, changedRate: Number((changed / SIMULATION_SAMPLES.length).toFixed(3)), current, proposed, sensitivity: simulateSensitivity(proposedConfig) });
    } catch (error) { return errorJson(res, 400, error.message, 'invalid_simulation'); }
  }
  if (req.method === 'POST' && url.pathname === '/admin/api/feedback') {
    // 显式质量反馈（飞轮）：requestId 关联决策日志，rating ∈ good|bad。业务方可选接入。
    try {
      const body = await readJson(req);
      const result = feedbackLog.write({ requestId: body.requestId, rating: body.rating, comment: body.comment, source: body.source });
      if (!result.ok) return errorJson(res, 400, result.error, 'invalid_feedback');
      return json(res, 200, { ok: true });
    } catch (error) { return errorJson(res, 400, error.message, 'invalid_feedback'); }
  }
  // 任务分类体系（参考 OpenRouter 大类+小类）：路由层仍是 5 任务（打分键），展示层归大类。
// 任务分类体系（对齐 OpenRouter rankings 的 category/subcategory 两级语义）：
// 5 大类 = 路由打分层（quality 有实测跑分支撑）；小类 = 展示层细分（正则线索，不影响打分）
const TASK_CATEGORIES = {
  // 路由打分层 5 族 + agent（quality 跑分支撑），仅用于打分回退，不决定展示大类
  default:    { subs: ['qa-knowledge', 'conversation', 'customer-support', 'finance-trading', 'security-audit', 'summarization', 'translation', 'other'] },
  coding:     { subs: ['code-generation', 'debugging', 'code-review', 'sql-database', 'frontend-ui', 'devops-config', 'shell-execution', 'file-io', 'repo-scanning'] },
  reasoning:  { subs: ['multi-step-planning', 'research-reports', 'math', 'security-audit', 'finance-trading', 'customer-support', 'summarization', 'translation'] },
  creative:   { subs: ['content-writing', 'roleplay-fiction'] },
  extraction: { subs: ['data-extraction', 'data-transformation', 'classification', 'summarization', 'translation', 'math'] },
  agent:      { subs: ['multi-step-planning', 'tool-dispatch', 'workflow-execution', 'web-search', 'memory-extraction', 'devops'] },
  explicit:   { subs: [] },
  unknown:    { subs: [] }
};

// OpenRouter rankings TASK TYPE 官方 30 小类 → 4 大类（+Pinned 内网特有）
const SUB_CATEGORY = {
  // CODE（9）
  'code-generation': { category: '代码', en: 'CODE', icon: '⚙️', label: '代码生成' },
  debugging: { category: '代码', en: 'CODE', icon: '⚙️', label: '调试' },
  'code-review': { category: '代码', en: 'CODE', icon: '⚙️', label: '代码审查' },
  'sql-database': { category: '代码', en: 'CODE', icon: '⚙️', label: 'SQL 与数据库' },
  'frontend-ui': { category: '代码', en: 'CODE', icon: '⚙️', label: '前端与 UI' },
  'devops-config': { category: '代码', en: 'CODE', icon: '⚙️', label: 'DevOps 与配置' },
  'shell-execution': { category: '代码', en: 'CODE', icon: '⚙️', label: 'Shell 执行' },
  'file-io': { category: '代码', en: 'CODE', icon: '⚙️', label: '文件读写' },
  'repo-scanning': { category: '代码', en: 'CODE', icon: '⚙️', label: '仓库扫描' },
  // AGENTS（6）
  'multi-step-planning': { category: '智能体', en: 'AGENTS', icon: '🤖', label: '多步规划' },
  'tool-dispatch': { category: '智能体', en: 'AGENTS', icon: '🤖', label: '工具调度' },
  'workflow-execution': { category: '智能体', en: 'AGENTS', icon: '🤖', label: '工作流执行' },
  'web-search': { category: '智能体', en: 'AGENTS', icon: '🤖', label: 'Web 搜索' },
  'memory-extraction': { category: '智能体', en: 'AGENTS', icon: '🤖', label: '记忆提取' },
  devops: { category: '智能体', en: 'AGENTS', icon: '🤖', label: 'DevOps' },
  // DATA（6）
  'data-extraction': { category: '数据', en: 'DATA', icon: '📋', label: '数据抽取' },
  'data-transformation': { category: '数据', en: 'DATA', icon: '📋', label: '数据转换' },
  classification: { category: '数据', en: 'DATA', icon: '📋', label: '分类' },
  summarization: { category: '数据', en: 'DATA', icon: '📋', label: '摘要' },
  translation: { category: '数据', en: 'DATA', icon: '📋', label: '翻译' },
  math: { category: '数据', en: 'DATA', icon: '📋', label: '数学' },
  // WRITING & CHAT（9）
  'content-writing': { category: '写作与对话', en: 'WRITING & CHAT', icon: '💬', label: '内容写作' },
  'research-reports': { category: '写作与对话', en: 'WRITING & CHAT', icon: '💬', label: '研究与报告' },
  'qa-knowledge': { category: '写作与对话', en: 'WRITING & CHAT', icon: '💬', label: '问答与知识' },
  conversation: { category: '写作与对话', en: 'WRITING & CHAT', icon: '💬', label: '对话' },
  'customer-support': { category: '写作与对话', en: 'WRITING & CHAT', icon: '💬', label: '客户支持' },
  'roleplay-fiction': { category: '写作与对话', en: 'WRITING & CHAT', icon: '💬', label: '角色扮演与虚构' },
  'finance-trading': { category: '写作与对话', en: 'WRITING & CHAT', icon: '💬', label: '金融与交易' },
  'security-audit': { category: '写作与对话', en: 'WRITING & CHAT', icon: '💬', label: '安全审计' },
  other: { category: '写作与对话', en: 'WRITING & CHAT', icon: '💬', label: '其他' },
  // 内网特有：点名模型
  pinned: { category: '指定模型', en: 'PINNED', icon: '📌', label: '用户点名' }
};

function subCategoryOf(task, subTask) {
  if (task === 'explicit') return SUB_CATEGORY.pinned;
  if (SUB_CATEGORY[subTask]) return SUB_CATEGORY[subTask];
  // 路由族兜底小类（未命中线索时）
  const fallback = { default: 'qa-knowledge', coding: 'code-generation', reasoning: 'research-reports', creative: 'content-writing', extraction: 'data-extraction', agent: 'workflow-execution' }[task];
  return SUB_CATEGORY[fallback] || SUB_CATEGORY.other;
}

// 任务榜单（OpenRouter「task-spend rankings」内网版）：按任务类型聚合决策日志，
  // 每类任务展示首选模型+使用份额+满意度——「大家把流量花在了哪」一目了然。
  // 路由体检报表：见 buildRoutingReport()
  if (req.method === 'GET' && url.pathname === '/admin/api/routing-report') {
    return json(res, 200, buildRoutingReport());
  }
  // 市场信号状态：各任务的信号覆盖（激活/休眠）与每模型的份额/调整值——飞轮健康度一览
  if (req.method === 'GET' && url.pathname === '/admin/api/market-signal') {
    marketSignal.rebuild().catch(() => {});
    return json(res, 200, { status: marketSignal.status(), signals: marketSignal.signals });
  }
  // 小模型端点连通测试：对配置的 http-json 端点发一条真实探测请求，验证「地址通/协议对/返回合法」
  if (req.method === 'POST' && url.pathname === '/admin/api/semantic/probe') {
    // url_ 提升到 try 外：catch 里也要回显目标地址（块级作用域会让 catch 读不到 try 内的 const）
    let url_ = '';
    try {
      const body = await readJson(req);
      // 不传 url 时探测当前生效端点（env SEMANTIC_CLASSIFIER_URL > config）；传了则探测指定地址（改地址后先验再存）
      const config = await loadConfig();
      const effective = process.env.SEMANTIC_CLASSIFIER_URL || config.semanticRouter?.httpJson?.url || '';
      url_ = String(body.url || effective).trim();
      if (!/^https?:\/\//.test(url_)) return errorJson(res, 400, '端点地址必须以 http:// 或 https:// 开头', 'bad_url');
      const started = Date.now();
      const probeBody = { text: '把"商品破损申请退款"分类为售前、售后或咨询，只返回标签。' };
      const response = await fetch(url_, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(probeBody),
        signal: AbortSignal.timeout(8000)
      }).catch((e) => { throw Object.assign(e, { stage: 'network' }); });
      const text = await response.text();
      const latencyMs = Date.now() - started;
      if (!response.ok) return json(res, 200, { ok: false, stage: 'http', latencyMs, httpStatus: response.status, message: `HTTP ${response.status}：${text.slice(0, 200)}` });
      let parsed;
      try { parsed = JSON.parse(text); } catch { return json(res, 200, { ok: false, stage: 'json', latencyMs, httpStatus: response.status, message: `返回不是 JSON：${text.slice(0, 200)}` }); }
      const missing = ['task', 'tier', 'complexity', 'confidence'].filter((k) => !(k in parsed));
      if (missing.length) return json(res, 200, { ok: false, stage: 'schema', latencyMs, httpStatus: response.status, message: `缺少字段：${missing.join('、')}（要求 {task,tier,complexity,confidence,reason}）`, sample: text.slice(0, 200) });
      return json(res, 200, { ok: true, stage: 'ok', latencyMs, httpStatus: 200, probedUrl: url_, assessment: parsed });
    } catch (error) {
      const timeout = String(error).includes('Timeout') || String(error).includes('abort');
      return json(res, 200, { ok: false, stage: timeout ? 'timeout' : 'network', probedUrl: url_, message: timeout ? '8 秒内无响应（连接超时）' : `网络不通：${error.message}` });
    }
  }
  if (req.method === 'GET' && url.pathname === '/admin/api/task-board') {
    const recent = await decisionLog.recent(2000).catch(() => []);
    const byTask = {};
    for (const entry of recent) {
      const task = entry?.decision?.analysis?.task || 'unknown';
      const subTask = entry?.decision?.analysis?.subTask || '';
      const model = entry?.decision?.selectedModel || entry?.decision?.suggestedModel;
      if (!model) continue;
      const cat = TASK_CATEGORIES[task] || TASK_CATEGORIES.unknown;
      const sub = cat.subs[subTask] || cat.defaultSub;
      const key = task + '/' + sub;
      const slot = byTask[key] ||= { task, sub, total: 0, models: {}, fails: {} };
      slot.total += 1;
      slot.models[model] = (slot.models[model] || 0) + 1;
      if (entry?.outcome?.ok === false) slot.fails[model] = (slot.fails[model] || 0) + 1;
    }
    const board = Object.values(byTask).map((slot) => {
      const sc = subCategoryOf(slot.task, slot.sub);
      return {
      task: slot.task,
      sub: slot.sub,
      subLabel: sc.label,
      category: sc.category,
      categoryEn: sc.en,
      categoryIcon: sc.icon,
      total: slot.total,
      picks: Object.entries(slot.models)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([model, count]) => ({ model, share: Number(((count / slot.total) * 100).toFixed(1)), fails: slot.fails[model] || 0 }))
    }}).sort((a, b) => b.total - a.total);
    return json(res, 200, { window: 'recent 2000 decisions', board });
  }
  if (req.method === 'GET' && url.pathname === '/admin/api/metrics') {
    const visibleRecent = recentKeyFilter ? recent.filter((x) => (x.keyFingerprint || '') === recentKeyFilter) : recent;
    return json(res, 200, { counters, health, recent: visibleRecent, semanticReviews, budget: budgetTracker.snapshot(), decisionLog: decisionLog.snapshot(), feedback: feedbackLog.snapshot(), sessions: sessions.size });
  }
  // 分类器标准评测：spawn Python 脚本跑 heldout 集，输出三方（gold/小模型/规则层）准确率与混淆矩阵。
  // 回答"换分类器后准了多少"——换端点前后各点一次即可对比。评测只读模型文件，不影响线上。
  if (req.method === 'POST' && url.pathname === '/admin/api/classifier/evaluate') {
    const script = join(projectRoot, 'scripts', 'evaluate_classifier.py');
    const pythonCmd = await resolveClassifierPython(); // v0.5.2：探活优先级 CLASSIFIER_PYTHON > .venv(探活) > python
    if (!pythonCmd) return errorJson(res, 500, '找不到可用的 Python（检查 CLASSIFIER_PYTHON 环境变量或安装 python）', 'classifier_eval_error');
    const child = spawn(pythonCmd, [script, ...(url.searchParams.get('dump') === '1' ? ['--dump'] : [])], { cwd: projectRoot, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), 120000);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (error) => { clearTimeout(timer); return errorJson(res, 500, `评测脚本启动失败: ${error.message}（检查 CLASSIFIER_PYTHON 环境变量）`, 'classifier_eval_error'); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return errorJson(res, 500, `评测脚本退出码 ${code}: ${stderr.slice(0, 500)}`, 'classifier_eval_error');
      try { return json(res, 200, JSON.parse(stdout)); }
      catch { return errorJson(res, 500, `评测输出不是合法 JSON: ${stdout.slice(0, 300)}`, 'classifier_eval_error'); }
    });
    return undefined;
  }
  // 切换影响预估：heldout 全量回放。Python dump 逐条小模型预测（gold/clf/rule + confidence/tier/complexity），
  // Node 侧用真实 routeRequest 对比三种决策链：rules-only（现状 shadow）、partial-active（新）、full-active。
  // 输出：任务判准率、模型分布变化、成本指数与质量变化、误判方向分解（漏判难任务=质量风险 / 多判难任务=成本浪费）。
  if (req.method === 'POST' && url.pathname === '/admin/api/classifier/replay') {
    const script = join(projectRoot, 'scripts', 'evaluate_classifier.py');
    const pythonCmd = await resolveClassifierPython(); // v0.5.2：同 evaluate 探活优先级
    if (!pythonCmd) return errorJson(res, 500, '找不到可用的 Python（检查 CLASSIFIER_PYTHON 环境变量或安装 python）', 'classifier_replay_error');
    const child = spawn(pythonCmd, [script, '--dump'], { cwd: projectRoot, windowsHide: true });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => child.kill(), 120000);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (error) => { clearTimeout(timer); return errorJson(res, 500, `回放脚本启动失败: ${error.message}`, 'replay_error'); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return errorJson(res, 500, `回放脚本退出码 ${code}: ${stderr.slice(0, 500)}`, 'replay_error');
      let dump;
      try { dump = JSON.parse(stdout); } catch { return errorJson(res, 500, `回放输出不是合法 JSON: ${stdout.slice(0, 300)}`, 'replay_error'); }
      try { return json(res, 200, replayHeldout(dump, config)); } catch (error) { return errorJson(res, 500, `回放计算失败: ${error.message}`, 'replay_error'); }
    });
    return undefined;
  }
  if (req.method === 'GET' && url.pathname === '/admin/api/decisions') {
    try {
      const count = Math.max(1, Math.min(2000, Number(url.searchParams.get('count') || 200)));
      const includeFullText = url.searchParams.get('fullText') === '1';
      const keyFilter = url.searchParams.get('key'); // key 指纹筛选（8 位十六进制）
      const rows = await decisionLog.recent(count, { includeFullText, keyFingerprint: keyFilter });
      return json(res, 200, { count: rows.length, decisions: rows });
    } catch (error) { return errorJson(res, 500, error.message, 'decision_log_error'); }
  }
  // key 指纹筛选开关（最近请求面板 v0.4.27）：null=全部；8 位十六进制=只看该 key
  if (req.method === 'POST' && url.pathname === '/admin/api/recent-key-filter') {
    try {
      const { key } = await readJson(req);
      if (key !== null && key !== undefined && key !== '') {
        const raw = String(key).toLowerCase();
        if (!/^[0-9a-f]{8}$/.test(raw)) return errorJson(res, 400, 'key 指纹须为 8 位十六进制（0-9/a-f）', 'invalid_key');
        setRecentKeyFilter(raw);
        return json(res, 200, { ok: true, keyFingerprint: raw });
      }
      setRecentKeyFilter(null);
      return json(res, 200, { ok: true, keyFingerprint: null });
    } catch (error) { return errorJson(res, 400, error.message, 'invalid_body'); }
  }
  if (req.method === 'POST' && url.pathname === '/admin/api/reload') {
    try { config = await loadConfig(); budgetTracker.updateConfig(config); decisionLog.updateConfig(config); return json(res, 200, { ok: true, version: config.version }); }
    catch (error) { return errorJson(res, 400, error.message, 'invalid_config'); }
  }
  if (url.pathname === '/manual') {
    // 使用手册页：服务端把 docs/使用说明.md 预渲染成 HTML 注入模板（客户端 JS 只做目录/高亮，失败也可见）
    try {
      const md = await readFile(join(projectRoot, 'docs', '使用说明.md'), 'utf8');
      const tpl = await readFile(join(projectRoot, 'public', 'manual.html'), 'utf8');
      // markdown → HTML：给 h2/h3 加 id 便于 TOC 锚点（id 由标题文本生成，双语稳定）
      let seq = 0;
      const body = renderMarkdown(md).replace(/<(h[23])>([^<]+)<\/h[23]>/g, (_, t, txt) => {
        const id = 'sec-' + txt.replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 40) + '-' + (seq++);
        return '<' + t + ' id="' + id + '">' + txt + '</' + t + '>';
      });
      const html = tpl
        .replace('__MANUAL_VERSION__', () => String(config.version).replace(/[^0-9a-zA-Z.\-]/g, ''))
        .replace('__MANUAL_BODY__', () => body);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    } catch { return errorJson(res, 404, '手册不存在', 'not_found'); }
  }
  if (req.method === 'GET' && await staticFile(url.pathname, res)) return;
  return errorJson(res, 404, 'Not Found', 'not_found');
});

// 优雅关停管理器：在 listen 之前创建（需要 server 实例监听 request 事件）
const shutdownManager = createShutdownManager({
  server,
  timeoutMs: Number(process.env.SHUTDOWN_TIMEOUT_MS || 20000),
  flush: async () => {
    // 等待决策日志写链与预算账本落盘完成，避免最后几条记录丢失
    await Promise.allSettled([decisionLog.writeChain, budgetTracker.pendingWrite]);
  },
});
installCrashHandlers(logger);
process.on('SIGINT', () => shutdownManager.shutdown('SIGINT'));
process.on('SIGTERM', () => shutdownManager.shutdown('SIGTERM'));

server.listen(port, host, () => {
  server.keepAliveTimeout = serverKeepAliveMs;
  server.headersTimeout = serverHeadersTimeoutMs;
  logger.info('server_started', { host, port, keepAliveMs: serverKeepAliveMs, headersTimeoutMs: serverHeadersTimeoutMs, configVersion: config.version, upstreamConfigured: Boolean(process.env.UPSTREAM_API_KEY || process.env.MAAS_API_KEY), node: process.version });
});
