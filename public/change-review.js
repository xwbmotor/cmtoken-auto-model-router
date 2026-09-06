const LABELS = {
  routing: '路由策略', models: '模型', budget: '预算', semanticRouter: '分类复核', judge: '回答评审',
  decisionLog: '决策日志', costModel: '成本模型', reasoningControl: '推理控制', enabled: '启用',
  mode: '运行模式', activeTrafficPercent: '生效流量 %', qualityFloor: '最低质量', qualityWeight: '质量权重',
  costWeight: '用户成本权重', providerCostWeight: '平台成本权重', latencyWeight: '时延权重',
  costTier: '成本档位', preferSelfHosted: '优先自建', selfHostedBonus: '自建加分',
  maxAttempts: '最多尝试次数', ownership: '归属', displayName: '显示名称', quality: '质量分',
  default: '通用', coding: '代码', reasoning: '推理', extraction: '抽取', creative: '创意', simple: '轻量',
  costIndex: '用户成本指数', latencyIndex: '时延指数', pricingYuanPerMillionTokens: '定价（元/百万 Token）',
  input: '输入', inputCached: '缓存输入', output: '输出', dailyBudgetYuan: '每日预算（元）',
  samplePercent: '抽样率 %', confidenceThreshold: '复核触发阈值', deployment: '部署资源'
};
function redact(value, path) {
  if (secretPath(path)) return '敏感值（隐藏）';
  if (Array.isArray(value)) return value.map((item, i) => redact(item, `${path}.${i}`));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,redact(item, `${path}.${key}`)]));
  return value;
}
const secretPath = path => /api.?key|password|authorization|secret|(^|\.)token($|\.)/i.test(path);

export function configurationChanges(before, after) {
  const changes = [];
  function visit(oldValue, newValue, path) {
    if (Object.is(oldValue, newValue)) return;
    if (path.length === 1 && path[0] === 'version') return;
    if (path.length === 1 && path[0] === 'models' && Array.isArray(oldValue) && Array.isArray(newValue)) {
      const oldModels = new Map(oldValue.map(model => [model.id, model]));
      const newModels = new Map(newValue.map(model => [model.id, model]));
      for (const id of new Set([...oldModels.keys(), ...newModels.keys()])) visit(oldModels.get(id), newModels.get(id), [...path, id]);
      return;
    }
    if (oldValue && newValue && typeof oldValue === 'object' && typeof newValue === 'object' && !Array.isArray(oldValue) && !Array.isArray(newValue)) {
      for (const key of new Set([...Object.keys(oldValue), ...Object.keys(newValue)])) visit(oldValue[key], newValue[key], [...path, key]);
      return;
    }
    if (JSON.stringify(oldValue) === JSON.stringify(newValue)) return;
    changes.push({ path: path.join('.'), label: path.map(key => LABELS[key] || key).join(' / '), before: redact(oldValue, path.join('.')), after: redact(newValue, path.join('.')) });
  }
  visit(before, after, []);
  return changes;
}

export function reviewPublication(before, after, { secretChanged, changedRate, qualityDrop, highRisk }) {
  const dialog = document.getElementById('publishReview');
  const rows = document.getElementById('changeRows'); rows.replaceChildren();
  const changes = configurationChanges(before, after);
  // Never interpolate configuration values as HTML or persist this review.
  for (const change of changes) {
    const row = document.createElement('tr');
    for (const [index, value] of [change.label, change.before, change.after].entries()) {
      const cell = document.createElement(index === 0 ? 'th' : 'td');
      cell.textContent = value === undefined ? '未设置' : value === true ? '开启' : value === false ? '关闭' : value === null ? '未设置' : typeof value === 'object' ? JSON.stringify(value) : String(value);
      row.append(cell);
    }
    rows.append(row);
  }
  document.getElementById('changeCount').textContent = `${changes.length} 项配置变化${secretChanged ? '，另有评审通道更新（密钥不显示）' : ''}`;
  document.getElementById('changeEmpty').hidden = changes.length > 0;
  const risk = document.getElementById('publishRisk');
  risk.textContent = `代表任务预计切换 ${Math.round(changedRate * 100)}%，平均质量分变化 ${qualityDrop >= 0 ? '+' : ''}${qualityDrop.toFixed(3)}。${highRisk ? '影响较大，建议先小流量灰度。' : '预估基于代表任务，不等于线上实际效果。'}`;
  risk.className = highRisk ? 'review-risk high' : 'review-risk';
  dialog.returnValue = 'cancel';
  return new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'publish'), { once: true });
    dialog.showModal();
  });
}
