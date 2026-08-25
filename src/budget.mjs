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
    // 预占-结算：请求开始预占估算额（防低预估逃逸预算窗口），结束按实际 usage 冲正。
    // reserves 仅内存态（进程崩溃丢预占 = 少记不重记，预算偏保守方向安全）
    this.reserves = new Map(); // id -> yuan
    this.reserveSeq = 0;
    this.rollover();
  }

  // 预占 改纯内存+异步落盘）：记账 estimated 返回 reserveId。估算为 null（模型未定价）时
  // 记 unpricedRequests 但不建预占——结算无需冲正。
  async reserve(estimateYuan) {
    this.rollover();
    const id = ++this.reserveSeq;
    if (estimateYuan == null || !Number.isFinite(Number(estimateYuan))) {
      this.reserves.set(id, null);
      this.state.unpricedRequests += 1;
      this.scheduleWrite();
      return id;
    }
    this.reserves.set(id, Number(estimateYuan));
    this.state.pricedRequests += 1;
    this.state.estimatedSpendYuan = Number((this.state.estimatedSpendYuan + Number(estimateYuan)).toFixed(6));
    this.scheduleWrite();
    return id;
  }

  // 结算 重写； 修：用实际额原子替换预占额。台账三项分解：
  // estimatedSpendYuan：未结算预占（所有结算路径都冲减， 无 usage 分支漏冲=双重占用已修）
  // settledActualSpendYuan：已按实际 usage 结算的累计（只增）
  // settledEstimatedSpendYuan：无 usage 而保留估算结清的累计（只增）
  // 冲正只做一次差额：estimated -= reserved（回滚预占），settled += actual。
  // 修 bug：原实现「先减 reserved，再 consume(actual-reserved)」——预占10实际15 记成 5（系统性少记）。
  async settle(id, actualYuan, fromUsage) {
    const reserved = this.reserves.get(id);
    if (reserved === undefined) return;
    this.reserves.delete(id);
    // 无定价预占（estimateYuan=null）：无金额可结，也不入估算台账
    if (reserved === null) { this.scheduleWrite(); return; }
    // 回滚预占：所有结算路径共用 修复——原无 usage 分支不回滚，费用同时在途+已结清双记）
    this.state.estimatedSpendYuan = Number(Math.max(0, this.state.estimatedSpendYuan - reserved).toFixed(6));
    if (!fromUsage || actualYuan == null || !Number.isFinite(Number(actualYuan))) {
      this.state.estimatedSettles = (this.state.estimatedSettles || 0) + 1;
      this.state.settledEstimatedSpendYuan = Number(((this.state.settledEstimatedSpendYuan || 0) + reserved).toFixed(6));
      this.state.answerEstimatedSettles = (this.state.answerEstimatedSettles || 0) + 1;
      this.state.answerEstimatedCostYuan = Number(((this.state.answerEstimatedCostYuan || 0) + reserved).toFixed(6));
      this.scheduleWrite();
      return; // 无 usage：保留预估口径结清（不冲正、不伪造实际值）
    }
    const actual = Number(actualYuan);
    // 修，不再要求 |delta|<1e-7
    // 的恰好相等（预占 10 实际 15 是正常冲正不是异常；原实现 exact 计数几乎恒 0，指标失去观测意义）
    this.state.settles = (this.state.settles || 0) + 1;
    this.state.exactSettles = (this.state.exactSettles || 0) + 1;
    this.state.answerSettles = (this.state.answerSettles || 0) + 1;
    this.state.answerCostYuan = Number(((this.state.answerCostYuan || 0) + actual).toFixed(6));
    this.state.settledActualSpendYuan = Number(((this.state.settledActualSpendYuan || 0) + actual).toFixed(6));
    this.scheduleWrite();
  }

  // 磁盘落盘保持异步批量：settle/reserve 不再 await 磁盘写——预算是记账不是闸门，
  // 热路径不因 JSON 台账序列化阻塞。
  scheduleWrite() {
    const snapshot = JSON.stringify(this.state, null, 2) + '\n';
    this.pendingWrite = this.pendingWrite.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temp, snapshot, { encoding: 'utf-8', mode: 0o600 });
      await rename(temp, this.path);
    }).catch(() => {});
    return this.pendingWrite;
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

  // 与主请求的 reserve→settle 不同，
  // 这笔费用在调用的瞬间就已确定（有真实 usage），直接进 settledActualSpendYuan（已结算实际），
  // 不占用预占语义。pressure 的总消费口径自动包含（settledActualSpendYuan 是其加数之一）。
  // 运营可直接算「净节省 = 回答节省 − 路由额外成本」；settles 与 settledActualSpendYuan 保持
  // 总口径不变（总量正确），分项字段做加法对齐（answer + overhead = total）。
  async chargeRouterOverhead(costYuan) {
    this.rollover();
    const cost = Number(costYuan);
    if (!Number.isFinite(cost) || cost < 0) return;
    this.state.settles = (this.state.settles || 0) + 1;
    this.state.classifierSettles = (this.state.classifierSettles || 0) + 1;
    this.state.routingOverheadCostYuan = Number(((this.state.routingOverheadCostYuan || 0) + cost).toFixed(6));
    this.state.settledActualSpendYuan = Number(((this.state.settledActualSpendYuan || 0) + cost).toFixed(6));
    this.scheduleWrite();
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
    // 修。
    // 原实现只看在途预占 estimatedSpendYuan——请求结算后预占归零，压力回落 0，
    // 预算耗尽也永不触发降级（budgetCostMultiplier 形同虚设）。
    const spend = (this.state.settledActualSpendYuan || 0) + (this.state.settledEstimatedSpendYuan || 0) + (this.state.estimatedSpendYuan || 0);
    return Math.max(0, Math.min(1, spend / limit));
  }

  snapshot() {
    this.rollover();
    const beansPerYuan = Number(this.config.budget?.beansPerYuan);
    const hasBeanRate = Number.isFinite(beansPerYuan) && beansPerYuan > 0;
    const settledTotal = (this.state.settledActualSpendYuan || 0) + (this.state.settledEstimatedSpendYuan || 0);
    // 首次读取旧台账时四分项之和
    // 自动补齐恒等式（此后 answerActual/answerEstimated/overhead 增长、legacy 冻结不变）。
    const attributed = (this.state.answerCostYuan || 0) + (this.state.answerEstimatedCostYuan || 0) + (this.state.routingOverheadCostYuan || 0);
    const legacyUnattributed = Math.max(0, Number((settledTotal - attributed).toFixed(6)));
    return {
      ...this.state,
      enabled: Boolean(this.config.budget?.enabled),
      dailyBudgetYuan: Number(this.config.budget?.dailyBudgetYuan || 0),
      settledSpendYuan: Number(settledTotal.toFixed(6)),
      pendingReserves: this.reserves.size,
      ...(hasBeanRate ? {
        beansPerYuan,
        estimatedSpendBeans: Number((this.state.estimatedSpendYuan * beansPerYuan).toFixed(2)),
        settledSpendBeans: Number((settledTotal * beansPerYuan).toFixed(2)),
        dailyBudgetBeans: Number(this.config.budget?.dailyBudgetBeans || 0) || Number(((Number(this.config.budget?.dailyBudgetYuan || 0)) * beansPerYuan).toFixed(2)),
      } : {}),
      // answerActualCostYuan 回答模型按真实 usage 结算（原 answerCostYuan 更名，语义不变）
      // answerEstimatedCostYuan 回答模型无 usage 保留估算结清（新增——原实现只进总账漏分项）
      // routingOverheadCostYuan L2/L3 分类调用（cash 记账）
      // legacyUnattributedCostYuan 升级前积累、无法归因到上述三者的存量（一次性迁移，只减不增）
      // 恒等式：answerActual + answerEstimated + routingOverhead + legacyUnattributed == settledSpendYuan
      // 净节省 = （固定模型基线成本 − answerActual − answerEstimated） − routingOverheadCostYuan。
      answerActualCostYuan: Number((this.state.answerCostYuan || 0).toFixed(6)),
      answerEstimatedCostYuan: Number((this.state.answerEstimatedCostYuan || 0).toFixed(6)),
      routingOverheadCostYuan: Number((this.state.routingOverheadCostYuan || 0).toFixed(6)),
      legacyUnattributedCostYuan: Number((legacyUnattributed).toFixed(6)),
      totalCostYuan: Number(settledTotal.toFixed(6)),
      answerSettles: this.state.answerSettles || 0,
      answerEstimatedSettles: this.state.answerEstimatedSettles || 0,
      classifierSettles: this.state.classifierSettles || 0,
      pressure: Number(this.pressure().toFixed(4)),
      // estimateOnly 语义：已结算部分有真实 usage 支撑；「true」只描述未结算预占
      estimateOnly: this.state.settledActualSpendYuan == null,
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
