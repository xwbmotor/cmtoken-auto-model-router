// Regenerate a sanitized provenance inventory from locally retained raw evaluations.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const config = JSON.parse(await readFile(new URL('../config/router.json', import.meta.url), 'utf8'));
const result = { schemaVersion: 1, generatedAt: new Date().toISOString(),
  limitations: ['历史 Judge 评测，非业务成功率', '原始结果未记录模型版本、完整推理参数与题目内容哈希', '当前分数与原始均值不一致时保留人工修订，不自动覆盖'], models: {} };
for (const model of config.models) {
  const path = `data/eval-gate/model-${model.id}.json`;
  let bytes;
  try { bytes = await readFile(new URL('../' + path, import.meta.url)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  const raw = JSON.parse(bytes.toString('utf8'));
  const rows = (raw.results || []).filter(r => r.model === model.id);
  const scores = {};
  for (const task of Object.keys(model.quality || {})) {
    const items = rows.filter(r => r.task === task);
    const valid = items.filter(r => Number.isFinite(r.score) && r.score >= 0 && r.score <= 1);
    if (!valid.length) continue;
    scores[task] = { path, sha256: createHash('sha256').update(bytes).digest('hex'), evaluatedAt: raw.at,
      judgeModel: /(?:^|\|)model=([^|]+)/.exec(raw.judgeModel || '')?.[1] || null,
      caseIds: valid.map(r => r.id), count: items.length, validCount: valid.length,
      duplicateCount: valid.length - new Set(valid.map(r => r.id)).size,
      mean: valid.reduce((s, r) => s + r.score, 0) / valid.length,
      configSource: model.qualitySource?.[task] || model.qualitySource?.default || '未登记' };
  }
  result.models[model.id] = scores;
}
const subPath = 'data/subtask-eval/merged30.json';
try {
  const bytes = await readFile(new URL('../' + subPath, import.meta.url)), raw = JSON.parse(bytes.toString('utf8'));
  for (const model of config.models) for (const sub of Object.keys(model.benchmarkScores?.subtasks || {})) {
    const items = (raw.results || []).filter(r => r.model === model.id && r.sub === sub);
    const valid = items.filter(r => Number.isFinite(r.score) && r.score >= 0 && r.score <= 1);
    if (!valid.length) continue;
    (result.models[model.id] ||= {})['subtask:' + sub] = { path: subPath, sha256: createHash('sha256').update(bytes).digest('hex'), evaluatedAt: raw.at,
      judgeModel: /^([\w.-]+)/.exec(raw.judge || '')?.[1] || null, caseIds: valid.map(r => r.id), count: items.length, validCount: valid.length,
      duplicateCount: valid.length - new Set(valid.map(r => r.id)).size, mean: valid.reduce((s, r) => s + r.score, 0) / valid.length,
      configSource: model.benchmarkScores?.subtasksMeta?.source || '未登记' };
  }
} catch (error) { if (error.code !== 'ENOENT') throw error; }
await writeFile(new URL('../src/quality-evidence.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ models: Object.keys(result.models), tasks: Object.values(result.models).reduce((n, m) => n + Object.keys(m).length, 0) }));
