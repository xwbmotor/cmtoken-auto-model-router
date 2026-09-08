import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
test('release receive validates corruption, resume, final hash and rejects traversal or duplicate chunks', () => {
  const code = String.raw`
import importlib.util, tempfile, json, hashlib
from pathlib import Path
spec = importlib.util.spec_from_file_location('receive', 'scripts/receive-release.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as d:
    root = Path(d); payload = b'release-evidence'
    sha = hashlib.sha256(payload).hexdigest(); name = 'chunk-00000-' + sha[:16]
    plan = {'name': 'image.tar.gz', 'sha256': sha, 'bytes': len(payload), 'chunks': [{'name': name, 'sha256': sha, 'bytes': len(payload)}]}
    (root / 'transfer-plan.json').write_text(json.dumps(plan))
    assert m.process(root)['missing'] == [name]
    (root / name).write_bytes(b'corrupt')
    assert m.process(root)['missing'] == [name]
    try: m.process(root, True); raise RuntimeError('accepted corruption')
    except AssertionError: pass
    (root / name).write_bytes(payload)
    assert m.process(root)['missing'] == []
    assert m.process(root, True)['complete']
    assert (root / 'image.tar.gz').read_bytes() == payload
    assert m.process(root)['complete']
    plan['name'] = '../escape'
    try: m.validate(plan, root); raise RuntimeError('accepted traversal')
    except AssertionError: pass
    plan['name'] = 'image.tar.gz'; plan['chunks'] *= 2
    try: m.validate(plan, root); raise RuntimeError('accepted duplicate')
    except AssertionError: pass
print('verified')
`;
  assert.match(execFileSync('python', ['-c', code], { encoding: 'utf8' }), /verified/);
});
