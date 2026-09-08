const el = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
export const evidenceLabels = { ready: '可用', no_data: '无同条件计时', insufficient: '样本不足', stale: '计时过期', unreliable: '成功率不足' };
const rejectionLabels = { disabled: '未启用', ownership_unconfirmed: '归属未确认', not_entitled: '调用方无权限', circuit_open: '熔断中', context_too_long: '上下文超限', completion_budget_too_low: '输出预算不足', cost_tier_excluded: '不在成本档位' };
const number = n => Number.isFinite(n) ? n.toFixed(3) : '—';

export function renderRouteExplanation(d) {
  const root = document.getElementById('routeExplanation'); if (!root) return;
  root.replaceChildren(el('h3', `本次预演选择：${d.selectedModel || '—'}`), el('p', '基于当前生效配置的预演，不调用回答模型；不代表实际业务请求已执行。本页未携带历史会话，实际请求还可能受会话粘性和运行时回退影响。', 'hint'));
  const rejected = el('details'); rejected.append(el('summary', `资格过滤：${d.rejected?.length || 0} 个模型未进入评分`));
  for (const r of d.rejected || []) rejected.append(el('p', `${r.model}：${Array.isArray(r.reasons) ? r.reasons.map(reason => rejectionLabels[reason] || reason).join('；') : r.reason || '未满足能力或健康条件'}`));
  root.append(rejected);
  for (const c of d.candidates || []) {
    const card = el('article', null, 'operation-card'), e = c.latencyEvidence, load = c.load || {};
    card.append(el('h4', `${c.model}${c.model === d.selectedModel ? ' · 预演选择' : ''}`));
    card.append(el('p', `质量 ${number(c.quality)} / 门槛 ${number(c.effectiveQualityFloor)} · ${c.qualityEligible ? '通过质量门槛' : '未通过质量门槛'} · 相对质量差 ${number(c.qualityLoss)}`));
    card.append(el('p', `成本指数 ${number(c.costIndex)} · 当前得分 ${number(c.score)} · 负载扣分 ${number(load.penalty)}${load.saturated ? ' · 额度已满' : ''}`));
    card.append(el('p', e ? `时延证据：${evidenceLabels[e.status] || e.status} · ${e.metric} · 有效样本 ${e.validCount} · 权重置信系数 ${number(e.confidence)} · 影子调整 ${number(e.adjustment)}（未计入当前得分）` : '时延证据：本次未评估'));
    if (e?.metricLastAt) card.append(el('p', `计时更新：${new Date(e.metricLastAt).toLocaleString('zh-CN')} · 成功 ${e.success} / 失败 ${e.failed} / 取消 ${e.cancelled}`, 'hint'));
    root.append(card);
  }
  const s = d.latencyShadow;
  if (s) root.append(el('p', `时延影子：${s.baselineModel} → ${s.proposedModel}；${s.reason === 'insufficient_comparable_evidence' ? '可比较证据不足' : s.reason === 'bounded_latency_advantage' ? '达到影子切换条件' : '未达到切换差值'}。这是会话约束前的候选比较，不改变真实选模。`, 'latency-notice'));
  if (d.preference) root.append(el('p', `任务偏好：${d.preference.note || d.preference.model}`));
  root.append(el('p', `合格回退顺序：${(d.fallbackOrder || []).join(' → ')}${d.qualityDegraded ? '；本次使用显式允许的质量降级' : ''}`));
}

export function setupModelDetails({ api }) {
  const tbody = document.getElementById('models'); if (!tbody) return;
  const table = tbody.closest('table'); table.classList.add('models-compact');
  document.addEventListener('change', event => {
    if (event.target.id === 'modelColumnView') table.classList.toggle('models-compact', event.target.value === 'common');
  });
  const dialog = el('dialog', null, 'model-detail-dialog'); dialog.setAttribute('aria-label', '模型详情与草稿参数'); document.body.append(dialog);
  let generation = 0, refreshing = false;
  const refreshObservations = async () => {
    if (refreshing || document.hidden || !tbody.getClientRects().length || tbody.closest('[hidden]')) return;
    refreshing = true;
    try {
      const data = await api('/admin/api/latency?metric=ttftMs');
      for (const row of tbody.rows) {
        const id = row.cells[1].querySelector('small').textContent, target = row.querySelector('.model-observed');
        const stats = data.rows?.find(r => r.model === id)?.recent30;
        if (target) target.textContent = stats ? `近30分钟业务首正文 P50 ${stats.p50Ms == null ? '无有效计时' : Math.round(stats.p50Ms) + ' ms'} · 有效 ${stats.validCount}` : '暂无对应观测';
      }
    } catch { for (const target of tbody.querySelectorAll('.model-observed')) target.textContent = '近期观测加载失败，稍后重试'; }
    finally { refreshing = false; }
  };
  document.addEventListener('workspace:navigate', refreshObservations);
  document.addEventListener('visibilitychange', refreshObservations);
  new MutationObserver(refreshObservations).observe(tbody, { childList: true });
  setInterval(refreshObservations, 30000);

  dialog.addEventListener('close', () => { generation++; });
  tbody.addEventListener('click', async event => {
    const button = event.target.closest('[data-model-details]'); if (!button) return;
    const row = button.closest('tr'), token = ++generation;
    const close = el('button', '关闭详情', 'secondary'); close.type = 'button'; close.onclick = () => dialog.close();
    dialog.replaceChildren(close, el('h2', row.cells[1].querySelector('strong').textContent), el('p', '参数修改进入当前草稿，检查并发布后才会生效。质量参数包含历史评测与人工先验；可靠性标签不代表本次重新评测。', 'hint'));
    const observation = el('p', '正在加载近 30 分钟真实业务观测…', 'latency-notice'); dialog.append(observation);
    const grid = el('div', null, 'model-detail-grid');
    for (let i = 2; i <= 11; i++) {
      const field = el('label', table.tHead.rows[0].cells[i].textContent.replace(/\?/g, '').trim());
      const original = row.cells[i].querySelector('input,select');
      if (original) {
        const input = original.cloneNode(true); input.value = original.value; input.checked = original.checked;
        input.addEventListener('input', () => { original.value = input.value; original.checked = input.checked; original.dispatchEvent(new Event('input', { bubbles: true })); });
        input.addEventListener('change', () => original.dispatchEvent(new Event('change', { bubbles: true })));
        field.append(input);
      } else field.append(el('span', row.cells[i].textContent));
      grid.append(field);
    }
    dialog.append(grid); dialog.showModal(); close.focus();
    try {
      const data = await api('/admin/api/latency?metric=ttftMs'); if (token !== generation || !dialog.open) return;
      const id = row.cells[1].querySelector('small').textContent;
      const stats = data.rows?.find(r => r.model === id)?.recent30;
      observation.textContent = stats ? `最近 30 分钟业务首正文 P50：${stats.p50Ms == null ? '无有效计时' : Math.round(stats.p50Ms) + ' ms'} · 有效 ${stats.validCount} · 失败 ${stats.failed} · 取消 ${stats.cancelled}。汇总可能跨请求条件，不能直接用作选模依据。` : '暂无对应模型观测。';
    } catch { if (token === generation) observation.textContent = '观测加载失败，可关闭详情后重试。'; }
  });
}
