// benchmark → quality 先验映射脚本。
// 用法：node scripts/benchmark-to-quality.mjs [benchmark-data.json 路径]
// 默认读取 config/benchmark-data.json。
// 作用：读 benchmark 数据文件，按 task 映射表把分数折算为 quality 先验，
//       写回 config/router.json（更新 models[].quality + 留痕 models[].benchmarkScores）。
// 复用 config.mjs 的 saveConfig：自动校验、version+1、写 history、原子落盘。
import { readFile } from 'node:fs/promises';
import { loadConfig, saveConfig } from '../src/config.mjs';
import { computeQualityPrior } from '../src/benchmark.mjs';

const dataPath = process.argv[2] || 'config/benchmark-data.json';

let data;
try {
  data = JSON.parse(await readFile(dataPath, 'utf8'));
} catch (error) {
  console.error(`读取 benchmark 数据失败: ${dataPath} — ${error.message}`);
  console.error('请参照 config/benchmark-data.json.example 创建该文件。');
  process.exit(1);
}

if (!data.mapping || typeof data.mapping !== 'object') {
  console.error('benchmark-data.json 缺少 mapping 对象（task → benchmark key 数组）。');
  process.exit(1);
}
if (!data.models || typeof data.models !== 'object') {
  console.error('benchmark-data.json 缺少 models 对象（model id → benchmark 分数）。');
  process.exit(1);
}

const config = await loadConfig();
const scaleFactor = data.scaleFactor ?? 1;
let updated = 0;
for (const modelConfig of config.models) {
  const modelBenchmarks = data.models[modelConfig.id];
  if (!modelBenchmarks || typeof modelBenchmarks !== 'object') continue;
  const qualityPrior = computeQualityPrior(modelBenchmarks, data.mapping, scaleFactor);
  if (!Object.keys(qualityPrior).length) continue;
  // 保留原有 quality 里的其他 key（如 tier 维度 simple），只覆盖 task 维度 + default
  modelConfig.quality = { ...modelConfig.quality, ...qualityPrior };
  modelConfig.benchmarkScores = {
    scores: { ...modelBenchmarks },
    source: data.source || 'manual',
    updatedAt: data.updatedAt || new Date().toISOString()
  };
  updated += 1;
  console.log(`  ${modelConfig.id}: ${JSON.stringify(qualityPrior)}`);
}

if (!updated) {
  console.log('没有模型在 benchmark-data.json 中有匹配的 benchmark 分数，配置未改动。');
  process.exit(0);
}

const next = await saveConfig(config);
console.log(`已更新 ${updated} 个模型的 quality 先验，软件版本 ${next.version}。`);
