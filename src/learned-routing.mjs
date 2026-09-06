// OFFLINE_ONLY. This module fits recorded business outcomes; it never calls a model
// provider, reads production config, or treats transport success as a quality label.
import { createHash } from 'node:crypto';
import { validateRoutingMatrix } from './routing-matrix.mjs';
import { ROUTING_FEATURE_VERSION, ROUTING_FEATURE_NAMES } from './request-features.mjs';

export const LEARNED_ROUTING_MODEL_VERSION = 'offline-logistic-v1';
const DEFAULTS = Object.freeze({
  qualityFloor: .8, relQualityCap: .05, minTrainGroups: 20, minValidationGroups: 20,
  minClassGroups: 2, l2: .05, costL2: .05, calibrationL2: .1, priorStrength: 1,
  iterations: 400, calibrationIterations: 200, learningRate: .03,
  oodZThreshold: 6, oodRangePadding: .25
});
const EPS = 1e-8;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const sigmoid = value => value >= 0 ? 1 / (1 + Math.exp(-value)) : Math.exp(value) / (1 + Math.exp(value));
const logit = p => Math.log(clamp(p, EPS, 1 - EPS) / (1 - clamp(p, EPS, 1 - EPS)));
const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
const copy = value => JSON.parse(JSON.stringify(value));
function requireThat(condition, message) { if (!condition) throw new Error(`learned-routing: ${message}`); }
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const hash = value => createHash('sha256').update(stableJson(value)).digest('hex');

export function modelArtifactHash(artifact) {
  const { artifactHash, ...content } = artifact;
  return hash(content);
}

function parameters(options) {
  requireThat(options && typeof options === 'object' && !Array.isArray(options), 'options must be an object');
  for (const key of Object.keys(options)) requireThat(Object.hasOwn(DEFAULTS, key), `unknown option ${key}`);
  const p = { ...DEFAULTS, ...options };
  for (const [key, value] of Object.entries(p)) requireThat(typeof value === 'number' && Number.isFinite(value), `${key} must be finite`);
  for (const key of ['qualityFloor', 'relQualityCap']) requireThat(p[key] >= 0 && p[key] <= 1, `${key} must be in [0, 1]`);
  for (const key of ['minTrainGroups', 'minValidationGroups', 'minClassGroups']) requireThat(Number.isInteger(p[key]) && p[key] >= 2, `${key} must be an integer >= 2`);
  for (const key of ['iterations', 'calibrationIterations']) requireThat(Number.isInteger(p[key]) && p[key] >= 1 && p[key] <= 5000, `${key} must be in [1, 5000]`);
  for (const key of ['l2', 'costL2', 'calibrationL2', 'priorStrength']) requireThat(p[key] > 0 && p[key] <= 100, `${key} must be in (0, 100]`);
  requireThat(p.learningRate > 0 && p.learningRate <= .1, 'learningRate must be in (0, .1]');
  requireThat(p.oodZThreshold >= 2 && p.oodZThreshold <= 20, 'oodZThreshold must be in [2, 20]');
  requireThat(p.oodRangePadding >= 0 && p.oodRangePadding <= 2, 'oodRangePadding must be in [0, 2]');
  return p;
}

function validateFeatures(features, names, path = 'features') {
  requireThat(Array.isArray(features) && features.length === names.length, `${path} must have ${names.length} dimensions`);
  features.forEach((value, i) => requireThat(typeof value === 'number' && Number.isFinite(value), `${path}[${i}] must be a finite number`));
}

function validateInput(data) {
  requireThat(data?.featureVersion === ROUTING_FEATURE_VERSION, `featureVersion must be ${ROUTING_FEATURE_VERSION}`);
  requireThat(stableJson(data.featureNames) === stableJson(ROUTING_FEATURE_NAMES), 'featureNames must exactly match the fixed feature schema and order');
  requireThat(Array.isArray(data.tasks), 'tasks must be an array');
  // Reject test before validation/hashing/statistics. Callers must create a separate,
  // non-test fit input; silently filtering a mixed file would hide a broken boundary.
  for (const task of data.tasks) requireThat(['train', 'validation'].includes(task?.split), 'fit input may contain train/validation only; test is forbidden');
  for (const row of data.observations || []) requireThat(row?.split !== 'test', 'test observations are forbidden');
  requireThat(Array.isArray(data.policies) && data.policies.length === 0 && Array.isArray(data.selections) && data.selections.length === 0, 'fit policies and selections must be empty');
  const validated = validateRoutingMatrix(data);
  for (const task of data.tasks) validateFeatures(task.features, data.featureNames, `tasks.${task.taskId}.features`);
  const sourceTasks = new Map(data.tasks.map(task => [task.taskId, task]));
  const candidates = [...validated.candidates.values()].map(copy).sort((a, b) => compare(a.id, b.id));
  const tasks = [...validated.tasks.values()].map(task => ({ ...task, features: [...sourceTasks.get(task.taskId).features] })).sort((a, b) => compare(a.taskId, b.taskId));
  return { candidates, tasks };
}

// Each independent group has equal total weight. Repeating a conversation does not
// multiply its contribution to standardization, fitting, calibration or baseline choice.
function grouped(rows) {
  const counts = new Map();
  for (const row of rows) counts.set(row.groupId, (counts.get(row.groupId) || 0) + 1);
  return rows.map(row => ({ ...row, weight: 1 / (counts.size * counts.get(row.groupId)) }));
}
const groupCount = rows => new Set(rows.map(row => row.groupId)).size;
const mean = (rows, value) => rows.reduce((sum, row) => sum + row.weight * value(row), 0);

function normalizer(tasks, size) {
  const rows = grouped(tasks);
  const means = Array.from({ length: size }, (_, i) => mean(rows, row => row.features[i]));
  const scales = means.map((mu, i) => {
    const variance = mean(rows, row => (row.features[i] - mu) ** 2);
    requireThat(Number.isFinite(variance), `feature ${i} cannot be standardized safely`);
    return variance > EPS ** 2 ? Math.sqrt(variance) : 1;
  });
  return { means, scales, mins: means.map((_, i) => rows.length ? rows.reduce((min, row) => Math.min(min, row.features[i]), Infinity) : 0),
    maxs: means.map((_, i) => rows.length ? rows.reduce((max, row) => Math.max(max, row.features[i]), -Infinity) : 0),
    trainingGroups: groupCount(tasks), trainingTasks: tasks.length, fitSplit: 'train' };
}

function transform(features, norm) {
  return features.map((value, i) => clamp((value - norm.means[i]) / norm.scales[i], -6, 6));
}

function outOfDistribution(features, norm, p) {
  if (!norm.trainingTasks) return ['no_train_feature_support'];
  const reasons = [];
  features.forEach((value, i) => {
    const range = norm.maxs[i] - norm.mins[i];
    if (range <= EPS) {
      if (Math.abs(value - norm.mins[i]) > EPS) reasons.push(`constant_feature_changed:${i}`);
    } else if (value < norm.mins[i] - range * p.oodRangePadding || value > norm.maxs[i] + range * p.oodRangePadding || Math.abs((value - norm.means[i]) / norm.scales[i]) > p.oodZThreshold) {
      reasons.push(`outside_train_support:${i}`);
    }
  });
  return reasons;
}

function fitQuality(rows, size, p, groups, prior) {
  let intercept = logit(prior);
  const weights = Array(size).fill(0);
  // Pseudo observations at the intercept stabilize rare outcomes. L2 acts on slopes.
  const pseudo = p.priorStrength / Math.max(1, groups);
  const step = Math.min(p.learningRate, .5 / (size + 1 + p.l2));
  for (let iteration = 0; iteration < p.iterations; iteration += 1) {
    let biasGradient = pseudo * (2 * sigmoid(intercept) - 1);
    const gradient = weights.map(w => p.l2 * w);
    for (const row of rows) {
      const residual = row.weight * (sigmoid(intercept + dot(weights, row.x)) - Number(row.success));
      biasGradient += residual;
      for (let i = 0; i < size; i += 1) gradient[i] += residual * row.x[i];
    }
    intercept -= step * biasGradient;
    for (let i = 0; i < size; i += 1) weights[i] -= step * gradient[i];
  }
  return { kind: 'regularized_logistic', intercept, weights };
}

function fitCost(rows, size, p, canFit) {
  if (!rows.length) return { kind: 'unavailable', meanCost: null, intercept: 0, weights: Array(size).fill(0), logSmearing: 0 };
  if (rows.every(row => row.cost === rows[0].cost)) return { kind: 'group_weighted_mean', meanCost: rows[0].cost, intercept: 0, weights: Array(size).fill(0), logSmearing: 0 };
  const meanCost = mean(rows, row => row.cost);
  if (!canFit) return { kind: 'group_weighted_mean', meanCost, intercept: 0, weights: Array(size).fill(0), logSmearing: 0 };
  let intercept = mean(rows, row => Math.log1p(row.cost));
  const weights = Array(size).fill(0);
  const step = Math.min(p.learningRate, .25 / (size + 1 + p.costL2));
  for (let iteration = 0; iteration < p.iterations; iteration += 1) {
    let biasGradient = 0;
    const gradient = weights.map(w => p.costL2 * w);
    for (const row of rows) {
      const residual = row.weight * (intercept + dot(weights, row.x) - Math.log1p(row.cost));
      biasGradient += residual;
      for (let i = 0; i < size; i += 1) gradient[i] += residual * row.x[i];
    }
    intercept -= step * biasGradient;
    for (let i = 0; i < size; i += 1) weights[i] -= step * gradient[i];
  }
  // Training-residual smearing reduces the log-to-cost retransformation bias; this
  // remains a cost estimate, not a conditional expectation guarantee.
  const smearing = mean(rows, row => Math.exp(clamp(Math.log1p(row.cost) - intercept - dot(weights, row.x), -40, 40)));
  return { kind: 'log1p_ridge_smearing', meanCost, intercept, weights, logSmearing: Math.log(Math.max(EPS, smearing)) };
}

function qualityMetrics(rows, probability) {
  if (!rows.length) return { groups: 0, tasks: 0, brier: null, logLoss: null, ece: null };
  const bins = Array.from({ length: 10 }, () => ({ weight: 0, probability: 0, success: 0 }));
  let brier = 0, logLoss = 0;
  for (const row of rows) {
    const prob = clamp(probability(row), EPS, 1 - EPS), y = Number(row.success);
    brier += row.weight * (prob - y) ** 2;
    logLoss -= row.weight * (y * Math.log(prob) + (1 - y) * Math.log(1 - prob));
    const bin = bins[Math.min(9, Math.floor(prob * 10))];
    bin.weight += row.weight; bin.probability += row.weight * prob; bin.success += row.weight * y;
  }
  return { groups: groupCount(rows), tasks: rows.length, brier, logLoss,
    ece: bins.reduce((sum, bin) => sum + (bin.weight ? Math.abs(bin.probability - bin.success) : 0), 0) };
}

function calibrate(rows, quality, p) {
  const groups = groupCount(rows);
  const successGroups = groupCount(rows.filter(row => row.success)), failureGroups = groupCount(rows.filter(row => !row.success));
  const raw = row => sigmoid(quality.intercept + dot(quality.weights, row.x));
  const base = { fitSplit: 'validation', independentlyValidated: false, groups, tasks: rows.length, successGroups, failureGroups,
    slope: 1, intercept: 0, rawDiagnostics: qualityMetrics(rows, raw), diagnosticsAreInSample: true };
  if (groups < p.minValidationGroups) return { ...base, status: 'insufficient_validation_groups', calibratedDiagnostics: null };
  if (successGroups < p.minClassGroups || failureGroups < p.minClassGroups) return { ...base, status: 'insufficient_validation_classes', calibratedDiagnostics: null };
  let slope = 1, intercept = 0;
  const step = Math.min(p.learningRate, .01);
  for (let iteration = 0; iteration < p.calibrationIterations; iteration += 1) {
    let dg = p.calibrationL2 * (slope - 1), db = p.calibrationL2 * intercept;
    for (const row of rows) {
      const z = clamp(quality.intercept + dot(quality.weights, row.x), -15, 15);
      const residual = row.weight * (sigmoid(slope * z + intercept) - Number(row.success));
      dg += residual * z; db += residual;
    }
    slope = clamp(slope - step * dg, .05, 10);
    intercept = clamp(intercept - step * db, -10, 10);
  }
  return { ...base, status: 'fit_on_validation', slope, intercept,
    calibratedDiagnostics: qualityMetrics(rows, row => sigmoid(slope * clamp(quality.intercept + dot(quality.weights, row.x), -15, 15) + intercept)) };
}

function panelCoverage(declared, complete, candidateIds) {
  return { declaredTasks: declared.length, completePanelTasks: complete.length, groups: groupCount(complete),
    excluded: declared.filter(task => !candidateIds.every(id => task.observations.has(id))).map(task => ({ taskId: task.taskId, missingCandidates: candidateIds.filter(id => !task.observations.has(id)) })) };
}

function baselineRanking(tasks, candidateIds, split, p) {
  if (!tasks.length) return { selectionSplit: null, ranking: [], samePanel: true };
  const rows = grouped(tasks), groups = groupCount(tasks);
  const ranking = candidateIds.map(candidateId => {
    const rate = mean(rows, row => Number(row.observations.get(candidateId).success));
    return { candidateId, groups, tasks: tasks.length, successRate: rate,
      smoothedSuccessRate: (rate * groups + p.priorStrength) / (groups + 2 * p.priorStrength),
      meanCost: mean(rows, row => row.observations.get(candidateId).cost) };
  }).sort((a, b) => b.smoothedSuccessRate - a.smoothedSuccessRate || a.meanCost - b.meanCost || compare(a.candidateId, b.candidateId));
  return { selectionSplit: split, ranking, samePanel: true, rule: 'group_weighted_smoothed_success_then_cost', qualityGuaranteed: false };
}

export function fitLearningPolicy(data, options = {}) {
  const p = parameters(options), { candidates, tasks } = validateInput(data);
  const candidateIds = candidates.map(candidate => candidate.id), size = data.featureNames.length;
  const declaredTrain = tasks.filter(task => task.split === 'train'), declaredValidation = tasks.filter(task => task.split === 'validation');
  const train = declaredTrain.filter(task => candidateIds.every(id => task.observations.has(id)));
  const validation = declaredValidation.filter(task => candidateIds.every(id => task.observations.has(id)));
  const normalization = normalizer(train, size);
  const validationInDistribution = validation.filter(task => !outOfDistribution(task.features, normalization, p).length);
  const models = candidateIds.map(candidateId => {
    const trainRows = grouped(train.map(task => ({ ...task.observations.get(candidateId), groupId: task.groupId, x: transform(task.features, normalization) })));
    const validationRows = grouped(validationInDistribution.map(task => ({ ...task.observations.get(candidateId), groupId: task.groupId, x: transform(task.features, normalization) })));
    const groups = groupCount(trainRows), successGroups = groupCount(trainRows.filter(row => row.success)), failureGroups = groupCount(trainRows.filter(row => !row.success));
    const successRate = mean(trainRows, row => Number(row.success));
    const prior = (successRate * groups + p.priorStrength) / (groups + 2 * p.priorStrength);
    const reasons = [];
    if (groups < p.minTrainGroups) reasons.push('insufficient_train_groups');
    if (!successGroups || !failureGroups) reasons.push('single_class_or_unobserved');
    else if (successGroups < p.minClassGroups || failureGroups < p.minClassGroups) reasons.push('insufficient_class_groups');
    const quality = reasons.length ? { kind: 'smoothed_constant', intercept: logit(prior), weights: Array(size).fill(0) } : fitQuality(trainRows, size, p, groups, prior);
    return { candidateId, status: reasons.length ? 'conservative_constant' : 'fitted', reasons,
      train: { tasks: trainRows.length, groups, successGroups, failureGroups, weightedSuccessRate: trainRows.length ? successRate : null, smoothedSuccessRate: prior,
        costBasis: { actual: trainRows.filter(row => row.costBasis === 'actual').length, estimated: trainRows.filter(row => row.costBasis === 'estimated').length } },
      quality, cost: fitCost(trainRows, size, p, groups >= p.minTrainGroups), calibration: calibrate(validationRows, quality, p) };
  });
  const baseline = groupCount(validation) >= p.minValidationGroups ? baselineRanking(validation, candidateIds, 'validation', p)
    : baselineRanking(train, candidateIds, 'train', p);
  const coverage = { train: panelCoverage(declaredTrain, train, candidateIds), validation: panelCoverage(declaredValidation, validation, candidateIds),
    calibrationValidationTasks: validationInDistribution.length, excludedOodValidationTasks: validation.length - validationInDistribution.length };
  const blockers = [];
  if (data.dataset.evidenceKind !== 'observed') blockers.push({ code: 'NON_OBSERVED_DATA', message: 'Demo/synthetic evidence does not establish real routing benefit.' });
  if (coverage.train.excluded.length || coverage.validation.excluded.length) blockers.push({ code: 'INCOMPLETE_PANEL', message: 'Missing candidate outcomes exclude tasks from fitting and calibration.' });
  for (const model of models) {
    if (model.status !== 'fitted') blockers.push({ code: 'CONSERVATIVE_CANDIDATE', candidateId: model.candidateId, message: model.reasons.join(', ') });
    if (model.calibration.status !== 'fit_on_validation') blockers.push({ code: 'CALIBRATION_UNAVAILABLE', candidateId: model.candidateId, message: model.calibration.status });
  }
  if (!baseline.ranking.length) blockers.push({ code: 'NO_SUPPORTED_BASELINE', message: 'No common complete train/validation panel supports a fixed baseline.' });
  if (data.observations.some(row => row.costBasis === 'estimated')) blockers.push({ code: 'ESTIMATED_COST_INPUT', message: 'Estimated costs cannot establish actual savings.' });
  const splitDigest = split => hash({ schemaVersion: data.schemaVersion, featureVersion: data.featureVersion, featureNames: data.featureNames, dataset: data.dataset, candidates,
    tasks: tasks.filter(task => task.split === split).map(task => ({ taskId: task.taskId, groupId: task.groupId, split, task: task.task, inputHash: task.inputHash, features: task.features,
      observations: [...task.observations.values()].sort((a, b) => compare(a.candidateId, b.candidateId)) })) });
  const artifact = { schemaVersion: 1, modelVersion: LEARNED_ROUTING_MODEL_VERSION, mode: 'OFFLINE_ONLY', productionValidated: false,
    featureVersion: data.featureVersion, featureNames: [...data.featureNames], parameters: p, dataset: copy(data.dataset), candidates,
    trainInputHash: splitDigest('train'), validationInputHash: splitDigest('validation'),
    fitSplits: [...(train.length ? ['train'] : []), ...(validationInDistribution.length || baseline.selectionSplit === 'validation' ? ['validation'] : [])], testLabelsUsed: false,
    normalization, coverage, models, baseline,
    readiness: { learningReady: models.every(model => model.status === 'fitted' && model.calibration.status === 'fit_on_validation') && !coverage.train.excluded.length && !coverage.validation.excluded.length,
      baselineAvailable: baseline.ranking.length > 0, blockers },
    limitations: ['Feature extraction and labels must be independently audited; dataset provenance is declarative.',
      'Group weighting assumes the declared groups represent dependence; it cannot detect unmarked shared templates.',
      'Validation is used for calibration and baseline selection, so its diagnostics are not independent performance evidence.',
      'Success probabilities and the quality gate are estimates, not guaranteed success-rate bounds.',
      'No test observations are accepted by fitting; held-out evaluation and production validation remain separate.',
      'Linear per-candidate models and marginal OOD checks can miss interactions and joint distribution shift.',
      'Cost regression uses train residual smearing and does not guarantee future task cost or hard budget compliance.'] };
  artifact.artifactHash = modelArtifactHash(artifact);
  return artifact;
}

function validateArtifact(artifact) {
  requireThat(artifact?.schemaVersion === 1 && artifact.modelVersion === LEARNED_ROUTING_MODEL_VERSION, 'unsupported model artifact');
  requireThat(artifact.mode === 'OFFLINE_ONLY' && artifact.productionValidated === false && artifact.testLabelsUsed === false, 'artifact must remain OFFLINE_ONLY and unvalidated for production');
  requireThat(artifact.featureVersion === ROUTING_FEATURE_VERSION && stableJson(artifact.featureNames) === stableJson(ROUTING_FEATURE_NAMES), 'artifact feature schema mismatch');
  requireThat(artifact.artifactHash === modelArtifactHash(artifact), 'artifact hash mismatch');
  parameters(artifact.parameters);
}

export function predictLearnedPolicy(artifact, request) {
  validateArtifact(artifact);
  validateFeatures(request?.features, artifact.featureNames);
  requireThat(Array.isArray(request.eligibleCandidateIds), 'eligibleCandidateIds must be explicitly provided');
  const known = new Set(artifact.candidates.map(candidate => candidate.id));
  requireThat(new Set(request.eligibleCandidateIds).size === request.eligibleCandidateIds.length, 'eligibleCandidateIds contains duplicates');
  for (const id of request.eligibleCandidateIds) requireThat(typeof id === 'string' && known.has(id), `unknown eligible candidate ${String(id)}`);
  const eligible = new Set(request.eligibleCandidateIds);
  const shared = { mode: 'OFFLINE_ONLY', productionValidated: false, probabilityFloorGuaranteed: false, artifactHash: artifact.artifactHash };
  if (!eligible.size) return { ...shared, candidateId: null, reason: 'no_eligible_candidates', fallback: true, qualityGateSatisfied: false, predictions: [] };
  const p = artifact.parameters, norm = artifact.normalization, x = transform(request.features, norm);
  const oodReasons = outOfDistribution(request.features, norm, p);
  const predictions = artifact.models.filter(model => eligible.has(model.candidateId)).map(model => {
    const rawLogit = model.quality.intercept + dot(model.quality.weights, x);
    const calibrated = model.calibration.status === 'fit_on_validation';
    const probability = calibrated ? sigmoid(model.calibration.slope * clamp(rawLogit, -15, 15) + model.calibration.intercept) : sigmoid(rawLogit);
    const cost = model.cost.kind === 'log1p_ridge_smearing' ? Math.expm1(clamp(model.cost.intercept + dot(model.cost.weights, x) + model.cost.logSmearing, 0, 700)) : model.cost.meanCost;
    return { candidateId: model.candidateId, successProbability: clamp(probability, EPS, 1 - EPS), estimatedCost: cost,
      qualityModelStatus: model.status, calibrationStatus: model.calibration.status, calibrationIndependentlyValidated: false };
  });
  const baseline = artifact.baseline.ranking.find(row => eligible.has(row.candidateId));
  const fallback = reason => ({ ...shared, candidateId: baseline?.candidateId ?? null,
    reason: baseline ? reason : 'no_supported_eligible_baseline', fallback: true, qualityGateSatisfied: false,
    baselineSelectionSplit: artifact.baseline.selectionSplit, requestedFallbackReason: reason, oodReasons, predictions });
  if (oodReasons.length) return fallback('out_of_distribution');
  if (predictions.some(row => row.qualityModelStatus !== 'fitted')) return fallback('insufficient_training_support');
  if (predictions.some(row => row.calibrationStatus !== 'fit_on_validation')) return fallback('calibration_unavailable');
  if (artifact.coverage.train.excluded.length || artifact.coverage.validation.excluded.length) return fallback('incomplete_panel');
  const maxProbability = Math.max(...predictions.map(row => row.successProbability));
  const qualified = predictions.filter(row => row.successProbability >= p.qualityFloor && maxProbability - row.successProbability <= p.relQualityCap + 1e-12 && Number.isFinite(row.estimatedCost));
  if (!qualified.length) return fallback('quality_gate_empty');
  qualified.sort((a, b) => a.estimatedCost - b.estimatedCost || b.successProbability - a.successProbability || compare(a.candidateId, b.candidateId));
  return { ...shared, candidateId: qualified[0].candidateId, reason: 'learned_cost_minimization', fallback: false,
    qualityGateSatisfied: true, qualifiedCandidateIds: qualified.map(row => row.candidateId), oodReasons, predictions };
}
