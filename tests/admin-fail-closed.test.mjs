import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

test('loopback without admin secret denies APIs and undefined-token login; business discovery stays available', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'amr-admin-closed-'));
  const config = JSON.parse(await readFile('config/router.json', 'utf8'));
  config.decisionLog = { ...config.decisionLog, enabled: false };
  config.semanticRouter = { ...config.semanticRouter, enabled: false, mode: 'shadow' };
  config.judge = { ...config.judge, enabled: false };
  config.routing.latencyObservation = { mode: 'off', probes: { enabled: false } };
  await writeFile(join(dir, 'router.json'), JSON.stringify(config));
  const portServer = net.createServer().listen(0, '127.0.0.1');
  await once(portServer, 'listening');
  const port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  const child = spawn(process.execPath, ['src/server.mjs'], { env: { ...process.env,
    HOST: '127.0.0.1', PORT: String(port), ADMIN_TOKEN: '', METRICS_TOKEN: 'test-metrics',
    AMR_GO_NATIVE_FRONT: '', AMR_GO_CHAT_EDGE: '', CONFIG_PATH: join(dir, 'router.json'),
    AMR_CONFIG_DIR: dir, AMR_COUNTERS_PATH: join(dir, 'counters.json'), ROUTER_ACCESS_KEY: 'test-business'
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let startupLog = '';
  child.stdout.on('data', data => { startupLog += data; });
  child.stderr.on('data', data => { startupLog += data; });
  const stopped = once(child, 'exit');
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${base}/health`)).ok) { ready = true; break; } } catch {}
      await sleep(100);
    }
    assert.ok(ready, `isolated server must start: ${startupLog}`);
    for (const path of ['/admin/api/config', '/admin/api/decisions', '/admin/api/annotation-export']) {
      assert.equal((await fetch(base + path)).status, 401);
      assert.equal((await fetch(base + path, { headers: { authorization: 'Bearer undefined' } })).status, 401);
    }
    for (const token of [undefined, '', 'undefined']) {
      const response = await fetch(base + '/admin/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('set-cookie'), null);
    }
    assert.equal((await fetch(base + '/v1/models', { headers: { authorization: 'Bearer test-business' } })).status, 200);
  } finally {
    child.kill(); await stopped;
    await rm(dir, { recursive: true, force: true });
  }
});

test('native public proxy refuses startup with missing admin secret before loading configuration', async () => {
  const child = spawn(process.execPath, ['src/server.mjs'], { env: { ...process.env,
    HOST: '127.0.0.1', AMR_GO_NATIVE_FRONT: '1', ADMIN_TOKEN: '', CONFIG_PATH: 'nonexistent-security-test.json'
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stderr.on('data', x => { output += x; });
  const [code] = await once(child, 'exit');
  assert.notEqual(code, 0);
  assert.match(output, /Native Go front requires ADMIN_TOKEN/);
  assert.doesNotMatch(output, /ENOENT/);
});
