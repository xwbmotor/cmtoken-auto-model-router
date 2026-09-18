# RouterArena 评测接入

此工具通过 Auto 的真实 `/v1/chat/completions` 入口采集选模与回答，导出 RouterArena 的预测文件。它不修改生产配置，不自行判分，也不自动上传结果。

当前状态：已提供预检、真实入口采集、证据记录和预测文件导出。验证使用本地模拟服务和自编样例；没有运行正式题集，没有榜单成绩。中台模型身份、公开模型名称及计价口径仍需核对，示例配置故意保持未验证状态。

本次对接固定到官方提交 `cff9659dd6a3a07815f4842fcdadea5a597a1df1`，并用其原始 `check_config_models` 和 `check_prediction_fields(check_generated_result=True)` 检查了模拟导出文件，均通过。这仅验证格式契约，不代表完整题集、模型身份、价格或参榜资格通过审核。

## 先检查配置

在仓库根目录运行，默认不会发出网络请求：

```bash
node scripts/routerarena.mjs --manifest integrations/routerarena/manifest.example.json --cases integrations/routerarena/smoke.json
```

输入为 JSON 数组，每条包含 `global index`（或 `global_index`）和 `prompt_formatted`（或 `prompt`）。工具只把题面传给 Auto，不传答案、类别或难度标签。`smoke.json` 是自编联调样例，不是 RouterArena 试题。

将配置复制到本地 `data/` 下，填写：

| 字段 | 含义 |
|---|---|
| `policyRevision` | 冻结的 Go 策略 revision，与响应头 `X-Router-Policy-Revision` 完全一致；不是应用版本号 |
| `routerArenaCommit` | 实际使用的 RouterArena 仓库完整提交 SHA；示例固定为本次核对的 `cff9659dd6a3a07815f4842fcdadea5a597a1df1` |
| `models[].id` | Auto 中台模型 ID |
| `models[].arenaId` | 经核实的 RouterArena 模型名；不能把不同权重或版本改成相似名称 |
| `models[].responseIds` | 该部署实际响应 `model` 字段的允许值 |
| `models[].identityVerified` | 完成权重/版本/部署对应关系核实后才设为 true |
| `maxRequests` | 本轮最大请求数；超过时拒绝运行，不截掉多余题目 |
| `maxTokens` | 每次传给上游的输出预算；不等于包含输入、重试及复核的总费用上限 |
| `timeoutMs` | 单次请求等待时间；客户端超时不保证上游停止计费 |

另行保存模型身份依据、价格来源及生效日期。公开美元价格和中台人民币结算价分开报告，不能直接比较数值。保持候选池、版本、语义模式和上游推理参数不变；仅检查 revision 不能证明上游别名背后的权重没有变化。

## 采集真实运行结果

建议使用隔离部署和专门的评测凭据。凭据应只允许本次候选模型；当前服务的列表查询失败可能扩大候选范围，因此工具在响应后还会检查实际模型。这个检查不能撤销已经发生的上游调用，也不能代替中台权限校验。

通过环境变量设置 `AMR_EVAL_URL`（完整的聊天接口 URL）及 `AMR_EVAL_KEY`。远程接口要求 HTTPS，本机可以使用 loopback HTTP；不要把凭据写入 manifest 或命令参数。

```bash
node scripts/routerarena.mjs --manifest data/arena-manifest.json --cases integrations/routerarena/smoke.json --out data/arena-smoke-run1 --execute
```

输出目录必须不存在，父目录须存在。工具逐条执行，不自动重试。每次先落盘开始记录，再发请求；失败或结果不确定时停止，保留现场，避免重跑造成重复消费。恢复前应核查服务日志，然后显式建立新一轮运行；暂不提供自动断点续跑。

| 文件 | 用途 |
|---|---|
| `manifest.json` | 本轮冻结配置，不含凭据和端点 |
| `evidence.jsonl` | 请求 ID、实际/建议模型、usage、端到端耗时及失败记录 |
| `summary.json` | 完成情况、配置与题面哈希、费用和时延的口径限制 |
| `<name>.json` | 全部成功后生成的 RouterArena 预测与回答；robustness 加对应后缀 |
| `arena-config.json` | RouterArena 模型池配置 |

模型越界、策略变化、响应模型不匹配、缺失 Token、截断或非文本回答都会停止导出。不能删掉失败题目后把较小文件当完整成绩提交。输出中的 `cost` 和 `accuracy` 留空，由官方工具计算；`leaderboardReady` 始终为 false，表示本工具没有权力认定榜单准入。

采集耗时是完整回答耗时，不能填成榜单的纯路由时延。usage 只覆盖最终回答，不保证涵盖失败尝试、分类和异步 Judge；提交前必须从日志对账这些费用，并按维护方认可方式披露。思考 Token 是否已包含于 `completion_tokens` 也须核实，不能重复累计。

## 放入 RouterArena 评测

官方入口：<https://github.com/RouteWorks/RouterArena>。先将该仓库固定到 manifest 中的提交，再完成模型名称和美元单价登记。新增中台模型或私有部署的接纳、版本对应关系与价格口径，需要由维护方确认。

1. 将 `arena-config.json` 放到 `router_inference/config/<name>.json`。
2. 将生成的 `<name>.json` 放到 `router_inference/predictions/`，保留原始题号和题面。
3. 在 RouterArena 仓库运行其检查和评分工具，例如：

```bash
uv run python router_inference/check_config_prediction_files.py amr-smoke sub_10
uv run python llm_evaluation/run.py amr-smoke sub_10
```

这里的名字需改为实际运行名，split 需与官方题集一致。自编的三个 smoke 样例当然不能通过官方 sub_10 的数量/题号检查；它们只用于接口联调。不要为了通过检查补造题目或答案。

不必再次运行 `llm_inference/run.py`：本工具已经保留真实 Auto 回答，重新生成会改变评测对象并产生额外费用。官方评分本身可能调用裁判模型，执行前另行核对预算。

`amr_recorded_router.py` 是可选的 `BaseRouter` 适配类。复制到官方 `router_inference/router/` 并在其 `__init__.py` 注册后，可通过 `AMR_ARENA_PREDICTIONS` 指向冻结预测文件进行选模回放。它仅复用本次实际决策，未见过的题面会报错；不能用其查表耗时冒充 Auto 时延。优先直接导入带回答的预测文件。

本版为了复用真实入口，robustness 也会生成回答，不能宣称此阶段零模型费用；如需纯选模评测，应另接入经过一致性验证的决策入口。本版不自动补全 optimality 所需的其他模型逐题回答，缺少相应矩阵时不声称获得最优选模指标。

## 何时可以对外使用成绩

截至接入核对时，官方文档要求完整题集 8400 条、sub_10 为 809 条、鲁棒性 420 条。具体以固定版本的检查器和数据为准。正式提交包含配置、完整生成结果及鲁棒性预测，经维护方审核后才算榜单收录。

RouterArena 数据及标签不得用于训练、能力评分校准或调参。联调使用自编样例；先在独立开发集冻结策略，再一次性评测。完整结果支持的是指定模型池、版本和协议下的表现，不是完整 Agent 或生产系统认证。

先说明“按 RouterArena 协议本地评测”，收录后再说“已进入榜单”。不能把本工具联调成功写成质量领先或成本节省。
