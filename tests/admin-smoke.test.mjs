// v0.11.6 管理台冒烟测试：真实浏览器打开页面，断言零 pageerror + 发现按钮绑定生效。
// 背景：v0.5.0 删除组件体检面板未同步删 app.js 死绑定（#evalClassifier/#replaySwitch），
// 模块在绑定处 TypeError 中断，其后 8 天所有新绑定（发现/交错评测/离线横幅）静默失效——
// API 测试与 node --check 均测不到此类问题，只有真实浏览器能抓。
// 依赖 python3 + playwright（系统级）；无则 skip（不阻断无浏览器环境）。
import { test } from 'node:test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as netServer } from 'node:net';

const hasPlaywright = (() => {
  for (const py of ['python3', 'python', 'py']) {
    try { execFileSync(py, ['-c', 'import playwright'], { stdio: 'ignore' }); return py; } catch {}
  }
  return null;
})();
// v0.11.11（二十六审 P1-4）：正式发布（AMR_TEST_STRICT_SKIP=1）时缺依赖直接失败，不静默跳过
if (!hasPlaywright && process.env.AMR_TEST_STRICT_SKIP === '1') {
  throw new Error('发布门禁：缺少 python+playwright，UI 测试不可跳过');
}

const freePort = () => new Promise((resolve, reject) => {
  const srv = netServer(); srv.unref(); srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('管理台冒烟：页面零 pageerror + 发现按钮绑定生效', { skip: !hasPlaywright && '无 python+playwright（跳过浏览器冒烟）' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'amr-smoke-'));
  const cfg = JSON.parse(readFileSync(join(process.cwd(), 'config', 'router.json'), 'utf8'));
  cfg.decisionLog = { ...(cfg.decisionLog || {}), enabled: false };
  writeFileSync(join(dir, 'router.json'), JSON.stringify(cfg));
  const port = await freePort();
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: process.cwd(), stdio: 'ignore',
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ADMIN_TOKEN: 'smoke', CONFIG_PATH: join(dir, 'router.json'), AMR_CONFIG_DIR: dir },
  });
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) { await sleep(150); try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) up = true; } catch {} }
    if (!up) throw new Error('server 未启动');

    const script = [
      'import json',
      'from playwright.sync_api import sync_playwright',
      `BASE = 'http://127.0.0.1:${port}'`,
      'errs = []',
      'with sync_playwright() as pw:',
      "    b = pw.chromium.launch(headless=True)",
      '    pg = b.new_page()',
      "    pg.on('pageerror', lambda e: errs.append(str(e)))",
      "    pg.goto(BASE + '/')",
      "    pg.wait_for_load_state('networkidle')",
      '    pg.wait_for_timeout(600)',
      '    try:',
      "        pg.fill('input', 'smoke')",
      '        pg.click(\'button:has-text("登")\')',
      '        pg.wait_for_timeout(2000)',
      '    except Exception: pass',
      "    pg.evaluate(\"() => document.getElementById('discoverModels').click()\")",
      '    pg.wait_for_timeout(1500)',
      "    modal = pg.evaluate(\"() => getComputedStyle(document.getElementById('discoverModal')).display\")",
      "    b.close()",
      'print(json.dumps({ "pageerrors": errs, "modal": modal }))',
    ].join('\n');
    writeFileSync(join(dir, 'smoke.py'), script);
    let out;
    try { out = execFileSync(hasPlaywright, [join(dir, 'smoke.py')], { encoding: 'utf8', timeout: 90000 }); }
    catch (e) { throw new Error(`playwright 脚本失败: ${String(e.stdout || e.message).slice(0, 300)}`); }
    const r = JSON.parse(out.slice(out.indexOf('{')));
    if (r.pageerrors && r.pageerrors.length) throw new Error(`页面 JS 错误（事件绑定可能中断）: ${r.pageerrors.join(' | ')}`);
    if (r.modal !== 'flex') throw new Error(`发现模型弹层未打开（绑定未生效）: display=${r.modal}`);
  } finally {
    child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true });
  }
});
