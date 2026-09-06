import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, saveConfig, getConfigRevision } from '../src/config.mjs';
import { configurationChanges } from '../public/change-review.js';

test('revision compare is inside the save queue; stale and external edits cannot be overwritten', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amr-revision-'));
  const oldPath = process.env.CONFIG_PATH;
  try {
    const raw = await readFile(new URL('../config/router.json', import.meta.url), 'utf8');
    process.env.CONFIG_PATH = join(directory, 'router.json');
    await writeFile(process.env.CONFIG_PATH, raw);
    const initial = await loadConfig();
    const revision = getConfigRevision(initial);
    assert.match(revision, /^"[a-f0-9]{64}"$/);
    const first = structuredClone(initial), second = structuredClone(initial);
    first.routing.activeTrafficPercent = 20;
    second.routing.activeTrafficPercent = 30;
    const attempts = await Promise.allSettled([
      saveConfig(first, { expectedRevision: revision }),
      saveConfig(second, { expectedRevision: revision })
    ]);
    assert.equal(attempts[0].status, 'fulfilled');
    assert.equal(attempts[1].status, 'rejected');
    assert.equal(attempts[1].reason.code, 'config_conflict');
    const saved = await loadConfig();
    assert.equal(saved.routing.activeTrafficPercent, 20);
    assert.notEqual(getConfigRevision(saved), revision);
    assert.equal(getConfigRevision(saved), getConfigRevision(attempts[0].value));
    assert.ok(!JSON.stringify(saved).includes('expectedRevision'));
    await writeFile(process.env.CONFIG_PATH, JSON.stringify({ ...saved, routing: { ...saved.routing, activeTrafficPercent: 50 } }));
    await assert.rejects(saveConfig(second, { expectedRevision: getConfigRevision(saved) }), { code: 'config_conflict' });
    assert.equal((await loadConfig()).routing.activeTrafficPercent, 50);
    // Compatibility: unconditional maintenance clients still save and advance revision.
    const legacy = await saveConfig(second);
    assert.equal((await loadConfig()).routing.activeTrafficPercent, 30);
    assert.equal(getConfigRevision(legacy), getConfigRevision(await loadConfig()));
  } finally {
    if (oldPath === undefined) delete process.env.CONFIG_PATH; else process.env.CONFIG_PATH = oldPath;
    await rm(directory, { recursive: true, force: true });
  }
});

test('change review follows model IDs, ignores object key order and software version, masks secrets', () => {
  const a = { version: '1', models: [{ id: 'a', enabled: true }, { id: 'b', quality: { default: .8 } }], judge: { apiKey: 'old' } };
  const b = { judge: { apiKey: 'new' }, models: [{ id: 'b', quality: { default: .9 } }, { id: 'a', enabled: true }], version: '2' };
  const changes = configurationChanges(a, b);
  assert.deepEqual(changes.map(c => c.path), ['models.b.quality.default', 'judge.apiKey']);
  assert.equal(changes[0].before, .8);
  assert.equal(changes[0].after, .9);
  assert.equal(changes[1].before, '敏感值（隐藏）');
  assert.equal(changes[1].after, '敏感值（隐藏）');
});
