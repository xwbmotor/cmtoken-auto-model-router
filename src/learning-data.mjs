import { validateRoutingMatrix } from './routing-matrix.mjs';
import { ROUTING_FEATURE_VERSION, ROUTING_FEATURE_NAMES, extractRoutingFeatures, routingInputHash } from './request-features.mjs';

export class RoutingLearningDataValidationError extends Error {
  constructor(path, message) {
    super(`${path}: ${message}`);
    this.name = 'RoutingLearningDataValidationError';
  }
}

function check(condition, path, message) {
  if (!condition) throw new RoutingLearningDataValidationError(path, message);
}

function shape(value, path, keys) {
  check(value && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)), path, '必须是普通 JSON 对象');
  for (const key of Object.keys(value)) check(keys.includes(key), `${path}.${key}`, '未支持的字段；请显式转换数据协议');
}

const DATASET_KEYS = ['id', 'evidenceKind', 'currency', 'costScope', 'successBasis', 'successDefinition', 'collectionProtocolRef', 'splitProtocolRef'];
const CANDIDATE_KEYS = ['id', 'model', 'modelVersion', 'provider', 'inference'];
const OBSERVATION_KEYS = ['taskId', 'candidateId', 'success', 'cost', 'costBasis', 'latencyMs', 'observedAt', 'evidenceRef', 'groupId', 'split', 'task', 'inputHash', 'model', 'modelVersion', 'provider', 'inference'];
const OUTCOME_KEYS = new Set(['answer', 'output', 'outcome', 'observations', 'success', 'score', 'cost', 'costBasis', 'latencyMs', 'observedAt', 'evidenceRef', 'taskSuccess']);

function rejectOutcomeParameters(value, path) {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    check(!OUTCOME_KEYS.has(key), `${path}.${key}`, '候选推理配置不能携带结果字段');
    rejectOutcomeParameters(item, `${path}.${key}`);
  }
}

function project(value, keys) {
  return Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, structuredClone(value[key])]));
}

function compare(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

/** Pure preparation: neither output contains raw requests; fit never contains test rows. */
export function prepareRoutingLearningData(matrix, requests) {
  const checked = validateRoutingMatrix(matrix);
  // Matrix analysis accepts its historical extensions. Learning preparation is deliberately
  // narrower so unknown metadata cannot silently enter a supposedly blind feature packet.
  shape(matrix.dataset, 'dataset', DATASET_KEYS);
  matrix.candidates.forEach((candidate, i) => {
    shape(candidate, `candidates[${i}]`, CANDIDATE_KEYS);
    rejectOutcomeParameters(candidate.inference, `candidates[${i}].inference`);
  });
  matrix.tasks.forEach((task, i) => shape(task, `tasks[${i}]`, ['taskId', 'groupId', 'split', 'task', 'inputHash']));
  matrix.observations.forEach((row, i) => shape(row, `observations[${i}]`, OBSERVATION_KEYS));
  for (const split of ['train', 'validation', 'test']) {
    check([...checked.tasks.values()].some((task) => task.split === split), 'tasks', `缺少 ${split} split；不能把测试集用于拟合或调参`);
  }
  shape(requests, 'requestsFile', ['schemaVersion', 'requests']);
  check(requests.schemaVersion === 1, 'requestsFile.schemaVersion', '仅支持版本 1');
  check(Array.isArray(requests.requests), 'requestsFile.requests', '必须是请求数组');
  const byId = new Map();
  const candidateIds = [...checked.candidates.keys()];
  requests.requests.forEach((row, i) => {
    const path = `requestsFile.requests[${i}]`;
    shape(row, path, ['taskId', 'request', 'eligibleCandidateIds']);
    check(typeof row.taskId === 'string' && row.taskId.trim().length > 0, `${path}.taskId`, '必须是非空字符串');
    check(!byId.has(row.taskId), `${path}.taskId`, '请求 taskId 重复');
    const task = checked.tasks.get(row.taskId);
    check(task, `${path}.taskId`, '请求不在冻结任务清单中');
    const inputHash = routingInputHash(row.request);
    check(inputHash === task.inputHash, `${path}.request`, '完整请求 SHA-256 与任务清单不一致；不得在这里重新标记已有结果');
    let eligibleCandidateIds = candidateIds.slice();
    let eligibilitySource = 'requires_confirmation';
    if (row.eligibleCandidateIds !== undefined) {
      check(Array.isArray(row.eligibleCandidateIds), `${path}.eligibleCandidateIds`, '必须是候选数组；空数组表示没有合格候选');
      check(new Set(row.eligibleCandidateIds).size === row.eligibleCandidateIds.length,
        `${path}.eligibleCandidateIds`, '候选 ID 不能重复');
      for (const id of row.eligibleCandidateIds) check(typeof id === 'string' && checked.candidates.has(id), `${path}.eligibleCandidateIds`, '必须是共同面板的子集');
      // Stable panel order, independent of how the caller orders the declaration.
      eligibleCandidateIds = candidateIds.filter((id) => row.eligibleCandidateIds.includes(id));
      eligibilitySource = 'caller_declared';
    }
    byId.set(row.taskId, { inputHash, features: extractRoutingFeatures(row.request), eligibleCandidateIds, eligibilitySource });
  });
  check(byId.size === checked.tasks.size, 'requestsFile.requests', '必须覆盖全部冻结任务；存在缺失请求');

  const tasks = [...checked.tasks.values()].sort((a, b) => compare(a.taskId, b.taskId));
  const fitTasks = [], blindTasks = [], observations = [];
  for (const task of tasks) {
    const request = byId.get(task.taskId);
    check(request, 'requestsFile.requests', '任务缺少原始请求');
    if (task.split === 'test') {
      // Explicit projection: never spread task/observation/dataset into a blind row.
      blindTasks.push({ taskId: task.taskId, groupId: task.groupId, split: 'test', inputHash: request.inputHash,
        features: request.features, eligibleCandidateIds: request.eligibleCandidateIds, eligibilitySource: request.eligibilitySource });
    } else {
      check(task.observations.size === candidateIds.length, `tasks.${task.taskId}`, 'train/validation 必须有完整候选结果面板，不能只保留成功返回的候选');
      fitTasks.push({ taskId: task.taskId, groupId: task.groupId, split: task.split, task: task.task,
        inputHash: request.inputHash, features: request.features });
      for (const id of candidateIds) observations.push(project(task.observations.get(id), OBSERVATION_KEYS));
    }
  }
  const candidates = matrix.candidates.map((candidate) => project(candidate, CANDIDATE_KEYS));
  return {
    fit: { schemaVersion: 1, featureVersion: ROUTING_FEATURE_VERSION, featureNames: [...ROUTING_FEATURE_NAMES],
      dataset: project(matrix.dataset, DATASET_KEYS), candidates: structuredClone(candidates), tasks: fitTasks, observations,
      policies: [], selections: [] },
    blind: { schemaVersion: 1, featureVersion: ROUTING_FEATURE_VERSION, featureNames: [...ROUTING_FEATURE_NAMES],
      datasetId: matrix.dataset.id, candidates: structuredClone(candidates), tasks: blindTasks }
  };
}
