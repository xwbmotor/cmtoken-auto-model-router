@echo off
rem 语义分类器服务（自训练小模型）：http://127.0.0.1:8788/classify
rem 用法：双击或 cmd 执行；日志见 data\training\serve.log
cd /d "%~dp0.."
.venv\Scripts\python.exe scripts\serve_classifier.py --port 8788 > data\training\serve.log 2>&1
