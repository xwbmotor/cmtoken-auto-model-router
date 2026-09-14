#!/usr/bin/env python3
"""Verify one JSON and one SSE request using an explicitly supplied business key."""
import argparse
import json
from pathlib import Path
import sys
import time
import urllib.error
import urllib.request
import uuid


def verify(root, key_file):
    state = json.loads((root / 'installation.json').read_text())
    key = key_file.read_text(encoding='utf-8').strip()
    if not key or '\n' in key or '\r' in key:
        raise ValueError('Invalid key file')
    bind = state['bind']
    if bind == '0.0.0.0': bind = '127.0.0.1'
    if bind == '::': bind = '::1'
    if ':' in bind: bind = '[' + bind + ']'
    base = 'http://' + bind + ':' + str(state['port'])
    checks = []
    for stream in [False, True]:
        rid = 'install-verify-' + uuid.uuid4().hex
        req = urllib.request.Request(base + '/v1/chat/completions',
            data=json.dumps({'messages': [{'role': 'user', 'content': 'Reply with the number 42.'}],
                'max_tokens': 128, 'stream': stream}).encode(),
            headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json', 'X-Request-ID': rid})
        with urllib.request.urlopen(req, timeout=90) as response:
            raw = response.read(2 * 1024 * 1024).decode()
            if response.status != 200: raise ValueError('Request failed')
            if stream:
                if raw.count('data: [DONE]') != 1 or not raw.rstrip().endswith('[DONE]'):
                    raise ValueError('Incomplete SSE response')
                events = [json.loads(line[6:]) for line in raw.splitlines() if line.startswith('data: ') and line != 'data: [DONE]']
                if not any(c.get('delta', {}).get('content') for e in events for c in e.get('choices', [])):
                    raise ValueError('SSE contained no answer')
            elif not any(c.get('message', {}).get('content') for c in json.loads(raw).get('choices', [])):
                raise ValueError('JSON contained no answer')
        checks.append({'requestId': rid, 'stream': stream, 'httpStatus': 200, 'complete': True})
    deadline = time.monotonic() + 20
    while True:
        counts = {item['requestId']: 0 for item in checks}
        for path in sorted((root / 'data/decisions').glob('decisions-*.jsonl'))[-3:]:
            with path.open(encoding='utf-8') as f:
                for line in f:
                    try: row = json.loads(line)
                    except json.JSONDecodeError: continue
                    rid = row.get('request', {}).get('requestId')
                    if rid in counts: counts[rid] += 1
        if all(value == 1 for value in counts.values()): break
        if time.monotonic() > deadline: raise ValueError('Decision records missing or duplicated')
        time.sleep(.5)
    result = {'passed': True, 'requests': checks, 'decisionRecordsExactlyOnce': True,
              'modelQualityVerified': False, 'backgroundReviewVerified': False}
    # Contains only opaque IDs and status, never keys or model answers.
    (root / 'business-verification.json').write_text(json.dumps(result, indent=2)+'\n',encoding='utf-8')
    return result


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root', type=Path, default=Path('/opt/amr'))
    p.add_argument('--key-file', type=Path, required=True)
    args = p.parse_args()
    try: print(json.dumps(verify(args.root,args.key_file)))
    except Exception:
        print('Business verification failed. Check local service logs and caller permissions; key and response are not printed.',file=sys.stderr)
        sys.exit(1)
