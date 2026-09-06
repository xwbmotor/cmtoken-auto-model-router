// Resume only evidence-compatible subtask reports. Historical scores require a
// complete rerun, not new metadata or a rerun of only their failed rows.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig, projectRoot } from '../src/config.mjs';
import { caseEvidence, coverageOf, evaluateCase, evidenceHash, normalizeCases, summarizeScores, validateEvidenceReport } from './evaluation-integrity.mjs';

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--report') throw new Error('用法：eval:regen -- --report <新协议报告路径>');
  const reportPath = resolve(projectRoot, args[1]);
  const report = validateEvidenceReport(JSON.parse(await readFile(reportPath, 'utf8')));
  if (report.integrity.kind !== 'subtask') throw new Error('只支持 subtask 报告');
  const config = await loadConfig();
  const baseUrl = (process.env.UPSTREAM_BASE_URL || process.env.MAAS_BASE_URL || config.upstreamBaseUrl).replace(/\/$/, '');
  const apiKey = process.env.UPSTREAM_API_KEY || process.env.MAAS_API_KEY;
  if (!apiKey) throw new Error('缺少 MAAS_API_KEY / UPSTREAM_API_KEY');
  const meta = report.integrity;
  if (meta.generation.baseUrl !== baseUrl) throw new Error('业务上游地址已变化，不能与原报告混合补跑');
  if (meta.generation.modelConfigHash !== evidenceHash(config.models.filter((m) => meta.models.includes(m.id)))) throw new Error('被测模型配置已变化，不能与原报告混合补跑');
  if (process.env.REGEN_MAX_TOKENS && Number(process.env.REGEN_MAX_TOKENS) !== meta.generation.maxTokens) throw new Error('补跑不能改变 maxTokens；需要新参数时请完整运行 eval:subtask');
  const judgeKey = meta.judge?.keyEnv ? process.env[meta.judge.keyEnv] : meta.judge?.baseUrl === baseUrl ? apiKey : null;
  const judge = meta.judge ? { ...meta.judge, apiKey: judgeKey } : null;
  if (judge && !judge.apiKey) throw new Error('缺少报告原 Judge 的凭据环境变量');
  const previousReportHash = evidenceHash(report);
  const failures = report.results.filter((r) => r.status !== 'scored');
  console.log(`补跑 ${failures.length} 条；保持原题、Judge 和生成参数，Judge 失败复用原回答`);
  for (const row of failures) {
    if (!config.models.some((m) => m.enabled && m.id === row.model)) throw new Error(`被测模型未启用：${row.model}`);
    const c = normalizeCases([caseEvidence(row)], meta.generation.maxTokens)[0];
    const next = await evaluateCase({ c, model: row.model, baseUrl, apiKey, judge, timeoutMs: meta.generation.timeoutMs, previous: row });
    delete row.error;
    Object.assign(row, next);
    console.log(`${row.id} ${row.model} → ${row.status}`);
  }
  report.at = new Date().toISOString();
  report.previousReportHash = previousReportHash;
  report.coverage = coverageOf(report.results);
  report.granularity = meta.models.map((model) => {
    const rows = report.results.filter((r) => r.model === model);
    const subs = summarizeScores(rows, 'sub');
    return { model, avgs: Object.fromEntries(Object.entries(subs).map(([sub, v]) => [sub, v.avg])), counts: Object.fromEntries(Object.entries(subs).map(([sub, v]) => [sub, v.count])), coverage: coverageOf(rows), note: '描述性均值；补跑历史保留在 previousAttempts' };
  });
  delete report.summary;
  validateEvidenceReport(report);
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(`已回写 ${reportPath} · 有效评分 ${report.coverage.scored}/${report.coverage.total}`);
}
main().catch((error) => { console.error('补跑失败：', error.message); process.exitCode = 2; });
