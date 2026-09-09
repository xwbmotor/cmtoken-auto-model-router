// Visible only when the operator explicitly enables the migration bridge.
export function setupGoCorePanel({ api }) {
  const page = document.querySelector('[data-tab="overview"].tab-page');
  const panel = document.createElement('section'); panel.className = 'panel'; panel.hidden = true;
  panel.setAttribute('aria-label', '实验 Go 核心');
  panel.innerHTML = '<div class="panel-head"><div><p class="eyebrow">迁移验证</p><h2>实验 Go 核心</h2></div><div class="actions"><button type="button" class="secondary" data-core-refresh>查询状态</button><button type="button" data-core-reload disabled>将已保存配置加载到 Go</button></div></div><p data-core-status role="status"></p><p class="hint">此操作只更新实验 Go 核心，不切换业务流量。当前页面的业务指标仍来自 Node；尚未保存的草稿不会下发。</p><details><summary>查看配置版本</summary><pre data-core-revisions style="white-space:pre-wrap;overflow-wrap:anywhere"></pre></details>';
  page.prepend(panel);
  const status = panel.querySelector('[data-core-status]'), versions = panel.querySelector('[data-core-revisions]');
  const reload = panel.querySelector('[data-core-reload]'), query = panel.querySelector('[data-core-refresh]');
  let revision = null, busy = false, enabled = false;
  async function refresh() {
    if (busy) return;
    busy = true; reload.disabled = true; query.disabled = true;
    try {
      const state = await api('/admin/api/go-core');
      enabled = true; panel.hidden = false; revision = state.revision;
      status.textContent = state.synchronized ? 'Go 已加载当前保存的配置。' : '已保存配置与 Go 生效配置不同，尚未同步。';
      versions.textContent = `管理服务保存：${state.savedConfigRevision}\nGo 当前配置：${state.configRevision}\nGo 运行版本：${state.revision}`;
    } catch (error) {
      revision = null;
      if (error.status === 404 && !enabled) panel.hidden = true;
      else { panel.hidden = false; status.textContent = `状态未确认：${error.message}`; }
    } finally { busy = false; query.disabled = false; reload.disabled = !revision; }
  }
  query.onclick = refresh;
  reload.onclick = async () => {
    if (!revision || busy) return;
    busy = true; reload.disabled = true; query.disabled = true;
    let failure;
    try { await api('/admin/api/go-core/reload', { method: 'POST', headers: { 'If-Match': revision } }); }
    catch (error) { failure = error.message; }
    finally { busy = false; }
    // Re-query after success or uncertain transport failure; never blindly retry a mutation.
    await refresh();
    if (failure) status.textContent = `加载请求未确认：${failure}。${status.textContent}`;
  };
  return { refresh };
}
