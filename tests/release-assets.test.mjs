import test from 'node:test';
import assert from 'node:assert/strict';
import { publishAssets } from '../scripts/publish-release-assets.mjs';
const file = name => ({ name, size: 123, digest: 'sha256:'+'a'.repeat(64) });
const asset = f => ({ ...f, state: 'uploaded' });
function api(initial = []) {
 const state = { rows: initial, uploads: [] };
 return { state, list: async () => state.rows, digest: async a => a.digest, upload: async f => { state.uploads.push(f.name); state.rows.push(asset(f)); } };
}
test('identical existing files are reused and missing files verified', async () => {
 const a=file('old'), b=file('new'), client=api([asset(a)]);
 const result=await publishAssets([a,b],client);
 assert.deepEqual(client.state.uploads,['new']);assert.equal(result[0].action,'reused');
 await publishAssets([a,b],client);assert.deepEqual(client.state.uploads,['new']);
});
test('a conflict anywhere in the batch prevents every upload', async () => {
 const a=file('new'), b=file('existing'), client=api([{...asset(b),digest:'sha256:'+'b'.repeat(64)}]);
 await assert.rejects(publishAssets([a,b],client),/differs/);assert.equal(client.state.uploads.length,0);
});
test('uncertain upload reconciles a matching race without retry', async () => {
 const a=file('race'), client=api();let attempts=0;
 client.upload=async f=>{attempts++;client.state.rows.push(asset(f));throw Error('response lost');};
 await publishAssets([a],client);assert.equal(attempts,1);
});
test('conflicting races and partial uploads fail without replacement', async () => {
 for(const change of [{digest:'sha256:'+'b'.repeat(64)},{state:'starter'},{size:3}]) {
  const a=file('race'), client=api();client.upload=async f=>{client.state.rows.push({...asset(f),...change});throw Error('race');};
  await assert.rejects(publishAssets([a],client),/differs/);assert.equal(client.state.rows.length,1);
 }
});
test('missing checksum must be computed; read failure cannot skip verification', async () => {
 const a=file('legacy'), remote=asset(a);delete remote.digest;const client=api([remote]);let reads=0;
 client.digest=async()=>{reads++;return a.digest;};await publishAssets([a],client);assert.equal(reads,1);assert.equal(client.state.uploads.length,0);
 client.digest=async()=>{throw Error('download failed');};await assert.rejects(publishAssets([a],client),/download failed/);
});
test('duplicate names and unconfirmed writes fail', async () => {
 const a=file('a');await assert.rejects(publishAssets([a,a],api()),/duplicate/);
 const client=api();client.upload=async()=>{throw Error('network');};await assert.rejects(publishAssets([a],client),/not confirmed/);
 await assert.rejects(publishAssets([a],api([asset(a),asset(a)])),/Duplicate remote/);
});
