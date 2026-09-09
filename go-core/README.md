# Auto Go 核心迁移

分支：`codex/go-core-migration`。目标是逐步把核心请求服务迁移到 Go，沿用现有管理台，Python 继续承担模型训练、推理与评测。

当前为 **M1：独立 Go 选模核心与本地转发实验链路**。它已有可执行实现和 Node 差分验证，**尚不能替换生产 Node 服务**；不改生产 Compose，不发布新版本标签。

## 已实现的边界

```mermaid
flowchart LR
    Client[本地测试请求] --> Gateway[Go 接入与转发]
    Gateway --> Adapter[Node 规则与配置适配器]
    Adapter --> Features[版本化特征输入]
    Features --> Kernel[Go 评分与选模]
    Kernel --> Admission[Go 原子并发预占]
    Admission --> Mock[本地模拟模型服务]
    Mock --> Stream[Go 非流式与 SSE 返回]
```

Go **独立计算评分和决策**，不是把 Node 已选出的模型转发一遍。暂时复用 Node 的任务分类、请求容量估算和配置默认值解析，避免一次迁移同时改变分类和选模语义。

| 功能 | M1 状态 |
|---|---|
| 质量、用户成本、平台成本、静态时延、自建偏好、健康惩罚、市场信号和负载评分 | 已实现 Go 计算；外部动态状态通过输入快照提供 |
| 绝对质量线、相对质量损失、子任务平滑、能力和上下文过滤 | 已实现 |
| 低输出预算、已验证思考开关、客户端显式思考意图 | 已实现选模约束；实验转发支持常用思考参数路径 |
| 灰度、影子基线资格检查、任务偏好、合格回退顺序 | 已实现决策；时延影子诊断尚未迁移 |
| 本进程计数、同步选模与预占、释放一次 | 已实现，Go mutex 保护；不是模型池全局计数 |
| 非流式与 SSE、即时刷新、取消传播、总超时、鉴权隔离 | 已实现本地实验链路 |
| L1 分类 | 复用 Node 规则，通过独立适配器提供输入 |
| L2/Python、L3/MaaS 复核及采纳 | 原服务保持原样；M1 演示不调用，主动采纳配置在适配器启动时拒绝 |
| 生产鉴权/套餐授权同步、会话粘性、运行健康更新、预算结算、日志、重试、配置热发布 | 待后续迁移，不能把实验服务接入生产流量 |
| 管理台、Python 训练与评测 | 保留现有实现，未声称已与 Go 后端联调完成 |

本地网关强制 `--lab`，监听和出站目标均只能为带端口的字面量 loopback IP；禁止目标重定向。只支持 Auto 请求，显式点名返回 `unsupported_explicit_model`。实验超时是总时长，尚不等价于生产 SSE 闲置超时。失败不自动重试，避免实验阶段引入重复调用。

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

`demo.mjs` 自动启动真实 Go 进程、Node 规则适配器和本地模拟上游，使用随机临时令牌与空闲端口；验证非流式、SSE 及时输出、`[DONE]`、鉴权隔离及拒绝不支持请求，随后清理进程和临时配置。**没有真实模型调用，不读取 `.env`，不使用生产令牌。**

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
