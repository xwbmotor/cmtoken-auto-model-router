# 决策合同 v1

合同用于受信任的请求分析组件向 Go 内核提供特征；不是让最终用户上传任意模型配置来调度生产流量。类型定义以 `internal/decision/types.go` 为准。

## 输入与责任

| 字段 | 提供方与含义 |
|---|---|
| `schemaVersion` | 固定为 1；其他版本拒绝 |
| `configVersion` | 配置所属的软件版本；不等同于配置内容 revision，后续配置热发布需增加内容版本校验 |
| `requestedModel` | 原始 Auto 标识；显式模型调用不在 M1 支持范围内 |
| `analysis` | 分类任务、子任务、难度、复杂度、完整请求上下文估算及能力要求 |
| `completionTokens` / `thinkingSpecified` / `thinkingOff` | 从原请求提取的输出预算与显式思考意图 |
| `policy` | 已按现有配置语义解析默认值的数值参数；零不是未配置的替代符 |
| `models` | 模型身份、能力、任务大类质量、小类样本、成本/时延指数、并发额度与已验证思考控制 |
| `runtime` | 显式时间、灰度桶、预算压力、资格集、健康、负载和市场信号快照 |

M1 Node 适配器调用既有 `analyzeRequest` 与 `estimateRequestCapacity`，完整输入估算不会被分类覆盖值替换。它只选择质量数据来源，不计算平滑质量、评分、资格集合或最终模型。

`allowedModelIds: null` 表示本合同未施加额外租户集合；`[]` 表示无任何授权候选，两者不等价。生产套餐验证尚未接入，所以实验网关禁止生产目标。`capacity: 0` 表示没有配置本进程限额，不能用上游部署总并发代替。

`runtime.trafficBucket` 必须在 `[0,100)`；重放使用固定桶，不在 Go 内部重新抽样。实验适配器生成桶；之后生产多阶段评估必须沿用同一请求的桶。

纯内核使用输入 `inflight`。网关执行时忽略适配器给出的 `inflight`，在锁内读取自身计数、计算选择并预占，避免旧快照导致超额；释放函数只生效一次。

## 输出

输出包含 `selectedModel`、`suggestedModel`、`fallbackOrder`、`qualifiedModelIds`、候选评分与负载、拒绝原因、灰度状态、质量降级状态及思考级别。`schemaVersion` 仍为 1。

结果对应**会话粘性应用之前**的候选决策。市场/健康等状态是传入快照，没有声称 Go 已维护这些生产状态。观察性的时延影子推荐、中文解释文案及完整分类证据仍留在现有实现，不纳入 M1 输出兼容范围。

代码以 IEEE-754 实际值实现 JS `toFixed` 的舍入规则，避免直接乘倍数四舍五入的二次舍入差异。排序采用稳定排序，候选最终排序按评分；合格回退池按评分再按成本排序，沿用现有语义。

## 调用方式

- 二进制 `amr-core replay`：标准输入每行一个合同，标准输出每行一个 `{"decision": ...}` 或 `{"error": ...}`；单行上限约 2 MiB。
- 实验 HTTP `POST /internal/v1/decide`：使用 `AMR_GO_ACCESS_TOKEN` 鉴权；只计算，不预占、不调用上游。
- 实验 HTTP `POST /v1/chat/completions`：先调用私有适配器，再由 Go 选模、预占、转发至启动参数指定的本地目标。

HTTP 拒绝未知合同字段、多个 JSON 值和不支持的版本。常见错误码：`invalid_contract`、`unsupported_strategy`、`unsupported_explicit_model`、`no_candidates`、`quality_gate`、`model_capacity_exhausted`。

## 下一阶段不能省略的衔接

生产配置校验仍在 Node；M1 的解析与有限校验不能替代它。迁移原始配置读取时必须对齐缺省值、数字字符串、模型删除、配置内容 revision 和热更新语义。动态状态的归属与更新时间也要明确，不能在两个实现中分别累计预算、并发和失败次数。
