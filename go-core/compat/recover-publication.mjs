// Offline rollback only: stop Go and the sole management writer first.
import { readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { atomicSnapshot } from '../../src/go-runtime/snapshot.mjs';
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--offline-restore-previous') throw new Error('Stop Go and management first, then use --offline-restore-previous <runtime.json>');
const output = resolve(args[1]);
const pending = JSON.parse(await readFile(output + '.pending', 'utf8'));
if (typeof pending.previous !== 'string' || !/^"[a-f0-9]{64}"$/.test(pending.before)) throw new Error('Invalid publication record');
const previous = Buffer.from(pending.previous, 'base64');
const snapshot = JSON.parse(previous.toString('utf8'));
if (!snapshot.features || !/^"[a-f0-9]{64}"$/.test(snapshot.revision)) throw new Error('Invalid previous snapshot');
await atomicSnapshot(output, previous);
await unlink(output + '.pending');
console.log(JSON.stringify({ restoredConfigRevision: snapshot.revision, restartRequired: true }));
