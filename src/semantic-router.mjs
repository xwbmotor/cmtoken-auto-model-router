// 语义复核：provider 分发层。
// 合同：所有评估器（自训练小模型 / 轻量大模型 / 未来其他）都返回同一份 assessment：
//   { task, tier, complexity, confidence, reason }
// provider 由 config.semanticRouter.provider 选择：
//   - openai-chat：现有行为，用 chat-completions 模型 + 分类 prompt（向后兼容：无 provider 字段且有 model 时默认）
//   - http-json  ：POST 到自训练小模型的 HTTP 端点，直接返回合同 JSON
//   - disabled   ：不复核（等价 semanticRouter.enabled=false，显式声明用）
import { requestText } from './router.mjs';

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
  const text = requestText(body).trim();
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
  const text = requestText(body).slice(-Number(policy.maxInputCharacters || 6000));
  const prompt = `你是模型路由分类器，只判断任务，不回答用户问题。\n\n任务类型只能是：default、coding、reasoning、creative、extraction。\n难度只能是：simple、balanced、complex。\ncomplexity 是 0 到 1；confidence 是你对分类的置信度。\n复杂架构、多目标权衡、长链条推理应提高难度；寒暄、直接事实、简单格式转换应降低难度。\n复杂任务低估的风险高于简单任务高估，证据不足时适度向上取整。\n\n严格只输出 JSON：{"task":"...","tier":"...","complexity":0.0,"confidence":0.0,"reason":"不超过80字"}\n\n用户请求：\n${text}`;
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
    return { ...assessment, provider: 'openai-chat', model: chat.model, latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

// —— provider: http-json（自训练小模型端点） ——
// 端点契约：POST {text} → 200 {task,tier,complexity,confidence,reason}
async function classifyViaHttpJson(body, config, options) {
  const policy = config.semanticRouter;
  const endpoint = policy.httpJson || {};
  if (!endpoint.url) throw new Error('http-json 评估器缺少 url 配置');
  const text = requestText(body).slice(-Number(policy.maxInputCharacters || 6000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('语义分类器超时')), Number(endpoint.timeoutMs || policy.timeoutMs || 2000));
  const started = Date.now();
  const headers = { 'content-type': 'application/json', ...(endpoint.token ? { authorization: `Bearer ${endpoint.token}` } : {}) };
  try {
    const response = await (options.fetchImpl || fetch)(endpoint.url, {
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

// —— 分发入口：签名与原 classifySemantically 兼容 ——
export async function classifySemantically(body, config, options = {}) {
  const provider = semanticProvider(config);
  if (provider === 'http-json') return classifyViaHttpJson(body, config, options);
  if (provider === 'disabled') throw new Error('语义复核 provider 已禁用');
  return classifyViaOpenAIChat(body, config, options);
}
