// v0.11.11（二十六审 P1-2/P1-3）：交错评测禁用模型拒绝（黑盒）+ discover-probe SSRF 防护（黑盒）
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

test('交错评测：禁用/归属待定模型后端拒绝（黑盒）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'amr-itl-deny-'));
  // 一个启用+确认归属、一个禁用、一个归属待定
  // 模板法：完整 config 过 validateConfig（最小 config 缺 quality.default 等会被拒）
  const cfg = JSON.parse(readFileSync(join(process.cwd(), 'config', 'router.json'), 'utf8'));
  const m0 = cfg.models[0];
  cfg.models = [
    { ...m0, id: 'ok-model', displayName: 'OK', enabled: true, ownership: 'self_hosted' },
    { ...m0, id: 'disabled-model', displayName: 'DIS', enabled: false, ownership: 'self_hosted' },
    { ...m0, id: 'unknown-model', displayName: 'UNK', enabled: false, ownership: 'unknown' }, // config 校验要求 unknown 必须 disabled——本来就是不允许上线的形态
  ];
  cfg.routing.defaultExplicitModel = 'ok-model'; cfg.routing.shadowModel = 'ok-model';
  cfg.routing.taskPreferences = {}; // 模板引用的原模型已删
  if (cfg.semanticRouter) { cfg.semanticRouter.model = 'ok-model'; if (cfg.semanticRouter.openaiChat) cfg.semanticRouter.openaiChat.model = 'ok-model'; }
  cfg.decisionLog = { ...(cfg.decisionLog || {}), enabled: false, dirPath: dir };
  writeFileSync(join(dir, 'router.json'), JSON.stringify(cfg));
  const port = await freePort();
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: process.cwd(), stdio: 'ignore',
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ADMIN_TOKEN: 'a', CONFIG_PATH: join(dir, 'router.json'), AMR_CONFIG_DIR: dir },
  });
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) { await sleep(150); try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) up = true; } catch {} }
    if (!up) throw new Error('server 未启动');
    const B = `http://127.0.0.1:${port}`;
    const H = { authorization: 'Bearer a', 'content-type': 'application/json' };

    // 含禁用模型 → 400 拒绝
    let r = await fetch(`${B}/admin/api/eval-jobs`, { method: 'POST', headers: H, body: JSON.stringify({ type: 'interleaved', modelIds: ['ok-model', 'disabled-model'] }) });
    let j = await r.json();
    if (r.status !== 400) throw new Error(`禁用模型应 400，实际 ${r.status}`);
    if (!/未启用或归属待定/.test(j.error?.message || '')) throw new Error(`拒因不含说明: ${j.error?.message}`);

    // 含归属待定模型 → 400
    r = await fetch(`${B}/admin/api/eval-jobs`, { method: 'POST', headers: H, body: JSON.stringify({ type: 'interleaved', modelIds: ['ok-model', 'unknown-model'] }) });
    j = await r.json();
    if (r.status !== 400) throw new Error(`unknown 模型应 400，实际 ${r.status}`);
  } finally {
    child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true });
  }
});

test('discover-probe SSRF：IP/localhost/非清单域名/带凭据 URL 全拒绝（黑盒）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'amr-ssrf-'));
  const cfg = JSON.parse(readFileSync(join(process.cwd(), 'config', 'router.json'), 'utf8'));
  cfg.models = [{ ...cfg.models[0], id: 'm1', displayName: 'M', enabled: false, ownership: 'unknown' }];
  cfg.routing.defaultExplicitModel = 'm1'; cfg.routing.shadowModel = 'm1';
  cfg.routing.taskPreferences = {}; cfg.routing.maxAttempts = 1;
  if (cfg.semanticRouter) { cfg.semanticRouter.model = 'm1'; if (cfg.semanticRouter.openaiChat) cfg.semanticRouter.openaiChat.model = 'm1'; }
  cfg.decisionLog = { ...(cfg.decisionLog || {}), enabled: false, dirPath: dir };
  writeFileSync(join(dir, 'router.json'), JSON.stringify(cfg));
  const port = await freePort();
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: process.cwd(), stdio: 'ignore',
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ADMIN_TOKEN: 'a', CONFIG_PATH: join(dir, 'router.json'), AMR_CONFIG_DIR: dir },
  });
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) { await sleep(150); try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) up = true; } catch {} }
    if (!up) throw new Error('server 未启动');
    const B = `http://127.0.0.1:${port}`;
    const H = { authorization: 'Bearer a', 'content-type': 'application/json' };
    const cases = [
      ['http://127.0.0.1:8080/v1', 'IP 直连'],
      ['http://localhost:9000/v1', 'localhost'],
      ['http://169.254.169.254/latest/v1', '云元数据 IP'],
      ['http://user:pass@maas.gd.chinamobile.com:36007/v1', 'URL 内嵌凭据'],
      ['ftp://maas.gd.chinamobile.com/v1', '非 http 协议'],
      ['http://evil.example.com/v1', '非清单域名'],
      ['not a url', '非法 URL'],
    ];
    for (const [u, name] of cases) {
      const r = await fetch(`${B}/admin/api/discover-probe`, { method: 'POST', headers: H, body: JSON.stringify({ baseUrl: u, apiKey: 'k' }) });
      const j = await r.json();
      if (r.status !== 400) throw new Error(`${name} 应 400，实际 ${r.status} ${JSON.stringify(j).slice(0, 100)}`);
    }
    // 清单内域名（不携带内嵌凭据）应通过 URL 校验（连接失败是 502，不是 400——语义不同）
    const r2 = await fetch(`${B}/admin/api/discover-probe`, { method: 'POST', headers: H, body: JSON.stringify({ baseUrl: 'https://maas.gd.chinamobile.com:36007/ai/uifm/open/v1', apiKey: 'k' }) });
    if (r2.status === 400) throw new Error('清单内域名不应被 URL 校验拒绝');
  } finally {
    child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true });
  }
});
