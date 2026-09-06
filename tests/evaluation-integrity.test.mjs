import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildQualityJudgeMessages, caseEvidence, createIntegrity, evaluateCase, evidenceHash,
  mergeReportRows, normalizeCases, parseQualityVerdict, qualityGate, resolveJudge,
  validateEvidenceReport,
} from '../scripts/evaluation-integrity.mjs';
import { planEvaluationImport } from '../scripts/evaluation-import.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const judge = { model: 'judge-fixture', baseUrl: 'http://127.0.0.1:1', apiKey: 'mock-key' };
const gen = { baseUrl: 'http://127.0.0.1:1', stream: false, maxTokens: 128, timeoutMs: 5000 };
function cases(count, start = 0, sub = 'debugging') {
  return normalizeCases(Array.from({ length: count }, (_, i) => ({ id: `case-${start + i}`, sub, prompt: `原题-${start + i}：只返回字段 alpha`, rubric: '必须含 alpha 且没有 beta' })), 128);
}
function scoredRow(c, model = 'm', score = 0.9) {
  return { ...caseEvidence(c), caseHash: evidenceHash(caseEvidence(c)), model, at: '2026-09-06T00:00:00.000Z', status: 'scored', score, reason: '符合', output: '{"alpha":1}', outputHead: '{"alpha":1}', generation: { ok: true, finishReason: 'stop', usage: { total_tokens: 20 }, maxTokens: c.maxTokens }, judge: { attempts: [{ ok: true, usage: { total_tokens: 30 } }] } };
}
function report(cs, { model = 'm', kind = 'subtask', rows = null, endpoint = judge } = {}) {
  const results = rows || cs.map((c) => scoredRow(c, model));
  const gate = qualityGate(results);
  return { at: '2026-09-06T00:00:00.000Z', integrity: createIntegrity({ cases: cs, kind, mode: 'model', models: [model], judge: endpoint, generation: gen }), results, gate, scope: { limited: false } };
}
const input = (r, path = 'report.json') => ({ report: r, path });
const config = () => ({ routing: { subtaskMinSamples: 4 }, models: [{ id: 'm', quality: { coding: 0.8 }, benchmarkScores: { subtasks: { debugging: { avg: 0.6, n: 4 }, untouched: { avg: 0.7, n: 8 } }, subtasksMeta: { source: 'old-history.json', at: '2026-08-21' } } }] });

test('Judge receives complete original prompt, rubric and long answer without template substitution', () => {
  const prompt = '原题中的唯一约束 XYZ42，原样保留 {answer} 与 $&';
  const answer = '前文'.repeat(9000) + '唯一答案尾部';
  const messages = buildQualityJudgeMessages({ prompt, rubric: '按 XYZ42 检查 {output}', answer, task: 'coding' });
  assert.equal(messages[0].role, 'system');
  assert.deepEqual(JSON.parse(messages[1].content), { task: 'coding', prompt, rubric: '按 XYZ42 检查 {output}', answer });
  assert.throws(() => buildQualityJudgeMessages({ prompt: '', rubric: 'r', answer: 'a' }), /原题/);
});

test('Judge null/string/out-of-range scores are failures, never zero-valued model quality', () => {
  for (const score of [null, '', '0.8', true, -0.1, 1.1]) assert.throws(() => parseQualityVerdict(JSON.stringify({ score })), /score/);
  assert.throws(() => parseQualityVerdict('{"unverifiable":true,"score":1,"reason":"无证据"}'), /无法核验/);
  assert.equal(parseQualityVerdict('```json\n{"score":0,"reason":"错误"}\n```').score, 0);
});

test('external Judge key missing cannot fall back to business credentials', () => {
  assert.throws(() => resolveJudge('url=https://judge.example/v1|model=j|key=MISSING', { baseUrl: 'https://business.example', apiKey: 'business-secret', env: {} }), /环境变量/);
  assert.equal(resolveJudge('none', { baseUrl: '', apiKey: '' }), null);
});

test('generation failures and Judge failures are separate; whitespace/length responses never reach Judge', async () => {
  const c = cases(1)[0];
  for (const choice of [{ message: { content: '   ' }, finish_reason: 'stop' }, { message: { content: '部分答案' }, finish_reason: 'length' }]) {
    let calls = 0;
    const row = await evaluateCase({ c, model: 'm', baseUrl: gen.baseUrl, apiKey: 'k', judge, timeoutMs: 5000, fetchImpl: async () => { calls++; return Response.json({ choices: [choice] }); } });
    assert.equal(row.status, 'generation_failed');
    assert.equal(row.score, null);
    assert.equal(calls, 1);
  }
  let n = 0;
  const row = await evaluateCase({ c, model: 'm', baseUrl: gen.baseUrl, apiKey: 'k', judge, timeoutMs: 5000, fetchImpl: async () => (++n === 1 ? Response.json({ choices: [{ message: { content: '答案' }, finish_reason: 'stop' }] }) : Response.json({ choices: [{ message: { content: '{"score":null}' } }] })) });
  assert.equal(row.status, 'judge_failed');
  assert.equal(row.score, null);
  assert.equal(row.generation.ok, true);
  assert.equal(n, 3);
  assert.equal(row.judge.attempts.length, 2);
});

test('Judge retry reuses the original generated answer and retains previous failure evidence', async () => {
  const c = cases(1)[0];
  const previous = { ...scoredRow(c), status: 'judge_failed', score: null, judge: { attempts: [{ ok: false, error: 'HTTP 503' }] } };
  let calls = 0;
  const next = await evaluateCase({ c, model: 'm', baseUrl: gen.baseUrl, apiKey: 'k', judge, timeoutMs: 5000, previous, fetchImpl: async (_url, init) => {
    calls++;
    const body = JSON.parse(init.body);
    assert.equal(body.model, judge.model);
    assert.equal(JSON.parse(body.messages[1].content).answer, previous.output);
    return Response.json({ choices: [{ message: { content: '{"score":0.8,"reason":"符合"}' }, finish_reason: 'stop' }], usage: { total_tokens: 12 } });
  } });
  assert.equal(calls, 1);
  assert.equal(next.status, 'scored');
  assert.equal(next.previousAttempts[0].status, 'judge_failed');
  assert.equal(next.reusedGeneration, true);
});

test('56-case gate fails both 55-generation-failure and 55-Judge-failure high-score illusions', () => {
  const rows = cases(56).map((c) => scoredRow(c, 'm', 1));
  const genFailed = rows.map((r, i) => i === 0 ? r : { ...r, status: 'generation_failed', score: null, generation: { ok: false } });
  const judgeFailed = rows.map((r, i) => i === 0 ? r : { ...r, status: 'judge_failed', score: null });
  for (const fixture of [genFailed, judgeFailed]) {
    const gate = qualityGate(fixture);
    assert.equal(gate.avg, 1);
    assert.equal(gate.passed, false);
    assert.equal(gate.coverage.scored, 1);
  }
  const noJudge = qualityGate(rows.map((r) => ({ ...r, status: 'judge_skipped', score: null })));
  assert.equal(noJudge.avg, null);
  assert.ok(noJudge.failures.includes('quality_unavailable'));
  assert.equal(qualityGate(rows).passed, true);
});

test('old reports, deleted failed rows, modified prompts and changed run settings cannot be reused', () => {
  assert.throws(() => validateEvidenceReport({ results: [{ score: 1 }] }), /历史/);
  const good = report(cases(4));
  validateEvidenceReport(good);
  const removed = structuredClone(good);
  removed.results.pop();
  assert.throws(() => validateEvidenceReport(removed), /题库哈希/);
  const changed = structuredClone(good);
  changed.results[0].prompt = 'different';
  assert.throws(() => validateEvidenceReport(changed), /哈希/);
  const settings = structuredClone(good.integrity);
  settings.generation.maxTokens = 256;
  assert.throws(() => validateEvidenceReport(good, settings), /已变化/);
});

test('import requires explicit protocol-complete inputs and rejects a latest one-row fragment', () => {
  assert.throws(() => planEvaluationImport(config()), /显式/);
  assert.throws(() => planEvaluationImport(config(), { subtaskReports: [input({ results: [{ score: 1 }] })] }), /历史/);
  const original = config();
  assert.throws(() => planEvaluationImport(original, { subtaskReports: [input(report(cases(1)))] }), /证据不足/);
  assert.equal(Object.keys(original.models[0].benchmarkScores.subtasks).length, 2);
});

test('merge preserves untouched legacy dimensions and records per-subtask sources without relabeling old scores', () => {
  const original = config();
  const plan = planEvaluationImport(original, { subtaskReports: [input(report(cases(4)), 'new-v2.json')], now: '2026-09-06T01:00:00Z' });
  const bs = plan.config.models[0].benchmarkScores;
  assert.deepEqual(bs.subtasks.debugging, { avg: 0.9, n: 4 });
  assert.deepEqual(bs.subtasks.untouched, { avg: 0.7, n: 8 });
  assert.deepEqual(bs.subtasksMeta.unverifiedSubtasks, ['untouched']);
  assert.equal(bs.subtasksMeta.bySubtask.untouched.protocol, 'legacy-unverified');
  assert.deepEqual(bs.subtasksMeta.bySubtask.debugging.sources, ['new-v2.json']);
  assert.equal(original.models[0].benchmarkScores.subtasks.debugging.avg, 0.6);
  assert.deepEqual(plan.config.models[0].quality, original.models[0].quality);
});

test('compatible explicit fragments merge by case; duplicate successes do not inflate sample count', () => {
  const one = input(report(cases(2)), 'one.json');
  const two = input(report(cases(2, 2)), 'two.json');
  const plan = planEvaluationImport(config(), { subtaskReports: [one, two] });
  assert.equal(plan.config.models[0].benchmarkScores.subtasks.debugging.n, 4);
  assert.equal(mergeReportRows([one, one]).length, 2);
  const conflict = cases(2); conflict[0].prompt += ' changed';
  assert.throws(() => mergeReportRows([one, input(report(conflict))]), /题面/);
  const failedRows = cases(2).map((c) => ({ ...scoredRow(c), status: 'generation_failed', score: null, generation: { ok: false } }));
  const failed = input(report(cases(2), { rows: failedRows }));
  assert.throws(() => planEvaluationImport(config(), { subtaskReports: [one, two, failed] }), /证据不足/);
});

test('smaller samples require explicit replace, whose preview identifies removed dimensions', () => {
  const cfg = config(); cfg.models[0].benchmarkScores.subtasks.debugging.n = 8;
  const inputs = { subtaskReports: [input(report(cases(4)))] };
  assert.throws(() => planEvaluationImport(cfg, inputs), /样本量/);
  const plan = planEvaluationImport(cfg, { ...inputs, mode: 'replace' });
  assert.deepEqual(Object.keys(plan.config.models[0].benchmarkScores.subtasks), ['debugging']);
  assert.deepEqual(plan.changes[0].removed, ['untouched']);
});

test('model profile import rejects routing subsets, limited smoke runs and failed coverage gates', () => {
  const cs = cases(4).map((c) => ({ ...c, task: 'coding' }));
  const good = report(cs, { kind: 'gate' });
  const planned = planEvaluationImport(config(), { gateReports: [input(good)] });
  assert.equal(planned.config.models[0].benchmarkScores.evalGate.coding, 0.9);
  assert.deepEqual(planned.config.models[0].quality, config().models[0].quality);
  const routed = structuredClone(good); routed.integrity.mode = 'routing-core';
  assert.throws(() => planEvaluationImport(config(), { gateReports: [input(routed)] }), /单模型/);
  const smoke = structuredClone(good); smoke.scope.limited = true;
  assert.throws(() => planEvaluationImport(config(), { gateReports: [input(smoke)] }), /冒烟/);
  const failed = structuredClone(good); failed.gate.passed = false;
  assert.throws(() => planEvaluationImport(config(), { gateReports: [input(failed)] }), /门禁/);
});

test('different model snapshots can be imported together while inconsistent snapshots of the same model are rejected', () => {
  const a = report(cases(4));
  a.integrity.generation = { ...gen, modelConfigHash: 'snapshot-a', modelConfigHashes: { m: 'snapshot-a' } };
  const b = report(cases(4), { model: 'n' });
  b.integrity.generation = { ...gen, modelConfigHash: 'snapshot-b', modelConfigHashes: { n: 'snapshot-b' } };
  assert.equal(mergeReportRows([input(a), input(b)]).length, 8);
  const conflict = structuredClone(a);
  conflict.integrity.generation.modelConfigHashes.m = 'changed';
  assert.throws(() => mergeReportRows([input(a), input(conflict)]), /配置版本不同/);
});

async function temporary(t) {
  const base = resolve(tmpdir());
  const dir = await mkdtemp(join(base, 'amr-evidence-'));
  t.after(async () => {
    assert.ok(resolve(dir).startsWith(base + sep));
    assert.ok(dir.split(sep).at(-1).startsWith('amr-evidence-'));
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}
function run(script, args, env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: root, env: { ...process.env, ...env }, windowsHide: true, timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (b) => { stdout += b; });
    child.stderr.on('data', (b) => { stderr += b; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolveRun({ code, signal, stdout, stderr }));
  });
}
async function localFixture(t, handler) {
  const dir = await temporary(t);
  const cfg = JSON.parse(await readFile(join(root, 'config/router.json'), 'utf8'));
  await writeFile(join(dir, 'router.json'), JSON.stringify(cfg));
  const srv = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    try { await handler(JSON.parse(Buffer.concat(chunks).toString()), res); }
    catch (error) { res.writeHead(500); res.end(error.message); }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }));
  const baseUrl = `http://127.0.0.1:${srv.address().port}`;
  return { dir, model: cfg.models.find((m) => m.enabled).id, env: { CONFIG_PATH: join(dir, 'router.json'), AMR_CONFIG_DIR: dir, UPSTREAM_BASE_URL: baseUrl, MAAS_BASE_URL: baseUrl, UPSTREAM_API_KEY: 'fixture', MAAS_API_KEY: 'fixture', EVAL_GATE_TIMEOUT_MS: '5000', EVAL_GATE_MAX_TOKENS: '128', SUBTASK_EVAL_MAX_TOKENS: '128' } };
}
const reply = (res, text, finish_reason = 'stop') => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason }], usage: { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 } })); };

test('CLI gate records original Judge input and fails low generation coverage against a local mock', async (t) => {
  const judged = [];
  const fx = await localFixture(t, (body, res) => {
    if (body.model === judge.model) { judged.push(JSON.parse(body.messages[1].content)); reply(res, '{"score":1,"reason":"满足唯一约束"}'); }
    else if (body.messages[0].content.includes('FAIL')) { res.writeHead(503); res.end('fixture unavailable'); }
    else reply(res, '完整回答 alpha');
  });
  const bank = cases(3).map((c, i) => ({ ...c, task: 'coding', prompt: i ? `FAIL-${i}` : '唯一原题 SECRET_SENTINEL_ALPHA' }));
  const path = join(fx.dir, 'cases.json'), out = join(fx.dir, 'gate.json');
  await writeFile(path, JSON.stringify({ cases: bank }));
  const executed = await run('scripts/eval-gate.mjs', ['--cases', path, '--model', fx.model, '--judge', judge.model, '--out', out], fx.env);
  assert.equal(executed.code, 1, executed.stderr + executed.stdout);
  assert.equal(judged.length, 1);
  assert.equal(judged[0].prompt, bank[0].prompt);
  assert.equal(judged[0].rubric, bank[0].rubric);
  const saved = JSON.parse(await readFile(out, 'utf8'));
  assert.equal(saved.avg, 1);
  assert.equal(saved.gate.passed, false);
  assert.equal(saved.coverage.generationFailed, 2);
  assert.equal(saved.results[0].generation.usage.total_tokens, 13);
  validateEvidenceReport(saved);
});

test('subtask CLI without Judge collects only unscored evidence; gate CLI never calls this a quality PASS', async (t) => {
  const fx = await localFixture(t, (_body, res) => reply(res, '答案'));
  const bank = cases(4), path = join(fx.dir, 'cases.json'), out = join(fx.dir, 'sub.json');
  await writeFile(path, JSON.stringify({ cases: bank }));
  const sub = await run('scripts/subtask-eval.mjs', ['--cases', path, '--models', fx.model, '--judge', 'none', '--out', out], fx.env);
  assert.equal(sub.code, 0, sub.stderr);
  assert.ok(!sub.stdout.includes('PASS'));
  const saved = JSON.parse(await readFile(out, 'utf8'));
  assert.equal(saved.coverage.judgeSkipped, 4);
  validateEvidenceReport(saved);
  const gateOut = join(fx.dir, 'gate.json');
  const gateRun = await run('scripts/eval-gate.mjs', ['--cases', path, '--model', fx.model, '--judge', 'none', '--out', gateOut], fx.env);
  assert.equal(gateRun.code, 1, gateRun.stderr);
  assert.ok(!gateRun.stdout.includes('PASS'));
  assert.equal(JSON.parse(await readFile(gateOut, 'utf8')).avg, null);
});

test('CLI importer rejects implicit latest selection and old protocol before modifying config', async (t) => {
  const dir = await temporary(t);
  const cfg = await readFile(join(root, 'config/router.json'), 'utf8');
  await writeFile(join(dir, 'router.json'), cfg);
  const env = { CONFIG_PATH: join(dir, 'router.json'), AMR_CONFIG_DIR: dir };
  const implicit = await run('scripts/apply-eval-to-models.mjs', ['--dry'], env);
  assert.equal(implicit.code, 2);
  assert.match(implicit.stderr, /显式/);
  const oldPath = join(dir, 'legacy.json');
  await writeFile(oldPath, JSON.stringify({ results: [{ model: 'm', sub: 'debugging', score: 1 }] }));
  const legacy = await run('scripts/apply-eval-to-models.mjs', ['--report', oldPath], env);
  assert.equal(legacy.code, 2);
  assert.match(legacy.stderr, /历史/);
  assert.equal(await readFile(join(dir, 'router.json'), 'utf8'), cfg);
});

test('subtask regeneration uses complete stored original input and does not regenerate a Judge-failed answer', async (t) => {
  let unavailable = true, generations = 0, judgments = 0;
  const fx = await localFixture(t, (body, res) => {
    if (body.model === judge.model) {
      judgments++;
      const request = JSON.parse(body.messages[1].content);
      assert.match(request.prompt, /^原题-/);
      assert.equal(request.rubric, '必须含 alpha 且没有 beta');
      if (unavailable && request.prompt.startsWith('原题-0')) { res.writeHead(503); res.end('judge outage'); }
      else reply(res, '{"score":0.9,"reason":"符合"}');
    } else { generations++; reply(res, '{"alpha":1}'); }
  });
  const path = join(fx.dir, 'cases.json'), out = join(fx.dir, 'sub.json');
  await writeFile(path, JSON.stringify({ cases: cases(4) }));
  const first = await run('scripts/subtask-eval.mjs', ['--cases', path, '--models', fx.model, '--judge', judge.model, '--out', out], fx.env);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(generations, 4);
  assert.equal(JSON.parse(await readFile(out, 'utf8')).coverage.judgeFailed, 1);
  unavailable = false;
  const resumed = await run('scripts/subtask-regen.mjs', ['--report', out], { ...fx.env, REGEN_MAX_TOKENS: '128' });
  assert.equal(resumed.code, 0, resumed.stderr + resumed.stdout);
  assert.equal(generations, 4);
  assert.equal(judgments, 6);
  const saved = JSON.parse(await readFile(out, 'utf8'));
  assert.equal(saved.coverage.scored, 4);
  assert.equal(saved.results.find((r) => r.id === 'case-0').previousAttempts[0].status, 'judge_failed');
  validateEvidenceReport(saved);
});

test('gate resume skips matching scored results but refuses changed model configuration before any new call', async (t) => {
  let calls = 0;
  const fx = await localFixture(t, (body, res) => { calls++; reply(res, body.model === judge.model ? '{"score":1,"reason":"符合"}' : 'alpha'); });
  const path = join(fx.dir, 'cases.json'), out = join(fx.dir, 'gate.json');
  await writeFile(path, JSON.stringify({ cases: cases(4).map((c) => ({ ...c, task: 'coding' })) }));
  const baseArgs = ['--cases', path, '--model', fx.model, '--judge', judge.model];
  const first = await run('scripts/eval-gate.mjs', [...baseArgs, '--out', out], fx.env);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(calls, 8);
  const resumed = await run('scripts/eval-gate.mjs', [...baseArgs, '--report', out], fx.env);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(calls, 8);
  const cfg = JSON.parse(await readFile(join(fx.dir, 'router.json'), 'utf8'));
  const model = cfg.models.find((m) => m.id === fx.model);
  model.avgLatencyMs = Number(model.avgLatencyMs || 100) + 1;
  await writeFile(join(fx.dir, 'router.json'), JSON.stringify(cfg));
  const changed = await run('scripts/eval-gate.mjs', [...baseArgs, '--report', out], fx.env);
  assert.equal(changed.code, 2);
  assert.match(changed.stderr, /配置已变化/);
  assert.equal(calls, 8);
});
