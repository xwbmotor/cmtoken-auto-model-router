#!/usr/bin/env node
import { readFile, mkdir, open, link, unlink, rmdir, realpath } from 'node:fs/promises';
import { resolve, dirname, join, relative, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { prepareRoutingLearningData, RoutingLearningDataValidationError } from '../src/learning-data.mjs';
import { RoutingMatrixValidationError } from '../src/routing-matrix.mjs';
import { RoutingRequestValidationError } from '../src/request-features.mjs';

const HELP = `准备离线路由学习数据（本地只读输入，不调用模型、不读取密钥）
node scripts/prepare-routing-learning.mjs --matrix matrix.json --requests requests.json --out-dir new-directory
  --matrix PATH      冻结的矩阵；train/validation 结果须完整，test 可尚无结果
  --requests PATH    {schemaVersion:1,requests:[{taskId,request,eligibleCandidateIds?}]}
  --out-dir PATH     必须不存在，父目录须已存在；生成 fit.json、blind.json、preparation.json
  --help, -h         显示帮助
fit 仅含 train/validation 特征与标签；blind 仅含 test 特征、候选与声明的资格。
请求哈希必须匹配冻结清单。未知请求字段、缺失/额外请求、跨组泄漏均拒绝。
退出码：0=准备完成（不表示数据真实或线上有效）；2=命令/协议错误；1=文件系统错误。
仅 preparation.json 含完整源文件哈希；预测进程不应读取它或完整矩阵/requests。
协议及特征定义见 docs/routing-learning-data.md。`;

function args(argv) {
  const result = {}, seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') { result.help = true; continue; }
    const key = ({ '--matrix': 'matrix', '--requests': 'requests', '--out-dir': 'outDir' })[flag];
    if (!key || seen.has(key)) throw new RoutingLearningDataValidationError('CLI', `未知或重复参数：${flag}`);
    seen.add(key);
    const value = argv[++i];
    if (!value || value.startsWith('-')) throw new RoutingLearningDataValidationError('CLI', `${flag} 缺少值`);
    result[key] = value;
  }
  if (!result.help && (!result.matrix || !result.requests || !result.outDir)) throw new RoutingLearningDataValidationError('CLI', '必须提供 --matrix、--requests 和 --out-dir');
  return result;
}

const digest = (source) => createHash('sha256').update(source).digest('hex');
const serialize = (value) => JSON.stringify(value, null, 2) + '\n';
const parse = (source) => JSON.parse(source.replace(/^\uFEFF/, ''));

// Atomic no-replace publication for each artifact. preparation.json is published last
// as the completion marker; this is not a cross-file transaction or an OS read sandbox.
async function publish(directory, name, content, owned) {
  const temporary = join(directory, `.${name}.${randomUUID()}.tmp`), final = join(directory, name);
  const handle = await open(temporary, 'wx', 0o600);
  owned.add(temporary);
  try { await handle.writeFile(content, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  await link(temporary, final); // Unlike rename, link cannot replace an existing destination.
  owned.add(final);
  await unlink(temporary);
  owned.delete(temporary);
}

async function main() {
  const options = args(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const matrixPath = await realpath(resolve(options.matrix)), requestsPath = await realpath(resolve(options.requests));
  const parent = await realpath(dirname(resolve(options.outDir)));
  const directory = join(parent, relative(dirname(resolve(options.outDir)), resolve(options.outDir)));
  for (const input of [matrixPath, requestsPath]) {
    const rel = relative(directory, input);
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) throw new RoutingLearningDataValidationError('CLI.outDir', '输出目录不能覆盖输入或包含输入');
  }
  const [matrixSource, requestsSource] = await Promise.all([readFile(matrixPath, 'utf8'), readFile(requestsPath, 'utf8')]);
  const { fit, blind } = prepareRoutingLearningData(parse(matrixSource), parse(requestsSource));
  const fitJson = serialize(fit), blindJson = serialize(blind);
  const manifest = {
    schemaVersion: 1, kind: 'routing-learning-preparation', status: 'complete', preparedAt: new Date().toISOString(),
    source: { matrix: { path: matrixPath, sha256: digest(matrixSource) }, requests: { path: requestsPath, sha256: digest(requestsSource) } },
    artifacts: { fit: { file: 'fit.json', sha256: digest(fitJson) }, blind: { file: 'blind.json', sha256: digest(blindJson) } },
    datasetId: fit.dataset.id, evidenceKind: fit.dataset.evidenceKind,
    counts: { train: fit.tasks.filter((task) => task.split === 'train').length,
      validation: fit.tasks.filter((task) => task.split === 'validation').length, test: blind.tasks.length, candidates: fit.candidates.length },
    eligibility: { callerDeclared: blind.tasks.filter((task) => task.eligibilitySource === 'caller_declared').length,
      requiresConfirmation: blind.tasks.filter((task) => task.eligibilitySource === 'requires_confirmation').length,
      onlineEligibilityVerified: false },
    testOutcomesIncludedInFit: false, testOutcomesIncludedInBlind: false, sourceEvidenceIndependentlyVerified: false,
    productionSuperiorityEstablished: false
  };
  await mkdir(directory, { mode: 0o700 }); // Exclusive reservation; never reuse an existing directory.
  const owned = new Set();
  try {
    await publish(directory, 'fit.json', fitJson, owned);
    await publish(directory, 'blind.json', blindJson, owned);
    await publish(directory, 'preparation.json', serialize(manifest), owned);
  } catch (error) {
    // Only unlink exact files created by this run; leave any unexpected foreign file intact.
    for (const path of owned) await unlink(path).catch(() => {});
    await rmdir(directory).catch(() => {});
    throw error;
  }
  console.log(serialize({ status: 'prepared', outputDirectory: directory, files: ['fit.json', 'blind.json', 'preparation.json'],
    evidenceKind: fit.dataset.evidenceKind, onlineEligibilityVerified: false, productionSuperiorityEstablished: false }).trim());
}

try { await main(); }
catch (error) {
  process.stderr.write(`prepare-routing-learning: ${error.message}\n`);
  process.exitCode = [RoutingLearningDataValidationError, RoutingMatrixValidationError, RoutingRequestValidationError, SyntaxError].some((kind) => error instanceof kind) ? 2 : 1;
}
