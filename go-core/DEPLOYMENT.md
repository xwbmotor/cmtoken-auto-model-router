# 独立 Go 容器实验部署

这是本地 mock 验收环境，不是生产部署。Go 以本地 runtime 快照运行，没有请求期 Node 适配器。`productionReady` 保持 `false`，CLI 继续要求 `--lab` 并限制监听与出站为字面量 loopback。

## 组成与运行

需要 Linux Docker Engine、Docker Compose v2、Node.js 24。Windows Docker Desktop 必须启用 Linux 容器；本轮本机没有运行中的 daemon，容器结果以独立 `Go core isolated deployment` CI 为准。

`Dockerfile` 使用 Go 1.27.1 编译静态程序，scratch 镜像携带时区库，以 UID/GID 65532 运行。`compose.lab.yml` 使用 `network_mode: none`，没有端口发布；mock 容器共享 Go 的网络命名空间，所有请求为 `127.0.0.1`。构建需拉取 Go/Node 基础镜像，运行环境没有外网路由。

从仓库根目录执行一次初始化（生成随机测试凭据，不读 `.env`）：

```sh
node go-core/deployment/prepare.mjs
sudo chown -R 65532:65532 data/go-deployment/config data/go-deployment/ledger
bash go-core/deployment/smoke.sh
```

初始化拒绝覆盖已存在的凭据；重复验收直接运行 `smoke.sh`。容器只读挂载 config，ledger 为独立可写目录。勿将真实凭据、生产配置或 Node 账本放入该目录。仓库已有 `data/` 忽略规则，CI 只上传 evidence，不上传 config 或原始账本。

日常命令：

```sh
docker compose -f go-core/compose.lab.yml up -d --build --wait
docker compose -f go-core/compose.lab.yml ps
docker compose -f go-core/compose.lab.yml exec -T gateway /amr-core healthcheck
docker compose -f go-core/compose.lab.yml exec -T mock node /lab/container.mjs check
docker compose -f go-core/compose.lab.yml logs --tail 100
docker compose -f go-core/compose.lab.yml down
```

健康检查只访问容器内 `/health`，禁用代理与重定向，2 秒超时。检查表示 Go 服务与持久化可用，不代表上游模型可用。进程 stdout/stderr 由 Docker json-file 驱动保存并轮转（Go 3 × 10 MB），业务结算审计保存到 `ledger/runtime.wal.events.jsonl`；这不是完整访问日志或指标系统。

## 停机、恢复与备份

Go 收到 SIGTERM 后停止接入并排空最多 10 秒，随后等待结算及后台任务关闭；Compose 给出 20 秒退出宽限。超出宽限会 SIGKILL，应检查容器退出码与 ledger 健康。`unless-stopped` 用于进程异常/宿主重启恢复，显式 stop 后不会自行启动；Docker 的 unhealthy 状态本身不触发重启。

WAL 和审计文件在宿主 bind mount 中持续存在，`down` 不删除。只允许一个 Go 写入进程，文件锁会拒绝并发写者。账本重启恢复，会话和进程健康重新建立。备份时先停止服务，再整体复制 ledger 目录及对应 config；不要复制正在写入的 WAL 当作一致备份。

共享网络命名空间的 mock 在 gateway 重启时必须重建，避免继续持有旧命名空间；`smoke.sh` 已处理此顺序。该脚本验证非流式、SSE `[DONE]`、管理鉴权、真实 mock usage 结算、审计脱敏、正常停机退出码、重启前后账本相等、SIGKILL 后已结算账本恢复及再次请求。SIGKILL 场景只验证已结算账本，未声称覆盖所有在途断电情况。

若 `runtime.json.pending` 存在，表示管理端发布事务尚未确认，应先依据管理桥事务信息核验/恢复，不可通过删除标记或反复重启跳过保护。Go 的保护行为由运行时实现，容器不覆盖它。

## 与现有管理端联调原则

Node 管理端继续处理已有页面、配置校验与保存，`AMR_GO_RUNTIME_CONFIG` 指向共享 runtime 快照路径；管理桥负责原子导出、reload 和读取确认。Node 与 Go 的内部接口必须位于同一 loopback 网络命名空间，快照目录对 Node 可写、对 Go 只读，二者看到相同目录中的原子替换与 pending 标记。仅分享网络名称或把宿主 `127.0.0.1` 当成容器地址不能实现联通。

本 compose 只包含 Go 与 mock，不启动完整 Node 管理服务。联调可把管理进程放入同一受限网络命名空间，或在隔离测试主机使用同机进程模式；不能为图方便把 Go 改为 `0.0.0.0` 或连接生产模型。当前容器环境无浏览器入口，不等同完整管理台上线验收。
Python 分类、训练与评测服务继续保留。本容器 smoke 禁用语义复核，不包含真实 Python 服务、训练或实际模型调用，不能据此宣称已验收 Python 集成。
