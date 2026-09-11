// Runs INSIDE one quota-limited container. No external network or credentials.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';

const role = process.env.M4_ROLE;
if (!['node', 'go'].includes(role) || !process.env.M4_CONTROL_TOKEN) throw new Error('isolated fixture required');
const dir = `/lab/${role}`, children = [];
let profiledCore;
let nodeProfiler;
if (process.env.M4_PROFILE === '1') {
  const { Session } = await import('node:inspector/promises');
  nodeProfiler = new Session(); nodeProfiler.connect();
  await nodeProfiler.post('Profiler.enable'); await nodeProfiler.post('Profiler.start');
}
const metricsPort = role === 'node' ? 18786 : 18791;
const counters = path => Object.fromEntries(readFileSync(path, 'utf8').trim().split('\n').map(line => { const [key, value] = line.split(/\s+/); return [key, Number(value)]; }));
const authorized = req => {
  const got = Buffer.from(req.headers.authorization || ''), expected = Buffer.from(`Bearer ${process.env.M4_CONTROL_TOKEN}`);
  return got.length === expected.length && timingSafeEqual(got, expected);
};
createServer(async (req, res) => {
    if (req.method !== 'GET' || !['/resources', '/decisions', '/profile-stop'].includes(req.url) || !authorized(req)) { res.writeHead(403); return res.end(); }
  try {
    if (req.url === '/profile-stop') {
      if (!nodeProfiler) { res.writeHead(409); return res.end(); }
      const { profile } = await nodeProfiler.post('Profiler.stop'); nodeProfiler.disconnect(); nodeProfiler = null;
      writeFileSync(`${dir}/node.cpuprofile`, JSON.stringify(profile));
      return res.end('{"stopped":true}');
    }
    if (req.url === '/decisions') {
      const path = `${dir}/decisions`;
      const requestIds = (existsSync(path) ? readdirSync(path) : []).filter(name => name.startsWith('decisions-') && name.endsWith('.jsonl'))
        .flatMap(name => readFileSync(`${path}/${name}`, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line).request?.requestId));
      res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ requestIds }));
    }
    const value = { at: Date.now(), cpu: counters('/sys/fs/cgroup/cpu.stat'), memoryBytes: Number(readFileSync('/sys/fs/cgroup/memory.current', 'utf8')),
      memoryLimit: readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim(), cpuLimit: readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim(), memoryEvents: counters('/sys/fs/cgroup/memory.events') };
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value));
  } catch { res.writeHead(503); res.end('{"error":"cgroup_v2_unavailable"}'); }
}).listen(metricsPort, '127.0.0.1');

Object.assign(process.env, { CONFIG_PATH: `${dir}/router.json`, HOST: '127.0.0.1', PORT: role === 'node' ? '8786' : '8787',
  ROUTER_KEY_MODE: 'strict', ROUTER_ACCESS_KEY: process.env.M4_ACCESS, ADMIN_TOKEN: process.env.M4_ADMIN,
  UPSTREAM_API_KEY: process.env.M4_UPSTREAM, UPSTREAM_BASE_URL: 'http://127.0.0.1:8790/v1', AMR_COUNTERS_PATH: `${dir}/counters.json` });
async function start(command, args) {
  const child = spawn(command, args, { cwd: '/app', stdio: ['ignore', 'pipe', 'pipe'], env: process.env }); children.push(child);
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child startup timeout')), 20000);
    child.once('error', () => { clearTimeout(timer); reject(new Error('child startup failed')); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`child exited ${code}`)); });
    lines.once('line', line => { clearTimeout(timer); try { resolve(JSON.parse(line)); } catch { reject(new Error('child readiness invalid')); } });
  });
}
if (role === 'go') {
  if (process.env.M4_EDGE === '1') {
    if (process.env.M4_FEATURE_MODE !== 'snapshot') throw new Error('edge requires snapshot');
    process.env.AMR_GO_EDGE_URL = 'http://127.0.0.1:8787/internal/v1/go-events';
    process.env.AMR_GO_EDGE_TOKEN = process.env.M4_EDGE_TOKEN;
    if (process.env.M4_NATIVE_FRONT === '1') {
      process.env.AMR_GO_NATIVE_FRONT = '1';
      process.env.AMR_GO_SEMANTIC_BUCKET_SECRET = process.env.M4_EDGE_TOKEN;
      process.env.SEMANTIC_BUCKET_SECRET = process.env.M4_EDGE_TOKEN;
    }
  }
  process.env.AMR_GO_ASSESSOR_TOKEN = process.env.M4_ASSESSOR;
  let configArgs;
  if (process.env.M4_FEATURE_MODE === 'snapshot') {
    const { loadConfig } = await import('../../src/config.mjs');
    const { runtimeBundle } = await import('./runtime-policy.mjs');
    writeFileSync(`${dir}/runtime.json`, JSON.stringify(runtimeBundle(await loadConfig())));
    delete process.env.AMR_GO_ASSESSOR_TOKEN;
    configArgs = ['--runtime-config', `${dir}/runtime.json`];
  } else {
    await start(process.execPath, ['go-core/compat/assessor.mjs', '--lab', '--config', process.env.CONFIG_PATH, '--port', '8789']);
    configArgs = ['--assessor', 'http://127.0.0.1:8789/assess'];
  }
  const coreInfo = await start('/app/amr-core', ['--lab', ...(process.env.M4_NODE_COST_OBSERVATION === '1' ? ['--node-cost-observation'] : []), ...(process.env.M4_NATIVE_FRONT === '1' ? ['--public-listen', '127.0.0.1:8793', '--node-origin', 'http://127.0.0.1:8787'] : []), '--runtime', '--auth-config', `${dir}/auth.json`, '--ledger', `${dir}/go.wal`, '--listen', '127.0.0.1:8791', ...configArgs, '--upstream', 'http://127.0.0.1:8790/v1/chat/completions', ...(process.env.M4_PROFILE === '1' ? ['--lab-profile-dir', `${dir}/profile`] : [])]);
  writeFileSync(`${dir}/runtime-info.json`, JSON.stringify(coreInfo));
  if (process.env.M4_PROFILE === '1') {
    profiledCore = children.at(-1);
    writeFileSync(`${dir}/core.pid`, String(profiledCore.pid));
  }
  process.env.AMR_GO_ADMIN_URL = 'http://127.0.0.1:8791'; process.env.AMR_GO_ADMIN_TOKEN = process.env.M4_CORE_ADMIN;
  if (process.env.M4_EDGE === '1') {
    process.env.AMR_GO_CHAT_URL = 'http://127.0.0.1:8791/v1/chat/completions';
    process.env.AMR_GO_RUNTIME_CONFIG = `${dir}/runtime.json`;
  }
}
// Node group: this process serves requests. Go group: this process is the real
// Node administration service; Go and any bootstrap adapter share its cgroup.
await import('../../src/server.mjs');
for (const child of children) child.once('exit', code => {
  // The profiling harness explicitly drains Go after every measured request.
  if (child !== profiledCore || code !== 0) process.exit(1);
});
