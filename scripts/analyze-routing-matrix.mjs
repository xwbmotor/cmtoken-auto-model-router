#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { analyzeRoutingMatrix } from '../src/routing-matrix.mjs';
import { mergeLearningSelections } from './learning-policy-files.mjs';
import { analyzeLearningPredictions } from '../src/learning-diagnostics.mjs';

const HELP = `离线业务任务矩阵分析（不读取密钥、不调用模型）
node scripts/analyze-routing-matrix.mjs --input matrix.json [--out report.json]
  --selections FILE                  附加独立盲化预测结果；校验来源，不覆盖已有策略
  --selection-split validation|train   基线选择集，默认 validation；禁止 test
  --min-test-groups N                 最少独立测试组，默认 30（不是统计保证）
  --bootstrap N                      配对组级 bootstrap 次数，默认 1000；0 关闭
  --seed N                           uint32 随机种子，默认 42
退出码：0=可进行有限范围离线比较；2=数据/覆盖不足或演示，报告仍输出；1=输入/命令错误。
任何退出码都不代表已证明生产优越性。数据契约见 docs/routing-matrix.md。`;

function parseArgs(argv) {
  const args = { options: {} };
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') { args.help = true; continue; }
    const key = ({ '--input': 'input', '-i': 'input', '--out': 'out', '-o': 'out', '--selections': 'selections', '--selection-split': 'selectionSplit', '--min-test-groups': 'minTestGroups', '--bootstrap': 'bootstrapIterations', '--seed': 'seed' })[flag];
    if (!key || seen.has(key)) throw new Error(`未知或重复参数：${flag}`);
    seen.add(key);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`${flag} 缺少值`);
    if (['input', 'out', 'selections'].includes(key)) args[key] = value;
    else args.options[key] = key === 'selectionSplit' ? value : Number(value);
  }
  if (!args.help && !args.input) throw new Error('缺少 --input；使用 --help 查看数据契约入口。');
  return args;
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) console.log(HELP);
  else {
    const inputPath = resolve(args.input);
    if (args.out && resolve(args.out).toLowerCase() === inputPath.toLowerCase()) throw new Error('--out 不能覆盖输入矩阵');
    if (args.out && args.selections && resolve(args.out).toLowerCase() === resolve(args.selections).toLowerCase()) throw new Error('--out 不能覆盖预测选择文件');
    const source = await readFile(inputPath, 'utf8');
    let matrix = JSON.parse(source.replace(/^\uFEFF/, ''));
    let learning = null;
    if (args.selections) {
      const selectionSource = await readFile(resolve(args.selections), 'utf8');
      const bundle = JSON.parse(selectionSource.replace(/^\uFEFF/, ''));
      const merged = mergeLearningSelections(matrix, bundle);
      matrix = merged.matrix;
      learning = { ...bundle.provenance, claimBlockers: merged.blockers,
        heldOutDiagnostics: analyzeLearningPredictions(matrix, bundle),
        source: { path: resolve(args.selections), sha256: createHash('sha256').update(selectionSource).digest('hex') } };
    }
    const report = analyzeRoutingMatrix(matrix, args.options);
    report.source = { path: inputPath, sha256: createHash('sha256').update(source).digest('hex') };
    if (learning) {
      report.learningExperiment = learning;
      report.claimAssessment.blockers.push(...learning.claimBlockers);
      report.claimAssessment.offlineAnalysisEligible = report.claimAssessment.blockers.length === 0;
      report.claimAssessment.status = report.claimAssessment.offlineAnalysisEligible ? 'offline_comparison_only' : 'blocked';
    }
    const json = JSON.stringify(report, null, 2) + '\n';
    if (args.out) {
      const outputPath = resolve(args.out);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, json, 'utf8');
    }
    process.stdout.write(json);
    if (!report.claimAssessment.offlineAnalysisEligible) {
      process.stderr.write(`离线比较尚未具备完整证据：${report.claimAssessment.blockers.map((item) => item.code).join(', ')}\n`);
      process.exitCode = 2;
    }
  }
} catch (error) {
  process.stderr.write(`routing-matrix: ${error.message}\n`);
  process.exitCode = 1;
}
