"""Fresh-host integration test. Only run on a disposable GitHub runner."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO/'deployment'))
from install import initialize, load_images, manage, manifest, InstallError
from verify import verify


def run(args):
    subprocess.run(args, check=True, capture_output=True, timeout=180)


def main():
    root=Path('/opt/amr-fresh-ci')
    evidence=REPO/'data/fresh-install-evidence';evidence.mkdir(parents=True,exist_ok=True)
    fixture=REPO/'data/fresh-fixture';fixture.mkdir(parents=True,exist_ok=True)
    if os.environ.get('GITHUB_ACTIONS')!='true' or root.exists():raise RuntimeError('Disposable runner required')
    release=manifest(REPO/'deployment/release.json')
    load_images(REPO/'data/fresh-bundle',release)
    config=json.loads((REPO/'deployment/router.example.json').read_text(encoding='utf-8'))
    config=json.loads(json.dumps(config).replace('replace-with-your-model','fixture-model'))
    config['models'][0]['pricingYuanPerMillionTokens'] = {'input': 1, 'output': 2}
    (fixture/'router.json').write_text(json.dumps(config))
    (fixture/'business.key').write_text('fixture-service-key')
    run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=amr-fresh-provider',
         '-addext','subjectAltName=DNS:amr-fresh-provider','-keyout',str(fixture/'tls-key.pem'),'-out',str(fixture/'tls-cert.pem')])
    for p in fixture.iterdir():os.chmod(p,0o644) # synthetic fixture only; Node UID 1000 reads certificate/key
    command=['docker','compose','--project-name','amr-fresh-ci','-f',str(root/'compose.json')]
    try:
        initialized=initialize(root,fixture/'router.json','https://amr-fresh-provider:8790/v1',release,
                               'amr-fresh-ci','127.0.0.1',18787,fixture/'tls-cert.pem')
        assert initialized['started'] is False
        assert json.loads((root/'config/go-runtime.json').read_text())
        for p in [root/'credentials.json',root/'compose.json',root/'config/go-auth.json']:
            assert p.stat().st_mode & 0o777 == 0o600
        before=(root/'config/router.json').read_bytes()
        try:initialize(root,fixture/'router.json','https://amr-fresh-provider:8790/v1',release,'amr-fresh-ci','127.0.0.1',18787)
        except InstallError:pass
        else:raise AssertionError('Existing installation overwritten')
        assert (root/'config/router.json').read_bytes()==before
        run(command+['create','classifier'])
        run(['docker','run','-d','--name','amr-fresh-provider','--network','amr-fresh-ci_default',
             '--mount','type=bind,src='+str(fixture)+',dst=/app/config,readonly',
             '--mount','type=bind,src='+str(REPO/'go-core/deployment/native_mock.mjs')+',dst=/mock.mjs,readonly',
             '--entrypoint','node','cmt-auto-model-router:'+release['version'],'/mock.mjs'])
        first=manage(root,'start',release)
        checks=[verify(root,fixture/'business.key')]
        creds=(root/'credentials.json').read_bytes()
        manage(root,'stop',release)
        manage(root,'start',release)
        checks.append(verify(root,fixture/'business.key'))
        assert (root/'credentials.json').read_bytes()==creds
        manage(root,'stop',release)  # Flush persisted costs before inspecting the ledger.
        ledger=json.loads((root/'data/budget-ledger.json').read_text())
        assert ledger['settles']==4,ledger['settles']
        assert abs(ledger['settledActualSpendYuan'] - .00096) < 1e-8
        result={'passed':True,'release':release['version'],'freshInitialization':True,'existingDirectoryRefused':True,
                'permissionsChecked':True,'threeRealReleaseImages':True,'syntheticUpstream':True,'realClassifierHealth':True,
                'requests':4,'jsonAndSSE':True,'restartPreservedCredentials':True,'settles':4,'checks':checks}
        (evidence/'result.json').write_text(json.dumps(result,indent=2))
        print(json.dumps(result))
    finally:
        # Only resources created under our required-new root/project.
        if (root/'compose.json').exists():
            for tail in [['stop','go-core'],['stop','auto-model-router','classifier'],['down']]:
                subprocess.run(command+tail,capture_output=True,timeout=120)
        subprocess.run(['docker','rm','-f','amr-fresh-provider'],capture_output=True,timeout=30)


if __name__=='__main__':main()
