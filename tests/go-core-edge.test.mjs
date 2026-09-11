import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { Readable } from 'node:stream';
import { createGoCoreEdge } from '../src/go-core-edge.mjs';
import { goOutcome } from '../src/go-core-results.mjs';

const token = 'test-edge-token-'.repeat(3), revision = '"' + 'a'.repeat(64) + '"';
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
function send(url, body, authorization = `Bearer ${token}`) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', headers: { authorization, 'content-type': 'application/json' } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode)); res.on('error', reject);
    });
    req.on('error', reject); req.end(JSON.stringify(body));
  });
}
function eventFor(body) {
  return { id: body.__amr_edge.id, configRevision: revision, analysis: {}, decisionAnalysis: { task: 'coding' },
    decision: { requestedModel: 'auto', selectedModel: 'model-a', suggestedModel: 'model-a', reasoningLevel: 'off', candidates: [], rejected: [], fallbackOrder: [] },
    attempt: { index: 0, model: 'model-a', ok: true, upstreamStatus: 200, latencyMs: 3, headerMs: 1, estimatedMicros: 20, actualMicros: 10 } };
}
async function fixture(t, runCore, onAttempt = () => {}, onComplete = async () => {}) {
  const complete = deferred(), coreDone = deferred();
  let eventURL;
  const core = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const c of req) chunks.push(c);
      assert.equal(req.headers['x-amr-edge-token'], token);
      const body = JSON.parse(Buffer.concat(chunks));
      await runCore({ req, res, body, post: (event, auth) => send(eventURL, event, auth) });
      coreDone.resolve();
    } catch (error) { coreDone.reject(error); res.destroy(); }
  });
  const coreURL = await listen(core);
  const edge = createGoCoreEdge({ AMR_GO_CHAT_URL: coreURL + '/v1/chat/completions', AMR_GO_EDGE_TOKEN: token });
  const server = createServer((req, res) => {
    if (req.url === '/internal/v1/go-events') return void edge.accept(req, res);
    req.requestId = 'public-request';
    req.headers.authorization = 'Bearer test-caller';
    edge.proxy(req, res, { model: 'auto', stream: req.url === '/stream', messages: [] }, {
      models: ['model-a'], configRevision: revision, timeoutMs: 1000, marketSignals: {}, onAttempt,
      onComplete: async result => { await onComplete(result); complete.resolve(result); }
    }).catch(complete.reject);
  });
  const url = await listen(server); eventURL = url + '/internal/v1/go-events';
  t.after(async () => {
    edge.close(); core.closeAllConnections(); server.closeAllConnections();
    await Promise.all([new Promise(resolve => core.close(resolve)), new Promise(resolve => server.close(resolve))]);
  });
  return { url, edge, complete: complete.promise, coreDone: coreDone.promise };
}

test('event receiver rejects non-loopback and incorrect authentication before processing', async () => {
  const edge = createGoCoreEdge({ AMR_GO_CHAT_URL: 'http://127.0.0.1:1/v1/chat/completions', AMR_GO_EDGE_TOKEN: token });
  for (const [remoteAddress, authorization] of [['192.0.2.1', `Bearer ${token}`], ['127.0.0.1', 'Bearer wrong']]) {
    const req = Readable.from(['{}']); Object.assign(req, { socket: { remoteAddress }, headers: { authorization }, method: 'POST', url: '/internal/v1/go-events' });
    let status; await edge.accept(req, { writeHead: s => { status = s; }, end() {} });
    assert.equal(status, 403);
  }
  edge.close();
});

test('authenticated concurrent event retries have one effect and changed same-attempt payload is rejected', { timeout: 10000 }, async t => {
  let effects = 0; const entered = deferred(), release = deferred();
  const f = await fixture(t, async ({ res, body, post }) => {
    const event = eventFor(body);
    assert.equal(await post(event, 'Bearer wrong'), 403);
    const first = post(event); await entered.promise;
    const retry = post(event);
    assert.equal(await post({ ...event, attempt: { ...event.attempt, actualMicros: 11 } }), 409);
    assert.equal(effects, 1); release.resolve();
    assert.deepEqual(await Promise.all([first, retry]), [204, 204]);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: 'answer' } }] }));
  }, async () => { effects++; entered.resolve(); await release.promise; });
  const response = await fetch(f.url); assert.equal(response.status, 200); await response.text();
  const result = await f.complete; await f.coreDone;
  assert.equal(effects, 1); assert.equal(result.ok, true); assert.equal(result.answerText, 'answer');
  assert.equal(result.events.length, 1); assert.equal(f.edge.pending(), 0);
  assert.equal(goOutcome(result).totalAttemptCostYuan, 0.00001);
});

test('SSE client cancellation cannot become success even with a successful core attempt event', { timeout: 10000 }, async t => {
  const f = await fixture(t, async ({ res, body, post }) => {
    assert.equal(await post(eventFor(body)), 204);
    const closed = new Promise(resolve => res.once('close', resolve));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
    await closed;
  });
  await new Promise((resolve, reject) => {
    const req = request(f.url + '/stream', res => { res.once('data', () => { res.destroy(); resolve(); }); res.on('error', () => {}); });
    req.on('error', reject); req.end();
  });
  const result = await f.complete; await f.coreDone;
  assert.equal(result.ok, false); assert.equal(result.clientGone, true);
  assert.equal(goOutcome(result).ok, false); assert.equal(f.edge.pending(), 0);
});

test('upstream SSE connection abort is recorded as failure with no duplicate upstream retry', { timeout: 10000 }, async t => {
  let calls = 0;
  const f = await fixture(t, async ({ res, body, post }) => {
    calls++;
    assert.equal(await post(eventFor(body)), 204);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    await new Promise(resolve => res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', resolve));
    res.destroy();
  });
  await fetch(f.url + '/stream').then(r => r.text()).catch(() => {});
  const result = await f.complete; await f.coreDone;
  assert.equal(result.ok, false); assert.equal(goOutcome(result).transportOk, false);
  assert.equal(calls, 1); assert.equal(f.edge.pending(), 0);
});

test('drain includes post-response persistence and has a bounded timeout', async t => {
  const entered = deferred(), release = deferred();
  const f = await fixture(t, async ({ res, body, post }) => {
    assert.equal(await post(eventFor(body)), 204);
    res.end('{"choices":[]}');
  }, () => {}, async () => { entered.resolve(); await release.promise; });
  await (await fetch(f.url)).text(); await entered.promise;
  assert.equal(await f.edge.drain(30), 1);
  release.resolve(); await f.complete;
  assert.equal(await f.edge.drain(100), 0);
});
