// v0.7.2 八审 P2 / v0.7.3 九审 P1 修订：优雅关停排空的**行为级** e2e。
// 用例：
//   ① SIGTERM 排空：mock L2 慢分类(1.2s) 的 shadow 请求先返回，立即 SIGTERM，
//      子进程正常退出后 semantic-reviews-*.jsonl 事件仍在（在途复核没丢）。
//   ② 8s 上限（九审 P1 重写）：经 AMR_TEST_STUCK_SEMANTIC_TASK 注入一个 >8s 且不受
//      分类器超时影响的「卡死」后台任务，断言退出耗时落在 [7.5s, 10s]——证明
//      Promise.race 的 8s 上限真实生效（旧版 mock 慢 15s 会被分类器 3.5s 超时
//      提前终止，elapsed<30000 无法区分「上限生效」与「超时早退」）。
//   ③ active 无 SEMANTIC_BUCKET_SECRET 拒启动（八审 P1 校验的行为级验证）。
//   ④ active secret <32 字节拒启动（九审 P2 强度下限的行为级验证）。
// mock MaaS 就绪协议（九审 P1-2 修订）：mock 监听 0（随机端口）→ 打印 "READY <port>"
// 到 stdout → 测试读到才启动 router。根除「spawn 返回但端口未监听」竞态导致的随机 502。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, fork } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
// 十三审 P2：固定端口 8799 在 Windows 上会被「排除端口范围/残留占用」打成 EACCES/ECONNREFUSED，
// 测试自身起不来却报成业务 fetch failed——改为随机端口（hold-then-release 拿号，child 立刻绑定）。
const portPool = (() => {
  const taken = new Set();
  return {
    async take() {
      const net = await import('node:net');
      for (;;) {
        const holder = net.createServer();
        const port = await new Promise((r, e) => { holder.once('error', e); holder.listen(0, '127.0.0.1', () => r(holder.address().port)); });
        await new Promise((r) => holder.close(r));
        if (!taken.has(port)) { taken.add(port); return port; }
      }
    },
  };
})();
let tmpDir;

// 从真实 config/router.json 派生测试配置（只覆盖端口/上游/日志目录/语义路由四处）——
// 手写 minimal config 会接连踩 validateConfig 的必填字段（ownership/quality/routing.mode/maxAttempts...）
function buildTestConfig(overrides) {
  const base = JSON.parse(readFileSync(join(root, 'config/router.json'), 'utf8'));
  const cfg = structuredClone(base);
  cfg.server = { ...cfg.server, port: overrides.port, bind: '127.0.0.1' };
  cfg.upstream = { baseUrl: overrides.upstream, apiKey: 'test-key', timeoutMs: 20000 };
  cfg.decisionLog = { ...cfg.decisionLog, enabled: true, dirPath: overrides.dataDir, maxDays: 30 };
  cfg.semanticRouter = { ...cfg.semanticRouter, ...overrides.semanticRouter };
  cfg.redaction = { enabled: false };
  return cfg;
}

// mock MaaS：随机端口 + READY 握手（九审 P1-2）。按 body 特征识别分类调用。
function mockMaasSource(delayMs) {
  return `import http from 'node:http';
const delay = ${delayMs};
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => raw += c);
  req.on('end', async () => {
    const body = raw ? JSON.parse(raw) : {};
    const msgs = body.messages || [];
    const isClassifierCall = msgs.some(m => String(m.content || '').includes('你是模型路由分类'));
    if (req.url === '/v1/models') {
      res.writeHead(200, {'content-type':'application/json'});
      return res.end(JSON.stringify({ object:'list', data: [ { id: 'qwen36-35b' }, { id: 'deepseekv4-flash' }, { id: 'minimax-m25' } ] }));
    }
    if (isClassifierCall) {
      await new Promise(r => setTimeout(r, delay));
      res.writeHead(200, {'content-type':'application/json'});
      return res.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ task:'coding', tier:'balanced', complexity:0.6, confidence:0.82, reason:'慢分类' }) } }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
      }));
    }
    res.writeHead(200, {'content-type':'application/json'});
    res.end(JSON.stringify({
      choices: [{ message: { content: '好的。' } }],
      usage: { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 }
    }));
  });
});
server.listen(0, '127.0.0.1', () => console.log('READY ' + server.address().port));`;
}

// 启动 mock 并等待 READY <port>（超时 10s 报错——mock 起不来测试不应对 502 迷惑）
async function startMockMaas(delayMs) {
  const mockFile = join(tmpDir, `mock-maas-${delayMs}-${Math.random().toString(36).slice(2, 8)}.mjs`);
  writeFileSync(mockFile, mockMaasSource(delayMs), 'utf8');
  const child = spawn(process.execPath, [mockFile], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('mock MaaS 10s 内未 READY')), 10000);
    let buf = '';
    child.stdout.on('data', (c) => {
      buf += c;
      const m = buf.match(/READY (\d+)/);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`mock MaaS 提前退出 code=${code}`)); });
  });
  return { child, port };
}

// Windows 上 kill('SIGTERM')=TerminateProcess 不走 handler，改经 IPC 钩子触发同一条
// shutdownManager.shutdown 路径（server.mjs 的 AMR_TEST_SHUTDOWN_IPC）；POSIX 仍用真 SIGTERM。
function shutdownRouter(child) {
  if (process.platform === 'win32') child.send({ type: 'amr-shutdown', reason: 'test-ipc' });
  else child.kill('SIGTERM');
}

async function startRouter(env, port, expectFail) {
  const child = fork(join(root, 'src/server.mjs'), [], {
    // ROUTER_KEY_MODE=passthrough（客户端 key 即 mock 上游 key）+ UPSTREAM_BASE_URL 指向 mock
    // （env 优先级最高，压过 config.upstreamBaseUrl 继承自真实 router.json 的生产地址）
    env: { ...process.env, ROUTER_KEY_MODE: 'passthrough', AMR_TEST_SHUTDOWN_IPC: '1', ...env, PORT: String(port), CONFIG_PATH: env.CONFIG_PATH },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  let childLog = '';
  child.stdout.on('data', (c) => { childLog += c; childLog = childLog.slice(-8000); });
  child.stderr.on('data', (c) => { childLog += c; childLog = childLog.slice(-8000); });
  if (!expectFail) {
    // 等 ready：轮询 /health；20s 未 ready 立即失败并附子进程输出尾部——
    // 不再把「起不来的 server」交给业务 fetch 报 ECONNREFUSED（十三审 P2：误导性 fetch failed）
    const t0 = Date.now();
    let ready = false;
    while (Date.now() - t0 < 20000) {
      try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) { ready = true; break; } } catch {}
      await new Promise(r => setTimeout(r, 200));
    }
    if (!ready) {
      child.kill();
      const tail = childLog.split(/\r?\n/).slice(-30).join('\n');
      throw new Error(`router 20s 未 ready（port=${port}）——子进程输出尾部：\n${tail || '(无输出)'}`);
    }
  }
  return child;
}

function lastEventFile(dir) {
  const files = readdirSync(dir).filter(f => f.startsWith('semantic-reviews-') && f.endsWith('.jsonl')).sort();
  return files.length ? join(dir, files.at(-1)) : null;
}

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'amr-sigterm-'));
});

after(async () => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

test('SIGTERM 排空：主请求返回后的在途 shadow 复核不丢，进程干净退出', async () => {
  // 1. mock MaaS：分类调用延迟 1200ms（就绪握手后才开始）
  const { child: mock, port: mockPort } = await startMockMaas(1200);
  try {
    // 2. router 子进程：shadow 模式 + 指向 mock（端口先取号再写 config）
    const port1 = await portPool.take();
    const dataDir = join(tmpDir, 'd1');
    const configFile = join(tmpDir, 'c1.json');
    writeFileSync(configFile, JSON.stringify(buildTestConfig({
      port: port1, upstream: `http://127.0.0.1:${mockPort}`, dataDir,
      semanticRouter: { enabled: true, mode: 'shadow', provider: 'cascade' }
    })));
    const child = await startRouter({ CONFIG_PATH: configFile, UPSTREAM_BASE_URL: `http://127.0.0.1:${mockPort}` }, port1);
    try {
      // 3. 触发 shadow 复核的低置信长文本（L1<0.7 且 ≥12 字）
      const r = await fetch(`http://127.0.0.1:${port1}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer test-key' },
        body: JSON.stringify({ messages: [{ role: 'user', content: '帮我把这段话翻译成英文再总结一下要点' }] })
      });
      assert.equal(r.status, 200, '主请求应先成功返回');
      // 4. 主响应已返回但后台分类(1.2s)仍在途 → 立即 SIGTERM
      shutdownRouter(child);
      const [code] = await once(child, 'exit');
      assert.equal(code, 0, `应优雅退出（exit=${code}）`);
      // 5. 在途复核事件仍在
      const ef = lastEventFile(dataDir);
      assert.ok(ef, 'semantic-reviews 事件文件应存在');
      // 事件 schema（writeRaw）：v/requestId/cascade/base/proposed/assessment…（无 event 字段）
      const lines = readFileSync(ef, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
      const evts = lines.filter(e => e.v === 1 && e.requestId && e.assessment);
      assert.ok(evts.length >= 1, `应至少 1 条复核事件，实际 ${evts.length}`);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  } finally {
    mock.kill();
    if (mock.exitCode === null) await once(mock, 'exit').catch(() => {});
  }
}, { timeout: 60000 });

test('SIGTERM 8s 上限：卡死后台任务按上限放弃，退出耗时落在 [7.5s, 10s]', async () => {
  // mock 只服务主请求（分类调用不会发出——卡死任务由测试钩子注入，不依赖 mock 时序）
  const { child: mock, port: mockPort } = await startMockMaas(50);
  try {
    const port2 = await portPool.take();
    const dataDir = join(tmpDir, 'd2');
    const configFile = join(tmpDir, 'c2.json');
    writeFileSync(configFile, JSON.stringify(buildTestConfig({
      port: port2, upstream: `http://127.0.0.1:${mockPort}`, dataDir,
      semanticRouter: { enabled: true, mode: 'shadow', provider: 'cascade' }
    })));

    // AMR_TEST_STUCK_SEMANTIC_TASK=1：server 启动即注册一个永不 resolve 的语义后台任务
    // （与 shadow 复核同一 trackSemanticTask 注册表）——Promise.race 的 8s 上限是唯一出路。
    const child = await startRouter({ CONFIG_PATH: configFile, UPSTREAM_BASE_URL: `http://127.0.0.1:${mockPort}`, AMR_TEST_STUCK_SEMANTIC_TASK: '1' }, port2);
    try {
      const r = await fetch(`http://127.0.0.1:${port2}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer test-key' },
        body: JSON.stringify({ messages: [{ role: 'user', content: '帮我把这段话翻译成英文再总结一下要点' }] })
      });
      assert.equal(r.status, 200);
      const t0 = Date.now();
      shutdownRouter(child);
      const [code] = await once(child, 'exit');
      const elapsed = Date.now() - t0;
      assert.equal(code, 0, `应正常退出（exit=${code}）`);
      // 九审 P1-3：断言 8s 上限真实生效——[7.5s, 10s] 窗口内退出。
      // 下界：上限存在且没被提前放弃（卡死任务永不 resolve，唯一出路=8s race 超时）；
      // 上界：排空后续写链 flush 是毫秒级，10s 内必须离场（防退化成无上限挂死）。
      assert.ok(elapsed >= 7500 && elapsed <= 10000, `8s 排空上限应生效：退出耗时 ${elapsed}ms 应落在 [7500, 10000]ms`);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  } finally {
    mock.kill();
    if (mock.exitCode === null) await once(mock, 'exit').catch(() => {});
  }
}, { timeout: 90000 });

test('active 无 SEMANTIC_BUCKET_SECRET：启动即拒绝', async () => {
  const port3 = await portPool.take();
  const configFile = join(tmpDir, 'c3.json');
  const dataDir = join(tmpDir, 'd3');
  writeFileSync(configFile, JSON.stringify(buildTestConfig({
    port: port3, upstream: 'http://127.0.0.1:1', dataDir,
    semanticRouter: { enabled: true, mode: 'active', provider: 'cascade', activeTrafficPercent: 5 }
  })));
  const child = spawn(process.execPath, [join(root, 'src/server.mjs')], {
    env: { ...process.env, SEMANTIC_BUCKET_SECRET: '', CONFIG_PATH: configFile, PORT: String(port3) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let err = '';
  child.stderr.on('data', c => err += c);
  const [code] = await once(child, 'exit');
  assert.notEqual(code, 0, 'active 无 secret 应非零退出');
  assert.ok(/SEMANTIC_BUCKET_SECRET/.test(err), `错误信息应点名 SEMANTIC_BUCKET_SECRET，实际：${err.slice(0, 200)}`);
}, { timeout: 30000 });

test('active secret 过短（<32 字节）：启动即拒绝（九审 P2 强度下限）', async () => {
  const port4 = await portPool.take();
  const configFile = join(tmpDir, 'c4.json');
  const dataDir = join(tmpDir, 'd4');
  writeFileSync(configFile, JSON.stringify(buildTestConfig({
    port: port4, upstream: 'http://127.0.0.1:1', dataDir,
    semanticRouter: { enabled: true, mode: 'active', provider: 'cascade', activeTrafficPercent: 5 }
  })));
  const child = spawn(process.execPath, [join(root, 'src/server.mjs')], {
    env: { ...process.env, SEMANTIC_BUCKET_SECRET: 'short-secret', CONFIG_PATH: configFile, PORT: String(port4) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let err = '';
  child.stderr.on('data', c => err += c);
  const [code] = await once(child, 'exit');
  assert.notEqual(code, 0, 'active + 短 secret 应非零退出');
  assert.ok(/长度不足/.test(err), `错误信息应说明长度不足（v0.7.4 口径：长度下限≠熵证明），实际：${err.slice(0, 200)}`);
}, { timeout: 30000 });