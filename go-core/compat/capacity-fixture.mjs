// Shared ingress relays and deterministic upstream, outside both gateway quotas.
import { createServer } from 'node:http';
import { createServer as tcpServer, connect } from 'node:net';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { timingSafeEqual } from 'node:crypto';

const control = process.env.M4_CONTROL_TOKEN, upstream = process.env.M4_UPSTREAM;
if (!control || !upstream) throw new Error('isolated fixture required');
let calls = 0, duplicates = 0, fixtureErrors = 0, active = 0;
const seen = new Set();
function authorized(req, token) { const got = Buffer.from(req.headers.authorization || ''), expected = Buffer.from(`Bearer ${token}`); return got.length === expected.length && timingSafeEqual(got, expected); }
const resources = async (role, path = '/resources') => {
  const res = await fetch(`http://127.0.0.1:${role === 'node' ? 18786 : 18791}${path}`, { headers: { authorization: `Bearer ${control}` }, signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error('resource query failed'); return res.json();
};
createServer(async (req, res) => {
  if (!authorized(req, control)) { res.writeHead(403); return res.end(); }
  try {
    if (req.method === 'GET' && req.url === '/state') return res.end(JSON.stringify({ calls, duplicates, fixtureErrors, active }));
    if (req.method === 'GET' && ['/resources/node', '/resources/go'].includes(req.url)) return res.end(JSON.stringify(await resources(req.url.split('/').at(-1))));
    if (req.method === 'GET' && ['/decisions/node', '/decisions/go'].includes(req.url)) return res.end(JSON.stringify(await resources(req.url.split('/').at(-1), '/decisions')));
    if (req.method === 'GET' && ['/profile-stop/node', '/profile-stop/go'].includes(req.url)) return res.end(JSON.stringify(await resources(req.url.split('/').at(-1), '/profile-stop')));
    res.writeHead(404); res.end();
  } catch { res.writeHead(503); res.end('{"error":"fixture_unavailable"}'); }
}).listen(8799, '0.0.0.0');
createServer(async (req, res) => {
  if (!authorized(req, upstream) || req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(403); return res.end(); }
  let counted = false;
  try {
    let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 2 * 1024 * 1024) throw new Error('body limit'); }
    const body = JSON.parse(raw);
    if (body.__amr_edge !== undefined || req.headers['x-amr-edge-token'] !== undefined) throw new Error('private edge context leaked');
    const id = body.messages?.[0]?.content;
    if (typeof id !== 'string' || !/^m4:[a-z0-9-]+$/.test(id) || body.model !== 'm4-fixture-model') throw new Error('invalid fixture input');
    calls++; if (seen.has(id)) duplicates++; seen.add(id); active++; counted = true;
    const started = performance.now();
    await sleep(10);
    const usage = { prompt_tokens: 200, completion_tokens: 20 };
    if (body.stream) {
      const seconds = Number(process.env.M4_STREAM_SECONDS || 60);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (let i = 0; i < seconds; i++) {
        if (res.destroyed) return;
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `part-${i};` } }] })}\n\n`);
        await sleep(1000);
      }
      res.end(`data: ${JSON.stringify({ choices: [], usage, fixtureServiceMs: performance.now() - started })}\n\ndata: [DONE]\n\n`);
    } else {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ model: body.model, choices: [{ message: { role: 'assistant', content: 'fixture-ok' } }], usage, fixtureServiceMs: performance.now() - started }));
    }
  } catch { fixtureErrors++; if (!res.headersSent) res.writeHead(500); res.end('fixture_error'); }
  finally { if (counted) active--; }
}).listen(8790, '0.0.0.0');
// Go deliberately remains bound to literal loopback. Both measured gateways use
// identical byte relays in the shared fixture namespace, not privileged networking.
for (const [front, back] of [[8785, 8786], [8792, process.env.M4_EDGE === '1' ? 8787 : 8791], [8784, 8787]]) {
  tcpServer(client => {
    const target = connect(back, '127.0.0.1'); client.pipe(target); target.pipe(client);
    client.on('error', () => target.destroy()); target.on('error', () => client.destroy());
    client.on('close', () => target.destroy()); target.on('close', () => client.destroy());
  }).listen(front, '0.0.0.0');
}
