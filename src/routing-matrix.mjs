// Offline only: evaluate recorded task outcomes on one common candidate panel.
// This module neither calls models nor turns transport success into task success.
const SPLITS = ['train', 'validation', 'test'];
const EVIDENCE_KINDS = ['observed', 'demo', 'synthetic'];
const SUCCESS_BASES = ['business_outcome', 'task_check', 'human_review'];
const COST_BASES = ['actual', 'estimated'];

export class RoutingMatrixValidationError extends Error {
  constructor(path, message) {
    super(`${path}: ${message}`);
    this.name = 'RoutingMatrixValidationError';
  }
}

function requireThat(condition, path, message) {
  if (!condition) throw new RoutingMatrixValidationError(path, message);
}

function record(value, path) {
  requireThat(value != null && typeof value === 'object' && !Array.isArray(value), path, '必须是对象');
}

function text(value, path) {
  requireThat(typeof value === 'string' && value.trim().length > 0, path, '必须是非空字符串');
}

function nonnegative(value, path) {
  requireThat(typeof value === 'number' && Number.isFinite(value) && value >= 0, path, '必须是有限非负数，不能用 null 或字符串代替');
}

function enumeration(value, values, path) {
  requireThat(values.includes(value), path, `必须是 ${values.join(' / ')}`);
}

function timestamp(value, path) {
  text(value, path);
  requireThat(/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)), path, '必须是带时区的 ISO 时间');
  return Date.parse(value);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

function compareText(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

function validateJson(value, path) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') return requireThat(Number.isFinite(value), path, 'JSON 参数不能含非有限数');
  requireThat(value && typeof value === 'object', path, '必须是 JSON 值');
  for (const [key, item] of Object.entries(value)) validateJson(item, `${path}.${key}`);
}

export function validateRoutingMatrix(input) {
  record(input, 'matrix');
  requireThat(input.schemaVersion === 1, 'schemaVersion', '仅支持版本 1');
  record(input.dataset, 'dataset');
  for (const key of ['id', 'currency', 'successDefinition', 'collectionProtocolRef', 'splitProtocolRef']) text(input.dataset[key], `dataset.${key}`);
  requireThat(/^[A-Z]{3}$/.test(input.dataset.currency), 'dataset.currency', '使用统一的三位货币代码，例如 CNY；禁止混币');
  enumeration(input.dataset.evidenceKind, EVIDENCE_KINDS, 'dataset.evidenceKind');
  enumeration(input.dataset.successBasis, SUCCESS_BASES, 'dataset.successBasis');
  requireThat(input.dataset.costScope === 'task_total', 'dataset.costScope', '必须为 task_total：包含失败、重试和工具执行所产生的任务费用');
  requireThat(Array.isArray(input.candidates) && input.candidates.length >= 2, 'candidates', '至少需要两个明确的候选模型／推理配置');
  const candidates = new Map();
  const signatures = new Set();
  input.candidates.forEach((candidate, index) => {
    const p = `candidates[${index}]`;
    record(candidate, p);
    for (const key of ['id', 'model', 'modelVersion']) text(candidate[key], `${p}.${key}`);
    requireThat(!candidates.has(candidate.id), `${p}.id`, '候选 ID 重复');
    record(candidate.inference, `${p}.inference`);
    validateJson(candidate.inference, `${p}.inference`);
    if (candidate.provider != null) text(candidate.provider, `${p}.provider`);
    const signature = stableJson([candidate.model, candidate.modelVersion, candidate.provider ?? null, candidate.inference]);
    requireThat(!signatures.has(signature), p, '相同模型、版本、供应商与推理参数不能冒充两个不同候选');
    signatures.add(signature);
    candidates.set(candidate.id, candidate);
  });

  // The independent manifest keeps wholly missing tasks in the coverage denominator.
  requireThat(Array.isArray(input.tasks) && input.tasks.length > 0, 'tasks', '必须提供预先确定的任务清单；不能仅从成功返回的观测推断覆盖分母');
  const tasks = new Map();
  const groupSplits = new Map();
  const inputGroups = new Map();
  input.tasks.forEach((task, index) => {
    const p = `tasks[${index}]`;
    record(task, p);
    for (const key of ['taskId', 'groupId', 'task']) text(task[key], `${p}.${key}`);
    requireThat(!tasks.has(task.taskId), `${p}.taskId`, '任务清单中 taskId 重复');
    requireThat(typeof task.inputHash === 'string' && /^[a-f0-9]{64}$/i.test(task.inputHash), `${p}.inputHash`, '必须是完整任务输入的 SHA-256 摘要');
    enumeration(task.split, SPLITS, `${p}.split`);
    requireThat(!groupSplits.has(task.groupId) || groupSplits.get(task.groupId) === task.split, `${p}.split`, '同一会话／模板 groupId 跨 split，存在泄漏');
    groupSplits.set(task.groupId, task.split);
    const inputHash = task.inputHash.toLowerCase();
    const previousInput = inputGroups.get(inputHash);
    requireThat(!previousInput || (previousInput.split === task.split && previousInput.groupId === task.groupId), `${p}.inputHash`, '相同任务输入跨 split 或被拆到不同独立组，存在泄漏／伪重复');
    inputGroups.set(inputHash, { split: task.split, groupId: task.groupId });
    tasks.set(task.taskId, { taskId: task.taskId, groupId: task.groupId, split: task.split, task: task.task, inputHash, observations: new Map() });
  });

  requireThat(Array.isArray(input.observations), 'observations', '需要观测数组（可为空并报告覆盖不足）；不能直接传入分类标签或路由日志');
  input.observations.forEach((row, index) => {
    const p = `observations[${index}]`;
    record(row, p);
    for (const key of ['taskId', 'candidateId', 'evidenceRef']) text(row[key], `${p}.${key}`);
    enumeration(row.costBasis, COST_BASES, `${p}.costBasis`);
    requireThat(typeof row.success === 'boolean', `${p}.success`, '必须是按业务标准核验的布尔值；HTTP 200、Judge 分数或分类命中不能自动转换为 success');
    nonnegative(row.cost, `${p}.cost`);
    nonnegative(row.latencyMs, `${p}.latencyMs`);
    timestamp(row.observedAt, `${p}.observedAt`);
    requireThat(candidates.has(row.candidateId), `${p}.candidateId`, '未声明的候选');
    const candidate = candidates.get(row.candidateId);
    const task = tasks.get(row.taskId);
    requireThat(task, `${p}.taskId`, '不在预先声明的任务清单内');
    for (const key of ['groupId', 'split', 'task']) if (row[key] !== undefined) requireThat(task[key] === row[key], `${p}.${key}`, '同一 taskId 的候选观测必须与任务清单一致');
    if (row.inputHash !== undefined) requireThat(typeof row.inputHash === 'string' && task.inputHash === row.inputHash.toLowerCase(), `${p}.inputHash`, '同一 taskId 的候选必须执行相同任务输入');
    for (const key of ['model', 'modelVersion', 'provider', 'inference']) if (row[key] !== undefined) requireThat(stableJson(candidate[key]) === stableJson(row[key]), `${p}.${key}`, '实际观测的模型／推理参数必须与候选声明一致');
    requireThat(!task.observations.has(row.candidateId), p, 'taskId + candidateId 重复；重复实验必须使用独立 taskId 并保留共同 groupId');
    task.observations.set(row.candidateId, { ...row, groupId: task.groupId, task: task.task, split: task.split });
  });

  requireThat(Array.isArray(input.policies), 'policies', '必须显式给出策略数组；尚无策略时使用 []');
  const policies = new Map();
  const policyKinds = new Set();
  input.policies.forEach((policy, index) => {
    const p = `policies[${index}]`;
    record(policy, p);
    for (const key of ['id', 'version', 'selectionEvidenceRef']) text(policy[key], `${p}.${key}`);
    enumeration(policy.kind, ['current', 'predicted'], `${p}.kind`);
    requireThat(!policies.has(policy.id) && !policyKinds.has(policy.kind), p, '每种 current / predicted 策略最多一个，且 ID 必须唯一');
    requireThat(Array.isArray(policy.fitSplits), `${p}.fitSplits`, '需要列出拟合或调参使用的 split（外部冻结策略可用 []）');
    requireThat(new Set(policy.fitSplits).size === policy.fitSplits.length, `${p}.fitSplits`, 'split 不能重复');
    for (const split of policy.fitSplits) {
      enumeration(split, ['train', 'validation'], `${p}.fitSplits`);
      requireThat([...tasks.values()].some((task) => task.split === split && task.observations.size > 0), `${p}.fitSplits`, `声明使用 ${split}，但没有该 split 的观测`);
    }
    enumeration(policy.selectionMode, ['before_outcome', 'label_blind_replay'], `${p}.selectionMode`);
    requireThat(policy.testLabelsUsed === false, `${p}.testLabelsUsed`, '必须明确为 false；看过测试结果的预测不能作为可部署路由策略');
    policies.set(policy.id, policy);
    policyKinds.add(policy.kind);
  });

  requireThat(Array.isArray(input.selections), 'selections', '必须显式给出选择数组；尚无策略时使用 []');
  const selections = new Map([...policies.keys()].map((id) => [id, new Map()]));
  input.selections.forEach((row, index) => {
    const p = `selections[${index}]`;
    record(row, p);
    for (const key of ['policyId', 'taskId', 'candidateId']) text(row[key], `${p}.${key}`);
    const policy = policies.get(row.policyId);
    requireThat(policy, `${p}.policyId`, '未声明的策略');
    requireThat(tasks.has(row.taskId), `${p}.taskId`, '没有该任务的观测');
    requireThat(candidates.has(row.candidateId), `${p}.candidateId`, '不在共同候选面板内');
    nonnegative(row.routerCost, `${p}.routerCost`);
    nonnegative(row.routerLatencyMs, `${p}.routerLatencyMs`);
    enumeration(row.costBasis, COST_BASES, `${p}.costBasis`);
    if (policy.selectionMode === 'before_outcome') {
      const selectedAt = timestamp(row.selectedAt, `${p}.selectedAt`);
      const firstOutcome = Math.min(...[...tasks.get(row.taskId).observations.values()].map((observation) => Date.parse(observation.observedAt)));
      requireThat(selectedAt <= firstOutcome, `${p}.selectedAt`, 'before_outcome 策略必须先于该任务的全部候选结果形成');
    } else if (row.selectedAt != null) timestamp(row.selectedAt, `${p}.selectedAt`);
    requireThat(!selections.get(row.policyId).has(row.taskId), p, 'policyId + taskId 重复');
    selections.get(row.policyId).set(row.taskId, row);
  });
  return { candidates, tasks, policies, selections };
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

function metrics(rows) {
  const successes = rows.reduce((n, row) => n + Number(row.success), 0);
  const totalCost = rows.reduce((n, row) => n + row.cost, 0);
  return {
    tasks: rows.length,
    groups: new Set(rows.map((row) => row.groupId)).size,
    successes,
    taskSuccessRate: rows.length ? successes / rows.length : null,
    totalCost,
    meanCostPerTask: rows.length ? totalCost / rows.length : null,
    // Failed attempts consume money too. Never filter costs to successful rows.
    costPerSuccessfulTask: successes ? totalCost / successes : null,
    latencyMs: {
      mean: rows.length ? rows.reduce((n, row) => n + row.latencyMs, 0) / rows.length : null,
      p50: percentile(rows.map((row) => row.latencyMs), 0.5),
      p95: percentile(rows.map((row) => row.latencyMs), 0.95)
    }
  };
}

function bestCandidate(tasks, candidateIds) {
  if (!tasks.length) return null;
  return candidateIds.map((id) => ({ id, ...metrics(tasks.map((task) => task.observations.get(id))) }))
    .sort((a, b) => b.taskSuccessRate - a.taskSuccessRate || a.meanCostPerTask - b.meanCostPerTask || a.latencyMs.mean - b.latencyMs.mean || compareText(a.id, b.id))[0].id;
}

function difference(rows, reference) {
  const a = metrics(rows), b = metrics(reference);
  const pairs = { bothSuccess: 0, candidateOnlySuccess: 0, referenceOnlySuccess: 0, bothFailure: 0 };
  rows.forEach((row, i) => {
    const other = reference[i];
    pairs[row.success ? (other.success ? 'bothSuccess' : 'candidateOnlySuccess') : (other.success ? 'referenceOnlySuccess' : 'bothFailure')] += 1;
  });
  return {
    qualityDeltaPercentagePoints: a.taskSuccessRate == null ? null : (a.taskSuccessRate - b.taskSuccessRate) * 100,
    totalCostDelta: a.totalCost - b.totalCost,
    meanCostPerTaskDelta: a.meanCostPerTask == null ? null : a.meanCostPerTask - b.meanCostPerTask,
    costSavingRate: b.totalCost > 0 ? (b.totalCost - a.totalCost) / b.totalCost : null,
    costPerSuccessfulTaskDelta: a.costPerSuccessfulTask != null && b.costPerSuccessfulTask != null ? a.costPerSuccessfulTask - b.costPerSuccessfulTask : null,
    meanLatencyMsDelta: a.latencyMs.mean == null ? null : a.latencyMs.mean - b.latencyMs.mean,
    pairedOutcomes: pairs
  };
}

// Resample entire groups, preserving policy pairing and within-session dependence.
function pairedBootstrap(rows, reference, iterations, seed) {
  const groups = new Map();
  rows.forEach((row, index) => {
    if (!groups.has(row.groupId)) groups.set(row.groupId, []);
    groups.get(row.groupId).push(index);
  });
  if (groups.size < 2 || iterations === 0) return null;
  const blocks = [...groups.values()];
  let state = seed >>> 0;
  const random = () => {
    state += 0x6D2B79F5;
    let t = Math.imul(state ^ state >>> 15, 1 | state);
    t ^= t + Math.imul(t ^ t >>> 7, 61 | t);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
  const quality = [], cost = [];
  for (let sample = 0; sample < iterations; sample += 1) {
    let size = 0, qualitySum = 0, costSum = 0;
    for (let group = 0; group < blocks.length; group += 1) {
      for (const index of blocks[Math.floor(random() * blocks.length)]) {
        size += 1;
        qualitySum += Number(rows[index].success) - Number(reference[index].success);
        costSum += rows[index].cost - reference[index].cost;
      }
    }
    quality.push(100 * qualitySum / size);
    cost.push(costSum / size);
  }
  return {
    method: 'paired_group_percentile_bootstrap', unit: 'groupId', groups: blocks.length,
    iterations, seed, confidenceLevel: 0.95,
    qualityDeltaPercentagePoints: [percentile(quality, 0.025), percentile(quality, 0.975)],
    meanCostPerTaskDelta: [percentile(cost, 0.025), percentile(cost, 0.975)],
    limitations: '条件于本面板的组级重采样区间，不涵盖标签误差、模型漂移或未观测流量；不提供生产优越性结论。'
  };
}

export function analyzeRoutingMatrix(input, options = {}) {
  const { candidates, tasks, policies, selections } = validateRoutingMatrix(input);
  const selectionSplit = options.selectionSplit ?? 'validation';
  const minTestGroups = options.minTestGroups ?? 30;
  const bootstrapIterations = options.bootstrapIterations ?? 1000;
  const seed = options.seed ?? 42;
  enumeration(selectionSplit, ['train', 'validation'], 'options.selectionSplit');
  requireThat(Number.isInteger(minTestGroups) && minTestGroups >= 2, 'options.minTestGroups', '必须是至少 2 的整数；阈值不是统计证明');
  requireThat(Number.isInteger(bootstrapIterations) && bootstrapIterations >= 0 && bootstrapIterations <= 10000, 'options.bootstrapIterations', '必须是 0..10000 的整数');
  requireThat(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff, 'options.seed', '必须是 uint32');
  const candidateIds = [...candidates.keys()].sort();
  const allTasks = [...tasks.values()].sort((a, b) => compareText(a.taskId, b.taskId));
  const cohorts = new Map();
  const coverage = {};
  for (const split of SPLITS) {
    const declared = allTasks.filter((task) => task.split === split);
    const eligible = [], excluded = [];
    let completePanelTasks = 0;
    for (const task of declared) {
      const missingCandidates = candidateIds.filter((id) => !task.observations.has(id));
      const missingPolicies = split === 'test' ? [...policies.keys()].filter((id) => !selections.get(id).has(task.taskId)) : [];
      if (!missingCandidates.length) completePanelTasks += 1;
      if (missingCandidates.length || missingPolicies.length) excluded.push({ taskId: task.taskId, missingCandidates, missingPolicies });
      else eligible.push(task);
    }
    cohorts.set(split, eligible);
    coverage[split] = {
      declaredTasks: declared.length, completePanelTasks, evaluatedTasks: eligible.length,
      coverageRate: declared.length ? eligible.length / declared.length : null,
      groups: new Set(eligible.map((task) => task.groupId)).size, excluded
    };
  }
  const selectionTasks = cohorts.get(selectionSplit), testTasks = cohorts.get('test');
  const selectedFixed = bestCandidate(selectionTasks, candidateIds);
  const categories = [...new Set(selectionTasks.map((task) => task.task))].sort();
  const selectedByTask = new Map(categories.map((task) => [task, bestCandidate(selectionTasks.filter((item) => item.task === task), candidateIds)]));
  const unseenTestTasks = testTasks.filter((task) => !selectedByTask.has(task.task)).length;
  const rowVectors = new Map();
  const strategies = [];
  const addStrategy = (id, kind, pick, details = {}, policy = null) => {
    const rows = testTasks.map((task) => {
      const candidateId = pick(task);
      const observation = task.observations.get(candidateId);
      const route = policy ? selections.get(policy.id).get(task.taskId) : null;
      return { taskId: task.taskId, groupId: task.groupId, task: task.task, candidateId,
        success: observation.success, cost: observation.cost + (route?.routerCost ?? 0), latencyMs: observation.latencyMs + (route?.routerLatencyMs ?? 0) };
    });
    rowVectors.set(id, rows);
    strategies.push({ id, kind, ...details, metrics: metrics(rows), byTask: Object.fromEntries([...new Set(rows.map((row) => row.task))].sort().map((task) => [task, metrics(rows.filter((row) => row.task === task))])) });
  };
  for (const id of candidateIds) addStrategy(`fixed:${id}`, 'fixed', () => id, { candidateId: id });
  if (selectedFixed) {
    addStrategy('selected_fixed', 'selected_fixed', () => selectedFixed, { selectedOn: selectionSplit, candidateId: selectedFixed });
    addStrategy('task_fixed', 'task_fixed', (task) => selectedByTask.get(task.task) ?? selectedFixed, {
      selectedOn: selectionSplit, candidatesByTask: Object.fromEntries(selectedByTask), unseenTaskFallback: selectedFixed, unseenTestTasks
    });
  }
  for (const policy of policies.values()) addStrategy(`router:${policy.id}`, policy.kind,
    (task) => selections.get(policy.id).get(task.taskId).candidateId,
    { policyId: policy.id, policyVersion: policy.version, fitSplits: policy.fitSplits, selectionMode: policy.selectionMode }, policy);
  addStrategy('oracle', 'oracle', (task) => candidateIds.slice().sort((a, b) => {
    const x = task.observations.get(a), y = task.observations.get(b);
    return Number(y.success) - Number(x.success) || x.cost - y.cost || x.latencyMs - y.latencyMs || compareText(a, b);
  })[0], { deployable: false, description: '事后知道全部观测结果，优先成功，再选成本最低者；全失败时仍计最便宜失败的费用。零路由开销仅用于理想上界。' });

  const current = [...policies.values()].find((policy) => policy.kind === 'current');
  const predicted = [...policies.values()].find((policy) => policy.kind === 'predicted');
  const referenceId = current ? `router:${current.id}` : selectedFixed ? 'selected_fixed' : null;
  const comparisons = referenceId ? strategies.filter((strategy) => strategy.id !== referenceId).map((strategy) => ({
    candidateStrategy: strategy.id, referenceStrategy: referenceId,
    ...difference(rowVectors.get(strategy.id), rowVectors.get(referenceId)),
    ...(strategy.kind === 'predicted' && current ? { bootstrap: pairedBootstrap(rowVectors.get(strategy.id), rowVectors.get(referenceId), bootstrapIterations, seed) } : {})
  })) : [];
  const uniqueSuccessTasks = new Map(candidateIds.map((id) => [id, 0]));
  let noCandidateSuccess = 0;
  for (const task of testTasks) {
    const winners = candidateIds.filter((id) => task.observations.get(id).success);
    if (!winners.length) noCandidateSuccess += 1;
    if (winners.length === 1) uniqueSuccessTasks.set(winners[0], uniqueSuccessTasks.get(winners[0]) + 1);
  }
  const blockers = [];
  const block = (code, message) => blockers.push({ code, message });
  if (input.dataset.evidenceKind !== 'observed') block('NON_OBSERVED_DATA', '演示／合成数据只能检查工具，不能支持真实路由收益结论。');
  if (!testTasks.length) block('NO_COMPLETE_TEST_TASKS', '没有完整候选面板且选择记录齐全的测试任务。');
  if (coverage.test.groups < minTestGroups) block('TOO_FEW_TEST_GROUPS', `独立测试组 ${coverage.test.groups} < ${minTestGroups}；小样本只作探索。`);
  if (coverage.test.excluded.length) block('INCOMPLETE_TEST_COVERAGE', '测试任务被共同面板／选择完整性检查排除；当前结果只适用于覆盖子集，不能外推全部流量。');
  if (!selectedFixed) block('NO_SELECTION_PANEL', `没有完整的 ${selectionSplit} 观测，无法无泄漏地选择固定／按任务基线。`);
  if (coverage[selectionSplit].excluded.length) block('INCOMPLETE_SELECTION_COVERAGE', '基线选择集不完整，缺失可能改变基线。');
  if (unseenTestTasks) block('UNSEEN_TEST_CATEGORIES', `${unseenTestTasks} 条测试任务的类别未出现在基线选择集，已明确使用全局固定模型回退。`);
  if (!current) block('NO_CURRENT_POLICY', '缺少 current 策略，不能衡量相对当前路由的收益。');
  if (!predicted) block('NO_PREDICTED_POLICY', '缺少 predicted 策略，本报告尚不能评价新策略收益。');
  const costEstimates = input.observations.filter((row) => row.costBasis === 'estimated').length + input.selections.filter((row) => row.costBasis === 'estimated').length;
  if (costEstimates) block('ESTIMATED_COSTS', `${costEstimates} 条费用为估算，成本差不能当作已核实的实际净节省。`);

  return {
    schemaVersion: 1, dataset: { ...input.dataset },
    analysis: { selectionSplit, minTestGroups, bootstrapIterations, seed, candidateCount: candidates.size,
      comparisonSplit: 'test', referenceStrategy: referenceId,
      baselineObjective: '在所选非 test split 上先最大化任务成功率，再最小化平均任务成本、平均时延，最后按候选 ID 确定性破同分。',
      costDefinition: '每成功任务成本 = 所有评估任务的总费用（含失败、重试、工具及该策略路由开销）/ 成功任务数；零成功时为 null。',
      latencyDefinition: '完整任务执行 latencyMs + 串行路由决策 routerLatencyMs；不是 TTFT。',
      collectionCost: input.observations.reduce((sum, row) => sum + row.cost, 0),
      collectionCostNote: '构建面板的所有候选观测费用，未包含另行记录的标注／Judge成本；不作为某个单选路由的线上成本。' },
    candidates: [...candidates.values()], coverage, strategies, comparisons,
    headroom: { noCandidateSuccessTasks: noCandidateSuccess,
      uniquelySuccessfulTasksByCandidate: Object.fromEntries(uniqueSuccessTasks),
      oracleComparison: comparisons.find((item) => item.candidateStrategy === 'oracle') ?? null,
      interpretation: 'Oracle差距是当前观测面板内可探索的互补空间，不是保证能达到的收益；Oracle也可能更贵。' },
    claimAssessment: {
      offlineAnalysisEligible: blockers.length === 0,
      productionSuperiorityEstablished: false,
      status: blockers.length ? 'blocked' : 'offline_comparison_only', blockers,
      evidenceVerification: '只校验结构与声明一致性；evidenceRef、标注真实性、label-blind 声明和模型版本未被工具独立核验。',
      requiredNextEvidence: '独立核验结果证据与划分，按业务风险检查分任务质量、成本和时延；生产收益还需代表性流量上的受控验证。通过样本阈值或区间排除零均不等于世界领先。'
    }
  };
}
