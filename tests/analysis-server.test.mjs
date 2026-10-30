import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createAnalysisServer } from '../src/analysis-server.mjs';

const baseline = JSON.parse(await readFile(new URL('../config/router.json', import.meta.url), 'utf8'));
const key = 'analysis-fixture-key-not-a-production-secret';
const input = { messages: [{ role: 'user', content: '请评审 Python 代码的并发安全问题' }] };
function config() {
  const c = structuredClone(baseline);
  Object.assign(c.routing, { qualityFloor: 0.1, complexQualityMargin: 0, relQualityCap: 1, taskPreferences: {} });
  c.version = 'fixture';
  return c;
}
async function harness(options = {}) {
  const events = [];
  const server = createAnalysisServer({ config: config(), accessKey: key, audit: e => events.push(e), burst: 100, ...options });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, events, base, close: () => server.closeAnalysis(),
    post: (body = input, headers = {}) => fetch(base + '/v1/decide', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...headers },
      body: JSON.stringify(body)
    }) };
}

test('analysis fails closed at startup without a dedicated strong credential or approved candidates', () => {
  for (const accessKey of [undefined, '', 'short', 'a'.repeat(32) + ' ']) {
    assert.throws(() => createAnalysisServer({ config: config(), accessKey }), /analysis_access_key/);
  }
  assert.throws(() => createAnalysisServer({ config: config(), accessKey: key, allowedModelIds: [] }), /approved_models/);
  assert.throws(() => createAnalysisServer({ config: config(), accessKey: key, allowedModelIds: ['absent'] }), /approved_models/);
  assert.throws(() => createAnalysisServer({ config: config(), accessKey: key, timeoutMs: 5001 }), /invalid_analysis_limits/);
});

test('analysis returns decision features and random correlation IDs without input text or upstream execution', async () => {
  const h = await harness();
  try {
    const marker = 'SYNTHETIC_PRIVATE_INPUT_90210';
    const body = { messages: [{ role: 'user', content: `${marker} 请检查 Python 代码` }] };
    const r = await h.post(body); assert.equal(r.status, 200);
    const value = await r.json();
    assert.equal(value.analysis.task, 'coding'); assert.ok(value.suggestedModel);
    assert.ok(value.candidates.length); assert.ok(value.analysis.estimatedInputTokens > 0);
    assert.match(value.requestId, /^[a-f0-9-]{36}$/); assert.ok(value.policyRevision);
    assert.equal(value.observation.inferenceExecuted, false);
    assert.equal(value.observation.qualityOutcomeObserved, false);
    assert.equal(value.observation.contentStored, false);
    assert.equal(value.observation.classifier, 'rules');
    const second = await (await h.post(body)).json(); assert.notEqual(second.requestId, value.requestId);
    assert.ok(!JSON.stringify(value).includes(marker));
    assert.ok(!JSON.stringify(h.events).includes(marker));
    assert.equal(h.events.at(-1).coverage.completed, 2);
    assert.equal(h.events.at(-1).result.analysis.task, 'coding');
    assert.equal(h.events.at(-1).result.modelScope, undefined);
  } finally { await h.close(); }
});

test('analysis authentication and path allowlist cannot expose forwarding, administration or reload', async () => {
  const h = await harness();
  try {
    for (const authorization of ['', 'Bearer wrong', 'Bearer adm', 'Basic abc']) {
      const r = await h.post(input, { authorization }); assert.equal(r.status, 401);
      assert.equal((await r.json()).error.code, 'unauthorized');
    }
    for (const path of ['/v1/chat/completions', '/admin/api/config', '/internal/decide', '/metrics', '/v1/decide?x=1']) {
      const r = await fetch(h.base + path, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: '{}' });
      assert.equal(r.status, 404, path);
    }
    assert.equal((await fetch(h.base + '/v1/decide')).status, 405);
    assert.equal((await fetch(h.base + '/health')).status, 200);
    assert.equal((await fetch(h.base + '/health/ready')).status, 200);
    assert.equal(h.server.analysisSnapshot().completed, 0);
  } finally { await h.close(); }
});

test('analysis rejects unsafe or unapproved input structures; history requires an explicit operator option', async () => {
  const h = await harness();
  try {
    for (const body of [null, [], { ...input, policy: {} }, { ...input, requestId: 'private-user-id' },
      { ...input, tools: [] }, { ...input, stream: true }, { messages: [] },
      { messages: [{ role: 'system', content: 'secret' }] },
      { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.invalid' } }] }] },
      { messages: [{ role: 'user', content: 'hello', tool_calls: [] }] },
      { messages: [{ role: 'user', content: 'x'.repeat(65537) }] },
      { messages: [...input.messages, ...input.messages] },
      { ...input, availableModelIds: ['private text with spaces'] }, { ...input, model: {} }]) {
      assert.equal((await h.post(body)).status, 400, JSON.stringify(body).slice(0, 100));
    }
    assert.equal((await h.post(input, { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await h.post(input, { 'content-encoding': 'gzip' })).status, 415);
    const malformed = await fetch(h.base + '/v1/decide', { method: 'POST', headers: {
      authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: '{bad_json_PRIVATE' });
    assert.equal(malformed.status, 400); assert.ok(!(await malformed.text()).includes('PRIVATE'));
    assert.equal(h.server.analysisSnapshot().completed, 0);
  } finally { await h.close(); }
  const history = await harness({ allowHistory: true });
  try {
    const r = await history.post({ messages: [input.messages[0], { role: 'assistant', content: 'previous answer' }, input.messages[0]] });
    assert.equal(r.status, 200); assert.equal((await r.json()).observation.inputScope, 'text-history');
  } finally { await history.close(); }
});

test('analysis intersects configured and request scopes without fail-open or invented tenant entitlement', async () => {
  const c = config(); const ids = c.models.filter(m => m.enabled === true && m.ownership !== 'unknown').map(m => m.id);
  const h = await harness({ config: c, allowedModelIds: [ids[0]] });
  try {
    const r = await h.post({ ...input, availableModelIds: [ids[0], ids[1], 'unknown-fixture'] });
    assert.equal(r.status, 200); const value = await r.json();
    assert.deepEqual(value.modelScope.availableModelIds, [ids[0]]);
    assert.deepEqual(value.modelScope.unknownModelIds, ['unknown-fixture']);
    assert.equal(value.suggestedModel, ids[0]);
    for (const availableModelIds of [[], ['absent'], [ids[1]]]) {
      const blocked = await h.post({ ...input, availableModelIds });
      assert.equal(blocked.status, 400); assert.equal((await blocked.json()).error.code, 'no_available_models');
    }
    assert.equal((await h.post({ ...input, model: ids[1] })).status, 403);
    assert.equal((await h.post({ ...input, model: 'absent' })).status, 400);
    assert.equal((await h.post({ ...input, model: ids[0] })).status, 200);
    // Caller mutating the original config after startup cannot change the snapshot.
    c.models.length = 0;
    assert.equal((await h.post()).status, 200);
    assert.ok(!JSON.stringify(h.events).includes('unknown-fixture'));
  } finally { await h.close(); }
});

test('analysis rejects oversized declared and chunked bodies', async () => {
  const h = await harness({ maxBodyBytes: 256 });
  try {
    assert.equal((await h.post({ messages: [{ role: 'user', content: 'x'.repeat(400) }] })).status, 413);
    const status = await new Promise((resolveStatus, reject) => {
      const req = http.request(h.base + '/v1/decide', { method: 'POST', headers: {
        authorization: `Bearer ${key}`, 'content-type': 'application/json', 'transfer-encoding': 'chunked'
      } }, res => { res.resume(); resolveStatus(res.statusCode); });
      req.on('error', reject); req.write('x'.repeat(200)); req.end('x'.repeat(200));
    });
    assert.equal(status, 413);
  } finally { await h.close(); }
});

test('analysis bounds slow readers, concurrent work and authenticated/unauthenticated rates', async () => {
  const h = await harness({ timeoutMs: 400, maxConcurrent: 1 });
  let slow;
  try {
    const slowStatus = new Promise((resolveStatus, reject) => {
      slow = http.request(h.base + '/v1/decide', { method: 'POST', headers: {
        authorization: `Bearer ${key}`, 'content-type': 'application/json', 'content-length': '200'
      } }, res => { res.resume(); resolveStatus(res.statusCode); });
      slow.on('error', reject); slow.write('{');
    });
    for (let i = 0; i < 100 && h.server.analysisSnapshot().active !== 1; i++) await sleep(5);
    assert.equal(h.server.analysisSnapshot().active, 1);
    assert.equal((await h.post()).status, 503);
    assert.equal(await slowStatus, 408);
    assert.equal(h.server.analysisSnapshot().active, 0);
    assert.equal(h.server.analysisSnapshot().timedOut, 1);
  } finally { slow?.destroy(); await h.close(); }
  const limited = await harness({ burst: 1, rpm: 1 });
  try {
    assert.equal((await limited.post(input, { authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await limited.post()).status, 429);
  } finally { await limited.close(); }
});

test('analysis worker deadline terminates pathological local rule computation without blocking health', async () => {
  const c = config(); c.taskRules.patterns = { coding: ['(a+)+$'] };
  const h = await harness({ config: c, timeoutMs: 500 });
  try {
    const request = h.post({ messages: [{ role: 'user', content: 'a'.repeat(30000) + '!' }] });
    await sleep(100);
    const start = performance.now(); assert.equal((await fetch(h.base + '/health')).status, 200);
    assert.ok(performance.now() - start < 1000, 'worker must not block HTTP event loop');
    const r = await request; assert.equal(r.status, 408);
    assert.equal((await r.json()).error.code, 'analysis_timeout');
    assert.equal(h.server.analysisSnapshot().active, 0);
  } finally { await h.close(); }
});

test('analysis fails a decision on audit sink failure and exposes the failure count', async () => {
  const h = await harness({ audit: () => { throw new Error('private sink error'); } });
  try {
    const r = await h.post(); assert.equal(r.status, 503);
    const result = await r.json(); assert.equal(result.error.code, 'audit_unavailable');
    assert.ok(!JSON.stringify(result).includes('private sink error'));
    assert.equal(h.server.analysisSnapshot().completed, 0);
    assert.equal(h.server.analysisSnapshot().auditErrors, 1);
    assert.equal((await (await fetch(h.base + '/health')).json()).auditErrors, 1);
  } finally { await h.close(); }
});

test('analysis disconnect cancels reading and releases the bounded slot', async () => {
  const h = await harness({ maxConcurrent: 1 });
  const req = http.request(h.base + '/v1/decide', { method: 'POST', headers: {
    authorization: `Bearer ${key}`, 'content-type': 'application/json', 'content-length': '200'
  } });
  req.on('error', () => {});
  try {
    req.write('{');
    for (let i = 0; i < 100 && h.server.analysisSnapshot().active !== 1; i++) await sleep(5);
    assert.equal(h.server.analysisSnapshot().active, 1);
    req.destroy();
    for (let i = 0; i < 100 && h.server.analysisSnapshot().active !== 0; i++) await sleep(5);
    assert.equal(h.server.analysisSnapshot().active, 0);
    assert.equal((await h.post()).status, 200);
  } finally { req.destroy(); await h.close(); }
});

test('analysis CLI ignores forwarding/background flags and produces metadata only without data files', { timeout: 20000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'amr-analysis-'));
  let upstreamCalls = 0;
  const upstream = http.createServer((_req, res) => { upstreamCalls++; res.end('{}'); });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const c = config(), endpoint = `http://127.0.0.1:${upstream.address().port}/v1`;
  c.upstreamBaseUrl = endpoint;
  c.semanticRouter = { ...c.semanticRouter, enabled: true, mode: 'active', provider: 'cascade', baseUrl: endpoint };
  c.judge = { ...c.judge, enabled: true, baseUrl: endpoint };
  c.decisionLog = { ...c.decisionLog, enabled: true, redactMessages: false, logAnswerText: true, dirPath: join(dir, 'decisions') };
  c.budget = { ...c.budget, ledgerPath: join(dir, 'budget.json') };
  const configPath = join(dir, 'router.json'); await writeFile(configPath, JSON.stringify(c));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/analysis-server.mjs', import.meta.url))], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CONFIG_PATH: configPath,
      ANALYSIS_PORT: '0', ANALYSIS_HOST: '127.0.0.1', ANALYSIS_ACCESS_KEY: key, ANALYSIS_ALLOW_HISTORY: 'false',
      ANALYSIS_ALLOWED_MODEL_IDS: undefined, ANALYSIS_TIMEOUT_MS: '5000', ANALYSIS_RPM: '120', ANALYSIS_BURST: '30',
      AMR_GO_NATIVE_FRONT: '1', AMR_GO_EDGE_ENABLED: '1', ADMIN_TOKEN: '',
      UPSTREAM_BASE_URL: endpoint, UPSTREAM_API_KEY: 'fixture-upstream-secret',
      AMR_NATIVE_RECEIPTS_DIR: join(dir, 'receipts'), AMR_COUNTERS_PATH: join(dir, 'counters.json') } });
  let output = '', errors = ''; child.stdout.on('data', x => { output += x; }); child.stderr.on('data', x => { errors += x; });
  try {
    let started;
    for (let i = 0; i < 100; i++) {
      started = output.split('\n').filter(Boolean).map(s => { try { return JSON.parse(s); } catch { return {}; } }).find(e => e.event === 'analysis_started');
      if (started) break;
      if (child.exitCode !== null) throw new Error(`analysis startup failed: ${errors}`);
      await sleep(50);
    }
    assert.ok(started, errors);
    const marker = 'SYNTHETIC_SECRET_PROMPT';
    const response = await fetch(`http://127.0.0.1:${started.port}/v1/decide`, { method: 'POST', headers: {
      authorization: `Bearer ${key}`, 'content-type': 'application/json'
    }, body: JSON.stringify({ messages: [{ role: 'user', content: marker + ' 写一段代码' }] }) });
    assert.equal(response.status, 200); await response.arrayBuffer();
    await sleep(150);
    assert.equal(upstreamCalls, 0);
    assert.ok(!output.includes(marker)); assert.ok(!errors.includes(marker)); assert.ok(!output.includes(key));
    assert.match(output, /analysis_request/);
    assert.deepEqual(await readdir(dir), ['router.json']);
  } finally {
    if (child.exitCode === null) { const closed = once(child, 'close'); child.kill(); await closed; }
    upstream.closeAllConnections(); await new Promise(r => upstream.close(r));
    await rm(dir, { recursive: true, force: true });
  }
});
