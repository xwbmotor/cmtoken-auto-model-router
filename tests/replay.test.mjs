import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const config = JSON.parse(await readFile(new URL('../config/router.json', import.meta.url), 'utf8'));

function runDump() {
  return new Promise((resolve, reject) => {
    const venv = join(projectRoot, '.venv', 'Scripts', 'python.exe');
    const cmd = existsSync(venv) ? venv : 'python';
    const child = spawn(cmd, [join(projectRoot, 'scripts', 'evaluate_classifier.py'), '--dump'], { cwd: projectRoot });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err))));
  });
}
import { join } from 'node:path';

test('replay：dump 逐条含 text/confidence/tier/complexity，三种策略可聚合', async () => {
  const dump = await runDump();
  assert.ok(dump.length >= 400, `dump 应约 454 条，实际 ${dump.length}`);
  for (const key of ['index', 'gold', 'clf', 'rule', 'confidence', 'tier', 'complexity', 'text']) {
    assert.ok(key in dump[0], `dump 行缺 ${key}`);
  }
  assert.ok(dump.every((r) => typeof r.text === 'string' && r.text.length > 0), 'text 应非空');
  // 三种任务的判准率应满足：full ≥ partial ≥ rules（小模型 95.4% > 规则 68.9%，采纳越多越准）
  const acc = (rows, key) => rows.filter((r) => r[key] === r.gold).length / rows.length;
  const rulesAcc = acc(dump, 'rule');
  const fullAcc = acc(dump, 'clf');
  assert.ok(fullAcc > rulesAcc + 0.2, `全量采纳判准率(${fullAcc.toFixed(3)}) 应明显高于规则层(${rulesAcc.toFixed(3)})`);
});

test('replay 端到端：真实 server /admin/api/classifier/replay 返回三策略完整结构', async () => {
  const { startServer } = await import('./helpers.mjs').catch(() => ({}));
  const dump = await runDump();
  // 直接调用内部函数不可行（未导出），端到端走真实服务
  const health = await fetch('http://127.0.0.1:8787/health');
  if (!health.ok) return; // 服务未运行时跳过（CI 环境）
  const res = await fetch('http://127.0.0.1:8787/admin/api/classifier/replay', { method: 'POST' });
  assert.ok(res.ok, `replay 应 200，实际 ${res.status}`);
  const data = await res.json();
  for (const key of ['rules', 'partial', 'full']) {
    assert.ok(data[key], `缺 ${key}`);
    for (const field of ['taskAcc', 'avgQuality', 'avgCost', 'misread', 'modelDist']) {
      assert.ok(field in data[key], `${key} 缺 ${field}`);
    }
    assert.ok(['underCalled', 'overCalled', 'taskSwapped'].every((k) => k in data[key].misread), `${key}.misread 不完整`);
  }
  assert.ok(data.rules.taskAcc < data.partial.taskAcc, `partial(${data.partial.taskAcc}) 应高于 rules(${data.rules.taskAcc})`);
  assert.ok(data.partial.taskAcc <= data.full.taskAcc, `full(${data.full.taskAcc}) 应不低于 partial(${data.partial.taskAcc})`);
}, { timeout: 180000 });
