import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';

// v0.9.3 管理端登录会话：静态管理页（index.html/app.js）无会话 → 登录页；
// /admin/api/* 接受 Bearer 或会话 cookie；/admin/api/login 验 ADMIN_TOKEN 发 HttpOnly cookie；
// 防爆破限流复用 adminAuthLimiter；/health /v1/models /metrics 不受影响。

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer(); srv.unref(); srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitHealth(port) {
  for (let i = 0; i < 60; i++) { await sleep(150); try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) return true; } catch {} }
  return false;
}

test('e2e 管理端登录会话：登录页门禁+cookie 会话+Bearer 兼容+登出', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'amr-login-'));
  let child;
  try {
    const cfg = JSON.parse((await import('node:fs')).readFileSync(new URL('../config/router.json', import.meta.url), 'utf8'));
    cfg.decisionLog = { ...(cfg.decisionLog || {}), enabled: false };
    (await import('node:fs')).writeFileSync(join(dir, 'router.json'), JSON.stringify(cfg));
    const port = await freePort();
    child = spawn(process.execPath, ['src/server.mjs'], {
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ADMIN_TOKEN: 'adm-secret', METRICS_TOKEN: 'met', CONFIG_PATH: join(dir, 'router.json') },
      cwd: process.cwd(), stdio: 'ignore',
    });
    await sleep(300);
    assert.ok(await waitHealth(port), 'server 未启动');
    const B = `http://127.0.0.1:${port}`;

    // 1) 无会话访问管理页 → 登录页（200 但内容是 login，或 302→/login；实现二选一，断言宽松：不是管理页正文）
    let r = await fetch(`${B}/`);
    const body = await r.text();
    assert.ok(r.status === 200 || r.status === 302, `管理页根路径状态 ${r.status}`);
    // 管理页正文的指纹是 app.js 引用 + Admin Token 输入框；登录页不应包含
    assert.ok(!body.includes('id="connect"') || body.includes('loginForm'), '未登录应看到登录页而非管理台');

    // 2) 无会话访问 /admin/api/config → 401
    r = await fetch(`${B}/admin/api/config`);
    assert.ok([401, 403, 429].includes(r.status), `无会话 API 应 401，得到 ${r.status}`);

    // 3) 错 token 登录 → 401
    r = await fetch(`${B}/admin/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'wrong' }) });
    assert.ok([401, 403, 429].includes(r.status), `错 token 登录应拒，得到 ${r.status}`);

    // 4) 正确 token 登录 → Set-Cookie HttpOnly
    r = await fetch(`${B}/admin/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'adm-secret' }) });
    assert.equal(r.status, 200, `登录失败: ${r.status}`);
    const setc = r.headers.get('set-cookie') || '';
    assert.ok(/amr_admin_session=/.test(setc) && /httponly/i.test(setc), `cookie 缺失或非 HttpOnly: ${setc}`);
    const cookie = setc.split(';')[0];

    // 5) 带 cookie 访问管理页 → 真管理页（含 connect）
    r = await fetch(`${B}/`, { headers: { cookie } });
    const page = await r.text();
    assert.ok(page.includes('id="connect"'), '登录后应看到管理台');

    // 6) 带 cookie 访问 API → 200
    r = await fetch(`${B}/admin/api/config`, { headers: { cookie } });
    assert.equal(r.status, 200);

    // 7) Bearer 仍可用（脚本兼容）
    r = await fetch(`${B}/admin/api/config`, { headers: { authorization: 'Bearer adm-secret' } });
    assert.equal(r.status, 200);

    // 8) 登出 → cookie 失效
    r = await fetch(`${B}/admin/api/logout`, { method: 'POST', headers: { cookie } });
    assert.equal(r.status, 200);
    r = await fetch(`${B}/admin/api/config`, { headers: { cookie } });
    assert.ok([401, 403].includes(r.status), `登出后 cookie 应失效，得到 ${r.status}`);

    // 9) /health 与 /v1/models 不受登录门影响
    r = await fetch(`${B}/health`); assert.equal(r.status, 200);
    r = await fetch(`${B}/v1/models`); assert.equal(r.status, 200);
  } finally {
    if (child) child.kill('SIGKILL');
    await sleep(300);
    rmSync(dir, { recursive: true, force: true });
  }
});


// ════════ v0.10.0 新增端点 ════════
// 黑盒 e2e：起临时服务打 v0.10.0 三个新端点（不 import server 内部——import 即启动全服务）
test('e2e v0.10.0 端点：下线提醒/发现/评测任务的鉴权与基本语义', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'amr-v010-'));
  let child;
  try {
    const cfg = JSON.parse((await import('node:fs')).readFileSync(new URL('../config/router.json', import.meta.url), 'utf8'));
    cfg.decisionLog = { ...(cfg.decisionLog || {}), enabled: false };
    (await import('node:fs')).writeFileSync(join(dir, 'router.json'), JSON.stringify(cfg));
    const port = await freePort();
    child = spawn(process.execPath, ['src/server.mjs'], {
      env: { ...process.env, AMR_CONFIG_DIR: dir, PORT: String(port), ADMIN_TOKEN: 'adm-secret',
             MAAS_BASE_URL: '', MAAS_API_KEY: '', UPSTREAM_BASE_URL: '', UPSTREAM_API_KEY: '' },
      stdio: 'ignore',
    });
    assert.ok(await waitHealth(port), '服务未就绪');
    const H = { authorization: 'Bearer adm-secret' };
    // 1) 无鉴权 → 401
    let r = await fetch(`http://127.0.0.1:${port}/admin/api/model-offline-alerts`);
    assert.strictEqual(r.status, 401);
    // 2) 下线提醒：正常态 alerts=[]（无熔断模型）
    r = await fetch(`http://127.0.0.1:${port}/admin/api/model-offline-alerts`, { headers: H });
    assert.strictEqual(r.status, 200);
    const { alerts } = await r.json();
    assert.ok(Array.isArray(alerts));
    // 3) 发现端点：无上游配置 → 502 discover_models_error（不崩）
    r = await fetch(`http://127.0.0.1:${port}/admin/api/discover-models`, { headers: H });
    assert.strictEqual(r.status, 502);
    const d = await r.json();
    assert.strictEqual(d.error?.type, 'discover_models_error');
    // 4) 评测任务：非法 type → 400；不存在模型 → 400；查不存在任务 → 404
    r = await fetch(`http://127.0.0.1:${port}/admin/api/eval-jobs`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'xxx' }) });
    assert.strictEqual(r.status, 400);
    r = await fetch(`http://127.0.0.1:${port}/admin/api/eval-jobs`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'checkup', modelId: 'no-such-model' }) });
    assert.strictEqual(r.status, 400);
    r = await fetch(`http://127.0.0.1:${port}/admin/api/eval-jobs?id=job_nope`, { headers: H });
    assert.strictEqual(r.status, 404);
  } finally {
    if (child) child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});


// ════════ v0.10.3 回归覆盖 ════════
test('config 校验：ownership=unknown 且 enabled=true 拒绝（fail-closed）', async () => {
  const { validateConfig } = await import('../src/config.mjs');
  const { readFileSync } = await import('node:fs');
  const base = JSON.parse(readFileSync(new URL('../config/router.json', import.meta.url), 'utf8'));
  // 用真实生产 config 为底——只动一个模型的 ownership，其余校验必然通过
  const bad = structuredClone(base);
  bad.models[0].ownership = 'unknown';
  assert.throws(() => validateConfig(bad), /归属未确认.*不允许启用/);
  const okCfg = structuredClone(base);
  okCfg.models[0].ownership = 'unknown';
  okCfg.models[0].enabled = false;
  validateConfig(okCfg); // disabled 下 unknown 合法
});

test('路由排除：ownership=unknown 的模型不进候选（ownership_unconfirmed）', async () => {
  const { routeRequest } = await import('../src/router.mjs');
  const { readFileSync } = await import('node:fs');
  const base = JSON.parse(readFileSync(new URL('../config/router.json', import.meta.url), 'utf8'));
  const config = structuredClone(base);
  config.models[0].ownership = 'unknown'; // 强制第一台 unknown 且 enabled
  config.models[0].enabled = true;
  const r = routeRequest({ messages: [{ role: 'user', content: '写个快排' }], max_tokens: 100 }, config, { now: Date.now(), health: {} });
  const rejectedIds = (r.rejected || []).map((x) => x.model || x.modelId || x.id);
  assert.ok(rejectedIds.includes(config.models[0].id), 'unknown 模型应进 rejected（ownership_unconfirmed）');
  const allChosen = [...(r.candidates || []).map((c) => c.modelId), ...(r.pool || []).map((c) => c.modelId)];
  assert.ok(!allChosen.includes(config.models[0].id), 'unknown 模型不得进入候选池');
});
