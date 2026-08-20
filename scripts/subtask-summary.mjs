// 汇总三份报告 → 粒度验证最终结论（含 Qwen3.8 预算修正口径）
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { projectRoot } from '../src/config.mjs';

const dir = resolve(projectRoot, 'data/subtask-eval');
const dsf = JSON.parse(await readFile(resolve(dir, 'run-dsf.json'), 'utf8'));
const qw36 = JSON.parse(await readFile(resolve(dir, 'run-qwen36.json'), 'utf8'));
const qw38 = JSON.parse(await readFile(resolve(dir, 'run-qwen38.json'), 'utf8'));
const regen = JSON.parse(await readFile(resolve(dir, 'run-Qwen3.8-27B-regen.json'), 'utf8'));

const SUBS = ['debugging', 'code-generation', 'code-review', 'sql-database'];
const SUB_LABEL = { debugging: '调试', 'code-generation': '代码生成', 'code-review': '代码评审', 'sql-database': 'SQL' };

// Qwen3.8 预算修正：code-generation 用 regen 数据（32768 预算，4/8 有效均分 0.93）
const regenAvg = regen.results.filter(r => r.score != null).reduce((a, r) => a + r.score, 0) / regen.results.filter(r => r.score != null).length;
const corrected38 = { ...qw38.granularity[0].avgs, 'code-generation': Number(regenAvg.toFixed(3)) };

const table = [
  { model: 'deepseekv4-flash', avgs: dsf.granularity[0].avgs, valid: dsf.results.filter(r => r.score != null).length, total: 32, note: '' },
  { model: 'qwen36-35b', avgs: qw36.granularity[0].avgs, valid: qw36.results.filter(r => r.score != null).length, total: 32, note: '' },
  { model: 'Qwen3.8-27B', avgs: corrected38, valid: 23 + 4, total: 32, note: 'code-generation 为 32768 预算重跑值（4/8 有效）；主跑 9 条超时、13 条 content 空判 0' }
];

console.log('=========== CODE 大类粒度验证（judge: glm-5.3）===========');
console.log('小类'.padEnd(10) + table.map(t => t.model.padEnd(17)).join(''));
for (const sub of SUBS) console.log(SUB_LABEL[sub].padEnd(10) + table.map(t => (t.avgs[sub] != null ? t.avgs[sub].toFixed(3) : '—').padEnd(17)).join(''));
console.log();
for (const t of table) {
  const vals = Object.values(t.avgs).filter(v => v != null);
  const spread = Math.max(...vals) - Math.min(...vals);
  const worst = Object.entries(t.avgs).sort((a, b) => a[1] - b[1])[0];
  console.log(`${t.model}  极差 ${spread.toFixed(3)} ${spread >= 0.1 ? '⚠有拆档信号' : '✓单档足够'}  最弱 ${SUB_LABEL[worst[0]]} ${worst[1].toFixed(3)}  有效 ${t.valid}/${t.total}${t.note ? '  ※' + t.note : ''}`);
}

// 逐小类最优模型
console.log('\n逐小类最优：');
for (const sub of SUBS) {
  const ranked = table.map(t => ({ m: t.model, v: t.avgs[sub] })).filter(x => x.v != null).sort((a, b) => b.v - a.v);
  console.log(`  ${SUB_LABEL[sub]}: ${ranked.map(x => `${x.m} ${x.v.toFixed(2)}`).join(' > ')}`);
}

await writeFile(resolve(dir, 'FINAL-SUMMARY.json'), JSON.stringify({ at: new Date().toISOString(), judge: 'glm-5.3', table, regenAvg: Number(regenAvg.toFixed(3)) }, null, 2));
console.log('\n已写入 data/subtask-eval/FINAL-SUMMARY.json');
