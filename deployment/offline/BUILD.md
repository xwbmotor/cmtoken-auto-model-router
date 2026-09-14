# 制作安装包

这份说明供维护人员制作交付包。部署同事直接使用 [发布页](https://github.com/xwbmotor/cmtoken-auto-model-router/releases/tag/v0.14.8)的完整安装包，按 [安装说明](README.md)操作即可。

## 标准安装包

打包机器需要 Python 3.9+ 和仓库源码；目标服务器不需要这些开发工具。取得 `v0.14.8` 发布页中的 `release-images-v0.14.8.zip`，从仓库根目录执行：

```bash
python3 deployment/offline/build_bundle.py \
  --images /path/to/release-images-v0.14.8.zip \
  --out data/distribution/amr-offline-0.14.8
```

输出为 `data/distribution/amr-offline-0.14.8.tar.gz`，包括镜像、脚本、配置和说明。脚本校验正式镜像哈希，默认使用仓库中的 `config/router.json`，不需要连接任何现有服务。输出目录和同名压缩包必须尚不存在。

`--images` 也可以指定已解压的镜像目录。每个归档仍须通过 `release.json` 中的 SHA256 校验，不接受同名但内容不同的镜像。

## 定制配置

使用 `--config /path/to/router.json` 指定另一份业务配置。配置中不能包含凭证，且当前应用版本要求关闭预算保护。部署人员仍需核对中台地址、模型权限、价格和能力。

若配置来自运行中的管理 API，并附有导出证明，可增加 `--provenance /path/to/config-provenance.json`。工具会验证配置哈希及 Go 同步记录；没有提供证明时，记录为交付方指定的配置，不宣称经过线上核验。

业务配置与内部凭证分开处理。安装时生成每台服务器自己的管理和内部 token；调用方 key、Judge 凭证和业务数据不随标准包交付。

## 持续验证

[安装工作流](https://github.com/xwbmotor/cmtoken-auto-model-router/actions/workflows/fresh-install.yml)检查初始化与拒绝覆盖行为，在限制宿主机命令路径的环境中安装三个服务，验证 JSON、SSE、重启与费用记录，再生成标准安装包。成功运行的 Artifacts 区域提供安装包和验收记录。

正式镜像按应用版本管理，安装工具按提交记录。更新说明或安装工具不改写既有应用标签；应用代码变化仍须重新构建和完成正式发布测试。
