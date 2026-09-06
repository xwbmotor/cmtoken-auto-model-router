// Pure import planning. The CLI performs a single save only after every input
// and every affected model has passed these checks.
import { EVALUATION_PROTOCOL, evidenceHash, mergeReportRows, qualityGate, summarizeScores, validateEvidenceReport } from './evaluation-integrity.mjs';

function inputMeta(rows, reports) {
  const sources = [...new Set(rows.map((r) => r.sourceFile))];
  return {
    protocol: EVALUATION_PROTOCOL, status: 'input-complete-not-human-calibrated',
    sources, datasetHashes: [...new Set(rows.map((r) => r.sourceDatasetHash))],
    sampleSetHash: evidenceHash(rows.map((r) => ({ model: r.model, id: r.id, caseHash: r.caseHash, at: r.at, score: r.score })).sort((a, b) => `${a.model}/${a.id}`.localeCompare(`${b.model}/${b.id}`))),
    reports: reports.filter((r) => sources.includes(r.path)).map(({ path, report }) => ({ path, at: report.at, reportHash: evidenceHash(report) })),
  };
}

export function planEvaluationImport(config, { subtaskReports = [], gateReports = [], mode = 'merge', now = new Date().toISOString() } = {}) {
  if (!['merge', 'replace'].includes(mode)) throw new Error('--mode 必须是 merge 或 replace');
  if (!subtaskReports.length && !gateReports.length) throw new Error('必须显式提供 --report 或 --gate-report；不自动选择最新片段');
  const next = structuredClone(config);
  const changes = [];
  const minSamples = Number(config.routing?.subtaskMinSamples ?? 4);
  if (!Number.isInteger(minSamples) || minSamples < 1) throw new Error('subtaskMinSamples 必须是正整数');
  for (const { report } of subtaskReports) {
    validateEvidenceReport(report);
    if (report.integrity.kind !== 'subtask') throw new Error('--report 只接受小类评测报告');
  }
  for (const { report } of gateReports) {
    validateEvidenceReport(report);
    if (report.integrity.kind !== 'gate' || report.integrity.mode !== 'model') throw new Error('--gate-report 只接受单模型评测；路由选择后的子集不能当作模型准入集');
    if (report.scope?.limited) throw new Error('不能用 --limit 冒烟报告更新模型能力档案');
    if (report.gate?.passed !== true || !qualityGate(report.results, report.gate?.limits).passed) throw new Error('模型准入报告没有通过质量/覆盖门禁');
  }
  const subRows = subtaskReports.length ? mergeReportRows(subtaskReports) : [];
  const gateRows = gateReports.length ? mergeReportRows(gateReports) : [];
  for (const row of [...subRows, ...gateRows]) if (!next.models.some((m) => m.id === row.model)) throw new Error(`报告模型不在当前配置中：${row.model}`);
  for (const model of next.models) {
    const rows = subRows.filter((r) => r.model === model.id);
    const gates = gateRows.filter((r) => r.model === model.id);
    if (!rows.length && !gates.length) continue;
    const bs = model.benchmarkScores ||= {};
    if (rows.length) {
      const oldSubtasks = bs.subtasks || {};
      const oldMeta = bs.subtasksMeta || {};
      const newSubtasks = mode === 'replace' ? {} : { ...oldSubtasks };
      const bySubtask = mode === 'replace' ? {} : Object.fromEntries(Object.keys(oldSubtasks).map((sub) => [sub, oldMeta.bySubtask?.[sub] || { protocol: 'legacy-unverified', source: oldMeta.source || null, at: oldMeta.at || null }]));
      const updated = [];
      for (const sub of new Set(rows.map((r) => r.sub))) {
        if (typeof sub !== 'string' || !sub || ['__proto__', 'constructor', 'prototype'].includes(sub)) throw new Error('无效小类名称');
        const group = rows.filter((r) => r.sub === sub);
        const gate = qualityGate(group, { min: 0 });
        if (!gate.passed || gate.coverage.scored < minSamples) throw new Error(`${model.id}/${sub} 证据不足：有效 ${gate.coverage.scored}/${group.length}，要求至少 ${minSamples} 且覆盖门禁通过`);
        if (mode === 'merge' && gate.coverage.scored < Number(oldSubtasks[sub]?.n || 0)) throw new Error(`${model.id}/${sub} 样本量将从 ${oldSubtasks[sub].n} 减至 ${gate.coverage.scored}；请补足样本或明确使用 --mode replace 重建该模型的小类档案`);
        newSubtasks[sub] = { avg: Number(gate.avg.toFixed(3)), n: gate.coverage.scored };
        bySubtask[sub] = { ...inputMeta(group, subtaskReports), coverage: gate.coverage };
        updated.push(sub);
      }
      bs.subtasks = newSubtasks;
      const unverified = Object.entries(bySubtask).filter(([, value]) => value.protocol !== EVALUATION_PROTOCOL).map(([sub]) => sub);
      bs.subtasksMeta = {
        at: now, judge: subtaskReports[0].report.integrity.judge?.model || null,
        source: subtaskReports.map((r) => r.path).join(', '), mode,
        protocol: unverified.length ? 'mixed-with-unverified-history' : EVALUATION_PROTOCOL,
        updatedSubtasks: updated, unverifiedSubtasks: unverified, bySubtask,
      };
      changes.push({ model: model.id, layer: 'subtasks', mode, before: Object.keys(oldSubtasks).length, after: Object.keys(newSubtasks).length, updated, removed: Object.keys(oldSubtasks).filter((sub) => !(sub in newSubtasks)), preservedUnverified: unverified });
    }
    if (gates.length) {
      const evaluated = qualityGate(gates, { min: 0 });
      if (!evaluated.passed) throw new Error(`${model.id} 合并后的 evalGate 覆盖不足：${evaluated.failures.join(', ')}`);
      const dims = summarizeScores(gates, 'task');
      for (const [task, stat] of Object.entries(dims)) if (stat.count < minSamples) throw new Error(`${model.id}/${task} evalGate 有效样本 ${stat.count} 少于 ${minSamples}`);
      const priorGate = bs.evalGate || {};
      bs.evalGate = { ...(mode === 'merge' ? priorGate : {}), at: now.slice(0, 10), judge: gateReports[0].report.integrity.judge?.model || null, total: Number(evaluated.avg.toFixed(3)), ...Object.fromEntries(Object.entries(dims).map(([task, stat]) => [task, stat.avg])) };
      const preservedTasks = mode === 'merge' ? Object.keys(priorGate).filter((key) => !['at', 'judge', 'total'].includes(key) && !(key in dims)) : [];
      bs.evalGateMeta = { ...inputMeta(gates, gateReports), at: now, mode, coverage: evaluated.coverage, totalScope: Object.keys(dims), preservedUnverifiedTasks: preservedTasks };
      changes.push({ model: model.id, layer: 'evalGate', mode, updated: Object.keys(dims), preservedUnverified: preservedTasks });
    }
    bs.updatedAt = now.slice(0, 10);
  }
  if (!changes.length) throw new Error('没有可导入的有效评分');
  return { config: next, changes };
}
