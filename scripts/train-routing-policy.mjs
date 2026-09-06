#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { fitLearningPolicy } from '../src/learned-routing.mjs';
import { makePolicyFile, writeNewJson } from './learning-policy-files.mjs';

const HELP = `离线拟合请求级路由策略（不读取测试结果、不调用模型、不更新服务）
node scripts/train-routing-policy.mjs --input prepared/fit.json --out policy.json
  --quality-floor N              预测概率门槛，默认 0.8；不是成功保证
  --rel-quality-cap N            允许与最高预测概率的差，默认 0.05
  --min-train-groups N           最少独立训练组，默认 20
  --min-validation-groups N      最少独立验证组，默认 20
  --allow-demo                   允许演示/合成数据的软件测试；仍返回 2
输出文件必须不存在。退出码：0=离线模型已拟合；2=只供演示或证据不足；1=输入/执行错误。
任何退出码都不代表生产验证或已优于固定模型。`;

try {
  const args = { options: {} }, seen = new Set();
  for (let i = 2; i < process.argv.length; i++) {
    const flag = process.argv[i];
    if (flag === '--help' || flag === '-h') { args.help = true; continue; }
    if (seen.has(flag)) throw new Error(`重复参数：${flag}`);
    seen.add(flag);
    if (flag === '--allow-demo') { args.allowDemo = true; continue; }
    const key = ({ '--input': 'input', '--out': 'out', '--quality-floor': 'qualityFloor', '--rel-quality-cap': 'relQualityCap', '--min-train-groups': 'minTrainGroups', '--min-validation-groups': 'minValidationGroups' })[flag];
    if (!key) throw new Error(`未知参数：${flag}`);
    const value = process.argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`${flag} 缺少值`);
    if (key === 'input' || key === 'out') args[key] = value;
    else args.options[key] = Number(value);
  }
  if (args.help) console.log(HELP);
  else {
    if (!args.input || !args.out) throw new Error('必须提供 --input 和 --out');
    const fit = JSON.parse((await readFile(args.input, 'utf8')).replace(/^\uFEFF/, ''));
    if (fit.dataset?.evidenceKind !== 'observed' && !args.allowDemo) throw new Error('演示/合成数据必须显式 --allow-demo，不能当作真实训练证据');
    const model = fitLearningPolicy(fit, args.options);
    const file = makePolicyFile(model, fit);
    const output = await writeNewJson(args.out, file, [args.input]);
    console.log(JSON.stringify({ output, modelHash: file.modelHash, evidenceKind: fit.dataset.evidenceKind, readiness: model.readiness,
      mode: model.mode, productionValidated: false }, null, 2));
    if (fit.dataset.evidenceKind !== 'observed' || !model.readiness?.learningReady) process.exitCode = 2;
  }
} catch (error) { console.error(`train-routing-policy: ${error.message}`); process.exitCode = 1; }
