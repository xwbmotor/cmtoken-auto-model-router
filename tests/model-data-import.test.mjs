// 模型能力数据导入：模板下载 + 导入合并三层（scores/evalGate/subtasks），未知模型跳过
// 2026-08-21 需求：模型管理页可看官方 benchmark + 实测数据，支持模板上传录入
// 2026-08-22 修复：不再连真实 8787 常驻服务（导入端点会 saveConfig 全量写盘，把常驻进程
// 内存里的旧配置写回 config/router.json——曾两次覆盖掉手改的 providerCostWeight/requestTimeoutMs）。
// 改为独立临时子进程（照 server-real.test.mjs 模式），跑完即清，永不污染真实配置。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

const ADMIN_TOKEN = 'adm-test';

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function waitForHealth(port, maxMs = 8000) {
  for (let i = 0; i < maxMs / 200; i += 1) {
    await sleep(200);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return await r.json();
    } catch { /* not yet */ }
  }
  return null;
}

test('模型数据模板下载与导入端到端', { timeout: 60000 }, async () => {
  // 独立子进程 + 临时配置：导入端点的 saveConfig 只写临时文件
  const dir = mkdtempSync(join(tmpdir(), 'mdi-'));
  const tempCfg = join(dir, 'router.json');
  const cfg = JSON.parse(readFileSync(new URL('../config/router.json', import.meta.url), 'utf8'));
  writeFileSync(tempCfg, JSON.stringify(cfg));
  const port = await freePort();
  const child = spawn(process.execPath, ['src/server.mjs'], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ADMIN_TOKEN, CONFIG_PATH: tempCfg, ROUTER_ACCESS_KEY: 'test-key' },
    cwd: process.cwd(), stdio: 'ignore', detached: false,
  });
  const headers = { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' };
  try {
    const hj = await waitForHealth(port);
    assert.ok(hj, 'server 启动超时');
    const BASE = `http://127.0.0.1:${port}`;

    // 1) 模板结构
    const tplRes = await fetch(`${BASE}/admin/api/model-data/template`, { headers });
    assert.ok(tplRes.ok, `模板应 200，实际 ${tplRes.status}`);
    const tpl = await tplRes.json();
    assert.ok(Array.isArray(tpl.models) && tpl.models.length >= 1, '模板应含 models 数组');
    const sample = tpl.models[0];
    assert.ok('id' in sample && 'benchmarkScores' in sample, '模板项应含 id + benchmarkScores');
    for (const key of ['scores', 'evalGate', 'subtasks']) assert.ok(key in sample.benchmarkScores, `模板 benchmarkScores 应含 ${key}`);

    // 2) 导入：有效模型 + 无效模型混合
    const payload = {
      models: [
        { id: 'deepseekv4-flash', benchmarkScores: { scores: { model_data_test: 0.5 }, scoresMeta: { source: '单测导入' } } },
        { id: '__no_such_model__', benchmarkScores: { scores: {} } }
      ]
    };
    const impRes = await fetch(`${BASE}/admin/api/model-data/import`, { method: 'POST', headers, body: JSON.stringify(payload) });
    assert.ok(impRes.ok, `导入应 200，实际 ${impRes.status}`);
    const r = await impRes.json();
    assert.deepEqual(r.applied, ['deepseekv4-flash']);
    assert.ok(r.skipped.some((s) => s.includes('__no_such_model__')), '未知模型应被跳过并说明原因');

    // 3) 合并语义：原有键保留（gpqa_diamond 不被清掉），新键覆盖
    const cfgRes = await fetch(`${BASE}/admin/api/config`, { headers });
    const cfg2 = await cfgRes.json();
    const m = cfg2.models.find((x) => x.id === 'deepseekv4-flash');
    assert.ok(m.benchmarkScores.scores.gpqa_diamond != null, '导入应保留原有官方分');
    assert.equal(m.benchmarkScores.scores.model_data_test, 0.5, '导入应合并新键');
    assert.equal(m.benchmarkScores.scoresMeta.source, '单测导入');

    // 4) 非法输入
    const bad = await fetch(`${BASE}/admin/api/model-data/import`, { method: 'POST', headers, body: JSON.stringify({ models: [] }) });
    assert.equal(bad.status, 400, '空 models 应 400');

    // 5) 还原测试污染：null 值删除导入的测试键（导入端点合并语义：null 删键）
    await fetch(`${BASE}/admin/api/model-data/import`, { method: 'POST', headers, body: JSON.stringify({ models: [{ id: 'deepseekv4-flash', benchmarkScores: { scores: { model_data_test: null }, scoresMeta: { source: '官方榜单（人工录入）' } } }] }) });
    const cfg3 = await (await fetch(`${BASE}/admin/api/config`, { headers })).json();
    const m2 = cfg3.models.find((x) => x.id === 'deepseekv4-flash');
    assert.equal(m2.benchmarkScores.scoresMeta.source, '官方榜单（人工录入）', '应可还原');
    assert.ok(!('model_data_test' in m2.benchmarkScores.scores), 'null 导入应删除测试键');
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
