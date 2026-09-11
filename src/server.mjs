import { completionBudgetEligible } from './completion-budget.mjs';
import { createGoCoreAdmin } from './go-core-admin.mjs';
import { createGoCoreEdge } from './go-core-edge.mjs';
import { goDecision, goAttempt, goOutcome } from './go-core-results.mjs';
import { createGoConfigPublication } from './go-config-publication.mjs';
import { attachGoLatencyObservation } from './go-core-observation.mjs';
import { createModelLoadTracker, loadAssessment } from './model-load.mjs';
import { LatencyObservatory, latencyContext } from './latency-observatory.mjs';
import { createLatencyProbeRunner } from './latency-probes.mjs';
import { OperationsEvidence, qualityEvidence, comparisonReadiness } from './operations-evidence.mjs';
import { analyzeRoutingMatrix } from './routing-matrix.mjs';
import http from 'node:http';

import { readFile } from 'node:fs/promises';

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, statSync, chmodSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { JudgeSecretStore } from './judge-secret.mjs';

import { spawn } from 'node:child_process';

import { dirname, extname, join, normalize, resolve } from 'node:path';

import { loadConfig, projectRoot, saveConfig as saveSourceConfig, validateConfig, getConfigRevision, refreshCostIndexes } from './config.mjs';
import { promises as dnsPromises } from 'node:dns'; // SSRF DNS pinning

import { analyzeRequest, mergeSemanticAssessment, routeRequest, paretoFrontier, oracleChoice, zeroRouterChoice, recommendReasoningLevel, isAutoRequest, autoModelId, capabilityEligible } from './router.mjs';

import { resolveModelScope, scopeIntersectsConfig, scopeAllows, scopeCacheStats } from './model-scope.mjs';

import { classifySemantically, shouldUseSemanticRouter } from './semantic-router.mjs';

// Judge：异步 shadow 评分器（独立事件流 judge-reviews；


import { shouldSampleJudge, buildJudgeMessages, buildTaskCheckMessages, parseJudgeJson, normalizeDimension, normalizeVerdict, randomAbOrder, JudgeGuard, callJudgeModel, judgePromptHash, JUDGE_RUBRIC_VERSION, JUDGE_TASK_ENUM, normalizeSuggestedTask, looksLikeQualityVerdict, isValidTaskCheckVerdict, extractNonStreamAnswerText, createAnswerCollector, compileRedactPatterns, redactText } from './judge.mjs';

import { BudgetTracker, estimateCostYuan } from './budget.mjs';

import { FeedbackLog } from './feedback.mjs';

import { DecisionLog } from './decision-log.mjs';

import { logger } from './logger.mjs';

import { renderPrometheusMetrics } from './metrics.mjs';

import { renderMarkdown } from './markdown.mjs';

import { createShutdownManager, installCrashHandlers } from './shutdown.mjs';

import { createRateLimiter } from './rate-limiter.mjs';

import { shouldPromoteVerified } from './calibration.mjs';
import { newHealthState, updateHealthState, offlineAlertDue, classifyUpstreamFailure, releaseCircuitAttempt } from './health.mjs';
import { sessionRoutingKey, chooseSessionModel } from './session-routing.mjs';
import { createStreamTimingObserver, observeLatency } from './response-timing.mjs';
import { bootstrap, bootstrapDiff } from './bootstrap.mjs';

import { MarketSignal } from './market-signal.mjs';

import { registerMarketSignal } from './market-signal-runtime.mjs';

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';

const host = process.env.HOST || '127.0.0.1';

const port = Number(process.env.PORT || 8787);
const goCoreAdmin = createGoCoreAdmin();
const nativePolicies = new Map();
if (process.env.AMR_GO_NATIVE_FRONT === '1' && String(process.env.SEMANTIC_BUCKET_SECRET || '').length < 32) throw new Error('Native Go front requires a shared stable semantic secret');
const goCoreEdge = createGoCoreEdge(process.env, { context: nativeGoContext, prepare: prepareNativeGoEvent,
  pending: async () => {
    const state = await goCoreAdmin.runtime();
    if (state.status !== 200 || state.activeRequests === undefined || state.backgroundReviews === undefined) return 1;
    return state.activeRequests + state.backgroundReviews;
  } });
if (goCoreEdge && (!goCoreAdmin || !process.env.AMR_GO_RUNTIME_CONFIG)) throw new Error('Go chat edge requires automatic snapshot publication');
const goConfigPublication = goCoreEdge ? createGoConfigPublication(goCoreAdmin, next => { assertSemanticBucketSecretForMode(next.semanticRouter?.mode); assertJudgeGuardStatePathStable(next.judge); }) : null;
async function saveConfig(next, options) {
  const saved = await (goConfigPublication ? goConfigPublication.save(next, options) : saveSourceConfig(next, options));
  rateLimiter.update({ rpm: Number(saved.rateLimit?.rpm ?? 120), burst: Number(saved.rateLimit?.burst ?? saved.rateLimit?.rpm ?? 120) });
  marketSignal.updateConfig(saved);
  return saved;
}

// 长流式 chat 的客户端可能挂 60~120 分钟，必须显式放宽默认 5 秒 keepAlive/headers 超时

const serverKeepAliveMs = Number(process.env.HTTP_KEEPALIVE_MS || 300000); // 5 分钟

const serverHeadersTimeoutMs = Number(process.env.HTTP_HEADERS_TIMEOUT_MS || 310000); // 比 keepAlive 略高

let config = await loadConfig();
nativePolicies.set(getConfigRevision(config), config);
const modelLoad = createModelLoadTracker();
const latencyStore = new LatencyObservatory({ path: process.env.LATENCY_STATE_PATH || (process.env.CONFIG_PATH
  ? join(dirname(resolve(projectRoot, process.env.CONFIG_PATH)), 'latency-observations.json') : join(projectRoot, 'data/latency-observations.json')) });
await latencyStore.restore();
const operations = new OperationsEvidence({ path: join(dirname(latencyStore.path), 'operations-evidence.json') });
await operations.restore();
const qualityManifest = JSON.parse(await readFile(new URL('./quality-evidence.json', import.meta.url), 'utf8'));
function checkOperations() {
  operations.evaluate({ windows: latencyStore.incidentWindows(), revision: getConfigRevision(config),
    enabledModels: config.models.filter(m => m.enabled !== false).map(m => m.id),
    capacities: config.models.map(m => ({ model: m.id, ...loadAssessment(m, config.routing, runtimeModelLoad()) })) });
}
const latencySettings = () => ({ mode: 'off', minSamples: 20, staleMs: 300000, scaleMs: 10000, maxAdjust: 0.05, switchMargin: 0.02, ...(config.routing.latencyObservation || {}) });
const latencyProbeSettings = () => ({ enabled: false, intervalMs: 900000, maxCallsPerDay: 144, timeoutMs: 20000, maxOutputTokens: 128, ...(config.routing.latencyObservation?.probes || {}) });
const latencyProbes = createLatencyProbeRunner({ observatory: latencyStore, getSettings: latencyProbeSettings,
  getModels: () => config.models.filter(m => m.enabled !== false), probe: runLatencyProbe,
  hasFreshBusiness: model => latencyStore.hasFreshBusiness(latencyContextFor(model, {}, {}, 'off', null).scope) });
let latencyProbeController = null;


assertSemanticBucketSecretForMode(config.semanticRouter?.mode);

const budgetTracker = await BudgetTracker.create(projectRoot, config);

const decisionLog = await DecisionLog.create(projectRoot, config);


// 两个流各持一个才能并行轮转互不踩脚；共享 enabled/目录/轮转参数，filePrefix 区分文件名）。

// 事件按 requestId 关联决策日志，shadow 观察期数据重启不再丢。

const semanticLog = await DecisionLog.create(projectRoot, { decisionLog: { ...(config.decisionLog || {}), filePrefix: 'semantic-reviews' } });



// 「judge 开 + 决策日志关」导致评分调用无落盘的漏洞已堵（config 校验层双保险）。

const judgeLog = await DecisionLog.create(projectRoot, { decisionLog: { ...(config.decisionLog || {}), enabled: Boolean(config.judge?.enabled), filePrefix: 'judge-reviews' } });


const judgeGuardStatePath = resolve(projectRoot, config.judge?.guardStatePath || './data/judge-guard-state.json');
// 评审通道优先级：judge-secret.json > 环境变量 > config.upstreamBaseUrl
const judgeSecretStore = new JudgeSecretStore({ path: resolve(projectRoot, './data/judge-secret.json') });
try { const st = statSync(judgeSecretStore.path); if ((st.mode & 0o777) !== 0o600) chmodSync(judgeSecretStore.path, 0o600); } catch { /* 文件不存在（未配置）或 Windows：跳过 */ }


// 下次启动静默按空状态恢复=预算被重置）；persist 失败计数进 judgeCounters（不再无声吞掉）。

// guard 持久化异步化：同 tick 多次状态变更合并为一次写盘（合并写+串行链），
// writeFileSync/renameSync 不再阻塞主事件循环；原子语义保留（tmp + rename）。
// 末次快照胜出：persist 回调只记录最新状态并调度微任务，串行链保证前序写完成后才写新快照。
const guardPersist = (() => {
  let pending = null; // 待写快照（只保留最新）
  let writing = false; // 串行链在途标记
  const flush = async () => {
    if (writing || pending === null) return;
    writing = true;
    const snap = pending; pending = null;
    try {
      await fsp.mkdir(dirname(judgeGuardStatePath), { recursive: true });
      const tmp = `${judgeGuardStatePath}.${process.pid}.${Date.now()}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(snap));
      await fsp.rename(tmp, judgeGuardStatePath);
    } catch { judgeBump('persistErrors'); }
    finally { writing = false; if (pending !== null) flush(); } // 落盘期间又有新快照→链式补写
  };
  return {
    persist: (snap) => { pending = snap; queueMicrotask(flush); },
    // shutdown 排空用：等待在途写链与 pending 快照全部落盘（2s 上限，防写盘卡死拖长关停）
    drain: () => Promise.race([ (async () => { while (writing || pending !== null) await new Promise((r) => setTimeout(r, 10)); })(), new Promise((r) => setTimeout(r, 2000)) ]),
  };
})();
const judgeGuard = new JudgeGuard({ ...(config.judge || {}), persist: guardPersist.persist });

if (existsSync(judgeGuardStatePath)) {

  try { judgeGuard.restore(JSON.parse(readFileSync(judgeGuardStatePath, 'utf8'))); } catch { /* 损坏状态按空起步 */ }

  logger.info('judge_guard_restored', { day: judgeGuard.snapshot().day, calls: judgeGuard.snapshot().calls, tokens: judgeGuard.snapshot().tokens, circuit: judgeGuard.snapshot().circuit });

}


// 管理页

// 「今日用量」不再显示进程累计——重启清零但运行期间口径正确，且 guard 状态有磁盘账。

const judgeCounters = { day: null, sampled: 0, qualityDone: 0, taskCheckDone: 0, errors: 0, tokens: 0, gaugeCircuit: 0, persistErrors: 0 };

function judgeBump(k, n = 1) {

  const today = new Date().toISOString().slice(0, 10);

  if (judgeCounters.day !== today) { judgeCounters.day = today; judgeCounters.sampled = 0; judgeCounters.qualityDone = 0; judgeCounters.taskCheckDone = 0; judgeCounters.errors = 0; judgeCounters.tokens = 0; }

  judgeCounters[k] = (judgeCounters[k] || 0) + n;

}


function judgeLogUpdate() { judgeLog.updateConfig({ decisionLog: { ...(config.decisionLog || {}), enabled: Boolean(config.judge?.enabled), filePrefix: 'judge-reviews' } }); }

const judgeRuntime = {

  get enabled() { return Boolean(config.judge?.enabled); },

};

// fire-and-forget judge 管线入口：请求完成后异步评分（绝不 await 在响应路径上）


// ②reserve→settle 预占闸（quality 与 taskCheck 各自 reserve，预算不穿透）

// ③taskCheck 只核路由大类（explicit 请求跳过）④空 verdict 不计成功 ⑤redactPatterns 脱敏

function maybeJudgeRequest({ requestId, outcome, decision, body, answerText, sessionIdRaw, sessionFingerprint, semanticAssessment }) {

  try {

    if (!judgeRuntime.enabled) return;

    if (!outcome?.ok) return; // 只评成功回答

    const jc = config.judge;

    if (!shouldSampleJudge(requestId, jc.samplePercent, semanticBucketSecret)) return;

    judgeBump('sampled');

    if (!answerText || !String(answerText).trim()) return; // 无回答正文（空流/纯 tool call/信封解析失败）不评

    const redactors = compileRedactPatterns(jc.redactPatterns);

    const task = trackSemanticTask((async () => {

      const at = new Date().toISOString();

      // —— 预占闸：await 上游前原子预占——并发请求不再穿透每日预算

      const rq = judgeGuard.reserve({ estTokens: 8000 });

      if (!rq.ok) {

        judgeLog.writeRaw({ at, v: 1, requestId, event: 'skipped', reason: rq.reason });

        return;

      }

      // > 环境变量 > config 缺省——glm-5.3 可指向 MaaS 或外部兼容端点
      const judgeSecret = judgeSecretStore.get();
      const base = (judgeSecret?.baseUrl || process.env.UPSTREAM_BASE_URL || process.env.MAAS_BASE_URL || config.upstreamBaseUrl).replace(/\/$/, '');
      const apiKey = judgeSecret?.apiKey || process.env.UPSTREAM_API_KEY || process.env.MAAS_API_KEY;

      if (!apiKey) { judgeGuard.release(rq.handle); judgeLog.writeRaw({ at, v: 1, requestId, event: 'skipped', reason: 'no_api_key' }); return; }

      const model = jc.model;

      const common = { model, baseUrl: base, apiKey, timeoutMs: Number(jc.timeoutMs) || 60000, fetchImpl: fetch };

      // ① 质量评分（单份）

      const q = await callJudgeModel({ ...common, messages: buildJudgeMessages({ messages: body.messages, answerText, redactors }) });

      if (!q.ok) { judgeGuard.settle(rq.handle, { ok: false }); judgeBump('errors'); judgeLog.writeRaw({ at, v: 1, requestId, event: 'error', stage: 'quality', error: q.error, latencyMs: q.latencyMs }); return; }

      const parsed = parseJudgeJson(q.text);

      // 空 verdict（{}）不算成功：四维全 missing 不得计入 qualityDone

      if (!parsed || !looksLikeQualityVerdict(parsed)) { judgeGuard.settle(rq.handle, { ok: false }); judgeBump('errors'); judgeLog.writeRaw({ at, v: 1, requestId, event: 'error', stage: 'quality_parse', latencyMs: q.latencyMs }); return; }

      judgeGuard.settle(rq.handle, { tokens: q.usage?.total_tokens, ok: true }); // v0.11.5：fail-closed 已内收 JudgeGuard.settle

      judgeBump('qualityDone'); if (typeof q.usage?.total_tokens === 'number') judgeBump('tokens', q.usage.total_tokens); // v0.11.5：metrics 只记真实报告值（缺失不记 0，防低估误导对账）

      const quality = {

        correctness: normalizeDimension(parsed.correctness),

        instruction_following: normalizeDimension(parsed.instruction_following),

        completeness: normalizeDimension(parsed.completeness),

        safety: normalizeDimension(parsed.safety),

        overall_comment: String(parsed.overall_comment || '').slice(0, 120) || null,

      };

      const judgeEvent = {

        at, v: 1, requestId, event: 'quality', rubricVersion: JUDGE_RUBRIC_VERSION, rubricHash: judgePromptHash(),

        judgeModel: model,

        answeredModel: outcome.model, task: decision?.analysis?.task, subTask: decision?.analysis?.subTask ?? null, tier: decision?.analysis?.tier,

        sessionFingerprint: sessionFingerprint ?? sessionFingerprintOf(sessionIdRaw),

        quality, usage: q.usage, latencyMs: q.latencyMs,

      };

      // ② 分类核对（task_agree）——独立第二次调用，与质量分分开落。

      // 只核路由大类枚举；显式模型请求（routeMethod='explicit'）没有路由判定，跳过核对。

      const routeMethod = decision?.analysis?.routeMethod;

      if (jc.taskCheckEnabled && routeMethod !== 'explicit') {

        // taskCheck 单独预占

        const rt = judgeGuard.reserve({ estTokens: 2000 });

        if (rt.ok) {

          const t = await callJudgeModel({ ...common, messages: buildTaskCheckMessages({ messages: body.messages, routeTask: decision?.analysis?.task, subTask: decision?.analysis?.subTask, predictedTier: decision?.analysis?.tier, redactors }) });

          if (t.ok) {

            const tp = parseJudgeJson(t.text);

            // task_agree 必须是布尔

            if (tp && isValidTaskCheckVerdict(tp)) {

              judgeGuard.settle(rt.handle, { tokens: t.usage?.total_tokens, ok: true }); // v0.11.5：同上，Guard 内收

              judgeEvent.taskCheck = { agree: tp.task_agree === true, reason: String(tp.reason || '').slice(0, 80) || null, suggested: normalizeSuggestedTask(tp.suggested_task), latencyMs: t.latencyMs };

              judgeBump('taskCheckDone'); if (typeof t.usage?.total_tokens === 'number') judgeBump('tokens', t.usage.total_tokens);

            } else {

              judgeGuard.settle(rt.handle, { ok: false }); // 形状不对视作失败（熔断计数）

              judgeEvent.taskCheck = { agree: null, reason: 'parse_failed', latencyMs: t.latencyMs };

              judgeBump('errors');

            }

          } else { judgeGuard.settle(rt.handle, { ok: false }); judgeBump('errors'); }

        } else {

          judgeEvent.taskCheck = { agree: null, reason: rt.reason === 'circuit_open' ? 'circuit_open' : 'budget', latencyMs: null };

        }

      }

      judgeLog.writeRaw(judgeEvent);

    })());

    task.catch(() => {});

    judgeCounters.gaugeCircuit = judgeGuard.snapshot().circuit === 'open' ? 2 : (judgeGuard.snapshot().circuit === 'half-open' ? 1 : 0);

  } catch (e) { logger.warn('judge_hook_error', { requestId, error: String(e.message || e).slice(0, 200) }); }

}


// fire-and-forget——HTTP 响应已结束但复核还在跑，容器滚动重启时进程直接退出会丢「正在复核

// 的事件」与「已排队未落盘的 semantic-reviews 事件」。关停 flush 按①后台任务（带超时）

// →②semanticLog.writeChain 顺序排空。

const semanticBackgroundTasks = new Set();

function trackSemanticTask(promise) {

  semanticBackgroundTasks.add(promise);

  promise.finally(() => semanticBackgroundTasks.delete(promise)).catch(() => {});

  return promise;

}

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

// 管理端登录会话：ADMIN_TOKEN 换 HttpOnly cookie（2h 空闲 / 12h 绝对上限）；Bearer 依旧兼容脚本调用。
const adminSessions = new Map(); // sid -> { lastSeen, absExpires }
const ADMIN_SESSION_IDLE_MS = 2 * 60 * 60 * 1000;
const ADMIN_SESSION_ABS_MS = 12 * 60 * 60 * 1000;
const ADMIN_SESSION_COOKIE = 'amr_admin_session';
function parseCookies(req) { const out = {}; const raw = req.headers.cookie; if (!raw) return out; for (const part of raw.split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim(); } return out; }
function getAdminSession(req) { const sid = parseCookies(req)[ADMIN_SESSION_COOKIE]; if (!sid || !adminSessions.has(sid)) return null; const sess = adminSessions.get(sid); const now = Date.now(); if (now - sess.lastSeen > ADMIN_SESSION_IDLE_MS || now > sess.absExpires) { adminSessions.delete(sid); return null; } sess.lastSeen = now; return sess; }
function authorizedAdmin(req) { if (!process.env.ADMIN_TOKEN) return true; if (safeEqual(req.headers.authorization, `Bearer ${process.env.ADMIN_TOKEN}`)) return true; return getAdminSession(req) != null; }
// 会话表定期清扫（防长期积累）
setInterval(() => { const now = Date.now(); for (const [sid, sess] of adminSessions) { if (now - sess.lastSeen > ADMIN_SESSION_IDLE_MS || now > sess.absExpires) adminSessions.delete(sid); } }, 10 * 60 * 1000).unref();

const health = {};
let goRuntimeSnapshot = { available: false, checkedAt: 0, inflight: {}, sessions: 0 };
let goRuntimeRead = null;
function runtimeModelLoad() { return goCoreEdge ? goRuntimeSnapshot.inflight : modelLoad.snapshot(); }
async function refreshGoRuntime() {
  if (!goCoreEdge) return null;
  if (goRuntimeRead) return goRuntimeRead;
  if (Date.now() - goRuntimeSnapshot.checkedAt < 1000) return goRuntimeSnapshot;
  goRuntimeRead = (async () => {
    try {
      const state = await goCoreAdmin.runtime();
      if (state.status !== 200) throw new Error('core_unavailable');
      const available = state.persistenceHealthy && state.edgeEnabled && state.configRevision === getConfigRevision(config) && !goConfigPublication.blocked();
      goRuntimeSnapshot = { ...state, available, checkedAt: Date.now() };
      for (const model of config.models) health[model.id] = state.health[model.id] || newHealthState();
    } catch { goRuntimeSnapshot = { ...goRuntimeSnapshot, available: false, checkedAt: Date.now(), error: 'core_unavailable' }; }
    return goRuntimeSnapshot;
  })();
  try { return await goRuntimeRead; } finally { goRuntimeRead = null; }
}

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

const counters = { startedAt: new Date().toISOString(), total: 0, auto: 0, explicit: 0, success: 0, errors: 0, fallback: 0, selected: {}, selectedBy: {}, suggested: {}, task: {}, outcome: { auto: { success: 0, error: 0 }, explicit: { success: 0, error: 0 } }, semantic: { eligible: 0, attempted: 0, succeeded: 0, disagreed: 0, errors: 0, applied: 0, escalated: 0, rejectedLowConfidence: 0, rolloutHold: 0, byCascadeLevel: {}, bucketKeySource: { session: 0, fingerprint: 0, internal: 0 } } };

// v0.11.14：总请求等指标改累计口径——落盘 JSON + 启动恢复（发版重启不清零）。
// 磁盘只存累计聚合值；health/recent 等 ephemeral 状态不入盘。异步批量原子写（与 budget 台账同模式）。
const countersStatePath = resolve(projectRoot, process.env.AMR_COUNTERS_PATH || './data/counters.json');
function countersToPersist() {
  const { startedAt, ...cumulative } = counters;
  // 保存首次启动时间，让重启后的累计统计起点保持一致。
  if (!cumulative.firstStartedAt) cumulative.firstStartedAt = startedAt;
  return { version: 1, savedAt: new Date().toISOString(), cumulative };
}
let countersWriteTimer = null;
let countersWriteChain = Promise.resolve(); // 串行保存统计快照，避免旧快照后完成而覆盖新数据。
function countersFlushNow() {
  if (countersWriteTimer) { clearTimeout(countersWriteTimer); countersWriteTimer = null; }
  const snapshot = JSON.stringify(countersToPersist(), null, 2) + String.fromCharCode(10);
  countersWriteChain = countersWriteChain.then(async () => {
    await fsp.mkdir(dirname(countersStatePath), { recursive: true });
    const temp = `${countersStatePath}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(temp, snapshot, { encoding: 'utf8', mode: 0o600 });
    await fsp.rename(temp, countersStatePath);
  }).catch((e) => { logger.warn('counters_write_failed', { error: String(e?.message || e) }); });
  return countersWriteChain;
}
function scheduleCountersWrite() {
  if (countersWriteTimer) return; // 批量：500ms 内合并为一次写
  countersWriteTimer = setTimeout(() => { countersWriteTimer = null; countersFlushNow(); }, 500);
  countersWriteTimer.unref?.();
}
// 恢复前校验快照结构，损坏时报告错误。
let countersRestored = (async () => {
  try {
    const raw = await fsp.readFile(countersStatePath, 'utf8');
    const saved = JSON.parse(raw);
    const c = saved?.cumulative;
    if (saved?.version === 1 && typeof c?.total === 'number' && typeof c?.success === 'number' && typeof c?.errors === 'number' && c.selected && typeof c.selected === 'object' && c.outcome?.auto && c.outcome?.explicit) {
      Object.assign(counters, c);
      logger.info('counters_restored', { total: counters.total, savedAt: saved.savedAt });
    } else {
      logger.warn('counters_state_invalid_shape', { total: c?.total });
    }
  } catch (e) {
    if (e?.code !== 'ENOENT') logger.warn('counters_state_corrupt', { error: String(e?.message || e) });
  }
})();
await countersRestored; // 完成统计恢复后才开始监听请求。

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

// 分类器评测/回放的 Python 解析：CLASSIFIER_PYTHON > .venv（探活通过才用）> PATH python。


let classifierPythonCache = null;

async function resolveClassifierPython() {

  if (classifierPythonCache) return classifierPythonCache;

  // 探活覆盖真实模型兼容性：仅 import sklearn/joblib 会误选旧 sklearn；1.9.0 生成的

  // estimator 在 1.6.1 下虽然能反序列化，但 predict_proba 会因字段不兼容失败。

  const smoke = "import sys, sklearn, joblib; sys.path.insert(0, 'scripts'); assert sklearn.__version__ == '1.9.0'; m=joblib.load('data/training/model/task.joblib'); m.predict(['smoke'])";

  const probe = (cmd) => new Promise((resolve) => {

    const p = spawn(cmd, ['-c', smoke], { cwd: projectRoot, stdio: 'ignore', windowsHide: true });

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

// - 

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
  '/admin/api/comparison/analyze': 2 * 1024 * 1024,

  '/v1/chat/completions': 50 * 1024 * 1024, // 50MB：vision base64 + 长工具 schema + 长上下文

  '/admin/api/config': 1 * 1024 * 1024,

  '/admin/api/preview': 1 * 1024 * 1024,

  '/admin/api/simulate': 1 * 1024 * 1024,
  '/admin/api/judge/secret': 8 * 1024 // 
};

const DEFAULT_BODY_LIMIT = 64 * 1024; // 健康检查、reload、metrics、decisions 等 GET/POST 小体

// 兼容——WorkBuddy 等客户端对请求体

// 默认压缩发送，Node 原生 http server 不会自动解压，JSON.parse 收到压缩字节直接 400「请求体不是合法 JSON」。

// 按声明逆序逐层解压（RFC 9110：编码按施加顺序声明，解码逆序；支持 "gzip, br" 复合），

// 解压后大小同样受路径上限约束（防压缩炸弹：50MB 上限对压缩 payload 解压后可任意大）。

// 未知编码（如 zstd）按 HTTP 语义返回 415，报错信息给出可行动指引。

const DECOMPRESSORS = {

  gzip: createGunzip,

  'x-gzip': createGunzip,

  deflate: createInflate,

  br: createBrotliDecompress

};

class RequestBodyError extends Error {

  constructor(message, status = 400, code = 'invalid_request_error') { super(message); this.status = status; this.code = code; }

}

function parseContentEncodings(header) {

  return String(header || '')

    .toLowerCase()

    .split(',')

    .map((token) => token.trim().replace(/;q=[0-9.]+$/, '').trim())

    .filter((token) => token && token !== 'identity' && token !== 'chunked');

}

function decompressOnce(buffer, encoding, limitLabel, limit) {

  return new Promise((resolve, reject) => {

    const stream = DECOMPRESSORS[encoding]();

    const chunks = [];

    let size = 0;

    let overLimit = false;

    stream.on('data', (chunk) => {

      size += chunk.length;

      if (size > limit) { overLimit = true; stream.destroy(); return; }

      chunks.push(chunk);

    });

    stream.on('error', (error) => reject(new RequestBodyError(`请求体解压失败（${encoding}）：${error.message}`)));

    stream.on('close', () => {

      if (overLimit) reject(new RequestBodyError(`解压后请求体超过 ${limitLabel}KB 上限`));

      else resolve(Buffer.concat(chunks));

    });

    stream.end(buffer);

  });

}

async function readJson(req) {

  const text = await readRawBody(req);

  try { return JSON.parse(text); } catch { throw new RequestBodyError('请求体不是合法 JSON'); }

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

  if (overLimit) throw new RequestBodyError(`请求体超过 ${Math.round(limit / 1024)}KB 上限`);

  let body = Buffer.concat(chunks);

  const encodings = parseContentEncodings(req.headers['content-encoding']);

  for (const encoding of [...encodings].reverse()) {

    if (!DECOMPRESSORS[encoding]) {

      throw new RequestBodyError(`不支持的 Content-Encoding: ${encoding}（支持 identity/gzip/deflate/br，请在客户端关闭请求体压缩或改用受支持编码）`, 415, 'unsupported_content_encoding');

    }

    body = await decompressOnce(body, encoding, Math.round(limit / 1024), limit);

  }

  return body;

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

// key 指纹筛选（最近请求面板）：内存环形缓冲里也带 keyFingerprint

let recentKeyFilter = null;

function setRecentKeyFilter(fp) { recentKeyFilter = fp; }

// 切换影响预估：heldout 全量回放。dump=evaluate_classifier.py --dump 的逐条输出

// （gold/clf/rule 任务标签 + 小模型 confidence/tier/complexity + text 原文）。

// 三种决策链对比（与 runtime 真实代码路径一致）：

// rules-only ：现状 shadow——路由只看规则层分析

// partial-active ：现有 active 模式语义——仅规则置信 < confidenceThreshold（即未命中桶 0.55）时采纳小模型

// full-active ：激进——所有请求都采纳小模型任务标签（需 confidenceThreshold>0.98 才等效）

// 输出：任务判准率、模型分布、质量/成本均值、误判方向分解（漏判难任务=质量风险 / 多判难任务=成本浪费）。

function replayHeldout(dump, policyConfig) {

  // 任务难度序（用于误判方向）：default < creative/extraction < coding/reasoning

  const taskRank = { default: 0, creative: 1, extraction: 1, coding: 2, reasoning: 2 };

  const semanticPolicy = { ...policyConfig.semanticRouter, enabled: true, provider: policyConfig.semanticRouter?.provider || 'http-json' };

  const init = () => ({ taskAcc: 0, count: 0, modelDist: {}, qualitySum: 0, costSum: 0, misread: { underCalled: 0, overCalled: 0, taskSwapped: 0 }, modelShifts: {} });

  const result = { rules: init(), partial: init(), full: init() };

  for (const row of dump) {

    const body = { model: autoModelId(config), messages: [{ role: 'user', content: String(row.text || '') }] };

    const baseAnalysis = analyzeRequest(body, policyConfig);

    const baseModel = routeRequest(body, policyConfig, { health: {}, analysisOverride: baseAnalysis, trafficBucket: 0 }).suggestedModel;

    const semantic = { task: row.clf, tier: row.tier, complexity: row.complexity, confidence: row.confidence, reason: 'replay' };

    const fullAnalysis = mergeSemanticAssessment(baseAnalysis, semantic, true, body);

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

        if (pr < gr) agg.misread.underCalled += 1; // 漏判难任务 → 质量风险

        else if (pr > gr) agg.misread.overCalled += 1; // 多判难任务 → 成本浪费

        else agg.misread.taskSwapped += 1; // 同档互错 → 影响小

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

    const decision = routeRequest({ model: autoModelId(config), ...sample.body }, policyConfig, { health: {}, trafficBucket: 0 });

    const candidate = decision.candidates.find((item) => item.model === decision.suggestedModel);

    const model = policyConfig.models.find((item) => item.id === decision.suggestedModel);

    const costYuan = estimateCostYuan(sample.body, decision.analysis, model, policyConfig, decision.reasoningLevel || 'off');

    const latencyMs = model?.avgLatencyMs ?? Math.round(Number(candidate?.latencyIndex || 0) * 43787);

    return { id: sample.id, label: sample.label, task: decision.analysis.task, subTask: decision.analysis.subTask || '', complexity: decision.analysis.complexity, tier: decision.analysis.tier, model: decision.suggestedModel, quality: candidate?.quality || 0, costIndex: Number(candidate?.costIndex || 0), costIndexProvider: Number(model?.costIndexProvider ?? 0.5), latencyIndex: Number(candidate?.latencyIndex || 0), costYuan: costYuan == null ? null : Number(costYuan), latencyMs, signals: decision.analysis.signals, requirements: decision.analysis.requirements, rejected: decision.rejected, candidates: decision.candidates };

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

  // 论文标准锚点：Zero-Router（Pareto 前沿哈希分发）与 Oracle（静态先验事后最优——基于任务级质量先验逐请求重选，非逐请求真实作答的反事实 regret 上界；真 Oracle 需全候选离线评估，见交接说明）.

  // 同一批样本上聚合质量/成本/时延，回答"当前路由距随机基线和理论上界各差多少"。

  const baselines = { zeroRouter: { label: '随机基线（Pareto 前沿）' }, oracle: { label: '静态先验最优（参考上界）' } };

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

    try { return routeRequest({ model: autoModelId(config), ...sample.body }, cfg, { health: {}, trafficBucket: 0 }).suggestedModel; } catch { return null; }

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

    try { const m = routeRequest({ model: autoModelId(config), ...sample.body }, cfg, { health: {}, trafficBucket: 0 }).suggestedModel; picks[m] = (picks[m] || 0) + 1; } catch {}

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
  const state = health[model] ||= newHealthState();
  return updateHealthState(state, ok, latencyMs, config.routing);
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

const calibrationPending = new Set();
function maybePromoteVerified(model) {

  if (calibrationPending.has(model)) return;

  const modelConfig = config.models.find((item) => item.id === model);

  const verdict = shouldPromoteVerified(modelConfig, health[model], config.calibration);

  if (!verdict) return;

  const expectedRevision = getConfigRevision(config), draft = structuredClone(config);
  const updatedModel = draft.models.find(item => item.id === model);
  updatedModel.reliabilityStatus = 'verified';

  updatedModel.calibrationStatus = 'verified'; // 旧字段同步写（未升级的旧 UI 仍读此字段）

  calibrationPending.add(model);

  saveConfig(draft, { expectedRevision }).then((next) => { config = next;
  logger.info('model_calibrated', { model, samples: verdict.samples, failureRate: verdict.failureRate });

  if (marketSignal) { marketSignal.updateConfig(config); marketSignal.rebuild().catch(() => {}); } }).catch((error) => logger.warn('model_calibrated_save_failed', { model, error: error.message })).finally(() => calibrationPending.delete(model));

}

function sessionModel(req, decision) {
  if (decision.analysis?.task === 'explicit' || decision.shadow) return decision.selectedModel;
  const id = sessionRoutingKey({ sessionId: req.headers['x-session-id'], authorization: req.headers.authorization,
    upstream: process.env.UPSTREAM_BASE_URL || process.env.MAAS_BASE_URL || config.upstreamBaseUrl }, semanticBucketSecret);
  if (!id) return decision.selectedModel;
  req.routingSessionKey = id;
  return chooseSessionModel(sessions.get(id), decision, config.routing);
}

// —— 调用方归因：key 指纹（sha256 前 8 位十六进制）——

// 只存指纹不存 key：多租户「按 key 筛选最近请求 / 消耗归因」够用，且明文日志不落敏感凭证。

function keyFingerprint(authorizationHeader) {

  const raw = String(authorizationHeader || '').replace(/^Bearer\s+/i, '').trim();

  if (!raw) return null;

  return createHash('sha256').update(raw).digest('hex').slice(0, 8);

}

// 原始

// x-session-id 不落盘（客户端可控字段，可能含手机号/账号/工单号——与 key 同等敏感）。

// 与分桶 secret 同源（SEMANTIC_BUCKET_SECRET；缺省时进程级随机），审计仍可对账「同一会话

// 稳定同指纹」，但无法反查原值。分桶/粘性等**内存路径继续用原值**（语义不变），仅落盘脱敏。

function sessionFingerprintOf(sessionId) {

  const raw = String(sessionId || '').trim();

  if (!raw) return null;

  return `sidfp:${createHmac('sha256', semanticBucketSecret).update(`session-fp:${raw}`).digest('hex').slice(0, 16)}`;

}

function upstreamRequestBody(body, model, reasoningLevel) {

  const payload = { ...structuredClone(body), model };

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

function latencyContextFor(model, body, analysis, reasoningLevel, clientAuthHeader, source = 'business') {
  const keys = ['stream', 'max_tokens', 'max_completion_tokens', 'reasoning_effort', 'thinking', 'reasoning', 'chat_template_kwargs', 'response_format', 'temperature', 'top_p'];
  const parameterRoot = model.reasoningControl?.parameter?.split('.')[0];
  if (parameterRoot && !keys.includes(parameterRoot)) keys.push(parameterRoot);
  const controls = Object.fromEntries(keys.filter(key => body[key] !== undefined).map(key => [key, body[key]]));
  if (body.tools?.length || body.functions?.length) controls.tools = [{}];
  const payload = upstreamRequestBody(controls, model.id, reasoningLevel);
  const key = (process.env.ROUTER_KEY_MODE === 'passthrough' ? clientAuthHeader : null) || process.env.UPSTREAM_API_KEY || process.env.MAAS_API_KEY || '';
  return latencyContext({ model, payload, analysis, source,
    authorization: typeof key === 'string' ? key.replace(/^Bearer\s+/i, '').trim() : '',
    scope: clientAuthHeader?.latencyScopes?.[model.id],
    baseUrl: (process.env.UPSTREAM_BASE_URL || process.env.MAAS_BASE_URL || config.upstreamBaseUrl || '').replace(/\/$/, '') });
}

function latencyRuntime(body, clientAuthHeader) {
  return { latencyAssessment: (model, analysis, reasoningLevel, baseline) => latencyStore.assessment(
    latencyContextFor(model, body, analysis, reasoningLevel, clientAuthHeader), latencySettings(), baseline, Number(config.routing.latencyWeight || 0)) };
}

async function runLatencyProbe(model, settings) {
  if (shutdownManager.draining) return { skipped: true, errorCode: 'draining' };
  try { upstreamBase(); } catch { return { skipped: true, errorCode: 'upstream_configuration' }; }
  if (!(process.env.UPSTREAM_API_KEY || process.env.MAAS_API_KEY)) return { skipped: true, errorCode: 'missing_server_credential' };
  const body = { model: model.id, messages: [{ role: 'user', content: '只回答一个数字：1+1等于几？' }], stream: true, max_tokens: settings.maxOutputTokens, stream_options: { include_usage: true } };
  if (!completionBudgetEligible(body, model, config, 'off')) return { skipped: true, errorCode: 'thinking_budget_incompatible' };
  if (goCoreEdge && !(await refreshGoRuntime())?.available) return { skipped: true, errorCode: 'core_unavailable' };
  const load = loadAssessment(model, config.routing, runtimeModelLoad());
  if (load.capacity != null && load.inflight / load.capacity >= 0.8) return { skipped: true, errorCode: 'busy_model' };
  let release;
  if (goCoreEdge) {
    try {
      const lease = await goCoreAdmin.acquireProbe(model.id, Math.min(120000, settings.timeoutMs + 5000), getConfigRevision(config));
      if (lease.status !== 200) return { skipped: true, errorCode: 'capacity' };
      release = () => goCoreAdmin.releaseProbe(lease.lease).catch(() => {});
    } catch { return { skipped: true, errorCode: 'core_unavailable' }; }
  } else release = modelLoad.acquire(model, config.routing);
  if (!release) return { skipped: true, errorCode: 'capacity' };
  const analysis = analyzeRequest(body, config), at = Date.now(), timing = createStreamTimingObserver(at);
  const context = latencyContextFor(model, body, analysis, 'off', null, 'probe');
  let reservation = null, called = false, cost = null, ok = false, errorCode = null, timeout = false;
  const controller = new AbortController(), timeoutHandle = setTimeout(() => controller.abort(), settings.timeoutMs);
  latencyProbeController = controller;
  let tail = '', bytes = 0;
  try {
    reservation = await budgetTracker.reserve(estimateCostYuan(body, analysis, model, config, 'off'));
    called = true;
    // Pass the configured server credential explicitly in passthrough mode as well.
    const credential = process.env.UPSTREAM_API_KEY || process.env.MAAS_API_KEY;
    const response = await callUpstream(body, model.id, controller.signal, 'off', 'Bearer ' + credential);
    if (!response.ok) { await response.body?.cancel(); errorCode = `http_${response.status}`; }
    else if (!response.headers.get('content-type')?.includes('text/event-stream')) { await response.body?.cancel(); errorCode = 'stream_protocol'; }
    else {
      let done = false;
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > 256 * 1024) { controller.abort(); errorCode = 'response_limit'; break; }
        timing.push(chunk); tail = (tail + Buffer.from(chunk).toString('utf8')).slice(-65536);
        if (/data:\s*\[DONE\]/.test(tail)) done = true;
      }
      timing.finish();
      const usage = extractUsage('text/event-stream', tail);
      cost = computeActualCostFromUsage(usage, model);
      ok = done && timing.snapshot().firstContentMs != null;
      if (!ok && !errorCode) errorCode = 'incomplete_stream';
    }
  } catch (error) { if (error.failureScope === 'configuration') called = false; timeout = controller.signal.aborted && !errorCode && !shutdownManager.draining; errorCode ||= shutdownManager.draining ? 'draining' : timeout ? 'timeout' : error.failureScope === 'configuration' ? 'configuration' : 'request_failed'; }
  finally {
    clearTimeout(timeoutHandle); await release(); latencyProbeController = null;
    if (reservation != null) { if (called) await budgetTracker.settle(reservation, cost, cost != null, 'probe').catch(() => {}); else await budgetTracker.release(reservation).catch(() => {}); }
    if (called) {
      const snap = timing.snapshot(), elapsed = Date.now() - at;
      latencyStore.record({ ...context, at: Date.now(), ok, timeout, failureScope: 'probe',
        ttftMs: snap.firstContentMs, firstOutputMs: snap.firstOutputMs, upstreamTtftMs: snap.firstContentMs,
        upstreamFirstOutputMs: snap.firstOutputMs, completionMs: elapsed, attemptMs: elapsed });
    }
  }
  return { ok, errorCode, skipped: !called };
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

// 同一 URL 同一租户 key 调 auto 与直连模型完全一致，计费/配额自然落到调用方租户。

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

function upstreamBase() {
  const raw = process.env.UPSTREAM_BASE_URL || process.env.MAAS_BASE_URL || config.upstreamBaseUrl;
  try { const url = new URL(raw); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(); return String(raw).replace(/\/$/, ''); }
  catch { const error = new Error('上游地址未配置或格式无效'); error.retryable = false; error.failureScope = 'configuration'; throw error; }
}

async function callUpstream(body, model, signal, reasoningLevel = 'off', clientAuthHeader = null) {

  const base = upstreamBase();

  const passthrough = process.env.ROUTER_KEY_MODE === 'passthrough';

  let key = passthrough ? clientAuthHeader : (process.env.UPSTREAM_API_KEY || process.env.MAAS_API_KEY);

  // passthrough 但客户端没带 key：退回服务端 key（仍可用），只是计费落不到租户

  if (!key && passthrough) key = process.env.UPSTREAM_API_KEY || process.env.MAAS_API_KEY;

  if (!key) {

    const error = new Error('尚未设置 MAAS_API_KEY；请使用轮换后的新 Key');

    error.retryable = false;
    error.failureScope = 'configuration';

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

// ── P1 模型发现：代理上游 /v1/models（独立 30s 缓存；MaaS 返回 code:100200 包 data 数组，标准 OpenAI 返回 data 或裸数组）
let discoverCache = { at: 0, result: null };
async function fetchUpstreamModels() {
  const now = Date.now();
  if (discoverCache.result && now - discoverCache.at < 30000) return discoverCache.result;
  const base = (process.env.UPSTREAM_BASE_URL || process.env.MAAS_BASE_URL || config.upstreamBaseUrl)?.replace(/\/$/, '');
  const key = process.env.UPSTREAM_API_KEY || process.env.MAAS_API_KEY;
  if (!base || !key) throw new Error(`上游未配置：端点 ${base || '未填'}、密钥 ${key ? '已配' : '未配'}——请在服务端 .env 配 UPSTREAM_BASE_URL 与 UPSTREAM_API_KEY 后重试`);
  const res = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`上游返回 HTTP ${res.status}`);
  const payload = await res.json();
  const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
  const registered = new Set((config.models || []).map((m) => m.id));
  const models = list.map((m) => ({ id: m.id, registered: registered.has(m.id), ownedBy: m.owned_by || null }));
  const result = { total: models.length, newCount: models.filter((m) => !m.registered).length, models,
    upstream: { baseUrl: base || null, keyMasked: key ? (key.length <= 8 ? '…' + key.slice(-2) : key.slice(0, 6) + '…' + key.slice(-4)) : null } }; // 短 key 只显示末两位。
  discoverCache = { at: now, result };
  return result;
}

// ── P2 评测任务运行器：体检（8题冒烟）/ 完整评测（eval-gate 题集）。单进程内存队列，重启即失。
const evalJobs = new Map();
const EVAL_JOB_TTL_MS = 2 * 3600 * 1000;

function getEvalJob(id) {
  const j = id ? evalJobs.get(id) : null;
  if (!j) return null;
  sweepEvalJobs();
  return evalJobs.get(id) || null;
}
function sweepEvalJobs() {
  const now = Date.now();
  for (const [id, j] of evalJobs) if (j.finishedAt && now - j.finishedAt > EVAL_JOB_TTL_MS) evalJobs.delete(id);
}

// 体检题集：benchmark.mjs 同源 8 题（简单/抽取/分类/编码×2/推理×2/创作），断言可机判
const CHECKUP_CASES = [
  { id: 'simple-qa', task: 'simple', prompt: '只回答一个数字：17 加 28 等于多少？', check: { contains: '45' } },
  { id: 'extract-json', task: 'extraction', prompt: '从这句话抽取姓名和城市。只输出 JSON，键名必须严格为 name 和 city：张晓明目前居住在广州。', check: { json: { name: '张晓明', city: '广州' } } },
  { id: 'classification', task: 'extraction', prompt: '将"申请退款，商品破损"分类为售前、售后或咨询。只输出分类名称。', check: { contains: '售后' } },
  { id: 'sql', task: 'coding', prompt: '写一条 PostgreSQL 查询：统计 orders 表每个 user_id 最近30天的订单金额总和，只返回 SQL。', check: { contains: 'group by' } },
  { id: 'reasoning', task: 'reasoning', prompt: '有三只箱子，标签分别是苹果、橘子、混合，但所有标签都贴错。最少取几个水果能确定全部箱子？只回答数字和一句理由。', check: { containsAny: ['1个', '一个', '1 个'] } },
  { id: 'creative', task: 'creative', prompt: '为企业内部 AI 助手写三条简洁中文宣传语，每条不超过18字。' },
];

function checkCase(check, text) {
  if (!check) return null; // 无断言=人工判断题，记完成即可
  const t = String(text || '');
  // 断言大小写无关（SQL 的 GROUP BY/Group by 都算对——大小写敏感会误判标准输出）
  if (check.contains && !t.toLowerCase().includes(check.contains.toLowerCase())) return false;
  if (check.containsAny && !check.containsAny.some((k) => t.toLowerCase().includes(k.toLowerCase()))) return false;
  if (check.json) {
    try {
      const cleaned = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      const obj = JSON.parse(cleaned);
      for (const [k, v] of Object.entries(check.json)) if (String(obj[k]) !== v) return false;
    } catch { return false; }
  }
  return true;
}

async function callUpstreamChat(modelId, prompt, maxTokens = 300) {
  const base = (process.env.UPSTREAM_BASE_URL || process.env.MAAS_BASE_URL || config.upstreamBaseUrl)?.replace(/\/$/, '');
  const key = process.env.UPSTREAM_API_KEY || process.env.MAAS_API_KEY;
  const t0 = Date.now();
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens, stream: false }),
    signal: AbortSignal.timeout(60000),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload?.error?.message || `HTTP ${res.status}`);
  const text = payload?.choices?.[0]?.message?.content || '';
  return { text, latencyMs: Date.now() - t0, usage: payload?.usage || null };
}

function startEvalJob(body) {
  const type = body?.type;
  const modelId = String(body?.modelId || '').trim();
  if (!['checkup', 'full', 'interleaved'].includes(type)) throw new Error('type 必须是 checkup（体检冒烟）、full（56 题稳定性巡检）或 interleaved（交错评测——多模型同窗口轮转+Judge 评分+置信区间，仅出建议值）');
  if (type === 'interleaved') {
    const ids0 = Array.isArray(body?.modelIds) ? body.modelIds.map(String) : [];
    const ids = [...new Set(ids0)]; // v0.11.1：去重——防 [A,A] 重复付费/键覆盖/伪 pairwise
    if (ids.length < 2) throw new Error('interleaved 至少要 2 个不同模型（modelIds 数组，已去重）');
    if (ids.length > 4) throw new Error('interleaved 最多 4 个模型（预算保护）');
    const unknown = ids.filter((id) => !(config.models || []).some((m) => m.id === id));
    if (unknown.length) throw new Error(`模型不在注册表：${unknown.join('、')}`);
    // 后端强校验 enabled+ownership——禁用/归属待定模型拒绝（与前端同口径，防直连 API 绕过）
    const ineligible = ids.filter((id) => { const m = (config.models || []).find((x) => x.id === id); return m && (m.enabled !== true || m.ownership === 'unknown'); });
    if (ineligible.length) throw new Error(`模型未启用或归属待定（不参与评测）：${ineligible.join('、')}`);
    for (const j of evalJobs.values()) if (!j.finishedAt) throw new Error(`已有任务在跑（${j.id} ${j.type}），请等它完成`);
    const id = `job_${Date.now().toString(36)}`;
    const job = { id, type, modelIds: ids, startedAt: new Date().toISOString(), finishedAt: null, status: 'running',
      total: null, done: 0, failed: 0, results: [], autoApplied: false, error: null,
      judge: { configured: Boolean((judgeSecretStore.get()?.apiKey || process.env.UPSTREAM_API_KEY || process.env.MAAS_API_KEY)), model: (config.judge || {}).model || 'glm-5.3', rubricVersion: null } };
    evalJobs.set(id, job);
    runInterleavedEval(job).catch((e) => { job.error = String(e?.message || e); job.status = 'failed'; job.finishedAt = new Date().toISOString(); });
    return job;
  }
  const model = (config.models || []).find((m) => m.id === modelId);
  if (!model) throw new Error(`模型 ${modelId} 不在注册表中（请先注册）`);
  // 并发上限：同时只跑一个评测任务，防止打爆上游
  for (const j of evalJobs.values()) if (!j.finishedAt) throw new Error(`已有任务在跑（${j.id} ${j.type}），请等它完成`);
  const id = `job_${Date.now().toString(36)}`;
  const job = { id, type, modelId, startedAt: new Date().toISOString(), finishedAt: null, status: 'running',
    total: type === 'checkup' ? CHECKUP_CASES.length : 56, done: 0, failed: 0, results: [], autoApplied: false, error: null };
  evalJobs.set(id, job);
  runEvalJob(job).catch((e) => { job.error = String(e?.message || e); job.status = 'failed'; job.finishedAt = new Date().toISOString(); });
  return job;
}

// ══ v0.11.0 交错评测：多模型同窗口轮转 + Judge 评分 + bootstrap CI。仅出建议值，不改任何模型参数。 ══
// 交错评测的统计约定：
//  · 同一题集对 N 个模型交错执行（A,B,A,B…），预热题（每模型前 warmup=2 题）不计分——消除冷启动偏差；
//  · 每题 Judge 按 rubric 四维打分（复用 buildJudgeMessages/callJudgeModel/parseJudgeJson）；
//  · 汇总：每模型质量分 CI（mean correctness+instruction+completeness+safety）/4）、时延 CI、两两显著性；
//  · Judge 未配置或预算不足时如实降级（只出时延统计，quality 维度标 unavailable）。
async function runInterleavedEval(job) {
  const jc = config.judge || {};
  const judgeSecret = judgeSecretStore.get();
  // v0.11.0：JUDGE_BASE_URL/JUDGE_API_KEY 显式指定评审通道（生产：Judge 常与业务上游分离；测试：指向 mock）
  const jBase = (process.env.JUDGE_BASE_URL || judgeSecret?.baseUrl || process.env.UPSTREAM_BASE_URL || process.env.MAAS_BASE_URL || config.upstreamBaseUrl || '').replace(/\/$/, '');
  const jKey = process.env.JUDGE_API_KEY || judgeSecret?.apiKey || process.env.UPSTREAM_API_KEY || process.env.MAAS_API_KEY;
  const jModel = jc.model || 'glm-5.3';
  const judgeReady = Boolean(jBase && jKey);
  job.judge.configured = judgeReady;
  job.judge.model = jModel;
  job.judge.rubricVersion = JUDGE_RUBRIC_VERSION;

  const bank = await loadEvalGateCases();
  const WARMUP = 2; // 每模型预热题数（不计分）
  const scored = bank.slice(WARMUP);
  const totalCalls = bank.length * job.modelIds.length;
  job.total = totalCalls;

  // v0.11.1：逐题轮换执行顺序（Latin rotation——第 k 题从 modelIds[k % N] 起始轮转，
  // 消除「A 永远先答」的位置/负载偏差；每模型的前 WARMUP 次调用仍是预热）
  let callIndexByModel = Object.fromEntries(job.modelIds.map((m) => [m, 0]));
  for (let ci = 0; ci < bank.length; ci++) {
    if (job.cancelRequested) { job.status = 'cancelled'; job.finishedAt = new Date().toISOString(); return; }
    const c = bank[ci];
    const isWarmup = ci < WARMUP;
    const N = job.modelIds.length;
    const order = job.modelIds.map((_, k) => job.modelIds[(ci + k) % N]); // 第 ci 题轮转起点
    for (const mid of order) {
      if (job.cancelRequested) break; // 题内每个模型调用前检查取消——不为已取消任务多付调用费
      callIndexByModel[mid] += 1;
      const modelWarmup = callIndexByModel[mid] <= WARMUP; // 每模型独立前 N 次调用=预热（不吞题）
      try {
        const r = await callUpstreamChat(mid, c.prompt, c.maxTokens || 512);
        const ok = r.text.length > 0;
        job.results.push({ caseId: c.id, task: c.task || null, model: mid, warmup: modelWarmup, ok,
          answer: r.text, prompt: c.prompt, // v0.11.1：完整保存原题与全文答案（Judge 必须看到题目；截断交给 buildJudgeMessages 的 12000 预算）
          latencyMs: r.latencyMs,
          rubric: c.rubric, judgeScore: null, judgeError: null });
        if (!ok && !modelWarmup) job.failed += 1;
      } catch (error) {
        job.results.push({ caseId: c.id, task: c.task || null, model: mid, warmup: modelWarmup, ok: false,
          answer: '', prompt: c.prompt, latencyMs: null, rubric: c.rubric, judgeScore: null,
          judgeError: null, error: String(error?.message || error).slice(0, 120), errorType: classifyEvalError(String(error?.message || error)) });
        if (!modelWarmup) job.failed += 1;
      }
      job.done += 1;
    }
  }

  // Judge 评分：仅非预热且 ok 的作答
  // v0.11.1：Judge 评分走 normalizeDimension（越界分归一/verifiable:false 置 null——与生产质量评审同规范）
  // + JudgeGuard 预算（dailyMaxCalls/Tokens/熔断——与生产同一 Guard，超额即停并如实标注）
  job.judge = { ...job.judge, scored: 0, skippedBudget: 0, skippedError: 0, noRubric: 0 };
  if (judgeReady) {
    const common = { model: jModel, baseUrl: jBase, apiKey: jKey, timeoutMs: Number(jc.timeoutMs) || 60000, fetchImpl: fetch, maxOutputTokens: 1024 };
    for (const r of job.results) {
      if (job.cancelRequested) { job.status = 'cancelled'; job.finishedAt = new Date().toISOString(); return; }
      if (r.warmup || !r.ok) continue;
      if (!r.rubric) { job.judge.noRubric += 1; r.judgeError = 'no_rubric'; continue; }
      const rq = judgeGuard.reserve({ estTokens: 8000 });
      if (!rq.ok) { r.judgeError = `budget:${rq.reason}`; job.judge.skippedBudget += 1; continue; }
      try {
        const jm = await callJudgeModel({ ...common,
          messages: buildJudgeMessages({ messages: [{ role: 'user', content: c_prompt(r) }], answerText: r.answer }) });
        if (!jm.ok) { judgeGuard.settle(rq.handle, { ok: false }); r.judgeError = jm.error; job.judge.skippedError += 1; continue; }
        const parsed = parseJudgeJson(jm.text);
        const dims = parsed && typeof parsed === 'object' ? parsed : null;
        if (!dims) { judgeGuard.settle(rq.handle, { ok: false }); r.judgeError = 'unparseable'; job.judge.skippedError += 1; continue; }
        const norm = ['correctness', 'instruction_following', 'completeness', 'safety']
          .map((k) => normalizeDimension(dims[k]));
        const scores = norm.map((d) => d.score).filter((v) => typeof v === 'number');
                judgeGuard.settle(rq.handle, { ok: true, tokens: jm.usage?.total_tokens }); // v0.11.5：fail-closed 已内收 JudgeGuard.settle（非有限非负 number 按 reservation estTokens 结算）
        // 全维度缺失才不计分；部分缺失用可得维度均值（normalizeDimension 已把 verifiable:false 的脏分清掉）
        r.judgeScore = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
        if (r.judgeScore == null) { r.judgeError = 'no_scored_dim'; continue; }
        job.judge.scored += 1;
      } catch (e) { judgeGuard.settle(rq.handle, { ok: false }); r.judgeError = String(e?.message || e).slice(0, 100); job.judge.skippedError += 1; }
    }
  }

  // 汇总（bootstrap CI，seed 固定可复现）
  const perModel = {};
  for (const mid of job.modelIds) {
    const rows = job.results.filter((r) => r.model === mid && !r.warmup);
    const lat = rows.filter((r) => r.latencyMs && r.ok).map((r) => r.latencyMs);
    const qs = rows.map((r) => r.judgeScore).filter((v) => typeof v === 'number' && Number.isFinite(v));
    const ready = rows.filter((r) => r.ok).length;
    perModel[mid] = {
      ready: `${ready}/${rows.length}`,
      readyRate: rows.length ? ready / rows.length : null,
      quality: qs.length >= 3 ? bootstrap(qs, { seed: 42 }) : { mean: qs.length ? qs.reduce((a, b) => a + b, 0) / qs.length : null, lo: null, hi: null, n: qs.length, note: '样本<3 不出 CI' },
      latencyMs: lat.length >= 3 ? bootstrap(lat, { seed: 43 }) : { mean: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null, lo: null, hi: null, n: lat.length, note: '样本<3 不出 CI' },
    };
  }
  // v0.11.1：两两比较改配对 bootstrap——同一题的 (scoreA, scoreB) 求 diff 后重采样（保留题目难度协方差；
  // 同题恒定领先 1 分时应保留配对关系，独立采样会丢失题目间协方差。
  const pairwise = [];
  for (let i = 0; i < job.modelIds.length; i++) for (let j = i + 1; j < job.modelIds.length; j++) {
    const A = job.modelIds[i], B = job.modelIds[j];
    const byCaseA = new Map(job.results.filter((r) => r.model === A && !r.warmup && typeof r.judgeScore === 'number').map((r) => [r.caseId, r.judgeScore]));
    const byCaseB = new Map(job.results.filter((r) => r.model === B && !r.warmup && typeof r.judgeScore === 'number').map((r) => [r.caseId, r.judgeScore]));
    const diffs = [...byCaseA.keys()].filter((cid) => byCaseB.has(cid)).map((cid) => byCaseA.get(cid) - byCaseB.get(cid));
    pairwise.push({ a: A, b: B, pairedN: diffs.length,
      qualityDiff: diffs.length >= 3 ? bootstrap(diffs, { seed: 44 }) : { mean: diffs.length ? diffs.reduce((x, y) => x + y, 0) / diffs.length : null, lo: null, hi: null, n: diffs.length, note: '配对样本<3 不出 CI' },
      significant: null });
    const ci = pairwise[pairwise.length - 1].qualityDiff;
    if (ci.lo != null) pairwise[pairwise.length - 1].significant = ci.lo > 0 || ci.hi < 0;
  }
  // v0.11.1：Judge 覆盖率入 summary——缺失原因可见（预算/失败/无 rubric），不静默
  // v0.11.3：覆盖率分母=全部非预热成功作答（含无 rubric 的——同样是没评到，避免「100% 覆盖」与「无评分标准 N 条」并存误导）
  const scoredTotal = job.results.filter((r) => !r.warmup && r.ok).length;
  job.summary = {
    kind: 'interleaved',
    judgeReadyRate: scoredTotal ? (job.judge?.scored || 0) / scoredTotal : null,
    judgeSkip: { budget: job.judge?.skippedBudget || 0, error: job.judge?.skippedError || 0, noRubric: job.judge?.noRubric || 0 },
    models: perModel,
    pairwise,
    judgeConfigured: judgeReady,
    note: '交错评测=同窗口轮转（逐题轮换次序）+Judge 四维评分+bootstrap 95% CI（两两比较为同题配对差值）。结果仅为建议值：不自动改质量分/时延参数，采纳需管理员在「模型参数」页确认后发布。',

  };
  job.status = 'done';
  job.finishedAt = new Date().toISOString();
}
// v0.11.1：题面构造——必须含原题正文（Judge 要能核验「答的是不是这道题」），rubric 作评分标准附后
function c_prompt(r) { return `${r.prompt || ''}\n\n（评分标准供参考：${r.rubric || '无'}）`; }

// 评测错误统一分类（empty_response/timeout/http_401/http_429/http_5xx/invalid_payload/other）
function classifyEvalError(msg) {
  const s = String(msg);
  if (/HTTP 401|HTTP 403/.test(s)) return 'http_401_403';
  if (/HTTP 429/.test(s)) return 'http_429';
  if (/HTTP 5\d\d/.test(s)) return 'http_5xx';
  if (/HTTP 4\d\d/.test(s)) return 'http_4xx';
  if (/timeout|TimeoutError|Timeout/.test(s)) return 'timeout';
  if (/JSON|parse|invalid/i.test(s)) return 'invalid_payload';
  return 'other';
}

async function runEvalJob(job) {
  const cases = job.type === 'checkup' ? CHECKUP_CASES : await loadEvalGateCases();
  job.total = cases.length;
  for (const c of cases) {
    // 体检与巡检同样响应取消。
    if (job.cancelRequested) { job.status = 'cancelled'; job.finishedAt = new Date().toISOString(); return; }
    try {
      const r = await callUpstreamChat(job.modelId, c.prompt, c.maxTokens || 300);
      const pass = checkCase(c.check, r.text);
      // v0.10.5：空正文也是失败——errorType=empty_response，计入 failed 与 errorTypes（不再漏记账）
      const ok = r.text.length > 0;
      const errorType = ok ? null : 'empty_response';
      job.results.push({ id: c.id, task: c.task || null, ok, pass, latencyMs: r.latencyMs, chars: r.text.length, excerpt: r.text.slice(0, 120), errorType });
      // v0.10.5：failed 统一口径 = !ok 或断言失败（空响应此前被漏计）
      if (!ok || pass === false) job.failed += 1;
    } catch (error) {
      const msg = String(error?.message || error);
      const errorType = classifyEvalError(msg);
      job.results.push({ id: c.id, task: c.task || null, ok: false, pass: null, error: msg, errorType });
      job.failed += 1;
    }
    job.done += 1;
  }
  job.status = job.error ? 'failed' : 'done';
  job.finishedAt = new Date().toISOString();
  const lat = job.results.filter((r) => r.latencyMs).map((r) => r.latencyMs).sort((a, b) => a - b);
  if (job.type === 'checkup') {
    // v0.10.2：体检=6 题连通性冒烟——不再自动改内存 config（样本量不支持），只出建议时延，
    // 运营确认后在「模型参数」页手工采纳并安全发布。断言数如实呈现（不叫质量百分比）。
    job.summary = {
      successRate: job.results.filter((r) => r.ok).length / job.total,
      assertPassed: job.results.filter((r) => r.pass === true).length,
      assertTotal: job.results.filter((r) => r.pass !== null).length,
      suggestedAvgLatencyMs: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null,
      minLatencyMs: lat[0] ?? null, maxLatencyMs: lat[lat.length - 1] ?? null,
      note: '6 题冒烟=连通性+简单断言；样本量不支持分位数/质量结论',
    };
  } else {
    // v0.10.3：full（56 题稳定性巡检）汇总——页面承诺的就绪率+时延分布+分任务成功率+错误类型
    const byTask = {};
    for (const r of job.results) {
      const t = r.task || '(无分类)';
      byTask[t] ||= { total: 0, ready: 0 };
      byTask[t].total += 1;
      if (r.ok) byTask[t].ready += 1;
    }
    const errTypes = {};
    for (const r of job.results) if (!r.ok) {
      const key = r.errorType || 'other';
      errTypes[key] = (errTypes[key] || 0) + 1;
    }
    job.summary = {
      readyRate: job.results.filter((r) => r.ok).length / job.total,
      avgLatencyMs: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null,
      minLatencyMs: lat[0] ?? null, maxLatencyMs: lat[lat.length - 1] ?? null,
      byTask: Object.fromEntries(Object.entries(byTask).map(([t, v]) => [t, { ...v, rate: v.ready / v.total }])),
      errorTypes: Object.keys(errTypes).length ? errTypes : null,
      note: '56 题稳定性巡检=就绪率+时延分布；不含质量评分（质量分以带裁判的 eval:gate 为准）',
    };
  }
}

// eval-gate 题集：读 config/eval-gate.json（与 scripts/eval-gate.mjs 同源 56 题）。
// 题目带 rubric（裁判评分标准）无机判断言——在线完整评测产出：就绪率（非空返回）+ 时延分布 +
// 分 task 成功率；质量分仍以 eval:gate 脚本（带裁判）为准，页面自动回填仅时延。
async function loadEvalGateCases() {
  const { readFile } = await import('node:fs/promises');
  const { resolve } = await import('node:path');
  // v0.10.5：AMR_CONFIG_DIR 指定时优先读配置目录里的题库（与 router.json 同构；测试/多实例部署用）
  const cfgDir = process.env.AMR_CONFIG_DIR;
  const bankPath = cfgDir ? resolve(cfgDir, 'eval-gate.json') : resolve(projectRoot, 'config/eval-gate.json');
  let raw;
  try { raw = await readFile(bankPath, 'utf8'); } catch { raw = await readFile(resolve(projectRoot, 'config/eval-gate.json'), 'utf8'); }
  const arr = JSON.parse(raw)?.cases;
  if (!Array.isArray(arr) || !arr.length) throw new Error('config/eval-gate.json 缺少 cases 题库');
  return arr.map((c) => ({ id: c.id, task: c.task, prompt: c.prompt, check: null, rubric: c.rubric || null, maxTokens: c.maxTokens || 1024 }));
}

function semanticOptions(clientAuthHeader = null) {


  // key，passthrough 无服务端 key 时 cascade 升级必报「缺少上游 API Key」）。客户端 key 优先。


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

// 入账。返回 { overheadUsage, overheadCostYuan,

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

  return { overheadUsage: assessment.overheadUsage, overheadCostYuan: costYuan, classifierLatencyMs: assessment.cascade?.totalLatencyMs ?? assessment.latencyMs ?? null };

}

function classifyAndCompare(body, baseAnalysis, baseDecision, { track = true, clientAuthHeader = null, allowedModelIds = null, requestId = null } = {}) {

  if (track) counters.semantic.attempted += 1;

  return classifySemantically(body, config, semanticOptions(clientAuthHeader)).then((assessment) => {

    if (track) counters.semantic.succeeded += 1;

    if (track && assessment?.escalatedFrom) counters.semantic.escalated = (counters.semantic.escalated || 0) + 1;

    const semanticAnalysis = mergeSemanticAssessment(baseAnalysis, assessment, true, body);


    // budgetPressure/trafficBucket——L2/L3 重判 task/tier 后第二次 routeRequest 拿全量模型池打分，

    // active 模式可能提出租户无权调用的模型（上游 403/404 + 无谓 fallback）。shadow 的 proposed

    // 对比同样要用同口径候选池，否则分歧率统计失真。

    const proposed = routeRequest(body, config, { health, ...latencyRuntime(body, clientAuthHeader), modelLoad: runtimeModelLoad(), analysisOverride: semanticAnalysis, budgetPressure: budgetTracker.pressure(), trafficBucket: baseDecision.rollout.trafficBucket, ...(allowedModelIds ? { allowedModelIds } : {}) });

    const disagreed = assessment.tier !== baseAnalysis.tier || assessment.task !== baseAnalysis.task || proposed.suggestedModel !== baseDecision.suggestedModel;

    if (track && disagreed) counters.semantic.disagreed += 1;

    // ——

    // 运营调 smallAcceptThreshold 时需要看到 L3 调用率（=成本）的对应变化

    if (track && assessment?.cascade?.level) {

      counters.semantic.byCascadeLevel ??= {};

      counters.semantic.byCascadeLevel[assessment.cascade.level] = (counters.semantic.byCascadeLevel[assessment.cascade.level] || 0) + 1;


      const lv = assessment.cascade.level;

      counters.semantic.cascadeLatency ??= {};

      const agg = counters.semantic.cascadeLatency[lv] ??= { count: 0, sumMs: 0 };

      agg.count += 1;


      agg.sumMs += Number(assessment.cascade.totalLatencyMs ?? assessment.cascade.latencyMs ?? 0);

    }

    const review = { at: new Date().toISOString(), assessment, base: { task: baseAnalysis.task, tier: baseAnalysis.tier, complexity: baseAnalysis.complexity, model: baseDecision.suggestedModel }, proposed: { task: semanticAnalysis.task, tier: semanticAnalysis.tier, complexity: semanticAnalysis.complexity, model: proposed.suggestedModel }, disagreed };


    // 按 assessment.model 的 token 定价 × 真实 usage 现金入账（非预占：金额已确定无需冲正）；

    // 决策日志随 review.assessment 携带 overheadUsage/overheadCostYuan；shadow 阶段该成本由

    // 平台承担（只观察不改路由），active 阶段计入该请求总成本。

    const overhead = routingOverhead(assessment);

    if (overhead) Object.assign(review, overhead);

    if (track) recordSemanticReview(review);

    // 按 requestId 关联决策日志，

    // 重启不丢；含三层结果对照、cascade 层级、开销与时延。语义复核频繁但单条小（<2KB），

    // 与决策日志共用轮转策略（16MB×14 文件）足够 7 天观察期。

    if (track) semanticLog.writeRaw({ at: review.at, v: 1, requestId, keyFingerprint: baseDecision.keyFingerprint || null, cascade: assessment.cascade?.level || null, cascadeLatencyMs: assessment.cascade?.totalLatencyMs ?? assessment.cascade?.latencyMs ?? null, smallLatencyMs: assessment.cascade?.smallLatencyMs ?? null, largeLatencyMs: assessment.cascade?.largeLatencyMs ?? null, totalLatencyMs: assessment.cascade?.totalLatencyMs ?? null, smallAttempt: assessment.smallAttempt ? { task: assessment.smallAttempt.task, tier: assessment.smallAttempt.tier, confidence: assessment.smallAttempt.confidence, latencyMs: assessment.smallAttempt.latencyMs ?? null } : null, base: review.base, proposed: review.proposed, disagreed, ...overhead, assessment: { task: assessment.task, tier: assessment.tier, complexity: assessment.complexity, confidence: assessment.confidence } });

    return { assessment, semanticAnalysis, proposed, review };

  }).catch((error) => {

    if (track) {

      counters.semantic.errors += 1;

      recordSemanticReview({ at: new Date().toISOString(), error: error.message });


      semanticLog.writeRaw({ at: new Date().toISOString(), v: 1, requestId, error: String(error.message).slice(0, 300) });

    }

    throw error;

  });

}


// ① 无盐 SHA-256(客户端可控 requestId) → HMAC(secret)。secret=进程级随机（不落盘、不进 config

// API、不跨重启稳定）——客户端无法预计算自己落在哪个桶，服务端也不受重启前桶漂移影响

// （shadow/hold 对照组按请求独立归因，无需跨重启同桶）。若未来要求跨重启稳定（如按会话

// 长期对照），把 secret 换成 SEMANTIC_BUCKET_SECRET 环境变量即可，逻辑不变。

// ② 桶键优先级：x-session-id（同会话稳定分桶，重试不换组）> keyFingerprint（同租户稳定）

// > 服务端内部实验ID（randomUUID，绝不复用客户端 x-request-id——

// 内部实验ID分离，客户端构造 ID 无法操纵分组）。

// ③ 返回 { bucket, key } 一并落事件，事后可审计每次分桶用了哪个键。

// secret 来源：SEMANTIC_BUCKET_SECRET（跨重启稳定，部署方可选）> 进程级随机（默认）。

// 两者都不可被客户端预计算——分桶输入（session/fingerprint/内部ID）+服务端秘密，


// 污染对照）。shadow 允许缺省。校验在启动与热切换两处执行（semanticRouter.mode=active）。

const semanticBucketSecret = process.env.SEMANTIC_BUCKET_SECRET ? Buffer.from(process.env.SEMANTIC_BUCKET_SECRET, 'utf8') : randomBytes(32);

// 而非熵证明——32 个

// 重复字符也能过校验。防预计算依赖「用随机生成命令产出」的运维纪律，代码只拦明显弱值。

// urlsafe-base64(32B)=43 字符、hex(32B)=64 字符、base64(32B)=44 字符，32 字节

// 下限覆盖三种主流生成方式；过短即拒绝启动（fail fast 优于带弱 secret 上线）。

// ——热更/重载

// 改该字段不会切换实际持久化文件，静默接受会制造「配置说 A 文件、状态写 B 文件」的分裂。

// 拒改；要换路径=改配置后重启。

function assertJudgeGuardStatePathStable(nextJudge) {

  const nextPath = nextJudge?.guardStatePath;

  const currentPath = config.judge?.guardStatePath;

  const nextResolved = nextPath == null ? resolve(projectRoot, './data/judge-guard-state.json') : resolve(projectRoot, nextPath);

  if (nextResolved !== judgeGuardStatePath) {

    throw new Error(`judge.guardStatePath 不可热更（当前=${judgeGuardStatePath}，请求=${nextResolved}）——改路径请更新配置后重启服务`);

  }

  void currentPath;

}

function assertSemanticBucketSecretForMode(mode) {

  if (mode !== 'active') return;

  const secret = process.env.SEMANTIC_BUCKET_SECRET;

  if (!secret) {

    throw new Error('semanticRouter.mode=active 需要 SEMANTIC_BUCKET_SECRET 环境变量（跨重启稳定分桶）：请在宿主机 .env 生成并经 compose 注入，生成命令 python3 -c "import secrets; print(secrets.token_urlsafe(32))"');

  }

  if (Buffer.byteLength(secret, 'utf8') < 32) {

    throw new Error(`SEMANTIC_BUCKET_SECRET 长度不足（当前 ${Buffer.byteLength(secret, 'utf8')} 字节 < 32 字节长度下限；长度≠熵，务必用随机命令生成）：请重新生成，python3 -c "import secrets; print(secrets.token_urlsafe(32))"`);

  }

}

function semanticBucketOf({ sessionId = null, keyFingerprint = null, requestId = null } = {}) {


  // 指标计数器按来源分布。匿名占比高=大量请求无 session 无 key 指纹 

  // 本指标不区分「探测」与「自然匿名流量」——探测检测需另建 per-key session 基数统计）。

  const source = sessionId ? 'session' : (keyFingerprint && String(keyFingerprint).length === 8 ? 'fingerprint' : 'internal');

  const key = sessionId ? `sid:${sessionId}` : (keyFingerprint && String(keyFingerprint).length === 8 ? `fp:${keyFingerprint}` : `rid:${requestId || randomUUID()}`);

  const bucket = Number(parseInt(createHmac('sha256', semanticBucketSecret).update(`semantic-rollout:${key}`).digest('hex').slice(0, 8), 16) % 100);


  // 含账号/手机号）不进日志。指纹与分桶同 secret：审计可对账「同一会话稳定同组」，但无法反查原值。


  const hmac = createHmac('sha256', semanticBucketSecret).update(`bucket-key-fp:${key}`).digest('hex').slice(0, 16);

  const loggedKey = `${key.split(':')[0]}:${hmac}`;

  return { bucket, key, source, loggedKey };

}

async function resolveAutoDecision(body, { preview = false, clientAuthHeader = null, requestId = null, bucketKey = null } = {}) {

  const baseAnalysis = { ...analyzeRequest(body, config), routeMethod: 'rules' };

  const runtime = { health, ...latencyRuntime(body, clientAuthHeader), modelLoad: runtimeModelLoad(), analysisOverride: baseAnalysis, budgetPressure: budgetTracker.pressure(), ...(preview ? { trafficBucket: 0 } : {}) };

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

    trackSemanticTask(classifyAndCompare(body, baseAnalysis, baseDecision, { clientAuthHeader, allowedModelIds: runtime.allowedModelIds || null, requestId }));

    return { ...baseDecision, semanticReview: { status: 'shadow_pending' } };

  }


  // shadow 模型」的放量；语义分类采纳是另一个实验变量，必须独立分桶——否则 shadow→active 一步切

  // 100%，实验混杂无法归因。按 requestId 稳定哈希分桶（同请求重试/复放落同桶），未放量请求照旧

  // 走规则层决策 + 后台 shadow 观察（不丢对照组样本）。

  const semanticPercent = Math.max(0, Math.min(100, Number(config.semanticRouter.activeTrafficPercent ?? 100)));

  const { bucket: semanticBucket, loggedKey: semanticBucketKey, source: semanticBucketSource } = semanticBucketOf(bucketKey || {});

  const semanticRolloutApplied = config.semanticRouter.mode === 'active' && semanticBucket < semanticPercent;


  // 实验组不再缺 bucketKey（此前只有对照组可审计分桶身份来源）。

  // sid:/fp: 后原值不落盘。

  const semanticRollout = { bucket: semanticBucket, bucketKey: semanticBucketKey, bucketKeySource: semanticBucketSource, percent: semanticPercent };


  counters.semantic.bucketKeySource ??= {};

  counters.semantic.bucketKeySource[semanticBucketSource] = (counters.semantic.bucketKeySource[semanticBucketSource] || 0) + 1;

  if (config.semanticRouter.mode === 'active' && !semanticRolloutApplied && !preview) {

    counters.semantic.rolloutHold = (counters.semantic.rolloutHold || 0) + 1;

    trackSemanticTask(classifyAndCompare(body, baseAnalysis, baseDecision, { clientAuthHeader, allowedModelIds: runtime.allowedModelIds || null, requestId }));

    return { ...baseDecision, semanticReview: { status: 'rollout_hold', ...semanticRollout } };

  }

  try {

    const result = await classifyAndCompare(body, baseAnalysis, baseDecision, { track: !preview, clientAuthHeader, allowedModelIds: runtime.allowedModelIds || null, requestId });

    if (config.semanticRouter.mode === 'active') {


      // cascade 里当升级线、这里当采纳线）。语义复核最终结果（无论来自小模型直接采纳、

      // 大模型复核、还是大模型挂了的降级小模型）confidence 低于此线 → 退回规则层决策，只记观察。

      // 兼容：未配置 finalAdoptionThreshold 时读 minConfidence（旧配置语义不变）。

      const adoptionThreshold = Number(config.semanticRouter.finalAdoptionThreshold ?? config.semanticRouter.minConfidence ?? 0);

      if (result.assessment.confidence < adoptionThreshold) {

        counters.semantic.rejectedLowConfidence = (counters.semantic.rejectedLowConfidence || 0) + 1;

        return { ...baseDecision, semanticReview: { status: 'rejected_low_confidence', ...semanticRollout, ...result.review } };

      }

      counters.semantic.applied += 1;

      return { ...result.proposed, semanticReview: { status: 'applied', ...semanticRollout, ...result.review } };

    }

    return { ...baseDecision, analysis: mergeSemanticAssessment(baseAnalysis, result.assessment, false, body), semanticReview: { status: 'shadow_complete', ...result.review } };

  } catch (error) {

    return { ...baseDecision, semanticReview: { status: 'error', error: error.message } };

  }

}

function commitRequestOutcome({ req, body, decision, outcome, answerText, policy = config }) {
  record({ at: new Date().toISOString(), requested: decision.requestedModel, selected: outcome.model,
    suggested: decision.suggestedModel, task: decision.analysis.task, complexity: decision.analysis.complexity,
    routeMethod: decision.analysis.routeMethod, reasoningLevel: decision.reasoningLevel,
    reasoningApplied: Boolean(policy.models.find(m => m.id === outcome.model)?.reasoningControl?.verified) && decision.reasoningLevel !== 'off',
    keyFingerprint: req.goMetadata?.keyFingerprint ?? keyFingerprint(req.headers.authorization), ...outcome });
  scheduleCountersWrite();
  if (outcome.ok && req.routingSessionKey) sessions.set(req.routingSessionKey, {
    model: outcome.model, expiresAt: Date.now() + policy.routing.sessionStickinessTtlMs,
    task: decision.analysis.task, tier: decision.analysis.tier, subTask: decision.analysis.subTask || null
  });
  const retainedOutcome = decisionLog.options?.logAnswerText && answerText
    ? { ...outcome, answerText: String(answerText).slice(0, 262144) } : outcome;
  decisionLog.write({ sessionFingerprint: req.goMetadata?.sessionFingerprint ?? sessionFingerprintOf(req.headers['x-session-id']), requestId: req.requestId,
    keyFingerprint: req.goMetadata?.keyFingerprint ?? keyFingerprint(req.headers.authorization), redactedBody: decisionLog.redact(body) }, decision, retainedOutcome);
  maybeJudgeRequest({ requestId: req.requestId, outcome, decision, body, answerText, sessionIdRaw: req.headers['x-session-id'], sessionFingerprint: req.goMetadata?.sessionFingerprint });
}

async function consumeGoSemantic(event, metadata) {
  const r = event.review;
  const attempted = r.status !== 'shadow_capacity_exhausted';
  counters.semantic.eligible += 1;
  if (attempted) counters.semantic.attempted += 1;
  if (r.status === 'error') counters.semantic.errors += 1;
  else if (attempted) counters.semantic.succeeded += 1;
  if (r.status === 'applied') counters.semantic.applied += 1;
  if (r.status === 'rejected_low_confidence') counters.semantic.rejectedLowConfidence += 1;
  if (r.rollout?.bucketKeySource) counters.semantic.bucketKeySource[r.rollout.bucketKeySource] = (counters.semantic.bucketKeySource[r.rollout.bucketKeySource] || 0) + 1;
  const disagreed = Boolean(r.proposedTask && (r.proposedTask !== r.baseTask || r.proposedTier !== r.baseTier || r.proposedModel !== r.baseModel));
  if (disagreed) counters.semantic.disagreed += 1;
  if (r.cascade?.level) {
    counters.semantic.byCascadeLevel[r.cascade.level] = (counters.semantic.byCascadeLevel[r.cascade.level] || 0) + 1;
    counters.semantic.cascadeLatency ??= {};
    const agg = counters.semantic.cascadeLatency[r.cascade.level] ||= { count: 0, sumMs: 0 };
    agg.count += 1; agg.sumMs += r.cascade.totalLatencyMs || 0;
  }
  const overheadCostYuan = r.overheadMicros === null ? null : r.overheadMicros / 1000000;
  if (r.usage) {
    if (overheadCostYuan !== null) await budgetTracker.chargeRouterOverhead(overheadCostYuan);
    counters.routingOverhead ??= { calls: 0, costYuan: 0, promptTokens: 0, completionTokens: 0 };
    counters.routingOverhead.calls += 1; counters.routingOverhead.costYuan += overheadCostYuan || 0;
    counters.routingOverhead.promptTokens += r.usage.prompt || 0; counters.routingOverhead.completionTokens += r.usage.completion || 0;
  }
  const review = { at: new Date().toISOString(), v: 1, requestId: metadata.requestId, keyFingerprint: metadata.keyFingerprint,
    core: 'go', status: r.status, configRevision: event.configRevision, disagreed,
    ...(r.status === 'error' ? { error: 'semantic_review_failed' } : {}),
    base: { task: r.baseTask, tier: r.baseTier, complexity: r.baseComplexity, model: r.baseModel },
    proposed: { task: r.proposedTask, tier: r.proposedTier, complexity: r.proposedComplexity, model: r.proposedModel },
    assessment: { task: r.proposedTask, tier: r.proposedTier, complexity: r.proposedComplexity, confidence: r.confidence, model: r.classifierModel, cascade: r.cascade },
    cascade: r.cascade?.level || null, cascadeLatencyMs: r.cascade?.totalLatencyMs ?? r.latencyMs,
    smallLatencyMs: r.cascade?.smallLatencyMs ?? null, largeLatencyMs: r.cascade?.largeLatencyMs ?? null,
    totalLatencyMs: r.cascade?.totalLatencyMs ?? r.latencyMs, overheadUsage: r.usage || null, overheadCostYuan,
    bucket: r.rollout?.bucket, bucketKey: r.rollout?.bucketKey, bucketKeySource: r.rollout?.bucketKeySource };
  recordSemanticReview(review); semanticLog.writeRaw(review); scheduleCountersWrite();
}

function nativeGoContext() {
  if (goConfigPublication.blocked() || shutdownManager.draining) return null;
  const revision = getConfigRevision(config);
  nativePolicies.set(revision, config);
  if (nativePolicies.size > 64) nativePolicies.delete(nativePolicies.keys().next().value);
  return { configRevision: revision, sessionProof: createHmac('sha256', semanticBucketSecret).update('go-native-front-v1').digest('hex'), marketSignals: Object.fromEntries(['default', 'coding', 'reasoning', 'creative', 'extraction'].map(task =>
    [task, Object.fromEntries(config.models.map(m => [m.id, marketSignal.adjustFor(task, m.id)]))])) };
}

function prepareNativeGoEvent(event, validateEvent) {
  const policy = nativePolicies.get(event.configRevision);
  const metadata = event.nativeMetadata || event.request?.metadata;
  if (!policy || !metadata || typeof metadata.requestId !== 'string' || !metadata.requestId || metadata.requestId.length > 256 ||
      !/^[a-f0-9]{8}$/.test(metadata.keyFingerprint) ||
      (metadata.sessionFingerprint !== '' && !/^sidfp:[a-f0-9]{16}$/.test(metadata.sessionFingerprint)) ||
      !metadata.latencyScopes || Object.values(metadata.latencyScopes).some(v => !/^[a-f0-9]{24}$/.test(v))) throw new Error('invalid_native_metadata');
  if (event.kind === 'semantic') {
    const r = event.review;
    if (!r || !['error', 'shadow_complete', 'applied', 'rejected_low_confidence', 'shadow_capacity_exhausted'].includes(r.status) ||
        !Number.isFinite(r.confidence) || r.confidence < 0 || r.confidence > 1 ||
        !(r.overheadMicros === null || Number.isSafeInteger(r.overheadMicros) && r.overheadMicros >= 0)) throw new Error('invalid_native_semantic');
    return () => consumeGoSemantic(event, metadata);
  }
  const { body, events } = event.request, result = event.result;
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages) || !Array.isArray(events) || events.length > 16 ||
      !result || !Number.isSafeInteger(result.startedAt) || typeof result.ok !== 'boolean' ||
      typeof result.stream !== 'boolean' || !result.timing || typeof result.answerText !== 'string' || result.answerText.length > 65536 ||
      !Number.isInteger(result.status) || result.status < 100 || result.status > 599) throw new Error('invalid_native_completion');
  const models = new Set(policy.models.map(m => m.id));
  const indexes = new Set();
  for (const e of events) {
    validateEvent(e, { revision: event.configRevision, models });
    if (e.id !== event.id || indexes.has(e.attempt.index) || !metadata.latencyScopes[e.attempt.model]) throw new Error('invalid_native_attempt');
    indexes.add(e.attempt.index);
  }
  events.sort((a, b) => a.attempt.index - b.attempt.index);
  return async () => {
    counters.total += 1;
    const req = { requestId: metadata.requestId, goMetadata: { ...metadata, sessionFingerprint: metadata.sessionFingerprint || null }, headers: {} };
    const options = goCompletionOptions(req, body, isAutoRequest(body, policy), policy);
    for (const e of events) await options.onAttempt(e);
    await options.onComplete({ ...result, events, last: events.at(-1) });
  };
}

async function proxyGoCompletion(req, res, body, auto) {
  if (goConfigPublication.blocked()) return errorJson(res, 503, '配置发布尚未完成，请稍后重试', 'core_publication_pending');
  return goCoreEdge.proxy(req, res, body, goCompletionOptions(req, body, auto));
}

function goCompletionOptions(req, body, auto, policy = config) {
  const observationHealth = structuredClone(health);
  counters[auto ? 'auto' : 'explicit'] += 1;
  return {
    configRevision: getConfigRevision(policy), models: policy.models.map(m => m.id), timeoutMs: policy.routing.requestTimeoutMs,
    onSemantic: consumeGoSemantic, semanticMetadata: { requestId: req.requestId, keyFingerprint: req.goMetadata?.keyFingerprint ?? keyFingerprint(req.headers.authorization) },
    marketSignals: Object.fromEntries(['default', 'coding', 'reasoning', 'creative', 'extraction'].map(task =>
      [task, Object.fromEntries(policy.models.map(m => [m.id, marketSignal.adjustFor(task, m.id)]))])),
    onAttempt: async event => {
      const attempt = goAttempt(event);
      // Mirror observations into the existing management ledger. Go exclusively
      // owns admission and its durable ledger; Node does not enforce this mirror.
      await budgetTracker.observeCompletedAttempt(attempt.estimatedCostYuan, attempt.actualCostYuan, attempt.costFromUsage);
      if (attempt.usage && attempt.costFromUsage) {
        counters.tokens ??= {};
        counters.tokens.prompt = (counters.tokens.prompt || 0) + attempt.usage.prompt;
        counters.tokens.completion = (counters.tokens.completion || 0) + attempt.usage.completion;
      }
      if (!attempt.ok) counters.failures = (counters.failures || 0) + 1;
      scheduleCountersWrite();
    },
    onComplete: result => {
      const timings = counters.responseTimingsV2 ||= {};
      const outcome = goOutcome(result);
      observeLatency(timings, outcome.ok ? 'completion' : 'failedCompletion', outcome.completionLatencyMs);
      observeLatency(timings, 'headers', outcome.responseHeaderLatencyMs);
      observeLatency(timings, 'ttft', outcome.ttftMs);
      observeLatency(timings, 'firstOutput', outcome.firstOutputMs);
      counters[outcome.ok ? 'success' : 'errors'] += 1;
      counters.outcome[auto ? 'auto' : 'explicit'][outcome.ok ? 'success' : 'error'] += 1;
      if (result.stream) { counters.stream ??= { completed: 0, aborted: 0 }; counters.stream[outcome.ok ? 'completed' : 'aborted'] += 1; }
      if (result.last) {
        const decision = goDecision(result.last, policy);
        attachGoLatencyObservation(decision, policy, { health: observationHealth,
          ...latencyRuntime(body, (req.goMetadata || req.headers.authorization)), budgetPressure: 0 });
        if (auto) latencyStore.noteShadow(decision.latencyShadow, decision.candidates);
        counters.suggested[decision.suggestedModel] = (counters.suggested[decision.suggestedModel] || 0) + 1;
        counters.task[decision.analysis.task] = (counters.task[decision.analysis.task] || 0) + 1;
        counters.fallback += Math.max(0, result.events.length - 1);
        if (outcome.ok) {
          counters.selected[outcome.model] = (counters.selected[outcome.model] || 0) + 1;
          const by = counters.selectedBy[outcome.model] ||= { explicit: 0, auto: 0, autoPreference: 0 };
          by[auto ? 'auto' : 'explicit'] += 1;
          if (auto && decision.preference?.model === outcome.model) by.autoPreference += 1;
        }
        for (const event of result.events) {
          const a = goAttempt(event), m = policy.models.find(m => m.id === a.model);
          const context = latencyContextFor(m, body, decision.analysis, decision.reasoningLevel, (req.goMetadata || req.headers.authorization));
          const row = { ...context, at: Date.now(), ok: a.ok && (!event.attempt.ok || outcome.ok), failureScope: a.failureScope,
            timeout: a.timeout, ttftMs: a.model === outcome.model ? outcome.ttftMs : null,
            firstOutputMs: a.model === outcome.model ? outcome.firstOutputMs : null,
            upstreamTtftMs: a.timing.ttftMs, upstreamFirstOutputMs: a.timing.firstOutputMs, completionMs: outcome.completionLatencyMs, attemptMs: a.latencyMs };
          if (latencySettings().mode !== 'off') latencyStore.record(row);
          operations.record(row, req.requestId);
        }
        commitRequestOutcome({ req, body, decision, outcome, answerText: result.answerText, policy });
      }
      scheduleCountersWrite();
    }
  };
}

async function proxyCompletion(req, res) {
  const requestStarted = Date.now();

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

  try { body = await readJson(req); } catch (error) { return errorJson(res, error.status || 400, error.message, error.code || 'invalid_request_error'); }

  if (!Array.isArray(body.messages)) return errorJson(res, 400, 'messages 必须是数组', 'invalid_request_error');

  counters.total += 1; scheduleCountersWrite();

  const auto = isAutoRequest(body, config);

  if (goCoreEdge) return proxyGoCompletion(req, res, body, auto);

  let decision;

  if (auto) {

    counters.auto += 1; scheduleCountersWrite();

    try { decision = await resolveAutoDecision(body, { clientAuthHeader: req.headers.authorization, requestId: req.requestId, bucketKey: { sessionId: req.headers['x-session-id'] || null, keyFingerprint: keyFingerprint(req.headers.authorization), requestId: req.requestId } }); }

    catch (error) { counters.errors += 1; counters.outcome.auto.error += 1; scheduleCountersWrite(); return errorJson(res, 503, error.message, error.code || 'routing_unavailable'); }

  } else {

    counters.explicit += 1; scheduleCountersWrite();
    const rejectExplicit = (status, message, type) => {
      counters.errors += 1; counters.outcome.explicit.error += 1; scheduleCountersWrite();
      return errorJson(res, status, message, type);
    };

    const model = config.models.find((x) => x.id === body.model && x.enabled);

    if (!config.routing.allowExplicitModel) return rejectExplicit(403, '当前策略不允许显式选择模型');

    if (!model) return rejectExplicit(400, `模型不存在或未启用: ${body.model}`, 'invalid_request_error');

    // explicit：reasoningLevel 不再硬编码 off——按请求本身复杂度定档（点名思考型模型问复杂问题应保留思考）

    const explicitAnalysis = analyzeRequest(body, config);
    if (model.contextWindow && explicitAnalysis.estimatedContextTokens > model.contextWindow) {
      return rejectExplicit(400, '完整请求与输出预留超过所选模型的上下文窗口（启发式估算）', 'context_length_exceeded');
    }
    const missingCapabilities = capabilityEligible(model, explicitAnalysis.requirements);
    if (missingCapabilities.length) return rejectExplicit(400, `所选模型不支持请求能力: ${missingCapabilities.join(', ')}`, 'unsupported_capability');

    const explicitLevel = recommendReasoningLevel(explicitAnalysis, config);
    if (!completionBudgetEligible(body, model, config, explicitLevel)) return rejectExplicit(400, '输出预算低于思考预留；请增加预算，或使用已验证的参数显式关闭思考', 'completion_budget_too_low');

    decision = { requestedModel: body.model, selectedModel: body.model, suggestedModel: body.model, shadow: false, analysis: { ...explicitAnalysis, task: 'explicit', tier: 'explicit', routeMethod: 'explicit' }, explicitTask: explicitAnalysis.task, reasoningLevel: explicitLevel, candidates: [], rejected: [], fallbackOrder: [body.model], configVersion: config.version };

  }

  decision.selectedModel = sessionModel(req, decision);
  decision.policyRevision = getConfigRevision(config) || null;
  if (auto) latencyStore.noteShadow(decision.latencyShadow, decision.candidates);

  counters.suggested[decision.suggestedModel] = (counters.suggested[decision.suggestedModel] || 0) + 1; scheduleCountersWrite();

  counters.task[decision.analysis.task] = (counters.task[decision.analysis.task] || 0) + 1; scheduleCountersWrite();

  const fallback = decision.fallbackOrder.filter((m) => m !== decision.selectedModel);

  const attempts = [decision.selectedModel, ...fallback].slice(0, auto ? config.routing.maxAttempts : 1);

  // 记账上下文（try/catch 外声明—— 修复 作用域 bug：markStreamOutcome/reserveId 原声明在 try 内，

  // catch 不可见，断流时先抛 ReferenceError 掩盖原始错误）。生命周期（每个 attempt 恰好一次）：

  // reserve(估算) → [成功: markOutcome(true) + settle(实际 usage；无 usage 保留估算)] | [失败: markOutcome(false) + settle(null) 保留估算]

  let reserveId = null;

  let estimatedCostYuan = null;

  let settledAttempt = false; // 预算落账闸（防 fallback 重试路径双结算）

  let outcomeSettled = true; // 成功/失败落账闸（true=无在途 attempt，调用 no-op）

  let actxCtx = null; // { model, started, ttftMs, isStream } 当前 attempt 快照
  const attemptOutcomes = [];
  const responseTimings = counters.responseTimingsV2 ||= {};
  const observeAttempt = (c, ok, error) => {
    if (!c || c.latencyRecorded || !c.attempt?.upstreamStarted || !c.observation) return;
    c.latencyRecorded = true;
    const at = Date.now(), snap = c.streamTiming?.snapshot(), offset = (c.upstreamAt || c.started) - requestStarted;
    const row = { ...c.observation, at, ok, failureScope: c.attempt.failureScope || null,
      timeout: /超时|timeout/i.test(String(error?.message || '')),
      ttftMs: snap?.firstContentMs ?? null, firstOutputMs: snap?.firstOutputMs ?? null,
      upstreamTtftMs: snap?.firstContentMs == null ? null : Math.max(0, snap.firstContentMs - offset),
      upstreamFirstOutputMs: snap?.firstOutputMs == null ? null : Math.max(0, snap.firstOutputMs - offset),
      completionMs: at - requestStarted, attemptMs: at - (c.upstreamAt || c.started) };
    c.attempt.timing = { ttftMs: row.upstreamTtftMs, firstOutputMs: row.upstreamFirstOutputMs, completionMs: row.attemptMs };
    if (latencySettings().mode !== 'off') latencyStore.record(row);
    operations.record(row, req.requestId);
  };
  const applyFailureHealth = (model, error) => {
    const classification = classifyUpstreamFailure(error, { clientGone });
    if (classification.countModelFailure) updateHealth(model, false, Date.now() - (actxCtx?.started || requestStarted));
    else releaseCircuitAttempt(health[model]);
    return classification;
  };

  // —— 客户端断开哨兵 + 非流式交付守卫 ——

  // 哨兵在 attempts 循环前注册：客户端在任何阶段断开（含服务端还在等上游响应头时）都能捕获；

  // 非流式 close 时按「writableFinished && delivered」判成功/失败。流式 close 交给流转发循环的

  // 异常路径（断流时 res.write 抛错或上游迭代器抛错进 catch），此守卫不重复落账（outcomeSettled 闸兜底）。

  let clientGone = Boolean(res.destroyed);

  const delivery = { delivered: false, usage: null, log: null, guardActive: false };

  // 与成功计数（outcomeSettled）各有闸门，

  // 唯独 decisionLog.write 无闸——成功流式会双写（close 守卫 + res.end 回调各一次，本地 200 条

  // 实测 9 个重复 requestId），污染市场信号/胜率/训练集。收敛为请求级唯一写入口：无论成功、

  // 失败、断开，每个请求恰好落一条 outcome 日志（顺带补齐 mid-flight 断流/客户端早退此前

  // 完全不落日志的缺口——同一正确性类别）。

  let requestLogWritten = false;

  // judge：请求级上下文。answerText 由两条交付路径（非流式 res.end 前 / 流式落账前）

  // 填充（64KB 软上限），writeOutcomeLog 首次落账时交给异步 judge 管线（fire-and-forget）。


  // 解析 choices[0].message.content；流式经 SSE 收集器增量提取 delta.content。Judge 不再见

  // 响应信封（usage/chunk JSON/data:/[DONE]）。解析失败 → null → 评分跳过（评信封不如不评）。

  const judgeCtx = { answerText: null, collector: createAnswerCollector(65536) };

  const writeOutcomeLog = (outcome) => {

    if (requestLogWritten) return;

    requestLogWritten = true;
    const completionLatencyMs = Date.now() - requestStarted;
    const streamTiming = actxCtx?.streamTiming?.snapshot();
    observeLatency(responseTimings, outcome.ok ? 'completion' : 'failedCompletion', completionLatencyMs);
    outcome = { ...outcome, latencyMs: completionLatencyMs, completionLatencyMs,
      responseHeaderLatencyMs: actxCtx?.headerLatencyMs ?? null,
      ttftMs: streamTiming?.firstContentMs ?? null, firstOutputMs: streamTiming?.firstOutputMs ?? null,
      timingVersion: 2, transportOk: Boolean(outcome.ok), taskSuccess: null,
      attempts: attemptOutcomes.map(item => ({ ...item })),
      totalAttemptCostYuan: attemptOutcomes.some(a => a.actualCostYuan == null && a.estimatedCostYuan == null) ? null
        : attemptOutcomes.reduce((sum, a) => sum + (a.actualCostYuan ?? a.estimatedCostYuan), 0),
      totalAttemptCostKind: attemptOutcomes.some(a => a.actualCostYuan == null && a.estimatedCostYuan == null) ? 'unknown'
        : attemptOutcomes.every(a => a.actualCostYuan != null) ? 'actual' : 'estimated_or_mixed' };
    commitRequestOutcome({ req, body, decision, outcome, answerText: judgeCtx.answerText });

  };

  const onClientClose = () => {

    clientGone = true;

    if (!delivery.guardActive) {
      controller?.abort(new Error('client_disconnected'));

      // attempt 前段（等上游响应头/读上游 body）客户端断开：无在途响应可交付，记客户端写失败


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
    if (actxCtx?.attempt) {
      actxCtx.attempt.actualCostYuan = actxCtx.attempt.upstreamStarted === false ? 0 : Number.isFinite(actualYuan) ? actualYuan : null;
      actxCtx.attempt.costFromUsage = Boolean(fromUsage);
      actxCtx.attempt.latencyMs = Date.now() - actxCtx.started;
    }

    if (reserveId == null) return;

    const id = reserveId; reserveId = null;

    if (actxCtx?.attempt?.upstreamStarted === false) budgetTracker.release(id).catch(() => {});
    else budgetTracker.settle(id, actualYuan, fromUsage).catch(() => {});

  };

  const markSelectedBy = (model) => {

    counters.selected[model] = (counters.selected[model] || 0) + 1; scheduleCountersWrite();

    const selectedBy = counters.selectedBy[model] ||= { explicit: 0, auto: 0, autoPreference: 0 };

    if (!auto) selectedBy.explicit += 1;

    else if (decision.preference?.model === model) { selectedBy.autoPreference += 1; selectedBy.auto += 1; }

    else selectedBy.auto += 1;

  };

  // 单次落账：成功只在「响应体完整交付」后记；失败只在 mid-flight 中断记

  // （attempt 前段失败由 catch 的 updateHealth+post-loop counters.errors 记，不在此重复）

  const markOutcome = (ok, err) => {

    if (outcomeSettled || !actxCtx) return; outcomeSettled = true;

    const c = actxCtx;

    if (ok) {

      const firstOutput = c.streamTiming?.snapshot().firstOutputMs;
      updateHealth(c.model, true, firstOutput == null ? Date.now() - c.started : Math.max(0, firstOutput - (c.started - requestStarted)));

      maybePromoteVerified(c.model);

      counters.success += 1; scheduleCountersWrite();

      counters.outcome[c.auto ? 'auto' : 'explicit'].success += 1; scheduleCountersWrite();

      markSelectedBy(c.model);

      if (c.isStream) { counters.stream ??= { completed: 0, aborted: 0 }; counters.stream.completed += 1; }

    } else {

      const failure = applyFailureHealth(c.model, err);
      if (c.attempt) c.attempt.failureScope = failure.scope;

      counters.failures += 1; scheduleCountersWrite();

      counters.outcome[c.auto ? 'auto' : 'explicit'].error += 1;

      if (c.isStream) { counters.stream ??= { completed: 0, aborted: 0 }; counters.stream.aborted += 1; }

      if (err) logger.warn(c.isStream ? 'stream_aborted' : 'client_write_failed', { requestId: req.requestId, model: c.model, error: String(err.message || err) });

    }
    if (c.attempt) c.attempt.ok = ok;
    observeAttempt(c, ok, err);

  };

  // 修

  // 第一次超时 abort 后 signal 永久失效，后续 fallback 复用已 aborted 的 signal 立即失败，

  // 「每次尝试独立计时」只重置了 timer 没重建 controller，超时必然污染整个 fallback 链。

  let controller = null;

  // 超时语义 修复流式长回答被掐）：

  // 非流式 = 整请求总超时；流式 = 闲置超时（收到任何上游数据即续命）。

  // 旧实现对流式也用一次性总超时——dsf 长回答（31 tok/s，10k 字≈110s+）撞 120s 线被 abort，

  // 客户端表现为流中断后反复续写仍截断。闲置超时只杀真堵死（无数据流动）的连接。

  const timeoutMs = Number(config.routing.requestTimeoutMs) || 120000;

  let timer = null;

  const armTimer = () => {

    clearTimeout(timer);

    timer = setTimeout(() => controller.abort(new Error(`上游请求超时（${body.stream ? '数据停滞' : '总时长'} 超过 ${Math.round(timeoutMs / 1000)}s）`)), timeoutMs);

  };

  let lastError;
  let lastAttemptedModel = null;

  for (let i = 0; i < attempts.length; i += 1) {

    const model = attempts[i];

    const attemptModelConfig = config.models.find(item => item.id === model);
    const releaseLoad = modelLoad.acquire(attemptModelConfig, config.routing);
    if (!releaseLoad) {
      if (!lastError) { lastError = new Error('所选合格模型的本进程并发额度已用满'); lastError.code = 'model_capacity_exhausted'; lastError.failureScope = 'capacity'; }
      continue;
    }
    if (!claimCircuitAttempt(model)) { releaseLoad(); continue; }
    res.once('close', releaseLoad);
    lastAttemptedModel = model;

    const started = Date.now();

    controller = new AbortController(); // 新 attempt 新 signal

    armTimer(); // 每次尝试独立计时（旧实现 timer 在循环外只设一次，attempt 2 继承剩余预算）

    try {
      const selectedConfig = config.models.find((item) => item.id === model);
      estimatedCostYuan = estimateCostYuan(body, decision.analysis, selectedConfig, config, decision.reasoningLevel);
      const attempt = { model, estimatedCostYuan, actualCostYuan: null, ok: null, upstreamStarted: false };
      attemptOutcomes.push(attempt);
      actxCtx = { model, started, headerLatencyMs: null, isStream: body.stream === true, auto, attempt,
        streamTiming: body.stream === true ? createStreamTimingObserver(requestStarted) : null };
      reserveId = await budgetTracker.reserve(estimatedCostYuan);
      settledAttempt = false; outcomeSettled = false;
      if (clientGone) {
        markOutcome(false, new Error('client_disconnected'));
        settleAttempt(0, false); // No upstream call was made.
        writeOutcomeLog({ ok: false, model, error: 'client_disconnected' });
        clearTimeout(timer); return;
      }

      // 飞轮：流式请求带上 stream_options.include_usage，上游会在最后一个 chunk 附带 usage

      if (body.stream === true) body.stream_options = { ...(body.stream_options || {}), include_usage: true };

      attempt.upstreamStarted = true;
      actxCtx.upstreamAt = Date.now();
      actxCtx.observation = latencyContextFor(selectedConfig, body, decision.analysis, decision.reasoningLevel, req.headers.authorization);
      const upstream = await callUpstream(body, model, controller.signal, decision.reasoningLevel, req.headers.authorization);

      const latency = Date.now() - started;
      actxCtx.headerLatencyMs = latency;
      observeLatency(responseTimings, 'headers', latency);

      if (!upstream.ok) {
        lastError = new Error(`上游 ${model} 调用失败（HTTP ${upstream.status}）`);
        lastError.upstreamStatus = upstream.status;
        lastError.retryable = upstream.status === 408 || upstream.status >= 500;
        attempt.upstreamStatus = upstream.status;
        // Status is already authoritative. A truncated/hanging error body must
        // not turn a known tenant rejection into a global transport failure.
        logger.warn('upstream_error', { requestId: req.requestId, model, status: upstream.status });
        await upstream.body?.cancel().catch(() => {});
        throw lastError;

      }

      // 客户端已在等待上游期间断开：响应无处交付，记失败结账直接返回——

      // 已预占的调用保守结算；无人接收结果时不再 fallback。

      if (clientGone) {

        markOutcome(false, new Error('client_disconnected'));
        settleAttempt(null, false);
        await upstream.body?.cancel().catch(() => {});

        logger.warn('client_abandoned_upstream_wait', { requestId: req.requestId, model, latencyMs: Date.now() - started });

        writeOutcomeLog({ ok: false, model, error: 'client_disconnected', latencyMs: Date.now() - started });

        clearTimeout(timer);

        return res.destroy();

      }

      // 飞轮：转发前先判定是否流式——流式不缓冲整个响应（内存安全），usage 从 SSE 尾块解析

      const isStream = body.stream === true;

      let usage = null;

      // 记账纪律：首包到达 ≠ 成功。非流式：响应体整体读完才算成功（text 后记）；

      // 流式首段正文在 SSE 事件中观测，响应头延迟单独记录。

      // 有 usage 按实际 token 冲正；无 usage 保留估算并标记 estimated

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

        // fix four-review 

        // already settled via guardActive=false branch (outcomeSettled=true, reserve closed) — continuing here would

        // write to a dead socket and add tokens nobody received. Early return prevents ghost success.

        if (clientGone) {

          clearTimeout(timer);

          logger.warn('client_abandoned_during_body_read', { requestId: req.requestId, model });

          writeOutcomeLog({ ok: false, model, error: 'client_disconnected_during_body_read', usage, latencyMs: latency });

          return;

        }

        // Success accounting stays with the close guard fix): delivered-then-finished semantics.

      }

      // 实际成本：有 usage 时按真实 token 结算（对账口径），否则保留预估值

      const actualCostYuan = usage ? computeActualCostFromUsage(usage, selectedConfig) : null;

      if (actualCostYuan != null) { counters.tokens ??= {}; counters.tokens.prompt = (counters.tokens.prompt || 0) + usage.prompt; counters.tokens.completion = (counters.tokens.completion || 0) + usage.completion; }

      // 日志先组装不落盘（流式的 usage 在流尾才知道）——转发完成后统一 write

      const logEntry = { sessionFingerprint: sessionFingerprintOf(req.headers['x-session-id']), requestId: req.requestId, keyFingerprint: keyFingerprint(req.headers.authorization), redactedBody: decisionLog.redact(body) };

      const logOutcome = { ok: true, model, latencyMs: latency, fallbackAttempt: i, estimatedCostYuan, actualCostYuan, usage };

      const headers = {

        'content-type': upstream.headers.get('content-type') || (body.stream ? 'text/event-stream' : 'application/json'),

        'cache-control': 'no-cache',

        'x-router-selected-model': model,

        'x-router-suggested-model': decision.suggestedModel,

        'x-router-task': decision.analysis?.task || '',

        'x-router-cost-tier': config.routing?.costTier || 'custom',

        'x-router-policy-version': String(config.version),
        'x-router-policy-revision': decision.policyRevision || 'unknown',
        'x-router-quality-degraded': String(Boolean(decision.qualityDegraded)),

        'x-router-shadow': String(decision.shadow),

        'x-router-reasoning-level': decision.reasoningLevel,

        'x-router-route-method': decision.analysis.routeMethod || 'rules'

      };

      res.writeHead(200, headers);

      if (!upstream.body) { clearTimeout(timer); delivery.delivered = true; delivery.guardActive = true; return void res.end(); } // 无 body 上游（304 类）：close 守卫结清

      if (responseText !== null) {

        // 非流式：一次性写回。成功落账由 close 守卫按「writableFinished && delivered」判定——

        // 修 读毕即记成功，客户端已断开时记了假成功。

        delivery.usage = usage;

        delivery.log = { entry: logEntry, outcome: usage ? { ...logOutcome, usage, actualCostYuan: usage.prompt != null && usage.completion != null ? computeActualCostFromUsage(usage, selectedConfig) : logOutcome.actualCostYuan } : logOutcome };

        delivery.delivered = true;

        delivery.guardActive = true;

        judgeCtx.answerText = extractNonStreamAnswerText(responseText); // 

        clearTimeout(timer); return void res.end(responseText);

      }

      // 流式：逐块转发（背压安全），并从 SSE 尾块提取 usage（飞轮：实际 token 消耗）

      // 超时续命：每收到一个 chunk 重置闲置计时器——只要上游还在产 token 就不掐

      // 注意：undici 的 chunk 是 Uint8Array，toString('utf8') 不生效（会输出字节数字）——必须 Buffer 化

      const tailChunks = []; let tailBytes = 0;

      const trimTail = () => { if (tailBytes > 8192) { const merged = Buffer.concat(tailChunks).subarray(-4096); tailChunks.length = 0; tailChunks.push(merged); tailBytes = merged.length; } };

      // judge：流式回答全文累积（软上限 64KB——超过即截断保留头部，防长流撑内存）


      // judge 拿到的是纯正文（usage/[DONE]/chunk JSON 不再进评分输入）

      for await (const chunk of upstream.body) {

        if (body.stream === true) armTimer(); // 流式闲置超时：有数据流动就续命
        const before = actxCtx.streamTiming?.snapshot();
        actxCtx.streamTiming?.push(chunk);
        const after = actxCtx.streamTiming?.snapshot();
        if (before?.firstContentMs === null && after?.firstContentMs != null) observeLatency(responseTimings, 'ttft', after.firstContentMs);
        if (before?.firstOutputMs === null && after?.firstOutputMs != null) observeLatency(responseTimings, 'firstOutput', after.firstOutputMs);

        if (!res.write(chunk)) await new Promise((resolve, reject) => {
          const cleanup = () => { res.off('drain', drained); res.off('close', closed); };
          const drained = () => { cleanup(); resolve(); };
          const closed = () => { cleanup(); reject(new Error('client_disconnected')); };
          res.once('drain', drained); res.once('close', closed);
        });

        tailChunks.push(Buffer.from(chunk)); tailBytes += chunk.length; trimTail();

        judgeCtx.collector.push(chunk); // 字节边界安全（只在 \n 切行，UTF-8 多字节序列不含 0x0a）

      }

      const timingBeforeFinish = actxCtx.streamTiming?.snapshot();
      actxCtx.streamTiming?.finish();
      const timingAfterFinish = actxCtx.streamTiming?.snapshot();
      if (timingBeforeFinish?.firstContentMs === null && timingAfterFinish?.firstContentMs != null) observeLatency(responseTimings, 'ttft', timingAfterFinish.firstContentMs);
      if (timingBeforeFinish?.firstOutputMs === null && timingAfterFinish?.firstOutputMs != null) observeLatency(responseTimings, 'firstOutput', timingAfterFinish.firstOutputMs);
      const sseTail = Buffer.concat(tailChunks).toString('utf8');

      if (isStream && !usage) usage = extractUsage('text/event-stream', sseTail);

      judgeCtx.answerText = judgeCtx.collector.text(); // 交付路径终点取纯正文（收集器全程在转发循环外喂——见下方 push 调用点）

      // 修 在

      // res.end 前——只证明上游完整，不证明客户端收完尾部数据）。改为 res.end 回调后落账。

      // 时序陷阱（首轮实现踩中）：undici 客户端收完 body 会立即关连接，close 事件可抢在

      // end 回调之前到达——若此刻守卫未激活（guardActive=false），成功流被误记 client_disconnected。

      // 因此发起 end 前先激活守卫并标记 delivered：close 与 end 回调谁先到都只落一次账

      // （outcomeSettled 闸互斥；writableFinished 区分「收完才关」与「没收完就断」）。

      delivery.usage = usage;

      delivery.log = { entry: logEntry, outcome: usage ? { ...logOutcome, usage, actualCostYuan: usage.prompt != null && usage.completion != null ? computeActualCostFromUsage(usage, selectedConfig) : logOutcome.actualCostYuan } : logOutcome };

      delivery.delivered = true;

      delivery.guardActive = true;

      // 提取（上一行），此处无需再赋值

      const streamDone = new Promise((resolve) => res.end(() => resolve()));

      await streamDone;

      markOutcome(true);

      settleWithUsage(usage);


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
      if (error.failureScope === 'configuration' && actxCtx?.attempt) actxCtx.attempt.upstreamStarted = false;

      delivery.guardActive = false; // 本 attempt 已死，close 守卫不再按交付状态落账（防旧 attempt 污染下一 attempt）

      if (clientGone && !res.headersSent) {
        markOutcome(false, new Error('client_disconnected'));
        releaseCircuitAttempt(health[model]);
        settleAttempt(null, false);
        writeOutcomeLog({ ok: false, model, error: 'client_disconnected' });
        clearTimeout(timer); return;
      }
      if (res.headersSent) {

        // mid-flight 中断（流式断流/非流式写回失败）：单次失败落账 + 预算保留估算



        markOutcome(false, error);

        settleAttempt(null, false);

        writeOutcomeLog({ ok: false, model, error: String(error.message || error).slice(0, 500), latencyMs: Date.now() - started, fallbackAttempt: i });

        clearTimeout(timer); res.destroy(error); return;

      }

      // attempt 前段失败（尚未发送响应头）：预算结算 + 健康降权，请求级错误由循环外 counters.errors 统一记

      settleAttempt(null, false);

      outcomeSettled = true; // 该 attempt 已死，防后续误落成功账

      const failureClass = applyFailureHealth(model, error);
      if (actxCtx?.attempt) { actxCtx.attempt.failureScope = failureClass.scope; actxCtx.attempt.ok = false; }
      observeAttempt(actxCtx, false, error);
      if (failureClass.retryable && i + 1 < attempts.length) { counters.fallback += 1; scheduleCountersWrite(); continue; }

      break;

    } finally { res.off('close', releaseLoad); releaseLoad(); }

  }

  clearTimeout(timer);

  counters.errors += 1; scheduleCountersWrite();

  counters.outcome[auto ? 'auto' : 'explicit'].error += 1; scheduleCountersWrite();


  writeOutcomeLog({ ok: false, model: lastAttemptedModel, upstreamStatus: lastError?.upstreamStatus ?? null,
    failureScope: classifyUpstreamFailure(lastError).scope, error: (lastError?.message || '').slice(0, 500) });
  const upstreamStatus = Number(lastError?.upstreamStatus);
  const status = lastError?.code === 'model_capacity_exhausted' ? 503 : upstreamStatus >= 400 && upstreamStatus < 500 ? upstreamStatus : 502;
  if (status === 503) res.setHeader('retry-after', '1');
  return errorJson(res, status, lastError?.message || '所有候选模型均调用失败', lastError?.code || 'upstream_error');

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

  if (url.pathname === '/internal/v1/go-events' || url.pathname === '/internal/v1/go-context') {
    if (!goCoreEdge) return errorJson(res, 404, '未启用 Go 请求链路', 'not_found');
    return goCoreEdge.accept(req, res);
  }

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

    await refreshGoRuntime();
    const disk = await decisionLog.diskUsage();

    const body = renderPrometheusMetrics({ counters: { ...counters, judge: { ...judgeCounters, gaugeCircuit: judgeGuard.snapshot().circuit === 'open' ? 2 : (judgeGuard.snapshot().circuit === 'half-open' ? 1 : 0), guardCalls: judgeGuard.snapshot().calls, guardTokens: judgeGuard.snapshot().tokens } }, health, modelLoad: runtimeModelLoad(), budget: budgetTracker.snapshot(), decisionLog: { ...decisionLog.snapshot(), diskUsage: disk }, config, sessions: goCoreEdge ? goRuntimeSnapshot.sessions : sessions.size, draining: shutdownManager.draining, inflight: shutdownManager.inflightCount() });

    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });

    const coreMetrics = goCoreEdge ? `# TYPE amr_go_core_available gauge\namr_go_core_available ${goRuntimeSnapshot.available ? 1 : 0}\n# TYPE amr_go_edge_report_errors_total counter\namr_go_edge_report_errors_total ${goRuntimeSnapshot.edgeErrors || 0}\n` : '';
    return res.end(body + coreMetrics);

  }

  if (req.method === 'GET' && url.pathname === '/health') {
    const core = await refreshGoRuntime();
    const ok = !core || core.available;
    return json(res, ok ? 200 : 503, { status: shutdownManager.draining ? 'draining' : ok ? 'ok' : 'core_unavailable',
      configVersion: config.version, core: goCoreEdge ? 'go' : 'node', upstreamConfigured: Boolean(process.env.UPSTREAM_API_KEY || process.env.MAAS_API_KEY),
      upstreamMode: process.env.UPSTREAM_BASE_URL ? 'gateway' : 'direct_maas', uptimeSeconds: Math.round(process.uptime()), inflight: shutdownManager.inflightCount() });
  }

  if (req.method === 'GET' && url.pathname === '/health/ready') {

    const probe = await probeUpstream();

    const core = await refreshGoRuntime();
    const ready = probe.reachable && !shutdownManager.draining && (!core || core.available);

    return json(res, ready ? 200 : 503, { ready, status: ready ? 'ready' : 'not_ready', upstreamReachable: probe.reachable, upstreamStatus: probe.status ?? null, upstreamError: probe.error ?? null, configVersion: config.version, checkedAt: new Date().toISOString() });

  }

  if (req.method === 'GET' && url.pathname === '/v1/models') {

    // ——

    // 客户端模型选择器只应看到路由入口，池内模型是内部实现细节（点名仍走 allowExplicitModel）。

    const autoEntry = { id: autoModelId(config), object: 'model', owned_by: 'router' };

    const pool = config.routing.exposeModelList === 'all' ? config.models.filter((m) => m.enabled).map((m) => ({ id: m.id, object: 'model', owned_by: m.ownership })) : [];

    return json(res, 200, { object: 'list', data: [autoEntry, ...pool] });

  }

  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') return proxyCompletion(req, res);

  // ；其余 /admin/api/* 接受 Bearer 或会话 cookie
  if (req.method === 'POST' && url.pathname === '/admin/api/login') {
    const verdict = adminAuthLimiter.check('admin-login:' + (req.socket.remoteAddress || 'unknown'));
    if (!verdict.allowed) return json(res, 429, { error: { message: '登录尝试过于频繁，请稍后再试', type: 'rate_limit_exceeded', code: 429 } }, { 'retry-after': String(Math.ceil(verdict.retryAfterMs / 1000)) });
    try { const body = await readJson(req); if (!safeEqual(`Bearer ${body.token}`, `Bearer ${process.env.ADMIN_TOKEN}`) && !(process.env.ADMIN_TOKEN && safeEqual(body.token, process.env.ADMIN_TOKEN))) return errorJson(res, 401, 'Admin Token 无效', 'authentication_error'); const sid = randomBytes(32).toString('hex'); const now = Date.now(); adminSessions.set(sid, { lastSeen: now, absExpires: now + ADMIN_SESSION_ABS_MS }); return json(res, 200, { ok: true, expiresInMs: ADMIN_SESSION_IDLE_MS }, { 'set-cookie': `${ADMIN_SESSION_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(ADMIN_SESSION_ABS_MS / 1000)}${(req.socket?.encrypted || req.headers['x-forwarded-proto'] === 'https') ? '; Secure' : ''}` }); } catch { return errorJson(res, 400, '请求体必须是 JSON', 'invalid_request_error'); }
  }
  if (req.method === 'POST' && url.pathname === '/admin/api/logout') {
    const sid = parseCookies(req)[ADMIN_SESSION_COOKIE]; if (sid) adminSessions.delete(sid);
    return json(res, 200, { ok: true }, { 'set-cookie': `${ADMIN_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` });
  }
  if (url.pathname.startsWith('/admin/api/') && !authorizedAdmin(req)) {

    // 鉴权失败也限流（独立更严的桶）：否则 ADMIN_TOKEN 可被无限暴力破解

    const failKey = 'admin-auth-fail:' + (req.socket.remoteAddress || 'unknown');

    const verdict = adminAuthLimiter.check(failKey);

    if (!verdict.allowed) return json(res, 429, { error: { message: '鉴权失败次数过多，请稍后再试', type: 'rate_limit_exceeded', code: 429 } }, { 'retry-after': String(Math.ceil(verdict.retryAfterMs / 1000)) });

    return errorJson(res, 401, 'Admin Token 无效', 'authentication_error');

  }

  if (url.pathname === '/admin/api/go-core' || url.pathname === '/admin/api/go-core/reload') {
    res.setHeader('Cache-Control', 'no-store');
    if (!goCoreAdmin) return errorJson(res, 404, 'Go 管理接口未启用', 'core_control_disabled');
    if (url.search || !((req.method === 'GET' && url.pathname === '/admin/api/go-core') || (req.method === 'POST' && url.pathname === '/admin/api/go-core/reload'))) return errorJson(res, 405, '不支持的操作', 'method_not_allowed');
    try {
      const result = req.method === 'GET' ? await goCoreAdmin.status() : await goCoreAdmin.reload(req.headers['if-match']);
      if (result.status !== 200) return errorJson(res, result.status, 'Go 配置操作未成功，请重新查询生效版本', result.error);
      const { status, ...view } = result;
      res.setHeader('ETag', view.revision);
      return json(res, 200, { ...view, servesTraffic: Boolean(goCoreEdge), savedConfigRevision: getConfigRevision(config), ...(view.configRevision ? { synchronized: view.configRevision === getConfigRevision(config) } : {}) });
    } catch { return errorJson(res, 502, 'Go 管理接口不可用，请查询状态后再决定是否重试', 'core_control_unavailable'); }
  }
  if (req.method === 'GET' && url.pathname === '/admin/api/config') { res.setHeader('ETag', getConfigRevision(config)); res.setHeader('Cache-Control', 'no-store'); return json(res, 200, config); }
  // ── P1 模型发现：代理上游 GET /v1/models（30s 缓存），勾选注册用。key 永不出服务端。
  // v0.11.8：流水线向导第一步——管理员现场填端点+key 探测（POST，key 只用于本次请求，不落盘不回显不进日志）
  if (req.method === 'POST' && url.pathname === '/admin/api/discover-probe') {
    try {
      const body = await readJson(req);
      const base = String(body?.baseUrl || '').trim().replace(/\/$/, '');
      const key = String(body?.apiKey || '').trim();
      if (!key) return errorJson(res, 400, '请填写该端点的 API Key', 'invalid_request_error');
      // SSRF 防护：new URL 严格解析 + 主机名白名单（禁止 IP 直连与内网默认放行）
      let u;
      try { u = new URL(base); } catch { return errorJson(res, 400, '端点必须是合法 http(s) URL（如 https://host:port/v1）', 'invalid_request_error'); }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return errorJson(res, 400, '端点协议只允许 http/https', 'invalid_request_error');
      if (u.username || u.password || u.hash) return errorJson(res, 400, '端点不允许携带用户名/密码/fragment', 'invalid_request_error');
      const host = u.hostname.toLowerCase();
      // 拒绝 query；fetch 用规范化 URL（防 base 带 ?x=1 拼出 /v1?x=1/models）
      if (u.search) return errorJson(res, 400, '端点不允许携带 query 参数', 'invalid_request_error');
      // 测试逃生口：e2e 用 127.0.0.1 mock 上游（默认关——生产绝不设）。v0.11.13 收窄：仅放行 127.0.0.1 字面量，
      // 不再豁免域名白名单与其他 IP（原实现允许任意 IP+任意域名=生产误设即全开）
      const allowLoopbackOnly = process.env.AMR_PROBE_ALLOW_LOCALHOST === '1' && host === '127.0.0.1' && (u.port !== '');
      if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host === 'localhost' || host.endsWith('.localhost') || host.includes(':')) {
        if (!allowLoopbackOnly) return errorJson(res, 400, '不允许直接用 IP/localhost 作为端点——请使用域名（防内网探测）', 'invalid_request_error');
      }
      if (!allowLoopbackOnly && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) {
        return errorJson(res, 400, '端点主机名格式不合法', 'invalid_request_error');
      }
      const ALLOW = (process.env.DISCOVER_PROBE_ALLOW_HOSTS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
      if (!allowLoopbackOnly && (ALLOW.length ? !ALLOW.includes(host) : !/^(maas\.gd\.chinamobile\.com|api\.z\.ai)$/.test(host))) {
        return errorJson(res, 400, `端点 ${host} 不在允许清单（DISCOVER_PROBE_ALLOW_HOSTS 可扩展）`, 'invalid_request_error');
      }
      // DNS pinning：域名必须先解析，解析结果全部落在禁用网段则拒绝（RFC1918/loopback/
      // link-local(含云元数据 169.254.169.254)/IPv6 ULA/IPv4-mapped）。白名单域名解析异常也拒绝（fail-closed）。
      const ipIsBlocked = (ip) => {
        if (ip.includes('.')) {
          const o = ip.split('.').map(Number);
          if (o[0] === 127 || o[0] === 10 || o[0] === 0) return true;
          if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
          if (o[0] === 192 && o[1] === 168) return true;
          if (o[0] === 169 && o[1] === 254) return true;
          if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true; // CGNAT
          return false;
        }
        const v6 = ip.toLowerCase();
        if (v6 === '::' || v6 === '::1') return true;
        if (v6.startsWith('fe80:') || v6.startsWith('fc') || v6.startsWith('fd')) return true;
        if (v6.startsWith('::ffff:')) return ipIsBlocked(v6.slice(7)); // IPv4-mapped
        return false;
      };
      if (!allowLoopbackOnly) {
        let addrs;
        try { addrs = await dnsPromises.lookup(host, { all: true }); }
        catch { return errorJson(res, 400, `端点域名 ${host} 解析失败（DNS）`, 'invalid_request_error'); }
        const bad = addrs.filter((a) => ipIsBlocked(a.address));
        if (bad.length) return errorJson(res, 400, `端点域名解析到禁用网段（${bad.map((b) => b.address).join('、')}）——禁止内网/元数据探测`, 'invalid_request_error');
        // 剩余窗口的如实说明：fetch 时 Node/undici 会再次解析（rebinding TOCTOU）。
        // 现实风险评估：白名单默认仅企业自有域名（maas.gd.chinamobile.com / api.z.ai），攻击者需控制其 DNS
        // 才能利用；DISCOVER_PROBE_ALLOW_HOSTS 扩展时运营自负其责。http 端点可加 IP 直连+Host 头彻底闭环
        // （https 因 SNI/证书绑定不可行）。此处选择：http 端点用解析出的第一个非禁 IP 直连（真闭环），
        // https 端点接受窗口（默认白名单域名全为 https 且可信）。
        if (u.protocol === 'http:') {
          const safeIp = addrs.find((a) => !ipIsBlocked(a.address));
          if (safeIp) {
            // IP 直连（真闭环：无二次解析窗口）+ Host 头保上游路由
            const hostForUrl = safeIp.address.includes(':') ? `[${safeIp.address}]` : safeIp.address; // IPv6 须括号否则 Invalid URL
            const ipUrl = new URL(`${u.protocol}//${hostForUrl}${u.port ? ':' + u.port : ''}${u.pathname.replace(/\/$/, '')}/models`);
            const res3 = await fetch(ipUrl, { headers: { authorization: `Bearer ${key}`, host: u.host }, signal: AbortSignal.timeout(15000), redirect: 'error' });
            if (!res3.ok) return errorJson(res, 502, `端点返回 HTTP ${res3.status}——请核对 URL 与 Key（key 是否有 /models 权限）`, 'discover_probe_error');
            const payload3 = await res3.json();
            const list3 = Array.isArray(payload3?.data) ? payload3.data : Array.isArray(payload3) ? payload3 : [];
            const registered3 = new Set((config.models || []).map((m) => m.id));
            const models3 = list3.map((m) => ({ id: m.id, registered: registered3.has(m.id), ownedBy: m.owned_by || null }));
            return json(res, 200, { total: models3.length, models: models3, upstream: { baseUrl: base, keyMasked: key.length <= 8 ? '…' + key.slice(-2) : key.slice(0, 6) + '…' + key.slice(-4) } });
          }
        }
      }
      const probeUrl = new URL(u.toString().replace(/\/$/, '') + '/models');
      const res2 = await fetch(probeUrl, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000), redirect: 'error' });
      if (!res2.ok) return errorJson(res, 502, `端点返回 HTTP ${res2.status}——请核对 URL 与 Key（key 是否有 /models 权限）`, 'discover_probe_error');
      const payload = await res2.json();
      const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
      const registered = new Set((config.models || []).map((m) => m.id));
      const models = list.map((m) => ({ id: m.id, registered: registered.has(m.id), ownedBy: m.owned_by || null }));
      return json(res, 200, { total: models.length, newCount: models.filter((m) => !m.registered).length, models,
        upstream: { baseUrl: base, keyMasked: key.length <= 8 ? '…' + key.slice(-2) : key.slice(0, 6) + '…' + key.slice(-4) } });
    } catch (error) { return errorJson(res, 502, `探测失败：${error.message}（URL 拼写/网络可达性/Key 有效性）`, 'discover_probe_error'); }
  }
  if (req.method === 'GET' && url.pathname === '/admin/api/discover-models') {
    try {
      const r = await fetchUpstreamModels();
      return json(res, 200, r);
    } catch (error) { return errorJson(res, 502, `上游模型列表获取失败：${error.message}`, 'discover_models_error'); }
  }
  // ── P3 下线检测（v0.10.2 重做）：独立于熔断的状态模型——
  // 熔断 3 次失败即隔离、冷却仅 30s：常规调用停止后 consecutiveFailures 涨不动、
  // circuitOpenUntil 永远 <1h，旧条件（≥20 次失败/熔断≥1h）在正常机制下不可达。
  // 改用 downSince（首次失败时刻）+ 半开探针连败：
  //   持续不可用 ≥30min，或 半开探针连败 ≥3 次且持续 ≥10min。
  if (req.method === 'GET' && url.pathname === '/admin/api/model-offline-alerts') {
    const alerts = [];
    for (const m of config.models || []) {
      if (!m.enabled) continue;
      const h = health[m.id];
      if (!h) continue;
      // v0.10.5：判定收敛到 src/health.mjs 的 offlineAlertDue()（与单测共用同一实现，防测试与生产漂移）
      if (!offlineAlertDue(h)) continue;
      const downMin = (Date.now() - h.downSince) / 60000;
      const probeStreak = h.halfOpenFailStreak || 0;
      const longDown = downMin >= 30;
      const probeDead = probeStreak >= 3 && downMin >= 10;
      {
        alerts.push({ modelId: m.id, displayName: m.displayName || m.id, ownership: m.ownership,
          downMinutes: Math.round(downMin), halfOpenFailStreak: probeStreak,
          totalFailures: h.failures || 0, lastSuccessAt: h.lastSuccessAt ? new Date(h.lastSuccessAt).toISOString() : null,
          lastFailureAt: h.lastFailureAt ? new Date(h.lastFailureAt).toISOString() : null,
          circuitState: h.circuitState,
          suggestion: longDown ? `持续不可用 ${Math.round(downMin)} 分钟，疑似模型已下线` : `熔断半开探针连败 ${probeStreak} 次，疑似上游持续故障` });
      }
    }
    return json(res, 200, { alerts, checkedAt: new Date().toISOString() });
  }
  // ── P2 评测任务：POST 起任务 / GET 查进度
  if (url.pathname === '/admin/api/eval-jobs') {
    // v0.11.1：取消评测任务（执行与 Judge 循环均检查 cancelRequested）
    if (req.method === 'POST' && url.searchParams.get('action') === 'cancel') {
      try {
        const body = await readJson(req);
        const job = getEvalJob(body?.id);
        if (!job) return errorJson(res, 404, '任务不存在或已过期', 'eval_job_not_found');
        if (job.finishedAt) return json(res, 200, { ok: true, alreadyFinished: true, status: job.status });
        job.cancelRequested = true;
        return json(res, 202, { ok: true, cancelling: true });
      } catch (error) { return errorJson(res, 400, error.message, 'invalid_body'); }
    }
    if (req.method === 'POST') {
      try {
        const body = await readJson(req);
        const job = startEvalJob(body);
        return json(res, 202, job);
      } catch (error) { return errorJson(res, 400, error.message, error.code || 'eval_job_error'); }
    }
    if (req.method === 'GET') {
      const id = url.searchParams.get('id');
      if (!id) {
        sweepEvalJobs();
        const jobs = [...evalJobs.values()].sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt)).map(({ id, type, modelId, modelIds, status, startedAt, finishedAt, total, done, failed, cancelRequested }) => ({ id, type, modelId, modelIds, status, startedAt, finishedAt, total, done, failed, cancelRequested }));
        return json(res, 200, { jobs, retentionHours: EVAL_JOB_TTL_MS / 3600000, survivesRestart: false });
      }
      const job = getEvalJob(id);
      if (!job) return errorJson(res, 404, '任务不存在或已过期', 'eval_job_not_found');
      return json(res, 200, job);
    }
  }
  // PUT 更新/清除；key 永不回传、不入 config
  if (req.method === 'GET' && url.pathname === '/admin/api/judge/secret') {
    return json(res, 200, { ...judgeSecretStore.masked(), source: 'admin-config', note: 'key 已落 data/judge-secret.json（git-ignored）；GET 永不回明文' });
  }
  if (req.method === 'PUT' && url.pathname === '/admin/api/judge/secret') {
    try {
      const body = await readJson(req);
      if (body.clear) { judgeSecretStore.clear(); return json(res, 200, judgeSecretStore.masked()); }
      if (!body.baseUrl || !body.apiKey) return errorJson(res, 400, '需要 baseUrl 与 apiKey（或 clear:true 清除）', 'invalid_judge_secret');
      if (!/^https?:\/\//.test(body.baseUrl)) return errorJson(res, 400, 'baseUrl 必须是 http(s) 端点', 'invalid_judge_secret');
      // 允许 HTTP
      const jsHost = (() => { try { return new URL(body.baseUrl).hostname; } catch { return null; } })();
      if (body.baseUrl.startsWith('http://') && !['127.0.0.1', 'localhost', '[::1]'].includes(jsHost)) return errorJson(res, 400, '外部 Judge 端点必须 HTTPS（内网回环才允许 http）', 'invalid_judge_secret');
      judgeSecretStore.save({ baseUrl: String(body.baseUrl), apiKey: String(body.apiKey) });
      return json(res, 200, judgeSecretStore.masked());
    } catch (error) { return errorJson(res, 400, error.message, 'invalid_judge_secret'); }
  }

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
      const expectedRevision = getConfigRevision(config), draft = structuredClone(config);

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

        const target = draft.models.find((m) => m.id === id);

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

      config = await saveConfig(draft, { expectedRevision });

      return json(res, 200, { ok: true, applied, skipped, format: 'csv' });

    } catch (error) { return errorJson(res, 400, error.message, 'invalid_request_error'); }

  }

  if (req.method === 'POST' && url.pathname === '/admin/api/model-data/import') {

    try {

      const body = await readJson(req);

      const incoming = Array.isArray(body?.models) ? body.models : null;
      const expectedRevision = getConfigRevision(config), draft = structuredClone(config);

      if (!incoming || !incoming.length) return errorJson(res, 400, '导入文件需含 models 数组（见模板）', 'invalid_request_error');

      const applied = []; const skipped = [];
      const bsImportIssues = []; // v0.11.4：导入键白名单拒绝记录（响应回显给运营）
            // 值类型化 schema——键合法值恶意同样拒绝；原型链保留名显式拒
            const KEY_RE = /^[a-zA-Z0-9_.-]{1,64}$/;
            const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
            const SAFE_STR = (x, max = 200) => (typeof x === 'string' && x.length <= max ? x : null);
            const SAFE_NUM = (x, lo, hi) => (typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi ? x : null);
            // scores/evalGate：{ 指标名: 数值 }；subtasks：{ 子类名: {avg,n} }；双 meta：{ 字段名: 限长字符串 }（source/at/judge 等）
            const VALUE_SCHEMA = {
              scores: (v) => SAFE_NUM(v, 0, 100),
              evalGate: (v) => SAFE_NUM(v, 0, 100),
              subtasks: (v) => (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length <= 4 && SAFE_NUM(v.avg, 0, 100) != null && SAFE_NUM(v.n, 0, 1000000) != null ? { avg: v.avg, n: v.n } : null),
              scoresMeta: (v) => SAFE_STR(v, 200), // 真实形态：{source:'榜单名', at:'日期'}——键=字段名、值=限长字符串
              subtasksMeta: (v) => SAFE_STR(v, 200), // 真实形态：{at:'日期', judge:'裁判名'}——同上
            };

      for (const item of incoming) {

        if (!item?.id || typeof item.id !== 'string') { skipped.push(`${JSON.stringify(item?.id)} 缺有效 id`); continue; }

        const target = draft.models.find((m) => m.id === item.id);

        if (!target) { skipped.push(`${item.id} 不存在`); continue; }

        const bs = item.benchmarkScores;

        if (!bs || typeof bs !== 'object') { skipped.push(`${item.id} 缺 benchmarkScores`); continue; }

        const cur = target.benchmarkScores ||= {};

        // 合并语义：浅合并各层；值为 null 表示删除该键（用于修正录错的数据）


        const mergeLayer = (layer, incoming) => {

          if (!incoming || typeof incoming !== 'object') return;

          const dst = cur[layer] ||= {};

          for (const [k, v] of Object.entries(incoming)) {

            // v0.11.4：键白名单 + v0.11.5 保留名拒绝（__proto__/constructor/prototype）
            if (!KEY_RE.test(k) || BAD_KEYS.has(k)) { bsImportIssues.push(String(k).slice(0, 30) + ' 含非法字符或保留名，已跳过'); continue; }
            // 值 schema 校验——键合法值恶意同样拒绝；null=删除语义保留
            if (v !== null) {
              const validated = VALUE_SCHEMA[layer] ? VALUE_SCHEMA[layer](v) : v;
              if (validated == null) { bsImportIssues.push(layer + '.' + k + ' 值类型/范围非法，已跳过'); continue; }
              dst[k] = validated;
            } else delete dst[k];

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

      config = await saveConfig(draft, { expectedRevision });

      return json(res, 200, { ok: true, applied, skipped, issues: bsImportIssues.slice(0, 20) }); // v0.11.5：导入拒绝明细回显

    } catch (error) { return errorJson(res, 400, error.message, 'invalid_request_error'); }

  }

  if (req.method === 'PUT' && url.pathname === '/admin/api/config') {

    try {

      const next = await readJson(req);


      assertSemanticBucketSecretForMode(next?.semanticRouter?.mode);

      assertJudgeGuardStatePathStable(next?.judge);

      config = await saveConfig(next, { expectedRevision: req.headers['if-match'] }); budgetTracker.updateConfig(config); decisionLog.updateConfig(config); semanticLog.updateConfig({ decisionLog: { ...(config.decisionLog || {}), filePrefix: 'semantic-reviews' } }); judgeLogUpdate(); judgeGuard.updateLimits(config.judge || {}); res.setHeader('ETag', getConfigRevision(config)); return json(res, 200, config);

    }

    catch (error) { return errorJson(res, error.code === 'config_conflict' ? 412 : 400, error.message, error.code || 'invalid_config'); }

  }

  if (req.method === 'POST' && url.pathname === '/admin/api/preview') {

    try { return json(res, 200, await resolveAutoDecision(await readJson(req), { preview: true })); }

    catch (error) { return errorJson(res, 400, error.message); }

  }

  if (req.method === 'POST' && url.pathname === '/admin/api/simulate') {

    try {

      const body = await readJson(req);

      const proposedConfig = refreshCostIndexes(validateConfig(body.proposedConfig));

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

  default: { subs: ['qa-knowledge', 'conversation', 'customer-support', 'finance-trading', 'security-audit', 'summarization', 'translation', 'other'] },

  coding: { subs: ['code-generation', 'debugging', 'code-review', 'sql-database', 'frontend-ui', 'devops-config', 'shell-execution', 'file-io', 'repo-scanning'] },

  reasoning: { subs: ['multi-step-planning', 'research-reports', 'math', 'security-audit', 'finance-trading', 'customer-support', 'summarization', 'translation'] },

  creative: { subs: ['content-writing', 'roleplay-fiction'] },

  extraction: { subs: ['data-extraction', 'data-transformation', 'classification', 'summarization', 'translation', 'math'] },

  agent: { subs: ['multi-step-planning', 'tool-dispatch', 'workflow-execution', 'web-search', 'memory-extraction', 'devops'] },

  explicit: { subs: [] },

  unknown: { subs: [] }

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

  // 路由体检报表：见 buildRoutingReport

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

  if (req.method === 'GET' && url.pathname === '/admin/api/latency') {
    const budget = budgetTracker.snapshot();
    return json(res, 200, { ...latencyStore.dashboard(config.models, Object.fromEntries(url.searchParams)), mode: latencySettings().mode,
      probe: { ...latencyProbes.snapshot(), actualCostYuan: budget.probeActualCostYuan || 0, estimatedCostYuan: budget.probeEstimatedCostYuan || 0 } });
  }
  if (req.method === 'GET' && url.pathname === '/admin/api/operations') {
    return json(res, 200, operations.snapshot());
  }
  if (req.method === 'GET' && url.pathname === '/admin/api/quality-evidence') {
    return json(res, 200, qualityEvidence(config.models, qualityManifest));
  }
  if (req.method === 'GET' && url.pathname === '/admin/api/comparison/readiness') {
    return json(res, 200, comparisonReadiness(recent));
  }
  if (req.method === 'POST' && url.pathname === '/admin/api/comparison/analyze') {
    try {
      const matrix = await readJson(req);
      if (!Array.isArray(matrix.tasks) || matrix.tasks.length > 200 || !Array.isArray(matrix.candidates) || matrix.candidates.length > 6 || !Array.isArray(matrix.observations) || matrix.observations.length > 1200 || (matrix.selections?.length || 0) > 2400) return errorJson(res, 400, '导入上限：200 个任务、6 个候选、1200 条观测与 2400 条选择；较大矩阵请使用离线 CLI。', 'comparison_limit');
      const report = analyzeRoutingMatrix(matrix, { minTestGroups: 30, bootstrapIterations: 500, seed: 42 });
      return json(res, 200, report);
    } catch (error) { return errorJson(res, error.status || 400, error.message, 'comparison_invalid'); }
  }
  if (req.method === 'POST' && url.pathname === '/admin/api/latency/probe') {
    const result = latencyProbes.run({ manual: true });
    const reasons = { disabled: '自动补测未启用', busy: '已有补测正在运行', cooldown: '补测间隔至少一分钟，请稍后重试', budget: '今日补测调用额度已用完', no_model: '暂无符合补测条件的模型', storage: '补测预算存储异常，已暂停调用' };
    return json(res, result.accepted ? 202 : 409, { ...result, ...(!result.accepted ? { error: { code: result.reason, message: reasons[result.reason] || '本次无法启动补测' } } : {}) });
  }

  if (req.method === 'GET' && url.pathname === '/admin/api/metrics') {

    await refreshGoRuntime();

    const visibleRecent = recentKeyFilter ? recent.filter((x) => (x.keyFingerprint || '') === recentKeyFilter) : recent;


    // 真正执行闸一致（进程 counters 重启清零，guard 从磁盘恢复；两者并列展示，不互相覆盖）。

    return json(res, 200, { counters, judge: judgeRuntime.enabled ? { ...judgeCounters, gaugeCircuit: judgeGuard.snapshot().circuit === 'open' ? 2 : (judgeGuard.snapshot().circuit === 'half-open' ? 1 : 0), guard: judgeGuard.snapshot() } : null, health, modelLoad: Object.fromEntries(config.models.map(m => [m.id, loadAssessment(m, config.routing, runtimeModelLoad())])), recent: visibleRecent, semanticReviews, budget: budgetTracker.snapshot(), decisionLog: decisionLog.snapshot(), feedback: feedbackLog.snapshot(), sessions: goCoreEdge ? goRuntimeSnapshot.sessions : sessions.size });

  }

  // 分类器标准评测：spawn Python 脚本跑 heldout 集，输出三方（gold/小模型/规则层）准确率与混淆矩阵。

  // 回答"换分类器后准了多少"——换端点前后各点一次即可对比。评测只读模型文件，不影响线上。

  if (req.method === 'POST' && url.pathname === '/admin/api/classifier/evaluate') {

    const script = join(projectRoot, 'scripts', 'evaluate_classifier.py');

    const pythonCmd = await resolveClassifierPython(); // > python

    if (!pythonCmd) return errorJson(res, 500, '找不到可用的 Python（检查 CLASSIFIER_PYTHON 环境变量或安装 python）', 'classifier_eval_error');

    const child = spawn(pythonCmd, [script, ...(url.searchParams.get('dump') === '1' ? ['--dump'] : [])], { cwd: projectRoot, windowsHide: true, env: { ...process.env, PYTHONUTF8: '1' } });

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

    const pythonCmd = await resolveClassifierPython(); // 

    if (!pythonCmd) return errorJson(res, 500, '找不到可用的 Python（检查 CLASSIFIER_PYTHON 环境变量或安装 python）', 'classifier_replay_error');

    const child = spawn(pythonCmd, [script, '--dump'], { cwd: projectRoot, windowsHide: true, env: { ...process.env, PYTHONUTF8: '1' } });

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


  // （每行=一次请求的完整可归因链），供人工标注正确 task/tier 或裁判打分。脱敏文本默认截断，

  // fullText=1 才带完整消息。语义事件按 requestId 匹配（一天内重试的重复 requestId 取最新）。

  if (req.method === 'GET' && url.pathname === '/admin/api/annotation-export') {

    try {

      const count = Math.max(1, Math.min(2000, Number(url.searchParams.get('count') || 200)));

      const includeFullText = url.searchParams.get('fullText') === '1';

      const decisions = await decisionLog.recent(count, { includeFullText: true }).catch(() => []);

      const reviews = await semanticLog.recent(count * 2).catch(() => []);

      // 返回从新到旧——先见即最新。setIfAbsent 语义（首次写入胜出），

      // 修正原实现「后写覆盖」实际留下最老事件的错误。

      const reviewByRid = new Map();

      for (const r of reviews) { const rid = r.requestId; if (rid && !reviewByRid.has(rid)) reviewByRid.set(rid, r); }

      const rows = decisions.map((d) => {

        const rid = d.request?.requestId;

        const rv = reviewByRid.get(rid) || null;

        return {

          requestId: rid, at: d.at, keyFingerprint: d.request?.keyFingerprint || null,

          text: (d.request?.redactedBody?.messages || []).map((m) => {

            const full = includeFullText ? (m.content ?? m.head ?? '') : String(m.head ?? '').slice(0, 60);

            return `[${m.role}] ${full}`;

          }).join(' | ').slice(0, includeFullText ? undefined : 300),

          // ——fullText=1 未必有真全文。标 truncated

          // 让 Judge/标注侧能自检样本是否可用，避免拿截断文本评完整回答质量。

          textTruncated: Boolean(includeFullText && (d.request?.redactedBody?.messages || []).some((m) => (m.content == null && m.head != null))),

          l1: { task: d.decision?.analysis?.task, tier: d.decision?.analysis?.tier, confidence: d.decision?.analysis?.confidence },

          semantic: rv ? { cascade: rv.cascade, task: rv.assessment?.task, tier: rv.assessment?.tier, confidence: rv.assessment?.confidence, disagreed: rv.disagreed, proposedModel: rv.proposed?.model, overheadCostYuan: rv.overheadCostYuan ?? null } : null,

          finalModel: d.outcome?.model || d.decision?.selectedModel, ok: d.outcome?.ok ?? null,

          latencyMs: d.outcome?.latencyMs ?? null, fallbackAttempt: d.outcome?.fallbackAttempt ?? null,

          actualCostYuan: d.outcome?.actualCostYuan ?? null,

          semanticStatus: d.decision?.semanticReview?.status || null,

          // 标注列（人工/裁判填）：correctTask / correctTier / qualityScore(1-5) / notes

          correctTask: null, correctTier: null, qualityScore: null, notes: null

        };

      });

      return json(res, 200, { count: rows.length, exportedAt: new Date().toISOString(), rows });

    } catch (error) { return errorJson(res, 500, error.message, 'annotation_export_error'); }

  }

  // key 指纹筛选开关（最近请求面板 ：null=全部；8 位十六进制=只看该 key

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


    // 拒绝（磁盘配置被外部改成 active 后 reload 不再是绕过口），校验通过才替换全局 config。

    try {

      const next = goConfigPublication ? await goConfigPublication.reload() : await loadConfig();

      assertSemanticBucketSecretForMode(next.semanticRouter?.mode);

      assertJudgeGuardStatePathStable(next?.judge);

      config = next; budgetTracker.updateConfig(config); decisionLog.updateConfig(config); semanticLog.updateConfig({ decisionLog: { ...(config.decisionLog || {}), filePrefix: 'semantic-reviews' } }); judgeLogUpdate(); judgeGuard.updateLimits(config.judge || {}); return json(res, 200, { ok: true, version: config.version });

    }

    catch (error) { return errorJson(res, 400, error.message, 'invalid_config'); }

  }

  if (req.method === 'GET' && ['/docs/controlled-comparison.md', '/docs/routing-matrix.md'].includes(url.pathname)) {
    const md = await readFile(join(projectRoot, url.pathname.slice(1)), 'utf8');
    const tpl = await readFile(join(projectRoot, 'public', 'manual.html'), 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(tpl.replace('__MANUAL_VERSION__', () => String(config.version).replace(/[^0-9a-zA-Z.\-]/g, '')).replace('__MANUAL_BODY__', () => renderMarkdown(md)));
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

  // 管理页登录门：index/app.js 无会话一律回登录页（样式与手册放行——登录页也需要）；API 调用不受影响
  if (req.method === 'GET' && ['/index.html', '/', '/app.js', '/manual.html'].includes(url.pathname) && !authorizedAdmin(req)) {
    return staticFile('/login.html', res);
  }
  if (req.method === 'GET' && await staticFile(url.pathname, res)) return;

  return errorJson(res, 404, 'Not Found', 'not_found');

});

// 优雅关停管理器：在 listen 之前创建（需要 server 实例监听 request 事件）

const shutdownManager = createShutdownManager({

  server,

  timeoutMs: Number(process.env.SHUTDOWN_TIMEOUT_MS || 20000),

  beforeClose: async () => {
    const remaining = await goCoreEdge?.drain(Number(process.env.SHUTDOWN_TIMEOUT_MS || 20000));
    if (remaining) logger.warn('shutdown_go_events_remaining', { remaining });
  },

  flush: async () => {
    clearInterval(goRuntimeTimer);
    goCoreEdge?.close();
    clearInterval(latencyPersistTimer); clearInterval(latencyProbeTimer); clearInterval(operationsTimer);
    latencyProbeController?.abort(new Error('draining'));
    await latencyProbes.done();
    await latencyStore.flush(true);
    await operations.flush();

    // 关闭前保存最终统计，避免丢失尚未定时写入的增量。
    await countersFlushNow();

    // ②决策日志写链 ③语义事件写链 ④预算账本。HTTP 响应结束≠复核结束，滚动重启前必须等完。

    if (semanticBackgroundTasks.size > 0) {

      logger.info('shutdown_drain_semantic_tasks', { count: semanticBackgroundTasks.size });

      await Promise.race([

        Promise.allSettled([...semanticBackgroundTasks]),

        new Promise((r) => setTimeout(r, 8000)),

      ]);

    }

    await Promise.allSettled([decisionLog.writeChain, semanticLog.writeChain, judgeLog.writeChain, budgetTracker.pendingWrite]);
    await guardPersist.drain();

  },

});

installCrashHandlers(logger);

process.on('SIGINT', () => shutdownManager.shutdown('SIGINT'));

process.on('SIGTERM', () => shutdownManager.shutdown('SIGTERM'));

// 测试钩子（仅 AMR_TEST_SHUTDOWN_IPC=1 且存在 IPC 通道时激活）：Windows 上 child.kill('SIGTERM')

// 是 TerminateProcess，不会送达上面的 handler，SIGTERM 排空行为无法在 Windows 本机验证。

// 经 IPC 发 {type:'amr-shutdown'} 走同一条 shutdownManager.shutdown 路径，POSIX CI 仍用真信号。

if (process.env.AMR_TEST_SHUTDOWN_IPC === '1' && typeof process.send === 'function') {

  process.on('message', (m) => { if (m && m.type === 'amr-shutdown') shutdownManager.shutdown(m.reason || 'test-ipc'); });

}

// 测试钩子（AMR_TEST_STUCK_SEMANTIC_TASK=1）：注册一个永不 resolve 的语义后台任务，

// 用于验证后台任务一直未完成时，关停等待仍有 8 秒上限。

if (process.env.AMR_TEST_STUCK_SEMANTIC_TASK === '1') {

  trackSemanticTask(new Promise(() => {}));

}

const latencyPersistTimer = setInterval(() => { latencyStore.flush().catch(() => {}); }, 30000);
const goRuntimeTimer = goCoreEdge ? setInterval(async () => {
  if (shutdownManager.draining) return;
  const state = await refreshGoRuntime();
  if (state?.available) for (const model of config.models) maybePromoteVerified(model.id);
}, 1000) : null;
goRuntimeTimer?.unref();
checkOperations();
const operationsTimer = setInterval(() => { checkOperations(); operations.flush().catch(() => {}); }, 30000);
operationsTimer.unref();
latencyPersistTimer.unref();
const latencyProbeTimer = setInterval(() => { if (!shutdownManager.draining && latencySettings().mode !== 'off') latencyProbes.run(); }, 300000);
latencyProbeTimer.unref();

server.listen(port, host, () => {

  server.keepAliveTimeout = serverKeepAliveMs;

  server.headersTimeout = serverHeadersTimeoutMs;

  logger.info('server_started', { host, port, keepAliveMs: serverKeepAliveMs, headersTimeoutMs: serverHeadersTimeoutMs, configVersion: config.version, upstreamConfigured: Boolean(process.env.UPSTREAM_API_KEY || process.env.MAAS_API_KEY), node: process.version });

});
