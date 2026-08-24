// v0.8.0 Judge e2e：真实 server 子进程 + mock 上游双角色（业务上游 + judge 上游）。
// 抽样键=服务端 requestId（不信任客户端 x-request-id），测试无法预知命中与否——
// 命中/未命中用 samplePercent=100/0 控制（比例分布行为由 judge.test.mjs 单测覆盖）。
// 验证：①enabled+100% → judge-reviews-*.jsonl 落 quality 事件（rubric hash/judgeModel/
// 四维评分/taskCheck/sessionFingerprint 指纹、原始 sid 不落）②samplePercent=0 → 零事件
// ③judge 上游挂 → error 事件 + 主请求 200 不受影响 ④disabled → 零事件零 judge 调用。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
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

// mock 上游：同端口按 body 特征区分 业务回答 / judge 调用
const JUDGE_MARK = '模型回答质量评审';
function mockUpstream({ judgeBehavior = 'good' } = {}) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, body });
      if (req.url.endsWith('/models')) { res.writeHead(200); return res.end('{"data":[]}'); }
      const isJudge = req.url.endsWith('/chat/completions') && (body.includes(JUDGE_MARK) || body.includes('请求分类核对员'));
      if (isJudge) {
        if (judgeBehavior === 'fail') { res.writeHead(500); return res.end('{"error":"judge down"}'); }
        const isTaskCheck = body.includes('请求分类核对员');
        const content = isTaskCheck
          ? JSON.stringify({ task_agree: true, reason: '判定正确', suggested_task: null })
          : JSON.stringify({ correctness: { score: 8, verifiable: true, reason: '逻辑正确' }, instruction_following: { score: 9, reason: '遵守' }, completeness: { score: 7, verifiable: true, reason: '略简' }, safety: { score: 10, reason: '' }, overall_comment: '总体可靠' });
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } }));
      }
      // 业务回答
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '这是业务回答内容' } }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }));
    });
  });
  return { upstream, seen };
}

const baseConfig = JSON.parse(await readFile(new URL('../config/router.json', import.meta.url), 'utf8'));

async function startRouter({ env }) {
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

async function fire(port, { sessionId = 'judge-sess-1' } = {}) {
  const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer k', 'x-session-id': sessionId },
    body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: '写一段冒泡排序的 Python 代码' }] })
  });
  await r.text();
  return r;
}

async function readJudgeEvents(workDir) {
  const files = await readdir(workDir);
  const f = files.find((x) => x.startsWith('judge-reviews') && x.endsWith('.jsonl'));
  if (!f) return [];
  return (await readFile(join(workDir, f), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
async function waitEvents(workDir, pred, maxMs = 6000) {
  for (let i = 0; i < maxMs / 150; i += 1) {
    await sleep(150);
    const ev = await readJudgeEvents(workDir);
    if (pred(ev)) return ev;
  }
  return readJudgeEvents(workDir);
}

const SECRET = 'judge-e2e-bucket-secret-0123456789abcdef';
async function setupCase({ judgeOver, judgeBehavior = 'good' }) {
  const workDir = await mkdtemp(join(tmpdir(), 'amr-judge-'));
  const cfg = JSON.parse(JSON.stringify(baseConfig));
  cfg.judge = { ...cfg.judge, timeoutMs: 10000, ...judgeOver };
  cfg.decisionLog = { ...cfg.decisionLog, dirPath: workDir };
  await writeFile(join(workDir, 'router.json'), JSON.stringify(cfg));
  const { upstream, seen } = mockUpstream({ judgeBehavior });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const { child, port } = await startRouter({ env: {
    CONFIG_PATH: join(workDir, 'router.json'), SEMANTIC_BUCKET_SECRET: SECRET,
    UPSTREAM_BASE_URL: `http://127.0.0.1:${upstream.address().port}`, UPSTREAM_API_KEY: 'test-key',
    ROUTER_KEY_MODE: 'strict',
  } });
  return { workDir, upstream, seen, child, port };
}

test('e2e judge 100% 抽样：quality+taskCheck 事件落盘、指纹脱敏、judge 上游被调', async () => {
  const { workDir, upstream, seen, child, port } = await setupCase({ judgeOver: { enabled: true, samplePercent: 100, model: 'judge-model-x', taskCheckEnabled: true } });
  try {
    const r = await fire(port);
    assert.equal(r.status, 200, '主请求必须正常（judge 不影响在线路径）');
    const events = await waitEvents(workDir, (ev) => ev.some((e) => e.event === 'quality'));
    const q = events.find((e) => e.event === 'quality');
    assert.ok(q, '100% 抽样应有 quality 事件');
    assert.ok(q.requestId, '事件带 requestId（服务端生成，可关联决策行）');
    assert.equal(q.judgeModel, 'judge-model-x');
    assert.match(q.rubricHash, /^[0-9a-f]{16}$/);
    assert.equal(q.quality.correctness.score, 8);
    assert.equal(q.quality.instruction_following.score, 9);
    assert.equal(q.quality.completeness.score, 7);
    assert.equal(q.quality.safety.score, 10);
    assert.ok(q.taskCheck && q.taskCheck.agree === true, 'taskCheck 应落且 agree=true');
    assert.match(q.sessionFingerprint ?? '', /^sidfp:[0-9a-f]{16}$/, 'sessionFingerprint 指纹格式');
    const rawAll = JSON.stringify(events);
    assert.ok(!rawAll.includes('judge-sess-1'), '原始 session id 不得出现在 judge 事件流');
    assert.ok(q.answeredModel, '事件记录被评的回答模型');
    assert.ok(seen.some((s) => s.body.includes(JUDGE_MARK) && s.body.includes('冒泡排序')), 'judge 调用应带原始问题打到 mock 上游');
  } finally { child.kill(); upstream.close(); }
});

test('e2e samplePercent=0：零事件、零 judge 上游调用（业务回答照常）', async () => {
  const { workDir, upstream, seen, child, port } = await setupCase({ judgeOver: { enabled: true, samplePercent: 0 } });
  try {
    const r = await fire(port);
    assert.equal(r.status, 200);
    await sleep(800);
    const events = await readJudgeEvents(workDir);
    assert.equal(events.length, 0, '0% 抽样不得有任何 judge 事件');
    assert.ok(!seen.some((s) => s.body.includes(JUDGE_MARK)), '0% 不得调 judge 上游');
  } finally { child.kill(); upstream.close(); }
});

test('e2e judge 上游 500：error 事件落盘、主请求 200、无进程异常', async () => {
  const { workDir, upstream, child, port } = await setupCase({ judgeOver: { enabled: true, samplePercent: 100 }, judgeBehavior: 'fail' });
  try {
    const r = await fire(port);
    assert.equal(r.status, 200, 'judge 上游挂不影响主请求');
    const events = await waitEvents(workDir, (ev) => ev.some((e) => e.event === 'error'));
    const err = events.find((e) => e.event === 'error');
    assert.ok(err, '应有 error 事件');
    assert.equal(err.stage, 'quality');
    assert.match(err.error, /500/);
  } finally { child.kill(); upstream.close(); }
});

test('e2e judge disabled：开关关闭零事件、零 judge 调用', async () => {
  const { workDir, upstream, seen, child, port } = await setupCase({ judgeOver: { enabled: false, samplePercent: 100 } });
  try {
    await fire(port);
    await sleep(800);
    const events = await readJudgeEvents(workDir);
    assert.equal(events.length, 0, 'disabled 时不得有任何 judge 事件');
    assert.ok(!seen.some((s) => s.body.includes(JUDGE_MARK)), 'disabled 不得调 judge 上游');
  } finally { child.kill(); upstream.close(); }
});
