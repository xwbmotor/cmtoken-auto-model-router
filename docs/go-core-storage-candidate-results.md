# Go 存储收尾与目标服务器定向验收

2026-09-11：完成成本观察模式的有界存储、审计轮转、恢复验证和目标服务器真实联调。独立候选实例已运行，定向测试请求通过；现有 Node 8787 业务入口、生产配置和 Python 服务保持原状。没有把两条测试请求称为普通用户流量百分比灰度或容量验收。

## 已实现

- 预算保护功能保留，仓库与线上均关闭。用户凭据透传到算力豆所属上游；auto 只统计调用成本，不维护另一套用户余额。本阶段不新增数据库。
- 预算关闭时使用独立成本观察状态：每4096事件保存聚合检查点、压缩WAL并重建索引；保留未决调用和最近窗口ID。崩溃临时文件使用固定路径，重复重启不会不断产生临时文件。未知执行状态不自动退款；未决条数上限20000。
- 观察模式和保护模式隔离，拒绝热切换或隐式覆盖旧账本。保护模式仍保留完整历史、仍有历史增长边界；当前不启用。
- 审计默认16MiB分段、8个归档、7天保留，含空闲维护。默认正常本地审计上限约144MiB；旧超大日志及时间语义见操作文档。已提供日志平台采集路径与去重口径，未配置外部采集目的地。
- 候选模式支持显式HTTPS上游、TLS根证书；监听仍为loopback，无宿主端口映射。L3使用本次有效上游凭据，strict映射与passthrough、同步与后台复核、并发用户隔离均有测试；实验模式的独立分类凭据合同保留。

代码和镜像对应提交：`3a8f3388c84f73eb04c12e3d174989225a2da30d`，迁移分支 `codex/go-core-migration`。现有生产 Node/Python 仍为 `v0.14.5`、提交 `1aa23e49646b8d7e9604707be1c740091687f092`；不创建伪装成正式生产替换的版本标签。

## 验证证据

| 检查 | 实际结果 |
| --- | --- |
| Go 本地与Linux检查 | 137个顶层测试通过；Linux vet和race通过，失败0 |
| Node/Go分层差分 | 8460项无差异：选模3145、原生特征3145、边界165、分析1153、语义852 |
| 有界存储/故障测试 | 14000+事件跨多次检查点；测试固定工作负载的WAL、索引、检查点各小于4MiB；聚合恢复、跨日未决、近期重复结算、检查点先落盘而WAL未截断、残留临时文件、校验损坏/文件冲突均覆盖。4MiB是该测试规模下结果，不是所有输入的全局上限 |
| 审计测试 | 轮转、过期、空闲维护、损坏尾行、中断双链接恢复及失败拒绝确认通过；Linux验证覆盖hardlink和目录同步路径 |
| 隔离容器 | 正常退出、重启、SIGKILL后已结算账本恢复通过 |
| 本轮短时稳定性 | 60秒×25RPS，1503个实际请求含额外长流；1428成功、30预期失败、45取消，非预期错误0、发压丢弃0；不作为新的一小时结果或生产SLO结论 |
| 目标服务器Node控制模块 | 从当前生产配置副本生成快照，通过实际发布桥确认生效revision，无pending发布事务；不是修改现有生产管理UI |
| 目标服务器Python | 实际调用当前分类容器/classify，HTTP200、分类字段合同通过 |
| 真实回答 | 非流式和完整SSE各1条，均HTTP200、正文及usage存在，SSE保留[DONE]，选择qwen36-35b |
| 实际上游尝试 | 2条回答+2条后台L3分类；回答审计requestId与响应一致，无额外回答重试，审计不含测试正文和凭据 |
| 目标服务器恢复 | 等待在途清零后，正常停止退出0；重启和SIGKILL后再启动，聚合账本一致 |
| 隔离与保全 | 候选healthy、只读根文件系统、UID65532、2CPU/512MiB、无宿主端口；原Node/Python镜像和生产配置hash不变且健康 |

最终提交的CI：[Go回归](https://github.com/xwbmotor/cmtoken-auto-model-router/actions/runs/34555463372)、[隔离容器](https://github.com/xwbmotor/cmtoken-auto-model-router/actions/runs/34555463381)、[短时稳定性](https://github.com/xwbmotor/cmtoken-auto-model-router/actions/runs/34555463394)，均成功。

目标服务器验收时间 UTC `2026-09-11T02:44:09`—`02:44:15`。观察成本1084微元（回答44、分类1040），按返回usage及配置价格计算，未与供应商账单或用户实际算力豆扣减对账。

## 运行与回滚

- 候选容器：`amr-go-candidate-3a8f3388c84f`；镜像 `cmt-amr-go:3a8f3388c84f`。
- 镜像ID：`sha256:f0376ba4763ce40090a12b2971c608d1f051370d2b235bf9edcef958ee6e56c1`。
- Linux二进制SHA256：`8867fe247b9389eb742f21c9a5290127dbb14aa8e20aee28d75d21aa5f0d8ad9`；Go1.27.1、linux/amd64、CGO关闭。构建输入、源码归档hash和服务器CA hash均保留。
- 服务器目录：`/opt/amr/go-candidate/3a8f3388c84f`，状态/配置均独立。预算保护保持关闭。
- 停止/回滚：在服务器执行 `python3 /opt/amr/go-candidate/3a8f3388c84f/source/go-core/deployment/candidate.py --root /opt/amr/go-candidate/3a8f3388c84f --image cmt-amr-go:3a8f3388c84f --revision 3a8f3388c84f73eb04c12e3d174989225a2da30d stop`。保留候选目录证据与状态，原业务服务无需切回。
- 候选不自动重启；Python容器若重建，需要重建候选的共享网络命名空间。普通业务入口仍由原Node处理。

本地证据：`data/go-migration/candidate-3a8f3388c84f/`，含live-evidence、linux-evidence、container-evidence、soak-evidence、image-proof.json和build-inputs.json。原始CI归档保留为 `candidate-artifact-10182436250.zip`、`candidate-artifact-10182400389.zip`、`candidate-artifact-10182443181.zip`。本地完整回归日志为 `data/go-migration/storage-final-verify.log`。

操作细节见[候选与存储说明](../go-core/CANDIDATE.md)。下一阶段才是选定业务范围、确定目标负载/SLO并接管实际用户入口；本轮不宣称已完成普通业务切流、外部日志平台接入或算力豆账务对账。
