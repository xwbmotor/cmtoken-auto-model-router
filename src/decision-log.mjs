//决策日志：把每次路由决策追加写入 JSONL 文件，用于标注集采集与离线分析。
//设计约束：绝不阻塞请求路径（fire-and-forget + 失败静默计数）；文件按大小轮转。
import { appendFile, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const DEFAULTS = {
  enabled: false,
  dirPath: './data/decisions',
  maxFileBytes: 16 * 1024 * 1024,   //单文件 16MB
  maxFiles: 14,                     //最多保留 14 个轮转文件
  redactMessages: true,             //默认脱敏：不落盘完整用户消息
  logAnswerText: false,             //回答原文落盘开关（与 redactMessages 独立；数据留存期开）
  filePrefix: 'decisions'           //泛化事件流前缀（semantic-reviews 复用同一套轮转/串行写）
};

export class DecisionLog {
  constructor(options = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.currentFile = null;
    this.currentBytes = 0;
    this.errors = 0;
    this.written = 0;
    this.writeChain = Promise.resolve(); //串行化写盘，避免并发 append 交错
  }

  static async create(projectRoot, config) {
    const log = new DecisionLog(config.decisionLog || {});
    log.projectRoot = projectRoot;
    if (log.options.enabled) await log.openExistingOrCreate();
    return log;
  }

  fileFor(date = new Date()) {
    //文件名按业务时区分日（如 Asia/Shanghai：本地 00:00 即新文件，而非 UTC 16:00）。
    //内部每条记录的 at 仍为 ISO UTC，便于跨时区对账。
    const formatter = this.options.timeZone ? new Intl.DateTimeFormat('en-CA', { timeZone: this.options.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }) : null;
    const ymd = formatter ? formatter.format(date).replace(/(\d{4})-(\d{2})-(\d{2})/, '$1-$2-$3') : date.toISOString().slice(0, 10);
    return resolve(this.projectRoot, this.options.dirPath, `${this.options.filePrefix}-${ymd}.jsonl`);
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
    //filePrefix 泛化后轮转名直接复用当前文件 basename（前缀各异，不再硬编码 decisions-）
    const rotated = resolve(dir, this.currentFile.replace(/\.jsonl$/, `-${stamp}.rotated.jsonl`));
    try {
      //轮转 = 把当前文件改名；下一条日志会自动写到当天新文件
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
    //按前缀隔离轮转保留——decisions 与 semantic-reviews 各自 maxFiles 个名额，
    //互不挤占（原实现按目录全量 .jsonl 排序清理，semantic-reviews 上线会挤掉 decisions 的保留窗口）
    const prefix = this.options.filePrefix;
    const files = (await readdir(dir)).filter((f) => f.startsWith(prefix) && f.endsWith('.jsonl')).sort();
    while (files.length > this.options.maxFiles) {
      const victim = files.shift();
      await rm(resolve(dir, victim), { force: true });
    }
  }

  redact(body) {
    // 数据留存模式（redactMessages=false）：消息原文全量落盘（content 完整字符串），
    // 供离线训练取数；非文本 content 统一标注 [non-text] 保持行结构可解析。
    if (!this.options.redactMessages) {
      const messages = (body?.messages || []).map((message, index) => {
        const content = typeof message?.content === 'string' ? message.content : '[non-text]';
        return { index, role: message?.role, chars: content.length, content };
      });
      return { model: body?.model, stream: Boolean(body?.stream), max_tokens: body?.max_tokens, messages };
    }
    const messages = (body?.messages || []).map((message, index) => {
      const content = typeof message?.content === 'string' ? message.content : '[non-text]';
      return { index, role: message?.role, chars: content.length, head: content.slice(0, 160) };
    });
    return { model: body?.model, stream: Boolean(body?.stream), max_tokens: body?.max_tokens, messages };
  }

  entry(requestContext, decision, outcome) {
    return {
      at: new Date().toISOString(),
      v: 2,
      request: requestContext,
      decision: {
        requestedModel: decision.requestedModel,
        suggestedModel: decision.suggestedModel,
        selectedModel: decision.selectedModel,
        shadow: decision.shadow,
        rollout: decision.rollout || null,
        routeMethod: decision.analysis?.routeMethod || 'rules',
        //点名请求的真实任务类型（服务层把 task 记为 'explicit'，真实槽位在此）。
        //市场信号重建读这个字段产生点名加成；白名单漏掉=字段在持久化时丢失
        explicitTask: decision.explicitTask || null,
        reasoningLevel: decision.reasoningLevel,
        policyRevision: decision.policyRevision || null,
        qualifiedModelIds: decision.qualifiedModelIds || [],
        qualityDegraded: Boolean(decision.qualityDegraded),
        qualityDegradedReason: decision.qualityDegradedReason || null,
        analysis: decision.analysis ? {
          task: decision.analysis.task, tier: decision.analysis.tier,
          complexity: decision.analysis.complexity, confidence: decision.analysis.confidence,
          signals: decision.analysis.signals,
          subTask: decision.analysis.subTask || null,
          estimatedInputTokens: decision.analysis.estimatedInputTokens,
          estimatedOutputTokens: decision.analysis.estimatedOutputTokens,
          estimatedContextTokens: decision.analysis.estimatedContextTokens,
          capacityEstimate: decision.analysis.capacityEstimate,
          //置信度归因因素落盘（原白名单漏掉——negation/meta-discussion 等因素
          //在内存里有、持久化时被丢弃，「决策日志可归因」的交付描述不成立）
          ...(Array.isArray(decision.analysis.confidenceFactors) && decision.analysis.confidenceFactors.length > 0
            ? { confidenceFactors: decision.analysis.confidenceFactors } : {})
        } : null,
        candidates: (decision.candidates || []).map((c) => ({ model: c.model, score: c.score, quality: c.quality, qualityEligible: c.qualityEligible })),
        rejected: decision.rejected || [],
        fallbackOrder: decision.fallbackOrder || [],
        semanticReview: decision.semanticReview || null,
        configVersion: decision.configVersion
      },
      outcome
    };
    //注意：request 里已按 redact 规则脱敏；outcome 由调用方在响应完成后补充（含 usage/actualCostYuan 飞轮字段）
  }

  write(requestContext, decision, outcome) {
    if (!this.options.enabled) return;
    const record = this.entry(requestContext, decision, outcome);
    this.writeChain = this.writeChain.then(() => this.append(record)).catch(() => { this.errors += 1; });
    return this.writeChain;
  }

  //语义复核事件流写入口。与决策日志共用轮转/串行链但文件独立
  //（semantic-reviews-*.jsonl）：shadow 后台分类结果按 requestId 关联原决策持久化，
  //服务重启不再丢观察期数据。事件体由调用方组装（fire-and-forget，失败静默计数）。
  writeRaw(event) {
    if (!this.options.enabled) return;
    this.writeChain = this.writeChain.then(() => this.append(event)).catch(() => { this.errors += 1; });
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

  //决策日志目录磁盘占用：遍历 *.jsonl 求和（供 /metrics 监控磁盘增长）
  async diskUsage() {
    //口径=日志目录全部 .jsonl（decisions + semantic-reviews 两流同目录）。
    //semantic-reviews 每事件 ~1KB 且仅在 shadow/灰度分类发生时写入，量级远小于 decisions，
    //不单独分拆；告警阈值沿用原口径不变。
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

  //读取日志用于导出/标注：返回最新 count 条（跨轮转文件合并读取）
  async recent(count = 200, { includeFullText = false, keyFingerprint = null } = {}) {
    if (!this.options.enabled && !this.currentFile) return [];
    const dir = resolve(this.projectRoot, this.options.dirPath);
    //按前缀过滤——decisions 与 semantic-reviews 同目录共存，各自只读自己的流
    let files = [];
    try { files = (await readdir(dir)).filter((f) => f.startsWith(this.options.filePrefix) && f.endsWith('.jsonl')).sort().reverse(); } catch { return []; }
    const want = keyFingerprint ? String(keyFingerprint).toLowerCase() : null;
    const rows = [];
    for (const file of files) {
      if (rows.length >= count) break;
      let text = '';
      try { text = await readFile(resolve(dir, file), 'utf8'); } catch { continue; }
      const lines = text.split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0 && rows.length < count; i -= 1) {
        try {
          const row = JSON.parse(lines[i]);
          if (want && String(row.request?.keyFingerprint || '').toLowerCase() !== want) continue;
          rows.push(row);
        } catch { /* 跳过坏行 */ }
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
