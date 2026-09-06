import test from 'node:test';
import assert from 'node:assert/strict';
import { routeRequest } from '../src/router.mjs';
import { scopeAllows, scopeIntersectsConfig, resolveModelScope } from '../src/model-scope.mjs';

// 纯合成配置：与线上数值彻底解耦，断言永不过时
const baseModel = (id, quality) => ({ id, displayName: id, enabled: true, ownership: 'self_hosted', calibrationStatus: 'verified', quality: { default: quality }, costIndex: 0.2, latencyIndex: 0.3 });
const makeConfig = (models) => ({
  version: 'syn',
  routing: { mode: 'active', qualityFloor: 0.7, qualityWeight: 1, costWeight: 0.2, latencyWeight: 0.1, uncertaintyPenalty: 0.08, maxAttempts: 3, taskPreferences: {} },
  semanticRouter: { enabled: false, mode: 'shadow', confidenceThreshold: 0.7 },
  taskRules: { complexMinComplexity: 0.7, simpleMaxComplexity: 0.35 },
  budget: { enabled: false },
  models
});

test('scopeAllows：null scope 全放行，非 null 按集合判定', () => {
  assert.equal(scopeAllows(null, 'anything'), true);
  const scope = new Set(['a', 'b']);
  assert.equal(scopeAllows(scope, 'a'), true);
  assert.equal(scopeAllows(scope, 'c'), false);
});

test('scopeIntersectsConfig：交集非空 true / 全不匹配 false / null scope true', () => {
  const models = [baseModel('a', 0.9), { ...baseModel('b', 0.9), enabled: false }];
  assert.equal(scopeIntersectsConfig(new Set(['a', 'x']), models), true);   // 命中启用的 a
  assert.equal(scopeIntersectsConfig(new Set(['b']), models), false);       // 只命中禁用的 b → 等价交集为空
  assert.equal(scopeIntersectsConfig(new Set(['b', 'a']), models), true);
  assert.equal(scopeIntersectsConfig(null, models), true);
});

test('routeRequest：allowedModelIds 过滤无权模型（not_entitled），次优接管', () => {
  const config = makeConfig([
    baseModel('front-tier', 0.95),
    baseModel('budget-tier', 0.90)
  ]);
  const decision = routeRequest({ model: 'auto', messages: [{ role: 'user', content: '写一个并发安全的 Go 计数器' }] }, config, { allowedModelIds: new Set(['budget-tier']) });
  assert.equal(decision.suggestedModel, 'budget-tier');
  assert.ok(decision.rejected.some((r) => r.model === 'front-tier' && r.reasons.includes('not_entitled')));
  // fallback 也不应包含无权模型
  assert.ok(!decision.fallbackOrder.includes('front-tier'));
});

test('routeRequest：scope 含全部模型时行为与无 scope 一致', () => {
  const config = makeConfig([baseModel('front-tier', 0.95), baseModel('budget-tier', 0.90)]);
  const body = { model: 'auto', messages: [{ role: 'user', content: '写一个并发安全的 Go 计数器' }] };
  const plain = routeRequest(body, config).suggestedModel;
  const scoped = routeRequest(body, config, { allowedModelIds: new Set(['front-tier', 'budget-tier']) }).suggestedModel;
  assert.equal(plain, scoped);
});

test('routeRequest：scope 滤空候选时抛错信号由上层回退（本层直接无候选报错）', () => {
  const config = makeConfig([baseModel('only', 0.9)]);
  assert.throws(() => routeRequest({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }, config, { allowedModelIds: new Set(['other']) }), /候选模型/);
});

test('resolveModelScope：strict 模式（非 passthrough）恒返回 null', async () => {
  const r = await resolveModelScope({ baseUrl: 'http://127.0.0.1:1', apiKey: 'k', authorizationHeader: 'Bearer k', passthrough: false });
  assert.equal(r, null);
});

test('resolveModelScope：无 authorizationHeader 返回 null；上游不可达 fail-open 返回 null', async () => {
  assert.equal(await resolveModelScope({ baseUrl: 'http://127.0.0.1:1', apiKey: 'k', authorizationHeader: null, passthrough: true }), null);
  // 127.0.0.1:1 无监听 → fetch 立即失败 → fail-open null
  assert.equal(await resolveModelScope({ baseUrl: 'http://127.0.0.1:1', apiKey: 'k', authorizationHeader: 'Bearer k', passthrough: true }), null);
});

test('resolveModelScope：上游 200 时解析出 id 集合并按 key 缓存', async () => {
  // 用 node 内置起一个最小 HTTP 服务
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    if (req.url === '/models' && req.headers.authorization === 'Bearer plan-b') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'm-a' }, { id: 'm-b' }] }));
    } else { res.writeHead(403); res.end('{}'); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const scope = await resolveModelScope({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'plan-b', authorizationHeader: 'Bearer plan-b', passthrough: true });
    assert.ok(scope instanceof Set);
    assert.deepEqual([...scope].sort(), ['m-a', 'm-b']);
  } finally { server.close(); }
});

test('scope cache separates old 32-bit collisions and the same credential on different upstreams', async () => {
  const http = await import('node:http');
  const servers = [];
  try {
    const baseUrls = [];
    for (const prefix of ['first', 'second']) {
      const server = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: `${prefix}:${req.headers.authorization}` }] }));
      });
      servers.push(server);
      await new Promise(r => server.listen(0, '127.0.0.1', r));
      baseUrls.push(`http://127.0.0.1:${server.address().port}`);
    }
    // Aa and BB have identical length and identical old h*31+char hash.
    for (const [baseUrl, credential, expected] of [[baseUrls[0], 'Aa', 'first:Bearer Aa'], [baseUrls[0], 'BB', 'first:Bearer BB'], [baseUrls[1], 'Aa', 'second:Bearer Aa']]) {
      const scope = await resolveModelScope({ baseUrl, apiKey: credential, authorizationHeader: `Bearer ${credential}`, passthrough: true });
      assert.deepEqual([...scope], [expected]);
    }
  } finally { await Promise.all(servers.map(server => new Promise(r => server.close(r)))); }
});
