// Exploratory M4 comparison: real Node server vs managed Go + Node adapter.
// Every upstream endpoint and credential is an isolated, generated fixture.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir, cpus, platform, release, totalmem } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
assert.ok(arg('--binary'), '--binary required');
const binary = resolve(arg('--binary'));
const durationMs = Number(arg('--seconds') ?? 5) * 1000, rounds = Number(arg('--rounds') ?? 3);
const levels = (arg('--concurrency') ?? '1,8,32').split(',').map(Number);
const chunkIntervalMs = Number(arg('--chunk-ms') ?? 200);
assert.ok(durationMs >= 1000 && durationMs <= 60000 && Number.isInteger(rounds) && rounds >= 1 && rounds <= 10);
assert.ok(levels.length <= 6 && levels.every(n => Number.isInteger(n) && n >= 1 && n <= 128));
assert.ok(Number.isInteger(chunkIntervalMs) && chunkIntervalMs >= 40 && chunkIntervalMs <= 1500);
const directory = mkdtempSync(resolve(tmpdir(), 'amr-m4-'));
const secret = () => randomBytes(24).toString('hex');
const access = secret(), admin = secret(), coreAdmin = secret(), upstreamToken = secret(), assessorToken = secret();
const children = [], resourceSamples = [], runs = [], requests = [];
let fixtureCalls = 0, fixtureErrors = 0, resourceTimer;
// Deliberately do not inherit production keys, endpoint overrides, .env or test hooks.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|HOME|USERPROFILE|COMSPEC|LANG|LC_ALL)$/i.test(key)));
Object.assign(env, { AMR_GO_ASSESSOR_TOKEN: assessorToken, GOMAXPROCS: '2', NODE_NO_WARNINGS: '1' });
const sha = value => createHash('sha256').update(value).digest('hex');
function child(command, args, extra = {}) {
  const p = spawn(command, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, ...extra } });
  children.push(p); p.stderr.on('data', () => {}); // No prompts/credentials in subprocess logs.
  p.on('error', e => { p.startError = e; });
  return p;
}
async function ready(p) {
  const lines = createInterface({ input: p.stdout });
  return new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture startup timeout')), 15000);
    p.once('error', e => { clearTimeout(timer); reject(e); });
    p.once('exit', code => { clearTimeout(timer); reject(new Error(`fixture exited ${code}`)); });
    lines.once('line', line => { clearTimeout(timer); try { resolveReady(JSON.parse(line)); } catch { reject(new Error('invalid fixture readiness')); } });
  });
}
async function stop(p) {
  if (p.exitCode !== null || p.signalCode !== null) return;
  await new Promise(done => {
    const timer = setTimeout(() => { p.kill('SIGKILL'); }, 5000);
    p.once('exit', () => { clearTimeout(timer); done(); }); p.kill();
  });
}
const mock = createServer(async (req, res) => {
  try {
    assert.equal(req.headers.authorization, `Bearer ${upstreamToken}`);
    assert.equal(req.url, '/v1/chat/completions'); assert.equal(req.method, 'POST');
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw); fixtureCalls++;
    assert.equal(body.model, fixtureModel);
    const usage = { prompt_tokens: 20, completion_tokens: 10 };
    await sleep(10);
    if (res.destroyed) return;
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (let i = 0; i < 5; i++) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `part-${i};` } }] })}\n\n`);
        await sleep(chunkIntervalMs);
      }
      res.end(`data: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`);
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: body.model, choices: [{ message: { role: 'assistant', content: 'fixture-ok' } }], usage }));
    }
  } catch { fixtureErrors++; if (!res.headersSent) res.writeHead(500); res.end('fixture failure'); }
});
let fixtureModel;
const configPath = resolve(directory, 'router.json'), authPath = resolve(directory, 'auth.json');
const source = JSON.parse(readFileSync(resolve(root, 'config/router.json'), 'utf8'));
source.semanticRouter.enabled = false;
source.judge = { ...source.judge, enabled: false, taskCheckEnabled: false, guardStatePath: resolve(directory, 'judge.json') };
source.rateLimit = { ...source.rateLimit, enabled: false };
source.feedbackLog = { enabled: false, dirPath: resolve(directory, 'feedback') };
source.decisionLog = { ...source.decisionLog, enabled: true, dirPath: resolve(directory, 'decisions'), includePrompt: false };
source.routing.mode = 'active'; source.routing.activeTrafficPercent = 100; source.routing.maxAttempts = 1;
source.routing.requestTimeoutMs = 10000; source.routing.taskPreferences = {};
source.routing.latencyObservation = { ...source.routing.latencyObservation, mode: 'off', probes: { enabled: false } };
source.models = source.models.filter(m => m.enabled).slice(0, 1); assert.equal(source.models.length, 1);
fixtureModel = source.models[0].id;
source.routing.shadowModel = fixtureModel; source.routing.defaultExplicitModel = fixtureModel;
for (const m of source.models) {
  m.quality = Object.fromEntries(Object.keys(m.quality).map(k => [k, .95])); m.quality.default = .95;
  m.benchmarkScores = null; m.minimumCompletionTokensForReliableAnswer = 0;
  m.pricingYuanPerMillionTokens = { input: 1, output: 2 }; m.contextWindow = 128000;
}
source.routing.loadBalancing = { enabled: true, penaltyWeight: .2, limits: { [fixtureModel]: 256 } };
source.budget = { ...source.budget, enabled: true, dailyBudgetYuan: 10000, cacheHitRatio: 0, ledgerPath: resolve(directory, 'node-ledger.json') };

async function sampleResources(pids) {
  if (platform() === 'win32') {
    const sampler = child('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', 'go-core/compat/sample-processes.ps1', '-ProcessIds', pids.join(',')]);
    const lines = createInterface({ input: sampler.stdout });
    lines.on('line', line => { try { resourceSamples.push(JSON.parse(line)); } catch {} });
    for (let i = 0; i < 50 && !resourceSamples.length; i++) await sleep(100);
    assert.ok(resourceSamples.length, 'Windows resource sampler unavailable');
  } else if (platform() === 'linux') {
    const ticks = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim());
    const sample = () => {
      const processes = pids.map(id => {
        const stat = readFileSync(`/proc/${id}/stat`, 'utf8').split(') ')[1].split(' ');
        const status = readFileSync(`/proc/${id}/status`, 'utf8');
        return { id, cpuMs: (Number(stat[11]) + Number(stat[12])) * 1000 / ticks, rssBytes: Number(status.match(/^VmRSS:\s+(\d+)/m)[1]) * 1024 };
      });
      resourceSamples.push({ at: Date.now(), processes });
    };
    sample(); resourceTimer = setInterval(sample, 200);
  }
}
const percentile = (values, q) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.ceil(sorted.length * q) - 1] : null; };
function resources(pids, start, end) {
  const frames = resourceSamples.filter(s => s.at >= start && s.at <= end);
  if (frames.length < 2) return null;
  const sum = (frame, field) => frame.processes.filter(p => pids.includes(p.id)).reduce((a, p) => a + p[field], 0);
  return { sampledMs: frames.at(-1).at - frames[0].at, cpuMs: sum(frames.at(-1), 'cpuMs') - sum(frames[0], 'cpuMs'), peakSampledRssBytes: Math.max(...frames.map(s => sum(s, 'rssBytes'))), sampleCount: frames.length };
}
async function send(base, stream, target, run) {
  const start = performance.now(); let firstByteMs = null, status = null, text = '', ok = false;
  try {
    const res = await fetch(base + '/v1/chat/completions', {
      method: 'POST', signal: AbortSignal.timeout(12000), headers: { authorization: `Bearer ${target === 'direct' ? upstreamToken : access}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: target === 'direct' ? fixtureModel : (source.routing.autoModelId || 'auto'), messages: [{ role: 'user', content: '请提取数字42。' }], max_tokens: 128, stream }),
    });
    status = res.status; const decoder = new TextDecoder();
    for await (const chunk of res.body) { if (firstByteMs === null) firstByteMs = performance.now() - start; text += decoder.decode(chunk, { stream: true }); }
    text += decoder.decode();
    if (status === 200 && stream) {
      const events = text.split(/\r?\n\r?\n/).map(e => e.trim()).filter(e => e.startsWith('data:')).map(e => e.slice(5).trim());
      const done = events.filter(e => e === '[DONE]');
      const content = events.filter(e => e !== '[DONE]').map(e => JSON.parse(e)).map(e => e.choices?.[0]?.delta?.content || '').join('');
      ok = done.length === 1 && events.at(-1) === '[DONE]' && content === 'part-0;part-1;part-2;part-3;part-4;' && firstByteMs < performance.now() - start - 40;
    } else if (status === 200) { const body = JSON.parse(text); ok = body.model === fixtureModel && body.choices?.[0]?.message?.content === 'fixture-ok'; }
  } catch { /* Preserve a failed observation; never silently remove it. */ }
  const sample = { target, run, stream, status, ok, firstByteMs, durationMs: performance.now() - start };
  requests.push(sample); return sample;
}
try {
  await new Promise(done => mock.listen(0, '127.0.0.1', done));
  const upstreamBase = `http://127.0.0.1:${mock.address().port}/v1`; source.upstreamBaseUrl = upstreamBase;
  writeFileSync(configPath, JSON.stringify(source)); writeFileSync(authPath, JSON.stringify({ mode: 'strict', accessToken: access, adminToken: coreAdmin, upstreamToken }));
  const adapter = child(process.execPath, ['go-core/compat/assessor.mjs', '--lab', '--config', configPath, '--port', '0']);
  const adapterReady = await ready(adapter);
  const go = child(binary, ['--lab', '--runtime', '--auth-config', authPath, '--ledger', resolve(directory, 'go.wal'), '--listen', '127.0.0.1:0', '--assessor', `http://127.0.0.1:${adapterReady.port}/assess`, '--upstream', upstreamBase + '/chat/completions']);
  const goReady = await ready(go), goBase = `http://${goReady.listen}`;
  const portHolder = createServer(); await new Promise(done => portHolder.listen(0, '127.0.0.1', done));
  const nodePort = portHolder.address().port; await new Promise(done => portHolder.close(done));
  const node = child(process.execPath, ['src/server.mjs'], {
    CONFIG_PATH: configPath, PORT: String(nodePort), HOST: '127.0.0.1', ROUTER_KEY_MODE: 'strict', ROUTER_ACCESS_KEY: access,
    ADMIN_TOKEN: admin, UPSTREAM_API_KEY: upstreamToken, UPSTREAM_BASE_URL: upstreamBase,
    AMR_COUNTERS_PATH: resolve(directory, 'counters.json'), AMR_GO_ADMIN_URL: goBase, AMR_GO_ADMIN_TOKEN: coreAdmin,
  });
  node.stdout.resume(); const nodeBase = `http://127.0.0.1:${nodePort}`;
  let healthy = false;
  for (let i = 0; i < 100; i++) {
    if (node.startError || node.exitCode !== null) throw new Error('Node fixture startup failed');
    try { const r = await fetch(nodeBase + '/health', { signal: AbortSignal.timeout(500) }); await r.arrayBuffer(); if (r.ok) { healthy = true; break; } } catch {}
    await sleep(100);
  }
  assert.ok(healthy, 'Node fixture not healthy');
  if (arg('--ui-python')) {
    execFileSync(arg('--ui-python'), ['go-core/compat/check-admin-ui.py', nodeBase, resolve(root, 'data/go-migration/ui')], {
      cwd: root, windowsHide: true, env: { ...env, AMR_UI_ADMIN_TOKEN: admin }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000,
    });
  }
  // Exercise the actual authenticated management routes and stale/invalid revisions.
  let res = await fetch(nodeBase + '/admin/api/go-core'); assert.equal(res.status, 401); await res.arrayBuffer();
  res = await fetch(nodeBase + '/admin/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: admin }) });
  assert.equal(res.status, 200); const cookie = res.headers.get('set-cookie').split(';')[0]; await res.arrayBuffer();
  const controlHeaders = { cookie };
  res = await fetch(nodeBase + '/admin/api/go-core', { headers: controlHeaders }); assert.equal(res.status, 200);
  const initial = await res.json(); assert.equal(initial.synchronized, true);
  res = await fetch(nodeBase + '/admin/api/go-core/reload', { method: 'POST', headers: controlHeaders }); assert.equal(res.status, 428); await res.arrayBuffer();
  res = await fetch(nodeBase + '/admin/api/config', { headers: controlHeaders }); const savedRevision = res.headers.get('etag'); const next = await res.json();
  next.routing.costWeight += .001;
  res = await fetch(nodeBase + '/admin/api/config', { method: 'PUT', headers: { ...controlHeaders, 'if-match': savedRevision, 'content-type': 'application/json' }, body: JSON.stringify(next) }); assert.equal(res.status, 200); await res.arrayBuffer();
  res = await fetch(nodeBase + '/admin/api/go-core', { headers: controlHeaders }); assert.equal((await res.json()).synchronized, false);
  res = await fetch(nodeBase + '/admin/api/go-core/reload', { method: 'POST', headers: { ...controlHeaders, 'if-match': initial.revision } }); assert.equal(res.status, 200); await res.arrayBuffer();
  res = await fetch(nodeBase + '/admin/api/go-core', { headers: controlHeaders }); const published = await res.json(); assert.equal(published.synchronized, true);
  res = await fetch(nodeBase + '/admin/api/go-core/reload', { method: 'POST', headers: { ...controlHeaders, 'if-match': initial.revision } }); assert.equal(res.status, 409); await res.arrayBuffer();
  const saved = readFileSync(configPath); writeFileSync(configPath, '{invalid');
  res = await fetch(nodeBase + '/admin/api/go-core/reload', { method: 'POST', headers: { ...controlHeaders, 'if-match': published.revision } }); assert.equal(res.status, 422); await res.arrayBuffer(); writeFileSync(configPath, saved);
  res = await fetch(nodeBase + '/admin/api/go-core', { headers: controlHeaders }); assert.deepEqual(await res.json(), published);
  // Direct baseline includes the same client/mock network path, without gateway work.
  const targets = { direct: { base: `http://127.0.0.1:${mock.address().port}`, pids: [] }, node: { base: nodeBase, pids: [node.pid] }, go: { base: goBase, pids: [go.pid, adapter.pid] } };
  await sampleResources([node.pid, go.pid, adapter.pid, process.pid]);
  for (const [target, t] of Object.entries(targets)) for (let i = 0; i < 5; i++) assert.ok((await send(t.base, i % 2 === 0, target, 'warmup')).ok);
  for (const stream of [false, true]) for (const concurrency of levels) for (let round = 0; round < rounds; round++) {
    // Rotate all three orders across rounds to limit systematic thermal bias.
    const order = ['direct', 'node', 'go'];
    for (const target of [...order.slice(round % 3), ...order.slice(0, round % 3)]) {
      const t = targets[target], id = `${stream ? 'sse' : 'json'}-c${concurrency}-r${round}-${target}`;
      const start = Date.now(), from = requests.length, until = performance.now() + durationMs, callsBefore = fixtureCalls;
      await Promise.all(Array.from({ length: concurrency }, async () => { do { await send(t.base, stream, target, id); } while (performance.now() < until); }));
      const end = Date.now(), samples = requests.slice(from), good = samples.filter(s => s.ok);
      const run = { id, target, stream, concurrency, round, start, end, elapsedMs: end - start, requests: samples.length, successes: good.length, errors: samples.length - good.length,
        upstreamCalls: fixtureCalls - callsBefore, deliveredRps: good.length * 1000 / (end - start),
        p95Ms: percentile(good.map(s => s.durationMs), .95), p99Ms: percentile(good.map(s => s.durationMs), .99),
        firstByteP95Ms: percentile(good.map(s => s.firstByteMs), .95), resources: t.pids.length ? resources(t.pids, start, end) : null, loadGeneratorAndMock: resources([process.pid], start, end) };
      runs.push(run); console.log(JSON.stringify(run));
      assert.equal(run.errors, 0, `${id}: incomplete/error responses`); assert.equal(run.upstreamCalls, run.requests, `${id}: duplicate or missing upstream calls`);
    }
  }
  assert.equal(fixtureErrors, 0);
  const report = {
    schemaVersion: 1, milestone: 'm4-exploratory', at: new Date().toISOString(), productionReady: false, acceptance: 'not evaluated: production load and SLO are not specified',
    environment: { platform: platform(), release: release(), cpu: cpus()[0].model, logicalCpus: cpus().length, memoryBytes: totalmem(), node: process.version,
      goMaxProcs: 2, hardCpuMemoryQuota: false, topology: 'same host; only one gateway receives measured traffic at a time; Go includes Node adapter; client and mock share harness process' },
    processRoles: { nodeServer: node.pid, goRuntime: go.pid, nodeAdapter: adapter.pid, harness: process.pid },
    fixture: { model: fixtureModel, semanticReview: false, retryAttempts: 1, modelConcurrency: 256, mockInitialDelayMs: 10, sseChunks: 5, sseChunkIntervalMs: chunkIntervalMs,
      billing: 'Node async JSON ledger + decision log; Go fsync WAL + fsync audit; persistence contracts differ', configRevision: published.savedConfigRevision },
    management: { cookieAuth: true, unauthorizedRejected: true, savedVsActiveVisible: true, hotReload: true, staleRejected: true, invalidPreservesActive: true },
    limitations: ['Synthetic single-model corpus is not business-quality validation.', 'Closed-loop load; does not measure open-loop queueing or maximum sustainable capacity.', 'No enforced common CPU/memory quota; no production SLO or performance superiority claim.', 'Finite five-chunk SSE is not a long-lived production stream.', 'Direct baseline is interleaved, not per-request paired; subtracting its P95 does not yield the P95 of gateway-added latency.', 'Resource samples are 200 ms snapshots; peak RSS is a sampled lower bound.', 'Go resource group is only its request path (Go + adapter); excludes the idle Node administration server. It is not total deployment resource usage.'],
    binarySha256: sha(readFileSync(binary)), nodeServerSha256: sha(readFileSync(resolve(root, 'src/server.mjs'))), runs, requests, resourceSamples,
  };
  const out = resolve(arg('--out') || resolve(root, 'data/go-migration/gateway-comparison.json'));
  mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ report: out, runs: runs.length, requests: requests.length, fixtureCalls, management: report.management }));
} catch (error) {
  const failure = resolve(arg('--out') || resolve(root, 'data/go-migration/gateway-comparison.json')) + '.failure.json';
  mkdirSync(dirname(failure), { recursive: true });
  writeFileSync(failure, JSON.stringify({ at: new Date().toISOString(), failed: true, error: error.message, runs, requests, resourceSamples }, null, 2));
  throw error;
} finally {
  clearInterval(resourceTimer);
  for (const p of children.reverse()) await stop(p);
  mock.closeAllConnections(); await new Promise(done => mock.close(done));
  // directory is created by mkdtemp above, never supplied by the caller.
  rmSync(directory, { recursive: true, force: true });
}
