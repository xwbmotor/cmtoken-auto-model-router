"""Actual browser check against compare-gateways' disposable local fixture."""
import json
import os
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

base = sys.argv[1]
if not base.startswith('http://127.0.0.1:'):
    raise RuntimeError('local fixture required')
out = Path(sys.argv[2]); out.mkdir(parents=True, exist_ok=True)
with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True)
    context = browser.new_context(viewport={'width': 1440, 'height': 1000})
    response = context.request.post(base + '/admin/api/login', data={'token': os.environ['AMR_UI_ADMIN_TOKEN']})
    assert response.status == 200
    page = context.new_page(); errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(base)
    panel = page.get_by_role('region', name='实验 Go 核心')
    expect(panel).to_be_visible()
    expect(panel.locator('[data-core-status]')).to_have_text('Go 已加载当前保存的配置。')
    response = context.request.get(base + '/admin/api/config')
    config = response.json(); config['routing']['costWeight'] += .002
    response = context.request.put(base + '/admin/api/config', data=config, headers={'If-Match': response.headers['etag']})
    assert response.status == 200
    panel.get_by_role('button', name='查询状态').click()
    expect(panel.locator('[data-core-status]')).to_contain_text('尚未同步')
    page.screenshot(path=str(out / 'go-core-unsynchronized.png'), full_page=False)
    panel.locator('[data-core-reload]').click()
    expect(panel.locator('[data-core-status]')).to_have_text('Go 已加载当前保存的配置。')
    page.screenshot(path=str(out / 'go-core-synchronized.png'), full_page=False)
    page.set_viewport_size({'width': 390, 'height': 844})
    page.screenshot(path=str(out / 'go-core-mobile.png'), full_page=False)
    assert panel.locator('[data-core-reload]').is_visible()
    assert not errors, errors
    (out / 'go-core-ui.json').write_text(json.dumps({'browser': 'chromium', 'login': True, 'savedVsActive': True, 'reload': True, 'pageErrors': errors}, indent=2), encoding='utf-8')
    browser.close()
