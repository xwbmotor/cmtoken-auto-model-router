// v0.11.10 UI 回归审计（发布门禁自动化——替代人肉 playwright 审计脚本）：
// 真实浏览器遍历全部 tab + 发现弹层两步向导，机器化断言：
//   1) 零 pageerror（绑定中断类 bug，v0.11.6 教训）
//   2) 关键交互元素存在（按钮/输入框）
//   3) 布局不变坏：发现列表行高 ≤44px（v0.11.9 教训：label 竖排折行 96px）
//   4) 归属下拉宽度 ≥ 最宽选项（v0.11.9 教训：47px 装不下）
//   5) 上传导入按钮有样式（v0.11.9 教训：btn-like 无定义）
//   6) 无「裸样式主按钮」：panel-head 内主按钮必须有 class
// 依赖 python3 + playwright（系统级）；无则 skip。
import { test } from 'node:test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as netServer } from 'node:net';
import { createServer as httpServer } from 'node:http';

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

test('UI 回归审计：7 tab + 发现向导，零错误 + 布局断言', { skip: !hasPlaywright && '无 python+playwright（跳过 UI 审计）' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'amr-ui-regress-'));
  const cfg = JSON.parse(readFileSync(join(process.cwd(), 'config', 'router.json'), 'utf8'));
  cfg.decisionLog = { ...(cfg.decisionLog || {}), enabled: false };
  writeFileSync(join(dir, 'router.json'), JSON.stringify(cfg));
  const port = await freePort();
  let mockProc = null; // v0.11.10：finally 可见（try 内 const 块作用域不可见）
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: process.cwd(), stdio: 'ignore',
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ADMIN_TOKEN: 'regress', CONFIG_PATH: join(dir, 'router.json'), AMR_CONFIG_DIR: dir, AMR_PROBE_ALLOW_LOCALHOST: '1' }, // mock 上游是 127.0.0.1——绕过 SSRF IP 拦截（仅测试）
  });
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) { await sleep(150); try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) up = true; } catch {} }
    if (!up) throw new Error('server 未启动');

    // mock 上游（供发现向导第2步用）
    // mock 上游必须独立进程：execFileSync(python3) 会冻结本进程事件循环，同进程 server 无法响应
    const mockJs = `
      const { createServer } = require('node:http');
      const s = createServer((req, res) => {
        const body = JSON.stringify({ data: [{ id: 'regress-new-model' }, { id: ${JSON.stringify(cfg.models[0].id)} }] });
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), connection: 'close' });
        res.end(body);
      });
      s.listen(0, '127.0.0.1', () => console.log(s.address().port));
    `;
    writeFileSync(join(dir, 'mock.js'), mockJs);
    const mockLog = join(dir, 'mock.log');
    const mockOut = openSync(mockLog, 'a');
    mockProc = spawn(process.execPath, [join(dir, 'mock.js')], { stdio: ['ignore', mockOut, 'ignore'] });
    let mockPort = 0;
    for (let i = 0; i < 40 && !mockPort; i++) {
      await sleep(150);
      try { mockPort = parseInt(readFileSync(mockLog, 'utf8').trim().split(String.fromCharCode(10)).pop(), 10); } catch {}
    }
    if (!mockPort) throw new Error('mock 上游启动失败');

    const script = `
import json
from playwright.sync_api import sync_playwright
BASE = 'http://127.0.0.1:${port}'
errs = []
with sync_playwright() as pw:
    b = pw.chromium.launch(headless=True)
    pg = b.new_page(viewport={'width': 1440, 'height': 900})
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(BASE + '/')
    pg.wait_for_load_state('networkidle')
    pg.wait_for_timeout(600)
    try:
        pg.fill('input', 'regress')
        pg.click('button:has-text("登")')
        pg.wait_for_timeout(1800)
    except Exception: pass
    result = {'pageerrors': errs}
    # 遍历 tab：每 tab 可交互无错
    tabs = pg.evaluate("[...document.querySelectorAll('#tabs button')].map(b => b.dataset.tab)")
    result['tabs'] = tabs
    for t in tabs:
        pg.click(f'#tabs button[data-tab=\"{t}\"]')
        pg.wait_for_timeout(300)
    result['pageerrors_after_tabs'] = errs
    # 发现向导：两步走完
    pg.click('#tabs button[data-tab=\"models\"]'); pg.wait_for_timeout(400)
    pg.evaluate("() => document.getElementById('discoverModels').click()"); pg.wait_for_timeout(400)
    ok1 = pg.evaluate("() => ({ url: !!document.getElementById('dcBaseUrl'), key: !!document.getElementById('dcApiKey'), next: !!document.getElementById('dcNext') })")
    result['step1'] = ok1
    pg.fill('#dcBaseUrl', 'http://127.0.0.1:${mockPort}')
    pg.fill('#dcApiKey', 'regress-key')
    pg.click('#dcNext'); pg.wait_for_timeout(1500)
    rowHs = pg.evaluate("() => [...document.querySelectorAll('.discover-row')].map(r => Math.round(r.getBoundingClientRect().height))")
    result['rowHeights'] = rowHs
    result['hasSelectAll'] = pg.evaluate("() => !!document.getElementById('discSelectAll')")
    sel = pg.evaluate("() => { const s = document.querySelector('#models select.ownership'); if (!s || !s.options.length) return null; const probe = document.createElement('span'); probe.style.cssText='position:absolute;visibility:hidden;white-space:nowrap'; document.body.appendChild(probe); let mx=0; for (const o of s.options){probe.textContent=o.textContent;mx=Math.max(mx,probe.getBoundingClientRect().width);} probe.remove(); return { selW: Math.round(s.getBoundingClientRect().width), needW: Math.round(mx) }; }")
    result['ownershipSelect'] = sel
    bl = pg.evaluate("() => { const l = document.querySelector('label.btn-like'); return l ? getComputedStyle(l).borderTopWidth !== '0px' : 'missing'; }")
    result['btnLikeStyled'] = bl
    # v0.11.11：断言内容可见性（不只行高）+ modal 兄弟 + 交错评测弹层可见
    result['nameWidths'] = pg.evaluate("() => [...document.querySelectorAll('.discover-row strong')].map(s => Math.round(s.getBoundingClientRect().width))")
    # v0.11.12：注册后引导面板 + 模型删除按钮
    pg.evaluate("() => { const c = document.querySelector('.disc-new'); if (c && !c.checked) c.click(); }")
    pg.wait_for_timeout(200)
    pg.evaluate("() => document.getElementById('registerSelected') && document.getElementById('registerSelected').click()")
    pg.wait_for_timeout(800)
    result['onboardGuide'] = pg.evaluate("() => { const g = document.querySelector('.onboard-guide'); return !!g && g.textContent.includes('交错评测') && g.textContent.includes('安全发布'); }")
    pg.evaluate("() => document.getElementById('guideClose') && document.getElementById('guideClose').click()")
    pg.wait_for_timeout(300)
    result['removeBtns'] = pg.evaluate("() => document.querySelectorAll('#models button[data-act=remove]').length")
    pg.on('dialog', lambda dlg: dlg.accept())  # 删除 confirm 在此之前挂好
    # 二十八审 P2-3：真实删除一遍——注册进来的 regress-new-model 应可删且删后行数-1
    result['removeFlow'] = pg.evaluate("() => { const trs = [...document.querySelectorAll('#models tr')]; const before = trs.length; const tr = trs.find(r => r.textContent.includes('regress-new-model')); if (!tr) return { found: false }; tr.querySelector('button[data-act=remove]').click(); return { found: true, before }; }")
    pg.wait_for_timeout(600)
    result['removeAfter'] = pg.evaluate("() => [...document.querySelectorAll('#models tr')].length")
    result['modalSiblings'] = pg.evaluate("() => { const dm = document.getElementById('discoverModal'); const em = document.getElementById('evalModal'); return !!dm && !!em && dm.parentElement === em.parentElement; }")
    pg.evaluate("() => { const b = document.getElementById('interleavedEval'); if (b) b.click(); }")
    pg.wait_for_timeout(1200)
    result['evalModalVisible'] = pg.evaluate("() => { const em = document.getElementById('evalModal'); const r = em.getBoundingClientRect(); return getComputedStyle(em).display === 'flex' && r.width > 0; }")
    result['pageerrors_final'] = errs
    b.close()
print(json.dumps(result))
`;
    writeFileSync(join(dir, 'regress.py'), script);
    let out;
    try { out = execFileSync(hasPlaywright, [join(dir, 'regress.py')], { encoding: 'utf8', timeout: 120000 }); }
    catch (e) { throw new Error(`playwright 失败: ${String(e.stdout || e.message).slice(0, 300)}`); }
    const r = JSON.parse(out.slice(out.indexOf('{')));
    if (r.pageerrors_final?.length) throw new Error(`页面 JS 错误: ${r.pageerrors_final.join(' | ')}`);
    if (!r.step1?.url || !r.step1?.key || !r.step1?.next) throw new Error(`向导第1步元素缺失: ${JSON.stringify(r.step1)}`);
    if (!r.hasSelectAll) throw new Error(`全选复选框缺失；step2 body: ${JSON.stringify(r.step2Body || r).slice(0, 300)}`);
    if (!Array.isArray(r.nameWidths) || r.nameWidths.some((w) => w < 10)) throw new Error(`模型名宽度 ${JSON.stringify(r.nameWidths)}——不可见（v0.11.9 全局 input width:100% 挤压回归）`);
    if (!r.modalSiblings) throw new Error('discoverModal/evalModal 非兄弟节点——modal 嵌套回归（v0.11.8 闭合标签缺失）');
    if (!r.evalModalVisible) throw new Error('交错评测弹层不可见（v0.11.11 P1-1 回归锚点）');
    if (!r.onboardGuide) throw new Error('注册成功后无上线路径引导面板（v0.11.12）');
    if (!Array.isArray(r.removeBtns) && !(r.removeBtns > 0)) throw new Error('模型表无删除按钮（v0.11.12）');
    if (!(Number(r.removeBtns) > 0)) throw new Error(`模型表删除按钮数 ${r.removeBtns}——应≥1`);
    if (r.removeFlow && !r.removeFlow.found) throw new Error('注册模型行未找到——删除流测试失效');
    if (r.removeFlow?.found && Number(r.removeAfter) !== Number(r.removeFlow.before) - 1) throw new Error(`删除后行数未减（before=${r.removeFlow.before} after=${r.removeAfter}）——二十八审 P1-4 删除链路`);
    const tall = (r.rowHeights || []).filter((h) => h > 44);
    if (tall.length) throw new Error(`发现列表行折行（>${44}px）: ${JSON.stringify(r.rowHeights)}`);
    if (r.ownershipSelect && r.ownershipSelect.selW < r.ownershipSelect.needW) throw new Error(`归属下拉过窄: ${JSON.stringify(r.ownershipSelect)}`);
    if (r.btnLikeStyled !== true) throw new Error(`上传导入按钮无样式: ${r.btnLikeStyled}`);
  } finally {
    try { child.kill('SIGKILL'); } catch {}
    // Windows 上 spawn 的子进程 SIGKILL 不可靠（mock 残留挂起 node --test）——用 taskkill /T 强杀进程树
    if (mockProc) {
      try { process.platform === 'win32' ? execFileSync('taskkill.exe', ['/PID', String(mockProc.pid), '/T', '/F'], { stdio: 'ignore' }) : mockProc.kill('SIGKILL'); } catch (e) { console.error('taskkill fail:', String(e.message).slice(0, 200)); }
      try { mockProc.kill('SIGKILL'); } catch {}
      mockProc.unref();
    }
    await new Promise((res) => setTimeout(res, 300));
    rmSync(dir, { recursive: true, force: true });
  }
});
