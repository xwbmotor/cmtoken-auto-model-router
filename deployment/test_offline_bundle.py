import hashlib
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import offline.build_bundle as packing


class OfflineBundleTests(unittest.TestCase):
    def inputs(self, root):
        images=root/'images';images.mkdir()
        release=packing.manifest(packing.REPO/'deployment/release.json')
        for name,item in release['images'].items():
            payload=name.encode();(images/item['archive']).write_bytes(payload)
            item['sha256']=hashlib.sha256(payload).hexdigest()
        cfg=root/'router.json';cfg.write_text(json.dumps({'budget':{'enabled':False},'models':[{'id':'test'}]}))
        return images,release,cfg

    def test_supplied_config_without_live_service_proof(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);images,release,cfg=self.inputs(root)
            with patch.object(packing,'manifest',return_value=release):packing.build(images,cfg,None,root/'package')
            with tarfile.open(root/'package.tar.gz') as t:
                proof=json.load(t.extractfile('package/config-provenance.json'))
                self.assertEqual(proof['source'],'supplied-config');self.assertFalse(proof['runtimeVerified'])
                sums=t.extractfile('package/SHA256SUMS').read().decode().splitlines()
                for line in sums:
                    digest,name=line.split('  ',1)
                    self.assertEqual(hashlib.sha256(t.extractfile('package/'+name).read()).hexdigest(),digest)

    def test_credentials_refused_before_output(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);images,release,cfg=self.inputs(root)
            cfg.write_text(json.dumps({'budget':{'enabled':False},'token':'do-not-package'}))
            with patch.object(packing,'manifest',return_value=release),self.assertRaisesRegex(ValueError,'Credential'):
                packing.build(images,cfg,None,root/'package')
            self.assertFalse((root/'package').exists())

    def test_damaged_image_refused(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);images,release,cfg=self.inputs(root)
            next(images.iterdir()).write_bytes(b'broken')
            with patch.object(packing,'manifest',return_value=release),self.assertRaisesRegex(ValueError,'archive differs'):
                packing.build(images,cfg,None,root/'package')
            self.assertFalse((root/'package').exists())

    def test_live_proof_mismatch_is_not_downgraded(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);images,release,cfg=self.inputs(root)
            proof=root/'proof.json';proof.write_text(json.dumps({'source':'running-admin-api','goSynchronized':True,'sha256':'incorrect'}))
            with patch.object(packing,'manifest',return_value=release),self.assertRaisesRegex(ValueError,'proof mismatch'):
                packing.build(images,cfg,proof,root/'package')
            self.assertFalse((root/'package').exists())
