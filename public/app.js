let config, savedConfig, metrics, lastSimulation, simulateTimer;
const $ = (id) => document.getElementById(id);
//—— 后台枚举 → 中文展示映射（只影响展示，不碰配置值）——
const TASK_CN = { coding: '代码', reasoning: '推理', creative: '创意', extraction: '抽取', default: '通用' };
//OpenRouter rankings TASK TYPE 官方 30 小类 → 4 大类（+Pinned）
const SUB_CATEGORY = { 'code-generation': ['代码', 'CODE', '⚙️', '代码生成'], debugging: ['代码', 'CODE', '⚙️', '调试'], 'code-review': ['代码', 'CODE', '⚙️', '代码审查'], 'sql-database': ['代码', 'CODE', '⚙️', 'SQL 与数据库'], 'frontend-ui': ['代码', 'CODE', '⚙️', '前端与 UI'], 'devops-config': ['代码', 'CODE', '⚙️', 'DevOps 与配置'], 'shell-execution': ['代码', 'CODE', '⚙️', 'Shell 执行'], 'file-io': ['代码', 'CODE', '⚙️', '文件读写'], 'repo-scanning': ['代码', 'CODE', '⚙️', '仓库扫描'], 'multi-step-planning': ['智能体', 'AGENTS', '🤖', '多步规划'], 'tool-dispatch': ['智能体', 'AGENTS', '🤖', '工具调度'], 'workflow-execution': ['智能体', 'AGENTS', '🤖', '工作流执行'], 'web-search': ['智能体', 'AGENTS', '🤖', 'Web 搜索'], 'memory-extraction': ['智能体', 'AGENTS', '🤖', '记忆提取'], 'devops-agent': ['智能体', 'AGENTS', '🤖', 'DevOps 智能体'], 'data-extraction': ['数据', 'DATA', '📋', '数据抽取'], 'data-transformation': ['数据', 'DATA', '📋', '数据转换'], classification: ['数据', 'DATA', '📋', '分类'], summarization: ['数据', 'DATA', '📋', '摘要'], translation: ['数据', 'DATA', '📋', '翻译'], math: ['数据', 'DATA', '📋', '数学'], 'content-writing': ['写作与对话', 'WRITING & CHAT', '💬', '内容写作'], 'research-reports': ['写作与对话', 'WRITING & CHAT', '💬', '研究与报告'], 'qa-knowledge': ['写作与对话', 'WRITING & CHAT', '💬', '问答与知识'], conversation: ['写作与对话', 'WRITING & CHAT', '💬', '对话'], 'customer-support': ['写作与对话', 'WRITING & CHAT', '💬', '客户支持'], 'roleplay-fiction': ['写作与对话', 'WRITING & CHAT', '💬', '角色扮演与虚构'], 'finance-trading': ['写作与对话', 'WRITING & CHAT', '💬', '金融与交易'], 'security-audit': ['写作与对话', 'WRITING & CHAT', '💬', '安全审计'], other: ['写作与对话', 'WRITING & CHAT', '💬', '其他'], pinned: ['指定模型', 'PINNED', '📌', '用户点名'] };
function subCategoryOf(task, subTask) { if (task === 'explicit') return SUB_CATEGORY.pinned; if (SUB_CATEGORY[subTask]) return SUB_CATEGORY[subTask]; const fb = { default: 'qa-knowledge', coding: 'code-generation', reasoning: 'research-reports', creative: 'content-writing', extraction: 'data-extraction', agent: 'workflow-execution' }[task]; return SUB_CATEGORY[fb] || SUB_CATEGORY.other; }
const TIER_CN = { simple: '轻量', balanced: '均衡', complex: '复杂' };
const METHOD_CN = { rules: '规则', semantic: '语义复核', 'rules+semantic': '规则+复核' };
const taskCN = (t) => TASK_CN[t] || t;
const escHtml = (x) => String(x ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const tierCN = (t) => TIER_CN[t] || t;
//成本档位（OpenRouter cost_tier 思路）：档位=参数预设+成本带双向过滤（服务端 COST_TIERS 同步生效）。
//band 非 ceiling：质量/顶配档会把「过于便宜」的低端模型也排除，防止拉低整体质量。
const TASK_LABELS = { default: '通用', coding: '代码', reasoning: '推理', extraction: '抽取', creative: '创意', agent: '智能体', explicit: '点名模型' };
const PRESETS = {
  budget:  { label: '省钱档：低成本模型优先，跑简单/批量任务最划算。', qualityFloor: 0.76, costWeight: 0.4,  latencyWeight: 0.14, selfHostedBonus: 0.28 },
  balanced:{ label: '均衡档：质量成本兼顾，默认推荐（内网生产建议）。', qualityFloor: 0.82, costWeight: 0.22, latencyWeight: 0.15, selfHostedBonus: 0.2 },
  quality: { label: '质量档：排除低端模型，复杂任务更稳。', qualityFloor: 0.88, costWeight: 0.1,  latencyWeight: 0.1,  selfHostedBonus: 0.12 },
  max:     { label: '顶配档：只用最强模型，不计成本（评测/演示场景）。', qualityFloor: 0.9,  costWeight: 0,    latencyWeight: 0.05, selfHostedBonus: 0.1 },
  custom:  { label: '自定义：手动微调滑条后的状态，档位过滤已解除。' }
};
//路由风格预设：四权重一键组合。与成本档位正交——档位管价格带过滤，风格管评分权重。
//运营成本优先：providerCostWeight 拉到 0.4，流量更多导向平台指数低的模型（q36 0.115 单实例占用少并发高）。
const STYLE_PRESETS = {
  'quality-first':      { label: '质量优先：质量权重拉满，成本时延仅微调（对外演示/评测）。', qualityWeight: 1, costWeight: 0.08, providerCostWeight: 0.05, latencyWeight: 0.08, qualityFloor: 0.80 },
  'user-cost-first':    { label: '用户成本优先：用户侧豆价权重拉高，替调用方省钱。', qualityWeight: 1, costWeight: 0.45, providerCostWeight: 0.10, latencyWeight: 0.10, qualityFloor: 0.72 },
  'provider-cost-first':{ label: '运营成本优先：平台侧资源指数权重拉高，更多导向低占用高并发模型。', qualityWeight: 1, costWeight: 0.22, providerCostWeight: 0.40, latencyWeight: 0.10, qualityFloor: 0.72 },
  'efficiency-first':   { label: '效率优先：时延权重拉高，首字快总时长短（交互场景）。', qualityWeight: 1, costWeight: 0.15, providerCostWeight: 0.05, latencyWeight: 0.45, qualityFloor: 0.72 },
  'balanced-style':     { label: '均衡风格：四权重均衡（现网默认组合）。', qualityWeight: 1, costWeight: 0.22, providerCostWeight: 0.10, latencyWeight: 0.14, qualityFloor: 0.72 }
};
function headers(json = false) { const token = $('token').value.trim(); return { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(json ? { 'content-type': 'application/json' } : {}) }; } //token 留空时靠登录会话 cookie（HttpOnly），API 侧 Bearer/会话二选一
async function api(path, options = {}) { const response = await fetch(path, { ...options, headers: { ...headers(Boolean(options.body)), ...(options.headers || {}) } }); const value = await response.json(); if (!response.ok) throw new Error(value.error?.message || `HTTP ${response.status}`); return value; }
function toast(message, bad = false) { const node = $('toast'); node.textContent = message; node.style.background = bad ? '#b42318' : '#101828'; node.classList.add('show'); setTimeout(() => node.classList.remove('show'), 3000); }
const percentValue = (value) => `${Math.round(Number(value) * 100)}%`;
//敏感度滑条：显示「档位 · 具体数值」，档位仅是快速读法，数值才是真实配置
const sensitivity = (value) => Number(value) < .15 ? '低' : Number(value) < .3 ? '中' : Number(value) < .45 ? '高' : '很高';
const sensLabel = (value) => `${sensitivity(value)} · ${Number(value).toFixed(2)}`;
function markTierCustom() {
  document.querySelectorAll('#tierPicker .tier').forEach((x) => x.classList.toggle('active', x.dataset.tier === 'custom'));
  const radio = document.querySelector('input[name="costTier"][value="custom"]');
  if (radio) radio.checked = true;
  config.routing = config.routing || {}; config.routing.costTier = 'custom';
}
//任务榜单：各类任务实际路由给了谁（近 2000 条决策聚合，学 OpenRouter task-spend rankings）
async function renderTaskBoard() {
  const rows = $('taskBoardRows'); if (!rows) return;
  try {
    const data = await api('/admin/api/task-board');
    if (!data.board?.length) { rows.innerHTML = '<tr><td colspan="5" class="empty">暂无决策记录（需开启决策日志）。</td></tr>'; return; }
    rows.innerHTML = data.board.map((b) => {
      const cells = [0, 1, 2].map((i) => b.picks[i]
        ? `<td>${escHtml(b.picks[i].model)} <span class="pill ${i === 0 ? 'good' : 'muted'}">${b.picks[i].share}%${b.picks[i].fails ? ` ·失败${b.picks[i].fails}` : ''}</span></td>`
        : '<td class="empty">—</td>').join('');
      const sc = subCategoryOf(b.task, b.sub);
      const subLabel = b.subLabel || sc[3];
      const icon = b.categoryIcon || sc[2];
      const catLabel = b.category || sc[0];
      const catEn = b.categoryEn || sc[1];
      return `<tr><th>${icon} ${catLabel} · ${subLabel}<br><span class="task-cat">${catEn}</span></th><td>${b.total}</td>${cells}</tr>`;
    }).join('');
  } catch (e) { rows.innerHTML = `<tr><td colspan="5" class="empty">${escHtml(String(e.message))}</td></tr>`; }
}
//市场信号状态：飞轮健康度（激活任务数/休眠原因），样本不足时明说「等真实流量」
async function renderMarketSignal() {
  const badge = $('marketSignalBadge'); const box = $('marketSignalBox');
  if (!badge || !box) return;
  try {
    const data = await api('/admin/api/market-signal');
    const st = data.status;
    badge.style.display = '';
    if (!st.tasksTracked) {
      badge.textContent = '市场信号：待数据'; badge.className = 'pill muted';
      box.hidden = true; return;
    }
    badge.textContent = `市场信号：${st.tasksActive}/${st.tasksTracked} 任务激活`;
    badge.className = 'pill ' + (st.tasksActive ? 'good' : 'muted');
    if (st.tasksActive) {
      const lines = Object.entries(data.signals || {}).map(([task, models]) => {
        const items = Object.entries(models).map(([m, sg]) => {
          const adj = sg.adjust ? `<span style="color:${sg.adjust > 0 ? 'var(--good,#067647)' : 'var(--danger,#b42318)'};font-weight:600">（${sg.adjust > 0 ? '+' : ''}${sg.adjust}）</span>` : '';
          const fails = sg.fails ? ` <span style="color:var(--danger,#b42318)">失败${sg.fails}</span>` : '';
          return `${escHtml(m)} ${sg.share}%${adj}${fails}`;
        }).join('；');
        return `<div><strong>${TASK_LABELS[task] || task}</strong>：${items}</div>`;
      }).join('');
      box.hidden = false;
      box.innerHTML = `<p class="hint"><strong>白话版：哪个模型最近跑得好就多派活，跑砸了就少派活。</strong><br>机制：看最近 ${st.windowDays} 天的真实使用（样本太少不动，避免小数据乱调；调整幅度封顶 ±${st.maxAdjust}，只微调不颠覆跑分）。份额领先者加成、失败多者降权、被点名者小幅加成。</p>${lines}`;
    } else box.hidden = true;
  } catch { badge.style.display = 'none'; }
}
//路由体检：auto vs 单模型基线（OpenRouter 评测叙事模板）
async function renderRoutingReport() {
  const rows = $('reportRows'); const hl = $('reportHighlights');
  if (!rows) return;
  rows.innerHTML = '<tr><td colspan="4" class="empty">计算中…</td></tr>';
  try {
    const data = await api('/admin/api/routing-report');
    rows.innerHTML = data.arms.map((a) => `<tr${a.name.startsWith('auto') ? ' style="font-weight:600;background:#f5f6fc"' : ''}><th>${escHtml(a.name)}${a.name.startsWith('auto') ? ' ⭐' : ''}</th><td>${a.quality}</td><td>${a.costIndex}</td><td>${a.latencyIndex}</td></tr>`).join('');
    hl.innerHTML = (data.highlights || []).map((t) => `<div class="highlight">${escHtml(t)}</div>`).join('');
  } catch (e) { rows.innerHTML = `<tr><td colspan="4" class="empty">${escHtml(String(e.message))}</td></tr>`; }
}
//总览 · 策略快照 + 任务分布（撑起总览信息密度）
const TIER_SNAP = { budget: '省钱', balanced: '均衡', quality: '质量', max: '顶配', custom: '自定义' };
function renderOverview() {
  if (!config) return;
  //策略快照
  const snap = $('policySnapshot');
  if (snap) {
    const r = config.routing || {};
    const rows = [
      ['成本档位', TIER_SNAP[r.costTier] || '均衡'],
      ['运行状态', r.mode === 'active' ? '正式生效' : '仅观察'],
      ['Auto 生效流量', (r.activeTrafficPercent ?? 100) + '%'],
      ['最低质量目标', (r.qualityFloor ?? 0.82).toFixed(2)],
      ['成本敏感度', (r.costWeight ?? 0.22).toFixed(2)],
      ['平台资源敏感度', (r.providerCostWeight ?? 0).toFixed(2)],
      ['速度敏感度', (r.latencyWeight ?? 0.1).toFixed(2)]
    ];
    snap.innerHTML = rows.map(([k, v]) => `<div><small>${k}</small><b>${v}</b></div>`).join('');
  }
  //任务分布（用决策日志 metrics.counters.task）
  const dist = $('taskDist');
  if (dist) {
    const t = metrics?.counters?.task || {};
    const entries = Object.entries(t).sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((a, [, v]) => a + v, 0) || 1;
    if (!entries.length) { dist.innerHTML = '<p class="empty">暂无任务数据。</p>'; }
    else {
      dist.innerHTML = entries.slice(0, 6).map(([k, v]) => {
        const pct = (v / total * 100);
        return `<div class="dist-row"><span>${TASK_LABELS[k] || k}</span><div class="bar"><i style="width:${pct}%"></i></div><b>${v}</b><small>${pct.toFixed(0)}%</small></div>`;
      }).join('');
    }
  }
}

function updateRangeLabels() { $('trafficValue').textContent = `${$('activeTrafficPercent').value}%`; $('qualityFloorValue').textContent = `≥ ${percentValue($('qualityFloor').value)}`; $('costWeightValue').textContent = sensLabel($('costWeight').value); $('latencyWeightValue').textContent = sensLabel($('latencyWeight').value); $('providerCostWeightValue').textContent = sensLabel($('providerCostWeight').value); $('selfBonusValue').textContent = `+${Number($('selfBonus').value).toFixed(2)}`; $('presetHelp').textContent = PRESETS[document.querySelector('input[name="costTier"]:checked')?.value]?.label || PRESETS.custom.label; }
//脏标记：表单与已发布版本不一致时提示「有未发布修改」，避免不知道改没改成
//diff 驱动而非交互驱动——拖回原值/改了又撤销会自动熄灭；键序无关深比较，server 端规范化重排键也不误报
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}
function syncDirty() { if (!config || !savedConfig) return; readForm(); const dirty = stableStringify(config) !== stableStringify(savedConfig); const badge = $('dirtyBadge'); if (badge) badge.hidden = !dirty; const dot = $('tabDirtyDot'); if (dot) dot.hidden = !dirty; }
//基线规范化：savedConfig 必须与 readForm 之后的 config 同形状（readForm 会补 pricingYuan…/performance 等默认键），
//否则 diff 永不相等。凡重建基线（connect/发布成功）处，先 render 表单再 readForm 再 snapshot。
function snapshotBaseline() { bindPolicy(); bindProfile(); renderModels(); renderProviderColumn(); renderProfile(); renderCapabilityMatrix(); renderDeployment(); readForm(); savedConfig = structuredClone(config); clearDirty(); }
//—— 页面 Tab 切换 ——
const TABS = ['overview','policy','models','insights','semantic','debug','help'];
function applyTab(name) {
  if (!TABS.includes(name)) name = 'overview';
  document.querySelectorAll('.tab-page').forEach(p => { p.hidden = p.dataset.tab !== name; });
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  history.replaceState(null, '', '#' + name);
  sessionStorage.setItem('routerTab', name);
  //切 tab 后回到页首：否则从长页面（如总览底部）跳手册时，视口仍停在中后段
  window.scrollTo({ top: 0 });
}
document.querySelectorAll('#tabs button').forEach(b => { b.onclick = () => applyTab(b.dataset.tab); });

//── 业务策略只读锁：默认只读，点「解锁修改」才能调整 ──
const POLICY_INPUTS = ['#mode', '#activeTrafficPercent', '#semanticActivePercent', '#judgeEnabled', '#judgeTaskCheckEnabled', '#judgeSamplePercent', '#judgeModel', '#judgeDailyMaxCalls', '#judgeDailyMaxTokens', '#judgeTimeoutMs', '#judgeCircuitThreshold', '#judgeSecretBaseUrl', '#judgeSecretApiKey', '#preferSelf', '#reasoningEnabled', '#decisionLogEnabled', '#logFullRequest', '#logAnswerText',
  '#costTier', '#qualityFloor', '#costWeight', '#providerCostWeight', '#latencyWeight', '#budgetEnabled', '#dailyBudget',
  '#budgetThreshold', '#selfBonus', '#qualityWeight', '#complexQualityMargin', '#uncertaintyPenalty', '#maxAttempts',
  '#relQualityCapSimple', '#relQualityCapBalanced', '#relQualityCapComplex', '#subtaskSmoothK',
  '#semanticSmallAccept', '#semanticFinalAdoption']
  .flatMap(sel => Array.from(document.querySelectorAll(sel))).concat(
    Array.from(document.querySelectorAll('#tierPicker input'))).concat(
    Array.from(document.querySelectorAll('#stylePicker input')));
function setPolicyLock(locked) {
  POLICY_INPUTS.forEach(el => { el.disabled = locked; });
  const note = $('policyLockNote'); if (note) note.hidden = !locked;
  const unlock = $('unlockEdit'); if (unlock) unlock.hidden = !locked;
  const relock = $('relockEdit'); if (relock) relock.hidden = locked;
  const reload = $('reload'); if (reload) reload.hidden = locked && !isDirty();
  const save = $('save'); if (save) save.hidden = locked;
  document.body.classList.toggle('policy-locked', locked);
}
let policyUnlocked = false;
if ($('unlockEdit')) $('unlockEdit').onclick = () => {
  policyUnlocked = true;
  setPolicyLock(false);
  toast('已解锁——调整后记得「安全发布」');
};
//重新锁定：改完不想发布（或只是看看），一键回到只读态并丢弃未发布修改
if ($('relockEdit')) $('relockEdit').onclick = () => {
  if (isDirty() && !window.confirm('有未发布的修改，重新锁定将丢弃这些修改。继续吗？')) return;
  policyUnlocked = false;
  if (savedConfig) { config = structuredClone(savedConfig); snapshotBaseline(); scheduleSimulation(); }
  setPolicyLock(true);
  toast('已回到只读视图');
};
//发布成功后自动回锁：安全发布本身就是一次完整事务，结束后不需要继续编辑态
const __origSave = $('save')?.onclick?.bind($('save'));
if (__origSave) $('save').onclick = async () => { await __origSave(); if (!isDirty()) { policyUnlocked = false; setPolicyLock(true); } };
function isDirty() { try { return config && savedConfig && stableStringify(config) !== stableStringify(savedConfig); } catch { return false; } }
//初始 tab：URL hash > 上次停留 > overview
applyTab((location.hash || '').slice(1) || sessionStorage.getItem('routerTab') || 'overview');
loadManual();
if ($('gotoPolicy')) $('gotoPolicy').onclick = () => applyTab('policy');
if ($('gotoInsights')) $('gotoInsights').onclick = () => applyTab('insights');
for (const id of ['gotoManual', 'gotoManual2']) if ($(id)) $(id).onclick = () => applyTab('help');
//手册直嵌（不再 iframe）：拉预渲染页，用 Shadow DOM 隔离样式（手册的全局选择器不污染管理页），
//目录 TOC 由这里手动生成（DOMParser 不执行页面脚本）。
function manualLegacyCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch { }
  document.body.removeChild(ta); return ok;
}
async function loadManual() {
  const host = $('manualInline'); if (!host || host.dataset.loaded) return;
  try {
    const res = await fetch('/manual');
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const styleEl = doc.querySelector('style');
    const layout = doc.querySelector('.layout');
    if (!layout) throw new Error('手册模板结构变化');
    const shadow = host.attachShadow({ mode: 'open' });
    if (styleEl) {
      const st = document.createElement('style');
      //嵌入模式适配：去顶栏、占满、TOC 粘滞
      st.textContent = styleEl.textContent + '\nheader.top{display:none}body{background:transparent}.layout{max-width:none;padding:0;gap:24px}nav.toc{position:sticky;top:0;max-height:76vh}main.doc{border:none;box-shadow:none;border-radius:0;padding:6px 26px 24px}';
      shadow.appendChild(st);
    }
    shadow.appendChild(document.importNode(layout, true));
    //生成目录（复刻 /manual 页内脚本逻辑）
    const toc = shadow.querySelector('nav.toc');
    const heads = Array.from(shadow.querySelectorAll('main.doc h2, main.doc h3'));
    if (toc && heads.length) {
      const title = document.createElement('div');
      title.className = 'toc-title'; title.textContent = '目录';
      toc.appendChild(title);
      heads.forEach((h, i) => {
        if (!h.id) h.id = 'sec-' + i;
        const a = document.createElement('a');
        a.href = '#' + h.id; a.textContent = h.textContent;
        if (h.tagName === 'H3') a.style.paddingLeft = '30px';
        //Shadow DOM 内 href="#..." 的原生锚点跳转不生效（不穿透 shadow root）——手动滚动
        a.addEventListener('click', (ev) => {
          ev.preventDefault();
          h.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        toc.appendChild(a);
      });
      //滚动高亮（监听管理页窗口滚动，按视口位置点亮当前节）
      const links = Array.from(toc.querySelectorAll('a'));
      const onScroll = () => {
        let cur = null;
        heads.forEach((h) => { if (h.getBoundingClientRect().top < 100) cur = h.id; });
        links.forEach((a) => a.className = a.getAttribute('href') === '#' + cur ? 'active' : '');
      };
      window.addEventListener('scroll', onScroll, { passive: true });
      onScroll();
    }
    //代码块复制按钮（同 /manual 独立页；clipboard 失败退回 execCommand）
    shadow.querySelectorAll('pre').forEach((pre) => {
      const btn = document.createElement('button');
      btn.className = 'copy-btn'; btn.type = 'button'; btn.textContent = '复制';
      btn.addEventListener('click', () => {
        const text = pre.querySelector('code') ? pre.querySelector('code').textContent : pre.textContent;
        const done = (ok) => {
          btn.textContent = ok ? '已复制 ✓' : '复制失败';
          btn.classList.toggle('copied', ok);
          setTimeout(() => { btn.textContent = '复制'; btn.classList.remove('copied'); }, 1600);
        };
        if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(() => done(true), () => done(manualLegacyCopy(text)));
        else done(manualLegacyCopy(text));
      });
      pre.appendChild(btn);
    });
    host.dataset.loaded = '1';
  } catch (e) { host.innerHTML = '<p class="empty">手册加载失败：' + escHtml(e.message) + ' <a href="/manual" target="_blank" rel="noopener">在新窗口打开</a></p>'; }
}
if ($('gotoInsights')) $('gotoInsights').onclick = () => applyTab('insights');

function clearDirty() { const badge = $('dirtyBadge'); if (badge) badge.hidden = true; }
function applyPolicyLock() { setPolicyLock(!policyUnlocked); }
//评审通道 masked 状态回填 + 清除按钮（key 只写不读：提交后输入框即清空）
async function loadJudgeSecretStatus() {
  try {
    const js = await api('/admin/api/judge/secret');
    const st = $('judgeSecretStatus');
    if (js.apiKeySet) {
      st.textContent = `已配置（…${js.apiKeyPreview}）· 端点 ${js.baseUrl}`;
      $('judgeSecretBaseUrl').placeholder = js.baseUrl;
      $('judgeSecretApiKey').placeholder = `输入新值即轮换（当前 …${js.apiKeyPreview}）`;
    } else { st.textContent = '未配置（judge 将 skipped:no_api_key）'; }
  } catch { $('judgeSecretStatus').textContent = '状态读取失败'; }
}
$('judgeSecretClear').onclick = async () => {
  if (!window.confirm('清空评审通道配置？清除后 judge 评审将因无 key 而跳过（业务不受影响）。')) return;
  try { await api('/admin/api/judge/secret', { method: 'PUT', body: JSON.stringify({ clear: true }) }); toast('评审通道已清空'); await loadJudgeSecretStatus(); }
  catch (e) { toast(e.message, true); }
};

//评审通道表单收集（同步；真正 PUT 在 saveConfig 的 async 路径里）
function readJudgeSecretForm() {
  const baseUrl = $('judgeSecretBaseUrl').value.trim(), apiKey = $('judgeSecretApiKey').value.trim();
  return (baseUrl || apiKey) ? { baseUrl, apiKey } : null;
}

function bindPolicy() {
  const r = config.routing; $('mode').value = r.mode; $('activeTrafficPercent').value = r.activeTrafficPercent ?? 100; $('autoModelId').value = r.autoModelId || 'auto'; $('exposeModelList').value = r.exposeModelList || 'auto-only'; $('qualityFloor').value = r.qualityFloor; $('selfBonus').value = r.selfHostedBonus; $('qualityWeight').value = r.qualityWeight; $('costWeight').value = r.costWeight; $('latencyWeight').value = r.latencyWeight; $('providerCostWeight').value = r.providerCostWeight ?? 0; $('uncertaintyPenalty').value = r.uncertaintyPenalty; $('complexQualityMargin').value = r.complexQualityMargin ?? .04; $('maxAttempts').value = r.maxAttempts; $('preferSelf').checked = r.preferSelfHosted;
  //新滑条
  const rel = r.relQualityCap || {}; $('relQualityCapSimple').value = rel.simple ?? 0.08; $('relQualityCapBalanced').value = rel.balanced ?? 0.04; $('relQualityCapComplex').value = rel.complex ?? 0.02; $('subtaskSmoothK').value = r.subtaskSmoothK ?? 8;
  $('semanticMode').value = config.semanticRouter?.mode || 'shadow'; $('semanticThreshold').value = config.semanticRouter?.confidenceThreshold ?? .7; $('semanticSmallAccept').value = config.semanticRouter?.smallAcceptThreshold ?? (config.semanticRouter?.minConfidence > 0 ? config.semanticRouter.minConfidence : 0.7); $('semanticFinalAdoption').value = config.semanticRouter?.finalAdoptionThreshold ?? (config.semanticRouter?.minConfidence ?? 0); $('semanticActivePercent').value = config.semanticRouter?.activeTrafficPercent ?? 5; $('reasoningEnabled').checked = Boolean(config.reasoningControl?.enabled); $('budgetEnabled').checked = Boolean(config.budget?.enabled); $('dailyBudget').value = config.budget?.dailyBudgetYuan || 0; $('budgetThreshold').value = config.budget?.degradeThreshold ?? .9;
  $('semanticProvider').value = config.semanticRouter?.provider || (config.semanticRouter?.model ? 'openai-chat' : 'disabled');
  $('judgeEnabled').checked = Boolean(config.judge?.enabled); $('judgeSamplePercent').value = config.judge?.samplePercent ?? 3; $('judgeModel').value = config.judge?.model || 'glm-5.3'; $('judgeDailyMaxCalls').value = config.judge?.dailyMaxCalls ?? 500; $('judgeDailyMaxTokens').value = config.judge?.dailyMaxTokens ?? 200000; $('judgeTimeoutMs').value = config.judge?.timeoutMs ?? 60000; $('judgeCircuitThreshold').value = config.judge?.circuitThreshold ?? 5; $('judgeTaskCheckEnabled').checked = Boolean(config.judge?.taskCheckEnabled);
  loadJudgeSecretStatus(); //通道 masked 状态异步回填（不阻塞表单绑定）
    const chatModel = config.semanticRouter?.openaiChat?.model || config.semanticRouter?.model;
  $('semanticModel').innerHTML = config.models.map((m) => `<option value="${escHtml(m.id)}" ${m.id === chatModel ? 'selected' : ''}>${escHtml(m.displayName || m.id)}</option>`).join('');
  $('semanticHttpUrl').value = config.semanticRouter?.httpJson?.url || '';
  //L1 规则定案占比（来自服务端 counters.routeMethod）：(rules+shadow) / (rules+shadow+semantic)
  const rm = metrics?.counters?.routeMethod || {};
  const rulesN = (rm.rules || 0) + (rm.rules_semantic_shadow || 0); const semN = rm.semantic || 0;
  const rc = $('rulesCoverage'); if (rc) { const tot = rulesN + semN; rc.textContent = tot ? `${Math.round(rulesN / tot * 100)}%（近 ${tot} 笔）` : '暂无流量'; rc.className = 'pill ' + (tot ? 'good' : 'muted'); }
  //pill 显示 guard 持久化口径（重启不重置）——预算用量/剩余额度/熔断态与执行闸一致；
  //进程级 sampled/qualityDone/errors 继续展示（抽样数是进程口径，guard 只记已结算调用）。
  const jm = (typeof metrics !== 'undefined' && metrics && metrics.judge) || null; const jt = $('judgeToday'); if (jt) { if (jm) { const g = jm.guard || {}; const circ = jm.gaugeCircuit === 2 ? '熔断' : (jm.gaugeCircuit === 1 ? '半开' : '正常'); const used = `${g.calls ?? 0}/${g.dailyMaxCalls ?? '?'} 次`; const tok = `${g.tokens ?? 0}/${g.dailyMaxTokens ?? '?'} tok`; const remain = Number.isFinite(Number(g.dailyMaxCalls)) && Number.isFinite(Number(g.calls)) ? ` · 余 ${Math.max(0, g.dailyMaxCalls - g.calls - (g.inflight || 0))} 次` : ''; jt.textContent = `今日 ${jm.sampled||0} 抽样 · ${jm.qualityDone||0} 评分 · ${jm.errors||0} 失败 | 预算 ${used} · ${tok}${remain} · ${circ}`; jt.className = jm.gaugeCircuit === 2 ? 'pill bad' : 'pill good'; } else { jt.textContent = '未启用'; jt.className = 'pill muted'; } }
  $('decisionLogEnabled').checked = Boolean(config.decisionLog?.enabled);
  $('logFullRequest').checked = config.decisionLog?.redactMessages === false;
  $('logAnswerText').checked = Boolean(config.decisionLog?.logAnswerText);
  const matched = Object.entries(PRESETS).find(([key, p]) => key !== 'custom' && ['qualityFloor','costWeight','latencyWeight','selfHostedBonus'].every((f) => Math.abs(r[f] - p[f]) < .005));
  const tierNow = matched?.[0] || (PRESETS[r.costTier] ? r.costTier : 'custom');
  const tierRadio = document.querySelector(`input[name="costTier"][value="${tierNow}"]`);
  if (tierRadio) tierRadio.checked = true;
  document.querySelectorAll('#tierPicker .tier').forEach((el) => el.classList.toggle('active', el.dataset.tier === tierNow));
  //风格预设回显：四权重+质量底线完全匹配才高亮，否则不高亮（保持 custom 状态诚实）
  const styleMatched = Object.entries(STYLE_PRESETS).find(([key, p]) => ['qualityWeight','costWeight','providerCostWeight','latencyWeight','qualityFloor'].every((f) => Math.abs((f === 'qualityWeight' ? r.qualityWeight ?? 1 : r[f]) - p[f]) < .005));
  const styleNow = r.routeStyle && STYLE_PRESETS[r.routeStyle] ? r.routeStyle : styleMatched?.[0];
  document.querySelectorAll('#stylePicker .tier').forEach((el) => el.classList.toggle('active', el.dataset.style === styleNow));
  const styleRadio = styleNow && document.querySelector(`input[name="routeStyle"][value="${styleNow}"]`);
  if (styleRadio) styleRadio.checked = true;
  updateRangeLabels();
}
function renderModels() { $('models').innerHTML = config.models.map((m, i) => `<tr data-index="${i}"><td><input class="enabled" type="checkbox" ${m.enabled ? 'checked' : ''}></td><td><strong>${escHtml(m.displayName || m.id)}</strong><br><small>${escHtml(m.id)}</small></td><td><select class="ownership"><option value="self_hosted" ${m.ownership === 'self_hosted' ? 'selected' : ''}>自建</option><option value="ecosystem" ${m.ownership === 'ecosystem' ? 'selected' : ''}>生态</option><option value="unknown" ${m.ownership === 'unknown' ? 'selected' : ''}>归属待定</option></select></td><td><input class="quality" type="number" min="0" max="1" step=".01" value="${m.quality.default}"></td><td><input class="cost" type="number" min="0" step=".01" value="${m.costIndex}"></td><td class="provider-cost">—</td><td><input class="latency" type="number" min="0" step=".01" value="${m.latencyIndex}"></td><td><input class="input-price" type="number" min="0" step=".01" placeholder="待配置" value="${m.pricingYuanPerMillionTokens?.input ?? ''}"></td><td><input class="cached-price" type="number" min="0" step=".01" placeholder="无折扣" value="${m.pricingYuanPerMillionTokens?.inputCached ?? ''}"></td><td><input class="output-price" type="number" min="0" step=".01" placeholder="待配置" value="${m.pricingYuanPerMillionTokens?.output ?? ''}"></td><td><input class="p95" type="number" min="0" step="1" placeholder="待观测" value="${m.performance?.totalP95Ms ?? ''}"></td><td><span class="pill ${(m.reliabilityStatus || m.calibrationStatus) === 'verified' ? 'good' : 'muted'}">${(m.reliabilityStatus || m.calibrationStatus) === 'verified' ? '可靠' : (m.reliabilityStatus || m.calibrationStatus) === 'pilot' ? 'Pilot' : '待观测'}</span></td><td><button class="btn-mini" data-act="checkup">体检</button><button class="btn-mini" data-act="full">巡检</button></td><td class="health">—</td></tr>`).join(''); }
//算力消耗指数列（成本双指标之一）：来自 deployment 数据 (机×卡×卡价)/tps，独立于用户侧豆价 costIndex
function providerIndexClient(m) { const d = m.deployment; if (!d || !d.machines || !d.tps) return null; const cw = Number((config.costModel?.cardPrice || {})[d.deviceType] || 1); const unit = Number(d.machines) * (Number(d.cardsPerMachine) || 1) * cw / Number(d.tps); return { unit }; }
function renderProviderColumn() { const units = config.models.map(providerIndexClient).map((x) => x?.unit).filter(Number.isFinite); const anchor = units.length ? Math.max(...units) : null; document.querySelectorAll('#models tr').forEach((row, i) => { const m = config.models[i]; const cell = row.querySelector('.provider-cost'); if (!cell) return; const p = providerIndexClient(m); cell.textContent = (p && anchor) ? Math.min(1, p.unit / anchor).toFixed(3) : '—'; }); }
function computeCostIndexClient(models, cardPrice) { const costs = []; for (const m of models) { const d = m.deployment; if (!d || !d.machines || !d.tps) continue; const cardWeight = Number(cardPrice[d.deviceType] || 1); const hw = Number(d.machines) * (Number(d.cardsPerMachine) || 1) * cardWeight; costs.push({ id: m.id, unitCost: hw / Number(d.tps) }); } if (!costs.length) return null; const max = Math.max(...costs.map((c) => c.unitCost)); if (!(max > 0)) return null; return Object.fromEntries(costs.map((c) => [c.id, Number((c.unitCost / max).toFixed(3))])); }
function computeCostIndexFromPricingClient(models, pricingMix) { const mix = pricingMix || { input: 10, output: 1 }; const total = Number(mix.input) + Number(mix.output); if (!(total > 0)) return null; const is = Number(mix.input) / total, os = Number(mix.output) / total; const costs = []; for (const m of models) { const p = m.pricingYuanPerMillionTokens; if (p?.input == null || p?.output == null) continue; const w = is * Number(p.input) + os * Number(p.output); if (w > 0) costs.push({ id: m.id, unitCost: w }); } if (costs.length < 2) return null; const anchor = Number(config?.costModel?.pricingAnchorYuan) > 0 ? Number(config.costModel.pricingAnchorYuan) : Math.max(...costs.map((c) => c.unitCost)); if (!(anchor > 0)) return null; return Object.fromEntries(costs.map((c) => [c.id, Number(Math.min(1, c.unitCost / anchor).toFixed(3))])); }
//跑分一览矩阵：行=模型 列=六维；色阶按列内相对高低，每列最强加皇冠标记；单元格失焦即写回 config（手工微调），未启用模型灰显
const CAP_TASKS = ['default','coding','reasoning','extraction','creative','simple'];
const CAP_TASK_LABEL = { default:'通用', coding:'代码', reasoning:'推理', extraction:'抽取', creative:'创意', simple:'轻量' };
//SUB_CATEGORY 复用文件头已有定义（30 小类 → [中文大类, 英文大类, emoji, 中文小类]）
//4 大类在 sub-cells 内按固定顺序分组渲染（组内按均分降序）
const SUB_GROUP_ORDER = ['代码', '智能体', '数据', '写作与对话'];
const SUB_GROUP_ICON = { '代码': '⚙️', '智能体': '🤖', '数据': '📋', '写作与对话': '💬' };
function groupedSubsHtml(subtasks, dim) {
  if (!subtasks || !Object.keys(subtasks).length) return '<span class="pill muted">未实测</span>';
  //按大类分组
  const groups = {};
  for (const [k, v] of Object.entries(subtasks)) {
    const cat = (SUB_CATEGORY[k] || [])[0] || '其他';
    (groups[cat] ||= []).push([k, v]);
  }
  //按固定顺序输出，组内按 avg 降序
  return SUB_GROUP_ORDER.filter((g) => groups[g]?.length).map((g) => {
    const cells = groups[g].sort((a, b) => b[1].avg - a[1].avg).map(([k, v]) =>
      `<span class="sub-cell${dim}" data-sub="${k}" style="background:${subHeat(v.avg)}" title="${(SUB_CATEGORY[k] || ['', '', '', k])[3] || k} · ${v.avg}（${v.n} 条）">${(SUB_CATEGORY[k] || ['', '', '', k])[3] || k}<b>${v.avg}</b></span>`
    ).join('');
    return `<div class="sub-group"><span class="sub-group-label">${SUB_GROUP_ICON[g] || '·'} ${g}</span><div class="sub-group-cells">${cells}</div></div>`;
  }).join('');
}
//30 小类统一列顺序：按 4 大类分组、组内按 SUB_CATEGORY 声明顺序（保证跨模型同列对齐）
function orderedSubKeys() {
  const groups = {};
  for (const [k, v] of Object.entries(SUB_CATEGORY)) {
    const cat = v[0];
    (groups[cat] ||= []).push(k);
  }
  return SUB_GROUP_ORDER.filter((g) => groups[g]?.length).flatMap((g) => groups[g]);
}
//矩阵：30 小类（列）× 模型（行）；每格只显示分数，热度走背景
function renderSubMatrix() {
  const wrap = $('subMatrixWrap'); if (!wrap) return;
  if (!config.models?.length) { wrap.innerHTML = '<p class="hint">暂无模型。</p>'; return; }
  const keys = orderedSubKeys();
  //按大类分组成列头段
  const catSegments = [];
  let curCat = null, curStart = 0;
  keys.forEach((k, idx) => {
    const cat = (SUB_CATEGORY[k] || [])[0] || '其他';
    if (cat !== curCat) { if (curCat) catSegments.push({ cat: curCat, start: curStart, end: idx }); curCat = cat; curStart = idx; }
  });
  if (curCat) catSegments.push({ cat: curCat, start: curStart, end: keys.length });
  //找每个小类在所有模型里的最高分（用于高亮）
  const best = {};
  for (const k of keys) {
    const vals = config.models.map((m) => Number(m.benchmarkScores?.subtasks?.[k]?.avg)).filter((v) => !Number.isNaN(v));
    best[k] = vals.length ? Math.max(...vals) : null;
  }
  const colHeader = `<tr class="matrix-head"><th class="row-head-cell" rowspan="2">模型</th>${catSegments.map((s) => `<th colspan="${s.end - s.start}" class="matrix-cat">${SUB_GROUP_ICON[s.cat] || ''} ${s.cat}</th>`).join('')}</tr><tr class="matrix-subhead">${keys.map((k) => `<th class="matrix-sub" title="${(SUB_CATEGORY[k]||[])[3]||k} · 大类${(SUB_CATEGORY[k]||[])[0]||''}">${(SUB_CATEGORY[k] || [])[3] || k}</th>`).join('')}</tr>`;
  const rowBody = config.models.map((m, i) => {
    const dim = m.enabled ? '' : ' dim';
    const subs = m.benchmarkScores?.subtasks || {};
    return `<tr data-row="${i}"><th class="row-head-cell"><div class="cap-model${dim}"><strong>${escHtml(m.displayName || m.id)}</strong><small>${escHtml(m.id)}</small></div></th>${keys.map((k) => {
      const v = subs[k];
      if (!v) return `<td class="matrix-cell empty" data-model="${i}" data-sub="${k}">—</td>`;
      const isBest = best[k] != null && Math.abs(Number(v.avg) - best[k]) < 1e-9;
      return `<td class="matrix-cell${dim}${isBest ? ' best' : ''}" data-model="${i}" data-sub="${k}" style="background:${subHeat(v.avg)}" title="${(SUB_CATEGORY[k] || ['', '', '', k])[3] || k}（${(SUB_CATEGORY[k] || [])[0] || ''}）· 均分 ${v.avg} · ${v.n} 条">${v.avg}</td>`;
    }).join('')}</tr>`;
  }).join('');
  wrap.innerHTML = `<div class="matrix-scroll"><table class="sub-matrix"><colgroup><col class="row-head-col">${keys.map(() => `<col class="sub-col">`).join('')}</colgroup>${colHeader}${rowBody}</table></div>`;
  wrap._matrixBound = true;
}
function subHeat(v){ //双色梯度：低分偏红警示、中高分偏绿稳健；避免单调绿
  if (v == null) return 'rgba(120,120,120,0.15)';
  const x = Math.max(0, Math.min(1, v));
  if (x < 0.7) { const t = x / 0.7; return `rgba(180,40,40,${(0.15 + 0.55 * (1 - t)).toFixed(3)})`; }
  const t = (x - 0.7) / 0.3;
  return `rgba(18,145,80,${(0.15 + 0.55 * t).toFixed(3)})`;
}
//摘要：模型/官方/六维 三列（不再展开 30 小类，30 小类单独走矩阵）
function renderProfile() {
  const tbody = $('profileRows'); if (!tbody) return;
  if (!config.models?.length) { tbody.innerHTML = '<tr><td colspan="3" class="empty">暂无模型。</td></tr>'; renderSubMatrix(); return; }
  const bestTotal = Math.max(0, ...config.models.map((x) => Number(x.benchmarkScores?.evalGate?.total) || 0));
  tbody.innerHTML = config.models.map((m, i) => {
    const bs = m.benchmarkScores || {};
    const dim = m.enabled ? '' : ' dim';
    const scores = bs.scores && Object.keys(bs.scores).length ? Object.entries(bs.scores).map(([k, v]) => `<span class="pill ${v >= 0.8 ? 'good' : 'muted'}" title="${escHtml(k)}">${escHtml(k)} ${Number(v).toFixed(3).replace(/0+$/,'').replace(/\.$/,'')}</span>`).join(' ') : '<span class="pill muted">未录入</span>';
    const eg = bs.evalGate;
    const gate = eg ? CAP_TASKS.filter(t => eg[t] != null).map(t => `<span class="pill ${eg[t] >= Math.max(...CAP_TASKS.map(k => Number(eg[k]) || 0)) - 1e-9 ? 'good' : ''}" title="${CAP_TASK_LABEL[t]} ${eg[t]}">${CAP_TASK_LABEL[t]} ${eg[t]}</span>`).join(' ') + (eg.total != null ? `<span class="pill ${eg.total >= bestTotal - 1e-9 && eg.total > 0 ? 'good' : ''}" title="总均分${eg.total >= bestTotal - 1e-9 && eg.total > 0 ? '（三模型最高）' : ''}">总 ${eg.total}</span>` : '') : '<span class="pill muted">未实测</span>';
    return `<tr><th><div class="cap-model${dim}"><strong>${escHtml(m.displayName || m.id)}</strong><small>${escHtml(m.id)}</small></div></th><td>${scores}</td><td>${gate}</td></tr>`;
  }).join('');
  renderSubMatrix();
}
async function showSubDetail(modelIdx, subKey) {
  const m = config.models[modelIdx]; if (!m) return;
  const meta = m.benchmarkScores?.subtasksMeta || {};
  const v = m.benchmarkScores?.subtasks?.[subKey]; if (!v) return;
  const [catCn, catEn, catIcon, label] = SUB_CATEGORY[subKey] || ['', '', '', subKey];
  const cat = `${catIcon || ''} ${catCn}`;
  $('profileDetail').hidden = false;
  $('profileDetail').innerHTML = `<div class="panel-head"><div><p class="eyebrow">小类明细</p><h3>${label} <small>${cat}</small></h3></div><button class="secondary" onclick="document.getElementById('profileDetail').hidden=true">收起</button></div>
  <p class="hint">模型 ${escHtml(m.displayName || m.id)} · ${label}（${catCn}）均分 <strong>${v.avg}</strong> · 样本 ${v.n} 条 · 实测时间 ${escHtml(String(meta.at || '—'))} · 裁判 ${escHtml(String(meta.judge || '—'))}</p>`;
}
function bindProfile() {
  const summaryTb = $('profileRows');
  if (summaryTb && !summaryTb._subBound) { summaryTb.addEventListener('click', (e) => { /* 摘要行无热力，点击 noop */ }); summaryTb._subBound = true; }
  const wrap = $('subMatrixWrap');
  if (wrap && !wrap._cellBound) {
    wrap.addEventListener('click', (e) => {
      const c = e.target.closest('.matrix-cell'); if (!c) return;
      showSubDetail(Number(c.dataset.model), c.dataset.sub);
    });
    wrap._cellBound = true;
  }
  const dl = $('dlProfileTpl');
  if (dl && !dl._bound) { dl._bound = true; dl.onclick = async () => {
    try {
      const res = await fetch('/admin/api/model-data/template-xlsx', { headers: headers() });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error?.message || `HTTP ${res.status}`);
      const blob = await res.blob(); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'model-data-template.csv'; a.click(); URL.revokeObjectURL(a.href);
    }
    catch (e) { toast(e.message, true); }
  }; }
  const f = $('importProfileFile');
  if (f && !f._bound) { f._bound = true; f.onchange = async () => {
    const file = f.files?.[0]; if (!file) return; f.value = '';
    try {
      const isCsv = /\.csv$/i.test(file.name);
      const r = isCsv
        ? await api('/admin/api/model-data/import-xlsx', { method: 'POST', body: await file.text() })
        : await api('/admin/api/model-data/import', { method: 'POST', body: JSON.stringify(JSON.parse(await file.text())) });
      config = await api('/admin/api/config'); snapshotBaseline(); renderProfile();
      $('profileImportMsg').textContent = `导入成功 ${r.applied.length} 个${r.skipped?.length ? `，跳过 ${r.skipped.length} 个（${r.skipped.join('；')}）` : ''}`;
      toast(`模型数据已导入 ${r.applied.length} 个`);
    } catch (e) { $('profileImportMsg').textContent = '导入失败'; toast(e.message, true); }
  }; }
}
const CAP_CN = { default:'通用', coding:'代码', reasoning:'推理', extraction:'抽取', creative:'创意', simple:'轻量' };
function renderCapabilityMatrix() {
  const tbody = $('capRows'); if (!tbody) return;
  const models = config.models;
  const best = {}; CAP_TASKS.forEach(t => { best[t] = Math.max(...models.filter(m => m.enabled).map(m => Number(m.quality?.[t] ?? m.quality?.default ?? 0)), 0); });
  tbody.innerHTML = models.map((m, i) => {
    const dim = m.enabled ? '' : ' dim';
    const cells = CAP_TASKS.map(t => {
      const v = m.quality?.[t] ?? m.quality?.default;
      const num = Number(v);
      const heat = Math.max(0, Math.min(1, (num - 0.75) / 0.25)); //0.75~1 映射到 0~1 色阶（绿色由浅到深）
      const isBest = m.enabled && num >= best[t] - 1e-9 && num > 0; //未启用模型不参评最强
      const crown = isBest ? '<span class="cap-best" title="该维度最强">★</span>' : '';
      const bg = m.enabled ? ` style="background:rgba(18,145,80,${(heat * 0.38).toFixed(3)})"` : ''; //未启用行去色阶只灰显
      return `<td${bg}><div class="cap-cell${dim}"><input class="cap-input" data-task="${t}" data-index="${i}" type="number" min="0" max="1" step="0.001" value="${v}">${crown}</div></td>`;
    }).join('');
    return `<tr><th><div class="cap-model${dim}"><strong>${escHtml(m.displayName || m.id)}</strong><span class="pill ${m.enabled ? 'good' : 'muted'}" style="margin-left:8px">${m.enabled ? '启用中' : '已停用'}</span><small>${escHtml(m.id)}</small></div></th>${cells}</tr>`;
  }).join('');
}
$('capRows').addEventListener('input', (e) => { if (!e.target.classList.contains('cap-input')) return; const idx = Number(e.target.dataset.index); const task = e.target.dataset.task; const v = e.target.value === '' ? null : Number(e.target.value); config.models[idx].quality[task] = v; syncDirty(); scheduleSimulation(); });
function renderDeployment() { const cm = config.costModel || {}; const source = cm.source || 'deployment'; $('costSource').value = source; $('pricingMixInput').value = cm.pricingMix?.input ?? 10; $('pricingMixOutput').value = cm.pricingMix?.output ?? 1; $('beansPerYuan').value = config.budget?.beansPerYuan ?? ''; const cardPrice = cm.cardPrice || {}; const computed = source === 'pricing' ? (computeCostIndexFromPricingClient(config.models, cm.pricingMix) || {}) : (computeCostIndexClient(config.models, cardPrice) || {}); $('deployment').innerHTML = config.models.map((m, i) => { const d = m.deployment || {}; return `<tr data-index="${i}"><td><strong>${escHtml(m.displayName || m.id)}</strong></td><td><select class="device-type"><option value="910B2" ${d.deviceType === '910B2' ? 'selected' : ''}>910B2</option><option value="910B4" ${d.deviceType === '910B4' ? 'selected' : ''}>910B4</option></select></td><td><input class="machines" type="number" min="1" step="1" value="${d.machines ?? ''}" placeholder="设备数"></td><td><input class="cards" type="number" min="1" step="1" value="${d.cardsPerMachine ?? ''}" placeholder="单机卡数"></td><td><input class="instances" type="number" min="1" step="1" value="${d.instances ?? ''}" placeholder="实例数"></td><td><input class="concurrency" type="number" min="1" step="1" value="${d.concurrencyPerInstance ?? ''}" placeholder="单实例并发"></td><td>${d.instances && d.concurrencyPerInstance ? `<span class="pill good">${d.totalConcurrency ?? d.instances * d.concurrencyPerInstance}</span>` : '<span class="pill muted">—</span>'}</td><td><input class="tps" type="number" min="1" value="${d.tps ?? ''}" placeholder="tokens/s"></td><td><span class="cost-preview pill ${computed[m.id] != null ? 'good' : 'muted'}">${computed[m.id] ?? '待录入'}</span></td></tr>`; }).join(''); }
function readForm() {
  const r = config.routing; r.costTier = document.querySelector('input[name="costTier"]:checked')?.value || 'custom'; r.mode = $('mode').value; r.autoModelId = $('autoModelId').value.trim() || 'auto'; r.exposeModelList = $('exposeModelList').value; r.activeTrafficPercent = Number($('activeTrafficPercent').value); r.qualityFloor = Number($('qualityFloor').value); r.selfHostedBonus = Number($('selfBonus').value); r.qualityWeight = Number($('qualityWeight').value); r.costWeight = Number($('costWeight').value); r.latencyWeight = Number($('latencyWeight').value); r.providerCostWeight = Number($('providerCostWeight').value); r.uncertaintyPenalty = Number($('uncertaintyPenalty').value); r.complexQualityMargin = Number($('complexQualityMargin').value); r.maxAttempts = Number($('maxAttempts').value); r.preferSelfHosted = $('preferSelf').checked;
  //新滑条收集
  r.relQualityCap = { simple: Number($('relQualityCapSimple').value), balanced: Number($('relQualityCapBalanced').value), complex: Number($('relQualityCapComplex').value) };
  r.subtaskSmoothK = Number($('subtaskSmoothK').value);
  config.semanticRouter.enabled = $('semanticProvider').value !== 'disabled'; config.semanticRouter.mode = $('semanticMode').value; config.semanticRouter.confidenceThreshold = Number($('semanticThreshold').value); config.semanticRouter.smallAcceptThreshold = Number($('semanticSmallAccept').value); config.semanticRouter.finalAdoptionThreshold = Number($('semanticFinalAdoption').value); config.semanticRouter.activeTrafficPercent = Number($('semanticActivePercent').value); config.semanticRouter.minConfidence = config.semanticRouter.finalAdoptionThreshold; config.reasoningControl.enabled = $('reasoningEnabled').checked; config.budget.enabled = $('budgetEnabled').checked; config.budget.dailyBudgetYuan = Number($('dailyBudget').value); config.budget.degradeThreshold = Number($('budgetThreshold').value);
  config.semanticRouter.provider = $('semanticProvider').value;
  config.judge = { ...(config.judge || {}), enabled: $('judgeEnabled').checked, samplePercent: Number($('judgeSamplePercent').value), model: $('judgeModel').value.trim() || 'glm-5.3', dailyMaxCalls: Number($('judgeDailyMaxCalls').value), dailyMaxTokens: Number($('judgeDailyMaxTokens').value), timeoutMs: Number($('judgeTimeoutMs').value), circuitThreshold: Number($('judgeCircuitThreshold').value), taskCheckEnabled: $('judgeTaskCheckEnabled').checked };
      if ($('semanticProvider').value === 'openai-chat') { config.semanticRouter.model = $('semanticModel').value; delete config.semanticRouter.httpJson; }
  else if ($('semanticProvider').value === 'http-json') { config.semanticRouter.httpJson = { ...(config.semanticRouter.httpJson || {}), url: $('semanticHttpUrl').value.trim() }; }
  else if ($('semanticProvider').value === 'cascade') { config.semanticRouter.httpJson = { ...(config.semanticRouter.httpJson || {}), url: $('semanticHttpUrl').value.trim() }; config.semanticRouter.model = $('semanticModel').value; }
  else { delete config.semanticRouter.model; delete config.semanticRouter.httpJson; }
  config.decisionLog = { ...(config.decisionLog || {}), enabled: $('decisionLogEnabled').checked,
    redactMessages: !$('logFullRequest').checked, logAnswerText: $('logAnswerText').checked };
  document.querySelectorAll('#models tr').forEach((row) => { const m = config.models[Number(row.dataset.index)]; const nullableNumber=(selector)=>{const value=row.querySelector(selector).value;return value===''?null:Number(value)}; m.enabled = row.querySelector('.enabled').checked; m.quality.default = Number(row.querySelector('.quality').value); m.costIndex = Number(row.querySelector('.cost').value); m.latencyIndex = Number(row.querySelector('.latency').value); m.pricingYuanPerMillionTokens ||= {}; m.pricingYuanPerMillionTokens.input=nullableNumber('.input-price'); m.pricingYuanPerMillionTokens.inputCached=nullableNumber('.cached-price'); m.pricingYuanPerMillionTokens.output=nullableNumber('.output-price'); m.performance ||= {}; m.performance.totalP95Ms=nullableNumber('.p95'); }); document.querySelectorAll('#deployment tr').forEach((row) => { const m = config.models[Number(row.dataset.index)]; const deviceType = row.querySelector('.device-type').value; const machines = row.querySelector('.machines').value; const cards = row.querySelector('.cards').value; const tps = row.querySelector('.tps').value; const instances = row.querySelector('.instances').value; const concurrency = row.querySelector('.concurrency').value;
    if (machines && tps) m.deployment = { deviceType, machines: Number(machines), cardsPerMachine: Number(cards) || 1, tps: Number(tps), ...(instances ? { instances: Number(instances), concurrencyPerInstance: Number(concurrency) || null, totalConcurrency: Number(instances) * (Number(concurrency) || 0) || null } : {}) }; else delete m.deployment; }); config.costModel ||= {}; config.costModel.source = $('costSource').value; const mixIn = Number($('pricingMixInput').value), mixOut = Number($('pricingMixOutput').value); if (Number.isFinite(mixIn) && Number.isFinite(mixOut) && mixIn >= 0 && mixOut >= 0 && mixIn + mixOut > 0) config.costModel.pricingMix = { input: mixIn, output: mixOut }; const beanRate = Number($('beansPerYuan').value); if (Number.isFinite(beanRate) && beanRate > 0) { config.budget ||= {}; config.budget.beansPerYuan = beanRate; } const cardPrice = config.costModel.cardPrice || {}; const computedCost = config.costModel.source === 'pricing' ? computeCostIndexFromPricingClient(config.models, config.costModel.pricingMix) : computeCostIndexClient(config.models, cardPrice); if (computedCost) for (const m of config.models) if (computedCost[m.id] != null) m.costIndex = computedCost[m.id]; return config;
}
function metricDelta(current, proposed, lower = false) { const delta = proposed - current, good = lower ? delta <= 0 : delta >= 0; return `<strong>${proposed.toFixed(2)}</strong><small class="${good ? 'positive' : 'negative'}">${delta >= 0 ? '+' : ''}${delta.toFixed(2)}</small>`; }
function metricDeltaMs(current, proposed, lower = false) { const delta = Math.round(proposed - current), good = lower ? delta <= 0 : delta >= 0; return `<strong>${Math.round(proposed)}ms</strong><small class="${good ? 'positive' : 'negative'}">${delta >= 0 ? '+' : ''}${delta}ms</small>`; }
function metricDeltaCost(current, proposed, lower = false) { const delta = proposed - current, good = lower ? delta <= 0 : delta >= 0; const fmt = (v) => { if (v < 0.0001) return v.toFixed(5); if (v < 0.01) return `${(v * 1000).toFixed(1)}厘`; return `¥${v.toFixed(2)}`; }; return `<strong>${fmt(proposed)}</strong><small class="${good ? 'positive' : 'negative'}">${delta >= 0 ? '+' : ''}${fmt(delta)}</small>`; }
function renderSimulation(result) {
  lastSimulation = result; const c = result.current, p = result.proposed, risk = result.changedRate >= .5 ? 'high' : result.changedRate >= .2 ? 'medium' : 'low';
  $('impactSummary').innerHTML = `<article class="impact ${risk}"><span>模型切换</span><strong>${result.changed}/${result.sampleCount}</strong><small>${percentValue(result.changedRate)} 代表任务改变</small></article><article><span>预计质量</span>${metricDelta(c.averageQuality,p.averageQuality)}</article>${(c.averageCostYuan!=null&&p.averageCostYuan!=null)?`<article><span>平均单次成本 <span class="help" data-help="按 12 个代表性任务（含系统提示词+多轮上下文+业务文档）的平均输入输出量、按厂商目录价5折结算价估算。DeepSeek V4 Flash 结算价输入 0.5 元/百万 token、输出 1 元/百万 token，因此单次多在 0.0001~0.012 元（1 厘~1 分）区间——这是真实结算价口径，不是市场价。">?</span></span>${metricDeltaCost(c.averageCostYuan,p.averageCostYuan,true)}</article>`:`<article><span>成本指数</span>${metricDelta(c.averageCostIndex,p.averageCostIndex,true)}</article>`}${(c.averageLatencyMs!=null&&p.averageLatencyMs!=null)?`<article><span>平均端到端时延 <span class="help" data-help="从发出请求到收完完整回答的总耗时（含模型思考时间），按代表性任务平均。">?</span></span>${metricDeltaMs(c.averageLatencyMs,p.averageLatencyMs,true)}</article>`:`<article><span>时延指数</span>${metricDelta(c.averageLatencyIndex,p.averageLatencyIndex,true)}</article>`}<article><span>自建比例</span><strong>${percentValue(p.selfHostedRate)}</strong><small>当前 ${percentValue(c.selfHostedRate)}</small></article>`;
  $('impactRows').innerHTML = p.rows.map((row,i) => { const before=c.rows[i], changed=before.model!==row.model; const sc3 = subCategoryOf(row.task, row.subTask); return `<tr><td><strong>${row.label}</strong><br><small>${sc3[2]} ${sc3[0]} · ${sc3[3]}</small></td><td>${Math.round(row.complexity*100)} · ${tierCN(row.tier)}</td><td>${escHtml(before.model)}</td><td>${escHtml(row.model)}</td><td><span class="pill ${changed?'bad':'good'}">${changed?'切换':'不变'}</span></td></tr>`; }).join('');
  renderSensitivity(result.sensitivity);
  renderNoAutoCompare(result);
}
//「不做 auto」对比表：调整后策略 vs 全量固定给每个单模型（质量/用户成本/算力消耗/时延 + 百分比变化）
function renderNoAutoCompare(result) {
  const box = $('noAutoCompare'); if (!box) return;
  const cmp = result.proposed?.comparison || result.comparison;
  if (!cmp || !cmp.singleModelBaselines?.length) { box.innerHTML = ''; return; }
  const p = result.proposed;
  const fmt = (v, suffix = '%') => v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(1) + suffix;
  const rowsHtml = cmp.singleModelBaselines.map((b) => {
    const dQ = p.averageQuality != null && b.averageQuality ? ((p.averageQuality - b.averageQuality) / b.averageQuality) * 100 : null;
    const dC = p.averageCostIndex != null && b.averageCostIndex ? ((p.averageCostIndex - b.averageCostIndex) / b.averageCostIndex) * 100 : null;
    const dP = p.averageCostIndexProvider != null && b.averageCostIndexProvider ? ((p.averageCostIndexProvider - b.averageCostIndexProvider) / b.averageCostIndexProvider) * 100 : null;
    const pills = [];
    if (dQ != null) pills.push(`<span class="pill ${dQ >= 0 ? 'good' : 'bad'}" title="质量变化">质量${fmt(dQ)}</span>`);
    if (dC != null) pills.push(`<span class="pill ${dC <= 0 ? 'good' : 'bad'}" title="用户成本变化">用户成本${fmt(dC)}</span>`);
    if (dP != null) pills.push(`<span class="pill ${dP <= 0 ? 'good' : 'bad'}" title="算力消耗变化">算力消耗${fmt(dP)}</span>`);
    return `<tr><td><b>${escHtml(b.displayName || b.model)}</b>${b.feasible === false ? ' <span class="pill bad" style="font-size:11px">能力不足</span>' : ''}</td><td>${b.averageQuality?.toFixed(3) ?? '—'}</td><td>${b.averageCostIndex?.toFixed(3) ?? '—'}</td><td>${b.averageCostIndexProvider?.toFixed(3) ?? '—'}</td><td>${pills.join(' ')}</td></tr>`;
  }).join('');
  box.innerHTML = `<p class="policy-section-title" style="margin:4px 0 6px">不做 auto 会怎样 <span class="help" data-help="把全部流量固定给某个模型（不做路由）的模拟结果 vs 当前调整后的策略。质量越高越好；用户成本=按豆价结算；算力消耗=按自建算力资源消耗；负值=策略比固定该模型更省。">?</span></p><div class="table-wrap"><table><thead><tr><th>固定给单一模型</th><th>质量</th><th>用户成本</th><th>算力消耗</th><th>当前策略相对它</th></tr></thead><tbody>${rowsHtml}</tbody></table></div><p class="hint" style="margin:6px 0 0">「不做 auto」= 同一批代表任务全部发给该模型。「当前策略相对它」列是百分比变化，绿=更优。这张表回答：不路由直接用某个模型，质量和成本各差多少。</p>`;
}
//调整手感：每个滑条「再拉多少才会变 / 拉到头也变不了的原因」
function renderSensitivity(s) {
  const box = $('sensitivityBox');
  if (!box) return;
  if (!s) { box.hidden = true; return; }
  const fmt = (v) => Number(v).toFixed(2);
  const cards = Object.values(s).map((axis) => {
    const head = `<div class="sens-head"><b>${axis.label}</b><span class="pill muted">当前 ${fmt(axis.currentValue)} · 范围 ${fmt(axis.range.min)}~${fmt(axis.range.max)}</span></div>`;
    if (axis.nextFlip) {
      const dir = axis.nextFlip.at > axis.currentValue ? '再拉高' : '再拉低';
      const gap = Math.abs(axis.nextFlip.at - axis.currentValue);
      return `<article class="sens-card"><div class="sens-head"><b>${axis.label}</b><span class="pill ${gap <= .1 ? 'warn' : 'muted'}">${dir}到 ${fmt(axis.nextFlip.at)} 触发切换</span></div><p>调整幅度 <b>${gap.toFixed(2)}</b> 后，${axis.nextFlip.count} 个代表任务从「${escHtml(axis.nextFlip.from)}」切换到「${escHtml(axis.nextFlip.to)}」。当前值附近 ${(axis.flips || []).length ? `首个翻转点 ${fmt(axis.flips[0].at)}` : '尚无翻转'}。</p></article>`;
    }
    const why = axis.dominated ? `<p class="sens-why">${axis.dominated}</p>` : '<p class="sens-why">拉满整条滑条都不会改变当前选择——现有配置下最优模型很稳定。</p>';
    return `<article class="sens-card">${head}${why}</article>`;
  }).join('');
  box.innerHTML = `<p class="sens-title">滑条手感 <span class="help" data-help="回答「滑条再拉多少才会改变路由」。若拉满也不变，说明现有配置下最优模型很稳定，怎么调权重都是它。">?</span></p><div class="sens-grid">${cards}</div>`;
  box.hidden = false;
}
async function simulate() { if (!config) return; readForm(); const result = await api('/admin/api/simulate',{method:'POST',body:JSON.stringify({proposedConfig:config})}); renderSimulation(result); renderBaselines(); return result; }
function scheduleSimulation(){ clearTimeout(simulateTimer); simulateTimer=setTimeout(()=>simulate().catch(()=>{}),350); }
function percent(n,d){ return d ? `${(n/d*100).toFixed(1)}%` : '0.0%'; }
function renderRecentKeySelect(){ //key 指纹下拉：从最近请求里聚合出现过的指纹
  const sel=$('recentKeySelect'); if(!sel)return;
  const seen=new Map(); for(const x of metrics.recent||[]){ if(x.keyFingerprint) seen.set(x.keyFingerprint,(seen.get(x.keyFingerprint)||0)+1); }
  const cur=sel.value; sel.innerHTML='<option value="">全部调用方</option>'+[...seen.entries()].map(([fp,n])=>`<option value="${escHtml(fp)}">${escHtml(fp)} · ${n} 笔</option>`).join('');
  sel.value=[...seen.keys()].includes(cur)?cur:''; $('recentKeyHint').textContent=`当前 ${seen.size} 个调用方 key 在线`;
}
function renderMetrics(){ const c=metrics.counters; $('total').textContent=c.total; $('autoRate').textContent=percent(c.auto,c.total); const selfIds=new Set(config.models.filter(m=>m.ownership==='self_hosted').map(m=>m.id)); const self=Object.entries(c.selected).filter(([id])=>selfIds.has(id)).reduce((s,[,n])=>s+n,0); $('selfRate').textContent=percent(self,c.success); $('semanticRate').textContent=percent(c.semantic?.disagreed||0,c.semantic?.succeeded||0); $('overheadCost').textContent=(metrics.budget?.routingOverheadCostYuan!=null?`${Number(metrics.budget.routingOverheadCostYuan).toFixed(4)}元`:'—'); $('budgetRate').textContent=metrics.budget?.enabled?percentValue(metrics.budget.pressure):'未启用'; $('fallback').textContent=c.fallback; $('errorRate').textContent=percent(c.errors,c.total); document.querySelectorAll('#models tr').forEach(row=>{const m=config.models[Number(row.dataset.index)],h=metrics.health[m.id],cell=row.querySelector('.health'); cell.innerHTML=!h?'<span class="pill muted">无数据</span>':h.circuitState==='half_open'?'<span class="pill muted">恢复探测</span>':h.circuitOpenUntil>Date.now()?'<span class="pill bad">熔断</span>':`<span class="pill good">${h.ewmaLatencyMs}ms · ${h.failures}错</span>`}); renderRecentKeySelect(); $('recent').innerHTML=metrics.recent.length?metrics.recent.map(x=>{const reasonTag=x.reasoningApplied===false&&x.reasoningLevel&&x.reasoningLevel!=='off'?` · 推理${x.reasoningLevel}(建议未生效)`:` · 推理${x.reasoningLevel||'off'}`; return `<div class="recent-item"><time>${new Date(x.at).toLocaleTimeString()}</time><div><b>${escHtml(x.selected)}</b> <small>← ${escHtml(x.requested)}${x.keyFingerprint?` · <span class="key-fp" title="调用方 key 指纹：${escHtml(x.keyFingerprint)}（可在上方下拉按它筛选）">${escHtml(x.keyFingerprint)}</span>`:''} · ${taskCN(x.task)} · ${METHOD_CN[x.routeMethod]||x.routeMethod||'规则'}${reasonTag}${x.fallbackAttempt?` · fallback ${x.fallbackAttempt}`:''}</small></div><span class="pill ${x.ok?'good':'bad'}">${x.ok?`${x.latencyMs}ms`:'失败'}</span></div>`;}).join(''):'<p class="empty">暂无请求</p>'; }
async function connect(){ try{ //不再把 ADMIN_TOKEN 写 sessionStorage（HttpOnly 会话已足够；Bearer 只留给外部脚本）
[config,metrics]=await Promise.all([api('/admin/api/config'),api('/admin/api/metrics')]);snapshotBaseline(); $('status').textContent=`已连接 · v${config.version}`; $('status').className='pill good'; renderMetrics(); renderOverview(); renderTaskBoard(); renderMarketSignal(); applyPolicyLock(); await simulate();}catch(error){$('status').textContent='连接失败';$('status').className='pill bad';toast(error.message,true)} }
//token 框不再回填存储的明文（已登录直接连，会话 cookie 生效） $('connect').onclick=connect;
//登出：清会话 cookie 后回登录页
$('logout').onclick=async()=>{ try{ await fetch('/admin/api/logout', { method: 'POST' }); } catch {} window.location.href='/'; }; $('refresh').onclick=async()=>{try{metrics=await api('/admin/api/metrics');renderMetrics();renderOverview()}catch(e){toast(e.message,true)}}; if($('recentKeySelect')) $('recentKeySelect').onchange=async()=>{try{metrics=await api('/admin/api/recent-key-filter',{method:'POST',body:JSON.stringify({key:$('recentKeySelect').value||null})});metrics=await api('/admin/api/metrics');renderMetrics();renderOverview();toast($('recentKeySelect').value?`已筛选 key ${$('recentKeySelect').value}`:'已显示全部调用方')}catch(e){toast(e.message,true)}}; $('reload').onclick=()=>{if(!savedConfig)return;config=structuredClone(savedConfig);snapshotBaseline();renderMetrics();simulate();toast('已恢复到当前线上版本')}; $('refreshBoard').onclick = () => { renderTaskBoard(); renderMarketSignal(); };
if ($('probeSemantic')) $('probeSemantic').onclick = async () => {
  const url = $('semanticHttpUrl')?.value?.trim();
  const box = $('semanticProbeResult');
  box.hidden = false; box.className = 'probe-result'; box.textContent = '正在探测…';
  try {
    //不传 url 时由服务端探测当前生效端点（env 覆盖 config 的场景也不会测错对象）；填了则先验再存
    const r = await api('/admin/api/semantic/probe', { method: 'POST', body: JSON.stringify(url ? { url } : {}) });
    const target = url || r.probedUrl || '';
    if (r.ok) { box.className = 'probe-result ok'; box.innerHTML = `✅ <code>${escHtml(target)}</code> 连通正常（${r.latencyMs}ms）——小模型返回：<code>${escHtml(JSON.stringify(r.assessment))}</code>，接口协议对得上。`; }
    else {
      const stageText = { http: '端点有响应但返回了错误状态', json: '端点通了，但返回的不是 JSON', schema: 'JSON 通了，但缺少约定字段', network: '网络不通（地址或端口错误）', timeout: '8 秒内无响应' }[r.stage] || '探测失败';
      box.className = 'probe-result bad'; box.innerHTML = `❌ ${stageText}（目标：<code>${escHtml(target)}</code>）：<br>${escHtml(r.message || '')}<br><small>本机开发需先启动 scripts/serve_classifier.bat（:8788）；compose 部署由 depends_on 自动拉起。</small>`;
    }
  } catch (e) { box.className = 'probe-result bad'; box.textContent = '探测请求失败：' + e.message; }
};
$('runReport').onclick = () => renderRoutingReport();
$('simulate').onclick=()=>simulate().catch(e=>toast(e.message,true));
document.querySelectorAll('#tierPicker .tier').forEach((el) => el.addEventListener('click', () => {
  const tier = el.dataset.tier; const p = PRESETS[tier];
  if (p) { const fields = { qualityFloor: 'qualityFloor', costWeight: 'costWeight', latencyWeight: 'latencyWeight', selfHostedBonus: 'selfBonus' }; for (const [field, id] of Object.entries(fields)) $(id).value = p[field]; }
  document.querySelectorAll('#tierPicker .tier').forEach((x) => x.classList.toggle('active', x === el));
  config.routing = config.routing || {}; config.routing.costTier = tier;
  updateRangeLabels(); syncDirty(); scheduleSimulation();
}));
//路由风格预设：四权重一键组合；写入后联动四个滑条+质量底线，档位标记为 custom
document.querySelectorAll('#stylePicker .tier').forEach((el) => el.addEventListener('click', () => {
  const style = el.dataset.style; const p = STYLE_PRESETS[style];
  if (!p) return;
  const fields = { qualityFloor: 'qualityFloor', costWeight: 'costWeight', providerCostWeight: 'providerCostWeight', latencyWeight: 'latencyWeight', qualityWeight: 'qualityWeight' };
  for (const [field, id] of Object.entries(fields)) $(id).value = p[field];
  document.querySelectorAll('#stylePicker .tier').forEach((x) => x.classList.toggle('active', x === el));
  config.routing = config.routing || {}; config.routing.costTier = 'custom'; config.routing.routeStyle = style;
  const help = $('presetHelp'); if (help) help.textContent = p.label;
  updateRangeLabels(); syncDirty(); scheduleSimulation();
}));
//新增模型（运营流程第 1 步）：以 qwen36-35b 为模板的保守默认值 + enabled:false，录入后立即出现在表格中可继续编辑，发布走既有安全链路
$('addModel').onclick=()=>{ if(!config) return toast('请先连接',true); const id=prompt('新模型 ID（MaaS 上的模型名，与现有模型同 URL，如 qwen38-27b）'); if(id===null) return; const trimmed=id.trim(); if(!trimmed) return toast('模型 ID 不能为空',true); if(config.models.some(m=>m.id===trimmed)) return toast(`模型 ${trimmed} 已存在`,true); config.models.push({ id:trimmed, displayName:trimmed, ownership:'unknown', enabled:false, calibrationStatus:'unverified', reliabilityStatus:'unverified', quality:{ default:0.80, simple:0.85, coding:0.75, reasoning:0.78, creative:0.82, extraction:0.85 }, costIndex:0.5, latencyIndex:0.5, pricingYuanPerMillionTokens:{ input:null, inputCached:null, output:null }, performance:{ totalP95Ms:null, ttftP50Ms:null, tokensPerSecond:null }, capabilities:{ chat:true, stream:true }, contextWindow:131072, reasoningControl:{ parameter:'reasoning_effort', verified:false } }); renderModels(); renderProviderColumn(); renderDeployment(); bindPolicy(); syncDirty(); scheduleSimulation(); toast(`已添加 ${trimmed}（未启用、归属待定）——发布前先把归属改为 自建/生态，填定价/质量分后发布，再跑 eval gate 实测校准`); };
for(const id of ['mode','activeTrafficPercent','autoModelId','exposeModelList','qualityFloor','costWeight','providerCostWeight','latencyWeight','selfBonus','preferSelf','qualityWeight','complexQualityMargin','uncertaintyPenalty','maxAttempts','semanticMode','semanticProvider','semanticModel','semanticHttpUrl','semanticThreshold','semanticSmallAccept','semanticFinalAdoption','semanticActivePercent','judgeEnabled','judgeTaskCheckEnabled','judgeSamplePercent','judgeModel','judgeDailyMaxCalls','judgeDailyMaxTokens','judgeTimeoutMs','judgeCircuitThreshold','decisionLogEnabled','reasoningEnabled','budgetEnabled','dailyBudget','budgetThreshold','relQualityCapSimple','relQualityCapBalanced','relQualityCapComplex','subtaskSmoothK']) $(id).addEventListener('input',()=>{if(!['mode','activeTrafficPercent','autoModelId','exposeModelList','preferSelf','semanticMode','semanticProvider','semanticModel','semanticHttpUrl','semanticThreshold','semanticSmallAccept','semanticFinalAdoption','semanticActivePercent','judgeEnabled','judgeTaskCheckEnabled','judgeSamplePercent','judgeModel','judgeDailyMaxCalls','judgeDailyMaxTokens','judgeTimeoutMs','judgeCircuitThreshold','decisionLogEnabled','reasoningEnabled','budgetEnabled','dailyBudget','budgetThreshold'].includes(id))markTierCustom();updateRangeLabels();syncDirty();scheduleSimulation()}); $('models').addEventListener('input',()=>{syncDirty();scheduleSimulation()});
// v0.10.3 归属下拉：确认归属后回写 config（unknown 时若已勾选启用则强制取消——服务端校验 fail-closed）
document.addEventListener('change',(ev)=>{const sel=ev.target;if(!sel||!sel.classList||!sel.classList.contains('ownership'))return;const tr=sel.closest('tr');if(!tr)return;const m=config.models[Number(tr.dataset.index)];if(!m)return;m.ownership=sel.value;if(m.ownership==='unknown'&&m.enabled){m.enabled=false;const cb=tr.querySelector('.enabled');if(cb)cb.checked=false;toast('归属待定的模型不能启用——已自动取消勾选（确认归属为自建/生态后方可启用）',true);}syncDirty();scheduleSimulation();}); const refreshCostPreview = () => { const cm = config.costModel || {}; const computed = (cm.source === 'pricing' ? computeCostIndexFromPricingClient(config.models, cm.pricingMix) : computeCostIndexClient(config.models, cm.cardPrice || {})) || {}; document.querySelectorAll('#deployment tr').forEach(row => { const m = config.models[Number(row.dataset.index)]; const cell = row.querySelector('.cost-preview'); if (computed[m.id] != null) { cell.textContent = computed[m.id]; cell.className = 'cost-preview pill good'; } else { cell.textContent = '待录入'; cell.className = 'cost-preview pill muted'; } }); document.querySelectorAll('#models tr').forEach(row => { const m = config.models[Number(row.dataset.index)]; if (computed[m.id] != null) row.querySelector('.cost').value = computed[m.id]; }); };
$('deployment').addEventListener('input',()=>{readForm(); refreshCostPreview(); syncDirty(); scheduleSimulation();});
for (const id of ['costSource','pricingMixInput','pricingMixOutput','beansPerYuan']) $(id).addEventListener('input',()=>{readForm(); refreshCostPreview(); syncDirty(); scheduleSimulation();});
$('save').onclick=async()=>{try{const impact=await simulate(),qualityDrop=impact.proposed.averageQuality-impact.current.averageQuality,highRisk=impact.changedRate>=.4||qualityDrop<-.02||Number(config.routing.activeTrafficPercent)-Number(savedConfig.routing.activeTrafficPercent||0)>30;if(highRisk&&!window.confirm(`这次调整会改变 ${percentValue(impact.changedRate)} 的代表任务，预计质量变化 ${qualityDrop>=0?'+':''}${qualityDrop.toFixed(2)}。\n\n建议先小流量灰度。仍要发布吗？`))return;config=await api('/admin/api/config',{method:'PUT',body:JSON.stringify(config)});snapshotBaseline();
  //评审通道独立提交（key 不进 config；端点+key 需同时填，失败单独提示不回滚 config）
  const jsForm = readJudgeSecretForm();
  if (jsForm) { if (!jsForm.baseUrl || !jsForm.apiKey) { toast('评审通道：端点与 Key 需同时填写', true); } else { try { await api('/admin/api/judge/secret', { method: 'PUT', body: JSON.stringify(jsForm) }); $('judgeSecretBaseUrl').value = ''; $('judgeSecretApiKey').value = ''; await loadJudgeSecretStatus(); } catch (e) { toast('评审通道保存失败：' + e.message, true); } } }$('status').textContent=`已连接 · v${config.version}`;toast(`配置已发布生效（v${config.version}），上一版本已自动备份`);await simulate()}catch(e){toast(e.message,true)}};
$('preview').onclick=async()=>{const body={model:'auto',messages:[{role:'user',content:$('prompt').value}],stream:$('stream').checked};if($('tools').checked)body.tools=[{type:'function',function:{name:'demo_tool',parameters:{type:'object'}}}];if($('jsonMode').checked)body.response_format={type:'json_object'};try{const d=await api('/admin/api/preview',{method:'POST',body:JSON.stringify(body)}),reasons=d.analysis.signals.map(s=>`  ${s.contribution>=0?'+':''}${s.contribution.toFixed(2)} ${s.label}`).join('\n'),review=d.semanticReview?.assessment?`\n语义复核：${d.semanticReview.status==='applied'?'已采用':'仅观察'} · ${tierCN(d.semanticReview.assessment.tier)}/${d.semanticReview.assessment.complexity.toFixed(2)}\n复核理由：${d.semanticReview.assessment.reason}\n复核后建议：${d.semanticReview.proposed?.model||d.suggestedModel}\n`:d.semanticReview?.error?`\n语义复核失败（已安全回退规则）：${d.semanticReview.error}\n`:'';$('decision').textContent=`建议模型：${d.suggestedModel}\n实际模型：${d.selectedModel}${d.shadow?'（当前未进入 Auto 生效流量）':''}\n推理强度：${d.reasoningLevel}\n判断方式：${METHOD_CN[d.analysis.routeMethod]||d.analysis.routeMethod||'规则'}\n任务：${taskCN(d.analysis.task)} · ${tierCN(d.analysis.tier)}\n难度：${d.analysis.complexity.toFixed(2)} · 判断置信度 ${percentValue(d.analysis.confidence)}${review}\n难度来源：\n${reasons}\n\n候选评分：\n${d.candidates.map(c=>`  ${c.model.padEnd(20)} score=${c.score.toFixed(3)} quality=${c.quality.toFixed(2)} floor=${c.effectiveQualityFloor.toFixed(2)}`).join('\n')}\n降级顺序：${d.fallbackOrder.join(' → ')}`}catch(e){$('decision').textContent=e.message}};
connect(); setInterval(async()=>{if(config)try{metrics=await api('/admin/api/metrics');renderMetrics()}catch{}},10000);

//术语解释 tooltip：鼠标悬停 ? 图标时，在图标上方/下方弹出解释（fixed 定位，不受表格 overflow 裁切）
const helpTooltip = document.createElement('div');
helpTooltip.className = 'help-tooltip';
document.body.appendChild(helpTooltip);
function showHelp(help) {
  helpTooltip.textContent = help.dataset.help;
  helpTooltip.classList.add('show');
  const rect = help.getBoundingClientRect();
  const tw = helpTooltip.offsetWidth, th = helpTooltip.offsetHeight;
  let x = rect.left + rect.width / 2 - tw / 2;
  let y = rect.top - th - 10;
  if (x < 8) x = 8;
  if (x + tw > innerWidth - 8) x = innerWidth - tw - 8;
  if (y < 8) y = rect.bottom + 10;  //顶部放不下时改到下方
  helpTooltip.style.left = `${x}px`;
  helpTooltip.style.top = `${y}px`;
}
document.addEventListener('mouseover', (e) => { const help = e.target.closest('.help'); if (help) showHelp(help); });
document.addEventListener('mouseout', (e) => { if (e.target.closest('.help')) helpTooltip.classList.remove('show'); });

//—— 简单/专家双模式 ——
//简单模式隐藏专家区（靠 CSS：.simple-view 下隐藏 expert-only/高级折叠/模型参数/成本定价/单题解释），
//只留预设、运行状态、灰度、预算和影响模拟。专家模式=全量视图。选择存 localStorage。
function applyView(mode) {
  const simple = mode === 'simple';
  document.body.classList.toggle('simple-view', simple);
  document.querySelectorAll('.expert-tab').forEach(t => { t.style.display = simple ? 'none' : ''; });
  if (simple && ['models','semantic','debug'].includes(sessionStorage.getItem('routerTab'))) applyTab('overview');
  $('btnSimple').classList.toggle('active', simple);
  $('btnExpert').classList.toggle('active', !simple);
  localStorage.setItem('routerAdminView', mode);
}
$('btnSimple').onclick = () => applyView('simple');
$('btnExpert').onclick = () => applyView('expert');
if ($('gotoExpert')) $('gotoExpert').onclick = () => applyView('expert');
applyView(localStorage.getItem('routerAdminView') || 'expert');

//—— 基线对照渲染（随机基线 / 事后最优，来自 simulate 响应的 baselines 字段）——
function renderBaselines() {
  const box = $('baselineRows');
  if (!box || !lastSimulation?.proposed?.baselines) return;
  const b = lastSimulation.proposed.baselines;
  const cur = lastSimulation.proposed;
  const row = (name, data) => `<article><span>${name}</span><strong>质量 ${data.averageQuality?.toFixed(3) ?? '—'}</strong><small>成本 ${data.averageCostIndex?.toFixed(3) ?? '—'} · 时延 ${data.averageLatencyIndex?.toFixed(3) ?? '—'}</small><small class="muted">${Object.entries(data.modelDistribution || {}).map(([m, n]) => `${escHtml(m)}×${n}`).join(' ')}</small></article>`;
  box.innerHTML = `<article><span>当前路由</span><strong>质量 ${cur.averageQuality?.toFixed(3) ?? '—'}</strong><small>成本 ${cur.averageCostIndex?.toFixed(3) ?? '—'} · 时延 ${cur.averageLatencyIndex?.toFixed(3) ?? '—'}</small><small class="muted">应落在两个基线之间</small></article>` + row(b.zeroRouter?.label || '随机基线', b.zeroRouter || {}) + row(b.oracle?.label || '静态先验最优', b.oracle || {}) + `<p class="hint">Pareto 前沿：${(lastSimulation.proposed.paretoFrontier || []).map((s) => escHtml(String(s))).join('、') || '—'}。当前路由质量低于随机基线时，说明任务区分度不足或评分权重失衡，应先调分类/权重而不是加模型。</p>`;
}

// v0.11.6 删除死代码：v0.5.0 移除组件体检面板（评测分类器/切换影响预估）时
// app.js 两个 onclick（#evalClassifier / #replaySwitch，元素已不存在）未同步删除
// 模块在 676 行 TypeError 中断，其后全部事件绑定失效 8 天（发现/交错/横幅/取消）
// 后端 /admin/api/classifier/evaluate 与 /replay 保留，仅删 UI 死代码


// ════════ v0.10.0 模型流水线：发现→注册→体检/评测→下线提醒 ════════
const $id = (i) => document.getElementById(i);

function updateSelfBonusHint() {
  const v = Number($id('selfBonus')?.value || 0);
  const hint = $id('selfBonusHint');
  if (!hint) return;
  if (!$id('preferSelf')?.checked) { hint.textContent = '（未勾选上方开关时不生效）'; return; }
  if (v === 0) { hint.textContent = '0 = 不加分，自建与生态完全同权竞争'; return; }
  const qw = Number(document.getElementById('qualityWeight')?.value || 0);
  const cw = Number(document.getElementById('costWeight')?.value || 0);
  const parts = [];
  if (qw > 0) parts.push(`质量分低 ${(v / qw).toFixed(2)}`); else parts.push('质量权重为 0，质量差不影响对比');
  if (cw > 0) parts.push(`成本指数贵 ${(v / cw).toFixed(2)}`); else parts.push('成本权重为 0，成本差不影响对比');
  hint.textContent = `加分 ${v.toFixed(2)} ≈ 可容忍：${parts.join('，')}（按当前权重换算）`;
}
if ($id('selfBonus')) $id('selfBonus').addEventListener('input', updateSelfBonusHint);
['qualityWeight', 'costWeight'].forEach((wid) => $id(wid)?.addEventListener('input', () => setTimeout(updateSelfBonusHint, 50)));
if ($id('preferSelf')) $id('preferSelf').addEventListener('change', updateSelfBonusHint);

async function refreshOfflineAlerts() {
  try {
    const r = await fetch('/admin/api/model-offline-alerts', { headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) return;
    const { alerts } = await r.json();
    const banner = $id('offlineBanner');
    if (!banner) return;
    if (!alerts?.length) { banner.style.display = 'none'; return; }
    banner.style.display = '';
    banner.innerHTML = '⚠ 疑似下线模型 ' + alerts.length + ' 个：' + alerts.map(x =>
      '<strong>' + escHtml(x.displayName) + '</strong>（' + escHtml(x.suggestion) + '，不可用 ' + x.downMinutes + ' 分钟，半开探针连败 ' + x.halfOpenFailStreak + ' 次）').join('；') +
      ' ——建议到下表关闭其「启用」开关（不会自动关闭，由管理员确认）。';
  } catch {}
}

// v0.11.8：发现模型=两步向导。第一步填端点+key（留空可展开用服务端已配——由后端 GET 兜底）；第二步探测+勾选注册。
// key 只在第二步 POST 请求体内一次性使用，不落 config、不回显、不进日志。
async function openDiscover() {
  const modal = $id('discoverModal'); const body = $id('discoverBody');
  modal.style.display = 'flex';
  // ── 第一步：填写端点与密钥 ──
  body.innerHTML = `
    <p class="hint" style="margin-bottom:12px">第 1 步 · 填写上游端点与密钥（OpenAI 兼容格式，例如 https://host:port/v1）。密钥只用于本次拉取，不会保存。</p>
    <label style="display:block;margin-bottom:10px"><span class="lbl">上游端点 URL</span>
      <input id="dcBaseUrl" type="text" placeholder="https://maas.example.com:36007/v1" style="width:100%"></label>
    <label style="display:block;margin-bottom:14px"><span class="lbl">API Key</span>
      <input id="dcApiKey" type="password" placeholder="sk-…" style="width:100%"></label>
    <details style="margin-bottom:12px"><summary class="hint">不填，直接用服务端已配置的上游（.env）</summary>
      <p class="hint" style="margin-top:6px">点下方「发现模型」将使用服务端 .env 里的 UPSTREAM_BASE_URL / UPSTREAM_API_KEY 拉取。</p></details>
    <div style="display:flex;gap:10px;justify-content:flex-end">
      <button id="dcCancel1" class="secondary">取消</button>
      <button id="dcNext" class="primary">发现模型</button>
    </div>`;
  $id('dcCancel1').onclick = () => { modal.style.display = 'none'; };
  $id('dcNext').onclick = async () => {
    const baseUrl = $id('dcBaseUrl').value.trim();
    const apiKey = $id('dcApiKey').value;
    // ── 第二步：探测 + 勾选 ──
    body.innerHTML = '<p class="hint">正在连接端点拉取模型列表…</p>';
    let d;
    try {
      if (baseUrl && apiKey) {
        const r = await fetch('/admin/api/discover-probe', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + ($('token') ? $('token').value.trim() : '') }, body: JSON.stringify({ baseUrl, apiKey }) });
        d = await r.json();
        if (!r.ok) throw new Error(d.error?.message || r.status);
      } else {
        const r = await fetch('/admin/api/discover-models', { headers: { authorization: 'Bearer ' + ($('token') ? $('token').value.trim() : '') } });
        d = await r.json();
        if (!r.ok) throw new Error(d.error?.message || r.status);
      }
    } catch (e) {
      body.innerHTML = '<p style="color:#c33;margin-bottom:10px">拉取失败：' + escHtml(String(e.message)) + '</p>' +
        '<div style="display:flex;gap:10px"><button id="dcBack" class="secondary btn-mini">← 回上一步改端点/密钥</button></div>';
      $id('dcBack').onclick = () => openDiscover();
      return;
    }
    const news = d.models.filter(m => !m.registered);
    const olds = d.models.filter(m => m.registered);
    const ups = d.upstream || {};
    const head = '<p class="hint" style="margin-bottom:10px">第 2 步 · 已连接 <code>' + escHtml(ups.baseUrl || '未知') + '</code>' + (ups.keyMasked ? '（密钥 ' + escHtml(ups.keyMasked) + '）' : '') + '——勾选要纳入管理的模型：</p>';
    const listHtml = news.length
      ? '<div class="discover-bar"><label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" id="discSelectAll"><span>全选新模型</span></label><span class="hint" id="discCount">已选 0 / ' + news.length + '</span></div>' +
        '<div class="discover-list">' + news.map(m => '<label class="discover-row" title="' + escHtml(m.id) + '"><input type="checkbox" class="disc-new" value="' + escHtml(m.id) + '"><strong>' + escHtml(m.id) + '</strong><span class="pill muted">新</span></label>').join('') + '</div>'
      : '<p class="hint">该端点没有新模型——所有模型都已在下方列表中。</p>';
    const oldsHtml = olds.length ? '<p class="hint" style="margin-top:8px">已在列表中（无需重复添加）：' + olds.map(m => escHtml(m.id)).join('、') + '</p>' : '';
    const notice = '<p class="hint" style="margin-top:10px">新纳入的模型<b>不会立即上线</b>：先在下方模型列表补归属、定价、质量分，确认后再手动启用。</p>';
    const foot = '<div style="margin-top:14px;display:flex;gap:10px;align-items:center">' +
      '<button id="dcBack2" class="secondary btn-mini">← 换个端点</button><span style="flex:1"></span>' +
      '<button id="dcCancel2" class="secondary">取消</button>' +
      '<button id="registerSelected" class="primary" ' + (news.length ? 'disabled' : '') + '>纳入所选（0）</button></div>';
    body.innerHTML = head + listHtml + oldsHtml + notice + foot;
    const regBtn = $id('registerSelected');
    const syncReg = () => {
      const boxes = [...document.querySelectorAll('.disc-new')];
      const n = boxes.filter((c) => c.checked).length;
      if (regBtn) { regBtn.textContent = '纳入所选（' + n + '）'; regBtn.disabled = n === 0; }
      const cnt = $id('discCount'); if (cnt) cnt.textContent = '已选 ' + n + ' / ' + boxes.length;
      const sa = $id('discSelectAll'); if (sa) { sa.checked = n === boxes.length && n > 0; sa.indeterminate = n > 0 && n < boxes.length; }
    };
    document.querySelectorAll('.disc-new').forEach((c) => c.addEventListener('change', syncReg));
    const sa = $id('discSelectAll');
    if (sa) sa.addEventListener('change', () => { document.querySelectorAll('.disc-new').forEach((c) => { c.checked = sa.checked; }); syncReg(); });
    $id('dcBack2').onclick = () => openDiscover();
    $id('dcCancel2').onclick = () => { modal.style.display = 'none'; };
    if (regBtn) regBtn.onclick = registerDiscovered;
  };
}
function registerDiscovered() {
  const picked = [...document.querySelectorAll('.disc-new:checked')].map(c => c.value);
  if (!picked.length) return toast('请先勾选', true);
  let added = 0;
  for (const id of picked) {
    if (config.models.some(m => m.id === id)) continue;
    config.models.push({ id, displayName: id, ownership: 'unknown', enabled: false, calibrationStatus: 'pilot', reliabilityStatus: 'unverified',
      quality: { default: 0.80, simple: 0.85, coding: 0.75, reasoning: 0.78, creative: 0.82, extraction: 0.85 },
      costIndex: 0.5, latencyIndex: 0.5, pricingYuanPerMillionTokens: { input: null, inputCached: null, output: null },
      performance: { totalP95Ms: null, ttftP50Ms: null, tokensPerSecond: null }, capabilities: { chat: true, stream: true },
      contextWindow: 131072, reasoningControl: { parameter: 'reasoning_effort', verified: false } });
    added += 1;
  }
  renderModels(); renderProviderColumn(); renderDeployment(); syncDirty();
  $id('discoverModal').style.display = 'none';
  toast('已注册 ' + added + ' 个模型（未启用、归属待定）——发布前须先在表格把归属改为 自建/生态（unknown 不参与自建加分），录入定价/质量分后「安全发布」');
}
$id('discoverModels')?.addEventListener('click', openDiscover);
$id('interleavedEval')?.addEventListener('click', startInterleaved);
$id('discoverClose')?.addEventListener('click', () => $id('discoverModal').style.display = 'none');

let evalTimer = null;
// v0.11.0 交错评测：多模型同窗口轮转+Judge 评分+置信区间（仅建议值）
async function startInterleaved() {
  const enabled = config.models.filter((m) => m.enabled || m.ownership !== 'unknown');
  const ids = enabled.map((m) => m.id);
  if (ids.length < 2) { toast('交错评测至少需要 2 个可用模型（当前 ' + ids.length + ' 个）', true); return; }
  const pick = ids.slice(0, 4).join('、');
  if (!confirm('对以下模型跑交错评测？\n' + pick + '\n\n56 题×每模型轮转执行（预热 2 题不计分）+ Judge 四维评分 + bootstrap 95% 置信区间。\n真实调用上游与 Judge——预计 30-90 分钟。\n结果仅为建议值：不会自动改质量分/时延参数，采纳需在「模型参数」页确认后发布。')) return;
  try {
    const r = await fetch('/admin/api/eval-jobs', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ type: 'interleaved', modelIds: ids.slice(0, 4) }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || r.status);
    $id('evalTitle').textContent = '交错评测 · ' + d.modelIds.join(' vs ');
    $id('evalModal').style.display = 'flex';
    pollEval(d.id);
  } catch (e) { toast('任务启动失败：' + e.message, true); }
}
async function startEval(type, modelId) {
  if (!confirm(type === 'checkup'
    ? '对 ' + modelId + ' 跑快速体检？（6 题冒烟，约 1-2 分钟，真实调用上游——就绪率+断言，不构成质量结论）'
    : '对 ' + modelId + ' 跑 56 题稳定性巡检？（就绪率+时延分布，约 10-60 分钟；不含质量评分——质量分以带裁判的 eval:gate 为准）')) return;
  try {
    const r = await fetch('/admin/api/eval-jobs', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ type, modelId }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || r.status);
    $id('evalTitle').textContent = (type === 'checkup' ? '快速体检 · ' : '稳定性巡检 · ') + modelId;
    $id('evalModal').style.display = 'flex';
    pollEval(d.id);
  } catch (e) { toast('任务启动失败：' + e.message, true); }
}
function pollEval(id) {
  clearInterval(evalTimer);
  // v0.11.3：取消按钮（长任务可中止——服务端在题/Judge 循环边界响应）
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-mini'; cancelBtn.style.cssText = 'margin-left:12px'; cancelBtn.textContent = '取消任务';
  cancelBtn.onclick = async () => {
    if (!confirm('确定取消当前评测任务？（已完成的调用照常计费）')) return;
    try {
      const r = await fetch('/admin/api/eval-jobs?action=cancel', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ id }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error?.message || r.status);
      if (d.alreadyFinished) toast('任务已结束，无需取消');
      else { toast('已请求取消——当前在途调用完成后停止'); cancelBtn.disabled = true; }
    } catch (e) { toast('取消失败：' + e.message, true); }
  };
  const head = $id('evalTitle');
  if (head && head.parentElement) { head.parentElement.querySelectorAll('.eval-cancel').forEach((x) => x.remove()); cancelBtn.classList.add('eval-cancel'); head.parentElement.insertBefore(cancelBtn, head.nextSibling); }
  evalTimer = setInterval(async () => {
    try {
      const r = await fetch('/admin/api/eval-jobs?id=' + id, { headers: { authorization: `Bearer ${token}` } });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error?.message || r.status);
      const pct = j.total ? Math.round(j.done / j.total * 100) : 0;
      let html = '<div class="progress-wrap"><div class="progress-bar" style="width:' + pct + '%"></div></div><p>' + j.done + '/' + j.total + '（' + pct + '%）失败 ' + j.failed + '</p>';
      if (j.status === 'cancelled') { clearInterval(evalTimer); html += '<p style="color:#c33">任务已取消——以上为取消前已完成部分（' + j.done + '/' + j.total + '）。</p>'; $id('evalBody').innerHTML = html; return; }
      if (j.status === 'done') {
        clearInterval(evalTimer);
        if (j.summary) {
          if (j.type === 'interleaved') {
            // v0.11.0：交错评测汇总——每模型质量/时延 CI + 两两显著性
            const s = j.summary;
            let rows = Object.entries(s.models || {}).map(([mid, v]) =>
              '<tr><td>' + escHtml(mid) + '</td><td>' + (v.ready || '—') + '</td><td>' +
              (v.quality && v.quality.mean != null ? v.quality.mean.toFixed(2) + (v.quality.lo != null ? ' [' + v.quality.lo.toFixed(2) + ', ' + v.quality.hi.toFixed(2) + ']' : '（样本不足）') : '—') + '</td><td>' +
              (v.latencyMs && v.latencyMs.mean != null ? Math.round(v.latencyMs.mean) + 'ms' + (v.latencyMs.lo != null ? ' [' + Math.round(v.latencyMs.lo) + ', ' + Math.round(v.latencyMs.hi) + ']' : '') : '—') + '</td></tr>').join('');
            html += '<table><tr><th>模型</th><th>就绪</th><th>质量分（95% CI）</th><th>时延（95% CI）</th></tr>' + rows + '</table>';
            if (s.judgeReadyRate != null) {
              const sk = s.judgeSkip || {};
              html += '<p class="hint">Judge 覆盖率 ' + (s.judgeReadyRate * 100).toFixed(0) + '%' +
                (sk.budget || sk.error || sk.noRubric ? '（跳过：预算 ' + (sk.budget || 0) + ' · 失败 ' + (sk.error || 0) + ' · 无评分标准 ' + (sk.noRubric || 0) + '）' : '') + '——覆盖率过低时质量结论不可采信。</p>';
            }
            if (Array.isArray(s.pairwise) && s.pairwise.length) {
              html += '<h4>两两对比（质量分差，正=A 好）</h4><ul>' + s.pairwise.map((p) =>
                '<li>' + escHtml(p.a) + ' vs ' + escHtml(p.b) + '（配对 ' + (p.pairedN ?? 0) + ' 题）：' +
                (p.qualityDiff && p.qualityDiff.mean != null
                  ? (p.qualityDiff.mean > 0 ? '+' : '') + p.qualityDiff.mean.toFixed(2) + (p.qualityDiff.lo != null ? ' [' + p.qualityDiff.lo.toFixed(2) + ', ' + p.qualityDiff.hi.toFixed(2) + ']' : '（样本不足）') + ' ' + (p.significant === true ? '<b>显著</b>' : p.significant === false ? '（不显著）' : '（显著性不可判定）')
                  : '样本不足') + '</li>').join('') + '</ul>';
            }
            if (!s.judgeConfigured) html += '<p class="hint">Judge 未配置——质量列不可用（仅时延统计）。配置 Judge 端点后重跑。</p>';
            html += '<p class="hint">结果仅为建议值：不自动改质量分/时延参数，采纳需在「模型参数」页确认后发布。</p>';
          } else if (j.type === 'full') {
            // 56 题稳定性巡检：就绪率+时延+分任务+错误分布
            let rows = Object.entries(j.summary.byTask || {}).map(([t, v]) => '<tr><td>' + escHtml(t) + '</td><td>' + v.ready + '/' + v.total + '</td><td>' + (v.rate * 100).toFixed(0) + '%</td></tr>').join('');
            html += '<table><tr><th>就绪率</th><th>平均时延</th><th>时延区间</th></tr><tr><td>' + (j.summary.readyRate * 100).toFixed(0) + '%</td><td>' + (j.summary.avgLatencyMs ?? '—') + 'ms</td><td>' + (j.summary.minLatencyMs ?? '—') + '~' + (j.summary.maxLatencyMs ?? '—') + 'ms</td></tr></table>';
            if (rows) html += '<h4>分任务就绪</h4><table><tr><th>任务</th><th>就绪</th><th>率</th></tr>' + rows + '</table>';
            if (j.summary.errorTypes) html += '<h4>错误类型</h4><ul>' + Object.entries(j.summary.errorTypes).map(([k, n]) => '<li>' + escHtml(k) + ' × ' + n + '</li>').join('') + '</ul>';
            html += '<p class=\'hint\'>56 题稳定性巡检=就绪率+时延分布；不含质量评分（质量分以带裁判的 eval:gate 为准）。</p>';
          } else {
            // 6 题体检冒烟
            html += '<table><tr><th>就绪率</th><th>断言通过</th><th>建议平均时延</th><th>时延区间</th></tr><tr><td>' + (j.summary.successRate * 100).toFixed(0) + '%</td><td>' + (j.summary.assertPassed ?? '—') + '/' + (j.summary.assertTotal ?? '—') + '</td><td>' + (j.summary.suggestedAvgLatencyMs ?? '—') + 'ms</td><td>' + (j.summary.minLatencyMs ?? '—') + '~' + (j.summary.maxLatencyMs ?? '—') + 'ms</td></tr></table><p class=\'hint\'>6 题冒烟样本量小——结果仅作连通性参考，不构成质量结论；建议时延需人工确认后手工采纳。</p>';
          }
        }
        // v0.10.2：不再自动回填（样本量不支持），建议值人工确认后手工录入
        html += '<button class="primary" onclick="document.getElementById(\'evalModal\').style.display=\'none\';location.reload()">完成并刷新</button>';
      } else if (j.status === 'failed') {
        clearInterval(evalTimer);
        html += '<p style="color:#c33">失败：' + escHtml(String(j.error || '未知错误')) + '</p>';
      }
      $id('evalBody').innerHTML = html;
    } catch (e) { clearInterval(evalTimer); $id('evalBody').innerHTML = '<p style="color:#c33">' + escHtml(String(e.message)) + '</p>'; }
  }, 2000);
}
$id('evalClose')?.addEventListener('click', () => { clearInterval(evalTimer); $id('evalModal').style.display = 'none'; });

$id('models')?.addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-act]');
  if (!b) return;
  const idx = Number(b.closest('tr')?.dataset.index);
  const m = config.models[idx];
  if (!m) return;
  if (b.dataset.act === 'checkup') startEval('checkup', m.id);
  if (b.dataset.act === 'full') startEval('full', m.id);
});

// 页面加载后拉一次下线提醒 + 刷新换算提示
setTimeout(() => { refreshOfflineAlerts(); updateSelfBonusHint(); }, 800);

