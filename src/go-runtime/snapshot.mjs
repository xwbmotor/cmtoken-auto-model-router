import { open, rename, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { runtimeBundle } from './runtime-policy.mjs';

export function encodeSnapshot(config) {
  const bundle = runtimeBundle(config);
  const data = JSON.stringify(bundle) + '\n';
  if (Buffer.byteLength(data) > 2 * 1024 * 1024) throw new Error('Runtime snapshot exceeds Go limit');
  return { data, revision: bundle.revision, models: bundle.features.models.length };
}

export async function atomicSnapshot(output, data) {
  const temporary = resolve(dirname(output), `.amr-runtime-${randomBytes(12).toString('hex')}.tmp`);
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(data); await file.sync(); await file.close(); file = null;
    await rename(temporary, output);
  } finally {
    if (file) await file.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
