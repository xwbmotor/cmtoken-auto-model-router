// File contracts for separate fit, blind prediction and outcome analysis processes.
// These hashes establish consistency, not authenticity of user-supplied evidence.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { modelArtifactHash } from '../src/learned-routing.mjs';
import { validateRoutingMatrix } from '../src/routing-matrix.mjs';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export function fileEvidenceHash(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
const byId = (a, b) => a.taskId.localeCompare(b.taskId) || String(a.candidateId || '').localeCompare(String(b.candidateId || ''));
export function testManifest(data) {
  return data.tasks.filter(t => t.split === 'test').map(({ taskId, groupId, split, inputHash }) => ({ taskId, groupId, split, inputHash: inputHash.toLowerCase() })).sort(byId);
}
export function fitEvidenceHash(data) {
  const tasks = data.tasks.filter(t => ['train', 'validation'].includes(t.split));
  const ids = new Set(tasks.map(t => t.taskId));
  return fileEvidenceHash({
    dataset: data.dataset,
    candidates: data.candidates.slice().sort((a, b) => a.id.localeCompare(b.id)),
    tasks: tasks.map(({ taskId, groupId, split, task, inputHash }) => ({ taskId, groupId, split, task, inputHash: inputHash.toLowerCase() })).sort(byId),
    observations: data.observations.filter(row => ids.has(row.taskId)).map(({ taskId, candidateId, success, cost, costBasis, latencyMs, observedAt, evidenceRef }) =>
      ({ taskId, candidateId, success, cost, costBasis, latencyMs, observedAt, evidenceRef })).sort(byId)
  });
}
export function makePolicyFile(model, fit) {
  const file = {
    schemaVersion: 1, kind: 'offline-routing-policy', model,
    modelHash: modelArtifactHash(model),
    source: { datasetId: fit.dataset.id, datasetHash: fileEvidenceHash(fit.dataset), fitEvidenceHash: fitEvidenceHash(fit),
      candidateHash: fileEvidenceHash(fit.candidates), evidenceKind: fit.dataset.evidenceKind }
  };
  file.fileHash = fileEvidenceHash({ modelHash: file.modelHash, source: file.source });
  return file;
}
export function validatePolicyFile(file) {
  if (file?.schemaVersion !== 1 || file.kind !== 'offline-routing-policy' || !file.model || !file.source) throw new Error('不是离线策略文件；请使用 train-routing-policy.mjs 生成');
  if (file.modelHash !== modelArtifactHash(file.model)) throw new Error('策略模型哈希不匹配，文件可能已修改');
  if (file.fileHash !== fileEvidenceHash({ modelHash: file.modelHash, source: file.source })) throw new Error('策略文件的来源摘要不匹配');
  if (file.model.mode !== 'OFFLINE_ONLY' || file.model.productionValidated !== false) throw new Error('策略文件不能声明生产已验证');
  if (file.source.datasetHash !== fileEvidenceHash(file.model.dataset) || file.source.datasetId !== file.model.dataset.id || file.source.evidenceKind !== file.model.dataset.evidenceKind) throw new Error('策略文件的数据来源与模型不一致');
  for (const key of ['datasetHash', 'fitEvidenceHash', 'candidateHash']) if (!/^[a-f0-9]{64}$/.test(file.source[key] || '')) throw new Error(`策略来源缺少 ${key}`);
  return file;
}
export async function writeNewJson(path, value, protectedPaths = []) {
  const output = resolve(path);
  if (protectedPaths.some(input => resolve(input).toLowerCase() === output.toLowerCase())) throw new Error('输出不能覆盖输入');
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  return output;
}
export function mergeLearningSelections(matrix, bundle) {
  validateRoutingMatrix(matrix);
  if (bundle?.schemaVersion !== 1 || bundle.kind !== 'offline-routing-selections' || !bundle.provenance) throw new Error('不是盲化预测选择文件');
  if (bundle.provenance.datasetHash !== fileEvidenceHash(matrix.dataset)) throw new Error('预测与矩阵的数据集声明不一致');
  if (bundle.provenance.candidateHash !== fileEvidenceHash(matrix.candidates)) throw new Error('预测与矩阵的候选版本或推理参数不一致');
  if (bundle.provenance.fitEvidenceHash !== fitEvidenceHash(matrix)) throw new Error('预测与矩阵的非测试拟合证据不一致');
  if (fileEvidenceHash(bundle.taskManifest) !== fileEvidenceHash(testManifest(matrix))) throw new Error('预测与矩阵的测试任务清单不一致');
  if (!/^[a-f0-9]{64}$/.test(bundle.provenance.modelHash || '') || bundle.policy?.version !== bundle.provenance.modelHash) throw new Error('预测策略版本与模型哈希不一致');
  if (bundle.policy?.kind !== 'predicted' || bundle.policy.selectionMode !== 'label_blind_replay' || bundle.policy.testLabelsUsed !== false) throw new Error('仅接受未使用测试结果的 predicted 策略');
  if (matrix.policies.some(p => p.kind === 'predicted' || p.id === bundle.policy.id)) throw new Error('矩阵已含 predicted 或同名策略；不能静默覆盖');
  if (!Array.isArray(bundle.selections) || !Array.isArray(bundle.unselected) || !Array.isArray(bundle.claimBlockers)) throw new Error('选择文件缺少完整结果或未选择原因');
  const testIds = new Set(testManifest(matrix).map(t => t.taskId));
  const covered = new Set();
  for (const row of [...bundle.selections, ...bundle.unselected]) {
    if (!testIds.has(row.taskId) || covered.has(row.taskId)) throw new Error('选择文件任务缺失、重复或不属于测试清单');
    covered.add(row.taskId);
  }
  if (covered.size !== testIds.size) throw new Error('选择文件未说明全部测试任务的处理结果');
  if (bundle.selections.some(row => row.policyId !== bundle.policy.id)) throw new Error('选择行的 policyId 不一致');
  for (const block of bundle.claimBlockers) if (typeof block?.code !== 'string' || typeof block?.message !== 'string') throw new Error('选择文件的证据限制格式错误');
  const result = { ...matrix, policies: [...matrix.policies, bundle.policy], selections: [...matrix.selections, ...bundle.selections] };
  validateRoutingMatrix(result);
  return { matrix: result, blockers: bundle.claimBlockers };
}
