# CI证据归档调整与验证

此前安装与Go回归检查通过后，仍因Actions附件存储配额耗尽而在报告上传步骤失败。本次将这部分证据改为Release归档，不增加付费额度，不忽略归档失败，也不改变生产应用。

## 调整结果

正式标签验证的原始报告保存在对应版本Release。受信任分支的安装、Go、容器、容量和稳定性证据保存到每月一个`ci-evidence-YYYY-MM`预发布Release；该归档不是应用版本，不作为latest。PR检查保留运行日志及摘要，不向Release写入原始证据。

每份归档包含被测试源码提交、工作流提交、运行编号、重试编号、测试状态和逐文件SHA256。上传后核对远端摘要；同名不同内容仍拒绝覆盖。测试失败时归档成功也不会把工作流变成成功。首次并发创建归档Release时遇到的可见性延迟已修复：创建最多一次，后续只做有上限的查询等待。

## 实际验证

主要改动为`46aed8d`，并发创建修复为`5af158e`。本地12项针对性测试通过。以下实际CI均通过：

- [附件及归档保护](https://github.com/xwbmotor/cmtoken-auto-model-router/actions/runs/36598808483)
- [空机安装、普通/SSE请求和重启](https://github.com/xwbmotor/cmtoken-auto-model-router/actions/runs/36598908337)
- [Go差分、竞态及Node/浏览器回归](https://github.com/xwbmotor/cmtoken-auto-model-router/actions/runs/36598808764)
- [隔离容器部署](https://github.com/xwbmotor/cmtoken-auto-model-router/actions/runs/36597947487)

[月度证据归档](https://github.com/xwbmotor/cmtoken-auto-model-router/releases/tag/ci-evidence-2026-09)已实际下载核对：容器证据16个文件、最终安装证据1个文件、最终Go证据26个文件，归档摘要和内部逐文件摘要均匹配。首次空机归档失败记录仍保留，没有以重跑覆盖历史结论。

本次未重新执行正式镜像构建、容量实验或一小时稳定性实验；这些工作流的归档步骤已切换到相同工具，未声称其测试重新运行。最新应用Release仍为v0.14.10，生产配置和服务未改动。

账户原有存储额度与账单未修改；本次解决的是这些流水线对Actions附件存储额度的依赖。本地检查记录与下载归档位于`data/archive-migration-20260930/`，后续操作见[发布与证据说明](release-efficiency.md)。
