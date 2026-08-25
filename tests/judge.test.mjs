// v0.8.0 Judge 单元测试：抽样稳定性、评分归一化、护栏熔断/预算、JSON 解析
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  shouldSampleJudge, buildJudgeMessages, buildTaskCheckMessages, parseJudgeJson,
  normalizeScore, normalizeDimension, normalizeVerdict, randomAbOrder,
  JudgeGuard, callJudgeModel, judgePromptHash, JUDGE_RUBRIC_VERSION,
  JUDGE_TASK_ENUM, normalizeSuggestedTask, looksLikeQualityVerdict, isValidTaskCheckVerdict,
  extractNonStreamAnswerText, createAnswerCollector, compileRedactPatterns, redactText,
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
  const msgs = buildTaskCheckMessages({ messages: [{ role: 'user', content: '帮我写 SQL' }], routeTask: 'coding', subTask: 'sql', predictedTier: 'balanced' });
  assert.match(msgs[1].content, /routeTask=coding subTask=sql tier=balanced/);
  assert.match(msgs[0].content, /task_agree/);
});

test('A/B 顺序随机：两种顺序都能出，且可注入确定性随机源', () => {
  const seen = new Set();
  for (let i = 0; i < 100; i += 1) seen.add(randomAbOrder().join(''));
  assert.ok(seen.has('AB') && seen.has('BA'));
  assert.deepEqual(randomAbOrder(() => 0.9), ['B', 'A']);
  assert.deepEqual(randomAbOrder(() => 0.1), ['A', 'B']);
});

test('JudgeGuard：每日调用/token 双预算（reserve 预占制）+ 自然日翻转', () => {
  let t = Date.UTC(2026, 7, 25, 1);
  const g = new JudgeGuard({ dailyMaxCalls: 2, dailyMaxTokens: 1000, now: () => t });
  const r1 = g.reserve({ estTokens: 100 });
  assert.equal(r1.ok, true);
  g.settle(r1.handle, { tokens: 600, ok: true });
  const r2 = g.reserve({ estTokens: 100 });
  g.settle(r2.handle, { tokens: 100, ok: true });
  assert.equal(g.reserve().reason, 'daily_calls_exhausted');
  t += 86400000; // 次日
  assert.equal(g.reserve().ok, true, '跨日应重置');
  const g2 = new JudgeGuard({ dailyMaxCalls: 100, dailyMaxTokens: 500, now: () => t });
  const r3 = g2.reserve({ estTokens: 400 });
  assert.equal(r3.ok, true);
  g2.settle(r3.handle, { tokens: 501, ok: true }); // 实际消耗超出预估，按实际结算
  assert.equal(g2.reserve().reason, 'daily_tokens_exhausted', '实际 token 已超上限，后续一律拦');
});

test('JudgeGuard：并发预占不穿透——N 个并发 reserve 在 await 期间全部计数', () => {
  const g = new JudgeGuard({ dailyMaxCalls: 3, now: () => 1000 });
  const held = [g.reserve(), g.reserve(), g.reserve()];
  assert.ok(held.every((r) => r.ok), '前三个应全部预占成功');
  assert.equal(g.reserve().reason, 'daily_calls_exhausted', '第 4 个并发必须被拦（旧 canCall 制会穿透）');
  g.release(held[2].handle);
  assert.equal(g.reserve().ok, true, 'release 退还名额');
  g.settle(held[0].handle, { tokens: 10, ok: true });
  assert.equal(g.settle(held[0].handle, { tokens: 10, ok: true }), false, '重复 settle 必须拒绝');
});

test('JudgeGuard：在途 token 预估占用预算（防 token 穿透）', () => {
  const g = new JudgeGuard({ dailyMaxCalls: 100, dailyMaxTokens: 1000, now: () => 1000 });
  const r1 = g.reserve({ estTokens: 800 });
  assert.ok(r1.ok);
  assert.equal(g.reserve({ estTokens: 800 }).reason, 'daily_tokens_exhausted', '在途预估也要占预算（800+800>1000 拦截）');
  g.settle(r1.handle, { tokens: 300, ok: true }); // 实际只用了 300，多占额度退回
  const r2 = g.reserve({ estTokens: 700 }); // 300+700=1000 ≤ 1000 放行
  assert.ok(r2.ok, '结算后退回多占的额度');
  g.settle(r2.handle, { tokens: 300, ok: true });
  assert.equal(g.reserve({ estTokens: 500 }).reason, 'daily_tokens_exhausted', '600 已用+500 预估超限拦截');
});

test('JudgeGuard：连续失败熔断 → 冷却后半开单探针（失败再开，成功关闭）', () => {
  let t = 1000000;
  const g = new JudgeGuard({ circuitThreshold: 3, cooldownMs: 1000, now: () => t });
  const a1 = g.reserve(); g.settle(a1.handle, { ok: false });
  const a2 = g.reserve(); g.settle(a2.handle, { ok: false });
  const a3 = g.reserve();
  assert.equal(a3.ok, true, '两败未到阈值不熔断');
  g.settle(a3.handle, { ok: false }); // 第三败 → open
  assert.equal(g.reserve().reason, 'circuit_open');
  t += 500;
  assert.equal(g.reserve().reason, 'circuit_open', '冷却未到仍 open');
  t += 600; // 过冷却
  const probe = g.reserve();
  assert.equal(probe.ok, true, '冷却后 half-open 放行试探');
  assert.equal(g.reserve().reason, 'circuit_open', '半开期间第二个并发请求必须被拦（单探针）');
  g.settle(probe.handle, { ok: false }); // 半开试探失败
  assert.equal(g.reserve().reason, 'circuit_open', '半开失败回 open');
  t += 1001;
  const probe2 = g.reserve();
  g.settle(probe2.handle, { ok: true }); // 半开成功
  assert.equal(g.snapshot().circuit, 'closed');
  assert.equal(g.snapshot().consecutiveFailures, 0);
});

// —— 十三审 P1-1：探针状态机补测——预算失败/释放不得永久卡死 half-open ——
test('十三审 P1-1：半开探针遇预算耗尽——probeBusy 必须回滚，不得永久 circuit_open', () => {
  let t = 1000000;
  const g = new JudgeGuard({ dailyMaxCalls: 10, dailyMaxTokens: 1000, circuitThreshold: 2, cooldownMs: 1000, now: () => t });
  // 先灌满 token 预算（此时 circuit=closed，正常路径）
  const filler = g.reserve({ estTokens: 950 });
  assert.equal(filler.ok, true);
  // 再制造熔断：release filler 后走两败
  g.release(filler.handle);
  g.settle(g.reserve({ estTokens: 20 }).handle, { tokens: 900, ok: false }); // 实际结算 900 → tokens=900
  g.settle(g.reserve({ estTokens: 20 }).handle, { tokens: 0, ok: false }); // 二连败 → open
  assert.equal(g.snapshot().circuit, 'open');
  t += 1001; // 过冷却
  // 探针请求：tokens 900（已结算）+ 0（在途）+ 800（预估）> 1000 → 预算拦
  const probe = g.reserve({ estTokens: 800 });
  assert.equal(probe.reason, 'daily_tokens_exhausted');
  // 修复前：reserve 已把 circuit 切 half-open + probeBusy=true，预算失败不回滚 → 永久卡死。
  // 修复后：预算检查在状态迁移之前，迁移没发生。
  assert.equal(g.snapshot().circuit, 'open', '预算失败的探针不得切 half-open（旧 bug：切了不回滚）');
  assert.ok(g.snapshot().invariantOk, '不变量：probeBusy 悬空即状态机 bug');
  t += 86400000; // 跨日（预算归零——旧 bug 下依然卡死，修复后应能探针）
  const probe2 = g.reserve({ estTokens: 800 });
  assert.equal(probe2.ok, true, '跨日预算归零后探针应能发起（旧 bug：永久 circuit_open）');
  assert.equal(g.snapshot().circuit, 'half-open');
  g.settle(probe2.handle, { tokens: 700, ok: true });
  assert.equal(g.snapshot().circuit, 'closed', '探针成功关闭熔断');
});

test('十三审 P1-1：半开探针被 release（如缺 api key）——必须回滚 half-open 回 open', () => {
  let t = 1000000;
  const g = new JudgeGuard({ circuitThreshold: 2, cooldownMs: 1000, now: () => t });
  g.settle(g.reserve().handle, { ok: false });
  g.settle(g.reserve().handle, { ok: false }); // open
  t += 1001;
  const probe = g.reserve();
  assert.equal(probe.ok, true);
  assert.equal(g.snapshot().circuit, 'half-open');
  g.release(probe.handle); // 未发起上游调用（缺 key 路径）
  // 修复前：release 只删 map，probeBusy 悬空 → 后续全部 circuit_open，跨日也不恢复。
  assert.equal(g.snapshot().circuit, 'open', '探针被 release 应回 open（冷却计时保留）');
  assert.ok(g.snapshot().invariantOk, 'release 后不变量必须成立');
  const next = g.reserve();
  assert.equal(next.ok, true, '回滚后下一个 reserve 可再当探针');
  g.settle(next.handle, { ok: true });
  assert.equal(g.snapshot().circuit, 'closed');
});

test('十三审 P1-1：跨日预算归零——卡死态（若有）必须能恢复探针', () => {
  let t = Date.UTC(2026, 7, 25, 1);
  const g = new JudgeGuard({ dailyMaxCalls: 2, dailyMaxTokens: 500, circuitThreshold: 2, cooldownMs: 1000, now: () => t });
  g.settle(g.reserve({ estTokens: 200 }).handle, { tokens: 200, ok: false });
  g.settle(g.reserve({ estTokens: 200 }).handle, { tokens: 200, ok: false }); // 预算满 + open
  t += 86400000 + 1001; // 跨日 + 过冷却
  const probe = g.reserve({ estTokens: 400 });
  assert.equal(probe.ok, true, '跨日归零 + 过冷却：探针应放行');
  g.settle(probe.handle, { tokens: 300, ok: true });
  assert.equal(g.snapshot().circuit, 'closed');
  assert.ok(g.snapshot().invariantOk);
});

test('JudgeGuard：persist/restore——重启恢复当日用量与熔断态，跨日归零', () => {
  const states = [];
  let t = Date.UTC(2026, 7, 25, 1);
  const g = new JudgeGuard({ dailyMaxCalls: 10, circuitThreshold: 3, now: () => t, persist: (s) => states.push(s) });
  const r1 = g.reserve(); g.settle(r1.handle, { tokens: 500, ok: true });
  const r2 = g.reserve(); g.settle(r2.handle, { ok: false });
  const r3 = g.reserve(); g.settle(r3.handle, { ok: false });
  const r4 = g.reserve(); g.settle(r4.handle, { ok: false });
  const saved = g.snapshot();
  assert.equal(saved.circuit, 'open', '三连败应熔断');
  const g2 = new JudgeGuard({ dailyMaxCalls: 10, circuitThreshold: 3, now: () => t });
  g2.restore(states.at(-1));
  const after = g2.snapshot();
  assert.equal(after.calls, saved.calls, '重启后当日调用数不重置');
  assert.equal(after.tokens, saved.tokens, '重启后当日 token 不重置');
  assert.equal(after.circuit, 'open', '重启后熔断态保留');
  assert.notEqual(g2.reserve().ok, true, '重启后熔断期间仍拦');
  t += 86400000;
  assert.equal(g2.reserve().ok, true, '跨日恢复');
});

test('JudgeGuard.updateLimits：热更新上限不清当日用量/熔断态', () => {
  let t = 1000000;
  const g = new JudgeGuard({ dailyMaxCalls: 10, now: () => t });
  const r1 = g.reserve(); g.settle(r1.handle, { tokens: 0, ok: true });
  const r2 = g.reserve(); g.settle(r2.handle, { tokens: 0, ok: true });
  g.updateLimits({ dailyMaxCalls: 1 }); // 上限降到 1，已用 2
  assert.equal(g.reserve().reason, 'daily_calls_exhausted', '已超新上限仍拦');
  g.updateLimits({ dailyMaxCalls: 999 }); // 再放宽，制造两次失败 settle
  const f1 = g.reserve(); g.settle(f1.handle, { ok: false });
  const f2 = g.reserve(); g.settle(f2.handle, { ok: false });
  g.updateLimits({ dailyMaxCalls: 999 });
  assert.equal(g.snapshot().calls, 4, 'updateLimits 不得清零用量');
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

// ─── v0.8.1 十二审修复面用例 ───
const CHARS_NN = String.fromCharCode(10, 10);


test('正文提取（非流式）：解析 choices[0].message.content，兼容多段数组；信封字段不入正文', () => {
  const env = JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion', model: 'glm-4.7', choices: [{ index: 0, message: { role: 'assistant', content: '回答正文第一句。回答正文第二句。' }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } });
  const t = extractNonStreamAnswerText(env);
  assert.equal(t, '回答正文第一句。回答正文第二句。');
  assert.ok(!t.includes('total_tokens'), '正文不得混入 usage');
  // 多段 content（vision 风格）
  const multi = JSON.stringify({ choices: [{ message: { content: [{ type: 'text', text: '甲' }, { type: 'text', text: '乙' }] } }] });
  assert.equal(extractNonStreamAnswerText(multi), '甲乙');
  // 坏输入
  assert.equal(extractNonStreamAnswerText('not json'), null);
  assert.equal(extractNonStreamAnswerText('{}'), null);
  assert.equal(extractNonStreamAnswerText(''), null);
});

test('正文提取（流式 SSE）：delta.content 增量拼接，协议行/usage/[DONE]/reasoning 不入正文；chunk 边界切分多字节字符安全', () => {
  const c = createAnswerCollector(65536);
  const ev1 = 'data: ' + JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] }) + '\n\n';
  const ev2 = 'data: ' + JSON.stringify({ choices: [{ delta: { content: '你好' } }] }) + '\n\n';
  const ev3 = 'data: ' + JSON.stringify({ choices: [{ delta: { content: '，世界' } }] }) + '\n\n';
  const usage = 'data: ' + JSON.stringify({ choices: [], usage: { total_tokens: 99 } }) + '\n\n';
  const done = 'data: [DONE]\n\n';
  // 故意按字节中间切断（多字节中文跨 chunk）
  const whole = Buffer.from(ev1 + ev2 + ev3 + usage + done);
  const cut = Math.floor(whole.length * 0.4);
  c.push(whole.subarray(0, cut));
  c.push(whole.subarray(cut));
  const t = c.text();
  assert.equal(t, '你好，世界');
  assert.ok(!t.includes('total_tokens') && !t.includes('DONE') && !t.includes('data:'), '协议噪音不得入正文');
  // reasoning 字段（思考型模型）不混入
  const c2 = createAnswerCollector(65536);
  c2.push(Buffer.from('data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: '思考中' } }] }) + '\n\n'));
  c2.push(Buffer.from('data: ' + JSON.stringify({ choices: [{ delta: { content: '正文' } }] }) + '\n\n'));
  assert.equal(c2.text(), '正文');
  // undici 真实场景：chunk 是纯 Uint8Array（toString 无编码参数）——必须入口 Buffer 化
  const cU = createAnswerCollector(65536);
  const raw = Buffer.from('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Uint8Array 边界' } }] }) + CHARS_NN);
  const arr = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  cU.push(arr);
  assert.equal(cU.text(), 'Uint8Array 边界');
  // 64KB 软上限
  const c3 = createAnswerCollector(10);
  c3.push(Buffer.from('data: ' + JSON.stringify({ choices: [{ delta: { content: '0123456789ABCDEF' } }] }) + '\n\n'));
  assert.equal(c3.text().length, 10, '软上限截断');
});

test('分类契约：JUDGE_TASK_ENUM 与路由大类一致；suggested_task 枚举校验；task_agree 必须布尔', () => {
  assert.deepEqual(JUDGE_TASK_ENUM, ['coding', 'reasoning', 'creative', 'extraction', 'agent', 'default']);
  assert.equal(normalizeSuggestedTask('coding'), 'coding');
  assert.equal(normalizeSuggestedTask('sql'), null, 'sql 是 subTask 细类，不得作为路由大类建议');
  assert.equal(normalizeSuggestedTask('EXPLICIT'), null);
  assert.equal(normalizeSuggestedTask(null), null);
  assert.equal(isValidTaskCheckVerdict({ task_agree: true, reason: '对' }), true);
  assert.equal(isValidTaskCheckVerdict({ task_agree: 'true' }), false, '字符串 true 不是布尔');
  assert.equal(isValidTaskCheckVerdict({}), false);
  assert.equal(isValidTaskCheckVerdict(null), false);
});

test('taskCheck 提示词 v2：呈现 routeTask/subTask 区分、大类编码表、不含 subTask 细类判定', () => {
  const msgs = buildTaskCheckMessages({ messages: [{ role: 'user', content: '帮我写 SQL' }], routeTask: 'extraction', subTask: 'sql', predictedTier: 'balanced' });
  assert.match(msgs[1].content, /routeTask=extraction subTask=sql tier=balanced/);
  assert.match(msgs[0].content, /coding\/reasoning\/creative\/extraction\/agent\/default/);
  assert.doesNotMatch(msgs[0].content, /编码表[^\n]*sql/, '大类编码表行不得混入 subTask 细类');
});

test('空 verdict 拦截：{} / null / 缺四维 不算评分成功', () => {
  assert.equal(looksLikeQualityVerdict({}), false);
  assert.equal(looksLikeQualityVerdict(null), false);
  assert.equal(looksLikeQualityVerdict({ overall_comment: '只有总评' }), false, '只有 overall_comment 不算有效 verdict');
  assert.equal(looksLikeQualityVerdict({ correctness: { score: 8 } }), true);
  assert.equal(looksLikeQualityVerdict({ instruction_following: { score: 9 } }), true);
  assert.equal(looksLikeQualityVerdict({ completeness: { score: null, verifiable: false } }), true, '维度存在即有效（值可缺失）');
});

test('redactPatterns：compile + 替换，非法正则静默跳过', () => {
  const pats = compileRedactPatterns(['sk-[A-Za-z0-9]{8,}', '[bad regex']);
  assert.equal(pats.length, 1, '非法正则跳过');
  const out = redactText('key 是 sk-abc12345xyz 请保密', pats);
  assert.equal(out, 'key 是 [REDACTED] 请保密');
  assert.equal(redactText(null, pats), null);
  assert.equal(redactText('普通文本', []), '普通文本');
});

test('buildJudgeMessages：redactors 作用于用户消息与回答正文', () => {
  const pats = compileRedactPatterns(['密码是 \\d+']);
  const msgs = buildJudgeMessages({ messages: [{ role: 'user', content: '密码是 123456' }], answerText: '你的密码是 654321', redactors: pats });
  assert.ok(msgs[1].content.includes('[REDACTED]'));
  assert.ok(!msgs[1].content.includes('123456'));
  assert.ok(!msgs[1].content.includes('654321'));
});
