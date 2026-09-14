// Check workload integrity, not a production latency SLO.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const files=process.argv.slice(2);assert.ok(files.length,'Provide capacity JSON reports');
for(const file of files){
 const r=JSON.parse(readFileSync(file,'utf8'));assert.ok(!r.failure,`${file}: experiment failed`);
 assert.ok(Array.isArray(r.runs)&&r.runs.length,`${file}: missing runs`);
 for(const run of r.runs){
  const where=`${file}: ${run.id}`;
  for(const key of ['offered','started','complete','errors','droppedByGenerator'])assert.ok(Number.isSafeInteger(run[key])&&run[key]>=0,`${where}: invalid ${key}`);
  assert.equal(run.errors,0,`${where}: request errors`);assert.equal(run.droppedByGenerator,0,`${where}: generator dropped requests`);
  assert.equal(run.started,run.offered,`${where}: incomplete offered workload`);assert.equal(run.complete,run.started,`${where}: incomplete responses`);
  if(run.resources){assert.equal(run.resources.after.memoryEvents.oom_kill-run.resources.before.memoryEvents.oom_kill,0,`${where}: OOM`);}
 }
 for(const role of ['node','go']){const e=r.decisionEvidence?.[role];assert.ok(e,`${file}: missing ${role} evidence`);assert.equal(e.missing,0);assert.equal(e.duplicates,0);assert.equal(e.records,e.successfulRequests);}
}
console.log(JSON.stringify({workloadIntegrityPassed:true,reports:files.length,productionSLOVerified:false}));
