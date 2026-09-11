"""Prepare the first native-front Compose specification; never deploy it.

Read resolved Compose JSON and fresh internal tokens from stdin. The output is
exclusive, mode 0600, because resolved environment values contain credentials.
The operator must separately bootstrap the matching snapshot/auth files and
preserve the original Compose/configuration before applying this specification.
"""
import argparse
import copy
import json
import os
import re
import sys
from urllib.parse import urlsplit


def build(source, version, upstream, edge_token, admin_token, small_token='', *, budget_enabled):
    if budget_enabled is not False:
        raise ValueError('disabled_budget_required')
    if not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise ValueError('invalid_version')
    endpoint = urlsplit(upstream)
    if (endpoint.scheme != 'https' or not endpoint.hostname or endpoint.username or
            endpoint.password or endpoint.query or endpoint.fragment):
        raise ValueError('invalid_upstream')
    if min(len(edge_token), len(admin_token)) < 32:
        raise ValueError('internal_tokens_required')
    result = copy.deepcopy(source)
    services = result['services']
    if 'go-core' in services:
        raise ValueError('initial_cutover_only')
    node, classifier = services['auto-model-router'], services['classifier']
    if (not node['image'].startswith('cmt-auto-model-router:') or
            not classifier['image'].startswith('cmt-amr-classifier:')):
        raise ValueError('unexpected_source_images')
    if node.get('network_mode') or node.get('networks') != classifier.get('networks'):
        raise ValueError('incompatible_source_networks')
    ports = node.get('ports', [])
    if not ports or classifier.get('ports') or any(p.get('target') != 8787 for p in ports):
        raise ValueError('unexpected_source_ports')
    env = node.setdefault('environment', {})
    if env.get('ROUTER_KEY_MODE', 'passthrough') != 'passthrough' or len(env.get('SEMANTIC_BUCKET_SECRET', '')) < 32:
        raise ValueError('source_auth_contract_mismatch')
    mounts = {v.get('target'): v for v in node.get('volumes', [])}
    for target, expected in [('/app/config', '/opt/amr/config'), ('/app/data', '/opt/amr/data')]:
        if mounts.get(target, {}).get('type') != 'bind' or mounts[target].get('source') != expected:
            raise ValueError('unexpected_source_mounts')
    node.update(image='cmt-auto-model-router:' + version, network_mode='service:classifier')
    node.pop('ports')
    node.pop('networks', None)
    node.pop('hostname', None)
    node['depends_on'] = {**node.get('depends_on', {}), 'go-core': {'condition': 'service_healthy'}}
    env.update(HOST='127.0.0.1', PORT='8789', AMR_GO_NATIVE_FRONT='1',
               AMR_GO_CHAT_URL='http://127.0.0.1:8791/v1/chat/completions',
               AMR_GO_ADMIN_URL='http://127.0.0.1:8791', AMR_GO_ADMIN_TOKEN=admin_token,
               AMR_GO_EDGE_TOKEN=edge_token, AMR_GO_RUNTIME_CONFIG='/app/config/go-runtime.json')
    node['healthcheck'] = {**node.get('healthcheck', {}), 'test': ['CMD', 'node', '-e',
        "fetch('http://127.0.0.1:8789/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]}
    classifier.update(image='cmt-amr-classifier:' + version, ports=ports)
    config_mount = copy.deepcopy(mounts['/app/config'])
    config_mount['read_only'] = True
    services['go-core'] = {
        'image': 'cmt-amr-go:' + version, 'container_name': 'amr-go-core',
        'restart': 'unless-stopped', 'network_mode': 'service:classifier',
        'depends_on': {'classifier': {'condition': 'service_healthy'}},
        'user': '1000:1000', 'read_only': True, 'cap_drop': ['ALL'],
        'security_opt': ['no-new-privileges:true'], 'pids_limit': 128,
        'cpus': 2, 'mem_limit': '512m', 'stop_grace_period': '30s',
        'environment': {'AMR_GO_EDGE_URL': 'http://127.0.0.1:8789/internal/v1/go-events',
                        'AMR_GO_EDGE_TOKEN': edge_token,
                        'AMR_GO_SEMANTIC_BUCKET_SECRET': env['SEMANTIC_BUCKET_SECRET'],
                        'AMR_GO_SEMANTIC_SMALL_TOKEN': small_token},
        'volumes': [config_mount, {'type': 'bind', 'source': '/opt/amr/data/go-native-' + version, 'target': '/state'}],
        'command': ['--candidate', '--runtime', '--native-semantics', '--node-cost-observation',
                    '--runtime-config', '/app/config/go-runtime.json', '--auth-config', '/app/config/go-auth.json',
                    '--ledger', '/state/runtime.wal', '--listen', '127.0.0.1:8791',
                    '--public-listen', '0.0.0.0:8787', '--node-origin', 'http://127.0.0.1:8789',
                    '--upstream', upstream.rstrip('/') + '/chat/completions',
                    '--scope-url', upstream.rstrip('/') + '/models',
                    '--semantic-small', 'http://127.0.0.1:8788/classify',
                    '--semantic-large', upstream.rstrip('/') + '/chat/completions', '--timeout', '50s'],
        'logging': {'driver': 'json-file', 'options': {'max-size': '10m', 'max-file': '3'}},
    }
    return result


def escape_interpolation(value):
    # Resolved Compose values must not be interpolated a second time. This also
    # preserves literal dollar signs in credentials and user-defined settings.
    if isinstance(value, str):
        return value.replace('$', '$$')
    if isinstance(value, list):
        return [escape_interpolation(v) for v in value]
    if isinstance(value, dict):
        return {escape_interpolation(k): escape_interpolation(v) for k, v in value.items()}
    return value


def decode_config_output(value):
    # Compose 2.x config.go escapeDollarSign doubles every dollar when rendering
    # interpolated JSON. Undo that rendering exactly once before adding tokens.
    # https://github.com/docker/compose/blob/v2.32.1/cmd/compose/config.go
    if isinstance(value, str):
        if '$' in value.replace('$$', ''):
            raise ValueError('expected_interpolated_compose_config_output')
        return value.replace('$$', '$')
    if isinstance(value, list):
        return [decode_config_output(v) for v in value]
    if isinstance(value, dict):
        return {decode_config_output(k): decode_config_output(v) for k, v in value.items()}
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    payload = json.load(sys.stdin)
    result = build(decode_config_output(payload['compose']), payload['version'], payload['upstream'],
                   payload['edgeToken'], payload['adminToken'], payload.get('smallToken', ''),
                   budget_enabled=payload['budgetEnabled'])
    fd = os.open(args.out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as out:
        json.dump(escape_interpolation(result), out, ensure_ascii=False, indent=2)
        out.write('\n')
        out.flush()
        os.fsync(out.fileno())
    print(json.dumps({'prepared': True, 'version': payload['version'], 'deployed': False}))


if __name__ == '__main__':
    main()
