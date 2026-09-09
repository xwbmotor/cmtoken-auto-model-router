// Independent Node oracle -> Go NDJSON replay. No upstream calls or production credentials.
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/config.mjs';
import { analyzeRequest, routeRequest } from '../../src/router.mjs';
import { decisionInput, referenceError, selectionProjection } from './contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const arg = name => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
if (!arg('--binary')) throw new Error('Usage: node go-core/compat/verify.mjs --binary <amr-core> [--out <report>]');
const binary = resolve(arg('--binary'));
process.env.CONFIG_PATH = resolve(root, 'config/router.json');
const original = await loadConfig();
const now = 1700000000000;
const body = { model: original.routing.autoModelId, messages: [{ role: 'user', content: '写一个 Python 函数处理 CSV 文件' }], max_tokens: 8192 };
const cases = [];
function scenario(id, edit = () => {}) {
  const value = { id, body: structuredClone(body), config: structuredClone(original), runtime: { now, trafficBucket: 0 } };
  edit(value); cases.push(value);
}

for (const item of JSON.parse(readFileSync(resolve(root, 'config/eval-gate.json'), 'utf8')).cases) {
  for (const stream of [false, true]) scenario(`eval:${item.id}:${stream}`, x => { x.body.messages[0].content = item.prompt; x.body.stream = stream; });
}
scenario('all-disabled', x => x.config.models.forEach(m => m.enabled = false));
scenario('all-unknown', x => x.config.models.forEach(m => m.ownership = 'unknown'));
scenario('entitlements-empty', x => x.runtime.allowedModelIds = new Set());
scenario('entitlements-single', x => x.runtime.allowedModelIds = new Set([x.config.models[0].id]));
scenario('full-pool', x => x.runtime.modelLoad = Object.fromEntries(x.config.models.map(m => [m.id, { inflight: x.config.routing.loadBalancing.limits[m.id] }])));
scenario('full-pool-disabled-protection', x => { x.config.routing.loadBalancing.enabled = false; x.runtime.modelLoad = Object.fromEntries(x.config.models.map(m => [m.id, { inflight: 999 }])); });
scenario('no-local-limit', x => { delete x.config.routing.loadBalancing.limits; x.runtime.modelLoad = Object.fromEntries(x.config.models.map(m => [m.id, { inflight: 999 }])); });
scenario('quality-gate', x => x.config.routing.qualityFloor = 1);
scenario('explicit-degradation', x => { x.config.routing.qualityFloor = 1; x.config.routing.allowQualityDegradation = true; });
scenario('unknown-score-strategy', x => x.config.routing.scoreStrategy = 'not-implemented');
scenario('shadow-unsafe', x => { x.config.routing.mode = 'shadow'; x.config.routing.shadowModel = 'absent'; });
scenario('shadow-qualified', x => x.config.routing.mode = 'shadow');
scenario('gray-zero', x => x.config.routing.activeTrafficPercent = 0);
scenario('gray-equal', x => { x.config.routing.activeTrafficPercent = 35; x.runtime.trafficBucket = 35; });
scenario('gray-below', x => { x.config.routing.activeTrafficPercent = 35; x.runtime.trafficBucket = 34.999; });
scenario('gray-rounding', x => { x.config.routing.activeTrafficPercent = 40; x.runtime.trafficBucket = 39.995; });
scenario('budget-pressure', x => x.runtime.budgetPressure = 1);
scenario('empty-quality-map', x => x.config.models.forEach(m => m.quality = {}));
scenario('full-request-capacity', x => { x.body.messages.unshift({ role: 'system', content: 'x'.repeat(120000) }); x.config.models.forEach(m => m.contextWindow = 16000); x.runtime.analysisOverride = { ...analyzeRequest(x.body, x.config), estimatedContextTokens: 1 }; });
scenario('capability-unknown', x => { x.body.tools = [{ type: 'function', function: { name: 'search', parameters: { type: 'object' } } }]; x.config.models.forEach(m => delete m.capabilities.tools); });
scenario('vision-json-required', x => { x.body.response_format = { type: 'json_object' }; x.body.messages[0].content = [{ type: 'text', text: '提取图片内容' }, { type: 'image_url', image_url: { url: 'https://example.invalid/image.png' } }]; });
for (const flag of [undefined, true, false]) scenario(`low-budget-thinking-${flag}`, x => {
  x.body.messages[0].content = '只返回 JSON'; x.body.max_tokens = 64;
  if (flag !== undefined) x.body.chat_template_kwargs = { enable_thinking: flag };
  x.config.models.forEach(m => { m.minimumCompletionTokensForReliableAnswer = 1024; m.reasoningControl = { verified: true, parameter: 'chat_template_kwargs.enable_thinking', values: { off: false, standard: true, high: true } }; });
});
for (const tier of ['budget', 'balanced', 'quality', 'max', 'custom']) scenario(`price-${tier}`, x => x.config.routing.costTier = tier);
for (const seed of [4, 8, 32, 100]) scenario(`subtask-samples-${seed}`, x => {
  x.runtime.analysisOverride = { ...analyzeRequest(x.body, x.config), task: 'coding', subTask: 'code-generation' };
  x.config.models.forEach((m, i) => { m.benchmarkScores = { subtasks: { 'code-generation': { avg: i % 2 ? 0.1 : 1, n: seed } } }; });
});

// Fixed seed ensures the exact corpus can be regenerated by another developer.
let state = 20260909;
function random() { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; }
const pick = values => values[Math.floor(random() * values.length)];
const tasks = ['coding', 'reasoning', 'creative', 'extraction', 'default', 'agent'];
const numberOfRandomCases = 3000;
for (let index = 0; index < numberOfRandomCases; index++) scenario(`seed:20260909:${index}`, x => {
  const task = pick(tasks), tier = pick(['simple', 'balanced', 'complex']);
  const complexity = pick([0, 0.3, 0.5, 0.5999, 0.6, 0.78, 1]);
  x.runtime.analysisOverride = { ...analyzeRequest(x.body, x.config), task, tier, complexity, subTask: 'fixture', requirements: { chat: true, stream: true, tools: random() < 0.15, json: random() < 0.15, vision: random() < 0.05 } };
  Object.assign(x.config.routing, { mode: pick(['active', 'shadow']), activeTrafficPercent: pick([0, 5, 35, 100]), qualityFloor: pick([0.5, 0.72, 0.8, 0.95]),
    qualityWeight: pick([0.5, 1, 1.5]), costWeight: random(), providerCostWeight: random()/2, latencyWeight: random()/2,
    allowQualityDegradation: random() < 0.1, costTier: pick(['custom', 'custom', 'budget', 'balanced', 'quality', 'max']),
    preferSelfHosted: random() < 0.5, selfHostedBonus: random()/3, relQualityCap: pick([0.02, 0.04, 0.08, '0.1']),
    taskPreferences: { [task]: { model: pick(x.config.models).id, tolerance: pick([0, 0.02, 0.1, 1]) } } });
  x.runtime.trafficBucket = random()*100;
  x.runtime.budgetPressure = pick([0, 0.5, 0.9, 1]);
  x.runtime.health = {}; x.runtime.modelLoad = {}; x.runtime.marketSignals = { [task]: {} };
  if (random() < 0.25) x.runtime.allowedModelIds = new Set(x.config.models.filter(() => random() < 0.7).map(m => m.id));
  x.config.models.forEach(m => {
    m.enabled = random() > 0.08; m.ownership = pick(['self_hosted', 'self_hosted', 'third_party', 'unknown']);
    m.quality = Object.fromEntries(tasks.map(t => [t, pick([0.5, 0.72, 0.8, 0.88, 0.9, 0.95, 1])]));
    m.costIndex = random(); m.costIndexProvider = random(); m.latencyIndex = random();
    m.reliabilityStatus = pick(['verified', 'unverified']);
    m.benchmarkScores = { subtasks: { fixture: { avg: random(), n: pick([0, 1, 3, 4, 8, 32, 100]) } } };
    m.capabilities = { tools: random() < 0.8, json: random() < 0.8, vision: random() < 0.5 };
    x.runtime.health[m.id] = { circuitOpenUntil: random() < 0.05 ? now+1000 : 0, ewmaLatencyMs: random()*50000, consecutiveFailures: pick([0, 0, 1, 2]) };
    const capacity = pick([1, 10, 100]); x.config.routing.loadBalancing.limits[m.id] = capacity;
    x.runtime.modelLoad[m.id] = { inflight: Math.floor(random()*(capacity+2)) };
    x.runtime.marketSignals[task][m.id] = (random()-0.5)*0.1;
  });
});

const inputs = cases.map(c => decisionInput(c.body, c.config, c.runtime));
const inputText = inputs.map(x => JSON.stringify(x)).join('\n') + '\n';
const run = spawnSync(binary, ['replay'], { input: inputText, encoding: 'utf8', maxBuffer: 96*1024*1024, timeout: 90000, windowsHide: true });
if (run.error || run.status !== 0) throw new Error(`Go replay failed: ${run.error?.message || run.stderr}`);
const results = run.stdout.trim().split(/\r?\n/).map(s => JSON.parse(s));
assert.equal(results.length, cases.length, 'missing replay responses');
let decisions = 0, expectedRejections = 0;
const mismatches = [];
function compare(actual, expected, path = '') {
  if (typeof expected === 'number' && typeof actual === 'number') {
    const exact = /\.(score|baseScore|qualityLoss|trafficBucket)$/.test(path);
    assert.ok(exact ? actual === expected : Math.abs(actual-expected) <= 1e-12, `${path}: ${actual} != ${expected}`); return;
  }
  if (expected && typeof expected === 'object') {
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `${path}: keys differ`);
    for (const key of Object.keys(expected)) compare(actual[key], expected[key], `${path}.${key}`);
    return;
  }
  assert.deepEqual(actual, expected, path);
}
cases.forEach((c, index) => {
  try {
    let expected, error;
    try { expected = routeRequest(c.body, c.config, c.runtime); } catch (e) { error = referenceError(e); }
    if (error) { assert.equal(results[index].error?.code, error); expectedRejections++; }
    else { assert.ok(results[index].decision, JSON.stringify(results[index])); compare(selectionProjection(results[index].decision), selectionProjection(expected)); decisions++; }
  } catch (e) { mismatches.push({ id: c.id, reason: e.message.slice(0, 700) }); }
});
const report = {
  milestone: 'm1', productionReady: false, schemaVersion: 1, reference: 'src/router.mjs routeRequest',
  nodeVersion: process.version, commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  at: new Date().toISOString(), seed: 20260909, cases: cases.length, decisions, expectedRejections, mismatches,
  corpusSha256: createHash('sha256').update(inputText).digest('hex'),
  binarySha256: createHash('sha256').update(readFileSync(binary)).digest('hex'),
  sourceSha256: Object.fromEntries(['src/router.mjs', 'go-core/compat/contract.mjs', 'go-core/internal/decision/engine.go', 'go-core/internal/decision/types.go'].map(p => [p, createHash('sha256').update(readFileSync(resolve(root,p))).digest('hex')])),
  scope: 'selection, scoring, quality, eligibility, local load, rollout, reasoning; common reference classification/capacity inputs',
  excluded: ['active semantic adoption', 'session selection', 'latency shadow diagnostics', 'production state synchronization', 'billing/retries', 'performance superiority']
};
const output = resolve(arg('--out') || resolve(root, 'data/go-migration/verification.json'));
mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(report, null, 2)+'\n');
console.log(JSON.stringify({ cases: report.cases, decisions, expectedRejections, mismatches: mismatches.length, output }));
if (mismatches.length) { console.error(JSON.stringify(mismatches.slice(0, 8), null, 2)); process.exitCode = 1; }
