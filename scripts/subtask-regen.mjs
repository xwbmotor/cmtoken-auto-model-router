// 补跑报告里的失败条（score==null）：读 --report，只重跑失败项，结果按 (model,id) 覆盖合并回写报告文件本身
// 用法：npm run eval:regen -- --report data/subtask-eval/full30.json
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig, projectRoot } from '../src/config.mjs';

const MAXT = Number(process.env.REGEN_MAX_TOKENS || 32768);
const argReport = process.argv.includes('--report') ? process.argv[process.argv.indexOf('--report') + 1] : null;
if (!argReport) { console.error('用法: node subtask-regen.mjs --report <报告路径>'); process.exit(2); }
const reportPath = resolve(projectRoot, argReport);

const config = await loadConfig();
const base = (process.env.UPSTREAM_BASE_URL || process.env.MAAS_BASE_URL || config.upstreamBaseUrl).replace(/\/$/, '');
const key = process.env.UPSTREAM_API_KEY || process.env.MAAS_API_KEY;
const JUDGE = { base: 'https://api.z.ai/api/coding/paas/v4', key: process.env.GLMCODE_API_KEY, model: 'glm-5.3' };

const caseById = new Map(JSON.parse(await readFile(resolve(projectRoot, 'config/subtask-eval.json'), 'utf8')).cases.map((c) => [c.id, c]));
const report = JSON.parse(await readFile(reportPath, 'utf8'));
const fails = report.results.filter((r) => r.score == null);
console.log(`重跑 --report ${argReport} × ${fails.length} 条 · max_tokens=${MAXT} · judge ${JUDGE.model}`);

async function genOne(model, c) {
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: c.prompt }], stream: false, max_tokens: MAXT }),
    signal: AbortSignal.timeout(300000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const d = await res.json();
  const m = d.choices?.[0]?.message || {};
  return { output: m.content || '', finish: d.choices?.[0]?.finish_reason, reasoningLen: (m.reasoning || m.reasoning_content || '').length };
}

async function judgeOne(c, output) {
  const prompt = `你是模型输出质量评估裁判。根据评分要点，给下面的模型输出打分（0 到 1 之间的小数，1 为完全符合）。\n\n任务类型：${c.sub}\n评分要点：${c.rubric}\n\n模型输出：\n${output}\n\n只返回一个 JSON 对象：{"score": 0.85, "reason": "一句话说明"}`;
  const jr = await fetch(`${JUDGE.base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${JUDGE.key}` },
    body: JSON.stringify({ model: JUDGE.model, messages: [{ role: 'user', content: prompt }], stream: false, max_tokens: 2048 }),
    signal: AbortSignal.timeout(120000)
  });
  const jd = await jr.json();
  const match = (jd.choices?.[0]?.message?.content || '').match(/\{[\s\S]*\}/);
  if (!match) return { score: null, reason: '裁判未返回 JSON' };
  const parsed = JSON.parse(match[0]);
  return { score: Number.isFinite(Number(parsed.score)) ? Number(parsed.score) : null, reason: parsed.reason || '' };
}

let done = 0;
for (const r of fails) {
  const c = caseById.get(r.id);
  if (!c) { console.log(`${r.id} 不在用例集中，跳过`); continue; }
  try {
    const g = await genOne(r.model, c);
    if (!g.output) { console.log(`[${++done}/${fails.length}] ${r.id} ${r.model} 仍无 content（finish=${g.finish}）`); continue; }
    const j = await judgeOne(c, g.output);
    if (j.score != null) {
      Object.assign(r, { score: j.score, reason: j.reason, finish: g.finish, contentLen: g.output.length, reasoningLen: g.reasoningLen, outputHead: g.output.slice(0, 160), regenAt: new Date().toISOString() });
      console.log(`[${++done}/${fails.length}] ${r.id} ${r.model} → ${j.score.toFixed(2)} ${j.reason.slice(0, 40)}`);
    } else {
      console.log(`[${++done}/${fails.length}] ${r.id} ${r.model} 裁判失败：${j.reason}`);
    }
  } catch (e) {
    console.log(`[${++done}/${fails.length}] ${r.id} ${r.model} 失败：${e.message.slice(0, 80)}`);
  }
}

// 重新聚合并回写报告
const byModel = {};
for (const x of report.results) {
  byModel[x.model] ||= { scored: 0, sum: 0, fail: 0, bySub: {} };
  if (x.score == null) byModel[x.model].fail += 1;
  else { byModel[x.model].scored += 1; byModel[x.model].sum += x.score; (byModel[x.model].bySub[x.sub] ||= []).push(x.score); }
}
report.summary = {};
for (const [m, v] of Object.entries(byModel)) {
  report.summary[m] = {
    total: v.scored + v.fail, scored: v.scored, failed: v.fail,
    avg: Number((v.sum / Math.max(1, v.scored)).toFixed(3)),
    subtasks: Object.fromEntries(Object.entries(v.bySub).map(([s, arr]) => [s, { n: arr.length, avg: Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(3)) }]))
  };
  const avgs = Object.values(report.summary[m].subtasks).map((x) => x.avg);
  const spread = Math.max(0, ...avgs) - Math.min(...avgs);
  report.summary[m].spread = Number(spread.toFixed(3));
}
await writeFile(reportPath, JSON.stringify(report, null, 2));
const still = report.results.filter((r) => r.score == null).length;
console.log(`\n已回写 ${argReport} · 剩余失败 ${still} 条`);
