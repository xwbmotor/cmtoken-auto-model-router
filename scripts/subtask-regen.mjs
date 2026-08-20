// Qwen3.8-27B 思考型模型重跑工具：max_tokens 32768（8192 时 reasoning 烧满导致 content 空）
// 只重跑指定模型+小类，输出与主跑同结构
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig, projectRoot } from '../src/config.mjs';

const MAXT = Number(process.env.REGEN_MAX_TOKENS || 32768);
const model = process.argv[2];
const subFilter = process.argv[3] ? process.argv[3].split(',') : null;
const outName = process.argv[4] || `run-${model}-regen.json`;

const config = await loadConfig();
const base = (process.env.UPSTREAM_BASE_URL || process.env.MAAS_BASE_URL || config.upstreamBaseUrl).replace(/\/$/, '');
const key = process.env.UPSTREAM_API_KEY || process.env.MAAS_API_KEY;
const judge = { base: 'https://api.z.ai/api/coding/paas/v4', key: process.env.GLMCODE_API_KEY, model: 'glm-5.3' };

const all = JSON.parse(await readFile(resolve(projectRoot, 'config/subtask-eval.json'), 'utf8')).cases;
const cases = subFilter ? all.filter((c) => subFilter.includes(c.sub)) : all;
console.log(`重跑 ${model} × ${cases.length} 条 · max_tokens=${MAXT} · judge ${judge.model}`);

const SUB_LABEL = { debugging: '调试', 'code-generation': '代码生成', 'code-review': '代码评审', 'sql-database': 'SQL' };
const results = [];
let i = 0;
for (const c of cases) {
  i += 1;
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: c.prompt }], stream: false, max_tokens: MAXT }),
      signal: AbortSignal.timeout(300000)
    });
    const d = await res.json();
    const m = d.choices?.[0]?.message || {};
    const output = m.content || '';
    const finish = d.choices?.[0]?.finish_reason;
    // 裁判
    const prompt = `你是模型输出质量评估裁判。根据评分要点，给下面的模型输出打分（0 到 1 之间的小数，1 为完全符合）。\n\n任务类型：${c.sub}\n评分要点：${c.rubric}\n\n模型输出：\n${output}\n\n只返回一个 JSON 对象：{"score": 0.85, "reason": "一句话说明"}`;
    let score = null, reason = '';
    try {
      const jr = await fetch(`${judge.base}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${judge.key}` },
        body: JSON.stringify({ model: judge.model, messages: [{ role: 'user', content: prompt }], stream: false, max_tokens: 2048 }),
        signal: AbortSignal.timeout(120000)
      });
      const jd = await jr.json();
      const match = (jd.choices?.[0]?.message?.content || '').match(/\{[\s\S]*\}/);
      if (match) { score = Number(JSON.parse(match[0]).score); reason = JSON.parse(match[0]).reason || ''; }
    } catch {}
    results.push({ id: c.id, sub: c.sub, model, score, reason, finish, contentLen: output.length, reasoningLen: (m.reasoning || m.reasoning_content || '').length, outputHead: output.slice(0, 160) });
    console.log(`[${String(i).padStart(2, '0')}/${cases.length}] ${c.id} finish=${finish} content=${output.length} reasoning=${(m.reasoning || m.reasoning_content || '').length} → ${score == null ? 'null' : score.toFixed(2)} ${reason.slice(0, 40)}`);
  } catch (error) {
    results.push({ id: c.id, sub: c.sub, model, score: null, error: error.message });
    console.log(`[${String(i).padStart(2, '0')}/${cases.length}] ${c.id} 失败：${error.message.slice(0, 80)}`);
  }
}

// 聚合
const bySub = {};
for (const r of results.filter((r) => r.score != null)) (bySub[r.sub] ||= []).push(r.score);
console.log('\n== 重跑结果 ==');
for (const [sub, arr] of Object.entries(bySub)) console.log(`  ${SUB_LABEL[sub] || sub}: ${arr.length} 条 均分 ${(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(3)}`);

await writeFile(resolve(projectRoot, 'data/subtask-eval', outName), JSON.stringify({ at: new Date().toISOString(), judge: 'glm-5.3(外部)', model, maxTokens: MAXT, results }, null, 2));
console.log(`\n已写入 data/subtask-eval/${outName}`);
