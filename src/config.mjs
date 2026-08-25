import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

//单一版本源：软件版本统一取 package.json 的 semver（0.x.x），不再维护独立的整数配置修订号。
export const SOFTWARE_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
})();

export function configPath() {
  return resolve(projectRoot, process.env.CONFIG_PATH || './config/router.json');
}

export function validateConfig(config) {
  if (!config || typeof config !== 'object') throw new Error('配置必须是 JSON 对象');
  if (!Array.isArray(config.models) || config.models.length === 0) throw new Error('models 至少需要一个模型');
  const ids = new Set();
  for (const model of config.models) {
    if (!model.id || typeof model.id !== 'string') throw new Error('每个模型都需要字符串 id');
    if (ids.has(model.id)) throw new Error(`模型 id 重复: ${model.id}`);
    ids.add(model.id);
    if (!['self_hosted', 'ecosystem'].includes(model.ownership)) throw new Error(`模型 ${model.id} ownership 无效`);
    if (!model.quality || typeof model.quality.default !== 'number') throw new Error(`模型 ${model.id} 缺少 quality.default`);
    if (model.calibrationStatus !== undefined && !['pilot', 'unverified', 'verified'].includes(model.calibrationStatus)) throw new Error(`模型 ${model.id} calibrationStatus 无效（可选 pilot/unverified/verified）`);
    //修calibrationStatus → reliabilityStatus 更名（「已验证」实际只验证 HTTP 可用性，
    //不是回答质量——原名让质量校准和可用性校准混为一谈）。旧字段兼容读取（calibrationStatus 仍生效）。
    if (model.reliabilityStatus !== undefined && !['pilot', 'unverified', 'verified'].includes(model.reliabilityStatus)) throw new Error(`模型 ${model.id} reliabilityStatus 无效（可选 pilot/unverified/verified）`);
    model.reliabilityStatus ??= model.calibrationStatus;
    if (model.benchmarkScores !== undefined && model.benchmarkScores !== null && (typeof model.benchmarkScores !== 'object' || Array.isArray(model.benchmarkScores))) throw new Error(`模型 ${model.id} benchmarkScores 必须是对象或 null`);
    if (model.deployment !== undefined && model.deployment !== null) {
      const d = model.deployment;
      if (typeof d !== 'object' || Array.isArray(d)) throw new Error(`模型 ${model.id} deployment 必须是对象`);
      if (d.deviceType !== undefined && typeof d.deviceType !== 'string') throw new Error(`模型 ${model.id} deployment.deviceType 必须是字符串`);
      if (d.machines !== undefined && (!Number.isInteger(Number(d.machines)) || Number(d.machines) < 1)) throw new Error(`模型 ${model.id} deployment.machines 必须是正整数`);
      if (d.cardsPerMachine !== undefined && (!Number.isInteger(Number(d.cardsPerMachine)) || Number(d.cardsPerMachine) < 1)) throw new Error(`模型 ${model.id} deployment.cardsPerMachine 必须是正整数`);
      if (d.tps !== undefined && (!Number.isFinite(Number(d.tps)) || Number(d.tps) <= 0)) throw new Error(`模型 ${model.id} deployment.tps 必须是正数`);
      if (d.instances !== undefined && (!Number.isInteger(Number(d.instances)) || Number(d.instances) < 1)) throw new Error(`模型 ${model.id} deployment.instances 必须是正整数`);
      if (d.concurrencyPerInstance !== undefined && d.concurrencyPerInstance !== null && (!Number.isInteger(Number(d.concurrencyPerInstance)) || Number(d.concurrencyPerInstance) < 1)) throw new Error(`模型 ${model.id} deployment.concurrencyPerInstance 必须是正整数`);
      if (d.totalConcurrency !== undefined && d.totalConcurrency !== null && (!Number.isInteger(Number(d.totalConcurrency)) || Number(d.totalConcurrency) < 1)) throw new Error(`模型 ${model.id} deployment.totalConcurrency 必须是正整数`);
    }
  }
  if (!config.routing || !['active', 'shadow'].includes(config.routing.mode)) throw new Error('routing.mode 必须是 active 或 shadow');
  if (config.routing.costTier != null && !['budget', 'balanced', 'quality', 'max', 'custom'].includes(config.routing.costTier)) throw new Error('routing.costTier 必须是 budget/balanced/quality/max/custom');
  //auto 对外模型名可配 + 模型发现列表口径。autoModelId 不得与池内模型 ID 冲突
  //（否则 auto 名与真实模型重合，路由入口判定与显式点名不可区分）。
  if (config.routing.autoModelId !== undefined) {
    if (typeof config.routing.autoModelId !== 'string' || !config.routing.autoModelId.trim()) throw new Error('routing.autoModelId 必须是非空字符串（auto 模型对外展示名，如「cmtoken-auto」）');
    if ((config.models || []).some((m) => m.id === config.routing.autoModelId)) throw new Error(`routing.autoModelId（${config.routing.autoModelId}）不得与池内模型 ID 冲突`);
  }
  if (config.routing.exposeModelList !== undefined && !['auto-only', 'all'].includes(config.routing.exposeModelList)) throw new Error('routing.exposeModelList 必须是 auto-only（默认，仅暴露 auto 入口）或 all（含池内模型）');
  const bounded = [['qualityFloor', 0, 1], ['qualityWeight', 0, 3], ['costWeight', 0, 1], ['latencyWeight', 0, 1], ['selfHostedBonus', 0, 1], ['activeTrafficPercent', 0, 100], ['complexQualityMargin', 0, 0.3], ['providerCostWeight', 0, 1], ['subtaskSmoothK', 1, 1000], ['subtaskMinSamples', 0, 1000], ['subtaskMaxAdjust', 0, 1], ['sessionStickinessMaxGap', 0, 1]];
  for (const [name, min, max] of bounded) {
    if (config.routing[name] === undefined) continue; //未配置视为默认值（如 providerCostWeight 缺省=0），向后兼容旧配置
    const value = Number(config.routing[name]);
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`routing.${name} 必须在 ${min} 到 ${max} 之间`);
  }
  //相对质量损失上限（对象形式 simple/balanced/complex 各 0~1；数字形式=统一值）
  if (config.routing.relQualityCap !== undefined) {
    const rqc = config.routing.relQualityCap;
    const asNum = (v) => Number(v);
    if (typeof rqc === 'number' || typeof rqc === 'string') {
      const v = asNum(rqc);
      if (!Number.isFinite(v) || v < 0 || v > 1) throw new Error('routing.relQualityCap（数字形式）必须在 0 到 1 之间');
    } else if (rqc && typeof rqc === 'object' && !Array.isArray(rqc)) {
      for (const tier of ['simple', 'balanced', 'complex']) {
        if (rqc[tier] === undefined) continue;
        const v = asNum(rqc[tier]);
        if (!Number.isFinite(v) || v < 0 || v > 1) throw new Error(`routing.relQualityCap.${tier} 必须在 0 到 1 之间`);
      }
    } else {
      throw new Error('routing.relQualityCap 必须是数字或 { simple, balanced, complex } 对象');
    }
  }
  //taskPreferences 校验（model 必须在池内、tolerance 0~1）
  if (config.routing.taskPreferences) {
    const ids = new Set(config.models.map((m) => m.id));
    for (const [task, pref] of Object.entries(config.routing.taskPreferences)) {
      if (!pref || typeof pref !== 'object') throw new Error(`routing.taskPreferences.${task} 必须是 { model, tolerance } 对象`);
      if (!ids.has(pref.model)) throw new Error(`routing.taskPreferences.${task}.model "${pref.model}" 不在模型池中`);
      if (pref.tolerance !== undefined && (!Number.isFinite(Number(pref.tolerance)) || Number(pref.tolerance) < 0 || Number(pref.tolerance) > 1)) throw new Error(`routing.taskPreferences.${task}.tolerance 必须在 0 到 1 之间`);
    }
  }
  if (!Number.isInteger(Number(config.routing.maxAttempts)) || config.routing.maxAttempts < 1 || config.routing.maxAttempts > config.models.length) throw new Error('maxAttempts 必须为 1 到模型数量之间的整数');
  if (config.routing.scoreStrategy !== undefined && !['weighted'].includes(config.routing.scoreStrategy)) throw new Error(`routing.scoreStrategy 无效: ${config.routing.scoreStrategy}（当前仅支持 weighted）`);
  if (config.routing.livePenalty) {
    const lp = config.routing.livePenalty;
    const lpBounds = [['latencyScaleMs', 1000, 3600000], ['latencyMax', 0, 1], ['errorStep', 0, 1], ['errorMax', 0, 1]];
    for (const [key, min, max] of lpBounds) {
      const v = Number(lp[key]);
      if (lp[key] !== undefined && (!Number.isFinite(v) || v < min || v > max)) throw new Error(`routing.livePenalty.${key} 必须在 ${min} 到 ${max} 之间`);
    }
  }
  if (config.routing.budgetCostMultiplier !== undefined && (!Number.isFinite(Number(config.routing.budgetCostMultiplier)) || Number(config.routing.budgetCostMultiplier) < 0)) throw new Error('routing.budgetCostMultiplier 必须是非负数');
  if (!ids.has(config.routing.defaultExplicitModel)) throw new Error('defaultExplicitModel 不在模型列表中');
  if (!ids.has(config.routing.shadowModel)) throw new Error('shadowModel 不在模型列表中');
  if (config.semanticRouter) {
    if (!['shadow', 'active'].includes(config.semanticRouter.mode)) throw new Error('semanticRouter.mode 必须是 shadow 或 active');
    const provider = config.semanticRouter.provider || (config.semanticRouter.model ? 'openai-chat' : 'disabled');
    if (!['openai-chat', 'http-json', 'cascade', 'disabled'].includes(provider)) throw new Error(`semanticRouter.provider 无效: ${provider}（可选 openai-chat / http-json / cascade / disabled）`);
    if (provider === 'http-json' && !config.semanticRouter.httpJson?.url) throw new Error('semanticRouter.httpJson.url 不能为空');
    if (provider === 'cascade' && !config.semanticRouter.httpJson?.url) throw new Error('级联复核需要 semanticRouter.httpJson.url（第一级小模型端点）');
    if (provider === 'cascade' && !config.semanticRouter.model && !config.semanticRouter.openaiChat?.model) throw new Error('级联复核需要 semanticRouter.model 或 openaiChat.model（第二级大模型）');
    if (provider === 'openai-chat' && !config.semanticRouter.model && !config.semanticRouter.openaiChat?.model) throw new Error('openai-chat 评估器必须配置 model 或 openaiChat.model');
    if ((provider === 'openai-chat' || provider === 'cascade') && config.semanticRouter.model && !ids.has(config.semanticRouter.model)) throw new Error('semanticRouter.model 不在模型列表中');
    if ((provider === 'openai-chat' || provider === 'cascade') && config.semanticRouter.openaiChat?.model && !ids.has(config.semanticRouter.openaiChat.model)) throw new Error('semanticRouter.openaiChat.model 不在模型列表中');
    const threshold = Number(config.semanticRouter.confidenceThreshold);
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error('semanticRouter.confidenceThreshold 必须在 0 到 1 之间');
    if (config.semanticRouter.minConfidence !== undefined) {
      const minConf = Number(config.semanticRouter.minConfidence);
      if (!Number.isFinite(minConf) || minConf < 0 || minConf > 1) throw new Error('semanticRouter.minConfidence 必须在 0 到 1 之间（兼容字段：未配置新字段时的回退值，建议改用 smallAcceptThreshold / finalAdoptionThreshold）');
    }
    //三阈值拆分（minConfidence 双语义）
    if (config.semanticRouter.smallAcceptThreshold !== undefined) {
      const v = Number(config.semanticRouter.smallAcceptThreshold);
      if (!Number.isFinite(v) || v < 0 || v > 1) throw new Error('semanticRouter.smallAcceptThreshold 必须在 0 到 1 之间（cascade 第一级：小模型置信度 ≥ 此值直接采纳，否则升级大模型）');
    }
    if (config.semanticRouter.finalAdoptionThreshold !== undefined) {
      const v = Number(config.semanticRouter.finalAdoptionThreshold);
      if (!Number.isFinite(v) || v < 0 || v > 1) throw new Error('semanticRouter.finalAdoptionThreshold 必须在 0 到 1 之间（语义复核最终采纳线，低于此值退回规则层决策）');
    }
    //语义路由独立灰度比例（与 routing.activeTrafficPercent 是两个实验变量）
    if (config.semanticRouter.activeTrafficPercent !== undefined) {
      const v = Number(config.semanticRouter.activeTrafficPercent);
      if (!Number.isFinite(v) || v < 0 || v > 100) throw new Error('semanticRouter.activeTrafficPercent 必须在 0 到 100 之间（语义分类独立灰度比例，按 requestId 稳定分桶）');
    }
  }
  //Judge：异步 shadow 评分器（边界：只离线评分，不进在线决策闭环）
  //judge 是付费调用，事件流必须可审计——judge 开 + 决策日志关
  //的组合直接拒绝（judge 流启停虽已独立于 decisionLog.enabled，但决策行与评审事件的
  //requestId 关联依赖决策日志；两者都关会导致评分调用无审计链）。
  if (config.judge?.enabled === true && config.decisionLog?.enabled === false) {
    throw new Error('judge.enabled=true 时 decisionLog.enabled 不得为 false——评审事件需与决策行按 requestId 关联审计');
  }
  if (config.judge) {
    if (typeof config.judge.enabled !== 'boolean') throw new Error('judge.enabled 必须是布尔值');
    const jm = config.judge.model;
    if (typeof jm !== 'string' || !jm) throw new Error('judge.model 必须是非空字符串（Judge 模型 ID，如 glm-5.3）');
    const sp = Number(config.judge.samplePercent);
    if (config.judge.samplePercent === undefined || !Number.isFinite(sp) || sp < 0 || sp > 100) throw new Error('judge.samplePercent 必须在 0 到 100 之间（日常建议 1~5%，采样期可调高）');
    if (config.judge.taskCheckEnabled !== undefined && typeof config.judge.taskCheckEnabled !== 'boolean') throw new Error('judge.taskCheckEnabled 必须是布尔值');
    if (config.judge.timeoutMs !== undefined && (!Number.isInteger(Number(config.judge.timeoutMs)) || Number(config.judge.timeoutMs) < 1000)) throw new Error('judge.timeoutMs 必须是 ≥1000 的整数（毫秒）');
    if (config.judge.dailyMaxCalls !== undefined && (!Number.isInteger(Number(config.judge.dailyMaxCalls)) || Number(config.judge.dailyMaxCalls) < 1)) throw new Error('judge.dailyMaxCalls 必须是正整数（每日调用上限，成本护栏）');
    if (config.judge.dailyMaxTokens !== undefined && (!Number.isInteger(Number(config.judge.dailyMaxTokens)) || Number(config.judge.dailyMaxTokens) < 1)) throw new Error('judge.dailyMaxTokens 必须是正整数（每日 token 上限，成本护栏）');
    if (config.judge.circuitThreshold !== undefined && (!Number.isInteger(Number(config.judge.circuitThreshold)) || Number(config.judge.circuitThreshold) < 1)) throw new Error('judge.circuitThreshold 必须是正整数（连续失败熔断阈值）');
    if (config.judge.cooldownMs !== undefined && (!Number.isInteger(Number(config.judge.cooldownMs)) || Number(config.judge.cooldownMs) < 1000)) throw new Error('judge.cooldownMs 必须是 ≥1000 的整数（熔断冷却毫秒）');
    if (config.judge.redactPatterns !== undefined) {
      if (!Array.isArray(config.judge.redactPatterns) || config.judge.redactPatterns.some((x) => typeof x !== 'string' || !x)) throw new Error('judge.redactPatterns 必须是非空字符串数组（发送评审模型前的脱敏正则）');
      for (const x of config.judge.redactPatterns) { try { new RegExp(x); } catch (e) { throw new Error(`judge.redactPatterns 含非法正则 ${JSON.stringify(x)}：${e.message}`); } }
    }
    if (config.judge.guardStatePath !== undefined && (typeof config.judge.guardStatePath !== 'string' || !config.judge.guardStatePath)) throw new Error('judge.guardStatePath 必须是非空字符串（预算/熔断状态持久化文件路径）');
  }
  if (config.decisionLog) {
    if (typeof config.decisionLog.enabled !== 'boolean') throw new Error('decisionLog.enabled 必须是布尔值');
    if (typeof config.decisionLog.dirPath !== 'string' || !config.decisionLog.dirPath) throw new Error('decisionLog.dirPath 必须是非空字符串');
    if (config.decisionLog.maxFiles !== undefined && (!Number.isInteger(Number(config.decisionLog.maxFiles)) || Number(config.decisionLog.maxFiles) < 1)) throw new Error('decisionLog.maxFiles 必须是正整数');
    if (config.decisionLog.redactMessages !== undefined && typeof config.decisionLog.redactMessages !== 'boolean') throw new Error('decisionLog.redactMessages 必须是布尔值');
    if (config.decisionLog.logAnswerText !== undefined && typeof config.decisionLog.logAnswerText !== 'boolean') throw new Error('decisionLog.logAnswerText 必须是布尔值（回答原文落盘开关）');
  }
  if (config.rateLimit) {
    if (typeof config.rateLimit.enabled !== 'boolean') throw new Error('rateLimit.enabled 必须是布尔值');
    if (config.rateLimit.rpm !== undefined && (!Number.isInteger(Number(config.rateLimit.rpm)) || Number(config.rateLimit.rpm) < 1)) throw new Error('rateLimit.rpm 必须是正整数');
    if (config.rateLimit.burst !== undefined && (!Number.isInteger(Number(config.rateLimit.burst)) || Number(config.rateLimit.burst) < 1)) throw new Error('rateLimit.burst 必须是正整数');
  }
  if (config.budget) {
    if (Number(config.budget.dailyBudgetYuan) < 0) throw new Error('budget.dailyBudgetYuan 不能小于 0');
    const degrade = Number(config.budget.degradeThreshold);
    if (!Number.isFinite(degrade) || degrade <= 0 || degrade > 1) throw new Error('budget.degradeThreshold 必须大于 0 且不超过 1');
  }
  if (config.calibration) {
    if (typeof config.calibration.enabled !== 'boolean') throw new Error('calibration.enabled 必须是布尔值');
    if (config.calibration.minSamples !== undefined && (!Number.isInteger(Number(config.calibration.minSamples)) || Number(config.calibration.minSamples) < 1)) throw new Error('calibration.minSamples 必须是正整数');
    if (config.calibration.maxFailureRate !== undefined && (!Number.isFinite(Number(config.calibration.maxFailureRate)) || Number(config.calibration.maxFailureRate) < 0 || Number(config.calibration.maxFailureRate) > 1)) throw new Error('calibration.maxFailureRate 必须在 0 到 1 之间');
  }
  if (config.costModel !== undefined) {
    if (typeof config.costModel !== 'object' || Array.isArray(config.costModel)) throw new Error('costModel 必须是对象');
    if (config.costModel.enabled !== undefined && typeof config.costModel.enabled !== 'boolean') throw new Error('costModel.enabled 必须是布尔值');
    if (config.costModel.source !== undefined && !['pricing', 'deployment'].includes(config.costModel.source)) throw new Error('costModel.source 必须是 pricing 或 deployment');
    if (config.costModel.pricingMix !== undefined) {
      if (typeof config.costModel.pricingMix !== 'object' || Array.isArray(config.costModel.pricingMix)) throw new Error('costModel.pricingMix 必须是对象');
      for (const key of ['input', 'output']) {
        const v = Number(config.costModel.pricingMix[key]);
        if (config.costModel.pricingMix[key] !== undefined && (!Number.isFinite(v) || v < 0)) throw new Error(`costModel.pricingMix.${key} 必须是非负数`);
      }
    }
    if (config.costModel.cardPrice !== undefined) {
      if (typeof config.costModel.cardPrice !== 'object' || Array.isArray(config.costModel.cardPrice)) throw new Error('costModel.cardPrice 必须是对象');
      for (const [key, value] of Object.entries(config.costModel.cardPrice)) {
        if (!Number.isFinite(Number(value)) || Number(value) <= 0) throw new Error(`costModel.cardPrice.${key} 必须是正数`);
      }
    }
  }
  if (config.budget) {
    if (config.budget.beansPerYuan !== undefined && (!Number.isFinite(Number(config.budget.beansPerYuan)) || Number(config.budget.beansPerYuan) <= 0)) throw new Error('budget.beansPerYuan 必须是正数');
    if (config.budget.dailyBudgetBeans !== undefined && Number(config.budget.dailyBudgetBeans) < 0) throw new Error('budget.dailyBudgetBeans 不能小于 0');
    if (Number(config.budget.dailyBudgetYuan) < 0) throw new Error('budget.dailyBudgetYuan 不能小于 0');
    const degrade = Number(config.budget.degradeThreshold);
    if (!Number.isFinite(degrade) || degrade <= 0 || degrade > 1) throw new Error('budget.degradeThreshold 必须大于 0 且不超过 1');
  }
  for (const model of config.models) {
    const p = model.pricingYuanPerMillionTokens;
    if (p === undefined || p === null) continue;
    if (typeof p !== 'object' || Array.isArray(p)) throw new Error(`模型 ${model.id} pricingYuanPerMillionTokens 必须是对象`);
    for (const key of ['input', 'inputCached', 'output', 'reasoning']) {
      if (p[key] === undefined || p[key] === null) continue;
      if (!Number.isFinite(Number(p[key])) || Number(p[key]) < 0) throw new Error(`模型 ${model.id} pricing.${key} 必须是非负数`);
    }
    if (p.inputCached !== undefined && p.inputCached !== null && (p.input == null || Number(p.inputCached) > Number(p.input))) throw new Error(`模型 ${model.id} pricing.inputCached 不能高于 input`);
  }
  return config;
}

//按定价归一化成本指数：加权单价 = (输入占比 × 输入价 + 输出占比 × 输出价)，归一化到 0~1（最贵的 = 1）。
//输入输出流量构成由 costModel.pricingMix 配置（如 10:1）。
export function computeCostIndexFromPricing(models, costModel) {
  const mix = costModel?.pricingMix || { input: 10, output: 1 };
  const totalMix = Number(mix.input) + Number(mix.output);
  if (!(totalMix > 0)) return null;
  const inputShare = Number(mix.input) / totalMix;
  const outputShare = Number(mix.output) / totalMix;
  const costs = [];
  for (const model of models) {
    const p = model.pricingYuanPerMillionTokens;
    if (p?.input == null || p?.output == null) continue;
    const weighted = inputShare * Number(p.input) + outputShare * Number(p.output);
    if (!(weighted > 0)) continue;
    costs.push({ id: model.id, unitCost: weighted });
  }
  if (costs.length < 2) return null;
  //归一化锚点：优先用 costModel.pricingAnchorYuan 固定基准（默认 4.811，
  //= 历史最贵 MiniMax-M3 的加权单价，保持删模型/换池子时成本指数语义不漂移）；
  //未配置时回退池内最贵（旧行为，仅兼容）。
  const anchor = Number(costModel?.pricingAnchorYuan) > 0 ? Number(costModel.pricingAnchorYuan)
    : Math.max(...costs.map((c) => c.unitCost));
  if (!(anchor > 0)) return null;
  const result = {};
  for (const c of costs) result[c.id] = Number(Math.min(1, (c.unitCost / anchor)).toFixed(3));
  return result;
}

//由部署资源估算相对成本指数：costIndex ∝ (设备数 × 单机卡数 × 卡型单价权重) / 吞吐，归一化到 0~1（最贵的 = 1）。
export function computeCostIndex(models, costModel) {
  const cardPrice = costModel?.cardPrice || {};
  const costs = [];
  for (const model of models) {
    const d = model.deployment;
    if (!d || !d.machines || !d.tps) continue;
    const cardWeight = Number(cardPrice[d.deviceType] || 1);
    const hardwareWeight = Number(d.machines) * (Number(d.cardsPerMachine) || 1) * cardWeight;
    const unitCost = hardwareWeight / Number(d.tps);
    costs.push({ id: model.id, unitCost });
  }
  if (!costs.length) return null;
  const max = Math.max(...costs.map((c) => c.unitCost));
  if (!(max > 0)) return null;
  const result = {};
  for (const c of costs) result[c.id] = Number((c.unitCost / max).toFixed(3));
  return result;
}

//平台侧成本指数（成本双指标之二）：与用户侧结算价（pricing 口径 costIndex）分开，
//度量平台自有算力的资源消耗强度 = 单位吞吐占用的硬件资源（机数×卡数×卡价权重 / 单实例吞吐）。
//用户侧看豆价（每豆换多少 token），平台侧看卡（同样吞吐谁吃卡少）；两者背离正是调度要同时管的事。
export function computeCostIndexProvider(models, costModel) {
  const cardPrice = costModel?.cardPrice || {};
  const costs = [];
  for (const model of models) {
    const d = model.deployment;
    if (!d || !d.machines || !d.tps) continue;
    const cardWeight = Number(cardPrice[d.deviceType] || 1);
    const hardwareWeight = Number(d.machines) * (Number(d.cardsPerMachine) || 1) * cardWeight;
    costs.push({ id: model.id, unitCost: hardwareWeight / Number(d.tps) });
  }
  if (costs.length < 2) return null;
  const anchor = Math.max(...costs.map((c) => c.unitCost));
  if (!(anchor > 0)) return null;
  const result = {};
  for (const c of costs) result[c.id] = Number(Math.min(1, (c.unitCost / anchor)).toFixed(3));
  return result;
}

export async function loadConfig() {
  const raw = await readFile(configPath(), 'utf8');
  const config = validateConfig(JSON.parse(raw));
  if (config.costModel?.enabled) {
    const source = config.costModel.source || 'deployment';
    const computed = source === 'pricing'
      ? computeCostIndexFromPricing(config.models, config.costModel)
      : computeCostIndex(config.models, config.costModel);
    if (computed) {
      for (const model of config.models) {
        if (computed[model.id] != null) model.costIndex = computed[model.id];
      }
    }
    //平台侧成本指数独立于 costModel.source：无论用户侧走 pricing 还是 deployment 口径，
    //只要模型有部署数据就计算 provider 指数（权重 providerCostWeight=0 时不影响评分，仅展示）
    const providerIndex = computeCostIndexProvider(config.models, config.costModel);
    if (providerIndex) {
      for (const model of config.models) {
        if (providerIndex[model.id] != null) model.costIndexProvider = providerIndex[model.id];
      }
    }
  }
  config.version = SOFTWARE_VERSION;
  return config;
}

let saveChain = Promise.resolve();
let historyCounter = 0;  //history 备份文件名唯一性计数器（时间戳可能同毫秒碰撞）

export function saveConfig(config) {
  //串行化：并发 saveConfig 排队执行，避免写同一个 temp 文件互相覆盖
  const task = saveChain.then(() => persistConfig(config), () => persistConfig(config));
  saveChain = task.catch(() => {});  //单次失败不阻塞后续保存
  return task;
}

async function persistConfig(config) {
  validateConfig(config);
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  const next = { ...config, version: SOFTWARE_VERSION };
  try {
    const previous = await readFile(path, 'utf8');
    const historyDir = resolve(dirname(path), 'history');
    await mkdir(historyDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    historyCounter += 1;
    await writeFile(resolve(historyDir, `router-${stamp}-${historyCounter}.json`), previous, { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  //唯一 temp 文件名（pid + 时间戳），避免并发 rename 冲突
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, path);
  return next;
}
