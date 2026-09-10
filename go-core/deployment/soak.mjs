// Reproducible laboratory soak. All network destinations are literal loopback.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { createGoCoreAdmin } from '../../src/go-core-admin.mjs';
import { loadConfig } from '../../src/config.mjs';
import { encodeSnapshot } from '../../src/go-runtime/snapshot.mjs';

const configDir=process.env.AMR_SOAK_CONFIG_DIR||'/config';
const evidence=process.env.AMR_SOAK_EVIDENCE_DIR||'/evidence';
const ledgerDir=process.env.AMR_SOAK_LEDGER_DIR||'/ledger';
process.env.CONFIG_PATH=configDir+'/router.json';
const auth=JSON.parse(await readFile(configDir+'/auth.json','utf8'));
const source=JSON.parse(await readFile(configDir+'/router.json','utf8'));
const mode=process.argv[2], base='http://127.0.0.1:8791', mockBase='http://127.0.0.1:8790';
const adminHeaders={Authorization:`Bearer ${auth.adminToken}`};
const seconds=Number(process.env.SOAK_SECONDS||3600),rps=Number(process.env.SOAK_RPS||100);
const longSeconds=Number(process.env.SOAK_LONG_SECONDS||300),reloadSeconds=Number(process.env.SOAK_RELOAD_SECONDS||60);
assert.ok(Number.isInteger(seconds)&&seconds>=30&&seconds<=7200);
assert.ok(Number.isInteger(rps)&&rps>=1&&rps<=300);
assert.ok(longSeconds>=5&&longSeconds<seconds&&reloadSeconds>=3&&reloadSeconds<seconds);
const save=(name,value)=>writeFile(evidence+'/'+name,JSON.stringify(value,null,2)+'\n');
const json=async(url,headers=adminHeaders)=>{const res=await fetch(url,{headers,signal:AbortSignal.timeout(10000)});assert.equal(res.status,200,url);return res.json()};
const runtime=()=>json(base+'/internal/v1/runtime');
const configState=()=>json(base+'/internal/v1/config');

if(mode==='serve'){
 const counts={attempts:0,active:0,closedBeforeUsage:0,usageSent:0,retryFirstFailures:0,byScenario:{}};
 const retries=new Set();
 const server=createServer(async(req,res)=>{
  try{
   if(req.method==='GET'&&req.url==='/health'){res.end('ok');return}
   if(req.method==='GET'&&req.url==='/lab/stats'){
    if(req.headers.authorization!==adminHeaders.Authorization){res.writeHead(403).end();return}
    res.setHeader('content-type','application/json');res.end(JSON.stringify({...counts,retryMarkers:retries.size}));return;
   }
   assert.equal(req.headers.authorization,`Bearer ${auth.upstreamToken}`);
   let raw='';for await(const chunk of req){raw+=chunk;assert.ok(raw.length<65536)}
   const body=JSON.parse(raw),parts=String(body.user||'').split(':'),scenario=parts[1];
   assert.ok(['json','short','cancel','fail','retry','long','drain'].includes(scenario));
   counts.attempts++;counts.active++;counts.byScenario[scenario]=(counts.byScenario[scenario]||0)+1;
   let usageSent=false;const timers=[];
   res.once('close',()=>{counts.active--;for(const timer of timers){clearTimeout(timer);clearInterval(timer)}if(!usageSent&&scenario!=='fail'&&scenario!=='retry')counts.closedBeforeUsage++});
   if(scenario==='fail'||(scenario==='retry'&&!retries.has(body.user))){
    if(scenario==='retry'){retries.add(body.user);counts.retryFirstFailures++}
    res.writeHead(503).end('{}');return;
   }
   if(scenario==='retry')retries.delete(body.user);
   const usage={prompt_tokens:10,completion_tokens:5};
   const complete=()=>{if(res.destroyed)return;usageSent=true;counts.usageSent++;if(body.stream)res.end(`data: ${JSON.stringify({choices:[],usage})}\n\ndata: [DONE]\n\n`);else res.end(JSON.stringify({model:body.model,choices:[{message:{role:'assistant',content:'ok'}}],usage}))};
   if(body.stream){
    res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: {"choices":[{"delta":{"content":"tick"}}]}\n\n');
    const duration=scenario==='long'?longSeconds*1000:scenario==='drain'?5000:scenario==='cancel'?10000:200;
    timers.push(setInterval(()=>{if(!res.destroyed)res.write('data: {"choices":[{"delta":{"content":"tick"}}]}\n\n')},Math.min(1000,duration/2)));
    timers.push(setTimeout(complete,duration));
   }else{res.setHeader('content-type','application/json');timers.push(setTimeout(complete,5))}
  }catch{if(!res.headersSent)res.writeHead(500);res.end('fixture_error')}
 });
 server.listen(8790,'127.0.0.1',()=>console.log('soak loopback mock ready'));
 process.on('SIGTERM',()=>server.close());
}else if(mode==='snapshot'){
 console.log(JSON.stringify((await runtime()).ledger));
}else if(mode==='run'||mode==='drain'){
 await mkdir(evidence,{recursive:true});
 for(let i=0;;i++){try{await json(mockBase+'/lab/stats');break}catch(error){if(i>=100)throw error;await sleep(100)}}
 const bridge=createGoCoreAdmin({ADMIN_TOKEN:'local-lab-management-only',AMR_GO_ADMIN_TOKEN:auth.adminToken,AMR_GO_ADMIN_URL:base,AMR_GO_RUNTIME_CONFIG:configDir+'/runtime.json'});
 const initial=await runtime(), initialConfig=await configState();
 const priceByRevision=new Map([[initialConfig.configRevision,source.models[0].pricingYuanPerMillionTokens.input]]);
 let sequence=0,expectedActual=0;
 const counts={started:0,completed:0,successful:0,expectedFailures:0,cancelled:0,unexpected:0,dropped:0,byScenario:{}};
 const failures=[],longs=[],samples=[],reloads=[],windowResults=[];
 let hist=new Map(),windowAt=Date.now();
 const bin=(map,key,value)=>{let bins=map.get(key);if(!bins){bins=new Uint32Array(10001);map.set(key,bins)}bins[Math.min(10000,Math.max(0,Math.ceil(value)))]++};
 const distribution=bins=>{const total=bins.reduce((a,b)=>a+b,0);const quantile=q=>{let sum=0;for(let i=0;i<bins.length;i++){sum+=bins[i];if(sum>=Math.ceil(total*q))return i}return null};return {count:total,p50Ms:quantile(.5),p95Ms:quantile(.95),p99Ms:quantile(.99),overflow:bins[10000]}};
 const flushWindow=async()=>{const window={at:Date.now(),from:windowAt,latency:Object.fromEntries([...hist].map(([k,b])=>[k,distribution(b)]))};hist=new Map();windowAt=window.at;windowResults.push(window);await appendFile(evidence+'/latency-windows.jsonl',JSON.stringify(window)+'\n')};
 const sample=async(label)=>{const value={at:Date.now(),label,...await runtime(),mock:await json(mockBase+'/lab/stats')};samples.push(value);await appendFile(evidence+'/runtime-samples.jsonl',JSON.stringify(value)+'\n');return value};
 const send=async(scenario)=>{
  const id=++sequence,stream=['short','cancel','long','drain'].includes(scenario),controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),(scenario==='long'?longSeconds+30:15)*1000);
  const started=performance.now();counts.started++;counts.byScenario[scenario]=(counts.byScenario[scenario]||0)+1;
  let firstByte=null,status=null,revision=null;
  try{
   const res=await fetch(base+'/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${auth.accessToken}`,'Content-Type':'application/json'},body:JSON.stringify({model:source.routing.autoModelId,messages:[{role:'user',content:'Extract number 42.'}],max_tokens:128,stream,user:`soak:${scenario}:${id}`}),signal:controller.signal});
   status=res.status;revision=res.headers.get('x-amr-config-revision');
   if(scenario==='fail'){assert.equal(res.status,502);await res.arrayBuffer();counts.expectedFailures++;return}
   assert.equal(res.status,200);
   const reader=res.body.getReader();let text='',cancelled=false;
   for(;;){const {done,value}=await reader.read();if(done)break;if(firstByte===null)firstByte=performance.now()-started;
    if(scenario==='cancel'){assert.ok(value.length>0);controller.abort();try{await reader.read()}catch{}cancelled=true;break}
    text+=new TextDecoder().decode(value);if(text.length>100000)throw new Error('unexpected oversized fixture');
   }
   if(scenario==='cancel'){assert.ok(cancelled);counts.cancelled++;return}
   if(stream)assert.match(text,/data: \[DONE\]/);else assert.equal(JSON.parse(text).choices[0].message.content,'ok');
   const scale=priceByRevision.get(revision);assert.ok(scale===1||scale===2,'unknown billing generation');
   expectedActual+=20*scale;counts.successful++;
   if(scenario==='long'||scenario==='drain'){
    const elapsedMs=performance.now()-started;
    assert.ok(elapsedMs>=(scenario==='long'?longSeconds*1000:5000)-100);
    const event={id,scenario,revision,elapsedMs,startedAt:Date.now()-elapsedMs,finishedAt:Date.now(),expectedMicros:20*scale};longs.push(event);await appendFile(evidence+'/long-streams.jsonl',JSON.stringify(event)+'\n');
   }
  }catch(error){counts.unexpected++;if(failures.length<30)failures.push({scenario,status,name:error.name,message:error.message.slice(0,180)})}
  finally{clearTimeout(timer);counts.completed++;const elapsed=performance.now()-started;bin(hist,scenario,elapsed);if(firstByte!==null)bin(hist,scenario+'FirstByte',firstByte)}
 };
 if(mode==='drain'){
  // Host waits for the upstream stream to be active before SIGTERM.
  const request=send('drain');
  for(let i=0;;i++){if((await json(mockBase+'/lab/stats')).active>0)break;if(i>=100)throw new Error('drain stream did not start');await sleep(25)}
  await save('drain-ready.json',{ready:true});await request;
  assert.equal(counts.unexpected,0,JSON.stringify(failures));assert.equal(counts.successful,1);
  const expected=structuredClone(initial.ledger);expected.actualMicros+=expectedActual;expected.sources.answer.actualMicros+=expectedActual;
  await save('expected-after-drain.json',expected);await save('drain-result.json',{completedDuringShutdown:true,stream:longs[0]});
 }else{
  assert.equal(initial.ledger.actualMicros,0,'fresh ledger required');assert.equal(initial.ledger.estimatedMicros,0);
  const baseline=await sample('baseline');
  const startedAt=Date.now(),began=performance.now(),pending=new Set();let launched=0,nextReload=reloadSeconds*1000,nextSample=30000,nextLong=1000;
  const launch=scenario=>{const task=send(scenario).finally(()=>pending.delete(task));pending.add(task)};
  let publishing=null,publishError=null;
  const publish=async()=>{
   const before=await configState(),next=JSON.parse(await readFile(configDir+'/router.json','utf8'));
   const scale=next.models[0].pricingYuanPerMillionTokens.input===1?2:1;
   for(const model of next.models)model.pricingYuanPerMillionTokens={input:scale,output:2*scale,inputCached:.5*scale};
   await writeFile(configDir+'/router.json',JSON.stringify(next));
   const target=encodeSnapshot(await loadConfig());priceByRevision.set(target.revision,scale);
   const result=await bridge.reload(before.revision);assert.equal(result.status,200);assert.equal(result.configRevision,target.revision);
   const stale=await bridge.reload(before.revision);assert.equal(stale.status,409);
   const record={at:Date.now(),from:before.configRevision,to:target.revision,scale};reloads.push(record);await appendFile(evidence+'/reloads.jsonl',JSON.stringify(record)+'\n');
  };
  try{
   while(performance.now()-began<seconds*1000){
    const elapsed=performance.now()-began;
    const due=Math.min(seconds*rps,Math.floor(elapsed*rps/1000)+1);
    while(launched<due){const slot=launched++%100;const scenario=slot<2?'fail':slot<4?'retry':slot<7?'cancel':slot<17?'short':'json';if(pending.size>=200){counts.dropped++;continue}launch(scenario)}
    if(elapsed>=nextLong&&elapsed+longSeconds*1000<seconds*1000){launch('long');nextLong+=Math.max(longSeconds*2,20)*1000}
    if(elapsed>=nextReload&&!publishing){nextReload+=reloadSeconds*1000;publishing=publish().catch(error=>{publishError=error}).finally(()=>{publishing=null})}
    if(elapsed>=nextSample){nextSample+=30000;await sample('load');await flushWindow();await save('progress.json',{at:Date.now(),elapsedSeconds:elapsed/1000,counts,reloads:reloads.length,pending:pending.size});console.log(JSON.stringify({elapsedSeconds:Math.round(elapsed/1000),counts,reloads:reloads.length}))}
    if(counts.unexpected>10||publishError)throw publishError||new Error('unexpected request failures');
    await sleep(5);
   }
   const loadDurationMs=performance.now()-began;counts.dropped+=seconds*rps-launched;
   if(publishing)await publishing;if(publishError)throw publishError;
   await Promise.all([...pending]);await sleep(3000);
   await sample('idle-3s');await sleep(35000);
   const end=await sample('idle-38s');await flushWindow();
   assert.equal(counts.dropped,0);assert.equal(counts.unexpected,0,JSON.stringify(failures));assert.equal(counts.started,counts.completed);
   assert.equal(end.ledger.pendingReserves,0);assert.equal(end.ledger.pendingMicros,0);assert.equal(end.ledger.actualMicros,expectedActual);
   assert.equal(end.diagnostics.runtime.activeRequests,0);assert.equal(end.diagnostics.generations.retired,0);assert.equal(end.diagnostics.generations.live,1);
   assert.ok(Object.values(end.inflight).every(n=>n===0));assert.equal(end.mock.active,0);assert.equal(end.mock.retryMarkers,0);
   assert.equal(end.diagnostics.runtime.retainedAttempts,end.mock.attempts);
   assert.ok(end.diagnostics.process.goroutines<=baseline.diagnostics.process.goroutines+16,'idle goroutines did not return near baseline');
   assert.ok(reloads.length>=Math.floor(seconds/reloadSeconds)-1);assert.ok(longs.length>0);
   assert.ok(longs.some(stream=>reloads.some(reload=>reload.at>stream.startedAt&&reload.at<stream.finishedAt&&reload.to!==stream.revision)),'long stream must span configuration changes');
   const report={at:new Date().toISOString(),productionReady:false,scope:'isolated mock deployment, not production capacity',parameters:{seconds,rps,longSeconds,reloadSeconds},startedAt,loadEndedAt:startedAt+loadDurationMs,loadDurationMs,elapsedSeconds:(Date.now()-startedAt)/1000,plannedRequests:seconds*rps,counts,failures,reloads:reloads.length,longStreams:longs.length,expectedActualMicros:expectedActual,baseline,final:end,windows:windowResults,checks:{noUnexpectedErrors:true,noDroppedWork:true,actualBillingMatchesClients:true,idleRequestsZero:true,idlePendingZero:true,retiredGenerationsZero:true}};
   await save('soak-result.json',report);await save('before-restart.json',end.ledger);console.log(JSON.stringify({result:'soak passed',counts,reloads:reloads.length}));
  }catch(error){await save('soak-failure.json',{at:new Date().toISOString(),error:error.message,counts,failures,reloads:reloads.length});throw error}
 }
}else if(mode==='audit'){
 let actual=0,estimated=0,events=0;const unique=new Set(),outcomes={};
 for await(const line of createInterface({input:createReadStream(ledgerDir+'/runtime.wal.events.jsonl'),crlfDelay:Infinity})){
  if(!line)continue;for(const key of [auth.accessToken,auth.adminToken,auth.upstreamToken,'Extract number 42.'])assert.ok(!line.includes(key));
  const event=JSON.parse(line),id=event.requestId+':'+event.attempt;assert.ok(!unique.has(id),'duplicate audit attempt');unique.add(id);events++;
  if(event.actualMicros!==null)actual+=event.actualMicros;else estimated+=event.estimatedMicros||0;
  outcomes[event.outcome]=(outcomes[event.outcome]||0)+1;
 }
 const expected=JSON.parse(await readFile(evidence+'/expected-after-drain.json','utf8'));
 assert.equal(actual,expected.actualMicros);assert.equal(estimated,expected.estimatedMicros);
 await save('audit-result.json',{events,actualMicros:actual,estimatedMicros:estimated,outcomes,uniqueAttempts:true,redacted:true,matchesLedger:true});
 console.log(JSON.stringify({auditPassed:true,events}));
}else throw new Error('Expected serve, run, drain, snapshot or audit');
