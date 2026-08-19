import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import net from 'node:net';

// 飞轮回归：usage 捕获（流式跨 chunk 切割 + 非流式）+ 显式反馈端点
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer(); srv.unref(); srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

test('飞轮：usage 捕获（流式 usage chunk 被切割成两半也能解析）+ feedback 端点', async () => {
  // mock 上游：流式 usage chunk 故意切成两个 TCP 写（验证跨块累积逻辑）
  const usageChunk = JSON.stringify({ id: 'x', choices: [], usage: { prompt_tokens: 200, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 10 } } });
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      const parsed = JSON.parse(body);
      if (parsed.stream === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ id: 'x', choices: [{ delta: { content: 'hi' } }] })}\n\n`);
        const half = Math.floor(usageChunk.length / 2);
        res.write(`data: ${usageChunk.slice(0, half)}`);
        setTimeout(() => { res.write(usageChunk.slice(half) + '\n\ndata: [DONE]\n\n'); res.end(); }, 30);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'x', choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 80, completion_tokens: 20 } }));
      }
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamPort = upstream.address().port;

  const routerPort = await freePort();
  const child = spawn(process.execPath, ['src/server.mjs'], {
    env: { ...process.env, PORT: String(routerPort), HOST: '127.0.0.1', ROUTER_ACCESS_KEY: 'rk', MAAS_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`, MAAS_API_KEY: 'maas', ADMIN_TOKEN: 'adm' },
    cwd: process.cwd(), stdio: 'ignore'
  });
  await sleep(1500);
  try {
    // 1. 流式：客户端正常收到完整 SSE
    const r1 = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer rk' }, body: JSON.stringify({ model: 'auto', stream: true, messages: [{ role: 'user', content: '复杂的长篇分析' }] }) });
    assert.equal(r1.status, 200);
    const sse = await r1.text();
    assert.ok(sse.includes('[DONE]'), '流式应完整收到 [DONE]');
    assert.ok(sse.includes('"usage"'), '流式尾块应含 usage');

    // 2. 非流式
    const r2 = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer rk' }, body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: '简单摘要' }] }) });
    assert.equal(r2.status, 200);
    const j2 = await r2.json();
    assert.equal(j2.usage.prompt_tokens, 80);

    // 3. 决策日志：两条都有 usage（流式跨块切割场景也要捕获）
    await sleep(800);
    const { readFileSync, readdirSync } = await import('node:fs');
    const latest = readdirSync('data/decisions').filter(f => f.endsWith('.jsonl')).sort().pop();
    const rows = readFileSync(`data/decisions/${latest}`, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const last2 = rows.slice(-2);
    const streamRow = last2.find(r => r.request?.redactedBody?.stream === true);
    const plainRow = last2.find(r => r.request?.redactedBody?.stream === false || !r.request?.redactedBody?.stream);
    assert.ok(streamRow, '应存在流式日志行');
    assert.equal(streamRow.outcome.usage?.prompt, 200, `流式 usage 应捕获 prompt=200（跨块切割），实际 ${JSON.stringify(streamRow.outcome.usage)}`);
    assert.equal(streamRow.outcome.usage?.cached, 10);
    assert.ok(streamRow.outcome.actualCostYuan != null, '流式 actualCostYuan 应结算');
    assert.ok(plainRow, '应存在非流式日志行');
    assert.equal(plainRow.outcome.usage?.prompt, 80);

    // 4. feedback 端点：合法写入 + 非法 rating 拒绝
    const fb1 = await fetch(`http://127.0.0.1:${routerPort}/admin/api/feedback`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer adm' }, body: JSON.stringify({ requestId: streamRow.request?.requestId || 'req-x', rating: 'good', comment: '回答准确' }) });
    assert.equal(fb1.status, 200);
    const fb2 = await fetch(`http://127.0.0.1:${routerPort}/admin/api/feedback`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer adm' }, body: JSON.stringify({ requestId: 'r2', rating: 'middle' }) });
    assert.equal(fb2.status, 400);
    const fb3 = await fetch(`http://127.0.0.1:${routerPort}/admin/api/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'r3', rating: 'good' }) });
    assert.equal(fb3.status, 401);
    // feedback 落盘验证
    await sleep(400);
    const { readFileSync: rf2, readdirSync: rd2 } = await import('node:fs');
    const fbFiles = rd2('data/feedback').filter(f => f.endsWith('.jsonl'));
    assert.ok(fbFiles.length >= 1, 'feedback 文件应存在');
    const fbRows = rf2(`data/feedback/${fbFiles.sort().pop()}`, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.equal(fbRows[fbRows.length - 1].rating, 'good');

    // 5. 无鉴权不可读 metrics
    const m = await fetch(`http://127.0.0.1:${routerPort}/admin/api/metrics`, { headers: { authorization: 'Bearer adm' } });
    assert.equal(m.status, 200);
    const mj = await m.json();
    assert.ok(mj.feedback && typeof mj.feedback.written === 'number', 'metrics 应含 feedback 快照');
  } finally {
    child.kill(); upstream.close();
  }
});
