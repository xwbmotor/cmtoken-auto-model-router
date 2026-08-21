// 模型能力档案：把 30 小类实测 + 6 维 evalGate + 官方 benchmark 三层数据写入 router.json 的 benchmarkScores。
// 数据源：data/subtask-eval/*.json（subtask-eval.mjs 产出）+ data/eval-gate/*.json（eval-gate.mjs 产出）
// 用法：node scripts/apply-eval-to-models.mjs [--dry]   （--dry 只打印不写）
// 写入结构（benchmarkScores）：
//   scores:   官方榜单 benchmark（人工录入或模板导入，本脚本不动它）
//   evalGate: 6 维实测（default/simple/coding/reasoning/creative/extraction + total）
//   subtasks: 30 小类实测均分（id → { avg, n }）
//   updatedAt / source
import { readFile, writeFile } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig, projectRoot, saveConfig } from '../src/config.mjs';

const dry = process.argv.includes('--dry');

const config = await loadConfig();
const dir = resolve(projectRoot, 'data', 'subtask-eval');

// 1) 30 小类：取最新一份含 subtasks 聚合的报告（subtask-eval.mjs 的 granularity 字段）
const argReport = process.argv.includes('--report') ? process.argv[process.argv.indexOf('--report') + 1] : null;

let sub = null;
if (argReport) {
  const j = JSON.parse(await readFile(resolve(projectRoot, argReport), 'utf8'));
  if (j.results || j.summary) {
    const agg = {};
    for (const r of (j.results || [])) {
      if (r.score == null) continue;
      (agg[r.model] ||= {})[r.sub] ||= [];
      agg[r.model][r.sub].push(r.score);
    }
    sub = { at: j.at || new Date().toISOString(), judge: j.judge || 'glm-5.3(外部)', agg, from: argReport };
  }
}
if (!sub) for (const f of (await readdir(dir)).filter((x) => x.startsWith('subtask-eval-2') && x.endsWith('.json')).sort()) {
  try {
    const j = JSON.parse(await readFile(resolve(dir, f), 'utf8'));
    if (Array.isArray(j.results) && j.results.length) {
      // 用合并口径重算：同 id+model 保留最新（文件间后者覆盖前者）
      const agg = {};
      for (const r of j.results) {
        if (r.score == null) continue;
        (agg[r.model] ||= {})[r.sub] ||= [];
        agg[r.model][r.sub].push(r.score);
      }
      sub = { at: j.at, judge: j.judge, agg, from: f };
    }
  } catch {}
}
if (!sub) { console.error('未找到 subtask-eval 报告（data/subtask-eval/subtask-eval-2*.json）'); process.exit(2); }

// 2) 六维 evalGate：读 data/eval-gate/model-<id>.json（跳过 .bak 备份），按模型名匹配
const gateDir = resolve(projectRoot, 'data', 'eval-gate');
const gateByModel = {};
try {
  for (const f of (await readdir(gateDir)).filter((x) => /^model-.+\.json$/.test(x) && !x.includes('.bak'))) {
    try {
      const j = JSON.parse(await readFile(resolve(gateDir, f), 'utf8'));
      const id = f.replace(/^model-/, '').replace(/\.json$/, '');
      const valid = (j.results || []).filter((r) => r.score != null).length;
      gateByModel[id] = { report: j, valid };
    } catch {}
  }
} catch {}

const SUB_LABEL = {
  'code-generation': '代码生成', debugging: '调试', 'code-review': '代码评审', 'sql-database': 'SQL', 'frontend-ui': '前端与UI', 'devops-config': 'DevOps与配置', 'shell-execution': 'Shell执行', 'file-io': '文件读写', 'repo-scanning': '仓库扫描',
  'multi-step-planning': '多步规划', 'tool-dispatch': '工具调度', 'workflow-execution': '工作流执行', 'web-search': 'Web搜索', 'memory-extraction': '记忆提取', 'devops-agent': 'DevOps智能体',
  'data-extraction': '数据抽取', 'data-transformation': '数据转换', classification: '分类', summarization: '摘要', translation: '翻译', math: '数学',
  'content-writing': '内容写作', 'research-reports': '研究与报告', 'qa-knowledge': '问答与知识', conversation: '对话', 'customer-support': '客户支持', 'roleplay-fiction': '角色扮演与虚构', 'finance-trading': '金融与交易', 'security-audit': '安全审计', other: '其他'
};

let changed = 0;
for (const m of config.models) {
  const aggModel = sub.agg[m.id];
  if (!aggModel) continue;
  const bs = m.benchmarkScores ||= {};
  const subtasks = {};
  for (const [s, arr] of Object.entries(aggModel)) subtasks[s] = { avg: Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(3)), n: arr.length };
  bs.subtasks = subtasks;
  bs.subtasksMeta = { at: sub.at, judge: sub.judge, source: sub.from };
  // 六维 evalGate 写入（有数据才覆盖）
  const g = gateByModel[m.id];
  if (g && g.report.byTask) {
    const dims = {};
    let cnt = 0, sum = 0;
    for (const [task, s] of Object.entries(g.report.byTask)) { dims[task] = s.avg; cnt += s.count; sum += s.avg * s.count; }
    bs.evalGate = { at: (g.report.at || '').slice(0, 10) || sub.at.slice(0, 10), judge: (g.report.judgeModel || '').split('|')[0]?.split('=')[1] || 'glm-5.3(外部)', total: Number((sum / Math.max(cnt, 1)).toFixed(3)), ...dims };
    console.log(`  evalGate 六维: ${Object.entries(dims).map(([k, v]) => k + ' ' + v).join(' · ')} | 有效 ${g.valid} 条`);
  }
  bs.updatedAt = new Date().toISOString().slice(0, 10);
  changed += 1;
  console.log(`${m.id}: ${Object.keys(subtasks).length} 小类已写入`);
  console.log('  ' + Object.entries(subtasks).sort((a, b) => b[1].avg - a[1].avg).map(([k, v]) => `${SUB_LABEL[k] || k} ${v.avg}(${v.n})`).join(' · '));
}

if (dry) { console.log('\n--dry：未写盘'); process.exit(0); }
await saveConfig(config);
console.log(`\n已写回 config/router.json（${changed} 个模型）`);
