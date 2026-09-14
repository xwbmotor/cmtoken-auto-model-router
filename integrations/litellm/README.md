# LiteLLM 集成示例

`config.yaml` 演示如何通过 LiteLLM 将 OpenAI 兼容模型连接到 MaaS 上游。它属于可选集成，不是标准三服务安装的必选组件。

配置中的模型名是历史示例，使用前应按实际中台接口更新。上游地址和凭证通过环境变量提供，不写进配置文件。

集成步骤见 [LiteLLM 说明](../../docs/litellm.md)。部署 Auto Model Router 本身请使用 [安装说明](../../deployment/offline/README.md)。
