// Opt-in migration control bridge. Caller authentication belongs to server.mjs.
// A fixed literal loopback destination and fixed paths prevent an admin proxy.
import { request } from 'node:http';
import { createSnapshotPublisher } from './go-runtime/publisher.mjs';
import { access } from 'node:fs/promises';

export function createGoCoreAdmin(env = process.env) {
  if (!env.AMR_GO_ADMIN_URL) return null;
  const endpoint = new URL(env.AMR_GO_ADMIN_URL);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port ||
      endpoint.pathname !== '/' || endpoint.search || endpoint.hash || endpoint.username || endpoint.password ||
      !env.ADMIN_TOKEN || !env.AMR_GO_ADMIN_TOKEN || env.AMR_GO_ADMIN_TOKEN.length < 16) {
    throw new Error('Go control bridge requires literal http://127.0.0.1:port, ADMIN_TOKEN and AMR_GO_ADMIN_TOKEN');
  }
  const token = env.AMR_GO_ADMIN_TOKEN;
  const call = (path, method = 'GET', revision, payload) => new Promise((resolve, reject) => {
    const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };
    if (revision) headers['if-match'] = revision;
    if (payload) headers['content-type'] = 'application/json';
    const req = request(new URL(path, endpoint), { method, headers, agent: false }, res => {
      let size = 0; const chunks = [];
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 65536) req.destroy(new Error('core_response_limit'));
        else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        try {
          // Never return arbitrary upstream bodies, errors, headers or credentials.
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (res.statusCode !== 200) return resolve({ status: [409, 422, 428].includes(res.statusCode) ? res.statusCode : 502, error: 'core_control_rejected' });
          if (typeof body.revision !== 'string' || !/^"[a-f0-9]{64}"$/.test(body.revision)) throw new Error('invalid_core_revision');
          if (path === '/internal/v1/probe/acquire' || path === '/internal/v1/probe/release') {
            if (path.endsWith('/acquire') && (typeof body.lease !== 'string' || !/^[a-f0-9]{64}$/.test(body.lease))) throw new Error('invalid_probe_lease');
            return resolve({ status: 200, ...(path.endsWith('/acquire') ? { lease: body.lease } : { released: body.released === true }) });
          }
          if (method === 'GET' && (typeof body.configRevision !== 'string' || !/^"[a-f0-9]{64}"$/.test(body.configRevision))) throw new Error('invalid_core_config_revision');
          if (path === '/internal/v1/status') {
            if (!body.health || !body.inflight || typeof body.persistenceHealthy !== 'boolean' || typeof body.edgeEnabled !== 'boolean' ||
                !Number.isSafeInteger(body.sessions) || body.sessions < 0 || !Number.isSafeInteger(body.edgeErrors) || body.edgeErrors < 0) throw new Error('invalid_core_status');
            const fields = ['consecutiveFailures', 'successes', 'failures', 'ewmaLatencyMs', 'circuitOpenUntil', 'lastSuccessAt', 'downSince', 'halfOpenFailStreak', 'lastFailureAt'];
            const health = Object.fromEntries(Object.entries(body.health).map(([id, value]) => {
              if (!['closed', 'open', 'half_open'].includes(value.circuitState) || fields.some(k => !Number.isFinite(value[k]) || value[k] < 0)) throw new Error('invalid_core_health');
              return [id, { circuitState: value.circuitState, probeInFlight: value.probeInFlight === true, ...Object.fromEntries(fields.map(k => [k, value[k]])) }];
            }));
            const inflight = Object.fromEntries(Object.entries(body.inflight).map(([id, count]) => {
              if (!Number.isInteger(count) || count < 0 || count > 10000) throw new Error('invalid_core_load');
              return [id, { inflight: count }];
            }));
            const pending = {};
            for (const key of ['activeRequests', 'backgroundReviews']) {
              if (body[key] !== undefined) {
                if (!Number.isSafeInteger(body[key]) || body[key] < 0 || body[key] > 100000) throw new Error('invalid_core_pending');
                pending[key] = body[key];
              }
            }
            return resolve({ status: 200, revision: body.revision, configRevision: body.configRevision,
              health, inflight, ...pending, sessions: body.sessions, persistenceHealthy: body.persistenceHealthy, edgeEnabled: body.edgeEnabled, edgeErrors: body.edgeErrors });
          }
          resolve({ status: 200, revision: body.revision, ...(method === 'GET' ? { configRevision: body.configRevision } : {}) });
        } catch { reject(new Error('invalid_core_response')); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('core_control_timeout')), 5000);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
    req.end(payload ? JSON.stringify(payload) : undefined);
  });
  const publish = env.AMR_GO_RUNTIME_CONFIG ? createSnapshotPublisher(env.AMR_GO_RUNTIME_CONFIG, call) : null;
  return {
    runtime: () => call('/internal/v1/status'),
    acquireProbe: (model, ttlMs, configRevision) => call('/internal/v1/probe/acquire', 'POST', null, { model, ttlMs, configRevision }),
    releaseProbe: lease => call('/internal/v1/probe/release', 'POST', null, { lease }),
    status: async () => {
      const state = await call('/internal/v1/config');
      if (!publish) return state;
      let publicationPending = false;
      try { await access(env.AMR_GO_RUNTIME_CONFIG + '.pending'); publicationPending = true; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      return { ...state, publicationPending, snapshotPublication: true };
    },
    reload: revision => {
      if (!revision) return Promise.resolve({ status: 428, error: 'core_revision_required' });
      if (typeof revision !== 'string' || !/^"[a-f0-9]{64}"$/.test(revision)) return Promise.resolve({ status: 400, error: 'invalid_core_revision' });
      return publish ? publish(revision) : call('/internal/v1/config/reload', 'POST', revision);
    },
  };
}
