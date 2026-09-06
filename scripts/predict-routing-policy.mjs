#!/usr/bin/env node
// Deliberately accepts only a frozen model and a label-blind feature file.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { predictLearnedPolicy } from '../src/learned-routing.mjs';
import { ROUTING_FEATURE_NAMES, ROUTING_FEATURE_VERSION } from '../src/request-features.mjs';
import { fileEvidenceHash, testManifest, validatePolicyFile, writeNewJson } from './learning-policy-files.mjs';

const HELP = `对隔离的测试请求特征做离线预测（不接收矩阵/答案文件）
node scripts/predict-routing-policy.mjs --policy policy.json --input prepared/blind.json --out selections.json --router-cost 0 --cost-basis estimated
  --policy-id ID                  策略名，默认 learned-request-v1
  --allow-unconfirmed-eligibility  允许在未经资格确认的候选面板上演示，报告保留阻断项
--router-cost 必须显式填写每次决策的费用，不能把未知费用冒充实际 0。
输出文件必须不存在。退出码：0=完成离线预测；2=证据/资格不足；1=输入错误。
本地计时只测预测调用，不代表服务端完整路由开销。`;

function onlyKeys(value, keys, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} 必须是对象`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`${path} 不允许字段 ${key}；不能接收结果或标签`);
}
function validateBlind(blind, file) {
  onlyKeys(blind, ['schemaVersion', 'featureVersion', 'featureNames', 'datasetId', 'candidates', 'tasks'], 'blind');
  if (blind.schemaVersion !== 1 || blind.featureVersion !== ROUTING_FEATURE_VERSION || fileEvidenceHash(blind.featureNames) !== fileEvidenceHash(ROUTING_FEATURE_NAMES)) throw new Error('盲化特征协议不匹配');
  if (blind.datasetId !== file.source.datasetId || fileEvidenceHash(blind.candidates) !== file.source.candidateHash) throw new Error('盲化输入的数据集或候选快照不匹配');
  if (!Array.isArray(blind.tasks) || !blind.tasks.length) throw new Error('缺少盲化测试任务');
  const ids = new Set(), hashes = new Map(), candidateIds = new Set(blind.candidates.map(c => c.id));
  for (const task of blind.tasks) {
    onlyKeys(task, ['taskId', 'groupId', 'split', 'inputHash', 'features', 'eligibleCandidateIds', 'eligibilitySource'], 'blind.tasks');
    if (typeof task.taskId !== 'string' || !task.taskId || ids.has(task.taskId) || typeof task.groupId !== 'string' || !task.groupId || task.split !== 'test') throw new Error('盲化任务 ID/分组/split 无效或重复');
    ids.add(task.taskId);
    if (!/^[a-f0-9]{64}$/i.test(task.inputHash || '')) throw new Error('盲化任务缺少输入哈希');
    const hash = task.inputHash.toLowerCase();
    if (hashes.has(hash) && hashes.get(hash) !== task.groupId) throw new Error('同一测试输入被拆到不同独立组');
    hashes.set(hash, task.groupId);
    if (!Array.isArray(task.features) || task.features.length !== ROUTING_FEATURE_NAMES.length || task.features.some(n => typeof n !== 'number' || !Number.isFinite(n))) throw new Error('盲化任务特征维度或数值无效');
    if (!Array.isArray(task.eligibleCandidateIds) || new Set(task.eligibleCandidateIds).size !== task.eligibleCandidateIds.length || task.eligibleCandidateIds.some(id => !candidateIds.has(id))) throw new Error('资格候选必须是无重复的已声明候选子集');
    if (!['caller_declared', 'requires_confirmation'].includes(task.eligibilitySource)) throw new Error('缺少资格来源');
  }
}

try {
  const args = {}, seen = new Set();
  for (let i = 2; i < process.argv.length; i++) {
    const flag = process.argv[i];
    if (flag === '--help' || flag === '-h') { args.help = true; continue; }
    if (seen.has(flag)) throw new Error(`重复参数：${flag}`);
    seen.add(flag);
    if (flag === '--allow-unconfirmed-eligibility') { args.allowUnconfirmed = true; continue; }
    const key = ({ '--policy': 'policy', '--input': 'input', '--out': 'out', '--router-cost': 'routerCost', '--cost-basis': 'costBasis', '--policy-id': 'policyId' })[flag];
    if (!key) throw new Error(`未知参数：${flag}`);
    const value = process.argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`${flag} 缺少值`);
    args[key] = key === 'routerCost' ? Number(value) : value;
  }
  if (args.help) console.log(HELP);
  else {
    if (!args.policy || !args.input || !args.out) throw new Error('必须提供 --policy、--input 和 --out');
    if (!Number.isFinite(args.routerCost) || args.routerCost < 0 || !['actual', 'estimated'].includes(args.costBasis)) throw new Error('必须显式提供非负 --router-cost 和 actual|estimated 的 --cost-basis');
    const file = validatePolicyFile(JSON.parse((await readFile(args.policy, 'utf8')).replace(/^\uFEFF/, '')));
    const blind = JSON.parse((await readFile(args.input, 'utf8')).replace(/^\uFEFF/, ''));
    validateBlind(blind, file);
    const unconfirmed = blind.tasks.filter(t => t.eligibilitySource === 'requires_confirmation').length;
    if (unconfirmed && !args.allowUnconfirmed) throw new Error('候选资格未确认；需补充 eligibleCandidateIds，或显式 --allow-unconfirmed-eligibility 仅做离线面板实验');
    const policyId = args.policyId || 'learned-request-v1';
    const selections = [], unselected = [];
    for (const task of blind.tasks) {
      const started = performance.now();
      const prediction = predictLearnedPolicy(file.model, { features: task.features, eligibleCandidateIds: task.eligibleCandidateIds });
      const latency = performance.now() - started;
      if (!prediction.candidateId) unselected.push({ taskId: task.taskId, reason: prediction.reason, eligibleCandidateIds: task.eligibleCandidateIds });
      else selections.push({ policyId, taskId: task.taskId, candidateId: prediction.candidateId,
        routerCost: args.routerCost, costBasis: args.costBasis, routerLatencyMs: latency,
        reason: prediction.reason, predictions: prediction.predictions, eligibilitySource: task.eligibilitySource,
        fallback: prediction.fallback, qualityGateSatisfied: prediction.qualityGateSatisfied, probabilityFloorGuaranteed: false });
    }
    const blockers = [{ code: 'PARTIAL_ROUTING_LATENCY', message: '当前时延只测本地预测调用，尚未测完整请求特征提取和服务路径，不能据此宣称端到端时延不退化。' }];
    if (!file.model.readiness?.learningReady) blockers.push({ code: 'LEARNED_POLICY_NOT_READY', message: '拟合或验证证据不足，策略保守回退，不能声称已完成有效学习。' });
    if (unconfirmed) blockers.push({ code: 'UNCONFIRMED_CANDIDATE_ELIGIBILITY', message: `${unconfirmed} 条测试请求只在候选面板内选择，没有确认线上资格约束。` });
    if (unselected.length) blockers.push({ code: 'UNSELECTED_TEST_TASKS', message: `${unselected.length} 条任务没有合格选择，保留缺口，不伪造候选结果。` });
    const bundle = {
      schemaVersion: 1, kind: 'offline-routing-selections',
      policy: { id: policyId, kind: 'predicted', version: file.modelHash, fitSplits: [...file.model.fitSplits],
        selectionMode: 'label_blind_replay', testLabelsUsed: false, selectionEvidenceRef: resolve(args.out) },
      taskManifest: testManifest(blind), selections, unselected, claimBlockers: blockers,
      provenance: { ...file.source, modelHash: file.modelHash, policyFileHash: file.fileHash, blindInputHash: fileEvidenceHash(blind),
        featureVersion: ROUTING_FEATURE_VERSION, mode: 'OFFLINE_ONLY', productionValidated: false,
        latencyScope: '本机已加载模型后的单次预测调用；不含文件读取、服务接入、原始请求特征计算或生产网络时延。',
        costScope: '由调用方显式给出的每次路由费用；工具不核验账单，也不把本地 CPU 消耗默认为免费。' }
    };
    const output = await writeNewJson(args.out, bundle, [args.policy, args.input]);
    console.log(JSON.stringify({ output, modelHash: file.modelHash, selected: selections.length, unselected: unselected.length,
      evidenceKind: file.source.evidenceKind, blockers, productionValidated: false }, null, 2));
    if (blockers.length || file.source.evidenceKind !== 'observed' || args.costBasis !== 'actual') process.exitCode = 2;
  }
} catch (error) { console.error(`predict-routing-policy: ${error.message}`); process.exitCode = 1; }
