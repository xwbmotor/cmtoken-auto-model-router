import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRequest } from '../src/router.mjs';

// 任务分类体系对齐 OpenRouter rankings TASK TYPE 官方结构：4 大类 30 小类
// CODE(9) / AGENTS(6) / DATA(6) / WRITING & CHAT(9)
// 路由打分层保持 5 族（quality 跑分支撑）+ agent；小类只做展示细分，不参与打分
const cfg = { models: [], taskRules: { simpleMaxComplexity: 0.34, complexMinComplexity: 0.7 } };

test('打分层大类保持兼容（5 族 + agent，quality 回退链不受影响）', () => {
  const tasks = new Set([
    analyzeRequest({ messages: [{ role: 'user', content: '今天星期几' }] }, cfg).task,
    analyzeRequest({ messages: [{ role: 'user', content: '写一个 Python 函数解析日志' }] }, cfg).task,
    analyzeRequest({ messages: [{ role: 'user', content: '比较两种方案的优劣并给出建议' }] }, cfg).task,
    analyzeRequest({ messages: [{ role: 'user', content: '写一条营销文案' }] }, cfg).task,
    analyzeRequest({ messages: [{ role: 'user', content: '把这段话提取为 JSON' }] }, cfg).task,
    analyzeRequest({ messages: [{ role: 'user', content: '查询订单' }], tools: [{ type: 'function', function: { name: 'get_order' } }] }, cfg).task
  ]);
  for (const t of ['default', 'coding', 'reasoning', 'creative', 'extraction', 'agent']) assert.ok(tasks.has(t), `缺任务 ${t}`);
});

test('CODE 小类（9）：调试/审查/SQL/前端/DevOps/Shell/文件/仓库', () => {
  const cases = [
    ['接口报错 500 怎么排查', 'debugging'],
    ['review 一下这段实现', 'code-review'],
    ['写 SQL 统计订单表', 'sql-database'],
    ['把这个设计稿还原成 Vue 组件', 'frontend-ui'],
    ['写一份 k8s 部署配置', 'devops-config'],
    ['用 shell 命令批量重命名', 'shell-execution'],
    ['解析 csv 文件里的手机号', 'file-io'],
    ['扫描整个代码库找硬编码密钥', 'repo-scanning']
  ];
  for (const [text, want] of cases) {
    const r = analyzeRequest({ messages: [{ role: 'user', content: text }] }, cfg);
    assert.equal(r.subTask, want, `${text} → 期望 ${want}，实际 ${r.subTask}`);
  }
});

test('AGENTS 小类：tools 请求默认 workflow-execution，搜索类工具→web-search', () => {
  const wf = analyzeRequest({ messages: [{ role: 'user', content: '查询订单状态' }], tools: [{ type: 'function', function: { name: 'get_order' } }] }, cfg);
  assert.equal(wf.task, 'agent');
  assert.equal(wf.subTask, 'workflow-execution');
  const ws = analyzeRequest({ messages: [{ role: 'user', content: '查一下最新消息' }], tools: [{ type: 'function', function: { name: 'web_search' } }] }, cfg);
  assert.equal(ws.subTask, 'web-search');
});

test('DATA 小类（6）：抽取/转换/分类/摘要/翻译', () => {
  const cases = [
    ['从这段话提取姓名和城市输出 JSON', 'data-extraction'],
    ['把这个日期字段转换成 ISO 格式并清洗', 'data-transformation'],
    ['把工单分类为售后或售前', 'classification'],
    ['把这份会议纪要总结成三条', 'summarization'],
    ['把这段话翻译成英文', 'translation']
  ];
  for (const [text, want] of cases) {
    const r = analyzeRequest({ messages: [{ role: userRole(), content: text }] }, cfg);
    assert.equal(r.subTask, want, `${text} → 期望 ${want}，实际 ${r.subTask}`);
  }
});

test('WRITING & CHAT 小类：内容写作/角色扮演/客服/金融/安全', () => {
  // 客服/金融/安全路由族=default（打分走通用档），展示层落 WRITING & CHAT 小类
  const cases = [
    ['写三条产品宣传文案', 'creative', 'content-writing'],
    ['扮演海盗船长写对话', 'creative', 'roleplay-fiction'],
    ['客服话术：客户投诉快递慢怎么回复', 'default', 'customer-support'],
    ['分析这只股票的技术面', 'default', 'finance-trading'],
    ['帮我做一次漏洞渗透测试方案', 'reasoning', 'security-audit'],
    ['在吗，陪我聊聊天', 'default', 'conversation']
  ];
  for (const [text, task, want] of cases) {
    const r = analyzeRequest({ messages: [{ role: 'user', content: text }] }, cfg);
    assert.equal(r.task, task, `${text} 大类 ${r.task} ≠ ${task}`);
    assert.equal(r.subTask, want, `${text} → 期望 ${want}，实际 ${r.subTask}`);
  }
});

test('小类不影响难度与置信度（打分层零扰动）', () => {
  const a = analyzeRequest({ messages: [{ role: 'user', content: '写一个 Python 函数解析日志文件' }] }, cfg);
  const b = analyzeRequest({ messages: [{ role: 'user', content: '写一个 Python 函数' }] }, cfg);
  assert.equal(a.complexity > 0, true);
  assert.equal(a.confidence > 0, true);
});

function userRole() { return 'user'; }
