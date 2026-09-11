// Docker/cgroup v2 capacity experiment. Creates and removes only its own labeled
// containers. The staging tree contains source and synthetic config, never .env.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { validateConfig } from '../../src/config.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, chmodSync } from 'node:fs';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
assert.ok(arg('--binary'), '--binary <Linux binary> required');
const seconds = Number(arg('--seconds') ?? 10), rounds = Number(arg('--rounds') ?? 3), streamSeconds = Number(arg('--stream-seconds') ?? 60);
const cpus = Number(arg('--cpus') ?? 1), memoryMiB = Number(arg('--memory-mib') ?? 512), streams = Number(arg('--streams') ?? 32);
const rates = (arg('--rates') ?? '50,150,300').split(',').map(Number);
const profiling = process.argv.includes('--profile');
// The cgroup enforces CPU throughput. Do not add a one-P scheduler restriction
// that suppresses Go's container-aware minimum parallelism during blocking I/O.
const goProcs = arg('--go-procs') ?? 'auto';
const featureMode = arg('--feature-mode') ?? 'bootstrap';
assert.ok(['bootstrap','snapshot'].includes(featureMode), 'invalid --feature-mode');
const nodeCostObservation = process.argv.includes('--node-cost-observation');
const relayNagle = process.argv.includes('--relay-nagle');
const isolatedHost = process.argv.includes('--isolated-host');
const budgetMode = arg('--budget-mode') ?? 'protection', nativeFront = process.argv.includes('--native-front'), edge = nativeFront || process.argv.includes('--edge');
assert.ok(['protection', 'observation'].includes(budgetMode), 'invalid --budget-mode');
assert.ok(!nodeCostObservation || (edge && budgetMode === 'observation'), 'Node cost observation requires edge and disabled budget');
assert.ok((!edge && budgetMode !== 'observation') || featureMode === 'snapshot', 'edge/observation requires --feature-mode snapshot');
assert.ok(goProcs === 'auto' || (/^[1-9]\d*$/.test(goProcs) && Number(goProcs) <= 64), 'invalid --go-procs');
assert.ok(Number.isInteger(seconds) && seconds >= 1 && seconds <= 60 && Number.isInteger(rounds) && rounds >= 1 && rounds <= 5);
assert.ok(Number.isInteger(streamSeconds) && streamSeconds >= 2 && streamSeconds <= 600 && Number.isInteger(streams) && streams >= 1 && streams <= 128);
assert.ok(cpus >= .25 && cpus <= 8 && Number.isInteger(memoryMiB) && memoryMiB >= 256 && memoryMiB <= 8192);
assert.ok(rates.length >= 1 && rates.length <= 5 && rates.every(n => Number.isInteger(n) && n > 0 && n <= 2000));
const runKey = 'm4-' + randomBytes(6).toString('hex'), dataRoot = resolve(root, 'data/go-migration');
const stage = resolve(dataRoot, runKey), out = resolve(arg('--out') || resolve(dataRoot, `${runKey}.json`));
const binary = resolve(arg('--binary')), image = arg('--image') || 'node:24-bookworm-slim';
const secret = () => randomBytes(24).toString('hex');
const credentials = { M4_ACCESS: secret(), M4_ADMIN: secret(), M4_CORE_ADMIN: secret(), M4_UPSTREAM: secret(), M4_ASSESSOR: secret(), M4_CONTROL_TOKEN: secret(), M4_EDGE_TOKEN: secret() };
const containers = [], requests = [], runs = [];
let sourceHash, imageEvidence, hostPorts, engine, quotas, preflight, longStreams, failure, goRuntime, decisionEvidence;
const docker = args => execFileSync('docker', args, { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const percentile = (values, q) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.ceil(sorted.length * q) - 1] : null; };
const model = 'm4-fixture-model';
function config(role) {
  const c = JSON.parse(readFileSync(resolve(root, 'config/router.json'), 'utf8')), dir = `/lab/${role}`;
  c.upstreamBaseUrl = 'http://127.0.0.1:8790/v1'; c.semanticRouter.enabled = false;
  c.semanticRouter.model = model;
  if (c.semanticRouter.openaiChat) c.semanticRouter.openaiChat.model = model;
  c.judge = { ...c.judge, enabled: false, taskCheckEnabled: false, guardStatePath: `${dir}/judge.json` };
  c.rateLimit = { ...c.rateLimit, enabled: false }; c.feedbackLog = { enabled: false, dirPath: `${dir}/feedback` };
  c.decisionLog = { ...c.decisionLog, enabled: true, dirPath: `${dir}/decisions`, includePrompt: false };
  c.routing.mode = 'active'; c.routing.activeTrafficPercent = 100; c.routing.maxAttempts = 1;
  c.routing.requestTimeoutMs = Math.max(30000, (streamSeconds + 30) * 1000); c.routing.taskPreferences = {};
  c.routing.latencyObservation = { ...c.routing.latencyObservation, mode: 'off', probes: { enabled: false } };
  c.routing.defaultExplicitModel = model; c.routing.shadowModel = model;
  c.routing.loadBalancing = { enabled: true, penaltyWeight: .2, limits: { [model]: 256 } };
  c.models = c.models.filter(m => m.enabled).slice(0, 1); assert.equal(c.models.length, 1);
  const m = c.models[0]; m.id = model; m.capabilities = { chat: true, stream: true, tools: true, json: true, vision: true };
  m.quality = Object.fromEntries(Object.keys(m.quality).map(k => [k, .95])); m.quality.default = .95;
  m.benchmarkScores = null; m.minimumCompletionTokensForReliableAnswer = 0; m.contextWindow = 131072;
  m.pricingYuanPerMillionTokens = { input: 1, output: 2 };
  c.budget = { ...c.budget, enabled: budgetMode === 'protection', dailyBudgetYuan: budgetMode === 'protection' ? 10000 : 0, cacheHitRatio: 0, ledgerPath: `${dir}/node-ledger.json` };
  c.calibration = { ...c.calibration, enabled: false };
  validateConfig(c); return c;
}
const controlHeaders = { authorization: `Bearer ${credentials.M4_CONTROL_TOKEN}` };
async function control(path) {
  const res = await fetch(`http://127.0.0.1:${hostPorts.control}${path}`, { headers: controlHeaders, signal: AbortSignal.timeout(5000) });
  assert.equal(res.status, 200, 'fixture control unavailable'); return res.json();
}
const shapes = (arg('--shapes') || 'short,history,tools,image').split(',');
assert.ok(shapes.length >= 1 && new Set(shapes).size === shapes.length && shapes.every(s => ['short', 'history', 'tools', 'image'].includes(s)), 'invalid --shapes');
function bodyFor(target, shape, id, stream) {
  const body = { ...(target === 'direct' ? { model } : {}), stream, max_tokens: 128, messages: [{ role: 'system', content: `m4:${id}` }] };
  if (shape === 'history') for (let i = 0; i < 16; i++) body.messages.push({ role: i % 2 ? 'assistant' : 'user', content: '项目需求、约束条件和执行记录。'.repeat(64) });
  if (shape === 'tools') {
    body.tools = [{ type: 'function', function: { name: 'lookup', description: '查询记录', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } }];
    body.messages.push({ role: 'assistant', content: null, tool_calls: [{ id: 'call_fixture', type: 'function', function: { name: 'lookup', arguments: '{"id":"42"}' } }] }, { role: 'tool', tool_call_id: 'call_fixture', content: '{"value":42}' });
  }
  body.messages.push({ role: 'user', content: shape === 'image' ? [{ type: 'text', text: '描述图片中的颜色。' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1sAAAAASUVORK5CYII=' } }] : '请提取并返回数字42。' });
  return body;
}
let sequence = 0;
async function request(target, shape, run, stream = false, due = performance.now()) {
  const id = `${runKey}-${sequence++}`, payload = JSON.stringify(bodyFor(target, shape, id, stream));
  const started = performance.now(), sample = { run, target, shape, stream, id, requestBytes: Buffer.byteLength(payload), schedulerDelayMs: Math.max(0, started - due), status: null, complete: false, firstByteMs: null, serviceMs: null };
  try {
    const response = await fetch(`http://127.0.0.1:${hostPorts[target]}/v1/chat/completions`, { method: 'POST', signal: AbortSignal.timeout((stream ? streamSeconds + 30 : 30) * 1000),
      headers: { authorization: `Bearer ${target === 'direct' ? credentials.M4_UPSTREAM : credentials.M4_ACCESS}`, 'content-type': 'application/json', 'x-request-id': id }, body: payload });
    sample.status = response.status; let text = ''; const decoder = new TextDecoder();
    for await (const chunk of response.body) { if (sample.firstByteMs === null) sample.firstByteMs = performance.now() - started; text += decoder.decode(chunk, { stream: true }); }
    text += decoder.decode();
    if (response.status !== 200) {
      let errorBody = text.slice(0, 2048);
      for (const value of Object.values(credentials)) errorBody = errorBody.split(value).join('[redacted]');
      sample.errorBody = errorBody;
    }
    if (response.status === 200 && stream) {
      const events = text.split(/\r?\n\r?\n/).map(e => e.trim()).filter(e => e.startsWith('data:')).map(e => e.slice(5).trim());
      const parsed = events.filter(e => e !== '[DONE]').map(e => JSON.parse(e));
      const content = parsed.map(e => e.choices?.[0]?.delta?.content || '').join('');
      sample.serviceMs = parsed.find(e => e.fixtureServiceMs != null)?.fixtureServiceMs ?? null;
      sample.complete = events.filter(e => e === '[DONE]').length === 1 && events.at(-1) === '[DONE]' && content === Array.from({ length: streamSeconds }, (_, i) => `part-${i};`).join('') && sample.firstByteMs < performance.now() - started - 1000;
    } else if (response.status === 200) {
      const value = JSON.parse(text); sample.serviceMs = value.fixtureServiceMs ?? null;
      sample.complete = value.model === model && value.choices?.[0]?.message?.content === 'fixture-ok';
    }
  } catch { sample.transportOrContentError = true; }
  sample.durationMs = performance.now() - started;
  sample.clientPathResidualMs = sample.serviceMs == null ? null : sample.durationMs - sample.serviceMs;
  requests.push(sample); return sample;
}
async function measure(target, id, action) {
  const stateBefore = await control('/state'), before = target === 'direct' ? null : await control(`/resources/${target}`), resourceSamples = [];
  let sampling;
  const timer = setInterval(async () => {
    if (sampling || target === 'direct') return;
    sampling = control(`/resources/${target}`).then(value => resourceSamples.push(value)).catch(() => {}).finally(() => { sampling = null; });
  }, 1000);
  const start = Date.now(), from = requests.length;
  let offered;
  try { offered = await action(); } finally { clearInterval(timer); await sampling; }
  const end = Date.now(), samples = requests.slice(from), good = samples.filter(s => s.complete);
  const stateAfter = await control('/state'), after = before ? await control(`/resources/${target}`) : null;
  assert.equal(stateAfter.duplicates, stateBefore.duplicates, 'duplicate upstream generation');
  assert.equal(stateAfter.fixtureErrors, 0, 'fixture violated its input contract');
  assert.ok(stateAfter.calls - stateBefore.calls <= samples.length, 'unexpected upstream call');
  const value = { id, target, ...offered, started: samples.length, complete: good.length, errors: samples.length - good.length,
    statusCounts: Object.fromEntries([...new Set(samples.map(s => String(s.status)))].map(status => [status, samples.filter(s => String(s.status) === status).length])),
    elapsedMs: end - start, deliveredRps: good.length * 1000 / (end - start), p95Ms: percentile(good.map(s => s.durationMs), .95), p99Ms: percentile(good.map(s => s.durationMs), .99),
    firstByteP95Ms: percentile(good.map(s => s.firstByteMs), .95), schedulerDelayP95Ms: percentile(samples.map(s => s.schedulerDelayMs), .95),
    clientPathResidualP95Ms: percentile(good.map(s => s.clientPathResidualMs).filter(n => n != null), .95),
    upstreamCalls: stateAfter.calls - stateBefore.calls, resources: before ? { before, after, resourceSamples,
      averageCpuCores: (after.cpu.usage_usec - before.cpu.usage_usec) / 1000 / (after.at - before.at),
      throttledPeriods: after.cpu.nr_throttled - before.cpu.nr_throttled, throttledMs: (after.cpu.throttled_usec - before.cpu.throttled_usec) / 1000,
      peakSampledMemoryBytes: Math.max(before.memoryBytes, after.memoryBytes, ...resourceSamples.map(s => s.memoryBytes)), oomKills: after.memoryEvents.oom_kill - before.memoryEvents.oom_kill } : null };
  runs.push(value); console.log(JSON.stringify({ ...value, resources: value.resources ? { averageCpuCores: value.resources.averageCpuCores, throttledPeriods: value.resources.throttledPeriods, peakSampledMemoryBytes: value.resources.peakSampledMemoryBytes, oomKills: value.resources.oomKills } : null }));
  return value;
}
try {
  // Validate synthetic model references before allocating any container.
  config('node'); config('go');
  engine = JSON.parse(docker(['info', '--format', '{"os":{{json .OSType}},"version":{{json .ServerVersion}},"cpus":{{.NCPU}},"memoryBytes":{{.MemTotal}}}']));
  assert.equal(engine.os, 'linux', 'Linux Docker engine required');
  if (isolatedHost) {
    assert.ok(engine.cpus >= 4 && cpus <= 1 && memoryMiB === 256, 'isolated host requires four CPUs and bounded 1 CPU / 256 MiB service groups');
    assert.match(readFileSync('/proc/self/status', 'utf8'), /^Cpus_allowed_list:\s*3\s*$/m, 'run the generator under taskset -c 3');
  }
  try { docker(['image', 'inspect', image, '--format', '{{.Id}}']); } catch { docker(['pull', image]); }
  imageEvidence = JSON.parse(docker(['image', 'inspect', image, '--format', '{"id":{{json .Id}},"digests":{{json .RepoDigests}}}']));
  mkdirSync(stage, { recursive: true }); mkdirSync(resolve(stage, 'app/go-core/compat'), { recursive: true });
  cpSync(resolve(root, 'src'), resolve(stage, 'app/src'), { recursive: true });
  cpSync(resolve(root, 'package.json'), resolve(stage, 'app/package.json'));
  for (const name of ['assessor.mjs', 'contract.mjs', 'feature-config.mjs', 'semantic-policy.mjs', 'runtime-policy.mjs', 'capacity-group.mjs', 'capacity-fixture.mjs']) cpSync(resolve(root, 'go-core/compat', name), resolve(stage, 'app/go-core/compat', name));
  cpSync(binary, resolve(stage, 'app/amr-core')); chmodSync(resolve(stage, 'app/amr-core'), 0o755);
  sourceHash = sha(readFileSync(resolve(root, 'src/server.mjs')));
  for (const role of ['node', 'go']) { mkdirSync(resolve(stage, role)); writeFileSync(resolve(stage, role, 'router.json'), JSON.stringify(config(role))); }
  writeFileSync(resolve(stage, 'go/auth.json'), JSON.stringify({ mode: 'strict', accessToken: credentials.M4_ACCESS, adminToken: credentials.M4_CORE_ADMIN, upstreamToken: credentials.M4_UPSTREAM }));
  const envFile = resolve(stage, 'fixture.env'); writeFileSync(envFile, Object.entries({ ...credentials, M4_STREAM_SECONDS: streamSeconds, M4_RELAY_NAGLE: relayNagle ? '1' : '0', M4_PROFILE: profiling ? '1' : '0', M4_FEATURE_MODE:featureMode, M4_EDGE: edge ? '1' : '0', M4_NODE_COST_OBSERVATION: nodeCostObservation ? '1' : '0', M4_NATIVE_FRONT: nativeFront ? '1' : '0', ...(goProcs === 'auto' ? {} : {GOMAXPROCS: goProcs}), NODE_NO_WARNINGS: '1' }).map(([k, v]) => `${k}=${v}`).join('\n'));
  const fixture = `${runKey}-fixture`;
  const mounts = ['--mount', `type=bind,source=${resolve(stage, 'app')},target=/app,readonly`, '--mount', `type=bind,source=${stage},target=/lab`, '--env-file', envFile];
  containers.push(fixture);
  docker(['run', '-d', '--name', fixture, '--label', `amr.capacity=${runKey}`, '--workdir', '/app', ...mounts,
    ...(isolatedHost ? ['--cpuset-cpus', '3', '--cpus', '1', '--cpu-shares', '64', '--memory', '192m', '--memory-swap', '192m', '--pids-limit', '128'] : []),
    ...[8785, 8792, 8784, 8790, 8799].flatMap(port => ['-p', `127.0.0.1::${port}`]), imageEvidence.id, 'node', 'go-core/compat/capacity-fixture.mjs']);
  const portMap = JSON.parse(docker(['inspect', fixture, '--format', '{{json .NetworkSettings.Ports}}']));
  hostPorts = Object.fromEntries(Object.entries({ node: 8785, go: 8792, admin: 8784, direct: 8790, control: 8799 }).map(([name, port]) => [name, Number(portMap[`${port}/tcp`][0].HostPort)]));
  quotas = {};
  for (const role of ['node', 'go']) {
    const name = `${runKey}-${role}`;
    containers.push(name);
    docker(['run', '-d', '--name', name, '--label', `amr.capacity=${runKey}`, '--workdir', '/app', '--network', `container:${fixture}`, '--cpus', String(cpus), '--memory', `${memoryMiB}m`, '--memory-swap', `${memoryMiB}m`, '--pids-limit', '128', ...(isolatedHost ? ['--cpuset-cpus', '2', '--cpu-shares', '64'] : []), ...mounts, '-e', `M4_ROLE=${role}`, imageEvidence.id, 'node', 'go-core/compat/capacity-group.mjs']);
    quotas[role] = JSON.parse(docker(['inspect', name, '--format', '{"nanoCpus":{{.HostConfig.NanoCpus}},"memory":{{.HostConfig.Memory}},"memorySwap":{{.HostConfig.MemorySwap}},"pidsLimit":{{.HostConfig.PidsLimit}},"cpuset":{{json .HostConfig.CpusetCpus}},"cpuShares":{{.HostConfig.CpuShares}}}']));
    assert.equal(quotas[role].nanoCpus, cpus * 1e9); assert.equal(quotas[role].memory, memoryMiB * 1048576); assert.equal(quotas[role].memorySwap, quotas[role].memory);
    if (isolatedHost) { assert.equal(quotas[role].cpuset, '2'); assert.equal(quotas[role].cpuShares, 64); }
  }
  for (const role of ['node', 'go']) {
    let healthy = false;
    for (let i = 0; i < 100; i++) { try { const res = await fetch(`http://127.0.0.1:${hostPorts[role]}/health`, { signal: AbortSignal.timeout(500) }); await res.arrayBuffer(); if (res.ok) { healthy = true; break; } } catch {} await sleep(200); }
    assert.ok(healthy, `${role} container did not become healthy`);
    const sample = await control(`/resources/${role}`); const [quota, period] = sample.cpuLimit.split(' ').map(Number);
    assert.equal(quota / period, cpus); assert.equal(Number(sample.memoryLimit), memoryMiB * 1048576);
  }
  goRuntime = JSON.parse(readFileSync(resolve(stage, 'go/runtime-info.json'), 'utf8'));
  preflight = [];
  for (const target of ['direct', 'node', 'go']) for (const shape of shapes) { const sample = await request(target, shape, 'preflight'); preflight.push(sample); assert.ok(sample.complete, `preflight failed: ${target}/${shape}/${sample.status}`); }
  for (const rate of rates) for (let round = 0; round < rounds; round++) {
    const order = ['direct', 'node', 'go'];
    for (const target of [...order.slice(round % 3), ...order.slice(0, round % 3)]) {
      const id = `${target}-rate${rate}-round${round}`;
      await measure(target, id, async () => {
        const count = seconds * rate, start = performance.now(), pending = new Set(); let droppedByGenerator = 0;
        for (let i = 0; i < count; i++) {
          const due = start + i * 1000 / rate, delay = due - performance.now(); if (delay > 0) await sleep(delay);
          if (pending.size >= 256 || performance.now() - due > 1000) { droppedByGenerator++; continue; }
          const task = request(target, shapes[i % shapes.length], id, false, due); pending.add(task); task.finally(() => pending.delete(task));
        }
        await Promise.all(pending); return { rate, round, plannedSeconds: seconds, offered: count, droppedByGenerator };
      });
    }
  }
  longStreams = [];
  for (const target of ['direct', 'node', 'go']) {
    const result = await measure(target, `${target}-long-sse`, async () => {
      await Promise.all(Array.from({ length: streams }, (_, i) => request(target, shapes[i % shapes.length], `${target}-long-sse`, true)));
      return { streamSeconds, streams, offered: streams, droppedByGenerator: 0 };
    });
    longStreams.push(result); assert.equal(result.errors, 0, 'long SSE integrity failure'); assert.equal(result.upstreamCalls, streams);
  }
  const finalState = await control('/state'); assert.equal(finalState.active, 0); assert.equal(finalState.duplicates, 0); assert.equal(finalState.fixtureErrors, 0);
  if (edge) {
    decisionEvidence = {};
    for (const role of ['node', 'go']) {
      const expected = requests.filter(r => r.target === role && r.complete).map(r => r.id);
      let rows = [];
      for (let i = 0; i < 50; i++) {
        rows = (await control(`/decisions/${role}`)).requestIds;
        const found = new Set(rows);
        if (expected.every(id => found.has(id))) break;
        await sleep(100);
      }
      const counts = new Map(); for (const id of rows) counts.set(id, (counts.get(id) || 0) + 1);
      const missing = expected.filter(id => !counts.has(id)), duplicates = [...counts].filter(([, n]) => n > 1).length;
      decisionEvidence[role] = { successfulRequests: expected.length, records: rows.length, missing: missing.length, duplicates };
      assert.equal(missing.length, 0, `${role}: successful request decision missing`);
      assert.equal(duplicates, 0, `${role}: duplicate decision record`);
    }
  }
  if (profiling) {
    for (const role of ['node', 'go']) {
      assert.equal((await control(`/profile-stop/${role}`)).stopped, true);
      cpSync(resolve(stage, `${role}/node.cpuprofile`), `${out}.${role}-node.cpuprofile`);
    }
    const pid = Number(readFileSync(resolve(stage, 'go/core.pid'), 'utf8'));
    assert.ok(Number.isInteger(pid) && pid > 1);
    // The Go process creates private files as container root. Transfer ownership
    // to the existing bind-mount owner without widening the 0700/0600 modes.
    docker(['exec', `${runKey}-go`, 'node', '--input-type=module', '-e', `
      import {existsSync, readFileSync, statSync, chownSync} from 'node:fs';
      process.kill(Number(process.argv[1]), 'SIGTERM');
      const dir='/lab/go/profile';
      for(let i=0;i<150&&!existsSync(dir+'/complete');i++) await new Promise(r=>setTimeout(r,100));
      if(readFileSync(dir+'/complete','utf8')!=='ok\\n') throw new Error('profile incomplete');
      const {uid,gid}=statSync('/lab/go');
      for(const file of ['cpu.pprof','block.pprof','mutex.pprof','runtime.trace','complete']) chownSync(dir+'/'+file,uid,gid);
      chownSync(dir,uid,gid);
    `, String(pid)]);
    assert.equal(readFileSync(resolve(stage, 'go/profile/complete'), 'utf8'), 'ok\n', 'profile drain did not complete');
    cpSync(resolve(stage, 'go/profile'), `${out}.profiles`, { recursive: true });
  }
} catch (error) { failure = error.message; process.exitCode = 1; }
finally {
  const diagnostics = failure ? containers.map(name => {
    const result = spawnSync('docker', ['logs', '--tail', '60', name], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    let log = (result.stdout || '') + (result.stderr || '');
    for (const value of Object.values(credentials)) log = log.split(value).join('[redacted]');
    return { name, log };
  }) : undefined;
  const report = { schemaVersion: 1, experiment: 'm4-cgroup-open-loop', at: new Date().toISOString(), runKey, productionReady: false, formalAcceptance: 'not evaluated: production workload and SLO not supplied',
    failure, diagnostics, profiling, goRuntime, decisionEvidence, parameters: { seconds, rounds, rates, streamSeconds, streams, cpus, memoryMiB, goProcs, featureMode, budgetMode, edge, nativeFront, nodeCostObservation, relayNagle, isolatedHost, decisionLog: true, judge: false, semantic: false, rateLimit: false }, engine, image: imageEvidence, quotas,
    groups: { node: ['Node gateway + resource endpoint'], go: ['Go runtime', ...(featureMode === 'snapshot' ? [] : ['Node adapter']), nativeFront ? 'Go public front + real Node events, administration + resource endpoint' : edge ? 'real Node HTTP edge, events, administration + resource endpoint' : 'real Node administration + resource endpoint'], outsideQuota: ['common TCP ingress', 'mock upstream', 'load generator'] },
    corpus: { model, shapes, synthetic: true, semanticReview: false, inputMix: 'equal round-robin', mockDelayMs: 10 },
    binarySha256: sha(readFileSync(binary)), nodeSourceSha256: sourceHash, budgetSourceSha256: sha(readFileSync(resolve(root, 'src/budget.mjs'))), preflight, runs, requests,
    limits: ['These are synthetic workloads, not business quality evidence.', 'CPU/memory limits cover each full service group; shared ingress/upstream and client are outside them.', 'clientPathResidual subtracts measured mock service duration but still includes client, network and relay costs; it is not pure gateway latency.', 'Rate-sweep errors and generator drops are retained; overload is not hidden by a successful-only throughput denominator.', 'Minute-scale SSE is not an hours-long soak. Resource state is reused across runs.'] };
  mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ report: out, failure, runs: runs.length, requests: requests.length }));
  for (const container of containers.reverse()) {
    try { const label = docker(['inspect', container, '--format', '{{index .Config.Labels "amr.capacity"}}']); if (label === runKey) docker(['rm', '-f', container]); } catch { process.exitCode = 1; }
  }
  // Resolve and bound the generated staging directory before recursive cleanup.
  try { const actual = realpathSync(stage), base = realpathSync(dataRoot); assert.ok(actual.startsWith(base + sep) && actual === stage); rmSync(actual, { recursive: true, force: true }); } catch { /* Keep staging on cleanup failure for inspection. */ }
}
