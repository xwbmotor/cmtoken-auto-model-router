#!/usr/bin/env node
// v0.7.0 六审 P2 / v0.7.3 九审 P2 / v0.7.4 十审 P1：发布档测试入口 + 可追溯发布报告。
// npm test（纯 Node）允许 replay 因缺 Python skip；正式发布不允许「161 全验证」的虚称——
// AMR_TEST_STRICT_SKIP=1 下 skip 视为失败（t.skip 前抛错），任何 skip 都会非零退出。
// 要求：本机或 CI 提供 CLASSIFIER_PYTHON（能 import sklearn/joblib）后跑此档。
//
// v0.7.3：报告不再人工拼装——本脚本跑完测试后自动落 reports/release-v{ver}-{date}.json，
// 含 commit SHA / dirty 状态 / config SHA256 / 测试命令与退出码（九审 P2：git.head
// = "pending-commit" 无法证明测试对应哪个源码版本）。
//
// v0.7.4 十审 P1（发布证据链自引用修复）：
//   ①报告是 tag 的**证明**，不能提交进被它证明的同一个 commit（commit 会因加报告而变 SHA）。
//     正确流程：代码+compose commit → 打 tag → 在干净 worktree（tag checkout）跑本脚本 →
//     报告留 workspace 外（reports/ 已加 .gitignore-via-commit-protocol；本脚本同时把
//     报告路径打印出来供作为 Release Artifact 附上）。
//   ②默认要求 clean HEAD + exact tag（HEAD 即 tag 指向的 commit），否则**非零退出**——
//     脏 worktree 的报告不再能冒充正式发布证据。开发期可用 --allow-dirty 显式降级，
//     报告标记 validForRelease=false。
//   ③报告写盘失败=发布失败（exit 2），不再吞掉。
import { spawn, execSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';

const cwd = process.cwd();
const collect = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };
const allowDirty = process.argv.includes('--allow-dirty');

const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
const git = {
  commit: collect(() => execSync('git rev-parse HEAD', { cwd, encoding: 'utf8' }).trim()),
  branch: collect(() => execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf8' }).trim()),
  // 十一审 P2：排除 reports/release-*.json——报告是本脚本上一轮的产物，若计入 dirty
  // 会把「跑过一次 release」变成永远过不了 clean gate 的死锁（.gitignore 只管未来，
  // 门禁还需自身排除，防 gitignore 误删时自锁）。
  dirty: collect(() => {
    const s = execSync('git status --porcelain', { cwd, encoding: 'utf8' }).trim();
    return s.length > 0 ? s.split('\n').map((l) => l.trim()).filter((l) => !/^reports\/release-.*\.json$/.test(l.replace(/^(\?\?| M|M | A|A | D|D |MM|AM)\s+/, ''))) : [];
  }, []),
  // 注意：不能用 `2>/dev/null` shell 重定向——Windows cmd.exe 下 /dev/null 非法路径，
  // 命令整体报错被 collect 吞掉 → tag 恒 null（v0.7.4 十审实测踩坑）。execSync 失败
  // （HEAD 无 exact tag 时 git describe 退出非零）本来就由 collect 捕获，无需重定向。
  tag: collect(() => execSync('git describe --tags --exact-match HEAD', { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()),
};
const configPath = existsSync(join(cwd, 'config/router.json')) ? join(cwd, 'config/router.json') : null;
const configSha256 = configPath ? createHash('sha256').update(readFileSync(configPath)).digest('hex') : null;

// 发布证据链门禁（v0.7.4）：正式模式三条件——clean、HEAD 有 exact tag、tag 与 package.json 版本一致。
const tagExpected = `v${pkg.version}`;
const gate = {
  clean: git.dirty.length === 0,
  onTag: Boolean(git.tag),
  tagMatchesVersion: git.tag === tagExpected,
};
// v0.8.1 十二审 P2：供应链证据进门禁——镜像 ID 与 OCI revision 非空且 revision==HEAD，
// 否则报告不能标 validForRelease（tag 可变，sha256 摘要+revision 才绑定 build 产物）。
const images = {
  routerImageId: collect(() => execSync(`docker images --no-trunc --format "{{.ID}}" cmt-auto-model-router:${pkg.version}`, { encoding: 'utf8' }).trim() || null),
  routerLabelsRevision: collect(() => JSON.parse(execFileSync('docker', ['inspect', `cmt-auto-model-router:${pkg.version}`, '--format', '{{json .Config.Labels}}'], { encoding: 'utf8' }))['org.opencontainers.image.revision'] || null),
};
gate.imageEvidence = Boolean(images.routerImageId) && Boolean(images.routerLabelsRevision) && images.routerLabelsRevision === git.commit;
// v0.10.2 门禁：compose 镜像版本必须与 package.json 一致（防 tag 复现出旧版本）+ 巡检题库存在
// v0.10.3 增强：题库必须合法 JSON 且 56 题；classifier 镜像 tag 必须显式存在（允许与 router 不同版本，但要有镜像证据）
const composeText = collect(() => readFileSync(join(cwd, 'docker-compose.prod.yml'), 'utf8'));
const composeTag = collect(() => (/image:\s*cmt-auto-model-router:([^\s#]+)/.exec(composeText) || [])[1]);
gate.composeVersionMatches = composeTag === pkg.version;
const evalCases = collect(() => {
  const parsed = JSON.parse(readFileSync(join(cwd, 'config/eval-gate.json'), 'utf8'));
  return Array.isArray(parsed?.cases) ? parsed.cases.length : -1;
});
gate.evalGateCasesPresent = evalCases === 56;
if (!gate.evalGateCasesPresent) console.error(`[test:release] 题库校验失败：期望 56 题，实际 ${evalCases}`);
const classifierTag = collect(() => (/image:\s*cmt-amr-classifier:([^\s#]+)/.exec(composeText) || [])[1]);
gate.classifierTagPresent = Boolean(classifierTag);
const classifierImageId = collect(() => classifierTag ? execSync(`docker images --no-trunc --format "{{.ID}}" cmt-amr-classifier:${classifierTag}`, { encoding: 'utf8' }).trim() || null : null);
const classifierLabelsRevision = collect(() => classifierTag ? JSON.parse(execFileSync('docker', ['inspect', `cmt-amr-classifier:${classifierTag}`, '--format', '{{json .Config.Labels}}'], { encoding: 'utf8' }))['org.opencontainers.image.revision'] || null : null);
images.classifierImageId = classifierImageId;          // 进 release 报告证据链
images.classifierLabelsRevision = classifierLabelsRevision;
gate.classifierImageBuilt = Boolean(classifierImageId);
// v0.10.5：revision 必须是 40 位 Git SHA（unlabeled/任意伪造串不再通过），且记录 rootfs 层 digest 证据
// 用 --format json 输出整对象再 JS 解析（避开 Windows shell 的 Go template 引号转义问题）
const classifierInspect = collect(() => classifierTag ? JSON.parse(execSync(`docker inspect cmt-amr-classifier:${classifierTag} --format "{{json .}}"`, { encoding: 'utf8' })) : null);
const labels = classifierInspect?.Config?.Labels || {};
const CLASSIFIER_REV_SHA = /^[0-9a-f]{40}$/;
images.classifierRootfsLayers = classifierInspect?.RootFS?.Layers || null;
// v0.11.3：强绑定——revision 必须等于 classifier 发布 tag（v{classifierTag}）指向的 commit。
// git rev-parse 'v0.9.7^{commit}' 得到 tag 的 commit；与镜像 OCI revision 一致才通过。
// 任意历史 commit / 伪造 SHA 不再通过；classifier 独立版本线 = 打自己的 vX.Y.Z tag。
const revRaw = labels['org.opencontainers.image.revision'] || null;
const revIsSha = Boolean(revRaw && CLASSIFIER_REV_SHA.test(revRaw));
const classifierTagCommit = collect(() => classifierTag ? execFileSync('git', ['rev-parse', `v${classifierTag}^{commit}`], { cwd, encoding: 'utf8' }).trim() : null); // 二十九审 P1-1：execSync 过 cmd.exe 单引号不剥离→ambiguous argument；去 shell 用 argv
images.classifierTagCommit = classifierTagCommit; // 期望源码 commit 入报告（可复核）
gate.classifierRevisionMatchesTag = Boolean(revRaw && classifierTagCommit && revRaw === classifierTagCommit);
gate.classifierRevisionIsSha = revIsSha && gate.classifierRevisionMatchesTag;
const validForRelease = gate.clean && gate.onTag && gate.tagMatchesVersion && gate.imageEvidence && gate.composeVersionMatches && gate.evalGateCasesPresent && gate.classifierTagPresent && gate.classifierImageBuilt && gate.classifierRevisionIsSha;
if (!validForRelease && !allowDirty) {
  console.error('[test:release] 发布证据链门禁未过：' + JSON.stringify({ ...gate, tag: git.tag, tagExpected, dirtyCount: git.dirty.length }));
  console.error('  正式发布流程：代码+compose 同 commit → docker build --build-arg GIT_REVISION=<HEAD> → git tag v{ver} → 干净 worktree 跑 npm run test:release。');
  console.error('  开发调试可加 --allow-dirty（报告标记 validForRelease=false，不作为发布证据）。');
  process.exit(3);
}

// 二十九审 P2-3：全测试树统一注入临时 counters 路径——其余 ~31 个启动点不再读写仓库 data/
const env = { ...process.env, AMR_COUNTERS_PATH: resolve(cwd, 'data', `counters-test-${process.pid}.json`), AMR_TEST_STRICT_SKIP: '1' };
const cmd = 'node --test --test-concurrency=1'; // v0.11.11（二十六审 P1-4）：串行——ui-regression 与其他 e2e 并发 spawn 会挂起
const t0 = Date.now();
const child = spawn(process.execPath, ['--test', '--test-concurrency=1'], { env, stdio: ['ignore', 'pipe', 'pipe'], cwd });

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
  // v0.11.13（二十七审 P1-2④）：汇总 fail-closed——任何字段解析失败（null，如 TAP 格式差异）发布档一律判失败
  if (validForRelease && Object.values(summary).some((v) => v === null)) {
    console.error('[test:release] 汇总解析失败（null）——fail-closed 判失败: ' + JSON.stringify(summary));
    process.exit(5);
  }
  const report = {
    stamp: new Date().toISOString(),
    version: pkg.version,
    validForRelease,
    gate,
    allowDirty,
    command: cmd, exitCode: code ?? 1, signal: signal ?? null, durationMs,
    summary,
    env: {
      node: process.version, platform: process.platform, arch: process.arch,
      hostname: collect(() => execSync('hostname', { encoding: 'utf8' }).trim()),
      cpus: collect(() => cpus().length),
    },
    git,
    // 十一审建议：记录本地镜像 image ID——tag 是可变的，image ID（sha256 摘要）才与 build 产物
    // 密码学绑定。云端部署后 docker inspect 对照，验证「运行镜像确实对应本报告」。
    images,
    config: { path: 'config/router.json', sha256: configSha256 },
    strict: 'AMR_TEST_STRICT_SKIP=1（任何 skip 视为失败）',
    logTail: out.split(/\r?\n/).slice(-40).join('\n'),
  };
  let reportPath = null;
  try {
    mkdirSync(join(cwd, 'reports'), { recursive: true });
    const stamp = report.stamp.replace(/[:.]/g, '-');
    reportPath = join(cwd, 'reports', `release-v${pkg.version}-${stamp.slice(0, 10)}-${stamp.slice(11, 19)}.json`);
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\n[test:release] 报告已落盘 ${reportPath}`);
  } catch (e) {
    console.error(`\n[test:release] 报告落盘失败（视为发布失败）：${e.message}`);
    process.exit(2);
  }
  if (!gate.clean) console.error(`[test:release] worktree 不干净（${git.dirty.length} 处）${allowDirty ? '——--allow-dirty 降级，报告不可作发布证据' : ''}`);
  if (!gate.onTag) console.error('[test:release] HEAD 无 exact tag——报告对应的 commit 不是发布 tag。');
  else if (!gate.tagMatchesVersion) console.error(`[test:release] tag ${git.tag} 与 package.json ${tagExpected} 不一致。`);
  if (!gate.imageEvidence) console.error(`[test:release] 镜像证据不完整或 revision 不等于 HEAD（imageId=${images.routerImageId}, revision=${images.routerLabelsRevision}, HEAD=${git.commit}）——先 docker build --build-arg GIT_REVISION=${git.commit} 。`);
  // v0.11.11（二十六审 P1-4）：报告层终检——发布档 skipped 必须=0（含 UI 测试静默 skip 的情形）
  if (validForRelease && (summary.skipped > 0 || summary.fail > 0)) {
    console.error(`[test:release] 发布门禁终检失败：skipped=${summary.skipped} fail=${summary.fail}——发布档不允许任何 skip/失败。`);
    process.exit(4);
  }
  if (code === 0 && validForRelease) {
    console.log(`\n[test:release] 全量通过（含 replay，无 skip）且发布证据链完整（tag=${git.tag}）。`);
    console.log('[test:release] 注意：报告不提交回 tag——作为 Release Artifact 归档（reports/ 目录已被协议排除）。');
  } else if (code === 0) {
    console.log('\n[test:release] 测试通过，但本报告不构成发布证据（validForRelease=false）。');
  } else {
    console.error(`\n[test:release] 失败（exit ${code}）。发布档不允许任何 skip/失败——若因缺 Python，设 CLASSIFIER_PYTHON 指向带 sklearn/joblib 的解释器。`);
  }
  process.exit(code ?? 1);
});
