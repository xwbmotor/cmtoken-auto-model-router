"""Build release images; reuse classifier only after comparing actual image files."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile
import time

ROOT = Path(__file__).resolve().parents[1]
INPUTS = ['Dockerfile.classifier', 'requirements-classifier.lock', 'scripts/classifier_common.py', 'scripts/serve_classifier.py', 'data/training/model']

def run(*args, **kwargs):
    return subprocess.check_output(args, cwd=ROOT, **kwargs)

def inspect(tag):
    return json.loads(run('docker', 'image', 'inspect', tag))[0]

def runtime_files():
    paths = []
    for name in INPUTS:
        path = ROOT / name
        if path.is_symlink():
            raise ValueError('Classifier input symlink is not reusable')
        paths.extend(path.rglob('*') if path.is_dir() else [path])
    if any(p.is_symlink() for p in paths):
        raise ValueError('Classifier input symlink is not reusable')
    return {p.relative_to(ROOT).as_posix(): p.read_bytes() for p in paths if p.is_file()}

def verify_base(base, files):
    info = base['images']['classifier']
    actual = inspect(info['tag'])
    assert actual['Id'] == info['id'], 'Base image digest changed'
    assert actual['RootFS']['Layers'] == info['rootfsLayers'], 'Base rootfs changed'
    assert actual['Config']['Labels']['org.opencontainers.image.revision'] == base['commit'], 'Base revision mismatch'
    old_dockerfile = run('git', 'show', base['commit'] + ':Dockerfile.classifier')
    assert old_dockerfile.replace(b'\r\n', b'\n') == files['Dockerfile.classifier'].replace(b'\r\n', b'\n'), 'Dockerfile changed'
    container = run('docker', 'create', info['tag']).decode().strip()
    try:
        actual_files = {}
        for name in ['requirements-classifier.lock', 'scripts', 'data/training/model']:
            archive = run('docker', 'cp', container + ':/app/' + name, '-')
            prefix = str(Path(name).parent).replace('\\', '/')
            with tarfile.open(fileobj=io.BytesIO(archive)) as source:
                for item in source.getmembers():
                    assert not item.issym() and not item.islnk(), 'Image input symlink'
                    if item.isfile():
                        path = (Path(prefix) / item.name).as_posix()
                        actual_files[path] = source.extractfile(item).read()
        expected = {k: v for k, v in files.items() if k != 'Dockerfile.classifier'}
        assert expected == actual_files, 'Runtime file bytes or file set changed'
    finally:
        subprocess.run(['docker', 'rm', container], cwd=ROOT, check=True, stdout=subprocess.DEVNULL)
    return actual

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-manifest', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--fresh-classifier', action='store_true')
    args = parser.parse_args()
    revision = run('git', 'rev-parse', 'HEAD').decode().strip()
    version = json.loads((ROOT / 'package.json').read_text())['version']
    files = runtime_files()
    hashes = {k: hashlib.sha256(v).hexdigest() for k, v in sorted(files.items())}
    inputs_sha = hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest()
    proof = {'revision': revision, 'version': version, 'classifierInputs': hashes, 'inputsSha256': inputs_sha}
    base = json.loads(args.base_manifest.read_text(encoding='utf-8'))
    reusable = None
    if not args.fresh_classifier:
        try:
            reusable = verify_base(base, files)
        except (AssertionError, ValueError, subprocess.CalledProcessError) as error:
            proof['fallbackReason'] = str(error)
    start = time.monotonic()
    router = 'cmt-auto-model-router:' + version
    classifier = 'cmt-amr-classifier:' + version
    subprocess.run(['docker', 'build', '--build-arg', 'GIT_REVISION=' + revision, '--cache-from', base['images']['router']['tag'], '-t', router, '.'], cwd=ROOT, check=True)
    proof['routerBuildSeconds'] = round(time.monotonic() - start, 3)
    start = time.monotonic()
    if reusable:
        dockerfile = 'FROM ' + base['images']['classifier']['tag'] + '\nLABEL org.opencontainers.image.revision="' + revision + '"\n'
        dockerfile += 'LABEL amr.classifier.inputs-sha256="' + inputs_sha + '" amr.classifier.reused-from="' + reusable['Id'] + '"\n'
        subprocess.run(['docker', 'build', '-t', classifier, '-f', '-', '.'], input=dockerfile.encode(), cwd=ROOT, check=True)
        assert inspect(classifier)['RootFS']['Layers'] == reusable['RootFS']['Layers'], 'Reuse changed filesystem'
    else:
        subprocess.run(['docker', 'build', '-f', 'Dockerfile.classifier', '--build-arg', 'GIT_REVISION=' + revision, '--cache-from', base['images']['classifier']['tag'], '-t', classifier, '.'], cwd=ROOT, check=True)
    proof.update(classifierReused=bool(reusable), classifierBuildSeconds=round(time.monotonic() - start, 3))
    release_tags = [router, classifier]
    if 'image: cmt-amr-go:' in (ROOT / 'docker-compose.prod.yml').read_text(encoding='utf-8'):
        go_image = 'cmt-amr-go:' + version
        start = time.monotonic()
        subprocess.run(['docker', 'build', '--build-arg', 'GIT_REVISION=' + revision,
                        '-t', go_image, 'go-core'], cwd=ROOT, check=True)
        proof['goBuildSeconds'] = round(time.monotonic() - start, 3)
        release_tags.append(go_image)
    for tag in release_tags:
        assert inspect(tag)['Config']['Labels']['org.opencontainers.image.revision'] == revision
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(proof, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({k: v for k, v in proof.items() if k != 'classifierInputs'}))

if __name__ == '__main__':
    main()
