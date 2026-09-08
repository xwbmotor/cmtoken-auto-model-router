import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { routeRequest } from '../src/router.mjs';

test('latency shadow never changes production choice or bypasses quality/capacity gates', () => {
  const config = { models: [
    { id: 'a', enabled: true, costIndex: 0.1, latencyIndex: 0.5, quality: { default: 0.9 } },
    { id: 'b', enabled: true, costIndex: 0.2, latencyIndex: 0.5, quality: { default: 0.9 } },
    { id: 'bad', enabled: true, costIndex: 0, latencyIndex: 0.1, quality: { default: 0.3 } }
  ], routing: { mode: 'active', qualityWeight: 1, costWeight: 0.1, latencyWeight: 0.1, uncertaintyPenalty: 0, qualityFloor: 0.8,
    latencyObservation: { mode: 'shadow', switchMargin: 0.02 }, loadBalancing: { enabled: true, limits: { a: 1, b: 1 } } }, taskRules: {} };
  const body = { messages: [{ role: 'user', content: 'Hello' }] };
  const evidence = model => ({ status: 'ready', adjustment: model.id === 'a' ? -0.05 : 0.05 });
  const decision = routeRequest(body, config, { latencyAssessment: evidence, trafficBucket: 0 });
  assert.equal(decision.selectedModel, 'a'); assert.equal(decision.suggestedModel, 'a');
  assert.equal(decision.latencyShadow.proposedModel, 'b'); assert.equal(decision.latencyShadow.changed, true);
  const saturated = routeRequest(body, config, { latencyAssessment: evidence, modelLoad: { b: { inflight: 1 } }, trafficBucket: 0 });
  assert.equal(saturated.latencyShadow.proposedModel, 'a');
  const unknown = routeRequest(body, config, { latencyAssessment: model => ({ ...evidence(model), status: 'no_data' }), trafficBucket: 0 });
  assert.equal(unknown.latencyShadow.changed, false);
});

test('real proxy separates business/probes, records timing, protects APIs and persists observations', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'amr-latency-'));
  const cfg = JSON.parse(await readFile(new URL('../config/router.json', import.meta.url), 'utf8'));
  cfg.semanticRouter = { ...cfg.semanticRouter, provider: 'disabled', mode: 'shadow' };
  cfg.judge = { ...cfg.judge, enabled: false };
  cfg.decisionLog = { ...cfg.decisionLog, enabled: false };
  cfg.rateLimit = { enabled: false };
  cfg.budget = { ...cfg.budget, enabled: false, statePath: join(dir, 'budget.json') };
  cfg.routing.latencyObservation = { mode: 'shadow', probes: { enabled: false, maxCallsPerDay: 2 } };
  for (const model of cfg.models) { model.minimumCompletionTokensForReliableAnswer = 0; }
  let fail = false, calls = 0;
  const upstream = createServer(async (req, res) => {
    if (req.url.endsWith('/models')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: cfg.models.map(m => ({ id: m.id })) })); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); calls++;
    if (fail) { res.writeHead(503); res.end('busy'); return; }
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n');
      await sleep(25);
      res.write('data: {"choices":[{"delta":{"content":"2"}}]}\n\n');
      await sleep(25); res.end('data: [DONE]\n\n');
    } else { await sleep(30); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ model: body.model, choices: [{ message: { content: '2' } }] })); }
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const reserved = createServer(); reserved.listen(0, '127.0.0.1'); await once(reserved, 'listening');
  const port = reserved.address().port; await new Promise(resolve => reserved.close(resolve));
  cfg.upstreamBaseUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
  await writeFile(join(dir, 'router.json'), JSON.stringify(cfg));
  const child = spawn(process.execPath, ['src/server.mjs'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env,
    CONFIG_PATH: join(dir, 'router.json'), AMR_CONFIG_DIR: dir, HOST: '127.0.0.1', PORT: String(port),
    UPSTREAM_BASE_URL: cfg.upstreamBaseUrl, UPSTREAM_API_KEY: 'fake-upstream-key', ROUTER_KEY_MODE: 'strict', ROUTER_ACCESS_KEY: 'fake-router-key', ADMIN_TOKEN: 'adm', AMR_TEST_SHUTDOWN_IPC: '1' } });
  let logs = ''; child.stdout.on('data', b => { logs = (logs + b).slice(-6000); }); child.stderr.on('data', b => { logs = (logs + b).slice(-6000); });
  const base = `http://127.0.0.1:${port}`;
  const admin = { authorization: 'Bearer adm' };
  const query = async (params = '') => (await fetch(base + '/admin/api/latency' + params, { headers: admin })).json();
  try {
    let ready = false;
    for (let i = 0; i < 60; i++) { try { ready = (await fetch(base + '/health')).ok; if (ready) break; } catch {} await sleep(100); }
    assert.ok(ready, logs);
    assert.equal((await fetch(base + '/admin/api/latency')).status, 401);
    assert.equal((await fetch(base + '/admin/api/latency/probe', { method: 'POST' })).status, 401);
    const request = async stream => {
      const res = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer fake-router-key', 'content-type': 'application/json' },
        body: JSON.stringify({ model: cfg.models[0].id, messages: [{ role: 'user', content: '1+1?' }], stream, max_tokens: 128 }) });
      await res.text(); return res.status;
    };
    assert.equal(await request(true), 200); assert.equal(await request(false), 200); fail = true; assert.equal(await request(false), 502); fail = false;
    await sleep(100);
    let report = await query('?metric=ttftMs');
    const row = report.rows[0].recent30;
    assert.equal(row.count, 3); assert.equal(row.success, 2); assert.equal(row.failed, 1); assert.equal(row.validCount, 1);
    assert.ok(row.p50Ms >= 20); assert.equal(row.p95Ms, null);
    report = await query('?metric=attemptMs&stream=false'); assert.equal(report.rows[0].recent30.validCount, 1);
    const before = calls;
    assert.equal((await fetch(base + '/admin/api/latency/probe', { method: 'POST', headers: admin })).status, 202);
    assert.equal((await fetch(base + '/admin/api/latency/probe', { method: 'POST', headers: admin })).status, 409);
    for (let i = 0; i < 40; i++) { report = await query('?source=probe'); if (!report.probe.running) break; await sleep(100); }
    assert.equal(calls, before + 1); assert.equal(report.probe.callsToday, 1);
    assert.equal(report.rows.reduce((n, r) => n + r.recent30.success, 0), 1);
    assert.equal((await query()).rows[0].recent30.count, 3);
    child.send({ type: 'amr-shutdown', reason: 'test' }); await once(child, 'exit');
    const saved = JSON.parse(await readFile(join(dir, 'latency-observations.json'), 'utf8'));
    assert.equal(saved.probeState.calls, 1); assert.ok(saved.hours.length > 0);
    assert.doesNotMatch(JSON.stringify(saved), /fake-upstream-key|1\+1\?/);
  } finally {
    if (child.exitCode == null) { child.kill(); await once(child, 'exit'); }
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
