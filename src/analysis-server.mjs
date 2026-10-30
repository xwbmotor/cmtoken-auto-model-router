// Independent analysis-only entrypoint. Never import server.mjs here: the normal
// gateway owns forwarding, receipt persistence, semantic/Judge and background jobs.
import http from 'node:http';
import { Worker } from 'node:worker_threads';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { loadConfig, getConfigRevision } from './config.mjs';
import { autoModelId } from './router.mjs';
import { createRateLimiter } from './rate-limiter.mjs';

const MODEL_ID = /^[A-Za-z0-9._:/-]{1,128}$/;
const own = (x, key) => Object.prototype.hasOwnProperty.call(x, key);
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const digest = x => createHash('sha256').update(x).digest();
class AnalysisError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const fail = (status, code) => { throw new AnalysisError(status, code); };
function integer(value, fallback, min, max) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error('invalid_analysis_limits');
  return n;
}

export function validateAnalysisBody(body, { allowHistory = false, maxMessages = 32, maxMessageChars = 65536 } = {}) {
  if (!record(body) || Object.keys(body).some(k => !['messages', 'model', 'availableModelIds'].includes(k))) fail(400, 'invalid_request');
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > (allowHistory ? maxMessages : 1)) fail(400, 'invalid_messages');
  for (const m of body.messages) {
    if (!record(m) || Object.keys(m).some(k => !['role', 'content'].includes(k)) ||
      !['user', ...(allowHistory ? ['assistant'] : [])].includes(m.role) ||
      typeof m.content !== 'string' || !m.content.trim() || m.content.length > maxMessageChars) fail(400, 'invalid_messages');
  }
  if (body.messages.at(-1).role !== 'user') fail(400, 'invalid_messages');
  if (own(body, 'model') && (typeof body.model !== 'string' || !MODEL_ID.test(body.model))) fail(400, 'invalid_model');
  if (own(body, 'availableModelIds') && (!Array.isArray(body.availableModelIds) ||
    body.availableModelIds.length > 256 || body.availableModelIds.some(id => typeof id !== 'string' || !MODEL_ID.test(id)))) fail(400, 'invalid_model_scope');
  return body;
}

// No /models lookup: gateway scope resolution intentionally has fail-open behavior
// for normal forwarding, which must not be reused at this restricted boundary.
function resolveScope(body, config, approved) {
  const known = new Set(config.models.map(m => m.id));
  const requested = body.availableModelIds;
  const allowed = requested === undefined ? [...approved] : [...new Set(requested)].filter(id => approved.has(id));
  const unknown = requested === undefined ? [] : [...new Set(requested)].filter(id => !known.has(id));
  if (!allowed.length) fail(400, 'no_available_models');
  if (body.model && body.model !== autoModelId(config)) {
    const model = config.models.find(m => m.id === body.model && m.enabled === true && m.ownership !== 'unknown');
    if (!model) fail(400, 'invalid_model');
    if (!allowed.includes(body.model)) fail(403, 'not_entitled');
    return { allowed: [body.model], unknown };
  }
  return { allowed, unknown };
}

function readBody(req, signal, maxBytes) {
  return new Promise((resolveBody, reject) => {
    let chunks = [], size = 0;
    const finish = (error, result) => {
      req.off('data', onData); req.off('end', onEnd); req.off('aborted', onAborted); req.off('error', onError);
      signal.removeEventListener('abort', onAbort); chunks = [];
      error ? reject(error) : resolveBody(result);
    };
    const onData = chunk => {
      size += chunk.length;
      if (size > maxBytes) { req.pause(); finish(new AnalysisError(413, 'request_too_large')); }
      else chunks.push(chunk);
    };
    const onEnd = () => {
      let body;
      try { body = JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
      catch { finish(new AnalysisError(400, 'invalid_json')); return; }
      finish(null, body);
    };
    const onAborted = () => finish(new AnalysisError(400, 'request_aborted'));
    const onError = () => finish(new AnalysisError(400, 'request_aborted'));
    const onAbort = () => { req.pause(); finish(signal.reason); };
    if (signal.aborted) { reject(signal.reason); return; }
    req.on('data', onData); req.once('end', onEnd); req.once('aborted', onAborted); req.once('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function calculate(body, config, allowedModelIds, signal) {
  return new Promise((resolveDecision, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const worker = new Worker(new URL('./analysis-worker.mjs', import.meta.url), {
      workerData: { body, config, allowedModelIds }, env: {}, execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 4 }, stdout: true, stderr: true
    });
    // No worker output may contain inputs. Drain it without forwarding or retaining it.
    worker.stdout.resume(); worker.stderr.resume();
    let settled = false;
    const finish = async (error, value) => {
      if (settled) return; settled = true;
      signal.removeEventListener('abort', onAbort);
      await worker.terminate().catch(() => {});
      error ? reject(error) : resolveDecision(value);
    };
    const onAbort = () => { void finish(signal.reason); };
    signal.addEventListener('abort', onAbort, { once: true });
    worker.once('message', m => {
      if (!m?.ok) void finish(new AnalysisError(m?.code === 'model_capacity_exhausted' ? 503 : 422, m?.code || 'no_candidates'));
      else void finish(null, m.decision);
    });
    worker.once('error', () => { void finish(new AnalysisError(503, 'analysis_unavailable')); });
    worker.once('exit', () => { if (!settled) void finish(new AnalysisError(503, 'analysis_unavailable')); });
  });
}

export function createAnalysisServer({ config, accessKey, allowedModelIds, allowHistory = false,
  timeoutMs = 5000, maxBodyBytes = 2 * 1024 * 1024, maxMessages = 32, maxMessageChars = 65536,
  maxConcurrent = 8, rpm = 120, burst = 30, audit = () => {} } = {}) {
  if (typeof accessKey !== 'string' || accessKey.length < 32 || accessKey.length > 512 || /\s/.test(accessKey)) throw new Error('analysis_access_key_required_minimum_32_characters');
  if (!config || !Array.isArray(config.models) || config.models.length > 256 || !config.taskRules || !config.routing) throw new Error('invalid_analysis_config');
  timeoutMs = integer(timeoutMs, 5000, 50, 5000);
  maxBodyBytes = integer(maxBodyBytes, 2 * 1024 * 1024, 256, 2 * 1024 * 1024);
  maxMessages = integer(maxMessages, 32, 1, 32);
  maxMessageChars = integer(maxMessageChars, 65536, 1, 65536);
  maxConcurrent = integer(maxConcurrent, 8, 1, 64);
  rpm = integer(rpm, 120, 1, 60000); burst = integer(burst, 30, 1, 10000);
  if (typeof allowHistory !== 'boolean' || typeof audit !== 'function') throw new Error('invalid_analysis_options');
  const revision = getConfigRevision(config) || `"${createHash('sha256').update(JSON.stringify(config)).digest('hex')}"`;
  // Freeze a private snapshot at creation. There is no HTTP reload/config write API.
  const policy = structuredClone(Object.fromEntries(['models', 'routing', 'taskRules', 'reasoningControl', 'budget', 'version']
    .filter(k => config[k] !== undefined).map(k => [k, config[k]])));
  const eligible = policy.models.filter(m => m.enabled === true && m.ownership !== 'unknown').map(m => m.id);
  if (eligible.some(id => !MODEL_ID.test(id))) throw new Error('invalid_analysis_model_id');
  if (allowedModelIds !== undefined && (!Array.isArray(allowedModelIds) || !allowedModelIds.length ||
    allowedModelIds.some(id => !eligible.includes(id)))) throw new Error('invalid_analysis_approved_models');
  const approved = new Set(allowedModelIds === undefined ? eligible : allowedModelIds);
  if (!approved.size) throw new Error('analysis_has_no_approved_models');
  const keyHash = digest(accessKey);
  const limiter = createRateLimiter({ rpm, burst });
  const totals = { received: 0, accepted: 0, completed: 0, rejected: 0, timedOut: 0, auditErrors: 0 };
  const active = new Set();
  const emit = event => {
    try { audit(event); return true; }
    catch { totals.auditErrors++; return false; }
  };
  const server = http.createServer({ maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout: 0,
    connectionsCheckingInterval: 1000 }, async (req, res) => {
    const requestId = randomUUID(), began = performance.now();
    let controller, deadline, status = 500, code = 'internal_error', result, responseBody;
    const send = (httpStatus, payload) => {
      status = httpStatus;
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(httpStatus, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff', connection: 'close' });
      if (!req.complete) res.once('finish', () => req.destroy());
      res.end(JSON.stringify(payload));
    };
    // Complete the synchronous metadata handoff before acknowledging a decision.
    // On backpressure/failure, return 503 instead of silently losing a sample.
    const respond = (httpStatus, payload) => { status = httpStatus; responseBody = payload; };
    if (req.method === 'GET' && ['/health', '/health/ready'].includes(req.url)) {
      send(200, { status: 'ok', role: 'analysis-only', auditErrors: totals.auditErrors }); return;
    }
    totals.received++;
    try {
      if (req.url !== '/v1/decide') fail(404, 'not_found');
      if (req.method !== 'POST') fail(405, 'method_not_allowed');
      if (!limiter.check('analysis').allowed) fail(429, 'rate_limited');
      const authorization = req.headers.authorization;
      const duplicates = req.rawHeaders.filter((v, i) => i % 2 === 0 && v.toLowerCase() === 'authorization').length;
      if (duplicates !== 1 || typeof authorization !== 'string' || !authorization.startsWith('Bearer ') ||
        !timingSafeEqual(keyHash, digest(authorization.slice(7)))) fail(401, 'unauthorized');
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) fail(415, 'unsupported_media_type');
      if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') fail(415, 'unsupported_content_encoding');
      if (req.headers['content-length'] && Number(req.headers['content-length']) > maxBodyBytes) fail(413, 'request_too_large');
      if (active.size >= maxConcurrent) fail(503, 'analysis_capacity_exhausted');
      controller = new AbortController(); active.add(controller); totals.accepted++;
      const disconnected = () => { if (!res.writableEnded) controller.abort(new AnalysisError(400, 'request_aborted')); };
      res.once('close', disconnected);
      deadline = setTimeout(() => controller.abort(new AnalysisError(408, 'analysis_timeout')), timeoutMs);
      const body = validateAnalysisBody(await readBody(req, controller.signal, maxBodyBytes), { allowHistory, maxMessages, maxMessageChars });
      const scope = resolveScope(body, policy, approved);
      const decision = await calculate(body, policy, scope.allowed, controller.signal);
      if (controller.signal.aborted) throw controller.signal.reason;
      result = { requestId, policyRevision: revision, ...decision,
        modelScope: { availableModelIds: scope.allowed, unknownModelIds: scope.unknown },
        observation: { mode: 'analysis-only', classifier: 'rules', inputScope: allowHistory ? 'text-history' : 'single-user-text',
          inferenceExecuted: false, qualityOutcomeObserved: false, contentStored: false,
          coverageScope: 'received-analysis-requests',
          latencyMs: Number((performance.now() - began).toFixed(2)) } };
      code = 'ok'; totals.completed++; respond(200, result);
    } catch (error) {
      const safe = error instanceof AnalysisError ? error : new AnalysisError(500, 'internal_error');
      code = safe.code; totals.rejected++; if (code === 'analysis_timeout') totals.timedOut++;
      respond(safe.status, { requestId, error: { code, message: code } });
    } finally {
      if (deadline) clearTimeout(deadline);
      if (controller) active.delete(controller);
      const event = { schemaVersion: 1, at: new Date().toISOString(), event: 'analysis_request', requestId, status, code,
        latencyMs: Number((performance.now() - began).toFixed(2)), policyRevision: revision,
        coverage: { ...totals, active: active.size } };
      // Metadata only. Caller-provided model/unknown IDs and all request fields are
      // intentionally absent from audit; model references in decision are trusted config.
      if (result) { const { requestId: ignored, modelScope, ...metadata } = result; event.result = metadata; }
      if (!emit(event)) {
        if (result) { totals.completed--; totals.rejected++; }
        respond(503, { requestId, error: { code: 'audit_unavailable', message: 'audit_unavailable' } });
      }
      send(status, responseBody);
    }
  });
  server.maxHeadersCount = 24;
  server.maxConnections = maxConcurrent * 4 + 16;
  server.keepAliveTimeout = 1000;
  server.on('clientError', (_error, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
  server.analysisSnapshot = () => ({ ...totals, active: active.size, role: 'analysis-only' });
  server.closeAnalysis = async () => {
    for (const controller of active) controller.abort(new AnalysisError(503, 'analysis_unavailable'));
    server.closeAllConnections();
    await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  };
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const config = await loadConfig();
    const server = createAnalysisServer({ config, accessKey: process.env.ANALYSIS_ACCESS_KEY,
      allowedModelIds: process.env.ANALYSIS_ALLOWED_MODEL_IDS === undefined ? undefined : process.env.ANALYSIS_ALLOWED_MODEL_IDS.split(',').map(s => s.trim()),
      allowHistory: process.env.ANALYSIS_ALLOW_HISTORY === 'true',
      timeoutMs: process.env.ANALYSIS_TIMEOUT_MS, maxBodyBytes: process.env.ANALYSIS_MAX_BODY_BYTES,
      maxMessages: process.env.ANALYSIS_MAX_MESSAGES, maxMessageChars: process.env.ANALYSIS_MAX_MESSAGE_CHARS,
      maxConcurrent: process.env.ANALYSIS_MAX_CONCURRENT, rpm: process.env.ANALYSIS_RPM, burst: process.env.ANALYSIS_BURST,
      audit: event => {
        // A stalled collector must not create an unbounded in-process log queue.
        // Dropped events are reflected by auditErrors in subsequent coverage records.
        if (process.stdout.writableLength > 1024 * 1024) throw new Error('audit_backpressure');
        process.stdout.write(JSON.stringify(event) + '\n');
      } });
    const port = integer(process.env.ANALYSIS_PORT, 8792, 0, 65535);
    server.listen(port, process.env.ANALYSIS_HOST || '127.0.0.1', () => {
      process.stdout.write(JSON.stringify({ event: 'analysis_started', role: 'analysis-only', port: server.address().port }) + '\n');
    });
    server.on('error', () => { process.stderr.write('analysis_start_failed\n'); process.exitCode = 1; });
    for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => { void server.closeAnalysis(); });
  } catch {
    // Configuration messages may contain deployment details; use a fixed startup code.
    process.stderr.write('analysis_start_failed_check_key_config_and_limits\n'); process.exitCode = 1;
  }
}
