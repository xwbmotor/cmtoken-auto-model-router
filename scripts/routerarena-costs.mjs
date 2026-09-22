import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export const COST_KINDS = ['generation', 'classifier', 'review', 'probe', 'tool'];
const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
export function costTemplate(evidence) {
  return { schemaVersion: 1, currency: 'CNY', requests: [...new Set(evidence.map(r => r.requestId).filter(Boolean))].map(requestId => ({ requestId,
    coverage: Object.fromEntries(COST_KINDS.map(k => [k, { status: 'pending', evidenceRef: null }])) })), entries: [] };
}
export function reconcileCosts(evidence, ledger) {
  requireValue(ledger.schemaVersion === 1 && /^[A-Z]{3}$/.test(ledger.currency), 'Invalid cost ledger');
  const expected = new Set(evidence.filter(r => r.status === 'started').map(r => r.requestId));
  requireValue(expected.size > 0 && Array.isArray(ledger.requests) && Array.isArray(ledger.entries), 'Missing request evidence');
  const requests = new Map();
  for (const r of ledger.requests) {
    requireValue(expected.has(r.requestId) && !requests.has(r.requestId), 'Unknown or duplicate request');
    requests.set(r.requestId, r);
  }
  const entries = new Map();
  for (const e of ledger.entries) {
    requireValue(typeof e.id === 'string' && e.id && expected.has(e.requestId) && COST_KINDS.includes(e.kind), 'Invalid cost entry identity');
    requireValue(['billed','usage_priced','estimated','unknown'].includes(e.basis) && e.currency === ledger.currency, 'Invalid cost basis or mixed currency');
    requireValue(typeof e.evidenceRef === 'string' && e.evidenceRef.trim(), 'Missing cost evidence reference');
    requireValue(e.basis === 'unknown' ? e.amount === null : typeof e.amount === 'number' && Number.isFinite(e.amount) && e.amount >= 0, 'Invalid amount');
    if (entries.has(e.id)) requireValue(JSON.stringify(entries.get(e.id)) === JSON.stringify(e), 'Conflicting duplicate cost entry');
    else entries.set(e.id, e);
  }
  const results = [...expected].map(requestId => {
    const r = requests.get(requestId), items = [...entries.values()].filter(e => e.requestId === requestId), missing = [];
    for (const kind of COST_KINDS) {
      const c = r?.coverage?.[kind], matching = items.filter(e => e.kind === kind);
      if (!c || !['complete','not_applicable'].includes(c.status) || !c.evidenceRef?.trim()) missing.push(kind);
      else if (c.status === 'not_applicable') {
        requireValue(kind !== 'generation' && matching.length === 0, 'Non-applicable component has calls');
      } else if (!matching.length || matching.some(e => e.amount === null)) missing.push(kind);
    }
    const sum = basis => items.filter(e => e.basis === basis).reduce((s,e) => s + e.amount, 0);
    const knownSubtotal = items.reduce((s,e) => s + (e.amount ?? 0), 0);
    requireValue(Number.isFinite(knownSubtotal), 'Cost total overflow');
    return { requestId, completed: evidence.some(e => e.requestId === requestId && e.status === 'complete'),
      billed: sum('billed'), usagePriced: sum('usage_priced'), estimated: sum('estimated'), knownSubtotal,
      total: missing.length ? null : knownSubtotal, missingComponents: missing,
      containsEstimates: items.some(e => e.basis === 'estimated') };
  });
  const complete = results.every(r => r.total !== null), completed = results.filter(r => r.completed).length;
  const total = complete ? results.reduce((s,r) => s + r.total, 0) : null;
  return { schemaVersion: 1, currency: ledger.currency, scope: 'all-recorded-generation-attempts-and-allocated-auxiliary-costs',
    coverageBasis: 'provided-ledger-attestations; verify against source logs and billing', requests: results,
    complete, total, knownSubtotal: results.reduce((s,r) => s+r.knownSubtotal,0), completedRequests: completed,
    costPerCompletedRequest: total !== null && completed ? total / completed : null,
    taskSuccessCost: null, leaderboardCost: null,
    note: '完整返回不等于任务成功；榜单费用单独按登记价格计算。estimated 为估算，usage_priced 为 usage 与单价折算，均非账单结算。' };
}
async function main() {
 const [evidencePath, ledgerPath, output] = process.argv.slice(2);
 requireValue(output, 'Usage: node scripts/routerarena-costs.mjs EVIDENCE_JSONL LEDGER_JSON NEW_OUTPUT');
 const rows=(await readFile(evidencePath,'utf8')).split(/\r?\n/).filter(Boolean).map(l=>JSON.parse(l));
 await writeFile(output,JSON.stringify(reconcileCosts(rows,JSON.parse(await readFile(ledgerPath,'utf8'))),null,2)+'\n',{flag:'wx'});
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) main().catch(e=>{console.error(e.message);process.exitCode=1;});
