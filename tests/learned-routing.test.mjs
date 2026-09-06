import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fitLearningPolicy, predictLearnedPolicy, modelArtifactHash } from '../src/learned-routing.mjs';
import { ROUTING_FEATURE_VERSION, ROUTING_FEATURE_NAMES } from '../src/request-features.mjs';

// Synthetic mechanism tests only. These labels and costs are not model-quality evidence.
const feature = x => ROUTING_FEATURE_NAMES.map((_, i) => i === 0 ? x : 0);
const near = (a, b, tolerance = 1e-10) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
function input({ train = 40, validation = 24, singleClass = false } = {}) {
  const tasks = [];
  for (const [split, count] of [['train', train], ['validation', validation]]) {
    for (let i = 0; i < count; i += 1) {
      const taskId = `${split}-${String(i).padStart(3, '0')}`, x = .05 + .9 * i / Math.max(1, count - 1);
      tasks.push({ taskId, groupId: taskId, split, task: 'fixture', inputHash: createHash('sha256').update(taskId).digest('hex'), features: feature(x) });
    }
  }
  return {
    schemaVersion: 1, featureVersion: ROUTING_FEATURE_VERSION, featureNames: [...ROUTING_FEATURE_NAMES],
    dataset: { id: 'learning-test-fixture', evidenceKind: 'synthetic', currency: 'CNY', costScope: 'task_total', successBasis: 'task_check', successDefinition: 'Synthetic fixture, not business data', collectionProtocolRef: 'fixture:collection', splitProtocolRef: 'fixture:split' },
    candidates: [{ id: 'cheap', model: 'fixture-small', modelVersion: '1', inference: { effort: 'off' } }, { id: 'strong', model: 'fixture-large', modelVersion: '1', inference: { effort: 'high' } }],
    tasks,
    observations: tasks.flatMap(task => ['cheap', 'strong'].map(candidateId => ({ taskId: task.taskId, candidateId,
      success: singleClass || (candidateId === 'cheap' ? task.features[0] < .65 : task.features[0] > .35),
      cost: candidateId === 'cheap' ? 1 + task.features[0] : 4 + task.features[0] * 2,
      costBasis: 'actual', latencyMs: 200, observedAt: '2026-09-01T00:00:00Z', evidenceRef: `fixture:${task.taskId}:${candidateId}` }))), policies: [], selections: []
  };
}
const options = { qualityFloor: .5, relQualityCap: .05 };
const predict = (model, x, eligibleCandidateIds = ['cheap', 'strong']) => predictLearnedPolicy(model, { features: feature(x), eligibleCandidateIds });

test('deterministic logistic/cost fits survive serialization and select by estimated quality then cost', () => {
  const data = input(), first = fitLearningPolicy(data, options), second = fitLearningPolicy(structuredClone(data), options);
  assert.deepEqual(first, second);
  assert.equal(first.artifactHash, modelArtifactHash(first));
  assert.equal(first.mode, 'OFFLINE_ONLY');
  assert.equal(first.productionValidated, false);
  assert.ok(first.readiness.blockers.some(b => b.code === 'NON_OBSERVED_DATA'));
  assert.ok(first.models.every(m => m.status === 'fitted' && m.calibration.status === 'fit_on_validation' && !m.calibration.independentlyValidated));
  const low = predict(first, .1), high = predict(first, .9);
  assert.equal(low.candidateId, 'cheap');
  assert.equal(high.candidateId, 'strong');
  assert.equal(low.reason, 'learned_cost_minimization');
  assert.equal(high.reason, 'learned_cost_minimization');
  assert.equal(high.probabilityFloorGuaranteed, false);
  assert.deepEqual(predict(JSON.parse(JSON.stringify(first)), .9), high);
  const cheaperLow = low.predictions.find(p => p.candidateId === 'cheap').estimatedCost;
  const cheaperHigh = high.predictions.find(p => p.candidateId === 'cheap').estimatedCost;
  assert.ok(cheaperHigh > cheaperLow, 'cost model should respond to request features in its observed support');
  data.tasks.reverse(); data.observations.reverse(); data.candidates.reverse();
  assert.equal(fitLearningPolicy(data, options).artifactHash, first.artifactHash, 'input row order must not change the fit');
});

test('test is forbidden and validation cannot change train standardization, classifier weights or cost model', () => {
  const data = input(), before = fitLearningPolicy(data, options), changed = structuredClone(data);
  const validationIds = new Set(changed.tasks.filter(t => t.split === 'validation').map(t => t.taskId));
  for (const observation of changed.observations) if (validationIds.has(observation.taskId)) { observation.success = !observation.success; observation.cost += 100; }
  for (const task of changed.tasks) if (task.split === 'validation') task.features[0] += 100;
  const after = fitLearningPolicy(changed, options);
  assert.deepEqual(after.normalization, before.normalization);
  assert.deepEqual(after.models.map(m => [m.quality, m.cost]), before.models.map(m => [m.quality, m.cost]));
  assert.equal(after.trainInputHash, before.trainInputHash);
  assert.notEqual(after.validationInputHash, before.validationInputHash);
  const testTask = structuredClone(data); testTask.tasks[0].split = 'test';
  assert.throws(() => fitLearningPolicy(testTask), /test is forbidden/);
  const testObservation = structuredClone(data); testObservation.observations[0].split = 'test';
  assert.throws(() => fitLearningPolicy(testObservation), /test observations are forbidden/);
  const outcomeInjection = structuredClone(data); outcomeInjection.observations.forEach(o => { o.x = feature(100000); o.weight = 100000; });
  const safe = fitLearningPolicy(outcomeInjection, options);
  assert.deepEqual(safe.models.map(m => [m.quality, m.cost]), before.models.map(m => [m.quality, m.cost]), 'observation metadata cannot override extracted features or group weights');
});

test('duplicating one conversation does not increase its fitting or scaling weight', () => {
  const data = input(), before = fitLearningPolicy(data, options), repeated = structuredClone(data);
  const original = repeated.tasks.find(t => t.split === 'train');
  const observations = repeated.observations.filter(o => o.taskId === original.taskId);
  for (let i = 0; i < 30; i += 1) {
    const taskId = `replica-${i}`;
    repeated.tasks.push({ ...original, taskId, features: [...original.features] });
    repeated.observations.push(...observations.map(o => ({ ...o, taskId, evidenceRef: `fixture:repeat:${i}` })));
  }
  const after = fitLearningPolicy(repeated, options);
  assert.equal(after.normalization.trainingGroups, before.normalization.trainingGroups);
  assert.equal(after.normalization.trainingTasks, before.normalization.trainingTasks + 30);
  before.normalization.means.forEach((v, i) => near(v, after.normalization.means[i]));
  before.normalization.scales.forEach((v, i) => near(v, after.normalization.scales[i]));
  before.models.forEach((model, i) => {
    near(model.quality.intercept, after.models[i].quality.intercept);
    model.quality.weights.forEach((v, j) => near(v, after.models[i].quality.weights[j]));
    near(model.cost.meanCost, after.models[i].cost.meanCost);
    assert.equal(after.models[i].train.groups, model.train.groups);
  });
});

test('small samples, one-class labels and unvalidated calibration return a finite conservative baseline', () => {
  for (const data of [input({ train: 2, validation: 1 }), input({ singleClass: true }), input({ validation: 0 })]) {
    const artifact = fitLearningPolicy(data, options);
    assert.equal(artifact.readiness.learningReady, false);
    const result = predict(artifact, .5, ['strong']);
    assert.equal(result.candidateId, 'strong', 'baseline must respect the explicit eligible subset');
    assert.equal(result.fallback, true);
    assert.equal(result.qualityGateSatisfied, false);
    for (const row of result.predictions) {
      assert.ok(Number.isFinite(row.successProbability));
      assert.ok(row.successProbability > 0 && row.successProbability < 1);
      assert.ok(row.estimatedCost === null || Number.isFinite(row.estimatedCost));
      assert.equal(row.calibrationIndependentlyValidated, false);
    }
  }
  const allFailure = input({ singleClass: true }); allFailure.observations.forEach(o => { o.success = false; o.cost = 0; });
  const failed = predict(fitLearningPolicy(allFailure, options), .5);
  assert.equal(failed.fallback, true);
  assert.ok(failed.predictions.every(p => p.estimatedCost === 0 && p.successProbability > 0));
});

test('eligibility, OOD and empty quality gates cannot silently route outside constraints', () => {
  const artifact = fitLearningPolicy(input(), options);
  assert.throws(() => predict(artifact, .5, ['unknown']), /unknown eligible candidate/);
  assert.throws(() => predict(artifact, .5, ['cheap', 'cheap']), /duplicates/);
  assert.throws(() => predictLearnedPolicy(artifact, { features: feature(.5) }), /explicitly provided/);
  assert.equal(predict(artifact, .5, []).candidateId, null);
  const ood = predict(artifact, 100, ['cheap']);
  assert.equal(ood.reason, 'out_of_distribution');
  assert.equal(ood.candidateId, 'cheap');
  assert.ok(ood.oodReasons.length);
  const changedConstant = feature(.5); changedConstant[13] = 1;
  assert.equal(predictLearnedPolicy(artifact, { features: changedConstant, eligibleCandidateIds: ['cheap', 'strong'] }).reason, 'out_of_distribution');
  const strict = fitLearningPolicy(input(), { ...options, qualityFloor: .999999 });
  const gated = predict(strict, .5, ['strong']);
  assert.equal(gated.reason, 'quality_gate_empty');
  assert.equal(gated.candidateId, 'strong');
  assert.equal(gated.qualityGateSatisfied, false);
});

test('feature/schema errors and missing common panels stay explicit', () => {
  for (const mutate of [d => { d.featureVersion = 'unknown'; }, d => { d.featureNames.reverse(); }, d => { d.tasks[0].features[0] = NaN; }, d => { d.tasks[0].features.pop(); }]) {
    const data = input(); mutate(data); assert.throws(() => fitLearningPolicy(data), /feature/);
  }
  const incomplete = input(); incomplete.observations = incomplete.observations.filter(o => o.candidateId === 'cheap');
  const artifact = fitLearningPolicy(incomplete, options);
  assert.equal(artifact.readiness.baselineAvailable, false);
  assert.ok(artifact.coverage.train.excluded.length > 0);
  assert.equal(predict(artifact, .5).candidateId, null);
  assert.equal(predict(artifact, .5).reason, 'no_supported_eligible_baseline');
  const tampered = fitLearningPolicy(input(), options); tampered.models[0].quality.intercept += 1;
  assert.throws(() => predict(tampered, .5), /artifact hash mismatch/);
  const emptyTrain = fitLearningPolicy(input({ train: 0 }), options);
  assert.equal(emptyTrain.normalization.trainingTasks, 0);
  assert.equal(predict(emptyTrain, .5).fallback, true);
  assert.equal(emptyTrain.trainInputHash.length, 64);
});
