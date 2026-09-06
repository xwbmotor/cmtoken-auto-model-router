import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { analyzeRoutingMatrix, RoutingMatrixValidationError } from '../src/routing-matrix.mjs';

// Synthetic fixtures exercise arithmetic and guardrails; no fixture is evidence of model quality.
function matrix() {
  const rows = [
    ['v1', 'validation', 'code', true, true],
    ['v2', 'validation', 'code', false, true],
    ['v3', 'validation', 'support', true, false],
    ['t1', 'test', 'code', true, true],
    ['t2', 'test', 'code', false, true],
    ['t3', 'test', 'support', true, false],
    ['t4', 'test', 'support', false, false]
  ];
  return {
    schemaVersion: 1,
    dataset: { id: 'unit-fixture', evidenceKind: 'demo', currency: 'CNY', costScope: 'task_total', successBasis: 'task_check',
      successDefinition: '任务输出通过预先约定的执行检查', collectionProtocolRef: 'fixture-only', splitProtocolRef: 'fixture-split-only' },
    candidates: [
      { id: 'cheap', model: 'cheap-model', modelVersion: 'fixture-v1', inference: { reasoning_effort: 'off', max_tokens: 1000 } },
      { id: 'strong', model: 'strong-model', modelVersion: 'fixture-v1', inference: { reasoning_effort: 'high', max_tokens: 2000 } }
    ],
    tasks: rows.map(([taskId, split, task]) => ({ taskId, split, task, groupId: `group-${taskId}`, inputHash: createHash('sha256').update(taskId).digest('hex') })),
    observations: rows.flatMap(([taskId, split, task, cheap, strong]) => ['cheap', 'strong'].map((candidateId) => ({
      taskId, split, task, groupId: `group-${taskId}`, inputHash: createHash('sha256').update(taskId).digest('hex'), candidateId,
      success: candidateId === 'cheap' ? cheap : strong, cost: candidateId === 'cheap' ? 1 : 3,
      costBasis: 'actual', latencyMs: candidateId === 'cheap' ? 100 : 300,
      observedAt: '2026-09-06T00:01:00Z', evidenceRef: `fixture:${taskId}:${candidateId}`
    }))),
    policies: ['current', 'predicted'].map((kind) => ({ id: kind, kind, version: 'fixture-v1', fitSplits: [],
      selectionMode: 'before_outcome', testLabelsUsed: false, selectionEvidenceRef: 'fixture-selection-only' })),
    selections: rows.filter((row) => row[1] === 'test').flatMap(([taskId]) => ['current', 'predicted'].map((policyId) => ({
      policyId, taskId, candidateId: policyId === 'current' || taskId === 't2' ? 'strong' : 'cheap',
      routerCost: policyId === 'current' ? 0.2 : 0.1, routerLatencyMs: policyId === 'current' ? 20 : 10,
      costBasis: 'actual', selectedAt: '2026-09-06T00:00:00Z'
    })))
  };
}

const opts = { minTestGroups: 2, bootstrapIterations: 100, seed: 11 };
const strategy = (report, id) => report.strategies.find((item) => item.id === id);
const hasBlock = (report, code) => report.claimAssessment.blockers.some((item) => item.code === code);
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

test('完整共同面板：失败、重试任务费用与路由开销均计入每成功任务成本', () => {
  const report = analyzeRoutingMatrix(matrix(), opts);
  const current = strategy(report, 'router:current').metrics;
  const predicted = strategy(report, 'router:predicted').metrics;
  assert.equal(current.tasks, 4);
  assert.equal(current.successes, 2);
  near(current.totalCost, 12.8);
  near(current.costPerSuccessfulTask, 6.4); // Includes the two failed tasks' costs.
  assert.equal(predicted.successes, 3);
  near(predicted.totalCost, 6.4);
  near(predicted.costPerSuccessfulTask, 6.4 / 3);
  assert.equal(current.latencyMs.mean, 320);
  assert.equal(predicted.latencyMs.mean, 160);
  assert.ok(report.strategies.every((item) => item.metrics.tasks === 4));
  const comparison = report.comparisons.find((item) => item.candidateStrategy === 'router:predicted');
  assert.equal(comparison.qualityDeltaPercentagePoints, 25);
  near(comparison.costSavingRate, 0.5);
  assert.deepEqual(comparison.pairedOutcomes, { bothSuccess: 2, candidateOnlySuccess: 1, referenceOnlySuccess: 0, bothFailure: 1 });
});

test('按任务固定与最佳固定基线只看 validation，测试结果变化不改变选择', () => {
  const input = matrix();
  const before = analyzeRoutingMatrix(input, opts);
  assert.equal(strategy(before, 'selected_fixed').candidateId, 'cheap'); // Selection-set accuracy ties; lower total cost wins.
  assert.deepEqual(strategy(before, 'task_fixed').candidatesByTask, { code: 'strong', support: 'cheap' });
  for (const row of input.observations.filter((row) => row.split === 'test')) row.success = row.candidateId === 'strong';
  const after = analyzeRoutingMatrix(input, opts);
  assert.equal(strategy(after, 'selected_fixed').candidateId, 'cheap');
  assert.deepEqual(strategy(after, 'task_fixed').candidatesByTask, strategy(before, 'task_fixed').candidatesByTask);
  assert.throws(() => analyzeRoutingMatrix(input, { ...opts, selectionSplit: 'test' }), /selectionSplit/);
});

test('事后 Oracle 先成功后成本，全失败任务也付费，且不声明可部署', () => {
  const report = analyzeRoutingMatrix(matrix(), opts);
  const oracle = strategy(report, 'oracle');
  assert.equal(oracle.deployable, false);
  assert.equal(oracle.metrics.successes, 3);
  assert.equal(oracle.metrics.totalCost, 6); // 1 + 3 + 1 + 1; failed t4 is not free.
  assert.equal(report.headroom.noCandidateSuccessTasks, 1);
  assert.deepEqual(report.headroom.uniquelySuccessfulTasksByCandidate, { cheap: 1, strong: 1 });
  assert.equal(report.claimAssessment.productionSuperiorityEstablished, false);
});

test('缺少候选结果时，全体策略使用同一子集，并明确阻断全流量结论', () => {
  const input = matrix();
  input.observations = input.observations.filter((row) => !(row.taskId === 't2' && row.candidateId === 'cheap'));
  const report = analyzeRoutingMatrix(input, opts);
  assert.equal(report.coverage.test.coverageRate, 0.75);
  assert.deepEqual(report.coverage.test.excluded, [{ taskId: 't2', missingCandidates: ['cheap'], missingPolicies: [] }]);
  assert.ok(report.strategies.every((item) => item.metrics.tasks === 3));
  assert.equal(hasBlock(report, 'INCOMPLETE_TEST_COVERAGE'), true);
});

test('缺少某策略选择时不得偷偷只用该策略覆盖的不同测试样本', () => {
  const input = matrix();
  input.selections = input.selections.filter((row) => !(row.taskId === 't1' && row.policyId === 'predicted'));
  const report = analyzeRoutingMatrix(input, opts);
  assert.equal(report.coverage.test.completePanelTasks, 4);
  assert.equal(report.coverage.test.evaluatedTasks, 3);
  assert.deepEqual(report.coverage.test.excluded[0].missingPolicies, ['predicted']);
  assert.ok(report.strategies.every((item) => item.metrics.tasks === 3));
});

test('整个任务没有任何观测时仍留在覆盖分母，不能隐藏整行缺失', () => {
  const input = matrix();
  input.observations = input.observations.filter((row) => row.taskId !== 't2');
  const report = analyzeRoutingMatrix(input, opts);
  assert.equal(report.coverage.test.declaredTasks, 4);
  assert.equal(report.coverage.test.coverageRate, 0.75);
  assert.deepEqual(report.coverage.test.excluded[0].missingCandidates, ['cheap', 'strong']);
  assert.equal(hasBlock(report, 'INCOMPLETE_TEST_COVERAGE'), true);
});

test('检测会话／模板跨 split，以及相同任务输入换 ID 跨 split', () => {
  const byGroup = matrix();
  byGroup.tasks.find((row) => row.taskId === 't1').groupId = 'group-v1';
  assert.throws(() => analyzeRoutingMatrix(byGroup, opts), /groupId 跨 split/);
  const byInput = matrix();
  byInput.tasks.find((row) => row.taskId === 't1').inputHash = byInput.tasks[0].inputHash;
  assert.throws(() => analyzeRoutingMatrix(byInput, opts), /相同任务输入跨 split/);
});

test('重复观测、同任务不同输入及候选伪重复必须拒绝', () => {
  const duplicate = matrix();
  duplicate.observations.push({ ...duplicate.observations[0] });
  assert.throws(() => analyzeRoutingMatrix(duplicate, opts), /taskId \+ candidateId 重复/);
  const differentInput = matrix();
  differentInput.observations[1].inputHash = createHash('sha256').update('another input').digest('hex');
  assert.throws(() => analyzeRoutingMatrix(differentInput, opts), /相同任务输入/);
  const duplicateCandidate = matrix();
  duplicateCandidate.candidates[1] = { ...duplicateCandidate.candidates[0], id: 'strong' };
  assert.throws(() => analyzeRoutingMatrix(duplicateCandidate, opts), /冒充两个不同候选/);
  const changedInference = matrix();
  changedInference.observations[0].inference = { reasoning_effort: 'high' };
  assert.throws(() => analyzeRoutingMatrix(changedInference, opts), /与候选声明一致/);
});

test('严格拒绝 HTTP 状态、分类标签、分数冒充业务成功及未知费用', () => {
  for (const invalidBasis of ['http_status', 'classification_label', 'llm_judge_score']) {
    const input = matrix();
    input.dataset.successBasis = invalidBasis;
    assert.throws(() => analyzeRoutingMatrix(input, opts), RoutingMatrixValidationError);
  }
  for (const [field, value] of [['success', 200], ['success', 0.9], ['success', null], ['cost', null], ['cost', -1], ['cost', '1'], ['latencyMs', NaN], ['evidenceRef', '']]) {
    const input = matrix();
    input.observations[0][field] = value;
    assert.throws(() => analyzeRoutingMatrix(input, opts), RoutingMatrixValidationError, `${field}=${value}`);
  }
  const missingOverhead = matrix();
  delete missingOverhead.selections[0].routerCost;
  assert.throws(() => analyzeRoutingMatrix(missingOverhead, opts), /routerCost/);
});

test('测试标签泄漏、测试集拟合与结果产生后伪称事前预测必须拒绝', () => {
  const fitTest = matrix();
  fitTest.policies[1].fitSplits = ['test'];
  assert.throws(() => analyzeRoutingMatrix(fitTest, opts), /fitSplits/);
  const labelsUsed = matrix();
  labelsUsed.policies[1].testLabelsUsed = true;
  assert.throws(() => analyzeRoutingMatrix(labelsUsed, opts), /testLabelsUsed/);
  const late = matrix();
  late.selections[0].selectedAt = '2026-09-06T00:02:00Z';
  assert.throws(() => analyzeRoutingMatrix(late, opts), /先于该任务/);
  const unknown = matrix();
  unknown.selections[0].candidateId = 'not-in-panel';
  assert.throws(() => analyzeRoutingMatrix(unknown, opts), /共同候选面板/);
});

test('label-blind replay 需要明确冻结版本和证据，仍不自动证明生产效果', () => {
  const input = matrix();
  input.policies[1].selectionMode = 'label_blind_replay';
  for (const selection of input.selections.filter((row) => row.policyId === 'predicted')) delete selection.selectedAt;
  const report = analyzeRoutingMatrix(input, opts);
  assert.equal(strategy(report, 'router:predicted').selectionMode, 'label_blind_replay');
  assert.equal(report.claimAssessment.productionSuperiorityEstablished, false);
  input.policies[1].selectionEvidenceRef = '';
  assert.throws(() => analyzeRoutingMatrix(input, opts), /selectionEvidenceRef/);
});

test('演示与估算费用都阻断效果声明；数据字段 observed 仅代表输入声明', () => {
  const demo = analyzeRoutingMatrix(matrix(), opts);
  assert.equal(hasBlock(demo, 'NON_OBSERVED_DATA'), true);
  assert.equal(demo.claimAssessment.offlineAnalysisEligible, false);
  const input = matrix();
  input.dataset.evidenceKind = 'observed'; // Exercises the input-attestation branch, not a real evidence claim.
  input.observations[0].costBasis = 'estimated';
  const estimated = analyzeRoutingMatrix(input, opts);
  assert.equal(hasBlock(estimated, 'ESTIMATED_COSTS'), true);
  input.observations[0].costBasis = 'actual';
  const declared = analyzeRoutingMatrix(input, opts);
  assert.equal(declared.claimAssessment.offlineAnalysisEligible, true);
  assert.equal(declared.claimAssessment.productionSuperiorityEstablished, false);
  assert.match(declared.claimAssessment.evidenceVerification, /未被工具独立核验/);
});

test('按组重采样保留会话内依赖和策略配对，种子可复现', () => {
  const input = matrix();
  for (const row of input.tasks.filter((row) => ['t1', 't2'].includes(row.taskId))) row.groupId = 'one-conversation';
  for (const row of input.observations.filter((row) => ['t1', 't2'].includes(row.taskId))) row.groupId = 'one-conversation';
  const a = analyzeRoutingMatrix(input, opts);
  const b = analyzeRoutingMatrix(input, opts);
  const ci = a.comparisons.find((item) => item.candidateStrategy === 'router:predicted').bootstrap;
  assert.equal(ci.groups, 3);
  assert.equal(ci.unit, 'groupId');
  assert.equal(ci.iterations, 100);
  assert.deepEqual(a, b);
  assert.equal(a.coverage.test.groups, 3);
});

test('零成功、无测试和样本不足输出 null / blocker，不伪造有效百分比', () => {
  const failed = matrix();
  for (const row of failed.observations.filter((row) => row.split === 'test')) row.success = false;
  const report = analyzeRoutingMatrix(failed); // Default minimum is deliberately unmet.
  assert.equal(hasBlock(report, 'TOO_FEW_TEST_GROUPS'), true);
  assert.ok(report.strategies.every((item) => item.metrics.costPerSuccessfulTask === null));
  const noTest = matrix();
  noTest.tasks = noTest.tasks.filter((row) => row.split !== 'test');
  noTest.observations = noTest.observations.filter((row) => row.split !== 'test');
  noTest.selections = [];
  const empty = analyzeRoutingMatrix(noTest, opts);
  assert.equal(hasBlock(empty, 'NO_COMPLETE_TEST_TASKS'), true);
  assert.equal(empty.coverage.test.coverageRate, null);
  assert.ok(empty.strategies.every((item) => item.metrics.taskSuccessRate === null));
});

test('未见类别按选择集固定模型回退；不偷偷在测试集选最优', () => {
  const input = matrix();
  for (const row of input.tasks.filter((row) => row.taskId === 't1')) row.task = 'unseen';
  for (const row of input.observations.filter((row) => row.taskId === 't1')) row.task = 'unseen';
  const report = analyzeRoutingMatrix(input, opts);
  const baseline = strategy(report, 'task_fixed');
  assert.equal(baseline.unseenTestTasks, 1);
  assert.equal(baseline.unseenTaskFallback, 'cheap');
  assert.equal(hasBlock(report, 'UNSEEN_TEST_CATEGORIES'), true);
});

test('CLI 保存完整阻断报告、返回非零，并保护输入矩阵', async () => {
  const root = resolve(tmpdir());
  const dir = await mkdtemp(join(root, 'amr-routing-matrix-'));
  try {
    const inputPath = join(dir, 'matrix.json'), outputPath = join(dir, 'report.json');
    const original = JSON.stringify(matrix());
    await writeFile(inputPath, '\uFEFF' + original);
    const cli = fileURLToPath(new URL('../scripts/analyze-routing-matrix.mjs', import.meta.url));
    const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 10000 });
    const result = run('--input', inputPath, '--out', outputPath, '--bootstrap', '20');
    assert.equal(result.status, 2, result.stderr);
    const report = JSON.parse(await readFile(outputPath, 'utf8'));
    assert.equal(report.claimAssessment.productionSuperiorityEstablished, false);
    assert.deepEqual(report, JSON.parse(result.stdout));
    assert.match(result.stderr, /NON_OBSERVED_DATA/);
    assert.equal(run('--input', inputPath, '--out', inputPath).status, 1);
    assert.equal(await readFile(inputPath, 'utf8'), '\uFEFF' + original);
    assert.equal(run('--input', inputPath, '--selection-split', 'test').status, 1);
    assert.equal(run('--input', inputPath, '--unknown', 'x').status, 1);
  } finally {
    assert.ok(resolve(dir).startsWith(root + sep));
    await rm(dir, { recursive: true, force: true });
  }
});

test('文档演示完整可运行，且始终标识演示与样本不足', async () => {
  const documentation = await readFile(new URL('../docs/routing-matrix.md', import.meta.url), 'utf8');
  const example = JSON.parse(documentation.match(/```json\r?\n([\s\S]*?)\r?\n```/)[1]);
  const report = analyzeRoutingMatrix(example);
  assert.equal(hasBlock(report, 'NON_OBSERVED_DATA'), true);
  assert.equal(hasBlock(report, 'TOO_FEW_TEST_GROUPS'), true);
  assert.equal(report.coverage.test.coverageRate, 1);
  assert.equal(report.claimAssessment.productionSuperiorityEstablished, false);
});
