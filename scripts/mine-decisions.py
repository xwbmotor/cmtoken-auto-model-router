#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""决策日志挖掘（飞轮核心）：从 data/decisions/*.jsonl 提炼调参建议 + 候选训练样本。

输出三部分：
1. 分模型×分档位的真实质量/成本画像（按 ok 率、延迟、实际成本）
2. 隐式负信号候选：同 sessionId 短间隔重试（用户不满意的代理信号）
3. 高置信训练样本候选：按 decision.analysis 的 task/tier/complexity 分桶，
   附带建议 tier 标签——可直接人工审核后并入 data/training/raw.jsonl

用法：
  python scripts/mine-decisions.py [--days 14] [--out data/training/mined-YYYYMMDD.jsonl]
"""
import argparse
import json
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DECISIONS_DIR = ROOT / 'data' / 'decisions'


def load_records(days: int):
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    records = []
    if not DECISIONS_DIR.exists():
        return records
    for f in sorted(DECISIONS_DIR.glob('decisions-*.jsonl')):
        for line in f.read_text(encoding='utf-8').splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            at = rec.get('at')
            if not at:
                continue
            try:
                ts = datetime.fromisoformat(at.replace('Z', '+00:00'))
            except ValueError:
                continue
            if ts >= cutoff:
                records.append(rec)
    return records


def fmt_yuan(v):
    return f'{v:.4f}元' if v is not None else '—'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--days', type=int, default=14)
    ap.add_argument('--out', default=None, help='候选训练样本输出路径（默认打印不入盘）')
    ap.add_argument('--retry-gap-sec', type=float, default=30.0, help='同会话重试间隔阈值（秒）')
    args = ap.parse_args()

    records = load_records(args.days)
    if not records:
        print(f'近 {args.days} 天无决策日志（{DECISIONS_DIR}）——先跑一段真实流量再挖掘。')
        return 0

    print(f'== 决策日志挖掘：近 {args.days} 天，{len(records)} 条 ==')
    print()

    # —— 1. 分模型×分档位画像 ——
    # quality 代理 = ok率；cost = actualCostYuan 求和（无 usage 时用 estimated）
    buckets = defaultdict(lambda: {'n': 0, 'ok': 0, 'lat': [], 'cost': 0.0, 'fbad': 0, 'fgood': 0})
    for r in records:
        d = r.get('decision') or {}
        o = r.get('outcome') or {}
        model = o.get('model') or d.get('selectedModel') or '?'
        task = (d.get('analysis') or {}).get('task') or '?'
        tier = (d.get('analysis') or {}).get('tier') or '?'
        key = (model, task, tier)
        b = buckets[key]
        b['n'] += 1
        if o.get('ok'):
            b['ok'] += 1
        lat = o.get('latencyMs')
        if isinstance(lat, (int, float)):
            b['lat'].append(lat)
        cost = o.get('actualCostYuan') or o.get('estimatedCostYuan')
        if isinstance(cost, (int, float)):
            b['cost'] += cost

    print('-- 1) 模型×任务×档位画像（按样本量排序，n≥5 才有参考价值）--')
    rows = sorted(buckets.items(), key=lambda kv: -kv[1]['n'])
    print(f"{'模型':<20}{'任务':<10}{'档位':<8}{'n':>5}{'ok率':>7}{'P50延迟':>9}{'成本合计':>10}")
    for (model, task, tier), b in rows:
        if b['n'] < 5:
            continue
        lat_sorted = sorted(b['lat']) or [0]
        p50 = lat_sorted[len(lat_sorted) // 2]
        ok_rate = b['ok'] / b['n']
        print(f"{model:<20}{task:<10}{tier:<8}{b['n']:>5}{ok_rate:>7.1%}{p50:>8}ms{fmt_yuan(b['cost']):>10}")

    # —— 2. 隐式负信号：同会话短间隔重试 ——
    # v0.7.4 十审 P1：决策日志不再落原始 sessionId，改 sessionFingerprint（sidfp:<16hex> HMAC）。
    # 旧日志（v0.7.3-）兼容读取：新字段优先，旧字段回退。
    print()
    print('-- 2) 隐式负信号候选（同会话短间隔重试，v0.7.4+ 按 sessionFingerprint 归并）--')
    by_session = defaultdict(list)
    for r in records:
        req = r.get('request') or {}
        sid = req.get('sessionFingerprint') or req.get('sessionId')
        if not sid:
            continue
        by_session[sid].append(r)
    retry_events = []
    for sid, rs in by_session.items():
        rs.sort(key=lambda r: r['at'])
        for prev, cur in zip(rs, rs[1:]):
            try:
                t0 = datetime.fromisoformat(prev['at'].replace('Z', '+00:00'))
                t1 = datetime.fromisoformat(cur['at'].replace('Z', '+00:00'))
            except (ValueError, KeyError):
                continue
            gap = (t1 - t0).total_seconds()
            if gap <= args.retry_gap_sec:
                retry_events.append({'sessionId': sid, 'gapSec': round(gap, 1), 'prevModel': (prev.get('outcome') or {}).get('model'), 'curModel': (cur.get('outcome') or {}).get('model'), 'at': cur['at']})
    if retry_events:
        print(f'捕获 {len(retry_events)} 次（重试≠必差，但高频重试的模型×档位值得关注）:')
        for e in retry_events[:10]:
            print(f"  {e['at'][:19]} sid={e['sessionId'][:8]}… {e['prevModel']} → {e['curModel']}（{e['gapSec']}s）")
    else:
        print('无（好现象）')

    # —— 3. 高置信训练样本候选 ——
    print()
    print('-- 3) 训练样本候选（按决策置信度排序，人工审核后可并入训练集）--')
    candidates = []
    for r in records:
        d = r.get('decision') or {}
        req = r.get('request') or {}
        redacted = req.get('redactedBody') or {}
        msgs = redacted.get('messages') or []
        if not msgs:
            continue
        text = msgs[0].get('head') or ''
        if not text:
            continue
        analysis = d.get('analysis') or {}
        conf = analysis.get('confidence') or 0
        candidates.append({
            'text': text,
            'task': analysis.get('task'),
            'tier': analysis.get('tier'),
            'complexity': analysis.get('complexity'),
            'confidence': conf,
            'selectedModel': (r.get('outcome') or {}).get('model'),
            'at': r.get('at'),
            'source': 'mined-v1',
        })
    candidates.sort(key=lambda c: -(c['confidence'] or 0))
    print(f'共 {len(candidates)} 条（决策日志只保留每条消息前 160 字符，作候选线索足够）')
    if args.out:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        with out.open('w', encoding='utf-8') as f:
            for c in candidates:
                f.write(json.dumps(c, ensure_ascii=False) + '\n')
        print(f'已写入 {out}')
    else:
        for c in candidates[:5]:
            print(f"  conf={c['confidence']} {c['task']}/{c['tier']} → {c['selectedModel']}: {c['text'][:40]}…")

    print()
    print('== 调参建议对照表 ==')
    print('若某模型×档位 ok 率 < 0.9 且 n≥20：考虑下调该模型 quality 分或调大 livePenalty')
    print('若高置信样本集中某 task 的 tier 判定与人工直觉不符：优先补训练样本（第 3 部分输出）')
    print('若重试集中某模型：查该模型健康度（/metrics router_health_up）与熔断记录')
    return 0


if __name__ == '__main__':
    sys.exit(main())
