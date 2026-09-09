// Offline Node -> Go -> Node -> Go accounting handoff, no production traffic.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { BudgetTracker } from '../../src/budget.mjs';

const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
assert.ok(arg('--binary'), '--binary required');
const binary = resolve(arg('--binary')), directory = mkdtempSync(resolve(tmpdir(), 'amr-rollback-'));
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const run = (command, source, target) => JSON.parse(execFileSync(binary, [command, '--source-frozen', '--source', source, '--target', target, '--source-sha256', hash(source), '--time-zone', 'UTC'], { encoding: 'utf8', windowsHide: true }));
try {
  const node = resolve(directory, 'node-original.json'), wal = resolve(directory, 'first.wal'), restored = resolve(directory, 'node-rollback.json');
  writeFileSync(node, JSON.stringify({ date: new Date().toISOString().slice(0, 10), estimatedSpendYuan: .125, settledActualSpendYuan: 2.123456, settledEstimatedSpendYuan: .75, pricedRequests: 0, unpricedRequests: 0 }));
  const originalHash = hash(node);
  const imported = run('ledger-import', node, wal); const walHash = hash(wal);
  assert.equal(imported.snapshot.actualMicros, 2123456); assert.equal(imported.snapshot.estimatedMicros, 875000);
  const exported = run('ledger-export', wal, restored);
  assert.equal(hash(wal), walHash); assert.equal(hash(node), originalHash); assert.equal(hash(restored), exported.targetSha256);
  const config = { budget: { enabled: true, timeZone: 'UTC', dailyBudgetYuan: 10, ledgerPath: restored } };
  const tracker = await BudgetTracker.create(directory, config);
  const before = tracker.snapshot();
  assert.equal(before.settledActualSpendYuan, 2.123456); assert.equal(before.settledEstimatedSpendYuan, .875);
  assert.equal(before.legacyUnattributedCostYuan, 2.998456); assert.equal(before.pendingReserves, 0);
  await tracker.chargeRouterOverhead(.000123); await tracker.pendingWrite;
  const after = tracker.snapshot();
  assert.equal(after.settledActualSpendYuan, 2.123579); assert.equal(after.settledEstimatedSpendYuan, .875);
  const second = run('ledger-import', restored, resolve(directory, 'second.wal'));
  assert.equal(second.snapshot.actualMicros, 2123579); assert.equal(second.snapshot.estimatedMicros, 875000);
  const report = { at: new Date().toISOString(), productionReady: false, sourceUnchanged: true, actualAndEstimatedPreserved: true, pendingNodeAmountConservativelyCarried: true,
    nodeRestartAcceptsSnapshot: true, newNodeChargePreservedOnReimport: true, countersReset: true, historicalCostAttribution: 'legacy-unattributed', binarySha256: hash(binary) };
  const out = resolve(arg('--out') || 'data/go-migration/rollback-demo.json'); mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally { rmSync(directory, { recursive: true, force: true }); }
