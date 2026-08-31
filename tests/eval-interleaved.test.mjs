import test from 'node:test';
import assert from 'node:assert/strict';
// v0.11.0：交错评测黑盒测试——mock 上游（两模型质量可区分）+ mock Judge（按内容打分）。
// 方案：保留真实 config 的模型 id（避免 taskPreferences/defaultExplicitModel 引用连环失效），
// mock 上游按 cfg.models[0].id（好模型 A）/cfg.models[1].id（差模型 B）区分回答。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
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
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) return true; } catch {}
    if (Date.now() - t0 > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 250));
    return loop();
  })();
}

test('e2e interleaved：双模型交错+Judge 评分+CI 汇总（仅建议值）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'amr-itl-'));
  let child;
  const base = JSON.parse(readFileSync(new URL('../config/router.json', import.meta.url), 'utf8'));
  const ID_A = base.models[0].id; // 好模型
  const ID_B = base.models[1].id; // 差模型

  // mock 上游：A 的回答带「优质」，B 不带 → Judge 可区分；B 加 30ms 延迟
  const upstream = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { model = '' } = JSON.parse(body || '{}');
      const isA = model === ID_A;
      const content = isA ? '优质回答：详尽、正确、结构清晰。' : '一般回答。';
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      }, isA ? 5 : 30);
    });
  });
  // mock Judge：回答含「优质」→ 全 10 分；否则全 4 分
  const judge = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { messages = [] } = JSON.parse(body || '{}');
      const user = (messages[1]?.content) || '';
      const s = user.includes('优质') ? 10 : 4;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        correctness: { score: s, verifiable: true, reason: 'ok' },
        instruction_following: { score: s, reason: 'ok' },
        completeness: { score: s, verifiable: true, reason: 'ok' },
        safety: { score: s, issues: '无' },
      }) } }] }));
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  await new Promise((r) => judge.listen(0, '127.0.0.1', r));

  try {
    const cfg = structuredClone(base);
    cfg.decisionLog = { ...cfg.decisionLog, enabled: false, dirPath: cfg.decisionLog?.dirPath || './data/decisions' };
    writeFileSync(join(dir, 'router.json'), JSON.stringify(cfg));
    // 缩小题库：6 题（前 2 题每模型预热不计分，后 4 题计分）
    writeFileSync(join(dir, 'eval-gate.json'), JSON.stringify({ cases: [
      { id: 'i1', task: 'coding', prompt: 'Q1', rubric: '答对即可', maxTokens: 32 },
      { id: 'i2', task: 'coding', prompt: 'Q2', rubric: '答对即可', maxTokens: 32 },
      { id: 'i3', task: 'reasoning', prompt: 'Q3', rubric: '答对即可', maxTokens: 32 },
      { id: 'i4', task: 'reasoning', prompt: 'Q4', rubric: '答对即可', maxTokens: 32 },
      { id: 'i5', task: 'reasoning', prompt: 'Q5', rubric: '答对即可', maxTokens: 32 },
      { id: 'i6', task: 'reasoning', prompt: 'Q6', rubric: '答对即可', maxTokens: 32 },
    ] }));

    const port = await freePort();
    child = spawn(process.execPath, ['src/server.mjs'], {
      env: { ...process.env, AMR_CONFIG_DIR: dir, CONFIG_PATH: join(dir, 'router.json'), PORT: String(port), ADMIN_TOKEN: 'adm-secret',
             MAAS_BASE_URL: `http://127.0.0.1:${upstream.address().port}`, MAAS_API_KEY: 'k',
             UPSTREAM_BASE_URL: `http://127.0.0.1:${upstream.address().port}`, UPSTREAM_API_KEY: 'k',
             JUDGE_BASE_URL: `http://127.0.0.1:${judge.address().port}`, JUDGE_API_KEY: 'jk' },
      stdio: 'ignore',
    });
    assert.ok(await waitHealth(port), '服务未就绪');
    const H = { authorization: 'Bearer adm-secret', 'content-type': 'application/json' };

    // 跑前 config 快照（验证「仅建议值」：跑完质量分不得变）
    const before = await (await fetch(`http://127.0.0.1:${port}/admin/api/config`, { headers: H })).json();

    let r = await fetch(`http://127.0.0.1:${port}/admin/api/eval-jobs`, { method: 'POST', headers: H, body: JSON.stringify({ type: 'interleaved', modelIds: [ID_A, ID_B] }) });
    const started = await r.json();
    assert.strictEqual(r.status, 202, JSON.stringify(started).slice(0, 200));
    assert.deepStrictEqual(started.modelIds, [ID_A, ID_B]);

    let job = null;
    for (let i = 0; i < 240; i++) {
      await new Promise((res) => setTimeout(res, 250));
      r = await fetch(`http://127.0.0.1:${port}/admin/api/eval-jobs?id=${started.id}`, { headers: H });
      job = await r.json();
      if (job.status === 'done' || job.status === 'failed') break;
    }
    assert.strictEqual(job.status, 'done', 'job 应完成: ' + JSON.stringify(job).slice(0, 300));
    assert.strictEqual(job.total, 12); // 6 题 × 2 模型
    // 交错顺序：第 1 题的 A、B 相邻
    assert.strictEqual(job.results[0].caseId, 'i1'); assert.strictEqual(job.results[0].model, ID_A);
    assert.strictEqual(job.results[1].caseId, 'i1'); assert.strictEqual(job.results[1].model, ID_B);
    // 预热：i1、i2 warmup=true，i3 起 false
    assert.strictEqual(job.results[0].warmup, true);
    assert.strictEqual(job.results.find((x) => x.caseId === 'i3' && x.model === ID_A).warmup, false);

    const s = job.summary;
    assert.strictEqual(s.kind, 'interleaved');
    // 质量 CI：A（10 分）明显优于 B（4 分）
    assert.ok(s.models[ID_A].quality.mean > s.models[ID_B].quality.mean + 3,
      `A=${s.models[ID_A].quality.mean} B=${s.models[ID_B].quality.mean}`);
    // 时延：B（30ms）均值应大于 A（5ms）
    assert.ok(s.models[ID_B].latencyMs.mean > s.models[ID_A].latencyMs.mean);
    // 两两对比显著
    const d = s.pairwise[0].qualityDiff;
    assert.strictEqual(d.significant, true);
    assert.ok(d.lo > 0);
    // 仅建议值：质量分不得被改
    const after = await (await fetch(`http://127.0.0.1:${port}/admin/api/config`, { headers: H })).json();
    assert.strictEqual(after.models.find((m) => m.id === ID_A).quality.default,
                       before.models.find((m) => m.id === ID_A).quality.default, '质量分不得被自动修改');
  } finally {
    if (child) child.kill();
    upstream.close(); judge.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, { timeout: 120000 });
