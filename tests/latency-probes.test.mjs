import test from 'node:test';
import assert from 'node:assert/strict';
import { createLatencyProbeRunner } from '../src/latency-probes.mjs';

function setup(options = {}) {
  let clock = Date.parse('2026-09-08T12:00:00Z');
  const config = { enabled: true, intervalMs: 900000, maxCallsPerDay: 144, ...options.config };
  const writes = [], calls = [];
  const obs = { probeState: { day: '', calls: 0, lastRunAt: null, modelLastAt: {} },
    storage: { persistErrors: 0 }, dirty: false,
    async flush() { writes.push(structuredClone(this.probeState)); this.dirty = false; } };
  Object.assign(obs, options.obs);
  const runner = createLatencyProbeRunner({ observatory: obs, getSettings: () => config,
    hasFreshBusiness: options.hasFreshBusiness, getModels: () => options.models ?? [{ id: 'a' }, { id: 'b' }, { id: 'c' }], now: () => clock,
    probe: async (model, settings) => { calls.push({ model: model.id, settings }); return options.probe ? options.probe(model) : { ok: true }; } });
  return { runner, obs, config, writes, calls, advance: ms => { clock += ms; }, time: at => { clock = Date.parse(at); } };
}

test('reserves synchronously, persists budget before call, and rejects overlap', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = setup({ probe: async () => { assert.equal(h.writes[0].calls, 1); await gate; return { ok: true }; } });
  assert.deepEqual(h.runner.run(), { accepted: true });
  assert.equal(h.runner.snapshot().running, true);
  assert.deepEqual(h.runner.run({ manual: true }), { accepted: false, reason: 'busy' });
  await Promise.resolve(); release(); await h.runner.done();
  assert.equal(h.calls.length, 1); assert.equal(h.obs.probeState.calls, 1);
  assert.equal(h.runner.snapshot().running, false);
});

test('swallowed persistence failure prevents upstream calls and blocks further runs', async () => {
  const h = setup();
  h.obs.flush = async () => { h.obs.storage.persistErrors++; };
  assert.equal(h.runner.run().accepted, true); await h.runner.done();
  assert.equal(h.calls.length, 0); assert.equal(h.runner.snapshot().lastError, 'storage');
  h.advance(900000);
  assert.deepEqual(h.runner.run(), { accepted: false, reason: 'storage' });
});

test('thrown flush and corrupt restored budget fail closed without rejection', async () => {
  const h = setup(); h.obs.flush = async () => { throw new Error('disk'); };
  h.runner.run(); await assert.doesNotReject(h.runner.done()); assert.equal(h.calls.length, 0);
  const corrupt = setup({ obs: { probeBudgetBlocked: true } });
  assert.deepEqual(corrupt.runner.run({ manual: true }), { accepted: false, reason: 'storage' });
});

test('manual works while disabled but still respects cooldown and daily budget', async () => {
  const h = setup({ config: { enabled: false, maxCallsPerDay: 1 } });
  assert.deepEqual(h.runner.run(), { accepted: false, reason: 'disabled' });
  assert.equal(h.runner.run({ manual: true }).accepted, true); await h.runner.done();
  assert.deepEqual(h.runner.run({ manual: true }), { accepted: false, reason: 'cooldown' });
  h.advance(60000);
  assert.deepEqual(h.runner.run({ manual: true }), { accepted: false, reason: 'budget' });
  assert.equal(h.runner.snapshot().nextRunAt, null);
});

test('UTC+8 midnight resets budget without bypassing global cooldown', async () => {
  const h = setup({ config: { maxCallsPerDay: 1 } });
  h.time('2026-09-08T15:59:30Z'); h.runner.run(); await h.runner.done();
  assert.equal(h.obs.probeState.day, '2026-09-08');
  h.advance(30000); assert.equal(h.runner.snapshot().callsToday, 0);
  assert.deepEqual(h.runner.run(), { accepted: false, reason: 'cooldown' });
  h.advance(30000); assert.equal(h.runner.run().accepted, true); await h.runner.done();
  assert.equal(h.obs.probeState.day, '2026-09-09'); assert.equal(h.obs.probeState.calls, 1);
});

test('selects oldest model, observes interval, manual may bypass model interval', async () => {
  const h = setup();
  for (let i = 0; i < 3; i++) { assert.equal(h.runner.run().accepted, true); await h.runner.done(); h.advance(100000); }
  assert.deepEqual(h.calls.map(x => x.model), ['a', 'b', 'c']);
  assert.deepEqual(h.runner.run(), { accepted: false, reason: 'no_model' });
  assert.equal(h.runner.run({ manual: true }).accepted, true); await h.runner.done();
  assert.equal(h.calls.at(-1).model, 'a');
  h.advance(900000); assert.equal(h.runner.run().accepted, true); await h.runner.done();
  assert.equal(h.calls.at(-1).model, 'b');
});

test('failure and exceptions retain budget and never expose raw exception messages', async () => {
  const h = setup({ probe: async () => { throw new Error('secret credential'); } });
  h.runner.run(); await assert.doesNotReject(h.runner.done());
  assert.equal(h.obs.probeState.calls, 1); assert.equal(h.runner.snapshot().lastError, 'probe_failed');
  assert.ok(h.obs.probeState.modelLastAt.a); assert.equal(h.writes.at(-1).calls, 1);
});

test('skips preserve missing sample time but delay scheduling and rotate models', async () => {
  const h = setup({ probe: async () => ({ ok: false, skipped: true, errorCode: 'capacity' }) });
  h.runner.run(); await h.runner.done();
  assert.equal(h.obs.probeState.modelLastAt.a, undefined); assert.equal(h.obs.probeState.calls, 1);
  h.advance(100000); h.runner.run(); await h.runner.done(); assert.equal(h.calls[1].model, 'b');
});

test('no enabled models makes no reservation; persisted state survives new runner', async () => {
  const empty = setup({ models: [{ id: 'a', enabled: false }] });
  assert.deepEqual(empty.runner.run(), { accepted: false, reason: 'no_model' });
  assert.equal(empty.obs.probeState.calls, 0);
  const h = setup({ config: { maxCallsPerDay: 1 } }); h.runner.run(); await h.runner.done();
  const restored = setup({ config: { maxCallsPerDay: 1 }, obs: { probeState: structuredClone(h.writes.at(-1)) } });
  restored.advance(60000);
  assert.deepEqual(restored.runner.run({ manual: true }), { accepted: false, reason: 'budget' });
});

test('failed completion flush retains pre-call durable budget and blocks next attempt', async () => {
  const h = setup({ probe: async () => ({ ok: false, errorCode: 'timeout' }) });
  const flush = h.obs.flush.bind(h.obs);
  let count = 0;
  h.obs.flush = async () => { if (++count === 1) return flush(); h.obs.storage.persistErrors++; };
  h.runner.run(); await h.runner.done();
  assert.equal(h.calls.length, 1); assert.equal(h.writes[0].calls, 1);
  assert.equal(h.runner.snapshot().callsToday, 1); assert.equal(h.runner.snapshot().lastError, 'storage');
  h.advance(900000); assert.equal(h.runner.run().reason, 'storage');
});

test('automatic probes pace remaining daily budget, but manual retains hard limits', async () => {
  const h = setup({ config: { maxCallsPerDay: 4 } });
  h.runner.run(); await h.runner.done();
  h.advance(60000);
  assert.equal(h.runner.run().reason, 'pacing');
  const due = h.runner.snapshot().nextRunAt;
  h.advance(60000); assert.equal(h.runner.snapshot().nextRunAt, due, 'polling must not postpone due time');
  assert.equal(h.runner.run({ manual: true }).accepted, true); await h.runner.done();
  h.advance(5400000); assert.equal(h.runner.run().accepted, true); await h.runner.done();
  assert.equal(h.calls.length, 3);
});

test('fresh business suppresses automatic probes without consuming budget; manual can inspect', async () => {
  let fresh = true;
  const h = setup({ hasFreshBusiness: () => fresh });
  assert.equal(h.runner.run().reason, 'fresh_business');
  assert.equal(h.obs.probeState.calls, 0);
  assert.ok(h.runner.snapshot().models.every(m => m.reason === 'fresh_business'));
  assert.equal(h.runner.run({ manual: true }).accepted, true); await h.runner.done();
  fresh = false; h.advance(900000);
  assert.equal(h.runner.run().accepted, true); await h.runner.done();
  assert.equal(h.calls[1].model, 'b');
});
