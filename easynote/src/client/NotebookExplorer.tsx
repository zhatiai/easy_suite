import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react';
import { ArrowRightLeft, CheckSquare, ChevronDown, ChevronRight, FilePlus2, FileText, Folder as FolderIcon, FolderOpen, FolderPlus, LoaderCircle, MoreHorizontal, Plus, Search, Square, Trash2, X } from 'lucide-react';
import type { Folder, Note, NoteSummary } from '../shared/types';
import type { ExplorerFolderState } from './useNotebook';
import { dateLocale, t, uiLanguage } from './i18n';
import { tagColorIndex } from './tagColors';

interface NotebookExplorerProps {
  title: string;
  view: string;
  query: string;
  activeTag: string;
  tagColors: Record<string, number>;
  activeFolderId: string | null | undefined;
  folders: Folder[];
  notes: NoteSummary[];
  currentNote: Note | null;
  pendingIds: Set<string>;
  selectionMode: boolean;
  selectedIds: Set<string>;
  inspectedFolderId: string | null;
  loading: boolean;
  disabled: boolean;
  nextOffset: number | null;
  explorerFolders: Record<string, ExplorerFolderState>;
  explorerFolderKey(folderId: string | null): string;
  ensureFolder(folderId: string | null, options?: { append?: boolean; force?: boolean }): Promise<void>;
  searchInput: RefObject<HTMLInputElement | null>;
  mobileSearch: boolean;
  headerActions: ReactNode;
  bulkToolbar?: ReactNode;
  setQuery(value: string): void;
  clearSearch(): void;
  inspectFolder(id: string): void;
  createChild(id: string): void;
  createNoteIn(id: string): void;
  mergeFolder(folder: Folder): void;
  removeFolder(folder: Folder): void;
  openNote(id: string): void;
  toggleSelected(id: string): void;
  openNoteMenu(id: string, trigger: HTMLElement): void;
  loadMore(): void;
  createNote(): void;
}

function compactExcerpt(value: string) {
  return value.replace(/[#*`\n]+/g, ' ').trim();
}

function highlightedText(value: string, query: string) {
  const needle = query.trim();
  if (!needle) return <span>{value}</span>;
  const parts: ReactNode[] = [];
  const source = value.toLocaleLowerCase();
  const target = needle.toLocaleLowerCase();
  let cursor = 0;
  let match = source.indexOf(target);
  while (match >= 0) {
    if (match > cursor) parts.push(value.slice(cursor, match));
    parts.push(<mark className="search-highlight" key={`${match}-${parts.length}`}>{value.slice(match, match + needle.length)}</mark>);
    cursor = match + needle.length;
    match = source.indexOf(target, cursor);
  }
  if (cursor < value.length) parts.push(value.slice(cursor));
  return <span>{parts}</span>;
}

function quickNoteTitle(timestamp: number) {
  const date = new Date(timestamp);
  if (uiLanguage() === 'zh') {
    const part = (value: number) => String(value).padStart(2, '0');
    return `${t('小记')}-${date.getFullYear()}年${part(date.getMonth() + 1)}月${part(date.getDate())}日 ${part(date.getHours())}:${part(date.getMinutes())}:${part(date.getSeconds())}`;
  }
  return `${t('小记')}-${date.toLocaleString(dateLocale(), {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  })}`;
}

export function NotebookExplorer(props: NotebookExplorerProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const treeRef = useRef<HTMLUListElement>(null);
  const hierarchical = props.view === 'all' && !props.query && !props.activeTag;
  const foldersByParent = useMemo(() => {
    const map = new Map<string | null, Folder[]>();
    for (const folder of props.folders) {
      const siblings = map.get(folder.parentId) ?? [];
      siblings.push(folder);
      map.set(folder.parentId, siblings);
    }
    for (const siblings of map.values()) siblings.sort((left, right) => left.name.localeCompare(right.name, dateLocale()));
    return map;
  }, [props.folders]);
  const parentById = useMemo(() => new Map(props.folders.map((folder) => [folder.id, folder.parentId])), [props.folders]);

  useEffect(() => {
    if (!hierarchical) return;
    if (typeof props.activeFolderId !== 'string') void props.ensureFolder(null);
    for (const id of expanded) void props.ensureFolder(id);
  }, [expanded, hierarchical, props.activeFolderId, props.ensureFolder, props.explorerFolders]);

  useEffect(() => {
    if (typeof props.activeFolderId !== 'string') return;
    setExpanded((current) => {
      const next = new Set(current);
      let id: string | null = props.activeFolderId as string;
      while (id) {
        next.add(id);
        id = parentById.get(id) ?? null;
      }
      return next.size === current.size ? current : next;
    });
  }, [parentById, props.activeFolderId]);

  useEffect(() => {
    const folderId = props.currentNote?.folderId;
    if (!hierarchical || !folderId) return;
    if (typeof props.activeFolderId === 'string') {
      let cursor: string | null = folderId;
      while (cursor && cursor !== props.activeFolderId) cursor = parentById.get(cursor) ?? null;
      if (cursor !== props.activeFolderId) return;
    }
    setExpanded((current) => {
      const next = new Set(current);
      let id: string | null = folderId;
      while (id) {
        next.add(id);
        id = parentById.get(id) ?? null;
      }
      return next.size === current.size ? current : next;
    });
  }, [hierarchical, parentById, props.activeFolderId, props.currentNote?.folderId]);

  useEffect(() => {
    if (!hierarchical || !props.currentNote) return;
    const frame = requestAnimationFrame(() => {
      const row = [...(treeRef.current?.querySelectorAll<HTMLElement>('[data-note-id]') ?? [])]
        .find((item) => item.dataset.noteId === props.currentNote?.id);
      row?.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  }, [expanded, hierarchical, props.currentNote?.id, props.explorerFolders]);

  useEffect(() => {
    const closeOpenMenus = () => {
      for (const menu of document.querySelectorAll<HTMLDetailsElement>('.folder-action-menu[open]')) menu.removeAttribute('open');
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('.folder-action-menu')) return;
      closeOpenMenus();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const openMenu = document.querySelector<HTMLDetailsElement>('.folder-action-menu[open]');
      if (!openMenu) return;
      event.preventDefault();
      openMenu.removeAttribute('open');
      openMenu.querySelector<HTMLElement>('summary')?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const toggleFolder = (id: string, forceOpen = false) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (forceOpen || !next.has(id)) next.add(id); else next.delete(id);
      return next;
    });
  };

  const closeFolderMenu = (target: HTMLElement) => target.closest('details')?.removeAttribute('open');

  const noteRow = (item: NoteSummary, depth = 0, showMetadata = false) => {
    const live = props.currentNote?.id === item.id
      ? { ...item, ...props.currentNote, excerpt: props.currentNote.content.slice(0, 180) }
      : item;
    const title = showMetadata && live.quick ? quickNoteTitle(live.createdAt) : live.title || t('untitled_note');
    return <li key={item.id} className="explorer-note-item" data-note-id={item.id} style={{ '--tree-depth': depth } as React.CSSProperties}>
      <button className={`note-row explorer-note-row ${showMetadata ? 'with-meta' : ''} ${item.id === props.currentNote?.id ? 'selected' : ''} ${props.selectedIds.has(item.id) ? 'checked' : ''}`} data-note-row
        aria-label={`${title}，${new Date(live.updatedAt).toLocaleDateString(dateLocale(), { month: 'short', day: 'numeric' })}`}
        aria-pressed={props.selectionMode ? props.selectedIds.has(item.id) : undefined}
        onClick={() => props.selectionMode ? props.toggleSelected(item.id) : props.openNote(item.id)}>
        {props.selectionMode ? props.selectedIds.has(item.id) ? <CheckSquare size={17} /> : <Square size={17} /> : <FileText size={17} />}
        <span className="explorer-note-copy">
          <strong className="note-row-title">{highlightedText(title, props.query)}</strong>
          <small className="note-excerpt" aria-hidden="true">{highlightedText(compactExcerpt(live.excerpt) || t('empty_note'), props.query)}</small>
        </span>
        {props.pendingIds.has(item.id) && <span className="local-dot" title={t('local_draft')} />}
        <span className="note-row-meta"><time>{new Date(live.updatedAt).toLocaleString(dateLocale(), { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time><span>{t('修订 {0}', live.revision)}</span></span>
      </button>
      {!props.selectionMode && <button className="explorer-row-more" aria-label={t('更多笔记操作')} onClick={(event) => props.openNoteMenu(item.id, event.currentTarget)}><MoreHorizontal size={16} /></button>}
    </li>;
  };

  const folderBranch = (folder: Folder, depth: number): ReactNode => {
    const open = expanded.has(folder.id);
    const children = foldersByParent.get(folder.id) ?? [];
    const bucket = props.explorerFolders[props.explorerFolderKey(folder.id)];
    return <li className="folder-tree-branch" key={folder.id}>
      <div className={`folder-tree-row ${locatedFolderId === folder.id ? 'active' : ''}`} style={{ '--tree-depth': depth } as React.CSSProperties}>
        <button className="folder-disclosure" aria-label={open ? t('折叠文件夹') : t('展开文件夹')} aria-expanded={open} onClick={() => toggleFolder(folder.id)}>
          {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </button>
        <button className="folder-tree-select" aria-pressed={props.inspectedFolderId === folder.id} onClick={() => { toggleFolder(folder.id, true); props.inspectFolder(folder.id); }}>{open ? <FolderOpen size={18} /> : <FolderIcon size={18} />}<span>{folder.name}</span><small>{folder.noteCount || ''}</small></button>
        <details className="folder-action-menu" onToggle={(event) => {
          if (!event.currentTarget.open) return;
          for (const menu of document.querySelectorAll<HTMLDetailsElement>('.folder-action-menu[open]')) {
            if (menu !== event.currentTarget) menu.removeAttribute('open');
          }
          const trigger = event.currentTarget.querySelector('summary')?.getBoundingClientRect();
          if (!trigger) return;
          const menuWidth = 184;
          const left = Math.min(Math.max(8, trigger.left - 10), window.innerWidth - menuWidth - 8);
          event.currentTarget.style.setProperty('--folder-menu-left', `${left}px`);
          event.currentTarget.style.setProperty('--folder-menu-top', `${trigger.bottom + 3}px`);
        }}>
          <summary className="explorer-row-more" aria-label={t('文件夹操作')}><MoreHorizontal size={16} /></summary>
          <div className="folder-action-popover" role="menu">
            <button role="menuitem" disabled={props.disabled} onClick={(event) => { closeFolderMenu(event.currentTarget); toggleFolder(folder.id, true); props.createChild(folder.id); }}><FolderPlus size={17} /><span className="folder-action-label">{t('新建文件夹')}</span></button>
            <button role="menuitem" disabled={props.disabled} onClick={(event) => { closeFolderMenu(event.currentTarget); props.createNoteIn(folder.id); }}><FilePlus2 size={17} /><span className="folder-action-label">{t('新建文件')}</span></button>
            <button role="menuitem" className="danger" disabled={props.disabled} onClick={(event) => { closeFolderMenu(event.currentTarget); props.removeFolder(folder); }}><Trash2 size={17} /><span className="folder-action-label">{t('删除文件夹')}</span></button>
            <button role="menuitem" disabled={props.disabled || props.folders.length < 2} onClick={(event) => { closeFolderMenu(event.currentTarget); props.mergeFolder(folder); }}><ArrowRightLeft size={17} /><span className="folder-action-label">{t('合并文件到...')}</span><ChevronRight className="folder-action-chevron" size={15} /></button>
          </div>
        </details>
      </div>
      {open && <ul className="folder-children">
        {children.map((child) => folderBranch(child, depth + 1))}
        {bucket?.notes.map((item) => noteRow(item, depth + 1, true))}
        {bucket?.loading && <li className="explorer-inline-state" style={{ '--tree-depth': depth + 1 } as React.CSSProperties}><LoaderCircle className="spin" size={14} />{t('loading')}</li>}
        {bucket?.error && <li className="explorer-inline-state error" style={{ '--tree-depth': depth + 1 } as React.CSSProperties}><span>{t('加载失败')}</span><button onClick={() => void props.ensureFolder(folder.id, { force: true })}>{t('retry')}</button></li>}
        {bucket && !bucket.loading && !bucket.error && !bucket.notes.length && !children.length && <li className="explorer-inline-state" style={{ '--tree-depth': depth + 1 } as React.CSSProperties}><span className="explorer-empty-label">{t('no_notes')}</span></li>}
        {bucket?.nextOffset !== null && bucket && <li style={{ '--tree-depth': depth + 1 } as React.CSSProperties}><button className="load-more explorer-load-more" onClick={() => void props.ensureFolder(folder.id, { append: true })}>{t('加载更多')}<ChevronDown size={14} /></button></li>}
      </ul>}
    </li>;
  };

  const rootBucket = props.explorerFolders[props.explorerFolderKey(null)];
  const scopedToFolder = typeof props.activeFolderId === 'string';
  const selectedFolder = scopedToFolder ? props.folders.find((folder) => folder.id === props.activeFolderId) : undefined;
  let noteFolderInScope = !!props.currentNote?.folderId;
  if (noteFolderInScope && scopedToFolder) {
    let cursor: string | null = props.currentNote?.folderId ?? null;
    while (cursor && cursor !== props.activeFolderId) cursor = parentById.get(cursor) ?? null;
    noteFolderInScope = cursor === props.activeFolderId;
  }
  const locatedFolderId = props.inspectedFolderId ?? (noteFolderInScope ? props.currentNote?.folderId : props.activeFolderId);
  const moveFocus = (event: ReactKeyboardEvent<HTMLUListElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.note-row, .folder-tree-select')].filter((button) => button.offsetParent !== null);
    const current = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('.note-row, .folder-tree-select') : null;
    const index = current ? buttons.indexOf(current) : -1;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : event.key === 'ArrowDown' ? Math.min(index + 1, buttons.length - 1) : Math.max(0, index - 1);
    if (buttons[next]) { event.preventDefault(); buttons[next].focus(); }
  };

  return <section className="note-list notebook-explorer" id="notebook-explorer">
    <header className="list-header explorer-header">
      <div className="list-heading"><h1 title={props.activeTag ? `${props.title} · ${props.activeTag}` : props.title}>
        {props.activeTag ? <span className="active-tag-heading"><span className="view-heading-context">{props.title} · {t('tags')}</span><span className="active-tag-heading-main"><span className={`tag-color-dot tag-color-${tagColorIndex(props.activeTag, props.tagColors)}`} aria-hidden="true" /><span className="active-tag-heading-name">{props.activeTag}</span></span></span> : props.title}
      </h1>{props.headerActions}</div>
      {props.bulkToolbar}
      <div className={`search-field ${props.mobileSearch || props.query ? 'mobile-open' : ''}`} role="search" onClick={() => props.searchInput.current?.focus()}>
        <Search size={17} />
        <input ref={props.searchInput} aria-label={t('搜索笔记')} placeholder={t('搜索笔记')} value={props.query}
          onChange={(event) => props.setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') props.clearSearch(); }} />
        <kbd>⌘ K</kbd>
        {props.query && <button type="button" className="search-clear" aria-label={t('清空搜索')} onClick={(event) => { event.stopPropagation(); props.clearSearch(); }}><X size={13} /></button>}
      </div>
    </header>
    <div className="list-scroll explorer-scroll" onScroll={(event) => {
      for (const menu of event.currentTarget.querySelectorAll<HTMLDetailsElement>('.folder-action-menu[open]')) menu.removeAttribute('open');
    }}>
      {props.loading && !props.notes.length && !hierarchical ? <div className="empty-state">{t('loading')}</div>
        : hierarchical ? <ul ref={treeRef} className="explorer-tree" onKeyDown={moveFocus}>
          {scopedToFolder
            ? selectedFolder && folderBranch(selectedFolder, 0)
            : <>
              {(rootBucket?.notes ?? []).map((item) => noteRow(item, 0, true))}
              {(foldersByParent.get(null) ?? []).map((folder) => folderBranch(folder, 0))}
              {rootBucket?.loading && <li className="explorer-inline-state"><LoaderCircle className="spin" size={14} />{t('loading')}</li>}
              {rootBucket?.error && <li className="explorer-inline-state error"><span>{t('加载失败')}</span><button onClick={() => void props.ensureFolder(null, { force: true })}>{t('retry')}</button></li>}
            </>}
        </ul>
          : !props.notes.length ? <div className="empty-state"><FileText size={28} /><span>{props.query ? t('no_matching_notes') : t('no_notes')}</span></div>
            : <ul className={`explorer-tree explorer-search-results ${props.activeTag ? 'explorer-file-results' : ''}`} onKeyDown={moveFocus}>{props.notes.map((item) => noteRow(item, 0, !!props.activeTag))}</ul>}
      {!hierarchical && props.nextOffset !== null && <button className="load-more" onClick={props.loadMore}>{t('加载更多')}<ChevronDown size={14} /></button>}
    </div>
    <footer className="list-footer"><span>{props.notes.length} {t('篇笔记')}</span></footer>
    <button className="mobile-compose" aria-label={t('新建笔记')} disabled={props.loading} onClick={props.createNote}><Plus size={23} /></button>
  </section>;
}
