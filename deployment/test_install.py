import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import install

REPO=Path(__file__).resolve().parents[1]


class FreshInstallTests(unittest.TestCase):
    def setUp(self):
        self.release=install.manifest(REPO/'deployment/release.json')

    def test_manifest_rejects_missing_image(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'manifest.json';r=json.loads(json.dumps(self.release));r['images'].pop('cmt-amr-go')
            p.write_text(json.dumps(r))
            with self.assertRaises(install.InstallError):install.manifest(p)

    def test_existing_target_refused_without_docker(self):
        with tempfile.TemporaryDirectory() as d,patch.object(install,'run') as run:
            with self.assertRaises(install.InstallError):install.validate_target(Path(d))
            run.assert_not_called()

    def test_relative_target_refused(self):
        with self.assertRaises(install.InstallError):install.validate_target(Path('relative-path'))

    def test_damaged_archive_refused_before_loading(self):
        with tempfile.TemporaryDirectory() as d,patch.object(install,'run') as run:
            p=Path(d);(p/'images').mkdir()
            for item in self.release['images'].values():(p/'images'/item['archive']).write_bytes(b'not-an-image')
            with self.assertRaises(install.InstallError):install.load_images(p,self.release)
            run.assert_not_called()

    def test_image_revision_mismatch(self):
        image={'Id':self.release['images'][install.IMAGES[0]]['ids'][0], 'Config':{'Labels':{'org.opencontainers.image.revision':'wrong'}}}
        with patch.object(install,'run',return_value=json.dumps([image])):
            with self.assertRaises(install.InstallError):install.inspect_image(install.IMAGES[0],self.release)

    def exercise(self,fail=False):
        with tempfile.TemporaryDirectory() as d:
            parent=Path(d).resolve();root=parent/'new-install';config=parent/'input.json'
            c=json.loads((REPO/'deployment/router.example.json').read_text(encoding='utf-8'))
            config.write_text(json.dumps(c).replace('replace-with-your-model','fixture-model'))
            original=config.read_bytes()
            def fake(args,timeout=180):
                if args[:2]==['docker','ps']:return ''
                if args[:3]==['docker','image','inspect']:
                    name=args[3].split(':')[0]
                    return json.dumps([{'Id':self.release['images'][name]['ids'][0],'Config':{'Labels':{'org.opencontainers.image.revision':self.release['revision']}},'Os':'linux','Architecture':'amd64'}])
                if args[:2]==['docker','run']:
                    if fail:raise install.InstallError('export failed')
                    mount=args[args.index('--mount')+1];stage=mount.split('src=',1)[1].split(',dst=')[0]
                    code=args[-1].replace('/staged',stage.replace('\\','/'))
                    subprocess.run(['node','--input-type=module','-e',code],cwd=REPO,check=True,capture_output=True)
                    return ''
                if args[:2]==['docker','compose']:return ''
                raise AssertionError(args)
            # Path safety for production Linux is tested there; Windows temp paths use drive letters.
            with patch.object(install,'run',side_effect=fake),patch.object(install.os,'chown',create=True),patch.object(install,'validate_target'):
                if fail:
                    with self.assertRaises(install.InstallError):install.initialize(root,config,'https://fixture.example/v1',self.release,'amr-test','127.0.0.1',18787)
                    self.assertFalse(root.exists());self.assertEqual(list(parent.glob('.new-install-install-*')),[])
                    return
                result=install.initialize(root,config,'https://fixture.example/v1',self.release,'amr-test','127.0.0.1',18787)
            self.assertFalse(result['started']);self.assertEqual(config.read_bytes(),original)
            self.assertTrue((root/'config/go-runtime.json').is_file())
            spec=json.loads((root/'compose.json').read_text())
            node=spec['services']['auto-model-router'];go=spec['services']['go-core']
            self.assertEqual(node['environment']['AMR_GO_EDGE_TOKEN'],go['environment']['AMR_GO_EDGE_TOKEN'])
            auth=json.loads((root/'config/go-auth.json').read_text())
            self.assertEqual(auth['adminToken'],node['environment']['AMR_GO_ADMIN_TOKEN'])
            self.assertEqual(go['container_name'],'amr-test-go')
            self.assertTrue(all(v['source'].startswith(str(root)) for s in spec['services'].values() for v in s.get('volumes',[])))

    def test_fresh_initialization_exports_real_snapshot(self):self.exercise()
    def test_failed_export_leaves_no_installation(self):self.exercise(fail=True)


if __name__=='__main__':unittest.main()
