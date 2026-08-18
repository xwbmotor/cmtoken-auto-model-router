// 结构化 JSON 日志：单行 JSON 输出到 stdout，适配 docker logs / journalctl / Loki 收集。
// 零依赖。LOG_LEVEL=debug|info|warn|error 控制输出（默认 info，调用时动态读取，改环境变量即时生效）。
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold() {
  const raw = (process.env.LOG_LEVEL || 'info').toLowerCase();
  return LEVELS[raw] ?? LEVELS.info;
}

function serializeError(error) {
  if (!error) return undefined;
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack?.split('\n').slice(0, 5).join(' | ') };
  return String(error);
}

function emit(level, event, fields) {
  if (LEVELS[level] < threshold()) return;
  const entry = { time: new Date().toISOString(), level, event };
  for (const [key, value] of Object.entries(fields || {})) entry[key] = key === 'err' ? serializeError(value) : value;
  try { process.stdout.write(`${JSON.stringify(entry)}\n`); } catch { /* stdout 不可写时静默丢弃，绝不影响主流程 */ }
}

export const logger = {
  debug: (event, fields = {}) => emit('debug', event, fields),
  info: (event, fields = {}) => emit('info', event, fields),
  warn: (event, fields = {}) => emit('warn', event, fields),
  error: (event, fields = {}) => emit('error', event, fields),
  // 绑定公共字段（如 requestId），返回同接口的子 logger
  child(base = {}) {
    const merge = (fields) => ({ ...base, ...fields });
    return {
      debug: (event, fields = {}) => emit('debug', event, merge(fields)),
      info: (event, fields = {}) => emit('info', event, merge(fields)),
      warn: (event, fields = {}) => emit('warn', event, merge(fields)),
      error: (event, fields = {}) => emit('error', event, merge(fields)),
    };
  },
};
