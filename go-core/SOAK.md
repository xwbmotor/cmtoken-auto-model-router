# 隔离部署稳定性实验

本阶段在与上一轮一致的无外网 Linux Docker 环境中运行，不连接生产或实际模型；它验证部署形态与持久化的持续稳定性，不替代目标服务器或真实 Python 分类器集成验收。

## 固定协议

Go 配额 2 CPU / 512 MiB；mock 与负载发生器独立容器 2 CPU / 768 MiB。全程 network_mode:none，无端口映射。使用独立随机凭据和全新账本，不读取 .env。Node 发布器通过同一 loopback 网络命名空间和共享快照目录执行热更新。

持续 3,600 秒按固定计划发起 100 RPS；最多 200 个未完成工作，超限或未发起计划均记为 dropped，不隐瞒欠发负载。每100次请求为83个普通JSON、10个短SSE、3个收到首帧后主动取消、2个上游连续503、2个首尝试503后换模型成功；另外每600秒发起一个300秒长SSE，确保流跨越配置热更新。

每60秒发布一次配置并立即核对生效revision，再验证旧If-Match被拒绝。热更新交替改变输入/输出价格为1/2与2/4元每百万Token；mock usage固定为10输入/5输出。客户端按响应配置revision计算每次成功应计20或40微元，以验证长流跨更新仍按原代计费。失败与取消没有最终usage，仍按原有保守估算结算；审计估算总和必须与账本一致。

每30秒采集运行诊断和分场景时延直方图；时延单位向上取整到毫秒，10秒及以上记录在溢出桶（长流另有实际时长）。Docker每约30秒记录CPU与容器内存；Go采样包含heap、goroutines、GC和保留账本条目数。诊断不强制GC，也不是跨组件原子快照。

负载结束后等待38秒，要求activeRequests、inflight、pendingReserves和retired配置代归零，live配置代为1，goroutines不超过基线+16，totalAttempts与mock实际尝试数一致，retainedAttempts缓存不超过attemptCacheLimit=4096。新报告带attemptStorage=bounded-cache-v1；旧报告没有此标记，retainedAttempts当时代表完整历史，分析器分别检查两种口径。内存增长需结合缓存和历史条目分析：本实验不把所有增长判为泄漏，也不把一次有界运行称为长期内存有界证明。

随后带5秒在途SSE执行SIGTERM，必须完成响应并以0退出；逐条流式读取审计，检查无重复attempt、无凭据或原文、实际/估算与账本一致。重启及随后SIGKILL后的已结算账本须与停止前预期相同。SIGKILL发生在空闲，不宣称验证所有在途断电场景。

## 运行

```sh
node go-core/deployment/prepare-soak.mjs
sudo chown -R 65532:65532 data/go-soak/config data/go-soak/ledger
sudo chgrp 65532 data/go-soak/evidence
chmod 2770 data/go-soak/evidence
bash go-core/deployment/soak.sh
```

prepare拒绝覆盖原fixture；每次新实验须使用全新目录/工作区，保留原证据。快速协议检查使用SOAK_SECONDS=60、SOAK_RPS=25、SOAK_LONG_SECONDS=10、SOAK_RELOAD_SECONDS=5。完整CI先通过快速协议，再执行一小时阶段；只有手动dispatch或提交信息包含[soak-hour]时运行长阶段，普通代码推送不自动消耗一小时运行。

原始证据在data/go-soak/evidence：soak-result.json、runtime-samples.jsonl、latency-windows.jsonl、long-streams.jsonl、reloads.jsonl、container-stats.jsonl，以及排空、审计和重启结果。失败写soak-failure.json并保留过程日志，不输出凭据或请求正文。持续时间、请求数和结论必须从实际完成归档读取，不将脚本实现等同实验通过。

完成后运行 `node go-core/deployment/analyze-soak.mjs data/go-soak/evidence`，生成检查结果和时延/内存分析；短跑显式加 `--smoke`。分析失败返回非零退出码。2026-09-10 实际一小时结果见[验收报告](../docs/go-core-soak-results.md)。
