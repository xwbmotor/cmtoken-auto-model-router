import test from 'node:test';
import assert from 'node:assert/strict';
// v0.11.1：interleaved 参数校验回归——去重 + 取消端点契约
// （轻量黑盒：只测 startEvalJob 校验与 cancel 端点，不跑全量任务）
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer as netServer } from 'node:net';

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = netServer();
    srv.unref(); srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}
function waitHealth(port, timeoutMs = 15000) {
  const t0 = Date.now();
  return (async function loop() {
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) return true; } catch {}
    if (Date.now() - t0 > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 250));
    return loop();
  })();
}

test('interleaved：modelIds 去重（[A,A] 拒绝）+ 取消端点契约', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'amr-itl2-'));
  let child;
  try {
    const base = JSON.parse(readFileSync(new URL('../config/router.json', import.meta.url), 'utf8'));
    const cfg = structuredClone(base);
    cfg.judge = { ...(cfg.judge || {}), guardStatePath: join(dir, 'judge-guard-state.json') }; // v0.11.1: guard 状态落测试目录（防污染项目 data/）
    cfg.decisionLog = { ...cfg.decisionLog, enabled: false, dirPath: cfg.decisionLog?.dirPath || './data/decisions' };
    writeFileSync(join(dir, 'router.json'), JSON.stringify(cfg));
    writeFileSync(join(dir, 'eval-gate.json'), JSON.stringify({ cases: [
      { id: 'x1', task: 't', prompt: 'Q', rubric: 'r', maxTokens: 32 } ] }));

    const port = await freePort();
    child = spawn(process.execPath, ['src/server.mjs'], {
      env: { ...process.env, AMR_CONFIG_DIR: dir, CONFIG_PATH: join(dir, 'router.json'), PORT: String(port), ADMIN_TOKEN: 'adm-secret', MAAS_API_KEY: 'k' },
      stdio: 'ignore',
    });
    assert.ok(await waitHealth(port), '服务未就绪');
    const H = { authorization: 'Bearer adm-secret', 'content-type': 'application/json' };
    const ID_A = base.models[0].id;

    // ① 去重：[A,A] → 400
    let r = await fetch(`http://127.0.0.1:${port}/admin/api/eval-jobs`, { method: 'POST', headers: H, body: JSON.stringify({ type: 'interleaved', modelIds: [ID_A, ID_A] }) });
    assert.strictEqual(r.status, 400);
    const d = await r.json();
    assert.ok(/至少要 2 个不同模型/.test(d.error?.message || ''), '去重拒绝消息');

    // ② 取消端点：不存在任务 → 404
    r = await fetch(`http://127.0.0.1:${port}/admin/api/eval-jobs?action=cancel`, { method: 'POST', headers: H, body: JSON.stringify({ id: 'job_nope' }) });
    assert.strictEqual(r.status, 404);
  } finally {
    if (child) child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}, { timeout: 60000 });
