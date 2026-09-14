# Auto Model Router 安装说明

本文说明如何安装、启动和检查 Auto Model Router。安装包包含三个服务镜像、安装脚本和业务配置。标准包可从 [GitHub 发布页](https://github.com/xwbmotor/cmtoken-auto-model-router/releases/latest)下载。

## 环境要求

- Linux x86_64 服务器，已安装 Docker Engine 和 Docker Compose v2。
- 可使用 Bash、tar、gzip、sha256sum 等常规系统命令。
- 服务器能够访问配置中的中台地址，部署人员具有 sudo 权限。

BigCloud Enterprise Linux For Euler 22.10U2 LTS 的 x86_64 环境可按本指南检查。已验证范围和目标机需要完成的检查见文末验收记录。

## 包里有什么

- 三个正式镜像（版本见 `release.json`）：Go 请求服务、Node 管理服务、Python 分类器。
- `install.sh`：导入、初始化、启停、检查和请求验收入口。
- `worker.mjs`、`compose.template.json`、`release.json`：镜像内初始化逻辑及发布信息。
- `router.json`：中台地址、模型池、价格、能力和业务策略。标准包使用仓库配置；定制包可以使用经过核对的环境配置，部署前确认适用范围。
- `config-provenance.json`：配置来源与校验值；使用现网导出时另记录导出时间和 Go 同步结果。
- `SHA256SUMS`：包内文件校验值。

本包不携带现网管理 key、Judge 独立凭证、业务日志或费用台账。初始化会生成新的管理、指标和内部凭证。Judge 的开关与其他业务策略保留，但独立评审凭证要由新环境管理员另行配置；业务调用使用对方自己的中台 key。

## 1. 上传和解压

将 `amr-offline-0.14.8.tar.gz` 上传到服务器，然后解压并检查包内文件：

```bash
tar -xzf amr-offline-0.14.8.tar.gz
cd amr-offline-0.14.8
sha256sum -c SHA256SUMS
```

校验必须全部通过。解压目录也保留在服务器上，后续启停使用其中的脚本。

## 2. 导入镜像

```bash
sudo bash install.sh load-images
```

工具检查归档、镜像 ID、源码提交和架构。同名版本如果已指向其他镜像，会拒绝覆盖。该步骤不启动服务。

## 3. 初始化

同机通过反向代理接入，保持默认监听地址：

```bash
sudo bash install.sh init --root /opt/amr
```

如果需要其他机器通过内网 IP 直接访问，在初始化时指定服务器自己的内网 IP：

```bash
sudo bash install.sh init --root /opt/amr --bind 10.0.0.10 --port 8787
```

以上两条选一条执行，不要把示例 IP 原样照搬。`/opt/amr` 必须尚不存在；已有目录会拒绝覆盖，不要删除原业务目录后重试。父目录 `/opt` 应已存在。

如中台使用企业私有 CA，增加 `--ca-cert /path/to/company-ca.pem`，不需要关闭 TLS 校验。另装独立实例时可以指定不同的 `--root`、`--project` 和 `--port`。

初始化会生成 `compose.json`、`installation.json`、`credentials.json`、Go 配置和数据目录。管理凭证在 `/opt/amr/credentials.json`，只供本机管理员读取；Compose 也包含内部凭证，不要外发。安装不会启动业务请求。

## 4. 启动和检查

```bash
sudo bash install.sh start --root /opt/amr
sudo bash install.sh check --root /opt/amr
```

三个服务应显示 healthy，运行镜像与正式记录一致。浏览器访问 `http://服务器IP:8787/`，使用新生成的 `ADMIN_TOKEN` 登录。默认只监听本机时，应通过同机反向代理或 SSH 隧道访问。

直连内网需要按运维规则允许客户端访问 TCP 8787。8788、8789 和 8791 是内部端口，不需要放行到宿主机外。若服务无法读取挂载目录，需检查本机权限与 SELinux 策略，不要直接关闭安全机制。

## 5. 验证中台调用

将对方自己的中台 key 保存到服务器上的独立文件，例如 `/root/maas.key`，内容只有一行 key，不带 `Bearer`，并设置权限：

```bash
sudo chmod 600 /root/maas.key
sudo bash install.sh verify --root /opt/amr --key-file /root/maas.key
```

验收发起两次业务请求，分别检查普通 JSON 和完整 SSE，并核对对应决策记录恰好一次。按保留的策略，语义复核等后台步骤可能产生额外调用和费用。不要使用管理登录 key 代替中台 key。

结果保存到 `/opt/amr/business-verification.json`，不含 key 或回答正文。业务验收成功不等于模型质量或后台评审已验证；Judge 需要另行配置并检查。

通过后给业务方的接入参数是：Base URL 为实际服务地址加 `/v1`，模型为 `cmtoken-auto`，API key 为业务方自己的中台 key。

## 日常启停与排障

```bash
sudo bash install.sh stop --root /opt/amr
sudo bash install.sh start --root /opt/amr
```

停止时先排空 Go，再关闭 Node 和分类器，保留配置、凭证和费用记录。查看本机日志：

```bash
sudo docker compose -p amr -f /opt/amr/compose.json logs --tail 100
```

如果安装时改了项目名或目录，替换对应值。日志可能含业务内容，仅在本地排查并按需脱敏。

本工具只负责新安装及日常启停。现有实例升级应走备份、版本核验和回滚流程，不应重新执行 init。应用版本由安装包内的发布信息确定，空机操作以本文件为准。

## 验收记录

2026 年 9 月 14 日的 [隔离安装验收](https://github.com/xwbmotor/cmtoken-auto-model-router/actions/runs/34814816190)已通过。测试从宿主机 PATH 移除了 Python 和 Node，使用本包 Shell 入口加载三个正式镜像；初始化容器禁用网络，完成普通/SSE 共 4 次业务请求、重复安装拒绝、错误输入清理和重启后的凭证与费用保留。测试使用模拟 HTTPS 中台，不能替代对方真实网络和 key 的验收。

配置来源见包内 `config-provenance.json`。`repository-config` 表示仓库配置，`supplied-config` 表示交付方指定的配置，`running-admin-api` 表示经过运行状态核对的导出。初始化只调整本机分类器的内部地址，保留业务策略；来源记录不代替目标环境验收。
