// v0.7.2 八审 P2：优雅关停排空的**行为级** e2e（对真实子进程发 SIGTERM）。
// 八审：关停顺序代码正确但缺行为级测试——「代码看起来对、容器滚动重启时才暴露」。
// 本文件两个用例：
//   ① SIGTERM 排空：mock L2 慢分类(1.2s) 的 shadow 请求先返回，立即 SIGTERM，
//      子进程正常退出后 semantic-reviews-*.jsonl 事件仍在（在途复核没丢）。
//   ② 8s 超时放弃：mock L2 慢 15s（>排空上限 8s），SIGTERM 后进程按上限放弃退出，
//      退出码正常（不挂死）——放弃是设计内，事件可丢。
// 附带：③ active 无 SEMANTIC_BUCKET_SECRET 拒启动（八审 P1 校验的行为级验证）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, fork } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync, cpSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const PORT = 8799;
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

// 与 tests/semantic-key-selection.test.mjs 同款 mock MaaS：按 body 特征识别分类调用
function mockMaaSDelay(delayMs, port = PORT + 100) {
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
server.listen(${port}, '127.0.0.1');`;
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
    env: { ...process.env, ROUTER_KEY_MODE: 'passthrough', UPSTREAM_BASE_URL: `http://127.0.0.1:${port + 100}`, AMR_TEST_SHUTDOWN_IPC: '1', ...env, PORT: String(port), CONFIG_PATH: env.CONFIG_PATH },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  if (!expectFail) {
    // 等 ready：轮询 /health
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) break; } catch {}
      await new Promise(r => setTimeout(r, 200));
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
  // 1. mock MaaS：分类调用延迟 1200ms
  const mockFile = join(tmpDir, 'mock-maas.mjs');
  writeFileSync(mockFile, mockMaaSDelay(1200), 'utf8');
  const mock = spawn(process.execPath, [mockFile], { stdio: 'ignore' });
  try {
    // 2. router 子进程：shadow 模式 + 指向 mock
    const dataDir = join(tmpDir, 'd1');
    const configFile = join(tmpDir, 'c1.json');
    writeFileSync(configFile, JSON.stringify(buildTestConfig({
      port: PORT, upstream: `http://127.0.0.1:${PORT + 100}`, dataDir,
      semanticRouter: { enabled: true, mode: 'shadow', provider: 'cascade' }
    })));

    const child = await startRouter({ CONFIG_PATH: configFile }, PORT);
    try {
      // 3. 触发 shadow 复核的低置信长文本（L1<0.7 且 ≥12 字）
      const r = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer test-key' },
        body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: '帮我把这段话翻译成英文再总结一下要点' }] })
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
  }
}, { timeout: 60000 });

test('SIGTERM 8s 上限：超时后台任务按设计放弃，进程不挂死', async () => {
  const mockFile = join(tmpDir, 'mock-maas-slow.mjs');
  writeFileSync(mockFile, mockMaaSDelay(15000, PORT + 102), 'utf8');
  const mock = spawn(process.execPath, [mockFile], { stdio: 'ignore' });
  try {
    const dataDir = join(tmpDir, 'd2');
    const configFile = join(tmpDir, 'c2.json');
    writeFileSync(configFile, JSON.stringify(buildTestConfig({
      port: PORT + 2, upstream: `http://127.0.0.1:${PORT + 102}`, dataDir,
      semanticRouter: { enabled: true, mode: 'shadow', provider: 'cascade' }
    })));

    const child = await startRouter({ CONFIG_PATH: configFile }, PORT + 2);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT + 2}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer test-key' },
        body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: '帮我把这段话翻译成英文再总结一下要点' }] })
      });
      assert.equal(r.status, 200);
      const t0 = Date.now();
      shutdownRouter(child);
      const [code] = await once(child, 'exit');
      const elapsed = Date.now() - t0;
      assert.equal(code, 0, `应正常退出（exit=${code}）`);
      assert.ok(elapsed < 30000, `8s 上限放弃后应尽快退出，实际 ${elapsed}ms`);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  } finally {
    mock.kill();
  }
}, { timeout: 90000 });

test('active 无 SEMANTIC_BUCKET_SECRET：启动即拒绝', async () => {
  const configFile = join(tmpDir, 'c3.json');
  const dataDir = join(tmpDir, 'd3');
  writeFileSync(configFile, JSON.stringify(buildTestConfig({
    port: PORT + 4, upstream: 'http://127.0.0.1:1', dataDir,
    semanticRouter: { enabled: true, mode: 'active', provider: 'cascade', activeTrafficPercent: 5 }
  })));
  const child = spawn(process.execPath, [join(root, 'src/server.mjs')], {
    env: { ...process.env, SEMANTIC_BUCKET_SECRET: '', CONFIG_PATH: configFile, PORT: String(PORT + 4) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let err = '';
  child.stderr.on('data', c => err += c);
  const [code] = await once(child, 'exit');
  assert.notEqual(code, 0, 'active 无 secret 应非零退出');
  assert.ok(/SEMANTIC_BUCKET_SECRET/.test(err), `错误信息应点名 SEMANTIC_BUCKET_SECRET，实际：${err.slice(0, 200)}`);
}, { timeout: 30000 });
