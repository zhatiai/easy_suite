import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { X } from 'lucide-react';
import { NoteConnections, type NoteConnectionsProps } from './NoteConnections';
import { NoteOutline } from './NoteOutline';
import type { Heading } from './knowledge';
import { t } from './i18n';

const tabs = [
  { id: 'outline', label: 'navigation_outline' },
  { id: 'outgoing', label: 'navigation_references' },
  { id: 'incoming', label: 'backlinks' },
] as const;

const widthStorageKey = 'easynote-note-navigation-width';
const minimumWidth = 240;
const maximumWidth = 640;
const defaultWidth = () => window.matchMedia('(max-width: 900px)').matches ? 280 : 304;

interface Props extends NoteConnectionsProps {
  headings: Heading[];
  activeOffset: number | null;
  onNavigate(offset: number): void;
  onClose(): void;
}

export function NoteNavigation({ headings, activeOffset, onNavigate, onClose, ...connections }: Props) {
  const [selected, setSelected] = useState<typeof tabs[number]['id']>('outline');
  const [width, setWidth] = useState(() => {
    const stored = localStorage.getItem(widthStorageKey);
    const saved = Number(stored);
    return stored !== null && Number.isFinite(saved) ? Math.min(maximumWidth, Math.max(minimumWidth, saved)) : defaultWidth();
  });
  const [availableWidth, setAvailableWidth] = useState(maximumWidth);
  const [resizing, setResizing] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const widthRef = useRef(width);
  const resizeStart = useRef<{ pointerId: number; x: number; width: number } | null>(null);
  const visibleWidth = Math.min(width, availableWidth);

  useLayoutEffect(() => {
    const workspace = panelRef.current?.parentElement;
    if (!workspace) return;
    // Reserve 240 px for the document and 5 px for the separator.
    const measure = () => setAvailableWidth(Math.min(maximumWidth, Math.max(minimumWidth, workspace.clientWidth - 245)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(workspace);
    return () => observer.disconnect();
  }, []);

  const updateWidth = (value: number) => {
    const next = Math.min(availableWidth, Math.max(minimumWidth, Math.round(value)));
    widthRef.current = next;
    setWidth(next);
  };
  const beginResize = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus();
    resizeStart.current = { pointerId: event.pointerId, x: event.clientX, width: visibleWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizing(true);
  };
  const moveResize = (event: PointerEvent<HTMLDivElement>) => {
    const start = resizeStart.current;
    if (start?.pointerId === event.pointerId) updateWidth(start.width + start.x - event.clientX);
  };
  const finishResize = (event: PointerEvent<HTMLDivElement>) => {
    if (resizeStart.current?.pointerId !== event.pointerId) return;
    resizeStart.current = null;
    setResizing(false);
    localStorage.setItem(widthStorageKey, String(widthRef.current));
  };
  const resizeWithKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    const widths: Record<string, number> = {
      ArrowLeft: visibleWidth + 12,
      ArrowRight: visibleWidth - 12,
      Home: minimumWidth,
      End: availableWidth,
    };
    if (!(event.key in widths)) return;
    event.preventDefault();
    updateWidth(widths[event.key]);
    localStorage.setItem(widthStorageKey, String(widthRef.current));
  };

  return <>
    <div className={`note-navigation-resizer note-list-resizer pane-divider${resizing ? ' resizing' : ''}`}
      role="separator" aria-label={t('调整笔记导航宽度')} aria-orientation="vertical"
      aria-valuemin={minimumWidth} aria-valuemax={availableWidth} aria-valuenow={visibleWidth} tabIndex={0}
      title={t('拖动调整宽度，双击恢复默认')} onPointerDown={beginResize} onPointerMove={moveResize}
      onPointerUp={finishResize} onPointerCancel={finishResize} onLostPointerCapture={finishResize}
      onKeyDown={resizeWithKeyboard} onDoubleClick={() => {
        updateWidth(defaultWidth());
        localStorage.setItem(widthStorageKey, String(widthRef.current));
      }} />
    <aside ref={panelRef} className="knowledge-panel" aria-label={t('笔记导航')}
      style={{ '--note-navigation-width': `${visibleWidth}px` } as CSSProperties}>
    <header>
      <div className="knowledge-tabs" role="tablist" aria-label={t('note_navigation_tabs')} onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const current = tabs.findIndex((tab) => tab.id === selected);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
          : (current + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
        setSelected(tabs[next].id);
        event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus({ preventScroll: true });
      }}>
        {tabs.map((tab) => <button key={tab.id} className="knowledge-tab" role="tab" id={`note-navigation-tab-${tab.id}`}
          aria-controls={`note-navigation-panel-${tab.id}`} aria-selected={selected === tab.id} tabIndex={selected === tab.id ? 0 : -1}
          onClick={() => setSelected(tab.id)}>{t(tab.label)}</button>)}
      </div>
      <button className="icon-button" aria-label={t('关闭笔记导航')} title={t('关闭笔记导航')} onClick={onClose}><X size={15} /></button>
    </header>
    {tabs.map((tab) => <div className="knowledge-tab-panel" key={tab.id} id={`note-navigation-panel-${tab.id}`}
      role="tabpanel" aria-labelledby={`note-navigation-tab-${tab.id}`} tabIndex={0} hidden={selected !== tab.id}>
      {tab.id === 'outline' ? <NoteOutline headings={headings} activeOffset={activeOffset} onNavigate={onNavigate} />
        : <NoteConnections {...connections} direction={tab.id} />}
    </div>)}
    </aside>
  </>;
}
