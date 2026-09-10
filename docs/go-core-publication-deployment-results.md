# Go 配置发布与独立部署验收结果

2026-09-10：配置发布闭环和独立容器实验部署已完成。管理台可将已保存配置自动导出到 Go 快照、热更新并核对生效版本；容器已通过健康、HTTP/SSE、结算、正常停止与重启、SIGKILL 后已结算账本恢复。生产未切换，版本仍为迁移分支的 0.14.5，不创建生产发布标签。

## 实现与使用

- [配置发布操作](../go-core/PUBLICATION.md)：启用 AMR_GO_RUNTIME_CONFIG，先保存，再点击“发布已保存配置到 Go”；显示保存与生效版本是否一致。
- [容器部署操作](../go-core/DEPLOYMENT.md)：独立 Dockerfile、compose、随机本地 mock 凭据、健康检查、持久化目录、日志轮转与停止恢复流程。
- 发布拒绝时按实际生效代恢复旧快照；不确定结果先读取核对，保留 pending 事务记录。Go 启动拒绝未决快照；Go 停止时可用离线恢复命令恢复上一快照。
- 投影代码移入 src/go-runtime，Node 镜像自带管理发布所需模块；旧 compat 导出路径继续兼容。没有新增请求期 Node 依赖。

## 验证证据

实现提交：`dbf16ff74f4a323b326e19786442e73c085183e8`。后续变更仅更新浏览器验收脚本定位方式和本说明，不改变运行逻辑。

| 检查 | 实际结果 |
| --- | --- |
| Go 本地检查与 Linux race | 103 个顶层测试通过，vet 与竞态检查通过 |
| Node/Go 分层差分 | 8,460 项通过：原生特征 3,145、边界 165、其余选模/分析/语义 5,150 |
| 发布保护 | 陈旧版本、源配置损坏、明确拒绝、响应丢失、中断恢复、串行并发通过；未决快照阻止 Go 启动 |
| 真实 Go 快照发布 | 无适配器请求依赖；管理发布、凭据轮换、SSE、重启账本恢复通过 |
| 真实 Node 管理接口 | cookie 登录、未授权拒绝、保存后未同步、发布后同步、陈旧版本拒绝、坏配置保留原代通过 |
| 实际浏览器 | Chromium 桌面 1440×1000、移动端 390×844；保存/生效状态、发布按钮通过，pageErrors 为空；截图已视觉核对 |
| 容器 | Linux CI 实际构建运行；network=none、0 端口映射，正常停机退出码 0，重启和 SIGKILL 后已结算账本相同 |
| 容器结算与日志 | 首批非流式+SSE 结算 40 微元，重启后保持 40，再请求后 80；无 pending reserve；账本及审计不含测试密钥/正文 |
| Node 完整回归及复验 | 首轮 410 项中 406 通过、4 失败；3 个浏览器用例因沙箱 spawn EPERM，另一个本地 flywheel 用例返回 502。四项定向复验均通过，未修改产品逻辑；不把首轮称为零失败，也未确认偶发 502 根因 |
| 离线恢复工具 | 临时目录实际执行恢复、核对旧快照与 pending 清除通过 |

Linux 运行记录：[Go 回归](https://github.com/xwbmotor/cmtoken-auto-model-router/actions/runs/34452318459)；[隔离容器验收](https://github.com/xwbmotor/cmtoken-auto-model-router/actions/runs/34452318489)。两项均成功。

本地复现证据：

- `data/go-migration/publication-linux-evidence/`：Linux race 日志、差分报告、管理端与 Go 快照运行报告；原始归档 `publication-download-10142098606.zip`。
- `data/go-migration/publication-container-evidence/`：HTTP、SSE、停止/强杀前后账本、隔离设置和审计脱敏结果；原始归档 `publication-download-10142062773.zip`。
- `data/go-migration/publication-verify.log`、`publication-node-tests.log`、`publication-browser-tests.log`、`publication-recheck.log`、`publication-admin-smoke.log`：本地检查和失败复验记录。
- `data/go-migration/publication-ui.json` 与 `data/go-migration/ui/go-core-*.png`、`go-core-ui.json`：本轮浏览器和真实管理请求结果（2026-09-10）。

## 尚未验证的范围

没有进行生产发布、目标服务器安装或业务流量切换。Docker 在 Linux CI 中实际运行并验收，本机 Docker daemon 未启动；没有将 mock 容器环境称为目标环境部署完成。Node 管理页面、Python 分类/训练/评测继续保留；本容器只包含 Go 与 mock，不包含完整 Node 管理服务或真实 Python 服务。管理发布在同机真实 Node/Go 进程中独立验证。

一小时混合负载、长 SSE 与取消、持续内存/并发泄漏、目标环境 Python 集成及灰度仍属于下一阶段。本轮短时冒烟不产生新的容量或 P95 性能结论。
