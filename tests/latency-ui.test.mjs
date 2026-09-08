import { test } from 'node:test';
import { execFileSync } from 'node:child_process';

const python = ['python3', 'python', 'py'].find(command => {
  try { execFileSync(command, ['-c', 'import playwright'], { stdio: 'ignore' }); return true; } catch { return false; }
});
if (!python && process.env.AMR_TEST_STRICT_SKIP === '1') throw new Error('发布门禁：时延 UI 验收需要 python+playwright');

test('时延 UI：隔离样本、可信度、预算、重试、键盘和响应式布局', { skip: !python && '无 python+playwright', timeout: 90000 }, () => {
  const script = String.raw`
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
root = Path.cwd() / 'public'
html = '''<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/workspace.css"><link rel="stylesheet" href="/latency.css"></head><body class="console"><main><section hidden id="insights"><section id="latencyPanel" class="panel"></section></section></main><script type="module">
import {setupLatencyPanel} from '/latency.js';
const stats = {count:50,success:45,failed:3,cancelled:2,validCount:45,p50Ms:900,p95Ms:1800,p95Reliable:true,lastAt:'2026-09-08T08:00:00Z'};
window.calls=[];window.notices=[];window.failure=false;window.empty=false;window.post={accepted:true};window.budget=5;
window.reply={at:'2026-09-08T08:05:00Z',timeZone:'Asia/Shanghai',mode:'off',retentionDays:14,storage:{evictedBuckets:2,restoreErrors:1},rows:[{model:'sample-model',name:'<img src=x onerror=alert(1)>',recent5:{...stats,validCount:2,p95Reliable:false,p95Ms:123456},recent30:stats,today:stats,hours:[{hour:0,...stats},{hour:1,...stats,validCount:2,p95Reliable:false,p95Ms:123456}]}],probe:{enabled:false,running:false,callsToday:0,maxCallsPerDay:5},shadow:{count:2,changed:1}};
window.stop=setupLatencyPanel({api:async(path,options={})=>{window.calls.push(path); if(options.method==='POST')return window.post; if(window.failure)throw new Error('mock unavailable'); const result=structuredClone(window.reply);result.probe.maxCallsPerDay=window.budget;if(window.empty)result.rows=[];return result;},notify:(text,bad)=>window.notices.push({text,bad})});
window.ready=true;
</script></body></html>'''
errors=[]
with sync_playwright() as pw:
    browser=pw.chromium.launch(headless=True)
    page=browser.new_page(viewport={'width':1440,'height':1000})
    page.on('pageerror',lambda error:errors.append(str(error)))
    def route(request):
        name=request.request.url.rsplit('/',1)[-1]
        if name in ['styles.css','workspace.css','latency.css','latency.js']:
            request.fulfill(body=(root/name).read_text(encoding='utf-8'),content_type='text/javascript' if name.endswith('.js') else 'text/css')
        else: request.fulfill(body=html,content_type='text/html')
    page.route('http://latency.test/**',route)
    page.goto('http://latency.test/')
    page.wait_for_function('window.ready === true')
    assert page.evaluate('window.calls.length') == 0, 'hidden panel fetched'
    page.evaluate("document.getElementById('insights').hidden=false;document.dispatchEvent(new Event('workspace:navigate'))")
    expect(page.locator('.latency-model-card')).to_have_count(1)
    expect(page.locator('.latency-notice')).to_contain_text('影子评分未启用')
    expect(page.locator('.latency-operations')).to_contain_text('提前截断')
    expect(page.locator('.latency-operations')).to_contain_text('恢复失败')
    expect(page.locator('.latency-model-card img')).to_have_count(0)
    expect(page.locator('.latency-model-card')).to_contain_text('1,800 ms')
    page.locator('.latency-window select').select_option('recent5')
    expect(page.locator('.latency-model-card')).to_contain_text('P95 样本不足')
    assert '123,456' not in page.locator('.latency-model-card').inner_text()
    page.locator('.latency-table td').nth(1).focus()
    expect(page.locator('.latency-detail')).to_contain_text('P95 样本不足')
    expect(page.locator('.latency-detail')).to_contain_text('失败 3')
    expect(page.locator('.latency-table td').nth(2)).to_have_class('latency-heat-none')
    for metric in ['completionMs','attemptMs','firstOutputMs','ttftMs']:
        page.locator('select[name=metric]').select_option(metric)
        page.wait_for_function('(metric) => window.calls.at(-1).includes("metric="+metric)',arg=metric)
    expect(page.locator('.latency-note').first).to_contain_text('只统计成功样本')
    page.locator('select[name=source]').select_option('probe')
    page.wait_for_function('window.calls.at(-1).includes("source=probe")')
    for width in [1440,390]:
        page.set_viewport_size({'width':width,'height':900})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'page overflows horizontally'
        assert page.locator('.latency-table-wrap').evaluate('(el)=>el.scrollWidth>el.clientWidth'), 'table should scroll internally'
    page.evaluate('window.empty=true')
    page.get_by_role('button',name='刷新数据',exact=True).click()
    expect(page.locator('.latency-empty')).to_contain_text('暂无匹配样本')
    page.evaluate('window.empty=false;window.failure=true')
    page.get_by_role('button',name='刷新数据',exact=True).click()
    expect(page.locator('.latency-status')).to_contain_text('mock unavailable')
    assert page.evaluate('window.notices.at(-1).bad') is True
    before=page.evaluate('window.calls.length')
    page.evaluate("for(let i=0;i<10;i++)document.dispatchEvent(new Event('workspace:navigate'))")
    assert page.evaluate('window.calls.length') == before, 'error retries must back off'
    page.evaluate('window.failure=false;window.budget=0')
    page.get_by_role('button',name='刷新数据',exact=True).click()
    expect(page.locator('.latency-model-card')).to_have_count(1)
    expect(page.get_by_role('button',name='运行一次补测')).to_be_disabled()
    page.evaluate("window.budget=5;window.post={accepted:false,reason:'budget exhausted'}")
    page.get_by_role('button',name='刷新数据',exact=True).click()
    expect(page.get_by_role('button',name='运行一次补测')).to_be_enabled()
    page.get_by_role('button',name='运行一次补测').click()
    page.wait_for_function('window.notices.at(-1).text.includes("budget exhausted")')
    page.evaluate('window.stop()')
    assert errors == [], errors
    browser.close()
print('latency UI browser checks passed')
`;
  try { execFileSync(python, ['-c', script], { encoding: 'utf8', timeout: 80000 }); }
  catch (error) { throw new Error(`时延 UI 浏览器验收失败：${String(error.stderr || error.stdout || error.message).slice(-5000)}`); }
});
