// Read-only observations and budget-limited probes. No routing configuration writes.
const FILTERS = [
  ['metric', '计时指标', [['ttftMs','首个正文'],['firstOutputMs','首个输出'],['completionMs','完整交付'],['attemptMs','上游尝试']]],
  ['source', '样本来源', [['business','真实业务'],['probe','定时 / 手动补测']]],
  ['stream', '请求方式', [['all','全部方式'],['true','流式'],['false','非流式']]],
  ['reasoning', '思考模式', [['all','全部模式'],['off','关闭'],['on','开启'],['unknown','未知']]],
  ['inputBand', '输入长度', [['all','全部长度'],['short','短输入'],['medium','中输入'],['long','长输入']]],
  ['outputBand', '输出预算上限', [['all','全部预算'],['short','短预算（≤256）'],['medium','中预算（257–2048）'],['long','长预算（>2048）']]],
  ['dayType', '日期类型', [['all','全部日期'],['weekday','周一至周五'],['weekend','周六、周日']]]
];
const METRIC_NOTES = {
  ttftMs: '首个正文：开始请求至首段正文到达。非流式请求不提供首字样本。',
  firstOutputMs: '首个输出：开始请求至正文、思考或工具调用首次输出；不等同于用户看到正文。',
  completionMs: '完整交付：请求开始至结束，包含路由及回退的总耗时；受输出长度影响，请结合同类请求比较。',
  attemptMs: '上游尝试：单次成功上游调用的耗时；不包含路由及多次回退的完整耗时。'
};
const node = (tag, className, text) => { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; };
const ms = value => typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value).toLocaleString('zh-CN')} ms` : '—';
const num = value => Number.isFinite(value) ? value : 0;
const stamp = value => {
  if (!value) return '暂无'; const date = new Date(value); if (!Number.isFinite(date.getTime())) return '暂无';
  return date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
};
function describe(stats) {
  if (!stats || !stats.count) return '无数据';
  return `请求 ${num(stats.count)} · 成功 ${num(stats.success)} · 失败 ${num(stats.failed)} · 取消 ${num(stats.cancelled)} · 有效计时 ${num(stats.validCount)} · P50 ${ms(stats.p50Ms)} · P95 ${stats.p95Reliable ? ms(stats.p95Ms) : '样本不足'} · 最近 ${stamp(stats.lastAt)}（Asia/Shanghai）`;
}
function heat(value) {
  if (!Number.isFinite(value)) return 'none';
  return value < 500 ? 'fast' : value < 2000 ? 'normal' : value < 5000 ? 'warm' : value < 10000 ? 'slow' : 'very-slow';
}

export function setupLatencyPanel({ api, notify = () => {} }) {
  const root = document.getElementById('latencyPanel');
  if (!root || root.dataset.latencyReady) return;
  root.dataset.latencyReady = 'true'; root.classList.add('latency-panel');
  const head = node('div', 'panel-head'), heading = node('div');
  heading.append(node('h2', '', '模型时延观测'), node('p', 'hint', '真实业务与补测独立统计，先核对样本，再判断快慢。'));
  const actions = node('div', 'actions');
  const refresh = node('button', 'secondary', '刷新数据'), probeButton = node('button', 'secondary', '运行一次补测');
  refresh.type = probeButton.type = 'button'; actions.append(refresh, probeButton); head.append(heading, actions);
  const notice = node('p', 'latency-notice', '时延观测不代表质量评测；当前质量未重新评测。影子评分启用后只记录候选变化，不改变实际选模。');
  const filters = node('div', 'latency-filters'); const controls = {};
  for (const [key, title, options] of FILTERS) {
    const label = node('label', '', title), select = node('select'); select.name = key;
    for (const [value, text] of options) select.add(new Option(text, value));
    controls[key] = select; label.append(select); filters.append(label);
  }
  const metricNote = node('p', 'latency-note');
  const status = node('p', 'latency-status', '进入效果洞察后加载。'); status.setAttribute('role','status');
  const windowBar = node('div', 'latency-window'), windowTitle = node('h3', '', '近期表现');
  const windowLabel = node('label', '', '观察窗口'), windowSelect = node('select');
  windowSelect.add(new Option('最近 5 分钟', 'recent5')); windowSelect.add(new Option('最近 30 分钟', 'recent30')); windowSelect.value = 'recent30';
  windowLabel.append(windowSelect); windowBar.append(windowTitle, windowLabel);
  const cards = node('div', 'latency-cards');
  const heatTitle = node('h3', '', '按小时观察 · P50'), heatNote = node('p', 'latency-note');
  const legend = node('div', 'latency-legend');
  for (const [level, title] of [['fast','< 500 ms'],['normal','500–2,000'],['warm','2,000–5,000'],['slow','5,000–10,000'],['very-slow','≥ 10,000 ms'],['none','无有效计时']]) {
    const item = node('span', '', title), swatch = node('i', `latency-heat-${level}`); swatch.setAttribute('aria-hidden', 'true'); item.prepend(swatch); legend.append(item);
  }
  const scroll = node('div','table-wrap latency-table-wrap'); scroll.tabIndex = 0; scroll.setAttribute('aria-label', '小时热力图，可横向滚动查看 24 小时');
  const table = node('table','latency-table'); scroll.append(table);
  const detail = node('p','latency-detail','悬停或聚焦小时单元格，查看样本、失败和分位数。'); detail.setAttribute('role', 'status');
  const operations = node('p','latency-operations');
  const coverage = node('section', 'latency-coverage');
  root.replaceChildren(head, notice, coverage, filters, metricNote, status, windowBar, cards, heatTitle, heatNote, legend, scroll, detail, operations);
  let data = null, busy = false, pending = false, probeBusy = false, requestVersion = 0, lastAttempt = 0, failures = 0, disposed = false;
  const visible = () => !document.hidden && root.getClientRects().length > 0 && !root.closest('[hidden]');
  const query = () => new URLSearchParams(Object.entries(controls).map(([key, control]) => [key, control.value])).toString();
  function render() {
    metricNote.textContent = `${METRIC_NOTES[controls.metric.value]} 分位数只统计成功样本，使用直方图桶上界近似；P95 需至少 40 个有效样本。失败与取消另列。输入按 token 数分组（短 ≤1024、中 ≤8192、长 >8192）；输出按预算上限分组，并非实际输出长度。全部长度 / 模式可能混合不同工作负载。`;
    cards.replaceChildren(); table.replaceChildren();
    if (!data) { coverage.replaceChildren(node('p', 'latency-note', '等待获取证据状态。')); return; }
    notice.textContent = `${data.mode === 'off' ? '影子评分未启用。' : '影子评分只记录候选变化，不改变实际选模。'}当前质量未重新评测，时延改善不代表质量提升。`;
    const rows = Array.isArray(data.rows) ? data.rows : [];
    const evidence = data.evidenceCoverage || {}, n = num(evidence.requests);
    const rate = count => n ? `${(num(count) / n * 100).toFixed(1)}%` : '暂无评估';
    const policy = data.policy || {}, lastBusiness = Date.parse(data.latestBusinessAt), observedAt = Date.parse(data.at);
    const freshness = !Number.isFinite(lastBusiness) ? '暂无真实业务记录' : observedAt - lastBusiness > 30 * 60000 ? '最近30分钟没有新业务记录' : '最近30分钟有业务记录';
    const sync = policy.synchronized === true ? '已同步' : policy.synchronized === false ? '尚未同步' : '同步状态待核对';
    coverage.replaceChildren(node('h3', '', '当前证据状态'),
      node('p', '', `配置版本 ${policy.version || '未知'} · ${sync} · ${freshness}`),
      node('p', 'latency-note', `最近真实业务记录：${stamp(data.latestBusinessAt)}。独立于下方筛选，包含失败记录，不代表已有足够的成功计时。`),
      node('p', '', `最近 30 分钟已评估 Auto 请求 ${n} · 至少一个合格候选有可用证据 ${rate(evidence.anyReady)} · 全部合格候选有可用证据 ${rate(evidence.allReady)}`),
      node('p', 'latency-note', `按请求当时的同条件证据统计，独立于下方热力图筛选；不表示已切换模型或取得收益。本进程统计起点 ${stamp(evidence.startedAt)}，重启后重新积累，窗口按分钟近似。`));
    const labels = { ready: '可用', no_data: '无同条件计时', insufficient: '样本不足', stale: '计时过期', unreliable: '成功率不足' };
    const reasons = {};
    for (const counts of Object.values(evidence.models || {})) for (const [key, value] of Object.entries(counts)) if (key !== 'ready') reasons[key] = (reasons[key] || 0) + num(value);
    const leading = Object.entries(reasons).sort((a,b) => b[1]-a[1]);
    coverage.append(node('p', '', !n ? '尚无候选证据评估，请等待 Auto 请求。' : leading.length ? `主要缺口：${leading.map(([k,v]) => `${labels[k] || k} ${v} 次`).join('；')}（候选评估次数，非请求数）。` : '当前已记录的候选评估未发现证据缺口；不代表质量或收益已经验证。'));
    const evidenceDetails = node('details'); evidenceDetails.append(node('summary', '', '查看各模型证据与配置指纹'));
    evidenceDetails.append(node('p','latency-note',`配置指纹：${policy.revision || '未知'}`));
    for (const [model, counts] of Object.entries(evidence.models || {})) evidenceDetails.append(node('p', '', `${model}：${Object.entries(counts).map(([key, value]) => `${labels[key] || key} ${value}`).join(' · ')}（候选评估次数）`));
    coverage.append(evidenceDetails);
    heatNote.textContent = `最近 ${num(data.retentionDays) || 14} 天按所选日期类型汇总至 0–23 时；不是今天的逐小时实况。时间均为 Asia/Shanghai。工作日按星期划分，不含节假日调休。`;
    for (const row of rows) {
      const card = node('article','latency-model-card'), s = row[windowSelect.value];
      card.append(node('h4','',row.name || row.model), node('p','latency-model-id',row.model));
      const primary = node('div','latency-primary'); primary.append(node('span','','P50'), node('strong','',ms(s?.p50Ms))); card.append(primary);
      card.append(node('p','',`P95 ${s?.p95Reliable ? ms(s.p95Ms) : '样本不足'} · 有效计时 ${num(s?.validCount)}`));
      card.append(node('p','',`请求 ${num(s?.count)} · 成功 ${num(s?.success)} · 失败 ${num(s?.failed)} · 取消 ${num(s?.cancelled)}`));
      card.append(node('p','latency-note',`最近样本：${stamp(s?.lastAt)}`));
      const today = node('details','latency-today'); today.append(node('summary','','查看今日统计'),node('p','',describe(row.today))); card.append(today); cards.append(card);
    }
    if (!rows.length) cards.append(node('p','latency-empty','暂无匹配样本。调整筛选或等待业务请求；补测样本请切换至“定时 / 手动补测”。'));
    const caption = node('caption','',`${controls.source.selectedOptions[0].textContent} · ${controls.metric.selectedOptions[0].textContent} · P50（毫秒）`); table.append(caption);
    const thead = node('thead'), tr = node('tr'), modelTh = node('th','','模型'); modelTh.scope = 'col'; tr.append(modelTh);
    for (let hour = 0; hour < 24; hour++) { const th = node('th','',String(hour).padStart(2,'0')); th.scope = 'col'; tr.append(th); }
    thead.append(tr); table.append(thead); const tbody = node('tbody');
    for (const row of rows) {
      const tr = node('tr'), name = node('th','',row.name || row.model); name.scope = 'row'; tr.append(name);
      const hours = new Map((row.hours || []).map(s => [Number(s.hour), s]));
      for (let hour = 0; hour < 24; hour++) {
        const s = hours.get(hour), td = node('td',`latency-heat-${heat(s?.p50Ms)}`,ms(s?.p50Ms).replace(' ms',''));
        const text = `${row.name || row.model} · ${String(hour).padStart(2,'0')}:00–${String(hour).padStart(2,'0')}:59 · ${describe(s)}`;
        td.tabIndex = 0; td.title = text; td.setAttribute('aria-label',text); td.onmouseenter = td.onfocus = () => { detail.textContent = text; };
        tr.append(td);
      }
      tbody.append(tr);
    }
    table.append(tbody);
    const p = data.probe || {}, shadow = data.shadow || {}, storage = data.storage || {};
    const hasCost = Object.hasOwn(p, 'actualCostYuan') || Object.hasOwn(p, 'estimatedCostYuan');
    const probeCost = hasCost ? `今日补测费用：实记¥${num(p.actualCostYuan).toFixed(6)} + 估算¥${num(p.estimatedCostYuan).toFixed(6)}（已计入总成本，不属于业务回答成本）。` : '今日补测费用：数据未返回。';
    const decisions = { pacing: '等待全天预算间隔', fresh_business: '近期同上游凭据业务输出充足，跳过补测', model_interval: '等待模型间隔', needs_probe: '缺少近期业务输出，等待补测', no_model: '暂无到期模型', scheduled: '定时补测', manual: '手动补测', cooldown: '等待一分钟冷却', budget: '今日额度已用完', busy: '已有任务运行', disabled: '定时关闭', storage: '存储异常' };
    operations.textContent = `补测：${p.running ? '运行中' : p.enabled ? '定时已启用' : '定时未启用'} · 今日预留次数 ${num(p.callsToday)} / ${num(p.maxCallsPerDay)}（跳过和失败不退次数） · 上次 ${stamp(p.lastRunAt)} · 最早允许 ${stamp(p.nextRunAt)}；每 5 分钟检查，实际执行还取决于数据新鲜度、容量和预算。${p.lastDecision ? `最近调度：${stamp(p.lastDecision.at)} ${decisions[p.lastDecision.reason] || p.lastDecision.reason}${p.lastDecision.model ? ' · ' + p.lastDecision.model : ''}${p.lastDecision.outcome ? ' · ' + p.lastDecision.outcome : ''}。` : ''}${(p.models || []).map(m => `${m.model}：${decisions[m.reason] || m.reason}`).join('；')}。${probeCost}影子评分累计 ${num(shadow.count)} 次，候选变化 ${num(shadow.changed)} 次；最近 ${stamp(shadow.lastAt)}。${p.lastError ? ` 补测异常：${p.lastError}。` : ''}${storage.evictedBuckets ? ` 存储容量淘汰 ${storage.evictedBuckets} 个桶，已提前截断，历史统计可能不完整。` : ''}${storage.persistErrors ? ` 持久化异常 ${storage.persistErrors} 次，重启后可能丢失近期数据。` : ''}${storage.restoreErrors ? ` 历史数据恢复失败 ${storage.restoreErrors} 次，统计可能缺失。` : ''}`;
    probeButton.disabled = probeBusy || Boolean(p.running) || num(p.callsToday) >= num(p.maxCallsPerDay);
  }
  async function load(manual = false) {
    if (disposed || !visible()) return;
    if (busy) { pending ||= manual; return; }
    // Keep keyboard inspection stable; manual refresh remains available.
    if (!manual && (table.contains(document.activeElement) || cards.contains(document.activeElement))) return;
    const backoff = Math.min(300000, 30000 * 2 ** Math.min(failures,4));
    if (!manual && Date.now() - lastAttempt < backoff) return;
    busy = true; lastAttempt = Date.now(); const version = requestVersion;
    refresh.disabled = true; root.setAttribute('aria-busy','true'); status.textContent = '正在获取时延数据…';
    try {
      const result = await api(`/admin/api/latency?${query()}`);
      if (disposed || version !== requestVersion) return;
      data = result; failures = 0; render(); status.textContent = `更新于 ${stamp(data.at)}（Asia/Shanghai）· 页面可见时每 30 秒刷新`;
    } catch (error) {
      if (disposed || version !== requestVersion) return;
      failures++; status.textContent = `加载失败：${error.message}。${data ? '当前保留上次数据，请留意更新时间。' : ''}自动刷新已退避，可手动重试。`;
      if (manual) notify(error.message, true);
    } finally {
      busy = false; refresh.disabled = false; root.removeAttribute('aria-busy');
      if (pending && !disposed) { pending = false; void load(true); }
    }
  }
  filters.onchange = () => { requestVersion++; data = null; render(); void load(true); };
  windowSelect.onchange = render; refresh.onclick = () => { void load(true); };
  probeButton.onclick = async () => {
    if (probeBusy) return; probeBusy = true; probeButton.disabled = true; probeButton.setAttribute('aria-busy','true');
    try { const result = await api('/admin/api/latency/probe', { method: 'POST', body: '{}' }); notify(result.accepted ? '补测已受理，调用受每日预算限制，请稍后刷新查看结果。' : `当前未受理补测：${result.reason || '请查看补测状态'}。`, !result.accepted); await load(true); }
    catch (error) { notify(error.message,true); }
    finally { probeBusy = false; probeButton.removeAttribute('aria-busy'); render(); }
  };
  const wake = () => { if (visible()) void load(); };
  document.addEventListener('workspace:navigate',wake); document.addEventListener('visibilitychange',wake);
  const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(wake) : null; observer?.observe(root);
  const timer = setInterval(wake,30000); render(); probeButton.disabled = true; wake();
  return () => { disposed = true; clearInterval(timer); observer?.disconnect(); document.removeEventListener('workspace:navigate',wake); document.removeEventListener('visibilitychange',wake); };
}
