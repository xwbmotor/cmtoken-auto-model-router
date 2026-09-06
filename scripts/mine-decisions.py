#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Read-only decision/feedback/Judge joins and human-review candidate export.

Transport success, declared human feedback and Judge scores are separate evidence.
Router labels, synthetic inputs and HTTP 200 never become gold labels here.
Existing --days/--out/--retry-gap-sec options remain supported; --out explicitly
writes review metadata, not training-ready rows. No upstream calls or config edits.
"""
import argparse
import json
import math
import re
import statistics
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DECISIONS_DIR = ROOT / 'data' / 'decisions'
FEEDBACK_DIR = ROOT / 'data' / 'feedback'
DIMENSIONS = ('correctness', 'instruction_following', 'completeness', 'safety')
TEST_SOURCE = re.compile(r'synthetic|test|eval|benchmark|probe|checkup|replay|合成|测试|评测', re.I)


def timestamp(value):
    try:
        ts = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        return ts if ts.tzinfo is not None else None
    except ValueError:
        return None


def number(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else None


def object_value(value):
    return value if isinstance(value, dict) else {}


def invalid_json_constant(value):
    raise ValueError(f'Non-finite JSON constant: {value}')


def load_stream(directory, pattern, cutoff, now):
    rows, stats = [], Counter()
    for path in sorted(directory.glob(pattern)):
        stats['files'] += 1
        for line_no, line in enumerate(path.read_text(encoding='utf-8-sig').splitlines(), 1):
            if not line.strip():
                continue
            stats['lines'] += 1
            try:
                row = json.loads(line, parse_constant=invalid_json_constant)
            except ValueError:
                stats['invalidJson'] += 1
                continue
            if not isinstance(row, dict):
                stats['invalidRecord'] += 1
                continue
            ts = timestamp(row.get('at'))
            if ts is None:
                stats['invalidTimestamp'] += 1
                continue
            if not cutoff <= ts <= now:
                stats['outsideWindow'] += 1
                continue
            row['_order'] = (ts, path.name, line_no)
            row['_evidence'] = {'file': str(path.resolve()), 'line': line_no}
            rows.append(row)
    return sorted(rows, key=lambda row: row['_order']), dict(stats)


def request_id(row):
    value = object_value(row.get('request')).get('requestId') or row.get('requestId')
    return value if isinstance(value, str) and value else None


def latest_by_request(rows):
    latest, counts, missing = {}, Counter(), []
    for row in rows:
        rid = request_id(row)
        if rid is None:
            missing.append(row)
            continue
        counts[rid] += 1
        latest[rid] = row
    return latest, counts, missing


def source_info(row):
    request = object_value(row.get('request'))
    declared = row.get('source') or request.get('source') or request.get('trafficSource')
    declared = declared if isinstance(declared, str) and declared else None
    marked_test = row.get('synthetic') is True or request.get('synthetic') is True or bool(declared and TEST_SOURCE.search(declared))
    return {'declared': declared, 'kind': 'synthetic_or_test' if marked_test else 'unknown' if declared is None else 'declared_other', 'verified': False}


def feedback_evidence(row):
    if row is None:
        return None
    source = row.get('source') if isinstance(row.get('source'), str) else None
    return {'rating': row['rating'], 'source': source, 'at': row['at'],
            'declaredHuman': source in ('manual', 'human', 'user', 'admin'),
            'syntheticOrTest': bool(source and TEST_SOURCE.search(source)),
            'sourceVerified': False, 'evidence': row['_evidence']}


def judge_evidence(row, answered_model):
    if row is None:
        return None
    quality = object_value(row.get('quality'))
    dimensions = {}
    for name in DIMENSIONS:
        raw = quality.get(name)
        raw = raw if isinstance(raw, dict) else {}
        score = number(raw.get('score'))
        dimensions[name] = {'score': score if score is not None and 0 <= score <= 10 and raw.get('verifiable') is not False else None,
                            'verifiable': raw.get('verifiable') if isinstance(raw.get('verifiable'), bool) else None}
    return {'at': row['at'], 'judgeModel': row.get('judgeModel'), 'answeredModel': row.get('answeredModel'),
            'answeredModelMismatch': bool(row.get('answeredModel') and row['answeredModel'] != answered_model),
            'rubricVersion': row.get('rubricVersion'), 'rubricHash': row.get('rubricHash'),
            'dimensions': dimensions, 'taskCheck': row.get('taskCheck'), 'evidence': row['_evidence']}


def input_evidence(row):
    request = object_value(row.get('request'))
    messages = object_value(request.get('redactedBody')).get('messages') or []
    messages = messages if isinstance(messages, list) else []
    users = []
    for i, message in enumerate(messages):
        if not isinstance(message, dict) or message.get('role') != 'user':
            continue
        text = message.get('content') if isinstance(message.get('content'), str) else message.get('head')
        if not isinstance(text, str) or not text:
            continue
        completeness = 'non_text' if text == '[non-text]' else 'full_text' if 'content' in message else 'head_only'
        users.append({'index': message.get('index', i), 'text': text, 'completeness': completeness, 'originalChars': message.get('chars')})
    return {'userMessages': users[-3:], 'latestUserText': users[-1]['text'] if users else None,
            'sourceContextComplete': bool(messages) and all(isinstance(m, dict) and isinstance(m.get('content'), str) and m['content'] != '[non-text]' for m in messages),
            'exportedContext': 'last_three_user_messages_only'}


def build_report(decisions, feedback, judges, retry_gap):
    by_id, decision_counts, missing_ids = latest_by_request(decisions)
    valid_feedback = [r for r in feedback if r.get('rating') in ('good', 'bad')]
    fb, fb_counts, missing_fb_ids = latest_by_request(valid_feedback)
    judge_latest, judge_counts, missing_judge_ids = latest_by_request(judges)
    judge_quality, _, _ = latest_by_request([r for r in judges if r.get('event') == 'quality'])
    records = sorted([*by_id.values(), *missing_ids], key=lambda r: r['_order'])
    profiles, joined, candidates = {}, [], []
    for row in records:
        rid = request_id(row)
        decision, outcome = object_value(row.get('decision')), object_value(row.get('outcome'))
        analysis = object_value(decision.get('analysis'))
        model = outcome.get('model') or decision.get('selectedModel')
        transport = outcome.get('transportOk') if isinstance(outcome.get('transportOk'), bool) else outcome.get('ok')
        transport = transport if isinstance(transport, bool) else None
        source = source_info(row)
        human = feedback_evidence(fb.get(rid))
        judge = judge_evidence(judge_quality.get(rid), model)
        has_judge_score = bool(judge and not judge['answeredModelMismatch'] and any(d['score'] is not None for d in judge['dimensions'].values()))
        last_judge = judge_latest.get(rid)
        item = {'requestId': rid, 'at': row['at'], 'selectedModel': model, 'dataSource': source,
                'transportOutcome': {'ok': transport, 'errorType': outcome.get('errorType')},
                'humanFeedback': human, 'humanRating': human['rating'] if human and human['declaredHuman'] and not human['syntheticOrTest'] else None,
                'judgeReview': judge, 'latestJudgeEvent': {'event': last_judge.get('event'), 'at': last_judge['at'], 'reason': last_judge.get('reason'), 'evidence': last_judge['_evidence']} if last_judge else None,
                'taskSuccess': None, 'evaluationStatus': 'has_separate_evidence' if human or has_judge_score else 'not_evaluated',
                'duplicates': {'decisions': max(0, decision_counts[rid] - 1), 'feedback': max(0, fb_counts[rid] - 1), 'judgeEvents': max(0, judge_counts[rid] - 1)},
                'evidence': row['_evidence']}
        joined.append(item)
        key = (model, decision.get('explicitTask') or analysis.get('task'), analysis.get('tier'), source['kind'], source['declared'])
        if key not in profiles:
            profiles[key] = {'model': key[0], 'taskSuggested': key[1], 'tierSuggested': key[2], 'dataSource': source,
                             'requests': 0, 'transportKnown': 0, 'transportOk': 0, 'humanRatings': Counter(),
                             'feedbackSources': Counter(), 'judgeScores': {d: [] for d in DIMENSIONS},
                             'judgeRubrics': Counter(), 'completionLatencyMs': [], 'legacyLatencyMs': [], 'actualCostYuan': 0.0, 'estimatedCostYuan': 0.0, 'costUnknown': 0}
        p = profiles[key]
        p['requests'] += 1
        if transport is not None:
            p['transportKnown'] += 1
            p['transportOk'] += int(transport)
        if human:
            p['feedbackSources'][human['source'] or 'unknown'] += 1
        if item['humanRating']:
            p['humanRatings'][item['humanRating']] += 1
        if has_judge_score:
            p['judgeRubrics'][json.dumps([judge['judgeModel'], judge['rubricHash'], judge['rubricVersion']])] += 1
            for name, dimension in judge['dimensions'].items():
                if dimension['score'] is not None:
                    p['judgeScores'][name].append(dimension['score'])
        latency_key = 'completionLatencyMs' if number(outcome.get('completionLatencyMs')) is not None else 'legacyLatencyMs'
        latency = number(outcome.get('completionLatencyMs' if latency_key == 'completionLatencyMs' else 'latencyMs'))
        if latency is not None:
            p[latency_key].append(latency)
        actual, estimated = number(outcome.get('actualCostYuan')), number(outcome.get('estimatedCostYuan'))
        if actual is not None:
            p['actualCostYuan'] += actual  # Zero is an observed amount, not a missing value.
        elif estimated is not None:
            p['estimatedCostYuan'] += estimated
        else:
            p['costUnknown'] += 1
        candidate = {**item, 'source': 'mined-review-v2', 'labelStatus': 'needs_human_review', 'trainingEligible': False,
                     'inputEvidence': input_evidence(row),
                     'labelsSuggested': {name: analysis.get(name) for name in ('task', 'tier', 'subTask', 'complexity', 'confidence')}}
        candidate['reviewBlockers'] = ['labels_not_human_verified']
        if rid is None:
            candidate['reviewBlockers'].append('missing_request_id')
        if source['kind'] != 'declared_other':
            candidate['reviewBlockers'].append('source_' + source['kind'])
        if not candidate['inputEvidence']['sourceContextComplete']:
            candidate['reviewBlockers'].append('incomplete_input')
        candidates.append(candidate)
    for p in profiles.values():
        p['transportSuccessRate'] = p['transportOk'] / p['transportKnown'] if p['transportKnown'] else None
        provenance_known = all(identity[0] and (identity[1] or identity[2]) for identity in (json.loads(key) for key in p['judgeRubrics']))
        comparable = len(p['judgeRubrics']) == 1 and provenance_known
        p['judgeScores'] = {name: {'n': len(scores), 'mean': statistics.mean(scores) if scores and comparable else None} for name, scores in p['judgeScores'].items()}
        p['judgeAggregationStatus'] = 'no_scores' if not p['judgeRubrics'] else 'missing_judge_provenance_no_pooled_mean' if not provenance_known else 'mixed_judge_or_rubric_no_pooled_mean' if not comparable else 'single_judge_and_rubric'
        for key in ('completionLatencyMs', 'legacyLatencyMs'):
            values = p[key]
            p[key] = {'n': len(values), 'p50': statistics.median(values) if values else None}
    sessions, retries = defaultdict(list), []
    for row in records:
        request = object_value(row.get('request'))
        sid = request.get('sessionFingerprint') or request.get('sessionId')
        if sid:
            sessions[(request.get('keyFingerprint'), sid)].append(row)
    for rows in sessions.values():
        for previous, current in zip(rows, rows[1:]):
            gap = (current['_order'][0] - previous['_order'][0]).total_seconds()
            if 0 <= gap <= retry_gap:
                retries.append({'previousRequestId': request_id(previous), 'requestId': request_id(current), 'gapSec': round(gap, 1), 'interpretation': 'nearby_turn_only_not_dissatisfaction'})
    return {'schemaVersion': 2, 'deduplication': 'latest timestamp per requestId; ties use sorted file and line',
            'coverage': {'decisionRows': len(decisions), 'uniqueRequests': len(by_id), 'missingRequestId': len(missing_ids),
                         'duplicateDecisionRows': sum(n - 1 for n in decision_counts.values()),
                         'duplicateFeedbackRows': sum(n - 1 for n in fb_counts.values()),
                         'duplicateJudgeEvents': sum(n - 1 for n in judge_counts.values()),
                         'invalidFeedbackRatings': len(feedback) - len(valid_feedback), 'feedbackMissingRequestId': len(missing_fb_ids),
                         'judgeMissingRequestId': len(missing_judge_ids),
                         'orphanFeedbackRequests': len(set(fb) - set(by_id)), 'orphanJudgeRequests': len(set(judge_latest) - set(by_id)),
                         'withoutFeedback': sum(r['humanFeedback'] is None for r in joined),
                         'withoutJudgeQuality': sum(r['judgeReview'] is None for r in joined),
                         'judgeWithoutNumericScores': sum(r['judgeReview'] is not None and not any(d['score'] is not None for d in r['judgeReview']['dimensions'].values()) for r in joined),
                         'judgeModelMismatch': sum(bool(r['judgeReview'] and r['judgeReview']['answeredModelMismatch']) for r in joined),
                         'withoutEvaluation': sum(r['evaluationStatus'] == 'not_evaluated' for r in joined),
                         'sources': dict(Counter(r['dataSource']['kind'] for r in joined))},
            'profiles': sorted(profiles.values(), key=lambda p: -p['requests']), 'requests': joined,
            'nearbySessionTurns': retries, 'candidates': candidates}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--days', type=int, default=14)
    ap.add_argument('--out', help='人工待审候选 JSONL 路径；默认不写文件')
    ap.add_argument('--retry-gap-sec', type=float, default=30.0)
    ap.add_argument('--decisions-dir', type=Path, default=DECISIONS_DIR)
    ap.add_argument('--feedback-dir', type=Path, default=FEEDBACK_DIR)
    ap.add_argument('--judge-dir', type=Path, help='默认与 decisions-dir 相同')
    ap.add_argument('--json', action='store_true', help='只读 JSON 报告输出到 stdout')
    args = ap.parse_args()
    if args.days < 1 or not math.isfinite(args.retry_gap_sec) or args.retry_gap_sec < 0:
        ap.error('days 必须为正整数，retry-gap-sec 必须为非负有限数')
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=args.days)
    decisions, ds = load_stream(args.decisions_dir, 'decisions-*.jsonl', cutoff, now)
    feedback, fs = load_stream(args.feedback_dir, 'feedback-*.jsonl', cutoff, now)
    judges, js = load_stream(args.judge_dir or args.decisions_dir, 'judge-reviews-*.jsonl', cutoff, now)
    report = build_report(decisions, feedback, judges, args.retry_gap_sec)
    report.update({'windowDays': args.days, 'loaded': {'decisions': ds, 'feedback': fs, 'judge': js}})
    if args.out:
        out = Path(args.out)
        source_files = {path.resolve() for directory, pattern in [(args.decisions_dir, 'decisions-*.jsonl'), (args.feedback_dir, 'feedback-*.jsonl'), (args.judge_dir or args.decisions_dir, 'judge-reviews-*.jsonl')] for path in directory.glob(pattern)}
        if out.resolve() == (ROOT / 'data/training/raw.jsonl').resolve() or out.resolve() in source_files:
            ap.error('候选输出不能覆盖原始日志或 data/training/raw.jsonl')
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(''.join(json.dumps(c, ensure_ascii=False) + '\n' for c in report['candidates']), encoding='utf-8')
    if args.json:
        print(json.dumps(report, ensure_ascii=False, allow_nan=False))
        return 0
    coverage = report['coverage']
    print(f"== 近 {args.days} 天：{coverage['decisionRows']} 条日志，{coverage['uniqueRequests']} 个去重请求，缺 requestId {coverage['missingRequestId']} 条 ==")
    print('来源分布：' + json.dumps(coverage['sources'], ensure_ascii=False) + '；unknown 不能视为真实业务。')
    print(f"无反馈 {coverage['withoutFeedback']}，无 Judge 质量事件 {coverage['withoutJudgeQuality']}，两者都无 {coverage['withoutEvaluation']}；无评价不是成功。")
    print('-- 传输可用性、声明人工反馈、Judge 分数分别统计；按来源隔离 --')
    for p in report['profiles']:
        rate = f"{p['transportSuccessRate']:.1%}" if p['transportSuccessRate'] is not None else '未知'
        print(f"{p['model']} {p['taskSuggested']}/{p['tierSuggested']} source={p['dataSource']['declared'] or 'unknown'} n={p['requests']} 传输成功率={rate} 人工声明反馈={dict(p['humanRatings'])} Judge={p['judgeScores']}")
    print(f"会话近邻请求 {len(report['nearbySessionTurns'])} 对：可能是正常追问/工具循环，不推定为用户不满意；未发现也不证明质量良好。")
    print(f"人工待审候选 {len(report['candidates'])} 条；taskSuccess 均未知，路由标签仅为建议，不可直接并入训练集。")
    if args.out:
        print(f'候选已写入 {args.out}')
    print('传输失败先排查凭据、限流、超时和服务健康；不能据 HTTP ok 率下调模型质量分。')
    print('人工反馈与 Judge 分歧优先复核原题、回答、评分规则及来源；确认后另行制作隔离训练/验证数据。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
