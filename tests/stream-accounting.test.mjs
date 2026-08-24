// v0.5.2 新增：流式/非流式记账生命周期端到端（Codex 二审 P0×2——
// v0.5.1 流式成功不落账 + 非流式 text() 前记成功双记 + catch 引用 try 内变量）
// 方法：起 mock 上游 + 真实 server（passthrough 模式直连 mock），从 /metrics 读落账结果。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import net from 'node:net';
import http from 'node:http';

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function waitForHealth(port, maxMs = 6000) {
  for (let i = 0; i < maxMs / 200; i += 1) {
    await sleep(200);
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) return true; } catch { /* retry */ }
  }
  return false;
}

// mock 上游：流式按序号切换行为——第 1 次正常完成（SSE 两 chunk + usage 尾块），第 2 次首 chunk 后断流
function startMockUpstream(port) {
  let streamSeq = 0;
  const srv = http.createServer((req, res) => {
    if (req.url.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [] })); }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      if (parsed.stream === true) {
        streamSeq += 1;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"id":"x","choices":[{"delta":{"content":"你好"}}]}\n\n');
        if (streamSeq === 2) { setTimeout(() => res.destroy(), 50); return; } // 第 2 次流式：首 chunk flush 后断流
        res.write('data: {"id":"x","choices":[{"delta":{"content":"世界"}}]}\n\n');
        res.end(`data: {"id":"x","choices":[{"delta":{}}],"usage":{"prompt_tokens":100,"completion_tokens":50}}\n\n`);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'x', choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 100, completion_tokens: 50 } }));
      }
    });
  });
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve(srv)));
}

async function metricsFor(port, token = 'met') {
  const r = await fetch(`http://127.0.0.1:${port}/metrics`, { headers: { authorization: `Bearer ${token}` } });
  return r.text();
}
const metricVal = (text, re) => { const m = text.match(re); return m ? Number(m[1]) : 0; };

test('e2e 记账生命周期：流式成功落 completed、非流式成功落 success、断流落 aborted（各恰一次）', async () => {
  const upstreamPort = await freePort();
  const port = await freePort();
  const upstream = await startMockUpstream(upstreamPort);
  const child = spawn(process.execPath, ['src/server.mjs'], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ROUTER_KEY_MODE: 'passthrough', UPSTREAM_BASE_URL: `http://127.0.0.1:${upstreamPort}`, ADMIN_TOKEN: 'adm', METRICS_TOKEN: 'met' },
    cwd: process.cwd(), stdio: 'ignore', detached: false
  });
  try {
    assert.ok(await waitForHealth(port), 'server 启动超时');
    const post = (payload) => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer any' }, body: JSON.stringify(payload)
    });

    // 1) 流式成功：SSE 完整走完 → completed +1、success +1
    const s1 = await post({ model: 'auto', stream: true, messages: [{ role: 'user', content: '写一句问候' }] });
    assert.equal(s1.status, 200);
    const stext = await s1.text();
    assert.match(stext, /你好/);
    await sleep(300);
    let m = await metricsFor(port);
    const completed1 = metricVal(m, /router_stream_total\{outcome="completed"\} (\d+)/);
    const succ1 = metricVal(m, /router_requests_success_total (\d+)/);
    assert.ok(completed1 >= 1, `流式成功应记 completed（实际 ${completed1}）——v0.5.1 此处恒 0`);
    assert.ok(succ1 >= 1, '流式成功应进 success 计数');

    // 2) 非流式成功：success +1（text() 完成后落账）
    const s2 = await post({ model: 'auto', messages: [{ role: 'user', content: '写一句问候' }] });
    assert.equal(s2.status, 200);
    await s2.text();
    await sleep(300);
    m = await metricsFor(port);
    const succ2 = metricVal(m, /router_requests_success_total (\d+)/);
    assert.equal(succ2, succ1 + 1, `非流式成功应使 success +1（${succ1}→${succ2}）`);

    // 3) 断流：aborted +1 且不新增 success（不双记）
    const s3 = await post({ model: 'auto', stream: true, messages: [{ role: 'user', content: '写一句问候' }] });
    assert.equal(s3.status, 200);
    await s3.text().catch(() => {}); // 断流会抛
    await sleep(300);
    m = await metricsFor(port);
    const aborted = metricVal(m, /router_stream_total\{outcome="aborted"\} (\d+)/);
    const succ3 = metricVal(m, /router_requests_success_total (\d+)/);
    assert.ok(aborted >= 1, `断流应记 aborted（实际 ${aborted}）`);
    assert.equal(succ3, succ2, `断流不得新增 success（${succ2}→${succ3}，防双记）`);
  } finally {
    child.kill(); upstream.close();
  }
}, { timeout: 30000 });