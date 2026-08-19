// 上线前评估门（eval gate）：用固定用例集实测「路由选中模型」的输出质量，防止静默质量退化。
//
// 两种模式：
//   1) 路由模式（默认）——每条例走 routeRequest 得 suggestedModel，测「路由整体质量」。
//   2) 单模型模式（--model <id>）——固定模型跑全部用例，测「单点质量」，用于候选模型准入。
//
// 每条用例：生成 → 裁判模型按 rubric 打分（0~1）→ 汇总（总均分 / 按 task / 按模型）。
// 总均分低于 --min 阈值时以非零退出码结束，可接 CI / 发布前手动跑。
//
// 用法：
//   npm run eval:gate                          # 路由模式，跑全部用例，阈值 0.7
//   npm run eval:gate -- --model qwen36-35b    # 单模型准入
//   npm run eval:gate -- --limit 10 --min 0.8  # 只跑前 10 条，阈值 0.8
//   npm run eval:gate -- --judge qwen36-35b    # 指定裁判模型
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { loadConfig, projectRoot } from '../src/config.mjs';
import { routeRequest } from '../src/router.mjs';

function parseArgs(argv) {
  const args = { cases: 'config/eval-gate.json', min: 0.7, limit: Infinity, judge: null, model: null, out: null, baseline: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--cases' || a === '-c') args.cases = argv[++i];
    else if (a === '--min') args.min = Number(argv[++i]);
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--judge' || a === '-j') args.judge = argv[++i];
    else if (a === '--model' || a === '-m') args.model = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--baseline') args.baseline = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log('eval gate 用法：npm run eval:gate -- [--model <id>] [--judge <id>] [--limit N] [--min 0.7] [--cases path] [--baseline 报告路径] [--out path]');
      process.exit(0);
    }
  }
  return args;
}

// 选裁判模型：默认取 enabled 中 quality.default 最高的模型
function pickJudge(config) {
  const enabled = config.models.filter((m) => m.enabled);
  if (!enabled.length) throw new Error('没有启用的模型可作裁判');
  return enabled.slice().sort((a, b) => (b.quality?.default || 0) - (a.quality?.default || 0))[0].id;
}

const TIMEOUT_MS = Number(process.env.EVAL_GATE_TIMEOUT_MS || 90000);

async function generate(base, key, model, prompt) {
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: false, max_tokens: 8192 }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`生成失败 ${model}: HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

const JUDGE_PROMPT = '你是模型输出质量评估裁判。根据评分要点，给下面的模型输出打分（0 到 1 之间的小数，1 为完全符合）。\n\n任务类型：{task}\n评分要点：{rubric}\n\n模型输出：\n{output}\n\n只返回一个 JSON 对象：{"score": 0.85, "reason": "一句话说明"}';

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

async function judge(base, key, judgeModel, task, rubric, output) {
  // --judge 支持外部裁判："--judge url=https://...|model=xxx|key=ENV_VAR"，用于引入网关外更强的裁判（如 GLM5.3）
  let jBase = base, jKey = key, jModel = judgeModel;
  if (judgeModel.startsWith('url=')) {
    const parts = judgeModel.split('|');
    for (const p of parts) {
      const [k, v] = p.split('=');
      if (k === 'url') jBase = v.replace(/\/$/, '');
      else if (k === 'model') jModel = v;
      else if (k === 'key' && process.env[v]) jKey = process.env[v];
    }
  }
  const prompt = JUDGE_PROMPT.replace('{task}', task).replace('{rubric}', rubric).replace('{output}', output);
  // 裁判失败不能记成被测模型的 0 分（2026-08-19 Qwen3.8 演练教训）：重试 1 次，仍失败记 null 并在汇总中剔除
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const res = await fetch(`${jBase}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${jKey}` },
      body: JSON.stringify({ model: jModel, messages: [{ role: 'user', content: prompt }], stream: false, max_tokens: 2048 }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!res.ok) { if (attempt === 2) return { score: null, reason: `[裁判失效] HTTP ${res.status}`, raw: '' }; continue; }
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) { if (attempt === 2) return { score: null, reason: '[裁判失效] 未返回 JSON', raw: text.slice(0, 120) }; continue; }
    try {
      const parsed = JSON.parse(match[0]);
      return { score: clamp01(parsed.score), reason: parsed.reason || '', raw: text.slice(0, 120) };
    } catch {
      if (attempt === 2) return { score: null, reason: '[裁判失效] JSON 解析失败', raw: text.slice(0, 120) };
    }
  }
  return { score: null, reason: '[裁判失效]', raw: '' };
}

function summarize(results, field) {
  const map = {};
  for (const r of results) {
    if (r.score == null) continue; // 裁判失效的不计入均分
    const k = r[field] ?? 'unknown';
    (map[k] ||= []).push(r.score);
  }
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, { count: v.length, avg: Number((v.reduce((a, b) => a + b, 0) / v.length).toFixed(3)) }]).sort((a, b) => b[1].avg - a[1].avg));
}

function printReport(avg, byTask, byModel, results) {
  console.log('\n================ eval gate 报告 ================');
  console.log(`总均分：${avg.toFixed(3)}（${results.length} 条，有效 ${results.filter((r) => r.score != null).length} 条）`);
  console.log('\n按任务：');
  for (const [task, s] of Object.entries(byTask)) console.log(`  ${task.padEnd(12)} ${String(s.count).padStart(2)} 条  均分 ${s.avg}`);
  console.log('\n按模型：');
  for (const [model, s] of Object.entries(byModel)) console.log(`  ${model.padEnd(18)} ${String(s.count).padStart(2)} 条  均分 ${s.avg}`);
  console.log('\n低分用例（< 0.6）：');
  const low = results.filter((r) => r.score != null && r.score < 0.6);
  if (low.length) for (const r of low) console.log(`  ${r.id} (${r.task}) → ${r.model} → ${r.score.toFixed(2)}：${r.reason}`);
  else console.log('  无');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadConfig();
  const base = (process.env.UPSTREAM_BASE_URL || process.env.MAAS_BASE_URL || config.upstreamBaseUrl).replace(/\/$/, '');
  const key = process.env.UPSTREAM_API_KEY || process.env.MAAS_API_KEY;
  if (!key) { console.error('缺少 MAAS_API_KEY / UPSTREAM_API_KEY（用 npm run eval:gate 以自动加载 .env）'); process.exit(2); }

  const judgeModel = args.judge || pickJudge(config);
  const all = JSON.parse(await readFile(resolve(projectRoot, args.cases), 'utf8')).cases;
  const cases = all.slice(0, args.limit === Infinity ? all.length : args.limit);

  const mode = args.model ? `单模型 ${args.model}` : '路由模式';
  console.log(`eval gate：${cases.length} 条用例 · ${mode} · 裁判 ${judgeModel} · 阈值 ${args.min}`);

  const results = [];
  for (let i = 0; i < cases.length; i += 1) {
    const c = cases[i];
    const tag = `[${String(i + 1).padStart(2, '0')}/${cases.length}]`;
    try {
      const decision = args.model
        ? { suggestedModel: args.model }
        : routeRequest({ model: 'auto', messages: [{ role: 'user', content: c.prompt }] }, config, {});
      const model = decision.suggestedModel;
      const output = await generate(base, key, model, c.prompt);
      const verdict = await judge(base, key, judgeModel, c.task, c.rubric, output);
      results.push({ id: c.id, task: c.task, model, score: verdict.score, reason: verdict.reason, output: output.slice(0, 200) });
      console.log(`${tag} ${c.id} → ${model} → ${verdict.score.toFixed(2)}`);
    } catch (error) {
      results.push({ id: c.id, task: c.task, model: null, score: 0, reason: error.message, output: '' });
      console.log(`${tag} ${c.id} → 失败：${error.message}`);
    }
  }

  const scored = results.filter((r) => r.score != null);
  const judgeFailed = results.length - scored.length;
  const scores = scored.map((r) => r.score);
  const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  printReport(avg, summarize(results, 'task'), summarize(results, 'model'), results);
  if (judgeFailed) console.log(`\n⚠️ 裁判失效剔除：${judgeFailed} 条（不计入均分，不算 0）`);

  // 落盘报告（默认 data/eval-gate/）
  const outPath = args.out || resolve(projectRoot, 'data', 'eval-gate', `eval-gate-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify({ at: new Date().toISOString(), judgeModel, mode, min: args.min, avg: Number(avg.toFixed(3)), byTask: summarize(results, 'task'), byModel: summarize(results, 'model'), results }, null, 2));
  console.log(`\n报告已写入 ${outPath}`);

  // 基线对比：防「静默质量退化」——即使总均分仍高于绝对阈值，相对基线明显下降也要告警
  let baselineDegraded = false;
  if (args.baseline) {
    const base = JSON.parse(await readFile(resolve(projectRoot, args.baseline), 'utf8'));
    const delta = Number((avg - base.avg).toFixed(3));
    console.log(`\n基线对比（${args.baseline}，基线均分 ${base.avg}）：`);
    console.log(`  总均分变化：${delta >= 0 ? '+' : ''}${delta}`);
    const taskDeltas = [];
    for (const [task, s] of Object.entries(summarize(results, 'task'))) {
      const baseAvg = base.byTask?.[task]?.avg ?? null;
      if (baseAvg != null) taskDeltas.push(`${task} ${baseAvg}→${s.avg}`);
    }
    if (taskDeltas.length) console.log(`  按任务：${taskDeltas.join('；')}`);
    if (delta < -0.05) { console.error('  ⚠ 质量明显退化（较基线下降超过 0.05）'); baselineDegraded = true; }
    else console.log('  ✓ 质量无明显退化');
  }

  if (avg < args.min || baselineDegraded) { console.error(`\nFAIL：总均分 ${avg.toFixed(3)}${baselineDegraded ? ' 或相对基线退化' : ` < 阈值 ${args.min}`}`); process.exit(1); }
  console.log(`\nPASS：总均分 ${avg.toFixed(3)} ≥ 阈值 ${args.min}${args.baseline ? ' 且无基线退化' : ''}`);
  process.exit(0);
}

main().catch((error) => { console.error('eval gate 执行失败：', error.message); process.exit(2); });
