import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import net from 'node:net';
import { gzipSync, deflateSync, brotliCompressSync, gzip } from 'node:zlib';
import { promisify } from 'node:util';
const gzipAsync = promisify(gzip);

// v0.8.1 回归：客户端压缩请求体兼容（WorkBuddy 实例——Content-Encoding: gzip 请求被
// 「请求体不是合法 JSON」400 拒收；Node 原生 http server 不自动解压请求体）
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function waitForHealth(port, maxMs = 5000) {
  for (let i = 0; i < maxMs / 200; i += 1) {
    await sleep(200);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return true;
    } catch { /* not yet */ }
  }
  return false;
}

function spawnServer(port, extraEnv = {}) {
  return spawn(process.execPath, ['src/server.mjs'], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ROUTER_ACCESS_KEY: 'test-key', ADMIN_TOKEN: 'adm', METRICS_TOKEN: 'met', ...extraEnv },
    cwd: process.cwd(),
    stdio: 'ignore',
    detached: false
  });
}

const headers = (extra = {}) => ({ 'content-type': 'application/json', authorization: 'Bearer test-key', ...extra });

async function post(port, body, extraHeaders = {}) {
  return fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: headers(extraHeaders), body });
}

// 无上游 key 环境：合法请求会走到「上游调用失败」——证明通过了 JSON 解析与路由，区别于解析层 400
test('压缩请求体：gzip/deflate/br 与复合编码均通过解析层（进入路由，非 400 invalid JSON）', async () => {
  const port = await freePort();
  const child = spawnServer(port);
  let exited = false;
  child.once('exit', () => { exited = true; });
  try {
    assert.ok(await waitForHealth(port), 'server 启动超时');

    const payload = JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] });

    // 1) plain 基线：进入路由（环境性 502/500，而非解析层 400 invalid JSON）
    const plain = await post(port, payload);
    assert.notEqual(plain.status, 400);
    await plain.json(); // 可解析即通过解析层
    const routeLayerMarker = (res) => {
      assert.notEqual(res.status, 400, '不得在解析层被 400 拒收');
      assert.doesNotMatch(JSON.stringify(res.headers.get('x-request-id')), /null/);
    };

    // 2) gzip
    const gz = await post(port, gzipSync(payload), { 'content-encoding': 'gzip' });
    assert.equal(gz.status, plain.status); // 与 plain 完全同构：同状态码
    await gz.json();

    // 3) deflate（zlib 包装方言——Node createInflate 吃 zlib 包装）
    const df = await post(port, deflateSync(payload), { 'content-encoding': 'deflate' });
    assert.equal(df.status, plain.status);
    await df.json();

    // 4) br
    const br = await post(port, brotliCompressSync(payload), { 'content-encoding': 'br' });
    assert.equal(br.status, plain.status);
    await br.json();

    // 5) 复合编码：先 br 后 gzip（声明逆序解压）
    const doubleEncoded = gzipSync(brotliCompressSync(payload));
    const multi = await post(port, doubleEncoded, { 'content-encoding': 'br, gzip' });
    assert.equal(multi.status, plain.status);
    await multi.json();

    // 6) 声明 x-gzip 别名
    const xgz = await post(port, gzipSync(payload), { 'content-encoding': 'x-gzip' });
    assert.equal(xgz.status, plain.status);
    await xgz.json();
    routeLayerMarker(xgz);

    // 7) 损坏 gzip：明确报解压失败（400），而不是「不是合法 JSON」
    const broken = Buffer.concat([gzipSync(payload).subarray(0, 10), Buffer.from('garbage')]);
    const bad = await post(port, broken, { 'content-encoding': 'gzip' });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error.message, /解压失败/);

    // 8) 未知编码 zstd：415 + 指引信息
    const unsupported = await post(port, Buffer.from(payload), { 'content-encoding': 'zstd' });
    assert.equal(unsupported.status, 415);
    const unsupportedBody = await unsupported.json();
    assert.match(unsupportedBody.error.message, /不支持的 Content-Encoding/);
    assert.equal(unsupportedBody.error.type, 'unsupported_content_encoding');

    // 9) 非法 JSON 明文体：type 必须是 invalid_request_error——v0.8.1 的三元标签 bug 回归
    //    （RequestBodyError.status 默认 400 恒真，曾把所有解析层错误错标成 unsupported_content_encoding）
    const garbage = await post(port, 'this is not json at all');
    assert.equal(garbage.status, 400);
    const garbageBody = await garbage.json();
    assert.match(garbageBody.error.message, /不是合法 JSON/);
    assert.equal(garbageBody.error.type, 'invalid_request_error');
  } finally {
    child.kill('SIGKILL');
    await sleep(500);
    assert.ok(exited, 'subprocess should be terminated');
  }
});

test('压缩请求体：解压炸弹防护——解压后超 50MB 上限按 400 拒收，进程不挂', async () => {
  const port = await freePort();
  const child = spawnServer(port);
  let exited = false;
  child.once('exit', () => { exited = true; });
  try {
    assert.ok(await waitForHealth(port), 'server 启动超时');
    // 50MB 全零 gzip 后仅约 50KB——解压后远超 /v1/chat/completions 的 50MB 上限
    const bomb = await gzipAsync(Buffer.alloc(60 * 1024 * 1024));
    const res = await post(port, bomb, { 'content-encoding': 'gzip' });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error.message, /解压后请求体超过/);
    // 进程存活：随后一个普通请求仍能正常处理
    const follow = await post(port, JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }));
    assert.equal(follow.status, 502);
  } finally {
    child.kill('SIGKILL');
    await sleep(500);
    assert.ok(exited, 'subprocess should be terminated');
  }
});
