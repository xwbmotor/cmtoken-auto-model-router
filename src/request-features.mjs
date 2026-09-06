import { createHash } from 'node:crypto';

// This schema is frozen. Changing names, order, or computation requires a new version.
export const ROUTING_FEATURE_VERSION = 'routing-request-v1';
export const ROUTING_FEATURE_NAMES = Object.freeze([
  'log_input_bytes', 'log_text_chars', 'log_estimated_input_tokens',
  'log_message_count', 'log_user_message_count', 'log_history_message_count',
  'log_system_chars', 'log_assistant_history_chars', 'log_tool_message_count',
  'log_tool_definition_count', 'log_tool_schema_bytes', 'log_prior_tool_call_count',
  'log_media_part_count', 'has_tools', 'has_json_response', 'requires_tool',
  'parallel_tool_calls', 'has_code_fence', 'code_symbol_ratio', 'digit_ratio',
  'cjk_ratio', 'latin_ratio', 'log_last_turn_chars', 'question_mark_ratio'
]);

export class RoutingRequestValidationError extends Error {
  constructor(path, message) {
    super(`${path}: ${message}`);
    this.name = 'RoutingRequestValidationError';
  }
}

function check(condition, path, message) {
  if (!condition) throw new RoutingRequestValidationError(path, message);
}

function object(value, path, allowed, required = []) {
  check(value != null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)), path, '必须是普通 JSON 对象');
  for (const key of Object.keys(value)) check(allowed.includes(key), `${path}.${key}`, '未支持的字段；不能静默移除输入、结果或标签');
  for (const key of required) check(Object.hasOwn(value, key), `${path}.${key}`, '缺少必填字段');
}

function string(value, path, nonempty = true) {
  check(typeof value === 'string' && (!nonempty || value.length > 0), path, '必须是字符串' + (nonempty ? '且非空' : ''));
}

function json(value, path, seen = new Set(), depth = 0) {
  check(depth <= 80, path, 'JSON 嵌套过深');
  if (value === null || ['string', 'boolean'].includes(typeof value)) return;
  if (typeof value === 'number') return check(Number.isFinite(value), path, 'JSON 数字必须有限');
  check(value && typeof value === 'object', path, '必须是 JSON 值，不能省略 undefined');
  check(!seen.has(value), path, 'JSON 不能有循环引用');
  check(Array.isArray(value) || [Object.prototype, null].includes(Object.getPrototypeOf(value)), path, '不支持非 JSON 对象');
  check(Object.getOwnPropertySymbols(value).length === 0, path, '不支持 Symbol 字段');
  seen.add(value);
  if (Array.isArray(value)) {
    check(Object.keys(value).length === value.length, path, '不支持稀疏数组或数组自定义字段');
    for (let i = 0; i < value.length; i += 1) json(value[i], `${path}[${i}]`, seen, depth + 1);
  } else {
    for (const [key, item] of Object.entries(value)) json(item, `${path}.${key}`, seen, depth + 1);
  }
  seen.delete(value);
}

function contentPart(part, path) {
  check(part && typeof part === 'object', path, '内容块必须是对象');
  if (part.type === 'text') {
    object(part, path, ['type', 'text'], ['type', 'text']);
    string(part.text, `${path}.text`, false);
  } else if (part.type === 'image_url') {
    object(part, path, ['type', 'image_url'], ['type', 'image_url']);
    object(part.image_url, `${path}.image_url`, ['url', 'detail'], ['url']);
    string(part.image_url.url, `${path}.image_url.url`);
    if (part.image_url.detail !== undefined) check(['auto', 'low', 'high'].includes(part.image_url.detail), `${path}.image_url.detail`, '必须是 auto/low/high');
  } else if (part.type === 'input_audio') {
    object(part, path, ['type', 'input_audio'], ['type', 'input_audio']);
    object(part.input_audio, `${path}.input_audio`, ['data', 'format'], ['data', 'format']);
    string(part.input_audio.data, `${path}.input_audio.data`);
    check(['wav', 'mp3'].includes(part.input_audio.format), `${path}.input_audio.format`, '仅支持 wav/mp3');
  } else if (part.type === 'file') {
    object(part, path, ['type', 'file'], ['type', 'file']);
    object(part.file, `${path}.file`, ['file_id', 'file_data', 'filename']);
    check(Number(Object.hasOwn(part.file, 'file_id')) + Number(Object.hasOwn(part.file, 'file_data')) === 1,
      `${path}.file`, '必须且只能提供 file_id 或 file_data');
    for (const [key, value] of Object.entries(part.file)) string(value, `${path}.file.${key}`);
  } else throw new RoutingRequestValidationError(`${path}.type`, '仅支持 text/image_url/input_audio/file 内容块');
}

function message(message, path) {
  object(message, path, ['role', 'content', 'name', 'tool_calls', 'tool_call_id'], ['role', 'content']);
  check(['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role), `${path}.role`, '不支持的消息角色');
  if (typeof message.content === 'string') string(message.content, `${path}.content`, false);
  else if (Array.isArray(message.content)) {
    check(message.content.length > 0, `${path}.content`, '内容块数组不能为空');
    message.content.forEach((part, i) => contentPart(part, `${path}.content[${i}]`));
  } else check(message.content === null && message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0,
    `${path}.content`, '仅历史 assistant 工具调用允许 null 正文');
  if (message.name !== undefined) string(message.name, `${path}.name`);
  if (message.tool_call_id !== undefined) {
    check(message.role === 'tool', `${path}.tool_call_id`, '仅 tool 消息接受 tool_call_id');
    string(message.tool_call_id, `${path}.tool_call_id`);
  }
  if (message.role === 'tool') string(message.tool_call_id, `${path}.tool_call_id`);
  if (message.tool_calls !== undefined) {
    check(message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0,
      `${path}.tool_calls`, '仅 assistant 历史接受非空工具调用数组');
    message.tool_calls.forEach((call, i) => {
      const p = `${path}.tool_calls[${i}]`;
      object(call, p, ['id', 'type', 'function'], ['id', 'type', 'function']);
      string(call.id, `${p}.id`);
      check(call.type === 'function', `${p}.type`, '仅支持 function 工具');
      object(call.function, `${p}.function`, ['name', 'arguments'], ['name', 'arguments']);
      string(call.function.name, `${p}.function.name`);
      string(call.function.arguments, `${p}.function.arguments`, false);
    });
  }
}

function validate(request) {
  json(request, 'request');
  object(request, 'request', ['messages', 'tools', 'tool_choice', 'parallel_tool_calls', 'response_format'], ['messages']);
  check(Array.isArray(request.messages) && request.messages.length > 0, 'request.messages', '需要非空 messages');
  request.messages.forEach((item, i) => message(item, `request.messages[${i}]`));
  check(request.messages.some((item) => item.role === 'user'), 'request.messages', '至少需要一条 user 消息');
  check(['user', 'tool'].includes(request.messages.at(-1).role), 'request.messages', '必须停在请求的 user/tool 轮；不接受最后一条 assistant 作答或前缀');
  if (request.tools !== undefined) {
    check(Array.isArray(request.tools), 'request.tools', '必须是数组');
    const names = new Set();
    request.tools.forEach((tool, i) => {
      const p = `request.tools[${i}]`;
      object(tool, p, ['type', 'function'], ['type', 'function']);
      check(tool.type === 'function', `${p}.type`, '仅支持 function 工具');
      object(tool.function, `${p}.function`, ['name', 'description', 'parameters', 'strict'], ['name']);
      string(tool.function.name, `${p}.function.name`);
      check(!names.has(tool.function.name), `${p}.function.name`, '工具名重复');
      names.add(tool.function.name);
      if (tool.function.description !== undefined) string(tool.function.description, `${p}.function.description`, false);
      if (tool.function.parameters !== undefined) check(tool.function.parameters && typeof tool.function.parameters === 'object' && !Array.isArray(tool.function.parameters), `${p}.function.parameters`, 'JSON Schema 必须是对象');
      if (tool.function.strict !== undefined) check(typeof tool.function.strict === 'boolean', `${p}.function.strict`, '必须是布尔值');
    });
  }
  if (request.tool_choice !== undefined) {
    const choice = request.tool_choice;
    if (typeof choice === 'string') check(['none', 'auto', 'required'].includes(choice), 'request.tool_choice', '必须是 none/auto/required 或具名 function');
    else {
      object(choice, 'request.tool_choice', ['type', 'function'], ['type', 'function']);
      check(choice.type === 'function', 'request.tool_choice.type', '仅支持 function');
      object(choice.function, 'request.tool_choice.function', ['name'], ['name']);
      string(choice.function.name, 'request.tool_choice.function.name');
      check(request.tools?.some((tool) => tool.function.name === choice.function.name), 'request.tool_choice', '具名工具必须在 tools 中声明');
    }
    if (choice !== 'none') check(request.tools?.length > 0, 'request.tool_choice', '需要至少一个工具定义');
  }
  if (request.parallel_tool_calls !== undefined) {
    check(typeof request.parallel_tool_calls === 'boolean', 'request.parallel_tool_calls', '必须是布尔值');
    check(request.tools?.length > 0, 'request.parallel_tool_calls', '需要至少一个工具定义');
  }
  if (request.response_format !== undefined) {
    const format = request.response_format;
    object(format, 'request.response_format', ['type', 'json_schema'], ['type']);
    check(['text', 'json_object', 'json_schema'].includes(format.type), 'request.response_format.type', '仅支持 text/json_object/json_schema');
    if (format.type === 'json_schema') {
      object(format.json_schema, 'request.response_format.json_schema', ['name', 'description', 'schema', 'strict'], ['name', 'schema']);
      string(format.json_schema.name, 'request.response_format.json_schema.name');
      check(format.json_schema.schema && typeof format.json_schema.schema === 'object' && !Array.isArray(format.json_schema.schema), 'request.response_format.json_schema.schema', 'JSON Schema 必须是对象');
      if (format.json_schema.description !== undefined) string(format.json_schema.description, 'request.response_format.json_schema.description', false);
      if (format.json_schema.strict !== undefined) check(typeof format.json_schema.strict === 'boolean', 'request.response_format.json_schema.strict', '必须是布尔值');
    } else check(!Object.hasOwn(format, 'json_schema'), 'request.response_format.json_schema', '此类型不接受 json_schema');
  }
}

// Preserve every accepted field and array order. No defaults or text normalization.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function routingInputHash(request) {
  validate(request);
  return createHash('sha256').update(canonical(request), 'utf8').digest('hex');
}

function textOf(message) {
  if (typeof message.content === 'string') return message.content;
  return Array.isArray(message.content) ? message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n') : '';
}

export function extractRoutingFeatures(request) {
  validate(request);
  const messages = request.messages, texts = messages.map(textOf), text = texts.join('\n');
  const length = [...text].length;
  const count = (pattern) => (text.match(pattern) || []).length;
  const cjk = count(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu);
  const tools = request.tools || [];
  const schemaBytes = Buffer.byteLength(canonical({ tools, response_format: request.response_format ?? null }));
  const toolCalls = messages.flatMap((item) => item.tool_calls || []);
  const mediaCount = messages.reduce((n, item) => n + (Array.isArray(item.content) ? item.content.filter((part) => part.type !== 'text').length : 0), 0);
  const estimatedTokens = cjk + Math.ceil((length - cjk) / 4) + Math.ceil(schemaBytes / 4) + Math.ceil(Buffer.byteLength(canonical(toolCalls)) / 4) + messages.length * 4 + mediaCount * 4096;
  const charsFor = (roles) => texts.reduce((n, value, i) => n + (roles.includes(messages[i].role) ? [...value].length : 0), 0);
  const log = Math.log1p, ratio = (n) => length ? n / length : 0;
  const features = [
    log(Buffer.byteLength(canonical(request))), log(length), log(estimatedTokens),
    log(messages.length), log(messages.filter((item) => item.role === 'user').length), log(messages.length - 1),
    log(charsFor(['system', 'developer'])), log(charsFor(['assistant'])), log(messages.filter((item) => item.role === 'tool').length),
    log(tools.length), log(schemaBytes), log(toolCalls.length), log(mediaCount),
    Number(tools.length > 0), Number(['json_object', 'json_schema'].includes(request.response_format?.type)),
    Number(request.tool_choice === 'required' || typeof request.tool_choice === 'object'), Number(request.parallel_tool_calls === true),
    Number(text.includes('```')), ratio(count(/[{}\[\]();=<>]/g)), ratio(count(/[0-9]/g)), ratio(cjk), ratio(count(/[A-Za-z]/g)),
    log([...texts.at(-1)].length), ratio(count(/[?？]/g))
  ];
  check(features.length === ROUTING_FEATURE_NAMES.length && features.every(Number.isFinite), 'features', '特征计算必须输出固定维度的有限数字');
  return features;
}
