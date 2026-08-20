let config, savedConfig, metrics, lastSimulation, simulateTimer;
const $ = (id) => document.getElementById(id);
// —— 后台枚举 → 中文展示映射（只影响展示，不碰配置值）——
const TASK_CN = { coding: '代码', reasoning: '推理', creative: '创意', extraction: '抽取', default: '通用' };
// OpenRouter rankings TASK TYPE 官方 30 小类 → 4 大类（+Pinned）
const SUB_CATEGORY = { 'code-generation': ['代码', 'CODE', '⚙️', '代码生成'], debugging: ['代码', 'CODE', '⚙️', '调试'], 'code-review': ['代码', 'CODE', '⚙️', '代码审查'], 'sql-database': ['代码', 'CODE', '⚙️', 'SQL 与数据库'], 'frontend-ui': ['代码', 'CODE', '⚙️', '前端与 UI'], 'devops-config': ['代码', 'CODE', '⚙️', 'DevOps 与配置'], 'shell-execution': ['代码', 'CODE', '⚙️', 'Shell 执行'], 'file-io': ['代码', 'CODE', '⚙️', '文件读写'], 'repo-scanning': ['代码', 'CODE', '⚙️', '仓库扫描'], 'multi-step-planning': ['智能体', 'AGENTS', '🤖', '多步规划'], 'tool-dispatch': ['智能体', 'AGENTS', '🤖', '工具调度'], 'workflow-execution': ['智能体', 'AGENTS', '🤖', '工作流执行'], 'web-search': ['智能体', 'AGENTS', '🤖', 'Web 搜索'], 'memory-extraction': ['智能体', 'AGENTS', '🤖', '记忆提取'], devops: ['智能体', 'AGENTS', '🤖', 'DevOps'], 'data-extraction': ['数据', 'DATA', '📋', '数据抽取'], 'data-transformation': ['数据', 'DATA', '📋', '数据转换'], classification: ['数据', 'DATA', '📋', '分类'], summarization: ['数据', 'DATA', '📋', '摘要'], translation: ['数据', 'DATA', '📋', '翻译'], math: ['数据', 'DATA', '📋', '数学'], 'content-writing': ['写作与对话', 'WRITING & CHAT', '💬', '内容写作'], 'research-reports': ['写作与对话', 'WRITING & CHAT', '💬', '研究与报告'], 'qa-knowledge': ['写作与对话', 'WRITING & CHAT', '💬', '问答与知识'], conversation: ['写作与对话', 'WRITING & CHAT', '💬', '对话'], 'customer-support': ['写作与对话', 'WRITING & CHAT', '💬', '客户支持'], 'roleplay-fiction': ['写作与对话', 'WRITING & CHAT', '💬', '角色扮演与虚构'], 'finance-trading': ['写作与对话', 'WRITING & CHAT', '💬', '金融与交易'], 'security-audit': ['写作与对话', 'WRITING & CHAT', '💬', '安全审计'], other: ['写作与对话', 'WRITING & CHAT', '💬', '其他'], pinned: ['指定模型', 'PINNED', '📌', '用户点名'] };
function subCategoryOf(task, subTask) { if (task === 'explicit') return SUB_CATEGORY.pinned; if (SUB_CATEGORY[subTask]) return SUB_CATEGORY[subTask]; const fb = { default: 'qa-knowledge', coding: 'code-generation', reasoning: 'research-reports', creative: 'content-writing', extraction: 'data-extraction', agent: 'workflow-execution' }[task]; return SUB_CATEGORY[fb] || SUB_CATEGORY.other; }
const TIER_CN = { simple: '轻量', balanced: '均衡', complex: '复杂' };
const METHOD_CN = { rules: '规则', semantic: '语义复核', 'rules+semantic': '规则+复核' };
const taskCN = (t) => TASK_CN[t] || t;
const escHtml = (x) => String(x ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const tierCN = (t) => TIER_CN[t] || t;
// 成本档位（OpenRouter cost_tier 思路）：档位=参数预设+成本带双向过滤（服务端 COST_TIERS 同步生效）。
// band 非 ceiling：质量/顶配档会把「过于便宜」的低端模型也排除，防止拉低整体质量。
const TASK_LABELS = { default: '通用', coding: '代码', reasoning: '推理', extraction: '抽取', creative: '创意', agent: '智能体', explicit: '点名模型' };
const PRESETS = {
  budget:  { label: '省钱档：低成本模型优先，跑简单/批量任务最划算。', qualityFloor: 0.76, costWeight: 0.4,  latencyWeight: 0.14, selfHostedBonus: 0.28 },
  balanced:{ label: '均衡档：质量成本兼顾，默认推荐（内网生产建议）。', qualityFloor: 0.82, costWeight: 0.22, latencyWeight: 0.15, selfHostedBonus: 0.2 },
  quality: { label: '质量档：排除低端模型，复杂任务更稳。', qualityFloor: 0.88, costWeight: 0.1,  latencyWeight: 0.1,  selfHostedBonus: 0.12 },
  max:     { label: '顶配档：只用最强模型，不计成本（评测/演示场景）。', qualityFloor: 0.9,  costWeight: 0,    latencyWeight: 0.05, selfHostedBonus: 0.1 },
  custom:  { label: '自定义：手动微调滑条后的状态，档位过滤已解除。' }
};
function headers(json = false) { const token = $('token').value.trim(); return { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(json ? { 'content-type': 'application/json' } : {}) }; }
async function api(path, options = {}) { const response = await fetch(path, { ...options, headers: { ...headers(Boolean(options.body)), ...(options.headers || {}) } }); const value = await response.json(); if (!response.ok) throw new Error(value.error?.message || `HTTP ${response.status}`); return value; }
function toast(message, bad = false) { const node = $('toast'); node.textContent = message; node.style.background = bad ? '#b42318' : '#101828'; node.classList.add('show'); setTimeout(() => node.classList.remove('show'), 3000); }
const percentValue = (value) => `${Math.round(Number(value) * 100)}%`;
// 敏感度滑条：显示「档位 · 具体数值」，档位仅是快速读法，数值才是真实配置
const sensitivity = (value) => Number(value) < .15 ? '低' : Number(value) < .3 ? '中' : Number(value) < .45 ? '高' : '很高';
const sensLabel = (value) => `${sensitivity(value)} · ${Number(value).toFixed(2)}`;
function markTierCustom() {
  document.querySelectorAll('#tierPicker .tier').forEach((x) => x.classList.toggle('active', x.dataset.tier === 'custom'));
  const radio = document.querySelector('input[name="costTier"][value="custom"]');
  if (radio) radio.checked = true;
  config.routing = config.routing || {}; config.routing.costTier = 'custom';
}
// 任务榜单：各类任务实际路由给了谁（近 2000 条决策聚合，学 OpenRouter task-spend rankings）
async function renderTaskBoard() {
  const rows = $('taskBoardRows'); if (!rows) return;
  try {
    const data = await api('/admin/api/task-board');
    if (!data.board?.length) { rows.innerHTML = '<tr><td colspan="5" class="empty">暂无决策记录（需开启决策日志）。</td></tr>'; return; }
    rows.innerHTML = data.board.map((b) => {
      const cells = [0, 1, 2].map((i) => b.picks[i]
        ? `<td>${b.picks[i].model} <span class="pill ${i === 0 ? 'good' : 'muted'}">${b.picks[i].share}%${b.picks[i].fails ? ` ·失败${b.picks[i].fails}` : ''}</span></td>`
        : '<td class="empty">—</td>').join('');
      const sc = subCategoryOf(b.task, b.sub);
      const subLabel = b.subLabel || sc[3];
      const icon = b.categoryIcon || sc[2];
      const catLabel = b.category || sc[0];
      const catEn = b.categoryEn || sc[1];
      return `<tr><th>${icon} ${catLabel} · ${subLabel}<br><span class="task-cat">${catEn}</span></th><td>${b.total}</td>${cells}</tr>`;
    }).join('');
  } catch (e) { rows.innerHTML = `<tr><td colspan="5" class="empty">${e.message}</td></tr>`; }
}
// 市场信号状态：飞轮健康度（激活任务数/休眠原因），样本不足时明说「等真实流量」
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
          return `${m} ${sg.share}%${adj}${fails}`;
        }).join('；');
        return `<div><strong>${TASK_LABELS[task] || task}</strong>：${items}</div>`;
      }).join('');
      box.hidden = false;
      box.innerHTML = `<p class="hint"><strong>白话版：哪个模型最近跑得好就多派活，跑砸了就少派活。</strong><br>机制：看最近 ${st.windowDays} 天的真实使用（样本太少不动，避免小数据乱调；调整幅度封顶 ±${st.maxAdjust}，只微调不颠覆跑分）。份额领先者加成、失败多者降权、被点名者小幅加成。</p>${lines}`;
    } else box.hidden = true;
  } catch { badge.style.display = 'none'; }
}
// 路由体检：auto vs 单模型基线（OpenRouter 评测叙事模板）
async function renderRoutingReport() {
  const rows = $('reportRows'); const hl = $('reportHighlights');
  if (!rows) return;
  rows.innerHTML = '<tr><td colspan="4" class="empty">计算中…</td></tr>';
  try {
    const data = await api('/admin/api/routing-report');
    rows.innerHTML = data.arms.map((a) => `<tr${a.name.startsWith('auto') ? ' style="font-weight:600;background:#f5f6fc"' : ''}><th>${a.name}${a.name.startsWith('auto') ? ' ⭐' : ''}</th><td>${a.quality}</td><td>${a.costIndex}</td><td>${a.latencyIndex}</td></tr>`).join('');
    hl.innerHTML = (data.highlights || []).map((t) => `<div class="highlight">${t}</div>`).join('');
  } catch (e) { rows.innerHTML = `<tr><td colspan="4" class="empty">${e.message}</td></tr>`; }
}
// 总览 · 策略快照 + 任务分布（撑起总览信息密度）
const TIER_SNAP = { budget: '省钱', balanced: '均衡', quality: '质量', max: '顶配', custom: '自定义' };
function renderOverview() {
  if (!config) return;
  // 策略快照
  const snap = $('policySnapshot');
  if (snap) {
    const r = config.routing || {};
    const rows = [
      ['成本档位', TIER_SNAP[r.costTier] || '均衡'],
      ['运行状态', r.mode === 'active' ? '正式生效' : '仅观察'],
      ['Auto 生效流量', (r.activeTrafficPercent ?? 100) + '%'],
      ['最低质量目标', (r.qualityFloor ?? 0.82).toFixed(2)],
      ['成本敏感度', (r.costWeight ?? 0.22).toFixed(2)],
      ['速度敏感度', (r.latencyWeight ?? 0.1).toFixed(2)]
    ];
    snap.innerHTML = rows.map(([k, v]) => `<div><small>${k}</small><b>${v}</b></div>`).join('');
  }
  // 任务分布（用决策日志 metrics.counters.task）
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

function updateRangeLabels() { $('trafficValue').textContent = `${$('activeTrafficPercent').value}%`; $('qualityFloorValue').textContent = `≥ ${percentValue($('qualityFloor').value)}`; $('costWeightValue').textContent = sensLabel($('costWeight').value); $('latencyWeightValue').textContent = sensLabel($('latencyWeight').value); $('selfBonusValue').textContent = `+${Number($('selfBonus').value).toFixed(2)}`; $('presetHelp').textContent = PRESETS[document.querySelector('input[name="costTier"]:checked')?.value]?.label || PRESETS.custom.label; }
// 脏标记：表单与已发布版本不一致时提示「有未发布修改」，避免不知道改没改成
// diff 驱动而非交互驱动——拖回原值/改了又撤销会自动熄灭；键序无关深比较，server 端规范化重排键也不误报
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}
function syncDirty() { if (!config || !savedConfig) return; readForm(); const dirty = stableStringify(config) !== stableStringify(savedConfig); const badge = $('dirtyBadge'); if (badge) badge.hidden = !dirty; const dot = $('tabDirtyDot'); if (dot) dot.hidden = !dirty; }
// 基线规范化：savedConfig 必须与 readForm 之后的 config 同形状（readForm 会补 pricingYuan…/performance 等默认键），
// 否则 diff 永不相等。凡重建基线（connect/发布成功）处，先 render 表单再 readForm 再 snapshot。
function snapshotBaseline() { bindPolicy(); renderModels(); renderCapabilityMatrix(); renderDeployment(); readForm(); savedConfig = structuredClone(config); clearDirty(); }
// —— 页面 Tab 切换 ——
const TABS = ['overview','policy','models','insights','semantic','debug','help'];
function applyTab(name) {
  if (!TABS.includes(name)) name = 'overview';
  document.querySelectorAll('.tab-page').forEach(p => { p.hidden = p.dataset.tab !== name; });
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  history.replaceState(null, '', '#' + name);
  sessionStorage.setItem('routerTab', name);
}
document.querySelectorAll('#tabs button').forEach(b => { b.onclick = () => applyTab(b.dataset.tab); });

// ── 业务策略只读锁：默认只读，点「解锁修改」才能调整 ──
const POLICY_INPUTS = ['#mode', '#activeTrafficPercent', '#preferSelf', '#reasoningEnabled', '#decisionLogEnabled',
  '#costTier', '#qualityFloor', '#costWeight', '#latencyWeight', '#budgetEnabled', '#dailyBudget',
  '#budgetThreshold', '#selfBonus', '#qualityWeight', '#complexQualityMargin', '#uncertaintyPenalty', '#maxAttempts']
  .flatMap(sel => Array.from(document.querySelectorAll(sel))).concat(
    Array.from(document.querySelectorAll('#tierPicker input')));
function setPolicyLock(locked) {
  POLICY_INPUTS.forEach(el => { el.disabled = locked; });
  const note = $('policyLockNote'); if (note) note.hidden = !locked;
  const unlock = $('unlockEdit'); if (unlock) unlock.hidden = !locked;
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
function isDirty() { try { return config && savedConfig && stableStringify(config) !== stableStringify(savedConfig); } catch { return false; } }
// 初始 tab：URL hash > 上次停留 > overview
applyTab((location.hash || '').slice(1) || sessionStorage.getItem('routerTab') || 'overview');
loadManual();
if ($('gotoPolicy')) $('gotoPolicy').onclick = () => applyTab('policy');
if ($('gotoInsights')) $('gotoInsights').onclick = () => applyTab('insights');
// 手册直嵌（不再 iframe）：拉预渲染页，用 Shadow DOM 隔离样式（手册的全局选择器不污染管理页），
// 目录 TOC 由这里手动生成（DOMParser 不执行页面脚本）。
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
      // 嵌入模式适配：去顶栏、占满、TOC 粘滞
      st.textContent = styleEl.textContent + '\nheader.top{display:none}body{background:transparent}.layout{max-width:none;padding:0;gap:24px}nav.toc{position:sticky;top:0;max-height:76vh}main.doc{border:none;box-shadow:none;border-radius:0;padding:6px 26px 24px}';
      shadow.appendChild(st);
    }
    shadow.appendChild(document.importNode(layout, true));
    // 生成目录（复刻 /manual 页内脚本逻辑）
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
        // Shadow DOM 内 href="#..." 的原生锚点跳转不生效（不穿透 shadow root）——手动滚动
        a.addEventListener('click', (ev) => {
          ev.preventDefault();
          h.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        toc.appendChild(a);
      });
      // 滚动高亮（监听管理页窗口滚动，按视口位置点亮当前节）
      const links = Array.from(toc.querySelectorAll('a'));
      const onScroll = () => {
        let cur = null;
        heads.forEach((h) => { if (h.getBoundingClientRect().top < 100) cur = h.id; });
        links.forEach((a) => a.className = a.getAttribute('href') === '#' + cur ? 'active' : '');
      };
      window.addEventListener('scroll', onScroll, { passive: true });
      onScroll();
    }
    // 代码块复制按钮（同 /manual 独立页；clipboard 失败退回 execCommand）
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
function bindPolicy() {
  const r = config.routing; $('mode').value = r.mode; $('activeTrafficPercent').value = r.activeTrafficPercent ?? 100; $('qualityFloor').value = r.qualityFloor; $('selfBonus').value = r.selfHostedBonus; $('qualityWeight').value = r.qualityWeight; $('costWeight').value = r.costWeight; $('latencyWeight').value = r.latencyWeight; $('uncertaintyPenalty').value = r.uncertaintyPenalty; $('complexQualityMargin').value = r.complexQualityMargin ?? .04; $('maxAttempts').value = r.maxAttempts; $('preferSelf').checked = r.preferSelfHosted;
  $('semanticEnabled').checked = Boolean(config.semanticRouter?.enabled); $('semanticMode').value = config.semanticRouter?.mode || 'shadow'; $('semanticThreshold').value = config.semanticRouter?.confidenceThreshold ?? .7; $('semanticMinConfidence').value = config.semanticRouter?.minConfidence ?? 0; $('reasoningEnabled').checked = Boolean(config.reasoningControl?.enabled); $('budgetEnabled').checked = Boolean(config.budget?.enabled); $('dailyBudget').value = config.budget?.dailyBudgetYuan || 0; $('budgetThreshold').value = config.budget?.degradeThreshold ?? .9;
  $('semanticProvider').value = config.semanticRouter?.provider || (config.semanticRouter?.model ? 'openai-chat' : 'disabled');
  const chatModel = config.semanticRouter?.openaiChat?.model || config.semanticRouter?.model;
  $('semanticModel').innerHTML = config.models.map((m) => `<option value="${m.id}" ${m.id === chatModel ? 'selected' : ''}>${m.displayName || m.id}</option>`).join('');
  $('semanticHttpUrl').value = config.semanticRouter?.httpJson?.url || '';
  $('decisionLogEnabled').checked = Boolean(config.decisionLog?.enabled);
  const matched = Object.entries(PRESETS).find(([key, p]) => key !== 'custom' && ['qualityFloor','costWeight','latencyWeight','selfHostedBonus'].every((f) => Math.abs(r[f] - p[f]) < .005));
  const tierNow = matched?.[0] || (PRESETS[r.costTier] ? r.costTier : 'custom');
  const tierRadio = document.querySelector(`input[name="costTier"][value="${tierNow}"]`);
  if (tierRadio) tierRadio.checked = true;
  document.querySelectorAll('#tierPicker .tier').forEach((el) => el.classList.toggle('active', el.dataset.tier === tierNow));
  updateRangeLabels();
}
function renderModels() { $('models').innerHTML = config.models.map((m, i) => `<tr data-index="${i}"><td><input class="enabled" type="checkbox" ${m.enabled ? 'checked' : ''}></td><td><strong>${m.displayName || m.id}</strong><br><small>${m.id}</small></td><td><span class="tag ${m.ownership === 'self_hosted' ? 'self' : 'eco'}">${m.ownership === 'self_hosted' ? '自建' : '生态'}</span></td><td><input class="quality" type="number" min="0" max="1" step=".01" value="${m.quality.default}"></td><td><input class="cost" type="number" min="0" step=".01" value="${m.costIndex}"></td><td><input class="latency" type="number" min="0" step=".01" value="${m.latencyIndex}"></td><td><input class="input-price" type="number" min="0" step=".01" placeholder="待配置" value="${m.pricingYuanPerMillionTokens?.input ?? ''}"></td><td><input class="cached-price" type="number" min="0" step=".01" placeholder="无折扣" value="${m.pricingYuanPerMillionTokens?.inputCached ?? ''}"></td><td><input class="output-price" type="number" min="0" step=".01" placeholder="待配置" value="${m.pricingYuanPerMillionTokens?.output ?? ''}"></td><td><input class="p95" type="number" min="0" step="1" placeholder="待观测" value="${m.performance?.totalP95Ms ?? ''}"></td><td><span class="pill ${m.calibrationStatus === 'verified' ? 'good' : 'muted'}">${m.calibrationStatus === 'verified' ? '已验证' : m.calibrationStatus === 'pilot' ? 'Pilot' : '待校准'}</span></td><td class="health">—</td></tr>`).join(''); }
function computeCostIndexClient(models, cardPrice) { const costs = []; for (const m of models) { const d = m.deployment; if (!d || !d.machines || !d.tps) continue; const cardWeight = Number(cardPrice[d.deviceType] || 1); const hw = Number(d.machines) * (Number(d.cardsPerMachine) || 1) * cardWeight; costs.push({ id: m.id, unitCost: hw / Number(d.tps) }); } if (!costs.length) return null; const max = Math.max(...costs.map((c) => c.unitCost)); if (!(max > 0)) return null; return Object.fromEntries(costs.map((c) => [c.id, Number((c.unitCost / max).toFixed(3))])); }
function computeCostIndexFromPricingClient(models, pricingMix) { const mix = pricingMix || { input: 10, output: 1 }; const total = Number(mix.input) + Number(mix.output); if (!(total > 0)) return null; const is = Number(mix.input) / total, os = Number(mix.output) / total; const costs = []; for (const m of models) { const p = m.pricingYuanPerMillionTokens; if (p?.input == null || p?.output == null) continue; const w = is * Number(p.input) + os * Number(p.output); if (w > 0) costs.push({ id: m.id, unitCost: w }); } if (costs.length < 2) return null; const anchor = Number(config?.costModel?.pricingAnchorYuan) > 0 ? Number(config.costModel.pricingAnchorYuan) : Math.max(...costs.map((c) => c.unitCost)); if (!(anchor > 0)) return null; return Object.fromEntries(costs.map((c) => [c.id, Number(Math.min(1, c.unitCost / anchor).toFixed(3))])); }
// 跑分一览矩阵：行=模型 列=六维；色阶按列内相对高低，每列最强加皇冠标记；单元格失焦即写回 config（手工微调），未启用模型灰显
const CAP_TASKS = ['default','coding','reasoning','extraction','creative','simple'];
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
      const heat = Math.max(0, Math.min(1, (num - 0.75) / 0.25)); // 0.75~1 映射到 0~1 色阶（绿色由浅到深）
      const isBest = m.enabled && num >= best[t] - 1e-9 && num > 0; // 未启用模型不参评最强
      const crown = isBest ? '<span class="cap-best" title="该维度最强">★</span>' : '';
      const bg = m.enabled ? ` style="background:rgba(18,145,80,${(heat * 0.38).toFixed(3)})"` : ''; // 未启用行去色阶只灰显
      return `<td${bg}><div class="cap-cell${dim}"><input class="cap-input" data-task="${t}" data-index="${i}" type="number" min="0" max="1" step="0.001" value="${v}">${crown}</div></td>`;
    }).join('');
    return `<tr><th><div class="cap-model${dim}"><strong>${m.displayName || m.id}</strong><span class="pill ${m.enabled ? 'good' : 'muted'}" style="margin-left:8px">${m.enabled ? '启用中' : '已停用'}</span><small>${m.id}</small></div></th>${cells}</tr>`;
  }).join('');
}
$('capRows').addEventListener('input', (e) => { if (!e.target.classList.contains('cap-input')) return; const idx = Number(e.target.dataset.index); const task = e.target.dataset.task; const v = e.target.value === '' ? null : Number(e.target.value); config.models[idx].quality[task] = v; syncDirty(); scheduleSimulation(); });
function renderDeployment() { const cm = config.costModel || {}; const source = cm.source || 'deployment'; $('costSource').value = source; $('pricingMixInput').value = cm.pricingMix?.input ?? 10; $('pricingMixOutput').value = cm.pricingMix?.output ?? 1; $('beansPerYuan').value = config.budget?.beansPerYuan ?? ''; const cardPrice = cm.cardPrice || {}; const computed = source === 'pricing' ? (computeCostIndexFromPricingClient(config.models, cm.pricingMix) || {}) : (computeCostIndexClient(config.models, cardPrice) || {}); $('deployment').innerHTML = config.models.map((m, i) => { const d = m.deployment || {}; return `<tr data-index="${i}"><td><strong>${m.displayName || m.id}</strong></td><td><select class="device-type"><option value="910B2" ${d.deviceType === '910B2' ? 'selected' : ''}>910B2</option><option value="910B4" ${d.deviceType === '910B4' ? 'selected' : ''}>910B4</option></select></td><td><input class="machines" type="number" min="1" step="1" value="${d.machines ?? ''}" placeholder="设备数"></td><td><input class="cards" type="number" min="1" step="1" value="${d.cardsPerMachine ?? ''}" placeholder="单机卡数"></td><td><input class="instances" type="number" min="1" step="1" value="${d.instances ?? ''}" placeholder="实例数"></td><td><input class="concurrency" type="number" min="1" step="1" value="${d.concurrencyPerInstance ?? ''}" placeholder="单实例并发"></td><td>${d.instances && d.concurrencyPerInstance ? `<span class="pill good">${d.totalConcurrency ?? d.instances * d.concurrencyPerInstance}</span>` : '<span class="pill muted">—</span>'}</td><td><input class="tps" type="number" min="1" value="${d.tps ?? ''}" placeholder="tokens/s"></td><td><span class="cost-preview pill ${computed[m.id] != null ? 'good' : 'muted'}">${computed[m.id] ?? '待录入'}</span></td></tr>`; }).join(''); }
function readForm() {
  const r = config.routing; r.costTier = document.querySelector('input[name="costTier"]:checked')?.value || 'custom'; r.mode = $('mode').value; r.activeTrafficPercent = Number($('activeTrafficPercent').value); r.qualityFloor = Number($('qualityFloor').value); r.selfHostedBonus = Number($('selfBonus').value); r.qualityWeight = Number($('qualityWeight').value); r.costWeight = Number($('costWeight').value); r.latencyWeight = Number($('latencyWeight').value); r.uncertaintyPenalty = Number($('uncertaintyPenalty').value); r.complexQualityMargin = Number($('complexQualityMargin').value); r.maxAttempts = Number($('maxAttempts').value); r.preferSelfHosted = $('preferSelf').checked;
  config.semanticRouter.enabled = $('semanticEnabled').checked; config.semanticRouter.mode = $('semanticMode').value; config.semanticRouter.confidenceThreshold = Number($('semanticThreshold').value); config.semanticRouter.minConfidence = Number($('semanticMinConfidence').value); config.reasoningControl.enabled = $('reasoningEnabled').checked; config.budget.enabled = $('budgetEnabled').checked; config.budget.dailyBudgetYuan = Number($('dailyBudget').value); config.budget.degradeThreshold = Number($('budgetThreshold').value);
  config.semanticRouter.provider = $('semanticProvider').value;
  if ($('semanticProvider').value === 'openai-chat') { config.semanticRouter.model = $('semanticModel').value; delete config.semanticRouter.httpJson; }
  else if ($('semanticProvider').value === 'http-json') { config.semanticRouter.httpJson = { ...(config.semanticRouter.httpJson || {}), url: $('semanticHttpUrl').value.trim() }; }
  else { delete config.semanticRouter.model; delete config.semanticRouter.httpJson; }
  config.decisionLog = { ...(config.decisionLog || {}), enabled: $('decisionLogEnabled').checked };
  document.querySelectorAll('#models tr').forEach((row) => { const m = config.models[Number(row.dataset.index)]; const nullableNumber=(selector)=>{const value=row.querySelector(selector).value;return value===''?null:Number(value)}; m.enabled = row.querySelector('.enabled').checked; m.quality.default = Number(row.querySelector('.quality').value); m.costIndex = Number(row.querySelector('.cost').value); m.latencyIndex = Number(row.querySelector('.latency').value); m.pricingYuanPerMillionTokens ||= {}; m.pricingYuanPerMillionTokens.input=nullableNumber('.input-price'); m.pricingYuanPerMillionTokens.inputCached=nullableNumber('.cached-price'); m.pricingYuanPerMillionTokens.output=nullableNumber('.output-price'); m.performance ||= {}; m.performance.totalP95Ms=nullableNumber('.p95'); }); document.querySelectorAll('#deployment tr').forEach((row) => { const m = config.models[Number(row.dataset.index)]; const deviceType = row.querySelector('.device-type').value; const machines = row.querySelector('.machines').value; const cards = row.querySelector('.cards').value; const tps = row.querySelector('.tps').value; const instances = row.querySelector('.instances').value; const concurrency = row.querySelector('.concurrency').value;
    if (machines && tps) m.deployment = { deviceType, machines: Number(machines), cardsPerMachine: Number(cards) || 1, tps: Number(tps), ...(instances ? { instances: Number(instances), concurrencyPerInstance: Number(concurrency) || null, totalConcurrency: Number(instances) * (Number(concurrency) || 0) || null } : {}) }; else delete m.deployment; }); config.costModel ||= {}; config.costModel.source = $('costSource').value; const mixIn = Number($('pricingMixInput').value), mixOut = Number($('pricingMixOutput').value); if (Number.isFinite(mixIn) && Number.isFinite(mixOut) && mixIn >= 0 && mixOut >= 0 && mixIn + mixOut > 0) config.costModel.pricingMix = { input: mixIn, output: mixOut }; const beanRate = Number($('beansPerYuan').value); if (Number.isFinite(beanRate) && beanRate > 0) { config.budget ||= {}; config.budget.beansPerYuan = beanRate; } const cardPrice = config.costModel.cardPrice || {}; const computedCost = config.costModel.source === 'pricing' ? computeCostIndexFromPricingClient(config.models, config.costModel.pricingMix) : computeCostIndexClient(config.models, cardPrice); if (computedCost) for (const m of config.models) if (computedCost[m.id] != null) m.costIndex = computedCost[m.id]; return config;
}
function metricDelta(current, proposed, lower = false) { const delta = proposed - current, good = lower ? delta <= 0 : delta >= 0; return `<strong>${proposed.toFixed(2)}</strong><small class="${good ? 'positive' : 'negative'}">${delta >= 0 ? '+' : ''}${delta.toFixed(2)}</small>`; }
function metricDeltaMs(current, proposed, lower = false) { const delta = Math.round(proposed - current), good = lower ? delta <= 0 : delta >= 0; return `<strong>${Math.round(proposed)}ms</strong><small class="${good ? 'positive' : 'negative'}">${delta >= 0 ? '+' : ''}${delta}ms</small>`; }
function metricDeltaCost(current, proposed, lower = false) { const delta = proposed - current, good = lower ? delta <= 0 : delta >= 0, fmt = (v) => (v < 0.01 ? v.toFixed(4) : v.toFixed(2)); return `<strong>¥${fmt(proposed)}</strong><small class="${good ? 'positive' : 'negative'}">${delta >= 0 ? '+' : ''}${fmt(delta)}</small>`; }
function renderSimulation(result) {
  lastSimulation = result; const c = result.current, p = result.proposed, risk = result.changedRate >= .5 ? 'high' : result.changedRate >= .2 ? 'medium' : 'low';
  $('impactSummary').innerHTML = `<article class="impact ${risk}"><span>模型切换</span><strong>${result.changed}/${result.sampleCount}</strong><small>${percentValue(result.changedRate)} 代表任务改变</small></article><article><span>预计质量</span>${metricDelta(c.averageQuality,p.averageQuality)}</article>${(c.averageCostYuan!=null&&p.averageCostYuan!=null)?`<article><span>平均单次成本 <span class="help" data-help="按代表性任务（含系统提示词+多轮上下文+业务文档，非单句提问）的平均输入输出量估算的每次请求成本（元）。">?</span></span>${metricDeltaCost(c.averageCostYuan,p.averageCostYuan,true)}</article>`:`<article><span>成本指数</span>${metricDelta(c.averageCostIndex,p.averageCostIndex,true)}</article>`}${(c.averageLatencyMs!=null&&p.averageLatencyMs!=null)?`<article><span>平均端到端时延 <span class="help" data-help="从发出请求到收完完整回答的总耗时（含模型思考时间），按代表性任务平均。">?</span></span>${metricDeltaMs(c.averageLatencyMs,p.averageLatencyMs,true)}</article>`:`<article><span>时延指数</span>${metricDelta(c.averageLatencyIndex,p.averageLatencyIndex,true)}</article>`}<article><span>自建比例</span><strong>${percentValue(p.selfHostedRate)}</strong><small>当前 ${percentValue(c.selfHostedRate)}</small></article>`;
  $('impactRows').innerHTML = p.rows.map((row,i) => { const before=c.rows[i], changed=before.model!==row.model; const sc3 = subCategoryOf(row.task, row.subTask); return `<tr><td><strong>${row.label}</strong><br><small>${sc3[2]} ${sc3[0]} · ${sc3[3]}</small></td><td>${Math.round(row.complexity*100)} · ${tierCN(row.tier)}</td><td>${before.model}</td><td>${row.model}</td><td><span class="pill ${changed?'bad':'good'}">${changed?'切换':'不变'}</span></td></tr>`; }).join('');
  renderSensitivity(result.sensitivity);
}
// 调整手感：每个滑条「再拉多少才会变 / 拉到头也变不了的原因」
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
      return `<article class="sens-card"><div class="sens-head"><b>${axis.label}</b><span class="pill ${gap <= .1 ? 'warn' : 'muted'}">${dir}到 ${fmt(axis.nextFlip.at)} 触发切换</span></div><p>调整幅度 <b>${gap.toFixed(2)}</b> 后，${axis.nextFlip.count} 个代表任务从「${axis.nextFlip.from}」切换到「${axis.nextFlip.to}」。当前值附近 ${(axis.flips || []).length ? `首个翻转点 ${fmt(axis.flips[0].at)}` : '尚无翻转'}。</p></article>`;
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
function renderMetrics(){ const c=metrics.counters; $('total').textContent=c.total; $('autoRate').textContent=percent(c.auto,c.total); const selfIds=new Set(config.models.filter(m=>m.ownership==='self_hosted').map(m=>m.id)); const self=Object.entries(c.selected).filter(([id])=>selfIds.has(id)).reduce((s,[,n])=>s+n,0); $('selfRate').textContent=percent(self,c.success); $('semanticRate').textContent=percent(c.semantic?.disagreed||0,c.semantic?.succeeded||0); $('budgetRate').textContent=metrics.budget?.enabled?percentValue(metrics.budget.pressure):'未启用'; $('fallback').textContent=c.fallback; $('errorRate').textContent=percent(c.errors,c.total); document.querySelectorAll('#models tr').forEach(row=>{const m=config.models[Number(row.dataset.index)],h=metrics.health[m.id],cell=row.querySelector('.health'); cell.innerHTML=!h?'<span class="pill muted">无数据</span>':h.circuitState==='half_open'?'<span class="pill muted">恢复探测</span>':h.circuitOpenUntil>Date.now()?'<span class="pill bad">熔断</span>':`<span class="pill good">${h.ewmaLatencyMs}ms · ${h.failures}错</span>`}); $('recent').innerHTML=metrics.recent.length?metrics.recent.map(x=>`<div class="recent-item"><time>${new Date(x.at).toLocaleTimeString()}</time><div><b>${x.selected}</b> <small>← ${x.requested} · ${taskCN(x.task)} · ${METHOD_CN[x.routeMethod]||x.routeMethod||'规则'} · 推理${x.reasoningLevel||'off'}${x.fallbackAttempt?` · fallback ${x.fallbackAttempt}`:''}</small></div><span class="pill ${x.ok?'good':'bad'}">${x.ok?`${x.latencyMs}ms`:'失败'}</span></div>`).join(''):'<p class="empty">暂无请求</p>'; }
async function connect(){ try{sessionStorage.setItem('routerAdminToken',$('token').value); [config,metrics]=await Promise.all([api('/admin/api/config'),api('/admin/api/metrics')]);snapshotBaseline(); $('status').textContent=`已连接 · v${config.version}`; $('status').className='pill good'; renderMetrics(); renderOverview(); renderTaskBoard(); renderMarketSignal(); applyPolicyLock(); await simulate();}catch(error){$('status').textContent='连接失败';$('status').className='pill bad';toast(error.message,true)} }
$('token').value=sessionStorage.getItem('routerAdminToken')||''; $('connect').onclick=connect; $('refresh').onclick=async()=>{try{metrics=await api('/admin/api/metrics');renderMetrics();renderOverview()}catch(e){toast(e.message,true)}}; $('reload').onclick=()=>{if(!savedConfig)return;config=structuredClone(savedConfig);snapshotBaseline();renderMetrics();simulate();toast('已恢复到当前线上版本')}; $('refreshBoard').onclick = () => { renderTaskBoard(); renderMarketSignal(); };
if ($('probeSemantic')) $('probeSemantic').onclick = async () => {
  const url = $('semanticHttpUrl')?.value?.trim();
  const box = $('semanticProbeResult');
  box.hidden = false; box.className = 'probe-result'; box.textContent = '正在探测…';
  try {
    // 不传 url 时由服务端探测当前生效端点（env 覆盖 config 的场景也不会测错对象）；填了则先验再存
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
// 新增模型（运营流程第 1 步）：以 qwen36-35b 为模板的保守默认值 + enabled:false，录入后立即出现在表格中可继续编辑，发布走既有安全链路
$('addModel').onclick=()=>{ if(!config) return toast('请先连接',true); const id=prompt('新模型 ID（MaaS 上的模型名，与现有模型同 URL，如 qwen38-27b）'); if(id===null) return; const trimmed=id.trim(); if(!trimmed) return toast('模型 ID 不能为空',true); if(config.models.some(m=>m.id===trimmed)) return toast(`模型 ${trimmed} 已存在`,true); config.models.push({ id:trimmed, displayName:trimmed, ownership:'self_hosted', enabled:false, calibrationStatus:'unverified', quality:{ default:0.80, simple:0.85, coding:0.75, reasoning:0.78, creative:0.82, extraction:0.85 }, costIndex:0.5, latencyIndex:0.5, pricingYuanPerMillionTokens:{ input:null, inputCached:null, output:null }, performance:{ totalP95Ms:null, ttftP50Ms:null, tokensPerSecond:null }, capabilities:{ chat:true, stream:true }, contextWindow:131072, reasoningControl:{ parameter:'reasoning_effort', verified:false } }); renderModels(); renderDeployment(); bindPolicy(); syncDirty(); scheduleSimulation(); toast(`已添加 ${trimmed}（未启用）——填定价/质量分后发布，再跑 eval gate 实测校准`); };
for(const id of ['mode','activeTrafficPercent','qualityFloor','costWeight','latencyWeight','selfBonus','preferSelf','qualityWeight','complexQualityMargin','uncertaintyPenalty','maxAttempts','semanticEnabled','semanticMode','semanticProvider','semanticModel','semanticHttpUrl','semanticThreshold','semanticMinConfidence','decisionLogEnabled','reasoningEnabled','budgetEnabled','dailyBudget','budgetThreshold']) $(id).addEventListener('input',()=>{if(!['mode','activeTrafficPercent','preferSelf','semanticEnabled','semanticMode','semanticProvider','semanticModel','semanticHttpUrl','semanticThreshold','decisionLogEnabled','reasoningEnabled','budgetEnabled','dailyBudget','budgetThreshold'].includes(id))markTierCustom();updateRangeLabels();syncDirty();scheduleSimulation()}); $('models').addEventListener('input',()=>{syncDirty();scheduleSimulation()}); const refreshCostPreview = () => { const cm = config.costModel || {}; const computed = (cm.source === 'pricing' ? computeCostIndexFromPricingClient(config.models, cm.pricingMix) : computeCostIndexClient(config.models, cm.cardPrice || {})) || {}; document.querySelectorAll('#deployment tr').forEach(row => { const m = config.models[Number(row.dataset.index)]; const cell = row.querySelector('.cost-preview'); if (computed[m.id] != null) { cell.textContent = computed[m.id]; cell.className = 'cost-preview pill good'; } else { cell.textContent = '待录入'; cell.className = 'cost-preview pill muted'; } }); document.querySelectorAll('#models tr').forEach(row => { const m = config.models[Number(row.dataset.index)]; if (computed[m.id] != null) row.querySelector('.cost').value = computed[m.id]; }); };
$('deployment').addEventListener('input',()=>{readForm(); refreshCostPreview(); syncDirty(); scheduleSimulation();});
for (const id of ['costSource','pricingMixInput','pricingMixOutput','beansPerYuan']) $(id).addEventListener('input',()=>{readForm(); refreshCostPreview(); syncDirty(); scheduleSimulation();});
$('save').onclick=async()=>{try{const impact=await simulate(),qualityDrop=impact.proposed.averageQuality-impact.current.averageQuality,highRisk=impact.changedRate>=.4||qualityDrop<-.02||Number(config.routing.activeTrafficPercent)-Number(savedConfig.routing.activeTrafficPercent||0)>30;if(highRisk&&!window.confirm(`这次调整会改变 ${percentValue(impact.changedRate)} 的代表任务，预计质量变化 ${qualityDrop>=0?'+':''}${qualityDrop.toFixed(2)}。\n\n建议先小流量灰度。仍要发布吗？`))return;config=await api('/admin/api/config',{method:'PUT',body:JSON.stringify(config)});snapshotBaseline();$('status').textContent=`已连接 · v${config.version}`;toast(`配置已发布生效（v${config.version}），上一版本已自动备份`);await simulate()}catch(e){toast(e.message,true)}};
$('preview').onclick=async()=>{const body={model:'auto',messages:[{role:'user',content:$('prompt').value}],stream:$('stream').checked};if($('tools').checked)body.tools=[{type:'function',function:{name:'demo_tool',parameters:{type:'object'}}}];if($('jsonMode').checked)body.response_format={type:'json_object'};try{const d=await api('/admin/api/preview',{method:'POST',body:JSON.stringify(body)}),reasons=d.analysis.signals.map(s=>`  ${s.contribution>=0?'+':''}${s.contribution.toFixed(2)} ${s.label}`).join('\n'),review=d.semanticReview?.assessment?`\n语义复核：${d.semanticReview.status==='applied'?'已采用':'仅观察'} · ${tierCN(d.semanticReview.assessment.tier)}/${d.semanticReview.assessment.complexity.toFixed(2)}\n复核理由：${d.semanticReview.assessment.reason}\n复核后建议：${d.semanticReview.proposed?.model||d.suggestedModel}\n`:d.semanticReview?.error?`\n语义复核失败（已安全回退规则）：${d.semanticReview.error}\n`:'';$('decision').textContent=`建议模型：${d.suggestedModel}\n实际模型：${d.selectedModel}${d.shadow?'（当前未进入 Auto 生效流量）':''}\n推理强度：${d.reasoningLevel}\n判断方式：${METHOD_CN[d.analysis.routeMethod]||d.analysis.routeMethod||'规则'}\n任务：${taskCN(d.analysis.task)} · ${tierCN(d.analysis.tier)}\n难度：${d.analysis.complexity.toFixed(2)} · 判断置信度 ${percentValue(d.analysis.confidence)}${review}\n难度来源：\n${reasons}\n\n候选评分：\n${d.candidates.map(c=>`  ${c.model.padEnd(20)} score=${c.score.toFixed(3)} quality=${c.quality.toFixed(2)} floor=${c.effectiveQualityFloor.toFixed(2)}`).join('\n')}\n降级顺序：${d.fallbackOrder.join(' → ')}`}catch(e){$('decision').textContent=e.message}};
connect(); setInterval(async()=>{if(config)try{metrics=await api('/admin/api/metrics');renderMetrics()}catch{}},10000);

// 术语解释 tooltip：鼠标悬停 ? 图标时，在图标上方/下方弹出解释（fixed 定位，不受表格 overflow 裁切）
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
  if (y < 8) y = rect.bottom + 10;  // 顶部放不下时改到下方
  helpTooltip.style.left = `${x}px`;
  helpTooltip.style.top = `${y}px`;
}
document.addEventListener('mouseover', (e) => { const help = e.target.closest('.help'); if (help) showHelp(help); });
document.addEventListener('mouseout', (e) => { if (e.target.closest('.help')) helpTooltip.classList.remove('show'); });

// —— 简单/专家双模式 ——
// 简单模式隐藏专家区（靠 CSS：.simple-view 下隐藏 expert-only/高级折叠/模型参数/成本定价/单题解释），
// 只留预设、运行状态、灰度、预算和影响模拟。专家模式=全量视图。选择存 localStorage。
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

// —— 基线对照渲染（随机基线 / 事后最优，来自 simulate 响应的 baselines 字段）——
function renderBaselines() {
  const box = $('baselineRows');
  if (!box || !lastSimulation?.proposed?.baselines) return;
  const b = lastSimulation.proposed.baselines;
  const cur = lastSimulation.proposed;
  const row = (name, data) => `<article><span>${name}</span><strong>质量 ${data.averageQuality?.toFixed(3) ?? '—'}</strong><small>成本 ${data.averageCostIndex?.toFixed(3) ?? '—'} · 时延 ${data.averageLatencyIndex?.toFixed(3) ?? '—'}</small><small class="muted">${Object.entries(data.modelDistribution || {}).map(([m, n]) => `${m}×${n}`).join(' ')}</small></article>`;
  box.innerHTML = `<article><span>当前路由</span><strong>质量 ${cur.averageQuality?.toFixed(3) ?? '—'}</strong><small>成本 ${cur.averageCostIndex?.toFixed(3) ?? '—'} · 时延 ${cur.averageLatencyIndex?.toFixed(3) ?? '—'}</small><small class="muted">应落在两个基线之间</small></article>` + row(b.zeroRouter?.label || '随机基线', b.zeroRouter || {}) + row(b.oracle?.label || '事后最优', b.oracle || {}) + `<p class="hint">Pareto 前沿：${(lastSimulation.proposed.paretoFrontier || []).join('、') || '—'}。当前路由质量低于随机基线时，说明任务区分度不足或评分权重失衡，应先调分类/权重而不是加模型。</p>`;
}

// —— 组件体检：分类器标准评测 ——
$('evalClassifier').onclick = async () => {
  const box = $('classifierReport');
  box.innerHTML = '<p class="empty">评测中（heldout 集 454 条，约几秒）…</p>';
  try {
    const r = await api('/admin/api/classifier/evaluate', { method: 'POST' });
    const matrix = (confusion, labels) => `<table class="mini-matrix"><thead><tr><th>真实＼预测</th>${labels.map((l) => `<th>${l}</th>`).join('')}</tr></thead><tbody>${labels.map((a) => `<tr><th>${a}</th>${labels.map((b) => `<td class="${a === b && confusion[a][b] > 0 ? 'diag' : ''} ${a !== b && confusion[a][b] > 0 ? 'off' : ''}">${confusion[a][b]}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    const fmtAcc = (v) => `${(v * 100).toFixed(1)}%`;
    box.innerHTML = `
      <div class="checkup-grid">
        <article><span>小模型分类器</span><strong>${fmtAcc(r.classifier.accuracy)}</strong><small>宏F1 ${r.classifier.macroF1.toFixed(4)} · 平均 ${r.classifier.avgInferMs}ms · 训练于 ${r.modelTrainedAt || '—'}</small></article>
        <article><span>规则层（关键词）</span><strong>${fmtAcc(r.rules.accuracy)}</strong><small>宏F1 ${r.rules.macroF1.toFixed(4)} · 未触发率 ${fmtAcc(r.rules.unmatchedRate)}（落到 default）</small></article>
        <article><span>两者分歧率</span><strong>${fmtAcc(r.disagreementRate)}</strong><small>标准评测集 ${r.heldoutSize} 条（与训练切分同源）</small></article>
      </div>
      <details class="advanced"><summary>混淆矩阵（换分类器前后对比用）</summary><div class="matrix-wrap"><div><h4>小模型</h4>${matrix(r.classifier.confusion, r.labels)}</div><div><h4>规则层</h4>${matrix(r.rules.confusion, r.labels)}</div></div></details>`;
  } catch (e) { box.innerHTML = `<p class="empty" style="color:var(--danger)">${e.message}</p>`; }
};

// —— 切换影响预估：heldout 全量回放（判准率/成本/质量/误判方向）——
$('replaySwitch').onclick = async () => {
  const box = $('replayReport');
  box.innerHTML = '<p class="empty">回放中（454 条全量路由回放，约 3~5 秒）…</p>';
  try {
    const r = await api('/admin/api/classifier/replay', { method: 'POST' });
    const pct = (v) => `${(v * 100).toFixed(1)}%`;
    const signed = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(3)}`;
    const row = (name, d, hint) => `<article><span>${name}</span><strong>判准率 ${pct(d.taskAcc)}</strong><small>质量 ${d.avgQuality.toFixed(3)} · 成本指数 ${d.avgCost.toFixed(3)}</small><small class="muted">漏判难任务 ${d.misread.underCalled} 条 · 多判 ${d.misread.overCalled} 条 · 同档互错 ${d.misread.taskSwapped} 条${hint || ''}</small></article>`;
    const dist = (d) => Object.entries(d.modelDist).map(([m, n]) => `${m.replace('deepseekv4-flash', 'dsf').replace('qwen36-35b', 'qwen')}×${n}`).join(' ');
    const shifts = Object.entries(r.partial.modelShifts || {}).map(([k, n]) => `${k.replace('deepseekv4-flash', 'dsf').replace('qwen36-35b', 'qwen')} ${n} 条`).join('，') || '无变化';
    box.innerHTML = `
      <div class="checkup-grid" style="grid-template-columns:repeat(3,1fr)">
        ${row('① 规则层主导（现状 shadow）', r.rules, `<br>分布 ${dist(r.rules)}`)}
        ${row('② 分级采纳（现 active 语义）', r.partial, `<br>分布 ${dist(r.partial)}`)}
        ${row('③ 全量采纳小模型', r.full, `<br>分布 ${dist(r.full)}`)}
      </div>
      <p class="hint">判准率：预测任务标签与真值一致的比例。漏判难任务=把 coding/reasoning 判成更轻的类（质量风险）；多判=反向（成本浪费）。切换到 active（含采纳门槛）≈ ②，全量采纳 ≈ ③。<br>模型迁移（①→②）：${shifts}。质量/成本为按 gold 任务的真实 quality/costIndex 加权平均。</p>`;
  } catch (e) { box.innerHTML = `<p class="empty" style="color:var(--danger)">${e.message}</p>`; }
};
