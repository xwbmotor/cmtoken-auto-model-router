// Real Go/Node processes and local HTTP fixtures. No production credentials,
// production endpoints, paid models, or source configuration writes.
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
import { analyzeRequest, mergeSemanticAssessment, routeRequest } from '../../src/router.mjs';
import { classifySemantically } from '../../src/semantic-router.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const flag=process.argv.indexOf('--binary');if(flag<0)throw Error('--binary is required');const binary=resolve(process.argv[flag+1]);
const dir=mkdtempSync(resolve(tmpdir(),'amr-go-semantic-'));
const snapshotMode=process.argv.includes('--snapshot');
const random=()=>randomBytes(24).toString('hex');
const access=random(),assessorToken=random(),upstreamToken=random(),smallToken=random(),largeToken=random(),secret=random();
const admin=random();
const tenants=[{accessToken:random(),upstreamToken:random()},{accessToken:random(),upstreamToken:random()}];
const children=[],observed=[],largeBodies=[],smallBodies=[];let assertionError=null,releaseShadow=null;
let ids=[];
const assess=(confidence)=>({task:'reasoning',tier:'complex',complexity:.9,confidence,reason:'fixture'});
const marker=text=>['case-small','case-large','case-low','case-degraded','case-error','case-shadow','case-tenant-a','case-tenant-b'].find(m=>text.includes(m))||'case-small';
const smallResponse=tag=>assess(['case-large','case-low','case-degraded'].includes(tag)?.4:.95);
const largeResponse=tag=>({choices:[{message:{content:JSON.stringify(assess(tag==='case-low'?.2:.95))}}],usage:{prompt_tokens:20,completion_tokens:10}});
const small=createServer(async(req,res)=>{try{
  assert.equal(req.headers.authorization,`Bearer ${smallToken}`);assert.equal(req.headers.cookie,undefined);
  let raw='';for await(const b of req)raw+=b;const body=JSON.parse(raw);smallBodies.push(body);assert.deepEqual(Object.keys(body),['text']);assert.ok(!body.text.includes('PRIVATE-SYSTEM')&&!body.text.includes('PRIVATE-HISTORY'));
  const tag=marker(body.text);if(tag==='case-shadow')await new Promise(resolve=>releaseShadow=resolve);
  if(tag==='case-error'){res.writeHead(503);res.end();return}res.setHeader('content-type','application/json');res.end(JSON.stringify(smallResponse(tag)));
}catch(e){assertionError=e;res.writeHead(500);res.end('fixture failure')}});
const upstream=createServer(async(req,res)=>{try{
  assert.equal(req.headers.cookie,undefined);
  if(req.url==='/v1/models'){
    const tenant=tenants.findIndex(t=>req.headers.authorization===`Bearer ${t.upstreamToken}`);
    assert.ok(tenant>=0||req.headers.authorization===`Bearer ${upstreamToken}`);
    res.setHeader('content-type','application/json');res.end(JSON.stringify({data:(tenant>=0?[ids[tenant]]:ids).map(id=>({id}))}));return;
  }
  let raw='';for await(const b of req)raw+=b;const body=JSON.parse(raw);
  if(req.url==='/classifier/chat/completions'){
    assert.equal(req.headers.authorization,`Bearer ${largeToken}`);largeBodies.push(body);
    const tag=marker(body.messages[0].content);if(['case-degraded','case-error'].includes(tag)){res.writeHead(503);res.end();return}
    res.setHeader('content-type','application/json');res.end(JSON.stringify(largeResponse(tag)));return;
  }
  assert.equal(req.url,'/v1/chat/completions');assert.ok([upstreamToken,...tenants.map(t=>t.upstreamToken)].some(t=>req.headers.authorization===`Bearer ${t}`));observed.push(body.model);
  if(body.stream){res.writeHead(200,{'content-type':'text/event-stream'});res.write(`data: ${JSON.stringify({model:body.model,choices:[{delta:{content:'answer'}}]})}\n\n`);setTimeout(()=>res.end('data: [DONE]\n\n'),60)}
  else {res.setHeader('content-type','application/json');res.end(JSON.stringify({model:body.model,choices:[{message:{content:'answer'}}]}))}
}catch(e){assertionError=e;res.writeHead(500);res.end('fixture failure')}});
async function start(command,args){
 const child=spawn(command,args,{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,AMR_GO_ACCESS_TOKEN:access,AMR_GO_ASSESSOR_TOKEN:assessorToken,AMR_GO_UPSTREAM_TOKEN:upstreamToken,AMR_GO_SEMANTIC_SMALL_TOKEN:smallToken,AMR_GO_SEMANTIC_LARGE_TOKEN:largeToken,AMR_GO_SEMANTIC_BUCKET_SECRET:secret,AMR_GO_TENANTS_JSON:JSON.stringify(tenants)}});children.push(child);
 let stderr='';child.stderr.on('data',b=>stderr=(stderr+b).slice(-2000));const lines=createInterface({input:child.stdout});
 return await new Promise((resolveReady,reject)=>{const timer=setTimeout(()=>reject(Error('laboratory readiness timeout')),15000);child.once('error',e=>{clearTimeout(timer);reject(e)});child.once('exit',code=>{clearTimeout(timer);reject(Error(`laboratory process exit ${code}: ${stderr}`))});lines.once('line',line=>{clearTimeout(timer);try{resolveReady(JSON.parse(line))}catch{reject(Error('invalid readiness message'))}})});
}
async function startMode(source,mode){
 const copy=structuredClone(source);copy.semanticRouter.mode=mode;const configPath=resolve(dir,`${mode}.json`);writeFileSync(configPath,JSON.stringify(copy));process.env.CONFIG_PATH=configPath;const config=await loadConfig();
 let configArgs;
 if(snapshotMode){
  const runtimePath=resolve(dir,`${mode}-runtime.json`),authPath=resolve(dir,`${mode}-auth.json`);
  execFileSync(process.execPath,['go-core/compat/export-runtime.mjs','--config',configPath,'--out',runtimePath],{cwd:root,windowsHide:true,stdio:'pipe'});
  writeFileSync(authPath,JSON.stringify({mode:'strict',accessToken:access,upstreamToken,adminToken:admin,tenants}));
  configArgs=['--runtime','--runtime-config',runtimePath,'--auth-config',authPath,'--ledger',resolve(dir,`${mode}.wal`)];
 }else{
  const adapter=await start(process.execPath,['go-core/compat/assessor.mjs','--lab','--native-semantics','--config',configPath,'--port','0']);
  configArgs=['--assessor',`http://127.0.0.1:${adapter.port}/assess`];
 }
 const go=await start(binary,['--lab','--native-analysis','--native-semantics','--listen','127.0.0.1:0',...configArgs,'--upstream',`http://127.0.0.1:${upstream.address().port}/v1/chat/completions`,'--scope-url',`http://127.0.0.1:${upstream.address().port}/v1/models`,'--semantic-small',`http://127.0.0.1:${small.address().port}/classify`,'--semantic-large',`http://127.0.0.1:${upstream.address().port}/classifier/chat/completions`]);
 return {base:`http://${go.listen}`,config};
}
try{
 await new Promise(r=>small.listen(0,'127.0.0.1',r));await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
 const source=JSON.parse(readFileSync(resolve(root,'config/router.json'),'utf8'));source.models=source.models.slice(0,2);ids=source.models.map(m=>m.id);
 for(const [i,m]of source.models.entries()){m.enabled=true;m.ownership='self_hosted';m.costIndex=0;m.latencyIndex=0;m.minimumCompletionTokensForReliableAnswer=0;m.quality={default:i?.94:.95,reasoning:i?.98:.96};m.benchmarkScores={subtasks:{}};m.capabilities={chat:true,stream:true,tools:true,json:true,vision:true}}
 Object.assign(source.routing,{mode:'active',maxAttempts:1,activeTrafficPercent:100,defaultExplicitModel:ids[0],shadowModel:ids[0],allowExplicitModel:true,qualityWeight:1,qualityFloor:.72,costWeight:0,providerCostWeight:0,latencyWeight:0,preferSelfHosted:false,uncertaintyPenalty:0,relQualityCap:.1,costTier:'custom',taskPreferences:{},loadBalancing:{enabled:false,limits:{}}});
 source.semanticRouter={enabled:true,provider:'cascade',mode:'active',model:ids[0],openaiChat:{model:ids[0],timeoutMs:1000},httpJson:{url:`http://127.0.0.1:${small.address().port}/classify`,timeoutMs:1000},confidenceThreshold:.7,smallAcceptThreshold:.7,finalAdoptionThreshold:.7,minCharacters:1,maxInputCharacters:6000,maxOutputTokens:180,useJsonMode:true,activeTrafficPercent:100};source.reasoningControl={...source.reasoningControl,enabled:false};
 const active=await startMode(source,'active');const checks=[];
 for(const [tag,status,tenantIndex,stream]of [['case-small','applied',-1,false],['case-large','applied',-1,false],['case-low','rejected_low_confidence',-1,false],['case-degraded','rejected_low_confidence',-1,false],['case-error','error',-1,false],['case-tenant-a','applied',0,false],['case-tenant-b','applied',1,true]]){
  const body={model:active.config.routing.autoModelId,messages:[{role:'system',content:'PRIVATE-SYSTEM'},{role:'assistant',content:'PRIVATE-HISTORY'},{role:'user',content:`请解释一下这段话的含义 ${tag}`}],max_tokens:8192,stream};
  const referenceLarge=[],referenceSmall=[];let assessment=null;try{assessment=await classifySemantically(body,active.config,{apiKey:largeToken,baseUrl:'http://reference.invalid',fetchImpl:async(url,request)=>{const payload=JSON.parse(request.body);if(url.endsWith('/classify')){referenceSmall.push(payload);return tag==='case-error'?new Response('',{status:503}):Response.json(smallResponse(tag))}referenceLarge.push(payload);return ['case-degraded','case-error'].includes(tag)?new Response('',{status:503}):Response.json(largeResponse(tag))}})}catch{}
  const baseAnalysis=analyzeRequest(body,active.config);const finalAnalysis=assessment&&assessment.confidence>=.7?mergeSemanticAssessment(baseAnalysis,assessment,true,body):baseAnalysis;
  const expected=routeRequest(body,active.config,{analysisOverride:finalAnalysis,trafficBucket:0,...(tenantIndex>=0?{allowedModelIds:new Set([ids[tenantIndex]])}:{})}).selectedModel;
  const beforeSmall=smallBodies.length,beforeLarge=largeBodies.length;
  const response=await fetch(active.base+'/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${tenantIndex>=0?tenants[tenantIndex].accessToken:access}`,'Content-Type':'application/json'},body:JSON.stringify(body)});const text=await response.text();
  assert.equal(response.status,200,text);assert.equal(response.headers.get('x-amr-semantic-status'),status);assert.equal(response.headers.get('x-amr-selected-model'),expected);if(stream)assert.ok(text.includes('data: [DONE]'));
  assert.deepEqual(smallBodies.slice(beforeSmall),referenceSmall);assert.deepEqual(largeBodies.slice(beforeLarge),referenceLarge,'Go changed the reference classifier request');checks.push({tag,status,stream,selectedModelMatchesNode:true});
 }
 const stats=await(await fetch(active.base+'/internal/v1/runtime',{headers:{Authorization:`Bearer ${snapshotMode?admin:access}`}})).json();assert.equal(stats.semanticGuard.largeCalls,4);assert.equal(stats.semanticGuard.actualTokens,60);assert.ok(stats.semanticGuard.estimatedTokens>0);assert.equal(stats.semanticGuard.pendingTokens,0);assert.equal(observed.length,7);
 const shadow=await startMode(source,'shadow');const response=await fetch(shadow.base+'/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${access}`,'Content-Type':'application/json'},body:JSON.stringify({model:shadow.config.routing.autoModelId,messages:[{role:'user',content:'请解释一下这段话的含义 case-shadow'}]})});await response.text();assert.equal(response.headers.get('x-amr-semantic-status'),'shadow_pending');assert.equal(response.headers.get('x-amr-selected-model'),ids[0]);
 for(let i=0;i<100&&!releaseShadow;i++)await new Promise(r=>setTimeout(r,10));assert.ok(releaseShadow);releaseShadow();
 let shadowStats;for(let i=0;i<100;i++){shadowStats=await(await fetch(shadow.base+'/internal/v1/runtime',{headers:{Authorization:`Bearer ${snapshotMode?admin:access}`}})).json();if(shadowStats.reviews.length)break;await new Promise(r=>setTimeout(r,10))};assert.equal(shadowStats.reviews[0]?.status,'shadow_complete');assert.equal(observed.length,8);
 if(assertionError)throw assertionError;
 const report={milestone:'m2b',productionReady:false,at:new Date().toISOString(),upstream:'local mocks only',checks,shadowNonblocking:true,shadowNoDuplicateAnswer:true,tenantCredentialIsolation:true,classifierRequestMatchesNode:true,guard:stats.semanticGuard,answerCalls:observed.length,binarySha256:createHash('sha256').update(readFileSync(binary)).digest('hex')};
 report.featureMode=snapshotMode?'native-local-snapshot':'legacy-request-adapter';report.adapterProcessRequired=!snapshotMode;
 mkdirSync(resolve(root,'data/go-migration'),{recursive:true});writeFileSync(resolve(root,`data/go-migration/${snapshotMode?'native-snapshot-semantic-demo':'semantic-demo'}.json`),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{
 if(releaseShadow)releaseShadow();for(const child of children.reverse()){if(child.exitCode!==null||child.signalCode!==null)continue;await new Promise(r=>{const timer=setTimeout(r,3000);child.once('exit',()=>{clearTimeout(timer);r()});child.kill()})};small.closeAllConnections();upstream.closeAllConnections();await Promise.all([new Promise(r=>small.close(r)),new Promise(r=>upstream.close(r))]);rmSync(dir,{recursive:true,force:true});
}
