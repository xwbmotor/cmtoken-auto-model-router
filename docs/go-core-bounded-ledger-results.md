# Go 账本缓存有界改造与一小时复验

2026-09-10：已将完整尝试历史从常驻内存移到 WAL 派生的磁盘索引，内存缓存限制为 4,096 条。相同配额和负载协议的一小时隔离复验通过，原始归档复核 44 项全部通过。本轮空闲 Go 堆为 2.58 MiB，上一轮为 123.84 MiB；磁盘历史仍会增长，生产未切换。

## 实现与语义

运行提交：`ef1892b01baacb2c1de66246ebca46387833db5d`（包含 `ba217ce` 的索引实现及后续 ID 边界修复）。没有更改 WAL 格式、预算结算规则或旧 ID 的幂等期限。

- 缓存达到上限后替换 map，旧记录从 `<WAL>.attempt-index` 精确查回；pending、settled、released 均可逐出缓存，逐出不释放预留、不抹掉旧 ID。
- 派生索引使用固定 65,536 个哈希桶头，约 512 KiB 内存；碰撞比较完整 ID，记录校验包含链信息与内容。没有引入 mmap 或新依赖。
- WAL 仍是唯一耐久依据。批次先同步 WAL，再更新派生索引并确认；索引故障阻止后续写入，重新打开时流式重放 WAL、重建索引，缓存仍受限。
- 每批完成后缓存最多 4,096 条；批内可临时多出至多 64 条，诊断读取与写入互斥。`retainedAttempts` 表示缓存，新增 `totalAttempts` 表示完整历史，避免混淆旧版口径。
- 测试复现了无效 UTF-8 ID 经 JSON 替换、逐出后重复预留的边界，现拒绝这类输入；有效 ID 的既有行为保留。

实现和持久化边界见 [ledger README](../go-core/internal/ledger/README.md)。

## 验收结果

Go 容器 2 CPU / 512 MiB，发生器独立容器 2 CPU / 768 MiB；无外网、无端口映射，仅调用 loopback mock。实际载荷 3600.000 秒，随后检查 38 秒空闲回落、在途 SIGTERM 和两次恢复。

| 检查 | 实际结果 |
| --- | --- |
| 发起 / 完成 | 360,006 / 360,006；包含额外 6 条五分钟 SSE |
| 成功 | 342,006：JSON 298,800、短 SSE 36,000、重试成功 7,200、长 SSE 6 |
| 预期失败 / 主动取消 | 7,200 / 10,800，单列统计 |
| 非预期错误 / 漏发 | 0 / 0 |
| 热更新 / 长流 | 59 次成功，陈旧 If-Match 拒绝；6 条长流跨代完成并按原代计价 |
| 历史与缓存 | 总历史 374,406 条，空闲缓存 1,886 条；采样缓存峰值 4,010，所有采样不超过 4,096 |
| 空闲回收 | activeRequests、模型 inflight、pending reserve、retired 配置代均为 0；live 代为 1；协程 9→8 |
| 负载计费 | actual=10,259,900 微元，与客户端逐请求预期一致 |
| 带请求退出 | 额外约 5.05 秒 SSE 在 SIGTERM 期间完成，正常退出，新增 actual 40 微元 |
| 审计 | 374,407 条唯一 attempt；actual=10,259,940、estimated=13,211,856 微元，与排空后账本一致 |
| 正常重启 / 空闲 SIGKILL 后恢复 | 账本字段均与排空后的预期逐项相等 |
| Go 回归 | 112 个顶层测试通过，race / vet 通过；新增 7 项覆盖驱逐、碰撞、故障、跨日、批内顺序和无效 ID |
| 分层差分 | 8,460 项通过；原生特征 3,145、边界 165、选模 3,145、请求语义 1,153、语义复核 852 |

计费数字来自固定 mock usage 与测试价格，不是真实模型消费。强杀在空闲时执行，未覆盖所有在途断电窗口。大批量单元测试为快速制造驱逐会暂禁逐次 fsync、重启前显式同步；耐久性依据同时包括原有 writer/recovery 测试及本轮真实容器运行，不能用灌数测试代替 fsync 证明。

## 内存、时延和代价

下表比较两次相同配额、相同协议的独立 CI 运行。它们不是同机随机交错对照；数字是观察对比，不用于证明所有差异均由此次改动引起。

| 指标 | 旧提交 5962b3e | 本轮 ef1892b |
| --- | ---: | ---: |
| 空闲末样本 Go heapAlloc | 123.84 MiB | 2.58 MiB |
| Go heapAlloc 采样峰值 | 125.70 MiB | 5.51 MiB |
| 空闲末样本 Docker 内存 | 154.10 MiB | 28.08 MiB |
| Docker 内存采样峰值 | 154.10 MiB | 29.14 MiB |
| 内存保留的尝试条数（末样本） | 374,406 | 1,886 |
| 完整历史条数 | 374,406 | 374,406 |
| Docker CPU 采样中位数 | 11.75% | 14.46% |
| GC 次数（末样本） | 830 | 7,725 |

Go 采样没有强制 GC。Docker 内存与 Go heap 口径不同；Docker CPU 的 100% 对应一颗逻辑 CPU，不是两 CPU 配额的 100%。本轮观测到 CPU 和 GC 次数增加，不能把节省内存描述成没有成本。

按十分钟分段，Go heapAlloc 的采样中位数和 JSON 窗口 P95 如下。heap 仅取 load 采样，按采样时间归段；时延先按 30 秒窗口计算 P95，再按窗口起始时间归段求中位数，**不是十分钟全部请求的 P95**。

| 分钟段 | 旧 heap 中位数 MiB | 本轮 heap 中位数 MiB | 旧 JSON 窗口 P95 中位数 ms | 本轮 JSON 窗口 P95 中位数 ms |
| --- | ---: | ---: | ---: | ---: |
| 0–10 | 9.90 | 2.36 | 9 | 10 |
| 10–20 | 27.80 | 2.73 | 8 | 9 |
| 20–30 | 41.39 | 2.42 | 8 | 10 |
| 30–40 | 57.18 | 2.92 | 9 | 10 |
| 40–50 | 107.77 | 2.61 | 8 | 9 |
| 50–60 | 98.93 | 2.54 | 8 | 10 |

本轮重试成功的窗口 P95 中位数为 11–12 ms（上一轮 10 ms），短 SSE 完成为 205 ms（上一轮约 204 ms）。JSON、重试、短 SSE 完成的窗口 P95 最大值分别为 11、15、207 ms；本轮没有继续随十分钟段增长的明显时延趋势，但一次运行不足以排除长时间退化。不能将窗口分位数合并为全场 P95，也不能据本次结果宣称更高生产容量。

负载结束时 WAL 为 163,313,529 字节（155.75 MiB），派生索引为 134,883,368 字节（128.63 MiB），均不含审计文件。缓存上限没有解决磁盘压缩：完整历史、WAL 和索引仍增长，固定桶的查询链长度及重放耗时也未设长期上界。生产候选前仍需考虑磁盘容量、历史压缩及更长时间运行；本轮也未验证真实 Python/上游、目标服务器或业务灰度。

## 证据与复现

- [一小时及短跑 CI](https://github.com/xwbmotor/cmtoken-auto-model-router/actions/runs/34484571731)：两项成功；一小时 artifact `go-core-soak-hour`，ID `10157981921`。
- [Linux Go/race/差分 CI](https://github.com/xwbmotor/cmtoken-auto-model-router/actions/runs/34484571779) 与 [常规容器验收](https://github.com/xwbmotor/cmtoken-auto-model-router/actions/runs/34484571733)：成功。
- 本地原始归档：`data/go-migration/bounded-download-10157981921.zip`；SHA256 `e9bfcdb750cbf73abf0409f45a05514d171c45ba0bd7549a67bebef2b0c84cab`。
- 原始采样、长流、热更新、计费、审计与恢复 JSON：`data/go-migration/bounded-hour-34484571731/`。`analysis-result.json` / `.md` 是本轮分析器复核的 44 项结果。
- Linux 112 项测试与差分归档：`data/go-migration/bounded-linux-34484571779/`；两轮分段对比：`data/go-migration/bounded-comparison.json`，数据来源为两轮 runtime-samples 和 latency-windows。
- [上一轮报告](go-core-soak-results.md) 保留旧实现实测数据；运行协议见 [SOAK.md](../go-core/SOAK.md)。

```sh
node go-core/deployment/analyze-soak.mjs data/go-migration/bounded-hour-34484571731
```

结论是账本缓存已实现有界并通过本轮隔离复验；不等于整个进程长期无泄漏、磁盘无限容量或生产已完成切换。
