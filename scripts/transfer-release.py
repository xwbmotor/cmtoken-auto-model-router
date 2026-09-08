"""Resume checksummed 2 MiB chunks using four bounded SCP connections."""
import argparse
import concurrent.futures
import hashlib
import json
from pathlib import Path
import re
import subprocess
import time

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--file', type=Path, required=True)
    p.add_argument('--version', required=True)
    p.add_argument('--host', required=True)
    p.add_argument('--identity', type=Path, required=True)
    a = p.parse_args()
    assert re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', a.version)
    assert re.fullmatch(r'[a-zA-Z0-9_.@-]+', a.host) and not a.host.startswith('-')
    assert re.fullmatch(r'[a-zA-Z0-9_.-]+', a.file.name)
    directory = a.file.resolve().parent / 'transfer-chunks'
    directory.mkdir(exist_ok=True)
    plan = {'name': a.file.name, 'bytes': a.file.stat().st_size, 'chunks': []}
    assert 0 < plan['bytes'] <= 4 * 1024 ** 3
    sha = hashlib.sha256()
    with a.file.open('rb') as source:
        for i, chunk in enumerate(iter(lambda: source.read(2 * 1024 ** 2), b'')):
            sha.update(chunk)
            checksum = hashlib.sha256(chunk).hexdigest()
            name = f'chunk-{i:05d}-{checksum[:16]}'
            (directory / name).write_bytes(chunk)
            plan['chunks'].append({'name': name, 'bytes': len(chunk), 'sha256': checksum})
    plan['sha256'] = sha.hexdigest()
    (directory / 'transfer-plan.json').write_text(json.dumps(plan), encoding='utf-8')
    remote = '/tmp/amr-up/' + a.version
    common = ['-i', str(a.identity), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=15']
    ssh = ['ssh', *common, a.host]
    scp = ['scp', '-O', '-q', *common]
    subprocess.run([*ssh, 'mkdir -p ' + remote], check=True, timeout=40)
    subprocess.run([*scp, str(directory / 'transfer-plan.json'), str(Path(__file__).with_name('receive-release.py')), a.host + ':' + remote + '/'], check=True, timeout=60)
    def status(assemble=False):
        return json.loads(subprocess.check_output([*ssh, 'python3 ' + remote + '/receive-release.py ' + remote + (' --assemble' if assemble else '')], timeout=120))
    state = status()
    start = time.monotonic()
    def upload(name):
        for attempt in range(2):
            try:
                result = subprocess.run([*scp, str(directory / name), a.host + ':' + remote + '/' + name], timeout=120)
            except subprocess.TimeoutExpired:
                continue
            if result.returncode == 0:
                return
        raise RuntimeError('Chunk upload failed: ' + name)
    if not state['complete']:
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(upload, state['missing']))
        state = status(True)
    assert state['complete']
    for c in plan['chunks']:
        (directory / c['name']).unlink()
    result = {**state, 'transferSeconds': round(time.monotonic() - start, 3), 'chunks': len(plan['chunks']), 'sha256': plan['sha256']}
    (directory / 'result.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps(result))

if __name__ == '__main__':
    main()
