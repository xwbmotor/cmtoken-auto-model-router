// Real-process M3 exercise. All credentials are random, all endpoints loopback.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/config.mjs';
import { routeRequest } from '../../src/router.mjs';
import { createGoCoreAdmin } from '../../src/go-core-admin.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const arg=name=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1]};
if(!arg('--binary'))throw new Error('--binary required');
const binary=resolve(arg('--binary')), directory=mkdtempSync(resolve(tmpdir(),'amr-m3-'));
const snapshotMode=process.argv.includes('--snapshot');
const secret=()=>randomBytes(24).toString('hex');
const access=secret(),admin=secret(),upstreamToken=secret(),assessorToken=secret(),newAccess=secret();
const children=[];let observed=[],failFirst=true;
async function start(command,args) {
 const child=spawn(command,args,{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,AMR_GO_ASSESSOR_TOKEN:snapshotMode?'':assessorToken}});children.push(child);
 let stderr='';child.stderr.on('data',v=>{stderr=(stderr+v).slice(-1000)});
 const lines=createInterface({input:child.stdout});
 const ready=await new Promise((yes,no)=>{const timer=setTimeout(()=>no(new Error('startup timeout')),15000);child.once('error',e=>{clearTimeout(timer);no(e)});child.once('exit',code=>{clearTimeout(timer);no(new Error(`startup failed ${code}: ${stderr}`))});lines.once('line',line=>{clearTimeout(timer);try{yes(JSON.parse(line))}catch{no(new Error('invalid readiness'))}})});
 return {...ready,child};
}
async function stop(child){if(child.exitCode!==null||child.signalCode!==null)return;await new Promise(done=>{const timer=setTimeout(done,3000);child.once('exit',()=>{clearTimeout(timer);done()});child.kill()})}
const mock=createServer(async(req,res)=>{
 try{
  assert.equal(req.headers.authorization,`Bearer ${upstreamToken}`);assert.equal(req.headers.cookie,undefined);
  let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);observed.push({model:body.model,stream:body.stream===true});
  if(failFirst){failFirst=false;res.writeHead(503);res.end();return}
  const usage={prompt_tokens:10,completion_tokens:5,prompt_tokens_details:{cached_tokens:2}};
  if(body.stream){assert.equal(body.stream_options.include_usage,true);res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');setTimeout(()=>res.end(`data: ${JSON.stringify({choices:[],usage})}\n\ndata: [DONE]\n\n`),40)}
  else{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({model:body.model,choices:[{message:{role:'assistant',content:'ok'}}],usage}))}
 }catch{res.writeHead(500);res.end('fixture failure')}
});
try{
 const source=JSON.parse(readFileSync(resolve(root,'config/router.json'),'utf8'));
 source.semanticRouter.enabled=false;source.routing.mode='active';source.routing.activeTrafficPercent=100;source.routing.maxAttempts=2;
 source.routing.requestTimeoutMs=2000;source.routing.qualityFloor=.7;source.routing.taskPreferences={};
 source.models=source.models.filter(m=>m.enabled).slice(0,2);
 assert.equal(source.models.length,2);
 for(const m of source.models){m.quality=Object.fromEntries(Object.keys(m.quality).map(k=>[k,.9]));m.quality.default=.9;m.benchmarkScores=null;m.minimumCompletionTokensForReliableAnswer=0;m.pricingYuanPerMillionTokens={input:1,output:2,inputCached:.5};m.contextWindow=128000}
 source.routing.loadBalancing={enabled:true,penaltyWeight:.2,limits:Object.fromEntries(source.models.map(m=>[m.id,16]))};
 source.budget.enabled=true;source.budget.dailyBudgetYuan=1;source.budget.cacheHitRatio=0;
 const configPath=resolve(directory,'router.json'),authPath=resolve(directory,'auth.json'),ledger=resolve(directory,'ledger.wal');
 const snapshotPath=resolve(directory,'runtime.json');
 let coreStarted=false;
 const publishSource=()=>{writeFileSync(configPath,JSON.stringify(source));if(snapshotMode&&!coreStarted)execFileSync(process.execPath,['go-core/compat/export-runtime.mjs','--config',configPath,'--out',snapshotPath],{cwd:root,windowsHide:true,stdio:'pipe'})};
 publishSource();writeFileSync(authPath,JSON.stringify({mode:'strict',accessToken:access,adminToken:admin,upstreamToken}));
 if(snapshotMode){
  const previous=readFileSync(snapshotPath);
  writeFileSync(configPath,'{invalid');
  assert.throws(()=>execFileSync(process.execPath,['go-core/compat/export-runtime.mjs','--config',configPath,'--out',snapshotPath],{cwd:root,windowsHide:true,stdio:'pipe'}));
  assert.deepEqual(readFileSync(snapshotPath),previous,'invalid export overwrote active snapshot');
  publishSource();
  for(const token of [access,admin,upstreamToken,assessorToken])assert.ok(!readFileSync(snapshotPath,'utf8').includes(token));
 }
 process.env.CONFIG_PATH=configPath;let config=await loadConfig();
 await new Promise(done=>mock.listen(0,'127.0.0.1',done));
 const adapter=snapshotMode?null:await start(process.execPath,['go-core/compat/assessor.mjs','--lab','--config',configPath,'--port','0']);
 const goArgs=['--lab','--runtime','--auth-config',authPath,'--ledger',ledger,'--listen','127.0.0.1:0',...(snapshotMode?['--runtime-config',snapshotPath]:['--assessor',`http://127.0.0.1:${adapter.port}/assess`]),'--upstream',`http://127.0.0.1:${mock.address().port}/v1/chat/completions`];
 let go=await start(binary,goArgs),base=`http://${go.listen}`;
 coreStarted=true;
 const bridge=snapshotMode?createGoCoreAdmin({ADMIN_TOKEN:secret(),AMR_GO_ADMIN_TOKEN:admin,AMR_GO_ADMIN_URL:base,AMR_GO_RUNTIME_CONFIG:snapshotPath}):null;
 const adminHeaders={Authorization:`Bearer ${admin}`};
 const body={model:config.routing.autoModelId,messages:[{role:'user',content:'请提取这句话中的数字：42。'}],max_tokens:128};
 const send=(token,data=body)=>fetch(base+'/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',Cookie:'must-not-leak'},body:JSON.stringify(data)});
 const expected=routeRequest(body,config,{trafficBucket:0});assert.ok(expected.fallbackOrder.some(m=>m!==expected.selectedModel));
 let res=await send(access);assert.equal(res.status,200);let answer=await res.json();
 assert.equal(observed[0].model,expected.selectedModel);assert.equal(answer.model,expected.fallbackOrder.find(m=>m!==expected.selectedModel));assert.equal(observed.length,2);
 const initial=await(await fetch(base+'/internal/v1/config',{headers:adminHeaders})).json();
 assert.equal(initial.configRevision,'"'+createHash('sha256').update(readFileSync(configPath)).digest('hex')+'"');
 let stats=await(await fetch(base+'/internal/v1/runtime',{headers:adminHeaders})).json();
 assert.equal(stats.ledger.pendingReserves,0);assert.equal(stats.ledger.actualMicros,19);assert.ok(stats.ledger.estimatedMicros>0);
 const settledBefore=stats.ledger.actualMicros+stats.ledger.estimatedMicros;
 const nextModel=answer.model;for(const m of source.models)m.enabled=m.id===nextModel;
 publishSource();writeFileSync(authPath,JSON.stringify({mode:'strict',accessToken:newAccess,adminToken:admin,upstreamToken}));
 let published;
 if(bridge){ published=await bridge.reload(initial.revision);assert.equal(published.status,200);assert.equal(published.configRevision,'"'+createHash('sha256').update(readFileSync(configPath)).digest('hex')+'"'); }
 else {res=await fetch(base+'/internal/v1/config/reload',{method:'POST',headers:{...adminHeaders,'If-Match':initial.revision}});assert.equal(res.status,200);published=await res.json();}
 assert.notEqual(published.revision,initial.revision);
 res=await send(access);assert.equal(res.status,401);await res.arrayBuffer();
 res=await send(newAccess,{...body,stream:true});assert.equal(res.status,200);assert.ok((await res.text()).includes('[DONE]'));
 assert.equal(res.headers.get('x-amr-selected-model'),nextModel);assert.notEqual(res.headers.get('x-amr-config-revision'),initial.configRevision);
 res=await fetch(base+'/internal/v1/config/reload',{method:'POST',headers:{...adminHeaders,'If-Match':initial.revision}});assert.equal(res.status,409);await res.arrayBuffer();
 writeFileSync(snapshotMode?snapshotPath:configPath,'{invalid');res=await fetch(base+'/internal/v1/config/reload',{method:'POST',headers:{...adminHeaders,'If-Match':published.revision}});assert.equal(res.status,422);await res.arrayBuffer();
 assert.equal((await(await fetch(base+'/internal/v1/config',{headers:adminHeaders})).json()).revision,published.revision);
 coreStarted=false;publishSource();coreStarted=true;
 res=await send(admin);assert.equal(res.status,401);await res.arrayBuffer();
 stats=await(await fetch(base+'/internal/v1/runtime',{headers:adminHeaders})).json();assert.equal(stats.ledger.actualMicros+stats.ledger.estimatedMicros,settledBefore+19);
 const beforeRestart=stats.ledger;
 await stop(go.child);go=await start(binary,goArgs);base=`http://${go.listen}`;
 stats=await(await fetch(base+'/internal/v1/runtime',{headers:adminHeaders})).json();assert.deepEqual(stats.ledger,beforeRestart);
 // Passthrough changes only caller credentials; admin privileges stay separate.
 const current=await(await fetch(base+'/internal/v1/config',{headers:adminHeaders})).json();
 writeFileSync(authPath,JSON.stringify({mode:'passthrough',adminToken:admin}));
 res=await fetch(base+'/internal/v1/config/reload',{method:'POST',headers:{...adminHeaders,'If-Match':current.revision}});assert.equal(res.status,200);await res.arrayBuffer();
 res=await send(upstreamToken);assert.equal(res.status,200);await res.arrayBuffer();
 res=await fetch(base+'/internal/v1/runtime',{headers:{Authorization:`Bearer ${upstreamToken}`}});assert.equal(res.status,403);await res.arrayBuffer();
 await stop(go.child);
 const wal=readFileSync(ledger,'utf8'),audit=readFileSync(ledger+'.events.jsonl','utf8');for(const value of [access,newAccess,admin,upstreamToken,body.messages[0].content]){assert.ok(!wal.includes(value));assert.ok(!audit.includes(value))}
 const report={milestone:'m3',at:new Date().toISOString(),productionReady:false,upstream:'local mock only',upstreamCalls:observed.length,strictAuth:true,passthroughAuth:true,adminIsolation:true,qualifiedRetry:true,perAttemptSettlement:true,sseUsage:true,atomicHotReload:true,credentialRotation:true,staleRevisionRejected:true,invalidReloadPreservesPrevious:true,restartPreservesLedger:true,logsExcludeCredentialsAndPrompts:true,binarySha256:createHash('sha256').update(readFileSync(binary)).digest('hex')};
 report.featureMode=snapshotMode?'native-local-snapshot':'native-bootstrap';report.adapterProcessRequired=!snapshotMode;report.managementSnapshotPublication=snapshotMode;
 const out=resolve(arg('--out')||resolve(root,`data/go-migration/${snapshotMode?'native-snapshot-runtime-demo':'runtime-demo'}.json`));mkdirSync(dirname(out),{recursive:true});writeFileSync(out,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{for(const child of children.reverse())await stop(child);mock.closeAllConnections();await new Promise(done=>mock.close(done));rmSync(directory,{recursive:true,force:true})}
