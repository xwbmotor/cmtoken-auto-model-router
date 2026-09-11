#!/usr/bin/env python3
"""Operator-only Go candidate. Credentials never leave server subprocess stdin/files.

Source and image must already be staged by the release operator. This does not
build, publish ports, modify production, or route existing customer traffic.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import time
from urllib.parse import urlsplit


def run(argv, payload=None):
    result = subprocess.run(argv, input=payload, text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=180)
    if result.returncode:
        # Docker error text can include expanded configuration and credentials.
        detail = ''
        try:
            failure = json.loads(result.stdout)
            if isinstance(failure.get('status'), int) and 100 <= failure['status'] <= 599:
                detail = '_http_' + str(failure['status'])
            elif re.fullmatch('[A-Za-z_]+', failure.get('error', '')):
                detail = '_' + failure['error'].lower()
        except (ValueError, TypeError, AttributeError):
            pass
        raise RuntimeError('subprocess_failed_' + str(result.returncode) + detail)
    return result.stdout


def inspect(name):
    return json.loads(run(['docker', 'inspect', name]))[0]


def protected(path, value, owner=False):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as out:
        out.write(value)
        out.flush()
        os.fsync(out.fileno())
    if owner:
        os.chown(path, 65532, 65532)


def write_report(root, name, value):
    value = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), **value}
    target = root / 'evidence' / (name + '.json')
    # Evidence contains selected result fields only, never raw HTTP bodies/env.
    target.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(value, ensure_ascii=False))


def production():
    router = inspect('auto-model-router')
    env = dict(x.split('=', 1) for x in router['Config']['Env'] if '=' in x)
    return router, env


def load(root):
    return json.loads((root / 'state' / 'candidate.json').read_text())


def assert_identity(state, args):
    if state['image'] != args.image or state['revision'] != args.revision:
        raise RuntimeError('candidate_identity_mismatch')


def prepare(args, root):
    for name in ['config', 'state', 'evidence']:
        (root / name).mkdir(mode=0o700, exist_ok=False)
    router, env = production()
    if env.get('ROUTER_KEY_MODE') != 'passthrough':
        raise RuntimeError('production_requires_passthrough')
    source = Path('/opt/amr/config/router.json').read_bytes()
    config = json.loads(source)
    if config.get('budget', {}).get('enabled') is not False:
        raise RuntimeError('budget_must_be_disabled')
    base = (env.get('UPSTREAM_BASE_URL') or env.get('MAAS_BASE_URL') or
            config.get('upstreamBaseUrl', '')).rstrip('/')
    parsed = urlsplit(base)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise RuntimeError('production_upstream_must_be_clean_https')
    semantic = config.get('semanticRouter', {})
    small = env.get('SEMANTIC_CLASSIFIER_URL') or semantic.get('httpJson', {}).get('url', '')
    small_url = urlsplit(small)
    if small_url.scheme != 'http' or small_url.hostname != 'classifier' or small_url.port != 8788 or small_url.path != '/classify' or small_url.query or small_url.fragment or small_url.username:
        raise RuntimeError('unexpected_production_classifier_endpoint')
    service = env.get('UPSTREAM_API_KEY') or env.get('MAAS_API_KEY')
    if not service:
        raise RuntimeError('service_credential_unavailable')
    if not (root / 'source/go-core/compat/export-runtime.mjs').is_file():
        raise RuntimeError('staged_source_missing')
    image = json.loads(run(['docker', 'image', 'inspect', args.image]))[0]
    if image.get('Config', {}).get('Labels', {}).get('org.opencontainers.image.revision') != args.revision:
        raise RuntimeError('candidate_image_revision_mismatch')
    protected(root / 'config/router.json', source.decode(), owner=True)
    admin = secrets.token_urlsafe(48)
    protected(root / 'config/auth.json', json.dumps({'mode': 'passthrough', 'adminToken': admin}), owner=True)
    variables = {
        'AMR_GO_SEMANTIC_SMALL_TOKEN': semantic.get('httpJson', {}).get('token', ''),
        'AMR_GO_SEMANTIC_BUCKET_SECRET': env.get('SEMANTIC_BUCKET_SECRET', ''),
    }
    if any('\n' in value or '\r' in value for value in variables.values()):
        raise RuntimeError('credential_env_format_invalid')
    protected(root / 'state/runtime.env', ''.join(key + '=' + value + '\n' for key, value in variables.items()))
    state = {'image': args.image, 'revision': args.revision,
             'name': 'amr-go-candidate-' + args.revision[:12],
             'nodeImage': router['Config']['Image'], 'productionImageId': router['Image'],
             'sourceConfigSha256': hashlib.sha256(source).hexdigest(),
             'upstream': base + '/chat/completions', 'scope': base + '/models',
             'small': 'http://127.0.0.1:8788/classify', 'budgetEnabled': False,
             'classifierImageId': inspect('amr-classifier')['Image']}
    protected(root / 'state/candidate.json', json.dumps(state, indent=2))
    for directory in ['config', 'state']:
        os.chown(root / directory, 65532, 65532)
    run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
         '--security-opt', 'no-new-privileges', '--user', '65532:65532',
         '--mount', f'type=bind,src={root}/source,dst=/source,readonly',
         '--mount', f'type=bind,src={root}/config,dst=/config',
         '--entrypoint', 'node', state['nodeImage'], '/source/go-core/compat/export-runtime.mjs',
         '--config', '/config/router.json', '--out', '/config/runtime.json'])
    snapshot_bytes = (root / 'config/runtime.json').read_bytes()
    if any(value and value.encode() in snapshot_bytes for value in [service, admin, env.get('SEMANTIC_BUCKET_SECRET', '')]):
        raise RuntimeError('snapshot_contains_credential')
    if (root / 'config/router.json').read_bytes() != source:
        raise RuntimeError('candidate_config_changed')
    write_report(root, 'prepare', {'prepared': True, 'revision': args.revision,
                                 'budgetEnabled': False, 'sourceConfigSha256': state['sourceConfigSha256']})


def start(args, root):
    state = load(root)
    assert_identity(state, args)
    image = json.loads(run(['docker', 'image', 'inspect', args.image]))[0]
    if image.get('Config', {}).get('Labels', {}).get('org.opencontainers.image.revision') != args.revision:
        raise RuntimeError('candidate_image_revision_mismatch')
    # Refuse duplicate/ambiguous starts. Resume existing container explicitly.
    existing = run(['docker', 'ps', '-a', '--filter', 'name=^/' + state['name'] + '$', '--format', '{{.ID}}']).strip()
    if existing:
        container = inspect(state['name'])
        if container['Config'].get('Labels', {}).get('amr.candidate.root') != str(root) or container['Image'] != image['Id']:
            raise RuntimeError('existing_candidate_identity_mismatch')
        if container['State']['Running']:
            raise RuntimeError('candidate_already_running')
        run(['docker', 'start', state['name']])
    else:
        run(['docker', 'run', '-d', '--name', state['name'], '--label', 'amr.candidate.root=' + str(root),
             '--network', 'container:amr-classifier', '--read-only', '--cap-drop', 'ALL',
             '--security-opt', 'no-new-privileges', '--cpus', '2', '--memory', '512m',
             '--pids-limit', '128', '--stop-timeout', '30', '--restart', 'no',
             '--log-driver', 'json-file', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3',
             '--env-file', str(root / 'state/runtime.env'),
             '--mount', f'type=bind,src={root}/config,dst=/config,readonly',
             '--mount', f'type=bind,src={root}/state,dst=/state', args.image,
             '--candidate', '--runtime', '--native-semantics', '--runtime-config', '/config/runtime.json',
             '--auth-config', '/config/auth.json', '--ledger', '/state/runtime.wal',
             '--listen', '127.0.0.1:8791', '--upstream', state['upstream'],
             '--scope-url', state['scope'], '--semantic-small', state['small'],
             '--semantic-large', state['upstream'], '--timeout', '50s'])
    wait_ready(root)
    write_report(root, 'start', {'started': True, 'name': state['name'], 'revision': args.revision,
                               'publishedPorts': [], 'operatorOnly': True})


# Executed within the classifier's network namespace. Secrets are supplied as
# stdin JSON, never argv or output. Never return an arbitrary error/body.
PROBE = r'''
import json,sys,urllib.request,urllib.error
p=json.load(sys.stdin)
def req(path,body=None,admin=False):
 h={'Authorization':'Bearer '+(p['admin'] if admin else p['service'])}
 if body is not None: h['Content-Type']='application/json'
 return urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8791'+path,headers=h,data=None if body is None else json.dumps(body).encode()),timeout=3 if path=='/health' else 55)
try:
 action=p['action']
 if action=='state':
  with req('/internal/v1/runtime',admin=True) as r: data=json.load(r)
  print(json.dumps({k:data.get(k) for k in ['revision','ledger','persistenceHealthy','inflight','semanticGuard','diagnostics']}))
 elif action=='health':
  with req('/health') as r: print(json.dumps({'status':r.status}))
 elif action=='python':
  h={'Content-Type':'application/json'}
  if p.get('small'): h['Authorization']='Bearer '+p['small']
  q=urllib.request.Request('http://127.0.0.1:8788/classify',headers=h,data=json.dumps({'text':'Explain why the sky is blue in one sentence.'}).encode())
  with urllib.request.urlopen(q,timeout=30) as r:
   d=json.load(r); print(json.dumps({'status':r.status,'schemaValid':all(k in d for k in ['task','tier','complexity','confidence'])}))
 else:
  streaming=action=='stream'
  body={'model':p['model'],'messages':[{'role':'user','content':'Only answer the number: 1+1=?'}],'max_tokens':64,'reasoning_effort':'none','stream':streaming}
  with req('/v1/chat/completions',body) as r:
   out={'status':r.status,'requestId':r.headers.get('X-AMR-Request-ID'),'usagePresent':False,'done':False,'contentPresent':False,'selectedModel':r.headers.get('X-AMR-Selected-Model')}
   if streaming:
    for raw in r:
     line=raw.decode().strip()
     if not line.startswith('data:'): continue
     data=line[5:].strip()
     if data=='[DONE]': out['done']=True;continue
     d=json.loads(data);out['model']=d.get('model',out.get('model'));out['requestId']=out['requestId'] or d.get('id')
     out['usagePresent']=out['usagePresent'] or isinstance(d.get('usage'),dict)
     out['contentPresent']=out['contentPresent'] or any(bool(c.get('delta',{}).get('content')) for c in d.get('choices',[]))
   else:
    d=json.load(r);out.update(model=d.get('model'),usagePresent=isinstance(d.get('usage'),dict),requestId=out['requestId'] or d.get('id'),contentPresent=any(bool(c.get('message',{}).get('content')) for c in d.get('choices',[])))
   print(json.dumps(out))
except urllib.error.HTTPError as e:
 print(json.dumps({'error':'http_rejected','status':e.code}));sys.exit(1)
except Exception as e:
 print(json.dumps({'error':type(e).__name__}));sys.exit(1)
'''


def probe(root, action):
    _, env = production()
    auth = json.loads((root / 'config/auth.json').read_text())
    config = json.loads((root / 'config/router.json').read_text())
    payload = {'action': action, 'admin': auth['adminToken'],
               'service': env.get('UPSTREAM_API_KEY') or env.get('MAAS_API_KEY'),
               'small': config.get('semanticRouter', {}).get('httpJson', {}).get('token', ''),
               'model': config.get('routing', {}).get('autoModelId') or 'auto'}
    return json.loads(run(['docker', 'exec', '-i', 'amr-classifier', 'python3', '-c', PROBE], json.dumps(payload)))


def wait_ready(root):
    deadline = time.monotonic() + 50
    while time.monotonic() < deadline:
        try:
            if probe(root, 'health')['status'] == 200:
                return
        except RuntimeError:
            pass
        time.sleep(1)
    raise RuntimeError('candidate_health_timeout')


def publication(root, state):
    code = """
import {readFile} from 'node:fs/promises';
import {createGoCoreAdmin} from '/source/src/go-core-admin.mjs';
const auth=JSON.parse(await readFile('/config/auth.json','utf8'));
process.env.CONFIG_PATH='/config/router.json';
const bridge=createGoCoreAdmin({AMR_GO_ADMIN_URL:'http://127.0.0.1:8791',ADMIN_TOKEN:auth.adminToken,AMR_GO_ADMIN_TOKEN:auth.adminToken,AMR_GO_RUNTIME_CONFIG:'/config/runtime.json'});
const before=await bridge.status();const after=await bridge.reload(before.revision);
if(before.status!==200||after.status!==200)throw Error('publication_failed');
console.log(JSON.stringify({status:after.status,revision:after.revision,configRevision:after.configRevision,publicationPending:(await bridge.status()).publicationPending}));
"""
    return json.loads(run(['docker', 'run', '--rm', '--network', 'container:amr-classifier',
                          '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
                          '--user', '65532:65532', '--mount', f'type=bind,src={root}/source,dst=/source,readonly',
                          '--mount', f'type=bind,src={root}/config,dst=/config',
                          '--entrypoint', 'node', state['nodeImage'], '--input-type=module', '-e', code]))


def verify(args, root):
    state = load(root)
    assert_identity(state, args)
    # A durable attempt marker prevents rerunning paid probes after interruption.
    report = {'budgetEnabled': False, 'operatorOnly': True, 'productionTrafficChanged': False}
    report['publication'] = publication(root, state)
    report['python'] = probe(root, 'python')
    if not report['python'].get('schemaValid'):
        raise RuntimeError('classifier_schema_invalid')
    write_report(root, 'verify-preflight', report)
    protected(root / 'state/verification-started', datetime.datetime.now(datetime.timezone.utc).isoformat())
    report['nonstream'] = probe(root, 'nonstream')
    write_report(root, 'verify-progress', report)
    report['stream'] = probe(root, 'stream')
    write_report(root, 'verify-progress', report)
    if not report['nonstream'].get('contentPresent') or not report['stream'].get('contentPresent') or not report['stream'].get('done'):
        raise RuntimeError('response_incomplete')
    before = probe(root, 'state')
    for _ in range(30):
        if before.get('ledger', {}).get('pendingReserves') == 0 and before.get('semanticGuard', {}).get('active', 0) == 0:
            break
        time.sleep(1)
        before = probe(root, 'state')
    if before.get('ledger', {}).get('pendingReserves') != 0:
        raise RuntimeError('pending_reserves_after_probes')
    if before.get('persistenceHealthy') is not True or before.get('semanticGuard', {}).get('active', 0) != 0:
        raise RuntimeError('runtime_not_settled_and_healthy')
    if not before.get('persistenceHealthy') or before.get('diagnostics', {}).get('runtime', {}).get('costStateMode') != 'observation':
        raise RuntimeError('candidate_storage_unhealthy_or_wrong_mode')
    report['settled'] = before
    write_report(root, 'verify-progress', report)
    run(['docker', 'stop', '--time', '30', state['name']])
    if inspect(state['name'])['State']['ExitCode'] != 0:
        raise RuntimeError('normal_stop_exit_nonzero')
    run(['docker', 'start', state['name']]); wait_ready(root)
    normal = probe(root, 'state')
    if normal['ledger'] != before['ledger'] or normal.get('revision') != before.get('revision') or normal.get('persistenceHealthy') is not True:
        raise RuntimeError('normal_restart_ledger_mismatch')
    run(['docker', 'kill', '--signal', 'KILL', state['name']])
    run(['docker', 'start', state['name']]); wait_ready(root)
    killed = probe(root, 'state')
    if killed['ledger'] != before['ledger'] or killed.get('revision') != before.get('revision') or killed.get('persistenceHealthy') is not True:
        raise RuntimeError('killed_restart_ledger_mismatch')
    router, _ = production()
    classifier = inspect('amr-classifier')
    if router['Image'] != state['productionImageId'] or classifier['Image'] != state['classifierImageId'] or hashlib.sha256(Path('/opt/amr/config/router.json').read_bytes()).hexdigest() != state['sourceConfigSha256']:
        raise RuntimeError('production_configuration_changed_during_candidate')
    if any(c.get('State', {}).get('Health', {}).get('Status') != 'healthy' for c in [router, classifier]):
        raise RuntimeError('production_health_changed')
    report['productionUnchangedAndHealthy'] = True
    report.update(normalRestartLedgerEqual=True, killedRestartLedgerEqual=True,
                  finalRevision=killed['revision'], completed=True,
                  paidAnswerRequests=2, additionalSemanticCallsPossible=True)
    write_report(root, 'verify', report)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True)
    parser.add_argument('--image', required=True)
    parser.add_argument('--revision', required=True)
    parser.add_argument('action', choices=['prepare', 'start', 'verify', 'stop', 'status'])
    args = parser.parse_args()
    root = Path(args.root).resolve()
    if not re.fullmatch('[0-9a-f]{40}', args.revision) or root.parent != Path('/opt/amr/go-candidate') or not re.fullmatch('[0-9a-f]{7,40}', root.name):
        raise RuntimeError('invalid_candidate_root_or_revision')
    if not args.revision.startswith(root.name):
        raise RuntimeError('root_revision_mismatch')
    if args.action == 'prepare':
        prepare(args, root)
    elif args.action == 'start':
        start(args, root)
    elif args.action == 'verify':
        verify(args, root)
    else:
        state = load(root); assert_identity(state, args)
        container = inspect(state['name'])
        if container['Config'].get('Labels', {}).get('amr.candidate.root') != str(root):
            raise RuntimeError('candidate_container_mismatch')
        if args.action == 'stop':
            run(['docker', 'stop', '--time', '30', state['name']])
            write_report(root, 'stop', {'stopped': True, 'productionUntouched': True})
        else:
            write_report(root, 'status', {'running': container['State']['Running'],
                                        'revision': container['Config'].get('Labels', {}).get('org.opencontainers.image.revision'),
                                        'runtime': probe(root, 'state') if container['State']['Running'] else None})


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # No traceback, raw subprocess stderr, raw HTTP body, or secret values.
        safe = str(error) if isinstance(error, RuntimeError) and re.fullmatch('[a-z0-9_]+', str(error)) else type(error).__name__
        print(json.dumps({'failed': True, 'error': safe}))
        sys.exit(1)
