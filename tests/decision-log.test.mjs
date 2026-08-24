// v0.5.2 新增：explicitTask 持久化端到端（Codex 二审 P1——旧测试手工构造日志对象，
// 绕过了真实 DecisionLog.entry() 白名单，没发现 explicitTask 在持久化时丢失）
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
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