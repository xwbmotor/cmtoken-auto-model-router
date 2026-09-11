# 路由约束与可信评测基础

本页说明 v0.13 引入的路由约束与评测基础。当前生产请求由 Go 执行，Node 继续管理配置和记录；服务职责见 [路由设计](路由设计说明.md)。本文的预算预占部分描述预算保护实现，v0.14.8 已验收部署关闭预算保护、采用 Node 费用观察。学习工具不自动调整生产模型评分。

## 执行规则

- `estimatedInputTokens` 使用完整 messages、system、历史、工具定义/调用/结果和输出 schema；分类仍使用独立的用户文本窗口。`estimatedContextTokens` 再加输出预留。
- 容量是供应商无关的启发式估算，不是精确 tokenizer。无法解析的媒体每块暂预留 4096 token，`capacityEstimate.unknownMediaParts` 显示不确定性；不能把这个估算当作多模态容量保证。
- Auto 的相对质量上限支持数字或按 tier 的对象。会话黏性和正常回退仅使用 `qualifiedModelIds`；不允许低成本候选通过黏性重新绕过质量门槛。
- 无模型达到质量门槛时默认失败。只有显式设置 `routing.allowQualityDegradation=true` 才允许可用性降级；响应头 `x-router-quality-degraded` 和决策日志 `qualityDegradedReason` 标明该状态。该选项不会放宽能力、上下文、启用状态及租户候选约束。
- shadow 基线也要通过候选约束；无资格时由合格建议模型接管，日志 `rollout.safetyOverride` 标明原因。显式点名不执行 Auto 的质量优化，但仍校验能力和容量。
- 成功交付后才更新会话模型。会话键使用完整 HMAC，绑定租户凭据、上游和 session id；不存明文凭据作为键。
- 上游 401、402/403、429 及其他请求类 4xx 不降低共享模型健康，也不盲目切换模型重试；调用方保留对应状态码。408、5xx、网络错误及上游超时仍作为供应商故障。客户端取消释放半开探针槽位，不声明模型故障或恢复。
- 当前供应商健康仍按模型统计；同一模型未来接多个独立供应商时，还需要供应商级状态。429 的账户/平台作用域不明确时，保守地不打开全局熔断。

## 预算与成本

预占发生在发起上游调用之前。没有发起上游的取消使用 `release`，不产生消费；已经发起但缺 usage 的调用保留估算，不能声称已取得精确账单。跨日将仍在途的预占携入新日，费用按结算日归属。

预算仍是单进程消费压力账本，影响成本权重和推理档位；不是租户硬配额。多副本共享预算和真实 GPU 资源成本尚未实现。

决策日志新增 `attempts`，包含各次尝试的模型、是否发起、结果、错误范围和费用证据。`totalAttemptCostYuan` 汇总本请求各次回答调用，缺定价时为 null；`totalAttemptCostKind` 区分实际、估算混合和未知。它不包括异步 Judge，也不等于多轮 Agent 完整任务成本；路由分类开销继续在既有 overhead 字段中记录。

`transportOk` 只表示交付结果，`taskSuccess` 保持 null，等待独立业务验收。`policyRevision` 对应配置文件内容修订号；模型供应商若在相同别名下更换权重，仍需额外采集模型版本证据。

## 指标口径变更

新观测单独写入持久化计数器 `responseTimingsV2`，不把旧 `ttft` 响应头样本重新解释为正文时延。升级后新序列从新的观测开始；原有累计请求计数保留。

| Prometheus 指标 | 口径 |
| --- | --- |
| `router_ttft_ms` | 从进入业务处理到完整 SSE 事件中首个非空正文 delta；role、心跳、usage、DONE、仅思考或工具输出不算正文 |
| `router_first_output_ms` | 首个正文、思考或工具输出；与正文 TTFT 分开 |
| `router_upstream_headers_ms` | 每次上游尝试的响应头到达时间 |
| `router_completion_ms` | 完整成功交付的请求时延，含路由和重试 |
| `router_failed_completion_ms` | 最终失败或取消请求的结束时延 |

以上均输出 histogram 的 `_bucket`、`_count`、`_sum`。TTFT 包含已经产生正文、随后中断的流；完整交付和失败分开统计。例：

```promql
histogram_quantile(0.95, sum by (le) (rate(router_completion_ms_bucket[5m])))
```

决策日志 `timingVersion=2`，`latencyMs` 与 `completionLatencyMs` 都是完整请求时延；`responseHeaderLatencyMs` 是最终尝试的响应头时延，`ttftMs` 无正文时为 null。旧日志不能与新 `latencyMs` 无差别混合分析。

## 评测与后续工作

1. [评测完整性](evaluation-integrity.md)：完整 Judge 输入、生成/评分覆盖门禁、同版本补跑、显式合并评分。历史缺原题的报告需要重评；原配置中的历史质量先验没有被本轮凭空重估。
2. [反馈关联](feedback-learning.md)：把请求、人工声明反馈和 Judge 按 requestId 关联，保留来源及未知项，只导出人工待审候选。
3. [业务任务矩阵](routing-matrix.md)：先冻结真实任务与成功标准，再形成相同候选面板，比较固定模型、按任务基线、当前/新策略和事后上界。
4. [离线路由学习流程](routing-learning-workflow.md)：已实现请求特征、按候选概率/费用拟合、盲化预测与矩阵比较。软件回归不等于真实业务训练或生产收益验证。

```powershell
npm run eval:matrix -- --input data/business-matrix.json --out data/business-matrix-report.json
.venv/Scripts/python.exe scripts/mine-decisions.py --days 14 --json
```

没有真实业务结果矩阵时，可以验证软件行为，但不能训练并宣称请求级成功率已校准，也不能声称已经节省成本或超过 OpenRouter。下一阶段需要明确业务任务来源、验收标准和模型版本；再按会话/模板隔离数据，训练简单基线，最后进行受控灰度。
