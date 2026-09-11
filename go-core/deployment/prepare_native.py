#!/usr/bin/env python3
"""Prepare protected first-cutover files and rollback originals, without applying them.

Run on the deployment host after all three release images have been verified.
The stage must be a new directory beneath /opt/amr. No production file is written.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess

from native_compose import build, decode_config_output, escape_interpolation


def run(args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=180)
    if result.returncode:
        # Expanded Compose errors may contain credentials.
        raise RuntimeError('preparation_subprocess_failed')
    return result.stdout


def protected(path, data, *, owner=False):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as output:
        output.write(data)
        output.flush()
        os.fsync(output.fileno())
    if owner:
        os.chown(path, 1000, 1000)


def prepare(stage, version, revision, *, root=Path('/opt/amr')):
    stage = stage.resolve()
    if stage.parent != root or not stage.name.startswith('native-release-'):
        raise ValueError('invalid_stage')
    if not re.fullmatch(r'\d+\.\d+\.\d+', version) or not re.fullmatch('[0-9a-f]{40}', revision):
        raise ValueError('invalid_release_identity')
    if any((root / 'config' / name).exists() for name in ['go-runtime.json', 'go-auth.json', 'go-runtime.json.pending']):
        raise ValueError('initial_cutover_files_already_exist')
    originals = {name: (path, path.read_bytes()) for name, path in [
        ('compose', root / 'docker-compose.prod.yml'), ('env', root / '.env'),
        ('router', root / 'config/router.json')]}
    images = {}
    for role, prefix in [('node', 'cmt-auto-model-router'), ('classifier', 'cmt-amr-classifier'), ('go', 'cmt-amr-go')]:
        image = json.loads(run(['docker', 'image', 'inspect', prefix + ':' + version]))[0]
        if image.get('Config', {}).get('Labels', {}).get('org.opencontainers.image.revision') != revision:
            raise ValueError('release_image_revision_mismatch')
        images[role] = image['Id']
    source = decode_config_output(json.loads(run(['docker', 'compose', '--env-file', str(root / '.env'),
        '-f', str(root / 'docker-compose.prod.yml'), 'config', '--format', 'json'])))
    node = json.loads(run(['docker', 'inspect', 'auto-model-router']))[0]
    live_env = dict(item.split('=', 1) for item in node['Config']['Env'])
    env = source['services']['auto-model-router'].get('environment', {})
    if any(str(value) != live_env.get(key) for key, value in env.items()):
        raise ValueError('compose_and_live_environment_differ')
    if node['Config']['Image'] != source['services']['auto-model-router']['image']:
        raise ValueError('compose_and_live_image_differ')
    original = originals['router'][1]
    config = json.loads(original)
    upstream = env.get('UPSTREAM_BASE_URL') or env.get('MAAS_BASE_URL') or config.get('upstreamBaseUrl', '')
    edge_token, admin_token = secrets.token_urlsafe(48), secrets.token_urlsafe(48)
    compose = build(source, version, upstream, edge_token, admin_token,
        config.get('semanticRouter', {}).get('httpJson', {}).get('token', ''),
        budget_enabled=config.get('budget', {}).get('enabled'))
    stage.mkdir(mode=0o700)
    for directory in ['rollback', 'config', 'evidence']:
        (stage / directory).mkdir(mode=0o700)
    hashes = {}
    for name, (path, data) in originals.items():
        protected(stage / 'rollback' / name, data)
        hashes[name] = hashlib.sha256(data).hexdigest()
    config['version'] = version
    protected(stage / 'config/router.json', (json.dumps(config, ensure_ascii=False, indent=2) + '\n').encode(), owner=True)
    protected(stage / 'config/go-auth.json', (json.dumps({'mode': 'passthrough', 'adminToken': admin_token}) + '\n').encode(), owner=True)
    protected(stage / 'compose.json', (json.dumps(escape_interpolation(compose), ensure_ascii=False, indent=2) + '\n').encode())
    os.chown(stage / 'config', 1000, 1000)
    # Export using the exact release image, with no network and only staged data.
    run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
         '--security-opt', 'no-new-privileges:true', '--user', '1000:1000',
         '--mount', f'type=bind,src={stage}/config,dst=/staged',
         '--entrypoint', 'node', images['node'], '--input-type=module', '-e',
         "import {loadConfig} from './src/config.mjs';"
         "import {encodeSnapshot,atomicSnapshot} from './src/go-runtime/snapshot.mjs';"
         "process.env.CONFIG_PATH='/staged/router.json';"
         "await atomicSnapshot('/staged/go-runtime.json',encodeSnapshot(await loadConfig()).data);"])
    run(['docker', 'compose', '-f', str(stage / 'compose.json'), 'config', '--quiet'])
    # Refuse a concurrent production configuration change during preparation.
    if any(path.read_bytes() != data for path, data in originals.values()):
        raise ValueError('production_config_changed_during_preparation')
    manifest = {'version': version, 'revision': revision, 'images': images,
                'originalSha256': hashes, 'prepared': True, 'applied': False}
    protected(stage / 'evidence/prepare.json', (json.dumps(manifest, indent=2) + '\n').encode())
    print(json.dumps(manifest))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage', required=True, type=Path)
    parser.add_argument('--version', required=True)
    parser.add_argument('--revision', required=True)
    args = parser.parse_args()
    prepare(args.stage, args.version, args.revision)
