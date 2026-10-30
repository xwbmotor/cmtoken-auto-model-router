import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

// Run only against a disposable container, without network or writable mounts.
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const name = `amr-analysis-check-${process.pid}`;
const key = 'synthetic-container-analysis-key-000000000000';
const marker = 'PRIVATE_SYNTHETIC_CONTAINER_INPUT_314159';
const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 30000 });
try {
  docker(['run', '-d', '--name', name, '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true', '--memory', '768m', '--pids-limit', '128',
    '-e', `ANALYSIS_ACCESS_KEY=${key}`, '-e', 'ANALYSIS_PORT=8792',
    `cmt-auto-model-router:${version}`, 'node', 'src/analysis-server.mjs']);
  let ready = false;
  const health = "fetch('http://127.0.0.1:8792/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))";
  for (let i = 0; i < 30; i++) {
    try { docker(['exec', name, 'node', '-e', health]); ready = true; break; } catch {}
    await sleep(200);
  }
  assert.ok(ready, 'analysis container must become ready');
  const request = `const base='http://127.0.0.1:8792';
    const r=await fetch(base+'/v1/decide',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer ${key}'},body:JSON.stringify({messages:[{role:'user',content:'${marker} 请解释代码的并发安全'}]})});
    const j=await r.json();if(r.status!==200||!j.suggestedModel||j.observation.inferenceExecuted!==false||JSON.stringify(j).includes('${marker}'))throw Error('invalid analysis response');
    const denied=await fetch(base+'/v1/chat/completions',{method:'POST'});if(denied.status!==404)throw Error('forwarding accessible');
    console.log(JSON.stringify({analysis:200,forwarding:404,metadataOnly:true}));`;
  const result = JSON.parse(docker(['exec', name, 'node', '--input-type=module', '-e', request]));
  const log = docker(['logs', name]);
  assert.ok(!log.includes(marker) && !log.includes(key));
  assert.match(log, /analysis_request/);
  const inspected = JSON.parse(docker(['inspect', name]))[0];
  assert.equal(inspected.HostConfig.NetworkMode, 'none');
  assert.equal(inspected.HostConfig.ReadonlyRootfs, true);
  assert.equal(inspected.Mounts.length, 0);
  console.log(JSON.stringify({ ...result, network: 'none', readOnly: true, noDataMounts: true }));
} finally {
  try { docker(['rm', '-f', name]); } catch {}
}
