# M4 混合输入容量瓶颈排查

> 历史阶段记录：下文保留当时的版本、实验条件和待办。“未切换生产”等描述只适用于记录时点；v0.14.8 已完成生产切换，见 [验收记录](go-core-production-v0.14.8.md)。

本文件保留诊断阶段证据。后续已经完成 [L1 扫描优化与同机验证](go-core-m4-optimization.md)，所测 300 RPS 混合输入由约 133 提升至 299 RPS；下文“尚未优化”描述的是诊断提交时的状态。

已将本轮的主要瓶颈定位到 **Go 原生 L1 分析器对长文本的多轮正则扫描**。同样保留 Node 适配器和三次同步落盘，仅短文本时 Go 组合能完整交付约 300 RPS、P95 16.11 ms；混合输入约 134 RPS；仅长历史约 27–37 RPS。CPU 剖析与输入对照的方向一致。当前应优先优化 L1 扫描，尚不能据此宣称修复完成或恢复了混合负载容量。

## Linux 实测结果

组件基准两轮结果如下；单位为每次调用的平均时间，不是端到端 P95。

| 组件 | 第 1 轮 ms/op | 第 2 轮 ms/op | 范围 |
|---|---:|---:|---|
| Go 短文本分析 | 0.0615 | 0.0637 | JSON 解析 + L1 + 容量估算 |
| Go 长历史分析 | 18.4634 | 17.8848 | 同上，每次分配约 1.06 MB |
| Go 持久化 | 1.0398 | 1.0116 | 独立临时目录的预占、结算、审计，三次同步落盘 |

分析基准 CPU profile 总采样 14.69 CPU 秒，`regexp.(*Regexp).find` 累计 12.54 秒（85.36%）。这是短文本和长历史两个基准的合并 profile，不是完整网关的 CPU 占比。调用点归因包括任务规则 4.19 秒、结构信号 2.48 秒、优化维度 2.65 秒、分句 0.90 秒、子任务 0.96 秒、否定检查 1.01 秒。JSON 解析、容量估算和编码也有成本，但本次采样的主要开销在匹配扫描。

全链路对照如下。RPS 按调度开始至最后请求结束的实测跨度计算，包含排空；P95 只统计完整成功请求，因此同时列出错误与未发起数。错误数不含发压器丢弃，后者由待处理达到 256 或调度迟到超过 1 秒触发。

| 输入 | 目标 RPS | Node 完整 RPS | Go 完整 RPS | Node / Go P95 ms | Node / Go 错误 | Node / Go 未发起 |
|---|---:|---:|---:|---:|---:|---:|
| 四类混合 | 150 | 149.92 | 133.62 | 16.75 / 1975.19 | 0 / 1 | 0 / 226 |
| 四类混合 | 300 | 299.70 | 133.69 | 41.05 / 2356.13 | 0 / 0 | 0 / 3206 |
| 仅短文本 | 150 | 149.92 | 149.90 | 14.68 / 15.57 | 0 / 0 | 0 / 0 |
| 仅短文本 | 300 | 299.72 | 299.69 | 20.72 / 16.11 | 0 / 0 | 0 / 0 |
| 仅长历史 | 150 | 149.88 | 36.74 | 49.77 / 7476.66 | 0 / 189 | 0 / 1856 |
| 仅长历史 | 300 | 256.28 | 26.67 | 1041.92 / 10521.92 | 0 / 357 | 564 / 4965 |

三个实验的 direct 路径均完成全部计划请求；Node 在仅长历史 300 RPS 档也出现饱和，不能将它描述为所有输入下均承载 300 RPS。仅短文本 300 RPS 时 Go 服务组平均使用约 0.39 CPU 核；混合和仅长历史的 Go 高档位约 0.90–0.97 核，并出现 cgroup 限流。此处是整个 Go 服务组的 CPU 用量，不是单个 Go 进程。

仅长历史共 546 个错误：193 个 `assessment_unavailable`、10 个 `upstream_unavailable`（HTTP 502），343 个 `no_candidates`（HTTP 422）；混合输入另有 1 个 `assessment_unavailable`。这些是原始响应的已验证分类。代码中的适配器客户端等待上限为 3 秒，单模型熔断也会进入 `no_candidates`；CPU 饱和后出现等待与健康状态变化是候选解释。本轮没有逐次传输错误及健康快照，不能将每个 502 都认定为超时，或将全部 422 的具体原因写成已经证实。

三组共 45 个测量组、70,219 次发起请求（含 18 条预检和 18 条短 SSE）。计数与逐请求记录已核对；三组均通过唯一上游调用与流式完整性检查，无 OOM kill。本轮 SSE 为 2 路、2 秒的诊断冒烟，前一轮 32 路、60 秒的结果另见 [同配额实验](go-core-m4-capacity-results.md)，不能混为本次测量。

## 范围与方法

针对前一轮 1 CPU / 512 MiB 下 Go 组合在 150/300 RPS 档的排队问题，本轮只增加诊断基准和输入类型选择，未修改请求算法、预算持久化或生产入口。运行代码相对 `7ea7aab` 的分析器、网关和账本实现保持不变。

诊断提交：`f30e8d7eddd290732b66210c9b6fbf8123f1a192`。同一 Linux CI 作业先运行 Go 分析器 CPU 基准及持久化基准，再分别运行四类混合输入、仅短文本、仅长历史的全链路对照。每类输入都保留 direct / Node / Go 三条路径，10 秒发起窗口、150/300 RPS、各两轮，服务组均为 1 CPU / 512 MiB。Go 组仍包含 Node 适配器与管理服务，预算 WAL 与审计同步落盘均开启。两轮轮换顺序，资源状态在各次独立实验内部复用；不是显著性检验或精确容量极限搜索。

组件基准在 Linux CI 宿主运行，不在服务组配额内；只用于定位单次计算或同步落盘开销，不能直接当作网关容量。Go 分析基准包含 JSON 解析、分类、复杂度和容量估算；分析器初始化不在计时内。持久化基准每次执行预占、结算和审计，保留三次同步落盘。

## 已核实的代码路径

请求在 [gateway.go](../go-core/internal/gateway/gateway.go) 中先执行 `g.analyzer.Analyze(data)`，再调用 `g.assess(...)`。Node 适配器收到 native analysis 后，[contract.mjs](../go-core/compat/contract.mjs) 直接使用它，不再重新做一次 Node L1 分析。因此 Go 分析器 CPU 热点发生在适配器请求之前。

[analysis.go](../go-core/internal/analysis/analysis.go) 的主要扫描点包括任务规则 `MatchString`、结构信号和优化维度 `FindAllString`、分句统计、子任务与否定范围。任务规则与多数固定正则已经预编译，不能简单把问题描述成“每次都编译全部正则”。工具名的两个小正则仍在请求内编译，但本轮长历史热点不包含工具名匹配。

两套账务写入语义不同：[budget.mjs](../src/budget.mjs) 将 Node 更新加入异步 JSON 写入队列，`reserve/settle` 不等待磁盘写入完成；[decision-log.mjs](../src/decision-log.mjs) 也异步追加。Go 的 [ledger.go](../go-core/internal/ledger/ledger.go) 在预占和结算提交时调用 `file.Sync()`，[runtime.go](../go-core/internal/gateway/runtime.go) 的审计同样同步落盘。本轮未关闭或绕过任何 Go 持久化步骤。

## 前一轮请求类型分布证据

以下取自已归档标准实验的 50 RPS 档，每个单元格包含 375 次完整请求。单位为端到端 P95 ms，包含约 10 ms 模拟上游；不是纯网关开销。

| 路径 | 短文本 | 长历史 | 工具消息 | 图片 |
|---|---:|---:|---:|---:|
| Node | 16.27 | 18.83 | 16.50 | 16.34 |
| Go 组合 | 16.01 | 45.14 | 25.40 | 16.50 |

长历史由 16 条交替 user/assistant 消息组成，每条重复 64 次“项目需求、约束条件和执行记录。”，另有 system 与最后一条 user 消息。它是可复现的合成输入，不代表真实业务分布。

## 优化顺序与验证约束

优先减少长文本上的重复扫描，评估固定字面词匹配或保守预筛选；复杂表达式与自定义规则保留现有正则路径。任何优化都必须保持任务顺序、UTF-16 计数、大小写、否定范围、重叠匹配和信号计数语义，不能通过截断历史、减少规则或降低精度得到吞吐提升。后续应以现有差分语料和针对这些边界的案例验证，再用同配额混合负载复测。

本轮尚未实现上述优化。适配器和持久化也有成本，但不能仅凭“多一个进程”认定它们是主要根因，更不能通过取消同步落盘改变验收口径。本轮没有完整网关的跨进程火焰图或全部阶段时延，因此不能给出它们各占端到端耗时的精确比例。

## 证据与复现

[诊断 CI 34423374328](https://github.com/xwbmotor/cmtoken-auto-model-router/actions/runs/34423374328)、[迁移回归 34423366482](https://github.com/xwbmotor/cmtoken-auto-model-router/actions/runs/34423366482) 和[容量冒烟 34423366556](https://github.com/xwbmotor/cmtoken-auto-model-router/actions/runs/34423366556) 均通过。诊断作业成功表示数据采集和完整性检查完成，负载下的请求错误与发压丢弃仍按表中保留，不表示性能验收通过。

原始归档为 `data/go-migration/capacity-download-10131925026.zip`，已展开到 `data/go-migration/diagnosis-34423374328/`（不提交大型原始数据）。其中包含三份原始 JSON、CPU profile、带行号的热点、组件基准日志；本地另生成三份 `summary-*.md` 和计数核验 `diagnostic-validation.json`。CI 归档保留 14 天，本地副本用于长期留存。

| 原始证据 | SHA256 |
|---|---|
| `capacity-diagnostic-short-history-tools-image.json` | `be4f1c34c77725f9874521b9c17f8aec7d385a14b7a9225724ea568d68097c36` |
| `capacity-diagnostic-short.json` | `51a2f224f8a86cfe6298e55c0b0b2006a837551d17998ed84cbf45acc163400f` |
| `capacity-diagnostic-history.json` | `9f1ca296f4356f387a7ce08c5a3421d25cf373d31fe68c85e55e6ac03f5e11f1` |
| `analysis.cpu.pprof` | `5c5438b2dba642bd08fe7f41489bdc9fd45eb0136a548ebdf7ab5f511bf9531f` |

三组使用的同一 Go 二进制 SHA256 为 `b34063a23b43716e377402b7b3e436a84af9bd864079c037b540e9d28c2afee9`。Linux 宿主报告 AMD EPYC 7763，CI 提供 2 CPU；组件基准不施加服务组 cgroup 限制，三个完整路径实验则逐一校验了 1 CPU / 512 MiB 限额。原始记录含镜像摘要与环境信息。

复现时在 `Go core capacity experiment` 工作流选择 `diagnostic`，或按 [工作流命令](../.github/workflows/go-core-capacity.yml) 本地执行。`compare-capacity.mjs --shapes short` / `--shapes history` 分别选择单一输入；省略参数保持原四类混合输入。汇总命令仍为 `node go-core/compat/summarize-capacity.mjs <raw.json> <summary.md>`。后续文档提交不冒写为本次运行提交。
