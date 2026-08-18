import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await readFile(resolve(root, 'config/router.json'), 'utf8'));
const baseUrl = (process.env.MAAS_BASE_URL || config.upstreamBaseUrl).replace(/\/$/, '');
const apiKey = process.env.MAAS_API_KEY;
const dryRun = process.argv.includes('--dry-run');
const concurrency = Math.max(1, Number(process.env.BENCHMARK_CONCURRENCY || 2));

const cases = [
  { id: 'simple-qa', task: 'simple', prompt: '只回答一个数字：17 加 28 等于多少？', check: { contains: '45' } },
  { id: 'extract-json', task: 'extraction', prompt: '从这句话抽取姓名和城市。只输出 JSON，键名必须严格为 name 和 city：张晓明目前居住在广州。', check: { json: { name: '张晓明', city: '广州' } } },
  { id: 'classification', task: 'extraction', prompt: '将“申请退款，商品破损”分类为售前、售后或咨询。只输出分类名称。', check: { contains: '售后' } },
  { id: 'coding', task: 'coding', prompt: '请找出下面 Java 代码的线程安全问题并给出最小修改：class C { int n=0; void inc(){n++;} }' },
  { id: 'sql', task: 'coding', prompt: '写一条 PostgreSQL 查询：统计 orders 表每个 user_id 最近30天的订单金额总和，只返回 SQL。', check: { contains: 'group by' } },
  { id: 'reasoning', task: 'reasoning', prompt: '有三只箱子，标签分别是苹果、橘子、混合，但所有标签都贴错。最少取几个水果能确定全部箱子？解释原因。', check: { containsAny: ['1个', '一个', '1 个'] } },
  { id: 'architecture', task: 'reasoning', prompt: '设计一个每秒一万请求的幂等支付回调处理方案，说明去重、事务、重试和监控。' },
  { id: 'creative', task: 'creative', prompt: '为企业内部 AI 助手写三条简洁中文宣传语，每条不超过18字。' }
];

function extractText(payload) {
  return payload?.choices?.[0]?.message?.content || '';
}

function looseJson(text) {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try { return JSON.parse(cleaned); } catch { return null; }
}

function checkResult(text, check) {
  if (!check) return { automaticScore: null, check: 'manual_review' };
  const lower = text.toLowerCase();
  if (check.contains) return { automaticScore: lower.includes(check.contains.toLowerCase()) ? 1 : 0, check: `contains:${check.contains}` };
  if (check.containsAny) return { automaticScore: check.containsAny.some((x) => lower.includes(x.toLowerCase())) ? 1 : 0, check: 'contains_any' };
  if (check.json) {
    const value = looseJson(text);
    const ok = value && Object.entries(check.json).every(([k, v]) => String(value[k]).includes(v));
    return { automaticScore: ok ? 1 : 0, check: 'json_fields' };
  }
  return { automaticScore: null, check: 'manual_review' };
}

async function runOne(model, item) {
  const started = performance.now();
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: model.id, messages: [{ role: 'user', content: item.prompt }], temperature: 0, stream: false })
    });
    const latencyMs = Math.round(performance.now() - started);
    const raw = await response.text();
    if (!response.ok) return { model: model.id, caseId: item.id, task: item.task, ok: false, status: response.status, latencyMs, error: raw.slice(0, 1000) };
    const payload = JSON.parse(raw); const text = extractText(payload); const evaluated = checkResult(text, item.check);
    return { model: model.id, caseId: item.id, task: item.task, ok: true, status: response.status, latencyMs, usage: payload.usage || null, output: text, ...evaluated };
  } catch (error) {
    return { model: model.id, caseId: item.id, task: item.task, ok: false, latencyMs: Math.round(performance.now() - started), error: error.message };
  }
}

async function pool(jobs) {
  const results = []; let index = 0;
  async function worker() {
    while (index < jobs.length) {
      const job = jobs[index++];
      process.stdout.write(`[${index}/${jobs.length}] ${job.model.id} · ${job.item.id}\n`);
      results.push(await runOne(job.model, job.item));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

function summarize(results) {
  return config.models.filter((model) => model.enabled).map((model) => {
    const rows = results.filter((x) => x.model === model.id);
    const success = rows.filter((x) => x.ok);
    const checked = success.filter((x) => x.automaticScore !== null);
    return {
      model: model.id,
      ownership: model.ownership,
      availability: rows.length ? success.length / rows.length : 0,
      automaticAccuracy: checked.length ? checked.reduce((s, x) => s + x.automaticScore, 0) / checked.length : null,
      averageLatencyMs: success.length ? Math.round(success.reduce((s, x) => s + x.latencyMs, 0) / success.length) : null,
      totalTokens: success.reduce((s, x) => s + Number(x.usage?.total_tokens || 0), 0)
    };
  });
}

if (dryRun) {
  const enabledModels = config.models.filter((m) => m.enabled);
  console.log(JSON.stringify({ baseUrl, models: enabledModels.map((m) => m.id), cases: cases.map((x) => ({ id: x.id, task: x.task })), totalCalls: enabledModels.length * cases.length, concurrency }, null, 2));
  process.exit(0);
}
if (!apiKey) throw new Error('缺少 MAAS_API_KEY。请轮换旧 Key 后，在本机 .env 中设置新 Key。');

const jobs = config.models.filter((m) => m.enabled).flatMap((model) => cases.map((item) => ({ model, item })));
const results = await pool(jobs);
const report = { generatedAt: new Date().toISOString(), baseUrl, cases, summary: summarize(results), results };
const outputDir = resolve(root, 'benchmark-results'); await mkdir(outputDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-'); const output = resolve(outputDir, `benchmark-${stamp}.json`);
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.table(report.summary);
console.log(`完整结果：${output}`);
console.log('主观任务需要人工复核 output；不要仅凭自动题更新生产质量分。');
