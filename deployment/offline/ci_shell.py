"""Verify the delivered Shell entry point with Python and Node absent from PATH."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

REPO=Path(__file__).resolve().parents[2]

def call(args,env=None):
    r=subprocess.run(args,capture_output=True,text=True,env=env,timeout=300)
    if r.returncode:
        # All data here is synthetic; installer itself never outputs credentials.
        raise RuntimeError('CI command failed: '+str(args[:3])+'\n'+r.stdout[-4000:]+'\n'+r.stderr[-4000:])
    return r.stdout


def main():
    root=Path('/opt/amr-offline-ci')
    if os.environ.get('GITHUB_ACTIONS')!='true' or root.exists():raise RuntimeError('Fresh runner required')
    base=REPO/'data/offline-ci';base.mkdir(parents=True)
    bundle=base/'bundle';bundle.mkdir()
    fixture=base/'fixture';fixture.mkdir()
    evidence=REPO/'data/fresh-install-evidence';evidence.mkdir(parents=True,exist_ok=True)
    for name in ['install.sh','worker.mjs','compose.template.json']:
        shutil.copyfile(REPO/'deployment/offline'/name,bundle/name)
    shutil.copyfile(REPO/'deployment/release.json',bundle/'release.json')
    release=json.loads((bundle/'release.json').read_text())
    (bundle/'release-id.txt').write_bytes((release['version']+' '+release['revision']+'\n').encode())
    (bundle/'image-ids.txt').write_bytes(''.join(name+' '+identity+'\n' for name,item in release['images'].items() for identity in item['ids']).encode())
    shutil.copytree(REPO/'data/fresh-bundle/images',bundle/'images')
    cfg=json.loads((REPO/'deployment/router.example.json').read_text(encoding='utf-8'))
    cfg=json.loads(json.dumps(cfg).replace('replace-with-your-model','fixture-model'))
    cfg['upstreamBaseUrl']='https://amr-offline-provider:8790/v1'
    cfg['models'][0]['pricingYuanPerMillionTokens']={'input':1,'output':2}
    (bundle/'router.json').write_text(json.dumps(cfg))
    (fixture/'router.json').write_text(json.dumps(cfg))
    (fixture/'key').write_text('fixture-service-key')
    call(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=amr-offline-provider',
        '-addext','subjectAltName=DNS:amr-offline-provider','-keyout',str(fixture/'tls-key.pem'),'-out',str(fixture/'tls-cert.pem')])
    for p in fixture.iterdir():p.chmod(0o644)
    files=[p for p in bundle.rglob('*') if p.is_file()]
    (bundle/'SHA256SUMS').write_text(''.join(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+p.relative_to(bundle).as_posix()+'\n' for p in sorted(files)))
    tools=base/'host-tools';tools.mkdir()
    for name in ['bash','docker','id','uname','cat','dirname','basename','cp','chown','chmod','mktemp','mv','rm','sha256sum','readlink']:
        source=shutil.which(name)
        if not source:raise RuntimeError('CI prerequisite missing '+name)
        (tools/name).symlink_to(source)
    env={**os.environ,'PATH':str(tools)}
    assert subprocess.run([str(tools/'bash'),'-c','command -v python3 || command -v python || command -v node'],env=env,capture_output=True).returncode!=0
    shell=[str(tools/'bash'),str(bundle/'install.sh')]
    args=['--root',str(root)]
    command=['docker','compose','-p','amr-offline-ci','-f',str(root/'compose.json')]
    try:
        call(shell+['load-images'],env)
        # Invalid input must not create an installation or leave staging directories.
        bad=subprocess.run(shell+['init',*args,'--project','amr-offline-ci','--port','99999'],env=env,capture_output=True)
        assert bad.returncode!=0 and not root.exists()
        assert not list(root.parent.glob('.amr-offline.*'))
        call(shell+['init',*args,'--project','amr-offline-ci','--port','18787','--ca-cert',str(fixture/'tls-cert.pem')],env)
        original=(root/'config/router.json').read_bytes();credentials=(root/'credentials.json').read_bytes()
        duplicate=subprocess.run(shell+['init',*args],env=env,capture_output=True)
        assert duplicate.returncode!=0 and (root/'config/router.json').read_bytes()==original
        for p in [root/'credentials.json',root/'compose.json',root/'config/go-auth.json']:
            assert p.stat().st_mode & 0o777 == 0o600
        call(command+['create','classifier'])
        call(['docker','run','-d','--name','amr-offline-provider','--network','amr-offline-ci_default',
              '--mount','type=bind,src='+str(fixture)+',dst=/app/config,readonly',
              '--mount','type=bind,src='+str(REPO/'go-core/deployment/native_mock.mjs')+',dst=/mock.mjs,readonly',
              '--entrypoint','node','cmt-auto-model-router:'+release['version'],'/mock.mjs'])
        checks=[]
        for _ in range(2):
            call(shell+['start',*args],env)
            check=json.loads(call(shell+['check',*args],env));assert check['healthy']
            result=json.loads(call(shell+['verify',*args,'--key-file',str(fixture/'key')],env));assert result['passed']
            checks.append(result)
            call(shell+['stop',*args],env)
        assert (root/'credentials.json').read_bytes()==credentials
        ledger=json.loads((root/'data/budget-ledger.json').read_text())
        assert ledger['settles']==4 and abs(ledger['settledActualSpendYuan']-.00096)<1e-8
        result={'passed':True,'installer':'offline-shell','hostPythonAbsent':True,'hostNodeAbsent':True,
            'bootstrapNetwork':'none','images':'verified-v'+release['version'],'threeServicesHealthy':True,
            'syntheticUpstream':True,'invalidInputCleaned':True,'existingDirectoryRefused':True,
            'credentialsPreserved':True,'pricedSettlements':4,'checks':checks}
        (evidence/'offline-shell-result.json').write_text(json.dumps(result,indent=2))
        print(json.dumps(result))
    finally:
        if (root/'compose.json').exists():
            for tail in [['stop','go-core'],['stop','auto-model-router','classifier'],['down']]:
                subprocess.run(command+tail,capture_output=True,timeout=120)
        subprocess.run(['docker','rm','-f','amr-offline-provider'],capture_output=True,timeout=30)


if __name__=='__main__':main()
