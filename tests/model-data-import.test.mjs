// 模型能力数据导入：模板下载 + 导入合并三层（scores/evalGate/subtasks），未知模型跳过
// 2026-08-21 需求：模型管理页可看官方 benchmark + 实测数据，支持模板上传录入
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { projectRoot } from '../src/config.mjs';

// 直接测试 server 模块的纯逻辑不可行（端点内联），端到端走 fetch：服务未运行时跳过
const BASE = 'http://127.0.0.1:8787';

async function adminHeaders() {
  let token = process.env.ADMIN_TOKEN || '';
  if (!token) {
    try {
      token = (await readFile(resolve(projectRoot, '.env'), 'utf8')).split(/\r?\n/).find((l) => l.startsWith('ADMIN_TOKEN='))?.slice('ADMIN_TOKEN='.length).trim() || '';
    } catch {}
  }
  return token ? { authorization: `Bearer ${token}`, 'content-type': 'application/json' } : null;
}

test('模型数据模板下载与导入端到端', { timeout: 60000 }, async () => {
  const headers = await adminHeaders();
  const health = await fetch(`${BASE}/health`).catch(() => null);
  if (!health?.ok || !headers) return; // 服务/token 未就绪（CI）跳过

  // 1) 模板结构
  const tplRes = await fetch(`${BASE}/admin/api/model-data/template`, { headers });
  assert.ok(tplRes.ok, `模板应 200，实际 ${tplRes.status}`);
  const tpl = await tplRes.json();
  assert.ok(Array.isArray(tpl.models) && tpl.models.length >= 1, '模板应含 models 数组');
  const sample = tpl.models[0];
  assert.ok('id' in sample && 'benchmarkScores' in sample, '模板项应含 id + benchmarkScores');
  for (const key of ['scores', 'evalGate', 'subtasks']) assert.ok(key in sample.benchmarkScores, `模板 benchmarkScores 应含 ${key}`);

  // 1.5) 前置清理：清掉上次异常中断留下的 model_data_test=null（端点 null=删键，但需键存在才生效）
  await fetch(`${BASE}/admin/api/model-data/import`, { method: 'POST', headers, body: JSON.stringify({ models: [{ id: 'deepseekv4-flash', benchmarkScores: { scores: { model_data_test: 0.5 } } }] }) });

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
  const cfg = await cfgRes.json();
  const m = cfg.models.find((x) => x.id === 'deepseekv4-flash');
  assert.ok(m.benchmarkScores.scores.gpqa_diamond != null, '导入应保留原有官方分');
  assert.equal(m.benchmarkScores.scores.model_data_test, 0.5, '导入应合并新键');
  assert.equal(m.benchmarkScores.scoresMeta.source, '单测导入');

  // 4) 非法输入
  const bad = await fetch(`${BASE}/admin/api/model-data/import`, { method: 'POST', headers, body: JSON.stringify({ models: [] }) });
  assert.equal(bad.status, 400, '空 models 应 400');

  // 5) 还原测试污染：null 值删除导入的测试键（导入端点合并语义：null 删键）
  await fetch(`${BASE}/admin/api/model-data/import`, { method: 'POST', headers, body: JSON.stringify({ models: [{ id: 'deepseekv4-flash', benchmarkScores: { scores: { model_data_test: null }, scoresMeta: { source: '官方榜单（人工录入）' } } }] }) });
  const cfg2 = await (await fetch(`${BASE}/admin/api/config`, { headers })).json();
  const m2 = cfg2.models.find((x) => x.id === 'deepseekv4-flash');
  assert.equal(m2.benchmarkScores.scoresMeta.source, '官方榜单（人工录入）', '应可还原');
  assert.ok(!('model_data_test' in m2.benchmarkScores.scores), 'null 导入应删除测试键');
});
