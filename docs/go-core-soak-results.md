# Go 一小时隔离稳定性验收

> 历史阶段记录：下文保留当时的版本、实验条件和待办。“未切换生产”等描述只适用于记录时点；v0.14.8 已完成生产切换，见 [验收记录](go-core-production-v0.14.8.md)。

2026-09-10：固定 100 RPS 的一小时混合负载、配置热更新、在途排空及账本恢复通过，原始证据复核 41 项全部通过。结论仅适用于本次隔离 mock 部署；长期账本历史保留仍未解决，生产未切换。

本文保留旧提交的实测结果。后续已完成[账本缓存有界改造与一小时复验](go-core-bounded-ledger-results.md)：缓存改为最多 4,096 条，完整历史移至派生磁盘索引；磁盘历史压缩仍未实现。

## 实际运行与结果

运行提交：`5962b3e15fb4a932814029d758b6e8c44e9f71a4`。Go 容器配额 2 CPU / 512 MiB，发生器独立容器 2 CPU / 768 MiB；network=none、无端口映射，不调用实际模型或 Python 服务。载荷从北京时间 16:43:01 开始，持续 3,600.003 秒；随后等待 38 秒检查空闲回落，再进行排空与重启。

| 项目 | 实测结果 |
| --- | --- |
| 发起与完成 | 360,006 / 360,006；包含计划内 360,000 次和额外 6 条长 SSE |
| 成功 | 342,006；包括普通 JSON 298,800、短 SSE 36,000、重试成功 7,200、长 SSE 6 |
| 预期失败与取消 | 连续上游 503 后返回预期 502 共 7,200；首帧后主动取消 10,800 |
| 非预期错误 / 漏发 | 0 / 0 |
| 热更新 | 59 次成功；每次旧 If-Match 均拒绝；变更价格按生效 revision 核对 |
| 跨代长流 | 6 条全部完成，实际各约 300.002–300.004 秒；跨更新仍按请求原代计价 |
| 空闲回落 | activeRequests、模型 inflight、pending reserve、retired 配置代均为 0；live 代为 1 |
| 协程 | 基线 9，采样峰值 49，空闲末样本 10 |
| 账本与持久化 | 所有采样 persistenceHealthy=true；负载 actual=10,260,080 微元，与客户端预期一致 |
| 在途 SIGTERM | 额外 SSE 在退出期间完整完成，耗时 5.016 秒，新增 actual 40 微元，进程正常退出 |
| 审计对账 | 374,407 条唯一 attempt；actual=10,260,120、estimated=13,215,392 微元，与排空后账本一致 |
| 恢复 | 正常重启及空闲 SIGKILL 后，账本各字段均与排空后预期一致 |

上述费用由固定 mock usage 和测试价格产生，不是真实模型消费。失败及取消没有最终 usage，按现有保守估算结算。SIGKILL 在空闲时执行，未覆盖所有在途断电窗口。

## 时延与内存解释

每 30 秒统计一个分场景时延直方图，再按窗口起始时间归入十分钟段。下表是这些窗口 P95 的中位数，不能称为十分钟或全场请求 P95。

| 分钟段 | JSON 完成 ms | 重试成功 ms | 短 SSE 完成 ms | 短 SSE 首字节 ms |
| --- | ---: | ---: | ---: | ---: |
| 0–10 | 9 | 10 | 204 | 3 |
| 10–20 | 8 | 10 | 204 | 2 |
| 20–30 | 8 | 10 | 204 | 2 |
| 30–40 | 9 | 10 | 204 | 3 |
| 40–50 | 8 | 10 | 203.5 | 2 |
| 50–60 | 8 | 10 | 204 | 2 |

普通 JSON 各窗口 P95 最大 9 ms、重试最大 14 ms、短 SSE 完成最大 205 ms。该结果包含 mock 的固定等待时间，不代表真实模型延迟。长流超过直方图 10 秒上限，实际时长使用独立长流记录；不能引用其顶格值作为长流 P95。本轮没有 Node 对照，不能据此产生新的 Node/Go 容量优势结论。

| 指标 | 基线或首样本 | 末样本 | 采样峰值 |
| --- | ---: | ---: | ---: |
| Go heapAlloc | 1.50 MiB | 123.84 MiB | 125.70 MiB |
| Go heapInuse | 2.20 MiB | 127.71 MiB | 129.08 MiB |
| Docker stats 内存 | 8.72 MiB | 154.10 MiB | 154.10 MiB |
| retainedAttempts | 0 | 374,406 | 374,406 |

空闲检查时请求资源和退役配置已释放，但历史尝试条目仍然保留。当前 `go-core/internal/ledger/ledger.go` 的 attempts map 保存已完成和释放记录，跨日 rollover 仅重置每日汇总，不清空该 map，启动还会重放 WAL。这解释了持续保留历史的机制；本次观测并未把全部内存增量逐项归因。

采样不强制 GC，heap 与 Docker 内存口径不同。一次一小时及 38 秒空闲不足以证明长期无泄漏或内存有界；生产候选前仍需解决账本历史保留/压缩，并验证幂等、恢复语义和更长时间运行。不能按本次增量简单外推 OOM 时间。

## 可追溯证据与复现

- [一小时及短跑 CI](https://github.com/xwbmotor/cmtoken-auto-model-router/actions/runs/34456318098)：两项成功；正式 artifact `go-core-soak-hour`，ID `10146019426`。
- [Go Linux 回归](https://github.com/xwbmotor/cmtoken-auto-model-router/actions/runs/34456318078)：105 个顶层测试通过，含 race / vet 检查。
- [常规容器验收](https://github.com/xwbmotor/cmtoken-auto-model-router/actions/runs/34456318124)：成功。
- 本地原始归档：`data/go-migration/soak-download-10146019426.zip`；解压与分析：`data/go-migration/soak-hour-34456318098/`。
- `soak-result.json` 保存计数及采样；`runtime-samples.jsonl`、`container-stats.jsonl`、`latency-windows.jsonl`、`reloads.jsonl`、`long-streams.jsonl` 保存过程证据；审计、排空和两次重启分别保留结果 JSON。
- `analysis-result.json` / `.md` 为分析器生成结果，完整列出 41 项检查、各窗口分段统计及解释边界。缺失证据、计数不符或检查失败会返回非零退出码。

```sh
node go-core/deployment/analyze-soak.mjs data/go-migration/soak-hour-34456318098
```

完整运行协议见 [SOAK.md](../go-core/SOAK.md)。短跑必须显式加 `--smoke`，不会作为一小时验收。

本次完成隔离环境稳定性阶段；目标服务器、真实 Python/上游集成和业务灰度仍未验证，不创建生产发布标签或修改生产配置。
