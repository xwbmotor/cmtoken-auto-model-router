// 优雅关停：SIGTERM/SIGINT → 停止接受新请求 → 等待 in-flight 完成（超时强断）→ flush 落盘 → 退出。
// 依赖 Node 18.2+ 的 server.closeIdleConnections / closeAllConnections（本项目 engines >=20，满足）。
import { logger } from './logger.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createShutdownManager({ server, timeoutMs = 20000, flush = async () => {}, log = logger, exit = (code) => process.exit(code) } = {}) {
  const inflight = new Set();
  let draining = false;
  let shuttingDown = null;

  // 跟踪未完成响应；draining 开始后不再登记新请求（它们会被服务层直接 503）
  server.on('request', (req, res) => {
    if (draining) return;
    inflight.add(res);
    res.on('close', () => inflight.delete(res));
  });

  async function drain() {
    const deadline = Date.now() + timeoutMs;
    while (inflight.size > 0 && Date.now() < deadline) await sleep(100);
    if (inflight.size > 0) {
      log.warn('shutdown_forcing', { remaining: inflight.size });
      for (const res of inflight) res.destroy?.();
    }
  }

  async function doShutdown() {
    server.close(() => {});
    server.closeIdleConnections?.(); // 只关空闲 keep-alive 连接，不影响 in-flight
    await drain();
    server.closeAllConnections?.(); // 排空（或强断）后清理所有连接
    try { await flush(); } catch (error) { log.error('shutdown_flush_failed', { err: error }); }
    log.info('shutdown_complete', { inflightRemaining: inflight.size });
  }

  function shutdown(signal) {
    if (shuttingDown) return shuttingDown;
    draining = true;
    log.warn('shutdown_start', { signal, inflight: inflight.size, timeoutMs });
    shuttingDown = doShutdown()
      .then(() => exit(0), (error) => { log.error('shutdown_failed', { err: error }); exit(1); });
    return shuttingDown;
  }

  return {
    shutdown,
    get draining() { return draining; },
    inflightCount: () => inflight.size,
  };
}

export function installCrashHandlers(log = logger) {
  process.on('uncaughtException', (error) => { log.error('uncaught_exception', { err: error }); process.exit(1); });
  process.on('unhandledRejection', (reason) => { log.error('unhandled_rejection', { err: reason }); process.exit(1); });
}
