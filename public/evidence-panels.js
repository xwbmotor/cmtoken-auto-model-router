const el = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
const date = n => n ? new Date(n).toLocaleString('zh-CN') : '暂无';
const names = { errors: '失败率升高', slow: '响应变慢', capacity: '额度接近上限' };
const states = { historical_judge: '历史 Judge 评测', amended_or_mismatch: '人工修订或均值不一致', missing: '缺少原始结果', invalid_evidence: '样本存在重复或无效值' };
function download(data, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = el('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function panel(tab, id, title) {
  const node = el('section', null, 'panel evidence-panel'); node.id = id;
  node.append(el('h2', title)); const body = el('div'); body.setAttribute('aria-live', 'polite'); node.append(body);
  document.querySelector(`.tab-page[data-tab="${tab}"]`).prepend(node); return { node, body };
}
function incident(event) {
  const card = el('details', null, 'operation-card');
  card.append(el('summary', `${names[event.type]} · ${event.model} · ${event.status === 'active' ? event.awaitingData ? '等待新证据' : '持续中' : event.status === 'resolved' ? '已观测恢复' : '配置变更关闭'}`));
  card.append(el('p', `触发 ${date(event.openedAt)} · 最近检查 ${date(event.lastCheckedAt)}${event.closedAt ? ' · 结束 ' + date(event.closedAt) : ''}`));
  for (const [title, evidence] of [['触发时', event.triggerEvidence], ['最近一次', event.latestEvidence]]) {
    if (event.type === 'capacity') card.append(el('p', `${title}：本路由进程在途 ${evidence.inflight} / 分配额度 ${evidence.capacity}；不代表整个 MaaS 池使用量。`));
    else {
      const c = evidence.current, b = evidence.baseline;
      card.append(el('p', `${title}：最近完整 5 分钟成功 ${c.success} / 失败 ${c.failed} / 取消 ${c.cancelled}；${evidence.metric} P50 ${c.p50Ms ?? '—'} ms（n=${c.validCount}），此前 25 分钟 P50 ${b.p50Ms ?? '—'} ms（n=${b.validCount}）。`));
      const x = evidence.context;
      card.append(el('p', `条件：${x.stream ? '流式' : '非流式'} · 思考 ${x.reasoning} · 输入 ${x.inputBand} / 输出 ${x.outputBand} · scope ${x.scope} · inference ${x.inference}`, 'hint'));
    }
  }
  card.append(el('p', event.type === 'capacity' ? '处理建议：核对本路由分配额度及副本共享计数，检查排队和超时。' : '处理建议：按关联请求核查上游返回、重试与推理条件，结合配置变更定位。'));
  card.append(el('p', '关联请求（最多 5 条，仅含诊断元数据）：'));
  for (const s of event.samples || []) card.append(el('p', `${date(s.at)} · ${s.requestId || '未登记请求 ID'} · ${s.ok ? '成功' : s.failureScope === 'client' ? '客户端取消' : '失败'}`, 'evidence-ref'));
  if (!event.samples?.length) card.append(el('p', '没有保留对应请求引用；聚合证据仍在。', 'hint'));
  card.append(el('p', `触发前 30 分钟配置变更 ${event.configChanges?.length || 0} 次；时间相邻不证明因果。`, 'hint'));
  for (const c of event.configChanges || []) card.append(el('p', `${date(c.at)} · ${c.previous} → ${c.revision}`, 'evidence-ref'));
  return card;
}
export function setupEvidencePanels({ api }) {
  const ops = panel('overview', 'operationsEvidence', '需要关注的异常');
  const quality = panel('models', 'qualityEvidence', '质量分数的证据');
  const compare = panel('insights', 'comparisonEvidence', '真实效果对比');
  document.querySelector('.tab-page[data-tab="overview"] > .cards')?.after(ops.node);
  document.querySelector('.model-registry-panel')?.after(quality.node);
  document.getElementById('latencyPanel')?.after(compare.node);
  const refreshers = [
    [ops, async () => {
      const d = await api('/admin/api/operations');
      ops.body.replaceChildren(el('p', `最近检查 ${date(d.lastCheckedAt)}`, 'hint'));
      if (d.storageErrors) ops.body.append(el('p', '异常记录持久化存在错误，请检查服务存储与权限。', 'latency-notice'));
      if (!d.active.length) ops.body.append(el('p', '暂无达到持续触发条件的异常；不代表所有条件均有足够观测。'));
      for (const e of d.active) ops.body.append(incident(e));
      const history = el('details'); history.append(el('summary', `已结束事件（${d.history.length}）`));
      for (const e of d.history) history.append(incident(e)); ops.body.append(history);
      const rules = el('details', null, 'evidence-rules'); rules.append(el('summary', '判定规则与保留范围'));
      rules.append(el('p', `连续两次检查确认。失败率 ≥10% 且至少 20 次尝试；同条件时延 P50 至少翻倍且增加 1 秒、两窗各至少 20 个有效样本；额度使用 ≥90%。无足够数据时不判定恢复。最多保留 ${d.maxEvents} 条事件，结束后保留 ${d.retentionDays} 天。`)); ops.body.append(rules);
    }],
    [quality, async () => {
      const d = await api('/admin/api/quality-evidence');
      quality.body.replaceChildren(el('p', (d.limitations || []).join('；') + '。', 'hint'));
      for (const m of d.models) {
        const group = el('details', null, 'operation-card'); group.append(el('summary', m.model));
        const subtasks = el('details', null, 'quality-subtasks'); subtasks.append(el('summary', '细分任务评分 · 按需展开'));
        for (const s of m.scores) {
          const name = ({ default: '通用', simple: '简单任务', coding: '代码', reasoning: '推理', creative: '创意', extraction: '抽取' })[s.task] || s.task.replace(/^subtask:/, '');
          const row = el('details'); row.append(el('summary', `${name} · 当前 ${s.value} · ${states[s.status]}`));
          row.append(el('p', `来源标记：${s.source}`));
          const e = s.evidence;
          if (e) {
            row.append(el('p', `评测 ${date(e.evaluatedAt)} · Judge ${e.judgeModel || '未记录'} · 有效 ${e.validCount}/${e.count} · 重复 ${e.duplicateCount} · 原始均值 ${e.mean.toFixed(4)}`));
            row.append(el('p', `原始文件 ${e.path} · SHA256 ${e.sha256}`, 'evidence-ref'));
            row.append(el('p', `题目 ID：${e.caseIds.join('、')}`, 'evidence-ref'));
          }
          row.append(el('p', `证据缺口：${s.missing.join('、')}。`, 'hint')); (s.task.startsWith('subtask:') ? subtasks : group).append(row);
        }
        if (subtasks.children.length > 1) group.append(subtasks);
        quality.body.append(group);
      }
      const save = el('button', '下载来源清单', 'secondary'); save.onclick = () => download(d, 'quality-evidence.json'); quality.body.append(save);
    }],
    [compare, async () => {
      const d = await api('/admin/api/comparison/readiness');
      compare.body.replaceChildren(el('p', '对比工具已就绪，真实业务实验尚待补齐数据。', 'latency-notice'), el('p', `${d.scope}：${d.observations} 条。${d.note}`, 'hint'));
      const list = el('ul'); for (const b of d.blockers) list.append(el('li', b)); compare.body.append(list);
      const link = el('a', '查看实验方案与验收口径'); link.href = d.plan; link.target = '_blank'; link.rel = 'noopener'; compare.body.append(link);
      const label = el('label', '导入已脱敏的业务矩阵 JSON（上限 2 MB；只分析，不调用模型）');
      const input = el('input'); input.type = 'file'; input.accept = '.json,application/json'; label.append(input); compare.body.append(label);
      const output = el('div'); output.setAttribute('role', 'status'); compare.body.append(output);
      input.onchange = async () => {
        const file = input.files[0]; if (!file) return;
        input.disabled = true; output.replaceChildren(el('p', '正在校验并计算配对结果…'));
        try {
          if (file.size > 2 * 1024 * 1024) throw Error('文件超过 2 MB，请使用离线 CLI。');
          const report = await api('/admin/api/comparison/analyze', { method: 'POST', body: await file.text() });
          output.replaceChildren(el('p', report.claimAssessment.offlineAnalysisEligible ? '满足有限范围离线比较条件；尚未证明生产优越性。' : '证据不足，不能据此声明效果提升。'));
          for (const b of report.claimAssessment.blockers) output.append(el('p', `${b.code}：${b.message || b.detail || ''}`));
          const save = el('button', '下载完整对比结果', 'secondary'); save.onclick = () => download(report, 'comparison-report.json'); output.append(save);
        } catch (error) { output.replaceChildren(el('p', '分析失败：' + error.message)); }
        finally { input.disabled = false; }
      };
    }]
  ];
  let busy = false; const last = new Map();
  async function refresh() {
    if (busy || document.hidden) return; busy = true;
    try {
      for (const [p, run] of refreshers) {
        if (!p.node.getClientRects().length || p.node.closest('[hidden]') || Date.now() - (last.get(p) || 0) < 30000 || p.node.contains(document.activeElement) || p.node.querySelector('details[open]') || p.node.querySelector('input[type=file]')?.files?.length) continue;
        last.set(p, Date.now());
        try { await run(); } catch (error) { p.body.replaceChildren(el('p', '加载失败：' + error.message + '，稍后自动重试。')); }
      }
    } finally { busy = false; }
  }
  document.addEventListener('workspace:navigate', refresh); document.addEventListener('visibilitychange', refresh);
  setInterval(refresh, 30000); refresh();
}
