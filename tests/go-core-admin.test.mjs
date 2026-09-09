import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createGoCoreAdmin } from '../src/go-core-admin.mjs';

test('Go admin bridge is opt-in and refuses nonliteral destinations or missing authentication', () => {
  assert.equal(createGoCoreAdmin({}), null);
  const env = { ADMIN_TOKEN: 'admin', AMR_GO_ADMIN_TOKEN: 'private-token-long-enough' };
  for (const url of ['http://localhost:12', 'https://127.0.0.1:12', 'http://127.0.0.1:12/path', 'http://127.0.0.1:12/?x=1', 'http://user@127.0.0.1:12', 'http://10.0.0.1:12']) {
    assert.throws(() => createGoCoreAdmin({ ...env, AMR_GO_ADMIN_URL: url }));
  }
  assert.throws(() => createGoCoreAdmin({ AMR_GO_ADMIN_URL: 'http://127.0.0.1:12' }));
});

test('Go admin bridge pins paths, preserves CAS, filters responses and never follows redirects', async () => {
  const revision = '"' + 'a'.repeat(64) + '"';
  let calls = [], mode = 'ok';
  const server = createServer((req, res) => {
    calls.push({ method: req.method, path: req.url, headers: req.headers });
    if (mode === 'redirect') { res.writeHead(302, { location: '/secret' }); return res.end('{}'); }
    if (mode === 'oversize') return res.end('x'.repeat(70000));
    if (mode === 'conflict') { res.writeHead(409); return res.end('{"secret":"never-return"}'); }
    res.end(JSON.stringify({ revision, configRevision: revision, secret: 'never-return' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const bridge = createGoCoreAdmin({ AMR_GO_ADMIN_URL: `http://127.0.0.1:${server.address().port}`, ADMIN_TOKEN: 'browser-token', AMR_GO_ADMIN_TOKEN: 'private-token-long-enough' });
    assert.equal((await bridge.reload()).status, 428);
    assert.equal((await bridge.reload('invalid\r\nheader')).status, 400);
    assert.equal(calls.length, 0);
    assert.deepEqual(await bridge.status(), { status: 200, revision, configRevision: revision });
    assert.deepEqual(await bridge.reload(revision), { status: 200, revision });
    assert.equal(calls[1].headers['if-match'], revision);
    assert.equal(calls[1].headers.authorization, 'Bearer private-token-long-enough');
    assert.equal(calls[1].headers.cookie, undefined);
    assert.deepEqual(calls.map(c => c.path), ['/internal/v1/config', '/internal/v1/config/reload']);
    mode = 'redirect'; assert.equal((await bridge.status()).status, 502); assert.equal(calls.length, 3);
    mode = 'conflict'; assert.deepEqual(await bridge.reload(revision), { status: 409, error: 'core_control_rejected' });
    mode = 'oversize'; await assert.rejects(bridge.status());
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
