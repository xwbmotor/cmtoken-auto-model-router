// 决策日志：把每次路由决策追加写入 JSONL 文件，用于标注集采集与离线分析。
// 设计约束：绝不阻塞请求路径（fire-and-forget + 失败静默计数）；文件按大小轮转。
import { appendFile, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const DEFAULTS = {
  enabled: false,
  dirPath: './data/decisions',
  maxFileBytes: 16 * 1024 * 1024,   // 单文件 16MB
  maxFiles: 14,                     // 最多保留 14 个轮转文件
  redactMessages: true              // 默认脱敏：不落盘完整用户消息
};

export class DecisionLog {
  constructor(options = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.currentFile = null;
    this.currentBytes = 0;
    this.errors = 0;
    this.written = 0;
    this.writeChain = Promise.resolve(); // 串行化写盘，避免并发 append 交错
  }

  static async create(projectRoot, config) {
    const log = new DecisionLog(config.decisionLog || {});
    log.projectRoot = projectRoot;
    if (log.options.enabled) await log.openExistingOrCreate();
    return log;
  }

  fileFor(date = new Date()) {
    // 文件名按业务时区分日（如 Asia/Shanghai：本地 00:00 即新文件，而非 UTC 16:00）。
    // 内部每条记录的 at 仍为 ISO UTC，便于跨时区对账。
    const formatter = this.options.timeZone ? new Intl.DateTimeFormat('en-CA', { timeZone: this.options.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }) : null;
    const ymd = formatter ? formatter.format(date).replace(/(\d{4})-(\d{2})-(\d{2})/, '$1-$2-$3') : date.toISOString().slice(0, 10);
    return resolve(this.projectRoot, this.options.dirPath, `decisions-${ymd}.jsonl`);
  }

  async openExistingOrCreate() {
    const file = this.fileFor();
    await mkdir(resolve(this.projectRoot, this.options.dirPath), { recursive: true });
    try {
      const info = await stat(file);
      this.currentFile = file;
      this.currentBytes = info.size;
      if (info.size >= this.options.maxFileBytes) await this.rotate();
    } catch {
      this.currentFile = file;
      this.currentBytes = 0;
    }
  }

  async rotate() {
    const dir = resolve(this.projectRoot, this.options.dirPath);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const rotated = resolve(dir, `decisions-${this.currentFile.match(/decisions-(.+)\.jsonl$/)?.[1] || 'unknown'}-${stamp}.rotated.jsonl`);
    try {
      // 轮转 = 把当前文件改名；下一条日志会自动写到当天新文件
      await mkdir(dir, { recursive: true });
      await rename(this.currentFile, rotated);
      this.currentFile = null;
      this.currentBytes = 0;
      await this.prune(dir);
    } catch (error) {
      this.errors += 1;
    }
  }

  async prune(dir) {
    const files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl')).sort();
    while (files.length > this.options.maxFiles) {
      const victim = files.shift();
      await rm(resolve(dir, victim), { force: true });
    }
  }

  redact(body) {
    if (!this.options.redactMessages) return body;
    const messages = (body?.messages || []).map((message, index) => {
      const content = typeof message?.content === 'string' ? message.content : '[non-text]';
      return { index, role: message?.role, chars: content.length, head: content.slice(0, 160) };
    });
    return { model: body?.model, stream: Boolean(body?.stream), max_tokens: body?.max_tokens, messages };
  }

  entry(requestContext, decision, outcome) {
    return {
      at: new Date().toISOString(),
      v: 1,
      request: requestContext,
      decision: {
        requestedModel: decision.requestedModel,
        suggestedModel: decision.suggestedModel,
        selectedModel: decision.selectedModel,
        shadow: decision.shadow,
        routeMethod: decision.analysis?.routeMethod || 'rules',
        reasoningLevel: decision.reasoningLevel,
        analysis: decision.analysis ? {
          task: decision.analysis.task, tier: decision.analysis.tier,
          complexity: decision.analysis.complexity, confidence: decision.analysis.confidence,
          signals: decision.analysis.signals
        } : null,
        candidates: (decision.candidates || []).map((c) => ({ model: c.model, score: c.score, quality: c.quality })),
        rejected: decision.rejected || [],
        fallbackOrder: decision.fallbackOrder || [],
        semanticReview: decision.semanticReview || null,
        configVersion: decision.configVersion
      },
      outcome
    };
    // 注意：request 里已按 redact 规则脱敏；outcome 由调用方在响应完成后补充
  }

  write(requestContext, decision, outcome) {
    if (!this.options.enabled) return;
    const record = this.entry(requestContext, decision, outcome);
    this.writeChain = this.writeChain.then(() => this.append(record)).catch(() => { this.errors += 1; });
    return this.writeChain;
  }

  async append(record) {
    if (!this.currentFile || this.fileFor() !== this.currentFile) await this.openExistingOrCreate();
    const line = JSON.stringify(record) + '\n';
    await appendFile(this.currentFile, line, 'utf8');
    this.currentBytes += Buffer.byteLength(line);
    this.written += 1;
    if (this.currentBytes >= this.options.maxFileBytes) await this.rotate();
  }

  updateConfig(config) {
    const next = { ...DEFAULTS, ...(config.decisionLog || {}) };
    if (config.budget?.timeZone) next.timeZone = config.budget.timeZone;
    const wasEnabled = this.options.enabled;
    this.options = next;
    if (next.enabled && !wasEnabled) {
      this.openExistingOrCreate().catch(() => { this.errors += 1; });
    }
    if (!next.enabled) { this.currentFile = null; }
  }

  snapshot() {
    return { enabled: this.options.enabled, written: this.written, errors: this.errors, currentFile: this.currentFile, currentBytes: this.currentBytes };
  }

  // 决策日志目录磁盘占用：遍历 *.jsonl 求和（供 /metrics 监控磁盘增长）
  async diskUsage() {
    const dir = resolve(this.projectRoot, this.options.dirPath);
    try {
      const entries = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'));
      let bytes = 0;
      for (const name of entries) {
        try { bytes += (await stat(resolve(dir, name))).size; } catch { /* 忽略单个文件读取失败 */ }
      }
      return { bytes, files: entries.length };
    } catch {
      return { bytes: 0, files: 0 };
    }
  }

  // 读取日志用于导出/标注：返回最新 count 条（跨轮转文件合并读取）
  async recent(count = 200, { includeFullText = false } = {}) {
    if (!this.options.enabled && !this.currentFile) return [];
    const dir = resolve(this.projectRoot, this.options.dirPath);
    let files = [];
    try { files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl')).sort().reverse(); } catch { return []; }
    const rows = [];
    for (const file of files) {
      if (rows.length >= count) break;
      let text = '';
      try { text = await readFile(resolve(dir, file), 'utf8'); } catch { continue; }
      const lines = text.split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0 && rows.length < count; i -= 1) {
        try { rows.push(JSON.parse(lines[i])); } catch { /* 跳过坏行 */ }
      }
    }
    if (!includeFullText) {
      for (const row of rows) {
        if (row.request?.messages) row.request.messages = row.request.messages.map((m) => ({ ...m, head: undefined }));
      }
    }
    return rows;
  }
}
