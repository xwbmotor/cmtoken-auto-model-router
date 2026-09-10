// Go 1.27.1 high-level trace dump, streamed from `go tool trace -d=parsed`.
// Region names are fixed source labels; no application payload is logged.
import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
const active = new Map(), samples = {}, requests = [];
for await (const line of createInterface({ input: process.stdin })) {
  const m = line.match(/^M=-?\d+ P=-?\d+ G=(\d+) Region(Begin|End) Time=(\d+) Task=\d+ Type="(gateway\.[A-Za-z]+)"/);
  if (!m) continue;
  const [, g, action, ns, name] = m, at = BigInt(ns);
  if (action === 'Begin') {
    if (name === 'gateway.request') { assert.ok(!active.has(g)); active.set(g, { start: at, regions: new Map(), stages: {} }); }
    else { const r = active.get(g); if (r) { assert.ok(!r.regions.has(name)); r.regions.set(name, at); } }
  } else {
    const r = active.get(g); if (!r) continue;
    const started = name === 'gateway.request' ? r.start : r.regions.get(name);
    assert.notEqual(started, undefined, `region end without start: ${name}`);
    const ms = Number(at - started) / 1e6;
    (samples[name] ??= []).push(ms);
    if (name === 'gateway.request') {
      assert.equal(r.regions.size, 0);
      requests.push({startNs:r.start.toString(), durationMs:ms, stages:r.stages}); active.delete(g);
    } else { r.stages[name] = (r.stages[name] ?? 0) + ms; r.regions.delete(name); }
  }
}
assert.equal(active.size, 0, 'trace ended with incomplete requests');
assert.ok(requests.length > 0, 'no request regions; check Go trace dump format');
const quantile = (a,p) => a[Math.ceil(a.length*p)-1];
const summary = Object.fromEntries(Object.entries(samples).map(([name,a])=>{
  a.sort((x,y)=>x-y); return [name,{count:a.length,meanMs:a.reduce((s,x)=>s+x,0)/a.length,p50Ms:quantile(a,.5),p95Ms:quantile(a,.95),p99Ms:quantile(a,.99),maxMs:a.at(-1)}];
}));
requests.sort((a,b)=>b.durationMs-a.durationMs);
const result = {profiled:true, note:'Diagnostic timing includes tracing overhead and the short SSE checks; compare unprofiled capacity separately.',summary,requests};
writeFileSync(process.argv[2], JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({requests:requests.length,summary}));
