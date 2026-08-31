import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as netServer } from 'node:net';

const freePort = () => new Promise((resolve, reject) => {
  const srv = netServer(); srv.unref(); srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitHealth = async (port) => {
  for (let i = 0; i < 60; i++) { await sleep(150); try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) return true; } catch {} }
  return false;
};

// v0.11.5（二十四审）：JSON 导入值 schema + Guard settle fail-closed 内收 + 内层取消
// 断言：合法值入、恶意值拒（issues 回显）、__proto__ 拒、Guard 各形态结算走 estTokens

test('导入值 schema：合法入/恶意拒/保留名拒/issues 回显', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'amr-imp-'));
  const cfg = {
    upstreamBaseUrl: 'http://127.0.0.1:1', upstreamApiKey: 'k',
    models: [{ id: 'model-a', displayName: 'A', enabled: false, ownership: 'unknown', quality: { default: 7 } }],
    routing: { mode: 'active', weights: { cost: 1, latency: 1, quality: 1 }, tiers: {}, taskPreferences: {}, maxAttempts: 1, defaultExplicitModel: 'model-a', shadowModel: 'model-a' },
    decisionLog: { enabled: false, dirPath: dir },
  };
  writeFileSync(join(dir, 'router.json'), JSON.stringify(cfg));
  const port = await freePort();
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ADMIN_TOKEN: 'a', CONFIG_PATH: join(dir, 'router.json'), AMR_CONFIG_DIR: dir },
  });
  try {
    if (!(await waitHealth(port))) throw new Error('server 未启动');
    const B = `http://127.0.0.1:${port}`;
    const H = { authorization: 'Bearer a', 'content-type': 'application/json' };
    // 合法 + 恶意值 + 保留名键 + 越界，一次导入
    const payload = {
      models: [{
        id: 'model-a',
        benchmarkScores: {
          scores: { coding: 0.85, evil: '<img src=x onerror=alert(1)>' },          // evil 值非法（字符串）→ 拒
          subtasks: { 'sub-1': { avg: 0.9, n: 120 }, 'sub-2': { avg: '<b>x</b>', n: 5 } }, // sub-2 avg 非法 → 拒
          evalGate: { coding: 91, total: 300 },
          // 保留名键在层内（mergeLayer 只遍历五层子对象，顶层键不进校验——所以必须放层内才可达）
          scoresMeta: { 'constructor': { at: '2026-01-01' } },
          subtasksMeta: { 'prototype': { at: '2026-01-01' } },
        },
      }],
    };
    const r = await fetch(`${B}/admin/api/model-data/import`, { method: 'POST', headers: H, body: JSON.stringify(payload) });
    const j = await r.json();
    if (r.status !== 200) throw new Error(`import ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
    if (!j.ok) throw new Error('import not ok');
    const issues = (j.issues || []).join('|');
    if (!issues.includes('evil')) throw new Error('issues 未回显 evil 值拒绝');
    if (!issues.includes('sub-2')) throw new Error('issues 未回显 sub-2 拒绝');
    if (!issues.includes('constructor')) throw new Error('issues 未回显保留名 constructor 拒绝');
    if (!issues.includes('prototype')) throw new Error('issues 未回显保留名 prototype 拒绝');
    // 合法值确实落盘
    const after = JSON.parse(readFileSync(join(dir, 'router.json'), 'utf8'));
    const bs = after.models[0].benchmarkScores;
    if (bs.scores.coding !== 0.85) throw new Error('合法 scores 未入');
    if (bs.scores.evil !== undefined) throw new Error('恶意值竟被写入 scores.evil');
    if (bs.subtasks['sub-1'].avg !== 0.9) throw new Error('合法 subtasks 未入');
    if (bs.subtasks['sub-2'] !== undefined) throw new Error('非法 subtasks 竟被写入');
    if (bs.evalGate.coding !== 91) throw new Error('合法 evalGate 未入');
  } finally {
    child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true });
  }
});

test('Guard settle 内收 fail-closed：七形态（number/null/undefined/字符串/false/负数/合法0）', async () => {
  const { JudgeGuard } = await import('../src/judge.mjs');
  const cases = [
    [8000, 8000], [null, 8000], [undefined, 8000], ['8000', 8000], [false, 8000], [-5, 8000], [0, 0],
  ];
  for (const [tok, expect] of cases) {
    const g = new JudgeGuard({ dailyMaxTokens: 1000000 });
    const rq = g.reserve({ estTokens: 8000 });
    if (!rq.ok) throw new Error('reserve 失败');
    g.settle(rq.handle, { ok: true, tokens: tok });
    const got = g.snapshot().tokens;
    if (got !== expect) throw new Error(`tokens=${JSON.stringify(tok)} → ${got}，期望 ${expect}`);
  }
  // 解析失败路径（ok:false 不传 tokens）也按预占结算
  const g2 = new JudgeGuard({ dailyMaxTokens: 1000000 });
  const rq2 = g2.reserve({ estTokens: 2000 });
  g2.settle(rq2.handle, { ok: false });
  if (g2.snapshot().tokens !== 2000) throw new Error(`ok:false 无 tokens → ${g2.snapshot().tokens}，期望预占 2000`);
  // estTokens 因 path 而异（task-check 2000）
  const g3 = new JudgeGuard({ dailyMaxTokens: 1000000 });
  const rq3 = g3.reserve({ estTokens: 2000 });
  g3.settle(rq3.handle, { ok: true, tokens: NaN });
  if (g3.snapshot().tokens !== 2000) throw new Error('NaN 应按 estTokens=2000 结算');
});
