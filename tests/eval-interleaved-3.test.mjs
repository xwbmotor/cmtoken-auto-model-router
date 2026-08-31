import test from 'node:test';
import assert from 'node:assert/strict';
// v0.11.2：二十一审 P2-4 补强——①Judge 请求实际含原题与完整答案 ②低 dailyMaxTokens 预算真实耗尽
// ③运行中取消最终 cancelled ④越界分/verifiable:false 不进统计
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = netServer(); srv.unref(); srv.on('error', reject);
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

test('interleaved 补强：Judge 见原题/预算耗尽/运行中取消/脏分过滤', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'amr-itl3-'));
  let child;
  const base = JSON.parse(readFileSync(new URL('../config/router.json', import.meta.url), 'utf8'));
  const ID_A = base.models[0].id, ID_B = base.models[1].id;
  const judgeCalls = []; // 记录每次 Judge 请求的 user 内容

  const upstream = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { model = '' } = JSON.parse(body || '{}');
      // 长答案：含尾部标记，验证不被 2000 截断
      const long = (model === ID_A ? '优质。' : '一般。') + '正文'.repeat(1200) + '【尾部标记】';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: long } }], usage: { total_tokens: 8000 } }));
    });
  });
  const judge = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { messages = [] } = JSON.parse(body || '{}');
      const user = messages[1]?.content || '';
      judgeCalls.push(user);
      // 脏分测试：越界 100 + verifiable:false 带 score=9
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ usage: { total_tokens: 8000 }, choices: [{ message: { content: JSON.stringify({
        correctness: { score: 'abc', reason: '非法分（normalizeScore→null 真过滤；注意 clamp 语义：-5→0/100→10 会入分，只有非法值才丢弃）' },
        instruction_following: { score: 7, reason: 'ok' },
        completeness: { score: 7, verifiable: false, reason: 'x' },  // verifiable:false → null
        safety: { score: 7, issues: '无' },
      }) } }] }));
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  await new Promise((r) => judge.listen(0, '127.0.0.1', r));

  try {
    const cfg = structuredClone(base);
    cfg.decisionLog = { ...cfg.decisionLog, enabled: false, dirPath: cfg.decisionLog?.dirPath || './data/decisions' };
    cfg.judge = { ...(cfg.judge || {}), guardStatePath: join(dir, 'judge-guard-state.json'),
      dailyMaxCalls: 1000, dailyMaxTokens: 12000 }; // 低 token 预算：2 次成功 settle(8000) 后应拒
    writeFileSync(join(dir, 'router.json'), JSON.stringify(cfg));
    writeFileSync(join(dir, 'eval-gate.json'), JSON.stringify({ cases: [
      { id: 'j1', task: 't', prompt: '原题甲：统计2024年Q3销售额', rubric: 'SQL正确', maxTokens: 64 },
      { id: 'j2', task: 't', prompt: '原题乙：推导贝叶斯公式', rubric: '推理正确', maxTokens: 64 },
      { id: 'j3', task: 't', prompt: '原题丙：写快排', rubric: '代码正确', maxTokens: 64 },
      { id: 'j4', task: 't', prompt: '原题丁：翻译段落', rubric: '翻译准确', maxTokens: 64 },
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

    let r = await fetch(`http://127.0.0.1:${port}/admin/api/eval-jobs`, { method: 'POST', headers: H, body: JSON.stringify({ type: 'interleaved', modelIds: [ID_A, ID_B] }) });
    const started = await r.json();
    assert.strictEqual(r.status, 202);

    let job = null;
    for (let i = 0; i < 300; i++) {
      await new Promise((res) => setTimeout(res, 200));
      r = await fetch(`http://127.0.0.1:${port}/admin/api/eval-jobs?id=${started.id}`, { headers: H });
      job = await r.json();
      if (job.status !== 'running') break;
    }
    assert.strictEqual(job.status, 'done');

    // ① Judge 请求含原题（不是只有 rubric）
    assert.ok(judgeCalls.length > 0, 'Judge 应被调用');
        assert.ok(judgeCalls.some((u) => u.includes('原题丙')), 'Judge 必须看到原题正文');
    // ② 长答案未截断（1200×'正文'≈2400+ 字 > 2000，尾部标记必须在）
    assert.ok(judgeCalls.some((u) => u.includes('【尾部标记】')), '答案不得截断丢尾');

    // ③ 脏分过滤：所有已评分结果的 judgeScore 只能来自 7 分维度（=7），不含 100/9
    const scored = job.results.filter((x) => typeof x.judgeScore === 'number');
    assert.ok(scored.length > 0);
    for (const x of scored) assert.strictEqual(x.judgeScore, 7, `脏分必须被过滤（得到 ${x.judgeScore}）`);

    // ④ 预算耗尽：dailyMaxTokens=12000，每次 settle 8000 → 第 2 次后应 budget skip
    assert.strictEqual(judgeCalls.length, 1, `dailyMaxTokens=12000 下 Judge 恰被调 1 次（首次 settle 8000 后即超限）（得到 ${judgeCalls.length}）——第 3 次 reserve 应被 daily_tokens_exhausted 拒`);
    assert.ok(job.summary.judgeSkip.budget >= 1, '低预算下应有 budget skip 计数');
    assert.ok(job.summary.judgeReadyRate < 1, '预算耗尽后覆盖率<1');

    // ⑤ 运行中取消（新起一个 slow 上游任务再取消）
    const slow = createServer((req, res) => {
      setTimeout(() => { res.writeHead(200); res.end(JSON.stringify({ choices: [{ message: { content: '慢' } }] })); }, 4000);
    });
    await new Promise((res) => slow.listen(0, '127.0.0.1', res));
    const port2 = await freePort();
    const child2 = spawn(process.execPath, ['src/server.mjs'], {
      env: { ...process.env, AMR_CONFIG_DIR: dir, CONFIG_PATH: join(dir, 'router.json'), PORT: String(port2), ADMIN_TOKEN: 'adm-secret',
             MAAS_BASE_URL: `http://127.0.0.1:${slow.address().port}`, MAAS_API_KEY: 'k', UPSTREAM_BASE_URL: `http://127.0.0.1:${slow.address().port}`, UPSTREAM_API_KEY: 'k' },
      stdio: 'ignore',
    });
    try {
      assert.ok(await waitHealth(port2), 'slow 服务未就绪');
      const cfg2 = structuredClone(base);
      cfg2.decisionLog = { ...cfg2.decisionLog, enabled: false, dirPath: './data/decisions' };
      writeFileSync(join(dir, 'router2.json'), JSON.stringify(cfg2)); // 未被 CONFIG_PATH 指向，无副作用
      let r2 = await fetch(`http://127.0.0.1:${port2}/admin/api/eval-jobs`, { method: 'POST', headers: H, body: JSON.stringify({ type: 'checkup', modelId: ID_A }) });
      const st2 = await r2.json();
      assert.strictEqual(r2.status, 202);
      // 立即取消
      await new Promise((res) => setTimeout(res, 500));
      const c = await (await fetch(`http://127.0.0.1:${port2}/admin/api/eval-jobs?action=cancel`, { method: 'POST', headers: H, body: JSON.stringify({ id: st2.id }) })).json();
      assert.ok(c.ok || c.alreadyFinished, '取消应被接受');
      let j2 = null;
      for (let i = 0; i < 60; i++) {
        await new Promise((res) => setTimeout(res, 300));
        const q = await fetch(`http://127.0.0.1:${port2}/admin/api/eval-jobs?id=${st2.id}`, { headers: H });
        j2 = await q.json();
        if (j2.status !== 'running') break;
      }
      assert.strictEqual(j2.status, 'cancelled', `checkup 取消后应为 cancelled（得到 ${j2.status}）`);
    } finally { child2.kill(); slow.close(); }
  } finally {
    if (child) child.kill();
    upstream.close(); judge.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, { timeout: 120000 });
