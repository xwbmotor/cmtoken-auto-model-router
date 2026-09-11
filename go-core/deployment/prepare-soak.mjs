// Dedicated disposable soak fixture. No .env, production auth or model calls.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const directory=resolve(root,'data/go-soak');
await mkdir(resolve(directory,'config'),{recursive:true});
await mkdir(resolve(directory,'ledger'),{recursive:true});
await mkdir(resolve(directory,'evidence'),{recursive:true});
const config=JSON.parse(await readFile(resolve(root,'config/router.json'),'utf8'));
config.semanticRouter.enabled=false;
// This sustained storage workload exceeds the normal tenant API rate limit.
// Rate-limit behavior has separate gateway tests; keep it out of this fixture.
config.rateLimit={...config.rateLimit,enabled:false};
config.routing.mode='active';config.routing.activeTrafficPercent=100;config.routing.taskPreferences={};
config.routing.maxAttempts=2;config.routing.qualityFloor=0;config.routing.requestTimeoutMs=600000;
config.routing.circuitBreakerFailures=100;config.routing.circuitBreakerCooldownMs=1000;
config.models=config.models.filter(m=>m.enabled).slice(0,2);
if(config.models.length!==2)throw new Error('Two enabled fixture models required');
config.routing.shadowModel=config.models[0].id;
for(const model of config.models){
 model.minimumCompletionTokensForReliableAnswer=0;model.contextWindow=128000;model.benchmarkScores=null;
 model.quality=Object.fromEntries(Object.keys(model.quality).map(k=>[k,.99]));model.quality.default=.99;
 model.pricingYuanPerMillionTokens={input:1,output:2,inputCached:.5};
}
config.routing.loadBalancing={enabled:true,penaltyWeight:.2,limits:Object.fromEntries(config.models.map(m=>[m.id,128]))};
config.budget.enabled=true;config.budget.dailyBudgetYuan=100;config.budget.cacheHitRatio=0;
const key=()=>randomBytes(24).toString('hex');
const configDir=resolve(directory,'config');
await writeFile(resolve(configDir,'auth.json'),JSON.stringify({mode:'strict',accessToken:key(),adminToken:key(),upstreamToken:key()}),{flag:'wx',mode:0o600});
await writeFile(resolve(configDir,'router.json'),JSON.stringify(config),{flag:'wx',mode:0o600});
execFileSync(process.execPath,['go-core/compat/export-runtime.mjs','--config',resolve(configDir,'router.json'),'--out',resolve(configDir,'runtime.json')],{cwd:root,windowsHide:true,stdio:'pipe'});
console.log(JSON.stringify({fixture:'data/go-soak',externalModelCalls:0,productionReady:false}));
