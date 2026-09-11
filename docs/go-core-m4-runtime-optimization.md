# M4 第三轮：调度限制定位与同配额复核

> 历史阶段记录：下文保留当时的版本、实验条件和待办。“未切换生产”等描述只适用于记录时点；v0.14.8 已完成生产切换，见 [验收记录](go-core-production-v0.14.8.md)。

已修正容量测试中的额外调度限制并完成无采样对照：原脚本在 1 CPU cgroup 下强制 `GOMAXPROCS=1`，现在默认交由 Go 运行时按容器条件设置。本轮实际自动值为 2，CPU/内存硬配额仍为每组 1 CPU / 512 MiB。在包含 150 RPS 阶段的常规流程中，300 RPS Go P95 从 35.93 降至 28.72 ms，P99 从 79.28 降至 66.98 ms；同阶段 Node 分别为 58.62/144.96 ms。

启动直接进入 300 RPS 的问题尚未解决：Go 第一轮 P95 为 843.38 ms，发压器有 40 个计划请求未发起，后两轮恢复至约 30/27 ms。不能只展示常规流程的改善，更不能宣称尾延迟已根治。生产未切换。

## 无采样实测

三个阶段采用相同 Go 二进制，区别为调度设置和是否先经过 150 RPS 阶段；每档分位数合并三轮完整成功请求，吞吐包含排空。所有已发起请求均完整结束，无 HTTP/内容错误，无 OOM。启动检查的 40 个未发起请求保留在计划数中。

| 目标 RPS | Go P95 ms：1 槽 → 自动 | Go P99 ms：1 槽 → 自动 | Go 完整 RPS：1 槽 → 自动 | 两组 Go 完整/计划 |
|---|---:|---:|---:|---:|
| 150 | 19.78 → 20.10 | 26.18 → 25.88 | 149.89 → 149.90 | 各 4500/4500 |
| 300 | 35.93 → 28.72 | 79.28 → 66.98 | 299.64 → 299.68 | 各 9000/9000 |

| 目标 RPS | Go CPU 核：1 槽 → 自动 | Go 采样峰值 MiB：1 槽 → 自动 | 自动阶段 Node CPU 核 / MiB | 自动阶段 Node P95 / P99 ms |
|---|---:|---:|---:|---:|
| 150 | 0.364 → 0.432 | 69.06 → 69.43 | 0.510 / 99.54 | 17.17 / 23.83 |
| 300 | 0.681 → 0.831 | 93.30 → 88.91 | 0.959 / 156.00 | 58.62 / 144.96 |

300 RPS 下恢复自动设置的本轮观测为 P95 下降约 20.1%、P99 下降约 15.5%，代价是平均 CPU 比单槽增加约 22.0%。与同阶段 Node 相比，Go P95/P99 低约 51.0%/53.8%，CPU 低约 13.3%，采样峰值内存低约 43.0%。150 RPS 下 Go P95 仍比 Node 高约 2.93 ms，不能宣称全负载全面占优。内存为整组 cgroup 采样峰值，包含页缓存，不是 RSS。

Node 的 300 RPS P95 在前后阶段为 58.78/58.62 ms，direct 约 12.88/12.96 ms。本轮单槽基线 P95 35.93 ms 已远低于此前不同轮次的 335.51 ms；因此不能用 335.51 → 28.72 宣称约 91% 的修正收益。跨轮波动与启动问题仍需单独看待。

两组均通过各路径 32 路、60 秒 SSE 完整性与唯一上游调用检查。Go 首字节 P95 为 103.32 → 101.74 ms，自动阶段 Node 为 78.08 ms；Go 在此指标仍较慢。这是模拟传输首字节，不代表真实模型生成延迟。

### 跳过 150 RPS 阶段的直接 300 RPS 检查

| 路径 | 完整/计划 | 发压未发起 | 合并 P95 / P99 ms | 各轮 P95 ms |
|---|---:|---:|---:|---|
| direct | 9000/9000 | 0 | 13.16 / 16.90 | 13.33 / 12.94 / 13.06 |
| Node | 9000/9000 | 0 | 67.02 / 119.95 | 105.70 / 51.86 / 41.75 |
| Go 自动 | 8960/9000 | 40 | 324.91 / 918.18 | 843.38 / 29.68 / 26.67 |

未发起的 40 个计划请求均在 Go 第一轮。Go 平均 CPU 为 0.845 核、采样峰值 110.89 MiB，无 OOM，已发起请求均成功；这些不能抵消计划量未完成的缺口。新增检查表明仅恢复自动调度不足以保证启动即承受 300 RPS。诊断已发现预算锁及同步 I/O 等待，启动长尾的具体贡献仍需在对应时间轴上进一步定位，不能据此直接宣称 fsync 是唯一根因或立即弱化持久化。

## 定位证据

Go 1.27.1 本地源码 `runtime/debug.go` 的 GOMAXPROCS 说明和 `runtime/cgroup_linux.go` 的 `adjustCgroupGOMAXPROCS` 实现均表明：在逻辑 CPU 与 affinity 允许时，容器 CPU 配额计算得到的默认执行槽下限为 2。原容量脚本将平均 CPU 配额再次取整后写入 `GOMAXPROCS`，额外限制为 1，覆盖了运行时默认策略。执行槽数量和 cgroup 的平均 CPU 吞吐配额不是同一概念。

诊断采用同一个 Go 二进制、同一 runner、同一完整服务组配额，分别运行 `--go-procs 1` 和 `--go-procs auto`。启动记录确认实际值为 1/2、逻辑 CPU 均为 2；二进制、Node source hash、镜像、配额、输入及 Docker engine 信息相同。每组 300 RPS 三轮、每轮 10 秒，另有 2 路 2 秒 SSE。

诊断开启 CPU、阻塞、互斥及执行跟踪，以下数据含采样开销，不能作为正式性能提升的数字。`gateway.request` 是处理函数区间，不含整个客户端链路；累计调度等待跨多个 goroutine 重叠累计，不是实验墙钟耗时。

| 诊断项 | 强制 1 槽 | Go 自动值 2 |
|---|---:|---:|
| 累计调度等待 | 437.93 s | 38.41 s |
| 分析区间 P95 | 2.80 ms | 4.89 ms |
| adapter 调用区间 P95 | 122.75 ms | 5.30 ms |
| 上游响应头等待区间 P95 | 139.09 ms | 14.67 ms |
| 预算快照区间 P95 | 3.08 ms | 15.24 ms |
| 预算预占区间 P95 | 1.28 ms | 5.29 ms |
| 预算结算区间 P95 | 3.61 ms | 15.59 ms |
| 审计区间 P95 | 1.02 ms | 1.68 ms |
| 整个处理函数区间 P95 | 304.86 ms | 100.58 ms |

典型慢请求的主要时间花在等待而非分析：单槽样本中一个 1,261 ms 的处理区间，分析仅 0.09 ms，预算快照约 276 ms，上游响应头约 658 ms，结算约 262 ms。这些是同一个请求的区间，不以独立分位数相减归因。

自动值明显减少 adapter/网络与调度等待，但预算相关竞争仍存在，不能宣称所有长尾都已消失。互斥 profile 主要集中在账本预占、结算和快照路径；自动值下累计互斥等待约 81.91 s，高于单槽约 71.61 s。诊断自动组第一轮客户端 P95 仍约 418 ms，后两轮约 26/24 ms，因此另安排关闭采样、跳过 150 RPS 阶段直接进入 300 RPS 的检查。

诊断单槽 Go 完成 8,924/9,000 个负载计划请求，发压丢弃 76 个；自动组完成 9,000/9,000，均无已发起请求错误。诊断采样会影响这些数字，最终结论使用下面的无采样实验。

## 实现范围

- 容量脚本默认 `--go-procs auto`，省略人为 `GOMAXPROCS` 覆盖，保留显式整数选项复现实验。Docker cgroup 的 CPU、内存、swap 与进程上限不变。历史 `optimization` / `tail-optimization` 工作流明确传入 `--go-procs 1`，保留其原始实验条件。
- 实验 Go 启动信息记录实际 GOMAXPROCS、逻辑 CPU 和 Go 版本，报告保留所请求设置及实际值。
- 新增可选 `--lab-profile-dir`：只接受新目录，采集 CPU、阻塞、互斥及执行跟踪。普通运行不开启；仅记录调用栈和固定阶段名，不记录正文或凭据，不开放调试 HTTP 端口。
- 诊断结束先正常排空 Go，再归档完整 profile。私有目录/文件保持 0700/0600，仅将容器创建文件的所有者转交给已有挂载目录的所有者，避免宿主读取失败。

账本格式、预算判断、预占/结算的同步落盘、审计同步落盘、重试、选模、Node adapter 和生产入口均未修改。本轮性能修正主要位于实验启动配置。

## 无采样验证方法

实现提交 `e7371afa29677fe2486bb59d2bfcb4a72df90de5`，同一二进制先运行强制 1 槽，再运行自动设置；每版均包含 direct、Node、Go，组内 1 CPU / 512 MiB、150/300 RPS 三轮、10 秒发起窗口、四类均匀混合输入和 32 路 60 秒 SSE。两版不启用 profile。

第三组使用相同二进制和自动设置，新建进程及账本，省略 150 RPS 阶段，直接运行 300 RPS 三轮，另有 2 路 2 秒 SSE。仍有四类预检请求，因此不称为零预热或冷文件系统测试。

实验固定先后顺序，不是随机交错的统计试验；Node/direct 对照用于观察环境变化，不能完全消除共享 runner 与文件系统波动。真实业务、小时级运行和生产 SLO 尚未验收。

## 证据

本地完整回归与最终实现的 Linux CI 均通过：5,150 条差分（3,145 条选模、1,153 条原生分析、852 条语义复核）无差异，90 项 Go 测试及 8 个模糊测试种子通过，`go vet` 和 `go test -race` 通过；真实进程合同、管理桥接及账本往返验证通过。新增 profile 生命周期与拒绝覆盖测试通过，阶段解析器已用实际 Go 执行跟踪验证。最终回归原始文件保存于 `data/go-migration/runtime-regression-34432728398/`，归档为 `capacity-download-10135113496.zip`。

- [完整诊断对照](https://github.com/xwbmotor/cmtoken-auto-model-router/actions/runs/34432139195)，执行提交 `9ad8ed9ae32dd607a9c8b2343771df262a3d39fe`；原始归档 `data/go-migration/capacity-download-10134970466.zip`，展开于 `data/go-migration/runtime-profile-34432139195/`。
- [无采样完整对照](https://github.com/xwbmotor/cmtoken-auto-model-router/actions/runs/34432768236)。
- [当前实现回归](https://github.com/xwbmotor/cmtoken-auto-model-router/actions/runs/34432728398)、[容量冒烟](https://github.com/xwbmotor/cmtoken-auto-model-router/actions/runs/34432728420)。

首次诊断运行 `34431598770` 的 profile 归档因容器/宿主所有者不同失败，已修复并在上述完整诊断运行中验证；不把失败运行当作已完成的诊断证据。

最终无采样工作流成功结束，但该状态表示实验成功执行，不表示启动容量指标合格。原始归档为 `data/go-migration/capacity-download-10135394141.zip`，展开至 `data/go-migration/runtime-pair-34432768236/`。包含 `capacity-runtime-before.json`、`capacity-runtime-after.json`、`capacity-runtime-cold.json` 和构建/设置来源；本地另生成三份 `summary-*.md` 和 `runtime-validation.json`。

常规流程两组各 40,608 个计划请求全部完成；直接 300 RPS 阶段共发起并完成 26,978 个请求，另有 40 个计划请求未发起。总计完整结束 108,194 个请求。各阶段计数均含 direct、Node、Go，以及预检和 SSE。逐请求计数、完整性、上游调用、参数差异、相同二进制/镜像/配额/Node source hash/输入及实际 GOMAXPROCS 均已核验。诊断的参数与计数复核另存于 `runtime-profile-34432139195/diagnostic-validation.json`。

| 证据 | SHA256 |
|---|---|
| 三组共用 Go 二进制 | `2397d55a2c98fefb7052f98a94949abef50f2f6de40a50e5f952f37a4ba5606b` |
| `capacity-runtime-before.json` | `02e220a9c854ff7cdbe4b0baed397efa2f466537f76e9eb680e6fd3712f14d83` |
| `capacity-runtime-after.json` | `88da54940dec5b57ff03d704799c54fef144134277de83ea1de5146588690eaf` |
| `capacity-runtime-cold.json` | `d65b7d9a6ea65c33fed93a8012de7ba455d19de919eabe842c28b36f4a6937f5` |

复现选择[容量工作流](../.github/workflows/go-core-capacity.yml)的 `runtime-profile` 或 `runtime-optimization`；阶段统计使用 `go tool trace -d=parsed <runtime.trace> | node go-core/compat/summarize-trace.mjs <output.json>`，单组负载汇总使用 `node go-core/compat/summarize-capacity.mjs <raw.json> <summary.md>`。大型原始证据未提交 Git，CI 保留 14 天，本地副本留存。后续文档提交不改变本次执行代码。

后续直接 300 RPS 启动排队已完成[第四轮耐久写入优化](go-core-m4-cold-optimization.md)：合并账本与审计同步提交有部分改善，但启动未发起计划仍存在，正式切换出口仍未满足。
