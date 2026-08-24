# Auto Model Router

一个零第三方运行依赖的 OpenAI Chat Completions 兼容代理：`model=auto` 一入口，按任务类型与难度自动从模型池选型——自建优先、质量底线、双成本指标（用户侧豆价 + 平台侧算力资源）、Shadow 灰度、熔断降级、配置管理与监控页面一体。

可以直接连接 MaaS，也可以采用 `Auto Router → LiteLLM → MaaS`。LiteLLM 的职责边界见 [集成说明](docs/litellm.md)。

> `config/router.json` 中的 `quality` 分数来自两级校准：冷启动先验（公开 benchmark 映射 + `scripts/benchmark-to-quality.mjs`）和 eval gate 实测（`config/eval-gate.json`，50 条真实用例裁判打分）。真实流量跑够量后由校准判定自动解除 `uncertaintyPenalty`。

模型池在 `config/router.json` 注册（示例配置含 3 个自建模型；历史曾评测 `minimax-m25`——思考无法关闭——与 `hy3-preview`、`Minimax-M3`，均已移除/禁用）。`benchmark-results/` 为运行时产物，不入库，克隆后由 `npm run benchmark` 生成。

完整的开发、测试和运营操作步骤见 [Auto Model Router 使用说明](docs/使用说明.md)。

交接给新的开发智能体时，请先让其阅读 [智能体交接说明](docs/智能体交接说明.md)。

## 版本规范

本项目只有一个版本号：**软件版本**（SemVer `0.X.X`），唯一来源是 `package.json` 的 `version`，配合 `git tag vX.Y.Z`。

- 递增规则：修 bug / 调参数 = patch（末位 +1）；**新增功能 = minor bump**（中位 +1，末位归零）；主版本保持 0 直到对外承诺接口长期稳定。

- 运行时所有对外暴露的版本（`/health` 的 `configVersion`、响应头 `x-router-policy-version`、`/metrics` 的 `router_config_version`、管理后台显示）都取这个值。
- `config/router.json` 不再维护独立的整数修订号；配置变更历史由 `config/history/` 目录按时间戳归档（每次保存自动备份上一版）。
- 发布流程：改代码 → bump `package.json` 版本 → `git commit` → `git tag vX.Y.Z` → `git push --tags`。

## 已实现

- `POST /v1/chat/completions`：支持 `auto` 和显式模型、非流式及 SSE 流式透传
- `GET /v1/models`：返回 `auto` 与已启用模型
- 自建优先的质量/成本/时延评分（成本双指标：用户侧豆价 + 平台侧算力资源，独立权重可配）
- 工具、JSON、视觉、上下文等能力硬约束
- 408、429、5xx 和网络错误下的候选模型降级
- 连续失败熔断、实时延迟惩罚、`x-session-id` 会话粘性
- Shadow/Active 模式、策略版本化和原子配置写入
- 管理页面：模型参数、策略发布、路由预演、健康与流量指标
- 运营策略预设、Auto 灰度比例、发布前十类任务影响模拟和高影响二次确认
- 可解释难度信号；发布时自动备份上一版本到 `config/history/`
- 低置信度语义复核：默认 Shadow 采集分歧，不阻塞主请求；评估器可插拔——`openai-chat`（MaaS 大模型）、`http-json`（自训练小模型 HTTP 端点）或 `cascade`（级联：小模型先判，置信度 ≥ `smallAcceptThreshold`(0.7) 直采、低置信升级大模型复核，大模型挂降级回小模型，双挂才回退规则层）
- 决策日志：每次路由决策落盘 JSONL（默认脱敏、按天轮转），`/admin/api/decisions` 导出，直接用于标注集采集
- benchmark 先验：通用评测基准（GPQA Diamond / HLE / Terminal-Bench / SciCode / AA-LCR 等）映射为 `quality` 冷启动初值，留痕 `benchmarkScores`（`scripts/benchmark-to-quality.mjs` + `config/benchmark-data.json`）
- 可靠性判定：模型累计真实样本达标且失败率低于阈值时，`reliabilityStatus`（旧字段名 `calibrationStatus` 兼容读取）从 pilot/unverified 自动翻 verified，`uncertaintyPenalty` 归零（benchmark 先验让位给实时后验）
- 生产就绪：结构化 JSON 日志、Prometheus `/metrics`（含决策日志磁盘监控）、优雅关停排空 in-flight、令牌桶限流（防成本失控）、`/health` 存活 + `/health/ready` 上游连通性就绪探针
- 反向代理集成：详见 [docs/反代集成.md](docs/反代集成.md)（Nginx/Caddy/HAProxy 示例，含流式超时与 TLS 终结）
- 路由设计说明：详见 [docs/路由设计说明.md](docs/路由设计说明.md)（为何默认 DeepSeek、容差分流机制、shadow→active 量化切换条件——部署团队必读）
- 管理面板双模式：简单模式只留预设与日常开关（运营人员）；专家模式开放全部参数（算法负责人）。右上角切换，选择记住在浏览器。
- 切换影响预估：组件体检面板新增「切换影响预估」按钮——454 条 heldout 上回放三种决策链（规则主导/分级采纳/全量采纳），直接读出判准率/质量/成本/误判方向。
- 三阈值分级采纳：`smallAcceptThreshold`(0.7) 小模型直采线——低于它升级大模型；`finalAdoptionThreshold`(0.5) 最终采纳线——语义复核结果低于它退回规则层；旧 `minConfidence` 为兼容别名。规则层置信度是证据强度函数（否定包裹/元讨论/多任务冲突下调），归因因素 `confidenceFactors` 落决策日志。
- **复核事件持久化（v0.7.0；v0.7.1 关停排空）**：shadow/灰度下的每次语义复核按 `requestId` 落 `data/decisions/semantic-reviews-*.jsonl`（独立事件流，含 L1/L2/L3 各层 task·tier·confidence、cascade 层级、**small/large/total 三段耗时**、分歧结论、分类开销）。优雅关停按「在途后台复核（≤8s）→ 决策日志 → 语义事件 → 预算账本」顺序排空——滚动重启不丢正在复核的事件。
- **语义独立灰度 v0.7.2 八审加固**：在 v0.7.1 HMAC + 服务端 secret 基础上，①`SEMANTIC_BUCKET_SECRET` 写入生产 compose（active 模式启动强校验，shadow 可缺省）——secret 跨重启稳定，实验组不被容器滚动打乱对照；②`semanticRollout` 三态（applied/rejected/hold）都带 `bucketKey`+`source`，审计分桶身份；③新增指标 `router_semantic_bucket_key_source_total{source=session|fingerprint|internal}`（internal 异常升高=在线探测实验组）；④SIGTERM 排空行为级 e2e 已入测试套（tests/shutdown-drain.test.mjs）；⑤`classifierLatencyMs` 统一 `totalLatencyMs` 口径。

- **语义独立灰度（v0.7.0；v0.7.1 加固）**：`semanticRouter.activeTrafficPercent`（0-100，默认 5）——active 模式下按 **HMAC(服务端 secret)** 分桶（七审：无盐哈希可被客户端预计算操纵）。桶键优先级 `x-session-id`（同会话重试不换组）> `keyFingerprint`（同租户稳定）> 服务端内部实验 ID（不复用客户端 `x-request-id`）。桶外记 `rollout_hold` 照常后台观察。secret 默认进程级随机，可选 `SEMANTIC_BUCKET_SECRET` 环境变量跨重启稳定。与模型路由整体灰度 `routing.activeTrafficPercent` 是两个独立实验变量。
- **三层分类口径统一（v0.7.0）**：L1 语义信号（task 正则/否定包裹/trivial）与 L2/L3 共用 user-only 文本；规模信号（长度/轮次/结构复杂度）保留请求全量口径——用户贴回长代码要求改写，工作量确实按全量算。
- **路由成本分账（v0.7.0；v0.7.1 补恒等式）**：五元组 `answerActualCostYuan`（真实 usage）/ `answerEstimatedCostYuan`（无 usage 估算结清）/ `routingOverheadCostYuan`（分类调用）/ `legacyUnattributedCostYuan`（升级前存量）/ `totalCostYuan`，**四分项之和恒等于 `settledSpendYuan`**（可对账）；指标 `router_budget_answer_actual_cost_yuan` 等 5 个 gauge。净节省 =（固定模型基线 − answerActual − answerEstimated）− routingOverhead。
- 误判方向分解：回放输出 underCalled（漏判难任务→质量风险）/ overCalled（多判→成本浪费）/ taskSwapped（同档互错），告诉运维错的方向而不是只给准确率。
- 基线对照：影响模拟面板新增「随机基线（Pareto 前沿）/ 事后最优」对照——当前路由质量应落在两者之间；低于随机基线说明任务区分度不足。
- 组件体检：一键在标准评测集（heldout 454 条，与训练切分同源）上评测分类小模型与规则层，输出准确率/宏F1/混淆矩阵/分歧率——换分类器前后各跑一次即可量化"准了多少"。
- 模型选择与推理强度建议分离；只有标记为已验证的模型才会收到推理参数
- 真实输入/输出单价与 P95 注册、每日预算软保护
- `CLOSED → OPEN → HALF_OPEN` 受控熔断恢复
- 多模型基准测试脚本（对全部启用模型跑 8 项任务）
- 相对质量损失上限（v0.5.1）：评分前按难度分档过滤候选——simple/balanced/complex 各有相对质量容忍（0.08/0.04/0.02），成本项不再能淹没质量差距；全部超限退回绝对地板保可用性
- 小类分数平滑进路由（v0.5.1）：30 个小类实测分按样本量平滑（n/(n+8)）参与评分，样本少的档位自动向大类分靠拢
- 能力声明 fail-closed（v0.5.1）：tools/json/vision 请求只发给显式声明支持的模型，未声明视为不支持
- 流式成功判定延后到流尾（v0.5.1）：SSE 中断不双记成功与失败，TTFT 单独统计；预算预占-结算按实际 usage 冲正
- 市场信号去自强化（v0.5.1）：份额正向加成移除（路由器不再学自己的历史决策），保留失败率降权与显式点名信号；点名任务经 `explicitTask` 持久化（v0.5.2 修通）
- 预算预占-结算（v0.5.2）：请求级 reserve/settle，实际 usage 冲正，三口径台账（estimated/settledActual/settledEstimated），结算数学修复（预占10实际15→记15）
- 流式记账纪律（v0.5.2）：流尾单次落账（completed/aborted 各恰一次），非流式成功记在响应体读毕后，断流不双记
- 「不做 auto」对比（v0.5.0）：影响预估新增固定单模型基线表——同一批代表任务全量固定给每个模型与当前策略并排比较质量/用户成本/算力消耗/时延百分比，换策略与横向汇报直接有数
- 三层分类架构可视化（v0.5.0）：质量复核页改为 L1 规则层 → L2 小模型复核层 → L3 大模型复核层三卡片布局，每层独立配置（L1 规则内置于代码、L2 端点地址、L3 模型选择+级联阈值），并显示规则层高置信定案占比（counters.routeMethod）
- 模型能力数据 Excel 导入导出（v0.5.0）：`GET /admin/api/model-data/template-xlsx`（CSV+BOM，Excel 直接打开）+ `POST /admin/api/model-data/import-xlsx`，前端按钮样式统一，兼容 JSON 导入
- 管理端点鉴权失败限速（v0.5.0）：`/admin` 与 `/metrics` 鉴权失败按 IP 限速（10 次/分钟），连续失败临时封禁
- 使用手册容器化（v0.5.0）：Dockerfile 补 COPY `docs/`，修复云容器 `/manual` 404

流量与健康指标保存在内存中，服务重启后清空；预算估算账本持久化到 `data/budget-ledger.json`，路由决策日志持久化到 `data/decisions/`。实验验证通过后应接 PostgreSQL/ClickHouse 和 Prometheus。

### 安全默认值

- `semanticRouter.mode=shadow`：分类模型只在后台复核，不改变线上路由。
- `reasoningControl.enabled=false`：逐模型验证 MaaS 参数前，不向上游发送额外字段。
- `budget.enabled=false`：填写真实 Token 单价和每日预算后再开启。

## 安全准备

此前在对话中出现过的 API Key 应立即撤销。创建新的 Key，并且只放在本机 `.env`、容器 Secret 或密钥管理系统中。

PowerShell：

```powershell
Copy-Item .env.example .env
notepad .env
```

至少设置：

```dotenv
MAAS_API_KEY=轮换后的新Key
ROUTER_ACCESS_KEY=客户端调用Router所用的新Key
ADMIN_TOKEN=管理端所用的新Token
```

`.env` 已在 `.gitignore` 中，不会被提交。

## 本机启动

需要 Node.js 20 或更高版本：

```powershell
npm test
npm start
```

打开 <http://127.0.0.1:8787/>，输入 `ADMIN_TOKEN`。默认仅监听本机；绑定非本机地址时，服务会强制要求同时设置 `ADMIN_TOKEN` 和 `ROUTER_ACCESS_KEY`。

健康检查：

```powershell
Invoke-RestMethod http://127.0.0.1:8787/health
```

## 调用 Auto

```powershell
$headers = @{
  Authorization = "Bearer $env:ROUTER_ACCESS_KEY"
  "Content-Type" = "application/json"
  "x-session-id" = "conversation-001"
}
$body = @{
  model = "auto"
  messages = @(@{ role = "user"; content = "分析这段 Java 代码的并发问题" })
  stream = $false
} | ConvertTo-Json -Depth 10
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8787/v1/chat/completions -Headers $headers -Body $body
```

响应头包含：

- `x-router-selected-model`：实际调用模型
- `x-router-suggested-model`：Auto 建议模型；Shadow 模式下可能不同
- `x-router-policy-version`：软件版本
- `x-router-shadow`：是否处于 Shadow 模式

## 推荐实验流程

1. 在管理端将模式切换为 `shadow`，实际仍走 `shadowModel`。
2. 收集真实流量中的 Auto 建议、任务类型、复杂度和模型健康。
3. 运行基准测试（对全部启用模型），并人工复核编程、推理和创意任务。
4. 更新每个模型分任务质量、成本与时延指数。
5. 先对低风险调用启用 `active`，观察自建承载率、错误率和 fallback。
6. 再接持久化指标、租户级策略、流量百分比灰度和质量反馈。

## 基准测试

先查看计划，不发送请求：

```powershell
npm run benchmark -- --dry-run
```

当前配置下，真实运行会对启用的自建模型执行 8 项任务（如 3 个启用模型 = 24 次调用，以 `--dry-run` 输出为准）：

```powershell
$env:BENCHMARK_CONCURRENCY = "2"
npm run benchmark
```

结果写入 `benchmark-results/`。简单题、抽取和分类有自动检查；代码、架构和创意任务必须人工评测，不能仅凭输出长度或模型自评更新质量分。

## 上线前评估门（eval gate）

用固定用例集（`config/eval-gate.json`，50 条，覆盖 coding / reasoning / creative / extraction / default）实测「路由选中模型」的输出质量，由裁判模型按 rubric 打分（0~1），防止静默质量退化。

```powershell
npm run eval:gate                         # 路由模式：跑全部用例，阈值 0.7
npm run eval:gate -- --model qwen36-35b   # 单模型模式：候选模型准入
npm run eval:gate -- --limit 10           # 只跑前 10 条（快速冒烟）
npm run eval:gate -- --baseline data\eval-gate\<上次报告>.json   # 对比基线，防相对退化
```

- 总均分低于 `--min`（默认 0.7）或相对基线下降超过 0.05 → 非零退出码，可接 CI。
- 报告落盘 `data/eval-gate/`，含总均分、按任务、按模型、低分用例明细。
- 建议流程：上线前跑一次存为基线；每次改路由配置 / 换模型后再跑并 `--baseline` 对比。

## Docker Compose

```powershell
docker compose up --build -d
```

Compose 含两个服务：`auto-router`（主路由 :8787）+ `classifier`（语义分类器，仅 compose 内网可达，`depends_on` 健康检查后启动主路由）。主路由通过 `SEMANTIC_CLASSIFIER_URL=http://classifier:8788/classify` 环境变量指向分类器服务名（优先级高于 config/router.json 里的 127.0.0.1）。

Compose 仅把端口发布到宿主机 `127.0.0.1`。如果通过反向代理对外服务，请同时配置 TLS、访问控制、请求体限制和管理路径隔离。

**Ubuntu 生产部署**（独立 URL + 注册为 `auto` 模型给平台/客户端试用，passthrough 模式 key 无感）：
详见 [docs/Ubuntu生产部署.md](docs/Ubuntu生产部署.md)——镜像导出/导入、compose 生产文件、凭证注入、冒烟验证、运行数据位置与迭代闭环说明。

使用 LiteLLM 作为网关底座（可选）：

```powershell
docker compose -f compose.litellm.yaml up --build -d
```

## 语义分类器（自训练小模型）

`semanticRouter.provider=http-json` 时，语义复核由本地小模型服务承担（约 2ms/次，替代 LLM 的 ~1.4s）。模型工件在 `data/training/model/`，随仓库交付。

**Linux 裸机部署**（不经 Docker）：

```bash
pip install -i https://pypi.tuna.tsinghua.edu.cn/simple scikit-learn==1.9.0 joblib numpy
./scripts/serve_classifier.sh --port 8788   # 前台运行；日志 data/training/serve.log
```

**Windows**：双击或执行 `scripts\serve_classifier.bat`。

健康检查 `GET /health`；Prometheus 指标 `GET /metrics`（请求量/错误数/推理耗时/低置信占比）。

分类器不可用时的降级：shadow 模式下错误只计数不阻塞请求；active 模式下自动回退规则层决策（`semanticReview.status=error`），主路由永不因分类器故障 5xx。

## 重要行为

- 只有 Auto 请求会 fallback；显式模型请求保持可预测性，不自动换模型。
- 只在上游尚未返回成功响应时 fallback；SSE 已开始向客户端输出后不会重放。
- 模型能力配置为 `false` 时会被硬过滤；`null` 表示未知，需要实测确认。
- 自建优先通过约束和偏好实现，但模型故障、上下文不足或质量不达标时允许生态兜底。
