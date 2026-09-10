// One-shot control-plane export; no server, model call or credential lookup.
import { open, rename, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../../src/config.mjs';
import { runtimeBundle } from './runtime-policy.mjs';

const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
if (!arg('--config') || !arg('--out')) throw new Error('Usage: node go-core/compat/export-runtime.mjs --config <router.json> --out <runtime.json>');
const source = resolve(arg('--config')), output = resolve(arg('--out'));
if (source.toLowerCase() === output.toLowerCase()) throw new Error('Snapshot must not overwrite router configuration');
process.env.CONFIG_PATH = source;
const bundle = runtimeBundle(await loadConfig());
const data = JSON.stringify(bundle) + '\n';
if (Buffer.byteLength(data) > 2 * 1024 * 1024) throw new Error('Runtime snapshot exceeds Go limit');
const temporary = resolve(dirname(output), `.amr-runtime-${randomBytes(12).toString('hex')}.tmp`);
let file;
try {
  file = await open(temporary, 'wx', 0o600);
  await file.writeFile(data, 'utf8'); await file.sync(); await file.close(); file = null;
  await rename(temporary, output);
} finally {
  if (file) await file.close();
  await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
}
console.log(JSON.stringify({ output, revision: bundle.revision, models: bundle.features.models.length, requestAdapterRequired: false }));
