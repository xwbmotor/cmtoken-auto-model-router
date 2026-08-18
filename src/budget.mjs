import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

function dateKey(timeZone = 'Asia/Shanghai', now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function estimateCostYuan(body, analysis, model, config, reasoningLevel = 'off') {
  const pricing = model?.pricingYuanPerMillionTokens;
  if (pricing?.input == null || pricing?.output == null) return null;
  const inputPrice = Number(pricing?.input);
  const outputPrice = Number(pricing?.output);
  if (!Number.isFinite(inputPrice) || !Number.isFinite(outputPrice)) return null;
  const outputTokens = Math.max(1, Number(body.max_completion_tokens || body.max_tokens || config.budget?.defaultEstimatedOutputTokens || 800));
  const reasoningRatio = reasoningLevel === 'high' ? 0.5 : reasoningLevel === 'standard' ? 0.15 : 0;
  const reasoningPrice = Number.isFinite(Number(pricing?.reasoning)) ? Number(pricing.reasoning) : outputPrice;
  // 缓存命中：预估时按 cacheHitRatio 的输入量用缓存价，其余按全价（无法预知实际命中率时的期望口径）
  const cachePrice = Number.isFinite(Number(pricing?.inputCached)) ? Number(pricing.inputCached) : inputPrice;
  const cacheHitRatio = Math.min(1, Math.max(0, Number(config.budget?.cacheHitRatio ?? 0)));
  const effectiveInputPrice = inputPrice * (1 - cacheHitRatio) + cachePrice * cacheHitRatio;
  const cost = (analysis.estimatedInputTokens * effectiveInputPrice + outputTokens * outputPrice + outputTokens * reasoningRatio * reasoningPrice) / 1_000_000;
  return Number(cost.toFixed(6));
}

export function yuanToBeans(yuan, config) {
  const rate = Number(config?.budget?.beansPerYuan);
  if (!Number.isFinite(rate) || rate <= 0 || yuan == null) return null;
  return Number((yuan * rate).toFixed(2));
}

export class BudgetTracker {
  constructor(path, config, state) {
    this.path = path;
    this.config = config;
    this.state = state;
    this.pendingWrite = Promise.resolve();
    this.rollover();
  }

  static async create(projectRoot, config) {
    const path = resolve(projectRoot, config.budget?.ledgerPath || './data/budget-ledger.json');
    let state;
    try { state = JSON.parse(await readFile(path, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      state = {};
    }
    return new BudgetTracker(path, config, state);
  }

  updateConfig(config) { this.config = config; this.rollover(); }

  rollover() {
    const date = dateKey(this.config.budget?.timeZone);
    if (this.state.date !== date) this.state = { date, estimatedSpendYuan: 0, pricedRequests: 0, unpricedRequests: 0 };
  }

  pressure() {
    this.rollover();
    const limit = Number(this.config.budget?.dailyBudgetYuan || 0);
    if (!this.config.budget?.enabled || limit <= 0) return 0;
    return Math.max(0, Math.min(1, this.state.estimatedSpendYuan / limit));
  }

  snapshot() {
    this.rollover();
    const beansPerYuan = Number(this.config.budget?.beansPerYuan);
    const hasBeanRate = Number.isFinite(beansPerYuan) && beansPerYuan > 0;
    return {
      ...this.state,
      enabled: Boolean(this.config.budget?.enabled),
      dailyBudgetYuan: Number(this.config.budget?.dailyBudgetYuan || 0),
      ...(hasBeanRate ? {
        beansPerYuan,
        estimatedSpendBeans: Number((this.state.estimatedSpendYuan * beansPerYuan).toFixed(2)),
        dailyBudgetBeans: Number(this.config.budget?.dailyBudgetBeans || 0) || Number(((Number(this.config.budget?.dailyBudgetYuan || 0)) * beansPerYuan).toFixed(2)),
      } : {}),
      pressure: Number(this.pressure().toFixed(4)),
      estimateOnly: true,
    };
  }

  async consume(cost) {
    this.rollover();
    if (cost == null) this.state.unpricedRequests += 1;
    else {
      this.state.pricedRequests += 1;
      this.state.estimatedSpendYuan = Number((this.state.estimatedSpendYuan + cost).toFixed(6));
    }
    const snapshot = JSON.stringify(this.state, null, 2) + '\n';
    this.pendingWrite = this.pendingWrite.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temp, snapshot, { encoding: 'utf8', mode: 0o600 });
      await rename(temp, this.path);
    });
    return this.pendingWrite;
  }
}
