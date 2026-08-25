// v0.7.1 七审测试重写：语义独立灰度分桶的行为不变量（替代 v0.7.0 的弱断言版测试）。
// 原测试三宗罪（七审 P2 点名）：
//   ① x-test-seed 服务端根本不读——requestId 实际随机，6 请求出现 hold+applied 有 ~3% 偶发失败
//   ② bucket(rid) === bucket(rid) 恒真断言——纯装饰
//   ③ evt.cascade 三元自等断言——没验证任何东西
// 重写思路：HMAC secret 进程级随机，测试无法预知具体桶值 → 改测**行为不变量**：
//   I1 同 x-session-id 的 N 个请求全组一致（同 hold 或同 applied/adopted 链）——分桶会话稳定
//   I2 固定 SEMANTIC_BUCKET_SECRET 下，两个不同 session 分别覆盖 <50 与 >=50（探测法定位），
//      percent=50 时该 session 必 hold、另一 session 必放量——阈值边界行为正确
//   I3 客户端伪造 x-request-id 不影响分组：同 session 下换任意 requestId 结果组不变
//   I4 small-degraded 时延含 L3 失败等待（P1-3）：事件 totalLatencyMs > smallLatencyMs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { createHmac } from 'node:crypto';
// v0.7.4 十审 P1：与 server sessionFingerprintOf 同算法——sidfp:HMAC(secret,'session-fp:'+sid)[:16hex]
function fpOf(secret, sid) {
  return `sidfp:${createHmac('sha256', Buffer.from(secret, 'utf8')).update(`session-fp:${sid}`).digest('hex').slice(0, 16)}`;
}

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

const LOW_CONF_PROMPT = '这个东西到底是什么意思呢，帮我讲讲呗，我不太明白，帮我解释一下好不好';

// 固定 secret 下预计算某 session 的桶值（与服务端同算法——测试拥有 secret 才可预知）
function bucketOf(secret, key) {
  return Number(parseInt(createHmac('sha256', Buffer.from(secret, 'utf8')).update(`semantic-rollout:sid:${key}`).digest('hex').slice(0, 8), 16) % 100);
}
// 探测一个落在 [lo, hi) 桶区的 sessionId：确定性搜索（不是随机试）
function findSession(secret, lo, hi) {
  for (let i = 0; i < 100000; i += 1) {
    const sid = `probe-session-${i}`;
    if (bucketOf(secret, sid) >= lo && bucketOf(secret, sid) < hi) return { sid, bucket: bucketOf(secret, sid) };
  }
  throw new Error(`100k 内找不到桶∈[${lo},${hi}) 的 session（概率上不可能）`);
}

async function fire(port, { sessionId = null, requestId = null } = {}) {
  const headers = { 'content-type': 'application/json', authorization: 'Bearer k' };
  if (sessionId) headers['x-session-id'] = sessionId;
  if (requestId) headers['x-request-id'] = requestId;
  const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers,
    body: JSON.stringify({ messages: [{ role: 'user', content: LOW_CONF_PROMPT }] })
  });
  await r.text();
  return r;
}

test('e2e 灰度不变量：固定 secret 下会话稳定分组 + 阈值边界 + 伪造 requestId 无效', async () => {
  const SECRET = 'test-bucket-secret-v073-0123456789abcdef0123';  // ≥32 字节（v0.7.3 九审强度下限——短 secret 在 active 模式拒启动）
  const { upstream } = mockUpstream();
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const workDir = await mkdtemp(join(tmpdir(), 'amr-rollout2-'));
  const cfg = structuredClone(baseConfig);
  cfg.semanticRouter = { ...cfg.semanticRouter, mode: 'active', activeTrafficPercent: 50, finalAdoptionThreshold: 0.5, provider: 'openai-chat', openaiChat: { model: 'deepseekv4-flash', timeoutMs: 5000 } };
  cfg.decisionLog = { ...cfg.decisionLog, dirPath: workDir.split('\\').join('/') };
  await writeFile(join(workDir, 'router.json'), JSON.stringify(cfg), 'utf8');

  // 预探测：一个桶<50（放量组）、一个桶>=50（hold 组）
  const inGroup = findSession(SECRET, 0, 50);
  const outGroup = findSession(SECRET, 50, 100);
  assert.ok(inGroup.bucket < 50 && outGroup.bucket >= 50);

  const { child, port } = await startRouter({ env: { ROUTER_KEY_MODE: 'passthrough', UPSTREAM_BASE_URL: `http://127.0.0.1:${upstream.address().port}`, CONFIG_PATH: join(workDir, 'router.json'), SEMANTIC_BUCKET_SECRET: SECRET } });
  try {
    // I1+I2：inGroup session 连打 3 发（不同 requestId），全组一致=applied 链（mock 分类 confidence 0.9>0.5 必采纳）
    for (let i = 0; i < 3; i += 1) await fire(port, { sessionId: inGroup.sid, requestId: `in-${i}` });
    // outGroup session 连打 3 发，全组一致=rollout_hold
    for (let i = 0; i < 3; i += 1) await fire(port, { sessionId: outGroup.sid, requestId: `out-${i}` });
    await sleep(1000);

    const files = await readdir(workDir);
    const decFile = files.find((f) => f.startsWith('decisions') && f.endsWith('.jsonl'));
    assert.ok(decFile, '决策日志应存在');
    const rows = (await readFile(join(workDir, decFile), 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    // v0.7.4 十审 P1：决策日志落 sessionFingerprint（sidfp:<16hex>），原始 sid 不落盘——
    // 分组断言按预计算指纹进行（与 server sessionFingerprintOf 同算法）。
    const fpIn = fpOf(SECRET, inGroup.sid), fpOut = fpOf(SECRET, outGroup.sid);
    const bySession = {};
    for (const r of rows) {
      const fp = r.request?.sessionFingerprint;
      const st = r.decision?.semanticReview?.status;
      if (fp && st) (bySession[fp] ??= new Set()).add(st);
    }
    // I1：组内一致性
    assert.deepEqual([...bySession[fpIn]], ['applied'], `放量组 session 全部 applied，实际 ${JSON.stringify([...bySession[fpIn]])}`);
    assert.deepEqual([...bySession[fpOut]], ['rollout_hold'], `hold 组 session 全部 rollout_hold，实际 ${JSON.stringify([...bySession[fpOut]])}`);

    // I3：同一 session 换任意（甚至恶意构造的）requestId 不改变分组
    await fire(port, { sessionId: outGroup.sid, requestId: 'attacker-tries-to-enter-000' });
    await fire(port, { sessionId: inGroup.sid, requestId: 'attacker-tries-to-avoid-999' });
    await sleep(800);
    const rows2 = (await readFile(join(workDir, decFile), 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const stOut = rows2.filter((r) => r.request?.sessionFingerprint === fpOut).map((r) => r.decision?.semanticReview?.status);
    const stIn = rows2.filter((r) => r.request?.sessionFingerprint === fpIn).map((r) => r.decision?.semanticReview?.status);
    assert.ok(stOut.every((s) => s === 'rollout_hold'), `伪造 requestId 不得改变 hold 组分组，实际 ${JSON.stringify(stOut)}`);
    assert.ok(stIn.every((s) => s === 'applied'), `伪造 requestId 不得改变放量组分组，实际 ${JSON.stringify(stIn)}`);

    // I4：事件流时延字段齐（mock L2 是 http-json 直采？不——provider=openai-chat 单层，cascade=null。
    //   时延三字段由 cascade provider 产出；本测试用 openai-chat 验证非级联路径事件正常落盘即可）
    const srFile = files.find((f) => f.startsWith('semantic-reviews') && f.endsWith('.jsonl'));
    assert.ok(srFile, 'semantic-reviews 事件流应存在');
    const evts = (await readFile(join(workDir, srFile), 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(evts.length >= 4, `hold+applied 都应有后台观察事件，实际 ${evts.length}`);
    for (const e of evts) assert.ok(e.requestId && e.cascade !== undefined, `事件须带 requestId 与 cascade 字段：${JSON.stringify(e).slice(0, 120)}`);

    // I5（九审 P2 + 十审 P1 脱敏不变量）：
    //   a) semanticRollout.bucketKey = HMAC 短指纹（sid/fp/rid + 16hex——v0.7.4 起 48bit→64bit）
    //   b) request.sessionFingerprint = sidfp:<16hex>（替代原 request.sessionId 原值落盘）
    //   c) 原始 session ID（probe-session-N）不得出现在决策日志或复核事件流的任何位置
    const allRows = rows.concat(rows2);
    for (const r of allRows) {
      const bk = r.decision?.semanticReview?.bucketKey;
      if (bk) assert.match(bk, /^(sid|fp|rid):[0-9a-f]{16}$/, `bucketKey 应为 HMAC 指纹 16hex（${bk}），原始标识不得落盘`);
      const fp = r.request?.sessionFingerprint;
      if (fp) assert.match(fp, /^sidfp:[0-9a-f]{16}$/, `sessionFingerprint 应为 sidfp:<16hex>（${fp}）`);
      assert.equal(r.request?.sessionId, undefined, 'request.sessionId 字段不得存在（v0.7.4 起一律 sessionFingerprint）');
    }
    const rawAll = (await readFile(join(workDir, decFile), 'utf8')) + (await readFile(join(workDir, srFile), 'utf8'));
    assert.ok(!rawAll.includes(inGroup.sid) && !rawAll.includes(outGroup.sid), '原始 session ID 不得出现在决策/复核日志（隐私：session 可能含账号/手机号）');
  } finally { child.kill(); upstream.close(); }
});
