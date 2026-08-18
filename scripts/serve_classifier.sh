#!/bin/sh
# 语义分类器服务启动（Linux/macOS）：http://127.0.0.1:8788/classify
# 用法：./scripts/serve_classifier.sh [--port 8788]
# 依赖：python3 + scikit-learn joblib numpy（pip install -i https://pypi.tuna.tsinghua.edu.cn/simple scikit-learn==1.9.0 joblib numpy）
set -e
cd "$(dirname "$0")/.."
PY="${PYTHON:-python3}"
if [ -x ".venv/bin/python" ]; then PY=".venv/bin/python"; fi
mkdir -p data/training
exec "$PY" scripts/serve_classifier.py --host 127.0.0.1 "$@"
