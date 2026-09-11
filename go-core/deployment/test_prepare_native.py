"""Exercise protected preparation with a real snapshot export and simulated images."""
import contextlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import prepare_native
from native_compose import escape_interpolation
from test_native_compose import source


REPO = Path(__file__).resolve().parents[2]
REVISION = 'a' * 40


class PrepareNativeTest(unittest.TestCase):
    def test_exports_snapshot_and_preserves_original_files(self):
        self.exercise()

    def test_refuses_concurrent_source_change(self):
        self.exercise(drift=True)

    def exercise(self, drift=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'config').mkdir()
            config = json.loads((REPO / 'config/router.json').read_text(encoding='utf-8'))
            config['budget']['enabled'] = False
            config['upstreamBaseUrl'] = 'https://provider.example/v1'
            (root / 'config/router.json').write_text(json.dumps(config), encoding='utf-8')
            (root / '.env').write_text('FIXTURE_ONLY=original\n', encoding='utf-8')
            (root / 'docker-compose.prod.yml').write_text('fixture original bytes\n', encoding='utf-8')
            originals = {p: p.read_bytes() for p in [root / '.env', root / 'docker-compose.prod.yml', root / 'config/router.json']}
            compose = source()
            stage = root / 'native-release-fixture'
            calls = []

            def run(args):
                calls.append(args)
                if args[1:3] == ['image', 'inspect']:
                    return json.dumps([{'Id': 'sha256:fixture', 'Config': {'Labels': {'org.opencontainers.image.revision': REVISION}}}])
                if args[1] == 'inspect':
                    node = compose['services']['auto-model-router']
                    return json.dumps([{'Config': {'Image': node['image'], 'Env': [key + '=' + value for key, value in node['environment'].items()]}}])
                if args[1] == 'compose':
                    return '' if '--quiet' in args else json.dumps(escape_interpolation(compose))
                if args[1] == 'run':
                    # Execute the exact release-side exporter against staged files.
                    script = args[-1].replace('/staged', (stage / 'config').as_posix())
                    subprocess.run(['node', '--input-type=module', '-e', script], cwd=REPO, check=True, capture_output=True)
                    if drift:
                        (root / '.env').write_text('changed concurrently\n', encoding='utf-8')
                    return ''
                raise AssertionError(args)

            with patch.object(prepare_native, 'run', run), patch.object(prepare_native.os, 'chown', create=True), contextlib.redirect_stdout(io.StringIO()):
                if drift:
                    with self.assertRaisesRegex(ValueError, 'production_config_changed'):
                        prepare_native.prepare(stage, '0.14.6', REVISION, root=root)
                    self.assertFalse((stage / 'evidence/prepare.json').exists())
                    return
                prepare_native.prepare(stage, '0.14.6', REVISION, root=root)
            for path, original in originals.items():
                self.assertEqual(path.read_bytes(), original)
            staged = json.loads((stage / 'config/router.json').read_text(encoding='utf-8'))
            self.assertEqual(staged.pop('version'), '0.14.6')
            config.pop('version', None)
            self.assertEqual(staged, config)
            runtime = json.loads((stage / 'config/go-runtime.json').read_text(encoding='utf-8'))
            self.assertTrue(runtime['features']['models'])
            self.assertFalse((root / 'config/go-auth.json').exists())
            self.assertTrue((stage / 'rollback/env').is_file())
            manifest = json.loads((stage / 'evidence/prepare.json').read_text())
            self.assertFalse(manifest['applied'])
            self.assertTrue(all('up' not in args and 'stop' not in args for args in calls))


if __name__ == '__main__':
    unittest.main()
