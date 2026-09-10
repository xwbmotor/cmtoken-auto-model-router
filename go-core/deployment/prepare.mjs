// Generate disposable fixture credentials and snapshot; never load .env.
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const directory = resolve(root, 'data/go-deployment');
await mkdir(resolve(directory, 'config'), { recursive: true });
await mkdir(resolve(directory, 'ledger'), { recursive: true });
// Never replace an existing fixture's credentials or ledger automatically.
const source = JSON.parse(await readFile(resolve(root, 'config/router.json'), 'utf8'));
source.semanticRouter.enabled = false;
source.routing.mode = 'active'; source.routing.activeTrafficPercent = 100;
source.routing.taskPreferences = {}; source.routing.maxAttempts = 1;
source.routing.qualityFloor = 0; source.routing.requestTimeoutMs = 5000;
source.models = source.models.filter(m => m.enabled).slice(0, 1);
if (source.models.length !== 1) throw new Error('Need one enabled fixture model');
const model = source.models[0];
source.routing.defaultExplicitModel = model.id; source.routing.shadowModel = model.id;
source.semanticRouter.provider = 'disabled';
model.minimumCompletionTokensForReliableAnswer = 0;
model.quality = Object.fromEntries(Object.keys(model.quality).map(k => [k, 0.99]));
model.quality.default = 0.99; model.benchmarkScores = null; model.contextWindow = 128000;
model.pricingYuanPerMillionTokens = { input: 1, output: 2, inputCached: 0.5 };
source.routing.loadBalancing = { enabled: true, penaltyWeight: 0.2, limits: { [model.id]: 16 } };
source.budget.enabled = true; source.budget.dailyBudgetYuan = 10; source.budget.cacheHitRatio = 0;
const config = resolve(directory, 'config');
const key = () => randomBytes(24).toString('hex');
await writeFile(resolve(config, 'auth.json'), JSON.stringify({ mode: 'strict', accessToken: key(), adminToken: key(), upstreamToken: key() }), { flag: 'wx', mode: 0o600 });
await writeFile(resolve(config, 'router.json'), JSON.stringify(source), { flag: 'wx', mode: 0o600 });
await writeFile(resolve(config, 'request.json'), JSON.stringify({ model: source.routing.autoModelId, messages: [{ role: 'user', content: 'Extract number 42.' }], max_tokens: 128 }), { flag: 'wx', mode: 0o600 });
execFileSync(process.execPath, ['go-core/compat/export-runtime.mjs', '--config', resolve(config, 'router.json'), '--out', resolve(config, 'runtime.json')], { cwd: root, stdio: 'pipe' });
if (process.platform !== 'win32') {
  // Dedicated fixtures only; container uid is 65532. Parent controls ownership.
  for (const file of ['auth.json', 'router.json', 'request.json', 'runtime.json']) await chmod(resolve(config, file), 0o600);
}
console.log(JSON.stringify({ fixture: 'data/go-deployment', productionReady: false, externalCalls: 0 }));
