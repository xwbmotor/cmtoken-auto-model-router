import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvalJobStore } from '../src/eval-job-store.mjs';

const job = (id, status = 'running') => ({id:'job_'+id,type:'checkup',modelId:'fixture',startedAt:new Date().toISOString(),
  status,done:1,failed:0,results:[{id:'one',ok:true,excerpt:'saved'}],finishedAt:status==='done'?new Date().toISOString():null});
async function fixture(fn) { const dir = await mkdtemp(join(tmpdir(),'amr-eval-store-'));try {await fn(join(dir,'jobs.json'));} finally {await rm(dir,{recursive:true,force:true});} }

test('restart preserves completed results and marks running jobs interrupted without executing them',async()=>fixture(async path=>{
  const s=await EvalJobStore.load(path);await s.add(job('running'));await s.add(job('done','done'));
  const restored=await EvalJobStore.load(path);
  assert.equal(restored.jobs.get('job_running').status,'interrupted');
  assert.equal(restored.jobs.get('job_running').done,1);assert.equal(restored.jobs.get('job_running').results[0].excerpt,'saved');
  assert.equal(restored.jobs.get('job_done').status,'done');
  const again=await EvalJobStore.load(path);assert.equal(again.jobs.get('job_running').finishedAt,restored.jobs.get('job_running').finishedAt);
}));

test('checkpoint writes remain ordered and do not leave partial JSON',async()=>fixture(async path=>{
  const s=await EvalJobStore.load(path);const j=job('ordered');await s.add(j);const saves=[];
  for(let i=0;i<12;i++){j.done=i;saves.push(s.save());}await Promise.all(saves);
  assert.equal(JSON.parse(await readFile(path,'utf8')).jobs[0].done,11);
}));

test('expired results are removed on recovery',async()=>fixture(async path=>{
  const s=await EvalJobStore.load(path);const j=job('old','done');j.finishedAt=new Date(Date.now()-3*3600000).toISOString();await s.add(j);
  assert.equal((await EvalJobStore.load(path)).jobs.size,0);
}));

test('corrupt task data is rejected instead of silently losing results',async()=>fixture(async path=>{
  await writeFile(path,'{bad');await assert.rejects(EvalJobStore.load(path));
}));

test('retention count evicts finished records, never running jobs',async()=>fixture(async path=>{
  const s=await EvalJobStore.load(path);for(let i=0;i<32;i++)await s.add(job(String(i),'done'));
  await s.add(job('active'));assert.equal(s.jobs.size,32);assert.equal(s.jobs.get('job_active').status,'running');assert.equal(s.jobs.has('job_0'),false);
}));
