# v0.11.14 累计口径与计数器持久化（2026-09-02）

用户反馈：管理台「总请求」重启即清零（容器重建丢内存），希望累计口径跨发版持久化。

## 改动

`src/server.mjs`：`counters` 对象加 JSON 落盘+启动恢复（500ms 批量合并原子写，与 budget-ledger 同模式）。磁盘只存累计聚合值；`startedAt`/`health`/`recent` 不入盘（这些是 ephemeral 状态）。路径：`process.env.AMR_COUNTERS_PATH` || `./data/counters.json`。

14 个递增点显式挂 `scheduleCountersWrite()`：total/auto/explicit/success/failures/fallback/errors/selected/selectedBy/suggested/task/outcome（×2）。

## 中途两个 ESM 坑

1. **未导入 `mkdir`/`writeFile`**：只 import 了 `readFile`，代码里却用裸名——运行时直接报 `mkdir is not defined`。**所有 catch 都被吞**（空 catch），上线后才暴露。教训：原子写必须显式 import，且 catch 一律 log（哪怕 `.warn(...)`）。
2. **heredoc `\\n` 塌陷成真换行**（本会话第 3 次）：所有含转义的 JS 字符串写盘后必 `node --check`；或干脆用 `String.fromCharCode(10)` 绕过。

## 隐藏回归：e2e 测试被落盘数据污染

**改计数器持久化立刻踩了「修点不修类」的老坑**——修了一处（生产 counters 累计），污染面却跨了所有 spawn server 的 e2e 测试。原因链：

- e2e 测试 `spawn(process.execPath, ['src/server.mjs'])` 不传 `AMR_COUNTERS_PATH` → 默认 `./data/counters.json`
- 第一个测试跑完落盘 success=1，下次进程启动恢复
- 第二个测试断言 success=0 失败——实际拿到 N（被恢复数据污染）
- 具体表现：disconnect 测试拿 success=21（前面所有调用累计）

**修复**：所有 spawn server 的 e2e 测试补 `AMR_COUNTERS_PATH: join(dataDir, 'counters.json')`（与 guardStatePath 隔离一致）。固化进模板：测试里 spawn server 的同时必传 `AMR_COUNTERS_PATH` 指向临时目录。

**普适版**：任何「把 X 改成持久化/累计」的修改，**第一件事**：grep 全仓 `spawn.*server.mjs`，看哪些 spawn 没指定 X 的路径 env，逐一补齐。否则串行测试间互相污染会导致「单跑全绿、全量挂」的」假 flake。

## 已固化断言（ui-regression）

`nameWidths ≥ 10px`（v0.11.11），「自启动日期 + 累计口径跨发版持久化」文案（v0.11.14）。

## 验证

新黑盒 `tests/itl-counters-persist.test.mjs`：5 次调用 → 落盘 → kill 重启 → 断言 total≥5 ✓。

## Docker daemon 卡死：部署流程备选

部署到云端时，本地 `docker build` 卡死（`docker ps`/`docker images`/`docker info` 全 timeout，Docker Desktop 进程在但 socket 不响应）→ 进死胡同。

**绕路方案**（已写好脚本 `amr-1114-cloudbuild.sh` 待验证）：云端 `/opt/amr` 镜像内 dockerfile build——但云端不是 git 仓库，**得先 scp 仓库源码 + 云端 build**（失败了一次，云端没有 .git 目录）。

**实际更可行的备选**：等用户手动重启 Docker Desktop；或跳过本地 build，scp 仓库 + 云端 `git init + git remote add + git pull` + 云端 docker build（云端有 docker.io 不可达问题：见 release-and-deploy 流程约束）。

**教训沉淀**：发版流水线里加一步「本机 docker daemon 健康检查」——`docker ps --max-time 10`（或 `info`）必须在 build 前出 200，否则立刻切云端构建路径，不能干等到 build 超时才发现**。这条还没写入 release-and-deploy reference，待补充。

## 二十八审状态

v0.11.13 后台跑，结论已知包含 DNS rebinding TOCTOU/网段完整度/删除多行 index 错位/引导面板 XSS 等审查点。等二十八审自动退出（或 30 分钟主动 poll）后报告用户。