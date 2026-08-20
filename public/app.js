let config, savedConfig, metrics, lastSimulation, simulateTimer;
const $ = (id) => document.getElementById(id);
// —— 后台枚举 → 中文展示映射（只影响展示，不碰配置值）——
const TASK_CN = { coding: '代码', reasoning: '推理', creative: '创意', extraction: '抽取', default: '通用' };
const TIER_CN = { simple: '轻量', balanced: '均衡', complex: '复杂' };
const METHOD_CN = { rules: '规则', semantic: '语义复核', 'rules+semantic': '规则+复核' };
const taskCN = (t) => TASK_CN[t] || t;
const tierCN = (t) => TIER_CN[t] || t;
const PRESETS = {
  balanced: { label: '质量、成本和速度保持均衡，适合默认生产流量。', qualityFloor: 0.82, costWeight: 0.22, latencyWeight: 0.15, selfHostedBonus: 0.2 },
  cost: { label: '在质量达标的前提下更积极选择低成本模型。', qualityFloor: 0.76, costWeight: 0.4, latencyWeight: 0.14, selfHostedBonus: 0.28 },
  quality: { label: '提高质量门槛，成本与速度只作为次要因素。', qualityFloor: 0.88, costWeight: 0.1, latencyWeight: 0.08, selfHostedBonus: 0.12 },
  speed: { label: '优先首字和完成速度，适合交互式场景。', qualityFloor: 0.78, costWeight: 0.12, latencyWeight: 0.42, selfHostedBonus: 0.18 },
  custom: { label: '当前参数不匹配标准预设，请结合影响模拟谨慎发布。' }
};
function headers(json = false) { const token = $('token').value.trim(); return { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(json ? { 'content-type': 'application/json' } : {}) }; }
async function api(path, options = {}) { const response = await fetch(path, { ...options, headers: { ...headers(Boolean(options.body)), ...(options.headers || {}) } }); const value = await response.json(); if (!response.ok) throw new Error(value.error?.message || `HTTP ${response.status}`); return value; }
function toast(message, bad = false) { const node = $('toast'); node.textContent = message; node.style.background = bad ? '#b42318' : '#101828'; node.classList.add('show'); setTimeout(() => node.classList.remove('show'), 3000); }
const percentValue = (value) => `${Math.round(Number(value) * 100)}%`;
// 敏感度滑条：显示「档位 · 具体数值」，档位仅是快速读法，数值才是真实配置
const sensitivity = (value) => Number(value) < .15 ? '低' : Number(value) < .3 ? '中' : Number(value) < .45 ? '高' : '很高';
const sensLabel = (value) => `${sensitivity(value)} · ${Number(value).toFixed(2)}`;
function updateRangeLabels() { $('trafficValue').textContent = `${$('activeTrafficPercent').value}%`; $('qualityFloorValue').textContent = `≥ ${percentValue($('qualityFloor').value)}`; $('costWeightValue').textContent = sensLabel($('costWeight').value); $('latencyWeightValue').textContent = sensLabel($('latencyWeight').value); $('selfBonusValue').textContent = `+${Number($('selfBonus').value).toFixed(2)}`; $('presetHelp').textContent = PRESETS[$('preset').value]?.label || ''; }
// 脏标记：表单与已发布版本不一致时提示「有未发布修改」，避免不知道改没改成
// diff 驱动而非交互驱动——拖回原值/改了又撤销会自动熄灭；键序无关深比较，server 端规范化重排键也不误报
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}
function syncDirty() { if (!config || !savedConfig) return; readForm(); const badge = $('dirtyBadge'); if (badge) badge.hidden = stableStringify(config) === stableStringify(savedConfig); }
// 基线规范化：savedConfig 必须与 readForm 之后的 config 同形状（readForm 会补 pricingYuan…/performance 等默认键），
// 否则 diff 永不相等。凡重建基线（connect/发布成功）处，先 render 表单再 readForm 再 snapshot。
function snapshotBaseline() { bindPolicy(); renderModels(); renderCapabilityMatrix(); renderDeployment(); readForm(); savedConfig = structuredClone(config); clearDirty(); }
function clearDirty() { const badge = $('dirtyBadge'); if (badge) badge.hidden = true; }
function bindPolicy() {
  const r = config.routing; $('mode').value = r.mode; $('activeTrafficPercent').value = r.activeTrafficPercent ?? 100; $('qualityFloor').value = r.qualityFloor; $('selfBonus').value = r.selfHostedBonus; $('qualityWeight').value = r.qualityWeight; $('costWeight').value = r.costWeight; $('latencyWeight').value = r.latencyWeight; $('uncertaintyPenalty').value = r.uncertaintyPenalty; $('complexQualityMargin').value = r.complexQualityMargin ?? .04; $('maxAttempts').value = r.maxAttempts; $('preferSelf').checked = r.preferSelfHosted;
  $('semanticEnabled').checked = Boolean(config.semanticRouter?.enabled); $('semanticMode').value = config.semanticRouter?.mode || 'shadow'; $('semanticThreshold').value = config.semanticRouter?.confidenceThreshold ?? .7; $('semanticMinConfidence').value = config.semanticRouter?.minConfidence ?? 0; $('reasoningEnabled').checked = Boolean(config.reasoningControl?.enabled); $('budgetEnabled').checked = Boolean(config.budget?.enabled); $('dailyBudget').value = config.budget?.dailyBudgetYuan || 0; $('budgetThreshold').value = config.budget?.degradeThreshold ?? .9;
  $('semanticProvider').value = config.semanticRouter?.provider || (config.semanticRouter?.model ? 'openai-chat' : 'disabled');
  const chatModel = config.semanticRouter?.openaiChat?.model || config.semanticRouter?.model;
  $('semanticModel').innerHTML = config.models.map((m) => `<option value="${m.id}" ${m.id === chatModel ? 'selected' : ''}>${m.displayName || m.id}</option>`).join('');
  $('semanticHttpUrl').value = config.semanticRouter?.httpJson?.url || '';
  $('decisionLogEnabled').checked = Boolean(config.decisionLog?.enabled);
  const matched = Object.entries(PRESETS).find(([key, p]) => key !== 'custom' && ['qualityFloor','costWeight','latencyWeight','selfHostedBonus'].every((f) => Math.abs(r[f] - p[f]) < .005)); $('preset').value = matched?.[0] || 'custom'; updateRangeLabels();
}
function renderModels() { $('models').innerHTML = config.models.map((m, i) => `<tr data-index="${i}"><td><input class="enabled" type="checkbox" ${m.enabled ? 'checked' : ''}></td><td><strong>${m.displayName || m.id}</strong><br><small>${m.id}</small></td><td><span class="tag ${m.ownership === 'self_hosted' ? 'self' : 'eco'}">${m.ownership === 'self_hosted' ? '自建' : '生态'}</span></td><td><input class="quality" type="number" min="0" max="1" step=".01" value="${m.quality.default}"></td><td><input class="cost" type="number" min="0" step=".01" value="${m.costIndex}"></td><td><input class="latency" type="number" min="0" step=".01" value="${m.latencyIndex}"></td><td><input class="input-price" type="number" min="0" step=".01" placeholder="待配置" value="${m.pricingYuanPerMillionTokens?.input ?? ''}"></td><td><input class="cached-price" type="number" min="0" step=".01" placeholder="无折扣" value="${m.pricingYuanPerMillionTokens?.inputCached ?? ''}"></td><td><input class="output-price" type="number" min="0" step=".01" placeholder="待配置" value="${m.pricingYuanPerMillionTokens?.output ?? ''}"></td><td><input class="p95" type="number" min="0" step="1" placeholder="待观测" value="${m.performance?.totalP95Ms ?? ''}"></td><td><span class="pill ${m.calibrationStatus === 'verified' ? 'good' : 'muted'}">${m.calibrationStatus === 'verified' ? '已验证' : m.calibrationStatus === 'pilot' ? 'Pilot' : '待校准'}</span></td><td class="health">—</td></tr>`).join(''); }
function computeCostIndexClient(models, cardPrice) { const costs = []; for (const m of models) { const d = m.deployment; if (!d || !d.machines || !d.tps) continue; const cardWeight = Number(cardPrice[d.deviceType] || 1); const hw = Number(d.machines) * (Number(d.cardsPerMachine) || 1) * cardWeight; costs.push({ id: m.id, unitCost: hw / Number(d.tps) }); } if (!costs.length) return null; const max = Math.max(...costs.map((c) => c.unitCost)); if (!(max > 0)) return null; return Object.fromEntries(costs.map((c) => [c.id, Number((c.unitCost / max).toFixed(3))])); }
function computeCostIndexFromPricingClient(models, pricingMix) { const mix = pricingMix || { input: 10, output: 1 }; const total = Number(mix.input) + Number(mix.output); if (!(total > 0)) return null; const is = Number(mix.input) / total, os = Number(mix.output) / total; const costs = []; for (const m of models) { const p = m.pricingYuanPerMillionTokens; if (p?.input == null || p?.output == null) continue; const w = is * Number(p.input) + os * Number(p.output); if (w > 0) costs.push({ id: m.id, unitCost: w }); } if (costs.length < 2) return null; const max = Math.max(...costs.map((c) => c.unitCost)); return Object.fromEntries(costs.map((c) => [c.id, Number((c.unitCost / max).toFixed(3))])); }
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
    return `<tr><th><div class="cap-model${dim}"><strong>${m.displayName || m.id}</strong><small>${m.id}</small></div></th>${cells}</tr>`;
  }).join('');
}
$('capRows').addEventListener('input', (e) => { if (!e.target.classList.contains('cap-input')) return; const idx = Number(e.target.dataset.index); const task = e.target.dataset.task; const v = e.target.value === '' ? null : Number(e.target.value); config.models[idx].quality[task] = v; syncDirty(); scheduleSimulation(); });
function renderDeployment() { const cm = config.costModel || {}; const source = cm.source || 'deployment'; $('costSource').value = source; $('pricingMixInput').value = cm.pricingMix?.input ?? 10; $('pricingMixOutput').value = cm.pricingMix?.output ?? 1; $('beansPerYuan').value = config.budget?.beansPerYuan ?? ''; const cardPrice = cm.cardPrice || {}; const computed = source === 'pricing' ? (computeCostIndexFromPricingClient(config.models, cm.pricingMix) || {}) : (computeCostIndexClient(config.models, cardPrice) || {}); $('deployment').innerHTML = config.models.map((m, i) => { const d = m.deployment || {}; return `<tr data-index="${i}"><td><strong>${m.displayName || m.id}</strong></td><td><select class="device-type"><option value="910B2" ${d.deviceType === '910B2' ? 'selected' : ''}>910B2</option><option value="910B4" ${d.deviceType === '910B4' ? 'selected' : ''}>910B4</option></select></td><td><input class="machines" type="number" min="1" step="1" value="${d.machines ?? ''}" placeholder="设备数"></td><td><input class="cards" type="number" min="1" step="1" value="${d.cardsPerMachine ?? ''}" placeholder="单机卡数"></td><td><input class="tps" type="number" min="1" value="${d.tps ?? ''}" placeholder="tokens/s"></td><td><span class="cost-preview pill ${computed[m.id] != null ? 'good' : 'muted'}">${computed[m.id] ?? '待录入'}</span></td></tr>`; }).join(''); }
function readForm() {
  const r = config.routing; r.mode = $('mode').value; r.activeTrafficPercent = Number($('activeTrafficPercent').value); r.qualityFloor = Number($('qualityFloor').value); r.selfHostedBonus = Number($('selfBonus').value); r.qualityWeight = Number($('qualityWeight').value); r.costWeight = Number($('costWeight').value); r.latencyWeight = Number($('latencyWeight').value); r.uncertaintyPenalty = Number($('uncertaintyPenalty').value); r.complexQualityMargin = Number($('complexQualityMargin').value); r.maxAttempts = Number($('maxAttempts').value); r.preferSelfHosted = $('preferSelf').checked;
  config.semanticRouter.enabled = $('semanticEnabled').checked; config.semanticRouter.mode = $('semanticMode').value; config.semanticRouter.confidenceThreshold = Number($('semanticThreshold').value); config.semanticRouter.minConfidence = Number($('semanticMinConfidence').value); config.reasoningControl.enabled = $('reasoningEnabled').checked; config.budget.enabled = $('budgetEnabled').checked; config.budget.dailyBudgetYuan = Number($('dailyBudget').value); config.budget.degradeThreshold = Number($('budgetThreshold').value);
  config.semanticRouter.provider = $('semanticProvider').value;
  if ($('semanticProvider').value === 'openai-chat') { config.semanticRouter.model = $('semanticModel').value; delete config.semanticRouter.httpJson; }
  else if ($('semanticProvider').value === 'http-json') { config.semanticRouter.httpJson = { ...(config.semanticRouter.httpJson || {}), url: $('semanticHttpUrl').value.trim() }; }
  else { delete config.semanticRouter.model; delete config.semanticRouter.httpJson; }
  config.decisionLog = { ...(config.decisionLog || {}), enabled: $('decisionLogEnabled').checked };
  document.querySelectorAll('#models tr').forEach((row) => { const m = config.models[Number(row.dataset.index)]; const nullableNumber=(selector)=>{const value=row.querySelector(selector).value;return value===''?null:Number(value)}; m.enabled = row.querySelector('.enabled').checked; m.quality.default = Number(row.querySelector('.quality').value); m.costIndex = Number(row.querySelector('.cost').value); m.latencyIndex = Number(row.querySelector('.latency').value); m.pricingYuanPerMillionTokens ||= {}; m.pricingYuanPerMillionTokens.input=nullableNumber('.input-price'); m.pricingYuanPerMillionTokens.inputCached=nullableNumber('.cached-price'); m.pricingYuanPerMillionTokens.output=nullableNumber('.output-price'); m.performance ||= {}; m.performance.totalP95Ms=nullableNumber('.p95'); }); document.querySelectorAll('#deployment tr').forEach((row) => { const m = config.models[Number(row.dataset.index)]; const deviceType = row.querySelector('.device-type').value; const machines = row.querySelector('.machines').value; const cards = row.querySelector('.cards').value; const tps = row.querySelector('.tps').value; if (machines && tps) m.deployment = { deviceType, machines: Number(machines), cardsPerMachine: Number(cards) || 1, tps: Number(tps) }; else delete m.deployment; }); config.costModel ||= {}; config.costModel.source = $('costSource').value; const mixIn = Number($('pricingMixInput').value), mixOut = Number($('pricingMixOutput').value); if (Number.isFinite(mixIn) && Number.isFinite(mixOut) && mixIn >= 0 && mixOut >= 0 && mixIn + mixOut > 0) config.costModel.pricingMix = { input: mixIn, output: mixOut }; const beanRate = Number($('beansPerYuan').value); if (Number.isFinite(beanRate) && beanRate > 0) { config.budget ||= {}; config.budget.beansPerYuan = beanRate; } const cardPrice = config.costModel.cardPrice || {}; const computedCost = config.costModel.source === 'pricing' ? computeCostIndexFromPricingClient(config.models, config.costModel.pricingMix) : computeCostIndexClient(config.models, cardPrice); if (computedCost) for (const m of config.models) if (computedCost[m.id] != null) m.costIndex = computedCost[m.id]; return config;
}
function metricDelta(current, proposed, lower = false) { const delta = proposed - current, good = lower ? delta <= 0 : delta >= 0; return `<strong>${proposed.toFixed(2)}</strong><small class="${good ? 'positive' : 'negative'}">${delta >= 0 ? '+' : ''}${delta.toFixed(2)}</small>`; }
function metricDeltaMs(current, proposed, lower = false) { const delta = Math.round(proposed - current), good = lower ? delta <= 0 : delta >= 0; return `<strong>${Math.round(proposed)}ms</strong><small class="${good ? 'positive' : 'negative'}">${delta >= 0 ? '+' : ''}${delta}ms</small>`; }
function metricDeltaCost(current, proposed, lower = false) { const delta = proposed - current, good = lower ? delta <= 0 : delta >= 0, fmt = (v) => (v < 0.01 ? v.toFixed(4) : v.toFixed(2)); return `<strong>¥${fmt(proposed)}</strong><small class="${good ? 'positive' : 'negative'}">${delta >= 0 ? '+' : ''}${fmt(delta)}</small>`; }
function renderSimulation(result) {
  lastSimulation = result; const c = result.current, p = result.proposed, risk = result.changedRate >= .5 ? 'high' : result.changedRate >= .2 ? 'medium' : 'low';
  $('impactSummary').innerHTML = `<article class="impact ${risk}"><span>模型切换</span><strong>${result.changed}/${result.sampleCount}</strong><small>${percentValue(result.changedRate)} 代表任务改变</small></article><article><span>预计质量</span>${metricDelta(c.averageQuality,p.averageQuality)}</article>${(c.averageCostYuan!=null&&p.averageCostYuan!=null)?`<article><span>平均单次成本 <span class="help" data-help="按代表性任务的平均输入输出量估算的每次请求成本（元）。0.003 元 = 一千次请求约 3 元。">?</span></span>${metricDeltaCost(c.averageCostYuan,p.averageCostYuan,true)}</article>`:`<article><span>成本指数</span>${metricDelta(c.averageCostIndex,p.averageCostIndex,true)}</article>`}${(c.averageLatencyMs!=null&&p.averageLatencyMs!=null)?`<article><span>平均端到端时延 <span class="help" data-help="从发出请求到收完完整回答的总耗时（含模型思考时间），按代表性任务平均。">?</span></span>${metricDeltaMs(c.averageLatencyMs,p.averageLatencyMs,true)}</article>`:`<article><span>时延指数</span>${metricDelta(c.averageLatencyIndex,p.averageLatencyIndex,true)}</article>`}<article><span>自建比例</span><strong>${percentValue(p.selfHostedRate)}</strong><small>当前 ${percentValue(c.selfHostedRate)}</small></article>`;
  $('impactRows').innerHTML = p.rows.map((row,i) => { const before=c.rows[i], changed=before.model!==row.model; return `<tr><td><strong>${row.label}</strong><br><small>${taskCN(row.task)}</small></td><td>${Math.round(row.complexity*100)} · ${tierCN(row.tier)}</td><td>${before.model}</td><td>${row.model}</td><td><span class="pill ${changed?'bad':'good'}">${changed?'切换':'不变'}</span></td></tr>`; }).join('');
  renderSensitivity(result.sensitivity);
}
// 敏感度分析：每个滑条「再拉多少才会变 / 拉到头也变不了的原因」
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
    const why = axis.dominated ? `<p class="sens-why">${axis.dominated}</p>` : '<p class="sens-why">全程扫描未发现模型切换。</p>';
    return `<article class="sens-card">${head}${why}</article>`;
  }).join('');
  box.innerHTML = `<p class="sens-title">敏感度分析 <span class="help" data-help="回答「滑条再拉多少才会改变路由」。若拉满全程都无变化，会给出原因（通常是某模型全面领先，怎么调权重都是它最优）。">?</span></p><div class="sens-grid">${cards}</div>`;
  box.hidden = false;
}
async function simulate() { if (!config) return; readForm(); const result = await api('/admin/api/simulate',{method:'POST',body:JSON.stringify({proposedConfig:config})}); renderSimulation(result); renderBaselines(); return result; }
function scheduleSimulation(){ clearTimeout(simulateTimer); simulateTimer=setTimeout(()=>simulate().catch(()=>{}),350); }
function percent(n,d){ return d ? `${(n/d*100).toFixed(1)}%` : '0.0%'; }
function renderMetrics(){ const c=metrics.counters; $('total').textContent=c.total; $('autoRate').textContent=percent(c.auto,c.total); const selfIds=new Set(config.models.filter(m=>m.ownership==='self_hosted').map(m=>m.id)); const self=Object.entries(c.selected).filter(([id])=>selfIds.has(id)).reduce((s,[,n])=>s+n,0); $('selfRate').textContent=percent(self,c.success); $('semanticRate').textContent=percent(c.semantic?.disagreed||0,c.semantic?.succeeded||0); $('budgetRate').textContent=metrics.budget?.enabled?percentValue(metrics.budget.pressure):'未启用'; $('fallback').textContent=c.fallback; $('errorRate').textContent=percent(c.errors,c.total); document.querySelectorAll('#models tr').forEach(row=>{const m=config.models[Number(row.dataset.index)],h=metrics.health[m.id],cell=row.querySelector('.health'); cell.innerHTML=!h?'<span class="pill muted">无数据</span>':h.circuitState==='half_open'?'<span class="pill muted">恢复探测</span>':h.circuitOpenUntil>Date.now()?'<span class="pill bad">熔断</span>':`<span class="pill good">${h.ewmaLatencyMs}ms · ${h.failures}错</span>`}); $('recent').innerHTML=metrics.recent.length?metrics.recent.map(x=>`<div class="recent-item"><time>${new Date(x.at).toLocaleTimeString()}</time><div><b>${x.selected}</b> <small>← ${x.requested} · ${taskCN(x.task)} · ${METHOD_CN[x.routeMethod]||x.routeMethod||'规则'} · 推理${x.reasoningLevel||'off'}${x.fallbackAttempt?` · fallback ${x.fallbackAttempt}`:''}</small></div><span class="pill ${x.ok?'good':'bad'}">${x.ok?`${x.latencyMs}ms`:'失败'}</span></div>`).join(''):'<p class="empty">暂无请求</p>'; }
async function connect(){ try{sessionStorage.setItem('routerAdminToken',$('token').value); [config,metrics]=await Promise.all([api('/admin/api/config'),api('/admin/api/metrics')]);snapshotBaseline(); $('status').textContent=`已连接 · v${config.version}`; $('status').className='pill good'; renderMetrics(); await simulate();}catch(error){$('status').textContent='连接失败';$('status').className='pill bad';toast(error.message,true)} }
$('token').value=sessionStorage.getItem('routerAdminToken')||''; $('connect').onclick=connect; $('refresh').onclick=async()=>{try{metrics=await api('/admin/api/metrics');renderMetrics()}catch(e){toast(e.message,true)}}; $('reload').onclick=()=>{if(!savedConfig)return;config=structuredClone(savedConfig);snapshotBaseline();renderMetrics();simulate();toast('已恢复到当前线上版本')}; $('simulate').onclick=()=>simulate().catch(e=>toast(e.message,true));
$('preset').onchange=()=>{const p=PRESETS[$('preset').value];if($('preset').value!=='custom'){const fields={qualityFloor:'qualityFloor',costWeight:'costWeight',latencyWeight:'latencyWeight',selfHostedBonus:'selfBonus'};for(const [field,id] of Object.entries(fields))$(id).value=p[field]}updateRangeLabels();syncDirty();scheduleSimulation()};
// 新增模型（运营流程第 1 步）：以 qwen36-35b 为模板的保守默认值 + enabled:false，录入后立即出现在表格中可继续编辑，发布走既有安全链路
$('addModel').onclick=()=>{ if(!config) return toast('请先连接',true); const id=prompt('新模型 ID（MaaS 上的模型名，与现有模型同 URL，如 qwen38-27b）'); if(id===null) return; const trimmed=id.trim(); if(!trimmed) return toast('模型 ID 不能为空',true); if(config.models.some(m=>m.id===trimmed)) return toast(`模型 ${trimmed} 已存在`,true); config.models.push({ id:trimmed, displayName:trimmed, ownership:'self_hosted', enabled:false, calibrationStatus:'unverified', quality:{ default:0.80, simple:0.85, coding:0.75, reasoning:0.78, creative:0.82, extraction:0.85 }, costIndex:0.5, latencyIndex:0.5, pricingYuanPerMillionTokens:{ input:null, inputCached:null, output:null }, performance:{ totalP95Ms:null, ttftP50Ms:null, tokensPerSecond:null }, capabilities:{ chat:true, stream:true }, contextWindow:131072, reasoningControl:{ parameter:'reasoning_effort', verified:false } }); renderModels(); renderDeployment(); bindPolicy(); syncDirty(); scheduleSimulation(); toast(`已添加 ${trimmed}（未启用）——填定价/质量分后发布，再跑 eval gate 实测校准`); };
for(const id of ['mode','activeTrafficPercent','qualityFloor','costWeight','latencyWeight','selfBonus','preferSelf','qualityWeight','complexQualityMargin','uncertaintyPenalty','maxAttempts','semanticEnabled','semanticMode','semanticProvider','semanticModel','semanticHttpUrl','semanticThreshold','semanticMinConfidence','decisionLogEnabled','reasoningEnabled','budgetEnabled','dailyBudget','budgetThreshold']) $(id).addEventListener('input',()=>{if(!['mode','activeTrafficPercent','preferSelf','semanticEnabled','semanticMode','semanticProvider','semanticModel','semanticHttpUrl','semanticThreshold','decisionLogEnabled','reasoningEnabled','budgetEnabled','dailyBudget','budgetThreshold'].includes(id))$('preset').value='custom';updateRangeLabels();syncDirty();scheduleSimulation()}); $('models').addEventListener('input',()=>{syncDirty();scheduleSimulation()}); const refreshCostPreview = () => { const cm = config.costModel || {}; const computed = (cm.source === 'pricing' ? computeCostIndexFromPricingClient(config.models, cm.pricingMix) : computeCostIndexClient(config.models, cm.cardPrice || {})) || {}; document.querySelectorAll('#deployment tr').forEach(row => { const m = config.models[Number(row.dataset.index)]; const cell = row.querySelector('.cost-preview'); if (computed[m.id] != null) { cell.textContent = computed[m.id]; cell.className = 'cost-preview pill good'; } else { cell.textContent = '待录入'; cell.className = 'cost-preview pill muted'; } }); document.querySelectorAll('#models tr').forEach(row => { const m = config.models[Number(row.dataset.index)]; if (computed[m.id] != null) row.querySelector('.cost').value = computed[m.id]; }); };
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
