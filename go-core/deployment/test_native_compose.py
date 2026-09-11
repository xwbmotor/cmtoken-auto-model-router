import copy
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from native_compose import build, escape_interpolation, decode_config_output


def source():
    return {'name': 'amr', 'services': {
        'auto-model-router': {
            'image': 'cmt-auto-model-router:0.14.5', 'hostname': 'auto-model-router',
            'environment': {'ROUTER_KEY_MODE': 'passthrough', 'SEMANTIC_BUCKET_SECRET': 's' * 40,
                            'ADMIN_TOKEN': 'fixture$literal${UNCHANGED}token', 'CUSTOM_SETTING': 'preserve'},
            'ports': [{'target': 8787, 'published': '8787', 'host_ip': '0.0.0.0', 'protocol': 'tcp'}],
            'networks': {'default': None}, 'depends_on': {'classifier': {'condition': 'service_healthy'}},
            'volumes': [{'type': 'bind', 'source': '/opt/amr/config', 'target': '/app/config'},
                        {'type': 'bind', 'source': '/opt/amr/data', 'target': '/app/data'}]},
        'classifier': {'image': 'cmt-amr-classifier:0.14.5', 'networks': {'default': None}}},
        'networks': {'default': {'name': 'amr_default'}}}


def prepare(value, **kwargs):
    return build(value, kwargs.get('version', '0.14.6'), kwargs.get('upstream', 'https://provider.example/v1'),
                 'e' * 40, 'a' * 40, budget_enabled=kwargs.get('budget_enabled', False))


class NativeComposeTest(unittest.TestCase):
    def test_preserves_business_settings_and_moves_only_public_mapping(self):
        original = source()
        preserved = copy.deepcopy(original)
        result = prepare(original)
        self.assertEqual(original, preserved)
        node, go, classifier = (result['services'][name] for name in ['auto-model-router', 'go-core', 'classifier'])
        self.assertEqual(classifier['ports'], original['services']['auto-model-router']['ports'])
        self.assertNotIn('ports', node)
        self.assertNotIn('ports', go)
        self.assertEqual(node['volumes'], original['services']['auto-model-router']['volumes'])
        self.assertEqual(node['environment']['ADMIN_TOKEN'], 'fixture$literal${UNCHANGED}token')
        self.assertEqual(node['environment']['CUSTOM_SETTING'], 'preserve')
        self.assertEqual(node['network_mode'], go['network_mode'])
        self.assertIn('--node-cost-observation', go['command'])
        self.assertEqual(go['volumes'][1]['source'], '/opt/amr/data/go-native-0.14.6')

    def test_refuses_incompatible_initial_state(self):
        for changes in [{'version': '../oops'}, {'upstream': 'http://provider.example/v1'}, {'budget_enabled': True}]:
            with self.assertRaises(ValueError):
                prepare(source(), **changes)
        bad = source()
        bad['services']['auto-model-router']['volumes'][0]['source'] = '/unrelated'
        with self.assertRaises(ValueError):
            prepare(bad)
        with self.assertRaises(ValueError):
            prepare(prepare(source()))

    def test_resolved_credentials_are_not_interpolated_twice(self):
        result = prepare(source())
        escaped = escape_interpolation(result)
        self.assertEqual(escaped['services']['auto-model-router']['environment']['ADMIN_TOKEN'],
                         'fixture$$literal$${UNCHANGED}token')
        self.assertEqual(decode_config_output(escaped), result)
        if os.environ.get('AMR_VERIFY_COMPOSE') == '1':
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / 'compose.json'
                path.write_text(json.dumps(escaped), encoding='utf-8')
                parsed = json.loads(subprocess.check_output(['docker', 'compose', '-f', str(path), 'config', '--format', 'json'], stderr=subprocess.PIPE))
                self.assertEqual(decode_config_output(parsed)['services']['auto-model-router']['environment']['ADMIN_TOKEN'],
                                 result['services']['auto-model-router']['environment']['ADMIN_TOKEN'])


if __name__ == '__main__':
    unittest.main()
