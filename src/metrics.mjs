// Prometheus 文本格式（format version 0.0.4）渲染器，零依赖。
// 输入是 server 内部状态的实时快照——单一数据源，不重复计数。
// 用法：GET /metrics → renderPrometheusMetrics({ counters, health, budget, decisionLog, config, sessions, draining, inflight })

function esc(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function metric(lines, name, type, help, samples) {
  lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
  lines.push(...samples);
}

export function renderPrometheusMetrics(snapshot) {
  const { counters = {}, health = {}, budget = {}, decisionLog = {}, config = {}, sessions = 0, draining = false, inflight = 0 } = snapshot || {};
  const lines = [];

  const outcome = counters.outcome || {};
  metric(lines, 'router_requests_total', 'counter', '路由完成的请求总数（按请求模式与结果）', [
    `router_requests_total{mode="auto",outcome="success"} ${outcome.auto?.success || 0}`,
    `router_requests_total{mode="auto",outcome="error"} ${outcome.auto?.error || 0}`,
    `router_requests_total{mode="explicit",outcome="success"} ${outcome.explicit?.success || 0}`,
    `router_requests_total{mode="explicit",outcome="error"} ${outcome.explicit?.error || 0}`,
  ]);

  metric(lines, 'router_fallbacks_total', 'counter', '主选模型失败后切换备选的次数', [
    `router_fallbacks_total ${counters.fallback || 0}`,
  ]);

  // v0.5.1: TTFT（首 token 时延）独立观测 + 流式完成/中断计数（流尾单次落账）
  const ttft = counters.ttft || { count: 0, sumMs: 0 };
  metric(lines, 'router_ttft_ms', 'summary', '首 token 时延（流式 TTFT，毫秒）', [
    `router_ttft_ms_count ${ttft.count}`,
    `router_ttft_ms_sum ${ttft.sumMs}`,
  ]);
  const stream = counters.stream || { completed: 0, aborted: 0 };
  metric(lines, 'router_stream_total', 'counter', '流式请求完成/中断计数（流尾单次落账）', [
    `router_stream_total{outcome="completed"} ${stream.completed || 0}`,
    `router_stream_total{outcome="aborted"} ${stream.aborted || 0}`,
  ]);

  // v0.5.1: 预算预占-结算统计（估算落账 vs 实际 usage 冲正）
  metric(lines, 'router_budget_settle_total', 'counter', '预算结算计数（exact=实际 usage 冲正, estimated=无 usage 保留估算）', [
    `router_budget_settle_total{kind="exact"} ${budget.exactSettles || 0}`,
    `router_budget_settle_total{kind="estimated"} ${budget.estimatedSettles || 0}`,
  ]);

  const selectedRows = Object.entries(counters.selected || {}).map(([model, n]) => `router_selected_total{model="${esc(model)}"} ${n}`);
  metric(lines, 'router_selected_total', 'counter', '实际选中各模型的次数', selectedRows);
  // 来源细分：显式点名 / auto 调度 / auto 容差分流（负荷均衡观测：auto 分流占 qwen 承载的比例）
  const selectedByRows = Object.entries(counters.selectedBy || {}).flatMap(([model, by]) => Object.entries(by)
    .filter(([, n]) => n > 0)
    .map(([source, n]) => `router_selected_by_source_total{model="${esc(model)}",source="${source}"} ${n}`));
  metric(lines, 'router_selected_by_source_total', 'counter', '各模型按请求来源的选中次数（explicit=用户点名, auto=路由调度, auto_preference=容差分流）', selectedByRows);

  const taskRows = Object.entries(counters.task || {}).map(([task, n]) => `router_task_total{task="${esc(task)}"} ${n}`);
  metric(lines, 'router_task_total', 'counter', '任务类型分布', taskRows);

  const semantic = counters.semantic || {};
  const semanticRows = ['eligible', 'attempted', 'succeeded', 'disagreed', 'errors', 'applied']
    .map((stage) => `router_semantic_total{stage="${stage}"} ${semantic[stage] || 0}`);
  metric(lines, 'router_semantic_total', 'counter', '语义复核各阶段计数', semanticRows);

  metric(lines, 'router_budget_estimated_spend_yuan', 'gauge', '当日估算花费（元，estimateOnly）', [
    `router_budget_estimated_spend_yuan ${Number(budget.estimatedSpendYuan || 0)}`,
  ]);
  if (budget.estimatedSpendBeans != null) {
    metric(lines, 'router_budget_estimated_spend_beans', 'gauge', '当日估算消耗算力豆（estimateOnly）', [
      `router_budget_estimated_spend_beans ${Number(budget.estimatedSpendBeans || 0)}`,
    ]);
  }
  metric(lines, 'router_budget_pressure', 'gauge', '预算压力 0-1', [
    `router_budget_pressure ${Number(budget.pressure || 0)}`,
  ]);

  metric(lines, 'router_decision_log_written_total', 'counter', '决策日志成功写入条数', [
    `router_decision_log_written_total ${decisionLog.written || 0}`,
  ]);
  metric(lines, 'router_decision_log_errors_total', 'counter', '决策日志写入失败次数', [
    `router_decision_log_errors_total ${decisionLog.errors || 0}`,
  ]);

  const disk = decisionLog.diskUsage || {};
  metric(lines, 'router_decision_log_disk_bytes', 'gauge', '决策日志目录磁盘占用字节', [
    `router_decision_log_disk_bytes ${disk.bytes || 0}`,
  ]);
  metric(lines, 'router_decision_log_disk_files', 'gauge', '决策日志文件数量', [
    `router_decision_log_disk_files ${disk.files || 0}`,
  ]);

  const circuitMap = { closed: 0, half_open: 1, open: 2 };
  const circuitRows = Object.entries(health).map(([model, state]) => `router_circuit_state{model="${esc(model)}"} ${circuitMap[state.circuitState] ?? 0}`);
  metric(lines, 'router_circuit_state', 'gauge', '熔断状态：0=closed 1=half_open 2=open', circuitRows);

  const latencyRows = Object.entries(health)
    .filter(([, state]) => state.ewmaLatencyMs > 0)
    .map(([model, state]) => `router_model_latency_ewma_ms{model="${esc(model)}"} ${Math.round(state.ewmaLatencyMs)}`);
  metric(lines, 'router_model_latency_ewma_ms', 'gauge', '各模型上游时延 EWMA（毫秒）', latencyRows);

  metric(lines, 'router_sessions_active', 'gauge', '活跃会话粘性条目数', [`router_sessions_active ${sessions}`]);
  metric(lines, 'router_inflight_requests', 'gauge', '正在处理的请求数', [`router_inflight_requests ${inflight}`]);
  metric(lines, 'router_draining', 'gauge', '是否正在优雅关停排空（1=是）', [`router_draining ${draining ? 1 : 0}`]);
  metric(lines, 'router_uptime_seconds', 'gauge', '进程运行秒数', [`router_uptime_seconds ${Math.round(process.uptime())}`]);
  metric(lines, 'router_config_version', 'gauge', '当前软件版本（1=当前版本生效）', [`router_config_version{version="${esc(config.version || 'unknown')}"} 1`]);

  const memory = process.memoryUsage();
  metric(lines, 'process_resident_memory_bytes', 'gauge', '进程常驻内存字节', [`process_resident_memory_bytes ${memory.rss}`]);
  metric(lines, 'nodejs_heap_used_bytes', 'gauge', 'V8 堆已用字节', [`nodejs_heap_used_bytes ${memory.heapUsed}`]);

  return `${lines.join('\n')}\n`;
}
