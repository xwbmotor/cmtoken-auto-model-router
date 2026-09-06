// Explicit, versioned model evidence import. Defaults to merging named subtasks;
// never discovers the latest partial file or silently consumes historical scores.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getConfigRevision, loadConfig, projectRoot, saveConfig } from '../src/config.mjs';
import { planEvaluationImport } from './evaluation-import.mjs';

async function main() {
  const args = process.argv.slice(2);
  const subPaths = [], gatePaths = [];
  let dry = false, mode = 'merge';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry') { dry = true; continue; }
    if (args[i] === '--help') {
      console.log('node scripts/apply-eval-to-models.mjs --report 新小类报告.json [--report 增量报告.json] [--gate-report 新单模型报告.json] [--mode merge|replace] [--dry]');
      console.log('merge 保留未覆盖的小类，不把旧聚合分混入新均值；replace 明确重建受影响模型的指定数据层。历史协议必须重评。');
      return;
    }
    if (!['--report', '--gate-report', '--mode'].includes(args[i]) || args[i + 1] == null) throw new Error(`未知参数或缺少值：${args[i]}`);
    const flag = args[i], value = args[++i];
    if (flag === '--report') subPaths.push(value);
    else if (flag === '--gate-report') gatePaths.push(value);
    else mode = value;
  }
  if (!subPaths.length && !gatePaths.length) throw new Error('必须显式指定 --report 或 --gate-report；禁止默认选择最新片段覆盖能力档案');
  const load = async (path) => ({ path, report: JSON.parse(await readFile(resolve(projectRoot, path), 'utf8')) });
  const [config, subtaskReports, gateReports] = await Promise.all([loadConfig(), Promise.all(subPaths.map(load)), Promise.all(gatePaths.map(load))]);
  const planned = planEvaluationImport(config, { subtaskReports, gateReports, mode });
  console.log(JSON.stringify({ mode, dry, changes: planned.changes }, null, 2));
  if (dry) { console.log('--dry：未写盘'); return; }
  const saved = await saveConfig(planned.config, { expectedRevision: getConfigRevision(config) });
  console.log(`已写回模型证据档案，配置版本 ${saved.version}；quality 主档未由本脚本自动更改。`);
}

main().catch((error) => { console.error('评测导入失败：', error.message); process.exitCode = 2; });
