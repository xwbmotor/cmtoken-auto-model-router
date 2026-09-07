import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '..');
const metric = (text, name) => Number(text.match(new RegExp(`^${name} ([0-9.]+)$`, 'm'))?.[1] || 0);
const normal = res => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({
  choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 5 }
})); };

async function harness(handler, configure = () => {}) {
  const dataRoot = resolve(root, 'data');
  const dataDir = await mkdtemp(join(dataRoot, 'execution-contract-'));
  const upstream = http.createServer(async (req, res) => {
    if (req.url.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); return; }
    let raw = ''; for await (const part of req) raw += part;
    try { await handler(req, res, JSON.parse(raw)); } catch { res.destroy(); }
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
  const cfg = JSON.parse(await readFile(join(root, 'config/router.json'), 'utf8'));
  cfg.upstreamBaseUrl = upstreamUrl;
  Object.assign(cfg.routing, { mode: 'active', activeTrafficPercent: 100, allowExplicitModel: true,
    requestTimeoutMs: 3000, maxAttempts: 3, circuitBreakerFailures: 3, circuitBreakerCooldownMs: 30000,
    qualityFloor: 0.1, relQualityCap: 1, taskPreferences: {} });
  cfg.semanticRouter.enabled = false; cfg.judge.enabled = false; cfg.rateLimit.enabled = false;
  cfg.calibration.enabled = false;
  cfg.decisionLog = { ...cfg.decisionLog, enabled: true, dirPath: join(dataDir, 'decisions'), redactMessages: true, logAnswerText: false };
  cfg.feedbackLog = { enabled: false, dirPath: join(dataDir, 'feedback') };
  cfg.budget = { ...cfg.budget, enabled: false, ledgerPath: join(dataDir, 'budget.json') };
  configure(cfg);
  const configPath = join(dataDir, 'router.json');
  await writeFile(configPath, JSON.stringify(cfg));
  const holder = net.createServer();
  await new Promise(r => holder.listen(0, '127.0.0.1', r));
  const port = holder.address().port;
  await new Promise(r => holder.close(r));
  const child = spawn(process.execPath, ['src/server.mjs'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), CONFIG_PATH: configPath,
      ROUTER_KEY_MODE: 'passthrough', UPSTREAM_BASE_URL: upstreamUrl, MAAS_BASE_URL: upstreamUrl,
      UPSTREAM_API_KEY: 'fixture', MAAS_API_KEY: 'fixture', ADMIN_TOKEN: 'fixture-admin', METRICS_TOKEN: 'fixture-metrics',
      AMR_COUNTERS_PATH: join(dataDir, 'counters.json') } });
  let output = ''; child.stdout.on('data', c => { output += c; }); child.stderr.on('data', c => { output += c; });
  const close = async () => {
    if (child.exitCode === null) { const closed = once(child, 'close'); child.kill(); await closed; }
    upstream.closeAllConnections(); await new Promise(r => upstream.close(r));
    assert.ok(resolve(dataDir).startsWith(dataRoot + sep));
    await rm(dataDir, { recursive: true, force: true });
  };
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/health')).ok) break; } catch { /* startup */ }
    if (i === 99 || child.exitCode !== null) { await close(); throw new Error(`fixture failed: ${output.slice(-1500)}`); }
    await sleep(50);
  }
  return { cfg, close,
    post: (body = {}, credential = 'good') => fetch(base + '/v1/chat/completions', {
      method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }], ...body }) }),
    metrics: async () => (await fetch(base + '/metrics', { headers: { authorization: 'Bearer fixture-metrics' } })).text(),
    records: async () => {
      await sleep(80);
      const files = (await readdir(join(dataDir, 'decisions'))).filter(f => f.startsWith('decisions-') && f.endsWith('.jsonl'));
      return (await Promise.all(files.map(f => readFile(join(dataDir, 'decisions', f), 'utf8')))).join('\n').split('\n').filter(Boolean).map(JSON.parse);
    }
  };
}

test('e2e local capacity bounds concurrent calls, preserves quality gate, and releases after completion', { timeout: 20000 }, async () => {
  let release; let arrived; let calls = 0;
  const arrival = new Promise(r => { arrived = r; });
  const h = await harness(async (_req, res, body) => {
    calls++;
    if (body.messages[0].content === 'hold') { arrived(); await new Promise(r => { release = r; }); }
    normal(res);
  }, cfg => {
    cfg.models = cfg.models.slice(0, 2);
    cfg.routing.maxAttempts = 2;
    cfg.routing.defaultExplicitModel = cfg.models[0].id; cfg.routing.shadowModel = cfg.models[0].id;
    cfg.routing.loadBalancing = { enabled: true, limits: Object.fromEntries(cfg.models.map(m => [m.id, 1])) };
    cfg.routing.qualityFloor = 0.8; cfg.routing.relQualityCap = 0.02;
    cfg.models[0].quality = { default: 0.95 }; cfg.models[1].quality = { default: 0.5 };
  });
  try {
    const model = h.cfg.models[0].id;
    const pending = h.post({ model, messages: [{ role: 'user', content: 'hold' }] });
    await arrival;
    assert.match(await h.metrics(), new RegExp(`router_model_inflight\\{model="${model}"\\} 1`));
    const blocked = await h.post({ model }); await blocked.text(); assert.equal(blocked.status, 503);
    const auto = await h.post(); await auto.text(); assert.equal(auto.status, 503, 'must not admit a lower quality model merely because the best is busy');
    assert.equal(calls, 1);
    release(); const first = await pending; await first.text();
    const next = await h.post({ model }); await next.text(); assert.equal(next.status, 200);
    assert.match(await h.metrics(), new RegExp(`router_model_inflight\\{model="${model}"\\} 0`));
  } finally { release?.(); await h.close(); }
});

test('e2e explicit thinking intent is respected under a small completion budget', { timeout: 20000 }, async () => {
  const seen = [];
  const h = await harness((_req, res, body) => { seen.push(body); normal(res); }, cfg => {
    const model = cfg.models[0];
    model.minimumCompletionTokensForReliableAnswer = 16384;
    model.reasoningControl = { verified: true, parameter: 'chat_template_kwargs.enable_thinking', values: { off: false, standard: true, high: true } };
    cfg.reasoningControl = { enabled: true, offMaxComplexity: 0.3, highMinComplexity: 0.78 };
  });
  try {
    const model = h.cfg.models[0].id;
    const blocked = await h.post({ model, max_tokens: 64, chat_template_kwargs: { enable_thinking: true } });
    assert.equal(blocked.status, 400); assert.equal((await blocked.json()).error.type, 'completion_budget_too_low');
    assert.equal(seen.length, 0);
    const ok = await h.post({ model, max_tokens: 64, chat_template_kwargs: { enable_thinking: false, extra: 'keep' } });
    assert.equal(ok.status, 200); await ok.text();
    assert.deepEqual(seen[0].chat_template_kwargs, { enable_thinking: false, extra: 'keep' });
  } finally { await h.close(); }
});

test('e2e auto uses another qualified model while the first is occupied', { timeout: 20000 }, async () => {
  let release; let arrived;
  const arrival = new Promise(r => { arrived = r; });
  const calls = [];
  const h = await harness(async (_req, res, body) => {
    calls.push(body.model);
    if (body.messages[0].content === 'hold') { arrived(); await new Promise(r => { release = r; }); }
    normal(res);
  }, cfg => {
    cfg.models = cfg.models.slice(0, 2);
    cfg.routing.maxAttempts = 2;
    cfg.routing.defaultExplicitModel = cfg.models[0].id; cfg.routing.shadowModel = cfg.models[0].id;
    for (const m of cfg.models) m.quality = { default: 0.95 };
    cfg.routing.loadBalancing = { enabled: true, limits: Object.fromEntries(cfg.models.map(m => [m.id, 1])) };
  });
  try {
    const pending = h.post({ model: h.cfg.models[0].id, messages: [{ role: 'user', content: 'hold' }] });
    await arrival;
    const next = await h.post(); await next.text(); assert.equal(next.status, 200);
    assert.equal(calls[1], h.cfg.models[1].id);
    release(); await (await pending).text();
  } finally { release?.(); await h.close(); }
});

test('e2e failed calls release capacity without leaking a slot', { timeout: 20000 }, async () => {
  let calls = 0;
  const h = await harness((_req, res) => { calls++; res.writeHead(401); res.end('{}'); }, cfg => {
    cfg.routing.loadBalancing = { enabled: true, limits: { [cfg.models[0].id]: 1 } };
  });
  try {
    for (let i = 0; i < 3; i++) {
      const response = await h.post({ model: h.cfg.models[0].id }); await response.text();
      assert.equal(response.status, 401);
    }
    assert.equal(calls, 3);
    assert.match(await h.metrics(), new RegExp(`router_model_inflight\\{model="${h.cfg.models[0].id}"\\} 0`));
  } finally { await h.close(); }
});

test('e2e tenant failures preserve 4xx and never open another tenant\'s model circuit', { timeout: 20000 }, async () => {
  let calls = 0;
  const h = await harness((req, res) => {
    calls++;
    if (req.headers.authorization === 'Bearer truncated') {
      res.writeHead(401, { 'content-type': 'application/json', 'content-length': '1000' });
      res.flushHeaders(); res.write('{'); setTimeout(() => res.destroy(), 80); return;
    }
    const status = Number(req.headers.authorization.split(' ').at(-1));
    if (status >= 400) { res.writeHead(status, { 'content-type': 'application/json' }); res.end('{"error":{"message":"fixture rejection"}}'); }
    else normal(res);
  });
  try {
    for (const credential of [401, 401, 401, 403, 402, 429, 400, 'truncated']) {
      const status = credential === 'truncated' ? 401 : credential;
      const before = calls;
      const response = await h.post({}, String(credential)); await response.text();
      assert.equal(response.status, status);
      assert.equal(calls, before + 1, 'tenant rejection must not retry another model');
    }
    const response = await h.post(); assert.equal(response.status, 200); await response.text();
    const metrics = await h.metrics();
    assert.doesNotMatch(metrics, /router_circuit_state\{[^\n]+\} [12]/);
    const records = await h.records();
    assert.equal(records.length, 9);
    assert.equal(records[0].outcome.failureScope, 'credential');
    assert.equal(records[0].outcome.attempts.length, 1);
    assert.equal(records.at(-1).outcome.taskSuccess, null);
    assert.match(records.at(-1).decision.policyRevision, /^"[a-f0-9]{64}"$/);
  } finally { await h.close(); }
});

test('e2e provider failures still open the circuit; budget is reserved before response headers', { timeout: 20000 }, async () => {
  let release; let arrived; let calls = 0;
  const arrival = new Promise(r => { arrived = r; });
  const h = await harness(async (_req, res, body) => {
    calls++;
    if (body.messages[0].content === 'hold') { arrived(); await new Promise(r => { release = r; }); normal(res); return; }
    res.writeHead(503); res.end('unavailable');
  });
  try {
    const model = h.cfg.models.find(m => m.enabled).id;
    const pending = h.post({ model, messages: [{ role: 'user', content: 'hold' }] });
    await arrival;
    assert.equal(metric(await h.metrics(), 'router_budget_pending_reserves'), 1);
    release(); const ok = await pending; await ok.text(); assert.equal(ok.status, 200);
    for (let i = 0; i < 3; i++) { const response = await h.post({ model }); await response.text(); assert.equal(response.status, 502); }
    const before = calls;
    const rejected = await h.post({ model }); await rejected.text(); assert.equal(rejected.status, 502);
    assert.equal(calls, before, 'open circuit must reject upstream attempt');
    assert.match(await h.metrics(), /router_circuit_state\{[^\n]+\} 2/);
  } finally { release?.(); await h.close(); }
});

test('e2e content TTFT excludes role headers, tool-only and nonstream, with completion recorded at delivery', { timeout: 20000 }, async () => {
  const h = await harness(async (_req, res, body) => {
    if (!body.stream) { await sleep(80); normal(res); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders();
    res.write('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n');
    await sleep(100);
    if (body.messages[0].content === 'tools') res.write('data: {"choices":[{"delta":{"tool_calls":[{"id":"call_1","function":{"name":"search","arguments":"{}"}}]}}]}\n\n');
    else {
      res.write('data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n');
      await sleep(150); res.write('data: {"choices":[{"delta":{"content":"answer"}}]}\n\n');
    }
    await sleep(150); res.end('data: {"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\ndata: [DONE]\n\n');
  });
  try {
    const stream = await h.post({ stream: true }); await stream.text();
    let m = await h.metrics(); assert.equal(metric(m, 'router_ttft_ms_count'), 1);
    const normalResponse = await h.post(); await normalResponse.text();
    const tool = await h.post({ stream: true, messages: [{ role: 'user', content: 'tools' }] }); await tool.text();
    m = await h.metrics();
    assert.equal(metric(m, 'router_ttft_ms_count'), 1);
    assert.equal(metric(m, 'router_first_output_ms_count'), 2);
    assert.equal(metric(m, 'router_completion_ms_count'), 3);
    const rows = await h.records();
    const first = rows[0].outcome;
    assert.ok(first.ttftMs >= 220, JSON.stringify(first));
    assert.ok(first.responseHeaderLatencyMs < first.ttftMs);
    assert.ok(first.completionLatencyMs >= first.ttftMs + 100);
    assert.equal(rows[1].outcome.ttftMs, null);
    assert.equal(rows[2].outcome.ttftMs, null);
    assert.equal(first.totalAttemptCostKind, 'actual');
  } finally { await h.close(); }
});

test('e2e explicit and shadow selections cannot bypass full context capacity', { timeout: 20000 }, async () => {
  let calls = 0;
  const h = await harness((_req, res) => { calls++; normal(res); }, cfg => {
    cfg.routing.mode = 'shadow';
    const short = cfg.models.find(m => m.enabled);
    short.contextWindow = 128; cfg.routing.shadowModel = short.id;
  });
  try {
    const short = h.cfg.routing.shadowModel;
    const explicit = await h.post({ model: short });
    assert.equal(explicit.status, 400); assert.equal((await explicit.json()).error.type, 'context_length_exceeded');
    assert.equal(calls, 0, 'invalid explicit model must not reach upstream');
    const shadow = await h.post(); assert.equal(shadow.status, 200);
    assert.notEqual(shadow.headers.get('x-router-selected-model'), short); await shadow.text();
    const rows = await h.records();
    assert.equal(rows[0].decision.rollout.safetyOverride, 'configured_shadow_model_not_eligible');
    assert.ok(rows[0].decision.analysis.estimatedContextTokens > 128);
  } finally { await h.close(); }
});
