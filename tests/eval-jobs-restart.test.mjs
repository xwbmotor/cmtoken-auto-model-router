import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomInt } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

async function port() {for(let i=0;i<50;i++){const s=createServer(),p=randomInt(20000,50000);try{await new Promise((resolve,reject)=>{s.once('error',reject);s.listen(p,'127.0.0.1',resolve);});}catch{continue;}await new Promise(r=>s.close(r));return p;}throw Error('No test port');}
test('running evaluation survives server restart as interrupted without replaying provider calls',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'amr-eval-restart-'));let child;let calls=0;
 const entered=Promise.withResolvers();const upstream=createServer(async(req,res)=>{for await(const _ of req){}calls++;if(calls===2){entered.resolve();return;}res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:'45'}}]}));});
 const up=await port(),local=await port(),base=`http://127.0.0.1:${local}`,headers={authorization:'Bearer restart-fixture-admin','content-type':'application/json'};
 const stop=async()=>{if(!child||child.exitCode!==null)return;const end=once(child,'close');child.kill('SIGKILL');await end;};
 try{
  await new Promise(r=>upstream.listen(up,'127.0.0.1',r));
  const cfg=JSON.parse(await readFile('config/router.json','utf8'));cfg.semanticRouter.enabled=false;cfg.judge.enabled=false;cfg.calibration.enabled=false;cfg.budget.ledgerPath=join(dir,'budget.json');cfg.decisionLog.dirPath=join(dir,'decisions');
  await writeFile(join(dir,'router.json'),JSON.stringify(cfg));
  const start=async()=>{
   child=spawn(process.execPath,['src/server.mjs'],{windowsHide:true,stdio:'ignore',env:{...process.env,NODE_ENV:'test',HOST:'127.0.0.1',PORT:String(local),CONFIG_PATH:join(dir,'router.json'),AMR_COUNTERS_PATH:join(dir,'counters.json'),ADMIN_TOKEN:'restart-fixture-admin',AMR_GO_CHAT_URL:'',AMR_GO_NATIVE_FRONT:'',UPSTREAM_BASE_URL:`http://127.0.0.1:${up}`,UPSTREAM_API_KEY:'fixture-only'}});
   for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok)return;}catch{}await sleep(50);}throw Error('server did not start');
  };
  await start();const response=await fetch(base+'/admin/api/eval-jobs',{method:'POST',headers,body:JSON.stringify({type:'checkup',modelId:cfg.models[0].id})});assert.equal(response.status,202);const job=await response.json();
  await Promise.race([entered.promise,sleep(6000).then(()=>{throw Error('provider did not receive second call');})]);
  await stop();await start();
  const restored=await(await fetch(base+'/admin/api/eval-jobs?id='+job.id,{headers})).json();assert.equal(restored.status,'interrupted');assert.equal(restored.done,1);assert.equal(restored.results.length,1);
  assert.equal((await(await fetch(base+'/admin/api/eval-jobs',{headers})).json()).survivesRestart,true);
  await sleep(150);assert.equal(calls,2,'server replayed a paid model call');
 }finally{await stop();upstream.closeAllConnections();await new Promise(r=>upstream.close(r));await rm(dir,{recursive:true,force:true});}
});
