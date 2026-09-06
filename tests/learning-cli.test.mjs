import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { routingInputHash } from '../src/request-features.mjs';
import { prepareRoutingLearningData } from '../src/learning-data.mjs';
import { fitLearningPolicy } from '../src/learned-routing.mjs';
import { makePolicyFile, mergeLearningSelections, fileEvidenceHash, fitEvidenceHash } from '../scripts/learning-policy-files.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
function fixture() {
  const matrix = { schemaVersion: 1,
    dataset: { id: 'synthetic-cli-fixture', evidenceKind: 'synthetic', currency: 'CNY', costScope: 'task_total', successBasis: 'task_check',
      successDefinition: 'Only synthetic software assertions, not model/business evidence', collectionProtocolRef: 'fixture:collection', splitProtocolRef: 'fixture:split' },
    candidates: [
      { id: 'cheap', model: 'fixture-cheap', modelVersion: 'fixture-1', inference: { max_tokens: 1000 } },
      { id: 'strong', model: 'fixture-strong', modelVersion: 'fixture-1', inference: { max_tokens: 1000 } }
    ], tasks: [], observations: [], policies: [], selections: [] };
  const requests = { schemaVersion: 1, requests: [] };
  for (const [split, count] of [['train', 80], ['validation', 60], ['test', 8]]) {
    for (let i = 0; i < count; i++) {
      const taskId = `${split}-${i}`, hard = i % 2 === 0;
      const request = { messages: [{ role: 'user', content: hard ? `仅用于软件夹具 ${taskId}：解释代码\n\`\`\`python\nx = [n for n in range(5)]\n\`\`\`` : `仅用于软件夹具 ${taskId}：从订单信息提取订单号` }] };
      const task = { taskId, groupId: `group-${split}-${Math.floor(i / 2)}`, split, task: hard ? 'coding' : 'extraction', inputHash: routingInputHash(request) };
      matrix.tasks.push(task);
      requests.requests.push({ taskId, request, eligibleCandidateIds: ['cheap', 'strong'] });
      for (const candidateId of ['cheap', 'strong']) matrix.observations.push({ taskId, candidateId,
        success: candidateId === 'cheap' ? !hard : i % 9 !== 0, cost: candidateId === 'cheap' ? 1 : 3, costBasis: 'actual',
        latencyMs: candidateId === 'cheap' ? 100 : 300, observedAt: '2026-09-07T00:00:00Z', evidenceRef: `fixture:${taskId}:${candidateId}` });
    }
  }
  return { matrix, requests };
}
async function temp(t) {
  const base = resolve(tmpdir()), dir = await mkdtemp(join(base, 'amr-learning-cli-'));
  t.after(async () => { if (!resolve(dir).startsWith(base + sep)) throw new Error('unexpected temp path'); await rm(dir, { recursive: true, force: true }); });
  return dir;
}
function run(script, args) {
  const result = spawnSync(process.execPath, [join(ROOT, 'scripts', script), ...args], { cwd: ROOT, encoding: 'utf8', timeout: 60000, maxBuffer: 3 * 1024 * 1024 });
  if (result.error) throw result.error;
  return result;
}
function expectCode(result, codes) { assert.ok(codes.includes(result.status), `${result.status}\n${result.stderr}\n${result.stdout}`); }

test('separate CLIs prepare, fit, predict blind features and compare outcomes without claiming demo gains', async t => {
  const dir = await temp(t), { matrix, requests } = fixture();
  const matrixPath = join(dir, 'matrix.json'), requestsPath = join(dir, 'requests.json'), prep = join(dir, 'prepared');
  await writeFile(matrixPath, JSON.stringify(matrix)); await writeFile(requestsPath, JSON.stringify(requests));
  expectCode(run('prepare-routing-learning.mjs', ['--matrix', matrixPath, '--requests', requestsPath, '--out-dir', prep]), [0, 2]);
  const policyPath = join(dir, 'policy.json');
  expectCode(run('train-routing-policy.mjs', ['--input', join(prep, 'fit.json'), '--out', policyPath, '--allow-demo']), [2]);
  const policy = await readJson(policyPath);
  assert.equal(policy.model.productionValidated, false);
  assert.equal(policy.source.fitEvidenceHash, fitEvidenceHash(matrix));
  const blind = await readJson(join(prep, 'blind.json'));
  for (const row of blind.tasks) {
    for (const key of ['task', 'success', 'cost', 'latencyMs', 'evidenceRef', 'answer']) assert.equal(row[key], undefined);
  }
  const selectionsPath = join(dir, 'selections.json');
  expectCode(run('predict-routing-policy.mjs', ['--policy', policyPath, '--input', join(prep, 'blind.json'), '--out', selectionsPath, '--router-cost', '0', '--cost-basis', 'estimated']), [2]);
  const selected = await readJson(selectionsPath);
  assert.equal(selected.selections.length, 8);
  assert.equal(selected.policy.testLabelsUsed, false);
  assert.equal(selected.provenance.productionValidated, false);
  const reportPath = join(dir, 'report.json');
  expectCode(run('analyze-routing-matrix.mjs', ['--input', matrixPath, '--selections', selectionsPath, '--out', reportPath, '--bootstrap', '30']), [2]);
  const report = await readJson(reportPath);
  assert.equal(report.claimAssessment.productionSuperiorityEstablished, false);
  assert.ok(report.strategies.some(s => s.kind === 'predicted'));
  assert.ok(report.claimAssessment.blockers.some(b => b.code === 'NON_OBSERVED_DATA'));
  assert.ok(report.claimAssessment.blockers.some(b => b.code === 'NO_CURRENT_POLICY'));
  assert.ok(report.claimAssessment.blockers.some(b => b.code === 'ESTIMATED_COSTS'));
  assert.ok(report.claimAssessment.blockers.some(b => b.code === 'PARTIAL_ROUTING_LATENCY'));
  assert.equal(report.learningExperiment.modelHash, policy.modelHash);
  const diagnostics = report.learningExperiment.heldOutDiagnostics;
  assert.equal(diagnostics.partition, 'test');
  assert.equal(diagnostics.totals.testTasks, 8);
  assert.equal(diagnostics.parameterFittingPerformed, false);
  assert.equal(diagnostics.calibrationEstablished, false);
  assert.ok(diagnostics.candidates.every(c => Number.isFinite(c.probability.brier)));
  assert.ok(diagnostics.candidates.every(c => c.cost.routerCostIncluded === false));
});

test('changing every test outcome cannot alter fit inputs, model hash or blind features', () => {
  const { matrix, requests } = fixture();
  const first = prepareRoutingLearningData(matrix, requests);
  const changed = structuredClone(matrix);
  for (const row of changed.observations.filter(r => r.taskId.startsWith('test-'))) { row.success = !row.success; row.cost += 1000; row.latencyMs += 1000; row.evidenceRef = 'fixture:changed-test-evidence'; }
  const second = prepareRoutingLearningData(changed, requests);
  assert.deepEqual(second.fit, first.fit);
  assert.deepEqual(second.blind, first.blind);
  assert.equal(fitEvidenceHash(changed), fitEvidenceHash(matrix));
  const a = makePolicyFile(fitLearningPolicy(first.fit), first.fit);
  const b = makePolicyFile(fitLearningPolicy(second.fit), second.fit);
  assert.equal(a.modelHash, b.modelHash);
});

test('fit CLI requires explicit demo opt-in and refuses output overwrite', async t => {
  const dir = await temp(t), { matrix, requests } = fixture();
  const { fit } = prepareRoutingLearningData(matrix, requests);
  const input = join(dir, 'fit.json'), output = join(dir, 'existing.json');
  await writeFile(input, JSON.stringify(fit)); await writeFile(output, 'keep-me');
  const noOptIn = run('train-routing-policy.mjs', ['--input', input, '--out', join(dir, 'unused.json')]);
  expectCode(noOptIn, [1]); assert.match(noOptIn.stderr, /allow-demo/);
  expectCode(run('train-routing-policy.mjs', ['--input', input, '--out', output, '--allow-demo']), [1]);
  assert.equal(await readFile(output, 'utf8'), 'keep-me');
  expectCode(run('train-routing-policy.mjs', ['--input', input, '--out', input, '--allow-demo']), [1]);
  assert.deepEqual(await readJson(input), fit);
});

test('blind predictor rejects outcome fields, unconfirmed eligibility and mismatched snapshots', async t => {
  const dir = await temp(t), { matrix, requests } = fixture();
  const { fit, blind } = prepareRoutingLearningData(matrix, requests);
  const policyPath = join(dir, 'policy.json'), blindPath = join(dir, 'blind.json');
  await writeFile(policyPath, JSON.stringify(makePolicyFile(fitLearningPolicy(fit), fit)));
  const base = ['--policy', policyPath, '--input', blindPath, '--router-cost', '0', '--cost-basis', 'estimated'];
  const polluted = structuredClone(blind); polluted.tasks[0].success = true;
  await writeFile(blindPath, JSON.stringify(polluted));
  const result = run('predict-routing-policy.mjs', [...base, '--out', join(dir, 'polluted.json')]);
  expectCode(result, [1]); assert.match(result.stderr, /不允许字段 success/);
  const unconfirmed = structuredClone(blind); unconfirmed.tasks[0].eligibilitySource = 'requires_confirmation';
  await writeFile(blindPath, JSON.stringify(unconfirmed));
  expectCode(run('predict-routing-policy.mjs', [...base, '--out', join(dir, 'unconfirmed.json')]), [1]);
  const changed = structuredClone(blind); changed.candidates[0].modelVersion = 'fixture-changed';
  await writeFile(blindPath, JSON.stringify(changed));
  const mismatch = run('predict-routing-policy.mjs', [...base, '--out', join(dir, 'mismatch.json')]);
  expectCode(mismatch, [1]); assert.match(mismatch.stderr, /候选快照/);
  const policy = await readJson(policyPath); policy.source.fitEvidenceHash = fileEvidenceHash('different-fit');
  await writeFile(policyPath, JSON.stringify(policy)); await writeFile(blindPath, JSON.stringify(blind));
  const sourceMismatch = run('predict-routing-policy.mjs', [...base, '--out', join(dir, 'source-mismatch.json')]);
  expectCode(sourceMismatch, [1]); assert.match(sourceMismatch.stderr, /来源摘要/);
});

test('selection merge verifies non-test evidence and test manifest, without silently replacing a policy', () => {
  const { matrix, requests } = fixture();
  const { fit, blind } = prepareRoutingLearningData(matrix, requests);
  const policyFile = makePolicyFile(fitLearningPolicy(fit), fit);
  const bundle = { schemaVersion: 1, kind: 'offline-routing-selections',
    policy: { id: 'learned', kind: 'predicted', version: policyFile.modelHash, fitSplits: ['train', 'validation'], selectionMode: 'label_blind_replay', testLabelsUsed: false, selectionEvidenceRef: 'fixture:prediction' },
    taskManifest: blind.tasks.map(({ taskId, groupId, split, inputHash }) => ({ taskId, groupId, split, inputHash })).sort((a, b) => a.taskId.localeCompare(b.taskId)),
    selections: blind.tasks.map(t => ({ policyId: 'learned', taskId: t.taskId, candidateId: 'strong', routerCost: 0, routerLatencyMs: 1, costBasis: 'estimated' })), unselected: [], claimBlockers: [],
    provenance: { ...policyFile.source, modelHash: policyFile.modelHash } };
  assert.equal(mergeLearningSelections(matrix, bundle).matrix.policies.length, 1);
  const changedFit = structuredClone(matrix); changedFit.observations[0].success = !changedFit.observations[0].success;
  assert.throws(() => mergeLearningSelections(changedFit, bundle), /非测试拟合证据/);
  const changedInput = structuredClone(matrix); changedInput.tasks.find(t => t.split === 'test').inputHash = fileEvidenceHash('changed-input');
  assert.throws(() => mergeLearningSelections(changedInput, bundle), /测试任务清单/);
  const merged = mergeLearningSelections(matrix, bundle).matrix;
  assert.throws(() => mergeLearningSelections(merged, bundle), /不能静默覆盖/);
});
