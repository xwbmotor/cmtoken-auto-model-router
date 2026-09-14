#!/usr/bin/env bash
set -euo pipefail
bundle=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
action=${1:-help}
if [[ $# -gt 0 ]]; then shift; fi
root=/opt/amr
project=amr
bind=127.0.0.1
port=8787
config="$bundle/router.json"
ca=''
key=''
version=0.14.8
revision=90e6e4eb71ff5e323a39caa87e52e1829e77f332
node_image="cmt-auto-model-router:$version"
stage=''
inspection=''
fail() { printf '%s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'HELP'
用法：sudo bash install.sh load-images|init|start|check|stop|verify [选项]
  --root /opt/amr          新安装目录（init 时必须不存在）
  --project amr           独立 Compose 项目名
  --bind 127.0.0.1        监听 IP；内网访问填写服务器内网 IP
  --port 8787             宿主机端口
  --config /path/file     默认使用包内已配置的 router.json
  --ca-cert /path/ca.pem  企业 HTTPS 上游的 CA 证书（可选）
  --key-file /path/key    verify 的调用方 key 文件，会发起两次真实调用
不需要宿主机 Python、Node、Go，也不下载或安装软件依赖。
HELP
}
while [[ $# -gt 0 ]]; do
  [[ $# -ge 2 ]] || fail '选项缺少值。'
  case "$1" in
    --root) root=$2;; --project) project=$2;; --bind) bind=$2;; --port) port=$2;;
    --config) config=$2;; --ca-cert) ca=$2;; --key-file) key=$2;; *) fail "未知选项：$1";;
  esac
  shift 2
done
if [[ "$action" == help || "$action" == --help ]]; then usage; exit 0; fi
case "$action" in load-images|init|start|check|stop|verify) ;; *) usage; exit 1;; esac
[[ $(id -u) == 0 ]] || fail '请在 Linux 宿主机上通过 sudo 运行。'
[[ $(uname -m) == x86_64 ]] || fail '本包仅支持 Linux x86_64。'
command -v docker >/dev/null || fail '需要已安装 Docker Engine。'
docker info >/dev/null 2>&1 || fail 'Docker 服务不可用。'
case $(docker info --format '{{.Architecture}}') in x86_64|amd64) ;; *) fail 'Docker 服务端必须为 amd64。';; esac
case $(docker compose version --short) in v[2-9].*|[2-9].*) ;; *) fail '需要 Docker Compose v2 或以上。';; esac
check_image() {
  local name=$1 id label platform
  id=$(docker image inspect "$name:$version" --format '{{.Id}}') || return 1
  case "$name:$id" in
    cmt-auto-model-router:sha256:f8f2c0d01b1d68feac6ed194e09c0bee769690de36d5b4d0ad874fb4bc4b393d|\
    cmt-auto-model-router:sha256:0571f87f9eaea31764768db0631c60de5656744731405fe0532bd3f46c63985a|\
    cmt-amr-classifier:sha256:df2b34e21b3a4868f1fca6754b9c80b1300300e0ca5b0cee26dc4b72ab4f1116|\
    cmt-amr-classifier:sha256:760fd4263502f6de69cd1f1cd6fd2bbd2a6645a831dc550af74b598dda8592b5|\
    cmt-amr-go:sha256:fbb0fa8c72796c8b1ec66fc57fc3d15ba40c1279b23e30b8afbfc38ee6677dcb|\
    cmt-amr-go:sha256:564b1906fc7bb69749ac1c6cb9aff97f2e3d23fda179211204cf11bbe5c62bb2) ;;
    *) fail "镜像 ID 不符合发布记录：$name";;
  esac
  label=$(docker image inspect "$name:$version" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
  platform=$(docker image inspect "$name:$version" --format '{{.Os}}/{{.Architecture}}')
  [[ "$label" == "$revision" && "$platform" == linux/amd64 ]] || fail "镜像提交或架构不匹配：$name"
}
if [[ "$action" == load-images ]]; then
  (cd "$bundle" && sha256sum -c SHA256SUMS) || fail '包内文件校验失败。'
  for name in cmt-auto-model-router cmt-amr-classifier cmt-amr-go; do
    if docker image inspect "$name:$version" >/dev/null 2>&1; then check_image "$name"; fi
  done
  for name in cmt-auto-model-router cmt-amr-classifier cmt-amr-go; do
    docker load -i "$bundle/images/$name-$version.tar.gz" >/dev/null
    check_image "$name"
  done
  printf '三个正式镜像已导入并核验。\n'; exit 0
fi
root=${root%/}
[[ "$root" =~ ^/[a-zA-Z0-9_./-]+$ && "$root" != / ]] || fail '安装目录须为不含空格和特殊字符的绝对路径。'
parent=$(CDPATH= cd -- "$(dirname -- "$root")" && pwd -P) || fail '安装目录的父目录不存在。'
[[ "$root" == "$parent/$(basename -- "$root")" && ! -L "$root" ]] || fail '安装路径不能包含符号链接或相对路径。'
for name in cmt-auto-model-router cmt-amr-classifier cmt-amr-go; do check_image "$name" || fail '请先执行 load-images。'; done
cleanup() {
  if [[ -n "$stage" && "$stage" == "$parent"/.amr-offline.* && -d "$stage" && ! -L "$stage" ]]; then rm -rf -- "$stage"; fi
  if [[ -n "$inspection" && -d "$inspection" && "$inspection" == /tmp/amr-inspect.* ]]; then rm -rf -- "$inspection"; fi
}
trap cleanup EXIT
helper() {
  docker run --rm --pull never --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    --user 0:0 --mount "type=bind,src=$bundle,dst=/bundle,readonly" \
    --mount "type=bind,src=$root,dst=/installed,readonly" \
    -e "AMR_INSTALL_ROOT=$root" --entrypoint node "$node_image" /bundle/worker.mjs "$@"
}
if [[ "$action" == init ]]; then
  [[ ! -e "$root" ]] || fail '安装目录已存在，拒绝覆盖。'
  [[ "$project" =~ ^[a-z][a-z0-9-]{0,39}$ ]] || fail '项目名须为小写字母、数字和连字符。'
  [[ -z $(docker ps -aq --filter "label=com.docker.compose.project=$project") ]] || fail 'Compose 项目已存在。'
  for suffix in node classifier go; do
    [[ -z $(docker ps -aq --filter "name=^/$project-$suffix$") ]] || fail '容器名称已存在。'
  done
  [[ -f "$config" ]] || fail '业务配置文件不存在。'
  stage=$(mktemp -d "$parent/.amr-offline.XXXXXXXX")
  cp -- "$config" "$stage/input.json"
  ca_flag=0
  if [[ -n "$ca" ]]; then cp -- "$ca" "$stage/ca-input.pem"; ca_flag=1; fi
  chown -R 1000:1000 "$stage"
  chmod 700 "$stage"
  docker run --rm --pull never --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    --user 1000:1000 --mount "type=bind,src=$bundle,dst=/bundle,readonly" \
    --mount "type=bind,src=$stage,dst=/output" \
    -e "AMR_INSTALL_ROOT=$root" -e "AMR_INSTALL_PROJECT=$project" -e "AMR_INSTALL_BIND=$bind" \
    -e "AMR_INSTALL_PORT=$port" -e "AMR_INSTALL_CA=$ca_flag" \
    --entrypoint node "$node_image" /bundle/worker.mjs prepare
  docker compose -p "$project" -f "$stage/compose.json" config --quiet 2>/dev/null || fail '生成的 Compose 校验未通过。'
  chown root:root "$stage/compose.json" "$stage/credentials.json"
  chmod 600 "$stage/compose.json" "$stage/credentials.json"
  # Non-secret installation metadata is readable by the service UID for verification.
  chown root:1000 "$stage" "$stage/installation.json"
  chmod 750 "$stage"
  chmod 640 "$stage/installation.json"
  [[ ! -e "$root" ]] || fail '初始化期间目标目录出现，已停止。'
  mv -T -n -- "$stage" "$root"
  [[ ! -e "$stage" ]] || fail '目标目录已存在，未覆盖。'
  stage=''
  printf '初始化完成：%s\n管理凭证：%s/credentials.json（仅本机管理员读取）\n' "$root" "$root"
  exit 0
fi
[[ -f "$root/installation.json" ]] || fail '未找到安装记录，请先 init。'
project=$(helper project)
compose=(docker compose -p "$project" -f "$root/compose.json")
if [[ "$action" == stop ]]; then
  "${compose[@]}" stop go-core
  "${compose[@]}" stop auto-model-router classifier
  printf '已按 Go、Node、分类器的顺序停止，配置和数据保留。\n'; exit 0
fi
if [[ "$action" == verify ]]; then
  [[ -f "$key" ]] || fail '请用 --key-file 指定调用方 key 文件。'
  key=$(readlink -f -- "$key")
  inspection=$(mktemp -d /tmp/amr-inspect.XXXXXXXX)
  cp -- "$key" "$inspection/business.key"
  chown 1000:1000 "$inspection/business.key"
  chmod 600 "$inspection/business.key"
  result=$(docker run --rm --pull never --network host --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    --user 1000:1000 --mount "type=bind,src=$bundle,dst=/bundle,readonly" \
    --mount "type=bind,src=$root,dst=/installed,readonly" --mount "type=bind,src=$inspection/business.key,dst=/run/business.key,readonly" \
    -e "AMR_INSTALL_ROOT=$root" --entrypoint node "$node_image" /bundle/worker.mjs verify)
  (umask 077; printf '%s\n' "$result" > "$root/business-verification.json")
  printf '%s\n' "$result"; exit 0
fi
if [[ "$action" == start ]]; then
  "${compose[@]}" up -d --pull never --wait --wait-timeout 120
fi
inspection=$(mktemp -d /tmp/amr-inspect.XXXXXXXX)
ids=$("${compose[@]}" ps -aq)
[[ -n "$ids" ]] || fail '没有找到运行容器。'
# Docker-generated IDs contain only hexadecimal characters; no credential fields are inspected.
# shellcheck disable=SC2086
docker inspect --format '{"service":{{json (index .Config.Labels "com.docker.compose.service")}},"image":{{json .Image}},"status":{{json .State.Status}},"health":{{json .State.Health.Status}}}' $ids > "$inspection/containers.jsonl"
docker run --rm --pull never --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --user 0:0 --mount "type=bind,src=$bundle,dst=/bundle,readonly" \
  --mount "type=bind,src=$root,dst=/installed,readonly" --mount "type=bind,src=$inspection,dst=/inspection,readonly" \
  -e "AMR_INSTALL_ROOT=$root" --entrypoint node "$node_image" /bundle/worker.mjs check
