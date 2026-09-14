import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeReceipts } from '../src/native-receipts.mjs';

async function fixture(fn) {const dir=await mkdtemp(join(tmpdir(),'amr-receipts-'));let s;try{s=await NativeReceipts.open(dir);await fn(s,dir);}finally{try{s?.close();}catch{}await rm(dir,{recursive:true,force:true});}}
const event=()=>({id:'a'.repeat(32),kind:'native_complete',receiptAt:Date.now(),request:{body:{messages:[{content:'private fixture content'}]}}});

test('native receipt suppresses repeated effects across process-store restart',async()=>fixture(async(s,dir)=>{
 const e=event();let applied=0;await s.apply(e,'digest',()=>{applied++},async()=>{});s.close();
 const restored=await NativeReceipts.open(dir);try{await restored.apply(e,'digest',()=>{applied++},async()=>{});assert.equal(applied,1);assert.equal(restored.blocked,false);}finally{restored.close();}
}));

test('uncertain effects block recovery instead of repeating a possible charge',async()=>fixture(async(s,dir)=>{
 const e=event();await assert.rejects(s.apply(e,'digest',()=>{throw Error('simulated crash boundary')},async()=>{}));
 assert.equal(s.blocked,true);assert.equal(s.status().pendingReconciliation,1);
 const row=s.db.prepare('SELECT payload FROM receipts').get();assert.equal(Buffer.from(row.payload).includes(Buffer.from('private fixture content')),false);
 assert.equal(s.decrypt(row.payload).request.body.messages[0].content,'private fixture content');
 s.close();const restored=await NativeReceipts.open(dir);try{assert.equal(restored.blocked,true);await assert.rejects(restored.apply(e,'digest',()=>{throw Error('must not run')},async()=>{}),/reconciliation/);}finally{restored.close();}
}));

test('receipt requires matching payload digest and rejects stale events',async()=>fixture(async(s)=>{
 const e=event();await s.apply(e,'one',async()=>{},async()=>{});await assert.rejects(s.apply(e,'two',async()=>{},async()=>{}),/conflict/);
 const stale={...e,id:'b'.repeat(32),receiptAt:Date.now()-25*3600000};await assert.rejects(s.apply(stale,'three',async()=>{},async()=>{}),/expired/);
}));

test('historic configuration is retained encrypted for delayed results',async()=>fixture(async(s)=>{
 s.savePolicy('revision',{models:[{id:'old'}],privateSetting:'protected'});assert.equal(s.policy('revision').models[0].id,'old');
 assert.equal(Buffer.from(s.db.prepare('SELECT payload FROM policies').get().payload).includes(Buffer.from('protected')),false);
}));

test('batched receipts share one durability barrier and replay no effects',async()=>fixture(async(s)=>{
 let effects=0,flushes=0;
 const items=Array.from({length:8},(_,i)=>({event:{...event(),id:String(i).padStart(32,'0')},digest:'digest-'+i,action:async()=>{effects++}}));
 await s.applyMany(items,async()=>{flushes++});
 await s.applyMany(items,async()=>{flushes++});
 assert.equal(effects,8);assert.equal(flushes,1);
 assert.equal(s.db.prepare("SELECT count(*) n FROM receipts WHERE state='done'").get().n,8);
}));
