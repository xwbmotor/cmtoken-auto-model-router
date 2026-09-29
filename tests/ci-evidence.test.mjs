import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveIdentity, collectEvidence } from '../scripts/archive-ci-evidence.mjs';
test('CI archive identity separates runs, attempts and formal releases',()=>{
 const env={GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',GITHUB_SHA:'a'.repeat(40),EVIDENCE_LABEL:'test'};
 const a=archiveIdentity(env,new Date('2026-09-30'));assert.equal(a.tag,'ci-evidence-2026-09');
 assert.notEqual(a.name,archiveIdentity({...env,GITHUB_RUN_ATTEMPT:'2'}).name);
 assert.equal(archiveIdentity({...env,EVIDENCE_RELEASE_TAG:'v0.14.10'}).tag,'v0.14.10');
 assert.throws(()=>archiveIdentity({...env,EVIDENCE_RELEASE_TAG:'../bad'}));
});
test('evidence glob preserves relative paths, deduplicates and rejects credential files',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'amr-evidence-'));
 try {
  await mkdir(join(dir,'evidence'));await writeFile(join(dir,'evidence','test.json'),'{}');
  assert.deepEqual(await collectEvidence(dir,['evidence/','evidence/*.json']),['evidence/test.json']);
  await writeFile(join(dir,'evidence','credentials.json'),'secret');
  await assert.rejects(collectEvidence(dir,['evidence/']),/Credential/);
  await assert.rejects(collectEvidence(dir,['../outside']),/escapes/);
 } finally {await rm(dir,{recursive:true,force:true});}
});
