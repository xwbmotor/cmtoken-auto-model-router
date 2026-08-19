import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

// 安全回归：CORS 收紧 + 管理端暴力破解限流。
// 起真实 server（随机端口、带 ADMIN_TOKEN），打真实请求断言。
const PORT = 18787;

async function waitFor(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return true; } catch {}
    await delay(150);
  }
  throw new Error('server 未启动');
}

test('CORS：恶意跨域 403 / 同源 200 / 暴破限流 429', async () => {
  const child = spawn('node', ['src/server.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT), ADMIN_TOKEN: 'test-token-xyz', HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  try {
    await waitFor(`http://127.0.0.1:${PORT}/health`);
    const base = `http://127.0.0.1:${PORT}`;

    // 恶意跨域：403（fetch 无法伪造 Origin，用真实 header）
    const evil = await fetch(base + '/admin/api/config', { headers: { origin: 'https://evil.example.com', authorization: 'Bearer test-token-xyz' } });
    assert.equal(evil.status, 403);
    assert.equal(evil.headers.get('access-control-allow-origin'), null);

    // 同源：200
    const same = await fetch(base + '/admin/api/config', { headers: { origin: base, authorization: 'Bearer test-token-xyz' } });
    assert.equal(same.status, 200);

    // 暴力破解：11 次错 token → 前 10 个 401，之后 429
    const codes = [];
    for (let i = 0; i < 11; i++) {
      const r = await fetch(base + '/admin/api/config', { headers: { authorization: `Bearer wrong-${i}` } });
      codes.push(r.status);
    }
    assert.equal(codes.filter((c) => c === 401).length, 10);
    assert.ok(codes.includes(429), '应有 429 出现');
  } finally {
    child.kill();
    await delay(300);
  }
});
