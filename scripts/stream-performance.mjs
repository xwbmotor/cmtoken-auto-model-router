import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await readFile(resolve(root, 'config/router.json'), 'utf8'));
const requestedModels = new Set((process.env.PERF_MODELS || '').split(',').map((x) => x.trim()).filter(Boolean));
const models = config.models.filter((model) => model.enabled && (!requestedModels.size || requestedModels.has(model.id)));
const baseUrl = (process.env.MAAS_BASE_URL || config.upstreamBaseUrl).replace(/\/$/, '');
const apiKey = process.env.MAAS_API_KEY;
const rounds = Math.max(1, Number(process.env.PERF_ROUNDS || 1));
const maxTokens = Math.max(64, Number(process.env.PERF_MAX_TOKENS || 256));
if (!apiKey) throw new Error('缺少 MAAS_API_KEY');

async function measure(model, round) {
  const started = performance.now();
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: model.id,
      messages: [{ role: 'user', content: '用80到120个中文字简要说明为什么大模型服务需要限流。直接回答，不要展示思考过程。' }],
      temperature: 0,
      stream: true,
      max_tokens: maxTokens
    })
  });
  if (!response.ok) return { model: model.id, round, ok: false, status: response.status, error: (await response.text()).slice(0, 500) };
  const decoder = new TextDecoder();
  let buffer = '';
  let output = '';
  let reasoningCharacters = 0;
  let ttftMs = null;
  let reasoningTtftMs = null;
  let finishReason = null;
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const payload = JSON.parse(data);
        const content = payload?.choices?.[0]?.delta?.content;
        const reasoning = payload?.choices?.[0]?.delta?.reasoning_content || payload?.choices?.[0]?.delta?.reasoning;
        if (reasoning) {
          if (reasoningTtftMs === null) reasoningTtftMs = Math.round(performance.now() - started);
          reasoningCharacters += reasoning.length;
        }
        if (payload?.choices?.[0]?.finish_reason) finishReason = payload.choices[0].finish_reason;
        if (content) {
          if (ttftMs === null) ttftMs = Math.round(performance.now() - started);
          output += content;
        }
      } catch {}
    }
  }
  const totalMs = Math.round(performance.now() - started);
  const generationMs = Math.max(1, totalMs - Number(ttftMs || totalMs));
  return {
    model: model.id, round, ok: true, ttftMs, reasoningTtftMs, totalMs, finishReason,
    reasoningCharacters,
    outputCharacters: output.length,
    charactersPerSecondAfterFirstToken: Number((output.length / generationMs * 1000).toFixed(1)),
    output
  };
}

const results = [];
for (let round = 1; round <= rounds; round += 1) {
  for (const model of models) {
    process.stdout.write(`[${results.length + 1}/${models.length * rounds}] ${model.id}\n`);
    results.push(await measure(model, round));
  }
}

const summary = models.map((model) => {
  const rows = results.filter((r) => r.model === model.id && r.ok);
  const average = (field) => {
    const values = rows.map((row) => row[field]).filter((value) => value !== null && value !== undefined).map(Number);
    return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
  };
  return { model: model.id, httpSuccess: rows.length, visibleOutputSuccess: rows.filter((row) => row.outputCharacters > 0).length, rounds, averageTtftMs: average('ttftMs'), averageTotalMs: average('totalMs'), averageCharactersPerSecond: average('charactersPerSecondAfterFirstToken') };
});

const outputDir = resolve(root, 'benchmark-results');
await mkdir(outputDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const output = resolve(outputDir, `stream-performance-${stamp}.json`);
await writeFile(output, `${JSON.stringify({ generatedAt: new Date().toISOString(), rounds, summary, results }, null, 2)}\n`, 'utf8');
console.table(summary);
console.log(`完整结果：${output}`);
