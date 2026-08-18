#!/usr/bin/env python
"""语义分类小模型推理服务：POST /classify {"text": "..."} → {"task","tier","complexity","confidence","reason"}
契约对齐 auto-model-router 的 semanticRouter http-json provider。
用法: .venv/Scripts/python.exe scripts/serve_classifier.py [--port 8788]
"""
import json, time, argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODEL_DIR = ROOT / 'data/training/model'
import joblib

task_model = joblib.load(MODEL_DIR / 'task.joblib')
tier_model = joblib.load(MODEL_DIR / 'tier.joblib')
cplx_model = joblib.load(MODEL_DIR / 'complexity.joblib')
META = json.loads((MODEL_DIR / 'meta.json').read_text(encoding='utf-8'))

TASK_DESC = {
    'coding': '编程开发请求', 'reasoning': '多因素分析推理', 'creative': '原创内容创作',
    'extraction': '给定材料结构化提取', 'default': '一般对话问答',
}

# Prometheus 计数器（进程内存态，重启清零；与主路由 router_semantic_total 对账用）
METRICS = {'classify_total': 0, 'classify_errors': 0, 'classify_ms_sum': 0.0, 'classify_ms_count': 0,
           'task_total': {}, 'low_confidence_total': 0}

def render_metrics():
    lines = [
        '# HELP classifier_classify_total 分类请求总数', '# TYPE classifier_classify_total counter',
        f'classifier_classify_total {METRICS["classify_total"]}',
        '# HELP classifier_classify_errors 分类失败数', '# TYPE classifier_classify_errors counter',
        f'classifier_classify_errors {METRICS["classify_errors"]}',
        '# HELP classifier_classify_latency_ms 推理耗时（累加，除以 count 得均值）', '# TYPE classifier_classify_latency_ms counter',
        f'classifier_classify_latency_ms_sum {METRICS["classify_ms_sum"]:.1f}',
        f'classifier_classify_latency_ms_count {METRICS["classify_ms_count"]}',
        '# HELP classifier_low_confidence_total 置信度<0.4 请求数（上游应走规则兜底）', '# TYPE classifier_low_confidence_total counter',
        f'classifier_low_confidence_total {METRICS["low_confidence_total"]}',
    ]
    for task, count in sorted(METRICS['task_total'].items()):
        lines.append(f'classifier_task_total{{task="{task}"}} {count}')
    return '\n'.join(lines) + '\n'

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # 结构化静默日志
        pass

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('content-type', 'application/json; charset=utf-8')
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/health':
            self._json(200, {'status': 'ok', 'model': META})
        elif self.path == '/metrics':
            body = render_metrics().encode('utf-8')
            self.send_response(200)
            self.send_header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
            self.send_header('content-length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self._json(404, {'error': 'not_found'})

    def do_POST(self):
        if self.path != '/classify':
            return self._json(404, {'error': 'not_found'})
        try:
            n = int(self.headers.get('content-length') or 0)
            req = json.loads(self.rfile.read(n).decode('utf-8'))
            text = str(req.get('text') or '').strip()
            if not text:
                return self._json(400, {'error': 'text required'})
            METRICS['classify_total'] += 1
            t0 = time.perf_counter()
            task = task_model.predict([text])[0]
            proba = task_model.predict_proba([text])[0]
            classes = list(task_model.classes_)
            conf = float(proba[list(classes).index(task)])
            tier = tier_model.predict([text])[0]
            cplx = float(min(1.0, max(0.0, cplx_model.predict([text])[0])))
            ms = (time.perf_counter() - t0) * 1000
            METRICS['classify_ms_sum'] += ms
            METRICS['classify_ms_count'] += 1
            METRICS['task_total'][task] = METRICS['task_total'].get(task, 0) + 1
            if conf < 0.4:
                METRICS['low_confidence_total'] += 1
            reason = f'{TASK_DESC.get(task, task)} · {tier} 难度 · 模型置信 {conf:.2f}'
            self._json(200, {
                'task': task, 'tier': tier,
                'complexity': round(cplx, 3), 'confidence': round(conf, 3),
                'reason': reason, 'latencyMs': round(ms, 1),
            })
        except Exception as e:
            METRICS['classify_errors'] += 1
            self._json(500, {'error': str(e)})

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8788)
    ap.add_argument('--host', default='127.0.0.1')
    args = ap.parse_args()
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    banner = f'classifier service on http://{args.host}:{args.port} · model {META["trainedAt"]} · taskAcc={META["taskAcc"]:.3f} tierAcc={META["tierAcc"]:.3f} MAE={META["complexityMae"]:.3f}'
    # pythonw 无控制台时 stdout 为 None，写文件兜底
    try:
        print(banner)
    except Exception:
        pass
    (ROOT / 'data/training/serve.log').write_text(banner + '\n', encoding='utf-8')
    srv.serve_forever()
