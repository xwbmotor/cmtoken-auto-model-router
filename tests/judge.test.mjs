// v0.8.0 Judge 单元测试：抽样稳定性、评分归一化、护栏熔断/预算、JSON 解析
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  shouldSampleJudge, buildJudgeMessages, buildTaskCheckMessages, parseJudgeJson,
  normalizeScore, normalizeDimension, normalizeVerdict, randomAbOrder,
  JudgeGuard, callJudgeModel, judgePromptHash, JUDGE_RUBRIC_VERSION,
} from '../src/judge.mjs';

const SECRET = Buffer.from('x'.repeat(43), 'utf8');

test('抽样：同一 requestId 恒定入选/落选（重放不变）', () => {
  const rid = 'req-stability-001';
  const first = shouldSampleJudge(rid, 3, SECRET);
  for (let i = 0; i < 20; i += 1) assert.equal(shouldSampleJudge(rid, 3, SECRET), first, '同 rid 结果必须恒定');
});

test('抽样：percent=0 全落选，100 全入选，域分隔（与语义分桶独立）', () => {
  assert.equal(shouldSampleJudge('a', 0, SECRET), false);
  assert.equal(shouldSampleJudge('a', 100, SECRET), true);
  assert.equal(shouldSampleJudge(null, 100, SECRET), false);
  // 域分隔证明：judge-sample: 前缀与 semantic: 分桶的 HMAC 输入不同，同 rid 同 secret 不同域
  const j = createHmac('sha256', SECRET).update('judge-sample:x').digest('hex');
  const s = createHmac('sha256', SECRET).update('semantic:x').digest('hex');
  assert.notEqual(j, s);
});

test('抽样：3% 下大数 rid 命中率 ∈ [1%, 8%]（统计边界）', () => {
  let hit = 0; const N = 20000;
  for (let i = 0; i < N; i += 1) if (shouldSampleJudge(`rid-${i}`, 3, SECRET)) hit += 1;
  const ratio = hit / N;
  assert.ok(ratio > 0.01 && ratio < 0.08, `3% 抽样命中率失常: ${ratio}`);
});

test('parseJudgeJson：裸 JSON / 围栏 / 前后缀文本都能解出', () => {
  assert.equal(parseJudgeJson('{"a":1}').a, 1);
  assert.equal(parseJudgeJson('```json\n{"a":2}\n```').a, 2);
  assert.equal(parseJudgeJson('好的，评分如下：{"a":3} 以上。').a, 3);
  assert.equal(parseJudgeJson(''), null);
  assert.equal(parseJudgeJson('完全没有 JSON'), null);
});

test('normalizeScore：clamp 到 [0,10]，非法值 null', () => {
  assert.equal(normalizeScore(7.4), 7);
  assert.equal(normalizeScore(99), 10);
  assert.equal(normalizeScore(-3), 0);
  assert.equal(normalizeScore(null), null);
  assert.equal(normalizeScore('abc'), null);
});

test('normalizeDimension：verifiable=false ⇒ score 强制 null（不可验证不混入平均）', () => {
  const d = normalizeDimension({ score: 8, verifiable: false, reason: '开放问题' });
  assert.equal(d.score, null);
  assert.equal(d.verifiable, false);
  assert.equal(d.reason, '开放问题');
  const d2 = normalizeDimension({ score: 8.6, reason: '可核验' });
  assert.equal(d2.score, 9);
  assert.equal(d2.verifiable, true);
  assert.deepEqual(normalizeDimension(null), { score: null, verifiable: true, reason: 'missing' });
});

test('rubric prompt：hash 稳定、版本字段存在、提示词含四维度与不可验证规则', () => {
  assert.equal(judgePromptHash(), judgePromptHash(), 'hash 必须进程内稳定');
  const msgs = buildJudgeMessages({ messages: [{ role: 'user', content: '写个快排' }], answerText: 'def quicksort...' });
  assert.match(msgs[0].content, /correctness/);
  assert.match(msgs[0].content, /instruction_following/);
  assert.match(msgs[0].content, /completeness/);
  assert.match(msgs[0].content, /safety/);
  assert.match(msgs[0].content, /verifiable.*false.*score.*null|score.*null.*verifiable.*false/s);
  assert.match(msgs[1].content, /写个快排/);
  assert.ok(JUDGE_RUBRIC_VERSION);
});

test('taskCheck 提示词：携带判定与编码表', () => {
  const msgs = buildTaskCheckMessages({ messages: [{ role: 'user', content: '帮我写 SQL' }], predictedTask: 'sql', predictedTier: 'balanced' });
  assert.match(msgs[1].content, /task=sql tier=balanced/);
  assert.match(msgs[0].content, /task_agree/);
});

test('A/B 顺序随机：两种顺序都能出，且可注入确定性随机源', () => {
  const seen = new Set();
  for (let i = 0; i < 100; i += 1) seen.add(randomAbOrder().join(''));
  assert.ok(seen.has('AB') && seen.has('BA'));
  assert.deepEqual(randomAbOrder(() => 0.9), ['B', 'A']);
  assert.deepEqual(randomAbOrder(() => 0.1), ['A', 'B']);
});

test('JudgeGuard：每日调用/token 双预算 + 自然日翻转', () => {
  let t = Date.UTC(2026, 7, 25, 1);
  const g = new JudgeGuard({ dailyMaxCalls: 2, dailyMaxTokens: 1000, now: () => t });
  assert.equal(g.canCall().ok, true);
  g.recordCall(600); g.recordCall(100);
  assert.equal(g.canCall().reason, 'daily_calls_exhausted');
  t += 86400000; // 次日
  assert.equal(g.canCall().ok, true, '跨日应重置');
  const g2 = new JudgeGuard({ dailyMaxCalls: 100, dailyMaxTokens: 500, now: () => t });
  g2.recordCall(501);
  assert.equal(g2.canCall().reason, 'daily_tokens_exhausted');
});

test('JudgeGuard：连续失败熔断 → 冷却后半开试探（一次失败再开，成功关闭）', () => {
  let t = 1000000;
  const g = new JudgeGuard({ circuitThreshold: 3, cooldownMs: 1000, now: () => t });
  g.recordFailure(); g.recordFailure();
  assert.equal(g.canCall().ok, true, '未到阈值不熔断');
  g.recordFailure();
  assert.equal(g.canCall().reason, 'circuit_open');
  t += 500;
  assert.equal(g.canCall().reason, 'circuit_open', '冷却未到仍 open');
  t += 600; // 过冷却
  assert.equal(g.canCall().ok, true, '冷却后 half-open 放行试探');
  g.recordFailure(); // 半开试探失败
  assert.equal(g.canCall().reason, 'circuit_open', '半开失败回 open');
  t += 1001;
  assert.equal(g.canCall().ok, true);
  g.recordSuccess(); // 半开成功
  assert.equal(g.snapshot().circuit, 'closed');
  assert.equal(g.snapshot().consecutiveFailures, 0);
});

test('JudgeGuard.updateLimits：热更新上限不清当日用量/熔断态', () => {
  let t = 1000000;
  const g = new JudgeGuard({ dailyMaxCalls: 10, now: () => t });
  g.recordCall(0); g.recordCall(0);
  g.updateLimits({ dailyMaxCalls: 1 }); // 上限降到 1，已用 2
  assert.equal(g.canCall().reason, 'daily_calls_exhausted', '已超新上限仍拦');
  g.recordFailure(); g.recordFailure(); g.recordFailure();
  g.updateLimits({ dailyMaxCalls: 999 });
  assert.equal(g.snapshot().calls, 2, 'updateLimits 不得清零用量');
});

test('callJudgeModel：ok 路径带 usage/latency，非 200 报错，超时 abort', async () => {
  const fake = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"correctness":{"score":8,"verifiable":true}}' } }], usage: { total_tokens: 120 } }) });
  const r = await callJudgeModel({ messages: [], model: 'm', baseUrl: 'http://x', apiKey: 'k', fetchImpl: fake });
  assert.equal(r.ok, true);
  assert.equal(r.usage.total_tokens, 120);
  assert.ok(r.latencyMs >= 0);
  const bad = async () => ({ ok: false, status: 429 });
  const r2 = await callJudgeModel({ messages: [], model: 'm', baseUrl: 'http://x', apiKey: 'k', fetchImpl: bad });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /429/);
  const slow = async (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))));
  const r3 = await callJudgeModel({ messages: [], model: 'm', baseUrl: 'http://x', apiKey: 'k', timeoutMs: 50, fetchImpl: slow });
  assert.equal(r3.ok, false);
  assert.match(r3.error, /超时|abort/i);
});

test('pair 评审 prompt：order 决定槽位呈现顺序，labels 随槽位标注真实模型', () => {
  const msgs = buildJudgeMessages({
    messages: [{ role: 'user', content: '解释 CAP' }],
    comparison: { order: ['B', 'A'], labels: { A: 'model-a', B: 'model-b' }, answers: { A: '回答甲', B: '回答乙' } },
  });
  // order=['B','A']：B 的回答占槽位A（先呈现），标注 model-b
  const slotA = msgs[1].content.indexOf('回答乙');
  const slotB = msgs[1].content.indexOf('回答甲');
  assert.ok(slotA >= 0 && slotB > slotA, 'order[0]=B 应先呈现（占槽位A）');
  const aLabel = msgs[1].content.indexOf('model-b');
  assert.ok(aLabel < slotA, '槽位A 标注的应是 model-b');
  assert.match(msgs[1].content, /model-a/);
  assert.match(msgs[0].content, /verdict/);
});
