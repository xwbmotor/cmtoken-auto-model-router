// v0.9.2：judge 通道管理端配置 e2e——masked 视图/PUT 更新/清除/GET config 不含 key
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 与 compressed-body.test.mjs 同款：unref 防句柄泄漏挂起测试进程
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForHealth(port, maxMs = 10000) {
  for (let i = 0; i < maxMs / 200; i++) { await sleep(200); try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) return true; } catch { /* not yet */ } }
  return false;
}

test('e2e judge/secret：PUT→GET masked→config 无 key→非法 URL 拒→清除→未鉴权拒', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'amr-js-e2e-'));
  try {
    const cfgPath = join(dir, 'router.json');
    const cfg = JSON.parse(readFileSync(new URL('../config/router.json', import.meta.url), 'utf8'));
    cfg.judge = { ...(cfg.judge || {}), enabled: false }; // 只测通道管理面，不触发真实评审
    cfg.decisionLog = { ...(cfg.decisionLog || {}), enabled: false };
    writeFileSync(cfgPath, JSON.stringify(cfg));
    const port = await freePort();
    const child = spawn(process.execPath, ['src/server.mjs'], {
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ROUTER_ACCESS_KEY: 'rk', ADMIN_TOKEN: 'adm', METRICS_TOKEN: 'met', CONFIG_PATH: cfgPath },
      cwd: process.cwd(), stdio: 'ignore', detached: false,
    });
    let exited = false;
    child.once('exit', () => { exited = true; });
    try {
      assert.ok(await waitForHealth(port), 'server 启动超时');
      const H = { authorization: 'Bearer adm', 'content-type': 'application/json' };
      // 1) 初始未配置
      let r = await fetch(`http://127.0.0.1:${port}/admin/api/judge/secret`, { headers: H });
      let v = await r.json();
      assert.equal(r.status, 200); assert.equal(v.apiKeySet, false);
      // 2) PUT 配置（尾斜杠归一）
      r = await fetch(`http://127.0.0.1:${port}/admin/api/judge/secret`, { method: 'PUT', headers: H, body: JSON.stringify({ baseUrl: 'https://api.example.com/v1/', apiKey: 'sk-secret-ABCD9999' }) });
      v = await r.json();
      assert.equal(r.status, 200); assert.equal(v.apiKeySet, true); assert.equal(v.apiKeyPreview, '…9999');
      // 3) GET masked：永不回明文
      r = await fetch(`http://127.0.0.1:${port}/admin/api/judge/secret`, { headers: H });
      v = await r.json();
      assert.equal(JSON.stringify(v).includes('sk-secret-ABCD9999'), false, 'GET 不得含完整 key');
      assert.equal(v.baseUrl, 'https://api.example.com/v1');
      // 4) GET config：key 不在 config
      r = await fetch(`http://127.0.0.1:${port}/admin/api/config`, { headers: H });
      const cfg2 = await r.json();
      assert.equal(JSON.stringify(cfg2).includes('sk-secret-ABCD9999'), false, 'config 不得含 key');
      // 5) 非法 baseUrl 拒绝
      r = await fetch(`http://127.0.0.1:${port}/admin/api/judge/secret`, { method: 'PUT', headers: H, body: JSON.stringify({ baseUrl: 'ftp://x', apiKey: 'k' }) });
      assert.equal(r.status, 400);
      // 6) 清除
      r = await fetch(`http://127.0.0.1:${port}/admin/api/judge/secret`, { method: 'PUT', headers: H, body: JSON.stringify({ clear: true }) });
      v = await r.json();
      assert.equal(v.apiKeySet, false);
      // 7) 未鉴权拒绝（401/403/429 均可——鉴权失败限流桶）
      r = await fetch(`http://127.0.0.1:${port}/admin/api/judge/secret`);
      assert.ok([401, 403, 429].includes(r.status), `未鉴权应拒绝，得到 ${r.status}`);
    } finally { child.kill('SIGKILL'); await sleep(400); assert.ok(exited, 'subprocess should be terminated'); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
