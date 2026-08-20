// CODE 大类粒度验证：3 模型 × 4 小类（debugging/code-generation/code-review/sql-database）。
// 裁判：glm-5.3（z.ai coding 端点，外部独立裁判）——judge 方案变更须经用户确认（工作原则）。
//
// 要回答的问题：路由打分层的 coding 单档是否够用，还是要按小类拆档？
// 判定规则：同模型跨小类均分极差(max-min) < 0.1 → 单档足够；≥ 0.1 → 该小类值得拆档。
//
// 用法：npm run eval:subtask [-- --limit N --models a,b,c]
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { loadConfig, projectRoot } from '../src/config.mjs';

function parseArgs(argv) {
  const args = { cases: 'config/subtask-eval.json', limit: Infinity, models: null, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--cases' || a === '-c') args.cases = argv[++i];
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--models') args.models = argv[++i].split(',');
    else if (a === '--out') args.out = argv[++i];
  }
  return args;
}

const TIMEOUT_MS = Number(process.env.EVAL_GATE_TIMEOUT_MS || 120000);

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

const SUB_LABEL = { debugging: '调试', 'code-generation': '代码生成', 'code-review': '代码评审', 'sql-database': 'SQL' };

const JUDGE_PROMPT = '你是模型输出质量评估裁判。根据评分要点，给下面的模型输出打分（0 到 1 之间的小数，1 为完全符合）。\n\n任务类型：{task}\n评分要点：{rubric}\n\n模型输出：\n{output}\n\n只返回一个 JSON 对象：{"score": 0.85, "reason": "一句话说明"}';

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

async function judgeOnce(ep, task, rubric, output) {
  const prompt = JUDGE_PROMPT.replace('{task}', task).replace('{rubric}', rubric).replace('{output}', output);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const res = await fetch(`${ep.base}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ep.key}` },
        body: JSON.stringify({ model: ep.model, messages: [{ role: 'user', content: prompt }], stream: false, max_tokens: 2048 }),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      if (!res.ok) { if (attempt === 2) return { score: null, reason: `[裁判失效] HTTP ${res.status}` }; continue; }
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content || '';
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) { if (attempt === 2) return { score: null, reason: '[裁判失效] 未返回 JSON' }; continue; }
      const parsed = JSON.parse(match[0]);
      return { score: clamp01(parsed.score), reason: parsed.reason || '' };
    } catch {
      if (attempt === 2) return { score: null, reason: '[裁判失效] 异常' };
    }
  }
  return { score: null, reason: '[裁判失效]' };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadConfig();
  const maasBase = (process.env.UPSTREAM_BASE_URL || process.env.MAAS_BASE_URL || config.upstreamBaseUrl).replace(/\/$/, '');
  const maasKey = process.env.UPSTREAM_API_KEY || process.env.MAAS_API_KEY;
  if (!maasKey) { console.error('缺少 MAAS_API_KEY'); process.exit(2); }

  const judge = { name: 'glm-5.3(外部)', base: 'https://api.z.ai/api/coding/paas/v4', key: process.env.GLMCODE_API_KEY, model: 'glm-5.3' };
  if (!judge.key) { console.error('缺少 GLMCODE_API_KEY（外部裁判）'); process.exit(2); }

  const models = args.models || config.models.filter((m) => m.enabled).map((m) => m.id);
  const all = JSON.parse(await readFile(resolve(projectRoot, args.cases), 'utf8')).cases;
  const cases = all.slice(0, args.limit === Infinity ? all.length : args.limit);

  console.log(`粒度验证：${models.length} 模型 × ${cases.length} 用例 · 裁判 ${judge.name}（单judge）`);
  console.log(`被测：${models.join(' / ')}\n`);

  const results = [];
  let n = 0;
  const total = models.length * cases.length;
  for (const model of models) {
    for (const c of cases) {
      n += 1;
      const tag = `[${String(n).padStart(3, '0')}/${total}]`;
      try {
        const output = await generate(maasBase, maasKey, model, c.prompt);
        const v = await judgeOnce(judge, c.sub, c.rubric, output);
        results.push({ id: c.id, sub: c.sub, model, score: v.score, reason: v.reason, outputHead: output.slice(0, 160) });
        console.log(`${tag} ${c.id} ${model} → ${v.score == null ? 'null' : v.score.toFixed(2)}${v.score == null ? ` ${v.reason}` : ''}`);
      } catch (error) {
        results.push({ id: c.id, sub: c.sub, model, score: null, error: error.message, outputHead: '' });
        console.log(`${tag} ${c.id} ${model} 生成失败：${error.message.slice(0, 80)}`);
      }
    }
  }

  // ---- 聚合 ----
  const ok = results.filter((r) => r.score != null);
  const byModelSub = {};
  for (const r of ok) {
    byModelSub[r.model] ||= {};
    (byModelSub[r.model][r.sub] ||= []).push(r.score);
  }

  console.log('\n================ 粒度验证报告 ================');
  console.log(`有效：${ok.length}/${total}（生成失败 ${results.filter((r) => r.error).length}，裁判失效 ${results.filter((r) => !r.error && r.score == null).length}）`);

  const granularity = [];
  for (const [model, subs] of Object.entries(byModelSub)) {
    console.log(`\n${model}:`);
    const avgs = {};
    for (const [sub, arr] of Object.entries(subs)) {
      const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
      avgs[sub] = avg;
      console.log(`  ${SUB_LABEL[sub] || sub}   ${String(arr.length).padStart(2)} 条  均分 ${avg.toFixed(3)}`);
    }
    const vals = Object.values(avgs);
    const spread = Math.max(...vals) - Math.min(...vals);
    const worst = Object.entries(avgs).sort((a, b) => a[1] - b[1])[0];
    granularity.push({ model, spread: Number(spread.toFixed(3)), lowest: { sub: worst[0], avg: Number(worst[1].toFixed(3)) }, avgs: Object.fromEntries(Object.entries(avgs).map(([k, v]) => [k, Number(v.toFixed(3))])) });
    console.log(`  → 跨小类极差 ${spread.toFixed(3)}（${spread < 0.1 ? '＜0.1 单档足够' : '≥0.1 有拆档价值'}），最弱 ${SUB_LABEL[worst[0]] || worst[0]} ${worst[1].toFixed(3)}`);
  }

  console.log('\n结论判定（判定规则：极差 <0.1 单档足够；≥0.1 有拆档价值）：');
  const needSplit = granularity.filter((g) => g.spread >= 0.1);
  if (!needSplit.length) console.log('  ✓ 所有模型跨小类极差 < 0.1 —— coding 单档打分足够，30 小类维持纯展示');
  else for (const g of needSplit) console.log(`  ⚠ ${g.model} 极差 ${g.spread} ≥ 0.1（最弱 ${SUB_LABEL[g.lowest.sub]} ${g.lowest.avg}）—— 该维度有拆档价值`);

  const outPath = args.out || resolve(projectRoot, 'data', 'subtask-eval', `subtask-eval-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify({ at: new Date().toISOString(), judge: judge.name, models, granularity, results }, null, 2));
  console.log(`\n报告已写入 ${outPath}`);
}

main().catch((error) => { console.error('执行失败：', error.message); process.exit(2); });
