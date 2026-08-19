// 用户显式反馈日志：业务方对单次路由结果的 👍/👎 评价落盘（飞轮的质量信号源之二）。
// 与决策日志同构（按天 JSONL、fire-and-forget、失败静默计数），供 mine-decisions.py 离线关联决策记录。
import { appendFile, mkdir, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const DEFAULTS = {
  enabled: true,
  dirPath: './data/feedback',
  maxFiles: 30, // 30 天：反馈稀疏，保留期比决策日志长
};

const RATINGS = new Set(['good', 'bad']);

export class FeedbackLog {
  constructor(options = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.errors = 0;
    this.written = 0;
    this.writeChain = Promise.resolve();
  }

  static async create(projectRoot, config) {
    const log = new FeedbackLog(config.feedbackLog || {});
    log.projectRoot = projectRoot;
    if (log.options.enabled) await mkdir(resolve(projectRoot, log.options.dirPath), { recursive: true }).catch(() => { log.errors += 1; });
    return log;
  }

  fileFor(date = new Date()) {
    const formatter = this.options.timeZone ? new Intl.DateTimeFormat('en-CA', { timeZone: this.options.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }) : null;
    const ymd = formatter ? formatter.format(date).replace(/(\d{4})-(\d{2})-(\d{2})/, '$1-$2-$3') : date.toISOString().slice(0, 10);
    return resolve(this.projectRoot, this.options.dirPath, `feedback-${ymd}.jsonl`);
  }

  // 评价单次请求：requestId 必填（与决策日志关联键），rating ∈ good|bad，comment 可选
  write(entry) {
    if (!this.options.enabled) return { ok: false, error: 'disabled' };
    if (!entry?.requestId) return { ok: false, error: 'requestId 必填' };
    if (!RATINGS.has(entry.rating)) return { ok: false, error: 'rating 必须是 good 或 bad' };
    const record = { at: new Date().toISOString(), v: 1, requestId: entry.requestId, rating: entry.rating, comment: typeof entry.comment === 'string' ? entry.comment.slice(0, 500) : null, source: entry.source || 'manual' };
    this.writeChain = this.writeChain.then(async () => {
      await appendFile(this.fileFor(), JSON.stringify(record) + '\n', 'utf8');
      this.written += 1;
      await this.prune().catch(() => {});
    }).catch(() => { this.errors += 1; });
    return { ok: true };
  }

  async prune() {
    const dir = resolve(this.projectRoot, this.options.dirPath);
    const files = (await readdir(dir)).filter((f) => f.startsWith('feedback-') && f.endsWith('.jsonl')).sort();
    for (const file of files.slice(0, Math.max(0, files.length - this.options.maxFiles))) {
      await (await import('node:fs/promises')).rm(resolve(dir, file), { force: true });
    }
  }

  async diskUsage() {
    try {
      const dir = resolve(this.projectRoot, this.options.dirPath);
      const files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'));
      let bytes = 0;
      for (const f of files) bytes += (await stat(resolve(dir, f))).size;
      return { files: files.length, bytes };
    } catch { return { files: 0, bytes: 0 }; }
  }

  snapshot() { return { enabled: this.options.enabled, written: this.written, errors: this.errors }; }
}
