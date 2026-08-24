// v0.7.4 十审 P2：/admin/api/reload secret 校验的行为级回归。
// 场景：①shadow 启动 → 磁盘改非法配置（activeTrafficPercent=101）→ reload 400 → 旧配置仍生效
//       ②active + 达标 secret 的合法 reload 200（校验不误伤）
//       ③进程 env 无 secret → 磁盘改 active → reload 400（缺 secret 绕过口）
// 证明「先 load 临时→校验→通过才替换全局 config」顺序正确（v0.7.3 九审 P1 的行为级补测）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { readFileSync as fsReadFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SECRET = 'test-secret-v074-0123456789abcdef012345';  // ≥32 字节
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function holdPort() {
  // v0.7.3 九审 P1 教训：spawn≠listening；holdPort 预占再释放，子进程 bind 同端口
  const probe = createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  return { port };
}

async function startRouter({ env, port }) {
  const child = spawn(process.execPath, [join(ROOT, 'src/server.mjs')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ADMIN_TOKEN: 'adm', METRICS_TOKEN: 'met', ROUTER_KEY_MODE: 'passthrough', ...env },
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 50; i += 1) {
    await sleep(200);
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) return child; } catch { /* retry */ }
  }
  child.kill();
  throw new Error('server 启动超时');
}

function makeBaseConfig(upstreamPort, workDir) {
  const base = JSON.parse(readFileSyncSafe(join(ROOT, 'config/router.json')));
  base.server = { ...base.server, bind: '127.0.0.1' };
  base.semanticRouter = { enabled: true, mode: 'shadow', provider: 'openai-chat', openaiChat: { model: 'deepseekv4-flash', timeoutMs: 5000 }, confidenceThreshold: 0.7, smallAcceptThreshold: 0.7, finalAdoptionThreshold: 0.5 };
  base.decisionLog = { ...base.decisionLog, enabled: true, dirPath: workDir.split('\\').join('/'), maxDays: 30 };
  base.upstream = { baseUrl: `http://127.0.0.1:${upstreamPort}`, apiKey: 't', timeoutMs: 15000 };
  base.redaction = { enabled: false };
  return base;
}
function readFileSyncSafe(p) { return fsReadFileSync(p, 'utf8'); }

test('reload 绕过口已堵：非法配置 400 不替换；active+达标 secret 合法通过', async () => {
  // mock 上游（READY 握手）
  let readyResolve; const readyPromise = new Promise((r) => { readyResolve = r; });
  const upstream = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    });
  });
  upstream.listen(0, '127.0.0.1', () => readyResolve(upstream.address().port));
  const upstreamPort = await readyPromise;

  const workDir = await mkdtemp(join(tmpdir(), 'amr-reload-'));
  const cfgPath = join(workDir, 'router.json');
  const base = makeBaseConfig(upstreamPort, workDir);
  await writeFile(cfgPath, JSON.stringify(base), 'utf8');

  const { port } = await holdPort();
  const child = await startRouter({ env: { CONFIG_PATH: cfgPath, SEMANTIC_BUCKET_SECRET: SECRET }, port });
  try {
    const admin = { Authorization: 'Bearer adm' };
    let r = await fetch(`http://127.0.0.1:${port}/admin/api/config`, { headers: admin });
    let cfg = await r.json();
    assert.equal(cfg.semanticRouter.mode, 'shadow');

    // 1) 非法配置 → 400 且报错指向字段；旧配置不被替换
    await writeFile(cfgPath, JSON.stringify({ ...base, semanticRouter: { ...base.semanticRouter, mode: 'active', activeTrafficPercent: 101 } }), 'utf8');
    r = await fetch(`http://127.0.0.1:${port}/admin/api/reload`, { method: 'POST', headers: admin });
    assert.equal(r.status, 400);
    let body = await r.json();
    assert.match(body.error?.message || body.message || '', /activeTrafficPercent/);
    r = await fetch(`http://127.0.0.1:${port}/admin/api/config`, { headers: admin });
    cfg = await r.json();
    assert.equal(cfg.semanticRouter.mode, 'shadow', 'reload 被拒后运行时不得被替换');

    // 2) active + 达标 secret → 200（校验不误伤）
    await writeFile(cfgPath, JSON.stringify({ ...base, semanticRouter: { ...base.semanticRouter, mode: 'active', activeTrafficPercent: 50 } }), 'utf8');
    r = await fetch(`http://127.0.0.1:${port}/admin/api/reload`, { method: 'POST', headers: admin });
    assert.equal(r.status, 200);
    r = await fetch(`http://127.0.0.1:${port}/admin/api/config`, { headers: admin });
    cfg = await r.json();
    assert.equal(cfg.semanticRouter.mode, 'active', '合法 reload 后新配置生效');
  } finally {
    child.kill();
    await Promise.race([once(child, 'exit'), sleep(3000)]);
    upstream.close();
  }
});

test('active 缺 secret：reload 拒绝 400，旧配置仍生效', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'amr-reload2-'));
  const cfgPath = join(workDir, 'router.json');
  const base = makeBaseConfig(1, workDir);  // 上游指向死端口不影响 reload 测试
  await writeFile(cfgPath, JSON.stringify(base), 'utf8');

  const { port } = await holdPort();
  const child = await startRouter({ env: { CONFIG_PATH: cfgPath, SEMANTIC_BUCKET_SECRET: '' }, port });
  try {
    const admin = { Authorization: 'Bearer adm' };
    // 磁盘改 active（env 无 secret）→ reload 必须 400 且指向 secret
    await writeFile(cfgPath, JSON.stringify({ ...base, semanticRouter: { ...base.semanticRouter, mode: 'active' } }), 'utf8');
    const r = await fetch(`http://127.0.0.1:${port}/admin/api/reload`, { method: 'POST', headers: admin });
    assert.equal(r.status, 400, 'active 缺 secret 的 reload 应 400');
    const body = await r.json();
    assert.match(body.error?.message || body.message || '', /SEMANTIC_BUCKET_SECRET/);
    const cfgResp = await fetch(`http://127.0.0.1:${port}/admin/api/config`, { headers: admin });
    const cfg = await cfgResp.json();
    assert.equal(cfg.semanticRouter.mode, 'shadow', 'reload 被拒后运行时仍是 shadow');
  } finally {
    child.kill();
    await Promise.race([once(child, 'exit'), sleep(3000)]);
  }
});
