# 空机安装

这套工具用于在一台新的 Linux 服务器上安装 Auto Model Router，不需要先运行 Node 版本。它使用已经验收的 v0.14.8 三个镜像；安装工具单独交付，不会更改现有生产服务。

适用环境：Linux x86_64、Python 3.9+、Docker Engine 和 Compose v2。当前镜像是 `linux/amd64`，不适用于 ARM 服务器。服务器须能访问自己的 HTTPS MaaS 上游；应用和三个镜像可离线传入，目标机不需要 Git、Node、Go 或 pip 安装依赖。

## 拿到哪些文件

交付包 `amr-fresh-install-0.14.8.zip` 包含：

| 文件 | 用途 |
|---|---|
| `images/` | Go、Node、Python 分类器三个正式镜像归档 |
| `release.json` | 镜像版本、源码提交和哈希依据 |
| `install.py`、`native_compose.py` | 镜像导入、空机初始化、启动、检查和停止 |
| `router.example.json` | 不含生产凭证的业务配置示例 |
| `verify.py` | 使用调用方 key 验证普通请求、SSE 和决策记录 |
| `SHA256SUMS` | 包内文件的校验值 |

解压后进入包目录。先用交付方提供的 ZIP SHA256 核对外层文件，再检查包内文件：

```bash
sha256sum -c SHA256SUMS
python3 --version
docker --version
docker compose version
```

校验失败时先重新取得完整文件，不要继续安装。

## 1. 导入镜像

```bash
sudo python3 install.py load-images
```

工具在导入前检查三个归档，在导入后核对镜像 ID、架构和源码提交。同版本标签若已指向其他镜像，会拒绝覆盖。

## 2. 填写自己的模型配置

```bash
cp router.example.json router.json
```

编辑 `router.json`，将所有 `replace-with-your-model` 替换成上游实际模型 ID，并填写名称、上下文、能力、价格及有依据的质量分。示例中的质量 0.5 和容量等只是占位值，不代表模型实测。只有一个模型时 `routing.maxAttempts` 保持 1；添加模型后再按实际情况设置。

统一入口默认是 `cmtoken-auto`。该安装方式要求 `budget.enabled=false`，业务使用调用方 MaaS key；Node 仍记录费用。示例关闭 Judge、语义复核、自动校准和时延补测，安装阶段不会自动发起这些额外模型调用。接入成功后再根据自己的需要配置、验证和启用。

不要复制其他环境的 `.env`、内部 token 或运行数据。管理与指标凭证由初始化工具为本机生成；业务 key 只在客户端和后面的验收步骤使用。

## 3. 初始化

以下示例中，上游地址应包含该平台实际的 `/v1` 基础路径，不能指回本服务：

```bash
sudo python3 install.py init \
  --config router.json \
  --upstream https://your-maas.example.com/v1 \
  --root /opt/amr
```

`/opt` 必须存在，`/opt/amr` 必须尚不存在。工具生成 Go 快照、匹配的内部凭证、Compose 和数据目录，通过校验后才发布到目标目录。重复执行不会覆盖已有安装。遇到失败先查看提示；不要删除已有业务目录后重试。

默认只监听 `127.0.0.1:8787`，适合由同机反向代理提供 TLS。内网需要直连时可在初始化命令中增加 `--bind <服务器内网IP>`。还可用 `--port 18787 --project amr-team-b --root /opt/amr-team-b` 安装独立实例，各实例需要不同端口、项目名和目录。多个独立实例不自动共享会话或费用状态。

如果上游使用企业私有 CA，增加 `--ca-cert /path/to/company-ca.pem`，工具会为 Node 和 Go 配置该证书；不要关闭 TLS 校验。

初始化后会生成：

```text
/opt/amr/
  compose.json
  installation.json
  credentials.json
  config/
    router.json
    go-runtime.json
    go-auth.json
  data/
```

`credentials.json` 存放新生成的 `ADMIN_TOKEN` 和 `METRICS_TOKEN`，由管理员在服务器上读取并妥善保存；不会在安装输出中显示。Compose 也含内部凭证，权限为 600。不要把这些生成文件发给业务调用方。

## 4. 启动和检查

```bash
sudo python3 install.py start --root /opt/amr
sudo python3 install.py check --root /opt/amr
curl --fail http://127.0.0.1:8787/health/ready
```

启动命令仅使用已导入镜像，不在线拉取；等待三个服务健康，并核对运行镜像。管理页面与业务共用 8787 入口，8788、8789、8791 不映射到宿主机。登录管理页使用本机生成的 `ADMIN_TOKEN`。

如果启动失败，保留安装目录，通过下列命令在服务器本地排查，再重试 `start`。日志可能包含业务信息，不应整份公开：

```bash
sudo docker compose -p amr -f /opt/amr/compose.json logs --tail 100
```

使用自定义 `--project` 时替换这里的 `amr`。

## 5. 验证实际调用

健康检查不等于模型能回答。将一个有效的调用方 MaaS key 单独写入权限为 600 的文件，内容只有 key，不带 `Bearer`。然后执行：

```bash
sudo python3 verify.py --root /opt/amr --key-file /path/to/business.key
```

此步骤会产生两次真实调用和相应费用，分别验证普通 JSON 和流式 SSE，并等待两条对应决策记录恰好一次。结果保存为 `business-verification.json`，不保存 key 或回答正文。它不评判模型回答质量，也不验证后来启用的后台 Judge 或语义复核。

通过后再接入业务客户端：Base URL 填实际服务地址加 `/v1`，模型填 `cmtoken-auto`，key 使用调用方自己的 MaaS key。

## 停止和重启

```bash
sudo python3 install.py stop --root /opt/amr
sudo python3 install.py start --root /opt/amr
```

停止命令先排空 Go，再停止 Node 与分类器，保留配置、凭证和数据。不要用无顺序的整组 `restart` 代替它。

本工具负责新安装和日常启停，不是升级或迁移工具。已有 Node 部署继续使用仓库的 `prepare_native.py`；已有 Go 部署升级前先备份、核对新版本并按生产部署说明操作。当前交付镜像仍为 v0.14.8，镜像内使用手册也保持该发布版本的内容；本文件是空机安装的最新操作入口。
