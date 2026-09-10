// Boundary cases for native defaults and JSON coercions. The unchanged Node
// decisionInput function remains the oracle; no model endpoints are contacted.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { loadConfig } from '../../src/config.mjs';
import { decisionInput } from './contract.mjs';
import { featureConfig } from './feature-config.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const arg=name=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1]};
if(!arg('--binary'))throw new Error('--binary required');
const binary=resolve(arg('--binary'));
process.env.CONFIG_PATH=resolve(root,'config/router.json');
const original=await loadConfig(), rows=[];
const now=1700000000000,bucket=39.995;
function add(id,edit=()=>{},invalid=false){
  const c={config:structuredClone(original),body:{model:'auto',max_tokens:128,messages:[{role:'user',content:'fixture'}]},analysis:{task:'coding',subTask:'fixture',tier:'balanced',complexity:.5,estimatedContextTokens:512,requirements:{chat:true,tools:true}},now,bucket};
  c.body.model=c.config.routing.autoModelId;edit(c);
  rows.push({id,invalid,row:{...c,config:featureConfig(c.config)},expected:invalid?null:decisionInput(c.body,c.config,{nativeAnalysis:c.analysis,now,trafficBucket:bucket})});
}
add('baseline');
const numericRouting=['sessionStickinessTtlMs','sessionStickinessMaxGap','activeTrafficPercent','providerCostWeight','complexQualityMargin','subtaskMinSamples','subtaskMaxAdjust','budgetCostMultiplier'];
for(const key of numericRouting)for(const value of [undefined,null,0,'0',' 0 ',false])add(`routing:${key}:${String(value)}`,c=>{c.config.routing[key]=value});
for(const key of ['qualityFloor','qualityWeight','costWeight','latencyWeight','selfHostedBonus','uncertaintyPenalty'])for(const value of [0,'0',false])add(`required:${key}:${String(value)}`,c=>{c.config.routing[key]=value});
for(const value of ['0x10','0b10000','0o20','16','\ufeff16\u00a0'])add(`number:${value}`,c=>{c.config.routing.sessionStickinessTtlMs=value});
for(const tier of ['simple','balanced','complex'])for(const value of [undefined,null,0,'0',{}, {simple:0,balanced:null,complex:'.03'}])add(`relative:${tier}:${JSON.stringify(value)}`,c=>{c.analysis.tier=tier;c.config.routing.relQualityCap=value});
for(const key of ['reasoningControl','budget'])add(`absent:${key}`,c=>{delete c.config[key]});
for(const key of ['livePenalty','loadBalancing','taskPreferences'])add(`absent:routing:${key}`,c=>{delete c.config.routing[key]});
for(const key of ['enabled','costIndex','costIndexProvider','latencyIndex','contextWindow','minimumCompletionTokensForReliableAnswer'])for(const value of [undefined,null,0,'0'])add(`model:${key}:${String(value)}`,c=>{for(const m of c.config.models)m[key]=value});
for(const value of [undefined,null,0,'0',.9])add(`quality:${String(value)}`,c=>{for(const m of c.config.models)m.quality.coding=value});
for(const value of [undefined,null,{}, {off:false,standard:true,high:true}])add(`reasoning:${JSON.stringify(value)}`,c=>{for(const m of c.config.models)m.reasoningControl={verified:true,parameter:'chat_template_kwargs.enable_thinking',values:value}});
for(const score of [{},{avg:null,n:4},{avg:'invalid',n:4},{avg:.7,n:0},{avg:'0.7',n:'4'},{avg:.9,n:100}])add(`subtask:${JSON.stringify(score)}`,c=>{for(const m of c.config.models)m.benchmarkScores={subtasks:{fixture:score}}});
for(const value of [undefined,null,0,false,'','0','  ',64,'64',[],[64]])add(`completion:${JSON.stringify(value)}`,c=>{c.body.max_completion_tokens=value});
for(const value of [undefined,null,false,true,0,'false'])add(`thinking:${String(value)}`,c=>{c.body.chat_template_kwargs={enable_thinking:value}});
for(const value of [undefined,null,''])add(`auto:${String(value)}`,c=>{c.body.model=value});
for(const value of [undefined,null,0,'0',.03])add(`preference:${String(value)}`,c=>{c.config.routing.taskPreferences={coding:{model:c.config.models[0].id,tolerance:value}}});
for(const value of ['NaN','Infinity','1_0','0x1p2'])add(`invalid-number:${value}`,c=>{c.config.routing.sessionStickinessTtlMs=value},true);
add('invalid-missing-required',c=>{delete c.config.routing.qualityFloor},true);
add('invalid-request-number',c=>{c.body.max_tokens='not-a-number'},true);
// The export must not expand into an accidental full management-config dump.
const secret='feature-projection-must-exclude-this-sentinel';
const projected=structuredClone(original);
projected.upstream={apiKey:secret};projected.routing.internalCredential=secret;
projected.models[0].endpoint=secret;projected.models[0].benchmarkScores={notes:secret,subtasks:{fixture:{avg:.9,n:5,prompt:secret}}};
assert.ok(!JSON.stringify(featureConfig(projected)).includes(secret));
const input=rows.map(x=>JSON.stringify(x.row)).join('\n')+'\n';
const run=spawnSync(binary,['features-replay'],{input,encoding:'utf8',maxBuffer:32*1024*1024,timeout:60000,windowsHide:true});
if(run.error||run.status!==0)throw new Error(`feature boundary replay failed: ${run.error?.message||run.stderr}`);
const actual=run.stdout.trim().split(/\r?\n/).map(x=>JSON.parse(x));assert.equal(actual.length,rows.length);
for(let i=0;i<rows.length;i++){if(rows[i].invalid)assert.equal(typeof actual[i].error,'string',rows[i].id);else assert.deepEqual(actual[i],rows[i].expected,rows[i].id)}
const report={cases:rows.length,invalidRejected:rows.filter(x=>x.invalid).length,mismatches:0,projectionExcludesUnrelatedFields:true,corpusSha256:createHash('sha256').update(input).digest('hex'),binarySha256:createHash('sha256').update(readFileSync(binary)).digest('hex')};
const out=resolve(arg('--out')||resolve(root,'data/go-migration/feature-boundaries.json'));mkdirSync(dirname(out),{recursive:true});writeFileSync(out,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
