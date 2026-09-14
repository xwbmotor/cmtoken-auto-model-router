# Ubuntu 生产部署与运维

本文说明 v0.14.8 的 Go 原生入口部署。最近一次生产验收在 2026 年 9 月 11 日完成，见 [上线记录](go-core-production-v0.14.8.md)。执行操作前仍须核对目标服务器的实际版本、配置文件和容器状态。

## 服务与端口

三个服务使用同一发布提交的镜像，共享分类器的网络命名空间。宿主机映射的 8787 由 Go 监听。不要把 Compose 中的端口映射归属误认为分类器处理了业务请求。

| Compose 服务名 | 容器名 | 监听与用途 |
|---|---|---|
| `go-core` | `amr-go-core` | 8787 为业务及管理访问入口；127.0.0.1:8791 为内部接口 |
| `auto-model-router` | `auto-model-router` | 127.0.0.1:8789，管理、配置、结果记录和兼容处理 |
| `classifier` | `amr-classifier` | 8788，小模型分类，不映射到宿主机 |

已验收范围为 `passthrough` 且 `budget.enabled=false`。Node 仍记录费用；不要因为 Go 独立账本测试通过就直接开启生产预算保护或更改鉴权方式。公网接入应配置 TLS，参见 [反向代理](反代集成.md)。

## 部署文件

服务器需要 Docker Engine 和 Compose v2，可访问业务上游。容量应根据自己的并发、输出长度和分类/评审设置验证；历史模拟压测不是服务器配置承诺。

```bash
docker --version
docker compose version
```

正式发布包含 `cmt-auto-model-router`、`cmt-amr-classifier` 和 `cmt-amr-go` 三个镜像。版本标签一致还不够，需核对它们的 OCI revision 与发布提交，并保留正式测试报告。使用正式归档时先验证传输哈希，再 `docker load -i <镜像归档>`。

生产目录使用 `/opt/amr`：

| 文件或目录 | 内容 |
|---|---|
| `.env` | 上游地址、管理与指标凭证等；只给必要账户读取 |
| `docker-compose.prod.yml` | 该服务器实际使用的服务配置，可能由迁移工具生成 |
| `config/router.json` | 业务参数；升级不能用仓库样例覆盖 |
| `config/go-runtime.json` | 由 Node 导出的 Go 运行快照 |
| `config/go-auth.json` | Go 内部鉴权配置 |
| `data/` | 决策、评审、费用及其他运行状态 |

Node 需写入配置和数据，Go 的状态挂载目录需由 UID 1000 写入。凭证、备份和生成后的 Compose 可能含密钥，使用受限权限，不在终端打印完整展开配置，不提交到 Git。

## 新安装与首次 Node 迁移

空服务器使用 [空机安装说明](../deployment/offline/README.md)。独立交付包包含三个已验证镜像、配置模板和安装工具；同中台交付包已预置核对过的业务配置，部署同事导入镜像后执行 `bash install.sh init` 和 `bash install.sh start`，宿主机无需安装 Python 或 Node。初始化不依赖已有 Node 服务，自动生成内部凭证、Go 快照和数据目录，并拒绝覆盖已有路径。

空机工具生成的是 `compose.json`，支持自定义安装目录、项目名和监听端口。下面的日常运维命令以既有 `/opt/amr/docker-compose.prod.yml` 部署为例；新安装优先使用安装工具的 `start`、`check`、`stop`，手工操作时采用 `installation.json` 中记录的项目名和实际文件。

已有 Node 部署首次迁入 Go 仍使用 `go-core/deployment/prepare_native.py`。它核对正在运行的服务、磁盘 Compose、镜像提交和预算设置，保留回滚文件并生成快照，只准备文件、不自动切换。已有部署不要重新运行空机初始化，迁移过程见 [切换验证](go-core-edge.md)。

## 运行检查

以下命令用于已完成安装的部署，工作目录和 Compose 文件以目标服务器为准：

```bash
cd /opt/amr
docker compose --env-file .env -f docker-compose.prod.yml ps
curl --fail http://127.0.0.1:8787/health/ready
docker compose --env-file .env -f docker-compose.prod.yml logs --tail 100 go-core auto-model-router classifier
```

三个服务应健康。`/health` 主要表明进程存活，`/health/ready` 用于检查就绪；两者都不能证明具体模型生成成功。

再用已授权的调用方 key 验证普通 JSON 和 SSE，检查完整输出与结束标记、决策记录是否恰好一次、后台复核是否完成。`/internal/v1/runtime` 不应从公网入口开放。请求示例见 [使用说明](使用说明.md)。

## 重启、升级与回滚

Go 会在后台向 Node 回传结果，所以停止顺序必须是 Go 在前，Node 和分类器在后。不要对整套服务直接执行无顺序的 `restart` 或 `down` 来替代排空。

仅重启 Go：

```bash
cd /opt/amr
docker compose --env-file .env -f docker-compose.prod.yml stop go-core
docker compose --env-file .env -f docker-compose.prod.yml up -d go-core
```

整体停止：

```bash
docker compose --env-file .env -f docker-compose.prod.yml stop go-core
docker compose --env-file .env -f docker-compose.prod.yml stop auto-model-router classifier
```

升级前保存正在使用的 Compose、环境、业务配置和旧镜像，核验新镜像与发布报告，再准备新配置。停止旧服务后应用已核对的文件；重建分类器会改变共享网络命名空间，因此需同时重建依附它的 Node 和 Go：

```bash
docker compose --env-file .env -f docker-compose.prod.yml up -d --force-recreate
```

该命令只用于已经完成备份、按顺序停止并准备好配置的升级。启动后重新检查健康、普通请求、SSE、配置保留、费用和后台记录，不能仅凭容器启动成功结束验收。

回滚也先排空 Go，再恢复已核验的旧 Compose、环境和对应配置。保留升级后产生的费用台账和日志，不回退运行数据。v0.14.8 切换保存的 Node v0.14.5 备份路径及镜像依据见 [上线记录](go-core-production-v0.14.8.md)；其他服务器需使用各自的备份。

## 日志与磁盘

容器日志与业务 JSONL 是两套记录，各有自己的轮转设置。检查磁盘时同时查看 Docker 日志、`data/`、镜像和传输归档。清理前确认文件用途和留存要求；回滚镜像及未归档证据不作为普通临时文件删除。

不要将整个 `data/` 打包对外发送。原文留存开关和运行配置可能与仓库默认值不同，导出时核对实际字段并脱敏。日志种类和指标解释见 [使用说明](使用说明.md)。
