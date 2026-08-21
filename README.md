# Auto Model Router 实验服务

一个零第三方运行依赖的 OpenAI Chat Completions 兼容代理，为 4 个自建模型和 1 个生态模型提供 `model=auto`、自建优先、Shadow 实验、熔断降级、配置管理及监控页面。

可以直接连接 MaaS，也可以采用 `Auto Router → LiteLLM → MaaS`。LiteLLM 的职责边界见 [集成说明](docs/litellm.md)。

> `config/router.json` 中的 `quality` 分数来自两级校准：冷启动先验（公开 benchmark 映射 + `scripts/benchmark-to-quality.mjs`）和 eval gate 实测（`config/eval-gate.json`，50 条真实用例裁判打分）。真实流量跑够量后由校准判定自动解除 `uncertaintyPenalty`。

当前实验配置已禁用生态模型 `Minimax-M3` 和自建模型 `minimax-m25`（原因见 `benchmark-results/REASONING-VERIFICATION-SUMMARY-2026-08-17.md`：其思考无法关闭），Auto 候选和 fallback 只包含 3 个自建模型；需要时可在管理端重新启用。（`benchmark-results/` 为运行时产物，不入库，克隆后由 `npm run benchmark` 生成）

完整的开发、测试和运营操作步骤见 [Auto Model Router 使用说明](docs/使用说明.md)。

移交给新的开发智能体时，请先让其阅读 [智能体交接说明](docs/智能体交接说明.md)。

## 版本规范

本项目只有一个版本号：**软件版本**（SemVer `0.X.X`），唯一来源是 `package.json` 的 `version`，配合 `git tag vX.Y.Z`。

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
- 低置信度语义复核：默认 Shadow 采集分歧，不阻塞主请求；评估器可插拔——`openai-chat`（MaaS 大模型）、`http-json`（自训练小模型 HTTP 端点）或 `cascade`（级联：小模型先判，失败或低置信升级大模型兜底，`minConfidence` 兼任升级线）
- 决策日志：每次路由决策落盘 JSONL（默认脱敏、按天轮转），`/admin/api/decisions` 导出，直接用于标注集采集
- benchmark 先验：通用评测基准（GPQA Diamond / HLE / Terminal-Bench / SciCode / AA-LCR 等）映射为 `quality` 冷启动初值，留痕 `benchmarkScores`（`scripts/benchmark-to-quality.mjs` + `config/benchmark-data.json`）
- 校准判定：模型累计真实样本达标且失败率低于阈值时，`calibrationStatus` 从 pilot/unverified 自动翻 verified，`uncertaintyPenalty` 归零（benchmark 先验让位给实时后验）
- 生产就绪：结构化 JSON 日志、Prometheus `/metrics`（含决策日志磁盘监控）、优雅关停排空 in-flight、令牌桶限流（防成本失控）、`/health` 存活 + `/health/ready` 上游连通性就绪探针
- 反向代理集成：详见 [docs/反代集成.md](docs/反代集成.md)（Nginx/Caddy/HAProxy 示例，含流式超时与 TLS 终结）
- 路由设计说明：详见 [docs/路由设计说明.md](docs/路由设计说明.md)（为何默认 DeepSeek、容差分流机制、shadow→active 量化切换条件——部署团队必读）
- 管理面板双模式：简单模式只留预设与日常开关（运营人员）；专家模式开放全部参数（算法负责人）。右上角切换，选择记住在浏览器。
- 切换影响预估：组件体检面板新增「切换影响预估」按钮——454 条 heldout 上回放三种决策链（规则主导/分级采纳/全量采纳），直接读出判准率/质量/成本/误判方向。
- 小模型采纳门槛：active 模式新增 `semanticRouter.minConfidence`，小模型复核结果置信度低于此值退回规则层（防止小模型瞎猜带偏路由），可从 0（激进/全采纳）调到 1（保守/全不采纳）。级联方式下此值兼任升级线：小模型置信度低于它就升级大模型兜底。
- 误判方向分解：回放输出 underCalled（漏判难任务→质量风险）/ overCalled（多判→成本浪费）/ taskSwapped（同档互错），告诉运维错的方向而不是只给准确率。
- 基线对照：影响模拟面板新增「随机基线（Pareto 前沿）/ 事后最优」对照——当前路由质量应落在两者之间；低于随机基线说明任务区分度不足。
- 组件体检：一键在标准评测集（heldout 454 条，与训练切分同源）上评测分类小模型与规则层，输出准确率/宏F1/混淆矩阵/分歧率——换分类器前后各跑一次即可量化"准了多少"。
- 模型选择与推理强度建议分离；只有标记为已验证的模型才会收到推理参数
- 真实输入/输出单价与 P95 注册、每日预算软保护
- `CLOSED → OPEN → HALF_OPEN` 受控熔断恢复
- 五模型基准测试脚本

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
3. 运行五模型基准测试，并人工复核编程、推理和创意任务。
4. 更新每个模型分任务质量、成本与时延指数。
5. 先对低风险调用启用 `active`，观察自建承载率、错误率和 fallback。
6. 再接持久化指标、租户级策略、流量百分比灰度和质量反馈。

## 五模型基准测试

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
