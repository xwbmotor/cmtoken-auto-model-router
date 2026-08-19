#!/usr/bin/env python
"""分类器标准评测：管理端「评测分类器」按钮的后端。
对比三方在同一 heldout 集上的任务分类表现：
  - gold    ：人工/合成标注真值
  - 小模型  ：data/training/model/*.joblib（线上 http-json 端点同款产物）
  - 规则层  ：复刻 src/router.mjs DEFAULT_TASK_PATTERNS 的关键词正则（与线上规则分类同源）
输出 JSON 到 stdout（Node 端 spawn 调用），含准确率、宏平均、混淆矩阵、规则层未触发率。
用法: .venv/Scripts/python.exe scripts/evaluate_classifier.py
"""
import json, re, time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODEL_DIR = ROOT / 'data/training/model'

# —— 与 src/router.mjs DEFAULT_TASK_PATTERNS 同源的关键词正则（改动 router.mjs 时同步此处）——
PATTERNS = {
    'coding': r'代码|编程|程序|函数|接口|报错|异常|debug|bug|python|java|javascript|typescript|golang|rust|sql|regex|算法|并发|重构|单元测试',
    'reasoning': r'推理|证明|分析原因|根因|权衡|取舍|对比|评估|规划|方案|设计|架构|框架|路由|综合选择|怎么做|如何实现|分布式事务|数学|逻辑|为什么|比较.*优缺点|reason|prove|analy[sz]e|architecture',
    'creative': r'创作|文案|故事|诗|广告|宣传语|口号|营销|改写.*风格|脑暴|起名|剧本|slogan|creative|story|poem|copywriting',
    'extraction': r'提取|抽取|分类|标签|结构化|转换为.*json|只返回|识别字段|extract|classify|parse|json',
}
COMPILED = {k: re.compile(v, re.I) for k, v in PATTERNS.items()}
# router.mjs 的遍历顺序即优先级：coding > reasoning > creative > extraction > default
ORDER = ['coding', 'reasoning', 'creative', 'extraction']


def rule_predict(text: str) -> str:
    for name in ORDER:
        if COMPILED[name].search(text):
            return name
    return 'default'


def main():
    import joblib
    rows = [json.loads(l) for l in (MODEL_DIR / 'heldout.jsonl').read_text(encoding='utf-8').splitlines() if l.strip()]
    texts = [r['text'] for r in rows]
    gold = [r['task'] for r in rows]

    task_model = joblib.load(MODEL_DIR / 'task.joblib')
    t0 = time.time()
    clf_pred = list(task_model.predict(texts))
    infer_ms = (time.time() - t0) / len(texts) * 1000
    rule_pred = [rule_predict(t) for t in texts]

    labels = sorted(set(gold) | set(clf_pred) | set(rule_pred))

    def confusion(pred):
        m = {a: {b: 0 for b in labels} for a in labels}
        for g, p in zip(gold, pred):
            m[g][p] += 1
        return m

    def accuracy(pred):
        return sum(1 for g, p in zip(gold, pred) if g == p) / len(gold)

    def macro_f1(pred):
        f1s = []
        for l in labels:
            tp = sum(1 for g, p in zip(gold, pred) if g == l and p == l)
            fp = sum(1 for g, p in zip(gold, pred) if g != l and p == l)
            fn = sum(1 for g, p in zip(gold, pred) if g == l and p != l)
            prec = tp / (tp + fp) if tp + fp else 0.0
            rec = tp / (tp + fn) if tp + fn else 0.0
            f1s.append(2 * prec * rec / (prec + rec) if prec + rec else 0.0)
        return sum(f1s) / len(f1s)

    meta = json.loads((MODEL_DIR / 'meta.json').read_text(encoding='utf-8')) if (MODEL_DIR / 'meta.json').exists() else {}
    out = {
        'heldoutSize': len(rows),
        'modelTrainedAt': meta.get('trainedAt'),
        'labels': labels,
        'classifier': {
            'accuracy': round(accuracy(clf_pred), 4),
            'macroF1': round(macro_f1(clf_pred), 4),
            'confusion': confusion(clf_pred),
            'avgInferMs': round(infer_ms, 1),
        },
        'rules': {
            'accuracy': round(accuracy(rule_pred), 4),
            'macroF1': round(macro_f1(rule_pred), 4),
            'confusion': confusion(rule_pred),
            'unmatchedRate': round(sum(1 for p in rule_pred if p == 'default') / len(rule_pred), 4),
        },
        'disagreementRate': round(sum(1 for a, b in zip(clf_pred, rule_pred) if a != b) / len(rows), 4),
    }
    print(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main()
