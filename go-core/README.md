# Auto Go 核心迁移

分支：`codex/go-core-migration`。目标是逐步把核心请求服务迁移到 Go，沿用现有管理台，Python 继续承担模型训练、推理与评测。

当前为 **M2a：Go 原生 L1、容量估算、显式模型调用与本进程会话粘性**。M1 选模与转发已完成，M2 的语义复核与生产租户资格同步仍待衔接，**尚不能替换生产 Node 服务**。

## 已实现的边界

```mermaid
flowchart LR
    Client[本地测试请求] --> Gateway[Go 接入与转发]
    Gateway --> Analysis[Go L1 与完整容量估算]
    Analysis --> Adapter[Node 配置默认值适配器]
    Adapter --> Features[版本化特征输入]
    Features --> Kernel[Go 评分与选模]
    Kernel --> Admission[Go 原子并发预占]
    Admission --> Mock[本地模拟模型服务]
    Mock --> Stream[Go 非流式与 SSE 返回]
```

使用 `--native-analysis` 时，Go 独立执行 L1 分类、置信度、子任务、复杂度信号和完整请求容量估算，再由 Node 适配器按分析结果解析配置默认值与任务质量数据。评分、资格过滤和最终选择也在 Go。未指定该开关时保留 M1 对照路径；演示及 CI 均使用原生路径。Node 仍有每请求配置转换调用，尚未达到完全移除 Node 请求依赖的最终架构。

| 功能 | 当前状态 |
|---|---|
| 质量、用户成本、平台成本、静态时延、自建偏好、健康惩罚、市场信号和负载评分 | 已实现 Go 计算；外部动态状态通过输入快照提供 |
| 绝对质量线、相对质量损失、子任务平滑、能力和上下文过滤 | 已实现 |
| 低输出预算、已验证思考开关、客户端显式思考意图 | 已实现选模约束；实验转发支持常用思考参数路径 |
| 灰度、影子基线资格检查、任务偏好、合格回退顺序 | 已实现决策；时延影子诊断尚未迁移 |
| 本进程计数、同步选模与预占、释放一次 | 已实现，Go mutex 保护；不是模型池全局计数 |
| 非流式与 SSE、即时刷新、取消传播、总超时、鉴权隔离 | 已实现本地实验链路 |
| L1 分类与容量 | Go 原生实现；1153 条 Node 对照验证覆盖置信度、全部信号、完整历史、多模态、工具和 UTF-16 边界 |
| 显式点名 | 开关允许时支持；校验启用、上下文、能力、思考预算、租户资格快照与并发，不套用 Auto 质量门槛 |
| 会话粘性 | HMAC 隔离调用凭据/上游/会话，锁内选择与预占；仅复用当前合格候选，完整有效交付后记录，最多 10000 条、最长 24 小时 |
| L2/Python、L3/MaaS 复核及采纳 | 原服务保持原样；M1 演示不调用，主动采纳配置在适配器启动时拒绝 |
| 生产鉴权/套餐授权同步、运行健康更新、预算结算、日志、重试、配置热发布 | 待后续迁移，不能把实验服务接入生产流量；当前资格集合仍为受信任合同输入 |
| 管理台、Python 训练与评测 | 保留现有实现，未声称已与 Go 后端联调完成 |

本地网关强制 `--lab`，监听和出站目标均只能为带端口的字面量 loopback IP；禁止目标重定向。实验超时是总时长，尚不等价于生产 SSE 闲置超时。失败不自动重试。

原生分析在启动时读取私有 `/analysis-config` 快照。配置适配器当前固定配置、没有热更新；后续需统一 revision。自定义规则只支持 Go RE2 语法及已知任务标签，不支持的规则在启动时报错，不静默退回默认规则。内置规则已对齐 JS 无 `/u` 正则的 UTF-16 长度及换行边界。容量仍是启发式估算，不是模型 tokenizer 的精确计费。

会话仅在当前 Go 进程内保存，重启清空；多副本共享和生产凭据同步未接入。空响应、无有效输出、SSE 缺少 `[DONE]`、取消及写回失败均不建立会话。超大或无法识别的响应仍转发，但保守地不记录粘性状态。

## 一次运行全部本地检查

依赖：Go 1.25+、Node.js 24；Go 代码仅使用标准库，无第三方模块。本次开发编译器为 Go 1.27.1，CI 固定使用同版本。

Windows，从仓库根目录：

```powershell
./go-core/verify.ps1
# 或显式指定已有编译器
./go-core/verify.ps1 -GoExecutable 'C:/Program Files/Go/bin/go.exe'
```

脚本优先使用 PATH 中的 Go，否则使用本地 `data/go-toolchain/go/bin/go.exe`。它不下载或安装工具；构建、日志和结果放在已忽略的 `data/go-migration/` 中。

Linux/macOS，从仓库根目录：

```sh
mkdir -p data/go-migration
cd go-core
go vet ./...
go test -race -timeout 90s ./...
go build -trimpath -o ../data/go-migration/amr-core ./cmd/amr-core
cd ..
node go-core/compat/verify.mjs --binary data/go-migration/amr-core
node go-core/compat/demo.mjs --binary data/go-migration/amr-core
```

`demo.mjs` 自动启动真实 Go 原生分析进程、Node 配置适配器和本地模拟上游，使用随机临时令牌与空闲端口；验证非流式、SSE 及时输出、`[DONE]`、显式调用与鉴权隔离，随后清理进程和临时配置。**没有真实模型调用，不读取 `.env`，不使用生产令牌。**

## 对照验证的含义

`compat/verify.mjs` 以现有 `src/router.mjs` 的 `routeRequest()` 为独立基准：

- 复用现有 56 条评估请求，分别运行流式/非流式决策。
- 加入明确的质量、容量、能力、灰度、预算与思考参数边界场景。
- 使用固定种子 `20260909` 生成 3000 个组合场景。
- 比较模型选择、合格集合、回退顺序、拒绝原因、质量、评分、负载、灰度和思考级别。
- 评分、质量损失和灰度桶的十进制结果要求精确相等；未量化的浮点特征容差为 `1e-12`。拒绝原因比较集合，不要求属性枚举顺序一致。

M1 原始差分语料为 3145 条；报告包含源文件、输入语料和二进制 SHA256，以及成功决策、预期拒绝和不一致数量。Git 提交值只作为运行上下文，**以源文件哈希确认未提交改动的版本**。

这证明所测选模合同的兼容性，不证明完整生产行为等价、业务效果提升或 Go 比 Node 更快。`BenchmarkDecision` 仅测 Go 内存中两个候选的选模内核，不能与包含网络、分类或模型推理的耗时直接比较。

GitHub 的 `Go core migration` 工作流独立运行 `go vet`、`go test -race`、差分检查和进程级演示。Windows 本机没有 C 工具链时，普通并发测试可以运行，但不能声称已完成本地 `-race` 检测。

## 代码入口

- `internal/decision/`：纯 Go 决策内核及版本化类型。
- `internal/gateway/`：并发预占、本地 HTTP 转发及传输测试。
- `cmd/amr-core/`：实验服务入口、JSONL 重放入口。
- `compat/contract.mjs`：从现有分析和配置导出特征，**不调用 `routeRequest()` 或输出选模结果**。
- `compat/assessor.mjs`：本地规则适配器，不连接生产运行状态。
- `compat/verify.mjs`：独立 Node 基准与 Go 差分验证。
- `compat/demo.mjs`：无需手动部署服务的进程级验证。

协议与后续迁移验收见 [合同说明](CONTRACT.md)、[迁移路线](../docs/go-core-migration.md)。
