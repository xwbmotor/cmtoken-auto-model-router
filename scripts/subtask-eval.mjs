// Subtask evidence collection. Scores are observations, not proof that a task
// taxonomy should be split; small samples and incomplete coverage remain visible.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { loadConfig, projectRoot } from '../src/config.mjs';
import { coverageOf, createIntegrity, evaluateCase, evidenceHash, normalizeCases, resolveJudge, summarizeScores, validateEvidenceReport } from './evaluation-integrity.mjs';

const DEFAULT_JUDGE = 'url=https://api.z.ai/api/coding/paas/v4|model=glm-5.3|key=GLMCODE_API_KEY';
function parseArgs(argv) {
  const args = { cases: 'config/subtask-eval.json', limit: Infinity, models: null, out: null, report: null, judge: DEFAULT_JUDGE };
  const fields = { '--cases': 'cases', '-c': 'cases', '--limit': 'limit', '--models': 'models', '--out': 'out', '--report': 'report', '--judge': 'judge' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help') { console.log('eval:subtask -- [--cases PATH] [--models a,b] [--limit N] [--judge SPEC|none] [--out PATH] [--report PATH]'); process.exit(0); }
    const key = fields[argv[i]];
    if (!key || argv[i + 1] == null) throw new Error(`未知参数或缺少值：${argv[i]}`);
    args[key] = key === 'limit' ? Number(argv[++i]) : key === 'models' ? [...new Set(argv[++i].split(',').filter(Boolean))] : argv[++i];
  }
  if (args.limit !== Infinity && (!Number.isInteger(args.limit) || args.limit <= 0)) throw new Error('--limit 必须是正整数');
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadConfig();
  const baseUrl = (process.env.UPSTREAM_BASE_URL || process.env.MAAS_BASE_URL || config.upstreamBaseUrl).replace(/\/$/, '');
  const apiKey = process.env.UPSTREAM_API_KEY || process.env.MAAS_API_KEY;
  if (!apiKey) throw new Error('缺少 MAAS_API_KEY / UPSTREAM_API_KEY');
  const judge = resolveJudge(args.judge, { baseUrl, apiKey });
  const models = args.models || config.models.filter((m) => m.enabled).map((m) => m.id);
  if (!models.length || models.some((id) => !config.models.some((m) => m.id === id && m.enabled))) throw new Error('被测模型必须存在且已启用');
  const maxTokens = Number(process.env.SUBTASK_EVAL_MAX_TOKENS || 32768);
  const timeoutMs = Number(process.env.EVAL_GATE_TIMEOUT_MS || 120000);
  const bank = JSON.parse(await readFile(resolve(projectRoot, args.cases), 'utf8')).cases;
  const cases = normalizeCases(bank.slice(0, args.limit), maxTokens);
  if (cases.some((c) => typeof c.sub !== 'string' || !c.sub)) throw new Error('小类用例缺少 sub');
  const modelConfigHash = evidenceHash(config.models.filter((m) => models.includes(m.id)));
  const modelConfigHashes = Object.fromEntries(config.models.filter((m) => models.includes(m.id)).map((m) => [m.id, evidenceHash(m)]));
  const integrity = createIntegrity({ cases, kind: 'subtask', mode: 'model', models, judge, generation: { baseUrl, stream: false, maxTokens, timeoutMs, modelConfigHash, modelConfigHashes } });
  const previous = args.report ? validateEvidenceReport(JSON.parse(await readFile(resolve(projectRoot, args.report), 'utf8')), integrity) : null;
  const previousByKey = new Map((previous?.results || []).map((r) => [JSON.stringify([r.model, r.id]), r]));
  console.log(`小类评测：${models.length} 模型 × ${cases.length}/${bank.length} 用例 · 裁判 ${judge?.model || '未配置'}`);
  const results = [];
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    for (let j = 0; j < models.length; j++) {
      const model = models[(i + j) % models.length];
      const old = previousByKey.get(JSON.stringify([model, c.id]));
      if (old?.status === 'scored') { results.push(old); continue; }
      const row = await evaluateCase({ c, model, baseUrl, apiKey, judge, timeoutMs, previous: old });
      results.push(row);
      console.log(`${c.id} ${model} → ${row.status}${row.score == null ? ` (${row.reason})` : ` ${row.score.toFixed(2)}`}`);
    }
  }
  const granularity = models.map((model) => {
    const rows = results.filter((r) => r.model === model);
    const subs = summarizeScores(rows, 'sub');
    const avgs = Object.fromEntries(Object.entries(subs).map(([sub, value]) => [sub, value.avg]));
    const values = Object.values(avgs);
    return { model, avgs, counts: Object.fromEntries(Object.entries(subs).map(([sub, value]) => [sub, value.count])), coverage: coverageOf(rows), spread: values.length > 1 ? Number((Math.max(...values) - Math.min(...values)).toFixed(3)) : null, note: '描述性均值；不据小样本极差直接判定拆档或排名' };
  });
  const outPath = resolve(projectRoot, args.out || args.report || `data/subtask-eval/subtask-eval-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify({ at: new Date().toISOString(), integrity, judge: judge?.model || null, models, scope: { selectedCases: cases.length, bankCases: bank.length }, coverage: coverageOf(results), granularity, results }, null, 2));
  console.log(`报告已写入 ${outPath} · 有效评分 ${results.filter((r) => r.status === 'scored').length}/${results.length}`);
  // An explicit --judge none collects generation results without a quality PASS.
}

main().catch((error) => { console.error('小类评测执行失败：', error.message); process.exitCode = 2; });
