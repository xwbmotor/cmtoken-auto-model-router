import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
const configDir = process.env.AMR_LAB_CONFIG_DIR || '/config';
const ledgerDir = process.env.AMR_LAB_LEDGER_DIR || '/ledger';
const auth = JSON.parse(readFileSync(configDir + '/auth.json'));
const body = JSON.parse(readFileSync(configDir + '/request.json'));
const mode = process.argv[2];
const base = 'http://127.0.0.1:8791';
const headers = { Authorization: `Bearer ${auth.adminToken}` };
const stats = async () => {
  const res = await fetch(base + '/internal/v1/runtime', { headers });
  assert.equal(res.status, 200); return (await res.json()).ledger;
};
if (mode === 'serve') {
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') { res.end('ok'); return; }
    if (req.headers.authorization !== `Bearer ${auth.upstreamToken}`) { res.writeHead(401).end(); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw), usage = { prompt_tokens: 10, completion_tokens: 5 };
    if (input.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
      setTimeout(() => res.end(`data: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`), 50);
    } else { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ model: input.model, choices: [{ message: { role: 'assistant', content: 'ok' } }], usage })); }
  });
  server.listen(8790, '127.0.0.1', () => console.log('loopback mock ready'));
  process.on('SIGTERM', () => server.close());
} else if (mode === 'check') {
  const deadline = Date.now() + 10000;
  for (;;) { try { assert.equal((await fetch('http://127.0.0.1:8790/health')).status, 200); break; } catch (error) { if (Date.now() > deadline) throw error; await new Promise(r => setTimeout(r, 100)); } }
  assert.equal((await fetch(base + '/health')).status, 200);
  assert.equal((await fetch(base + '/internal/v1/runtime')).status, 403);
  const before = await stats();
  for (const stream of [false, true]) {
    const res = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, stream }) });
    assert.equal(res.status, 200);
    if (stream) assert.match(await res.text(), /data: \[DONE\]/);
    else assert.equal((await res.json()).choices[0].message.content, 'ok');
  }
  const after = await stats();
  assert.equal(after.actualMicros - before.actualMicros, 40);
  assert.equal(after.pendingReserves, 0);
  console.log(JSON.stringify({ http: true, sse: true, adminIsolation: true, settlement: true, ledger: after }));
} else if (mode === 'audit') {
  for (const filename of ['runtime.wal', 'runtime.wal.events.jsonl']) {
    const log = readFileSync(ledgerDir + '/' + filename, 'utf8');
    for (const value of [auth.accessToken, auth.adminToken, auth.upstreamToken, body.messages[0].content]) assert.ok(!log.includes(value));
  }
  console.log(JSON.stringify({ logsRedacted: true }));
} else if (mode === 'snapshot') {
  console.log(JSON.stringify(await stats()));
} else { throw new Error('Expected serve, check, audit or snapshot'); }
