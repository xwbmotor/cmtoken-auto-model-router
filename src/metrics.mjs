import { loadAssessment } from './model-load.mjs';
// Prometheus 文本格式（format version 0.0.4）渲染器，零依赖。
// 输入是 server 内部状态的实时快照——单一数据源，不重复计数。
// 用法：GET /metrics → renderPrometheusMetrics({ counters, health, budget, decisionLog, config, sessions, draining, inflight })
import { LATENCY_BUCKETS_MS } from './response-timing.mjs';

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

  const loads = (config.models || []).map(model => ({ id: model.id, ...loadAssessment(model, config.routing, snapshot?.modelLoad) }));
  metric(lines, 'router_model_inflight', 'gauge', '本路由进程占用的模型调用数，不代表上游总负载', loads.map(x => `router_model_inflight{model="${esc(x.id)}"} ${x.inflight}`));
  metric(lines, 'router_model_concurrency_limit', 'gauge', '配置的本进程模型并发额度；未知不输出', loads.filter(x => x.capacity !== null).map(x => `router_model_concurrency_limit{model="${esc(x.id)}"} ${x.capacity}`));
  const outcome = counters.outcome || {};
  const successTotal = (outcome.auto?.success || 0) + (outcome.explicit?.success || 0);
  metric(lines, 'router_requests_total', 'counter', '路由完成的请求总数（按请求模式与结果）', [
    `router_requests_success_total ${successTotal}`,
    `router_requests_total{mode="auto",outcome="success"} ${outcome.auto?.success || 0}`,
    `router_requests_total{mode="auto",outcome="error"} ${outcome.auto?.error || 0}`,
    `router_requests_total{mode="explicit",outcome="success"} ${outcome.explicit?.success || 0}`,
    `router_requests_total{mode="explicit",outcome="error"} ${outcome.explicit?.error || 0}`,
  ]);

  metric(lines, 'router_fallbacks_total', 'counter', '主选模型失败后切换备选的次数', [
    `router_fallbacks_total ${counters.fallback || 0}`,
  ]);

  // 独立观测 + 流式完成/中断计数（流尾单次落账）
  // V2 excludes legacy header/non-stream observations; persisted V1 data is not
  // relabelled as TTFT. Histogram buckets support P95/P99 in Prometheus.
  const timingDefinitions = [
    ['ttft', 'router_ttft_ms', '从请求进入到首个非空正文 delta（流式，包括后来中断的流）'],
    ['firstOutput', 'router_first_output_ms', '从请求进入到首个正文/思考/工具输出'],
    ['headers', 'router_upstream_headers_ms', '每次上游尝试的响应头到达时延'],
    ['completion', 'router_completion_ms', '成功交付的完整请求时延（含路由与重试）'],
    ['failedCompletion', 'router_failed_completion_ms', '失败请求结束时延（含路由与重试）']
  ];
  for (const [key, name, help] of timingDefinitions) {
    const h = counters.responseTimingsV2?.[key] || { count: 0, sumMs: 0, buckets: [] };
    metric(lines, name, 'histogram', help, [
      ...LATENCY_BUCKETS_MS.map((le, i) => `${name}_bucket{le="${le}"} ${h.buckets?.[i] || 0}`),
      `${name}_bucket{le="+Inf"} ${h.count}`, `${name}_count ${h.count}`, `${name}_sum ${h.sumMs}`
    ]);
  }
  const stream = counters.stream || { completed: 0, aborted: 0 };
  metric(lines, 'router_stream_total', 'counter', '流式请求完成/中断计数（流尾单次落账）', [
    `router_stream_total{outcome="completed"} ${stream.completed || 0}`,
    `router_stream_total{outcome="aborted"} ${stream.aborted || 0}`,
  ]);

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
  // /rejectedLowConfidence（低于采纳线
  // 被拒数）此前只在内存 counters 有、Prometheus 不导出，运营无法从监控判断调阈值后 L3 调用率变化
  const semanticRows = ['eligible', 'attempted', 'succeeded', 'disagreed', 'errors', 'applied', 'escalated', 'rejectedLowConfidence', 'rolloutHold']
    .map((stage) => `router_semantic_total{stage="${stage}"} ${semantic[stage] || 0}`);
  metric(lines, 'router_semantic_total', 'counter', '语义复核各阶段计数（escalated=L2升级L3，rejectedLowConfidence=低于采纳线被拒，rolloutHold=独立灰度未放量走规则层）', semanticRows);
  // 表示既无 x-session-id 也无有效 key 指纹（走内部随机 ID）。本指标**不能**证明「探测
  // 实验组」：探测者可每发换一个 x-session-id（source 仍=session）。探测检测需另建
  // per-key session 基数/换 session 频率统计 候选）。现用途：监控匿名流量占比异常。
  const bks = (counters.semantic && counters.semantic.bucketKeySource) || {};
  const bksRows = Object.keys(bks).length
    ? Object.entries(bks).map(([src, n]) => `router_semantic_bucket_key_source_total{source="${esc(src)}"} ${n}`)
    : ['router_semantic_bucket_key_source_total{source="session"} 0', 'router_semantic_bucket_key_source_total{source="fingerprint"} 0', 'router_semantic_bucket_key_source_total{source="internal"} 0'];
  metric(lines, 'router_semantic_bucket_key_source_total', 'counter', '语义灰度分桶键来源分布（internal=无 session 无 key 指纹的匿名请求占比；探测检测不由此指标承担）', bksRows);

  const cascadeRows = Object.entries(semantic.byCascadeLevel || {}).map(([level, n]) => `router_semantic_cascade_total{level="${esc(level)}"} ${n}`);
  if (cascadeRows.length > 0) metric(lines, 'router_semantic_cascade_total', 'counter', 'cascade 各层产出计数（small=直采，large=升级L3，small-degraded=降级）', cascadeRows);

  // Judge：异步评分器各阶段计数（sampled=抽样入选，quality_done=完成质量评分，
  // task_check_done=完成分类核对，skipped_* 与 error_* 见事件流 reason/stage）
  const judge = counters.judge || {};
  const judgeRows = ['sampled', 'qualityDone', 'taskCheckDone', 'errors', 'persistErrors'].map((k) => `router_judge_total{stage="${k}"} ${judge[k] || 0}`);
  metric(lines, 'router_judge_total', 'counter', 'Judge 异步 shadow 评分各阶段计数（不进在线决策闭环；sampled=抽样入选，errors 含解析失败，persistErrors=guard 状态持久化失败）', judgeRows);
  if (judge.tokens) metric(lines, 'router_judge_tokens_total', 'counter', 'Judge 调用累计 token（进程口径，自然日翻转；与每日上限对照请看 guard_* 系列）', [`router_judge_tokens_total ${judge.tokens}`]);
  // 时 if 短路会让整条指标消失，
  // Prometheus 端 absent 无法区分「正常」与「judge 模块被移除」，状态回退也测不出。
  if (Number.isFinite(Number(judge.gaugeCircuit))) metric(lines, 'router_judge_circuit_state', 'gauge', 'Judge 熔断状态（0=closed 1=half-open 2=open；恒输出，closed 不是缺席）', [`router_judge_circuit_state ${Number(judge.gaugeCircuit)}`]);
  // ——预算对账以这组为准
  if (Number.isFinite(Number(judge.guardCalls))) {
    metric(lines, 'router_judge_guard_calls_today', 'gauge', 'Judge 当日已结算调用数（Guard 持久化口径，重启不重置；与 dailyMaxCalls 对照）', [`router_judge_guard_calls_today ${judge.guardCalls}`]);
    metric(lines, 'router_judge_guard_tokens_today', 'gauge', 'Judge 当日已结算 token（Guard 持久化口径，重启不重置；与 dailyMaxTokens 对照）', [`router_judge_guard_tokens_today ${judge.guardTokens}`]);
  }

  const latRows = Object.entries(semantic.cascadeLatency || {}).flatMap(([level, agg]) => [
    `router_semantic_cascade_latency_ms_sum{level="${esc(level)}"} ${agg.sumMs}`,
    `router_semantic_cascade_latency_ms_count{level="${esc(level)}"} ${agg.count}`,
  ]);
  if (latRows.length > 0) metric(lines, 'router_semantic_cascade_latency_ms', 'counter', 'cascade 各层时延累计（sum/count，ms）；观察期评估 L2/L3 的时延代价', latRows);

  // 可观测——真实付费的隐藏成本首次进监控
  const overhead = counters.routingOverhead || {};
  metric(lines, 'router_routing_overhead_calls_total', 'counter', '路由层大模型分类调用次数（L3 升级）', [
    `router_routing_overhead_calls_total ${overhead.calls || 0}`,
  ]);
  metric(lines, 'router_routing_overhead_cost_yuan', 'counter', '路由层分类调用累计成本（元）', [
    `router_routing_overhead_cost_yuan ${overhead.costYuan || 0}`,
  ]);
  metric(lines, 'router_routing_overhead_tokens_total', 'counter', '路由层分类调用累计 token（prompt/completion）', [
    `router_routing_overhead_tokens_total{type="prompt"} ${overhead.promptTokens || 0}`,
    `router_routing_overhead_tokens_total{type="completion"} ${overhead.completionTokens || 0}`,
  ]);

  metric(lines, 'router_budget_estimated_spend_yuan', 'gauge', '当日估算花费（元，estimateOnly）', [
    `router_budget_estimated_spend_yuan ${Number(budget.estimatedSpendYuan || 0)}`,
  ]);
  // 修——「预算指标全零」无法区分
  // 「没花钱」与「没记账」。落地真实观测：已结算消费（实际+估算结清）与在途预占数。
  metric(lines, 'router_budget_settled_yuan', 'gauge', '当日已结算消费（元）= 按实际 usage 结算 + 无 usage 估算结清（budget.enabled=false 时也持续记账）', [
    `router_budget_settled_yuan ${Number(budget.settledSpendYuan || 0)}`,
  ]);
  metric(lines, 'router_budget_pending_reserves', 'gauge', '在途预占数（已 reserve 未 settle 的请求数）', [
    `router_budget_pending_reserves ${Number(budget.pendingReserves || 0)}`,
  ]);
  metric(lines, 'router_budget_answer_actual_cost_yuan', 'gauge', '回答模型按真实 usage 结算（元）', [
    `router_budget_answer_actual_cost_yuan ${Number(budget.answerActualCostYuan || 0)}`,
  ]);
  metric(lines, 'router_budget_answer_estimated_cost_yuan', 'gauge', '回答模型无 usage 保留估算结清（元）', [
    `router_budget_answer_estimated_cost_yuan ${Number(budget.answerEstimatedCostYuan || 0)}`,
  ]);
  metric(lines, 'router_budget_routing_overhead_cost_yuan', 'gauge', '路由分类开销（元，L2/L3 分类调用现金记账）', [
    `router_budget_routing_overhead_cost_yuan ${Number(budget.routingOverheadCostYuan || 0)}`,
  ]);
  metric(lines, 'router_budget_legacy_unattributed_cost_yuan', 'gauge', '升级前存量无归因成本（元，只减不增）', [
    `router_budget_legacy_unattributed_cost_yuan ${Number(budget.legacyUnattributedCostYuan || 0)}`,
  ]);
  metric(lines, 'router_budget_total_cost_yuan', 'gauge', '已结算总成本（元）= answerActual + answerEstimated + overhead + legacy', [
    `router_budget_total_cost_yuan ${Number(budget.totalCostYuan || budget.settledSpendYuan || 0)}`,
  ]);
  metric(lines, 'router_budget_answer_settles', 'gauge', '当日回答模型结算次数（answerSettles）', [
    `router_budget_answer_settles ${Number(budget.answerSettles || 0)}`,
  ]);
  metric(lines, 'router_budget_classifier_settles', 'gauge', '当日分类器结算次数（classifierSettles）', [
    `router_budget_classifier_settles ${Number(budget.classifierSettles || 0)}`,
  ]);
  if (budget.settledSpendBeans != null) {
    metric(lines, 'router_budget_settled_beans', 'gauge', '当日已结算消耗算力豆（对账口径）', [
      `router_budget_settled_beans ${Number(budget.settledSpendBeans || 0)}`,
    ]);
  }
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
