import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const script = join(root, 'scripts', 'mine-decisions.py');
const python = [process.env.CLASSIFIER_PYTHON, join(root, '.venv', 'Scripts', 'python.exe'), join(root, '.venv', 'bin', 'python'), 'python', 'python3']
  .filter(Boolean).find(cmd => (cmd.includes('/') || cmd.includes('\\') ? existsSync(cmd) : true) && spawnSync(cmd, ['-c', 'import json, pathlib'], { windowsHide: true }).status === 0);
const at = offset => new Date(Date.now() - 3600000 + offset * 1000).toISOString();
const decision = (id, offset, extra = {}) => ({ at: at(offset), request: { requestId: id, sessionFingerprint: 's-1', keyFingerprint: 'tenant-1', redactedBody: { messages: [{ role: 'system', head: '不要把system当训练题' }, { role: 'user', head: '用户原题片段', chars: 800 }] } }, decision: { selectedModel: 'model-a', analysis: { task: 'coding', tier: 'simple', confidence: .99, complexity: .2 } }, outcome: { model: 'model-a', ok: true, actualCostYuan: 0, estimatedCostYuan: 99, completionLatencyMs: 300 }, ...extra });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'amr-mine-'));
  const decisions = join(dir, 'decisions'), feedback = join(dir, 'feedback');
  await mkdir(decisions); await mkdir(feedback);
  return { dir, decisions, feedback };
}
const writeRows = (path, rows) => writeFile(path, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
function run(f, options = []) {
  assert.ok(python, 'mine-decisions regression requires a usable Python interpreter');
  const result = spawnSync(python, [script, '--decisions-dir', f.decisions, '--feedback-dir', f.feedback, ...options], { cwd: root, encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' }, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

test('joins latest feedback by requestId, preserves source and distinguishes transport from quality', async () => {
  const f = await fixture();
  try {
    const old = decision('r1', 0, { outcome: { model: 'model-a', ok: false, actualCostYuan: 7 } });
    const newest = decision('r1', 3);
    const unreviewed = decision('r2', 10);
    const synthetic = decision('r3', 20, { source: 'synthetic-test' });
    await writeRows(join(f.decisions, 'decisions-a.jsonl'), [newest, unreviewed, synthetic, old]);
    await writeRows(join(f.feedback, 'feedback-a.jsonl'), [{ at: at(50), requestId: 'r1', rating: 'bad', source: 'manual' }, { at: at(40), requestId: 'r1', rating: 'good', source: 'manual' }, { at: at(51), requestId: 'orphan', rating: 'good', source: 'manual' }, { at: at(52), requestId: 'r3', rating: 'good', source: 'synthetic-test' }]);
    await writeRows(join(f.decisions, 'judge-reviews-a.jsonl'), [{ at: at(45), requestId: 'r1', event: 'quality', judgeModel: 'judge-a', answeredModel: 'model-a', rubricHash: 'rubric1', quality: { correctness: { score: 2, verifiable: true }, completeness: { score: 9, verifiable: false } } }, { at: at(55), requestId: 'r1', event: 'skipped', reason: 'budget' }]);
    const report = JSON.parse(run(f, ['--json']));
    assert.equal(report.coverage.uniqueRequests, 3);
    assert.equal(report.coverage.duplicateDecisionRows, 1);
    assert.equal(report.coverage.duplicateFeedbackRows, 1);
    assert.equal(report.coverage.orphanFeedbackRequests, 1);
    assert.deepEqual(report.coverage.sources, { unknown: 2, synthetic_or_test: 1 });
    const r1 = report.requests.find(r => r.requestId === 'r1');
    assert.equal(r1.transportOutcome.ok, true);
    assert.equal(r1.humanRating, 'bad');
    assert.equal(r1.humanFeedback.sourceVerified, false);
    assert.equal(r1.judgeReview.dimensions.correctness.score, 2);
    assert.equal(r1.judgeReview.dimensions.completeness.score, null);
    assert.equal(r1.latestJudgeEvent.event, 'skipped');
    assert.equal(r1.taskSuccess, null);
    assert.equal(report.requests.find(r => r.requestId === 'r2').evaluationStatus, 'not_evaluated');
    assert.equal(report.requests.find(r => r.requestId === 'r3').humanRating, null);
    const p = report.profiles.find(p => p.dataSource.kind === 'unknown');
    assert.equal(p.actualCostYuan, 0);
    assert.equal(p.estimatedCostYuan, 0, 'actual zero must not fall through to estimated 99');
    assert.equal(p.transportSuccessRate, 1);
    assert.deepEqual(p.humanRatings, { bad: 1 });
    assert.equal(p.judgeScores.correctness.mean, 2);
    assert.equal(p.completionLatencyMs.n, 2);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('default is read-only and explicit export produces review metadata, never training-ready gold rows', async () => {
  const f = await fixture();
  try {
    const input = join(f.decisions, 'decisions-a.jsonl');
    await writeRows(input, [decision('r1', 0)]);
    const before = await readFile(input, 'utf8');
    const stdout = run(f);
    assert.match(stdout, /不能据 HTTP ok 率下调模型质量分/);
    assert.doesNotMatch(stdout, /无（好现象）|真实质量\/成本画像/);
    assert.equal(await readFile(input, 'utf8'), before);
    assert.deepEqual((await readdir(f.dir)).sort(), ['decisions', 'feedback']);
    const out = join(f.dir, 'candidates.jsonl');
    run(f, ['--out', out]);
    const candidate = JSON.parse((await readFile(out, 'utf8')).trim());
    assert.equal(candidate.labelStatus, 'needs_human_review');
    assert.equal(candidate.trainingEligible, false);
    assert.equal(candidate.taskSuccess, null);
    assert.equal(candidate.labelsSuggested.task, 'coding');
    assert.equal(candidate.inputEvidence.latestUserText, '用户原题片段');
    assert.equal(candidate.inputEvidence.userMessages[0].completeness, 'head_only');
    assert.ok(candidate.reviewBlockers.includes('incomplete_input'));
    for (const key of ['text', 'task', 'tier', 'complexity']) assert.equal(Object.hasOwn(candidate, key), false, `${key} must not masquerade as a training label`);
    const protectedWrite = spawnSync(python, [script, '--decisions-dir', f.decisions, '--feedback-dir', f.feedback, '--out', input], { encoding: 'utf8', windowsHide: true, env: { ...process.env, PYTHONUTF8: '1' } });
    assert.notEqual(protectedWrite.status, 0);
    assert.equal(await readFile(input, 'utf8'), before);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('missing identifiers, invalid lines, absent ratings and Judge model mismatches remain visible', async () => {
  const f = await fixture();
  try {
    await writeRows(join(f.decisions, 'decisions-a.jsonl'), [decision('r1', 0, { outcome: {} }), decision(null, 10)]);
    await writeFile(join(f.decisions, 'decisions-b.jsonl'), '{broken\n' + JSON.stringify({ at: 'invalid' }) + '\n' + JSON.stringify({ at: at(0), request: [], decision: [], outcome: [] }) + '\n');
    await writeRows(join(f.feedback, 'feedback-a.jsonl'), [{ at: at(30), requestId: 'r1', rating: 'invalid' }]);
    await writeRows(join(f.decisions, 'judge-reviews-a.jsonl'), [{ at: at(30), requestId: 'r1', event: 'quality', answeredModel: 'different-model', quality: { correctness: { score: 10 } } }]);
    const report = JSON.parse(run(f, ['--json']));
    assert.equal(report.loaded.decisions.invalidJson, 1);
    assert.equal(report.loaded.decisions.invalidTimestamp, 1);
    assert.equal(report.coverage.missingRequestId, 2);
    assert.equal(report.coverage.invalidFeedbackRatings, 1);
    assert.equal(report.coverage.judgeModelMismatch, 1);
    const r1 = report.requests.find(r => r.requestId === 'r1');
    assert.equal(r1.transportOutcome.ok, null);
    assert.equal(r1.evaluationStatus, 'not_evaluated');
    assert.ok(report.profiles.every(p => p.judgeScores.correctness.n === 0));
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('Judge scores from different rubric/model combinations do not receive a pooled quality mean', async () => {
  const f = await fixture();
  try {
    await writeRows(join(f.decisions, 'decisions-a.jsonl'), [decision('r1', 0), decision('r2', 10)]);
    await writeRows(join(f.decisions, 'judge-reviews-a.jsonl'), ['r1', 'r2'].map((rid, i) => ({ at: at(30 + i), requestId: rid, event: 'quality', answeredModel: 'model-a', judgeModel: 'judge-a', rubricHash: `rubric${i}`, quality: { correctness: { score: 5 + i } } })));
    const report = JSON.parse(run(f, ['--json']));
    assert.equal(report.profiles[0].judgeScores.correctness.n, 2);
    assert.equal(report.profiles[0].judgeScores.correctness.mean, null);
    assert.equal(report.profiles[0].judgeAggregationStatus, 'mixed_judge_or_rubric_no_pooled_mean');
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
