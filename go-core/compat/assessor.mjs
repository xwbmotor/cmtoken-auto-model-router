// LAB ONLY: reuse Node rule classification and normalized config while Go selects.
// This does not expose the production admin server, read .env, or call MaaS.
import { createServer } from 'node:http';
import { timingSafeEqual, randomInt } from 'node:crypto';
import { resolve } from 'node:path';
import { loadConfig } from '../../src/config.mjs';
import { decisionInput } from './contract.mjs';
import { semanticPolicy } from './semantic-policy.mjs';

const arg = name => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
if (!process.argv.includes('--lab') || !arg('--config')) throw new Error('Requires --lab --config <explicit path>');
const token = process.env.AMR_GO_ASSESSOR_TOKEN;
if (!token || token.length < 16) throw new Error('AMR_GO_ASSESSOR_TOKEN must contain at least 16 characters');
process.env.CONFIG_PATH = resolve(arg('--config'));
const config = await loadConfig();
// Active L2/L3 selection is deliberately not approximated by this rule-only adapter.
if (config.semanticRouter?.enabled && config.semanticRouter.mode === 'active' && !process.argv.includes('--native-semantics')) throw new Error('Active semantic adoption requires --native-semantics and Go native review');
const port = Number(arg('--port') ?? 8789);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
const authorized = req => {
  const actual = Buffer.from(req.headers.authorization || ''); const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};
const server = createServer(async (req, res) => {
  const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
  if (!authorized(req)) return send(401, { error: 'unauthorized' });
  if (req.method === 'GET' && req.url === '/analysis-config') return send(200, { semanticRequired: config.semanticRouter?.enabled === true && config.semanticRouter.mode === 'active', taskRules: config.taskRules, budget: { defaultEstimatedOutputTokens: config.budget?.defaultEstimatedOutputTokens } });
  if (req.method === 'GET' && req.url === '/semantic-config') return send(200, semanticPolicy(config));
  if (req.method !== 'POST' || req.url !== '/assess') return send(404, { error: 'not_found' });
  if (config.semanticRouter?.enabled && config.semanticRouter.mode === 'active' && req.headers['x-amr-native-semantics'] !== '1') return send(400, { error: 'native_semantics_required' });
  let bytes = 0; const chunks = [];
  try {
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) { send(413, { error: 'request_too_large' }); return; }
      chunks.push(chunk);
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const nativeTransport = req.headers['x-amr-native-analysis'] === '1';
    if (nativeTransport && (payload?.nativeAnalysisVersion !== 1 || !payload.analysis || !payload.request)) return send(400, { error: 'invalid_native_envelope' });
    const nativeAnalysis = nativeTransport ? payload.analysis : undefined;
    const body = nativeAnalysis ? payload.request : payload;
    if (!Array.isArray(body?.messages) || !body.messages.length || body.messages.some(m => !m || typeof m.role !== 'string')) return send(400, { error: 'invalid_messages' });
    const input = decisionInput(body, config, { trafficBucket: randomInt(1000000) / 10000, nativeAnalysis });
    send(200, input);
  } catch { send(400, { error: 'invalid_assessment_request' }); }
});
server.requestTimeout = 10000; server.headersTimeout = 5000;
server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ laboratory: true, service: 'node-rule-adapter', port: server.address().port, configVersion: config.version })));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
