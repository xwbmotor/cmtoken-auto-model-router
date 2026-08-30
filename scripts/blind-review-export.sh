#!/bin/bash
# 盲审样本导出：云端 judge-reviews + decisions 原文 → 本地 xlsx
# 用法：bash scripts/blind-review-export.sh [输出.xlsx] [条数]
set -e
H=root@159.75.246.86
KEY="$HOME/.ssh/id_ed25519_amr"
OUT_WIN="${1:-C:\\Users\\xwbmo\\Documents\\judge盲审样本.xlsx}"
# MSYS → Windows 路径（python 不认 /c/...）
OUT_NATIVE=$(cygpath -w "$1" 2>/dev/null || echo "$OUT_WIN")
export BR_COUNT="${2:-100}"

ssh -i "$KEY" $H 'bash -s' <<'REMOTE' > "$LOCALAPPDATA/Temp/amr-blindreview.jsonl"
python3 - <<'PYEOF'
import json, glob, os

COUNT = int(os.environ.get('BR_COUNT', '100'))

reviews = []
for f in sorted(glob.glob('/opt/amr/data/decisions/judge-reviews-*.jsonl')):
    for l in open(f):
        r = json.loads(l)
        if r.get('event') == 'quality' and r.get('quality'):
            reviews.append(r)
reviews = reviews[-COUNT:]

by_rid = {}
for f in sorted(glob.glob('/opt/amr/data/decisions/decisions-*.jsonl')):
    for l in open(f):
        r = json.loads(l)
        rid = (r.get('request') or {}).get('requestId') or r.get('requestId')
        if rid: by_rid[rid] = r

out = []
for rv in reviews:
    rid = rv.get('requestId')
    d = by_rid.get(rid)
    if not d: continue
    msgs = ((d.get('request') or {}).get('redactedBody') or {}).get('messages') or []
    req_text = ' | '.join("[%s] %s" % (m.get('role'), str(m.get('content', m.get('head', '')))[:200]) for m in msgs)[:600]
    ans = (d.get('outcome') or {}).get('answerText') or ''
    q = rv.get('quality') or {}
    def dim(k):
        dd = q.get(k) or {}
        if not dd: return '-'
        s = dd.get('score')
        return ("%s" % s) + ("(不可核验)" if dd.get('verifiable') is False and s is None else "")
    out.append({
        'requestId': rid,
        'at': rv.get('at'),
        'task': rv.get('task'), 'subTask': rv.get('subTask') or '', 'tier': rv.get('tier'),
        'answeredModel': rv.get('answeredModel'),
        '请求文本': req_text,
        '回答文本': (ans or '(未留存)')[:2000],
        '人工质量分_1到10': '',
        '人工分类对错': '',
        '备注': '',
        'judge正确性': dim('correctness'),
        'judge指令遵循': dim('instruction_following'),
        'judge完整性': dim('completeness'),
        'judge安全性': dim('safety'),
        'judge评语': (q.get('overall_comment') or '')[:100],
    })
for row in out:
    print(json.dumps(row, ensure_ascii=False))
PYEOF
REMOTE

python - "$OUT_NATIVE" <<'PYX'
import json, sys, os
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment

out_path = sys.argv[1]
rows = [json.loads(l) for l in open(os.environ['LOCALAPPDATA'] + r'\Temp\amr-blindreview.jsonl', encoding='utf-8') if l.strip()]
if not rows:
    print('无样本'); sys.exit(2)

wb = Workbook(); ws = wb.active; ws.title = '盲审'
cols = list(rows[0].keys())
ws.append(cols)
for r in rows: ws.append([r[c] for c in cols])

grey = PatternFill('solid', fgColor='F2F2F2')
blue = PatternFill('solid', fgColor='DDEBF7')
yellow = PatternFill('solid', fgColor='FFF2CC')
for c in ws[1]:
    c.font = Font(bold=True)
    c.fill = grey if c.value.startswith('judge') else (yellow if c.value.startswith('人工') else blue)
ws.freeze_panes = 'A2'
for col in ws.columns:
    letter = col[0].column_letter
    width = max(len(str(c.value or '')) for c in col[:60])
    ws.column_dimensions[letter].width = min(max(width * 1.3, 10), 55)
for row in ws.iter_rows(min_row=2):
    for c in row:
        if c.column > 5:
            c.alignment = Alignment(wrap_text=True, vertical='top')

wb.save(out_path)
print('导出 %d 条盲审样本 -> %s' % (len(rows), out_path))
print('列说明：蓝=样本信息 黄=人工盲审填写列（先填） 灰=judge对照列（盲审完后对答案）')
PYX
