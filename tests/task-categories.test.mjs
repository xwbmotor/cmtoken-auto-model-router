import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRequest } from '../src/router.mjs';

// 任务分类体系对齐 OpenRouter：大类（路由打分层）+ 小类（展示层细分）
// 大类不破坏：quality[task] 回退链、任务榜单聚合键
// 小类只做展示细分：analyzeRequest 返回 subTask，不参与打分
const cfg = { models: [], taskRules: { simpleMaxComplexity: 0.34, complexMinComplexity: 0.7 } };

test('大类保持 5 类不变（打分链兼容）', () => {
  const tasks = new Set([
    analyzeRequest({ messages: [{ role: 'user', content: '写一个 Python 函数' }] }, cfg).task,
    analyzeRequest({ messages: [{ role: 'user', content: '分析分布式事务方案的优缺点' }] }, cfg).task,
    analyzeRequest({ messages: [{ role: 'user', content: '写三条宣传文案' }] }, cfg).task,
    analyzeRequest({ messages: [{ role: 'user', content: '抽取姓名并输出 JSON' }] }, cfg).task,
    analyzeRequest({ messages: [{ role: 'user', content: '你好' }] }, cfg).task
  ]);
  assert.deepEqual([...tasks].sort(), ['coding', 'creative', 'default', 'extraction', 'reasoning']);
});

test('小类细分：代码大类下区分调试/评审/SQL/生成', () => {
  const cases = [
    ['这个报错帮我排查一下 StackTrace', 'debugging'],
    ['帮我评审这段代码的实现', 'code-review'],
    ['写 SQL 统计最近 30 天订单金额', 'sql-query'],
    ['写一个 Python 函数实现快速排序', null]  // 无细分线索 → null（展示时落 defaultSub）
  ];
  for (const [text, expected] of cases) {
    const r = analyzeRequest({ messages: [{ role: 'user', content: text }] }, cfg);
    assert.equal(r.subTask, expected, `"${text}" 应为 ${expected}，得到 ${r.subTask}`);
  }
});

test('小类细分：数据大类下区分分类/转换/抽取', () => {
  const cases = [
    ['把这条工单分类为售后或售前', 'classification'],
    ['把日期字段转换为 ISO 格式', 'data-transformation'],
    ['抽取文本中的姓名和城市输出 JSON', 'data-extraction']
  ];
  for (const [text, expected] of cases) {
    const r = analyzeRequest({ messages: [{ role: 'user', content: text }] }, cfg);
    assert.equal(r.task, 'extraction');
    assert.equal(r.subTask, expected, `"${text}" 应为 ${expected}`);
  }
});

test('小类细分：分析大类下区分架构/规划/研究', () => {
  const cases = [
    ['设计一个高并发系统的架构分层', 'architecture'],
    ['给出项目三期的实施规划步骤', 'multi-step-planning'],
    ['写一份行业趋势研究报告', 'research-report']
  ];
  for (const [text, expected] of cases) {
    const r = analyzeRequest({ messages: [{ role: 'user', content: text }] }, cfg);
    assert.equal(r.task, 'reasoning');
    assert.equal(r.subTask, expected, `"${text}" 应为 ${expected}`);
  }
});

test('小类细分：内容大类下区分角色扮演/文案', () => {
  const a = analyzeRequest({ messages: [{ role: 'user', content: '扮演一个海盗船长写一段对话' }] }, cfg);
  assert.equal(a.task, 'creative');
  assert.equal(a.subTask, 'roleplay-fiction');
  const b = analyzeRequest({ messages: [{ role: 'user', content: '给新产品写三条营销文案' }] }, cfg);
  assert.equal(b.subTask, 'content-writing');
});

test('小类不影响难度与置信度（打分层零扰动）', () => {
  const text = '把这条工单分类为售后或售前，只返回标签';
  const withSub = analyzeRequest({ messages: [{ role: 'user', content: text }] }, cfg);
  // 去掉细分线索词后的同类请求，complexity/confidence 应在同一量级
  const plain = analyzeRequest({ messages: [{ role: 'user', content: '把这条工单归到售后或售前，只返回标签' }] }, cfg);
  assert.ok(Math.abs(withSub.complexity - plain.complexity) < 0.15);
  assert.equal(withSub.confidence, plain.confidence);
});
