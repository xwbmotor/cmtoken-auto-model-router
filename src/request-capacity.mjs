// Provider-independent estimates, not tokenizer counts or hard quota guarantees.
// Classification uses separate user-only text; capacity and cost include the full request.
export function estimateInputTokens(text) {
  const value = String(text || '');
  const cjk = (value.match(/[\u3400-\u9fff]/g) || []).length;
  return Math.max(1, Math.ceil(cjk / 1.6 + (value.length - cjk) / 4));
}

export function estimateOutputTokens(body = {}, config = {}) {
  for (const value of [body.max_completion_tokens, body.max_tokens, config.budget?.defaultEstimatedOutputTokens]) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return Math.ceil(n);
  }
  return 800;
}

export function estimateRequestCapacity(body = {}, config = {}) {
  let unknownMediaParts = 0;
  const serialize = (value) => {
    if (Array.isArray(value)) return value.map(serialize);
    if (!value || typeof value !== 'object') return value;
    // Opaque media cannot be tokenized from its URL/base64 representation. Keep metadata
    // out of the text count and expose uncertainty; this allowance is not a provider limit.
    if (['image_url', 'input_image', 'input_audio', 'audio', 'video', 'video_url', 'file'].includes(value.type)) {
      unknownMediaParts += 1;
      return { type: value.type, media: '[opaque]' };
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serialize(item)]));
  };
  const input = {};
  for (const key of ['messages', 'tools', 'functions', 'tool_choice', 'function_call', 'response_format']) {
    if (body[key] !== undefined) input[key] = serialize(body[key]);
  }
  const estimatedMediaTokens = unknownMediaParts * 4096;
  const estimatedInputTokens = estimateInputTokens(JSON.stringify(input)) + estimatedMediaTokens;
  const estimatedOutputTokens = estimateOutputTokens(body, config);
  return {
    estimatedInputTokens,
    estimatedOutputTokens,
    estimatedContextTokens: estimatedInputTokens + estimatedOutputTokens,
    capacityEstimate: { method: 'heuristic', unknownMediaParts, estimatedMediaTokens }
  };
}
