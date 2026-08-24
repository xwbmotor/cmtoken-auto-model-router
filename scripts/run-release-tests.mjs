#!/usr/bin/env node
// v0.7.0 六审 P2 / v0.7.3 九审 P2：发布档测试入口 + 可追溯发布报告。
// npm test（纯 Node）允许 replay 因缺 Python skip；正式发布不允许「161 全验证」的虚称——
// AMR_TEST_STRICT_SKIP=1 下 skip 视为失败（t.skip 前抛错），任何 skip 都会非零退出。
// 要求：本机或 CI 提供 CLASSIFIER_PYTHON（能 import sklearn/joblib）后跑此档。
//
// v0.7.3：报告不再人工拼装——本脚本跑完测试后自动落 reports/release-v{ver}-{date}.json，
// 含 commit SHA / dirty 状态 / config SHA256 / 测试命令与退出码（九审 P2：git.head
// = "pending-commit" 无法证明测试对应哪个源码版本）。
import { spawn, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const cwd = process.cwd();
const collect = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };

const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
const git = {
  commit: collect(() => execSync('git rev-parse HEAD', { cwd, encoding: 'utf8' }).trim()),
  branch: collect(() => execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf8' }).trim()),
  dirty: collect(() => {
    const s = execSync('git status --porcelain', { cwd, encoding: 'utf8' }).trim();
    return s.length > 0 ? s.split('\n') : [];
  }, []),
  tag: collect(() => execSync('git describe --tags --exact-match HEAD 2>/dev/null', { cwd, encoding: 'utf8' }).trim()),
};
const configPath = existsSync(join(cwd, 'config/router.json')) ? join(cwd, 'config/router.json') : null;
const configSha256 = configPath ? createHash('sha256').update(readFileSync(configPath)).digest('hex') : null;

const env = { ...process.env, AMR_TEST_STRICT_SKIP: '1' };
const cmd = 'node --test';
const t0 = Date.now();
const child = spawn(process.execPath, ['--test'], { env, stdio: ['ignore', 'pipe', 'pipe'], cwd });

let out = '';
child.stdout.on('data', (c) => { out += c; });
child.stderr.on('data', (c) => { out += c; });

child.on('exit', (code, signal) => {
  const durationMs = Date.now() - t0;
  const num = (re) => { const m = out.match(re); return m ? Number(m[1]) : null; };
  const summary = {
    tests: num(/^ℹ tests (\d+)/m), pass: num(/^ℹ pass (\d+)/m),
    fail: num(/^ℹ fail (\d+)/m), skipped: num(/^ℹ skipped (\d+)/m),
    cancelled: num(/^ℹ cancelled (\d+)/m),
  };
  const report = {
    stamp: new Date().toISOString(),
    version: pkg.version,
    command: cmd, exitCode: code ?? 1, signal: signal ?? null, durationMs,
    summary,
    env: {
      node: process.version, platform: process.platform, arch: process.arch,
      hostname: collect(() => execSync('hostname', { encoding: 'utf8' }).trim()),
      cpus: collect(() => require('node:os').cpus().length),
    },
    git,
    config: { path: 'config/router.json', sha256: configSha256 },
    strict: 'AMR_TEST_STRICT_SKIP=1（任何 skip 视为失败）',
    logTail: out.split(/\r?\n/).slice(-40).join('\n'),
  };
  try {
    mkdirSync(join(cwd, 'reports'), { recursive: true });
    const stamp = report.stamp.replace(/[:.]/g, '-');
    const file = join(cwd, 'reports', `release-v${pkg.version}-${stamp.slice(0, 10)}-${stamp.slice(11, 19)}.json`);
    writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(`\n[test:release] 报告已落盘 ${file}`);
  } catch (e) {
    console.error(`\n[test:release] 报告落盘失败：${e.message}`);
  }
  if (git.dirty.length > 0) {
    console.error(`[test:release] 警告：worktree 不干净（${git.dirty.length} 处未提交）——报告对应 ${git.commit}，发布 tag 前请先 commit。`);
  }
  if (code === 0) {
    console.log('\n[test:release] 全量通过（含 replay，无 skip）。发布档要求满足。');
  } else {
    console.error(`\n[test:release] 失败（exit ${code}）。发布档不允许任何 skip/失败——若因缺 Python，设 CLASSIFIER_PYTHON 指向带 sklearn/joblib 的解释器。`);
  }
  process.exit(code ?? 1);
});