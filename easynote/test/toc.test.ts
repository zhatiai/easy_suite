import assert from 'node:assert/strict';
import test from 'node:test';
import { slugify, hasToc, generateToc, insertToc, removeToc, toggleToc, updateToc } from '../src/client/toc';

test('slugify converts titles to valid markdown anchor slugs', () => {
  assert.equal(slugify('Hello World!'), 'hello-world');
  assert.equal(slugify('快速开始指南'), '快速开始指南');
  assert.equal(slugify('1.1 EasyNote 介绍 (v0.7.8)'), '11-easynote-介绍-v078');
  assert.equal(slugify('`getUser(id)` API'), 'getuserid-api');
  assert.equal(slugify('**重要**：[使用说明](https://example.com)'), '重要使用说明');
  assert.equal(slugify('!!!@@@###'), 'section');
});

test('hasToc detects standard markdown TOC markers', () => {
  assert.equal(hasToc('<!-- toc -->\n- [A](#a)\n<!-- /toc -->'), true);
  assert.equal(hasToc('<!-- TOC -->\n- [A](#a)\n<!-- /TOC -->'), true);
  assert.equal(hasToc('<!-- toc -->\n- [A](#a)\n<!-- tocstop -->'), true);
  assert.equal(hasToc('# 标题\n正文内容'), false);
  assert.equal(hasToc(''), false);
});

test('generateToc creates hierarchical markdown list from headings', () => {
  const content = `# 一级标题\n内容\n## 二级标题 A\n内容\n### 三级标题 A.1\n内容\n## 二级标题 B`;
  const toc = generateToc(content);
  assert.ok(toc);
  assert.equal(
    toc,
    [
      '<!-- toc -->',
      '- [一级标题](#一级标题)',
      '  - [二级标题 A](#二级标题-a)',
      '    - [三级标题 A.1](#三级标题-a1)',
      '  - [二级标题 B](#二级标题-b)',
      '<!-- /toc -->',
    ].join('\n'),
  );
});

test('generateToc handles duplicate headings and min-level offsets', () => {
  const content = `## 重复标题\n## 重复标题\n### 子标题\n## 重复标题`;
  const toc = generateToc(content);
  assert.ok(toc);
  assert.equal(
    toc,
    [
      '<!-- toc -->',
      '- [重复标题](#重复标题)',
      '- [重复标题](#重复标题-1)',
      '  - [子标题](#子标题)',
      '- [重复标题](#重复标题-2)',
      '<!-- /toc -->',
    ].join('\n'),
  );
});

test('generateToc returns null when no headings exist or headings are in code fences', () => {
  assert.equal(generateToc('没有标题的正文内容'), null);
  assert.equal(generateToc('```markdown\n# 这是代码块里的标题\n```'), null);
});

test('insertToc inserts TOC at top of document', () => {
  const content = '# 标题 1\n内容\n## 标题 2\n内容';
  const result = insertToc(content);
  assert.equal(result.inserted, true);
  assert.ok(result.content.startsWith('<!-- toc -->\n- [标题 1](#标题-1)\n  - [标题 2](#标题-2)\n<!-- /toc -->\n\n# 标题 1'));
});

test('insertToc preserves frontmatter and inserts TOC directly after it', () => {
  const content = '---\ntitle: 测试\ntags: [demo]\n---\n\n# 章节一\n正文';
  const result = insertToc(content);
  assert.equal(result.inserted, true);
  assert.ok(result.content.startsWith('---\ntitle: 测试\ntags: [demo]\n---\n\n<!-- toc -->\n- [章节一](#章节一)\n<!-- /toc -->\n\n# 章节一'));
});

test('removeToc removes TOC and restores original text', () => {
  const original = '# 标题 1\n正文内容\n## 标题 2';
  const inserted = insertToc(original);
  assert.equal(inserted.inserted, true);
  const removed = removeToc(inserted.content);
  assert.equal(removed.removed, true);
  assert.equal(removed.content, original);
});

test('removeToc preserves frontmatter when removing TOC', () => {
  const original = '---\ntitle: 测试\n---\n\n# 章节一\n正文内容';
  const inserted = insertToc(original);
  assert.equal(inserted.inserted, true);
  const removed = removeToc(inserted.content);
  assert.equal(removed.removed, true);
  assert.equal(removed.content, original);
});

test('toggleToc inserts TOC on first call and removes on second call', () => {
  const note = '# 一级\n## 二级';
  const r1 = toggleToc(note);
  assert.equal(r1.action, 'inserted');
  assert.equal(hasToc(r1.content), true);

  const r2 = toggleToc(r1.content);
  assert.equal(r2.action, 'removed');
  assert.equal(hasToc(r2.content), false);
  assert.equal(r2.content, note);
});

test('toggleToc returns no_headings when document has no headings', () => {
  const note = '没有标题的纯文本内容';
  const result = toggleToc(note);
  assert.equal(result.action, 'no_headings');
  assert.equal(result.content, note);
});

test('updateToc refreshes TOC when headings are added or changed', () => {
  const note = '# 一级标题\n内容';
  const inserted = insertToc(note);
  assert.equal(inserted.inserted, true);

  // No change if headings are identical
  const u1 = updateToc(inserted.content);
  assert.equal(u1.changed, false);
  assert.equal(u1.content, inserted.content);

  // Appending a new heading
  const modified = `${inserted.content}\n\n## 二级标题\n更多内容`;
  const u2 = updateToc(modified);
  assert.equal(u2.changed, true);
  assert.ok(u2.content.includes('- [二级标题](#二级标题)'));
  assert.ok(u2.content.includes('## 二级标题'));
});
