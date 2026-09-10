// One-shot control-plane bootstrap; no server, model call or credential lookup.
import { resolve } from 'node:path';
import { access } from 'node:fs/promises';
import { loadConfig } from '../../src/config.mjs';
import { atomicSnapshot, encodeSnapshot } from '../../src/go-runtime/snapshot.mjs';
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
if (!arg('--config') || !arg('--out')) throw new Error('Usage: node go-core/compat/export-runtime.mjs --config <router.json> --out <runtime.json>');
const source = resolve(arg('--config')), output = resolve(arg('--out'));
if (source.toLowerCase() === output.toLowerCase()) throw new Error('Snapshot must not overwrite router configuration');
try { await access(output + '.pending'); throw new Error('Unresolved publication; reconcile before exporting'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
process.env.CONFIG_PATH = source;
const snapshot = encodeSnapshot(await loadConfig());
await atomicSnapshot(output, snapshot.data);
console.log(JSON.stringify({ output, revision: snapshot.revision, models: snapshot.models, requestAdapterRequired: false }));
