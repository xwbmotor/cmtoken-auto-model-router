// 服务端 markdown → HTML 渲染器（零依赖，手册专用）。
// 覆盖 docs/使用说明.md 用到的语法子集：标题/表格/代码块/行内代码/列表/粗体/链接/引用。
// 输出前统一 HTML 转义，无注入面；渲染失败时回退 <pre> 纯文本，保证手册永远有内容可读。

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(s) {
  return s
    .replace(/`([^`]+)`/g, (_, c) => '<code>' + c + '</code>')
    .replace(/\*\*([^*]+)\*\*/g, (_, t) => '<strong>' + t + '</strong>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, h) => '<a href="' + h + '" target="_blank" rel="noopener">' + t + '</a>');
}

export function renderMarkdown(md) {
  if (typeof md !== 'string' || !md.trim()) return '<p>（手册内容为空）</p>';
  try {
    const lines = md.split(/\r?\n/);
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (line.startsWith('```')) { // 代码块（语言标注不转义出界——在 esc 后包裹）
        const lang = line.slice(3).trim();
        const buf = [];
        i++;
        while (i < lines.length && !lines[i].startsWith('```')) { buf.push(lines[i]); i++; }
        i++;
        out.push('<pre data-lang="' + esc(lang) + '"><code>' + esc(buf.join('\n')) + '</code></pre>');
        continue;
      }
      if (/^\|.*\|$/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|$/.test(lines[i + 1])) { // 表格
        const rows = [];
        let j = i + 2;
        while (j < lines.length && /^\|.*\|$/.test(lines[j])) { rows.push(lines[j]); j++; }
        const cells = (r) => r.split('|').slice(1, -1).map((c) => c.trim());
        out.push('<table><thead><tr>' + cells(line).map((c) => '<th>' + inline(c) + '</th>').join('') + '</tr></thead><tbody>'
          + rows.map((r) => '<tr>' + cells(r).map((c) => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table>');
        i = j;
        continue;
      }
      if (/^#{1,3}\s/.test(line)) {
        const level = Math.min(4, line.match(/^#+/)[0].length + 1); // md h1 → 页面 h2（h1 留给文档题头）
        out.push('<h' + level + '>' + inline(esc(line.replace(/^#+\s*/, ''))) + '</h' + level + '>');
        i++;
        continue;
      }
      if (/^&gt;\s?/.test(line) || /^>\s?/.test(line)) {
        out.push('<blockquote>' + inline(esc(line.replace(/^(&gt;|>)\s?/, ''))) + '</blockquote>');
        i++;
        continue;
      }
      if (/^[-*]\s/.test(line) || /^\d+\.\s/.test(line)) { // 列表（连续同类型合并，避免碎 <ul>）
        const ordered = /^\d+\.\s/.test(line);
        const items = [];
        let j = i;
        while (j < lines.length && (/^[-*]\s/.test(lines[j]) || /^\d+\.\s/.test(lines[j]))) {
          items.push('<li>' + inline(esc(lines[j].replace(/^([-*]|\d+\.)\s*/, ''))) + '</li>');
          j++;
        }
        out.push('<' + (ordered ? 'ol' : 'ul') + '>' + items.join('') + '</' + (ordered ? 'ol' : 'ul') + '>');
        i = j;
        continue;
      }
      if (!line.trim()) { i++; continue; }
      out.push('<p>' + inline(esc(line)) + '</p>');
      i++;
    }
    return out.join('\n');
  } catch {
    return '<pre>' + esc(md) + '</pre>'; // 渲染器异常也保证可读
  }
}
