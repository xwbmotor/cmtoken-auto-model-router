import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { analyzeLearningPredictions, LearningDiagnosticsValidationError } from '../src/learning-diagnostics.mjs';

// Pure arithmetic fixtures, never evidence of model quality or business success.
function fixture() {
  const matrix = { schemaVersion: 1,
    dataset: { id: 'diagnostics-fixture', evidenceKind: 'synthetic', currency: 'CNY', costScope: 'task_total',
      successBasis: 'task_check', successDefinition: 'Synthetic arithmetic fixture only',
      collectionProtocolRef: 'fixture:collection', splitProtocolRef: 'fixture:split' },
    candidates: ['a', 'b'].map(id => ({ id, model: `fixture-${id}`, modelVersion: 'fixture-1', inference: {} })),
    tasks: ['t1', 't2', 't3'].map((taskId, i) => ({ taskId, groupId: i < 2 ? 'g1' : 'g2', split: 'test', task: 'fixture',
      inputHash: createHash('sha256').update(taskId).digest('hex') })),
    observations: ['t1', 't2', 't3'].flatMap((taskId, i) => ['a', 'b'].map(candidateId => ({ taskId, candidateId,
      success: i !== 1, cost: [2, 4, 8][i], costBasis: i === 2 ? 'estimated' : 'actual', latencyMs: 1,
      observedAt: '2026-09-07T00:00:00Z', evidenceRef: `fixture:${taskId}:${candidateId}` }))),
    policies: [], selections: [] };
  const bundle = { selections: matrix.tasks.map((task, i) => ({ taskId: task.taskId, candidateId: 'a',
    reason: i === 1 ? 'quality_gate_empty' : 'learned_cost_minimization', fallback: i === 1, qualityGateSatisfied: i !== 1,
    routerCost: 500, predictions: ['a', 'b'].map(candidateId => ({ candidateId,
      successProbability: [.8, .2, .5][i], estimatedCost: [1, 2, 5][i],
      qualityModelStatus: 'fitted', calibrationStatus: 'fit_on_validation' })) })), unselected: [] };
  return { matrix, bundle };
}

const near = (actual, expected) => assert.ok(typeof actual === 'number' && Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
const candidate = (report, id = 'a') => report.candidates.find(row => row.candidateId === id);

test('hand-computed grouped Brier, natural log loss, reliability/ECE, cost and gate diagnostics', () => {
  const { matrix, bundle } = fixture();
  const report = analyzeLearningPredictions(matrix, bundle), row = candidate(report);
  // g1 has two tasks of weight 1/4 each; g2 has one task of weight 1/2.
  near(row.probability.brier, .25 * .04 + .25 * .04 + .5 * .25);
  near(row.probability.logLoss, -.5 * Math.log(.8) - .5 * Math.log(.5));
  near(row.probability.ece, .25 * .2 + .25 * .2 + .5 * .5);
  assert.equal(row.probability.reliability.length, 10);
  assert.equal(row.probability.reliability[8].tasks, 1);
  near(row.probability.reliability[8].weight, .25);
  near(row.probability.reliability[8].meanPredictedProbability, .8);
  assert.equal(row.probability.reliability[8].observedSuccessRate, 1);
  assert.equal(row.probability.reliability[0].meanPredictedProbability, null);
  assert.equal(row.probability.reliability[9].upperBoundInclusive, true);
  near(row.cost.allMatchedTargets.mae, .25 * 1 + .25 * 2 + .5 * 3);
  near(row.cost.actualTargets.mae, 1.5);
  near(row.cost.estimatedTargets.mae, 3);
  assert.equal(row.cost.actualTargets.failedTasksIncluded, 1);
  assert.equal(row.cost.routerCostIncluded, false);
  assert.equal(row.cost.targetCostBasis, 'mixed');
  assert.deepEqual(report.totals, { testTasks: 3, testGroups: 2, candidates: 2,
    testTaskCandidatePairs: 6, observedTestTaskCandidatePairs: 6, savedPredictionPairs: 6 });
  assert.equal(report.selectionSummary.fallback.tasks, 1);
  assert.deepEqual(report.selectionSummary.fallback.reasons, [{ reason: 'quality_gate_empty', tasks: 1 }]);
  near(report.selectionSummary.qualityGate.passRateAmongKnownSelections, 2 / 3);
  assert.equal(report.productionValidated, false);
  assert.equal(report.calibrationEstablished, false);
  assert.equal(report.thresholdSelectionPerformed, false);
  assert.equal(report.provenanceIsDeclarative, true);
});

test('replicating an entire group changes task counts but not grouped scores or reliability weights', () => {
  const { matrix, bundle } = fixture(), original = analyzeLearningPredictions(matrix, bundle);
  for (const oldId of ['t1', 't2']) {
    const taskId = `${oldId}-repeat`;
    matrix.tasks.push({ ...matrix.tasks.find(row => row.taskId === oldId), taskId });
    matrix.observations.push(...matrix.observations.filter(row => row.taskId === oldId).map(row => ({ ...row, taskId })));
    bundle.selections.push({ ...structuredClone(bundle.selections.find(row => row.taskId === oldId)), taskId });
  }
  const repeated = analyzeLearningPredictions(matrix, bundle), a = candidate(original), b = candidate(repeated);
  near(b.probability.brier, a.probability.brier);
  near(b.probability.logLoss, a.probability.logLoss);
  near(b.probability.ece, a.probability.ece);
  near(b.cost.allMatchedTargets.mae, a.cost.allMatchedTargets.mae);
  assert.equal(b.probability.tasks, 5);
  assert.equal(b.probability.groups, 2);
});

test('reliability bins retain global group weights instead of reweighting each bin equally', () => {
  const { matrix, bundle } = fixture();
  bundle.selections[0].predictions[0].successProbability = .52;
  bundle.selections[1].predictions[0].successProbability = .54;
  bundle.selections[2].predictions[0].successProbability = .56;
  const row = candidate(analyzeLearningPredictions(matrix, bundle));
  const bin = row.probability.reliability[5];
  near(bin.meanPredictedProbability, .25 * .52 + .25 * .54 + .5 * .56);
  near(bin.observedSuccessRate, .75);
  near(bin.weight, 1);
  near(row.probability.ece, .75 - (.25 * .52 + .25 * .54 + .5 * .56));
});

test('missing probabilities, costs, outcomes and candidate eligibility subsets have independent denominators', () => {
  const { matrix, bundle } = fixture();
  bundle.selections[0].predictions[0].successProbability = null;
  delete bundle.selections[1].predictions[0].successProbability;
  bundle.selections[0].predictions[0].estimatedCost = null;
  bundle.selections[1].predictions = bundle.selections[1].predictions.filter(row => row.candidateId === 'a');
  matrix.observations = matrix.observations.filter(row => !(row.taskId === 't3' && row.candidateId === 'b'));
  const report = analyzeLearningPredictions(matrix, bundle), a = candidate(report), b = candidate(report, 'b');
  assert.equal(a.coverage.missingProbabilitiesInSavedPredictions, 2);
  assert.equal(a.probability.tasks, 1);
  assert.equal(a.probability.groups, 1);
  near(a.probability.taskCoverageRate, 1 / 3);
  near(a.probability.brier, .25);
  assert.equal(a.cost.allMatchedTargets.tasks, 2);
  near(a.cost.allMatchedTargets.mae, 2.5);
  assert.equal(b.coverage.missingPredictionTasks, 1);
  assert.equal(b.coverage.predictionsWithoutObservation, 1);
  assert.equal(b.probability.tasks, 1);
  assert.equal(b.cost.allMatchedTargets.tasks, 1);
  assert.equal(report.totals.testTaskCandidatePairs, 6);
  assert.equal(report.totals.observedTestTaskCandidatePairs, 5);
  assert.ok(report.limitations.some(text => text.includes('different evaluation subsets')));
});

test('unselected and missing prediction tasks stay visible without fabricated scores or fallback flags', () => {
  const { matrix, bundle } = fixture();
  const removed = bundle.selections.pop();
  bundle.unselected.push({ taskId: removed.taskId, reason: 'no_eligible_candidates', eligibleCandidateIds: [] });
  delete bundle.selections[0].predictions;
  delete bundle.selections[0].fallback;
  delete bundle.selections[0].qualityGateSatisfied;
  const report = analyzeLearningPredictions(matrix, bundle);
  assert.equal(report.selectionSummary.unselectedTasks, 1);
  assert.equal(report.selectionSummary.unreportedTasks, 0);
  assert.equal(report.selectionSummary.fallback.unknownTasks, 1);
  assert.equal(report.selectionSummary.qualityGate.unknownSelectedTasks, 1);
  assert.equal(report.selectionSummary.qualityGate.passRateAmongKnownSelections, 0);
  assert.equal(candidate(report).coverage.missingPredictionTasks, 2);
  near(candidate(report).probability.taskCoverageRate, 1 / 3);
  assert.deepEqual(report.selectionSummary.unselectedReasons, [{ reason: 'no_eligible_candidates', tasks: 1 }]);
});

test('no outcomes, no predictions and no test partition return explicit null metrics', () => {
  const { matrix, bundle } = fixture();
  matrix.observations = [];
  let report = analyzeLearningPredictions(matrix, bundle);
  assert.equal(candidate(report).probability.brier, null);
  assert.equal(candidate(report).probability.logLossStatus, 'no_data');
  assert.equal(candidate(report).probability.ece, null);
  assert.equal(candidate(report).cost.allMatchedTargets.mae, null);
  assert.equal(candidate(report).coverage.predictionsWithoutObservation, 3);
  report = analyzeLearningPredictions(matrix, { selections: [], unselected: [] });
  assert.equal(report.selectionSummary.unreportedTasks, 3);
  assert.equal(report.selectionSummary.qualityGate.passRateAmongKnownSelections, null);
  for (const task of matrix.tasks) task.split = 'train';
  report = analyzeLearningPredictions(matrix, { selections: [], unselected: [] });
  assert.equal(report.totals.testTasks, 0);
  assert.equal(candidate(report).probability.taskCoverageRate, null);
  assert.equal(report.selectionSummary.selectionCoverageRate, null);
  assert.doesNotThrow(() => JSON.stringify(report));
});

test('endpoint probabilities score exactly and certain errors are explicitly infinite, never NaN or fake zero', () => {
  const { matrix, bundle } = fixture();
  for (let i = 0; i < 3; i++) bundle.selections[i].predictions[0].successProbability = i === 1 ? 0 : 1;
  let row = candidate(analyzeLearningPredictions(matrix, bundle));
  assert.equal(row.probability.brier, 0);
  assert.equal(row.probability.logLoss, 0);
  assert.equal(row.probability.ece, 0);
  assert.equal(row.probability.reliability[9].tasks, 2);
  bundle.selections[0].predictions[0].successProbability = 0;
  const report = analyzeLearningPredictions(matrix, bundle);
  row = candidate(report);
  assert.equal(row.probability.logLoss, null);
  assert.equal(row.probability.logLossStatus, 'infinite');
  assert.equal(row.probability.infiniteLogLossTasks, 1);
  near(row.probability.brier, .25);
  assert.equal(JSON.parse(JSON.stringify(report)).candidates[0].probability.logLossStatus, 'infinite');
});

test('reject every invalid probability/cost, including unchosen candidates and predictions without outcomes', () => {
  for (const key of ['successProbability', 'estimatedCost']) {
    for (const value of [NaN, Infinity, -Infinity, -1, '0.5', true, {}, ...(key === 'successProbability' ? [1.01] : [])]) {
      const { matrix, bundle } = fixture();
      matrix.observations = matrix.observations.filter(row => row.candidateId !== 'b');
      bundle.selections[0].predictions[1][key] = value;
      assert.throws(() => analyzeLearningPredictions(matrix, bundle), error => error instanceof LearningDiagnosticsValidationError && error.message.includes(key));
    }
  }
});

test('finite extreme nonnegative costs keep MAE finite without dropping failed tasks', () => {
  const { matrix, bundle } = fixture();
  for (const row of matrix.observations) row.cost = Number.MAX_VALUE;
  for (const row of bundle.selections) for (const prediction of row.predictions) prediction.estimatedCost = 0;
  const row = candidate(analyzeLearningPredictions(matrix, bundle));
  assert.equal(row.cost.allMatchedTargets.mae, Number.MAX_VALUE);
  assert.equal(row.cost.allMatchedTargets.failedTasksIncluded, 1);
});

test('duplicate and unknown task/candidate IDs, non-test selections and invalid gate flags are rejected', () => {
  const edits = [
    b => b.selections.push(structuredClone(b.selections[0])),
    b => b.unselected.push({ taskId: b.selections[0].taskId }),
    b => { b.selections[0].taskId = 'unknown'; },
    b => { b.selections[0].candidateId = 'unknown'; },
    b => { b.selections[0].predictions[1].candidateId = 'unknown'; },
    b => b.selections[0].predictions.push(structuredClone(b.selections[0].predictions[0])),
    b => { b.selections[0].fallback = 1; },
    b => { b.selections[0].qualityGateSatisfied = 'true'; },
    b => { b.selections[0].predictions = null; },
    b => { b.selections[0].eligibleCandidateIds = ['a', 'a']; },
    b => { b.selections[0].eligibleCandidateIds = ['unknown']; }
  ];
  for (const edit of edits) {
    const { matrix, bundle } = fixture(); edit(bundle);
    assert.throws(() => analyzeLearningPredictions(matrix, bundle), LearningDiagnosticsValidationError);
  }
  const { matrix, bundle } = fixture();
  for (const task of matrix.tasks) task.split = 'train';
  assert.throws(() => analyzeLearningPredictions(matrix, bundle), /declared test task/);
});

test('diagnostics do not mutate frozen inputs or depend on outcomes outside test', () => {
  const { matrix, bundle } = fixture();
  const originalMatrix = structuredClone(matrix), originalBundle = structuredClone(bundle);
  const before = analyzeLearningPredictions(matrix, bundle);
  assert.deepEqual(matrix, originalMatrix);
  assert.deepEqual(bundle, originalBundle);
  matrix.tasks.push({ taskId: 'train-only', groupId: 'train-group', split: 'train', task: 'fixture', inputHash: createHash('sha256').update('train-only').digest('hex') });
  matrix.observations.push({ ...matrix.observations[0], taskId: 'train-only', success: false, cost: 12345 });
  assert.deepEqual(analyzeLearningPredictions(matrix, bundle), before);
});
