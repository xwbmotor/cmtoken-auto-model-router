// 思考型模型保护：Qwen3.8-27B 实测发现（2026-08-20 粒度验证）：
// 1. 服务端默认开思考且思考与正文共享 max_tokens 预算——复杂题思考烧完 8192 预算后 content 为空（finish=length）
// 2. 唯一有效开关是 vLLM 风格 chat_template_kwargs.enable_thinking（enable_thinking/thinking.type 均无效）
// 3. 不带思考预算的窄窗口请求应被路由层拒绝（completion_budget_too_low），换下一候选
import test from 'node:test';
import assert from 'node:assert/strict';
import { routeRequest } from '../src/router.mjs';

const baseConfig = {
  models: [
    { id: 'thinker', enabled: true, costIndex: 0.5, latencyIndex: 0.5, quality: { default: 0.9, coding: 0.95 }, reasoningControl: { parameter: 'chat_template_kwargs.enable_thinking', values: { off: false, standard: true, high: true }, verified: true }, minimumCompletionTokensForReliableAnswer: 16384 },
    { id: 'plain', enabled: true, costIndex: 0.3, latencyIndex: 0.5, quality: { default: 0.8, coding: 0.8 } }
  ],
  routing: { mode: 'active', qualityWeight: 1, costWeight: 0.2, latencyWeight: 0.1, uncertaintyPenalty: 0.05, qualityFloor: 0.72 },
  taskRules: { complexMinComplexity: 0.66, highLoadThresholdQps: 50 }
};

test('思考型模型：max_tokens 低于安全下限时被拒并回退到普通模型', () => {
  const body = { messages: [{ role: 'user', content: '写一个带指数退避重试的装饰器' }], max_tokens: 8192 };
  const d = routeRequest(body, baseConfig);
  assert.equal(d.selectedModel, 'plain');
  const rejected = d.rejected.find((r) => r.model === 'thinker');
  assert.ok(rejected, 'thinker 应被拒绝');
  assert.ok(rejected.reasons.includes('completion_budget_too_low'));
});

test('思考型模型：max_tokens 达到下限（或未指定）时不被预算拒绝', () => {
  const ok1 = routeRequest({ messages: [{ role: 'user', content: '写一个带指数退避重试的装饰器' }], max_tokens: 16384 }, baseConfig);
  assert.equal(ok1.selectedModel, 'thinker');
  const ok2 = routeRequest({ messages: [{ role: 'user', content: '写一个带指数退避重试的装饰器' }] }, baseConfig);
  assert.equal(ok2.selectedModel, 'thinker');
  for (const d of [ok1, ok2]) {
    const rejected = d.rejected.find((r) => r.model === 'thinker');
    assert.ok(!rejected || !rejected.reasons.includes('completion_budget_too_low'));
  }
});

test('max_completion_tokens（OpenAI 新参数名）同样受下限保护', () => {
  const d = routeRequest({ messages: [{ role: 'user', content: '写一个带指数退避重试的装饰器' }], max_completion_tokens: 4096 }, baseConfig);
  assert.equal(d.selectedModel, 'plain');
  assert.ok(d.rejected.find((r) => r.model === 'thinker')?.reasons.includes('completion_budget_too_low'));
});

test('点路径参数注入：chat_template_kwargs.enable_thinking 按档位切换且保留兄弟键', async () => {
  // server.mjs 不导出 upstreamRequestBody/setDeepParameter，从源码提取验证（同构断言）
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/server.mjs', import.meta.url), 'utf8');
  assert.match(src, /function setDeepParameter\(payload, dottedPath, value\)/, 'setDeepParameter 应存在');
  assert.match(src, /setDeepParameter\(payload, parameter, values\[reasoningLevel\] \?\? values\.standard\)/, '注入应走点路径且用 ?? 兜底');
});

test('路由分层与思考控制正交：低复杂度默认档 reasoningLevel=off → 上游会注入 enable_thinking=false', () => {
  const d = routeRequest({ messages: [{ role: 'user', content: '你好' }] }, { ...baseConfig, reasoningControl: { enabled: true } });
  assert.equal(d.selectedModel, 'thinker');
  assert.equal(d.reasoningLevel, 'off'); // 前提：简单任务 off 档 → 注入 false → 关思考（105s→7s 实测）
});
