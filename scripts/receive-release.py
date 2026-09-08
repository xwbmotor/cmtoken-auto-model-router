"""Validate resumable release chunks and assemble atomically; never deploy."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import os

def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for part in iter(lambda: f.read(1024 * 1024), b''):
            h.update(part)
    return h.hexdigest()

def validate(plan, directory):
    assert re.fullmatch(r'[A-Za-z0-9_.-]+', plan['name']) and plan['name'] not in ['.', '..']
    assert re.fullmatch(r'[a-f0-9]{64}', plan['sha256'])
    assert 0 < plan['bytes'] <= 4 * 1024 ** 3
    assert 0 < len(plan['chunks']) <= 2048
    names = set()
    for chunk in plan['chunks']:
        assert re.fullmatch(r'chunk-[0-9]{5}-[a-f0-9]{16}', chunk['name']) and chunk['name'] not in names
        names.add(chunk['name'])
        assert 0 < chunk['bytes'] <= 2 * 1024 ** 2
        assert re.fullmatch(r'[a-f0-9]{64}', chunk['sha256'])
        assert (directory / chunk['name']).resolve().parent == directory.resolve()
    assert sum(c['bytes'] for c in plan['chunks']) == plan['bytes']
    assert (directory / plan['name']).resolve().parent == directory.resolve()

def process(directory, assemble=False):
    directory = directory.resolve()
    plan = json.loads((directory / 'transfer-plan.json').read_text())
    validate(plan, directory)
    target = directory / plan['name']
    if target.is_file() and target.stat().st_size == plan['bytes'] and digest(target) == plan['sha256']:
        return {'complete': True, 'missing': []}
    missing = [c['name'] for c in plan['chunks'] if not (directory / c['name']).is_file() or (directory / c['name']).stat().st_size != c['bytes'] or digest(directory / c['name']) != c['sha256']]
    if assemble:
        assert not missing, 'Missing or corrupt release chunks'
        temporary = directory / (plan['name'] + '.assembling')
        assert temporary.resolve().parent == directory
        with temporary.open('wb') as out:
            for c in plan['chunks']:
                out.write((directory / c['name']).read_bytes())
        assert temporary.stat().st_size == plan['bytes'] and digest(temporary) == plan['sha256'], 'Final checksum mismatch'
        os.replace(temporary, target)
        for c in plan['chunks']:
            (directory / c['name']).unlink()
        return {'complete': True, 'missing': [], 'bytes': plan['bytes'], 'sha256': plan['sha256']}
    return {'complete': False, 'missing': missing}

if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('directory', type=Path)
    p.add_argument('--assemble', action='store_true')
    a = p.parse_args()
    assert a.directory.resolve().is_relative_to(Path('/tmp/amr-up')), 'Receive target outside release staging'
    print(json.dumps(process(a.directory, a.assemble)))
