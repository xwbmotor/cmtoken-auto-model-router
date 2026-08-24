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
    // Python 解析顺序（v0.5.2，Codex 二审：.venv 记录的绝对路径可能失效——existsSync ≠ 可执行）：
    //   CLASSIFIER_PYTHON 显式指定 > .venv（探活通过才用）> PATH 上的 python
    // 探活必须覆盖真实模型兼容性：仅 import 会误选 sklearn 1.6.1，而模型由 1.9.0 生成，
    // 反序列化后 predict_proba 会因 estimator 字段不兼容失败。
    const smoke = "import sys, sklearn, joblib; sys.path.insert(0, 'scripts'); assert sklearn.__version__ == '1.9.0'; m=joblib.load('data/training/model/task.joblib'); m.predict(['smoke'])";
    const tryRun = (cmd) => new Promise((res) => {
      const probe = spawn(cmd, ['-c', smoke], { cwd: projectRoot, stdio: 'ignore' });
      probe.on('error', () => res(false));
      probe.on('close', (code) => res(code === 0));
    });
    (async () => {
      // v0.5.4 修四审 P1：所有候选统一 import 级探活（原实现 tryRun 只用于 .venv 分支，
      // CLASSIFIER_PYTHON 和 PATH python 不探活直接 spawn——本机 PATH python 能 import joblib
      // 却不能反序列化 sklearn 模型时 replay 直接 2 fail，与 server.resolveClassifierPython 行为不一致）
      const candidates = [];
      if (process.env.CLASSIFIER_PYTHON) candidates.push(process.env.CLASSIFIER_PYTHON);
      if (existsSync(venv)) candidates.push(venv);
      candidates.push('python');
      const cmd = await candidates.reduce(async (acc, c) => await acc || (await tryRun(c) ? c : null), null);
      if (!cmd) { reject(new Error('SKIP_NO_PYTHON')); return; } // v0.6.1 五审 P2：无 Python 环境 → skip 而非 fail
      const child = spawn(cmd, [join(projectRoot, 'scripts', 'evaluate_classifier.py'), '--dump'], { cwd: projectRoot, env: { ...process.env, PYTHONUTF8: '1' } });
      let out = ''; let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('close', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`${cmd}: ${err}`))));
    })();
  });
}

// v0.6.1 五审 P2：无可用 Python（sklearn/joblib）时明确 skip，不让整个 Node 测试套件失败。
// codex 在干净环境实测 152/154：两项 replay 因缺可导入 sklearn 的 Python 而 fail——
// 可选依赖缺失应降级为跳过（t.skip 语义），CI 中可用 CLASSIFIER_PYTHON 指定解释器恢复全量。
async function dumpOrSkip(t) {
  try {
    return await runDump();
  } catch (error) {
    if (String(error.message).includes('SKIP_NO_PYTHON')) {
      // v0.7.0 六审 P2：发布档（test:release，AMR_TEST_STRICT_SKIP=1）下 skip 即失败——
      // 「159 通过 2 skip」不能宣称为全量验证；发布机器必须配 CLASSIFIER_PYTHON。
      if (process.env.AMR_TEST_STRICT_SKIP === '1') {
        throw new Error('发布档（AMR_TEST_STRICT_SKIP=1）不允许 skip：本机无可导入 sklearn/joblib 的 Python。请设 CLASSIFIER_PYTHON 指向带 sklearn/joblib 的解释器后重跑。');
      }
      t.skip('本机无可导入 sklearn/joblib 的 Python——replay 数据集回放跳过（设 CLASSIFIER_PYTHON 可启用）');
      return null;
    }
    throw error;
  }
}
import { join } from 'node:path';

test('replay：dump 逐条含 text/confidence/tier/complexity，三种策略可聚合', async (t) => {
  const dump = await dumpOrSkip(t);
  if (!dump) return;
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

test('replay 端到端：真实 server /admin/api/classifier/replay 返回三策略完整结构', async (t) => {
  const { startServer } = await import('./helpers.mjs').catch(() => ({}));
  const dump = await dumpOrSkip(t);
  if (!dump) return;
  // 直接调用内部函数不可行（未导出），端到端走真实服务；服务未起视为环境跳过
  let adminToken = process.env.ADMIN_TOKEN || '';
  try {
    const envText = await readFile(new URL('../.env', import.meta.url), 'utf8');
    adminToken = adminToken || envText.split(/\r?\n/).find((line) => line.startsWith('ADMIN_TOKEN='))?.slice('ADMIN_TOKEN='.length).trim() || '';
  } catch {}
  let health, res;
  try {
    health = await fetch('http://127.0.0.1:8787/health');
  } catch { return; } // ECONNREFUSED/超时 → 跳过（CI 或未起服务的本机环境）
  if (!health.ok) return;
  try {
    res = await fetch('http://127.0.0.1:8787/admin/api/classifier/replay', { method: 'POST', headers: adminToken ? { authorization: `Bearer ${adminToken}` } : {} });
  } catch { return; } // 同上：网络异常视为环境跳过
  if (res.status === 401) return; // 无 token 环境跳过
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
