import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Sparkles } from 'lucide-react';
import { NoteAiChat } from './NoteAiChat';
import { t } from './i18n';

interface SelectionContext { text: string; context: string; range: Range }

export function readAiSelection(article: HTMLElement, selection: Selection | null): SelectionContext | null {
  if (!selection || selection.isCollapsed || !selection.rangeCount || !selection.toString().trim()) return null;
  const range = selection.getRangeAt(0);
  if (!article.contains(range.startContainer) || !article.contains(range.endContainer)) return null;
  const block = (node: Node): Element | null => {
    let element = node instanceof Element ? node : node.parentElement;
    while (element && element.parentElement !== article) element = element.parentElement;
    return element;
  };
  const start = block(range.startContainer);
  const end = block(range.endContainer);
  if (!start || !end) return null;
  const paragraph = (node: Node) => (node instanceof Element ? node : node.parentElement)
    ?.closest('p, li, pre, blockquote, td, th, h1, h2, h3, h4, h5, h6');
  const firstParagraph = paragraph(range.startContainer) ?? start;
  const lastParagraph = paragraph(range.endContainer) ?? end;
  const contextRange = document.createRange();
  contextRange.setStartBefore(firstParagraph);
  contextRange.setEndAfter(lastParagraph);
  const fragment = contextRange.cloneContents();
  const contextText = fragment.textContent ?? '';
  const following = [...article.querySelectorAll('p, h1, h2, h3, h4, h5, h6')].find((element) =>
    !lastParagraph.contains(element)
    && !!(lastParagraph.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING));
  const parts = [contextText];
  if (following?.tagName === 'P') parts.push(following.textContent ?? '');
  return { text: selection.toString().trim(), context: parts.join('\n\n'), range: range.cloneRange() };
}

interface DialogBounds { left: number; top: number; right: number; bottom: number }
interface DialogRect { x: number; y: number; width: number; height: number }
type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
const resizeEdges: ResizeEdge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
const resizeLabels = {
  n: 'llm_resize_top', s: 'llm_resize_bottom', e: 'llm_resize_right', w: 'llm_resize_left',
  ne: 'llm_resize_top_right', nw: 'llm_resize_top_left', se: 'llm_resize_bottom_right', sw: 'llm_resize_bottom_left',
} as const;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

export function SelectionAi({ article, userId, dark, onConfigure }: {
  article: RefObject<HTMLElement | null>;
  userId: string;
  dark: boolean;
  onConfigure(): void;
}) {
  const [selection, setSelection] = useState<SelectionContext | null>(null);
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  const trigger = useRef<HTMLDivElement>(null);
  const popup = useRef<HTMLDialogElement>(null);
  const geometry = useRef<DialogRect | null>(null);
  const bounds = useRef<DialogBounds | null>(null);
  const drag = useRef<{ pointerId: number; edge: ResizeEdge; x: number; y: number; rect: DialogRect } | null>(null);

  const close = () => {
    popup.current?.close();
    openRef.current = false;
    setOpen(false);
    setSelection(null);
    geometry.current = null;
    drag.current = null;
    window.getSelection()?.removeAllRanges();
    article.current?.closest<HTMLElement>('.document-scroll')?.focus({ preventScroll: true });
  };

  function place(rect: DialogRect) {
    const panel = popup.current;
    if (!panel) return;
    geometry.current = rect;
    panel.style.left = `${rect.x}px`;
    panel.style.top = `${rect.y}px`;
    panel.style.width = `${rect.width}px`;
    panel.style.height = `${rect.height}px`;
  }

  function resize(rect: DialogRect, edge: ResizeEdge, dx: number, dy: number) {
    const limit = bounds.current;
    if (!limit) return;
    const minWidth = Math.min(280, limit.right - limit.left);
    const minHeight = Math.min(320, limit.bottom - limit.top);
    let left = rect.x, right = rect.x + rect.width;
    let top = rect.y, bottom = rect.y + rect.height;
    if (edge.includes('w')) left = clamp(left + dx, limit.left, right - minWidth);
    if (edge.includes('e')) right = clamp(right + dx, left + minWidth, limit.right);
    if (edge.includes('n')) top = clamp(top + dy, limit.top, bottom - minHeight);
    if (edge.includes('s')) bottom = clamp(bottom + dy, top + minHeight, limit.bottom);
    place({ x: left, y: top, width: right - left, height: bottom - top });
  }

  useEffect(() => {
    const update = () => {
      if (openRef.current || !article.current || popup.current?.contains(document.activeElement)) return;
      setSelection(readAiSelection(article.current, window.getSelection()));
    };
    document.addEventListener('selectionchange', update);
    return () => document.removeEventListener('selectionchange', update);
  }, [article]);

  useLayoutEffect(() => {
    const panel = open ? popup.current : trigger.current;
    const note = article.current;
    if (!selection || !panel || !note) return;
    const scroller = note.closest<HTMLElement>('.document-scroll') ?? note;
    const viewport = window.visualViewport;
    const originalScroll = { top: scroller.scrollTop, left: scroller.scrollLeft };
    const originalStyle = {
      overflow: scroller.style.overflow,
      scrollBehavior: scroller.style.scrollBehavior, scrollbarGutter: scroller.style.scrollbarGutter,
    };
    const rootOverflow = document.documentElement.style.overflow;
    const spacer = document.createElement('div');
    spacer.setAttribute('aria-hidden', 'true');
    let frame = 0;
    if (open) {
      scroller.style.scrollBehavior = 'auto';
      scroller.style.scrollbarGutter = 'stable';
      scroller.style.overflow = 'hidden';
      document.documentElement.style.overflow = 'hidden';
      scroller.appendChild(spacer);
    }
    const position = () => {
      const area = scroller.getBoundingClientRect();
      const viewportLeft = viewport?.offsetLeft ?? 0;
      const viewportTop = viewport?.offsetTop ?? 0;
      const left = Math.max(area.left, viewportLeft) + 8;
      const right = Math.min(area.right, viewportLeft + (viewport?.width ?? innerWidth)) - 8;
      const top = Math.max(area.top, viewportTop) + 8;
      const bottom = Math.min(area.bottom, viewportTop + (viewport?.height ?? innerHeight)) - 8;
      if (right <= left || bottom <= top) return;
      if (open) {
        // Extra scroll space also lets the last paragraph sit above the conversation.
        spacer.style.height = `${scroller.clientHeight}px`;
        const selected = selection.range.getBoundingClientRect();
        const visibleSelectionHeight = Math.min(selected.height, (bottom - top) * 0.2);
        const desiredBottom = top + visibleSelectionHeight;
        scroller.scrollTop += selected.bottom - desiredBottom;
        const anchor = selection.range.getBoundingClientRect();
        const dialogTop = Math.max(top, anchor.bottom + 8);
        const availableHeight = Math.max(1, bottom - dialogTop);
        const availableWidth = right - left;
        bounds.current = { left, right, top: dialogTop, bottom };
        const previous = geometry.current;
        const body = note.getBoundingClientRect();
        const width = Math.min(previous?.width ?? (innerWidth <= 640 ? availableWidth : body.width * 0.8), availableWidth);
        const height = Math.min(previous?.height ?? 640, availableHeight);
        place({
          x: clamp(previous?.x ?? body.left + (body.width - width) / 2, left, right - width),
          y: clamp(previous?.y ?? dialogTop, dialogTop, bottom - height),
          width, height,
        });
        panel.style.visibility = 'visible';
      } else {
        const rect = selection.range.getBoundingClientRect();
        const visible = rect.bottom > top && rect.top < bottom;
        panel.style.visibility = visible ? 'visible' : 'hidden';
        if (!visible) return;
        panel.style.maxWidth = `${right - left}px`;
        const size = panel.getBoundingClientRect();
        panel.style.left = `${clamp(rect.right - size.width, left, right - size.width)}px`;
        panel.style.top = `${clamp(rect.top - size.height - 6, top, bottom - size.height)}px`;
      }
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(position);
    };
    position();
    if (open) popup.current?.showModal();
    const observer = new ResizeObserver(schedule);
    observer.observe(scroller);
    document.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    viewport?.addEventListener('resize', schedule);
    viewport?.addEventListener('scroll', schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      viewport?.removeEventListener('resize', schedule);
      viewport?.removeEventListener('scroll', schedule);
      if (open) {
        popup.current?.close();
        scroller.style.overflow = originalStyle.overflow;
        spacer.remove();
        scroller.style.scrollbarGutter = originalStyle.scrollbarGutter;
        document.documentElement.style.overflow = rootOverflow;
        scroller.scrollTop = originalScroll.top;
        scroller.scrollLeft = originalScroll.left;
        scroller.style.scrollBehavior = originalStyle.scrollBehavior;
      }
    };
  }, [article, selection, open]);

  if (!selection) return null;
  return createPortal(open ? <dialog ref={popup} className="selection-ai-dialog" aria-modal="true"
    aria-label={t('llm_selection_chat')} onCancel={(event) => { event.preventDefault(); close(); }}>
    <NoteAiChat userId={userId} text={selection.text} context={selection.context} dark={dark}
      onClose={close} onConfigure={() => { close(); onConfigure(); }} />
    {resizeEdges.map((edge) => <button key={edge} type="button" className={`selection-ai-resize resize-${edge}`}
      aria-label={t(resizeLabels[edge])} title={t('llm_resize_hint')}
      onPointerDown={(event) => {
        if (event.button !== 0 || !geometry.current) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointerId: event.pointerId, edge, x: event.clientX, y: event.clientY, rect: geometry.current };
      }} onPointerMove={(event) => {
        const active = drag.current;
        if (active?.pointerId === event.pointerId) resize(active.rect, active.edge, event.clientX - active.x, event.clientY - active.y);
      }} onPointerUp={(event) => {
        if (drag.current?.pointerId === event.pointerId) {
          event.currentTarget.releasePointerCapture(event.pointerId);
          drag.current = null;
        }
      }} onLostPointerCapture={() => { drag.current = null; }} onKeyDown={(event) => {
        if (!geometry.current || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault();
        const step = event.shiftKey ? 40 : 12;
        resize(geometry.current, edge, event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0,
          event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0);
      }} />)}
  </dialog> : <div ref={trigger} className="selection-ai-floating" style={{ visibility: 'hidden' }}>
    <button className="selection-ai-trigger" aria-label={t('llm_ask_selection')} onPointerDown={(event) => event.preventDefault()}
      onClick={() => { openRef.current = true; setOpen(true); }}><Sparkles size={14} />{t('llm_ask_short')}</button>
  </div>, document.body);
}
