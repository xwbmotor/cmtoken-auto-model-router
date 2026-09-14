# Auto Model Router

Auto Model Router 是放在应用与 MaaS 平台之间的模型路由服务。应用调用一个统一模型名，服务根据请求所需能力、任务类型、质量分、成本、时延和模型可用状态选择上游模型，并记录选择过程。

客户端使用 OpenAI Chat Completions 接口，模型名填 `cmtoken-auto`，也可以省略 `model`。入口名称由 `routing.autoModelId` 配置；若部署方修改了名称，以该部署的 `/v1/models` 为准。

## 安装

下载 [v0.14.8 安装包](https://github.com/xwbmotor/cmtoken-auto-model-router/releases/tag/v0.14.8)，在已有 Docker Engine 和 Compose v2 的 Linux x86_64 服务器上解压：

```bash
tar -xzf amr-offline-0.14.8.tar.gz
cd amr-offline-0.14.8
sha256sum -c SHA256SUMS
sudo bash install.sh load-images
sudo bash install.sh init --root /opt/amr
sudo bash install.sh start --root /opt/amr
sudo bash install.sh check --root /opt/amr
```

`/opt/amr` 必须尚不存在。默认监听 `127.0.0.1:8787`，适合通过同机反向代理访问；需要内网直连时，在初始化命令中增加 `--bind 服务器内网IP`。安装包自带运行镜像，安装过程不访问软件源。

包内配置提供中台接入和模型池，部署前核对其是否适用于自己的环境。管理凭证会为新实例生成；业务使用调用方自己的中台 key。完整步骤、企业 CA、请求验收和启停方法见 [安装说明](deployment/offline/README.md)。已有服务升级见 [部署与运维](docs/Ubuntu生产部署.md)。

## 服务组成

| 服务 | 负责什么 |
|---|---|
| Go | 承接业务入口，执行分类、选模、并发控制、重试和 JSON / SSE 转发 |
| Node | 管理页面、配置校验与发布、决策记录、费用观察、异步质量评审及兼容请求处理 |
| Python 分类器 | 提供小模型任务分类；是否参与请求决策由语义复核策略决定 |

已验收的 Go 生产方式使用 `passthrough` 鉴权，且 `budget.enabled=false`。客户端的 MaaS key 用于上游调用；费用仍由 Node 记录。Go 独立账本、其他鉴权方式和多实例共享状态的实验，不等于已在这套生产部署中启用。

## 能做什么

- 根据模型能力、上下文容量、租户权限和质量要求筛选候选，再比较成本、时延及健康状态。便宜的模型不能绕过这些条件。
- 支持普通 JSON 和流式 SSE 请求，以及工具调用、JSON 输出模式等兼容字段；具体支持范围仍取决于上游模型。
- 遇到可重试的上游故障时按策略重试或选择其他合格模型；鉴权、权限和请求错误不作为盲目换模型的理由。
- 通过管理端查看模型、调整策略、预览变更影响，再发布配置。保存成功后，Node 与 Go 使用对应的新配置。
- 记录决策、语义复核和 Judge 评审结果。Judge 是对回答的抽样评审，不保证每个回答正确，也不会自动把评分写回线上策略。

路由质量取决于模型池、评分来源和真实业务数据。仓库提供离线比较与学习工具，但尚未证明学习策略的生产收益。[评测说明](docs/evaluation-integrity.md)解释了不同测试能支持什么结论。

## 接入示例

以下请求会调用真实上游。`MAAS_KEY` 是调用方的 MaaS 凭证，地址替换为实际服务地址：

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $MAAS_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"cmtoken-auto","messages":[{"role":"user","content":"用一句话解释快速排序"}]}'
```

需要流式输出时增加 `"stream":true`。Python 示例、会话和常见错误见 [使用说明](docs/使用说明.md)。

## 开发与测试

### 开发运行

```bash
npm start
```

Node.js 24 可直接启动管理服务，读取存在的 `.env`，默认监听 `127.0.0.1:8787`。此命令供本地开发，不会启动完整的 Go 和分类器部署。环境变量参考 `.env.example`，Go 检查见 [Go 开发说明](go-core/README.md)。


```bash
npm test
npm run eval:matrix -- --input data/business-matrix.json --out data/business-matrix-report.json
```

`npm test` 是 Node 测试入口；涉及分类器或浏览器的测试还需要相应依赖。Go 检查可在 Windows 执行 `./go-core/verify.ps1`。正式发版另需在干净且精确匹配版本标签的工作区运行 `npm run test:release`，验证镜像提交和零跳过测试；普通本地测试通过不代表正式发布完成。

| 目录 | 内容 |
|---|---|
| `deployment/` | 安装脚本、交付配置、打包工具和安装验收 |
| `go-core/` | Go 请求服务、兼容性测试、容量实验和部署工具 |
| `src/` | Node 管理服务、配置、记录、评审和保留的 Node 请求实现 |
| `public/` | 管理端页面与脚本 |
| `config/` | 路由配置、规则及评测输入；生产配置另行保管 |
| `scripts/`、`tests/` | 训练与评测工具、发布检查、Node 回归测试 |
| `docs/` | 使用、运维、开发说明和历史验证记录 |

## 文档入口

- [文档目录](docs/README.md)：按使用、运维、开发和历史记录查找。
- [使用说明](docs/使用说明.md)：接入和日常使用。
- [MaaS 平台集成](docs/MaaS平台集成部署运营手册.md)：平台分流、凭证和运营。
- [部署说明](docs/Ubuntu生产部署.md) · [反向代理](docs/反代集成.md)：生产运行。
- [路由设计](docs/路由设计说明.md) · [开发交接](docs/开发指南.md)：实现与维护。
- [版本记录](CHANGELOG.md)：各版本的变化及影响。
