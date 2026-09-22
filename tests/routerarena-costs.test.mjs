import test from 'node:test';
import assert from 'node:assert/strict';
import { costTemplate, reconcileCosts, COST_KINDS } from '../scripts/routerarena-costs.mjs';
const evidence=[{requestId:'a',status:'started'},{requestId:'a',status:'complete'},{requestId:'b',status:'started'},{requestId:'b',status:'failed_or_unknown'}];
function fixture(){
 const l=costTemplate(evidence);
 for(const r of l.requests)for(const k of COST_KINDS)r.coverage[k]={status:k==='generation'?'complete':'not_applicable',evidenceRef:'source-log:1'};
 l.entries=['a','b'].map((requestId,i)=>({id:'attempt-'+i,requestId,kind:'generation',amount:i+1,currency:'CNY',basis:'usage_priced',evidenceRef:'attempt-log:'+i}));return l;
}
test('unknown costs remain null; failed attempts belong in total cost',()=>{
 assert.equal(reconcileCosts(evidence,costTemplate(evidence)).total,null);
 const result=reconcileCosts(evidence,fixture());assert.equal(result.total,3);assert.equal(result.costPerCompletedRequest,3);assert.equal(result.taskSuccessCost,null);
 const l=fixture();l.entries[1].amount=null;l.entries[1].basis='unknown';
 const partial=reconcileCosts(evidence,l);assert.equal(partial.total,null);assert.equal(partial.knownSubtotal,1);
});
test('deduplicates stable entries and rejects conflicts, mixed currency and false zero coverage',()=>{
 const l=fixture();l.entries.push({...l.entries[0]});assert.equal(reconcileCosts(evidence,l).total,3);
 l.entries.at(-1).amount=9;assert.throws(()=>reconcileCosts(evidence,l),/Conflicting/);
 const mixed=fixture();mixed.entries[0].currency='USD';assert.throws(()=>reconcileCosts(evidence,mixed),/currency/);
 const invalid=fixture();invalid.requests[0].coverage.generation.status='not_applicable';assert.throws(()=>reconcileCosts(evidence,invalid),/Non-applicable/);
});
