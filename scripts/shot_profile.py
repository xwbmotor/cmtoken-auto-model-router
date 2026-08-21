# -*- coding: utf-8 -*-
# 管理页「能力档案」截图：Selenium headless Chrome，注入 token、连上服务、切模型管理 tab、滚动到档案区、全页截图
import os, sys, time
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
env = {}
with open(os.path.join(ROOT, '.env'), encoding='utf-8') as f:
    for line in f:
        line = line.strip()
        if line.startswith('ADMIN_TOKEN='):
            env['ADMIN_TOKEN'] = line.split('=', 1)[1].strip()
token = env.get('ADMIN_TOKEN') or os.environ.get('ADMIN_TOKEN')
assert token, 'no ADMIN_TOKEN'

from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By

opts = Options()
opts.add_argument('--headless=new')
opts.add_argument('--disable-gpu')
opts.add_argument('--window-size=1500,1600')
opts.add_argument('--hide-scrollbars')
d = webdriver.Chrome(options=opts)
try:
    d.get('http://127.0.0.1:8787/')
    time.sleep(2)
    d.execute_script("try{sessionStorage.setItem('routerAdminToken', arguments[0])}catch(e){}", token)
    # 简单模式默认隐藏 token 输入（专家模式才显示）；直接 JS 填值并触发 connect
    d.execute_script("const t=document.getElementById('token'); t.value=arguments[0]; document.getElementById('connect').click()", token)
    time.sleep(5)
    # 切模型管理 tab
    d.execute_script("document.querySelector('#tabs button[data-tab=models], button[data-tab=models]').click()")
    time.sleep(2)
    # 滚动到能力档案面板
    d.execute_script("document.querySelector('.profile-panel').scrollIntoView({block:'start'})")
    time.sleep(1)
    out = os.path.join(ROOT, 'data', 'profile-shot.png')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    d.save_screenshot(out)
    # 额外：点一个 sub-cell 看明细面板
    try:
        d.execute_script("document.querySelector('.sub-cell').click()")
        time.sleep(1)
        out2 = os.path.join(ROOT, 'data', 'profile-shot-detail.png')
        d.save_screenshot(out2)
        print('detail shot:', out2)
    except Exception as e:
        print('detail shot skip:', e)
    print('shot:', out)
    # 校验渲染内容
    rows = d.execute_script("return document.querySelectorAll('#profileRows tr').length")
    cells = d.execute_script("return document.querySelectorAll('#profileRows .sub-cell').length")
    print('profileRows tr:', rows, '| sub-cells:', cells)
finally:
    d.quit()
