import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadConfig, getConfigRevision } from '../src/config.mjs';
import { encodeSnapshot } from '../src/go-runtime/snapshot.mjs';

const listen = async server => { await new Promise(r => server.listen(0, '127.0.0.1', r)); return server.address().port; };
test('Go rejects model imports without changing live Node config or source bytes', { timeout: 15000 }, async () => {
 const dir = await mkdtemp(join(tmpdir(), 'amr-import-publication-')), path = join(dir, 'router.json'), snapshot = join(dir, 'runtime.json');
 const prior = process.env.CONFIG_PATH;
 const source = JSON.parse(await readFile(new URL('../config/router.json', import.meta.url), 'utf8'));
 source.calibration.enabled = false; source.semanticRouter.enabled = false; source.judge.enabled = false;
 source.budget.ledgerPath = join(dir, 'budget.json'); source.decisionLog.dirPath = dir;
 await writeFile(path, JSON.stringify(source));
 process.env.CONFIG_PATH = path; const config = await loadConfig();
 if (prior === undefined) delete process.env.CONFIG_PATH; else process.env.CONFIG_PATH = prior;
 await writeFile(snapshot, encodeSnapshot(config).data);
 const original = await readFile(path, 'utf8'), revision = getConfigRevision(config), generation = '"' + 'a'.repeat(64) + '"';
 let rejects = 0;
 const core = createServer((req, res) => {
  req.resume();
  if (req.url === '/internal/v1/config/reload') { rejects++; res.writeHead(422); return res.end('{}'); }
  const state = { revision: generation, configRevision: revision, health: {}, inflight: {}, sessions: 0, persistenceHealthy: true, edgeEnabled: true, edgeErrors: 0 };
  res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(state));
 });
 const corePort = await listen(core), holder = createServer(), port = await listen(holder); await new Promise(r => holder.close(r));
 const base = `http://127.0.0.1:${port}`, coreBase = `http://127.0.0.1:${corePort}`;
 const child = spawn(process.execPath, ['src/server.mjs'], { windowsHide: true, stdio: 'ignore', env: { ...process.env,
  CONFIG_PATH: path, HOST: '127.0.0.1', PORT: String(port), ADMIN_TOKEN: 'test-admin', AMR_COUNTERS_PATH: join(dir, 'counters.json'),
  AMR_GO_ADMIN_URL: coreBase, AMR_GO_ADMIN_TOKEN: 'core-admin-test-token', AMR_GO_CHAT_URL: coreBase + '/v1/chat/completions',
  AMR_GO_EDGE_TOKEN: 'edge-test-token-'.repeat(3), AMR_GO_RUNTIME_CONFIG: snapshot } });
 try {
  let ready = false;
  for (let i=0;i<100;i++) { try { if ((await fetch(base+'/health')).ok) { ready=true;break; } } catch {} await sleep(50); }
  assert.ok(ready);
  const auth = { authorization: 'Bearer test-admin' }, id = config.models[0].id;
  const before = await (await fetch(base+'/admin/api/config',{headers:auth})).json();
  const cases = [
   ['import', 'application/json', JSON.stringify({models:[{id,benchmarkScores:{scores:{gpqa_diamond:99}}}]})],
   ['import-xlsx', 'text/csv', `id,gpqa_diamond\n${id},98\n`]
  ];
  for (const [route, type, body] of cases) {
   const response = await fetch(base+'/admin/api/model-data/'+route,{method:'POST',headers:{...auth,'content-type':type},body});
   assert.equal(response.status,400); await response.text();
   const after = await (await fetch(base+'/admin/api/config',{headers:auth})).json();
   assert.deepEqual(after,before,'failed publication changed live config');
   assert.equal(await readFile(path,'utf8'),original,'failed publication changed source bytes');
   assert.equal((await fetch(base+'/health')).status,200);
  }
  assert.equal(rejects,2);
 } finally {
  if(child.exitCode===null) { const done=once(child,'exit'); child.kill(); await done; }
  core.closeAllConnections(); await new Promise(r=>core.close(r)); await rm(dir,{recursive:true,force:true});
 }
});

