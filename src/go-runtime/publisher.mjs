import { readFile, open, unlink, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { configPath, loadConfig } from '../config.mjs';
import { atomicSnapshot, encodeSnapshot } from './snapshot.mjs';

// A single management writer owns this path. The exclusive journal also guards
// separate processes; Go refuses startup while a publication is unresolved.
export function createSnapshotPublisher(path, call) {
  const output = resolve(path), journal = output + '.pending';
  if (output.toLowerCase() === configPath().toLowerCase()) throw new Error('Snapshot must not overwrite source configuration');
  let chain = Promise.resolve();
  async function finish(record, state) {
    if (state.status !== 200) throw new Error('publication_state_unknown');
    if (state.configRevision === record.target && state.revision !== record.before) {
      await unlink(journal);
      return state;
    }
    if (state.revision === record.before) {
      await atomicSnapshot(output, Buffer.from(record.previous, 'base64'));
      await unlink(journal);
      return null;
    }
    throw new Error('publication_state_unknown');
  }
  async function publish(revision) {
    // Recover an interrupted publication from live evidence before another write.
    let pending;
    try { pending = JSON.parse(await readFile(journal, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (pending) await finish(pending, await call('/internal/v1/config'));
    const before = await call('/internal/v1/config');
    if (before.status !== 200) return before;
    if (before.revision !== revision) return { status: 409, error: 'core_revision_conflict' };
    // Require a bootstrapped snapshot; also reject aliases to the source file.
    if ((await realpath(output)).toLowerCase() === (await realpath(configPath())).toLowerCase()) throw new Error('snapshot_source_alias');
    let snapshot;
    try { snapshot = encodeSnapshot(await loadConfig()); }
    catch { return { status: 422, error: 'core_snapshot_invalid' }; }
    const record = { before: before.revision, target: snapshot.revision, previous: (await readFile(output)).toString('base64') };
    const file = await open(journal, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(record)); await file.sync(); } finally { await file.close(); }
    try { await atomicSnapshot(output, snapshot.data); }
    catch (error) { await unlink(journal); throw error; }
    let result;
    try { result = await call('/internal/v1/config/reload', 'POST', revision); }
    catch { /* Outcome is unknown until a read confirms the active generation. */ }
    const state = await call('/internal/v1/config');
    // Idempotent publication may retain the exact same generation revision.
    if (result?.status === 200 && state.status === 200 && state.revision === result.revision && state.configRevision === snapshot.revision) {
      await unlink(journal); return state;
    }
    const recovered = await finish(record, state);
    return recovered || { status: result?.status === 200 ? 502 : (result?.status || 502), error: result?.error || 'core_publication_unconfirmed' };
  }
  return revision => {
    const task = chain.then(() => publish(revision));
    chain = task.catch(() => {});
    return task;
  };
}
