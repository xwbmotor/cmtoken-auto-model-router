import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { NativeReceipts } from '../src/native-receipts.mjs';

for(const action of ['mark-applied','retry-unapplied']) test('offline native reconciliation: '+action,async()=>{
 const root=await mkdtemp(join(tmpdir(),'amr-reconcile-'));let store;
 try{
  const event={id:'c'.repeat(32),kind:'native_complete',receiptAt:Date.now(),private:'encrypted fixture'};
  store=await NativeReceipts.open(root);await assert.rejects(store.apply(event,'verified-digest',()=>{throw Error('interrupted')},async()=>{}));store.close();store=null;
  const args=[resolve('src/reconcile-native.mjs'),action,'--dir',root,'--id',event.id+':'+event.kind,'--digest','verified-digest'];
  const denied=spawnSync(process.execPath,args,{encoding:'utf8'});assert.notEqual(denied.status,0);
  const accepted=spawnSync(process.execPath,[...args,'--confirm-offline'],{encoding:'utf8'});assert.equal(accepted.status,0,accepted.stderr);assert.equal(accepted.stdout.includes('encrypted fixture'),false);
  store=await NativeReceipts.open(root);assert.equal(store.blocked,false);let applied=0;
  await store.apply(event,'verified-digest',()=>{applied++},async()=>{});assert.equal(applied,action==='mark-applied'?0:1);
 }finally{store?.close();await rm(root,{recursive:true,force:true});}
});
