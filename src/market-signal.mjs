// 市场信号引擎（OpenRouter「wisdom of the market」的内网飞轮版）。
// 内网没有跨租户市场，但决策日志就是「内部市场」：按任务类型聚合各模型的使用份额与满意度，
// 作为静态跑分（先验）之外的小权重活信号（后验）。核心安全设计：
//   1. 样本不足自动休眠（minSamplePerTask）——没有足够真实流量时信号为零，绝不瞎指挥；
//   2. 调整幅度有界（maxAdjust，默认 ±0.05）——信号只能微调排序，不能颠覆先验跑分；
//   3. 只在「同任务多家模型都被用过」时才有意义（单一模型 100% 份额不产生调整）。
// 信号构成（每任务×每模型）：
//   share      使用份额（auto 路由给了它多少）——市场用脚投票的结果；
//   explicit   被显式点名的次数——最强的真偏好（用户绕过 auto 也要用它）；
//   failRate   失败率——负向信号，失败多则降权；
// 综合 marketScore = share 归一 + explicit 加权 - failRate 惩罚，映射到 [-maxAdjust, +maxAdjust]。
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;

export class MarketSignal {
  constructor(options = {}) {
    this.projectRoot = options.projectRoot || process.cwd();
    this.decisionLog = options.decisionLog;          // DecisionLog 实例（recent() 复用其读取逻辑）
    this.windowDays = options.windowDays ?? 7;       // 滚动窗口（对齐 OpenRouter 7 天窗）
    this.minSamplePerTask = options.minSamplePerTask ?? 8;  // 每任务最少样本（不足则该任务休眠）
    this.maxAdjust = options.maxAdjust ?? 0.05;      // 单模型最大调整幅度（有界，防颠覆先验）
    this.minShareGap = options.minShareGap ?? 0.15;  // 份额差小于此值视为无明显偏好（不调整）
    this.signals = {};        // { [task]: { [modelId]: { n, fails, explicit, share, adjust } } }
    this.coverage = {};       // { [task]: { total, active } } 每任务样本量与是否激活
    this.loadedAt = 0;
    this.refreshMs = options.refreshMs ?? 5 * 60 * 1000; // 内存缓存 5 分钟
  }

  updateConfig(config) {
    const cfg = config.routing?.marketSignal || {};
    // 管理页可调窗口与门槛；enabled=false 完全关闭（adjust 恒 0）
    if (cfg.windowDays) this.windowDays = Number(cfg.windowDays);
    if (cfg.minSamplePerTask != null) this.minSamplePerTask = Number(cfg.minSamplePerTask);
    if (cfg.maxAdjust != null) this.maxAdjust = Number(cfg.maxAdjust);
    this.enabled = cfg.enabled !== false; // 默认开（样本不足自然休眠，无副作用）
  }

  // 从决策日志重建信号表（惰性 + 定时刷新；决策日志开启时每次 rebuild 全量重算，窗口内数据量小）
  async rebuild() {
    const empty = { signals: {}, coverage: {} };
    if (!this.decisionLog) return empty;
    const rows = await this.decisionLog.recent(5000).catch(() => []);
    const since = Date.now() - this.windowDays * DAY_MS;
    const byTask = {};
    for (const row of rows) {
      const at = Date.parse(row.at || '');
      if (!Number.isFinite(at) || at < since) continue;
      const d = row.decision || {};
      const outcome = row.outcome || {};
      const task = d.analysis?.task;
      const model = outcome.model || d.selectedModel;
      if (!task || !model || task === 'explicit') continue; // 点名请求不进份额（但进 explicit 计数）
      if (d.requestedModel && d.requestedModel !== 'auto') continue; // 点名请求单独计 explicit
      const slot = byTask[task] ||= { total: 0, models: {} };
      slot.total += 1;
      const m = slot.models[model] ||= { n: 0, fails: 0, explicit: 0 };
      m.n += 1;
      if (outcome.ok === false) m.fails += 1;
    }
    // explicit 点名计数（独立于 auto 份额：用户点名 = 绕过路由也要用的真偏好）
    for (const row of rows) {
      const at = Date.parse(row.at || '');
      if (!Number.isFinite(at) || at < since) continue;
      const d = row.decision || {};
      if (!d.requestedModel || d.requestedModel === 'auto') continue;
      // 点名请求在服务层 task 被记为 'explicit'，真实任务存于 decision.explicitTask（v0.5.1 起补记）；
      // 旧日志无该字段时跳过（宁缺毋滥）——否则 explicitBoost 恒为 0
      const task = d.explicitTask || (d.analysis?.task !== 'explicit' ? d.analysis?.task : null);
      if (!task || !byTask[task]) continue;
      const m = byTask[task].models[d.requestedModel];
      if (m) m.explicit += 1;
    }
    // 计算调整值
    const signals = {};
    const coverage = {};
    for (const [task, slot] of Object.entries(byTask)) {
      coverage[task] = { total: slot.total, active: slot.total >= this.minSamplePerTask };
      if (!coverage[task].active) continue;
      const entries = Object.entries(slot.models).sort((a, b) => b[1].n - a[1].n);
      const topN = entries[0][1].n / slot.total;
      const secondN = entries[1] ? entries[1][1].n / slot.total : 0;
      const shareGap = topN - secondN;
      const taskSignals = {};
      for (const [model, m] of entries) {
        const share = m.n / slot.total;
        const failRate = m.n > 0 ? m.fails / m.n : 0;
        // 无明显偏好（份额接近）或高失败率时不给正向加成
        // 历史份额不再作正向信号（路由器学习自己的历史决策 = 自我强化闭环；
        // 曾因旧份额 98.2% 白得 +0.05）。正向只保留 explicit 点名（绕过 auto 的真偏好），
        // 负向保留失败率降权。share 仍统计展示，不参与 adjust。
        let adjust = 0;
        const explicitBoost = Math.min(0.02, m.explicit * 0.005); // 每次点名 +0.005，封顶 0.02
        if (failRate >= 0.3) adjust = -this.maxAdjust;                       // 失败率 ≥30%：最大降权
        else if (failRate >= 0.1) adjust = -this.maxAdjust * (failRate / 0.3); // 线性降权区
        taskSignals[model] = { n: m.n, fails: m.fails, explicit: m.explicit,
          share: Number((share * 100).toFixed(1)), adjust: Number(adjust.toFixed(4)),
          explicitBoost: Number(explicitBoost.toFixed(4)) };
      }
      signals[task] = taskSignals;
    }
    this.signals = signals;
    this.coverage = coverage;
    this.loadedAt = Date.now();
    return { signals, coverage };
  }

  // 路由热路径查询：确保新鲜（过期后台刷新，不阻塞请求——对齐 model-scope 的 stale-while-revalidate）
  ensureFresh() {
    if (Date.now() - this.loadedAt < this.refreshMs) return;
    this.loadedAt = Date.now(); // 先占位防并发重复重建
    this.rebuild().catch(() => { this.loadedAt = 0; });
  }

  // 评分调整量（router 热路径调用；未激活/未启用/无数据一律 0）
  adjustFor(task, modelId) {
    if (this.enabled === false) return 0;  // 仅显式关闭才休眠；未调用 updateConfig 时默认启用
    this.ensureFresh();
    const s = this.signals[task]?.[modelId];
    if (!s) return 0;
    const total = Number(s.adjust || 0) + Number(s.explicitBoost || 0);
    return Math.max(-this.maxAdjust, Math.min(this.maxAdjust, total)); // 双保险夹紧
  }

  status() {
    const tasks = Object.keys(this.coverage).length;
    const active = Object.values(this.coverage).filter((c) => c.active).length;
    return { enabled: this.enabled !== false, windowDays: this.windowDays,
      minSamplePerTask: this.minSamplePerTask, maxAdjust: this.maxAdjust,
      tasksTracked: tasks, tasksActive: active, loadedAt: this.loadedAt ? new Date(this.loadedAt).toISOString() : null,
      coverage: this.coverage };
  }
}
