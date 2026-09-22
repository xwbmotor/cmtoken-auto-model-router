import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeRelease } from '../scripts/release-evidence.mjs';
const sha = 'a'.repeat(40);
function fixture() {
  return { version:'1.2.3',stamp:'2026-09-22T00:00:00Z',validForRelease:true,allowDirty:false,exitCode:0,signal:null,
    git:{tag:'v1.2.3',commit:sha,dirty:[]}, gate:{clean:true},summary:{tests:4,pass:4,fail:0,skipped:0,cancelled:0},
    images:Object.fromEntries(['router','classifier','go'].flatMap(n=>[[n+'ImageId','sha256:'+'b'.repeat(64)],[n+'LabelsRevision',sha]])),
    env:{secret:'do-not-publish'}, logTail:'private prompt', config:{token:'secret'} };
}
test('release evidence only exposes checked identity and numeric results',()=>{
 const result=summarizeRelease(fixture(),'v1.2.3',sha);
 assert.equal(result.checks.passed,4);assert.equal(result.deploymentVerified,false);
 assert.ok(!JSON.stringify(result).includes('secret'));assert.ok(!JSON.stringify(result).includes('private prompt'));
});
test('failed, skipped, dirty and mismatched reports cannot become release evidence',()=>{
 for(const mutate of [r=>r.summary.skipped=1,r=>r.summary.cancelled=1,r=>r.summary.pass=3,r=>r.git.dirty.push('x'),r=>r.allowDirty=true,r=>r.gate.clean=false,r=>r.images.goLabelsRevision='b'.repeat(40)]) {
  const r=fixture();mutate(r);assert.throws(()=>summarizeRelease(r,'v1.2.3',sha));
 }
 assert.throws(()=>summarizeRelease(fixture(),'v1.2.4',sha));
});
