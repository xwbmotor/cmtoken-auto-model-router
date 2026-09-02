// v0.5.3 新增（Codex 三审 P1×2 端到端验证）：
//  1) 超时 fallback：第一个模型 hang 超时后，第二个模型必须真正发起请求并成功——
//     验证「每 attempt 独立 AbortController」。v0.5.2 单例 controller 被第一次超时
//     abort 污染，fallback 复用已 aborted 的 signal 会立即失败（客户端拿到 502）。
//  2) 非流式客户端断开：大响应写回途中客户端断开 → 必须记失败不记成功——
//     验证「成功落账在客户端交付完成后」。v0.5.2 在 text() 读毕即记成功，
//     写回失败时成功闸已关，catch 的失败落账成 no-op（健康/计数全记成功）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import net from 'node:net';
import http from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer(); srv.unref(); srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}
// v0.5.3 修测试竞态（同 stream-accounting）：freePort 探针号码在并行测试下会被抢注。
// mock 上游 listen(0) 内核分配；router 端口 holdPort 先占后放（窗口 <1ms）。
async function holdPort() {
  const holder = net.createServer(); holder.unref();
  await new Promise((r, e) => { holder.once('error', e); holder.listen(0, '127.0.0.1', r); });
  return { port: holder.address().port, release: () => new Promise((r) => holder.close(r)) };
}

async function waitForHealth(port, maxMs = 8000) {
  for (let i = 0; i < maxMs / 200; i += 1) {
    await sleep(200);
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) return true; } catch { /* retry */ }
  }
  return false;
}

async function metricsFor(port) {
  const r = await fetch(`http://127.0.0.1:${port}/metrics`, { headers: { authorization: 'Bearer met' } });
  return r.text();
}
const metricVal = (text, re) => { const m = text.match(re); return m ? Number(m[1]) : 0; };

// 临时 config：独立数据目录 + 1s 超时（快速触发 attempt 1 超时）
async function makeSandbox(upstreamPort) {
  const dataDir = await mkdtemp(join(tmpdir(), 'amr-timeout-'));
  const config = JSON.parse(await readFile(join(projectRoot, 'config', 'router.json'), 'utf8'));
  config.upstreamBaseUrl = `http://127.0.0.1:${upstreamPort}/v1`;
  config.routing = { ...config.routing, requestTimeoutMs: 1000, maxAttempts: 3, circuitBreakerFailures: 50 };
  config.decisionLog = { ...(config.decisionLog || {}), enabled: true, dirPath: join(dataDir, 'decisions') };
  config.budget = { ...(config.budget || {}), ledgerPath: join(dataDir, 'budget-ledger.json') };
  const configPath = join(dataDir, 'router.json');
  await writeFile(configPath, JSON.stringify(config), 'utf8');
  return { dataDir, configPath };
}

test('e2e 超时 fallback：attempt 1 超时不得污染 attempt 2（独立 controller）', async () => {
  // mock 上游：第 1 次请求 hang 3s（远超 1s 超时），第 2 次起立即成功
  let seq = 0;
  const upstream = http.createServer((req, res) => {
    if (req.url.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [] })); }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seq += 1;
      if (seq === 1) { setTimeout(() => { try { res.end(); } catch { /* router 已断开 */ } }, 3000); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'x', choices: [{ message: { role: 'assistant', content: 'fallback ok' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    });
  });
  // v0.5.3 修测试竞态（同 stream-accounting）：mock 上游 listen(0) 内核分配，零碰撞
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const realUpstreamPort = upstream.address().port;
  const held = await holdPort();
  const port = held.port;
  const { configPath, dataDir } = await makeSandbox(realUpstreamPort);
  const child = spawn(process.execPath, ['src/server.mjs'], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ROUTER_KEY_MODE: 'passthrough', MAAS_BASE_URL: `http://127.0.0.1:${realUpstreamPort}/v1`, ADMIN_TOKEN: 'adm', METRICS_TOKEN: 'met', CONFIG_PATH: configPath, AMR_COUNTERS_PATH: join(dataDir, 'counters.json') },
    cwd: process.cwd(), stdio: 'ignore'
  });
  await held.release();
  try {
    assert.ok(await waitForHealth(port), 'server 启动超时');
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer any' },
      body: JSON.stringify({ messages: [{ role: 'user', content: '写一句问候' }] })
    });
    // v0.5.2 单例 controller：attempt 2 复用 aborted signal → fetch 立即抛 → 502。
    // v0.5.3 独立 controller：attempt 2 正常发出 → 200。
    assert.equal(r.status, 200, 'attempt 1 超时后 fallback 必须成功（v0.5.2 此处 502）');
    const j = await r.json();
    assert.match(j.choices[0].message.content, /fallback ok/);
    await sleep(400);
    const m = await metricsFor(port);
    const fallbacks = metricVal(m, /router_fallbacks_total (\d+)/);
    const success = metricVal(m, /router_requests_success_total (\d+)/);
    assert.ok(fallbacks >= 1, `应记一次 fallback（实际 ${fallbacks}）`);
    assert.ok(success >= 1, `fallback 成功应进 success（实际 ${success}）`);
  } finally {
    child.kill(); upstream.close(); upstream.closeAllConnections?.();
    const { rm } = await import('node:fs/promises'); await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
}, { timeout: 30000 });

test('e2e 非流式客户端断开：写回前断开记失败不记成功（交付完成语义）', async () => {
  // Codex 三审 P1 场景：客户端已断开，服务端仍记成功。确定性复现——上游延迟 300ms 才响应，
  // 客户端 100ms 时硬断：服务端 writeHead/end 发生在已死 socket 上，close 时 writableFinished=false。
  // （不采用「大响应+中途 RST」：Windows loopback 内核以内存拷贝速度 ACK 全部 32MB，
  //   res.end() 总是先于 RST 完成——该场景在本机物理上不可复现，生产 Linux EPIPE 才触发）
  const payload = JSON.stringify({ id: 'x', choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  const upstream = http.createServer((req, res) => {
    if (req.url.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [] })); }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(payload); }, 300));
  });
  // v0.5.3 修测试竞态（同 stream-accounting）：mock 上游 listen(0) 内核分配，零碰撞
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const realUpstreamPort = upstream.address().port;
  const held = await holdPort();
  const port = held.port;
  const { configPath, dataDir } = await makeSandbox(realUpstreamPort);
  const child = spawn(process.execPath, ['src/server.mjs'], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ROUTER_KEY_MODE: 'passthrough', MAAS_BASE_URL: `http://127.0.0.1:${realUpstreamPort}/v1`, ADMIN_TOKEN: 'adm', METRICS_TOKEN: 'met', CONFIG_PATH: configPath, AMR_COUNTERS_PATH: join(dataDir, 'counters.json') },
    cwd: process.cwd(), stdio: 'ignore'
  });
  await held.release();
  try {
    assert.ok(await waitForHealth(port), 'server 启动超时');
    const reqBody = JSON.stringify({ messages: [{ role: 'user', content: '写一句问候' }] });
    const sock = net.connect({ port, host: '127.0.0.1' });
    sock.on('error', () => {});
    sock.write(`POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nAuthorization: Bearer any\r\nContent-Length: ${Buffer.byteLength(reqBody)}\r\nConnection: close\r\n\r\n${reqBody}`);
    await sleep(100);  // 上游还在延迟窗口内，服务端尚未写回
    sock.destroy();    // 客户端先走：服务端后续 writeHead/end 全部落在死 socket 上
    await sleep(1200); // 等上游 300ms 响应 + 服务端 close 事件 + 落账
    const m = await metricsFor(port);
    const success = metricVal(m, /router_requests_success_total (\d+)/);
    const errors = metricVal(m, /router_requests_total\{mode="auto",outcome="error"\} (\d+)/);
    // v0.5.2：text() 读毕即记成功 → 客户端没收到也 success=1。v0.5.3：交付未完成 → 不记成功。
    assert.equal(success, 0, `客户端断开不得记 success（实际 ${success}）——v0.5.2 此处为 1`);
    assert.ok(errors >= 1, `客户端断开应记 error（实际 ${errors}）`);
  } finally {
    child.kill(); upstream.close(); upstream.closeAllConnections?.();
    const { rm } = await import('node:fs/promises'); await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
}, { timeout: 30000 });