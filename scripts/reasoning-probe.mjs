// 一次性验证脚本：逐模型探测 MaaS reasoning 参数的真实行为。
// 安全约定：凭证只从环境变量 MAAS_API_KEY 读取，绝不打印到输出或报告。
// 用法：
//   node scripts/reasoning-probe.mjs --dry-run              查看计划，不产生调用
//   node scripts/reasoning-probe.mjs                        默认探测：reasoning_effort = low/medium/high
//   node scripts/reasoning-probe.mjs --probe=off            探测关闭思考的参数（enable_thinking / thinking.type / /no_think）
//   通用参数：--model=<id> 只跑一个模型；--timeout=<ms> 单请求超时（默认 90000）
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await readFile(resolve(root, 'config/router.json'), 'utf8'));
const baseUrl = (process.env.MAAS_BASE_URL || config.upstreamBaseUrl).replace(/\/$/, '');
const dryRun = process.argv.includes('--dry-run');
const modelFilter = (process.argv.find((a) => a.startsWith('--model=')) || '').split('=')[1] || null;
const probeKind = (process.argv.find((a) => a.startsWith('--probe=')) || '').split('=')[1] || 'effort';
const REQUEST_TIMEOUT_MS = Math.max(10_000, Number((process.argv.find((a) => a.startsWith('--timeout=')) || '').split('=')[1]) || 90_000);

const PROMPT = '一个三位数，各位数字之和为12，百位比个位大3，十位是百位与个位的平均值。求这个数，并简要说明推理过程。';
const PROMPT_ANSWER_DIGITS = ['543', '552', '450', '345']; // 可能的解，供自动核对

// —— 两种探测矩阵 ——
const PROBES = {
  effort: {
    label: 'reasoning_effort',
    variants: [
      { name: 'low', extra: { reasoning_effort: 'low' }, promptSuffix: '' },
      { name: 'medium', extra: { reasoning_effort: 'medium' }, promptSuffix: '' },
      { name: 'high', extra: { reasoning_effort: 'high' }, promptSuffix: '' }
    ]
  },
  off: {
    label: '关闭思考',
    variants: [
      { name: 'baseline-无参数', extra: {}, promptSuffix: '' },
      { name: 'enable_thinking=false', extra: { enable_thinking: false }, promptSuffix: '' },
      { name: 'thinking.type=disabled', extra: { thinking: { type: 'disabled' } }, promptSuffix: '' },
      { name: 'no_think标签', extra: {}, promptSuffix: ' /no_think' }
    ]
  }
};
const probe = PROBES[probeKind] || PROBES.effort;

async function loadEnvOnce() {
  try {
    const envText = await readFile(resolve(root, '.env'), 'utf8');
    for (const line of envText.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
    }
  } catch {
    // .env 不存在时忽略，后面统一报错
  }
  if (!process.env.MAAS_API_KEY) throw new Error('缺少 MAAS_API_KEY：请在环境变量或项目 .env 中配置');
}
await loadEnvOnce();
const key = process.env.MAAS_API_KEY;

const models = config.models.filter((m) => m.enabled && (!modelFilter || m.id === modelFilter));
console.log(`目标上游：${baseUrl}`);
console.log(`探测：${probe.label}；${models.length} 个模型 × ${probe.variants.length} 个变体 = ${models.length * probe.variants.length} 次调用`);
if (dryRun) {
  for (const model of models) for (const v of probe.variants) console.log(`  - ${model.id} · ${v.name}`);
  process.exit(0);
}

const results = [];
for (const model of models) {
  for (const variant of probe.variants) {
    const started = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        signal: controller.signal,
        body: JSON.stringify({
          model: model.id,
          messages: [{ role: 'user', content: PROMPT + variant.promptSuffix }],
          temperature: 0,
          max_tokens: 1024,
          stream: false,
          ...variant.extra
        })
      });
      const latencyMs = Math.round(performance.now() - started);
      const raw = await response.text();
      clearTimeout(timer);
      if (!response.ok) {
        results.push({ model: model.id, variant: variant.name, ok: false, status: response.status, latencyMs, error: raw.slice(0, 500) });
        console.log(`  ✗ ${model.id} · ${variant.name} → HTTP ${response.status} (${latencyMs}ms)`);
        continue;
      }
      const payload = JSON.parse(raw);
      const message = payload?.choices?.[0]?.message || {};
      const answerText = (message.content || '').toString();
      const reasoningText = (message.reasoning_content || message.reasoning || '').toString();
      const answered = answerText.trim().length > 0;
      const answerLooksCorrect = PROMPT_ANSWER_DIGITS.some((d) => answerText.replace(/\s/g, '').includes(d));
      results.push({
        model: model.id, variant: variant.name, ok: true, status: response.status, latencyMs,
        answered, answerLooksCorrect,
        answerChars: answerText.length,
        reasoningChars: reasoningText.length,
        hasReasoningField: Boolean(reasoningText),
        finishReason: payload?.choices?.[0]?.finish_reason || null,
        usage: payload.usage || null
      });
      console.log(`  ${answered ? '·' : '!'} ${model.id} · ${variant.name} → HTTP 200 (${latencyMs}ms) 回答${answerText.length}字${reasoningText.length ? `，思考${reasoningText.length}字` : '，无思考字段'}${answerLooksCorrect ? '，答案核对通过' : '，答案需人工核对'}`);
    } catch (error) {
      clearTimeout(timer);
      const latencyMs = Math.round(performance.now() - started);
      const isTimeout = error.name === 'AbortError';
      results.push({ model: model.id, variant: variant.name, ok: false, latencyMs, timeout: isTimeout, error: isTimeout ? `超过 ${REQUEST_TIMEOUT_MS / 1000}s 超时` : error.message });
      console.log(`  ✗ ${model.id} · ${variant.name} → ${isTimeout ? '超时' : '异常'} ${isTimeout ? '' : error.message}`);
    }
    await new Promise((r) => setTimeout(r, 400)); // 轻微间隔，避免压上游
  }
}

// 汇总与报告
const reportLines = [];
reportLines.push(`# Reasoning 参数探测报告 · ${probe.label}`);
reportLines.push('');
reportLines.push(`- 时间：${new Date().toISOString()}`);
reportLines.push(`- 上游：${baseUrl}`);
reportLines.push(`- 探测内容：${probe.label}（${probe.variants.map((v) => v.name).join(' / ')}）`);
reportLines.push(`- 共 ${results.length} 次调用，单请求超时 ${REQUEST_TIMEOUT_MS / 1000}s`);
reportLines.push('');
reportLines.push('## 逐次结果');
reportLines.push('');
reportLines.push('| 模型 | 变体 | HTTP | 时延ms | 回答字数 | 思考字数 | usage | finish_reason | 核对 |');
reportLines.push('|---|---|---|---|---|---|---|---|---|');
for (const r of results) {
  const usageText = r.usage ? `${r.usage.prompt_tokens ?? '?'}/${r.usage.completion_tokens ?? '?'}${r.usage.reasoning_tokens != null ? `+${r.usage.reasoning_tokens}` : ''}` : '-';
  const check = !r.ok ? '请求失败' : r.answerLooksCorrect ? '✅' : '人工核对';
  reportLines.push(`| ${r.model} | ${r.variant} | ${r.ok ? r.status : r.status ?? 'ERR'} | ${r.latencyMs} | ${r.ok ? (r.answerChars ?? '-') : '-'} | ${r.ok ? (r.reasoningChars ?? '-') : '-'} | ${r.ok ? usageText : '-'} | ${r.ok ? (r.finishReason ?? '-') : '-'} | ${check} |`);
}
reportLines.push('');
reportLines.push('## 原始结果 JSON');
reportLines.push('');
reportLines.push('```json');
reportLines.push(JSON.stringify(results, null, 2));
reportLines.push('```');

const dir = resolve(root, 'benchmark-results');
await mkdir(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
const suffix = `${modelFilter ? `-${modelFilter}` : ''}-${probeKind}`;
const path = resolve(dir, `REASONING-PROBE-${stamp}${suffix}.md`);
await writeFile(path, reportLines.join('\n'), 'utf8');
console.log(`\n报告已写入 ${path}`);
