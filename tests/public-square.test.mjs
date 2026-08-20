import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import net from 'node:net';

// /api/models 公开端点（模型广场数据源）+ /models 页面：安全与形状测试。
// 独立起一个真实服务实例（学 server-real.test.mjs 的做法），测完即杀。

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function waitForHealth(port, maxMs = 8000) {
  for (let i = 0; i < maxMs / 200; i += 1) {
    await sleep(200);
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) return true; } catch { /* not yet */ }
  }
  return false;
}

test('模型广场：/api/models 免 token + 字段安全 + /models 页面可访问', async () => {
  const port = await freePort();
  const child = spawn(process.execPath, ['src/server.mjs'], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ROUTER_ACCESS_KEY: 'test-key', ADMIN_TOKEN: 'adm', METRICS_TOKEN: 'met' },
    cwd: process.cwd(), stdio: 'ignore', detached: false
  });
  try {
    assert.ok(await waitForHealth(port), 'server 启动超时');
    const base = `http://127.0.0.1:${port}`;

    // 1) 免 token 访问
    const res = await fetch(base + '/api/models');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.models) && body.models.length >= 1, '至少一个模型卡');
    assert.ok(body.service && body.service.version, '含服务版本');
    assert.ok(Array.isArray(body.report?.highlights), '含体检金句');

    // 2) 字段安全：不含部署资源/密钥/敏感字段名
    const raw = JSON.stringify(body);
    for (const card of body.models) {
      assert.equal(card.deployment, undefined, '不含部署资源');
      for (const k of Object.keys(card)) assert.ok(!/secret|token|key|password|apikey/i.test(k), `字段名敏感: ${k}`);
      assert.ok(card.id && card.displayName && card.ownership, '卡片基础字段完整');
      assert.ok(['自建部署', '生态伙伴'].includes(card.ownership), '归属已归一为中文');
    }
    assert.ok(!raw.includes('MAAS_API_KEY') && !raw.includes('ADMIN_TOKEN'), '不泄环境变量名');
    assert.ok(!raw.includes('deployment'), '不透出部署明细');

    // 3) /models 页面免 token
    const page = await fetch(base + '/models');
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes('模型广场') && html.includes('auto'), '页面渲染模型广场内容');

    // 4) /admin/api/config 无 token 仍 401（公开面没扩大）
    const admin = await fetch(base + '/admin/api/config');
    assert.equal(admin.status, 401);
  } finally {
    child.kill();
  }
});
