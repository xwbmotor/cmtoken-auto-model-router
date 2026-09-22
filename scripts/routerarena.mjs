// RouterArena interoperability runner. No network requests without --execute.
import { readFile, writeFile, mkdir, open } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { costTemplate } from './routerarena-costs.mjs';

export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
const integer = x => Number.isSafeInteger(x) && x >= 0;

export function prepare(manifest, dataset) {
  requireValue(manifest.schemaVersion === 1, 'Unsupported manifest version');
  requireValue(/^[a-z0-9][a-z0-9_-]+$/.test(manifest.name), 'Invalid run name');
  requireValue(typeof manifest.autoModel === 'string' && manifest.autoModel, 'Missing Auto model ID');
  requireValue(typeof manifest.policyRevision === 'string' && manifest.policyRevision, 'Missing frozen policy revision');
  requireValue(typeof manifest.routerArenaCommit === 'string' && /^[a-f0-9]{40}$/.test(manifest.routerArenaCommit), 'Pin RouterArena to a full commit SHA');
  requireValue(['smoke', 'sub_10', 'full', 'robustness'].includes(manifest.split), 'Invalid split');
  requireValue(integer(manifest.maxRequests) && manifest.maxRequests > 0, 'Invalid request cap');
  requireValue(integer(manifest.maxTokens) && manifest.maxTokens > 0, 'Invalid output token cap');
  requireValue(integer(manifest.timeoutMs) && manifest.timeoutMs > 0 && manifest.timeoutMs <= 600000, 'Invalid timeout');
  requireValue(Array.isArray(manifest.models) && manifest.models.length > 0, 'Missing frozen model pool');
  const ids = new Set(), names = new Set();
  for (const m of manifest.models) {
    requireValue(typeof m.id === 'string' && m.id && typeof m.arenaId === 'string' && m.arenaId, 'Missing model identity');
    requireValue(!ids.has(m.id) && !names.has(m.arenaId), 'Duplicate model identity');
    ids.add(m.id); names.add(m.arenaId);
    requireValue(Array.isArray(m.responseIds) && m.responseIds.length > 0 && m.responseIds.every(x => typeof x === 'string' && x), 'Missing expected upstream response IDs');
  }
  requireValue(Array.isArray(dataset) && dataset.length > 0, 'Dataset must be a nonempty JSON array');
  requireValue(dataset.length <= manifest.maxRequests, 'Dataset exceeds request cap');
  const seen = new Set();
  const cases = dataset.map(row => {
    const id = row['global index'] ?? row.global_index;
    const prompt = row.prompt_formatted ?? row.prompt;
    requireValue((typeof id === 'string' && id.length > 0) || integer(id), 'Invalid global index');
    requireValue(!seen.has(String(id)), 'Duplicate global index');
    seen.add(String(id));
    requireValue(typeof prompt === 'string' && prompt.trim(), 'Missing prompt');
    // Never forward answers, labels, categories or difficulty metadata to Auto.
    return { 'global index': id, prompt };
  });
  return { manifestHash: hash(manifest), datasetHash: hash(cases), cases };
}

export function decodeResponse(manifest, headers, body) {
  const selected = headers.get('x-router-selected-model');
  const model = manifest.models.find(m => m.id === selected);
  requireValue(model, 'Selected model is outside the frozen pool or header is missing');
  requireValue(headers.get('x-router-policy-revision') === manifest.policyRevision, 'Policy revision changed or missing');
  requireValue(model.responseIds.includes(body.model), 'Upstream model identity changed or missing');
  const choice = body.choices?.[0];
  requireValue(choice?.finish_reason === 'stop', 'Incomplete or non-text completion');
  requireValue(typeof choice.message?.content === 'string' && choice.message.content.trim(), 'Empty answer');
  const u = body.usage;
  requireValue(integer(u?.prompt_tokens) && integer(u?.completion_tokens) && u.completion_tokens > 0, 'Missing or invalid billable token usage');
  return {
    prediction: model.arenaId,
    generated_result: {
      generated_answer: choice.message.content, success: true,
      token_usage: { input_tokens: u.prompt_tokens, output_tokens: u.completion_tokens },
      provider: 'amr-upstream', model_used: model.arenaId, error: null,
    },
    evidence: { selectedModel: selected, responseModel: body.model,
      suggestedModel: headers.get('x-router-suggested-model'),
      shadow: headers.get('x-router-shadow'), usage: u },
  };
}

export async function run({ manifest, dataset, out, execute = false, endpoint, key, fetchImpl = fetch }) {
  const plan = prepare(manifest, dataset);
  if (!execute) return { mode: 'preflight', requests: plan.cases.length,
    manifestHash: plan.manifestHash, datasetHash: plan.datasetHash,
    identityVerified: manifest.models.every(m => m.identityVerified === true),
    networkCalls: 0, leaderboardReady: false };
  requireValue(manifest.models.every(m => m.identityVerified === true), 'Verify model identities before execution');
  requireValue(!manifest.policyRevision.startsWith('REPLACE_') && manifest.routerArenaCommit !== '0'.repeat(40), 'Replace revision placeholders before execution');
  requireValue(key && !/[\r\n]/.test(key), 'Missing AMR_EVAL_KEY');
  const url = new URL(endpoint);
  requireValue(!url.username && !url.password && !url.search && !url.hash, 'Endpoint must not contain credentials, query or fragment');
  requireValue(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)), 'Use HTTPS or a loopback endpoint');
  requireValue(url.pathname.endsWith('/chat/completions'), 'Use the real Auto chat/completions endpoint');
  requireValue(out, 'Missing output directory');
  await mkdir(out, { recursive: false }); // Refuse overwriting/retrying a previous paid run.
  await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const log = await open(join(out, 'evidence.jsonl'), 'wx');
  const predictions = [];
  const runId = randomUUID();
  let failure = null;
  const record = async row => { await log.write(JSON.stringify(row) + '\n'); await log.sync(); };
  try {
    for (const item of plan.cases) {
      const started = Date.now();
      const requestId = `arena-${runId}-${hash(item).slice(0, 12)}`;
      await record({ ...item, status: 'started', requestId });
      try {
        const response = await fetchImpl(url, {
          method: 'POST', redirect: 'error',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'x-request-id': requestId },
          body: JSON.stringify({ model: manifest.autoModel, messages: [{ role: 'user', content: item.prompt }],
            stream: false, max_tokens: manifest.maxTokens }),
          signal: AbortSignal.timeout(manifest.timeoutMs),
        });
        requireValue(response.ok, `Auto HTTP ${response.status}`);
        const decoded = decodeResponse(manifest, response.headers, await response.json());
        const { evidence, ...result } = decoded;
        predictions.push({ ...item, ...result, cost: null, accuracy: null, for_optimality: false });
        await record({ ...item, status: 'complete', requestId, ...evidence,
          endToEndMs: Date.now() - started, result });
      } catch {
        // Do not persist remote response text or exception messages: either can echo credentials.
        failure = { index: item['global index'], status: 'failed_or_unknown' };
        await record({ ...failure, requestId, endToEndMs: Date.now() - started });
        break; // No automatic retry, omitted failed rows must never become a scored submission.
      }
    }
  } finally { await log.close(); }
  const summary = { mode: 'live-auto', runId, requestsPlanned: plan.cases.length,
    completed: predictions.length, failure, manifestHash: plan.manifestHash,
    datasetHash: plan.datasetHash, leaderboardReady: false,
    costScope: 'final-completion-usage-only; reconcile retries and classifier/review calls separately',
    latencyScope: 'end-to-end completion, not router-only latency' };
  await writeFile(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  const evidenceRows = (await readFile(join(out, 'evidence.jsonl'), 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  await writeFile(join(out, 'cost-ledger.template.json'), JSON.stringify(costTemplate(evidenceRows), null, 2));
  if (!failure) {
    const suffix = manifest.split === 'robustness' ? '-robustness' : '';
    await writeFile(join(out, `${manifest.name}${suffix}.json`), JSON.stringify(predictions, null, 2));
    await writeFile(join(out, 'arena-config.json'), JSON.stringify({ pipeline_params: {
      router_name: manifest.name, router_cls_name: 'AMRRecordedRouter', models: manifest.models.map(m => m.arenaId),
    } }, null, 2));
  }
  return summary;
}

async function main() {
  const args = process.argv.slice(2), opts = {};
  if (args.includes('--help')) {
    console.log('node scripts/routerarena.mjs --manifest FILE --cases FILE [--out NEW_DIR --execute]\nDefault: offline preflight. Execution reads AMR_EVAL_URL and AMR_EVAL_KEY.');
    return;
  }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--execute') { opts.execute = true; continue; }
    requireValue(['--manifest', '--cases', '--out'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('--'), 'Invalid command arguments');
    opts[args[i].slice(2)] = args[++i];
  }
  requireValue(opts.manifest && opts.cases, '--manifest and --cases are required');
  const result = await run({ manifest: JSON.parse(await readFile(opts.manifest, 'utf8')),
    dataset: JSON.parse(await readFile(opts.cases, 'utf8')), out: opts.out && resolve(opts.out),
    execute: opts.execute, endpoint: process.env.AMR_EVAL_URL, key: process.env.AMR_EVAL_KEY });
  console.log(JSON.stringify(result, null, 2));
  if (result.failure) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
