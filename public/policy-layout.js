const el = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
const $ = id => document.getElementById(id);

// Reparent existing controls so draft bindings and publication review keep one source of truth.
export function setupPolicyLayout() {
  const review = setupReviewLayout();
  const panel = $('unlockEdit').closest('.panel'); panel.id = 'policyConfiguration'; panel.classList.add('policy-configuration');
  const header = panel.querySelector('.panel-head'), heading = header.querySelector('h2');
  const subtitle = header.querySelector('.hint');
  $('unlockEdit').textContent = '编辑策略'; $('relockEdit').textContent = '结束编辑';
  $('unlockEdit').disabled = true;
  $('policyLockNote').remove();
  const sections = [...panel.children].filter(n => n.classList.contains('policy-section'));
  const advanced = panel.querySelector(':scope > .advanced');
  const editor = el('div', null, 'policy-editor'); editor.id = 'policyEditor'; editor.hidden = true;
  const summary = el('div', null, 'policy-summary'); summary.id = 'policySummary';
  summary.append(el('p', '正在加载当前配置…', 'hint')); panel.append(summary, editor);
  for (const section of sections) editor.append(section);
  editor.append(advanced); advanced.classList.add('policy-advanced');
  const simple = panel.querySelector('.view-switch-panel'); if (simple) editor.prepend(simple);
  const impact = document.querySelector('.impact-panel');
  impact.querySelector('.panel-head .hint').textContent = '调整后自动更新。基于代表任务与当前质量参数模拟，不调用模型，不代表真实业务效果。';
  const impactDetails = el('details', null, 'impact-details'); impactDetails.id = 'impactDetails';
  impactDetails.append(el('summary', '查看任务变化、单模型对照与敏感度'));
  for (const node of [$('noAutoCompare'), $('sensitivityBox'), impact.querySelector(':scope > .table-wrap')]) impactDetails.append(node);
  $('impactSummary').after(impactDetails);

  const runtime = sections[0], controls = new Map();
  for (const field of runtime.querySelectorAll('.business-policy > label')) for (const input of field.querySelectorAll('input[id],select[id]')) controls.set(input.id, field);
  runtime.className = 'policy-runtime'; runtime.replaceChildren();
  function group(title, description, ids) {
    const card = el('section', null, 'policy-group');
    card.append(el('h3', title), el('p', description, 'policy-group-note'));
    const fields = el('div', null, 'policy-fields');
    for (const id of ids) fields.append(controls.get(id));
    card.append(fields); return card;
  }
  runtime.append(
    group('运行与流量', '设置路由何时生效，以及覆盖多少请求。', ['mode', 'activeTrafficPercent', 'reasoningEnabled']),
    group('自建模型偏好', '在满足质量要求的候选中，调整自建倾向。', ['preferSelf', 'selfBonus']),
    group('日志与留存', '按需保留决策与正文，用于排查和评测。', ['decisionLogEnabled', 'logFullRequest', 'logAnswerText']),
    group('客户端接入', '管理调用方使用的模型入口与发现列表。', ['autoModelId', 'exposeModelList'])
  );
  sections[1].classList.add('policy-presets'); sections[1].querySelector('.policy-section-title').textContent = '路由目标';
  const presets = el('div', null, 'policy-preset-groups');
  for (const [id, title, description] of [['tierPicker', '价格档位', '先确定候选模型的价格范围。'], ['stylePicker', '取舍偏好', '再确定质量、成本与速度的侧重。']]) {
    const card = el('fieldset', null, 'policy-preset-group'); card.append(el('legend', title), el('p', description, 'policy-group-note'), $(id)); presets.append(card);
  }
  const title = sections[1].querySelector('.policy-section-title');
  const help = $('presetHelp'); sections[1].replaceChildren(title, presets, help);
  const descriptions = {
    budget: '低成本任务优先', balanced: '兼顾质量与预算', quality: '减少低端模型候选', max: '面向高预算任务', custom: '保留当前手动参数',
    'quality-first': '更看重回答质量', 'user-cost-first': '更看重调用方费用', 'provider-cost-first': '更看重平台资源消耗', 'efficiency-first': '更看重响应速度', 'balanced-style': '均衡各项权重'
  };
  for (const label of presets.querySelectorAll('.tier')) label.querySelector('small').textContent = descriptions[label.dataset.tier || label.dataset.style];
  sections[2].classList.add('policy-tuning'); sections[2].querySelector('.policy-section-title').textContent = '质量与敏感度';
  sections[3].classList.add('policy-budget'); sections[3].querySelector('.policy-section-title').textContent = '预算保护';
  advanced.querySelector('summary').textContent = '高级评分与回退参数';

  function readout(title, rows, note) {
    const card = el('section', null, 'policy-readout'); card.append(el('h3', title));
    const list = el('dl');
    for (const [label, value, status] of rows) {
      const row = el('div'); row.append(el('dt', label));
      const dd = el('dd'); dd.append(el('span', value, status == null ? '' : `policy-state ${status ? 'on' : 'off'}`)); row.append(dd); list.append(row);
    }
    card.append(list); if (note) card.append(el('p', note, 'policy-group-note')); return card;
  }
  const enabled = id => $(id).checked;
  const status = (label, id) => [label, enabled(id) ? '已开启' : '未开启', enabled(id)];
  const value = id => $(id).value;
  const selected = id => $(id).selectedOptions[0]?.textContent || '未设置';
  const number = id => Number(value(id)).toLocaleString('zh-CN', { maximumFractionDigits: 3 });
  function update(locked, config) {
    review.update(locked, config);
    editor.hidden = locked; summary.hidden = !locked;
    heading.textContent = locked ? '当前配置' : '编辑策略';
    subtitle.textContent = locked ? '查看当前已加载的策略；编辑后可先预估影响，再审核发布。' : '修改暂存为草稿，审核并发布后才会影响线上请求。';
    panel.dataset.editing = String(!locked);
    $('unlockEdit').disabled = !config;
    if (!config) return;
    const tier = $('tierPicker').querySelector('.active strong')?.textContent || '自定义';
    const style = $('stylePicker').querySelector('.active strong')?.textContent || '自定义权重';
    const grid = el('div', null, 'policy-readout-grid');
    grid.append(
      readout('运行与路由', [
        ['运行状态', selected('mode'), value('mode') === 'active'],
        ['Auto 生效流量', value('mode') === 'active' ? value('activeTrafficPercent') + '%' : '仅观察（配置比例 ' + value('activeTrafficPercent') + '%）'],
        ['价格档位 / 取舍偏好', tier + ' / ' + style], ['最低质量目标', $('qualityFloorValue').textContent], status('自动调节思考深度', 'reasoningEnabled')]),
      readout('模型偏好与预算', [status('满足质量要求时优先自建', 'preferSelf'),
        ['自建模型加分', enabled('preferSelf') ? $('selfBonusValue').textContent : '未启用（配置 ' + $('selfBonusValue').textContent + '）'],
        status('每日预算软保护', 'budgetEnabled'), ['每日预算', number('dailyBudget') + ' 元' + (enabled('budgetEnabled') ? '' : '（未启用）')],
        ['保护触发比例', Math.round(Number(value('budgetThreshold')) * 100) + '%']], '预算软保护调整路由倾向，不直接拒绝请求。'),
      readout('日志与留存', [status('决策日志', 'decisionLogEnabled'), status('请求原文留存', 'logFullRequest'), status('回答原文留存', 'logAnswerText')],
        enabled('decisionLogEnabled') ? '正文留存按需开启，用毕可关闭。' : '决策日志未开启，正文留存设置暂不生效。'),
      readout('客户端接入', [['Auto 对外模型名', value('autoModelId') || 'auto'], ['模型发现列表', selected('exposeModelList')]], '修改入口名称前，请协调调用方同步更新。')
    );
    const detail = el('details', null, 'policy-parameters expert-only'); detail.append(el('summary', '查看评分权重与回退参数'));
    detail.append(readout('评分参数', [
      ['质量权重', number('qualityWeight')], ['用户成本敏感度', number('costWeight')], ['平台资源敏感度', number('providerCostWeight')], ['速度敏感度', number('latencyWeight')],
      ['复杂任务质量加严', number('complexQualityMargin')], ['相对质量损失上限 · 轻量 / 均衡 / 复杂', ['relQualityCapSimple', 'relQualityCapBalanced', 'relQualityCapComplex'].map(number).join(' / ')],
      ['小类分数平滑权重', number('subtaskSmoothK')], ['新模型观察期扣分', number('uncertaintyPenalty')], ['最多尝试次数', number('maxAttempts')]
    ]));
    summary.replaceChildren(grid, detail);
  }
  return { update };
}

function setupReviewLayout() {
  const page = document.querySelector('.tab-page[data-tab="semantic"]');
  const panel = page.querySelector('.panel'); panel.classList.add('review-settings');
  const header = panel.querySelector('.panel-head');
  header.querySelector('h2').textContent = '分类与评审设置';
  header.querySelector('.hint').textContent = '规则先识别任务，不确定时再复核；后台评审用于持续观察回答质量。';
  const actions = el('div', null, 'actions'), edit = el('button', '编辑复核设置', 'secondary'); edit.id = 'editReviewSettings'; edit.type = 'button'; edit.disabled = true; actions.append(edit); header.append(actions);
  edit.onclick = () => $(document.body.classList.contains('policy-locked') ? 'unlockEdit' : 'relockEdit').click();
  const sections = [...panel.querySelectorAll(':scope > .policy-section')];
  const controls = new Map();
  for (const field of panel.querySelectorAll('.policy-grid > label')) for (const input of field.querySelectorAll('input[id],select[id]')) controls.set(input.id, field);
  const hints = {
    semanticProvider: '按需使用小模型或大模型进行复核。', semanticMode: '仅观察时不改变实际路由。', semanticActivePercent: '正式采用时，按此比例采纳复核结果。',
    semanticThreshold: '规则置信度低于此值时启动复核。', semanticSmallAccept: '小模型达到此值即可定案。', semanticFinalAdoption: '低于此值则保留规则判断。',
    judgeEnabled: '后台抽样评审，不阻塞主请求。', judgeSamplePercent: '按请求比例抽样。', judgeDailyMaxCalls: '达到上限后暂停当天评审。', judgeDailyMaxTokens: '与调用数共同限制用量。',
    judgeModel: '后台质量与分类评审使用的模型。', judgeTimeoutMs: '单次评审等待上限，单位毫秒。', judgeCircuitThreshold: '连续失败达到阈值后暂停调用。',
    judgeTaskCheckEnabled: '单独核对任务分类，会增加一次评审调用。', semanticHttpUrl: '独立部署的分类服务地址。'
  };
  for (const [id, text] of Object.entries(hints)) { const note = controls.get(id)?.querySelector('small'); if (note) note.textContent = text; }
  function group(title, ids) {
    const card = el('section', null, 'review-group'); card.append(el('h3', title));
    const fields = el('div', null, 'review-fields'); for (const id of ids) fields.append(controls.get(id)); card.append(fields); return card;
  }
  const classification = el('div', null, 'review-groups');
  classification.append(group('复核方式', ['semanticProvider', 'semanticMode', 'semanticActivePercent']), group('采纳条件', ['semanticThreshold', 'semanticSmallAccept', 'semanticFinalAdoption']));
  sections[0].replaceChildren(el('h3', '分类复核', 'review-section-title'), classification);
  const judge = el('div', null, 'review-groups');
  judge.append(group('抽样与预算', ['judgeEnabled', 'judgeSamplePercent', 'judgeDailyMaxCalls', 'judgeDailyMaxTokens']), group('模型与保护', ['judgeModel', 'judgeTimeoutMs', 'judgeCircuitThreshold', 'judgeTaskCheckEnabled']));
  const connection = el('details', null, 'review-connection'); connection.append(el('summary', '评审通道与凭据'));
  const connectionFields = el('div', null, 'policy-grid'); connectionFields.append(controls.get('judgeSecretBaseUrl'), controls.get('judgeSecretApiKey')); connection.append(connectionFields);
  const clear = $('judgeSecretClear'); clear.textContent = '清空通道配置'; connection.append(clear, el('p', '清空操作会单独确认，并立即生效。', 'hint'));
  const usage = $('judgeToday').closest('label'); usage.classList.add('review-usage'); usage.querySelector('small')?.remove();
  sections[1].replaceChildren(el('h3', '回答评审', 'review-section-title'), usage, judge, connection);
  const components = el('details', null, 'review-components'); components.append(el('summary', '组件连接与运行状态'));
  for (const section of sections.slice(2)) components.append(section); panel.append(components);
  const readouts = [];
  for (const field of panel.querySelectorAll('.review-fields > label, .review-components .policy-grid > label')) {
    const input = field.querySelector('input,select'); if (!input) continue;
    field.classList.add('review-read-field'); const value = el('span', null, 'review-read-value'); field.append(value); readouts.push([input, value]);
  }
  return { update(locked, config) {
    edit.textContent = locked ? '编辑复核设置' : '结束编辑'; edit.disabled = !config;
    for (const [input, value] of readouts) {
      value.textContent = !config ? '加载中…' : input.type === 'checkbox' ? input.checked ? '已开启' : '未开启' : input.tagName === 'SELECT' ? input.selectedOptions[0]?.textContent || '未设置' : input.value || '未设置';
      value.classList.toggle('is-on', input.type === 'checkbox' && input.checked);
    }
  } };
}
