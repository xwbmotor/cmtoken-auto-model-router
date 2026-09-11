import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createGoConfigPublication } from '../src/go-config-publication.mjs';
import { loadConfig, getConfigRevision } from '../src/config.mjs';

const rev = char => '"' + char.repeat(64) + '"';
async function isolated(run) {
  const dir = await mkdtemp(resolve(tmpdir(), 'amr-go-publication-')), old = process.env.CONFIG_PATH;
  try {
    const path = resolve(dir, 'router.json');
    // Deliberately noncanonical bytes: rollback must preserve spacing and CRLF.
    const source = JSON.parse(await readFile(new URL('../config/router.json', import.meta.url), 'utf8'));
    const raw = JSON.stringify(source, null, 4).replaceAll('\n', '\r\n') + '\r\n\r\n';
    await writeFile(path, raw); process.env.CONFIG_PATH = path;
    const initial = await loadConfig();
    await run({ path, raw, initial });
  } finally {
    if (old === undefined) delete process.env.CONFIG_PATH; else process.env.CONFIG_PATH = old;
    await rm(dir, { recursive: true, force: true });
  }
}

test('Go rejection restores exact source bytes and permits a subsequent successful publication', async () => isolated(async ({ path, raw, initial }) => {
  let state = { status: 200, revision: rev('a'), configRevision: getConfigRevision(initial) }, reject = true;
  const publication = createGoConfigPublication({ status: async () => ({ ...state }), reload: async expected => {
    assert.equal(expected, state.revision);
    if (reject) return { status: 422 };
    state = { status: 200, revision: rev('b'), configRevision: getConfigRevision(await loadConfig()) }; return { ...state };
  } });
  const next = structuredClone(initial); next.routing.qualityFloor = 0.69;
  await assert.rejects(publication.save(next, { expectedRevision: getConfigRevision(initial) }), { code: 'core_publication_failed' });
  assert.equal(await readFile(path, 'utf8'), raw); assert.equal(publication.blocked(), false);
  reject = false; const saved = await publication.save(next, { expectedRevision: getConfigRevision(initial) });
  assert.equal(saved.routing.qualityFloor, 0.69); assert.equal(publication.blocked(), false);
  assert.equal(state.configRevision, getConfigRevision(saved));
}));

test('unknown publication stays blocked and does not roll back until explicit recovery confirms the live config', async () => isolated(async ({ path, initial }) => {
  let state = { status: 200, revision: rev('a'), configRevision: getConfigRevision(initial) }, offline = false;
  const publication = createGoConfigPublication({
    status: async () => { if (offline) throw new Error('offline'); return { ...state }; },
    reload: async () => { if (!offline) { offline = true; throw new Error('lost response'); } }
  });
  const next = structuredClone(initial); next.routing.qualityFloor = 0.69;
  await assert.rejects(publication.save(next), { code: 'core_publication_pending' });
  assert.equal(publication.blocked(), true);
  const persisted = await readFile(path, 'utf8'); assert.equal(JSON.parse(persisted).routing.qualityFloor, 0.69);
  await assert.rejects(publication.save(initial));
  assert.equal(await readFile(path, 'utf8'), persisted); assert.equal(publication.blocked(), true);
}));

test('lost successful publish acknowledgment is reconciled by live status without source rollback', async () => isolated(async ({ initial }) => {
  let state = { status: 200, revision: rev('a'), configRevision: getConfigRevision(initial) };
  const publication = createGoConfigPublication({ status: async () => ({ ...state }), reload: async () => {
    state = { status: 200, revision: rev('b'), configRevision: getConfigRevision(await loadConfig()) };
    throw new Error('lost acknowledgment');
  } });
  const next = structuredClone(initial); next.routing.qualityFloor = 0.69;
  const saved = await publication.save(next);
  assert.equal(state.configRevision, getConfigRevision(saved)); assert.equal(publication.blocked(), false);
}));

test('unknown outcome recovers through reload and budget protection changes are refused before saving', async () => isolated(async ({ initial, path, raw }) => {
  let mode = 'unknown', offline = false, state = { status: 200, revision: rev('a'), configRevision: getConfigRevision(initial) };
  const publication = createGoConfigPublication({ status: async () => {
    if (offline) throw new Error('offline'); return { ...state };
  }, reload: async () => {
    if (mode === 'unknown') { offline = true; throw new Error('lost response'); }
    state = { status: 200, revision: rev('b'), configRevision: getConfigRevision(await loadConfig()) }; return { ...state };
  } });
  const budget = structuredClone(initial); budget.budget.enabled = !initial.budget.enabled;
  await assert.rejects(publication.save(budget), { code: 'core_storage_mode_change' });
  assert.equal(await readFile(path, 'utf8'), raw);
  const next = structuredClone(initial); next.routing.qualityFloor = 0.69;
  await assert.rejects(publication.save(next), { code: 'core_publication_pending' });
  assert.equal(publication.blocked(), true);
  offline = false; mode = 'ok'; const saved = await publication.reload();
  assert.equal(publication.blocked(), false); assert.equal(getConfigRevision(saved), state.configRevision);
}));
