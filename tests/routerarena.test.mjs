import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { prepare, decodeResponse, run } from '../scripts/routerarena.mjs';

const manifest = () => ({ schemaVersion: 1, name: 'amr-smoke', split: 'smoke',
  autoModel: 'cmtoken-auto', policyRevision: 'frozen-revision', routerArenaCommit: 'a'.repeat(40),
  maxRequests: 3, maxTokens: 512, timeoutMs: 1000,
  models: [{ id: 'cheap', arenaId: 'cheap-v1', responseIds: ['served-cheap'], identityVerified: true },
    { id: 'strong', arenaId: 'strong-v1', responseIds: ['served-strong'], identityVerified: true }] });
const cases = [{ 'global index': 'local-1', prompt: 'Return the number two.', answer: 'never send this label' }];
const headers = () => new Headers({ 'x-router-selected-model': 'cheap',
  'x-router-suggested-model': 'strong', 'x-router-policy-revision': 'frozen-revision' });
const body = () => ({ model: 'served-cheap', choices: [{ message: { content: '2' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 2 } });

test('preflight makes no calls and strips evaluation labels', async () => {
  assert.deepEqual(prepare(manifest(), cases).cases, [{ 'global index': 'local-1', prompt: cases[0].prompt }]);
  const result = await run({ manifest: manifest(), dataset: cases, fetchImpl: () => { throw Error('network'); } });
  assert.equal(result.networkCalls, 0);
  assert.equal(result.leaderboardReady, false);
  assert.throws(() => prepare(manifest(), [...cases, ...cases]), /Duplicate/);
  assert.throws(() => prepare({ ...manifest(), maxRequests: 0 }, cases), /cap/);
});

test('actual selection wins over shadow; drift and missing usage stop export', () => {
  assert.equal(decodeResponse(manifest(), headers(), body()).prediction, 'cheap-v1');
  const h = headers(); h.set('x-router-selected-model', 'outside');
  assert.throws(() => decodeResponse(manifest(), h, body()), /pool/);
  h.set('x-router-selected-model', 'cheap'); h.set('x-router-policy-revision', 'changed');
  assert.throws(() => decodeResponse(manifest(), h, body()), /revision/);
  assert.throws(() => decodeResponse(manifest(), headers(), { ...body(), model: 'redirected' }), /identity/);
  assert.throws(() => decodeResponse(manifest(), headers(), { ...body(), usage: {} }), /usage/);
  const truncated = body(); truncated.choices[0].finish_reason = 'length';
  assert.throws(() => decodeResponse(manifest(), headers(), truncated), /Incomplete/);
});

test('real HTTP fixture exports official fields without forwarding answers or persisting keys', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arena-'));
  let received;
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    received = JSON.parse(Buffer.concat(chunks));
    res.writeHead(200, Object.fromEntries(headers())); res.end(JSON.stringify(body()));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const out = join(dir, 'run');
    const result = await run({ manifest: manifest(), dataset: cases, out, execute: true,
      endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, key: 'fixture-secret' });
    assert.equal(result.completed, 1);
    assert.deepEqual(received.messages, [{ role: 'user', content: cases[0].prompt }]);
    const rows = JSON.parse(await readFile(join(out, 'amr-smoke.json'), 'utf8'));
    assert.equal(rows[0].generated_result.token_usage.output_tokens, 2);
    assert.equal(rows[0].prediction, 'cheap-v1');
    const evidence = await readFile(join(out, 'evidence.jsonl'), 'utf8');
    assert.ok(!evidence.includes('fixture-secret'));
    assert.ok(!evidence.includes('never send'));
    await assert.rejects(run({ manifest: manifest(), dataset: cases, out, execute: true,
      endpoint: 'http://127.0.0.1/v1/chat/completions', key: 'fixture-secret' }), /EEXIST/);
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(dir, { recursive: true, force: true }); }
});

test('failed request is retained, not retried or silently exported as a smaller dataset', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arena-')); let calls = 0;
  try {
    const out = join(dir, 'failed');
    const result = await run({ manifest: manifest(), dataset: cases, out, execute: true,
      endpoint: 'http://localhost/v1/chat/completions', key: 'fixture-secret',
      fetchImpl: async () => { calls++; throw Error('remote echoes fixture-secret'); } });
    assert.equal(calls, 1); assert.ok(result.failure);
    await assert.rejects(access(join(out, 'amr-smoke.json')));
    const log = await readFile(join(out, 'evidence.jsonl'), 'utf8');
    assert.ok(log.includes('failed_or_unknown')); assert.ok(!log.includes('fixture-secret'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('unverified model identities cannot start a paid run', async () => {
  const m = manifest(); m.models[0].identityVerified = false;
  await assert.rejects(run({ manifest: m, dataset: cases, execute: true }), /identities/);
});
