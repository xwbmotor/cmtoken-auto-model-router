import test from 'node:test';
import assert from 'node:assert/strict';
// v0.10.4：健康状态机行为测试（抽出的纯函数）+ full summary 结构测试
import { newHealthState, updateHealthState, offlineAlertDue } from '../src/health.mjs';

test('downSince 只在熔断首次打开时设置——单次失败不设置', () => {
  const s = newHealthState();
  updateHealthState(s, false, 100);
  assert.strictEqual(s.downSince, 0, '单次失败不设 downSince');
  assert.strictEqual(s.circuitState, 'closed', '未到熔断阈值仍 closed');
});

test('连续 3 次失败开熔断并设 downSince；恢复成功清零', () => {
  const s = newHealthState();
  updateHealthState(s, false, 100); updateHealthState(s, false, 100); updateHealthState(s, false, 100);
  assert.strictEqual(s.circuitState, 'open');
  assert.ok(s.downSince > 0, '熔断打开时设置 downSince');
  assert.ok(s.circuitOpenUntil > Date.now(), '冷却窗口生效');
  // 恢复
  updateHealthState(s, true, 200);
  assert.strictEqual(s.circuitState, 'closed');
  assert.strictEqual(s.downSince, 0, '成功清零 downSince');
  assert.strictEqual(s.halfOpenFailStreak, 0);
});

test('下线告警：单失败+无流量 30 分钟后不告警（无流量≠宕机）', () => {
  const s = newHealthState();
  updateHealthState(s, false, 100); // 单次失败
  const later = Date.now() + 40 * 60000;
  // 模拟时间流逝但 lastFailureAt 已远（>10min 无失败证据）
  s.lastFailureAt = Date.now() - 15 * 60000;
  assert.strictEqual(offlineAlertDue(s, later), false, '无近期失败证据不告警');
});

test('下线告警：熔断持续 30 分钟（有近期失败）触发', () => {
  const s = newHealthState();
  updateHealthState(s, false, 100); updateHealthState(s, false, 100); updateHealthState(s, false, 100);
  s.downSince = Date.now() - 35 * 60000; // 已持续 35 分钟
  s.lastFailureAt = Date.now() - 2000;   // 2 秒前仍有失败（探针持续失败）
  assert.strictEqual(offlineAlertDue(s), true);
});

test('下线告警：半开探针连败 3 次且≥10min 触发', () => {
  const s = newHealthState();
  updateHealthState(s, false, 100); updateHealthState(s, false, 100); updateHealthState(s, false, 100);
  s.circuitState = 'half_open'; s.halfOpenFailStreak = 3;
  s.downSince = Date.now() - 12 * 60000;
  s.lastFailureAt = Date.now() - 1000;
  assert.strictEqual(offlineAlertDue(s), true);
});

test('下线告警：closed 态（已恢复）不告警', () => {
  const s = newHealthState();
  updateHealthState(s, true, 100);
  assert.strictEqual(offlineAlertDue(s), false);
});
