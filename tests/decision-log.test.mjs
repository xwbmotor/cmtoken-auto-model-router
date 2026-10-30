// v0.5.2 新增：explicitTask 持久化端到端（Codex 二审 P1——旧测试手工构造日志对象，
// 绕过了真实 DecisionLog.entry() 白名单，没发现 explicitTask 在持久化时丢失）
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DecisionLog } from '../src/decision-log.mjs';

test('entry() 白名单保留 explicitTask，写盘后读回可重建点名信号', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'amr-dlog-'));
  const log = new DecisionLog({ enabled: true, dirPath: dir, timeZone: 'Asia/Shanghai' });
  const decision = {
    requestedModel: 'qwen36-35b', suggestedModel: 'qwen36-35b', selectedModel: 'qwen36-35b',
    shadow: false, reasoningLevel: 'off',
    explicitTask: 'coding', // 服务层点名请求补记的真实任务（市场信号重建读它）
    analysis: { task: 'explicit', tier: 'complex', complexity: 0.7, confidence: 0.9, routeMethod: 'rules', signals: {} },
    candidates: [], rejected: [], fallbackOrder: [],
    configVersion: '0.5.2-test'
  };
  const entry = log.entry({ requestId: 'req-1', keyFingerprint: 'fp1' }, decision, { ok: true, model: 'qwen36-35b', latencyMs: 100 });
  assert.equal(entry.decision.explicitTask, 'coding', 'entry() 应保留 explicitTask');
  await log.write({ requestId: 'req-1', keyFingerprint: 'fp1' }, decision, { ok: true, model: 'qwen36-35b', latencyMs: 100 }); // v0.5.2：await writeChain，消并行竞态
  const files = await readdir(dir);
  const f = files.find((x) => x.endsWith('.jsonl'));
  assert.ok(f, '应有 jsonl 落盘');
  const lines = (await readFile(join(dir, f), 'utf8')).trim().split('\n');
  const persisted = JSON.parse(lines.at(-1));
  assert.equal(persisted.decision.explicitTask, 'coding', '持久化后 explicitTask 不丢（v0.5.1 在此为 null）');
  assert.equal(persisted.decision.analysis.task, 'explicit', '服务层 task 槽位保持 explicit 语义');
  await rm(dir, { recursive: true, force: true });
});

test('无 explicitTask 的普通请求：entry() 输出 null 不炸', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'amr-dlog-'));
  const log = new DecisionLog({ enabled: true, dirPath: dir });
  const decision = {
    requestedModel: 'auto', suggestedModel: 'qwen36-35b', selectedModel: 'qwen36-35b',
    shadow: false, reasoningLevel: 'off',
    analysis: { task: 'coding', tier: 'complex', complexity: 0.7, confidence: 0.9, routeMethod: 'rules', signals: {} },
    candidates: [], rejected: [], fallbackOrder: [], configVersion: '0.5.2-test'
  };
  const entry = log.entry({ requestId: 'req-2' }, decision, { ok: true });
  assert.equal(entry.decision.explicitTask, null);
  await rm(dir, { recursive: true, force: true });
});

const trainingDecision = {
  requestedModel: 'auto', suggestedModel: 'model-a', selectedModel: 'model-b',
  explicitTask: 'coding', analysis: { task: 'coding', tier: 'complex', complexity: 0.7,
    confidence: 0.9, estimatedInputTokens: 125, estimatedOutputTokens: 40,
    signals: { code: true }, confidenceFactors: [{ key: 'task_base', contribution: 0.4 }] },
  candidates: [{ model: 'model-a', score: 0.8, quality: 0.9 }],
  fallbackOrder: ['model-a', 'model-b'], configVersion: 'test', policyRevision: 'revision-a'
};

test('默认日志在磁盘去掉正文、前缀、回答及自由错误信息，保留飞轮特征与结果', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'amr-dlog-private-'));
  try {
    const log = new DecisionLog({ enabled: true, dirPath: dir });
    const body = { messages: ['system', 'user', 'assistant', 'tool'].map(role => ({ role, content: `PRIVATE_${role}` })) };
    const redacted = log.redact(body);
    assert.deepEqual(redacted.messages.map(m => [m.role, m.chars]), body.messages.map(m => [m.role, m.content.length]));
    await log.write({ requestId: 'r1', keyFingerprint: 'fp1', redactedBody: redacted,
      body, messages: [{ content: 'PRIVATE_legacy', head: 'PRIVATE_head', chars: 14 }],
      authorization: 'PRIVATE_key' },
    { ...trainingDecision, semanticReview: { status: 'error', error: 'PRIVATE_classifier_echo' } },
    { ok: false, model: 'model-b', status: 503, error: 'PRIVATE_upstream_echo', failureScope: 'model',
      answerText: 'PRIVATE_answer', latencyMs: 32, usage: { prompt_tokens: 125, completion_tokens: 40 },
      actualCostYuan: 0.012 });
    await log.flushDurable();
    const raw = await readFile(log.currentFile, 'utf8');
    assert.ok(!raw.includes('PRIVATE_'), '所有已知正文及错误回显路径都不能出现在磁盘');
    const [row] = await log.recent(1);
    assert.equal(row.request.requestId, 'r1');
    assert.equal(row.decision.policyRevision, 'revision-a');
    assert.equal(row.decision.explicitTask, 'coding');
    assert.deepEqual(row.decision.analysis.signals, { code: true });
    assert.deepEqual(row.decision.analysis.confidenceFactors, trainingDecision.analysis.confidenceFactors);
    assert.equal(row.decision.candidates[0].score, 0.8);
    assert.deepEqual(row.outcome.usage, { prompt_tokens: 125, completion_tokens: 40 });
    assert.equal(row.outcome.actualCostYuan, 0.012);
    assert.equal(row.outcome.status, 503);
    assert.equal(row.outcome.failureScope, 'model');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('默认查询屏蔽历史嵌套正文但不改写历史文件，显式全文导出继续可用', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'amr-dlog-legacy-'));
  try {
    const log = new DecisionLog({ enabled: true, dirPath: dir });
    await log.openExistingOrCreate();
    const old = { at: '2026-10-01', request: { keyFingerprint: 'fp1',
      headers: { authorization: 'SECRET_header' }, Authorization: 'SECRET_bearer', api_key: 'SECRET_key',
      messages: [{ head: 'PRIVATE_head', content: 'PRIVATE_content', chars: 99 }],
      body: { messages: [{ content: [{ type: 'text', text: 'PRIVATE_multi' }, { type: 'image_url', image_url: { url: 'PRIVATE_url' } }] }] },
      redactedBody: { messages: [{ content: 'PRIVATE_actual_shape', role: 'user', chars: 20 }] } },
      outcome: { answerText: 'PRIVATE_answer', error: 'PRIVATE_error', ok: false, status: 500,
        usage: { total_tokens: 33 }, actualCostYuan: 0.01 } };
    const raw = JSON.stringify(old) + '\n';
    await writeFile(log.currentFile, raw);
    const rows = await log.recent(1, { keyFingerprint: 'FP1' });
    assert.equal(rows.length, 1);
    assert.ok(!JSON.stringify(rows).includes('PRIVATE_'));
    assert.equal(rows[0].request.redactedBody.messages[0].chars, 20);
    assert.equal(rows[0].outcome.usage.total_tokens, 33);
    const [full] = await log.recent(1, { includeFullText: true });
    assert.equal(full.request.messages[0].content, old.request.messages[0].content);
    assert.equal(full.request.redactedBody.messages[0].content, old.request.redactedBody.messages[0].content);
    assert.equal(full.outcome.answerText, old.outcome.answerText);
    assert.equal(full.outcome.error, 'details_redacted');
    assert.ok(!JSON.stringify(full).includes('SECRET_'), '全文导出也不能包含历史凭据');
    assert.equal(await readFile(log.currentFile, 'utf8'), raw, '读取不能删除或修改已保存样本');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('显式原文采集与回答采集仍可独立启用，默认查询不暴露训练样本', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'amr-dlog-optin-'));
  try {
    const log = new DecisionLog({ enabled: true, dirPath: dir, redactMessages: false, logAnswerText: true });
    await log.write({ requestId: 'training-1', redactedBody: log.redact({ messages: [{ role: 'user', content: 'PRIVATE_training_prompt' }] }) },
      trainingDecision, { ok: true, answerText: 'PRIVATE_training_answer', usage: { total_tokens: 42 } });
    const full = await log.recent(1, { includeFullText: true });
    assert.equal(full[0].request.redactedBody.messages[0].content, 'PRIVATE_training_prompt');
    assert.equal(full[0].outcome.answerText, 'PRIVATE_training_answer');
    assert.ok(!JSON.stringify(await log.recent(1)).includes('PRIVATE_'));
    const answerOnly = new DecisionLog({ redactMessages: true, logAnswerText: true });
    const answerRecord = answerOnly.entry({ redactedBody: answerOnly.redact({ messages: [{ role: 'user', content: 'PRIVATE_request' }] }) },
      trainingDecision, { answerText: 'approved_answer', usage: { total_tokens: 42 } });
    assert.equal(answerRecord.outcome.answerText, 'approved_answer');
    assert.ok(!JSON.stringify(answerRecord.request).includes('PRIVATE_'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('后台语义事件写入不保存上游错误回显，结构化评估数据继续保留', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'amr-dlog-semantic-'));
  try {
    const log = new DecisionLog({ enabled: true, dirPath: dir, filePrefix: 'semantic-reviews' });
    await log.writeRaw({ requestId: 'r1', error: 'PRIVATE_error_echo', assessment: { task: 'coding', confidence: 0.9 },
      latencyMs: 12, messages: [{ content: 'PRIVATE_message' }] });
    const raw = await readFile(log.currentFile, 'utf8');
    assert.ok(!raw.includes('PRIVATE_'));
    const row = JSON.parse(raw);
    assert.deepEqual(row.assessment, { task: 'coding', confidence: 0.9 });
    assert.equal(row.latencyMs, 12);
    assert.equal(row.error, 'details_redacted');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('原生用量 prompt/completion 数字与同名布尔信号完整保留，字符串正文仍隐藏', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'amr-dlog-usage-'));
  try {
    const log = new DecisionLog({ enabled: true, dirPath: dir });
    const usage = { prompt: 200, completion: 50, cached: 10, reasoning: null };
    const signals = { prompt: true, completion: false, content: 0, text: null, code: true };
    await log.write({ requestId: 'r-usage', body: { prompt: 'PRIVATE_prompt', completion: 'PRIVATE_completion' } },
      { ...trainingDecision, analysis: { ...trainingDecision.analysis, signals } },
      { ok: true, usage, actualCostYuan: 0.1 });
    const persisted = JSON.parse(await readFile(log.currentFile, 'utf8'));
    const [queried] = await log.recent(1);
    for (const row of [persisted, queried]) {
      assert.deepEqual(row.outcome.usage, usage);
      assert.deepEqual(row.decision.analysis.signals, signals);
      assert.ok(!JSON.stringify(row).includes('PRIVATE_'));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('评审自由评论和解释不进入默认日志，评分、分类、拒绝枚举与HTTP错误类别保留', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'amr-dlog-judge-'));
  try {
    const log = new DecisionLog({ enabled: true, dirPath: dir, filePrefix: 'judge-reviews' });
    const event = { event: 'quality', requestId: 'r-judge', quality: {
      correctness: { score: 8, verifiable: true, reason: 'PRIVATE_reason' },
      safety: { score: 10, reason: null }, overall_comment: 'PRIVATE_comment' },
      taskCheck: { agree: false, suggested: 'coding', reason: 'PRIVATE_task' },
      assessment: { task: 'coding', confidence: 0.9, reason: 'PRIVATE_semantic' },
      signals: [{ key: 'semantic_review', label: 'PRIVATE_signal', contribution: 0.2 }],
      rejected: [{ model: 'model-a', reasons: ['context_too_long', 'missing_vision'] }],
      latencyShadow: { reason: 'within_switch_margin' },
      error: 'judge 上游 500', usage: { prompt: 200, completion: 50 } };
    await log.writeRaw(event);
    const row = JSON.parse(await readFile(log.currentFile, 'utf8'));
    assert.ok(!JSON.stringify(row).includes('PRIVATE_'));
    assert.equal(row.quality.correctness.score, 8);
    assert.equal(row.quality.correctness.verifiable, true);
    assert.equal(row.taskCheck.agree, false);
    assert.equal(row.taskCheck.suggested, 'coding');
    assert.deepEqual(row.rejected, event.rejected);
    assert.deepEqual(row.usage, event.usage);
    assert.equal(row.signals[0].contribution, 0.2);
    assert.equal(row.latencyShadow.reason, 'within_switch_margin');
    assert.equal(row.error, 'judge 上游 500');
    await log.writeRaw({ event: 'error', error: 'judge 上游 500 PRIVATE_echo' });
    assert.equal((await log.recent(1))[0].error, 'details_redacted', '只有完整匹配固定错误模板才可保留');
    const optedIn = new DecisionLog({ redactMessages: false });
    const rich = optedIn.entry({}, { ...trainingDecision, semanticReview: { reason: 'approved_explanation' } }, {});
    assert.equal(rich.decision.semanticReview.reason, 'approved_explanation', '显式样本采集保留解释能力');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
