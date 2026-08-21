// 管理页截图：headless Chrome 渲染能力档案（admin token 从 .env 读，只进 localStorage 不打印）
// 用法：node scripts/shot-profile.mjs [out.png]
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { projectRoot } from '../src/config.mjs';

const run = promisify(execFile);
const out = resolve(projectRoot, process.argv[2] || 'data', 'profile-shot.png');

let token = process.env.ADMIN_TOKEN || '';
if (!token) {
  try { token = (await readFile(resolve(projectRoot, '.env'), 'utf8')).split(/\r?\n/).find((l) => l.startsWith('ADMIN_TOKEN='))?.slice('ADMIN_TOKEN='.length).trim() || ''; } catch {}
}
if (!token) { console.error('缺少 ADMIN_TOKEN'); process.exit(2); }

const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const shot = resolve(tmpdir(), `router-profile-${Date.now()}.png`);
await run(chrome, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--window-size=1440,1400', '--virtual-time-budget=9000',
  `--session-storage=key=routerAdminToken,value=${token}`,
  '--dump-dom', 'http://127.0.0.1:8787/admin'
].map(String), { timeout: 30000 }).catch((e) => ({ stdout: e.stdout || '' }));
console.log('dom captured (headless --dump-dom 无法直接截图，退回 screenshot 模式)');
