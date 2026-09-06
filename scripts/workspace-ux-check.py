"""Real-browser UX checks against an isolated local server and copied config.
Run: python scripts/workspace-ux-check.py
No .env is loaded; no upstream inference is invoked.
"""
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.request
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'reports' / 'workspace-ux'
OUT.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix='amr-workspace-') as directory:
    config = json.loads((ROOT / 'config/router.json').read_text(encoding='utf-8'))
    config['decisionLog'] = {**config.get('decisionLog', {}), 'enabled': False}
    config['judge'] = {**config.get('judge', {}), 'enabled': False}
    cfgpath = Path(directory) / 'router.json'
    cfgpath.write_text(json.dumps(config), encoding='utf-8')
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    base = f'http://127.0.0.1:{port}'
    env = {**os.environ, 'PORT': str(port), 'HOST': '127.0.0.1', 'ADMIN_TOKEN': 'workspace-local-test', 'CONFIG_PATH': str(cfgpath), 'AMR_CONFIG_DIR': directory, 'AMR_COUNTERS_PATH': str(Path(directory) / 'counters.json')}
    server = subprocess.Popen(['node', 'src/server.mjs'], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(60):
            try:
                urllib.request.urlopen(base + '/health', timeout=1)
                break
            except Exception:
                time.sleep(.15)
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            page = browser.new_page(viewport={'width': 1440, 'height': 1000}, device_scale_factor=1)
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(base)
            page.fill('#adminToken', 'workspace-local-test')
            page.click('#loginBtn')
            expect(page.locator('#status')).to_contain_text('已连接')
            expect(page.locator('#modelCount')).to_contain_text('个模型')
            page.screenshot(path=str(OUT / 'overview-desktop.png'), full_page=True)
            page.click('#tabs [data-tab="models"]')
            count = page.locator('#models tr').count()
            page.fill('#modelSearch', 'no-such-model-ux-check')
            expect(page.locator('#modelCount')).to_have_text(f'显示 0 / {count} 个模型')
            page.click('#clearModelFilters')
            expect(page.locator('#models tr:visible')).to_have_count(count)
            page.evaluate('window.scrollTo(0,0)')
            page.screenshot(path=str(OUT / 'models-desktop.png'), full_page=True)
            page.click('#tabs [data-tab="insights"]')
            page.go_back()
            expect(page.locator('#pageTitle')).to_have_text('模型管理')
            page.click('#discoverModels')
            modal = page.locator('#discoverModal')
            expect(modal).to_be_visible()
            assert page.evaluate("document.getElementById('discoverModal').contains(document.activeElement)")
            # Close is first in the tab order; Shift+Tab wraps to the final input/button.
            page.focus('#discoverClose')
            page.keyboard.press('Shift+Tab')
            assert page.evaluate("document.getElementById('discoverModal').contains(document.activeElement)")
            page.keyboard.press('Escape')
            expect(modal).not_to_be_visible()
            expect(page.locator('#discoverModels')).to_be_focused()
            page.click('#tabs [data-tab="policy"]')
            page.click('#unlockEdit')
            field = page.locator('#activeTrafficPercent')
            original = field.input_value()
            field.fill('25' if original != '25' else '30')
            expect(page.locator('#draftBar')).to_be_visible()
            page.click('#tabs [data-tab="models"]')
            expect(page.locator('#draftBar')).to_be_visible()
            page.once('dialog', lambda dialog: dialog.dismiss())
            page.click('#discardDraft')
            expect(page.locator('#draftBar')).to_be_visible()
            page.once('dialog', lambda dialog: dialog.accept())
            page.click('#discardDraft')
            expect(page.locator('#draftBar')).not_to_be_visible()
            expect(field).to_have_value(original)
            # Verify exactly one config PUT when the publish control is clicked twice.
            page.click('#tabs [data-tab="policy"]')
            if page.locator('#unlockEdit').is_visible():
                page.click('#unlockEdit')
            field.fill('25' if original != '25' else '30')
            puts = []
            page.on('request', lambda request: puts.append(request.url) if request.method == 'PUT' and request.url.endswith('/admin/api/config') else None)
            page.on('dialog', lambda dialog: dialog.accept())
            page.evaluate("document.getElementById('save').click(); document.getElementById('save').click()")
            expect(page.locator('#publishReview')).to_be_visible()
            page.screenshot(path=str(OUT / 'publish-review.png'))
            page.click('#confirmPublish')
            expect(page.locator('#toast')).to_contain_text('配置已发布生效', timeout=20000)
            expect(page.locator('#unlockEdit')).to_be_visible()
            expect(field).to_be_disabled()
            expect(page.locator('#draftBar')).not_to_be_visible()
            assert len(puts) == 1, puts
            # Endpoint/key validation must run before publishing any config.
            page.click('#unlockEdit')
            page.click('#tabs [data-tab="semantic"]')
            page.fill('#judgeSecretBaseUrl', 'https://example.invalid/v1')
            page.click('#reviewDraft')
            page.click('#save')
            expect(page.locator('#errorNotice')).to_contain_text('需要同时填写')
            assert len(puts) == 1
            expect(page.locator('#draftBar')).to_be_visible()
            page.wait_for_timeout(3200)
            expect(page.locator('#errorNotice')).to_be_visible()
            page.click('#dismissError')
            page.click('#discardDraft')
            expect(page.locator('#judgeSecretBaseUrl')).to_have_value('')
            # Failed secret write must retain input and not claim complete success.
            page.click('#tabs [data-tab="semantic"]')
            page.fill('#judgeSecretBaseUrl', 'https://example.invalid/v1')
            page.fill('#judgeSecretApiKey', 'test-only-value')
            page.route('**/admin/api/judge/secret', lambda route: route.fulfill(status=503, json={'error': {'message': '模拟写入失败'}}) if route.request.method == 'PUT' else route.continue_())
            page.click('#reviewDraft')
            page.click('#save')
            page.click('#confirmPublish')
            expect(page.locator('#errorNotice')).to_contain_text('路由配置已发布，但评审通道保存失败', timeout=20000)
            expect(page.locator('#judgeSecretApiKey')).to_have_value('test-only-value')
            expect(page.locator('#draftBar')).to_be_visible()
            page.click('#dismissError')
            page.click('#discardDraft')
            # Another administrator publishes after this page loaded: reject the old draft.
            page.click('#tabs [data-tab="policy"]')
            if page.locator('#unlockEdit').is_visible():
                page.click('#unlockEdit')
            field.fill('35')
            remote = page.request.get(base + '/admin/api/config')
            newer = remote.json()
            newer['routing']['activeTrafficPercent'] = 40
            published = page.request.put(base + '/admin/api/config', headers={'If-Match': remote.headers['etag']}, data=newer)
            assert published.status == 200
            page.click('#save')
            page.click('#confirmPublish')
            expect(page.locator('#errorNotice')).to_contain_text('线上配置已被其他操作修改')
            expect(field).to_have_value('35')
            expect(page.locator('#draftBar')).to_be_visible()
            assert page.request.get(base + '/admin/api/config').json()['routing']['activeTrafficPercent'] == 40
            page.click('#dismissError')
            page.locator('.connection-options summary').click()
            page.click('#connect')
            expect(field).to_have_value('40')
            page.locator('.connection-options summary').click()
            # Task list recovery uses read-only fixture data, never paid upstream work.
            fixture = {'id': 'ux-fixture', 'type': 'checkup', 'modelId': 'fixture-model', 'status': 'done', 'startedAt': '2026-09-06T00:00:00Z', 'finishedAt': '2026-09-06T00:01:00Z', 'total': 6, 'done': 6, 'failed': 0}
            page.route('**/admin/api/eval-jobs', lambda route: route.fulfill(json={'jobs': [fixture], 'survivesRestart': False, 'retentionHours': 2}))
            page.route('**/admin/api/eval-jobs?id=*', lambda route: route.fulfill(json=fixture))
            page.click('#tabs [data-tab="models"]')
            expect(page.locator('#evalTaskList')).to_contain_text('fixture-model')
            page.get_by_role('button', name='查看结果', exact=True).click()
            expect(page.locator('#evalBody')).to_contain_text('6/6')
            page.wait_for_timeout(5200)
            page.keyboard.press('Escape')
            expect(page.get_by_role('button', name='查看结果', exact=True)).to_be_focused()
            page.get_by_role('button', name='查看结果', exact=True).click()
            expect(page.locator('#evalBody')).to_contain_text('6/6')
            page.keyboard.press('Escape')
            page.select_option('#modelColumnView', 'pricing')
            expect(page.locator('#models .input-price').first).to_be_visible()
            page.select_option('#modelColumnView', 'common')
            expect(page.locator('#models .input-price').first).not_to_be_visible()
            page.unroute('**/admin/api/eval-jobs')
            page.unroute('**/admin/api/eval-jobs?id=*')
            # Refresh failure retains actionable feedback.
            page.route('**/admin/api/metrics', lambda route: route.fulfill(status=503, json={'error': {'message': '模拟服务暂不可用'}}))
            page.click('#tabs [data-tab="overview"]')
            page.click('#refresh')
            expect(page.locator('#errorNotice')).to_contain_text('模拟服务暂不可用')
            page.click('#dismissError')
            page.unroute('**/admin/api/metrics')
            page.locator('.connection-options summary').click()
            page.click('#connect')
            expect(page.locator('#status')).to_contain_text('已连接')
            page.locator('.connection-options summary').click()
            # All pages must contain overflow within tables on narrow screens.
            overflow = []
            for width in [1440, 1024, 390]:
                page.set_viewport_size({'width': width, 'height': 900})
                for name in ['overview', 'policy', 'models', 'insights', 'semantic', 'debug', 'help']:
                    page.locator(f'#tabs [data-tab="{name}"]').click()
                    page.wait_for_timeout(150)
                    delta = page.evaluate('document.documentElement.scrollWidth - innerWidth')
                    if delta > 1:
                        overflow.append([width, name, delta])
                    if width == 390 and name == 'overview':
                        page.screenshot(path=str(OUT / 'overview-mobile.png'), full_page=True)
            assert not overflow, overflow
            assert not errors, errors
            result = {'checks': ['navigation history', 'model filters', 'modal keyboard and focus return', 'cross-page draft', 'discard confirmation', 'single-submit publish and relock', 'publication change review', 'cross-session stale-write rejection', 'task progress recovery', 'model column views', 'secret prevalidation', 'partial failure preserves draft', 'persistent errors', 'reconnect', '7 pages at 3 viewport widths'], 'pageErrors': errors, 'overflow': overflow, 'configWrites': len(puts), 'productionConfigModified': False}
            (OUT / 'results.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
            print(json.dumps(result, ensure_ascii=False))
            browser.close()
    finally:
        server.terminate()
        server.wait(timeout=10)
