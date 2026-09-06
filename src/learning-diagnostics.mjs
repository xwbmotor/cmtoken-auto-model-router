// Diagnose already-frozen predictions. This module never fits or selects a threshold.
import { validateRoutingMatrix } from './routing-matrix.mjs';

export class LearningDiagnosticsValidationError extends Error {
  constructor(path, message) {
    super(`${path}: ${message}`);
    this.name = 'LearningDiagnosticsValidationError';
  }
}

function check(condition, path, message) {
  if (!condition) throw new LearningDiagnosticsValidationError(path, message);
}

function record(value, path) {
  check(value && typeof value === 'object' && !Array.isArray(value), path, 'must be an object');
}

function text(value, path) {
  check(typeof value === 'string' && value.trim().length > 0, path, 'must be a nonempty string');
}

function optionalNumber(value, path, max = Infinity) {
  if (value == null) return null;
  check(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max,
    path, max === 1 ? 'must be a finite probability in [0, 1], or null/missing' : 'must be finite and nonnegative, or null/missing');
  return value;
}

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const groupCount = rows => new Set(rows.map(row => row.groupId)).size;
const ratio = (value, total) => total ? value / total : null;

function coverage(rows, totals) {
  return { tasks: rows.length, groups: groupCount(rows),
    taskCoverageRate: ratio(rows.length, totals.testTasks),
    groupCoverageRate: ratio(groupCount(rows), totals.testGroups) };
}

// Each represented group receives the same total weight; tasks share their group's weight.
// The weights are specific to a metric's matched cohort, including its missingness pattern.
function weighted(rows) {
  const counts = new Map();
  for (const row of rows) counts.set(row.groupId, (counts.get(row.groupId) || 0) + 1);
  return rows.map(row => ({ ...row, weight: 1 / (counts.size * counts.get(row.groupId)) }));
}

function probabilityMetrics(rows, totals) {
  const items = weighted(rows);
  const bins = Array.from({ length: 10 }, (_, index) => ({ index, lowerBound: index / 10,
    upperBound: (index + 1) / 10, upperBoundInclusive: index === 9,
    tasks: 0, groups: 0, weight: 0, meanPredictedProbability: null,
    observedSuccessRate: null, absoluteGap: null }));
  let brier = 0, logLoss = 0, infiniteLogLossTasks = 0;
  const members = Array.from({ length: 10 }, () => []);
  for (const row of items) {
    const p = row.successProbability, y = Number(row.observation.success);
    brier += row.weight * (p - y) ** 2;
    // Keep exact endpoint semantics. JSON cannot represent an infinite proper-score loss.
    if ((y === 1 && p === 0) || (y === 0 && p === 1)) infiniteLogLossTasks += 1;
    else logLoss += row.weight * (y ? -Math.log(p) : -Math.log1p(-p));
    members[Math.min(9, Math.floor(p * 10))].push(row);
  }
  let ece = 0;
  bins.forEach((bin, index) => {
    const bucket = members[index];
    bin.tasks = bucket.length;
    bin.groups = groupCount(bucket);
    bin.weight = bucket.reduce((sum, row) => sum + row.weight, 0);
    if (!bucket.length) return;
    bin.meanPredictedProbability = bucket.reduce((sum, row) => sum + row.weight * row.successProbability, 0) / bin.weight;
    bin.observedSuccessRate = bucket.reduce((sum, row) => sum + row.weight * Number(row.observation.success), 0) / bin.weight;
    bin.absoluteGap = Math.abs(bin.meanPredictedProbability - bin.observedSuccessRate);
    ece += bin.weight * bin.absoluteGap;
  });
  return { ...coverage(rows, totals), brier: rows.length ? brier : null,
    logLoss: rows.length && !infiniteLogLossTasks ? logLoss : null,
    logLossStatus: !rows.length ? 'no_data' : infiniteLogLossTasks ? 'infinite' : 'finite',
    infiniteLogLossTasks, ece: rows.length ? ece : null, reliability: bins,
    calibrationEstablished: false };
}

function costMetrics(rows, totals) {
  const items = weighted(rows);
  // Scale before summing so finite nonnegative costs do not overflow via a raw total.
  const scale = rows.reduce((max, row) => Math.max(max, row.estimatedCost, row.observation.cost), 0);
  const scaledMean = items.reduce((sum, row) => sum + row.weight * (scale ? Math.abs(row.estimatedCost - row.observation.cost) / scale : 0), 0);
  return { ...coverage(rows, totals), mae: rows.length ? Math.min(1, scaledMean) * scale : null,
    failedTasksIncluded: rows.filter(row => !row.observation.success).length };
}

function countsByReason(rows) {
  const counts = new Map();
  for (const row of rows) {
    const reason = row.reason ?? 'unspecified';
    counts.set(reason, (counts.get(reason) || 0) + 1);
  }
  return [...counts].sort(([a], [b]) => compare(a, b)).map(([reason, tasks]) => ({ reason, tasks }));
}

function validateBundle(bundle, checked) {
  record(bundle, 'bundle');
  check(Array.isArray(bundle.selections), 'bundle.selections', 'must be an array');
  check(Array.isArray(bundle.unselected), 'bundle.unselected', 'must be an array');
  const seen = new Set(), predictions = [];
  for (const [kind, rows] of [['selections', bundle.selections], ['unselected', bundle.unselected]]) {
    rows.forEach((row, index) => {
      const path = `bundle.${kind}[${index}]`;
      record(row, path);
      text(row.taskId, `${path}.taskId`);
      const task = checked.tasks.get(row.taskId);
      check(task?.split === 'test', `${path}.taskId`, 'must identify a declared test task');
      check(!seen.has(row.taskId), `${path}.taskId`, 'duplicate task across selections/unselected');
      seen.add(row.taskId);
      if (row.reason !== undefined) text(row.reason, `${path}.reason`);
      for (const key of ['fallback', 'qualityGateSatisfied']) {
        if (row[key] !== undefined) check(typeof row[key] === 'boolean', `${path}.${key}`, 'must be boolean when present');
      }
      if (row.eligibleCandidateIds !== undefined) {
        check(Array.isArray(row.eligibleCandidateIds), `${path}.eligibleCandidateIds`, 'must be an array');
        const eligible = new Set();
        row.eligibleCandidateIds.forEach((id, i) => {
          check(checked.candidates.has(id), `${path}.eligibleCandidateIds[${i}]`, 'unknown candidate');
          check(!eligible.has(id), `${path}.eligibleCandidateIds[${i}]`, 'duplicate candidate');
          eligible.add(id);
        });
      }
      if (kind === 'unselected') {
        // A future producer must explicitly extend this contract before retaining such rows.
        check(row.predictions === undefined, `${path}.predictions`, 'unselected predictions are not supported by this selections-only diagnostic contract');
        return;
      }
      check(checked.candidates.has(row.candidateId), `${path}.candidateId`, 'unknown selected candidate');
      if (row.predictions === undefined) return;
      check(Array.isArray(row.predictions), `${path}.predictions`, 'must be an array when present');
      const candidates = new Set();
      row.predictions.forEach((prediction, j) => {
        const p = `${path}.predictions[${j}]`;
        record(prediction, p);
        check(checked.candidates.has(prediction.candidateId), `${p}.candidateId`, 'unknown candidate');
        check(!candidates.has(prediction.candidateId), `${p}.candidateId`, 'duplicate candidate prediction');
        candidates.add(prediction.candidateId);
        const successProbability = optionalNumber(prediction.successProbability, `${p}.successProbability`, 1);
        const estimatedCost = optionalNumber(prediction.estimatedCost, `${p}.estimatedCost`);
        for (const key of ['qualityModelStatus', 'calibrationStatus']) if (prediction[key] !== undefined) text(prediction[key], `${p}.${key}`);
        predictions.push({ taskId: task.taskId, groupId: task.groupId, candidateId: prediction.candidateId,
          successProbability, estimatedCost, observation: task.observations.get(prediction.candidateId) ?? null });
      });
    });
  }
  return { predictions, reportedTasks: seen.size };
}

/** Call after provenance/manifest merge validation; this function only diagnoses frozen test predictions. */
export function analyzeLearningPredictions(matrix, bundle) {
  const checked = validateRoutingMatrix(matrix);
  const { predictions, reportedTasks } = validateBundle(bundle, checked);
  const testTasks = [...checked.tasks.values()].filter(task => task.split === 'test');
  const totals = { testTasks: testTasks.length, testGroups: groupCount(testTasks),
    candidates: checked.candidates.size, testTaskCandidatePairs: testTasks.length * checked.candidates.size,
    observedTestTaskCandidatePairs: testTasks.reduce((sum, task) => sum + task.observations.size, 0),
    savedPredictionPairs: predictions.length };
  const candidates = [...checked.candidates.keys()].sort(compare).map(candidateId => {
    const rows = predictions.filter(row => row.candidateId === candidateId);
    const observed = testTasks.filter(task => task.observations.has(candidateId));
    const probabilities = rows.filter(row => row.successProbability !== null);
    const costs = rows.filter(row => row.estimatedCost !== null);
    const matchedProbabilities = probabilities.filter(row => row.observation);
    const matchedCosts = costs.filter(row => row.observation);
    const actual = matchedCosts.filter(row => row.observation.costBasis === 'actual');
    const estimated = matchedCosts.filter(row => row.observation.costBasis === 'estimated');
    return { candidateId,
      coverage: { declaredTestTasks: totals.testTasks, declaredTestGroups: totals.testGroups,
        observed: coverage(observed, totals), savedPredictions: coverage(rows, totals),
        providedProbabilities: coverage(probabilities, totals), providedCostEstimates: coverage(costs, totals),
        missingPredictionTasks: totals.testTasks - rows.length,
        predictionsWithoutObservation: rows.filter(row => !row.observation).length,
        missingProbabilitiesInSavedPredictions: rows.length - probabilities.length,
        missingCostsInSavedPredictions: rows.length - costs.length },
      probability: probabilityMetrics(matchedProbabilities, totals),
      cost: { currency: matrix.dataset.currency, scope: 'task_total', routerCostIncluded: false,
        predictionBasis: 'estimated', failureCostsIncluded: true,
        targetCostBasis: !matchedCosts.length ? 'none' : actual.length && estimated.length ? 'mixed' : actual.length ? 'actual' : 'estimated',
        allMatchedTargets: costMetrics(matchedCosts, totals),
        actualTargets: costMetrics(actual, totals), estimatedTargets: costMetrics(estimated, totals) } };
  });
  const selected = bundle.selections;
  const fallback = selected.filter(row => row.fallback === true);
  const nonFallback = selected.filter(row => row.fallback === false);
  const passed = selected.filter(row => row.qualityGateSatisfied === true).length;
  const failed = selected.filter(row => row.qualityGateSatisfied === false).length;
  return { schemaVersion: 1, partition: 'test', evidenceKind: matrix.dataset.evidenceKind,
    productionValidated: false, provenanceIsDeclarative: true, calibrationEstablished: false,
    parameterFittingPerformed: false, thresholdSelectionPerformed: false,
    weighting: 'equal total weight per represented groupId; equal task weights within each group, separately for each matched metric cohort',
    probabilityDefinition: 'Brier and natural-log loss on matched predictions; exact incorrect p=0/1 has infinite logLoss represented by null plus logLossStatus=infinite; no clipping',
    reliabilityDefinition: '10 fixed equal-width bins [0,0.1), ... [0.9,1]; bin statistics retain the full matched cohort weights; ECE is sum(bin weight * absolute calibration gap)',
    totals, candidates,
    selectionSummary: { declaredTestTasks: totals.testTasks, selectedTasks: selected.length,
      unselectedTasks: bundle.unselected.length, unreportedTasks: totals.testTasks - reportedTasks,
      selectionCoverageRate: ratio(selected.length, totals.testTasks),
      selectedReasons: countsByReason(selected), unselectedReasons: countsByReason(bundle.unselected),
      fallback: { tasks: fallback.length, nonFallbackTasks: nonFallback.length,
        unknownTasks: selected.length - fallback.length - nonFallback.length,
        rateAmongKnownSelections: ratio(fallback.length, fallback.length + nonFallback.length), reasons: countsByReason(fallback) },
      qualityGate: { passedTasks: passed, failedTasks: failed, unknownSelectedTasks: selected.length - passed - failed,
        passRateAmongKnownSelections: ratio(passed, passed + failed),
        knownGateCoverageAmongTestTasks: ratio(passed + failed, totals.testTasks),
        observedPassesPerDeclaredTestTask: ratio(passed, totals.testTasks),
        interpretation: 'Predicted gate status only; it is not observed task success or a guaranteed success-rate bound.' } },
    limitations: [
      'Only saved selections[].predictions are scored. Missing predictions, outcomes and unselected tasks remain in full test denominators; missing values are never converted to zero.',
      'Candidate eligibility and missingness can produce different evaluation subsets. Candidate scores cannot directly establish relative quality without a common cohort.',
      'Each metric reweights its own represented groups. Declared groupId may fail to capture dependence; fewer groups or narrow coverage weaken interpretation.',
      'Reliability, ECE and proper scores are descriptive held-out diagnostics, not proof of calibration; no confidence bound, improvement test, threshold tuning or production superiority conclusion is produced.',
      'Cost MAE uses total task costs including failed tasks and excludes router cost. Estimated targets are shown separately and cannot establish actual billing accuracy or savings.',
      'Frozen provenance, candidate versions and manifests must be checked by the calling merge stage; source authenticity and independence remain declarative.'
    ] };
}
