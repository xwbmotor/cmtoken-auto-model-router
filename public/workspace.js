// Progressive UI enhancements; no configuration or credential persistence here.
export const PAGES = {
  overview: ['运行总览', '查看流量、成本与路由表现，快速定位需要关注的问题。'],
  policy: ['业务策略', '调整路由目标，比较影响，再发布到线上。'],
  models: ['模型管理', '查找模型、维护能力与定价，完成评测后纳入路由。'],
  insights: ['效果洞察', '结合真实请求与对照结果，判断路由是否带来收益。'],
  semantic: ['质量复核', '配置分类复核与回答评审，控制采纳范围和调用预算。'],
  debug: ['调试工具', '输入业务请求，查看模型选择及其原因。'],
  help: ['使用手册', '了解接入、配置与日常运营流程。']
};

export function setupWorkspace({ navigate, isDirty, notify }) {
  const $ = id => document.getElementById(id);
  const paths = ['M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z', 'M4 7h16 M4 17h16 M9 4v6 M15 14v6', 'M3 5l9-4 9 4-9 4z M3 12l9 4 9-4 M3 19l9 4 9-4', 'M4 20V10 M12 20V4 M20 20v-8', 'M12 2l8 4v6c0 5-8 10-8 10S4 17 4 12V6z M8 12l3 3 5-6', 'M8 6l-6 6 6 6 M16 6l6 6-6 6', 'M4 3h7l1 2 1-2h7v17h-7l-1 2-1-2H4z M12 5v17'];
  document.querySelectorAll('#tabs button').forEach((button, i) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.classList.add('nav-icon');
    const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', paths[i]); svg.append(path); button.prepend(svg);
  });
  const jump = $('sectionJump');
  function updatePage() {
    const page = document.querySelector('.tab-page:not([hidden])');
    if (!page) return;
    const name = page.dataset.tab;
    $('pageTitle').textContent = PAGES[name][0]; $('pageDescription').textContent = PAGES[name][1];
    document.title = `${PAGES[name][0]} · Auto Model Router`;
    jump.replaceChildren(new Option('跳转到本页内容…', ''));
    page.querySelectorAll('h2').forEach((heading, i) => {
      if (!heading.getClientRects().length) return;
      if (!heading.id) heading.id = `section-${name}-${i}`;
      jump.add(new Option(heading.textContent.trim(), heading.id));
    });
    jump.parentElement.hidden = jump.options.length < 3;
  }
  document.addEventListener('workspace:navigate', updatePage);
  new MutationObserver(updatePage).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  jump.addEventListener('change', () => {
    const heading = $(jump.value); if (!heading) return;
    heading.closest('details')?.setAttribute('open', '');
    heading.tabIndex = -1; heading.focus({ preventScroll: true }); heading.scrollIntoView({ block: 'start' });
  });
  updatePage();

  const body = $('models');
  const tools = document.createElement('div'); tools.className = 'model-tools';
  tools.innerHTML = '<label>查找模型<input id="modelSearch" type="search" placeholder="输入模型名称或 ID" autocomplete="off"></label><label>启用状态<select id="modelState"><option value="all">全部状态</option><option value="enabled">已启用</option><option value="disabled">未启用</option></select></label><label>模型归属<select id="modelOwner"><option value="all">全部归属</option><option value="self_hosted">自建</option><option value="ecosystem">生态</option><option value="unknown">归属待定</option></select></label><button id="clearModelFilters" class="secondary" type="button">重置筛选</button><output id="modelCount" aria-live="polite"></output>';
  body.closest('.table-wrap').before(tools);
  const columnLabel = document.createElement('label'); columnLabel.textContent = '显示内容';
  const columnView = document.createElement('select'); columnView.id = 'modelColumnView';
  for (const [value, label] of [['common','日常管理'],['pricing','模型定价'],['all','全部参数']]) columnView.add(new Option(label, value));
  columnLabel.append(columnView); tools.insertBefore(columnLabel, $('clearModelFilters'));
  const table = body.closest('table');
  table.dataset.columns = 'common';
  columnView.onchange = () => { table.dataset.columns = columnView.value; };
  const empty = document.createElement('p'); empty.className = 'empty'; empty.hidden = true; empty.textContent = '没有匹配的模型，请调整关键词或重置筛选。'; tools.after(empty);
  function filterModels() {
    const query = $('modelSearch').value.trim().toLocaleLowerCase(); let count = 0;
    [...body.rows].forEach(row => {
      const enabled = row.querySelector('.enabled').checked;
      const owner = row.querySelector('.ownership').value;
      row.hidden = !row.cells[1].textContent.toLocaleLowerCase().includes(query)
        || ($('modelState').value !== 'all' && enabled !== ($('modelState').value === 'enabled'))
        || ($('modelOwner').value !== 'all' && owner !== $('modelOwner').value);
      if (!row.hidden) count++;
      // A label for each dense table control keeps screen reader context intact.
      row.querySelectorAll('input,select').forEach(input => {
        const column = body.closest('table').tHead.rows[0].cells[input.closest('td').cellIndex];
        input.setAttribute('aria-label', `${row.cells[1].querySelector('strong').textContent} · ${column.textContent.replace(/\?/g, '').trim()}`);
      });
    });
    $('modelCount').textContent = `显示 ${count} / ${body.rows.length} 个模型`;
    empty.hidden = count !== 0; body.closest('.table-wrap').hidden = count === 0;
  }
  tools.addEventListener('input', filterModels); tools.addEventListener('change', filterModels);
  body.addEventListener('change', filterModels);
  $('clearModelFilters').onclick = () => { $('modelSearch').value = ''; $('modelState').value = $('modelOwner').value = 'all'; filterModels(); $('modelSearch').focus(); };
  new MutationObserver(filterModels).observe(body, { childList: true }); filterModels();

  function updateDraft() { $('draftBar').hidden = !isDirty(); }
  new MutationObserver(updateDraft).observe($('dirtyBadge'), { attributes: true, attributeFilter: ['hidden'] });
  $('reviewDraft').onclick = () => { navigate('policy'); $('unlockEdit').click(); $('save').focus(); };
  $('discardDraft').onclick = () => $('reload').click();
  window.addEventListener('beforeunload', event => { if (isDirty()) { event.preventDefault(); event.returnValue = ''; } });
  updateDraft();

  // Wrap established handlers once: repeated clicks cannot duplicate a mutation.
  for (const id of ['connect', 'refresh', 'save', 'simulate', 'preview', 'logout', 'probeSemantic']) {
    const button = $(id), original = button?.onclick; if (!original) continue;
    button.onclick = async function(event) {
      if (button.getAttribute('aria-busy') === 'true') return;
      button.disabled = true; button.setAttribute('aria-busy', 'true');
      try { await original.call(this, event); } catch (error) { notify(error.message, true); }
      finally { button.disabled = false; button.removeAttribute('aria-busy'); updateDraft(); }
    };
  }

  // Existing modal markup is shared by live evaluation updates and discovery.
  // Preserve their close callbacks (timer and secret cleanup), and add focus isolation.
  const modals = [...document.querySelectorAll('.modal-mask')]; let active = null, returnFocus = null, inerted = [];
  const focusable = node => [...node.querySelectorAll('button,input,select,textarea,a[href],[tabindex]')].filter(el => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length);
  function restore() { inerted.forEach(el => { el.inert = false; }); inerted = []; }
  function syncModal() {
    const visible = modals.filter(modal => getComputedStyle(modal).display !== 'none').at(-1);
    if (visible === active) return;
    restore();
    if (!visible) { active = null; returnFocus?.focus(); returnFocus = null; return; }
    if (!active) returnFocus = document.activeElement;
    active = visible;
    let branch = active;
    while (branch.parentElement && branch !== document.body) {
      [...branch.parentElement.children].forEach(el => { if (el !== branch && !el.inert && !['SCRIPT','STYLE'].includes(el.tagName) && !el.matches('#toast,#errorNotice')) { el.inert = true; inerted.push(el); } });
      branch = branch.parentElement;
    }
    (focusable(active)[0] || active).focus();
  }
  modals.forEach((modal, i) => {
    modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.tabIndex = -1;
    const title = modal.querySelector('h3'); title.id ||= `dialog-title-${i}`; modal.setAttribute('aria-labelledby', title.id);
    modal.querySelector('.modal-x').setAttribute('aria-label', '关闭对话框');
    new MutationObserver(syncModal).observe(modal, { attributes: true, attributeFilter: ['style'] });
    // Dynamic wizard steps may remove the focused control.
    new MutationObserver(() => { if (active === modal && !modal.contains(document.activeElement)) (focusable(modal)[0] || modal).focus(); }).observe(modal.querySelector('.modal-box'), { childList: true, subtree: true });
  });
  document.addEventListener('keydown', event => {
    if (!active) return;
    if (event.key === 'Escape') { event.preventDefault(); active.querySelector('.modal-x').click(); }
    if (event.key === 'Tab') {
      const items = focusable(active), first = items[0], last = items.at(-1);
      if (!first) { event.preventDefault(); active.focus(); }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === active)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
}
