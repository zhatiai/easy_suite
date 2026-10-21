import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatAnnotationsAsMarkdown,
  formatSingleAnnotationAsMarkdown,
  formatTxtQuoteAsMarkdown,
  type PdfAnnotation,
} from '../src/client/annotations';

test('formatAnnotationsAsMarkdown formats multi-page annotations in order', () => {
  const annotations: PdfAnnotation[] = [
    {
      id: 'ann-2',
      page: 3,
      type: 'highlight',
      color: 'blue',
      text: 'Conclusion: The hypothesis holds true.',
      comment: 'Check appendix for proofs',
      rects: [{ x: 10, y: 20, width: 80, height: 5 }],
      createdAt: 200,
    },
    {
      id: 'ann-1',
      page: 1,
      type: 'highlight',
      color: 'yellow',
      text: 'Introduction to Distributed Systems',
      comment: 'Core definition',
      rects: [{ x: 10, y: 10, width: 80, height: 5 }],
      createdAt: 100,
    },
  ];

  const md = formatAnnotationsAsMarkdown('paper.pdf', annotations);
  assert.ok(md.includes('### 《paper.pdf》阅读笔记与批注'));
  assert.ok(md.includes('#### 第 1 页'));
  assert.ok(md.includes('> Introduction to Distributed Systems'));
  assert.ok(md.includes('**批注**：Core definition'));
  assert.ok(md.includes('#### 第 3 页'));
  assert.ok(md.includes('> Conclusion: The hypothesis holds true.'));
  assert.ok(md.includes('**批注**：Check appendix for proofs'));
  // verify page 1 comes before page 3 in markdown output
  const idx1 = md.indexOf('第 1 页');
  const idx3 = md.indexOf('第 3 页');
  assert.ok(idx1 < idx3);
});

test('formatSingleAnnotationAsMarkdown formats quote, comment, and page reference', () => {
  const ann: PdfAnnotation = {
    id: 'ann-1',
    page: 5,
    type: 'highlight',
    color: 'green',
    text: 'Key insight for architecture design',
    comment: 'Implement in module B',
    rects: [{ x: 5, y: 15, width: 50, height: 4 }],
    createdAt: 100,
  };
  const singleMd = formatSingleAnnotationAsMarkdown(ann, 'architecture.pdf');
  assert.ok(singleMd.includes('> Key insight for architecture design'));
  assert.ok(singleMd.includes('**批注**：Implement in module B'));
  assert.ok(singleMd.includes('《architecture.pdf》第 5 页'));
});

test('formatTxtQuoteAsMarkdown formats text blockquotes with source', () => {
  const quote = formatTxtQuoteAsMarkdown('First line\nSecond line', 'readme.txt');
  assert.ok(quote.includes('> First line\n> Second line'));
  assert.ok(quote.includes('*(来源: 《readme.txt》)*'));
});
