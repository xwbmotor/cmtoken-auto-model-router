# 零依赖 Node 服务：无需 npm install，单阶段即可；slim(glibc) 对企业内网 DNS 兼容性最好
FROM node:24-slim

# 十一审建议：OCI label 绑定源码 commit——云端可 docker inspect 验证「运行镜像确实对应
# 源码版本」。build 时 --build-arg GIT_REVISION=$(git rev-parse HEAD)；缺省 unknown。
ARG GIT_REVISION=unknown
LABEL org.opencontainers.image.revision="${GIT_REVISION}" \
      org.opencontainers.image.title="cmt-auto-model-router" \
      org.opencontainers.image.licenses="MIT"

# 生产运行环境标识（app 层默认 info 级日志）
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787

WORKDIR /app

# 非 root 运行（node 镜像自带 node 用户 uid=1000）
COPY --chown=node:node src/ ./src/
COPY --chown=node:node public/ ./public/
COPY --chown=node:node docs/ ./docs/
COPY --chown=node:node package.json README.md ./
# config 作为无挂载启动时的兜底；生产用 compose 卷覆盖
COPY --chown=node:node config/router.json ./config/router.json

RUN mkdir -p /app/data /app/config/history && chown -R node:node /app/data /app/config
USER node

# healthcheck 不依赖 curl/wget（slim 镜像没有），用 node 内置 fetch
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

EXPOSE 8787

# SIGTERM 触发优雅排空（默认 20s，需容器 stop_grace_period > SHUTDOWN_TIMEOUT_MS）
STOPSIGNAL SIGTERM
CMD ["node", "src/server.mjs"]
