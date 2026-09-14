#!/usr/bin/env python3
"""Initialize a fresh Linux installation without an existing Node service."""
import argparse
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit

# The bundle includes this module next to the installer.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'go-core/deployment'))
from native_compose import build, escape_interpolation

HERE = Path(__file__).resolve().parent
class InstallError(Exception):
    pass


IMAGES = ('cmt-auto-model-router', 'cmt-amr-classifier', 'cmt-amr-go')


def run(args, timeout=180):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        # Docker/Compose errors can contain expanded credentials.
        raise InstallError('Command failed: ' + ' '.join(args[:3]) + '; inspect service status locally.')
    return result.stdout


def sha(path):
    with path.open('rb') as f:
        digest = hashlib.sha256()
        for block in iter(lambda: f.read(1024 * 1024), b''):
            digest.update(block)
        return digest.hexdigest()


def manifest(path):
    value = json.loads(path.read_text(encoding='utf-8'))
    if not re.fullmatch(r'\d+\.\d+\.\d+', value['version']) or not re.fullmatch('[0-9a-f]{40}', value['revision']):
        raise InstallError('Invalid release identity')
    if set(value['images']) != set(IMAGES):
        raise InstallError('Exactly three release images required')
    for name, item in value['images'].items():
        if item['archive'] != name + '-' + value['version'] + '.tar.gz':
            raise InstallError('Invalid archive name')
        if not re.fullmatch('[0-9a-f]{64}', item['sha256']):
            raise InstallError('Invalid archive hash')
        if not item['ids'] or any(not re.fullmatch('sha256:[0-9a-f]{64}', i) for i in item['ids']):
            raise InstallError('Invalid image identity')
    return value


def inspect_image(name, release):
    image = json.loads(run(['docker', 'image', 'inspect', name + ':' + release['version']]))[0]
    expected = release['images'][name]
    if image['Id'] not in expected['ids'] or image.get('Config', {}).get('Labels', {}).get('org.opencontainers.image.revision') != release['revision']:
        raise InstallError('Image identity mismatch: ' + name)
    if image.get('Os') != 'linux' or image.get('Architecture') != release['architecture']:
        raise InstallError('Image platform mismatch: ' + name)
    return image['Id']


def prerequisites(release):
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise InstallError('Run on Linux with sudo; Docker Engine and Compose v2 are required')
    arch = run(['docker', 'info', '--format', '{{.Architecture}}']).strip()
    if {'x86_64': 'amd64', 'aarch64': 'arm64'}.get(arch, arch) != release['architecture']:
        raise InstallError('This release does not match the Docker server architecture')
    version = run(['docker', 'compose', 'version', '--short']).strip().lstrip('v')
    if not re.match(r'[2-9]\.', version):
        raise InstallError('Docker Compose v2 or newer required')


def load_images(bundle, release):
    # Validate every input before the first Docker mutation.
    for name, item in release['images'].items():
        path = bundle / 'images' / item['archive']
        if path.is_symlink() or not path.is_file() or sha(path) != item['sha256']:
            raise InstallError('Missing or damaged archive: ' + item['archive'])
        existing = subprocess.run(['docker', 'image', 'inspect', name + ':' + release['version']], capture_output=True)
        if existing.returncode == 0:
            inspect_image(name, release)  # Refuse to replace another image under the same tag.
    for name, item in release['images'].items():
        run(['docker', 'load', '-i', str(bundle / 'images' / item['archive'])], timeout=600)
        inspect_image(name, release)
    return {'imagesLoaded': 3, 'version': release['version']}


def validate_target(root):
    if not root.is_absolute() or root == Path('/') or root.exists() or root.is_symlink():
        raise InstallError('Installation directory must be an absolute, new path')
    if root.resolve() != root or not root.parent.is_dir():
        raise InstallError('Parent directory must exist and path must not traverse symlinks')
    if not re.fullmatch(r'/[a-zA-Z0-9_./-]+', str(root)):
        raise InstallError('Use a directory without spaces, commas or special characters')


def protected(path, data, owner=False):
    with path.open('x', encoding='utf-8') as f:
        os.chmod(path, 0o600)
        f.write(data)
    if owner:
        os.chown(path, 1000, 1000)


def write_json(path, value, owner=False):
    protected(path, json.dumps(value, ensure_ascii=False, indent=2) + '\n', owner)


def initialize(root, config_path, upstream, release, project, bind, port, ca_cert=None):
    validate_target(root)
    if not re.fullmatch('[a-z][a-z0-9-]{0,39}', project):
        raise InstallError('Project must use lowercase letters, numbers and hyphens')
    ipaddress.ip_address(bind)
    if not 1 <= port <= 65535:
        raise InstallError('Invalid port')
    endpoint = urlsplit(upstream)
    if endpoint.scheme != 'https' or not endpoint.hostname or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment:
        raise InstallError('Use an HTTPS upstream base URL without credentials, query or fragment')
    if endpoint.hostname.endswith('.invalid'):
        raise InstallError('Replace the example upstream with your real endpoint')
    existing = run(['docker', 'ps', '-aq', '--filter', 'label=com.docker.compose.project=' + project]).strip()
    if existing:
        raise InstallError('Compose project already exists; choose a different project')
    for suffix in ['node', 'classifier', 'go']:
        names = run(['docker', 'ps', '-aq', '--filter', 'name=^/' + project + '-' + suffix + '$']).strip()
        if names:
            raise InstallError('Container name already exists')
    images = {name: inspect_image(name, release) for name in IMAGES}
    config = json.loads(config_path.read_text(encoding='utf-8-sig'))
    if config.get('budget', {}).get('enabled') is not False:
        raise InstallError('This installation requires budget.enabled=false')
    if any(m.get('id') == 'replace-with-your-model' for m in config.get('models', [])):
        raise InstallError('Replace the sample model ID and matching routing references before initialization')
    config['version'] = release['version']
    config['upstreamBaseUrl'] = upstream.rstrip('/')
    # Local classifier is always reachable in the shared network namespace.
    if config.get('semanticRouter', {}).get('httpJson'):
        config['semanticRouter']['httpJson']['url'] = 'http://127.0.0.1:8788/classify'
    tokens = {key: secrets.token_urlsafe(48) for key in ['admin', 'metrics', 'bucket', 'edge', 'goAdmin']}
    env = {'NODE_ENV': 'production', 'ROUTER_KEY_MODE': 'passthrough', 'MAAS_BASE_URL': upstream.rstrip('/'),
           'ADMIN_TOKEN': tokens['admin'], 'METRICS_TOKEN': tokens['metrics'], 'SEMANTIC_BUCKET_SECRET': tokens['bucket'],
           'SEMANTIC_CLASSIFIER_URL': 'http://127.0.0.1:8788/classify', 'TZ': 'Asia/Shanghai'}
    source = {'name': project, 'services': {
        'auto-model-router': {'image': IMAGES[0] + ':' + release['version'], 'container_name': project + '-node',
            'environment': env, 'ports': [{'target': 8787, 'published': str(port), 'host_ip': bind, 'protocol': 'tcp'}],
            'depends_on': {'classifier': {'condition': 'service_healthy'}}, 'restart': 'unless-stopped', 'stop_grace_period': '30s',
            'logging': {'driver': 'json-file', 'options': {'max-size': '20m', 'max-file': '3'}},
            'volumes': [{'type': 'bind', 'source': '/opt/amr/' + n, 'target': '/app/' + n} for n in ['config', 'data']]},
        'classifier': {'image': IMAGES[1] + ':' + release['version'], 'container_name': project + '-classifier',
            'hostname': 'classifier', 'restart': 'unless-stopped',
            'logging': {'driver': 'json-file', 'options': {'max-size': '20m', 'max-file': '2'}}}}}
    compose = build(source, release['version'], upstream, tokens['edge'], tokens['goAdmin'],
                    config.get('semanticRouter', {}).get('httpJson', {}).get('token', ''), budget_enabled=False)
    compose['services']['go-core']['container_name'] = project + '-go'
    for service in compose['services'].values():
        for mount in service.get('volumes', []):
            mount['source'] = str(root) + mount['source'][len('/opt/amr'):]
    if ca_cert:
        if not ca_cert.is_file():
            raise InstallError('CA certificate file missing')
        compose['services']['auto-model-router']['environment']['NODE_EXTRA_CA_CERTS'] = '/app/config/upstream-ca.pem'
        compose['services']['go-core']['environment']['SSL_CERT_FILE'] = '/app/config/upstream-ca.pem'
    # Generate in a private sibling; publish only once every check passes.
    stage = Path(tempfile.mkdtemp(prefix='.' + root.name + '-install-', dir=root.parent))
    try:
        for name in ['config', 'data', 'data/go-native-' + release['version']]:
            directory = stage / name
            directory.mkdir(mode=0o750)
            os.chown(directory, 1000, 1000)
        write_json(stage / 'config/router.json', config, owner=True)
        write_json(stage / 'config/go-auth.json', {'mode': 'passthrough', 'adminToken': tokens['goAdmin']}, owner=True)
        if ca_cert:
            protected(stage / 'config/upstream-ca.pem', ca_cert.read_text(), owner=True)
        write_json(stage / 'credentials.json', {'ADMIN_TOKEN': tokens['admin'], 'METRICS_TOKEN': tokens['metrics']})
        write_json(stage / 'compose.json', escape_interpolation(compose))
        run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
             '--security-opt', 'no-new-privileges:true', '--user', '1000:1000',
             '--mount', 'type=bind,src=' + str(stage / 'config') + ',dst=/staged',
             '--entrypoint', 'node', images[IMAGES[0]], '--input-type=module', '-e',
             "import {loadConfig} from './src/config.mjs';import {encodeSnapshot,atomicSnapshot} from './src/go-runtime/snapshot.mjs';"
             "process.env.CONFIG_PATH='/staged/router.json';await atomicSnapshot('/staged/go-runtime.json',encodeSnapshot(await loadConfig()).data);"])
        run(['docker', 'compose', '--project-name', project, '-f', str(stage / 'compose.json'), 'config', '--quiet'])
        write_json(stage / 'installation.json', {'version': release['version'], 'revision': release['revision'],
            'images': images, 'project': project, 'root': str(root), 'bind': bind, 'port': port, 'initialized': True})
        if root.exists() or root.is_symlink():
            raise InstallError('Installation target appeared during initialization')
        stage.rename(root)
    finally:
        if stage.exists():
            shutil.rmtree(stage)  # Only our mkdtemp sibling, never a pre-existing installation.
    return {'initialized': True, 'root': str(root), 'started': False, 'credentialsFile': str(root / 'credentials.json')}


def manage(root, action, release):
    state = json.loads((root / 'installation.json').read_text())
    if state['root'] != str(root.resolve()):
        raise InstallError('Installation was moved; mounted paths must be reviewed first')
    if state['revision'] != release['revision'] or state['version'] != release['version']:
        raise InstallError('Installation and release manifest differ')
    if action == 'start':
        for name in IMAGES:
            if inspect_image(name, release) != state['images'][name]:
                raise InstallError('Installed image identity changed')
    command = ['docker', 'compose', '--project-name', state['project'], '-f', str(root / 'compose.json')]
    if action == 'start':
        run(command + ['up', '-d', '--pull', 'never', '--wait', '--wait-timeout', '120'], timeout=180)
    elif action == 'stop':
        run(command + ['stop', 'go-core'])
        run(command + ['stop', 'auto-model-router', 'classifier'])
    ids = run(command + ['ps', '-aq']).split()
    containers = json.loads(run(['docker', 'inspect', *ids])) if ids else []
    result = {c['Config']['Labels']['com.docker.compose.service']: {
        'status': c['State']['Status'], 'health': c['State'].get('Health', {}).get('Status', 'unavailable')}
        for c in containers}
    if action in ['start', 'check'] and (len(result) != 3 or any(c['health'] != 'healthy' for c in result.values())):
        raise InstallError('Three healthy services required; use Docker Compose logs locally')
    if action in ['start', 'check']:
        roles = {'auto-model-router': IMAGES[0], 'classifier': IMAGES[1], 'go-core': IMAGES[2]}
        if set(result) != set(roles):
            raise InstallError('Unexpected Compose services')
        for item in containers:
            role = item['Config']['Labels']['com.docker.compose.service']
            if item['Image'] != state['images'][roles[role]]:
                raise InstallError('Running image differs from installation record')
    return {'action': action, 'services': result, 'businessRequestsVerified': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['load-images', 'init', 'start', 'check', 'stop'])
    parser.add_argument('--manifest', type=Path, default=HERE / 'release.json')
    parser.add_argument('--bundle', type=Path, default=HERE)
    parser.add_argument('--root', type=Path, default=Path('/opt/amr'))
    parser.add_argument('--config', type=Path)
    parser.add_argument('--upstream')
    parser.add_argument('--project', default='amr')
    parser.add_argument('--bind', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8787)
    parser.add_argument('--ca-cert', type=Path)
    args = parser.parse_args()
    try:
        release = manifest(args.manifest)
        prerequisites(release)
        if args.action == 'load-images':
            result = load_images(args.bundle, release)
        elif args.action == 'init':
            if not args.config or not args.upstream:
                raise InstallError('init requires --config and --upstream')
            result = initialize(args.root, args.config, args.upstream, release, args.project, args.bind, args.port, args.ca_cert)
        else:
            result = manage(args.root, args.action, release)
        print(json.dumps(result, ensure_ascii=False))
    except InstallError as error:
        print(str(error), file=sys.stderr)
        return 1
    except (ValueError, OSError, KeyError, subprocess.SubprocessError):
        # Deliberately do not print config values, subprocess stderr or tracebacks.
        print('Installation step failed. Check arguments, image identity, directory permissions and local Docker status. Existing installations are not overwritten.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
