// 市场信号的运行时桥：router.mjs 是纯函数（无服务器生命周期），信号实例挂在 server 侧。
// 这里提供进程级单例注册口：server.mjs 启动时 registerMarketSignal(实例)，
// router 热路径经 adjustFor() 取实例；无实例（测试/CLI 场景）一律返回 0，保持纯函数可测性。
let instance = null;

export function registerMarketSignal(signal) { instance = signal; }
export function getMarketSignal() { return instance; }

export function adjustFor(config, task, modelId, runtime = {}) {
  // runtime 直注（测试用）：runtime.marketSignals = { [task]: { [modelId]: adjust } }
  if (runtime.marketSignals) {
    const v = Number(runtime.marketSignals?.[task]?.[modelId] ?? 0);
    return Number.isFinite(v) ? v : 0;
  }
  if (!instance) return 0;
  return instance.adjustFor(task, modelId) || 0;
}
