import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROUTING_FEATURE_VERSION, ROUTING_FEATURE_NAMES, extractRoutingFeatures, routingInputHash } from '../src/request-features.mjs';
import { prepareRoutingLearningData } from '../src/learning-data.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = resolve(root, 'scripts/prepare-routing-learning.mjs');
const request = (text) => ({ messages: [{ role: 'user', content: text }] });

function fixture({ includeTestResults = true, evidenceKind = 'demo' } = {}) {
  const requests = { schemaVersion: 1, requests: [
    { taskId: 'train-1', request: request('Write a function that sorts three numbers.') },
    { taskId: 'validation-1', request: request('解释为什么字符串长度不等于字节数？') },
    { taskId: 'test-1', request: request('Return a JSON object with two fields.') }
  ] };
  const tasks = requests.requests.map((row, i) => ({ taskId: row.taskId, groupId: `group-${i}`, split: ['train', 'validation', 'test'][i],
    task: ['coding', 'reasoning', 'extraction'][i], inputHash: routingInputHash(row.request) }));
  const candidates = ['a', 'b'].map((id) => ({ id, model: `demo-${id}`, modelVersion: 'frozen-v1', inference: { max_tokens: 1000, temperature: 0 } }));
  return { requests, matrix: { schemaVersion: 1,
    dataset: { id: 'demo-data', evidenceKind, currency: 'CNY', costScope: 'task_total', successBasis: 'task_check',
      successDefinition: 'Synthetic test fixture only', collectionProtocolRef: 'demo:collection', splitProtocolRef: 'demo:split' },
    candidates, tasks,
    observations: tasks.filter((task) => includeTestResults || task.split !== 'test').flatMap((task) => candidates.map((candidate, i) => ({
      taskId: task.taskId, candidateId: candidate.id, success: i === 0, cost: i + 1, costBasis: 'actual',
      latencyMs: 100 * (i + 1), observedAt: '2026-09-01T00:00:00Z', evidenceRef: `demo:${task.taskId}:${candidate.id}`
    }))), policies: [], selections: [] } };
}

function prepare(data = fixture()) { return prepareRoutingLearningData(data.matrix, data.requests); }

test('feature schema is fixed, finite and purely request-derived', () => {
  assert.equal(ROUTING_FEATURE_VERSION, 'routing-request-v1');
  assert.equal(ROUTING_FEATURE_NAMES.length, 24);
  assert.equal(new Set(ROUTING_FEATURE_NAMES).size, 24);
  const values = extractRoutingFeatures(request('```js\nreturn x[0] + 42;\n``` 你好？'));
  assert.equal(values.length, 24);
  assert.ok(values.every(Number.isFinite));
  assert.equal(values[ROUTING_FEATURE_NAMES.indexOf('has_code_fence')], 1);
  assert.ok(values[ROUTING_FEATURE_NAMES.indexOf('cjk_ratio')] > 0);
  assert.ok(values[ROUTING_FEATURE_NAMES.indexOf('digit_ratio')] > 0);
  assert.deepEqual(values, extractRoutingFeatures(request('```js\nreturn x[0] + 42;\n``` 你好？')));
});

test('hash canonicalizes object keys but preserves text, arrays and explicit defaults', () => {
  const a = { messages: [{ role: 'user', content: 'answer me' }], response_format: { type: 'json_object' } };
  const b = { response_format: { type: 'json_object' }, messages: [{ content: 'answer me', role: 'user' }] };
  assert.equal(routingInputHash(a), routingInputHash(b));
  assert.deepEqual(extractRoutingFeatures(a), extractRoutingFeatures(b));
  assert.notEqual(routingInputHash(a), routingInputHash({ ...a, messages: [{ role: 'user', content: 'answer me ' }] }));
  assert.notEqual(routingInputHash(request('answer me')), routingInputHash({ ...request('answer me'), tools: [] }));
  const multi = { messages: [{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }] };
  assert.notEqual(routingInputHash(multi), routingInputHash({ messages: multi.messages.toReversed() }));
  assert.notEqual(routingInputHash(request('é')), routingInputHash(request('e\u0301')));
});

test('accepted tool/schema/media fields participate in the full input hash', () => {
  const input = {
    messages: [{ role: 'system', content: 'Use the tool.' }, { role: 'user', content: [{ type: 'text', text: 'Describe this.' },
      { type: 'image_url', image_url: { url: 'https://example.invalid/image-v1', detail: 'high' } }] }],
    tools: [{ type: 'function', function: { name: 'check', strict: true, parameters: { type: 'object', properties: { success: { type: 'boolean' } } } } }],
    tool_choice: { type: 'function', function: { name: 'check' } }, parallel_tool_calls: false,
    response_format: { type: 'json_schema', json_schema: { name: 'result', strict: true, schema: { type: 'object', properties: { answer: { type: 'string' } } } } }
  };
  const base = routingInputHash(input);
  const variants = [
    (x) => { x.messages[0].content = 'Use a tool carefully.'; },
    (x) => { x.messages[1].content[1].image_url.url = 'https://example.invalid/image-v2'; },
    (x) => { x.tools[0].function.parameters.properties.success.type = 'string'; },
    (x) => { x.tool_choice = 'none'; },
    (x) => { x.parallel_tool_calls = true; },
    (x) => { x.response_format.json_schema.schema.properties.answer.type = 'number'; }
  ];
  for (const change of variants) { const copy = structuredClone(input); change(copy); assert.notEqual(routingInputHash(copy), base); }
  const values = extractRoutingFeatures(input);
  assert.equal(values[ROUTING_FEATURE_NAMES.indexOf('has_tools')], 1);
  assert.equal(values[ROUTING_FEATURE_NAMES.indexOf('requires_tool')], 1);
  assert.equal(values[ROUTING_FEATURE_NAMES.indexOf('has_json_response')], 1);
  assert.equal(values[ROUTING_FEATURE_NAMES.indexOf('log_media_part_count')], Math.log1p(1));
});

test('only existing assistant/tool history is accepted, never a final answer row', () => {
  const input = { messages: [{ role: 'user', content: 'Look it up.' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"id":1}' } }] },
    { role: 'tool', tool_call_id: 'call-1', content: 'Existing tool result.' }] };
  const features = extractRoutingFeatures(input);
  assert.equal(features[ROUTING_FEATURE_NAMES.indexOf('log_prior_tool_call_count')], Math.log1p(1));
  assert.equal(features[ROUTING_FEATURE_NAMES.indexOf('log_tool_message_count')], Math.log1p(1));
  input.messages.push({ role: 'assistant', content: 'This is the evaluated answer.' });
  assert.throws(() => routingInputHash(input), /最后一条 assistant/);
});

test('unknown/result/candidate inference request fields are rejected instead of dropped', () => {
  for (const key of ['answer', 'score', 'success', 'task', 'latencyMs', 'evidenceRef', 'model', 'inference', 'max_tokens', 'temperature', 'unknown']) {
    assert.throws(() => extractRoutingFeatures({ ...request('hello'), [key]: 'do not ignore' }), /未支持的字段/);
  }
  assert.throws(() => routingInputHash({ messages: [{ role: 'user', content: 'hello', score: 1 }] }), /未支持的字段/);
  assert.throws(() => routingInputHash({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hello', answer: 'secret' }] }] }), /未支持的字段/);
});

test('non-JSON values, malformed inputs and unsupported schema controls fail closed', () => {
  const bad = [
    { messages: [] }, { messages: [{ role: 'system', content: 'x' }] },
    { messages: [{ role: 'user', content: null }] }, { messages: [{ role: 'user', content: [] }] },
    { ...request('x'), tools: 'not-array' }, { ...request('x'), tool_choice: 'required' },
    { ...request('x'), response_format: { type: 'json_schema' } },
    { ...request('x'), tools: [{ type: 'function', function: { name: 'a', parameters: { limit: Infinity } } }] },
    { ...request('x'), response_format: undefined }, { messages: Array(1) }
  ];
  for (const value of bad) assert.throws(() => routingInputHash(value));
  const cycle = request('x'); cycle.tools = [cycle]; assert.throws(() => routingInputHash(cycle), /循环/);
});

test('file/audio identifiers are hashed, without reading attachments or URLs', () => {
  const input = { messages: [{ role: 'user', content: [
    { type: 'file', file: { file_id: 'immutable-v1', filename: 'business.txt' } },
    { type: 'input_audio', input_audio: { data: 'base64-placeholder', format: 'wav' } }
  ] }] };
  const original = routingInputHash(input);
  assert.equal(extractRoutingFeatures(input)[12], Math.log1p(2));
  input.messages[0].content[0].file.file_id = 'immutable-v2';
  assert.notEqual(routingInputHash(input), original);
  input.messages[0].content[0].file.file_data = 'two-conflicting-inputs';
  assert.throws(() => routingInputHash(input), /只能提供/);
});

test('preparation physically separates fit labels and blind features', () => {
  const data = fixture(), original = structuredClone(data), { fit, blind } = prepare(data);
  assert.deepEqual(data, original);
  assert.deepEqual(fit.tasks.map((task) => task.split).sort(), ['train', 'validation']);
  assert.equal(fit.observations.length, 4);
  assert.ok(fit.observations.every((row) => row.taskId !== 'test-1'));
  assert.deepEqual(fit.policies, []); assert.deepEqual(fit.selections, []);
  assert.deepEqual(blind.tasks.map((task) => task.taskId), ['test-1']);
  assert.deepEqual(Object.keys(blind).sort(), ['schemaVersion', 'featureVersion', 'featureNames', 'datasetId', 'candidates', 'tasks'].sort());
  const forbidden = new Set(['task', 'success', 'cost', 'costBasis', 'latencyMs', 'evidenceRef', 'observedAt', 'observations', 'output', 'answer']);
  function assertBlind(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) { assert.ok(!forbidden.has(key), `leaked ${key}`); assertBlind(item); }
  }
  assertBlind(blind);
  assert.equal(JSON.stringify(fit).includes('Return a JSON object'), false);
  assert.equal(JSON.stringify(blind).includes('Return a JSON object'), false);
});

test('changing or removing test outcomes cannot change fit or blind artifacts', () => {
  const data = fixture(), first = prepare(data);
  data.matrix.tasks.find((task) => task.split === 'test').task = 'secret-category-not-a-feature';
  for (const row of data.matrix.observations.filter((row) => row.taskId === 'test-1')) {
    row.success = !row.success; row.cost += 999; row.latencyMs += 4567;
    row.evidenceRef = 'test-answer-sentinel'; row.observedAt = '2026-09-04T00:00:00Z';
  }
  assert.deepEqual(prepare(data), first);
  data.matrix.observations = data.matrix.observations.filter((row) => row.taskId !== 'test-1');
  assert.deepEqual(prepare(data), first);
});

test('human task category is a fit grouping label, never an extracted feature', () => {
  const data = fixture(), before = prepare(data);
  data.matrix.tasks.find((task) => task.split === 'train').task = 'arbitrary-human-label';
  const after = prepare(data);
  assert.deepEqual(after.fit.tasks.find((task) => task.split === 'train').features, before.fit.tasks.find((task) => task.split === 'train').features);
});

test('blind and fit use cloned candidate descriptors; caller inputs and sibling outputs cannot be mutated through them', () => {
  const data = fixture(), { fit, blind } = prepare(data);
  fit.candidates[0].inference.max_tokens = 9;
  assert.equal(data.matrix.candidates[0].inference.max_tokens, 1000);
  assert.equal(blind.candidates[0].inference.max_tokens, 1000);
});

test('unknown metadata/outcome fields cannot sneak into candidate or dataset inputs', () => {
  for (const change of [
    (x) => { x.matrix.candidates[0].score = 1; },
    (x) => { x.matrix.candidates[0].inference.evidenceRef = 'test-outcome'; },
    (x) => { x.matrix.dataset.testSuccessRate = 0.9; },
    (x) => { x.matrix.tasks[0].answer = 'secret'; },
    (x) => { x.requests.requests[0].score = 1; }
  ]) { const data = fixture(); change(data); assert.throws(() => prepare(data), /字段/); }
});

test('all three splits and complete fit panels are mandatory; test outcomes may be absent', () => {
  assert.equal(prepare(fixture({ includeTestResults: false })).blind.tasks.length, 1);
  for (const split of ['train', 'validation', 'test']) {
    const data = fixture();
    const id = data.matrix.tasks.find((task) => task.split === split).taskId;
    data.matrix.tasks = data.matrix.tasks.filter((task) => task.taskId !== id);
    data.matrix.observations = data.matrix.observations.filter((row) => row.taskId !== id);
    data.requests.requests = data.requests.requests.filter((row) => row.taskId !== id);
    assert.throws(() => prepare(data), /缺少 .* split/);
  }
  for (const id of ['train-1', 'validation-1']) {
    const data = fixture(); data.matrix.observations = data.matrix.observations.filter((row) => !(row.taskId === id && row.candidateId === 'b'));
    assert.throws(() => prepare(data), /完整候选结果面板/);
  }
});

test('missing, duplicate, extra or hash-conflicting raw requests are rejected', () => {
  for (const change of [
    (x) => { x.requests.requests.pop(); },
    (x) => { x.requests.requests.push(structuredClone(x.requests.requests[0])); },
    (x) => { x.requests.requests.push({ taskId: 'not-frozen', request: request('extra') }); },
    (x) => { x.requests.requests[0].request.messages[0].content += ' changed'; }
  ]) { const data = fixture(); change(data); assert.throws(() => prepare(data)); }
});

test('same group across splits and same input across groups fail before fitting', () => {
  const sharedGroup = fixture(); sharedGroup.matrix.tasks[1].groupId = sharedGroup.matrix.tasks[0].groupId;
  assert.throws(() => prepare(sharedGroup), /跨 split/);
  const sharedInput = fixture();
  sharedInput.requests.requests[1].request = structuredClone(sharedInput.requests.requests[0].request);
  sharedInput.matrix.tasks[1].inputHash = sharedInput.matrix.tasks[0].inputHash;
  assert.throws(() => prepare(sharedInput), /相同任务输入/);
});

test('same frozen input can repeat within one group/split without pseudo-independent grouping', () => {
  const data = fixture();
  data.matrix.tasks.push({ ...data.matrix.tasks[0], taskId: 'train-repeat' });
  data.requests.requests.push({ ...structuredClone(data.requests.requests[0]), taskId: 'train-repeat' });
  data.matrix.observations.push(...data.matrix.observations.filter((row) => row.taskId === 'train-1').map((row) => ({ ...row, taskId: 'train-repeat' })));
  assert.equal(prepare(data).fit.tasks.length, 3);
});

test('declared eligibility is a checked subset, while absent eligibility stays unconfirmed', () => {
  const data = fixture();
  assert.deepEqual(prepare(data).blind.tasks[0].eligibleCandidateIds, ['a', 'b']);
  assert.equal(prepare(data).blind.tasks[0].eligibilitySource, 'requires_confirmation');
  data.requests.requests[2].eligibleCandidateIds = ['b'];
  assert.deepEqual(prepare(data).blind.tasks[0].eligibleCandidateIds, ['b']);
  assert.equal(prepare(data).blind.tasks[0].eligibilitySource, 'caller_declared');
  for (const invalid of [['a', 'a'], ['c'], [null], 'a']) {
    data.requests.requests[2].eligibleCandidateIds = invalid; assert.throws(() => prepare(data), /eligibleCandidateIds/);
  }
});

test('explicitly empty eligibility means no qualified candidate and never expands to the full panel', () => {
  const data = fixture();
  data.requests.requests[2].eligibleCandidateIds = [];
  const { blind } = prepare(data);
  assert.equal(blind.tasks.length, 1);
  assert.deepEqual(blind.tasks[0].eligibleCandidateIds, []);
  assert.equal(blind.tasks[0].eligibilitySource, 'caller_declared');
});

test('demo/synthetic provenance and estimated costs remain explicit without upgrading evidence', () => {
  for (const evidenceKind of ['demo', 'synthetic', 'observed']) {
    const data = fixture({ evidenceKind }); data.matrix.observations[0].costBasis = 'estimated';
    const { fit } = prepare(data);
    assert.equal(fit.dataset.evidenceKind, evidenceKind);
    assert.equal(fit.observations.find((row) => row.taskId === 'train-1' && row.candidateId === 'a').costBasis, 'estimated');
  }
});

async function inDirectory(t, callback) {
  const directory = await mkdtemp(join(tmpdir(), 'amr-learning-data-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  await callback(directory);
}

async function writeFixture(directory, data = fixture()) {
  const matrix = join(directory, 'matrix.json'), requests = join(directory, 'requests.json');
  await writeFile(matrix, '\uFEFF' + JSON.stringify(data.matrix), 'utf8');
  await writeFile(requests, JSON.stringify(data.requests), 'utf8');
  return { matrix, requests };
}

function cli(paths, output) {
  return spawnSync(process.execPath, [script, '--matrix', paths.matrix, '--requests', paths.requests, '--out-dir', output], { cwd: root, encoding: 'utf8' });
}

test('CLI help and unknown/duplicate arguments have explicit exit codes', () => {
  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0); assert.match(help.stdout, /fit.json/);
  for (const argv of [['--unknown'], ['--matrix', 'a', '--matrix', 'b'], []]) {
    const result = spawnSync(process.execPath, [script, ...argv], { encoding: 'utf8' });
    assert.equal(result.status, 2);
  }
});

test('CLI publishes all artifacts, keeps source hashes out of fit/blind and preserves inputs', async (t) => {
  await inDirectory(t, async (directory) => {
    const paths = await writeFixture(directory), output = join(directory, 'prepared');
    const originals = await Promise.all([readFile(paths.matrix), readFile(paths.requests)]);
    const result = cli(paths, output);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual((await readdir(output)).sort(), ['blind.json', 'fit.json', 'preparation.json']);
    const fit = await readFile(join(output, 'fit.json'), 'utf8'), blind = await readFile(join(output, 'blind.json'), 'utf8');
    const manifest = JSON.parse(await readFile(join(output, 'preparation.json'), 'utf8'));
    assert.equal(manifest.status, 'complete'); assert.equal(manifest.evidenceKind, 'demo');
    assert.equal(manifest.productionSuperiorityEstablished, false);
    assert.match(manifest.source.matrix.sha256, /^[a-f0-9]{64}$/);
    assert.ok(!fit.includes(manifest.source.matrix.sha256)); assert.ok(!blind.includes(manifest.source.matrix.sha256));
    assert.deepEqual(await readFile(paths.matrix), originals[0]); assert.deepEqual(await readFile(paths.requests), originals[1]);
  });
});

test('CLI refuses existing output paths and input overwrite without changing their content', async (t) => {
  await inDirectory(t, async (directory) => {
    const paths = await writeFixture(directory), output = join(directory, 'existing');
    await mkdir(output); await writeFile(join(output, 'fit.json'), 'keep-me');
    assert.equal(cli(paths, output).status, 1);
    assert.equal(await readFile(join(output, 'fit.json'), 'utf8'), 'keep-me');
    const original = await readFile(paths.matrix);
    assert.equal(cli(paths, paths.matrix).status, 2);
    assert.deepEqual(await readFile(paths.matrix), original);
    assert.deepEqual(await readdir(output), ['fit.json']);
  });
});

test('CLI validation failure leaves no output directory or temporary artifacts', async (t) => {
  await inDirectory(t, async (directory) => {
    const data = fixture(); data.requests.requests[2].request.score = 0.99;
    const paths = await writeFixture(directory, data), output = join(directory, 'invalid');
    const result = cli(paths, output);
    assert.equal(result.status, 2, result.stderr);
    assert.deepEqual((await readdir(directory)).sort(), ['matrix.json', 'requests.json']);
  });
});

test('CLI fit/blind bytes remain identical when withheld outcomes change', async (t) => {
  await inDirectory(t, async (directory) => {
    const data = fixture(), paths = await writeFixture(directory, data);
    const a = join(directory, 'a'), b = join(directory, 'b');
    assert.equal(cli(paths, a).status, 0);
    data.matrix.observations.filter((row) => row.taskId === 'test-1').forEach((row) => { row.success = !row.success; row.cost += 30; row.evidenceRef = 'different-result'; });
    await writeFile(paths.matrix, JSON.stringify(data.matrix));
    assert.equal(cli(paths, b).status, 0);
    for (const name of ['fit.json', 'blind.json']) assert.deepEqual(await readFile(join(a, name)), await readFile(join(b, name)));
    const am = JSON.parse(await readFile(join(a, 'preparation.json'), 'utf8'));
    const bm = JSON.parse(await readFile(join(b, 'preparation.json'), 'utf8'));
    assert.notEqual(am.source.matrix.sha256, bm.source.matrix.sha256);
  });
});
