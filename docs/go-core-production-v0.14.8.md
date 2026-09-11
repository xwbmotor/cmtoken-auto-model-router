# Go v0.14.8 生产切换验收

截至 2026-09-11T15:28:07.786018+00:00，生产业务入口已由 Go v0.14.8 承接，发布提交为 `90e6e4eb71ff5e323a39caa87e52e1829e77f332`。Node 保留管理、记录、Judge、费用观察和兼容请求处理，Python 分类器继续提供小模型分类。三个服务均健康。

## 已验证结果

- 正式发布：[34614987601](https://github.com/xwbmotor/cmtoken-auto-model-router/actions/runs/34614987601)，干净 `v0.14.8` 标签，432 项成功、0 失败、0 跳过；三个镜像绑定同一发布提交。
- Go 迁移与真实 SIGTERM：[34614959644](https://github.com/xwbmotor/cmtoken-auto-model-router/actions/runs/34614959644)；三服务切换、重启、回滚演练：[34614959598](https://github.com/xwbmotor/cmtoken-auto-model-router/actions/runs/34614959598)。
- 实际生产完成两次非流式和两次 SSE 请求，包含 Go 重启前后；均返回 200，SSE 内容和末尾 DONE 完整。
- 四条决策记录恰好一次，均确认由 Go 成功交付；四条影子语义复核均为 `shadow_complete`。
- 保留原业务配置与环境文件，仅更新配置软件版本；费用文件保留，结算累计继续增加。
- 服务器外部访问 `/health/ready`、`/go-core.js` 返回 200，管理资源包含业务链路状态；`/internal/v1/runtime` 返回 404。

## 重启排空的生产证据

本次 Docker 记录的 SIGTERM 为 `15:26:08.756 UTC`。重启前 SSE 请求的影子复核于 `15:26:10.193 UTC` 完成，Go 随后于 `15:26:10.242 UTC` 以退出码 0 退出。即收到退出信号后仍保留了尚未完成的复核，再完成重启。

v0.14.7 曾在主请求验收通过后发现此后台取消问题，并实际恢复 Node v0.14.5。v0.14.8 修复后，同一受控测试在旧版本复现失败、新版本通过；本页结果为最终状态，不能将早期 v0.14.7 主请求成功记录当作最终上线结论。

## 镜像内容对应

CI 记录配置 JSON 摘要，目标 Docker 显示 OCI 清单摘要。已校验归档总哈希、各镜像归档哈希、清单对配置的哈希引用，以及完整运行配置与 RootFS 一致性。

| 镜像 | CI 配置摘要 | 生产 OCI 清单摘要 |
|---|---|---|
| cmt-auto-model-router:0.14.8 | `sha256:f8f2c0d01b1d68feac6ed194e09c0bee769690de36d5b4d0ad874fb4bc4b393d` | `sha256:0571f87f9eaea31764768db0631c60de5656744731405fe0532bd3f46c63985a` |
| cmt-amr-classifier:0.14.8 | `sha256:df2b34e21b3a4868f1fca6754b9c80b1300300e0ca5b0cee26dc4b72ab4f1116` | `sha256:760fd4263502f6de69cd1f1cd6fd2bbd2a6645a831dc550af74b598dda8592b5` |
| cmt-amr-go:0.14.8 | `sha256:fbb0fa8c72796c8b1ec66fc57fc3d15ba40c1279b23e30b8afbfc38ee6677dcb` | `sha256:564b1906fc7bb69749ac1c6cb9aff97f2e3d23fda179211204cf11bbe5c62bb2` |

## 性能依据及边界

切换前同配额合成对照见 [完整实验记录](go-core-edge.md)。2 CPU / 512 MiB 的两轮 300 RPS 对照中，Node / Go P95 分别为 22.02 / 19.99 ms、22.47 / 20.36 ms；目标服务器 1 CPU / 256 MiB 隔离对照为 233.82 / 153.34 ms、188.16 / 160.90 ms。全部计划请求及对应日志完整。

该性能证据对应连接复用优化后的候选二进制；v0.14.8 后续修复关停与配置换代的后台排空，并完成上述功能与真实请求复验。没有把旧二进制压测写成 v0.14.8 新镜像的容量实测。Go 在这些对照中的额外采样内存约 70–110 MiB，低负载与 SSE 并非始终更快。模拟上游、关闭语义复核/Judge/限流的实验不能证明真实模型质量或生产 SLO。

## 回滚与证据位置

- 本次受保护备份：服务器 `/opt/amr/native-release-0.14.8/rollback/`；保留 Node v0.14.5 原 Compose、环境文件和 router 配置，旧镜像未删除。
- 如需整体停止或回滚，先停止并排空 `go-core`，再停止 `auto-model-router` 和 `classifier`，确保 Node 在 Go 结果回传期间仍可用。恢复原配置时保留当前费用和日志，不导入空的 Go 观察模式 WAL。
- 现有实验容器 `amr-go-candidate-3a8f3388c84f` 保留；正式请求不依赖该实验容器。
- 服务端最终证据：`/opt/amr/native-release-0.14.8/evidence/`；本地验收文件如下。

- `data/go-migration/production-native-0148.json`，SHA256 `c7be00fe2d25682f5299de119323ac0a0ef6d4e1614d46baa0879e9698eaed57`。
- `data/go-migration/production-native-0148-final-check.json`，SHA256 `d2b800d946213eb0b153ba9e7ec3bcab0134cc256f9ba76ca24ffc753624c332`。
- `data/go-migration/production-native-0148-image-map.json`，SHA256 `dda8f5f037f5da8044f79dc8a2e86f77b19f4ce21193b5e3a33102a5082473bf`。
