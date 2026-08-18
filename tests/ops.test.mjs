import test from 'node:test';
import assert from 'node:assert/strict';
import { logger } from '../src/logger.mjs';
import { renderPrometheusMetrics } from '../src/metrics.mjs';
import { createShutdownManager } from '../src/shutdown.mjs';
import http from 'node:http';

// ---------- logger ----------
test('logger: JSON 单行输出 + 级别过滤', async () => {
  const original = process.stdout.write.bind(process.stdout);
  let captured = '';
  const capture = (chunk) => { if (typeof chunk === 'string') captured += chunk; return true; };
  process.stdout.write = capture;
  try {
    process.env.LOG_LEVEL = 'info';
    logger.info('test_event', { msg: 'hello', n: 1 });
    logger.debug('debug_hidden', { msg: 'should not appear' });
  } finally { process.stdout.write = original; }
  const lines = captured.trim().split('\n').filter((l) => l.includes('test_event') || l.includes('debug_hidden'));
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.event, 'test_event');
  assert.equal(entry.msg, 'hello');
  assert.ok(entry.time);
  assert.equal(lines.length, 1, 'debug 应被过滤');
});

test('logger: child 绑定公共字段', async () => {
  const original = process.stdout.write.bind(process.stdout);
  let captured = '';
  process.stdout.write = (chunk) => { if (typeof chunk === 'string') captured += chunk; return true; };
  try {
    logger.child({ requestId: 'r-123' }).warn('child_event', { code: 'X1' });
  } finally { process.stdout.write = original; }
  const entry = JSON.parse(captured.trim());
  assert.equal(entry.requestId, 'r-123');
  assert.equal(entry.code, 'X1');
});

// ---------- metrics ----------
test('metrics: 输出合法 Prometheus 文本格式', () => {
  const body = renderPrometheusMetrics({
    counters: {
      fallback: 2,
      outcome: { auto: { success: 10, error: 1 }, explicit: { success: 5, error: 0 } },
      selected: { 'qwen36-35b': 9, 'hy3-preview': 7 },
      task: { reasoning: 6, coding: 4 },
      semantic: { eligible: 3, attempted: 2, succeeded: 1, disagreed: 1, errors: 0, applied: 0 },
    },
    health: { 'qwen36-35b': { circuitState: 'closed', ewmaLatencyMs: 1200.4 } },
    budget: { estimatedSpendYuan: 1.23, pressure: 0.05 },
    decisionLog: { written: 16, errors: 0 },
    config: { version: '0.4.1' },
    sessions: 2,
    draining: false,
    inflight: 1,
  });
  assert.ok(body.includes('# HELP router_requests_total'));
  assert.ok(body.includes('router_requests_total{mode="auto",outcome="success"} 10'));
  assert.ok(body.includes('router_selected_total{model="qwen36-35b"} 9'));
  assert.ok(body.includes('router_circuit_state{model="qwen36-35b"} 0'));
  assert.ok(body.includes('router_draining 0'));
  assert.ok(body.includes('router_config_version{version="0.4.1"} 1'));
  assert.ok(!body.includes('undefined') && !body.includes('NaN'));
});

test('metrics: 空状态不输出 undefined/NaN', () => {
  const body = renderPrometheusMetrics({});
  assert.ok(!body.includes('undefined'));
  assert.ok(!body.includes('NaN'));
  assert.ok(body.includes('router_uptime_seconds'));
});

// ---------- shutdown drain ----------
test('shutdown: 排空等待 in-flight 完成后 flush 并退出', async () => {
  let flushCalled = false;
  const exitCode = new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      // 模拟长请求：800ms 后才响应
      setTimeout(() => { res.writeHead(200); res.end('done'); }, 800);
    });
    const manager = createShutdownManager({ server, timeoutMs: 5000, flush: async () => { flushCalled = true; }, exit: (code) => { server.close(); resolve(code); } });
    server.listen(0, '127.0.0.1', async () => {
      const port = server.address().port;
      // 发起 in-flight 请求
      const response = fetch(`http://127.0.0.1:${port}/x`).then((r) => r.text());
      await new Promise((r) => setTimeout(r, 100)); // 让请求进入 in-flight
      assert.equal(manager.inflightCount(), 1, '应跟踪到 1 个 in-flight 请求');
      manager.shutdown('SIGTERM');
      const text = await response;
      assert.equal(text, 'done', 'in-flight 请求应完整收到响应，不被截断');
    });
  });
  const code = await exitCode;
  assert.equal(code, 0);
  assert.ok(flushCalled, 'flush 应在排空后被调用');
});

test('shutdown: 超时强断残余连接', async () => {
  const exitCode = new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      // 永不响应
    });
    const manager = createShutdownManager({ server, timeoutMs: 300, flush: async () => {}, exit: (code) => { server.close(); resolve(code); } });
    server.listen(0, '127.0.0.1', async () => {
      const port = server.address().all || server.address();
      const p = typeof port === 'object' ? port.port : port;
      fetch(`http://127.0.0.1:${p}/x`).catch(() => {});
      await new Promise((r) => setTimeout(r, 100));
      manager.shutdown('SIGTERM');
    });
  });
  const code = await exitCode;
  assert.equal(code, 0, '超时强断路径也应正常退出 0');
});
