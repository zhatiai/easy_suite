import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Compartment, EditorState, Facet, StateField, type Range } from '@codemirror/state';
import { Decoration, EditorView, keymap, placeholder, ViewPlugin, type DecorationSet, type ViewUpdate, WidgetType } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import MarkdownIt from 'markdown-it';
import footnote from 'markdown-it-footnote';
import DOMPurify from 'dompurify';
import katex from 'katex';
import { idPattern } from '../shared/types';
import { t } from './i18n';
import { slugify, updateToc } from './toc';
import { headings } from './knowledge';
import { DocumentViewer } from './DocumentViewer';
import {
  type ParsedTable,
  parseMarkdownTable,
  serializeMarkdownTable,
  insertRow,
  deleteRow,
  insertColumn,
  deleteColumn,
  setCell,
  isDelimiterLine,
} from './table';

interface Props {
  value: string;
  mode?: 'live' | 'markdown';
  onChange(value: string): void;
  onImages?(files: File[], insertion: string): void;
  onSubmit?(): void;
  onTogglePreview(): void;
  onShowShortcuts(): void;
  searchQuery?: string;
  onRefreshToc?(): void;
}

export interface EditorHandle {
  markInsertion(): string;
  insertAt(insertion: string, value: string): boolean;
  releaseInsertion(insertion: string): void;
  cursor(): number;
  goTo(offset: number): void;
  focus(): void;
}

const tocRefreshFacet = Facet.define<() => void, () => void>({
  combine: (values) => values.at(-1) ?? (() => {}),
});
const searchQueryFacet = Facet.define<string, string>({
  combine: (values) => values.at(-1) ?? '',
});
const searchHighlights = EditorView.decorations.compute([searchQueryFacet, 'doc'], (state) => {
  const query = state.facet(searchQueryFacet).trim();
  if (!query) return Decoration.none;
  const text = state.doc.toString();
  const haystack = text.toLocaleLowerCase();
  const needle = query.toLocaleLowerCase();
  const ranges = [];
  let match = haystack.indexOf(needle);
  while (match >= 0) {
    ranges.push(Decoration.mark({ class: 'cm-search-highlight' }).range(match, match + query.length));
    match = haystack.indexOf(needle, match + query.length);
  }
  return Decoration.set(ranges);
});

class LiveTextWidget extends WidgetType {
  constructor(private readonly text: string, private readonly className: string) { super(); }
  eq(other: LiveTextWidget) { return this.text === other.text && this.className === other.className; }
  toDOM() {
    const span = document.createElement('span');
    span.className = this.className;
    span.textContent = this.text;
    span.setAttribute('aria-hidden', 'true');
    return span;
  }
}

class LiveImageWidget extends WidgetType {
  constructor(private readonly src: string, private readonly alt: string) { super(); }
  eq(other: LiveImageWidget) { return this.src === other.src && this.alt === other.alt; }
  toDOM() {
    const image = document.createElement('img');
    image.className = 'cm-live-image';
    image.src = this.src;
    image.alt = this.alt;
    image.loading = 'lazy';
    return image;
  }
}

export function renderInlineMath(text: string): string {
  if (!text.includes('$')) return text;
  let result = text.replace(/(?<!\\)\$\$(.+?)(?<!\\)\$\$/g, (fullMatch, formula) => {
    try {
      return katex.renderToString(formula.trim(), { displayMode: true, throwOnError: false });
    } catch {
      return fullMatch;
    }
  });
  result = result.replace(/(?<!\\)\$(?!\$|\s)([^\$\r\n]+?)(?<!\s)\$(?!\$)/g, (fullMatch, formula) => {
    try {
      return katex.renderToString(formula.trim(), { displayMode: false, throwOnError: false });
    } catch {
      return fullMatch;
    }
  });
  return result;
}

class LiveMathWidget extends WidgetType {
  constructor(private readonly formula: string, private readonly display: boolean) { super(); }
  eq(other: LiveMathWidget) { return this.formula === other.formula && this.display === other.display; }
  toDOM() {
    const el = document.createElement(this.display ? 'div' : 'span');
    el.className = this.display ? 'cm-live-math-block' : 'cm-live-math-inline';
    el.title = this.display ? `$$${this.formula}$$` : `$${this.formula}$`;
    try {
      el.innerHTML = katex.renderToString(this.formula, {
        displayMode: this.display,
        throwOnError: false,
      });
    } catch {
      el.textContent = this.formula;
    }
    return el;
  }
}

class LiveTableWidget extends WidgetType {
  private static pendingFocus: { tableFrom: number; row: number; col: number } | null = null;

  constructor(
    private readonly rawText: string,
    private readonly table: ParsedTable,
    private readonly from: number,
    private readonly to: number,
  ) {
    super();
  }

  eq(other: LiveTableWidget) {
    return this.rawText === other.rawText;
  }

  ignoreEvent() {
    return true;
  }

  private dispatchUpdate(view: EditorView, newMarkdown: string, nextFocus?: { row: number; col: number }) {
    if (newMarkdown === this.rawText) return;
    if (nextFocus) {
      LiveTableWidget.pendingFocus = { tableFrom: this.from, row: nextFocus.row, col: nextFocus.col };
    }
    view.dispatch({
      changes: { from: this.from, to: this.to, insert: newMarkdown },
      scrollIntoView: false,
    });
  }

  toDOM(view: EditorView): HTMLElement {
    const container = document.createElement('div');
    container.className = 'cm-live-table-container';

    container.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) return;
      e.stopPropagation();
    });

    const scroll = document.createElement('div');
    scroll.className = 'cm-live-table-scroll';

    const tableEl = document.createElement('table');
    tableEl.className = 'cm-live-table';

    let localTable = { ...this.table };
    const inputs: HTMLInputElement[][] = [];

    const createInput = (value: string, r: number, c: number, placeholderText = ''): { input: HTMLInputElement; mathPreview: HTMLDivElement | null } => {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'cm-live-table-cell-input';
      if (r === -1) input.classList.add('cm-live-table-header-input');
      input.value = value;
      input.placeholder = placeholderText;
      const align = this.table.alignments[c];
      if (align) input.style.textAlign = align;

      let mathPreview: HTMLDivElement | null = null;
      const setupMathPreview = () => {
        if (!mathPreview) {
          mathPreview = document.createElement('div');
          mathPreview.className = 'cm-live-table-cell-math-preview';
          if (align) mathPreview.style.justifyContent = align === 'right' ? 'flex-end' : align === 'center' ? 'center' : 'flex-start';
          mathPreview.addEventListener('mousedown', (e) => e.stopPropagation());
          mathPreview.addEventListener('click', (e) => {
            e.stopPropagation();
            if (mathPreview) mathPreview.style.display = 'none';
            input.style.display = 'block';
            input.focus();
            input.select();
          });
          input.parentElement?.appendChild(mathPreview);
        }
        return mathPreview;
      };

      const initialMath = renderInlineMath(value);
      if (initialMath !== value) {
        input.style.display = 'none';
        mathPreview = document.createElement('div');
        mathPreview.className = 'cm-live-table-cell-math-preview';
        if (align) mathPreview.style.justifyContent = align === 'right' ? 'flex-end' : align === 'center' ? 'center' : 'flex-start';
        mathPreview.innerHTML = initialMath;
        mathPreview.addEventListener('mousedown', (e) => e.stopPropagation());
        mathPreview.addEventListener('click', (e) => {
          e.stopPropagation();
          if (mathPreview) mathPreview.style.display = 'none';
          input.style.display = 'block';
          input.focus();
          input.select();
        });
      }

      input.addEventListener('focus', () => {
        if (mathPreview) mathPreview.style.display = 'none';
        input.style.display = 'block';
      });

      let committed = false;
      const commit = () => {
        if (committed) return;
        const currentVal = r === -1 ? this.table.headers[c] : this.table.rows[r]?.[c] ?? '';
        if (input.value !== currentVal) {
          committed = true;
          localTable = setCell(localTable, r, c, input.value);
          const newMd = serializeMarkdownTable(localTable);
          this.dispatchUpdate(view, newMd);
        }
      };

      input.addEventListener('input', () => {
        localTable = setCell(localTable, r, c, input.value);
      });

      input.addEventListener('blur', () => {
        commit();
        const updatedMath = renderInlineMath(input.value);
        if (updatedMath !== input.value) {
          const el = setupMathPreview();
          el.innerHTML = updatedMath;
          el.style.display = 'flex';
          input.style.display = 'none';
        } else if (mathPreview) {
          mathPreview.style.display = 'none';
          input.style.display = 'block';
        }
      });

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') {
          e.preventDefault();
          commit();
          if (!e.shiftKey) {
            if (c < this.table.headers.length - 1) {
              const nextInput = inputs[r + 1]?.[c + 1];
              nextInput?.focus();
              nextInput?.select();
            } else if (r < this.table.rows.length - 1) {
              const nextInput = inputs[r + 2]?.[0];
              nextInput?.focus();
              nextInput?.select();
            } else {
              const updated = insertRow(localTable);
              const newMd = serializeMarkdownTable(updated);
              this.dispatchUpdate(view, newMd, { row: this.table.rows.length, col: 0 });
            }
          } else {
            if (c > 0) {
              const prevInput = inputs[r + 1]?.[c - 1];
              prevInput?.focus();
              prevInput?.select();
            } else if (r >= 0) {
              const prevInput = inputs[r]?.[this.table.headers.length - 1];
              prevInput?.focus();
              prevInput?.select();
            }
          }
        } else if (e.key === 'Enter') {
          e.preventDefault();
          commit();
          if (r < this.table.rows.length - 1) {
            const nextInput = inputs[r + 2]?.[c];
            nextInput?.focus();
            nextInput?.select();
          } else {
            const updated = insertRow(localTable);
            const newMd = serializeMarkdownTable(updated);
            this.dispatchUpdate(view, newMd, { row: this.table.rows.length, col: c });
          }
        } else if (e.key === 'ArrowUp') {
          if (r >= 0) {
            e.preventDefault();
            commit();
            const aboveInput = inputs[r]?.[c];
            aboveInput?.focus();
            aboveInput?.select();
          }
        } else if (e.key === 'ArrowDown') {
          if (r < this.table.rows.length - 1) {
            e.preventDefault();
            commit();
            const belowInput = inputs[r + 2]?.[c];
            belowInput?.focus();
            belowInput?.select();
          }
        }
      });

      return { input, mathPreview };
    };

    // Header
    const thead = document.createElement('thead');
    const headerTr = document.createElement('tr');
    const headerInputs: HTMLInputElement[] = [];

    this.table.headers.forEach((headerText, c) => {
      const th = document.createElement('th');
      const wrapper = document.createElement('div');
      wrapper.className = 'cm-live-table-cell-wrapper';

      const { input, mathPreview } = createInput(headerText, -1, c, t('table_header'));
      headerInputs.push(input);
      wrapper.appendChild(input);
      if (mathPreview) wrapper.appendChild(mathPreview);

      if (this.table.headers.length > 1) {
        const delColBtn = document.createElement('button');
        delColBtn.className = 'cm-live-table-col-del';
        delColBtn.type = 'button';
        delColBtn.title = t('delete_column');
        delColBtn.setAttribute('aria-label', t('delete_column'));
        delColBtn.textContent = '✕';
        delColBtn.addEventListener('mousedown', (e) => e.stopPropagation());
        delColBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const updated = deleteColumn(localTable, c);
          const newMd = serializeMarkdownTable(updated);
          this.dispatchUpdate(view, newMd);
        });
        wrapper.appendChild(delColBtn);
      }

      th.appendChild(wrapper);
      headerTr.appendChild(th);
    });

    inputs.push(headerInputs);

    // Header action cell (+ column)
    const addColTh = document.createElement('th');
    addColTh.className = 'cm-live-table-add-col-th';
    const addColBtn = document.createElement('button');
    addColBtn.className = 'cm-live-table-add-col-btn';
    addColBtn.type = 'button';
    addColBtn.title = t('add_column');
    addColBtn.setAttribute('aria-label', t('add_column'));
    addColBtn.textContent = '+ ' + t('add_column');
    addColBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    addColBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const updated = insertColumn(localTable);
      const newMd = serializeMarkdownTable(updated);
      this.dispatchUpdate(view, newMd, { row: -1, col: this.table.headers.length });
    });
    addColTh.appendChild(addColBtn);
    headerTr.appendChild(addColTh);
    thead.appendChild(headerTr);
    tableEl.appendChild(thead);

    // Body
    const tbody = document.createElement('tbody');
    this.table.rows.forEach((row, r) => {
      const tr = document.createElement('tr');
      const rowInputs: HTMLInputElement[] = [];

      this.table.headers.forEach((_, c) => {
        const td = document.createElement('td');
        const wrapper = document.createElement('div');
        wrapper.className = 'cm-live-table-cell-wrapper';

        const cellValue = row[c] ?? '';
        const { input, mathPreview } = createInput(cellValue, r, c);
        rowInputs.push(input);
        wrapper.appendChild(input);
        if (mathPreview) wrapper.appendChild(mathPreview);
        td.appendChild(wrapper);
        tr.appendChild(td);
      });

      // Delete row button
      const delRowTd = document.createElement('td');
      delRowTd.className = 'cm-live-table-row-del-td';
      const delRowBtn = document.createElement('button');
      delRowBtn.className = 'cm-live-table-row-del-btn';
      delRowBtn.type = 'button';
      delRowBtn.title = t('delete_row');
      delRowBtn.setAttribute('aria-label', t('delete_row'));
      delRowBtn.textContent = '✕';
      delRowBtn.addEventListener('mousedown', (e) => e.stopPropagation());
      delRowBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const updated = deleteRow(localTable, r);
        const newMd = serializeMarkdownTable(updated);
        this.dispatchUpdate(view, newMd);
      });
      delRowTd.appendChild(delRowBtn);
      tr.appendChild(delRowTd);

      inputs.push(rowInputs);
      tbody.appendChild(tr);
    });
    tableEl.appendChild(tbody);
    scroll.appendChild(tableEl);
    container.appendChild(scroll);

    // Footer (+ row)
    const footer = document.createElement('div');
    footer.className = 'cm-live-table-footer';
    const addRowBtn = document.createElement('button');
    addRowBtn.className = 'cm-live-table-add-row-btn';
    addRowBtn.type = 'button';
    addRowBtn.title = t('add_row');
    addRowBtn.setAttribute('aria-label', t('add_row'));
    addRowBtn.textContent = '+ ' + t('add_row');
    addRowBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    addRowBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const updated = insertRow(localTable);
      const newMd = serializeMarkdownTable(updated);
      this.dispatchUpdate(view, newMd, { row: this.table.rows.length, col: 0 });
    });
    footer.appendChild(addRowBtn);
    container.appendChild(footer);

    if (LiveTableWidget.pendingFocus && LiveTableWidget.pendingFocus.tableFrom === this.from) {
      const { row, col } = LiveTableWidget.pendingFocus;
      LiveTableWidget.pendingFocus = null;
      setTimeout(() => {
        const targetInput = inputs[row + 1]?.[col];
        if (targetInput) {
          targetInput.style.display = 'block';
          const preview = targetInput.parentElement?.querySelector<HTMLElement>('.cm-live-table-cell-math-preview');
          if (preview) preview.style.display = 'none';
          targetInput.focus();
          targetInput.select();
        }
      }, 0);
    }

    return container;
  }
}

class LiveTocWidget extends WidgetType {
  constructor(
    private readonly rawToc: string,
    private readonly from: number,
    private readonly to: number,
  ) {
    super();
  }

  eq(other: LiveTocWidget) {
    return this.rawToc === other.rawToc && this.from === other.from && this.to === other.to;
  }

  ignoreEvent() {
    return false;
  }

  toDOM(view: EditorView): HTMLElement {
    const card = document.createElement('nav');
    card.className = 'cm-live-toc-container markdown-toc-card';
    card.setAttribute('aria-label', t('note_toc'));

    const header = document.createElement('div');
    header.className = 'markdown-toc-header';

    const titleWrapper = document.createElement('div');
    titleWrapper.className = 'markdown-toc-title-wrapper';

    const icon = document.createElement('span');
    icon.className = 'markdown-toc-icon';
    icon.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M7 12h14"/><path d="M11 18h10"/><path d="M3 12h.01"/><path d="M3 18h.01"/></svg>';

    const title = document.createElement('span');
    title.className = 'markdown-toc-title';
    title.textContent = t('note_toc');

    titleWrapper.appendChild(icon);
    titleWrapper.appendChild(title);

    const actions = document.createElement('div');
    actions.className = 'markdown-toc-actions';

    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'markdown-toc-action-btn';
    refreshBtn.title = t('update_toc');
    refreshBtn.setAttribute('aria-label', t('update_toc'));
    refreshBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 21h5v-5"/></svg>';

    refreshBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    refreshBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const onRefresh = view.state.facet(tocRefreshFacet);
      if (onRefresh) {
        onRefresh();
      } else {
        const { content: updated, changed } = updateToc(view.state.doc.toString());
        if (changed) {
          view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: updated } });
        }
      }
    });

    actions.appendChild(refreshBtn);
    header.appendChild(titleWrapper);
    header.appendChild(actions);
    card.appendChild(header);

    const body = document.createElement('div');
    body.className = 'markdown-toc-body';

    const list = document.createElement('ul');
    list.className = 'markdown-toc-list';

    const lines = this.rawToc.split(/\r?\n/);
    const itemRegex = /^(\s*)[-+*]\s+\[([^\]]+)\]\((#[^)]+)\)/;

    const items: { depth: number; text: string; hash: string }[] = [];
    for (const line of lines) {
      const match = itemRegex.exec(line);
      if (match) {
        const indent = match[1].length;
        const itemText = match[2].replace(/\\([\[\]])/g, '$1');
        const hash = match[3];
        items.push({ depth: Math.floor(indent / 2), text: itemText, hash });
      }
    }

    if (items.length) {
      const badge = document.createElement('span');
      badge.className = 'markdown-toc-badge';
      badge.textContent = `${items.length}`;
      titleWrapper.appendChild(badge);
    }

    for (const item of items) {
      const li = document.createElement('li');
      li.className = `markdown-toc-item markdown-toc-depth-${item.depth}`;
      li.style.paddingLeft = `${item.depth * 16 + 8}px`;

      const dot = document.createElement('span');
      dot.className = 'markdown-toc-dot';

      const a = document.createElement('a');
      a.className = 'markdown-toc-link';
      a.href = item.hash;
      a.textContent = item.text;

      const clickHandler = (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const rawSlug = item.hash.slice(1);
        const slug = decodeURIComponent(rawSlug);
        const allHeadings = headings(view.state.doc.toString());
        const slugCounts = new Map<string, number>();
        let targetOffset: number | null = null;
        for (const h of allHeadings) {
          const base = slugify(h.text);
          const count = slugCounts.get(base) ?? 0;
          slugCounts.set(base, count + 1);
          const hSlug = count === 0 ? base : `${base}-${count}`;
          if (hSlug === slug || hSlug === rawSlug) {
            targetOffset = h.offset;
            break;
          }
        }
        if (targetOffset === null) {
          const fallback = allHeadings.find((h) => h.text === item.text);
          if (fallback) targetOffset = fallback.offset;
        }
        if (targetOffset !== null) {
          view.dispatch({
            selection: { anchor: targetOffset },
            scrollIntoView: true,
          });
          view.focus();
        }
      };

      li.addEventListener('mousedown', (e) => e.stopPropagation());
      li.addEventListener('click', clickHandler);

      li.appendChild(dot);
      li.appendChild(a);
      list.appendChild(li);
    }

    body.appendChild(list);
    card.appendChild(body);
    return card;
  }
}

function liveMarkdownDecorations(view: EditorView): { decorations: DecorationSet; replacements: DecorationSet } {
  const ranges: Range<Decoration>[] = [];
  const replacementRanges: Range<Decoration>[] = [];
  let fenced = false;
  let fenceMarker = '';

  const addReplacement = (from: number, to: number, widget?: WidgetType) => {
    if (to <= from) return;
    const range = Decoration.replace(widget ? { widget } : {}).range(from, to);
    ranges.push(range);
    replacementRanges.push(range);
  };
  const addInline = (lineFrom: number, text: string) => {
    const addPairs = (pattern: RegExp, className: string) => {
      for (const match of text.matchAll(pattern)) {
        const offset = match.index ?? 0;
        const marker = match[1];
        const content = match[2];
        const contentFrom = lineFrom + offset + marker.length;
        addReplacement(lineFrom + offset, contentFrom);
        ranges.push(Decoration.mark({ class: className }).range(contentFrom, contentFrom + content.length));
        addReplacement(contentFrom + content.length, contentFrom + content.length + marker.length);
      }
    };

    for (const match of text.matchAll(/!\[([^\]\r\n]*)\]\((\/api\/images\/[0-9a-f-]{36})\)/gi)) {
      const from = lineFrom + (match.index ?? 0);
      addReplacement(from, from + match[0].length, new LiveImageWidget(match[2], match[1]));
    }
    for (const match of text.matchAll(/\[([^\]\r\n]+)\]\(([^)\r\n]+)\)/g)) {
      const offset = match.index ?? 0;
      if (offset > 0 && text[offset - 1] === '!') continue;
      const labelFrom = lineFrom + offset + 1;
      addReplacement(lineFrom + offset, labelFrom);
      ranges.push(Decoration.mark({ class: 'cm-live-link' }).range(labelFrom, labelFrom + match[1].length));
      addReplacement(labelFrom + match[1].length, lineFrom + offset + match[0].length);
    }
    for (const match of text.matchAll(/\[\[([0-9a-f-]{36})\|([^\]\r\n]+)\]\]/gi)) {
      const offset = match.index ?? 0;
      const labelFrom = lineFrom + offset + match[1].length + 3;
      addReplacement(lineFrom + offset, labelFrom);
      ranges.push(Decoration.mark({ class: 'cm-live-link' }).range(labelFrom, labelFrom + match[2].length));
      addReplacement(labelFrom + match[2].length, lineFrom + offset + match[0].length);
    }
    addPairs(/(\*\*|__)(.+?)\1/g, 'cm-live-strong');
    addPairs(/(`)([^`\r\n]+)\1/g, 'cm-live-code');
    addPairs(/(?<!\*)(\*)(?!\*)([^*\r\n]+)\1(?!\*)/g, 'cm-live-emphasis');
    for (const match of text.matchAll(/(?<!\\|\$)\$(?!\$|\s)([^\$\r\n]+?)(?<!\s)\$(?!\$)/g)) {
      const offset = match.index ?? 0;
      const from = lineFrom + offset;
      const to = from + match[0].length;
      addReplacement(from, to, new LiveMathWidget(match[1], false));
    }
  };

  for (let number = 1; number <= view.state.doc.lines; number++) {
    const line = view.state.doc.line(number);
    const text = line.text;
    const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(text);
    if (fence) {
      ranges.push(Decoration.line({ class: 'cm-live-code-fence' }).range(line.from));
      addReplacement(line.from, line.to, new LiveTextWidget(fenced ? '' : fence[1][0] === '`' ? text.slice(fence[0].length).trim() : '', 'cm-live-code-language'));
      if (!fenced) { fenced = true; fenceMarker = fence[1][0]; }
      else if (fence[1][0] === fenceMarker) { fenced = false; fenceMarker = ''; }
      continue;
    }
    if (fenced) {
      ranges.push(Decoration.line({ class: 'cm-live-code-block' }).range(line.from));
      continue;
    }
    const trimmedLine = text.trim();
    if (!fenced && /^<!--\s*toc\s*-->/i.test(trimmedLine)) {
      let endLineNumber = number;
      while (endLineNumber <= view.state.doc.lines) {
        if (/<!--\s*(?:\/toc|tocstop)\s*-->/i.test(view.state.doc.line(endLineNumber).text.trim())) {
          break;
        }
        endLineNumber++;
      }
      number = endLineNumber;
      continue;
    }
    if (!fenced && number < view.state.doc.lines) {
      const lineText = text.trim();
      const nextLineText = view.state.doc.line(number + 1).text.trim();
      if (lineText.includes('|') && isDelimiterLine(nextLineText)) {
        let endLineNumber = number + 1;
        while (endLineNumber + 1 <= view.state.doc.lines) {
          const candidateLine = view.state.doc.line(endLineNumber + 1).text;
          const candidateTrimmed = candidateLine.trim();
          if (!candidateTrimmed || !candidateTrimmed.includes('|') ||
              /^(?:#{1,6}\s|[-*+]\s|>|`{3,}|~{3,})/.test(candidateTrimmed)) {
            break;
          }
          endLineNumber++;
        }
        number = endLineNumber;
        continue;
      }
    }
    const trimmedMathLine = text.trim();
    if (!fenced && trimmedMathLine.startsWith('$$')) {
      if (trimmedMathLine.length > 2 && trimmedMathLine.endsWith('$$')) {
        continue;
      }
      let endLineNumber = number + 1;
      while (endLineNumber <= view.state.doc.lines) {
        if (view.state.doc.line(endLineNumber).text.trim().endsWith('$$')) break;
        endLineNumber++;
      }
      if (endLineNumber <= view.state.doc.lines && view.state.doc.line(endLineNumber).text.trim().endsWith('$$')) {
        number = endLineNumber;
        continue;
      }
    }
    const heading = /^(#{1,6})\s+/.exec(text);
    if (heading) {
      addReplacement(line.from, line.from + heading[0].length);
      ranges.push(Decoration.line({ class: `cm-live-heading cm-live-h${heading[1].length}` }).range(line.from));
      addInline(line.from + heading[0].length, text.slice(heading[0].length));
      continue;
    }
    const task = /^(\s*)[-+*]\s+\[([ xX])\]\s+/.exec(text);
    if (task) {
      const markerFrom = line.from + task[1].length;
      addReplacement(markerFrom, line.from + task[0].length,
        new LiveTextWidget(task[2].toLowerCase() === 'x' ? '☑' : '☐', 'cm-live-task'));
      ranges.push(Decoration.line({ class: 'cm-live-list-line' }).range(line.from));
      addInline(line.from + task[0].length, text.slice(task[0].length));
      continue;
    }
    const bullet = /^(\s*)[-+*]\s+/.exec(text);
    if (bullet) {
      const markerFrom = line.from + bullet[1].length;
      addReplacement(markerFrom, line.from + bullet[0].length, new LiveTextWidget('•', 'cm-live-bullet'));
      ranges.push(Decoration.line({ class: 'cm-live-list-line' }).range(line.from));
      addInline(line.from + bullet[0].length, text.slice(bullet[0].length));
      continue;
    }
    const quote = /^\s{0,3}>\s?/.exec(text);
    if (quote) {
      addReplacement(line.from, line.from + quote[0].length);
      ranges.push(Decoration.line({ class: 'cm-live-quote' }).range(line.from));
      addInline(line.from + quote[0].length, text.slice(quote[0].length));
      continue;
    }
    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(text)) {
      addReplacement(line.from, line.to, new LiveTextWidget('', 'cm-live-rule'));
      continue;
    }
    if (!text.trim()) {
      ranges.push(Decoration.line({ class: 'cm-live-empty-line' }).range(line.from));
      continue;
    }
    addInline(line.from, text);
  }
  return {
    decorations: Decoration.set(ranges, true),
    replacements: Decoration.set(replacementRanges, true),
  };
}

function buildTableDecorations(state: EditorState): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  let fenced = false;
  let fenceMarker = '';

  for (let number = 1; number <= state.doc.lines; number++) {
    const line = state.doc.line(number);
    const text = line.text;
    const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(text);
    if (fence) {
      if (!fenced) { fenced = true; fenceMarker = fence[1][0]; }
      else if (fence[1][0] === fenceMarker) { fenced = false; fenceMarker = ''; }
      continue;
    }
    if (fenced) continue;

    if (number < state.doc.lines) {
      const lineText = text.trim();
      const nextLineText = state.doc.line(number + 1).text.trim();
      if (lineText.includes('|') && isDelimiterLine(nextLineText)) {
        const tableLines = [text, state.doc.line(number + 1).text];
        let endLineNumber = number + 1;
        while (endLineNumber + 1 <= state.doc.lines) {
          const candidateLine = state.doc.line(endLineNumber + 1).text;
          const candidateTrimmed = candidateLine.trim();
          if (!candidateTrimmed || !candidateTrimmed.includes('|') ||
              /^(?:#{1,6}\s|[-*+]\s|>|`{3,}|~{3,})/.test(candidateTrimmed)) {
            break;
          }
          tableLines.push(candidateLine);
          endLineNumber++;
        }
        const parsed = parseMarkdownTable(tableLines);
        if (parsed) {
          const tableStart = line.from;
          const tableEnd = state.doc.line(endLineNumber).to;
          const rawText = state.sliceDoc(tableStart, tableEnd);
          const widget = new LiveTableWidget(rawText, parsed, tableStart, tableEnd);
          decorations.push(Decoration.replace({ widget, block: true }).range(tableStart, tableEnd));
          number = endLineNumber;
          continue;
        }
      }
    }
  }

  return Decoration.set(decorations, true);
}

const tableField = StateField.define<DecorationSet>({
  create(state) {
    return buildTableDecorations(state);
  },
  update(decorations, transaction) {
    if (transaction.docChanged) {
      return buildTableDecorations(transaction.state);
    }
    return decorations;
  },
  provide: (field) => [
    EditorView.decorations.from(field),
    EditorView.atomicRanges.of((view) => view.state.field(field)),
  ],
});

function buildMathDecorations(state: EditorState): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  let fenced = false;
  let fenceMarker = '';

  for (let number = 1; number <= state.doc.lines; number++) {
    const line = state.doc.line(number);
    const text = line.text;
    const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(text);
    if (fence) {
      if (!fenced) { fenced = true; fenceMarker = fence[1][0]; }
      else if (fence[1][0] === fenceMarker) { fenced = false; fenceMarker = ''; }
      continue;
    }
    if (fenced) continue;

    const trimmed = text.trim();
    if (trimmed.startsWith('$$')) {
      if (trimmed.length > 2 && trimmed.endsWith('$$')) {
        const formula = trimmed.slice(2, -2).trim();
        if (formula) {
          const widget = new LiveMathWidget(formula, true);
          decorations.push(Decoration.replace({ widget, block: true }).range(line.from, line.to));
          continue;
        }
      }
      const startLine = number;
      let endLine = number;
      while (endLine + 1 <= state.doc.lines) {
        endLine++;
        if (state.doc.line(endLine).text.trim().endsWith('$$')) break;
      }
      if (endLine > startLine && state.doc.line(endLine).text.trim().endsWith('$$')) {
        const from = line.from;
        const to = state.doc.line(endLine).to;
        const formulaLines: string[] = [];
        for (let l = startLine + 1; l < endLine; l++) {
          formulaLines.push(state.doc.line(l).text);
        }
        const formula = formulaLines.join('\n').trim();
        if (formula) {
          const widget = new LiveMathWidget(formula, true);
          decorations.push(Decoration.replace({ widget, block: true }).range(from, to));
        }
        number = endLine;
        continue;
      }
    }
  }

  return Decoration.set(decorations, true);
}

const mathField = StateField.define<DecorationSet>({
  create(state) {
    return buildMathDecorations(state);
  },
  update(decorations, transaction) {
    if (transaction.docChanged) {
      return buildMathDecorations(transaction.state);
    }
    return decorations;
  },
  provide: (field) => [
    EditorView.decorations.from(field),
    EditorView.atomicRanges.of((view) => view.state.field(field)),
  ],
});

function buildTocDecorations(state: EditorState): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  let fenced = false;
  let fenceMarker = '';

  for (let number = 1; number <= state.doc.lines; number++) {
    const line = state.doc.line(number);
    const text = line.text;
    const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(text);
    if (fence) {
      if (!fenced) { fenced = true; fenceMarker = fence[1][0]; }
      else if (fence[1][0] === fenceMarker) { fenced = false; fenceMarker = ''; }
      continue;
    }
    if (fenced) continue;

    const trimmed = text.trim();
    if (/^<!--\s*toc\s*-->/i.test(trimmed)) {
      let endLine = number;
      while (endLine <= state.doc.lines) {
        if (/<!--\s*(?:\/toc|tocstop)\s*-->/i.test(state.doc.line(endLine).text.trim())) {
          break;
        }
        endLine++;
      }
      if (endLine <= state.doc.lines) {
        const from = line.from;
        const to = state.doc.line(endLine).to;
        const rawToc = state.sliceDoc(from, to);
        const widget = new LiveTocWidget(rawToc, from, to);
        decorations.push(Decoration.replace({ widget, block: true }).range(from, to));
        number = endLine;
        continue;
      }
    }
  }

  return Decoration.set(decorations, true);
}

const tocField = StateField.define<DecorationSet>({
  create(state) {
    return buildTocDecorations(state);
  },
  update(decorations, transaction) {
    if (transaction.docChanged) {
      return buildTocDecorations(transaction.state);
    }
    return decorations;
  },
  provide: (field) => [
    EditorView.decorations.from(field),
    EditorView.atomicRanges.of((view) => view.state.field(field)),
  ],
});

const liveMarkdown = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  replacements: DecorationSet;
  constructor(view: EditorView) {
    const result = liveMarkdownDecorations(view);
    this.decorations = result.decorations;
    this.replacements = result.replacements;
  }
  update(update: ViewUpdate) {
    if (update.docChanged) {
      const result = liveMarkdownDecorations(update.view);
      this.decorations = result.decorations;
      this.replacements = result.replacements;
    }
  }
}, {
  decorations: (value) => value.decorations,
  provide: (plugin) => EditorView.atomicRanges.of((view) => view.plugin(plugin)?.replacements ?? Decoration.none),
});

type LegacyCaretDocument = Document & {
  caretRangeFromPoint?(x: number, y: number): { startContainer: Node; startOffset: number } | null;
};

function editorPositionAtPointer(editorView: EditorView, event: MouseEvent): number | null {
  const owner = editorView.dom.ownerDocument;
  const caret = owner.caretPositionFromPoint?.(event.clientX, event.clientY);
  const node = caret?.offsetNode;
  if (node && editorView.contentDOM.contains(node)) {
    try { return editorView.posAtDOM(node, caret.offset); } catch { /* Fall back to coordinate mapping. */ }
  }
  const range = (owner as LegacyCaretDocument).caretRangeFromPoint?.(event.clientX, event.clientY);
  if (range && editorView.contentDOM.contains(range.startContainer)) {
    try { return editorView.posAtDOM(range.startContainer, range.startOffset); } catch { /* Fall back to coordinate mapping. */ }
  }
  return editorView.posAtCoords({ x: event.clientX, y: event.clientY });
}

function toggleEmphasis(marker: '*' | '**') {
  return (editor: EditorView): boolean => {
    const range = editor.state.selection.main;
    if (range.empty) {
      editor.dispatch({
        changes: { from: range.from, insert: `${marker}${marker}` },
        selection: { anchor: range.from + marker.length },
        scrollIntoView: true,
      });
      return true;
    }
    const document = editor.state.doc;
    let before = 0;
    let after = 0;
    while (range.from - before > 0 && document.sliceString(range.from - before - 1, range.from - before) === '*') before++;
    while (range.to + after < document.length && document.sliceString(range.to + after, range.to + after + 1) === '*') after++;
    const active = marker === '*' ? before % 2 === 1 && after % 2 === 1 : before >= 2 && after >= 2;
    if (active) {
      editor.dispatch({
        changes: [
          { from: range.from - marker.length, to: range.from },
          { from: range.to, to: range.to + marker.length },
        ],
        selection: { anchor: range.from - marker.length, head: range.to - marker.length },
        scrollIntoView: true,
      });
    } else {
      editor.dispatch({
        changes: [
          { from: range.from, insert: marker },
          { from: range.to, insert: marker },
        ],
        selection: { anchor: range.from + marker.length, head: range.to + marker.length },
        scrollIntoView: true,
      });
    }
    return true;
  };
}

export const Editor = forwardRef<EditorHandle, Props>(function Editor({
  value,
  mode = 'markdown',
  onChange,
  onImages,
  onSubmit,
  onTogglePreview,
  onShowShortcuts,
  searchQuery = '',
  onRefreshToc,
}, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const search = useRef(new Compartment());
  const presentation = useRef(new Compartment());
  const callbacks = useRef({ onChange, onImages, onSubmit, onTogglePreview, onShowShortcuts, onRefreshToc });
  const modeRef = useRef(mode);
  const insertions = useRef(new Map<string, number>());
  callbacks.current = { onChange, onImages, onSubmit, onTogglePreview, onShowShortcuts, onRefreshToc };
  modeRef.current = mode;
  const external = useRef(false);

  const markInsertion = (position?: number) => {
    const id = crypto.randomUUID();
    insertions.current.set(id, position ?? view.current?.state.selection.main.head ?? 0);
    return id;
  };

  useImperativeHandle(ref, () => ({
    markInsertion,
    insertAt(insertion, text) {
      const editor = view.current;
      const marked = insertions.current.get(insertion);
      if (!editor || marked === undefined) return false;
      const position = Math.min(marked, editor.state.doc.length);
      const before = position > 0 && editor.state.doc.sliceString(position - 1, position) !== '\n' ? '\n\n' : '';
      const after = position < editor.state.doc.length && editor.state.doc.sliceString(position, position + 1) !== '\n' ? '\n\n' : '\n';
      const inserted = `${before}${text}${after}`;
      editor.dispatch({
        changes: { from: position, insert: inserted },
        selection: { anchor: position + inserted.length },
        scrollIntoView: true,
      });
      insertions.current.set(insertion, position + inserted.length);
      editor.focus();
      return true;
    },
    releaseInsertion(insertion) { insertions.current.delete(insertion); },
    cursor() { return view.current?.state.selection.main.head ?? 0; },
    goTo(offset) {
      const editor = view.current;
      if (!editor) return;
      const position = Math.max(0, Math.min(offset, editor.state.doc.length));
      editor.dispatch({ selection: { anchor: position }, scrollIntoView: true });
      editor.focus();
    },
    focus() { view.current?.focus(); },
  }), []);

  useEffect(() => {
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          markdown(), history(), keymap.of([
            { key: 'Mod-b', run: toggleEmphasis('**') },
            { key: 'Mod-i', run: toggleEmphasis('*') },
            { key: 'Ctrl-e', run: () => { callbacks.current.onTogglePreview(); return true; } },
            { key: 'Meta-e', run: () => { callbacks.current.onTogglePreview(); return true; } },
            { key: 'Mod-Enter', run: () => { (callbacks.current.onSubmit ?? callbacks.current.onTogglePreview)(); return true; } },
            { key: 'Mod-/', run: () => { callbacks.current.onShowShortcuts(); return true; } },
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.lineWrapping, placeholder(t('start_writing')),
          search.current.of(searchQueryFacet.of(searchQuery)),
          searchHighlights,
          tocRefreshFacet.of(() => callbacks.current.onRefreshToc?.()),
          presentation.current.of(mode === 'live' ? [liveMarkdown, tableField, mathField, tocField] : []),
          EditorView.contentAttributes.of({
            'aria-label': t('note_content'),
            'aria-keyshortcuts': 'Meta+B Control+B Meta+I Control+I Meta+E Control+E Meta+Enter Control+Enter Meta+/ Control+/',
            spellcheck: 'false',
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              for (const [id, position] of insertions.current) {
                insertions.current.set(id, update.changes.mapPos(position, -1));
              }
            }
            if (update.docChanged && !external.current) callbacks.current.onChange(update.state.doc.toString());
          }),
          EditorView.domEventHandlers({
            mousedown(event, editorView) {
              if (modeRef.current !== 'live' || event.button !== 0 || event.detail !== 1 ||
                  event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false;
              if (event.target instanceof Element && event.target.closest('.cm-live-table-container, .cm-live-toc-container')) return false;
              const position = editorPositionAtPointer(editorView, event);
              if (position === null) return false;
              event.preventDefault();
              editorView.dispatch({ selection: { anchor: position }, scrollIntoView: true });
              editorView.focus();
              return true;
            },
            paste(event) {
              const files = Array.from(event.clipboardData?.files ?? []);
              if (!files.length || !callbacks.current.onImages) return false;
              event.preventDefault();
              callbacks.current.onImages(files, markInsertion());
              return true;
            },
            drop(event, editorView) {
              const files = Array.from(event.dataTransfer?.files ?? []);
              if (!files.length || !callbacks.current.onImages) return false;
              event.preventDefault();
              callbacks.current.onImages(files, markInsertion(editorView.posAtCoords({ x: event.clientX, y: event.clientY }) ?? undefined));
              return true;
            },
            dragover(event) { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); },
          }),
        ],
      }),
    });
    view.current = editor;
    return () => { editor.destroy(); view.current = null; insertions.current.clear(); };
  }, []);

  useEffect(() => {
    const editor = view.current;
    if (!editor || editor.state.doc.toString() === value) return;
    external.current = true;
    const prevSel = editor.state.selection;
    const oldText = editor.state.doc.toString();
    let prefix = 0;
    while (prefix < oldText.length && prefix < value.length && oldText[prefix] === value[prefix]) {
      prefix++;
    }
    let suffixOld = oldText.length;
    let suffixNew = value.length;
    while (suffixOld > prefix && suffixNew > prefix && oldText[suffixOld - 1] === value[suffixNew - 1]) {
      suffixOld--;
      suffixNew--;
    }
    const changes = {
      from: prefix,
      to: suffixOld,
      insert: value.slice(prefix, suffixNew),
    };
    editor.dispatch({
      changes,
      selection: prevSel.map(editor.state.changes(changes)),
    });
    external.current = false;
  }, [value]);
  useEffect(() => {
    view.current?.dispatch({ effects: search.current.reconfigure(searchQueryFacet.of(searchQuery)) });
  }, [searchQuery]);
  useEffect(() => {
    view.current?.dispatch({ effects: presentation.current.reconfigure(mode === 'live' ? [liveMarkdown, tableField, mathField, tocField] : []) });
  }, [mode]);
  return <div className={`code-editor ${mode === 'live' ? 'live-markdown-editor' : 'source-markdown-editor'}`} ref={host} />;
});

function mathPlugin(md: MarkdownIt) {
  md.inline.ruler.after('backticks', 'math_inline', (state, silent) => {
    if (state.src.charCodeAt(state.pos) !== 0x24 /* $ */) return false;

    const isDouble = state.src.charCodeAt(state.pos + 1) === 0x24;
    const delim = isDouble ? '$$' : '$';
    const delimLen = delim.length;
    const start = state.pos + delimLen;

    if (!isDouble) {
      const nextChar = state.src.charCodeAt(start);
      if (nextChar === 0x20 || nextChar === 0x09 || nextChar === 0x0a || nextChar === 0x0d) {
        return false;
      }
    }

    let match = -1;
    let pos = start;
    while ((pos = state.src.indexOf(delim, pos)) !== -1) {
      let backslashes = 0;
      let checkPos = pos - 1;
      while (checkPos >= start && state.src.charCodeAt(checkPos) === 0x5c /* \ */) {
        backslashes++;
        checkPos--;
      }
      if (backslashes % 2 === 0) {
        if (!isDouble) {
          const prevChar = state.src.charCodeAt(pos - 1);
          if (prevChar === 0x20 || prevChar === 0x09 || prevChar === 0x0a || prevChar === 0x0d) {
            pos += delimLen;
            continue;
          }
        }
        match = pos;
        break;
      }
      pos += delimLen;
    }

    if (match === -1) return false;

    const content = state.src.slice(start, match).trim();
    if (!content) return false;
    if (!isDouble && content.includes('\n')) return false;

    if (!silent) {
      const token = state.push(isDouble ? 'math_block' : 'math_inline', 'math', 0);
      token.content = content;
      token.markup = delim;
    }
    state.pos = match + delimLen;
    return true;
  });

  md.block.ruler.after('blockquote', 'math_block', (state, startLine, endLine, silent) => {
    let pos = state.bMarks[startLine] + state.tShift[startLine];
    let max = state.eMarks[startLine];

    if (pos + 2 > max) return false;
    if (state.src.slice(pos, pos + 2) !== '$$') return false;

    pos += 2;
    const firstLine = state.src.slice(pos, max);

    if (silent) return true;

    let haveEndMarker = false;
    let nextLine = startLine;

    const trimmedFirst = firstLine.trim();
    if (trimmedFirst.length >= 2 && trimmedFirst.endsWith('$$')) {
      haveEndMarker = true;
    }

    while (!haveEndMarker) {
      nextLine++;
      if (nextLine >= endLine) break;

      pos = state.bMarks[nextLine] + state.tShift[nextLine];
      max = state.eMarks[nextLine];

      if (pos < max && state.tShift[nextLine] < state.blkIndent) break;

      const lineContent = state.src.slice(pos, max).trim();
      if (lineContent === '$$' || lineContent.endsWith('$$')) {
        haveEndMarker = true;
      }
    }

    state.line = nextLine + (haveEndMarker ? 1 : 0);

    const token = state.push('math_block', 'math', 0);
    token.block = true;
    if (haveEndMarker && nextLine === startLine) {
      token.content = trimmedFirst.slice(0, -2).trim();
    } else {
      token.content = state.getLines(startLine + 1, nextLine, state.tShift[startLine], false).trim();
    }
    token.map = [startLine, state.line];
    token.markup = '$$';
    return true;
  }, {
    alt: ['paragraph', 'reference', 'blockquote', 'list'],
  });

  md.renderer.rules.math_inline = (tokens, index) => {
    const source = md.utils.escapeHtml(tokens[index].content);
    return `<span data-katex-source="${source}"></span>`;
  };
  md.renderer.rules.math_block = (tokens, index) => {
    const source = md.utils.escapeHtml(tokens[index].content);
    return `<div data-katex-display="true" data-katex-source="${source}"></div>\n`;
  };
}

function tocMarkdownPlugin(md: MarkdownIt) {
  md.block.ruler.before('html_block', 'toc_block', (state, startLine, endLine, silent) => {
    const pos = state.bMarks[startLine] + state.tShift[startLine];
    const max = state.eMarks[startLine];
    const line = state.src.slice(pos, max).trim();
    if (!/^<!--\s*toc\s*-->/i.test(line)) return false;

    if (silent) return true;

    let nextLine = startLine + 1;
    let haveEnd = false;
    while (nextLine < endLine) {
      const p = state.bMarks[nextLine] + state.tShift[nextLine];
      const m = state.eMarks[nextLine];
      const l = state.src.slice(p, m).trim();
      if (/<!--\s*(?:\/toc|tocstop)\s*-->/i.test(l)) {
        haveEnd = true;
        break;
      }
      nextLine++;
    }

    const endLineNum = haveEnd ? nextLine + 1 : nextLine;

    const openToken = state.push('toc_container_open', 'nav', 1);
    openToken.attrSet('data-toc-container', 'true');
    openToken.block = true;

    const oldParentType = state.parentType;
    state.parentType = 'root';
    state.md.block.tokenize(state, startLine + 1, nextLine);
    state.parentType = oldParentType;

    const closeToken = state.push('toc_container_close', 'nav', -1);
    closeToken.block = true;

    state.line = endLineNum;
    return true;
  });

  md.renderer.rules.toc_container_open = (tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options);
  md.renderer.rules.toc_container_close = (tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options);
}

const renderer = new MarkdownIt({ html: true, linkify: true, breaks: true })
  .use(footnote)
  .use(mathPlugin)
  .use(tocMarkdownPlugin);
renderer.core.ruler.after('block', 'source_lines', (state) => {
  for (const token of state.tokens) {
    if (token.map && token.nesting === 1) token.attrSet('data-source-line', String(token.map[0]));
  }
});
renderer.core.ruler.push('heading_slugs', (state) => {
  const slugCounts = new Map<string, number>();
  for (let i = 0; i < state.tokens.length; i++) {
    if (state.tokens[i].type === 'heading_open') {
      const inlineToken = state.tokens[i + 1];
      const text = inlineToken ? inlineToken.content : '';
      const base = slugify(text);
      const count = slugCounts.get(base) ?? 0;
      slugCounts.set(base, count + 1);
      const slug = count === 0 ? base : `${base}-${count}`;
      state.tokens[i].attrSet('data-heading-slug', slug);
    }
  }
});
const defaultText = renderer.renderer.rules.text;
renderer.renderer.rules.text = (tokens, index, options, env, self) => {
  const rendered = defaultText
    ? defaultText(tokens, index, options, env, self)
    : renderer.utils.escapeHtml(tokens[index].content);
  return rendered.replace(/\[\[([0-9a-f-]{36})\|([^\]\r\n]{1,256})\]\]/gi, (source, id: string, label: string) =>
    idPattern.test(id) ? `<a href="#note-${id}" data-note-id="${id}">${label}</a>` : source);
};
renderer.renderer.rules.fence = (tokens, index) => {
  const token = tokens[index];
  const language = token.info.trim().split(/\s+/, 1)[0].toLowerCase();
  const sourceLine = token.map ? ` data-source-line="${token.map[0]}"` : '';
  const source = renderer.utils.escapeHtml(token.content);
  if (language === 'mermaid') {
    return `<div data-mermaid-source="true"${sourceLine}><pre><code>${source}</code></pre></div>`;
  }
  return `<pre${sourceLine}><code data-code-language="${renderer.utils.escapeHtml(language)}">${source}</code></pre>\n`;
};
renderer.renderer.rules.code_block = (tokens, index) => {
  const token = tokens[index];
  const sourceLine = token.map ? ` data-source-line="${token.map[0]}"` : '';
  return `<pre${sourceLine}><code data-code-language="">${renderer.utils.escapeHtml(token.content)}</code></pre>\n`;
};
renderer.renderer.rules.image = (tokens, index) => {
  const token = tokens[index];
  const src = token.attrGet('src') ?? '';
  const id = /^(?:\/api\/images\/|\/api\/public\/shares\/[a-f0-9]{64}\/images\/)([0-9a-f-]{36})$/i.exec(src)?.[1];
  if (!id || !idPattern.test(id)) return `<span class="blocked-image">${t('[外部图片未加载]')}</span>`;
  return `<img src="${src}" data-private-image="${id}" alt="${renderer.utils.escapeHtml(token.content)}" loading="lazy" />`;
};
renderer.renderer.rules.link_open = (tokens, index, options, _env, self) => {
  const href = tokens[index].attrGet('href') ?? '';
  const id = /^(?:\/api\/files\/|\/api\/public\/shares\/[a-f0-9]{64}\/files\/)([0-9a-f-]{36})$/i.exec(href)?.[1];
  if (id && idPattern.test(id)) {
    tokens[index].attrSet('data-private-file', id);
    tokens[index].attrSet('download', '');
  } else {
    tokens[index].attrSet('target', '_blank');
    tokens[index].attrSet('rel', 'noopener noreferrer');
  }
  return self.renderToken(tokens, index, options);
};
renderer.renderer.rules.footnote_ref = (tokens, index) => {
  const number = Number(tokens[index].meta.id) + 1;
  const subId = Number(tokens[index].meta.subId ?? 0);
  const reference = subId > 0 ? `${number}:${subId}` : String(number);
  return `<sup><a href="#footnote-${number}" data-footnote-ref="${number}" data-footnote-reference="${reference}">[${reference}]</a></sup>`;
};
renderer.renderer.rules.footnote_block_open = () =>
  '<hr data-footnotes-separator>\n<section data-footnotes>\n<ol>\n';
renderer.renderer.rules.footnote_block_close = () => '</ol>\n</section>\n';
renderer.renderer.rules.footnote_open = (tokens, index) => {
  const number = Number(tokens[index].meta.id) + 1;
  return `<li data-footnote-id="${number}">`;
};
renderer.renderer.rules.footnote_close = () => '</li>\n';
renderer.renderer.rules.footnote_anchor = (tokens, index) => {
  const number = Number(tokens[index].meta.id) + 1;
  const subId = Number(tokens[index].meta.subId ?? 0);
  const reference = subId > 0 ? `${number}:${subId}` : String(number);
  return ` <a href="#footnote-ref-${reference}" data-footnote-backref="${reference}" aria-label="${t('返回脚注引用')}">↩︎</a>`;
};

export function toggleMarkdownTask(content: string, taskIndex: number, checked: boolean): string {
  let index = 0;
  return content.replace(/^(\s*[-+*]\s+)\[([ xX]?)\](?=\s|$)/gm, (source, prefix: string) => {
    if (index++ !== taskIndex) return source;
    return `${prefix}[${checked ? 'x' : ' '}]`;
  });
}

function highlightRenderedText(root: HTMLElement, query: string) {
  const needle = query.trim();
  if (!needle) return;
  const normalizedNeedle = needle.toLocaleLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const matches: Text[] = [];
  let current = walker.nextNode();
  while (current) {
    const text = current as Text;
    if (text.parentElement && !text.parentElement.closest('svg, .katex, .search-highlight') &&
        text.data.toLocaleLowerCase().includes(normalizedNeedle)) matches.push(text);
    current = walker.nextNode();
  }
  for (const text of matches) {
    const haystack = text.data.toLocaleLowerCase();
    const fragment = document.createDocumentFragment();
    let offset = 0;
    let match = haystack.indexOf(normalizedNeedle);
    while (match >= 0) {
      if (match > offset) fragment.append(text.data.slice(offset, match));
      const mark = document.createElement('mark');
      mark.className = 'search-highlight';
      mark.textContent = text.data.slice(match, match + needle.length);
      fragment.append(mark);
      offset = match + needle.length;
      match = haystack.indexOf(normalizedNeedle, offset);
    }
    if (offset < text.data.length) fragment.append(text.data.slice(offset));
    text.replaceWith(fragment);
  }
}

function renderMarkdown(content: string, interactiveTasks: boolean, searchQuery: string, canRefreshToc = false): string {
  const clean = DOMPurify.sanitize(renderer.render(content), {
    USE_PROFILES: { html: true },
    ADD_TAGS: ['nav'],
    ADD_ATTR: [
      'target', 'download', 'data-source-line', 'data-code-language', 'data-mermaid-source',
      'data-note-id', 'data-private-image', 'data-private-file', 'data-footnotes',
      'data-footnotes-separator', 'data-footnote-id', 'data-footnote-ref',
      'data-footnote-reference', 'data-footnote-backref',
      'data-katex-source', 'data-katex-display', 'data-heading-slug',
      'data-toc-container', 'data-toc-action',
    ],
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: [
      'style', 'script', 'iframe', 'form', 'input', 'button', 'select', 'option', 'textarea',
      'object', 'embed', 'link', 'meta', 'base', 'video', 'audio', 'source', 'track',
    ],
    FORBID_ATTR: ['style', 'srcset', 'id', 'name', 'class'],
  });
  const parsed = new DOMParser().parseFromString(clean, 'text/html');
  parsed.body.querySelectorAll<HTMLElement>('[data-toc-container]').forEach((container) => {
    container.className = 'markdown-toc-card';
    const header = parsed.createElement('div');
    header.className = 'markdown-toc-header';

    const titleWrapper = parsed.createElement('div');
    titleWrapper.className = 'markdown-toc-title-wrapper';

    const icon = parsed.createElement('span');
    icon.className = 'markdown-toc-icon';
    icon.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M7 12h14"/><path d="M11 18h10"/><path d="M3 12h.01"/><path d="M3 18h.01"/></svg>';

    const title = parsed.createElement('span');
    title.className = 'markdown-toc-title';
    title.textContent = t('note_toc');

    titleWrapper.appendChild(icon);
    titleWrapper.appendChild(title);

    const itemsCount = container.querySelectorAll('li').length;
    if (itemsCount > 0) {
      const badge = parsed.createElement('span');
      badge.className = 'markdown-toc-badge';
      badge.textContent = `${itemsCount}`;
      titleWrapper.appendChild(badge);
    }

    header.appendChild(titleWrapper);

    if (canRefreshToc) {
      const actions = parsed.createElement('div');
      actions.className = 'markdown-toc-actions';

      const refreshBtn = parsed.createElement('button');
      refreshBtn.type = 'button';
      refreshBtn.className = 'markdown-toc-action-btn';
      refreshBtn.setAttribute('data-toc-action', 'refresh');
      refreshBtn.title = t('update_toc');
      refreshBtn.setAttribute('aria-label', t('update_toc'));
      refreshBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 21h5v-5"/></svg>';

      actions.appendChild(refreshBtn);
      header.appendChild(actions);
    }

    const body = parsed.createElement('div');
    body.className = 'markdown-toc-body';
    while (container.firstChild) {
      body.appendChild(container.firstChild);
    }

    container.appendChild(header);
    container.appendChild(body);
  });
  parsed.body.querySelectorAll('img').forEach((image) => {
    const src = image.getAttribute('src') ?? '';
    const id = /^(?:\/api\/images\/|\/api\/public\/shares\/[a-f0-9]{64}\/images\/)([0-9a-f-]{36})$/i.exec(src)?.[1];
    if (id && idPattern.test(id)) {
      image.setAttribute('loading', 'lazy');
      image.setAttribute('data-private-image', id);
      return;
    }
    const replacement = parsed.createElement('span');
    replacement.className = 'blocked-image';
    replacement.textContent = t('[外部图片未加载]');
    image.replaceWith(replacement);
  });
  parsed.body.querySelectorAll<HTMLAnchorElement>('a').forEach((link) => {
    if (link.dataset.footnoteRef || link.dataset.footnoteBackref) {
      link.removeAttribute('target');
      link.removeAttribute('rel');
      return;
    }
    const noteId = link.dataset.noteId;
    if (noteId && idPattern.test(noteId)) {
      link.href = `#note-${noteId}`;
      link.removeAttribute('target');
      link.removeAttribute('rel');
      return;
    }
    const fileId = /^(?:\/api\/files\/|\/api\/public\/shares\/[a-f0-9]{64}\/files\/)([0-9a-f-]{36})$/i
      .exec(link.getAttribute('href') ?? '')?.[1];
    if (fileId && idPattern.test(fileId)) {
      link.dataset.privateFile = fileId;
      link.setAttribute('download', '');
      link.removeAttribute('target');
      link.removeAttribute('rel');
      const text = link.textContent?.trim() || '';
      const href = link.getAttribute('href') || '';
      const isPdf = /\.pdf$/i.test(text) || /\.pdf$/i.test(href);
      const isTxt = /\.txt$/i.test(text) || /\.txt$/i.test(href);
      if (isPdf || isTxt) {
        link.classList.add(isPdf ? 'doc-link-pdf' : 'doc-link-txt');
        link.dataset.docType = isPdf ? 'pdf' : 'txt';
        link.dataset.docFilename = text;
      }
      return;
    }
    const href = link.getAttribute('href') ?? '';
    if (href.startsWith('#')) {
      link.removeAttribute('target');
      link.removeAttribute('rel');
      return;
    }
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer');
  });
  let taskIndex = 0;
  parsed.body.querySelectorAll<HTMLLIElement>('li').forEach((item) => {
    const holder = item.firstElementChild?.tagName === 'P' ? item.firstElementChild : item;
    const text = [...holder.childNodes].find((node) => node.nodeType === Node.TEXT_NODE);
    const match = /^(\s*)\[([ xX]?)\](?:\s+|$)/.exec(text?.textContent ?? '');
    if (!text || !match) return;
    const checked = match[2].toLocaleLowerCase() === 'x';
    text.textContent = `${match[1]}${text.textContent!.slice(match[0].length)}`;
    const checkbox = parsed.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.taskIndex = String(taskIndex++);
    checkbox.setAttribute('aria-label', t('待办事项：{0}', item.textContent?.trim() || t('未命名')));
    if (checked) {
      checkbox.checked = true;
      checkbox.setAttribute('checked', '');
      item.classList.add('done');
    }
    if (!interactiveTasks) checkbox.disabled = true;
    item.classList.add('task-list-item');
    item.parentElement?.classList.add('task-list');
    holder.insertBefore(checkbox, holder.firstChild);
  });
  parsed.body.querySelectorAll<HTMLElement>('[data-katex-source]').forEach((node) => {
    const source = node.getAttribute('data-katex-source') ?? '';
    const isDisplay = node.getAttribute('data-katex-display') === 'true';
    const wrapper = parsed.createElement(isDisplay ? 'div' : 'span');
    wrapper.className = isDisplay ? 'katex-display-wrapper' : 'katex-inline-wrapper';
    wrapper.setAttribute('data-katex-source', source);
    wrapper.setAttribute('data-katex-display', isDisplay ? 'true' : 'false');
    try {
      wrapper.innerHTML = katex.renderToString(source, {
        displayMode: isDisplay,
        throwOnError: false,
      });
    } catch {
      wrapper.textContent = source;
    }
    node.replaceWith(wrapper);
  });
  highlightRenderedText(parsed.body, searchQuery);
  return parsed.body.innerHTML;
}

function diagramError(element: HTMLElement, error: unknown) {
  element.className = 'mermaid-error';
  element.removeAttribute('data-mermaid-source');
  element.textContent = t('图表无法渲染：{0}', String(error).split('\n', 1)[0]);
}

function fitDiagramToContainer(element: HTMLElement) {
  const svg = element.querySelector<SVGSVGElement>('svg');
  const width = svg?.viewBox.baseVal.width ?? 0;
  if (!svg || width <= 0) return;
  svg.style.width = `${Math.ceil(width)}px`;
  svg.style.maxWidth = '100%';
  svg.style.height = 'auto';
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function Preview({
  content,
  userId,
  onImage,
  onNote,
  onFile,
  onViewDocument,
  onInsertToNote,
  onCreateNoteFromContent,
  onTask,
  resolveFile,
  dark = false,
  eagerImages = false,
  onEditLine,
  searchQuery = '',
  onRefreshToc,
}: {
  content: string;
  userId?: string;
  onImage(src: string): void;
  onNote?(id: string): void;
  onFile?(id: string, href: string): void;
  onViewDocument?(file: { id?: string; url: string; filename: string; type: 'pdf' | 'txt' }): void;
  onInsertToNote?(markdown: string): void;
  onCreateNoteFromContent?(title: string, markdown: string): void;
  onTask?(index: number, checked: boolean): void;
  resolveFile?(id: string): Promise<string | null>;
  dark?: boolean;
  eagerImages?: boolean;
  onEditLine?(line: number): void;
  searchQuery?: string;
  onRefreshToc?(): void;
}) {
  const host = useRef<HTMLElement>(null);
  const embeddedDocs = useMemo(() => {
    const matches = Array.from(content.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g));
    const docs: { id?: string; url: string; filename: string; type: 'pdf' | 'txt' }[] = [];
    for (const m of matches) {
      const filename = m[1]?.trim() || '';
      const href = m[2]?.trim() || '';
      const isPdf = /\.pdf$/i.test(filename) || /\.pdf$/i.test(href);
      const isTxt = /\.txt$/i.test(filename) || /\.txt$/i.test(href);
      if (!isPdf && !isTxt) continue;
      const fileId = /^(?:\/api\/files\/|\/api\/public\/shares\/[a-f0-9]{64}\/files\/)([0-9a-f-]{36})$/i
        .exec(href)?.[1];
      docs.push({
        id: fileId && idPattern.test(fileId) ? fileId : undefined,
        url: href,
        filename,
        type: isPdf ? 'pdf' : 'txt',
      });
    }
    return docs;
  }, [content]);

  // Strip duplicate H1 heading matching document name and embedded doc links from preview
  const { cleanedContent, hasOtherText } = useMemo(() => {
    if (!embeddedDocs.length) return { cleanedContent: content, hasOtherText: true };
    let res = content;
    for (const doc of embeddedDocs) {
      const rawTitle = doc.filename.replace(/\.[^.]+$/, '').trim();
      const headingRegex = new RegExp(`^#\\s+${escapeRegex(rawTitle)}\\s*\\r?\\n*`, 'im');
      res = res.replace(headingRegex, '');
      const headingRegexFull = new RegExp(`^#\\s+${escapeRegex(doc.filename)}\\s*\\r?\\n*`, 'im');
      res = res.replace(headingRegexFull, '');

      // Strip document links corresponding to embedded documents so the preview moves up and removes redundant link pill
      if (doc.id) {
        const idRegex = new RegExp(`\\[[^\\]]*\\]\\([^)]*${escapeRegex(doc.id)}[^)]*\\)\\r?\\n*`, 'gi');
        res = res.replace(idRegex, '');
      }
      if (doc.url) {
        const urlRegex = new RegExp(`\\[[^\\]]*\\]\\(${escapeRegex(doc.url)}\\)\\r?\\n*`, 'gi');
        res = res.replace(urlRegex, '');
      }
      const fileRegex = new RegExp(`\\[\\s*${escapeRegex(doc.filename)}\\s*\\]\\([^)]+\\)\\r?\\n*`, 'gi');
      res = res.replace(fileRegex, '');
    }
    const remainingText = res.trim();
    return {
      cleanedContent: res,
      hasOtherText: remainingText.length > 0,
    };
  }, [content, embeddedDocs]);

  const html = useMemo(
    () => renderMarkdown(cleanedContent, !!onTask, searchQuery, !!onRefreshToc),
    [cleanedContent, !!onTask, searchQuery, !!onRefreshToc]
  );
  useEffect(() => {
    const elements = [...(host.current?.querySelectorAll<HTMLElement>('[data-mermaid-source]') ?? [])];
    const codeBlocks = [...(host.current?.querySelectorAll<HTMLElement>('code[data-code-language]') ?? [])];
    const privateImages = [...(host.current?.querySelectorAll<HTMLImageElement>('img[data-private-image]') ?? [])];
    const docLinks = [...(host.current?.querySelectorAll<HTMLAnchorElement>('a.doc-link-pdf, a.doc-link-txt') ?? [])];
    for (const link of docLinks) {
      const href = link.getAttribute('href') || '';
      const pId = link.dataset.privateFile || '';
      const isEmbedded = embeddedDocs.some(
        (d) => (d.id && d.id === pId) || d.url === href || d.filename === (link.dataset.docFilename || link.textContent?.trim())
      );
      if (isEmbedded) {
        link.classList.add('doc-link-embedded');
      }
    }
    const objectUrls: string[] = [];
    let cancelled = false;
    if (eagerImages) privateImages.forEach((image) => { image.loading = 'eager'; });
    if (resolveFile) {
      for (const image of privateImages) {
        const id = image.dataset.privateImage;
        if (!id) continue;
        let attempted = false;
        const useCached = () => {
          if (attempted) return;
          attempted = true;
          void resolveFile(id).then((url) => {
            if (!url) return;
            if (cancelled) URL.revokeObjectURL(url);
            else { objectUrls.push(url); image.src = url; }
          });
        };
        image.addEventListener('error', useCached, { once: true });
        if (!navigator.onLine || image.complete && image.naturalWidth === 0) useCached();
      }
    }
    if (codeBlocks.some((code) => code.dataset.codeLanguage)) void (async () => {
      const { default: highlighter } = await import('highlight.js/lib/common');
      if (cancelled) return;
      for (const code of codeBlocks) {
        const language = code.dataset.codeLanguage ?? '';
        if (!language || !highlighter.getLanguage(language)) continue;
        try {
          code.innerHTML = highlighter.highlight(code.textContent ?? '', { language, ignoreIllegals: true }).value;
          code.classList.add('hljs');
        } catch { /* Keep escaped plain text when a language cannot be highlighted. */ }
      }
    })();
    if (elements.length) void (async () => {
      try {
        const { default: mermaid } = await import('mermaid');
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          suppressErrorRendering: true,
          htmlLabels: false,
          maxTextSize: 50_000,
          maxEdges: 500,
          secure: [
            'secure', 'securityLevel', 'startOnLoad', 'suppressErrorRendering', 'maxTextSize', 'maxEdges',
            'theme', 'look', 'layout', 'themeVariables', 'themeCSS', 'fontFamily', 'htmlLabels',
          ],
          theme: dark ? 'dark' : 'default',
          look: 'classic',
          layout: 'dagre',
          themeVariables: { fontSize: '14px' },
          flowchart: {
            curve: 'basis',
            htmlLabels: false,
            useMaxWidth: false,
            diagramPadding: 4,
            nodeSpacing: 30,
            rankSpacing: 35,
          },
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        });
        for (const [index, element] of elements.entries()) {
          if (cancelled) return;
          const source = element.textContent?.trim() ?? '';
          if (!source || source.length > 50_000 || index >= 20) {
            diagramError(element, source ? t('图表内容过大或数量超过 20 个。') : t('图表内容为空。'));
            continue;
          }
          try {
            const id = `easynote-diagram-${crypto.randomUUID()}`;
            const { svg, bindFunctions } = await mermaid.render(id, source);
            if (cancelled) return;
            element.innerHTML = DOMPurify.sanitize(svg, {
              USE_PROFILES: { svg: true, svgFilters: true },
              ADD_TAGS: ['style'],
            });
            element.className = 'mermaid-diagram';
            element.removeAttribute('data-mermaid-source');
            fitDiagramToContainer(element);
            bindFunctions?.(element);
          } catch (error) {
            diagramError(element, error);
          }
        }
      } catch (error) {
        if (!cancelled) elements.forEach((element) => diagramError(element, error));
      }
    })();
    return () => {
      cancelled = true;
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [html, dark, resolveFile, eagerImages]);

  return (<>{hasOtherText && html.trim() ? <article ref={host} className="markdown" onDoubleClick={(event) => {
    if (!onEditLine) return;
    const target = event.target as HTMLElement;
    if (target.closest('a, button, input, img, summary')) return;
    const block = target.closest<HTMLElement>('[data-source-line]');
    const line = Number(block?.dataset.sourceLine);
    if (Number.isInteger(line) && line >= 0) onEditLine(line);
  }} onClick={(event) => {
    const target = event.target as HTMLElement;
    const refreshBtn = target.closest<HTMLElement>('[data-toc-action="refresh"]');
    if (refreshBtn) {
      event.preventDefault();
      onRefreshToc?.();
      return;
    }
    const footnoteRef = target.closest<HTMLAnchorElement>('a[data-footnote-ref]');
    if (footnoteRef) {
      event.preventDefault();
      host.current?.querySelector<HTMLElement>(`[data-footnote-id="${footnoteRef.dataset.footnoteRef}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    const footnoteBackref = target.closest<HTMLAnchorElement>('a[data-footnote-backref]');
    if (footnoteBackref) {
      event.preventDefault();
      host.current?.querySelector<HTMLElement>(
        `[data-footnote-reference="${footnoteBackref.dataset.footnoteBackref}"]`
      )?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    const task = target.closest<HTMLInputElement>('input[data-task-index]');
    if (task && onTask) {
      onTask(Number(task.dataset.taskIndex), task.checked);
      return;
    }
    const image = target.closest<HTMLImageElement>('img[data-private-image]');
    if (image) { onImage(image.src); return; }
    const note = target.closest<HTMLAnchorElement>('a[data-note-id]');
    if (note?.dataset.noteId && onNote) {
      event.preventDefault();
      onNote(note.dataset.noteId);
      return;
    }
    const file = target.closest<HTMLAnchorElement>('a[data-private-file]');
    if (file?.dataset.privateFile) {
      const filename = file.dataset.docFilename || file.textContent?.trim() || 'document';
      const docType = file.dataset.docType as ('pdf' | 'txt' | undefined);
      if ((docType === 'pdf' || docType === 'txt' || /\.pdf$/i.test(filename) || /\.txt$/i.test(filename))) {
        event.preventDefault();
        const isEmbedded = embeddedDocs.some(
          (d) => (d.id && d.id === file.dataset.privateFile) || d.url === file.getAttribute('href') || d.filename === filename
        );
        if (isEmbedded) {
          // Document is already rendered directly on the page! Never close or open disruptive modal popup
          const targetSlot = host.current?.parentElement?.querySelector('.doc-embed-slot');
          targetSlot?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          return;
        }
        if (onViewDocument) {
          onViewDocument({
            id: file.dataset.privateFile,
            url: file.href,
            filename,
            type: docType || (/\.pdf$/i.test(filename) ? 'pdf' : 'txt'),
          });
          return;
        }
      }
      if (onFile) {
        event.preventDefault();
        onFile(file.dataset.privateFile, file.href);
        return;
      }
    }
    const headingAnchor = target.closest<HTMLAnchorElement>('a[href^="#"]');
    if (headingAnchor) {
      const href = headingAnchor.getAttribute('href') ?? '';
      if (!href.startsWith('#note-') && !href.startsWith('#footnote-') && !href.startsWith('#footnote-ref-')) {
        event.preventDefault();
        const rawSlug = href.slice(1);
        const slug = decodeURIComponent(rawSlug);
        const escapeSelector = (val: string) =>
          typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(val) : val.replace(/["\\]/g, '\\$&');
        const targetElement = host.current?.querySelector<HTMLElement>(`[data-heading-slug="${escapeSelector(slug)}"]`)
          || host.current?.querySelector<HTMLElement>(`[data-heading-slug="${escapeSelector(rawSlug)}"]`);
        targetElement?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
  }} dangerouslySetInnerHTML={{ __html: html }} /> : null}
  {embeddedDocs.map((doc, index) => (
    <div key={`${doc.url}-${index}`} className="doc-embed-slot">
      <DocumentViewer
        embedded={true}
        file={doc}
        userId={userId || ''}
        onExpandFullscreen={() => onViewDocument?.(doc)}
        onInsertToNote={onInsertToNote}
        onCreateNoteFromContent={onCreateNoteFromContent}
        resolveFile={resolveFile}
      />
    </div>
  ))}
  </>);
}
