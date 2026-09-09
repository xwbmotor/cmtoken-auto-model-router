// Opt-in migration control bridge. Caller authentication belongs to server.mjs.
// A fixed literal loopback destination and fixed paths prevent an admin proxy.
import { request } from 'node:http';

export function createGoCoreAdmin(env = process.env) {
  if (!env.AMR_GO_ADMIN_URL) return null;
  const endpoint = new URL(env.AMR_GO_ADMIN_URL);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port ||
      endpoint.pathname !== '/' || endpoint.search || endpoint.hash || endpoint.username || endpoint.password ||
      !env.ADMIN_TOKEN || !env.AMR_GO_ADMIN_TOKEN || env.AMR_GO_ADMIN_TOKEN.length < 16) {
    throw new Error('Go control bridge requires literal http://127.0.0.1:port, ADMIN_TOKEN and AMR_GO_ADMIN_TOKEN');
  }
  const token = env.AMR_GO_ADMIN_TOKEN;
  const call = (path, method = 'GET', revision) => new Promise((resolve, reject) => {
    const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };
    if (revision) headers['if-match'] = revision;
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
          if (method === 'GET' && (typeof body.configRevision !== 'string' || !/^"[a-f0-9]{64}"$/.test(body.configRevision))) throw new Error('invalid_core_config_revision');
          resolve({ status: 200, revision: body.revision, ...(method === 'GET' ? { configRevision: body.configRevision } : {}) });
        } catch { reject(new Error('invalid_core_response')); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('core_control_timeout')), 5000);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
    req.end();
  });
  return {
    status: () => call('/internal/v1/config'),
    reload: revision => {
      if (!revision) return Promise.resolve({ status: 428, error: 'core_revision_required' });
      if (typeof revision !== 'string' || !/^"[a-f0-9]{64}"$/.test(revision)) return Promise.resolve({ status: 400, error: 'invalid_core_revision' });
      return call('/internal/v1/config/reload', 'POST', revision);
    },
  };
}
