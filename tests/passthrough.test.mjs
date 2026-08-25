import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import net from 'node:net';

// passthrough 模式端到端：客户端的 MaaS key 原样到达上游（同 URL 同 key 分流场景）
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

test('passthrough：客户端 Authorization 原样转发上游 + 入口只查非空', async () => {
  // 1. mock MaaS：记录鉴权头，回一个合法 chat completion
  const seenAuth = [];
  const upstream = http.createServer((req, res) => {
    seenAuth.push(req.headers.authorization);
    if (req.url.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}'); }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamPort = upstream.address().port;

  // 2. passthrough 模式起路由器（注意：故意不设 ROUTER_ACCESS_KEY 语义、不设 MAAS_API_KEY——key 全靠客户端带）
  const routerPort = await freePort();
  const child = spawn(process.execPath, ['src/server.mjs'], {
    env: { ...process.env, PORT: String(routerPort), HOST: '127.0.0.1', ROUTER_KEY_MODE: 'passthrough', MAAS_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`, ADMIN_TOKEN: 'adm', METRICS_TOKEN: 'met' },
    cwd: process.cwd(), stdio: 'ignore'
  });
  try {
    let healthy = false;
    for (let i = 0; i < 25 && !healthy; i++) { await sleep(200); try { healthy = (await fetch(`http://127.0.0.1:${routerPort}/health`)).ok; } catch { /* retry */ } }
    assert.ok(healthy, 'server should be healthy');

    // 3a. 无 key → 401（缺 Authorization）
    const noKey = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: '你好' }] }) });
    assert.equal(noKey.status, 401);

    // 3b. 带租户 key → 200，且上游收到的就是调用方的 key（非 Bearer+服务端 key 拼接）
    const tenantKey = 'sk-tenant-abc123';
    const ok = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tenantKey}` },
      body: JSON.stringify({ messages: [{ role: 'user', content: '你好' }] })
    });
    assert.equal(ok.status, 200, 'tenant key request should succeed');
    const payload = await ok.json();
    assert.equal(payload.choices[0].message.content, 'ok');

    // 上游必须收到原样的客户端头
    assert.ok(seenAuth.includes(`Bearer ${tenantKey}`), `upstream should see tenant key, saw: ${JSON.stringify(seenAuth)}`);
    assert.ok(!seenAuth.includes('Bearer undefined'), 'never forward undefined key');

    // 3c. 显式模型同样透传（分流场景：MaaS 网关把非 auto 请求直连、auto 才进路由器；两种都应透传）
    await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tenantKey}` },
      body: JSON.stringify({ model: 'deepseekv4-flash', messages: [{ role: 'user', content: '你好' }] })
    });
    assert.ok(seenAuth.filter((x) => x === `Bearer ${tenantKey}`).length >= 2, 'explicit model request also passes key through');
  } finally {
    child.kill('SIGTERM');
    await sleep(300);
    upstream.close();
  }
}, 20000);
