#!/usr/bin/env python
"""训练语义分类小模型（task 5 类 + tier 3 类 + complexity 回归）。
用法: .venv/Scripts/python.exe scripts/train_classifier.py
输入: data/training/raw.jsonl  输出: data/training/model/*.joblib + meta.json
自定义 transformer 在 classifier_common.py（train/serve 共享，保证 pickle 兼容）。
"""
import json, time, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / 'data/training/raw.jsonl'
MODEL_DIR = ROOT / 'data/training/model'

from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.pipeline import Pipeline, FeatureUnion
from sklearn.linear_model import LogisticRegression, Ridge
from sklearn.model_selection import train_test_split
from sklearn.metrics import classification_report, confusion_matrix, mean_absolute_error
from classifier_common import LengthFeats

rows = [json.loads(l) for l in RAW.read_text(encoding='utf-8').splitlines() if l.strip()]
print(f'加载 {len(rows)} 条')
texts = [r['text'] for r in rows]
y_task = [r['task'] for r in rows]
y_tier = [r['tier'] for r in rows]
y_cplx = [r['complexity'] for r in rows]

# 分层切分：同一样本同时作为 task/tier/complexity 的测试集（模拟真实分布）
X_tr, X_te, t_tr, t_te, tier_tr, tier_te, c_tr, c_te = train_test_split(
    texts, y_task, y_tier, y_cplx, test_size=0.2, random_state=42,
    stratify=[f'{a}|{b}' for a, b in zip(y_task, y_tier)])

# heldout 索引落盘：管理端"评测分类器"用同一 seed 复现切分，保证评测集与训练时完全一致
import numpy as np
_idx = np.arange(len(rows))
_tr_idx, _te_idx = train_test_split(_idx, test_size=0.2, random_state=42,
                                    stratify=[f'{a}|{b}' for a, b in zip(y_task, y_tier)])
heldout = [{'index': int(i), 'text': texts[i], 'task': y_task[i], 'tier': y_tier[i], 'complexity': y_cplx[i]} for i in _te_idx]
(MODEL_DIR / 'heldout.jsonl').write_text('\n'.join(json.dumps(h, ensure_ascii=False) for h in heldout) + '\n', encoding='utf-8')
print(f'heldout 评测集已落盘 → {MODEL_DIR / "heldout.jsonl"} ({len(heldout)} 条)')


def make_featurizer():
    return FeatureUnion([
        ('tfidf', TfidfVectorizer(analyzer='char_wb', ngram_range=(2, 4), sublinear_tf=True, min_df=2, max_features=120000)),
        ('len', LengthFeats()),
    ])


def make_clf(C=1.0):
    return Pipeline([
        ('feat', make_featurizer()),
        ('clf', LogisticRegression(C=C, max_iter=3000, class_weight='balanced')),
    ])


def make_reg():
    return Pipeline([
        ('feat', make_featurizer()),
        ('reg', Ridge(alpha=1.0)),
    ])


# —— task 分类 ——
t0 = time.time()
task_model = make_clf().fit(X_tr, t_tr)
pred_task = task_model.predict(X_te)
print('\n== task 分类 ==')
print(classification_report(t_te, pred_task, digits=4))
print('混淆矩阵 (行=真实 列=预测):')
labels = sorted(set(y_task))
print(' ' * 12 + '  '.join(f'{l[:9]:>9}' for l in labels))
for i, a in enumerate(labels):
    row = confusion_matrix(t_te, pred_task, labels=labels)[i]
    print(f'{a[:10]:>12}  ' + '  '.join(f'{v:>9}' for v in row))

# —— tier 分类 ——
tier_model = make_clf().fit(X_tr, tier_tr)
pred_tier = tier_model.predict(X_te)
print('\n== tier 分类 ==')
print(classification_report(tier_te, pred_tier, digits=4))

# —— complexity 回归 ——
cplx_model = make_reg().fit(X_tr, c_tr)
pred_c = cplx_model.predict(X_te)
mae = mean_absolute_error(c_te, pred_c)
print(f'\n== complexity 回归 ==  MAE={mae:.4f}  (目标 <=0.10)')

# —— 推理速度 ——
t1 = time.time()
for _ in range(50):
    task_model.predict(['宽带断了帮我看看是什么问题'])
lat = (time.time() - t1) / 50 * 1000
print(f'\n单次推理: {lat:.1f}ms (目标 <50ms)')

# —— 保存 ——
import joblib
MODEL_DIR.mkdir(parents=True, exist_ok=True)
joblib.dump(task_model, MODEL_DIR / 'task.joblib')
joblib.dump(tier_model, MODEL_DIR / 'tier.joblib')
joblib.dump(cplx_model, MODEL_DIR / 'complexity.joblib')
(MODEL_DIR / 'meta.json').write_text(json.dumps({
    'trainedAt': time.strftime('%Y-%m-%dT%H:%M:%S'),
    'samples': len(rows), 'features': 'tfidf-char_wb-2-4gram + length-feats',
    'taskAcc': float((pred_task == t_te).mean()),
    'tierAcc': float((pred_tier == tier_te).mean()),
    'complexityMae': float(mae),
    'latencyMs': round(lat, 1),
}, ensure_ascii=False, indent=1), encoding='utf-8')
print(f'\n模型已保存 → {MODEL_DIR}')
ok = (pred_task == t_te).mean() >= 0.95 and (pred_tier == tier_te).mean() >= 0.90 and mae <= 0.10 and lat < 50
sys.exit(0 if ok else 2)
