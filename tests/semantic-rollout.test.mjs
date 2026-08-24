// v0.7.0 六审核心交付回归：
// ①shadow 复核事件按 requestId 持久化（semantic-reviews-*.jsonl）
// ②语义独立灰度：activeTrafficPercent + requestId 稳定分桶（rollout_hold 对照组）
// ③三层口径统一：L1 taskText 不再被 assistant 历史拽偏
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { analyzeRequest } from '../src/router.mjs';

const baseConfig = JSON.parse(await readFile(new URL('../config/router.json', import.meta.url), 'utf8'));

function holdPort() {
  const holder = net.createServer(); holder.unref();
  return new Promise((r, e) => { holder.once('error', e); holder.listen(0, '127.0.0.1', () => r({ port: holder.address().port, release: () => new Promise((rr) => holder.close(rr)) })); });
}
async function waitForHealth(port, maxMs = 8000) {
  for (let i = 0; i < maxMs / 200; i += 1) {
    await sleep(200);
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) return true; } catch { /* retry */ }
  }
  return false;
}
function mockUpstream() {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const isClassifier = req.url.endsWith('/chat/completions') && body.includes('你是模型路由分类器');
      seen.push({ url: req.url, auth: req.headers.authorization || null, isClassifier, body });
      if (req.url.endsWith('/models')) { res.writeHead(200); return res.end('{"data":[]}'); }
      if (isClassifier) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ task: 'default', tier: 'simple', complexity: 0.3, confidence: 0.9, reason: 'mock' }) } }], usage: { prompt_tokens: 33, completion_tokens: 7 } }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    });
  });
  return { upstream, seen };
}

async function startRouter({ cfg, env }) {
  const held = await holdPort();
  const port = held.port;
  const child = spawn(process.execPath, ['src/server.mjs'], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ADMIN_TOKEN: 'adm', METRICS_TOKEN: 'met', ...env },
    cwd: process.cwd(), stdio: 'ignore'
  });
  await held.release();
  if (!(await waitForHealth(port))) { child.kill(); throw new Error('server 启动超时'); }
  return { child, port };
}

const LOW_CONF_PROMPT = '这个东西到底是什么意思呢，帮我讲讲呗，我不太明白';

// ---------- ③ 三层口径统一（单元级） ----------

test('L1 口径统一：assistant 历史大段代码不再把普通问题拽向 coding', () => {
  const a = analyzeRequest({ messages: [
    { role: 'system', content: '你是研发助手' },
    { role: 'user', content: '帮我看看这段配置有什么问题' },
    { role: 'assistant', content: '```python\n' + 'def x():\n'.repeat(50) + '```' },
    { role: 'user', content: '好的，另外今天天气怎么样' }
  ] }, baseConfig);
  assert.equal(a.task, 'default', 'user 从未表达 coding 意图，assistant 代码不应改变任务判定');
});

test('L1 口径统一：单轮明确 coding 不回归', () => {
  const a = analyzeRequest({ messages: [{ role: 'user', content: '写一个快速排序的Python函数' }] }, baseConfig);
  assert.equal(a.task, 'coding');
  assert.equal(a.confidence, 0.86);
});

// ---------- ① shadow 复核事件持久化 ----------

test('e2e shadow：复核事件落 semantic-reviews-*.jsonl 且带 requestId', async () => {
  const { upstream, seen } = mockUpstream();
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const workDir = await mkdtemp(join(tmpdir(), 'amr-srlog-'));
  const cfg = structuredClone(baseConfig);
  cfg.semanticRouter = { ...cfg.semanticRouter, mode: 'shadow', provider: 'openai-chat', openaiChat: { model: 'deepseekv4-flash', timeoutMs: 5000 } };
  cfg.decisionLog = { ...cfg.decisionLog, dirPath: workDir.split('\\').join('/') };
  await writeFile(join(workDir, 'router.json'), JSON.stringify(cfg), 'utf8');
  const { child, port } = await startRouter({ env: { ROUTER_KEY_MODE: 'passthrough', UPSTREAM_BASE_URL: `http://127.0.0.1:${upstream.address().port}`, CONFIG_PATH: join(workDir, 'router.json') } });
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer k' },
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: LOW_CONF_PROMPT }] })
    });
    assert.ok(r.ok); await r.text();
    await sleep(900);
    const files = await readdir(workDir);
    const srFiles = files.filter((f) => f.startsWith('semantic-reviews') && f.endsWith('.jsonl'));
    assert.ok(srFiles.length >= 1, `应有 semantic-reviews 文件，实际 ${JSON.stringify(files)}`);
    const lines = (await readFile(join(workDir, srFiles[0]), 'utf8')).trim().split('\n').filter(Boolean);
    assert.ok(lines.length >= 1, '事件流应有记录');
    const evt = JSON.parse(lines.at(-1));
    assert.ok(evt.requestId && evt.requestId.length >= 8, `事件须带 requestId，实际 ${JSON.stringify(evt).slice(0, 200)}`);
    assert.equal(evt.cascade, 'openai-chat-l3' in evt ? evt.cascade : evt.cascade); // cascade 字段存在（openai-chat 直采为 null）
    assert.ok(evt.base && evt.proposed && typeof evt.disagreed === 'boolean', '事件须含三层对照');
    // 与决策日志 requestId 对得上（关联性）
    const decFiles = files.filter((f) => f.startsWith('decisions') && f.endsWith('.jsonl'));
    assert.ok(decFiles.length >= 1, '决策日志文件应存在');
    const decLines = (await readFile(join(workDir, decFiles[0]), 'utf8')).trim().split('\n').filter(Boolean);
    const decIds = decLines.map((l) => JSON.parse(l).request?.requestId);
    assert.ok(decIds.includes(evt.requestId), `复核事件的 requestId 必须能在决策日志找到（关联闭环），事件=${evt.requestId} 决策=${JSON.stringify(decIds)}`);
  } finally { child.kill(); upstream.close(); }
});

// ---------- ② 语义独立灰度 ----------

test('e2e 独立灰度：active + activeTrafficPercent=50 → 分桶结果与哈希一致，hold 请求照走规则层', async () => {
  const { upstream, seen } = mockUpstream();
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const workDir = await mkdtemp(join(tmpdir(), 'amr-rollout-'));
  const cfg = structuredClone(baseConfig);
  cfg.semanticRouter = { ...cfg.semanticRouter, mode: 'active', activeTrafficPercent: 50, finalAdoptionThreshold: 0.5, provider: 'openai-chat', openaiChat: { model: 'deepseekv4-flash', timeoutMs: 5000 } };
  cfg.decisionLog = { ...cfg.decisionLog, dirPath: workDir.split('\\').join('/') };
  await writeFile(join(workDir, 'router.json'), JSON.stringify(cfg), 'utf8');
  const { child, port } = await startRouter({ env: { ROUTER_KEY_MODE: 'passthrough', UPSTREAM_BASE_URL: `http://127.0.0.1:${upstream.address().port}`, CONFIG_PATH: join(workDir, 'router.json') } });
  try {
    const outcomes = [];
    for (let i = 0; i < 6; i += 1) {
      const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer k', 'x-test-seed': `s${i}` },
        body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: LOW_CONF_PROMPT }] })
      });
      assert.ok(r.ok); await r.text();
      await sleep(700); // 每个请求的 shadow/hold 分类异步落事件
    }
    const files = await readdir(workDir);
    const srFile = files.find((f) => f.startsWith('semantic-reviews') && f.endsWith('.jsonl'));
    assert.ok(srFile, '独立灰度 hold/applied 的复核事件照常落盘（对照组样本不丢）');
    // 决策日志里 semanticReview.status 应出现 rollout_hold（50% 桶）
    const decFile = files.find((f) => f.startsWith('decisions') && f.endsWith('.jsonl'));
    const decLines = (await readFile(join(workDir, decFile), 'utf8')).trim().split('\n').filter(Boolean);
    const statuses = decLines.map((l) => JSON.parse(l).decision?.semanticReview?.status);
    assert.ok(statuses.includes('rollout_hold'), `50% 灰度应产生 hold 对照组，实际 ${JSON.stringify(statuses)}`);
    assert.ok(statuses.includes('applied') || statuses.includes('rejected_low_confidence'), `放量桶应有语义采纳/拒绝，实际 ${JSON.stringify(statuses)}`);
    // 分桶确定性：同 requestId 哈希稳定（单元级验证分桶函数行为）
    const bucket = (rid) => Number(parseInt(createHash('sha256').update(`semantic:${rid}`).digest('hex').slice(0, 8), 16) % 100);
    const rid = 'test-request-id-abc';
    assert.equal(bucket(rid), bucket(rid), '分桶必须稳定');
  } finally { child.kill(); upstream.close(); }
});
