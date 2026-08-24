// 语义复核：provider 分发层。
// 合同：所有评估器（自训练小模型 / 轻量大模型 / 未来其他）都返回同一份 assessment：
//   { task, tier, complexity, confidence, reason }
// provider 由 config.semanticRouter.provider 选择：
//   - openai-chat：现有行为，用 chat-completions 模型 + 分类 prompt（向后兼容：无 provider 字段且有 model 时默认）
//   - http-json  ：POST 到自训练小模型的 HTTP 端点，直接返回合同 JSON
//   - cascade    ：级联复核——先问自训练小模型；小模型失败或自身置信度不足时升级 MaaS 大模型；
//                  大模型也不行才把错误抛给调用方（由上层退回规则层决策）。
//                  成本逻辑：大部分请求小模型能定，只有拿不准的少数才付大模型的调用成本。
//   - disabled   ：不复核（等价 semanticRouter.enabled=false，显式声明用）
import { classifierText, requestText } from './router.mjs';

const ALLOWED_TASKS = new Set(['default', 'coding', 'reasoning', 'creative', 'extraction']);
const ALLOWED_TIERS = new Set(['simple', 'balanced', 'complex']);

export function semanticProvider(config) {
  const policy = config.semanticRouter || {};
  if (policy.provider) return policy.provider;
  return policy.model ? 'openai-chat' : 'disabled';
}

export function shouldUseSemanticRouter(analysis, body, config) {
  const policy = config.semanticRouter;
  if (!policy?.enabled || semanticProvider(config) === 'disabled') return false;
  // v0.6.1 五审 P2：文本口径统一（L2/L3 与 L1 同口径）——分类输入不再包含 system/assistant
  const text = classifierText(body).trim();
  if (text.length < Number(policy.minCharacters || 12)) return false;
  return analysis.confidence < Number(policy.confidenceThreshold ?? 0.7);
}

export function parseSemanticAssessment(content) {
  const raw = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('语义分类器没有返回 JSON 对象');
  const value = JSON.parse(raw.slice(start, end + 1));
  if (!ALLOWED_TASKS.has(value.task)) throw new Error(`语义分类器 task 无效: ${value.task}`);
  if (!ALLOWED_TIERS.has(value.tier)) throw new Error(`语义分类器 tier 无效: ${value.tier}`);
  const complexity = Number(value.complexity);
  const confidence = Number(value.confidence);
  if (!Number.isFinite(complexity) || complexity < 0 || complexity > 1) throw new Error('语义分类器 complexity 必须在 0 到 1 之间');
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('语义分类器 confidence 必须在 0 到 1 之间');
  return {
    task: value.task,
    tier: value.tier,
    complexity: Number(complexity.toFixed(3)),
    confidence: Number(confidence.toFixed(3)),
    reason: String(value.reason || '').slice(0, 240)
  };
}

// —— provider: openai-chat（现状行为，向后兼容） ——
async function classifyViaOpenAIChat(body, config, options) {
  const policy = config.semanticRouter;
  const chat = policy.openaiChat || { model: policy.model };
  if (!chat.model) throw new Error('openai-chat 评估器缺少模型配置');
  const base = (options.baseUrl || config.upstreamBaseUrl).replace(/\/$/, '');
  if (!options.apiKey) throw new Error('语义分类器缺少上游 API Key');
  // v0.6.1 五审 P2：分类文本与 L1 同口径（user 为主，排除 system/assistant）——原 requestText
  // 会把 system 提示与 assistant 历史代码一并送分类，系统性拽向 coding
  const text = classifierText(body).slice(-Number(policy.maxInputCharacters || 6000));
  // v0.6.0：携带前级判断（cascade 升级时）。大模型复核不是盲判——小模型结论作为参照意见
  // 注入 prompt，明确「仅参考，可同意可推翻」；证明有效性的最终标准是决策日志对比。
  const prior = options.priorAssessment ? `\n\n小模型初判（仅参考，可同意可推翻）：{"task":"${options.priorAssessment.task}","tier":"${options.priorAssessment.tier}","confidence":${options.priorAssessment.confidence},"reason":"${(options.priorAssessment.reason || '').slice(0, 80)}"}` : '';
  const prompt = `你是模型路由分类器，只判断任务，不回答用户问题。\n\n任务类型只能是：default、coding、reasoning、creative、extraction。任务类型 task 含义：default=通用问答；coding=要求产出/修改/调试代码；reasoning=多步推理、方案权衡、根因分析；creative=创作文案故事；extraction=结构化提取转换。\n难度只能是：simple、balanced、complex。complexity 是 0 到 1；confidence 是你对分类的置信度。\n复杂架构、多目标权衡、长链条推理应提高难度；寒暄、直接事实、简单格式转换应降低难度。\n复杂任务低估的风险高于简单任务高估，证据不足时适度向上取整。\n注意：用户说「不要代码」时不是 coding；「什么是 X」概念解释、对已有材料的总结/翻译是 default 或 extraction，不是材料所属领域任务的请求。\n${prior}\n\n严格只输出 JSON：{"task":"...","tier":"...","complexity":0.0,"confidence":0.0,"reason":"不超过80字"}\n\n用户请求：\n${text}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('语义分类器超时')), Number(chat.timeoutMs || policy.timeoutMs || 3500));
  const started = Date.now();
  try {
    const response = await (options.fetchImpl || fetch)(`${base}/chat/completions`, {
      method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` },
      body: JSON.stringify({
        model: chat.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        max_tokens: Number(policy.maxOutputTokens || 180),
        response_format: policy.useJsonMode ? { type: 'json_object' } : undefined,
        stream: false
      })
    });
    if (!response.ok) throw new Error(`语义分类器返回 HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
    const payload = await response.json();
    const assessment = parseSemanticAssessment(payload?.choices?.[0]?.message?.content);
    // v0.6.1 五审 P1：提取大模型分类调用的真实 usage（原实现只取 choices——L3 升级产生的
    // 真实 token 费用从未进预算台账，shadow 阶段是「真实付费但不改路由」的隐藏成本）
    const u = payload?.usage;
    const overheadUsage = (u && Number.isFinite(u.prompt_tokens) && Number.isFinite(u.completion_tokens))
      ? { prompt: u.prompt_tokens, completion: u.completion_tokens }
      : null;
    return { ...assessment, provider: 'openai-chat', model: chat.model, latencyMs: Date.now() - started, ...(overheadUsage ? { overheadUsage } : {}) };
  } finally {
    clearTimeout(timer);
  }
}

// —— provider: http-json（自训练小模型端点） ——
// 端点契约：POST {text} → 200 {task,tier,complexity,confidence,reason}
// url 优先级：SEMANTIC_CLASSIFIER_URL 环境变量（compose 服务名）> config.semanticRouter.httpJson.url
async function classifyViaHttpJson(body, config, options) {
  const policy = config.semanticRouter;
  const endpoint = policy.httpJson || {};
  const url = process.env.SEMANTIC_CLASSIFIER_URL || endpoint.url;
  if (!url) throw new Error('http-json 评估器缺少 url 配置');
  // v0.6.1 五审 P2：同 openai-chat——分类文本与 L1 同口径（user 为主，排除 system/assistant）
  const text = classifierText(body).slice(-Number(policy.maxInputCharacters || 6000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('语义分类器超时')), Number(endpoint.timeoutMs || policy.timeoutMs || 2000));
  const started = Date.now();
  const headers = { 'content-type': 'application/json', ...(endpoint.token ? { authorization: `Bearer ${endpoint.token}` } : {}) };
  try {
    const response = await (options.fetchImpl || fetch)(url, {
      method: 'POST', signal: controller.signal, headers,
      body: JSON.stringify({ text })
    });
    if (!response.ok) throw new Error(`http-json 评估器返回 HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    const payload = await response.json();
    const assessment = parseSemanticAssessment(typeof payload === 'string' ? payload : JSON.stringify(payload));
    return { ...assessment, provider: 'http-json', latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

// —— provider: cascade（小模型 → 大模型级联） ——
// v0.6.0 三阈值语义拆分（四审：原 minConfidence 同时承担「升级线」与「采纳线」两语义）：
//   - smallAcceptThreshold（cascade 内）：小模型 confidence ≥ 此值直接采纳，否则升级大模型。
//     默认 0.7；兼容回退：未配置时读 minConfidence（0.5 旧默认语义=升级线），都无则 0.7。
//   - finalAdoptionThreshold（server 层，见 resolveAutoDecision）：语义复核最终结果的采纳线，
//     低于它退回规则层决策。默认读 minConfidence ?? 0（= 旧行为：一律采纳）。
//   minConfidence 保留为兼容别名，不再承担新语义；新配置只用上面两个明确命名的字段。
export function resolveSmallAcceptThreshold(policy = {}) {
  if (policy.smallAcceptThreshold !== undefined) return Number(policy.smallAcceptThreshold);
  if (policy.minConfidence !== undefined && Number(policy.minConfidence) > 0) return Number(policy.minConfidence);
  return 0.7;
}

export async function classifyViaCascade(body, config, options) {
  const policy = config.semanticRouter || {};
  const acceptThreshold = resolveSmallAcceptThreshold(policy);
  // 第一级：自训练小模型。失败或低置信都记录，但低置信时小模型的判断要带给大模型做参照
  let small = null;
  let smallError = null;
  const smallStarted = Date.now();
  try {
    small = await classifyViaHttpJson(body, config, options);
  } catch (error) {
    smallError = error;
  }
  const smallLatencyMs = Date.now() - smallStarted;
  if (small && Number(small.confidence) >= acceptThreshold) {
    return { ...small, cascade: { level: 'small', acceptThreshold, latencyMs: smallLatencyMs } };
  }
  // 第二级：升级 MaaS 大模型（小模型挂了兜底 / 小模型拿不准复核）。
  // v0.6.0：prompt 携带小模型判断（四审：原实现 smallAttempt 仅事后补日志元数据，
  // 大模型看不到小模型结论，复核等于盲判）；大模型挂时若小模型有产出则降级返回小模型
  // （degraded-small，由 server 按 finalAdoptionThreshold 决定采纳或退回规则层），双挂才抛。
  let escalated;
  const largeStarted = Date.now();
  try {
    escalated = await classifyViaOpenAIChat(body, config, { ...options, priorAssessment: small || null });
  } catch (largeError) {
    if (small) {
      return {
        ...small,
        provider: 'http-json',
        latencyMs: smallLatencyMs,
        cascade: { level: 'small-degraded', acceptThreshold, latencyMs: smallLatencyMs, largeError: String(largeError.message).slice(0, 200) }
      };
    }
    const merged = new Error(`级联复核两级均失败：小模型 ${smallError ? smallError.message : '低置信未采纳'}；大模型 ${largeError.message}`);
    merged.cause = largeError;
    throw merged;
  }
  const largeLatencyMs = Date.now() - largeStarted;
  const meta = { escalatedFrom: 'http-json', cascade: { level: 'large', acceptThreshold, latencyMs: largeLatencyMs, totalLatencyMs: smallLatencyMs + largeLatencyMs } };
  if (small) meta.smallAttempt = { task: small.task, tier: small.tier, confidence: small.confidence, latencyMs: smallLatencyMs };
  if (smallError) meta.smallError = String(smallError.message).slice(0, 200);
  return { ...escalated, ...meta };
}

// —— 分发入口：签名与原 classifySemantically 兼容 ——
export async function classifySemantically(body, config, options = {}) {
  const provider = semanticProvider(config);
  if (provider === 'http-json') return classifyViaHttpJson(body, config, options);
  if (provider === 'cascade') return classifyViaCascade(body, config, options);
  if (provider === 'disabled') throw new Error('语义复核 provider 已禁用');
  return classifyViaOpenAIChat(body, config, options);
}
