// Real Node HTTP edge + Go native runtime + mock provider. No production traffic.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes, createHash, createHmac } from 'node:crypto';
import { mkdtemp, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '../..');
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
assert.ok(arg('--binary'), '--binary required');
const binary = resolve(arg('--binary'));
const semantic = arg('--semantic') || 'disabled';
const nativeFront = process.argv.includes('--native-front'), nodeCostObservation = process.argv.includes('--node-cost-observation');
assert.ok(['disabled', 'shadow', 'active'].includes(semantic), '--semantic must be shadow or active');
const dir = await mkdtemp(join(root, 'data/go-migration/edge-'));
const secret = () => randomBytes(24).toString('hex');
const edgeToken = secret(), admin = secret(), access = secret(), provider = secret();
const semanticSecret = secret();
const children = [], seen = [];
let failures = 0;
let classifierCalls = 0;
const mock = createServer(async (req, res) => {
  if (req.url.endsWith('/models')) { res.setHeader('content-type', 'application/json'); res.end('{"data":[]}'); return; }
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  if (req.url === '/private/classify') {
    assert.equal(typeof body.text, 'string');
    assert.ok(body.text.length > 0);
    assert.equal(req.headers['x-amr-edge-token'], undefined, 'edge token leaked to classifier');
    classifierCalls++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ task: 'reasoning', tier: 'complex', complexity: .91, confidence: .96, reason: 'fixture reclassification' }));
    return;
  }
  assert.equal(req.headers.authorization, `Bearer ${provider}`);
  assert.equal(body.__amr_edge, undefined, 'private context leaked upstream');
  assert.equal(req.headers['x-amr-edge-token'], undefined, 'edge credential leaked upstream');
  const judge = raw.includes('模型回答质量评审') || raw.includes('请求分类核对员');
  seen.push({ judge, model: body.model, stream: body.stream === true, content: body.messages?.at(-1)?.content });
  const usage = { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 };
  res.setHeader('content-type', 'application/json');
  if (judge) {
    const content = raw.includes('请求分类核对员') ? { taskCorrect: true, suggestedTask: 'default', reason: 'fixture' }
      : { correctness: { score: 8, verifiable: true, reason: 'fixture' }, instruction_following: { score: 9, reason: 'fixture' }, completeness: { score: 8, verifiable: true, reason: 'fixture' }, safety: { score: 10, reason: 'fixture' } };
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage })); return;
  }
  if (failures > 0) { failures--; res.writeHead(503); res.end('{}'); return; }
  if (body.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n');
    await sleep(30);
    res.write('data: {"choices":[{"delta":{"content":"这是流式回答"}}]}\n\n');
    await sleep(['cancel-fixture', 'drain-fixture'].includes(body.messages?.[0]?.content) ? 1500 : 30);
    res.end(`data: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`);
  } else res.end(JSON.stringify({ model: body.model, choices: [{ message: { role: 'assistant', content: '这是业务回答' } }], usage }));
});
async function freePort() { const s = createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
function start(command, args, env) {
  const child = spawn(command, args, { cwd: root, windowsHide: true, stdio: env.AMR_TEST_SHUTDOWN_IPC === '1' ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  let output = ''; child.stdout.on('data', b => { output = (output + b).slice(-8000); }); child.stderr.on('data', b => { output = (output + b).slice(-8000); });
  child.on('error', e => { output += String(e); }); children.push(child); return { child, output: () => output };
}
async function healthy(base, process) {
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + '/health')).ok) return; } catch {}
    if (process.child.exitCode !== null) break;
    await sleep(50);
  }
  throw new Error(`startup failed: ${process.output()}`);
}
try {
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const upstream = `http://127.0.0.1:${mock.address().port}/v1`;
  const config = JSON.parse(await readFile(join(root, 'config/router.json'), 'utf8'));
  config.upstreamBaseUrl = upstream;
  config.models = config.models.filter(m => m.enabled).slice(0, 2);
  for (const m of config.models) {
    m.quality = Object.fromEntries(Object.keys(m.quality).map(k => [k, .95])); m.quality.default = .95;
    m.benchmarkScores = null; m.minimumCompletionTokensForReliableAnswer = 0;
    m.pricingYuanPerMillionTokens = { input: 1, output: 2 }; m.contextWindow = 128000;
  }
  Object.assign(config.routing, { mode: 'active', activeTrafficPercent: 100, maxAttempts: 2, requestTimeoutMs: 5000,
    qualityFloor: .7, taskPreferences: {}, sessionStickinessTtlMs: 0, latencyObservation: { mode: 'shadow', probes: { enabled: false } } });
  config.routing.loadBalancing = { enabled: true, penaltyWeight: .2, limits: Object.fromEntries(config.models.map(m => [m.id, 16])) };
  config.semanticRouter.enabled = false; config.calibration.enabled = false;
  if (semantic !== 'disabled') Object.assign(config.semanticRouter, {
    enabled: true, mode: semantic, provider: 'http-json', minCharacters: 1, confidenceThreshold: 1,
    activeTrafficPercent: 100, finalAdoptionThreshold: .5,
    httpJson: { url: `http://127.0.0.1:${mock.address().port}/private/classify`, timeoutMs: 2000 }
  });
  config.rateLimit = { enabled: true, rpm: 6000, burst: 100 };
  config.budget = { ...config.budget, enabled: false, ledgerPath: join(dir, 'node-budget.json') };
  config.decisionLog = { ...config.decisionLog, enabled: true, dirPath: join(dir, 'decisions'), redactMessages: true, logAnswerText: false };
  config.feedbackLog = { enabled: false, dirPath: join(dir, 'feedback') };
  config.judge = { ...config.judge, enabled: true, samplePercent: 100, taskCheckEnabled: true, guardStatePath: join(dir, 'judge-guard.json'), timeoutMs: 5000 };
  const configFile = join(dir, 'router.json'), snapshot = join(dir, 'runtime.json'), authFile = join(dir, 'auth.json');
  await writeFile(configFile, JSON.stringify(config));
  await writeFile(authFile, JSON.stringify({ mode: 'strict', accessToken: access, upstreamToken: provider, adminToken: admin }));
  execFileSync(process.execPath, ['go-core/compat/export-runtime.mjs', '--config', configFile, '--out', snapshot], { cwd: root, windowsHide: true, stdio: 'pipe' });
  const nodePort = await freePort(), goPort = await freePort(), publicPort = await freePort();
  const nodeBase = `http://127.0.0.1:${nodePort}`, base = nativeFront ? `http://127.0.0.1:${publicPort}` : nodeBase, goBase = `http://127.0.0.1:${goPort}`;
  const go = start(binary, ['--lab', ...(nodeCostObservation ? ['--node-cost-observation'] : []), ...(nativeFront ? ['--public-listen', `127.0.0.1:${publicPort}`, '--node-origin', nodeBase] : []), '--runtime', '--runtime-config', snapshot, '--auth-config', authFile, '--ledger', join(dir, 'go.wal'), '--listen', `127.0.0.1:${goPort}`, '--upstream', upstream + '/chat/completions',
    ...(semantic === 'disabled' ? [] : ['--native-semantics', '--semantic-small', config.semanticRouter.httpJson.url])], {
    AMR_GO_EDGE_URL: nodeBase + '/internal/v1/go-events', AMR_GO_EDGE_TOKEN: edgeToken,
    AMR_GO_SEMANTIC_BUCKET_SECRET: semanticSecret
  });
  await healthy(goBase, go);
  const node = start(process.execPath, ['src/server.mjs'], { HOST: '127.0.0.1', PORT: String(nodePort), CONFIG_PATH: configFile,
    AMR_TEST_SHUTDOWN_IPC: nativeFront ? '1' : '0', AMR_GO_NATIVE_FRONT: nativeFront ? '1' : '0', AMR_GO_CHAT_URL: goBase + '/v1/chat/completions', AMR_GO_EDGE_TOKEN: edgeToken, AMR_GO_ADMIN_URL: goBase,
    AMR_GO_ADMIN_TOKEN: admin, AMR_GO_RUNTIME_CONFIG: snapshot, ROUTER_KEY_MODE: 'strict', ROUTER_ACCESS_KEY: access,
    UPSTREAM_BASE_URL: upstream, MAAS_BASE_URL: upstream, UPSTREAM_API_KEY: provider, MAAS_API_KEY: provider,
    SEMANTIC_BUCKET_SECRET: semanticSecret,
    ADMIN_TOKEN: admin, METRICS_TOKEN: admin, AMR_COUNTERS_PATH: join(dir, 'counters.json'), JUDGE_SECRET_PATH: join(dir, 'judge-secret.json') });
  await healthy(base, node);
  const callerSession = 'private-session-fixture';
  const headers = { authorization: `Bearer ${access}`, 'content-type': 'application/json', 'x-session-id': callerSession };
  const post = (extra = {}, id = secret()) => fetch(base + (nativeFront ? '/v1/chat/completions' : '/v1/chat/completions?compatible=1'), { method: 'POST', headers: { ...headers, 'x-request-id': id },
    body: JSON.stringify({ messages: [{ role: 'user', content: semantic === 'disabled' ? 'hello' : 'hello there, good morning' }], max_tokens: 128, ...extra }) });
  const requests = [];
  for (const stream of [false, true]) {
    const id = 'edge-' + stream;
    const res = await post({ stream }, id), raw = await res.text();
    assert.equal(res.status, 200, raw); assert.equal(res.headers.get('x-request-id'), id);
    assert.ok(res.headers.get('x-router-selected-model')); assert.ok(res.headers.get('x-router-policy-revision'));
    assert.match(raw, stream ? /\[DONE\]/ : /这是业务回答/); requests.push(id);
  }
  failures = 1;
  const retried = await post({}, 'edge-fallback'); assert.equal(retried.status, 200, await retried.text()); requests.push('edge-fallback');
  const cancelled = await post({ stream: true, messages: [{ role: 'user', content: 'cancel-fixture' }] }, 'edge-cancel');
  const reader = cancelled.body.getReader(); await reader.read(); await reader.cancel(); requests.push('edge-cancel');
  await sleep(500);
  const records = async prefix => {
    const files = (await readdir(join(dir, 'decisions'))).filter(f => f.startsWith(prefix) && f.endsWith('.jsonl'));
    return (await Promise.all(files.map(f => readFile(join(dir, 'decisions', f), 'utf8')))).join('\n').split('\n').filter(Boolean).map(JSON.parse);
  };
  let rows = [];
  for (let i = 0; i < 100; i++) { rows = await records('decisions-'); if (requests.every(id => rows.some(r => r.request?.requestId === id))) break; await sleep(50); }
  for (const id of requests) assert.equal(rows.filter(r => r.request?.requestId === id).length, 1, 'missing/duplicate decision ' + id);
  for (const row of rows) {
    assert.equal(row.request.keyFingerprint, createHash('sha256').update(access).digest('hex').slice(0, 8));
    assert.equal(row.request.sessionFingerprint, 'sidfp:' + createHmac('sha256', semanticSecret).update('session-fp:' + callerSession).digest('hex').slice(0, 16));
  }
  const serializedLogs = JSON.stringify(rows);
  for (const privateValue of [access, provider, edgeToken, semanticSecret, callerSession]) assert.ok(!serializedLogs.includes(privateValue), 'private data leaked into decisions');
  assert.equal(rows.find(r => r.request?.requestId === 'edge-cancel').outcome.ok, false);
  assert.equal(rows.find(r => r.request?.requestId === 'edge-fallback').outcome.attempts.length, 2);
  assert.equal(rows.find(r => r.request?.requestId === 'edge-true').outcome.core, 'go');
  let judges = [];
  for (let i = 0; i < 100; i++) { judges = await records('judge-reviews-'); if (judges.filter(r => r.event === 'quality').length >= 3) break; await sleep(50); }
  assert.equal(judges.filter(r => r.event === 'quality').length, 3, JSON.stringify(judges));
  assert.ok(seen.some(r => r.judge && r.content?.includes('这是流式回答')));
  const adminHeaders = { authorization: `Bearer ${admin}`, 'content-type': 'application/json' };
  const currentRes = await fetch(base + '/admin/api/config', { headers: adminHeaders });
  const current = await currentRes.json();
  current.routing.qualityWeight += .01;
  const saved = await fetch(base + '/admin/api/config', { method: 'PUT', headers: { ...adminHeaders, 'if-match': currentRes.headers.get('etag') }, body: JSON.stringify(current) });
  assert.equal(saved.status, 200, await saved.text());
  const after = await post({}, 'edge-after-publish'); assert.equal(after.status, 200, await after.text());
  assert.equal(after.headers.get('x-router-policy-revision'), saved.headers.get('etag'));
  let semanticRows = [];
  if (semantic !== 'disabled') {
    const successful = [...requests.filter(id => id !== 'edge-cancel'), 'edge-after-publish'];
    for (let i = 0; i < 100; i++) {
      semanticRows = await records('semantic-reviews-'); rows = await records('decisions-');
      if (successful.every(id => semanticRows.some(r => r.requestId === id) && rows.some(r => r.request?.requestId === id))) break;
      await sleep(50);
    }
    for (const id of successful) {
      const reviews = semanticRows.filter(r => r.requestId === id);
      assert.equal(reviews.length, 1, 'missing/duplicate semantic review ' + id);
      const review = reviews[0], decision = rows.find(r => r.request?.requestId === id).decision;
      assert.equal(review.core, 'go');
      assert.equal(review.status, semantic === 'active' ? 'applied' : 'shadow_complete');
      assert.equal(review.proposed.task, 'reasoning'); assert.notEqual(review.base.task, 'reasoning');
      assert.equal(review.assessment.confidence, .96);
      assert.equal(decision.analysis.task, semantic === 'active' ? 'reasoning' : review.base.task);
      assert.equal(decision.routeMethod, semantic === 'active' ? 'semantic' : 'rules');
      assert.ok(decision.analysis.confidence > 0 && decision.analysis.confidence <= 1);
      if (semantic === 'active') assert.equal(decision.analysis.confidence, .96);
      assert.ok(decision.analysis.estimatedInputTokens > 0, 'input token estimate lost during semantic adoption');
      assert.equal(decision.analysis.estimatedOutputTokens, 128);
      assert.ok(decision.analysis.estimatedContextTokens >= decision.analysis.estimatedInputTokens);
    }
    assert.ok(classifierCalls >= successful.length);
  }
  const noAuth = await fetch(base + '/internal/v1/go-events', { method: 'POST', body: '{}' }); assert.equal(noAuth.status, nativeFront ? 404 : 403);
  const cors = await fetch(base + '/v1/chat/completions', { method: 'OPTIONS', headers: { origin: 'https://outside.example' } }); assert.equal(cors.status, 204);
  let gracefulNativeDrain = false;
  if (nativeFront) {
    const draining = await post({ stream: true, messages: [{ role: 'user', content: 'drain-fixture' }] }, 'edge-drain');
    const ended = once(node.child, 'close');
    node.child.send({ type: 'amr-shutdown', reason: 'native-front-drain-test' });
    assert.equal(draining.status, 200); assert.match(await draining.text(), /\[DONE\]/);
    assert.equal((await ended)[0], 0, node.output());
    const persisted = await records('decisions-');
    assert.equal(persisted.filter(r => r.request?.requestId === 'edge-drain').length, 1);
    assert.equal(persisted.find(r => r.request?.requestId === 'edge-drain').outcome.ok, true);
    if (semantic !== 'disabled') semanticRows = await records('semantic-reviews-');
    judges = await records('judge-reviews-');
    gracefulNativeDrain = true;
  }
  if (nodeCostObservation && nativeFront) {
    const costs = JSON.parse(await readFile(join(dir, 'node-budget.json'), 'utf8'));
    assert.ok(costs.settledActualSpendYuan > 0, 'Node cost observation was not persisted');
    for (const suffix of ['', '.events.jsonl']) assert.equal((await stat(join(dir, 'go.wal' + suffix))).size, 0);
    assert.equal(await readFile(join(dir, 'go.wal.node-observation'), 'utf8'), 'AMR_NODE_COST_OBSERVATION_V1\n');
  }
  const result = { experiment: nativeFront ? 'go-native-front-node-events' : 'real-node-go-edge', nativeFront, nodeCostObservation, gracefulNativeDrain, passed: true, requests: requests.length + 1 + (nativeFront ? 1 : 0),
    semantic, classifierCalls, semanticReviewRecords: semanticRows.length,
    judgeQualityRecords: judges.filter(r => r.event === 'quality').length, cancellation: true, fallback: true, configPublication: true, at: new Date().toISOString() };
  await writeFile(resolve(arg('--out') || join(root, 'data/go-migration/edge-integration.json')), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally {
  for (const child of children.reverse()) if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'close'); child.kill(); await done; }
  mock.closeAllConnections(); await new Promise(r => mock.close(r));
  assert.ok(resolve(dir).startsWith(join(root, 'data/go-migration') + sep));
  await rm(dir, { recursive: true, force: true });
}
