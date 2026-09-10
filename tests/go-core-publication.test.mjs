import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createSnapshotPublisher } from '../src/go-runtime/publisher.mjs';
import { loadConfig } from '../src/config.mjs';
import { encodeSnapshot, atomicSnapshot } from '../src/go-runtime/snapshot.mjs';

const rev = c => '"' + c.repeat(64) + '"';
test('snapshot publication CAS, rollback, uncertain outcome, recovery and concurrent writers', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'amr-publish-'));
  const original = process.env.CONFIG_PATH;
  try {
    const source = resolve(dir, 'router.json'), output = resolve(dir, 'runtime.json');
    await writeFile(source, await readFile(new URL('../config/router.json', import.meta.url)));
    process.env.CONFIG_PATH = source;
    const old = encodeSnapshot(await loadConfig());
    await atomicSnapshot(output, old.data);
    let state = { status: 200, revision: rev('a'), configRevision: old.revision }, mode = 'ok', posts = 0;
    const call = async (path, method) => {
      if (method !== 'POST') { if (mode === 'unreachable') throw new Error('offline'); return {...state}; }
      posts++;
      if (mode === 'reject') return {status: 422, error: 'core_control_rejected'};
      if (mode === 'unknown') { mode = 'unreachable'; throw new Error('timeout'); }
      state = {status: 200, revision: rev('b'), configRevision: JSON.parse(await readFile(output, 'utf8')).revision};
      if (mode === 'lost-response') throw new Error('timeout');
      return {...state};
    };
    const publish = createSnapshotPublisher(output, call);
    assert.equal((await publish(rev('c'))).status, 409); assert.equal(posts, 0);
    const sourceConfig = JSON.parse(await readFile(source, 'utf8'));
    sourceConfig.routing.qualityFloor = 0.68;
    await writeFile(source, JSON.stringify(sourceConfig));
    mode = 'reject'; assert.equal((await publish(rev('a'))).status, 422);
    assert.equal(await readFile(output, 'utf8'), old.data);
    await assert.rejects(access(output + '.pending'));
    mode = 'unknown'; await assert.rejects(publish(rev('a')));
    await access(output + '.pending');
    mode = 'reject'; assert.equal((await publish(rev('a'))).status, 422);
    assert.equal(await readFile(output, 'utf8'), old.data);
    mode = 'lost-response'; assert.equal((await publish(rev('a'))).status, 200);
    assert.notEqual(state.configRevision, old.revision);
    await assert.rejects(access(output + '.pending'));
    mode = 'ok'; state.revision = rev('a');
    const outcomes = await Promise.all([publish(rev('a')), publish(rev('a'))]);
    assert.deepEqual(outcomes.map(x => x.status), [200, 409]);
    assert.throws(() => createSnapshotPublisher(source, call));
    await writeFile(source, '{broken');
    const previous = await readFile(output, 'utf8');
    assert.equal((await publish(rev('b'))).status, 422);
    assert.equal(await readFile(output, 'utf8'), previous);
  } finally {
    if (original === undefined) delete process.env.CONFIG_PATH; else process.env.CONFIG_PATH = original;
    await rm(dir, {recursive: true, force: true});
  }
});
