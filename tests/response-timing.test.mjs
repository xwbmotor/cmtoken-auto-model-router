import test from 'node:test';
import assert from 'node:assert/strict';
import { createStreamTimingObserver, observeLatency } from '../src/response-timing.mjs';
import { renderPrometheusMetrics } from '../src/metrics.mjs';

test('TTFT ignores headers/role/heartbeat/reasoning and handles split UTF-8 events', () => {
  let clock = 1000;
  const timer = createStreamTimingObserver(1000, () => clock);
  const push = data => timer.push(Buffer.from(data));
  clock = 1010; push(': ping\n\ndata: {"choices":[{"delta":{"role":"assistant"}}]}\n\n');
  assert.deepEqual(timer.snapshot(), { firstContentMs: null, firstOutputMs: null });
  clock = 1100; push('data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n');
  assert.deepEqual(timer.snapshot(), { firstContentMs: null, firstOutputMs: 100 });
  const event = Buffer.from('data: {"choices":[{"delta":{"content":"你好"}}]}\n\n');
  const cut = event.indexOf(Buffer.from('你')) + 1;
  clock = 1250; timer.push(event.subarray(0, cut));
  assert.equal(timer.snapshot().firstContentMs, null);
  clock = 1300; timer.push(event.subarray(cut));
  assert.deepEqual(timer.snapshot(), { firstContentMs: 300, firstOutputMs: 100 });
  clock = 1800; push('data: [DONE]\n\n');
  assert.equal(timer.snapshot().firstContentMs, 300);
});
test('tool-only streams and usage-only streams never fabricate content TTFT', () => {
  const t = createStreamTimingObserver(0, () => 80);
  t.push(Buffer.from('data: {"choices":[{"delta":{"tool_calls":[{"id":"call_1"}]}}]}\n\n'));
  t.push(Buffer.from('data: {"usage":{"prompt_tokens":4}}\n\ndata: [DONE]\n\n'));
  t.finish();
  assert.deepEqual(t.snapshot(), { firstContentMs: null, firstOutputMs: 80 });
});
test('multiline data events are assembled before timing and EOF flushes a final event', () => {
  let clock = 30;
  const t = createStreamTimingObserver(0, () => clock);
  t.push(Buffer.from('event: completion\r\ndata: {"choices":\r\ndata: [{"delta":{"content":"ok"}}]}\r\n'));
  assert.equal(t.snapshot().firstContentMs, null);
  clock = 50; t.push(Buffer.from('\r\n'));
  assert.equal(t.snapshot().firstContentMs, 50);
  const eof = createStreamTimingObserver(0, () => 70);
  eof.push(Buffer.from('data: {"choices":[{"delta":{"content":"ok"}}]}'));
  eof.finish(); assert.equal(eof.snapshot().firstContentMs, 70);
});
test('timing histograms have cumulative buckets and never reuse legacy header TTFT', () => {
  const responseTimingsV2 = {};
  observeLatency(responseTimingsV2, 'ttft', 80);
  observeLatency(responseTimingsV2, 'ttft', 300);
  observeLatency(responseTimingsV2, 'ttft', null);
  const body = renderPrometheusMetrics({ counters: { ttft: { count: 999, sumMs: 99999 }, responseTimingsV2 } });
  assert.match(body, /router_ttft_ms_bucket\{le="50"\} 0/);
  assert.match(body, /router_ttft_ms_bucket\{le="100"\} 1/);
  assert.match(body, /router_ttft_ms_bucket\{le="500"\} 2/);
  assert.match(body, /router_ttft_ms_count 2/);
  assert.match(body, /router_ttft_ms_sum 380/);
});
