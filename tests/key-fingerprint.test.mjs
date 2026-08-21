// v0.4.27 新功能：key 指纹归因 + 最近请求筛选 + 推理档位未生效标注
// 独立临时子进程（server-real.test 模式：freePort + 临时 cwd，不碰常驻 8787，防配置污染）
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer(); srv.unref(); srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

test('key 指纹：decisions 筛选 + recent-key-filter 端点 + 归一化', async (t) => {
  const PORT = await freePort();
  // 临时 cwd：复制最小运行集（src public docs config），data 独立
  const dir = mkdtempSync(join(tmpdir(), 'amr-keyfp-'));
  for (const p of ['src', 'public', 'config']) cpSync(p, join(dir, p), { recursive: true });
  mkdirSync(join(dir, 'data', 'decisions'), { recursive: true });
  writeFileSync(join(dir, 'data', 'decisions', 'decisions-2026-01-01.jsonl'), [
    JSON.stringify({ at: '2026-01-01T00:00:00Z', v: 2, request: { requestId: 'r1', keyFingerprint: 'aabbccdd' }, decision: { selectedModel: 'deepseekv4-flash', reasoningLevel: 'high' }, outcome: { ok: true } }),
    JSON.stringify({ at: '2026-01-01T00:01:00Z', v: 2, request: { requestId: 'r2', keyFingerprint: '11223344' }, decision: { selectedModel: 'qwen36-35b', reasoningLevel: 'off' }, outcome: { ok: true } })
  ].join('\n') + '\n');
  const child = spawn(process.execPath, ['src/server.mjs'], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', ADMIN_TOKEN: 'adm', ROUTER_ACCESS_KEY: 'rk' },
    cwd: dir, stdio: 'ignore'
  });
  t.after(() => { child.kill(); });
  // 等就绪
  let up = false;
  for (let i = 0; i < 25 && !up; i += 1) { await sleep(200); try { up = (await fetch(`http://127.0.0.1:${PORT}/health`)).ok; } catch { /* booting */ } }
  assert.ok(up, 'server 启动超时');
  const admin = { authorization: 'Bearer adm' };

  // 1) decisions 按 key 筛选
  const all = await (await fetch(`http://127.0.0.1:${PORT}/admin/api/decisions?count=50`, { headers: admin })).json();
  assert.ok(all.count >= 2, `预置 2 条应可见，实际 ${all.count}`);
  const filtered = await (await fetch(`http://127.0.0.1:${PORT}/admin/api/decisions?key=aabbccdd`, { headers: admin })).json();
  assert.equal(filtered.count, 1);
  assert.equal(filtered.decisions[0].request.keyFingerprint, 'aabbccdd');
  const none = await (await fetch(`http://127.0.0.1:${PORT}/admin/api/decisions?key=00000000`, { headers: admin })).json();
  assert.equal(none.count, 0);

  // 2) recent-key-filter：大写归一化 / 非法值 400 / null 清除
  const set = await (await fetch(`http://127.0.0.1:${PORT}/admin/api/recent-key-filter`, { method: 'POST', headers: { ...admin, 'content-type': 'application/json' }, body: JSON.stringify({ key: 'AABBCCDD' }) })).json();
  assert.equal(set.keyFingerprint, 'aabbccdd');
  const bad = await fetch(`http://127.0.0.1:${PORT}/admin/api/recent-key-filter`, { method: 'POST', headers: { ...admin, 'content-type': 'application/json' }, body: JSON.stringify({ key: 'xyz' }) });
  assert.equal(bad.status, 400);
  const clear = await (await fetch(`http://127.0.0.1:${PORT}/admin/api/recent-key-filter`, { method: 'POST', headers: { ...admin, 'content-type': 'application/json' }, body: JSON.stringify({ key: null }) })).json();
  assert.equal(clear.keyFingerprint, null);

  // 3) 无鉴权 401
  const noauth = await fetch(`http://127.0.0.1:${PORT}/admin/api/recent-key-filter`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: null }) });
  assert.equal(noauth.status, 401);
});
