import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { extname, join, normalize } from 'node:path';
import { loadConfig, projectRoot, saveConfig, validateConfig } from './config.mjs';
import { analyzeRequest, mergeSemanticAssessment, routeRequest, paretoFrontier, oracleChoice, zeroRouterChoice } from './router.mjs';
import { resolveModelScope, scopeIntersectsConfig, scopeAllows, scopeCacheStats } from './model-scope.mjs';
import { classifySemantically, shouldUseSemanticRouter } from './semantic-router.mjs';
import { BudgetTracker, estimateCostYuan } from './budget.mjs';
import { FeedbackLog } from './feedback.mjs';
import { DecisionLog } from './decision-log.mjs';
import { logger } from './logger.mjs';
import { renderPrometheusMetrics } from './metrics.mjs';
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
const counters = { startedAt: new Date().toISOString(), total: 0, auto: 0, explicit: 0, success: 0, errors: 0, fallback: 0, selected: {}, selectedBy: {}, suggested: {}, task: {}, outcome: { auto: { success: 0, error: 0 }, explicit: { success: 0, error: 0 } }, semantic: { eligible: 0, attempted: 0, succeeded: 0, disagreed: 0, errors: 0, applied: 0 } };
const SIMULATION_SAMPLES = [
  { id: 'weekday', label: '直接事实', body: { messages: [{ role: 'user', content: '今天星期几？' }], max_tokens: 64 } },
  { id: 'classification', label: '工单分类', body: { messages: [{ role: 'user', content: '把“商品破损申请退款”分类为售前、售后或咨询，只返回标签。' }], max_tokens: 64 } },
  { id: 'extraction', label: '结构化抽取', body: { messages: [{ role: 'user', content: '抽取姓名和城市并严格输出 JSON：张晓明居住在广州。' }], response_format: { type: 'json_object' }, max_tokens: 256 } },
  { id: 'summary', label: '普通摘要', body: { messages: [{ role: 'user', content: '将一份800字会议纪要压缩为五条行动项，并标明负责人和截止时间。' }], max_tokens: 512 } },
  { id: 'coding', label: '代码分析', body: { messages: [{ role: 'user', content: '分析 Java 计数器 n++ 的并发安全问题，给出最小修复和单元测试。' }], max_tokens: 1024 } },
  { id: 'sql', label: 'SQL生成', body: { messages: [{ role: 'user', content: '编写 PostgreSQL 查询，统计最近30天每个用户的订单金额并按金额降序。' }], max_tokens: 512 } },
  { id: 'reasoning', label: '复杂推理', body: { messages: [{ role: 'user', content: '比较 Saga、TCC 和本地消息表三种分布式事务方案，从一致性、成本、复杂度和恢复能力给出取舍。' }], max_tokens: 4096 } },
  { id: 'architecture', label: '架构设计', body: { messages: [{ role: 'user', content: '设计一个每秒一万请求的幂等支付回调系统，说明去重、事务、重试、监控、成本和扩容方案。' }], max_tokens: 4096 } },
  { id: 'creative', label: '创意文案', body: { messages: [{ role: 'user', content: '为企业内部 AI 助手写三条简洁宣传语，每条不超过18字。' }], max_tokens: 512 } },
  { id: 'tools', label: '工具调用', body: { messages: [{ role: 'user', content: '查询订单状态并总结异常原因。' }], tools: [{ type: 'function', function: { name: 'get_order', parameters: { type: 'object' } } }], max_tokens: 512 } },
  { id: 'deep-consult', label: '深度咨询', body: { messages: [{ role: 'user', content: '我们是省级运营商，需要为全省 21 个地市的营业厅设计一套智能问答系统的落地方案。请完整回答以下问题：第一，系统架构如何分层，渠道侧、应用侧、模型侧、数据侧各自的职责边界是什么，如何避免重复建设；第二，模型选型上自建与采购如何权衡，涉及成本、数据安全、迭代速度、可控性四个维度，并给出量化依据；第三，知识库建设分几期，每期的目标、范围、验收标准和风险是什么；第四，全省推广的节奏怎么安排，试点、扩容、全面上线三个阶段的准入门槛和退出条件分别是什么；第五，运营保障体系怎么建，包括监控指标、告警阈值、值班响应、故障演练的具体要求。回答必须同时满足：给出明确结论、每条结论有依据、标注关键假设、控制总篇幅在两千字以内。' }], max_tokens: 8192 } },
  { id: 'code-refactor', label: '代码重构', body: { messages: [{ role: 'user', content: '我们有一个 30 万行的 Java 单体系统，交易核心模块每到大促就出现数据库连接池耗尽和慢 SQL 告警。请做一次完整的重构设计：1）先用三段论分析根因，区分架构问题、代码问题和容量问题，并说明验证方法；2）给出目标架构，要求读写分离、热点数据本地缓存、异步削峰，同时保证分布式事务一致性，说明每种一致性方案（强一致、最终一致、补偿）的适用场景和代价；3）制定分步迁移计划，每一步要可回滚，给出灰度策略和观察指标；4）列出迁移过程中的十大风险及对应预案；5）给出容量估算模型：假设峰值 QPS 从当前 2000 涨到 12000，按读写比 8:2、缓存命中率 90% 目标推演数据库、缓存、应用层的扩容需求。要求所有结论标注置信度。' }], max_tokens: 8192 } }
];

if (!['127.0.0.1', 'localhost', '::1'].includes(host) && (!process.env.ADMIN_TOKEN || !process.env.ROUTER_ACCESS_KEY)) {
  throw new Error('绑定到非本机地址时必须同时设置 ADMIN_TOKEN 和 ROUTER_ACCESS_KEY');
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
  const limit = BODY_LIMITS[req.url ? new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname : ''] ?? DEFAULT_BODY_LIMIT;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error(`请求体超过 ${Math.round(limit / 1024)}KB 上限`);
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
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
}

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
    return { id: sample.id, label: sample.label, task: decision.analysis.task, complexity: decision.analysis.complexity, tier: decision.analysis.tier, model: decision.suggestedModel, quality: candidate?.quality || 0, costIndex: Number(candidate?.costIndex || 0), latencyIndex: Number(candidate?.latencyIndex || 0), costYuan: costYuan == null ? null : Number(costYuan), latencyMs, signals: decision.analysis.signals };
  });
  const distribution = {};
  for (const row of rows) distribution[row.model] = (distribution[row.model] || 0) + 1;
  const average = (field) => {
    const values = rows.map((row) => row[field]).filter((value) => value != null && Number.isFinite(Number(value)));
    if (!values.length) return null;
    return Number((values.reduce((sum, value) => sum + Number(value), 0) / values.length).toFixed(3));
  };
  const selfIds = new Set(policyConfig.models.filter((model) => model.ownership === 'self_hosted').map((model) => model.id));
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
  return { rows, distribution, averageQuality: average('quality'), averageCostIndex: average('costIndex'), averageLatencyIndex: average('latencyIndex'), averageCostYuan: average('costYuan'), averageLatencyMs: average('latencyMs'), selfHostedRate: Number((rows.filter((row) => selfIds.has(row.model)).length / rows.length).toFixed(3)), paretoFrontier: paretoFrontier(policyConfig.models).map((m) => m.id), baselines };
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
  modelConfig.calibrationStatus = 'verified';
  logger.info('model_calibrated', { model, samples: verdict.samples, failureRate: verdict.failureRate });
  saveConfig(config).then((next) => { config = next;
  if (marketSignal) { marketSignal.updateConfig(config); marketSignal.rebuild().catch(() => {}); } }).catch((error) => logger.warn('model_calibrated_save_failed', { model, error: error.message }));
}

function sessionModel(req, decision) {
  const id = req.headers['x-session-id'];
  if (!id) return decision.selectedModel;
  const current = sessions.get(id);
  if (current && current.expiresAt > Date.now() && decision.fallbackOrder.includes(current.model)) return current.model;
  sessions.set(id, { model: decision.selectedModel, expiresAt: Date.now() + config.routing.sessionStickinessTtlMs });
  return decision.selectedModel;
}

function upstreamRequestBody(body, model, reasoningLevel) {
  const payload = { ...body, model };
  const modelConfig = config.models.find((item) => item.id === model);
  if (config.reasoningControl?.enabled && modelConfig?.reasoningControl?.verified) {
    const parameter = modelConfig.reasoningControl.parameter || 'reasoning_effort';
    const values = modelConfig.reasoningControl.values || { off: 'low', standard: 'medium', high: 'high' };
    payload[parameter] = values[reasoningLevel] || values.standard;
  }
  return payload;
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
  if (!base || !key) {
    const result = { reachable: false, error: 'upstream_not_configured' };
    probeCache = { at: now, result };
    return result;
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

function semanticOptions() {
  return {
    baseUrl: process.env.UPSTREAM_BASE_URL || process.env.MAAS_BASE_URL || config.upstreamBaseUrl,
    apiKey: process.env.UPSTREAM_API_KEY || process.env.MAAS_API_KEY
  };
}

function recordSemanticReview(review) {
  semanticReviews.unshift(review);
  if (semanticReviews.length > 100) semanticReviews.length = 100;
}

function classifyAndCompare(body, baseAnalysis, baseDecision, { track = true } = {}) {
  if (track) counters.semantic.attempted += 1;
  return classifySemantically(body, config, semanticOptions()).then((assessment) => {
    if (track) counters.semantic.succeeded += 1;
    const semanticAnalysis = mergeSemanticAssessment(baseAnalysis, assessment, true);
    const proposed = routeRequest(body, config, { health, analysisOverride: semanticAnalysis, budgetPressure: budgetTracker.pressure(), trafficBucket: baseDecision.rollout.trafficBucket });
    const disagreed = assessment.tier !== baseAnalysis.tier || assessment.task !== baseAnalysis.task || proposed.suggestedModel !== baseDecision.suggestedModel;
    if (track && disagreed) counters.semantic.disagreed += 1;
    const review = { at: new Date().toISOString(), assessment, base: { task: baseAnalysis.task, tier: baseAnalysis.tier, complexity: baseAnalysis.complexity, model: baseDecision.suggestedModel }, proposed: { task: semanticAnalysis.task, tier: semanticAnalysis.tier, complexity: semanticAnalysis.complexity, model: proposed.suggestedModel }, disagreed };
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
    apiKey: process.env.UPSTREAM_API_KEY || process.env.MAAS_API_KEY,
    authorizationHeader: clientAuthHeader,
    passthrough: process.env.ROUTER_KEY_MODE === 'passthrough'
  });
  const scopeActive = scope && scopeIntersectsConfig(scope, config.models);
  if (scopeActive) runtime.allowedModelIds = scope;
  const baseDecision = routeRequest(body, config, runtime);
  if (!shouldUseSemanticRouter(baseAnalysis, body, config)) return baseDecision;
  if (!preview) counters.semantic.eligible += 1;
  if (config.semanticRouter.mode === 'shadow' && !preview) {
    classifyAndCompare(body, baseAnalysis, baseDecision).catch(() => {});
    return { ...baseDecision, semanticReview: { status: 'shadow_pending' } };
  }
  try {
    const result = await classifyAndCompare(body, baseAnalysis, baseDecision, { track: !preview });
    if (config.semanticRouter.mode === 'active') {
      // 置信度门槛：小模型自己也不确定时（confidence < minConfidence），退回规则层决策，只记观察
      const minConfidence = Number(config.semanticRouter.minConfidence ?? 0);
      if (result.assessment.confidence < minConfidence) {
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
    decision = { requestedModel: body.model, selectedModel: body.model, suggestedModel: body.model, shadow: false, analysis: { task: 'explicit', tier: 'explicit', complexity: 0, routeMethod: 'explicit' }, reasoningLevel: 'off', candidates: [], rejected: [], fallbackOrder: [body.model], configVersion: config.version };
  }
  decision.selectedModel = sessionModel(req, decision);
  counters.suggested[decision.suggestedModel] = (counters.suggested[decision.suggestedModel] || 0) + 1;
  counters.task[decision.analysis.task] = (counters.task[decision.analysis.task] || 0) + 1;
  const fallback = decision.fallbackOrder.filter((m) => m !== decision.selectedModel);
  const attempts = [decision.selectedModel, ...fallback].slice(0, auto ? config.routing.maxAttempts : 1);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('上游请求超时')), config.routing.requestTimeoutMs);
  let lastError;
  for (let i = 0; i < attempts.length; i += 1) {
    const model = attempts[i];
    if (!claimCircuitAttempt(model)) continue;
    const started = Date.now();
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
      // 飞轮：转发前先判定是否流式——流式不缓冲整个响应（内存安全），usage 从 SSE 尾块解析
      const isStream = body.stream === true;
      let usage = null;
      updateHealth(model, true, latency);
      maybePromoteVerified(model);
      counters.success += 1;
      counters.outcome[auto ? 'auto' : 'explicit'].success += 1;
      counters.selected[model] = (counters.selected[model] || 0) + 1;
      // 按请求来源细分：显式点名 vs auto 调度（auto 里再分容差分流），负荷均衡观测的核心
      const selectedBy = counters.selectedBy[model] ||= { explicit: 0, auto: 0, autoPreference: 0 };
      if (!auto) selectedBy.explicit += 1;
      else if (decision.preference?.model === model) { selectedBy.autoPreference += 1; selectedBy.auto += 1; }
      else selectedBy.auto += 1;
      const selectedConfig = config.models.find((item) => item.id === model);
      const estimatedCostYuan = estimateCostYuan(body, decision.analysis, selectedConfig, config, decision.reasoningLevel);
      budgetTracker.consume(estimatedCostYuan).catch(() => {});
      // 飞轮：非流式在此整体缓冲解析 usage（拿到实际 token 数）；流式在转发循环中从尾块提取
      let responseText = null;
      if (!isStream && upstream.body) {
        responseText = await upstream.text();
        usage = extractUsage(upstream.headers.get('content-type'), responseText);
      }
      // 实际成本：有 usage 时按真实 token 结算（对账口径），否则保留预估值
      const actualCostYuan = usage ? computeActualCostFromUsage(usage, selectedConfig) : null;
      if (actualCostYuan != null) { counters.tokens ??= {}; counters.tokens.prompt = (counters.tokens.prompt || 0) + usage.prompt; counters.tokens.completion = (counters.tokens.completion || 0) + usage.completion; }
      // 日志先组装不落盘（流式的 usage 在流尾才知道）——转发完成后统一 write
      const logEntry = { sessionId: req.headers['x-session-id'] || null, requestId: req.requestId, redactedBody: decisionLog.redact(body) };
      const logOutcome = { ok: true, model, latencyMs: latency, fallbackAttempt: i, estimatedCostYuan, actualCostYuan, usage };
      record({ at: new Date().toISOString(), requested: decision.requestedModel, selected: model, suggested: decision.suggestedModel, task: decision.analysis.task, complexity: decision.analysis.complexity, routeMethod: decision.analysis.routeMethod, reasoningLevel: decision.reasoningLevel, estimatedCostYuan, actualCostYuan, latencyMs: latency, fallbackAttempt: i, ok: true });
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
      if (!upstream.body) return res.end();
      if (responseText !== null) {
        // 非流式：body 已被 text() 消费，这里一次性写回客户端；usage/actualCostYuan 已解析完毕，落日志
        if (!res.write(responseText)) await new Promise((resolve) => res.once('drain', resolve));
        decisionLog.write(logEntry, decision, logOutcome);
        clearTimeout(timer); return res.end();
      }
      // 流式：逐块转发（背压安全），并从 SSE 尾块提取 usage（飞轮：实际 token 消耗）
      // 注意：undici 的 chunk 是 Uint8Array，toString('utf8') 不生效（会输出字节数字）——必须 Buffer 化
      const tailChunks = []; let tailBytes = 0;
      const trimTail = () => { if (tailBytes > 8192) { const merged = Buffer.concat(tailChunks).subarray(-4096); tailChunks.length = 0; tailChunks.push(merged); tailBytes = merged.length; } };
      for await (const chunk of upstream.body) {
        if (!res.write(chunk)) await new Promise((resolve) => res.once('drain', resolve));
        tailChunks.push(Buffer.from(chunk)); tailBytes += chunk.length; trimTail();
      }
      const sseTail = Buffer.concat(tailChunks).toString('utf8');
      if (isStream && !usage) usage = extractUsage('text/event-stream', sseTail);
      decisionLog.write(logEntry, decision, { ...logOutcome, usage, actualCostYuan: usage && usage.prompt != null && usage.completion != null ? computeActualCostFromUsage(usage, selectedConfig) : logOutcome.actualCostYuan });
      // 流式尾块拿到 usage 后补算实际成本并更新 token 计数器
      if (usage && selectedConfig?.pricingYuanPerMillionTokens && usage.prompt != null && usage.completion != null) {
        const actual = computeActualCostFromUsage(usage, selectedConfig);
        if (actual != null) { counters.tokens ??= {}; counters.tokens.prompt = (counters.tokens.prompt || 0) + usage.prompt; counters.tokens.completion = (counters.tokens.completion || 0) + usage.completion; }
      }
      clearTimeout(timer); return res.end();
    } catch (error) {
      lastError = error;
      updateHealth(model, false, Date.now() - started);
      if (res.headersSent) { clearTimeout(timer); res.destroy(error); return; }
      if (error.retryable !== false && i + 1 < attempts.length) { counters.fallback += 1; continue; }
      break;
    }
  }
  clearTimeout(timer);
  counters.errors += 1;
  counters.outcome[auto ? 'auto' : 'explicit'].error += 1;
  const failure = { at: new Date().toISOString(), requested: decision.requestedModel, selected: attempts.at(-1), suggested: decision.suggestedModel, task: decision.analysis.task, ok: false, error: lastError?.message };
  record(failure);
  decisionLog.write({ sessionId: req.headers['x-session-id'] || null, requestId: req.requestId, redactedBody: decisionLog.redact(body) }, decision, { ok: false, model: attempts.at(-1), error: (lastError?.message || '').slice(0, 500) });
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
    if (process.env.METRICS_TOKEN && !safeEqual(req.headers.authorization, `Bearer ${process.env.METRICS_TOKEN}`)) return errorJson(res, 401, 'Metrics Token 无效', 'authentication_error');
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
  // 任务榜单（OpenRouter「task-spend rankings」内网版）：按任务类型聚合决策日志，
  // 每类任务展示首选模型+使用份额+满意度——「大家把流量花在了哪」一目了然。
  // 路由体检报表（OpenRouter 评测叙事模板的内网版）：同一批代表任务上，
  // auto 路由 vs 每个单模型固定基线的加权质量/平均成本/平均时延对比——
  // 「auto 比 X 便宜多少/质量高多少」一句话有数可查。模拟口径（读配置跑分），不调模型、零成本。
  if (req.method === 'GET' && url.pathname === '/admin/api/routing-report') {
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
    // 金句生成：auto vs 最强单模型 / auto vs 最便宜单模型
    const strongest = arms.filter((a) => a !== base).sort((a, b) => b.quality - a.quality)[0];
    const cheapest = arms.filter((a) => a !== base).sort((a, b) => a.costIndex - b.costIndex)[0];
    const highlights = [];
    if (strongest) highlights.push(`对比最强单模型 ${strongest.name}：质量 ${base.quality} vs ${strongest.quality}（${base.quality >= strongest.quality ? '+' : ''}${(base.quality - strongest.quality).toFixed(3)}），成本指数 ${base.costIndex} vs ${strongest.costIndex}（省 ${(((strongest.costIndex - base.costIndex) / (strongest.costIndex || 1)) * 100).toFixed(0)}%）`);
    if (cheapest) highlights.push(`对比最便宜单模型 ${cheapest.name}：成本接近（${base.costIndex} vs ${cheapest.costIndex}），质量 ${base.quality} vs ${cheapest.quality}（${base.quality >= cheapest.quality ? '高' : '低'} ${Math.abs(base.quality - cheapest.quality).toFixed(3)}）`);
    return json(res, 200, { sampleCount: rows.length, arms, highlights, perSample: rows });
  }
  // 市场信号状态：各任务的信号覆盖（激活/休眠）与每模型的份额/调整值——飞轮健康度一览
  if (req.method === 'GET' && url.pathname === '/admin/api/market-signal') {
    marketSignal.rebuild().catch(() => {});
    return json(res, 200, { status: marketSignal.status(), signals: marketSignal.signals });
  }
  if (req.method === 'GET' && url.pathname === '/admin/api/task-board') {
    const recent = await decisionLog.recent(2000).catch(() => []);
    const byTask = {};
    for (const entry of recent) {
      const task = entry?.decision?.analysis?.task || 'unknown';
      const model = entry?.decision?.selectedModel || entry?.decision?.suggestedModel;
      if (!model) continue;
      const slot = byTask[task] ||= { task, total: 0, models: {}, fails: {} };
      slot.total += 1;
      slot.models[model] = (slot.models[model] || 0) + 1;
      if (entry?.outcome?.ok === false) slot.fails[model] = (slot.fails[model] || 0) + 1;
    }
    const board = Object.values(byTask).map((slot) => ({
      task: slot.task,
      total: slot.total,
      picks: Object.entries(slot.models)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([model, count]) => ({ model, share: Number(((count / slot.total) * 100).toFixed(1)), fails: slot.fails[model] || 0 }))
    })).sort((a, b) => b.total - a.total);
    return json(res, 200, { window: 'recent 2000 decisions', board });
  }
  if (req.method === 'GET' && url.pathname === '/admin/api/metrics') return json(res, 200, { counters, health, recent, semanticReviews, budget: budgetTracker.snapshot(), decisionLog: decisionLog.snapshot(), feedback: feedbackLog.snapshot(), sessions: sessions.size });
  // 分类器标准评测：spawn Python 脚本跑 heldout 集，输出三方（gold/小模型/规则层）准确率与混淆矩阵。
  // 回答"换分类器后准了多少"——换端点前后各点一次即可对比。评测只读模型文件，不影响线上。
  if (req.method === 'POST' && url.pathname === '/admin/api/classifier/evaluate') {
    const script = join(projectRoot, 'scripts', 'evaluate_classifier.py');
    const venvPython = join(projectRoot, '.venv', 'Scripts', 'python.exe');
    const pythonCmd = process.env.CLASSIFIER_PYTHON || (existsSync(venvPython) ? venvPython : 'python');
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
    const venvPython = join(projectRoot, '.venv', 'Scripts', 'python.exe');
    const pythonCmd = process.env.CLASSIFIER_PYTHON || (existsSync(venvPython) ? venvPython : 'python');
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
      const rows = await decisionLog.recent(count, { includeFullText });
      return json(res, 200, { count: rows.length, decisions: rows });
    } catch (error) { return errorJson(res, 500, error.message, 'decision_log_error'); }
  }
  if (req.method === 'POST' && url.pathname === '/admin/api/reload') {
    try { config = await loadConfig(); budgetTracker.updateConfig(config); decisionLog.updateConfig(config); return json(res, 200, { ok: true, version: config.version }); }
    catch (error) { return errorJson(res, 400, error.message, 'invalid_config'); }
  }
  if (url.pathname === '/manual') {
    // 使用手册页：读 docs/使用说明.md 渲染（服务启动目录固定，路径穿越已被 normalize 防住）
    try {
      const md = await readFile(join(projectRoot, 'docs', '使用说明.md'), 'utf8');
      const html = await readFile(join(projectRoot, 'public', 'manual.html'), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html.replace('__MANUAL_CONTENT__', () => md.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')));
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
