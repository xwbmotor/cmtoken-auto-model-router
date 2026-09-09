// End-to-end laboratory: real Go process + Node rule adapter + local mock upstream.
// Ephemeral ports and random tokens; no .env, MaaS request, or production write.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/config.mjs';
import { routeRequest } from '../../src/router.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const arg = name => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
if (!arg('--binary')) throw new Error('Usage: node go-core/compat/demo.mjs --binary <amr-core> [--out <report>]');
const binary = resolve(arg('--binary'));
const access = randomBytes(24).toString('hex'), assessorToken = randomBytes(24).toString('hex'), upstreamToken = randomBytes(24).toString('hex');
const directory = mkdtempSync(resolve(tmpdir(), 'amr-go-lab-'));
const children = [];
async function start(command, args) {
  const child = spawn(command, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, AMR_GO_ACCESS_TOKEN: access, AMR_GO_ASSESSOR_TOKEN: assessorToken, AMR_GO_UPSTREAM_TOKEN: upstreamToken } });
  children.push(child);
  let stderr = ''; child.stderr.on('data', chunk => stderr = (stderr+chunk).slice(-1500));
  const lines = createInterface({ input: child.stdout });
  return await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error('Laboratory process startup timed out')), 15000);
    child.once('error', err => { clearTimeout(timer); reject(err); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Laboratory process exited ${code}: ${stderr}`)); });
    lines.once('line', line => { clearTimeout(timer); try { resolveReady(JSON.parse(line)); } catch { reject(new Error('Invalid laboratory readiness message')); } });
  });
}
const observed = [];
let doneWritten = false;
const mock = createServer(async (req, res) => {
  try {
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, `Bearer ${upstreamToken}`);
    assert.equal(req.headers.cookie, undefined);
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    observed.push({ model: body.model, stream: body.stream === true });
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '2' } }] })}\n\n`);
      const timer = setTimeout(() => { doneWritten = true; res.end('data: [DONE]\n\n'); }, 150);
      res.on('close', () => clearTimeout(timer));
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: body.model, choices: [{ message: { role: 'assistant', content: '2' } }] }));
    }
  } catch { res.writeHead(500); res.end('fixture failure'); }
});
try {
  const source = JSON.parse(readFileSync(resolve(root, 'config/router.json'), 'utf8'));
  // Rules-only, deterministic lab policy. This is not the running production config.
  source.semanticRouter.enabled = false;
  source.routing.mode = 'active'; source.routing.activeTrafficPercent = 100;
  const configPath = resolve(directory, 'router.json'); writeFileSync(configPath, JSON.stringify(source));
  process.env.CONFIG_PATH = configPath;
  const config = await loadConfig();
  await new Promise(resolveReady => mock.listen(0, '127.0.0.1', resolveReady));
  const assessor = await start(process.execPath, ['go-core/compat/assessor.mjs', '--lab', '--config', configPath, '--port', '0']);
  const go = await start(binary, ['--lab', '--listen', '127.0.0.1:0', '--assessor', `http://127.0.0.1:${assessor.port}/assess`, '--upstream', `http://127.0.0.1:${mock.address().port}/v1/chat/completions`]);
  const base = `http://${go.listen}`;
  const headers = { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json', Cookie: 'must-not-leak' };
  const health = await (await fetch(base+'/health')).json(); assert.equal(health.productionReady, false);
  const body = { model: config.routing.autoModelId, messages: [{ role: 'user', content: '只返回一个数字：1+1等于几？' }], max_tokens: 8192 };
  const expected = routeRequest(body, config, { trafficBucket: 0 }).selectedModel;
  const plain = await fetch(base+'/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal(plain.status, 200); const answer = await plain.json();
  assert.equal(answer.model, expected); assert.equal(answer.choices[0].message.content, '2');
  const stream = await fetch(base+'/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify({ ...body, stream: true }) });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  const first = await reader.read();
  assert.equal(doneWritten, false, 'SSE was buffered until completion');
  let text = new TextDecoder().decode(first.value);
  for (;;) { const next = await reader.read(); if (next.done) break; text += new TextDecoder().decode(next.value); }
  assert.ok(text.includes('"content":"2"') && text.includes('data: [DONE]'));
  const unauthenticated = await fetch(base+'/v1/chat/completions', { method: 'POST', body: JSON.stringify(body) });
  assert.equal(unauthenticated.status, 401); await unauthenticated.arrayBuffer();
  const explicit = await fetch(base+'/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify({ ...body, model: config.models[0].id }) });
  assert.equal(explicit.status, 400); assert.equal((await explicit.json()).error.code, 'unsupported_explicit_model');
  assert.equal(observed.length, 2, 'unexpected upstream call or retry');
  const report = { milestone: 'm1', productionReady: false, at: new Date().toISOString(), upstream: 'local mock only',
    services: ['Go gateway and decision kernel', 'Node rules adapter', 'mock OpenAI upstream'],
    nonstream: true, sse: true, sseFirstEventBeforeCompletion: true, donePreserved: true, unauthorizedRejected: true,
    explicitModelRejected: true, upstreamCalls: observed.length, selectedModelMatchesNode: true, credentialIsolation: true,
    binarySha256: createHash('sha256').update(readFileSync(binary)).digest('hex') };
  const output = resolve(arg('--out') || resolve(root, 'data/go-migration/demo.json'));
  mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(report, null, 2)+'\n');
  console.log(JSON.stringify(report));
} finally {
  for (const child of children.reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    await new Promise(resolveExit => { const timer = setTimeout(resolveExit, 3000); child.once('exit', () => { clearTimeout(timer); resolveExit(); }); child.kill(); });
  }
  mock.closeAllConnections(); await new Promise(resolveClosed => mock.close(resolveClosed));
  rmSync(directory, { recursive: true, force: true });
}
