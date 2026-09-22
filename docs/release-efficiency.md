# 发布构建与断点传输

## 正式验收证据保留

正式发布工作流将脱敏验收摘要保存为 Release 附件，名称包含版本、运行编号和重试编号。摘要只包含测试计数、源码提交、镜像身份、验证时间与原报告哈希，不包含主机名、配置内容、环境变量或日志正文。失败、跳过、取消、脏工作区及身份不一致的报告不能生成成功摘要。

尚未发布的版本保持草稿状态；已有附件不会覆盖。CI 中的镜像保留7天、完整报告保留14天，Release 摘要不随 CI 保留期到期删除。该摘要证明构建及测试，`deploymentVerified: false` 表示它不代替生产验收；上线结果继续按版本记录在 `docs/go-core-production-*.md`。

构建示例：

```sh
python scripts/build-release-images.py --base-manifest data/deploy-v0.14.3/manifest.json --out data/deploy-v0.14.4/build-proof.json
```

分类器 Dockerfile 未改变、旧镜像配置摘要、OCI revision 和文件系统层均匹配原始发布清单，且本地全部运行输入与旧镜像 `/app` 中锁文件、脚本和模型的文件集合及每一字节一致时，可以直接复用旧镜像文件系统并标记新源码 revision。检查包括新增或移除的文件，拒绝符号链接。发布证明保留每个输入 SHA256、复用来源与构建耗时。

条件不满足则完整构建分类器。`--fresh-classifier` 强制正常构建，适合需要更新基础环境的维护发布。复用不会主动更新基础操作系统或 Python 依赖；是否需要更新由当次维护范围决定。无论是否复用，都必须通过分类器启动实测和正式发布门禁，不能用构建速度代替功能验证。

Docker 缓存是否命中取决于指令与输入、构建器缓存是否可用；`--cache-from` 提供已有镜像作为缓存来源，但不承诺每一层命中。参考 [Docker 官方缓存说明](https://docs.docker.com/build/cache/optimize/)。

分块传输示例：

```sh
python scripts/transfer-release.py --file data/deploy-v0.14.4/image-delta.tar.gz --version 0.14.4 --host root@example.com --identity /path/to/ssh-key
```

固定 2 MiB 块、最多 4 个并行 SCP 连接、单块最多重试 2 次。重新执行会先检查远端完整包和逐块 SHA256，只补缺失或损坏的块，接收端核对文件名、大小、块总量、哈希及目录边界后原子组装。整包已存在且校验通过时直接完成。清理只删除当前计划内的临时块，保留计划与传输结果用于复现。

接收目录限定 `/tmp/amr-up/<version>`。传输工具不加载镜像、不改配置、不启动服务；完成校验后沿用正式部署的备份、配置保留、镜像证明、健康和真实业务验收流程。异常中断后保留的内容寻址分块允许后续恢复，不能只凭文件大小判断成功。
