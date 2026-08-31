import test from 'node:test';
import assert from 'node:assert/strict';
// v0.10.5：full（56 题稳定性巡检）summary 黑盒测试——mock 上游覆盖：
// 正常正文 / 空正文 / HTTP 500 / 两种 task 分组 / errorType 分类 / failed 口径。
// 通过 AMR_CONFIG_DIR 指到临时目录（内放缩小版 eval-gate 题库 5 题），黑盒跑真 server。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = netServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}
function waitHealth(port, timeoutMs = 15000) {
  const t0 = Date.now();
  return (async function loop() {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return true;
    } catch {}
    if (Date.now() - t0 > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 250));
    return loop();
  })();
}

test('e2e full 巡检：mock 上游混合成功/空正文/500 → summary 就绪率/errorType/byTask 全对上', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'amr-full-'));
  let child;
  const upstream = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { messages = [] } = JSON.parse(body || '{}');
      const prompt = String(messages[0]?.content || '');
      if (prompt.includes('CASE_EMPTY')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: '' } }] })); // 空正文
      } else if (prompt.includes('CASE_500')) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'boom' }));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: '正常回答：' + prompt.slice(0, 10) } }] }));
      }
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upPort = upstream.address().port;

  try {
    const { readFileSync } = await import('node:fs');
    const cfg = JSON.parse(readFileSync(new URL('../config/router.json', import.meta.url), 'utf8'));
    cfg.decisionLog = { ...cfg.decisionLog, enabled: false, dirPath: cfg.decisionLog?.dirPath || './data/decisions' };
    writeFileSync(join(dir, 'router.json'), JSON.stringify(cfg));
    // 缩小题库 5 题：3 正常（两种 task）+1 空正文+1 500
    const bank = { cases: [
      { id: 'f1', task: 'coding', prompt: '写个hello CASE_OK1', rubric: 'r', maxTokens: 32 },
      { id: 'f2', task: 'coding', prompt: '写个sql CASE_OK2', rubric: 'r', maxTokens: 32 },
      { id: 'f3', task: 'reasoning', prompt: '推理下 CASE_OK3', rubric: 'r', maxTokens: 32 },
      { id: 'f4', task: 'reasoning', prompt: '推理下 CASE_EMPTY', rubric: 'r', maxTokens: 32 },
      { id: 'f5', task: 'reasoning', prompt: '推理下 CASE_500', rubric: 'r', maxTokens: 32 },
    ] };
    writeFileSync(join(dir, 'eval-gate.json'), JSON.stringify(bank));

    const port = await freePort();
    child = spawn(process.execPath, ['src/server.mjs'], {
      env: { ...process.env, AMR_CONFIG_DIR: dir, PORT: String(port), ADMIN_TOKEN: 'adm-secret',
             MAAS_BASE_URL: `http://127.0.0.1:${upPort}`, MAAS_API_KEY: 'k',
             UPSTREAM_BASE_URL: `http://127.0.0.1:${upPort}`, UPSTREAM_API_KEY: 'k' },
      stdio: 'ignore',
    });
    assert.ok(await waitHealth(port), '服务未就绪');
    const H = { authorization: 'Bearer adm-secret', 'content-type': 'application/json' };
    const modelId = cfg.models[0].id;
    let r = await fetch(`http://127.0.0.1:${port}/admin/api/eval-jobs`, { method: 'POST', headers: H, body: JSON.stringify({ type: 'full', modelId }) });
    assert.strictEqual(r.status, 202);
    const started = await r.json();
    assert.ok(started.id);

    // 轮询至 done
    let job = null;
    for (let i = 0; i < 120; i++) {
      await new Promise((res) => setTimeout(res, 250));
      r = await fetch(`http://127.0.0.1:${port}/admin/api/eval-jobs?id=${started.id}`, { headers: H });
      job = await r.json();
      if (job.status === 'done' || job.status === 'failed') break;
    }
    assert.strictEqual(job.status, 'done');
    assert.strictEqual(job.total, 5);
    assert.strictEqual(job.done, 5);
    // v0.10.5 failed 口径：!ok（空正文+500）都计入 → 2
    assert.strictEqual(job.failed, 2, '空正文+HTTP500 都必须计入 failed');
    const s = job.summary;
    // 就绪率 = 3/5
    assert.ok(Math.abs(s.readyRate - 0.6) < 1e-9, `readyRate=${s.readyRate}`);
    // errorType 分类：empty_response + http_5xx
    assert.strictEqual(s.errorTypes['empty_response'], 1);
    assert.strictEqual(s.errorTypes['http_5xx'], 1);
    // byTask：coding 2/2、reasoning 1/3
    assert.strictEqual(s.byTask.coding.ready, 2);
    assert.strictEqual(s.byTask.coding.total, 2);
    assert.ok(Math.abs(s.byTask.reasoning.rate - 1 / 3) < 1e-9);
    // 时延分布存在（正常 3 笔有 latencyMs）
    assert.ok(s.avgLatencyMs >= 0 && s.minLatencyMs != null);
  } finally {
    if (child) child.kill();
    upstream.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, { timeout: 90000 });
