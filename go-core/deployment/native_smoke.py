#!/usr/bin/env python3
"""CI-only first native cutover and rollback with synthetic TLS upstream/data."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
import urllib.error
import urllib.request

from prepare_native import prepare


REPO = Path(__file__).resolve().parents[2]
ROOT = Path('/opt/amr')


def run(args):
    subprocess.run(args, check=True, timeout=240, cwd=REPO)


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    os.chown(path, 1000, 1000)
    os.chmod(path, 0o600)


def request(path, body=None):
    headers = {'Authorization': 'Bearer fixture-service-key', 'Content-Type': 'application/json'}
    if body:
        headers['X-Request-ID'] = body.pop('_fixtureId')
    return urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8787' + path,
        headers=headers, data=None if body is None else json.dumps(body).encode()), timeout=20)


def probe(phase, expected):
    with request('/health/ready') as response:
        assert response.status == 200
    for stream in [False, True]:
        request_id = 'native-topology-' + phase + '-' + str(stream)
        body = {'_fixtureId': request_id, 'messages': [{'role': 'user', 'content': 'Extract number 42.'}],
                'max_tokens': 128, 'stream': stream}
        with request('/v1/chat/completions', body) as response:
            raw = response.read().decode()
            assert 'fixture-ok' in raw
            if stream:
                assert raw.count('[DONE]') == 1 and raw.rstrip().endswith('[DONE]')
        expected.append(request_id)
    time.sleep(.3)


def main():
    revision = os.environ.get('GITHUB_SHA', '')
    if os.environ.get('GITHUB_ACTIONS') != 'true' or not re.fullmatch('[0-9a-f]{40}', revision) or ROOT.exists():
        raise RuntimeError('fresh_GitHub_runner_required')
    evidence = REPO / 'data/go-native-deployment'
    evidence.mkdir(parents=True, exist_ok=False)
    ROOT.mkdir(mode=0o755)
    for name in ['config', 'data']:
        (ROOT / name).mkdir(mode=0o700)
        os.chown(ROOT / name, 1000, 1000)
    compose_path = ROOT / 'docker-compose.prod.yml'
    compose = ['docker', 'compose', '--env-file', str(ROOT / '.env'), '-f', str(compose_path)]
    try:
        run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
             '-subj', '/CN=classifier', '-addext', 'subjectAltName=DNS:classifier,IP:127.0.0.1',
             '-keyout', str(ROOT / 'config/tls-key.pem'), '-out', str(ROOT / 'config/tls-cert.pem')])
        for path in (ROOT / 'config').iterdir():
            os.chown(path, 1000, 1000)
            os.chmod(path, 0o600)
        config = json.loads((REPO / 'config/router.json').read_text(encoding='utf-8'))
        config['version'] = '0.0.0'
        config['upstreamBaseUrl'] = 'https://classifier:8790/v1'
        config['budget'].update(enabled=False, ledgerPath='./data/budget-ledger.json')
        config['semanticRouter']['enabled'] = False
        config['judge'].update(enabled=False, taskCheckEnabled=False)
        config['rateLimit']['enabled'] = False
        config['calibration']['enabled'] = False
        config['routing'].update(mode='active', activeTrafficPercent=100, qualityFloor=0, taskPreferences={})
        config['routing']['latencyObservation'] = {'mode': 'off', 'probes': {'enabled': False}}
        model = config['models'] = [next(m for m in config['models'] if m['enabled'])]
        model[0]['minimumCompletionTokensForReliableAnswer'] = 0
        model[0]['benchmarkScores'] = None
        model[0]['pricingYuanPerMillionTokens'] = {'input': 1, 'output': 2}
        config['routing']['defaultExplicitModel'] = config['routing']['shadowModel'] = model[0]['id']
        config['routing']['loadBalancing'] = {'enabled': True, 'penaltyWeight': .2, 'limits': {model[0]['id']: 16}}
        config['semanticRouter']['model'] = model[0]['id']
        if 'openaiChat' in config['semanticRouter']:
            config['semanticRouter']['openaiChat']['model'] = model[0]['id']
        write(ROOT / 'config/router.json', config)
        (ROOT / '.env').write_text('FIXTURE_ONLY=true\n')
        run(['docker', 'build', '--build-arg', 'GIT_REVISION=' + revision, '-t', 'cmt-auto-model-router:0.0.1', '.'])
        run(['docker', 'tag', 'cmt-auto-model-router:0.0.1', 'cmt-auto-model-router:0.0.0'])
        mock_dockerfile = evidence / 'Dockerfile.mock'
        mock_dockerfile.write_text('FROM cmt-auto-model-router:0.0.1\nCOPY go-core/deployment/native_mock.mjs /mock.mjs\nENTRYPOINT ["node","/mock.mjs"]\nHEALTHCHECK --interval=2s --timeout=2s --retries=20 CMD node -e "fetch(\'http://127.0.0.1:8788/health\').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"\n')
        run(['docker', 'build', '-f', str(mock_dockerfile), '-t', 'cmt-amr-classifier:0.0.1', '.'])
        run(['docker', 'tag', 'cmt-amr-classifier:0.0.1', 'cmt-amr-classifier:0.0.0'])
        run(['docker', 'build', '--build-arg', 'GIT_REVISION=' + revision, '-t', 'cmt-amr-go:0.0.1', 'go-core'])
        source = {'name': 'amr-native-ci', 'services': {
            'auto-model-router': {'image': 'cmt-auto-model-router:0.0.0', 'container_name': 'auto-model-router',
                'depends_on': {'classifier': {'condition': 'service_healthy'}},
                'ports': ['127.0.0.1:8787:8787'],
                'environment': {'ROUTER_KEY_MODE': 'passthrough', 'ADMIN_TOKEN': 'a' * 40,
                    'SEMANTIC_BUCKET_SECRET': 's' * 40, 'METRICS_TOKEN': 'm' * 40,
                    'MAAS_BASE_URL': config['upstreamBaseUrl'], 'MAAS_API_KEY': 'fixture-service-key',
                    'NODE_EXTRA_CA_CERTS': '/app/config/tls-cert.pem'},
                'volumes': ['/opt/amr/config:/app/config', '/opt/amr/data:/app/data'], 'stop_grace_period': '30s'},
            'classifier': {'image': 'cmt-amr-classifier:0.0.0', 'container_name': 'amr-classifier',
                'volumes': ['/opt/amr/config:/app/config:ro']}}, 'networks': {'default': {'internal': True}}}
        write(compose_path, source)
        run(compose + ['up', '-d', '--wait', '--wait-timeout', '90'])
        expected = []
        probe('node-before', expected)
        stage = ROOT / 'native-release-fixture'
        prepare(stage, '0.0.1', revision)
        candidate = json.loads((stage / 'compose.json').read_text())
        # Synthetic local CA only; production uses the image's public trust store.
        candidate['services']['go-core']['environment']['SSL_CERT_FILE'] = '/app/config/tls-cert.pem'
        for name in ['router.json', 'go-auth.json', 'go-runtime.json']:
            shutil.copy2(stage / 'config' / name, ROOT / 'config' / name)
            os.chown(ROOT / 'config' / name, 1000, 1000)
        state = ROOT / 'data/go-native-0.0.1'
        state.mkdir(mode=0o700)
        os.chown(state, 1000, 1000)
        write(compose_path, candidate)
        run(compose + ['up', '-d', '--remove-orphans', '--wait', '--wait-timeout', '90'])
        probe('go', expected)
        try:
            request('/internal/v1/runtime')
            raise AssertionError('private endpoint exposed')
        except urllib.error.HTTPError as error:
            assert error.code == 404
        run(compose + ['restart', 'go-core'])
        run(compose + ['up', '-d', '--wait', '--wait-timeout', '90'])
        probe('go-restart', expected)
        run(compose + ['stop'])
        for name, path in [('compose', compose_path), ('env', ROOT / '.env'), ('router', ROOT / 'config/router.json')]:
            shutil.copy2(stage / 'rollback' / name, path)
            os.chown(path, 1000, 1000)
        # Preserve Node cost state; never import the empty observation-mode Go WAL.
        run(compose + ['up', '-d', '--remove-orphans', '--wait', '--wait-timeout', '90'])
        probe('node-rollback', expected)
        run(compose + ['stop'])
        ledger = json.loads((ROOT / 'data/budget-ledger.json').read_text())
        assert ledger['settles'] == len(expected), ledger['settles']
        assert abs(ledger['answerCostYuan'] - len(expected) * .00024) < .0000001
        records = [json.loads(line) for path in (ROOT / 'data/decisions').glob('decisions-*.jsonl') for line in path.read_text().splitlines() if line]
        ids = [row['request']['requestId'] for row in records]
        assert all(ids.count(value) == 1 for value in expected), ids
        report = {'passed': True, 'revision': revision, 'requests': len(expected), 'cutover': True,
                  'restart': True, 'rollback': True, 'costPreserved': True, 'decisionRecordsExactlyOnce': True,
                  'syntheticProviderAndClassifier': True, 'productionModified': False}
        (evidence / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report))
    finally:
        if compose_path.exists():
            with (evidence / 'containers.log').open('w') as log:
                subprocess.run(compose + ['logs', '--no-color'], stdout=log, stderr=subprocess.STDOUT, timeout=30)
            subprocess.run(compose + ['down', '--remove-orphans'], timeout=90)
        # This root was required to be absent on this fresh GitHub runner.
        shutil.rmtree(ROOT)


if __name__ == '__main__':
    main()
