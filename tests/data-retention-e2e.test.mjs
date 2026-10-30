// 数据留存模式 e2e：redactMessages=false + logAnswerText=true → 请求原文与回答原文入决策日志。
// 场景：低流量期攒训练数据（离线训练取数），开关默认保持脱敏（redactMessages=true / logAnswerText=false）。
// 断言：①请求消息全量落盘（content 完整字符串）②outcome.answerText=非流式纯正文 ③流式=SSE delta 拼接
// ④非文本 content 标注 [non-text] ⑤redactMessages=true 时 logAnswerText 仍独立生效（回答落、请求脱敏）
// ⑥关闭 logAnswerText → 无 answerText 字段。复用 judge-e2e 的双角色 mock 与守卫纪律（workDir 隔离）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

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
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url.endsWith('/models')) { res.writeHead(200); return res.end('{"data":[]}'); }
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* ignore */ }
      if (parsed && parsed.stream === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const events = [
          { choices: [{ delta: { role: 'assistant' } }] },
          { choices: [{ delta: { content: '流式回答' } }] },
          { choices: [{ delta: { content: '第二段' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ];
        for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
        res.write('data: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":10,"total_tokens":30}}\n\n');
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '这是非流式业务回答' } }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }));
    });
  });
  return { upstream };
}

const baseConfig = JSON.parse(await readFile(new URL('../config/router.json', import.meta.url), 'utf8'));

const projectDataGuard = join(process.cwd(), 'data', 'judge-guard-state.json');
let guardBefore = null;
try { guardBefore = (await stat(projectDataGuard)).mtimeMs; } catch { /* 不存在=好 */ }
after(async () => {
  try { const now = (await stat(projectDataGuard)).mtimeMs; if (guardBefore != null) assert.equal(now, guardBefore, '测试不得修改项目 data/judge-guard-state.json'); } catch { /* 不存在=好 */ }
});

async function startRouter({ env }) {
  const held = await holdPort();
  const port = held.port;
  let childLog = '';
  const child = spawn(process.execPath, ['src/server.mjs'], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ADMIN_TOKEN: 'adm', METRICS_TOKEN: 'met', ...env },
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (c) => { childLog += c; childLog = childLog.slice(-8000); });
  child.stderr.on('data', (c) => { childLog += c; childLog = childLog.slice(-8000); });
  await held.release();
  if (!(await waitForHealth(port))) {
    child.kill();
    const tail = childLog.split(/\r?\n/).slice(-40).join('\n');
    throw new Error(`server 启动超时——子进程输出尾部：\n${tail || '(无输出)'}`);
  }
  return { child, port };
}

async function setupCase({ decisionOver }) {
  const workDir = await mkdtemp(join(tmpdir(), 'amr-retain-'));
  const cfg = JSON.parse(JSON.stringify(baseConfig));
  cfg.judge = { ...cfg.judge, enabled: false, guardStatePath: join(workDir, 'judge-guard-state.json') };
  cfg.decisionLog = { ...cfg.decisionLog, dirPath: workDir, ...decisionOver };
  await writeFile(join(workDir, 'router.json'), JSON.stringify(cfg));
  const { upstream } = mockUpstream();
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const { child, port } = await startRouter({ env: {
    CONFIG_PATH: join(workDir, 'router.json'), SEMANTIC_BUCKET_SECRET: 'retain-e2e-secret-0123456789abcdef',
    UPSTREAM_BASE_URL: `http://127.0.0.1:${upstream.address().port}`, UPSTREAM_API_KEY: 'test-key',
    ROUTER_KEY_MODE: 'strict',
  } });
  return { workDir, upstream, child, port };
}

async function fire(port, { stream = false, content = '训练数据采集：解释什么是梯度下降', withImage = false } = {}) {
  const messages = withImage
    ? [{ role: 'user', content: [{ type: 'text', text: '看图说话' }, { type: 'image_url', image_url: { url: 'http://x/img.png' } }] }]
    : [{ role: 'user', content }];
  const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer k', 'x-session-id': 'retain-sess-1' },
    body: JSON.stringify({ stream, messages })
  });
  await r.text();
  return r;
}

async function readDecisions(workDir) {
  const files = await readdir(workDir);
  const f = files.find((x) => x.startsWith('decisions-') && x.endsWith('.jsonl'));
  if (!f) return [];
  return (await readFile(join(workDir, f), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
async function waitRows(workDir, pred, maxMs = 6000) {
  for (let i = 0; i < maxMs / 150; i += 1) {
    await sleep(150);
    const rows = await readDecisions(workDir);
    if (pred(rows)) return rows;
  }
  return readDecisions(workDir);
}

async function cleanupCase({ child, upstream, workDir }) {
  // SIGTERM starts asynchronous draining; wait until the log writer has exited.
  if (child.exitCode === null && child.signalCode === null) {
    const closed = once(child, 'close');
    child.kill();
    await closed;
  }
  await new Promise((resolve) => upstream.close(resolve));
  await rm(workDir, { recursive: true, force: true });
}

test('e2e 数据留存全开：请求原文全量 + 非流式/流式回答原文入决策日志', async () => {
  const { workDir, upstream, child, port } = await setupCase({ decisionOver: { redactMessages: false, logAnswerText: true } });
  try {
    // 非流式
    let r = await fire(port);
    assert.equal(r.status, 200);
    // 流式
    r = await fire(port, { stream: true });
    assert.equal(r.status, 200);
    // 带图（非文本 content）——标注而非丢弃
    r = await fire(port, { withImage: true });
    assert.equal(r.status, 200);
    const rows = await waitRows(workDir, (rs) => rs.length >= 3);
    assert.equal(rows.length, 3, '三请求三行');
    const [nonStream, stream, image] = rows;
    // ① 请求原文全量（content 完整字符串）
    const msg = nonStream.request.redactedBody.messages[0];
    assert.equal(typeof msg.content, 'string', 'redactMessages=false 时 content 应为完整字符串');
    assert.ok(msg.content.includes('梯度下降'), '请求原文完整落盘');
    assert.equal(msg.chars, msg.content.length, 'chars 与全量长度一致');
    // ② 非流式回答原文
    assert.equal(nonStream.outcome.answerText, '这是非流式业务回答', '非流式 answerText=纯正文');
    // ③ 流式回答原文 = SSE delta 拼接
    assert.equal(stream.outcome.answerText, '流式回答第二段', '流式 answerText=delta 拼接');
    // ④ 非文本 content 标注
    const imgMsg = image.request.redactedBody.messages[0];
    assert.equal(imgMsg.content, '[non-text]', '非文本 content 标注 [non-text]');
    // ⑤ 密钥永不落盘
    const raw = JSON.stringify(rows);
    assert.ok(!raw.includes('test-key'), '上游 key 不得出现在决策日志');
    const headers = { authorization: 'Bearer adm' };
    for (const path of ['/admin/api/decisions', '/admin/api/annotation-export']) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
      assert.equal(response.status, 200);
      const hidden = await response.text();
      assert.ok(!hidden.includes('梯度下降') && !hidden.includes('这是非流式业务回答'), '默认管理查询不泄露已采集的正文');
      const full = await fetch(`http://127.0.0.1:${port}${path}?fullText=1`, { headers });
      assert.equal(full.status, 200);
      assert.ok((await full.text()).includes('梯度下降'), '显式授权导出仍能供标注与训练使用');
    }
  } finally { await cleanupCase({ child, upstream, workDir }); }
});

test('e2e 留存开关独立：redactMessages=true + logAnswerText=true → 请求仍脱敏，回答照落', async () => {
  const { workDir, upstream, child, port } = await setupCase({ decisionOver: { redactMessages: true, logAnswerText: true } });
  try {
    const r = await fire(port);
    assert.equal(r.status, 200);
    const rows = await waitRows(workDir, (rs) => rs.length >= 1);
    const row = rows[0];
    const msg = row.request.redactedBody.messages[0];
    assert.equal(typeof msg.content, 'undefined', 'redactMessages=true 时无 content 字段');
    assert.equal(msg.head, undefined, '脱敏日志不保存正文前缀');
    assert.equal(row.outcome.answerText, '这是非流式业务回答', 'logAnswerText 独立生效——回答照落');
  } finally { await cleanupCase({ child, upstream, workDir }); }
});

test('e2e 留存关闭（默认）：无 answerText 字段、请求脱敏', async () => {
  const { workDir, upstream, child, port } = await setupCase({ decisionOver: {} });
  try {
    const r = await fire(port);
    assert.equal(r.status, 200);
    const rows = await waitRows(workDir, (rs) => rs.length >= 1);
    const row = rows[0];
    assert.equal(row.outcome.answerText, undefined, 'logAnswerText=false 时无 answerText');
    const msg = row.request.redactedBody.messages[0];
    assert.equal(typeof msg.content, 'undefined', '默认请求脱敏');
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/annotation-export?fullText=1`, { headers: { authorization: 'Bearer adm' } });
    const exported = await response.json();
    const annotation = exported.rows?.[0] ?? exported.data?.[0];
    assert.ok(annotation, 'annotation row exists');
    assert.equal(annotation.textAvailable, false, '只有元数据不能假装具有训练文本');
    assert.equal(annotation.textTruncated, true, '缺正文必须显式标记');
  } finally { await cleanupCase({ child, upstream, workDir }); }
});
