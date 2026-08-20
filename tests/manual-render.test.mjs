import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../src/markdown.mjs';

// 手册渲染器回归：任何输入都不得产出「空正文」——这是手册空白事故的防线
test('renderMarkdown: 标题/表格/代码/列表/粗体/链接全覆盖', () => {
  const html = renderMarkdown('# 标题\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```bash\nnpm start\n```\n\n- 项目\n- 列表\n\n**粗体** `code` [链接](https://x)\n');
  assert.ok(html.includes('<h2>标题</h2>'), 'h1→h2');
  assert.ok(html.includes('<table>'), '表格');
  assert.ok(html.includes('<pre'), '代码块');
  assert.ok(html.includes('<ul><li>项目</li><li>列表</li></ul>'), '列表合并不碎');
  assert.ok(html.includes('<strong>粗体</strong>'), '粗体');
  assert.ok(html.includes('<a href='), '链接');
});

test('renderMarkdown: 空输入/异常输入不抛错、不空屏', () => {
  assert.ok(renderMarkdown('').includes('手册内容为空'), '空串兜底文案');
  assert.ok(renderMarkdown(null).includes('手册内容为空'), 'null 兜底');
  assert.ok(renderMarkdown('<script>alert(1)</script>').includes('&lt;script&gt;'), 'XSS 转义');
});

test('renderMarkdown: 服务端注入安全（HTML 尖括号全部转义后再生效行内语法）', () => {
  const html = renderMarkdown('正常 `<b>text</b>` 结束');
  assert.ok(!/<b>/.test(html), '原文 <b> 不落 DOM');
  assert.ok(html.includes('&lt;b&gt;'), '已转义');
});
