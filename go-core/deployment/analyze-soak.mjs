// Analyze saved laboratory evidence; missing or malformed evidence fails closed.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const args=process.argv.slice(2),smoke=args.includes('--smoke');
const positional=args.filter(arg=>arg!=='--smoke');
if(positional.length!==1||positional[0].startsWith('--'))throw new Error('Usage: node analyze-soak.mjs EVIDENCE_DIR [--smoke]');
const dir=resolve(positional[0]),checks=[];
const check=(name,pass,detail)=>checks.push({name,pass:pass===true,detail});
const finite=n=>typeof n==='number'&&Number.isFinite(n);
const integer=n=>Number.isInteger(n)&&n>=0;
async function read(name,lines=false){
 try{const raw=await readFile(join(dir,name),'utf8');const value=lines?raw.split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line)):JSON.parse(raw);if(!(lines?value:[value]).every(v=>v!==null&&typeof v==='object'&&!Array.isArray(v)))throw new Error('expected JSON object');check('source:'+name,!lines||value.length>0,'已读取且解析；空采样失败');return value}
 catch(error){check('source:'+name,false,error.code==='ENOENT'?'缺失':error.message);return lines?[]:{}}
}
const [r,samples,windows,streams,reloads,containerStats,container,before,expected,after,afterKill,restart,drain,audit]=await Promise.all([
 read('soak-result.json'),read('runtime-samples.jsonl',true),read('latency-windows.jsonl',true),read('long-streams.jsonl',true),read('reloads.jsonl',true),read('container-stats.jsonl',true),read('container.json'),read('before-restart.json'),read('expected-after-drain.json'),read('after-restart.json'),read('after-kill.json'),read('restart-result.json'),read('drain-result.json'),read('audit-result.json'),
]);
try{await readFile(join(dir,'soak-failure.json'));check('noFailureArtifact',false,'存在 soak-failure.json')}catch(error){check('noFailureArtifact',error.code==='ENOENT','不得存在失败产物')}
const p=r.parameters||{},c=r.counts||{},b=r.baseline||{},f=r.final||{};
const scenarios=['json','short','cancel','fail','retry','long'];
check('duration',finite(p.seconds)&&p.seconds>=(smoke?30:3600)&&finite(r.loadDurationMs)&&r.loadDurationMs>=p.seconds*1000&&finite(r.startedAt)&&finite(r.loadEndedAt)&&Math.abs(r.loadEndedAt-r.startedAt-r.loadDurationMs)<2,smoke?'显式短跑，不能声称完成一小时':'至少 3600 秒实际施加载荷');
check('targetRate',integer(p.rps)&&p.rps>0&&(smoke||p.rps===100),'完整验收固定 100 RPS');
check('containerResources',container.nanoCPUs===2000000000&&container.memoryBytes===536870912,'Go 固定为 2 CPU / 512 MiB');
check('plannedWork',integer(r.plannedRequests)&&r.plannedRequests===p.seconds*p.rps&&integer(c.started)&&integer(c.byScenario?.long)&&integer(c.dropped)&&r.plannedRequests===c.started-c.byScenario.long+c.dropped,'计划数 = started - long + dropped');
check('completedWork',integer(c.completed)&&c.started===c.completed&&['successful','expectedFailures','cancelled','unexpected'].every(k=>integer(c[k]))&&c.completed===c.successful+c.expectedFailures+c.cancelled+c.unexpected,'发起、完成与结果分类相符');
check('noErrorsOrDrops',c.unexpected===0&&c.dropped===0&&Array.isArray(r.failures)&&r.failures.length===0,'失败场景的预期 502 单独统计');
check('scenarioCoverage',scenarios.every(k=>integer(c.byScenario?.[k])&&c.byScenario[k]>0)&&Object.values(c.byScenario||{}).reduce((a,v)=>a+v,0)===c.started&&c.expectedFailures===c.byScenario?.fail&&c.cancelled===c.byScenario?.cancel,'六类请求均实际发起');
check('sourceAgreement',isDeepStrictEqual(r.windows,windows)&&samples.some(s=>isDeepStrictEqual(s,b))&&samples.some(s=>isDeepStrictEqual(s,f))&&r.reloads===reloads.length&&r.longStreams===streams.filter(s=>s.scenario==='long').length,'JSON 报告与逐行原始采样一致');
check('sampleTimeline',samples.length>=2&&samples.every((s,i)=>finite(s.at)&&(i===0||s.at>samples[i-1].at))&&samples[0]?.label==='baseline'&&f.at>=r.loadEndedAt+37000&&f.label==='idle-38s','包含基线及至少 37 秒空闲回落');
check('runtimeSampleCoverage',samples.filter(s=>s.label==='load').length>=Math.max(0,Math.floor(p.seconds/30)-1),'30 秒低频采样数量');
check('reloadCoverage',finite(p.reloadSeconds)&&reloads.length>=Math.floor(p.seconds/p.reloadSeconds)-1&&reloads.every((x,i)=>finite(x.at)&&x.from!==x.to&&[1,2].includes(x.scale)&&(i===0||x.at>reloads[i-1].at)),'按指定周期发生配置变更');
const prices=new Map();
if(reloads.length)prices.set(reloads[0].from,3-reloads[0].scale);
let priceChainValid=reloads.length>0;
for(const [i,x] of reloads.entries()){
 if((i>0&&x.from!==reloads[i-1].to)||(prices.has(x.to)&&prices.get(x.to)!==x.scale)||prices.get(x.from)!==3-x.scale)priceChainValid=false;
 prices.set(x.to,x.scale);
}
const longStreams=streams.filter(s=>s.scenario==='long');
check('longStreamAcrossReload',longStreams.length>0&&longStreams.every(s=>finite(s.elapsedMs)&&s.elapsedMs>=p.longSeconds*1000-100&&finite(s.startedAt)&&finite(s.finishedAt)&&s.finishedAt>s.startedAt&&[20,40].includes(s.expectedMicros))&&longStreams.some(s=>reloads.some(x=>x.at>s.startedAt&&x.at<s.finishedAt&&x.to!==s.revision)),'长流完成并跨配置代；每条记录含原代价格结果');
check('longStreamGenerationPrice',priceChainValid&&longStreams.every(s=>prices.has(s.revision)&&s.expectedMicros===20*prices.get(s.revision)),'配置变更价格链一致；长流按响应配置代计价');
check('actualBilling',integer(r.expectedActualMicros)&&b.ledger?.actualMicros===0&&f.ledger?.actualMicros===r.expectedActualMicros&&f.ledger?.sources?.answer?.actualMicros===r.expectedActualMicros,'客户端成功完成计价与账本 actual 相等');
check('idleState',f.ledger?.pendingReserves===0&&f.ledger?.pendingMicros===0&&f.diagnostics?.runtime?.activeRequests===0&&f.diagnostics?.generations?.retired===0&&f.diagnostics?.generations?.live===1&&f.inflight!==undefined&&Object.values(f.inflight).every(n=>n===0)&&f.mock?.active===0&&f.mock?.retryMarkers===0,'请求、模型槽位、pending、旧配置代、mock 重试标记归零');
check('retainedAttempts',integer(f.diagnostics?.runtime?.retainedAttempts)&&f.diagnostics.runtime.retainedAttempts===f.mock?.attempts,'内存保留历史条数与 mock 尝试数一致');
check('idleGoroutines',integer(b.diagnostics?.process?.goroutines)&&integer(f.diagnostics?.process?.goroutines)&&f.diagnostics.process.goroutines<=b.diagnostics.process.goroutines+16,'空闲协程数不高于基线 + 16');
check('restartLedger',Object.hasOwn(before,'actualMicros')&&isDeepStrictEqual(before,f.ledger)&&Object.hasOwn(expected,'actualMicros')&&isDeepStrictEqual(after,expected)&&isDeepStrictEqual(afterKill,expected),'保存、正常重启、SIGKILL 后账本原字段逐项相等');
check('activeDrainBilling',drain.completedDuringShutdown===true&&drain.stream?.scenario==='drain'&&drain.stream.elapsedMs>=4900&&[20,40].includes(drain.stream.expectedMicros)&&expected.actualMicros===before.actualMicros+drain.stream.expectedMicros&&expected.estimatedMicros===before.estimatedMicros&&expected.pendingReserves===0,'SIGTERM 中长流完成并新增相应 actual');
const projected=structuredClone(before);
if(projected.sources?.answer&&finite(drain.stream?.expectedMicros)){projected.actualMicros+=drain.stream.expectedMicros;projected.sources.answer.actualMicros+=drain.stream.expectedMicros}
check('drainOnlyChangesActual',Boolean(projected.sources?.answer)&&isDeepStrictEqual(projected,expected)&&streams.some(s=>isDeepStrictEqual(s,drain.stream)),'排空仅新增 answer actual，其余账本字段保持一致，长流原记录存在');
check('restartIsolation',restart.gracefulActiveStreamCompleted===true&&restart.restartLedgerEqual===true&&restart.killSettledLedgerEqual===true&&restart.network==='none'&&restart.portBindings===0&&restart.productionReady===false,'执行脚本确认优雅退出、两次恢复和无网络/端口');
check('auditConsistency',integer(audit.events)&&audit.events===f.mock?.attempts+1&&audit.actualMicros===expected.actualMicros&&audit.estimatedMicros===expected.estimatedMicros&&audit.uniqueAttempts===true&&audit.redacted===true&&audit.matchesLedger===true&&Object.values(audit.outcomes||{}).reduce((a,v)=>a+v,0)===audit.events,'审计条数 = soak 尝试 + drain；actual/estimated 与账本一致，唯一性与脱敏由审计程序验证');

const median=values=>{if(!values.length)return null;const v=[...values].sort((a,b)=>a-b),m=Math.floor(v.length/2);return v.length%2?v[m]:(v[m-1]+v[m])/2};
const buckets=new Map();
let latencyValid=windows.length>0;
for(const w of windows){
 if(!finite(w.from)||!finite(w.at)||w.at<=w.from||!w.latency){latencyValid=false;continue}
 const period=Math.max(0,Math.min(Math.ceil(p.seconds/600)-1,Math.floor((w.from-r.startedAt)/600000)));
 for(const [scenario,d] of Object.entries(w.latency)){
  if(!d||!integer(d.count)||d.count===0||!finite(d.p95Ms)||!finite(d.p50Ms)||!finite(d.p99Ms)||d.p50Ms>d.p95Ms||d.p95Ms>d.p99Ms||d.p99Ms>10000||d.p50Ms<0||!integer(d.overflow)||d.overflow>d.count){latencyValid=false;continue}
  const key=period+':'+scenario;
  if(!buckets.has(key))buckets.set(key,{period,scenario,windows:0,requests:0,p95:[],overflow:0});
  const row=buckets.get(key);row.windows++;row.requests+=d.count;row.p95.push(d.p95Ms);row.overflow+=d.overflow;
 }
}
check('latencyEvidence',latencyValid&&windows.reduce((sum,w)=>sum+Object.entries(w.latency||{}).filter(([k])=>!k.endsWith('FirstByte')).reduce((n,[,d])=>n+(d?.count||0),0),0)===c.completed,'窗口按 from 归入十分钟段，尾部窗口含排空；直方图请求总数一致');
const latency=[...buckets.values()].sort((a,b)=>a.period-b.period||a.scenario.localeCompare(b.scenario)).map(({p95,...row})=>({...row,windowP95MedianMs:median(p95),windowP95MaxMs:Math.max(...p95)}));
for(const row of latency){const previous=latency.find(x=>x.period===row.period-1&&x.scenario===row.scenario);row.windowP95MedianChangeMs=previous?row.windowP95MedianMs-previous.windowP95MedianMs:null}
const memory=samples.map(s=>({at:s.at,label:s.label,heapAllocBytes:s.diagnostics?.process?.heapAllocBytes,heapInuseBytes:s.diagnostics?.process?.heapInuseBytes,heapObjects:s.diagnostics?.process?.heapObjects,numGC:s.diagnostics?.process?.numGC,goroutines:s.diagnostics?.process?.goroutines,retainedAttempts:s.diagnostics?.runtime?.retainedAttempts}));
check('persistenceHealth',samples.length>0&&samples.every(s=>s.persistenceHealthy===true),'所有采样时点持久化健康');
check('memoryEvidence',memory.length>=2&&memory.every(s=>['heapAllocBytes','heapInuseBytes','heapObjects','numGC','goroutines','retainedAttempts'].every(k=>integer(s[k]))),'Go 进程堆/GC/协程和保留历史均有数值');
const summary=values=>values.length?{first:values[0],last:values.at(-1),max:Math.max(...values),delta:values.at(-1)-values[0]}:null;
const runtimeMemory=Object.fromEntries(['heapAllocBytes','heapInuseBytes','heapObjects','numGC','goroutines','retainedAttempts'].map(k=>[k,summary(memory.map(s=>s[k]).filter(finite))]));
function bytes(value){const m=String(value).trim().match(/^([\d.]+)\s*(B|KiB|MiB|GiB|TiB|kB|MB|GB)$/);if(!m)return null;return Number(m[1])*({B:1,KiB:1024,MiB:1024**2,GiB:1024**3,TiB:1024**4,kB:1000,MB:1e6,GB:1e9}[m[2]])}
const dockerMemory=containerStats.map(s=>({at:s.at,bytes:bytes(s.stats?.MemUsage?.split('/')[0])}));
check('dockerEvidence',integer(container.memoryBytes)&&container.memoryBytes>0&&dockerMemory.length>=Math.max(1,Math.floor(p.seconds/40))&&dockerMemory.every(s=>finite(s.at)&&finite(s.bytes)),'Docker stats 内存独立于 Go heap，采样间隔含 stats 执行开销');
const limits=['仅隔离 mock 部署；不代表真实上游延迟、生产容量或生产可切换。','只提供 30 秒窗口 P95 的中位数/最大值，不能合并成十分钟或整场请求 P95；overflow 表示被 10000 ms 顶格截断，long 场景尤其如此。','账本保留已完成/释放尝试的幂等历史；随 retainedAttempts 增长的内存不直接证明泄漏，也不证明长期内存稳定。','采样不强制 GC；Go heap 与 Docker stats 内存口径不同。一次一小时及 38 秒空闲不足以排除长期泄漏。','窗口按起始时间归段，跨段和最终排空窗口会混入相邻时段；窗口统计不作请求级分位数推断。'];
const result={status:checks.every(c=>c.pass)?(smoke?'SMOKE_PASS':'PASS'):'FAIL',mode:smoke?'smoke':'one-hour',productionReady:false,parameters:p,plannedRequests:r.plannedRequests,counts:c,checks,latency,runtimeMemory,dockerMemory:summary(dockerMemory.map(s=>s.bytes).filter(finite)),limits};
const lines=[`# Go 隔离稳定性分析：${result.status}`,'',`模式：${smoke?'显式短跑':'一小时'}；配置 ${p.seconds??'未知'} 秒 / ${p.rps??'未知'} RPS。`, '',`实际载荷时长：${finite(r.loadDurationMs)?(r.loadDurationMs/1000).toFixed(3):'未知'} 秒。计划请求 ${r.plannedRequests??'未知'}；发起 ${c.started??'未知'}（含额外长流）；丢弃 ${c.dropped??'未知'}；非预期错误 ${c.unexpected??'未知'}。`,'','## 验收检查','','| 检查 | 结果 | 说明 |','|---|---|---|',...checks.map(c=>`| ${c.name} | ${c.pass?'通过':'失败/缺失'} | ${String(c.detail).replaceAll('|','/').replaceAll('\n',' ')} |`),'','## 各十分钟段的窗口 P95','','下表是窗口 P95 的中位数/最大值，不是该时段所有请求的 P95。firstByte 单独列出。','','| 分钟段 | 场景 | 窗口数 | 样本数 | 窗口 P95 中位数 ms | 最大值 ms | 顶格数 |','|---|---|---:|---:|---:|---:|---:|',...latency.map(x=>`| ${x.period*10}–${(x.period+1)*10} | ${x.scenario} | ${x.windows} | ${x.requests} | ${x.windowP95MedianMs} | ${x.windowP95MaxMs} | ${x.overflow} |`),'','## 内存与空闲回落','','| 指标 | 基线/首样本 | 末样本 | 最大值 | 变化 |','|---|---:|---:|---:|---:|',...Object.entries({...runtimeMemory,dockerMemoryBytes:result.dockerMemory}).map(([k,v])=>`| ${k} | ${v?.first??'缺失'} | ${v?.last??'缺失'} | ${v?.max??'缺失'} | ${v?.delta??'缺失'} |`),'','## 解释边界','',...limits.map(x=>'- '+x),''];
const changes=latency.filter(x=>x.windowP95MedianChangeMs!==null).map(x=>`| ${x.period*10}–${(x.period+1)*10} | ${x.scenario} | ${x.windowP95MedianChangeMs} |`);
if(changes.length)lines.splice(lines.indexOf('## 内存与空闲回落')-1,0,'','相邻十分钟段窗口 P95 中位数变化（ms；不是请求整体 P95 变化）：','','| 分钟段 | 场景 | 相对上一段变化 ms |','|---|---|---:|',...changes,'');
await writeFile(join(dir,'analysis-result.json'),JSON.stringify(result,null,2)+'\n');
await writeFile(join(dir,'analysis-result.md'),lines.join('\n'));
console.log(JSON.stringify({status:result.status,failedChecks:checks.filter(c=>!c.pass).map(c=>c.name),output:join(dir,'analysis-result.md')}));
if(result.status==='FAIL')process.exitCode=1;
