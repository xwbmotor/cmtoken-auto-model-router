// v0.11.14：counters 累计口径——重启后恢复（黑盒）
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as netServer } from 'node:net';
import http from 'node:http';

const freePort = () => new Promise((resolve, reject) => {
  const srv = netServer(); srv.unref(); srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('counters 累计口径：重启后恢复（黑盒）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'amr-cnt-'));
  // 模板法 + 关掉一些外部依赖
  const cfg = JSON.parse(readFileSync(join(process.cwd(), 'config', 'router.json'), 'utf8'));
  cfg.routing.maxAttempts = 1; cfg.routing.taskPreferences = {};
  if (cfg.semanticRouter) { cfg.semanticRouter.model = cfg.models[0].id; if (cfg.semanticRouter.openaiChat) cfg.semanticRouter.openaiChat.model = cfg.models[0].id; }
  cfg.decisionLog = { ...(cfg.decisionLog || {}), enabled: false, dirPath: dir };
  writeFileSync(join(dir, 'router.json'), JSON.stringify(cfg));
  const port = await freePort();
  const countersPath = join(dir, 'counters.json');
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', ADMIN_TOKEN: 'a', CONFIG_PATH: join(dir, 'router.json'), AMR_CONFIG_DIR: dir, AMR_COUNTERS_PATH: countersPath };
  let child = spawn(process.execPath, ['src/server.mjs'], { cwd: process.cwd(), stdio: 'ignore', env });
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) { await sleep(150); try { const r = await fetch('http://127.0.0.1:' + port + '/health'); if (r.ok) up = true; } catch {} }
    if (!up) throw new Error('server 未启动');
    // 5 次调用
    for (let i = 0; i < 5; i++) {
      const r = await fetch('http://127.0.0.1:' + port + '/v1/chat/completions', {
        method: 'POST', headers: { authorization: 'Bearer a', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'cmtoken-auto', messages: [{ role: 'user', content: '1+1=?' }] }),
      });
      await r.text();
    }
    await sleep(1500); // 等落盘（500ms 批量）
    if (!existsSync(countersPath)) throw new Error('counters.json 未落盘');
    const before = JSON.parse(readFileSync(countersPath, 'utf8'));
    if (before.cumulative.total < 5) throw new Error('落盘 total < 5: ' + before.cumulative.total);
  } finally {
    child.kill('SIGKILL');
  }
  // 重启
  await sleep(300);
  child = spawn(process.execPath, ['src/server.mjs'], { cwd: process.cwd(), stdio: 'ignore', env });
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) { await sleep(150); try { const r = await fetch('http://127.0.0.1:' + port + '/health'); if (r.ok) up = true; } catch {} }
    if (!up) throw new Error('重启后 server 未启动');
    const m = await fetch('http://127.0.0.1:' + port + '/admin/api/metrics', { headers: { authorization: 'Bearer a' } });
    const j = await m.json();
    if (j.counters.total < 5) throw new Error('重启后 total 不恢复: ' + j.counters.total);
  } finally {
    child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});
