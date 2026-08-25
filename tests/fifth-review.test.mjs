// v0.6.1 五审修复回归：
// ①流式决策日志幂等（每 requestId 恰一条）——e2e：mock 上游 + 真实 server + 读落盘 JSONL
// ②strict 模式大模型分类器不得透传客户端 Router Key（只 passthrough 可透传）
// ③置信度否定局部化 + trivial 只数 user turn + classifierText 口径
// ④confidenceFactors 落盘
// ⑤L3 分类器 usage/成本提取
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { analyzeRequest, classifierText } from '../src/router.mjs';

const config = JSON.parse(await readFile(new URL('../config/router.json', import.meta.url), 'utf8'));
const A = (t, extra = {}) => analyzeRequest({ messages: [...(extra.sys ? [{ role: 'system', content: extra.sys }] : []), { role: 'user', content: t }] }, config);

// ---------- ③ 置信度否定局部化 / trivial user-turns / classifierText ----------

test('否定局部化：肯定命中在否定作用域外 → 不扣分（明确的 coding 请求不复误伤）', () => {
  const cases = [
    '禁止使用递归，请写一个循环版本的斐波那契函数',
    '不要解释，直接写一个Python函数',
    '解释报错并写修复代码',
  ];
  for (const text of cases) {
    const a = A(text);
    assert.equal(a.confidence, 0.86, `「${text}」confidence=${a.confidence} 应保持强命中 0.86（存在肯定命中）`);
    assert.ok(!a.confidenceFactors.includes('negation'), `「${text}」不应带 negation 因素`);
  }
});

test('否定局部化：任务词全部被否定包裹 → 扣分进复核（四审反例保持）', () => {
  const a = A('不要写代码，只用通俗语言解释什么是递归');
  assert.ok(a.confidence < config.semanticRouter.confidenceThreshold, '「不要写代码解释递归」应落复核线以下');
  assert.ok(a.confidenceFactors.includes('negation'), '应携带 negation 因素');
});

test('trivial：system+user 两消息的「今天星期几」仍判 0.98（user turn 计数）', () => {
  const a = A('今天星期几', { sys: '你是编程助手' });
  assert.equal(a.confidence, 0.98, 'system 提示不应破坏 trivial 判定');
});

test('classifierText：排除 system/assistant，user 为主 + 有限上下文', () => {
  const body = { messages: [
    { role: 'system', content: '你是编程助手' },
    { role: 'user', content: '问题一' },
    { role: 'assistant', content: 'def foo(): pass' },
    { role: 'user', content: '问题二' }
  ] };
  const text = classifierText(body);
  assert.ok(!text.includes('编程助手'), 'system 不应进入分类文本');
  assert.ok(!text.includes('def foo'), 'assistant 历史不应进入分类文本');
  assert.ok(text.includes('问题一') && text.includes('问题二'), 'user 消息应保留');
});

// ---------- ① 流式决策日志幂等 e2e ----------

function holdPort() {
  const holder = net.createServer(); holder.unref();
  return new Promise((r, e) => { holder.once('error', e); holder.listen(0, '127.0.0.1', () => r({ port: holder.address().port, release: () => new Promise((rr) => holder.close(rr)) })); });
}

async function waitForHealth(port, maxMs = 8000) {
  for (let i = 0; i < maxMs / 200; i += 1) {
    await sleep(200);
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) return true; } catch { /* retry */ }
  }
  return false;
}

test('e2e 流式请求决策日志恰一条（requestId 唯一性）', async () => {
  // mock 上游：正常 SSE 流（两 chunk + usage 尾块）
  const upstream = http.createServer((req, res) => {
    if (req.url.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [] })); }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"id":"x","choices":[{"delta":{"content":"你"}}]}\n\n');
      res.write('data: {"id":"x","choices":[{"delta":{"content":"好"}}]}\n\n');
      res.end('data: {"id":"x","choices":[{"delta":{}}],"usage":{"prompt_tokens":100,"completion_tokens":50}}\n\n');
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamPort = upstream.address().port;

  const logDir = await mkdtemp(join(tmpdir(), 'amr-logidem-'));
  const held = await holdPort();
  const port = held.port;
  const child = spawn(process.execPath, ['src/server.mjs'], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ROUTER_KEY_MODE: 'passthrough', UPSTREAM_BASE_URL: `http://127.0.0.1:${upstreamPort}`, ADMIN_TOKEN: 'adm', METRICS_TOKEN: 'met', CONFIG_PATH: (() => {
      // 隔离配置：decisionLog.dirPath 指向临时目录（防污染仓库 data/）
      const cfg = structuredClone(config);
      cfg.decisionLog = { ...cfg.decisionLog, dirPath: logDir.replace(/\\/g, '/') };
      const cfgFile = join(logDir, 'router.json');
      return cfgFile;
    })() },
    cwd: process.cwd(), stdio: 'ignore', detached: false
  });
  // 写隔离配置文件（上面 IIFE 只算路径，实际内容在此落盘）
  const { writeFile } = await import('node:fs/promises');
  const cfg = structuredClone(config);
  cfg.decisionLog = { ...cfg.decisionLog, dirPath: logDir.replace(/\\/g, '/') };
  await writeFile(join(logDir, 'router.json'), JSON.stringify(cfg), 'utf8');
  await held.release();
  try {
    assert.ok(await waitForHealth(port), 'server 启动超时');
    // 连发 3 个流式请求（不同 session 防粘性干扰）
    for (let i = 0; i < 3; i += 1) {
      const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer k', 'x-session-id': `idem-${i}` },
        body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: '写一句五个字的诗' }] })
      });
      assert.ok(r.ok, `流式请求 ${i} 应 200`);
      await r.text(); // 读完整流（触发 close + end 双路径）
    }
    await sleep(600); // decisionLog 异步写盘
    const files = await readdir(logDir);
    const jsonl = files.filter((f) => f.endsWith('.jsonl'));
    assert.ok(jsonl.length > 0, '应有决策日志文件');
    const lines = (await readFile(join(logDir, jsonl[0]), 'utf8')).trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 3, `3 个请求应恰好 3 条日志，实际 ${lines.length}`);
    const ids = lines.map((l) => JSON.parse(l).request?.requestId);
    assert.equal(new Set(ids).size, 3, `requestId 必须唯一，实际 ${JSON.stringify(ids)}`);
    // 每条都应是成功 outcome
    for (const l of lines) assert.equal(JSON.parse(l).outcome?.ok, true, '正常完成的流应为 ok:true');
  } finally {
    child.kill();
    upstream.close();
  }
});

// ---------- ⑤ L3 usage 提取 ----------

test('openai-chat 评估器提取 usage（overheadUsage）并随 assessment 返回', async () => {
  const { classifySemantically } = await import('../src/semantic-router.mjs');
  const fakeFetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({ task: 'reasoning', tier: 'complex', complexity: 0.7, confidence: 0.9, reason: '推理' }) } }], usage: { prompt_tokens: 1200, completion_tokens: 60 } })
  });
  const cfg = structuredClone(config);
  cfg.semanticRouter = { ...cfg.semanticRouter, provider: 'openai-chat', openaiChat: { model: 'deepseekv4-flash', timeoutMs: 3000 } };
  const result = await classifySemantically({ messages: [{ role: 'user', content: '多步推理权衡方案' }] }, cfg, { fetchImpl: fakeFetch, apiKey: 'x' });
  assert.deepEqual(result.overheadUsage, { prompt: 1200, completion: 60 }, 'L3 分类调用的真实 usage 应随 assessment 返回');
});

// ---------- ② strict key（单元级：semanticOptions 逻辑由 server 封装，此处验证 provider 端拿到的 key） ----------
// server.mjs 的 semanticOptions 未导出——e2e 已由 passthrough.test/server-real 覆盖透传路径；
// strict 路径的正确性由「仅 passthrough 分支才剥 Bearer」的代码路径保证 + 本测试锁定契约：
// strict 模式下 classifyAndCompare 收到的 clientAuthHeader 不进入 apiKey 计算。
// v0.7.0 六审 P2：原「源码字符串断言」已删除——strict/passthrough 的 key 选择由
// tests/semantic-key-selection.test.mjs 以 mock MaaS 行为级验证（变量改名不再误失败，
// 逻辑绕过也无法误通过）。
