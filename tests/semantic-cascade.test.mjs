// v0.6.0 三层分类改造测试：
// ①规则层置信度证据模型（四审反例：否定包裹/元讨论/多任务冲突 → 落入复核线）
// ②cascade 三阈值语义拆分（smallAcceptThreshold / finalAdoptionThreshold / minConfidence 兼容）
// ③passthrough 客户端 key 透传到大模型分类器
// ④大模型 prompt 携带小模型判断 + 大模型挂时降级返回小模型
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { analyzeRequest } from '../src/router.mjs';
import { classifySemantically, resolveSmallAcceptThreshold } from '../src/semantic-router.mjs';

const config = JSON.parse(await readFile(new URL('../config/router.json', import.meta.url), 'utf8'));

// ---------- ① 规则层置信度证据模型 ----------

test('置信度证据模型：四审反例落入复核线（confidence < 0.7）', () => {
  const cases = [
    '不要写代码，只用通俗语言解释什么是递归',        // 否定包裹 + 元讨论
    '请总结下面这段 Python 代码的业务含义',           // 引用性提及（主任务是 summarize）
    '什么是 Kubernetes？',                            // 概念问答（不是部署请求）
  ];
  for (const text of cases) {
    const a = analyzeRequest({ messages: [{ role: 'user', content: text }] }, config);
    assert.ok(a.confidence < config.semanticRouter.confidenceThreshold,
      `「${text}」confidence=${a.confidence} 应低于复核触发线 ${config.semanticRouter.confidenceThreshold}（否则永远进不了语义复核）`);
    assert.ok(a.confidenceFactors.length > 0, '低置信必须携带下调因素，便于决策日志归因');
  }
});

test('置信度证据模型：正常强命中保持高置信（不浪费复核预算）', () => {
  const cases = [
    ['帮我写一个 Python 函数计算斐波那契数列', 'coding'],
    ['权衡一下自建机房和公有云的成本与稳定性', 'reasoning'],
    ['把这段文字转成 JSON 格式', 'extraction'],
  ];
  for (const [text, task] of cases) {
    const a = analyzeRequest({ messages: [{ role: 'user', content: text }] }, config);
    assert.equal(a.task, task);
    assert.ok(a.confidence >= 0.86, `「${text}」confidence=${a.confidence} 强命中不应下调`);
    assert.deepEqual(a.confidenceFactors, []);
  }
});

test('置信度证据模型：trivial 直接事实保持 0.98', () => {
  const a = analyzeRequest({ messages: [{ role: 'user', content: '今天是星期几' }] }, config);
  assert.equal(a.confidence, 0.98);
});

// ---------- ② cascade 三阈值 ----------

const ASSESS_OK = { task: 'reasoning', tier: 'complex', complexity: 0.8, confidence: 0.92, reason: '多步权衡' };
const chatResponse = (assessment) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(assessment) } }] }) });

function cascadeConfig(overrides = {}) {
  const custom = structuredClone(config);
  custom.semanticRouter = {
    ...custom.semanticRouter,
    provider: 'cascade',
    model: 'deepseekv4-flash',
    httpJson: { url: 'http://127.0.0.1:9/classify', timeoutMs: 500 },
    ...overrides
  };
  return custom;
}

test('三阈值：smallAcceptThreshold 独立控制升级线', async () => {
  // 小模型 0.65：阈值 0.7 → 升级；阈值 0.6 → 直采
  const small65 = { task: 'default', tier: 'balanced', complexity: 0.5, confidence: 0.65, reason: '中等' };
  let calls = 0;
  const fetchCounting = async (url) => {
    calls += 1;
    if (String(url).includes('/classify')) return { ok: true, status: 200, json: async () => small65 };
    return chatResponse(ASSESS_OK);
  };
  const escalated = await classifySemantically({ messages: [{ role: 'user', content: '这个怎么样' }] }, cascadeConfig({ smallAcceptThreshold: 0.7 }), { fetchImpl: fetchCounting, apiKey: 'k' });
  assert.equal(escalated.cascade.level, 'large', '0.65 < 0.7 应升级');
  assert.equal(calls, 2);
  calls = 0;
  const accepted = await classifySemantically({ messages: [{ role: 'user', content: '这个怎么样' }] }, cascadeConfig({ smallAcceptThreshold: 0.6 }), { fetchImpl: fetchCounting, apiKey: 'k' });
  assert.equal(accepted.cascade.level, 'small', '0.65 ≥ 0.6 应直采');
  assert.equal(calls, 1, '直采不应调大模型');
});

test('三阈值：resolveSmallAcceptThreshold 兼容回退 minConfidence', () => {
  assert.equal(resolveSmallAcceptThreshold({ smallAcceptThreshold: 0.8 }), 0.8, '显式值优先');
  assert.equal(resolveSmallAcceptThreshold({ minConfidence: 0.5 }), 0.5, '未配置新字段回退 minConfidence');
  assert.equal(resolveSmallAcceptThreshold({ minConfidence: 0 }), 0.7, 'minConfidence=0（旧云端配置）不回退 0——0 意为全部直采会让级联失效');
  assert.equal(resolveSmallAcceptThreshold({}), 0.7, '全空走默认 0.7');
});

// ---------- ③④ prompt 前级注入 + 大模型挂降级 ----------

test('cascade 升级时 prompt 携带小模型判断', async () => {
  const lowConf = { task: 'default', tier: 'balanced', complexity: 0.5, confidence: 0.3, reason: '拿不准' };
  let chatPrompt = null;
  const fakeFetch = async (url, init) => {
    if (String(url).includes('/classify')) return { ok: true, status: 200, json: async () => lowConf };
    chatPrompt = init.body ? JSON.parse(init.body).messages[0].content : null;
    return chatResponse({ task: 'coding', tier: 'complex', complexity: 0.75, confidence: 0.88, reason: '代码重构' });
  };
  const result = await classifySemantically({ messages: [{ role: 'user', content: '看看这段代码怎么改' }] }, cascadeConfig(), { fetchImpl: fakeFetch, apiKey: 'k' });
  assert.equal(result.cascade.level, 'large');
  assert.ok(chatPrompt.includes('小模型初判'), '升级 prompt 必须携带小模型结论');
  assert.ok(chatPrompt.includes('"confidence":0.3'), '小模型置信度要给大模型看到');
  assert.equal(result.smallAttempt.task, 'default');
});

test('cascade：大模型挂 + 小模型有产出 → 降级返回小模型（small-degraded）', async () => {
  const lowConf = { task: 'default', tier: 'balanced', complexity: 0.5, confidence: 0.45, reason: '拿不准' };
  const fakeFetch = async (url) => {
    if (String(url).includes('/classify')) return { ok: true, status: 200, json: async () => lowConf };
    // v0.7.1 七审 P1-3：模拟 L3 白等才挂。十一审 P2：延迟 300→350ms——Windows 计时取整+并发
    // 负载下 setTimeout(300) 实测可记为 299ms，恰好击穿「≥300」断言（专项 10 轮全过但全量套件
    // 偶发 168/169）。350ms 模拟延迟 + ≥300ms 断言留 50ms 容差，仍完整验证「L3 等待被计入」。
    await new Promise((r) => setTimeout(r, 350));
    throw new Error('上游 503');
  };
  const result = await classifySemantically({ messages: [{ role: 'user', content: '这个怎么样' }] }, cascadeConfig(), { fetchImpl: fakeFetch, apiKey: 'k' });
  assert.equal(result.cascade.level, 'small-degraded');
  assert.equal(result.provider, 'http-json');
  assert.ok(result.cascade.largeError.includes('503'));
  assert.equal(result.confidence, 0.45, '降级结果保留小模型原始置信度，由 server 采纳线决定去留');
  // v0.7.1 七审 P1-3：降级路径时延必须含 L3 失败等待——原实现只记 smallLatencyMs（漏 300ms 白等）
  assert.ok(result.cascade.largeLatencyMs >= 300, `largeLatencyMs 应含 L3 等待 ≥300ms，实际 ${result.cascade.largeLatencyMs}`);
  assert.ok(result.cascade.totalLatencyMs >= 300, `totalLatencyMs 应 ≥300ms，实际 ${result.cascade.totalLatencyMs}`);
  assert.equal(result.cascade.totalLatencyMs, result.cascade.smallLatencyMs + result.cascade.largeLatencyMs, 'total = small + large 恒等');
  assert.ok(result.latencyMs >= 300, '顶层 latencyMs（旧字段兼容）也应为 total 口径');
});

test('cascade：两级都挂才抛（小模型挂 + 大模型挂）', async () => {
  const fakeFetch = async () => { throw new Error('network down'); };
  await assert.rejects(
    () => classifySemantically({ messages: [{ role: 'user', content: '随便看看' }] }, cascadeConfig(), { fetchImpl: fakeFetch, apiKey: 'k' }),
    /级联复核两级均失败/
  );
});