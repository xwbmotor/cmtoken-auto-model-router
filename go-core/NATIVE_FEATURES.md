# Go 原生决策输入与配置快照

核心请求链路已能在 Go 内完成配置默认值解析、按任务/子任务取质量数据、决策输入构建及语义复核后的再次构建。新的 `--runtime` 从完整配置快照构建不可变代，请求不再调用 Node `/assess`。使用本地快照时，启动、请求、热更新及重启均不需要适配器进程。生产仍受 loopback 实验边界限制，没有切换流量。

## 配置与请求的分工

Node 管理端继续承担 `router.json` 校验、兼容字段迁移、软件版本绑定，以及价格/部署资源派生成本指数。`feature-config.mjs` 只投影所需字段，不传递凭据、端点、请求正文或无关管理数据。Go 的 `internal/features` 解析快照中的原始字段，按配置代编译数值默认值、各档相对质量上限、任务偏好、质量表和子任务样本表。

每个请求仅在 Go 内结合本地分析结果、输出预算、思考参数、时钟和流量桶构建输入。健康、额度、并发和租户资格仍来自运行状态，不能从配置快照冒充实时状态。语义复核重分类后使用同一个构建器，并保留原请求的流量桶与租户/运行快照。各请求拥有独立可修改的映射，配置代之间及请求之间不共享可变结果。

因此本轮完成的是**移除 Node 请求依赖**；并未重写管理端配置校验器或成本派生程序，也没有把 Python 分类器迁到 Go。

## 本地快照启动

先在受控本地配置上执行一次导出。路径应为本次实验专用；快照不能覆盖源 `router.json`。

```powershell
node go-core/compat/export-runtime.mjs --config data/go-migration/lab/router.json --out data/go-migration/lab/runtime.json
./data/go-migration/amr-core.exe --lab --runtime --runtime-config data/go-migration/lab/runtime.json --auth-config data/go-migration/lab/auth.json --ledger data/go-migration/lab/go.wal --listen 127.0.0.1:8791 --upstream http://127.0.0.1:8790/v1/chat/completions
```

鉴权仍使用独立受保护的 `auth.json`，不放入快照。命令不启动模型上游；示例地址必须已有本地模拟服务。启用语义复核时仍需 `--native-semantics`、单独的本地分类器端点和凭据。

导出器先验证源配置，在目标同目录以独占临时文件写入、同步文件后原子重命名。导出失败不替换旧快照。Go 限制快照为 2 MiB，严格解析顶层运行合同，并验证特征 schema、数值、模型身份和价格模型集合。无特征字段的旧快照不能用于 `--runtime-config`，不会静默转回网络适配器。

## 热更新与管理端

1. 保存并验证新的 `router.json`，重新导出到相同 `runtime.json` 路径；如需轮换凭据，另行原子更新 `auth.json`。
2. 获取 Go `/internal/v1/config` 当前 `revision`，使用 `If-Match` 调用 `/internal/v1/config/reload`；已启用的 Node 管理桥仍可执行此步骤。
3. 核对 `configRevision` 与源配置原始字节 SHA256 对应，并核对管理台保存与生效版本一致。启用 `AMR_GO_RUNTIME_CONFIG` 后，管理台发布入口会自动导出并核验生效版本，见 [配置发布闭环](PUBLICATION.md)。仅保存 `router.json` 仍不会自动发布到 Go。

Go 一次发布完整鉴权、分析、语义、特征与计费配置代；在途请求继续旧代，包括热更新后才结束的语义复核。陈旧 `If-Match`、无效特征、缺失计费模型或损坏文件均拒绝发布并保留原代；时区改变仍要求受控重启。账本与审计提交/恢复规则没有改变。

不指定本地快照时，新 Go 在启动/热更新的 `/runtime-config` 请求上协商 `X-AMR-Native-Features: 1`，接收同样的完整特征快照；适配器停止后已生效的请求链路继续工作，但下一次热更新需要配置源恢复。旧 Go 和早期演示仍可使用原 `/assess` 协议做差分对照。新协议不依赖适配器保留历史配置的 64 代缓存。

## 验证

`verify.ps1` 和 Linux CI 均加入 3,145 条原生特征合同对照、165 条缺省/零值/字符串/子任务等边界检查，以及没有适配器进程的运行与语义演示。原有 5,150 条选模、分析及语义差分继续保留。新增 Go 测试覆盖配置所有权、并发构建、无效代拒绝、适配器关闭后请求可用，以及语义复核跨热更新仍固定旧代。

容量工作流的 `native-features` 使用相同 runner 和硬配额，将固定旧版与当前本地快照链路对照，并增加直接 300 RPS 启动检查；`--feature-mode snapshot` 可单独复现该链路。Go 配额组仍包含 Node 管理进程，不能把组合资源说成纯 Go 进程资源。常规流程固定先旧后新，不是交错随机实验，结果需要保留顺序限制。正式性能结论以实际归档结果为准。
