// 十四审 P1/P2：auto 模型对外名可配（cmtoken-auto）+ /v1/models 只暴露 auto + circuit gauge 恒输出
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { routeRequest, isAutoRequest } from '../src/router.mjs';
import { validateConfig } from '../src/config.mjs';
import { renderPrometheusMetrics } from '../src/metrics.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baseConfig = JSON.parse(readFileSync(resolve(projectRoot, 'config/router.json'), 'utf8'));

function cfgWith(routing, extra) {
  const c = JSON.parse(JSON.stringify(baseConfig));
  c.routing = { ...c.routing, ...routing };
  return { ...c, ...extra };
}

test('isAutoRequest：默认 autoModelId=auto，空 model 也算 auto', () => {
  const c = cfgWith({});
  delete c.routing.autoModelId; // 线上配置已带 cmtoken-auto；本例验证「未配置」时的缺省行为
  assert.equal(isAutoRequest({ model: 'auto' }, c), true);
  assert.equal(isAutoRequest({}, c), true);
  assert.equal(isAutoRequest({ model: '' }, c), true);
  assert.equal(isAutoRequest({ model: 'deepseekv4-flash' }, c), false);
});

test('isAutoRequest：autoModelId=cmtoken-auto 时只认新名', () => {
  const c = cfgWith({ autoModelId: 'cmtoken-auto' });
  assert.equal(isAutoRequest({ model: 'cmtoken-auto' }, c), true);
  assert.equal(isAutoRequest({}, c), true, '未指定 model 仍走 auto 路由');
  assert.equal(isAutoRequest({ model: 'auto' }, c), false, '硬切：旧名 auto 不再是路由入口——按不存在模型 400');
});

test('routeRequest：requestedModel 落真实请求名（cmtoken-auto），不再写死 auto', () => {
  const c = cfgWith({ autoModelId: 'cmtoken-auto' });
  const d = routeRequest({ model: 'cmtoken-auto', messages: [{ role: 'user', content: '写一个并发安全的 Go 计数器' }] }, c, { health: {} });
  assert.equal(d.requestedModel, 'cmtoken-auto');
});

test('config 校验：autoModelId 非空字符串、不得与池内模型 ID 冲突', () => {
  assert.throws(() => validateConfig(cfgWith({ autoModelId: '' })), /autoModelId/);
  assert.throws(() => validateConfig(cfgWith({ autoModelId: 123 })), /autoModelId/);
  const dup = cfgWith({ autoModelId: baseConfig.models[0].id });
  assert.throws(() => validateConfig(dup), /autoModelId/);
  validateConfig(cfgWith({ autoModelId: 'cmtoken-auto' })); // 合法不抛
});

test('config 校验：exposeModelList 只允许 auto-only|all', () => {
  assert.throws(() => validateConfig(cfgWith({ exposeModelList: 'everything' })), /exposeModelList/);
  validateConfig(cfgWith({ exposeModelList: 'auto-only' }));
  validateConfig(cfgWith({ exposeModelList: 'all' }));
});

test('metrics：circuit gauge closed(0) 时也必须输出 router_judge_circuit_state', () => {
  // 十四审 P2：if (judge.gaugeCircuit) 在 closed 时整条消失——Prometheus 告警规则用 absent() 兜底也救不了
  // 状态回退检测（open→closed 消失≠正常）。gauge 必须恒输出 0/1/2。
  const body = renderPrometheusMetrics({ counters: { judge: { sampled: 0, qualityDone: 0, taskCheckDone: 0, errors: 0, persistErrors: 0, gaugeCircuit: 0, guardCalls: 0, guardTokens: 0 } } });
  assert.ok(body.includes('router_judge_circuit_state 0'), 'closed 必须输出 0：\n' + body.slice(0, 500));
  const body2 = renderPrometheusMetrics({ counters: { judge: { gaugeCircuit: 2 } } });
  assert.ok(body2.includes('router_judge_circuit_state 2'));
});
