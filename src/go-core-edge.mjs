import { request, Agent } from 'node:http';
import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { createAnswerCollector, extractNonStreamAnswerText } from './judge.mjs';
import { createStreamTimingObserver } from './response-timing.mjs';

const MAX_BODY = 2 * 1024 * 1024;
const equal = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const loopback = address => address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
const amount = v => v === null || (Number.isSafeInteger(v) && v >= 0);

function validateEvent(event, slot) {
  const a = event?.attempt, d = event?.decision;
  if (event.configRevision !== slot.revision || !a || !d || !event.analysis || !event.decisionAnalysis ||
      !Number.isInteger(a.index) || a.index < 0 || a.index > 15 || !slot.models.has(a.model) || typeof a.ok !== 'boolean' ||
      !Number.isInteger(a.upstreamStatus) || a.upstreamStatus < 0 || a.upstreamStatus > 599 ||
      !Number.isFinite(a.latencyMs) || a.latencyMs < 0 || !amount(a.estimatedMicros) || !amount(a.actualMicros) ||
      !Array.isArray(d.candidates) || !Array.isArray(d.rejected) || !Array.isArray(d.fallbackOrder) ||
      !slot.models.has(d.selectedModel) || !slot.models.has(d.suggestedModel) ||
      !['off', 'standard', 'high'].includes(d.reasoningLevel) || typeof event.decisionAnalysis.task !== 'string') {
    throw new Error('invalid_core_event');
  }
}

// Public auth/CORS/body validation stay in server.mjs. This opt-in bridge has no
// fallback to the Node router: once Go has sent upstream bytes, retrying the whole
// request could duplicate both a model invocation and its charge.
export function createGoCoreEdge(env = process.env) {
  if (!env.AMR_GO_CHAT_URL) return null;
  const endpoint = new URL(env.AMR_GO_CHAT_URL);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port ||
      endpoint.pathname !== '/v1/chat/completions' || endpoint.search || endpoint.hash || endpoint.username || endpoint.password ||
      typeof env.AMR_GO_EDGE_TOKEN !== 'string' || env.AMR_GO_EDGE_TOKEN.length < 32) {
    throw new Error('Go chat edge requires fixed loopback completion URL and protected edge token');
  }
  const token = env.AMR_GO_EDGE_TOKEN;
  const agent = new Agent({ keepAlive: true, maxSockets: 256, maxFreeSockets: 32 });
  const pending = new Map();
  const semanticPending = new Map(), semanticDone = new Map();
  let completing = 0;

  async function accept(req, res) {
    if (!loopback(req.socket.remoteAddress) || !equal(req.headers.authorization, `Bearer ${token}`)) {
      res.writeHead(403); res.end(); return;
    }
    if (req.method !== 'POST' || req.url !== '/internal/v1/go-events') { res.writeHead(404); res.end(); return; }
    let bytes = 0; const chunks = [];
    try {
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > MAX_BODY) { res.writeHead(413); res.end(); return; }
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks), event = JSON.parse(raw);
      const digest = createHash('sha256').update(raw).digest('hex');
      if (event.kind === 'semantic') {
        const slot = pending.get(event.id) || semanticPending.get(event.id);
        const prior = slot?.semantic || semanticDone.get(event.id);
        if (prior) {
          if (prior.digest !== digest) { res.writeHead(409); res.end(); return; }
          await prior.task; res.writeHead(204); res.end(); return;
        }
        const review = event.review;
        if (!slot) { res.writeHead(410); res.end(); return; }
        if (event.configRevision !== slot.revision || !review ||
            !['error', 'shadow_complete', 'applied', 'rejected_low_confidence', 'shadow_capacity_exhausted'].includes(review.status) ||
            !Number.isFinite(review.confidence) || review.confidence < 0 || review.confidence > 1 || !amount(review.overheadMicros)) {
          res.writeHead(422); res.end(); return;
        }
        completing++;
        const task = Promise.resolve().then(() => slot.onSemantic?.(event, slot.semanticMetadata)).finally(() => { completing--; });
        slot.semantic = { digest, task };
        semanticDone.set(event.id, slot.semantic);
        if (semanticDone.size > 4096) semanticDone.delete(semanticDone.keys().next().value);
        semanticPending.delete(event.id);
        await task; res.writeHead(204); res.end(); return;
      }
      const slot = pending.get(event.id);
      if (!slot) { res.writeHead(410); res.end(); return; }
      validateEvent(event, slot);
      const prior = slot.events.get(event.attempt.index);
      if (prior && prior.digest !== digest) { res.writeHead(409); res.end(); return; }
      if (!prior) {
        const task = Promise.resolve().then(() => slot.onAttempt(event));
        // Insert before awaiting: retries/concurrent duplicates share one effect.
        slot.events.set(event.attempt.index, { digest, event, task });
      }
      await slot.events.get(event.attempt.index).task;
      slot.wake?.();
      res.writeHead(204); res.end();
    } catch {
      if (!res.headersSent) res.writeHead(422);
      res.end();
    }
  }

  async function proxy(req, res, body, options) {
    for (const [id, slot] of semanticPending) if (Date.now() - slot.at > 300000) semanticPending.delete(id);
    if (pending.size >= 256 || semanticPending.size >= 256) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'go_edge_capacity_exhausted', message: '请求并发已满，请稍后重试' } }));
      return;
    }
    const id = randomUUID(), startedAt = Date.now();
    const slot = { revision: options.configRevision, models: new Set(options.models), events: new Map(), onAttempt: options.onAttempt,
      onSemantic: options.onSemantic, semanticMetadata: options.semanticMetadata };
    pending.set(id, slot);
    const payload = JSON.stringify({ ...body, __amr_edge: {
      id, requestId: String(req.requestId).slice(0, 256), configRevision: slot.revision, marketSignals: options.marketSignals
    } });
    const collector = createAnswerCollector(65536), timing = createStreamTimingObserver(startedAt);
    const stream = body.stream === true;
    let outgoing, upstream, responseComplete = false, delivered = false, error = null, headerLatencyMs = null, answerText = null;
    let clientGone = Boolean(res.destroyed);
    const closed = () => {
      if (!res.writableFinished) { clientGone = true; outgoing?.destroy(); upstream?.destroy(); }
    };
    res.once('close', closed);
    try {
      if (clientGone) throw new Error('client_disconnected');
      upstream = await new Promise((resolve, reject) => {
        outgoing = request(endpoint, { method: 'POST', agent, headers: {
          authorization: req.headers.authorization, 'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload), 'x-amr-edge-token': token,
          ...(req.headers['x-session-id'] ? { 'x-session-id': req.headers['x-session-id'] } : {})
        } }, resolve);
        outgoing.setTimeout(options.timeoutMs || 120000, () => outgoing.destroy(new Error('go_core_timeout')));
        outgoing.on('error', reject);
        outgoing.end(payload);
      });
      headerLatencyMs = Date.now() - startedAt;
      const headers = { 'content-type': upstream.headers['content-type'] || 'application/json', 'cache-control': 'no-cache' };
      for (const [name, value] of Object.entries(upstream.headers)) {
        if (name.startsWith('x-router-') || name === 'retry-after') headers[name] = value;
      }
      const responseChunks = []; let responseBytes = 0;
      const successStream = stream && upstream.statusCode >= 200 && upstream.statusCode < 300;
      if (successStream) res.writeHead(upstream.statusCode, headers);
      for await (const chunk of upstream) {
        if (clientGone) throw new Error('client_disconnected');
        if (successStream) {
          collector.push(chunk); timing.push(chunk);
          if (!res.write(chunk)) await new Promise((resolve, reject) => {
            const cleanup = () => { res.off('drain', drained); res.off('close', failed); res.off('error', failed); };
            const drained = () => { cleanup(); resolve(); };
            const failed = () => { cleanup(); reject(new Error('client_disconnected')); };
            res.once('drain', drained); res.once('close', failed); res.once('error', failed);
          });
        } else {
          responseBytes += chunk.length;
          if (responseBytes > MAX_BODY) throw new Error('go_core_response_limit');
          responseChunks.push(chunk);
        }
      }
      responseComplete = upstream.complete;
      if (!responseComplete) throw new Error('go_core_incomplete');
      if (successStream) { timing.finish(); answerText = collector.text(); }
      else {
        const raw = Buffer.concat(responseChunks);
        if (upstream.statusCode >= 200 && upstream.statusCode < 300) answerText = extractNonStreamAnswerText(raw.toString('utf8'));
        res.writeHead(upstream.statusCode, headers);
        res.write(raw);
      }
      delivered = true;
      await new Promise(resolve => {
        const done = () => { res.off('close', done); resolve(); };
        res.once('close', done); res.end(done);
      });
    } catch (e) {
      error = clientGone ? 'client_disconnected' : 'go_core_unavailable';
      outgoing?.destroy(); upstream?.destroy();
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: error, message: '请求处理未完成，请稍后重试' } }));
      } else if (!res.writableFinished) res.destroy();
    } finally {
      res.off('close', closed);
      // On cancellation, Go settles the interrupted attempt independently of the
      // cancelled socket and reports it here. Bound that grace period and memory.
      if (!responseComplete && slot.events.size === 0 && outgoing) await new Promise(resolve => {
        const timer = setTimeout(resolve, 4500);
        slot.wake = () => { clearTimeout(timer); resolve(); };
      });
      await Promise.allSettled([...slot.events.values()].map(v => v.task));
      const events = [...slot.events.values()].sort((a, b) => a.event.attempt.index - b.event.attempt.index).map(v => v.event);
      const last = events.at(-1);
      if (!slot.semantic && ['shadow_pending', 'rollout_hold'].includes(last?.semanticStatus)) {
        // Retain only redacted correlation metadata, never the body, caller
        // credential, response bytes or request/response objects after delivery.
        semanticPending.set(id, { revision: slot.revision, onSemantic: slot.onSemantic,
          semanticMetadata: slot.semanticMetadata, at: Date.now() });
      }
      completing++;
      pending.delete(id);
      try { await options.onComplete({ events, last, startedAt, headerLatencyMs, timing: timing.snapshot(), answerText,
        ok: Boolean(delivered && responseComplete && res.writableFinished && upstream?.statusCode >= 200 && upstream?.statusCode < 300 && last?.attempt.ok),
        error, clientGone, stream, status: upstream?.statusCode || 502 }); } finally { completing--; }
    }
  }
  async function drain(timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while ((pending.size || semanticPending.size || completing) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return pending.size + semanticPending.size + completing;
  }
  return { accept, proxy, drain, close: () => agent.destroy(), pending: () => pending.size };
}
