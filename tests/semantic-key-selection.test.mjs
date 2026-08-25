// v0.7.0 六审 P2 测试债：strict 模式大模型分类器的 key 选择——行为级测试。
// 原 fifth-review.test.mjs 只断言源码字符串（变量改名误失败/逻辑绕过误通过），本文件用
// mock MaaS 真实启动 strict Router，断言上游收到的 Authorization 是服务端 MaaS Key，
// 不是客户端传来的 Router Key。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

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

test('e2e strict：L3 分类调用打到 MaaS 的是服务端 Key，不是客户端 Router Key', async () => {
  // mock MaaS：记录所有收到的 Authorization；/models 返回空表（防套餐过滤）；分类端点返回低置信→不触发升级的大模型直采路径需要 openai-chat；这里直接用 openai-chat provider 强制 L3
  const seenAuth = [];
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      // 分类调用特征：单条 user 消息以「你是模型路由分类器」开头（semantic-router prompt）
      const isClassifier = req.url.endsWith('/chat/completions') && body.includes('你是模型路由分类器');
      seenAuth.push({ url: req.url, auth: req.headers.authorization || null, isClassifier });
      if (req.url.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [] })); }
      if (isClassifier) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ task: 'reasoning', tier: 'complex', complexity: 0.7, confidence: 0.88, reason: 'mock' }) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamPort = upstream.address().port;

  const workDir = await mkdtemp(join(tmpdir(), 'amr-strict-'));
  const cfg = structuredClone(baseConfig);
  // shadow + openai-chat：每个 auto 请求都会后台触发 L3 分类（不打扰主请求）
  cfg.semanticRouter = { ...cfg.semanticRouter, mode: 'shadow', provider: 'openai-chat', openaiChat: { model: 'deepseekv4-flash', timeoutMs: 5000 } };
  cfg.decisionLog = { ...cfg.decisionLog, dirPath: workDir.split('\\').join('/') };
  await writeFile(join(workDir, 'router.json'), JSON.stringify(cfg), 'utf8');

  const held = await holdPort();
  const port = held.port;
  const child = spawn(process.execPath, ['src/server.mjs'], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ROUTER_KEY_MODE: 'strict', ROUTER_ACCESS_KEY: 'router-secret-key-123', UPSTREAM_API_KEY: 'maas-server-key-456', UPSTREAM_BASE_URL: `http://127.0.0.1:${upstreamPort}`, ADMIN_TOKEN: 'adm', METRICS_TOKEN: 'met', CONFIG_PATH: join(workDir, 'router.json') },
    cwd: process.cwd(), stdio: 'ignore'
  });
  await held.release();
  try {
    assert.ok(await waitForHealth(port), 'server 启动超时');
    // 客户端只持 Router Key（strict 语义）——发一个低置信请求触发语义复核
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer router-secret-key-123' },
      body: JSON.stringify({ messages: [{ role: 'user', content: '这个东西到底是什么意思呢，帮我讲讲呗，我不太明白' }] })
    });
    assert.ok(r.ok, `auto 请求应 200，实际 ${r.status}`);
    await r.text();
    await sleep(900); // shadow 后台分类是异步的
    const classifyCalls = seenAuth.filter((x) => x.isClassifier);
    assert.ok(classifyCalls.length >= 1, `应有分类调用打到 mock 上游，实际 ${JSON.stringify(seenAuth)}`);
    for (const call of classifyCalls) {
      assert.equal(call.auth, 'Bearer maas-server-key-456', `分类调用必须带服务端 MaaS Key，实际 ${call.auth}`);
    }
    // 主请求（chat/completions）同样必须是服务端 key（strict 不透传客户端 Router Key）
    const mainCalls = seenAuth.filter((x) => !x.isClassifier && x.url.endsWith('/chat/completions'));
    assert.ok(mainCalls.length >= 1, '主请求应打到上游');
    for (const call of mainCalls) assert.equal(call.auth, 'Bearer maas-server-key-456');
  } finally {
    child.kill();
    upstream.close();
  }
});

test('e2e passthrough：L3 分类透传客户端 MaaS Key（四审行为不回归）', async () => {
  const seenAuth = [];
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const isClassifier = req.url.endsWith('/chat/completions') && body.includes('你是模型路由分类器');
      seenAuth.push({ url: req.url, auth: req.headers.authorization || null, isClassifier });
      if (req.url.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [] })); }
      if (isClassifier) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ task: 'reasoning', tier: 'complex', complexity: 0.7, confidence: 0.88, reason: 'mock' }) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamPort = upstream.address().port;

  const workDir = await mkdtemp(join(tmpdir(), 'amr-pass-'));
  const cfg = structuredClone(baseConfig);
  cfg.semanticRouter = { ...cfg.semanticRouter, mode: 'shadow', provider: 'openai-chat', openaiChat: { model: 'deepseekv4-flash', timeoutMs: 5000 } };
  cfg.decisionLog = { ...cfg.decisionLog, dirPath: workDir.split('\\').join('/') };
  await writeFile(join(workDir, 'router.json'), JSON.stringify(cfg), 'utf8');

  const held = await holdPort();
  const port = held.port;
  const child = spawn(process.execPath, ['src/server.mjs'], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ROUTER_KEY_MODE: 'passthrough', UPSTREAM_BASE_URL: `http://127.0.0.1:${upstreamPort}`, ADMIN_TOKEN: 'adm', METRICS_TOKEN: 'met', CONFIG_PATH: join(workDir, 'router.json') },
    cwd: process.cwd(), stdio: 'ignore'
  });
  await held.release();
  try {
    assert.ok(await waitForHealth(port), 'server 启动超时');
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tenant-maas-key-789' },
      body: JSON.stringify({ messages: [{ role: 'user', content: '这个东西到底是什么意思呢，帮我讲讲呗，我不太明白' }] })
    });
    assert.ok(r.ok);
    await r.text();
    await sleep(900);
    const classifyCalls = seenAuth.filter((x) => x.isClassifier);
    assert.ok(classifyCalls.length >= 1, `passthrough 下分类调用应发生，实际 ${JSON.stringify(seenAuth)}`);
    for (const call of classifyCalls) assert.equal(call.auth, 'Bearer tenant-maas-key-789', 'passthrough 分类必须透传客户端 key');
  } finally {
    child.kill();
    upstream.close();
  }
});
