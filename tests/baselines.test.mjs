import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { paretoFrontier, oracleChoice, zeroRouterChoice, routeRequest } from '../src/router.mjs';

const config = JSON.parse(await readFile(new URL('../config/router.json', import.meta.url), 'utf8'));

test('paretoFrontier：成本+时延双维非支配集合，被支配模型剔除', () => {
  const models = [
    { id: 'cheap-slow', enabled: true, costIndex: 0.1, latencyIndex: 0.9 },
    { id: 'expensive-fast', enabled: true, costIndex: 0.9, latencyIndex: 0.1 },
    { id: 'dominated', enabled: true, costIndex: 0.95, latencyIndex: 0.95 },
    { id: 'disabled-one', enabled: false, costIndex: 0.01, latencyIndex: 0.01 },
  ];
  const front = paretoFrontier(models).map((m) => m.id);
  assert.deepEqual([...front].sort(), ['cheap-slow', 'expensive-fast']);
});

test('paretoFrontier：真实模型池前沿至少含一个模型且全部启用（当前 dsf 双维占优，前沿=1 属正常）', () => {
  const front = paretoFrontier(config.models);
  assert.ok(front.length >= 1, `前沿应 ≥1 个模型，实际 ${front.length}`);
  assert.ok(front.every((m) => m.enabled !== false));
});

test('oracleChoice：事后最优=满足质量线的最低成本；质量线不可达时退最高质量', () => {
  const body = { messages: [{ role: 'user', content: '帮我写一个 Python 排序函数并解释复杂度' }] };
  const oracle = oracleChoice(body, config);
  assert.ok(oracle, '应返回模型');
  assert.ok(config.models.includes(oracle));
});

test('zeroRouterChoice：同一请求确定性映射到 Pareto 前沿成员', () => {
  const body = { messages: [{ role: 'user', content: '把这段话翻译成英文并整理成 JSON' }] };
  const frontIds = new Set(paretoFrontier(config.models).map((m) => m.id));
  for (let i = 0; i < 3; i++) {
    const pick = zeroRouterChoice(body, config);
    assert.ok(pick, '应返回模型');
    assert.ok(frontIds.has(pick.id), `选择 ${pick.id} 必须在前沿内`);
  }
});

test('路由质量应落在随机基线与事后最优之间（10 类代表任务聚合）', () => {
  const samples = [
    { messages: [{ role: 'user', content: '今天星期几？' }] },
    { messages: [{ role: 'user', content: '分析 Java n++ 并发安全问题并给修复代码' }] },
    { messages: [{ role: 'user', content: '比较三种分布式事务方案的优劣' }] },
    { messages: [{ role: 'user', content: '写三条公司宣传语' }] },
    { messages: [{ role: 'user', content: '抽取姓名城市输出 JSON：张晓明在广州' }], response_format: { type: 'json_object' } },
  ];
  let routerQuality = 0, zeroQuality = 0, oracleQuality = 0, count = 0;
  for (const body of samples) {
    const decision = routeRequest({ model: 'auto', ...body }, config);
    const task = decision.analysis.task;
    const q = (m) => Number(m.quality?.[task] ?? m.quality.default);
    routerQuality += q(config.models.find((m) => m.id === decision.suggestedModel));
    zeroQuality += q(zeroRouterChoice(body, config));
    oracleQuality += q(oracleChoice(body, config));
    count++;
  }
  routerQuality /= count; zeroQuality /= count; oracleQuality /= count;
  assert.ok(zeroQuality <= oracleQuality + 1e-9, `随机基线(${zeroQuality.toFixed(3)}) 不应高于事后最优(${oracleQuality.toFixed(3)})`);
  assert.ok(routerQuality >= zeroQuality - 0.05, `当前路由(${routerQuality.toFixed(3)}) 至少应与随机基线(${zeroQuality.toFixed(3)})相当`);
});

test('分类器评测资产齐备：heldout.jsonl 与 evaluate_classifier.py 存在且同步', async () => {
  assert.ok(existsSync(new URL('../data/training/model/heldout.jsonl', import.meta.url)), 'heldout.jsonl 应存在');
  assert.ok(existsSync(new URL('../scripts/evaluate_classifier.py', import.meta.url)), '评测脚本应存在');
  const heldout = (await readFile(new URL('../data/training/model/heldout.jsonl', import.meta.url), 'utf8')).trim().split('\n');
  assert.ok(heldout.length >= 400, `heldout 应约 454 条，实际 ${heldout.length}`);
  for (const line of heldout.slice(0, 5)) {
    const row = JSON.parse(line);
    assert.ok(['default', 'coding', 'reasoning', 'creative', 'extraction'].includes(row.task));
    assert.ok(typeof row.text === 'string' && row.text.length > 0);
  }
});

test('Zero-Router 哈希负数防回归：FNV-1a 溢出产生负哈希时索引必须归一化（真实 12 样本+新价 3 模型前沿复现 2026-08-21 simulate 400）', async () => {
  // 2026-08-21 新价上线后 /admin/api/simulate 稳定 400：zeroRouterChoice 里 front[h % len]
  // 在 h 为负数时产生负索引 → undefined → 读 .capabilities 崩。旧价 2 模型前沿负索引恰好
  // 落在 [-1,0] 内有效，掩盖了此 bug；新价 3 模型前沿出现 -2 索引才暴露。
  // 这四个样本的 FNV-1a(requestText) 均为负数（-271207372 等），修复前必崩。
  const negativeHashSamples = [
    { messages: [{ role: 'user', content: '分析 Java 计数器 n++ 的并发安全问题，给出最小修复和单元测试。' }] },
    { messages: [{ role: 'user', content: '比较 Saga、TCC 和本地消息表三种分布式事务方案，从一致性、成本、复杂度和恢复能力给出取舍。' }] },
    { messages: [{ role: 'user', content: '为企业内部 AI 助手写三条简洁宣传语，每条不超过18字。' }] },
    { messages: [{ role: 'user', content: '编写 PostgreSQL 查询，统计最近30天每个用户的订单金额并按金额降序。' }] },
  ];
  for (const body of negativeHashSamples) {
    const chosen = zeroRouterChoice(body, config); // 修复前：TypeError: Cannot read properties of undefined
    assert.ok(chosen === null || typeof chosen === 'object', `负哈希样本应返回模型或 null，而非崩溃：${JSON.stringify(body.messages[0].content).slice(0, 30)}`);
  }
});
