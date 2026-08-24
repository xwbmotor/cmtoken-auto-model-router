#!/usr/bin/env node
// v0.7.0 六审 P2：发布档测试入口。
// npm test（纯 Node）允许 replay 因缺 Python skip；正式发布不允许「161 全验证」的虚称——
// AMR_TEST_STRICT_SKIP=1 下 skip 视为失败（t.skip 前抛错），任何 skip 都会非零退出。
// 要求：本机或 CI 提供 CLASSIFIER_PYTHON（能 import sklearn/joblib）后跑此档。
import { spawn } from 'node:child_process';

const env = { ...process.env, AMR_TEST_STRICT_SKIP: '1' };
const child = spawn(process.execPath, ['--test'], { env, stdio: 'inherit', cwd: process.cwd() });
child.on('exit', (code, signal) => {
  if (code === 0) {
    console.log('\n[test:release] 全量通过（含 replay，无 skip）。发布档要求满足。');
  } else {
    console.error(`\n[test:release] 失败（exit ${code}）。发布档不允许任何 skip/失败——若因缺 Python，设 CLASSIFIER_PYTHON 指向带 sklearn/joblib 的解释器。`);
  }
  process.exit(code ?? 1);
});
