# 隔离运行诊断

已鉴权 `GET /internal/v1/runtime` 的 `diagnostics` 供隔离稳定性测试每 30 秒采样，仍要求管理凭据且 `Cache-Control: no-store`。没有新增 pprof、强制 GC 或公开端点。

- `process.scope="process"`、`pid`：其余 process 字段属于整个 Go 进程；`goroutines`、`heapAllocBytes`、`heapInuseBytes`、`heapObjects`、`numGC` 分别来自 Go runtime 当前协程数和 MemStats。堆分配并非 RSS，也并非强制 GC 后的存活堆；重启后计数重新开始。
- `runtime.activeRequests` / `requestCapacity`：跨配置代共享的已接纳请求数 / 上限，包含内部 decide，排除管理读取和 health。`costStateMode` 区分 `protected` 与 `observation`。保护模式下，`retainedAttempts` 是当前内存缓存条数，`attemptCacheLimit` 为 4096，`totalAttempts` 为完整幂等历史条数；观察模式下，三者表示保留记录数/保留窗口上界，`totalAttempts` 不再表示累计调用量，历史成本看 ledger 聚合。旧记录逐出缓存后仍可从派生磁盘索引精确查回，不改变结算和幂等语义。历史版本没有后两字段，曾将完整历史保存在内存；跨版本分析须区分口径。
- `generations.live` / `retired`：被管理运行时持有的配置代数 / 已退休且仍在处理请求的代数。`activeHandlers` 包含所有配置代的 HTTP handler 引用及当前采样本身（单次空闲采样为 1）。`revision` 是读取代统计时的当前生效代，可与响应头的此次请求代在并发发布时不同。

这些是分别加锁/读取的低频诊断值，MemStats、协程数、请求槽位、账本和配置代之间不是同一个原子快照。空闲复核关注 `activeRequests=0`、原有 `inflight` 全 0、`ledger.pendingReserves=0`、`live=1`、`retired=0`；内存结合 GC 次数、保留历史、时间趋势解释。`live/retired` 反映配置代引用，不保证退役代的 Close 已完成；进程协程空闲回落需观察后续样本。
