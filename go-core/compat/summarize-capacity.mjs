// Summarize the retained open-loop samples; never subtract unrelated percentiles.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const [input, output] = process.argv.slice(2);
assert.ok(input && output, 'usage: node summarize-capacity.mjs input.json output.md');
const bytes = readFileSync(input), report = JSON.parse(bytes);
assert.equal(report.experiment, 'm4-cgroup-open-loop');
assert.ok(!report.failure, `experiment failed: ${report.failure}`);
assert.equal(report.preflight.length, 12);
assert.ok(report.preflight.every(r => r.complete));
assert.equal(report.runs.length, report.parameters.rates.length * report.parameters.rounds * 3 + 3);
for (const run of report.runs) {
  const samples = report.requests.filter(r => r.run === run.id);
  assert.equal(samples.length, run.started);
  assert.equal(samples.filter(r => r.complete).length, run.complete);
  assert.equal(run.started + run.droppedByGenerator, run.offered);
  assert.equal(run.complete + run.errors, run.started);
}
const fmt = n => n == null ? '—' : n.toFixed(2);
const percentile = (samples, q) => {
  const values = samples.filter(Number.isFinite).sort((a, b) => a - b);
  return values.length ? values[Math.ceil(values.length * q) - 1] : null;
};
const lines = ['# M4 同配额开放负载实测', '',
  `原始记录时间：${report.at}。原始 JSON SHA256：\`${createHash('sha256').update(bytes).digest('hex')}\`。`, '',
  `每个服务组均限制为 ${report.parameters.cpus} CPU、${report.parameters.memoryMiB} MiB 内存且不提供额外 swap。Go 组包含 Go runtime、Node 适配器和真实 Node 管理服务。模拟上游、公共 TCP 入口和发压器在配额之外。`, '',
  '以下均为合成负载。非流式上游固定等待约 10 ms，短文本、长历史、工具消息、图片各占四分之一；关闭语义复核。延迟分位数合并各轮完整成功请求，错误和发压丢弃单列；完整吞吐按调度开始至最后请求结束的实测跨度计算，包含排空。末次发起比计划窗口结束早一个请求间隔，因此低负载下实测跨度可能略短于计划窗口。', '',
  '| 路径 | 目标 RPS | 发起/计划 | 完整成功 | 错误 | 发压丢弃 | 完整 RPS | P95 ms | P99 ms | 调度迟到 P95 ms |',
  '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|'];
for (const rate of report.parameters.rates) for (const target of ['direct', 'node', 'go']) {
  const runs = report.runs.filter(r => r.rate === rate && r.target === target);
  assert.equal(runs.length, report.parameters.rounds);
  const ids = new Set(runs.map(r => r.id)), samples = report.requests.filter(r => ids.has(r.run));
  const good = samples.filter(r => r.complete), sum = key => runs.reduce((s, r) => s + r[key], 0);
  lines.push(`| ${target} | ${rate} | ${sum('started')}/${sum('offered')} | ${good.length} | ${sum('errors')} | ${sum('droppedByGenerator')} | ${fmt(good.length * 1000 / sum('elapsedMs'))} | ${fmt(percentile(good.map(r => r.durationMs), .95))} | ${fmt(percentile(good.map(r => r.durationMs), .99))} | ${fmt(percentile(samples.map(r => r.schedulerDelayMs), .95))} |`);
}
lines.push('', 'CPU 为各轮 cgroup 累计用量除以采样时间的加权平均；内存是采样峰值（含 cgroup 记账的缓存），不是 RSS，也不保证捕捉瞬时峰值。限流周期合计、OOM kill 合计均直接取 cgroup 差值。', '',
  '| 路径 | 目标 RPS | 平均 CPU 核 | 采样峰值 MiB | CPU 限流周期 | OOM kill |', '|---|---:|---:|---:|---:|---:|');
for (const rate of report.parameters.rates) for (const target of ['node', 'go']) {
  const values = report.runs.filter(r => r.rate === rate && r.target === target).map(r => r.resources);
  const cpu = values.reduce((s, r) => s + r.after.cpu.usage_usec - r.before.cpu.usage_usec, 0) / 1000 / values.reduce((s, r) => s + r.after.at - r.before.at, 0);
  lines.push(`| ${target} | ${rate} | ${fmt(cpu)} | ${fmt(Math.max(...values.map(r => r.peakSampledMemoryBytes)) / 1048576)} | ${values.reduce((s, r) => s + r.throttledPeriods, 0)} | ${values.reduce((s, r) => s + r.oomKills, 0)} |`);
}
lines.push('', `SSE：每条持续 ${report.parameters.streamSeconds} 秒，每路径同时 ${report.parameters.streams} 条；校验逐段内容、唯一且末尾的 DONE，以及首段在结束前到达。`, '',
  '| 路径 | 完整/发起 | 上游调用 | 首字节 P95 ms | 总时长 P95 ms | 采样峰值 MiB |', '|---|---:|---:|---:|---:|---:|');
for (const run of report.runs.filter(r => r.streamSeconds)) lines.push(`| ${run.target} | ${run.complete}/${run.started} | ${run.upstreamCalls} | ${fmt(run.firstByteP95Ms)} | ${fmt(run.p95Ms)} | ${fmt(run.resources ? run.resources.peakSampledMemoryBytes / 1048576 : null)} |`);
lines.push('', '逐请求 clientPathResidualMs 已扣除该请求模拟服务用时，但仍包含客户端、网络、公共入口等开销，不能称为纯网关延迟。未用两个独立 P95 相减。', '',
  '本实验不能证明真实模型回答质量、小时级稳定性、生产容量上限或正式 SLO 达标。资源状态在各组测试间复用，目标环境和真实流量仍需独立验收。', '',
  `Go 二进制 SHA256：\`${report.binarySha256}\`。`, '', `Node server SHA256：\`${report.nodeSourceSha256}\`。`, '', `容器镜像：\`${report.image.id}\`。`, '');
writeFileSync(output, lines.join('\n'));
console.log(JSON.stringify({ output, runs: report.runs.length, requests: report.requests.length }));
