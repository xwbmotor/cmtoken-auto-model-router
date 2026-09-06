// Offline quality gate. Routing mode exercises the routing core, not the entire
// production serving/semantic/fallback chain. See docs/evaluation-integrity.md.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { loadConfig, projectRoot } from '../src/config.mjs';
import { routeRequest } from '../src/router.mjs';
import {
  caseEvidence, createIntegrity, evaluateCase, evidenceHash, normalizeCases,
  qualityGate, resolveJudge, sharedGenerationSettings, summarizeScores, validateEvidenceReport,
} from './evaluation-integrity.mjs';

function parseArgs(argv) {
  const args = { cases: 'config/eval-gate.json', min: 0.7, limit: Infinity, judge: null, model: null, out: null, baseline: null, report: null };
  const fields = { '--cases': 'cases', '-c': 'cases', '--min': 'min', '--limit': 'limit', '--judge': 'judge', '-j': 'judge', '--model': 'model', '-m': 'model', '--out': 'out', '--baseline': 'baseline', '--report': 'report', '--min-ready-rate': 'minReadyRate', '--min-judge-coverage': 'minJudgeCoverage', '--min-task-coverage': 'minTaskCoverage' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      console.log('eval:gate -- [--model ID] [--judge ID|url=...|model=...|key=ENV|none] [--cases PATH] [--limit N] [--min 0.7] [--min-ready-rate 0.95] [--min-judge-coverage 0.95] [--min-task-coverage 0.8] [--baseline PATH] [--out PATH] [--report PATH]');
      console.log('--report 仅复用同题库/协议/参数的新报告；无 Judge 只出生成结果，质量门不能 PASS。');
      process.exit(0);
    }
    if (!fields[a] || argv[i + 1] == null) throw new Error(`未知参数或缺少值：${a}`);
    const field = fields[a];
    args[field] = ['min', 'limit', 'minReadyRate', 'minJudgeCoverage', 'minTaskCoverage'].includes(field) ? Number(argv[++i]) : argv[++i];
  }
  if (args.limit !== Infinity && (!Number.isInteger(args.limit) || args.limit <= 0)) throw new Error('--limit 必须是正整数');
  return args;
}

function pickJudge(config) {
  const enabled = config.models.filter((m) => m.enabled);
  if (!enabled.length) throw new Error('没有启用的模型可作裁判；可显式指定 --judge');
  return enabled.slice().sort((a, b) => (b.quality?.default || 0) - (a.quality?.default || 0))[0].id;
}
function comparableBaseline(baseline, integrity) {
  validateEvidenceReport(baseline);
  for (const key of ['datasetHash', 'judge', 'mode']) {
    if (evidenceHash(baseline.integrity[key]) !== evidenceHash(integrity[key])) throw new Error(`基线 ${key} 与本次不同，不能比较`);
  }
  if (evidenceHash(sharedGenerationSettings(baseline.integrity.generation)) !== evidenceHash(sharedGenerationSettings(integrity.generation))) throw new Error('基线生成请求设置与本次不同，不能比较');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const limits = Object.fromEntries(['min', 'minReadyRate', 'minJudgeCoverage', 'minTaskCoverage'].filter((k) => args[k] != null).map((k) => [k, args[k]]));
  qualityGate([], limits);
  const config = await loadConfig();
  const baseUrl = (process.env.UPSTREAM_BASE_URL || process.env.MAAS_BASE_URL || config.upstreamBaseUrl).replace(/\/$/, '');
  const apiKey = process.env.UPSTREAM_API_KEY || process.env.MAAS_API_KEY;
  if (!apiKey) throw new Error('缺少 MAAS_API_KEY / UPSTREAM_API_KEY');
  if (args.model && !config.models.some((m) => m.enabled && m.id === args.model)) throw new Error(`被测模型未启用或不存在：${args.model}`);
  const judgeModel = args.judge || pickJudge(config);
  const judge = resolveJudge(judgeModel, { baseUrl, apiKey });
  const timeoutMs = Number(process.env.EVAL_GATE_TIMEOUT_MS || 90000);
  const maxTokens = Number(process.env.EVAL_GATE_MAX_TOKENS || 32768);
  const bank = JSON.parse(await readFile(resolve(projectRoot, args.cases), 'utf8')).cases;
  const cases = normalizeCases(bank.slice(0, args.limit), maxTokens);
  const selectedModels = config.models.filter((m) => args.model ? m.id === args.model : m.enabled);
  const integrity = createIntegrity({ cases, kind: 'gate', mode: args.model ? 'model' : 'routing-core', models: selectedModels.map((m) => m.id), judge, generation: { baseUrl, stream: false, maxTokens, timeoutMs, modelConfigHash: evidenceHash(selectedModels), modelConfigHashes: Object.fromEntries(selectedModels.map((m) => [m.id, evidenceHash(m)])) }, policyHash: args.model ? null : evidenceHash(config) });
  const previous = args.report ? validateEvidenceReport(JSON.parse(await readFile(resolve(projectRoot, args.report), 'utf8')), integrity) : null;
  const baseline = args.baseline ? JSON.parse(await readFile(resolve(projectRoot, args.baseline), 'utf8')) : null;
  if (baseline) comparableBaseline(baseline, integrity);
  const mode = args.model ? `单模型 ${args.model}` : '路由核心模式（不含在线语义分类/健康/预算/回退链）';
  console.log(`eval gate：${cases.length}/${bank.length} 条 · ${mode} · 裁判 ${judge?.model || '未配置'} · 阈值 ${args.min}`);
  const previousById = new Map((previous?.results || []).map((r) => [r.id, r]));
  const results = [];
  for (const c of cases) {
    const old = previousById.get(c.id);
    if (old?.status === 'scored') { results.push(old); continue; }
    let model;
    try {
      model = args.model || routeRequest({ model: 'auto', messages: [{ role: 'user', content: c.prompt }], max_tokens: c.maxTokens }, config, {}).suggestedModel;
      if (!model) throw new Error('没有可用模型');
    } catch (error) {
      results.push({ ...caseEvidence(c), caseHash: evidenceHash(caseEvidence(c)), model: null, status: 'generation_failed', score: null, reason: `routing_failed:${error.message}`, error: error.message, output: '', outputHead: '', generation: { ok: false, error: error.message, usage: null }, judge: { attempts: [] } });
      continue;
    }
    const row = await evaluateCase({ c, model, baseUrl, apiKey, judge, timeoutMs, previous: old });
    results.push(row);
    console.log(`${c.id} → ${model} → ${row.status}${row.score == null ? ` (${row.reason})` : ` ${row.score.toFixed(2)}`}`);
  }

  const gate = qualityGate(results, limits);
  let comparison = null;
  if (baseline) {
    const oldScores = new Map(baseline.results.filter((r) => r.status === 'scored').map((r) => [r.id, r.score]));
    const differences = results.filter((r) => r.status === 'scored' && oldScores.has(r.id)).map((r) => r.score - oldScores.get(r.id));
    const delta = differences.length ? differences.reduce((a, b) => a + b, 0) / differences.length : null;
    comparison = { pairedN: differences.length, total: cases.length, delta, baseline: args.baseline, note: '同题配对均值差；未作显著性推断' };
    if (differences.length / cases.length < gate.limits.minTaskCoverage) gate.failures.push('baseline_paired_coverage_below_minimum');
    if (delta == null || delta < -0.05) gate.failures.push('baseline_degraded');
    gate.passed = gate.failures.length === 0;
  }
  const report = {
    at: new Date().toISOString(), integrity, judgeModel, mode, min: args.min,
    scope: { selectedCases: cases.length, bankCases: bank.length, limited: cases.length !== bank.length },
    avg: gate.avg == null ? null : Number(gate.avg.toFixed(3)), byTask: summarizeScores(results, 'task'), byModel: summarizeScores(results, 'model'),
    coverage: gate.coverage, gate, comparison, results,
    ...(previous ? { resumedFrom: args.report, previousReportHash: evidenceHash(previous) } : {}),
  };
  const outPath = args.out ? resolve(projectRoot, args.out) : args.report ? resolve(projectRoot, args.report) : resolve(projectRoot, 'data', 'eval-gate', `eval-gate-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(report, null, 2));
  console.log(`质量均分 ${report.avg ?? 'unavailable'} · 生成就绪 ${gate.coverage.generated}/${gate.coverage.total} · 有效评分 ${gate.coverage.scored}/${gate.coverage.total} · Judge 失败 ${gate.coverage.judgeFailed} · 跳过 ${gate.coverage.judgeSkipped}`);
  console.log(`报告已写入 ${outPath}`);
  console.log(gate.passed ? 'PASS：质量与覆盖门禁均通过' : `FAIL：${gate.failures.join(', ')}`);
  process.exitCode = gate.passed ? 0 : 1;
}

main().catch((error) => { console.error('eval gate 执行失败：', error.message); process.exitCode = 2; });
