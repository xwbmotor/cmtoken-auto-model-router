import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

// 动态申请空闲端口，避免与常驻服务（如分类器 :8788）撞车
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function waitForHealth(port, maxMs = 5000) {
  for (let i = 0; i < maxMs / 200; i += 1) {
    await sleep(200);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return await r.json();
    } catch { /* not yet */ }
  }
  return null;
}

function spawnServer(port, extraEnv = {}) {
  return spawn(process.execPath, ['src/server.mjs'], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ROUTER_ACCESS_KEY: 'test-key', ADMIN_TOKEN: 'adm', METRICS_TOKEN: 'met', ...extraEnv },
    cwd: process.cwd(),
    stdio: 'ignore',
    detached: false
  });
}

test('real server: 健康检查 + 大请求体上限 + /metrics 鉴权 + /health/ready', async () => {
  const port = await freePort();
  const child = spawnServer(port);
  let exited = false;
  child.once('exit', () => { exited = true; });
  try {
    const hj = await waitForHealth(port);
    assert.ok(hj, 'server 启动超时');
    assert.equal(hj.status, 'ok');

    // /metrics 鉴权 + 磁盘指标
    const noAuth = await fetch(`http://127.0.0.1:${port}/metrics`);
    assert.equal(noAuth.status, 401);
    const withAuth = await fetch(`http://127.0.0.1:${port}/metrics`, { headers: { authorization: 'Bearer met' } });
    assert.equal(withAuth.status, 200);
    const mtext = await withAuth.text();
    assert.match(mtext, /router_uptime_seconds \d/);
    assert.match(mtext, /router_requests_total/);
    assert.match(mtext, /router_config_version\{version="\d+\.\d+\.\d+"\} 1/);
    assert.match(mtext, /router_decision_log_disk_bytes \d/);
    assert.match(mtext, /router_decision_log_disk_files \d/);

    // /health/ready：未配上游 → 503 not_ready
    const ready = await fetch(`http://127.0.0.1:${port}/health/ready`);
    assert.equal(ready.status, 503);
    const rj = await ready.json();
    assert.equal(rj.ready, false);
    assert.equal(rj.upstreamReachable, false);
    assert.equal(rj.upstreamError, 'upstream_not_configured');

    // admin/preview 1MB 上限：构造 1.1MB JSON
    const huge = JSON.stringify({ messages: [{ role: 'user', content: 'a'.repeat(1_200_000) }] });
    const tooBig = await fetch(`http://127.0.0.1:${port}/admin/api/preview`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer adm' }, body: huge
    });
    assert.equal(tooBig.status, 400);
    const err = await tooBig.json();
    assert.match(err.error.message, /请求体超过/);
  } finally {
    child.kill('SIGKILL');
    await sleep(500);
    assert.ok(exited, 'subprocess should be terminated');
  }
});

test('real server: rate limit 超限返回 429', async () => {
  // 用临时 config（burst=2）+ 关闭决策日志，避免污染真实 config 和 data/decisions
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  const tempCfg = join(dir, 'router.json');
  const cfg = JSON.parse(readFileSync(new URL('../config/router.json', import.meta.url), 'utf8'));
  cfg.rateLimit = { enabled: true, rpm: 120, burst: 2 };
  cfg.decisionLog = { ...cfg.decisionLog, enabled: false };
  writeFileSync(tempCfg, JSON.stringify(cfg));

  const port = await freePort();
  const child = spawnServer(port, { CONFIG_PATH: tempCfg });
  let exited = false;
  child.once('exit', () => { exited = true; });
  try {
    const hj = await waitForHealth(port);
    assert.ok(hj, 'server 启动超时');

    const body = JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] });
    const headers = { 'content-type': 'application/json', authorization: 'Bearer test-key' };
    // 前 2 个请求消耗 burst（走到上游失败，因为测试环境无 MAAS_API_KEY）
    await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers, body });
    await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers, body });
    // 第 3 个请求超限 → 429 + retry-after
    const third = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers, body });
    assert.equal(third.status, 429);
    assert.ok(Number(third.headers.get('retry-after')) >= 0);
    const tj = await third.json();
    assert.equal(tj.error.type, 'rate_limit_exceeded');
  } finally {
    child.kill('SIGKILL');
    await sleep(500);
    rmSync(dir, { recursive: true, force: true });
    assert.ok(exited, 'subprocess should be terminated');
  }
});
