import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { classifySemantically, parseSemanticAssessment, semanticProvider, shouldUseSemanticRouter } from '../src/semantic-router.mjs';
import { validateConfig } from '../src/config.mjs';
import { DecisionLog } from '../src/decision-log.mjs';

const config = JSON.parse(await readFile(new URL('../config/router.json', import.meta.url), 'utf8'));

// —— provider 分发 ——

test('semanticProvider resolves legacy config to openai-chat and empty to disabled', () => {
  const legacy = structuredClone(config); delete legacy.semanticRouter.provider;
  assert.equal(semanticProvider(legacy), 'openai-chat');
  const empty = structuredClone(config); delete empty.semanticRouter.model; delete empty.semanticRouter.provider;
  assert.equal(semanticProvider(empty), 'disabled');
});

test('http-json provider posts text and parses assessment contract', async () => {
  const custom = structuredClone(config);
  custom.semanticRouter = { ...custom.semanticRouter, provider: 'http-json', httpJson: { url: 'http://127.0.0.1:9/classify', timeoutMs: 500 } };
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ task: 'reasoning', tier: 'complex', complexity: 0.82, confidence: 0.9, reason: '多目标权衡' }) };
  };
  const result = await classifySemantically({ messages: [{ role: 'user', content: '帮我权衡这几个方案的成本和时延' }] }, custom, { fetchImpl: fakeFetch });
  assert.equal(result.provider, 'http-json');
  assert.equal(result.task, 'reasoning');
  assert.equal(result.complexity, 0.82);
  assert.equal(calls[0].url, 'http://127.0.0.1:9/classify');
  assert.ok(calls[0].body.text.length > 0);
  assert.ok(!('model' in calls[0].body), 'http-json 不应携带 model 字段');
});

test('http-json provider rejects invalid contract values', async () => {
  const custom = structuredClone(config);
  custom.semanticRouter = { ...custom.semanticRouter, provider: 'http-json', httpJson: { url: 'http://127.0.0.1:9/classify' } };
  const badFetch = async () => ({ ok: true, status: 200, json: async () => ({ task: 'invalid-task', tier: 'complex', complexity: 0.5, confidence: 0.5 }) });
  await assert.rejects(() => classifySemantically({ messages: [{ role: 'user', content: '帮我看看这份材料' }] }, custom, { fetchImpl: badFetch }), /task 无效/);
});

test('openai-chat provider keeps chat-completions behavior with explicit sub-config', async () => {
  const custom = structuredClone(config);
  custom.semanticRouter = { ...custom.semanticRouter, provider: 'openai-chat', openaiChat: { model: 'deepseekv4-flash', timeoutMs: 500 } };
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const content = '```json\n{"task":"extraction","tier":"simple","complexity":0.2,"confidence":0.95,"reason":"格式转换"}\n```';
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
  };
  const result = await classifySemantically({ messages: [{ role: 'user', content: '把这段转成 JSON' }] }, custom, { fetchImpl: fakeFetch, apiKey: 'k' });
  assert.equal(result.provider, 'openai-chat');
  assert.equal(result.model, 'deepseekv4-flash');
  assert.equal(result.task, 'extraction');
  assert.ok(calls[0].url.endsWith('/chat/completions'));
  assert.equal(calls[0].body.model, 'deepseekv4-flash');
});

test('disabled provider never triggers semantic routing', () => {
  const custom = structuredClone(config);
  custom.semanticRouter = { ...custom.semanticRouter, enabled: true, provider: 'disabled' };
  delete custom.semanticRouter.model;
  const body = { messages: [{ role: 'user', content: '帮我处理一下这份材料，看看怎么调整比较合适' }] };
  const analysis = { confidence: 0.55 };
  assert.equal(shouldUseSemanticRouter(analysis, body, custom), false);
});

test('parseSemanticAssessment still accepts fenced JSON and validates ranges', () => {
  const ok = parseSemanticAssessment('{"task":"coding","tier":"balanced","complexity":0.5,"confidence":0.7,"reason":"代码"}');
  assert.equal(ok.task, 'coding');
  assert.throws(() => parseSemanticAssessment('{"task":"coding","tier":"balanced","complexity":1.5,"confidence":0.7}'), /complexity/);
});

// —— config 校验 ——

test('config validation accepts provider forms and rejects invalid ones', () => {
  const httpJson = structuredClone(config);
  httpJson.semanticRouter = { ...httpJson.semanticRouter, provider: 'http-json', httpJson: { url: 'http://127.0.0.1:9000/classify' } };
  validateConfig(httpJson);
  const chatForm = structuredClone(config);
  chatForm.semanticRouter = { ...chatForm.semanticRouter, provider: 'openai-chat', openaiChat: { model: 'deepseekv4-flash' } };
  delete chatForm.semanticRouter.model;
  validateConfig(chatForm);
  const badProvider = structuredClone(config);
  badProvider.semanticRouter = { ...badProvider.semanticRouter, provider: 'grpc' };
  assert.throws(() => validateConfig(badProvider), /provider 无效/);
  const missingUrl = structuredClone(config);
  missingUrl.semanticRouter = { ...missingUrl.semanticRouter, provider: 'http-json' };
  delete missingUrl.semanticRouter.httpJson;  // 基础配置可能已带 url，显式移除以构造"缺 url"用例
  assert.throws(() => validateConfig(missingUrl), /httpJson\.url/);
  const withLog = structuredClone(config);
  withLog.decisionLog = { enabled: true, dirPath: './data/decisions', maxFiles: 7 };
  validateConfig(withLog);
  assert.throws(() => { const bad = structuredClone(withLog); bad.decisionLog.maxFiles = 0; validateConfig(bad); }, /maxFiles/);
});

// —— decision log ——

test('decision log writes redacted entries, rotates and reads back', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'router-log-'));
  try {
    const log = new DecisionLog({ enabled: true, dirPath: './decisions', maxFileBytes: 1, maxFiles: 5, redactMessages: true });
    log.projectRoot = dir;
    const body = { model: 'auto', stream: false, max_tokens: 256, messages: [{ role: 'user', content: 'A'.repeat(500) }] };
    const decision = {
      requestedModel: 'auto', suggestedModel: 'qwen36-35b', selectedModel: 'qwen36-35b', shadow: false,
      reasoningLevel: 'standard', analysis: { task: 'reasoning', tier: 'balanced', complexity: 0.55, confidence: 0.86, routeMethod: 'rules', signals: [{ key: 'task_base', label: '任务类型：reasoning', contribution: 0.38 }] },
      candidates: [{ model: 'qwen36-35b', score: 0.8, quality: 0.89 }], rejected: [], fallbackOrder: ['qwen36-35b'], configVersion: '0.4.1'
    };
    log.write({ sessionId: 's1', redactedBody: log.redact(body) }, decision, { ok: true, model: 'qwen36-35b', latencyMs: 120, fallbackAttempt: 0 });
    log.write({ sessionId: 's2', redactedBody: log.redact(body) }, decision, { ok: true, model: 'qwen36-35b', latencyMs: 130, fallbackAttempt: 0 });
    await log.writeChain;
    const files = (await readdir(join(dir, 'decisions'))).filter((f) => f.endsWith('.jsonl'));
    assert.ok(files.length >= 1, '至少生成一个日志文件');
    const rows = await log.recent(10);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].outcome.model, 'qwen36-35b');
    assert.equal(rows[0].decision.suggestedModel, 'qwen36-35b');
    // 脱敏：消息只保留长度和前160字符
    const message = rows[0].request.redactedBody.messages[0];
    assert.equal(message.chars, 500);
    assert.equal(message.head.length, 160);
    assert.ok(!JSON.stringify(rows).includes('A'.repeat(200)), '完整用户消息不得落盘');
    // maxFileBytes=1 触发轮转
    assert.ok(files.some((f) => f.includes('rotated')), '小阈值应触发轮转');
    const snapshot = log.snapshot();
    assert.equal(snapshot.written, 2);
    assert.equal(snapshot.errors, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('decision log disabled writes nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'router-log-off-'));
  try {
    const log = new DecisionLog({ enabled: false, dirPath: './decisions' });
    log.projectRoot = dir;
    log.write({}, { suggestedModel: 'x' }, { ok: true });
    await log.writeChain;
    await assert.rejects(() => readdir(join(dir, 'decisions')));
    assert.equal(log.snapshot().written, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
