// Runs INSIDE one quota-limited container. No external network or credentials.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';

const role = process.env.M4_ROLE;
if (!['node', 'go'].includes(role) || !process.env.M4_CONTROL_TOKEN) throw new Error('isolated fixture required');
const dir = `/lab/${role}`, children = [];
const metricsPort = role === 'node' ? 18786 : 18791;
const counters = path => Object.fromEntries(readFileSync(path, 'utf8').trim().split('\n').map(line => { const [key, value] = line.split(/\s+/); return [key, Number(value)]; }));
const authorized = req => {
  const got = Buffer.from(req.headers.authorization || ''), expected = Buffer.from(`Bearer ${process.env.M4_CONTROL_TOKEN}`);
  return got.length === expected.length && timingSafeEqual(got, expected);
};
createServer((req, res) => {
  if (req.method !== 'GET' || req.url !== '/resources' || !authorized(req)) { res.writeHead(403); return res.end(); }
  try {
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
  process.env.AMR_GO_ASSESSOR_TOKEN = process.env.M4_ASSESSOR;
  await start(process.execPath, ['go-core/compat/assessor.mjs', '--lab', '--config', process.env.CONFIG_PATH, '--port', '8789']);
  await start('/app/amr-core', ['--lab', '--runtime', '--auth-config', `${dir}/auth.json`, '--ledger', `${dir}/go.wal`, '--listen', '127.0.0.1:8791', '--assessor', 'http://127.0.0.1:8789/assess', '--upstream', 'http://127.0.0.1:8790/v1/chat/completions']);
  process.env.AMR_GO_ADMIN_URL = 'http://127.0.0.1:8791'; process.env.AMR_GO_ADMIN_TOKEN = process.env.M4_CORE_ADMIN;
}
// Node group: this process serves requests. Go group: this process is the real
// Node administration service; adapter and Go runtime remain children in its cgroup.
await import('../../src/server.mjs');
for (const child of children) child.once('exit', () => process.exit(1));
