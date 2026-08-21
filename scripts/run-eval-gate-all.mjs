// eval-gate 多模型串行调度器：解决 bash 后台启动 node 子进程的 stdin 问题
// 用法：node scripts/run-eval-gate-all.mjs
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const JUDGE = 'url=https://api.z.ai/api/coding/paas/v4|model=glm-5.3|key=GLMCODE_API_KEY';
const MODELS = [];
const LOG = 'C:/Users/xwbmo/AppData/Local/Temp/gate56-all.log';
import { writeFileSync, appendFileSync } from 'node:fs';
function logSync(m) { appendFileSync(LOG, m + '\n'); }

const args = process.argv.slice(2);
let pending = args.length ? args : ['qwen36-35b', 'Qwen3.8-27B'];
for (const m of pending) {
  let outFile = 'model-' + m + '.json';
  // 文件名还原：deepseekv4-flash/Qwen3.8-27B/qwen36-35b → 直接用
  MODELS.push([m, outFile]);
}
logSync(`=== start ${new Date().toISOString()} pending=${pending.join(',')} ===`);

async function runOne(model, out) {
  return new Promise((resolveP) => {
    logSync(`\n\n===== ${model} =====`);
    const child = spawn(process.execPath, [
      '--env-file-if-exists=.env',
      'scripts/eval-gate.mjs',
      '--model', model,
      '--judge', JUDGE,
      '--out', `data/eval-gate/${out}`
    ], { stdio: ['ignore', 'ignore', 'ignore'], detached: false });
    child.on('exit', (code, signal) => {
      const stamp = new Date().toISOString();
      logSync(`[${stamp}] ${model} exit=${code} signal=${signal}`);
      logSync(`===== ${model} 完成 =====`);
      resolveP({ model, code });
    });
    child.on('error', (e) => { logSync(`${model} error: ${e.message}`); resolveP({ model, code: -1 }); });
  });
}

for (const [model, out] of MODELS) {
  await runOne(model, out);
}
logSync('\n\n=== 全部完成 ===');