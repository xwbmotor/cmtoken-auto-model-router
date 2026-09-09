// Rebuild the checked-in compact report from the raw, local comparison evidence.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const [input, output] = process.argv.slice(2);
assert.ok(input && output, 'usage: summarize-gateways.mjs input.json output.md');
const raw = readFileSync(input), report = JSON.parse(raw);
assert.equal(report.schemaVersion, 1);
assert.ok(report.runs.length && report.requests.length);
const median = values => { const sorted = [...values].sort((a, b) => a - b), n = sorted.length; return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2; };
const number = value => value == null ? '—' : value.toFixed(1);
const rows = [];
for (const stream of [false, true]) {
  for (const concurrency of [...new Set(report.runs.map(r => r.concurrency))]) {
    for (const target of ['direct', 'node', 'go']) {
      const runs = report.runs.filter(r => r.stream === stream && r.concurrency === concurrency && r.target === target);
      assert.ok(runs.length);
      for (const run of runs) {
        const samples = report.requests.filter(r => r.run === run.id);
        assert.equal(samples.length, run.requests); assert.equal(samples.filter(r => r.ok).length, run.successes);
        assert.equal(run.errors, 0); assert.equal(run.upstreamCalls, run.requests);
      }
      const memory = runs.map(r => r.resources?.peakSampledRssBytes).filter(v => v != null);
      const cpu = runs.map(r => r.resources ? r.resources.cpuMs / r.resources.sampledMs : null).filter(v => v != null);
      rows.push(`| ${stream ? 'SSE' : 'JSON'} | ${concurrency} | ${target} | ${runs.length} | ${runs.reduce((sum, r) => sum + r.requests, 0)} | ${number(median(runs.map(r => r.deliveredRps)))} | ${number(median(runs.map(r => r.p95Ms)))} | ${number(median(runs.map(r => r.firstByteP95Ms)))} | ${memory.length ? number(Math.max(...memory) / 1048576) : '—'} | ${cpu.length ? median(cpu).toFixed(2) : '—'} |`);
    }
  }
}
const measured = report.runs.reduce((sum, r) => sum + r.requests, 0);
const lines = [
  '# M4 本地完整链路对照记录', '',
  '本记录是 Windows 同机、同策略、同模拟上游的探索性对照，不是生产容量验收。Go 组包含请求路径中的 Node 适配器；实际 Node 服务和 Go managed runtime 均启用各自的计费与日志。', '',
  `运行时间（UTC）：${report.at}。共 ${report.runs.length} 组、${measured} 次测量请求，另有 ${report.requests.length - measured} 次预热。所测请求完整性失败和重复上游调用均为 0。`, '',
  `机器：${report.environment.cpu}，${report.environment.logicalCpus} 个逻辑 CPU；${report.environment.platform} ${report.environment.release}；Node ${report.environment.node}。`, '',
  `各组在固定时间窗口内持续发起请求后排空，并发与轮数见下表；direct、Node、Go 按轮次轮换顺序。吞吐为成功完成数除以包含排空的时间。每个 SSE 含 ${report.fixture.sseChunks} 段内容，段间计划等待 ${report.fixture.sseChunkIntervalMs} ms，首段前计划等待 ${report.fixture.mockInitialDelayMs} ms；实际计时含系统调度。`, '',
  '| 类型 | 并发 | 路径 | 轮数 | 测量请求 | RPS 中位数 | 每轮 P95 中位数 ms | 每轮首字节 P95 中位数 ms | 最大采样 RSS MiB | CPU 核数中位数 |',
  '|---|---:|---|---:|---:|---:|---:|---:|---:|---:|', ...rows, '',
  'CPU 核数按采样窗口内进程 CPU 时间增量 / 墙钟时间计算，1.00 表示平均占用一个核；Go 为 Go 进程与 Node 适配器之和，**未包含旁路空闲的 Node 管理服务**，不能将其视为整个部署的总资源。RSS 为约 200 ms 采样的最大值，不是精确峰值。服务进程跨组复用，后续组内存包含之前负载的影响。负载发生器与模拟上游在同一独立进程，原始证据单列其资源。', '',
  '## 可以支持的结论', '',
  '- 表中结果只适用于本次单模型规则路由负载和当前运行环境；应逐档比较吞吐、时延和资源，不据此推断生产全面更快。',
  '- 所测 SSE 内容顺序、完整性、唯一结束标记及首段及时转发均通过。有限长度模拟流不能替代数分钟或小时的真实长连接验收。',
  '- 两组持久化语义不同：Node 使用异步 JSON 账本与日志，Go 使用 fsync WAL 与审计；结果反映当前候选架构，而不是单纯语言速度。', '',
  '## 尚未满足的正式出口条件', '',
  '- 没有共同强制 CPU/内存配额。GOMAXPROCS=2 只约束 Go 调度，不是整组资源配额。',
  '- 未提供生产 RPS、在线 SSE 数、请求分布、附加延迟及错误率 SLO；尚不能判定容量达标。',
  '- 闭环负载无法证明开放流量下的排队稳定性或最大持续吞吐。direct 是交错基线，不能将两个 P95 相减称为“网关附加 P95”。',
  '- 未使用真实业务、付费 L3、代表性多模态/工具长历史性能负载，未做生产灰度。功能对照证据见既有 5150 条 parity 和运行测试。',
  '- Go 仍限 loopback、单权威账本，正式入口/TLS、租户范围与状态迁移须在 M5 前明确。', '',
  '## 证据和复现', '',
  `原始 JSON SHA256：\`${createHash('sha256').update(raw).digest('hex')}\`。`,
  `被测 Go 二进制 SHA256：\`${report.binarySha256}\`。`,
  `被测 Node server.mjs SHA256：\`${report.nodeServerSha256}\`。`, '',
  '```powershell',
  'node go-core/compat/compare-gateways.mjs --binary data/go-migration/amr-core.exe --seconds 5 --rounds 3 --concurrency 1,8,32 --out data/go-migration/gateway-comparison.json',
  'node go-core/compat/summarize-gateways.mjs data/go-migration/gateway-comparison.json data/go-migration/gateway-comparison.md',
  '```', '',
  '原始记录保留每个请求的 HTTP 状态、完整性交付、首字节和总时长，以及按进程采样的 CPU/RSS，不含凭据或业务正文。每次运行指定新 --out 路径，保留历史记录。', '',
];
writeFileSync(output, lines.join('\n'));
