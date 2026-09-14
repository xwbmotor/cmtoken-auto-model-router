import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeReceipts } from '../src/native-receipts.mjs';
import { createGoCoreEdge } from '../src/go-core-edge.mjs';

test('batched native HTTP results preserve per-event identity and flush once',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'amr-native-batch-'));const receipts=await NativeReceipts.open(dir);let effects=0,flushes=0;
 const token='fixture-edge-token-'.repeat(3);
 const edge=createGoCoreEdge({AMR_GO_CHAT_URL:'http://127.0.0.1:19999/v1/chat/completions',AMR_GO_EDGE_TOKEN:token,AMR_GO_NATIVE_FRONT:'1'},
  {receipts,prepare:()=>async()=>{effects++},flush:async()=>{flushes++},context:()=>({})});
 const server=createServer((req,res)=>edge.accept(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const send=items=>new Promise((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port:server.address().port,path:'/internal/v1/go-events',method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end(JSON.stringify({kind:'native_batch',items:items.map(x=>Buffer.from(JSON.stringify(x)).toString('base64'))}));});
 try{
  const a={id:'a'.repeat(32),kind:'native_complete',receiptAt:Date.now()},b={...a,id:'b'.repeat(32)};
  assert.equal(await send([a,b,a]),204);assert.equal(effects,2);assert.equal(flushes,1);
  assert.equal(await send([a,b]),204);assert.equal(effects,2);assert.equal(flushes,1);
  assert.equal(await send([{...a,changed:true}]),422);assert.equal(effects,2);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));edge.close();receipts.close();await rm(dir,{recursive:true,force:true});}
});
