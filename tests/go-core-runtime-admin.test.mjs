import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createGoCoreAdmin } from '../src/go-core-admin.mjs';

const revision = '"' + 'a'.repeat(64) + '"', configRevision = '"' + 'b'.repeat(64) + '"';
const secret = 'protected-runtime-admin-secret';
test('runtime admin validates status schema, filters unknown fields and sends exact probe payloads', async t => {
  let mode = 'ok'; const requests = [];
  const health = { circuitState: 'closed', probeInFlight: false, consecutiveFailures: 0, successes: 4, failures: 0,
    ewmaLatencyMs: 20, circuitOpenUntil: 0, lastSuccessAt: 100, downSince: 0, halfOpenFailStreak: 0, lastFailureAt: 0 };
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push({ path: req.url, method: req.method, auth: req.headers.authorization, payload: raw ? JSON.parse(raw) : null });
    res.setHeader('content-type', 'application/json');
    if (mode === 'reject') { res.writeHead(409); res.end(JSON.stringify({ secret, error: 'private internal details' })); return; }
    if (req.url.startsWith('/internal/v1/probe/')) {
      res.end(JSON.stringify({ revision, configRevision, lease: 'c'.repeat(64), released: true, secret })); return;
    }
    res.end(JSON.stringify({ revision, configRevision, health: { model: { ...health, secret, ...(mode === 'bad-health' ? { failures: -1 } : {}) } },
      inflight: { model: mode === 'bad-load' ? -1 : 2 }, sessions: 1, persistenceHealthy: true, edgeEnabled: true, edgeErrors: 0, secret }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const admin = createGoCoreAdmin({ AMR_GO_ADMIN_URL: `http://127.0.0.1:${server.address().port}`, ADMIN_TOKEN: 'public-admin', AMR_GO_ADMIN_TOKEN: secret });
  const state = await admin.runtime();
  assert.deepEqual(state, { status: 200, revision, configRevision, health: { model: health }, inflight: { model: { inflight: 2 } }, sessions: 1,
    persistenceHealthy: true, edgeEnabled: true, edgeErrors: 0 });
  assert.equal(JSON.stringify(state).includes(secret), false);
  const acquired = await admin.acquireProbe('model', 20000, configRevision);
  assert.deepEqual(acquired, { status: 200, lease: 'c'.repeat(64) });
  assert.deepEqual(await admin.releaseProbe(acquired.lease), { status: 200, released: true });
  assert.deepEqual(requests.slice(1).map(r => ({ path: r.path, method: r.method, payload: r.payload })), [
    { path: '/internal/v1/probe/acquire', method: 'POST', payload: { model: 'model', ttlMs: 20000, configRevision } },
    { path: '/internal/v1/probe/release', method: 'POST', payload: { lease: acquired.lease } }
  ]);
  assert.ok(requests.every(r => r.auth === `Bearer ${secret}`));
  for (const value of ['bad-health', 'bad-load']) { mode = value; await assert.rejects(admin.runtime(), /invalid_core_response/); }
  mode = 'reject'; assert.deepEqual(await admin.acquireProbe('model', 20000, configRevision), { status: 409, error: 'core_control_rejected' });
});
