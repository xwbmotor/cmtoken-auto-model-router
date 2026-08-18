import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeRequest } from '../src/router.mjs';
import { DecisionLog } from '../src/decision-log.mjs';

// ---------- router.mjs：TASK_PATTERNS 配置化 ----------
test('taskRules.patterns 覆盖默认正则', () => {
  const config = {
    taskRules: {
      simpleMaxComplexity: 0.34,
      complexMinComplexity: 0.7,
      longPromptCharacters: 12000,
      patterns: { reasoning: ['微服务治理', '消息队列', 'SLI/SLO'] }   // 完全自定义关键词
    }
  };
  assert.equal(analyzeRequest({ messages: [{ role: 'user', content: '我们的 SLI/SLO 应该怎么设计' }] }, config).task, 'reasoning');
});

test('taskRules.patterns 不存在则保持默认行为', () => {
  const config = { taskRules: { simpleMaxComplexity: 0.34, complexMinComplexity: 0.7 } };
  assert.equal(analyzeRequest({ messages: [{ role: 'user', content: '比较分布式事务方案的优缺点' }] }, config).task, 'reasoning');
  assert.equal(analyzeRequest({ messages: [{ role: 'user', content: '写一个 Python 函数' }] }, config).task, 'coding');
});

test('taskRules.patterns 非法正则容错（继续走默认）', () => {
  const config = { taskRules: { patterns: { coding: ['[invalid('] } } };
  // 正则构造失败被 catch 吞掉，继续走默认 coding 正则
  const r = analyzeRequest({ messages: [{ role: 'user', content: '写一个 Java 接口' }] }, config);
  assert.equal(r.task, 'coding');
});

// ---------- decision-log：跨时区分日 ----------
test('fileFor 按 Asia/Shanghai 跨日分文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dlog-'));
  const log = new DecisionLog({ enabled: true, dirPath: dir, timeZone: 'Asia/Shanghai' });
  log.projectRoot = process.cwd();
  // 2026-08-18T16:01Z = Asia/Shanghai 2026-08-19 00:01 → 文件名应该是 2026-08-19
  const file = log.fileFor(new Date('2026-08-18T16:01:00Z'));
  assert.ok(file.endsWith('decisions-2026-08-19.jsonl'), `expected 2026-08-19, got ${file}`);
  // 当日（北京时间 00:00-08:00）仍是 UTC 前一天
  assert.match(file, /decisions-\d{4}-\d{2}-\d{2}\.jsonl$/);
  rmSync(dir, { recursive: true, force: true });
});

test('fileFor 不传 timeZone 走 UTC（默认行为）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dlog-'));
  const log = new DecisionLog({ enabled: true, dirPath: dir });
  log.projectRoot = process.cwd();
  const file = log.fileFor(new Date('2026-08-18T16:01:00Z'));
  // 16:01 UTC 仍是 2026-08-18
  assert.ok(file.endsWith('decisions-2026-08-18.jsonl'), `expected 2026-08-18, got ${file}`);
  rmSync(dir, { recursive: true, force: true });
});

test('updateConfig 透传 budget.timeZone 到 decision log', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dlog-'));
  mkdirSync(dir, { recursive: true });
  const log = new DecisionLog({ enabled: true, dirPath: dir });
  log.projectRoot = process.cwd();
  log.updateConfig({ decisionLog: { enabled: true }, budget: { timeZone: 'Asia/Shanghai' } });
  // 16:01Z 在 Shanghai 是 2026-08-19 00:01 → 文件名 2026-08-19
  const file = log.fileFor(new Date('2026-08-18T16:01:00Z'));
  assert.ok(file.endsWith('decisions-2026-08-19.jsonl'), `expected 2026-08-19, got ${file}`);
  rmSync(dir, { recursive: true, force: true });
});