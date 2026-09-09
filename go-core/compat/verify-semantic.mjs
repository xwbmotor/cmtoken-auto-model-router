import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { dirname,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash,createHmac } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { loadConfig } from '../../src/config.mjs';
import { analyzeRequest,mergeSemanticAssessment } from '../../src/router.mjs';
import { parseSemanticAssessment,shouldUseSemanticRouter } from '../../src/semantic-router.mjs';
import { semanticPolicy } from './semantic-policy.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');const flag=process.argv.indexOf('--binary');if(flag<0)throw Error('--binary is required');const binary=resolve(process.argv[flag+1]);
const config=await loadConfig();config.semanticRouter={...config.semanticRouter,enabled:true,provider:'cascade',mode:'active'};
const cfg={taskRules:config.taskRules,budget:{defaultEstimatedOutputTokens:config.budget.defaultEstimatedOutputTokens}};
const policy=semanticPolicy(config);const prompts=JSON.parse(readFileSync(resolve(root,'config/eval-gate.json'),'utf8')).cases.map(c=>c.prompt);
const rows=[];const secret='synthetic-stable-secret-1234567890123456';
for(const prompt of prompts)for(const task of ['default','coding','reasoning','creative','extraction'])for(const [tier,complexity]of [['simple',.2],['balanced',.5],['complex',.9]]){
 const index=rows.length;const body={messages:[{role:'system',content:'这段代码不参与任务分类'},{role:'user',content:prompt}],max_tokens:900};if(index%4===0)body.tools=[{type:'function',function:{name:'web_search'}}];if(index%7===0)body.messages.push({role:'user',content:[{type:'image_url',image_url:{url:'opaque'}}]});
 const assessment={task,tier,complexity,confidence:index%2?.9:.4,reason:index%5?'fixture':''};
 rows.push({body,config:cfg,policy,content:JSON.stringify(assessment),secret,sessionId:index%3===0?'synthetic-session-'+index:'',authorization:index%3===1?'Bearer synthetic-token-'+index:'',requestId:'request-'+index});
}
for(const content of ['{}','not JSON',JSON.stringify({task:'invalid',tier:'simple',complexity:.2,confidence:.8}),JSON.stringify({task:'coding',tier:'wrong',complexity:.2,confidence:.8}),...[-1,2,'NaN',undefined].map(complexity=>JSON.stringify({task:'coding',tier:'simple',complexity,confidence:.8})),...['0.8',null,true,0.0625].map(confidence=>'```json\n'+JSON.stringify({task:'coding',tier:'simple',complexity:.0625,confidence,reason:'fixture'})+'\n```')])rows.push({...rows[0],content});
const corpus=rows.map(JSON.stringify).join('\n')+'\n';const run=spawnSync(binary,['semantic-replay'],{input:corpus,encoding:'utf8',maxBuffer:32*1024*1024,windowsHide:true});if(run.error||run.status!==0)throw run.error||Error(run.stderr);const output=run.stdout.trim().split('\n').map(JSON.parse);if(output.length!==rows.length)throw Error('missing replay output');
const expected=rows.map(row=>{try{const assessment=parseSemanticAssessment(row.content),base=analyzeRequest(row.body,config);const merged=mergeSemanticAssessment(base,assessment,true,row.body);delete merged.semantic;delete merged.routeMethod;
 let source='internal',key='rid:'+row.requestId;const token=row.authorization.replace(/^Bearer\s+/i,'').trim();if(token){source='fingerprint';key='fp:'+createHash('sha256').update(token).digest('hex').slice(0,8)}if(row.sessionId){source='session';key='sid:'+row.sessionId};const digest=text=>createHmac('sha256',row.secret).update(text).digest('hex');const rollout={bucket:parseInt(digest('semantic-rollout:'+key).slice(0,8),16)%100,bucketKey:key.split(':')[0]+':'+digest('bucket-key-fp:'+key).slice(0,16),bucketKeySource:source};return {assessment,merged,eligible:shouldUseSemanticRouter(base,row.body,config),rollout};}catch{return {error:true}}});
const mismatches=[];for(let i=0;i<rows.length;i++)if(!isDeepStrictEqual(output[i],expected[i]))mismatches.push({index:i,expected:expected[i],actual:output[i]});
const hash=x=>createHash('sha256').update(x).digest('hex');const report={scope:'semantic parse, analysis merge, eligibility, HMAC rollout',cases:rows.length,mismatchCount:mismatches.length,mismatches:mismatches.slice(0,20),corpusSha256:hash(corpus),binarySha256:hash(readFileSync(binary)),referenceSha256:hash(readFileSync(resolve(root,'src/semantic-router.mjs'))),at:new Date().toISOString()};mkdirSync(resolve(root,'data/go-migration'),{recursive:true});writeFileSync(resolve(root,'data/go-migration/semantic-verification.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({cases:rows.length,mismatches:mismatches.length}));if(mismatches.length)process.exitCode=1;
