import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Archive, CheckSquare, ChevronDown, ChevronLeft, Eye, Filter, FolderInput, Grid2X2, History,
  Link2, List, Maximize2, Menu, Minimize2, MoreHorizontal, Pencil, Pin, Plus,
  Search, Send, Share2, Tag, Trash2, X,
} from 'lucide-react';
import type { Folder, Note, NoteInput, NoteSummary } from '../shared/types';
import { Editor, Preview, type EditorHandle } from './Editor';
import { FolderTreePicker } from './FolderTreePicker';
import { dateLocale, t } from './i18n';
import { tagColorIndex } from './tagColors';

interface QuickNotesProps {
  notes: NoteSummary[];
  activeNote: Note | null;
  tags: string[];
  tagCounts: Record<string, number>;
  folders: Folder[];
  tagColors: Record<string, number>;
  loading: boolean;
  disabled: boolean;
  hasMore: boolean;
  create(input: Partial<NoteInput>): Promise<Note>;
  select(id: string): Promise<void>;
  edit(patch: Partial<NoteInput>): void;
  save(): Promise<boolean>;
  loadMore(): void;
  openNavigation(): void;
  details(id: string): Promise<Note>;
  togglePin(note: NoteSummary): Promise<void>;
  copyLink(note: NoteSummary): Promise<void>;
  share(id: string): Promise<void>;
  moveToFolder(id: string, folderId: string): Promise<void>;
  addTag(id: string, tag: string): Promise<void>;
  createTag(tag: string): void;
  reportError(message: string): void;
  archive(id: string): Promise<void>;
  showHistory(note: NoteSummary): Promise<void>;
  remove(id: string): Promise<void>;
}

function noteTitle(content: string) {
  const first = content.split('\n').find((line) => line.trim())?.trim() ?? '';
  return first.replace(/^#{1,6}\s+/, '').replace(/[*_`~[\]]/g, '').slice(0, 256);
}

export function QuickNotes(props: QuickNotesProps) {
  const editor = useRef<EditorHandle>(null);
  const [content, setContent] = useState('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [tagQuery, setTagQuery] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filterTag, setFilterTag] = useState('');
  const [order, setOrder] = useState<'newest' | 'oldest'>('newest');
  const [view, setView] = useState<'list' | 'grid'>('list');
  const [fullscreen, setFullscreen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const menuElement = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{
    id: string;
    panel: 'folders' | 'tags' | null;
    left: number;
    top: number;
  } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [detailContent, setDetailContent] = useState<Record<string, string>>({});
  const [detailLoading, setDetailLoading] = useState<string | null>(null);

  const filtered = useMemo(() => props.notes
    .filter((note) => !filterTag || note.tags.includes(filterTag))
    .filter((note) => !query.trim() || `${note.title} ${note.excerpt}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .toSorted((left, right) => order === 'newest' ? right.updatedAt - left.updatedAt : left.updatedAt - right.updatedAt),
  [filterTag, order, props.notes, query]);

  useEffect(() => {
    if (!openingId || props.activeNote?.id !== openingId) return;
    setEditingId(openingId);
    setContent(props.activeNote.content);
    setSelectedTags(props.activeNote.tags);
    setOpeningId(null);
    requestAnimationFrame(() => editor.current?.focus());
  }, [openingId, props.activeNote]);

  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => {
      if (!(event.target as Element).closest('[data-quick-menu-root]')) setMenu(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setMenu(null);
      }
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', escape);
    };
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('resize', close);
    document.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('resize', close);
      document.removeEventListener('scroll', close, true);
    };
  }, [menu]);

  useLayoutEffect(() => {
    if (!menu || !menuElement.current || window.innerWidth <= 1100) return;
    const bounds = menuElement.current.getBoundingClientRect();
    const top = Math.max(8, Math.min(menu.top, window.innerHeight - bounds.height - 8));
    const left = Math.max(8, Math.min(menu.left, window.innerWidth - bounds.width - 8));
    if (Math.abs(top - menu.top) > 1 || Math.abs(left - menu.left) > 1) {
      setMenu((current) => current ? { ...current, top, left } : null);
    }
  }, [menu]);

  const reset = () => {
    setEditingId(null);
    setContent('');
    setSelectedTags([]);
    requestAnimationFrame(() => editor.current?.focus());
  };
  const updateContent = (value: string) => {
    setContent(value);
    if (editingId) props.edit({ content: value, title: noteTitle(value) });
  };
  const updateTags = (tags: string[]) => {
    setSelectedTags(tags);
    if (editingId) props.edit({ tags });
  };
  const availableTags = [...new Set([...props.tags, ...selectedTags])]
    .sort((left, right) => left.localeCompare(right, dateLocale()))
    .filter((tag) => !tagQuery.trim() || tag.toLocaleLowerCase().includes(tagQuery.trim().toLocaleLowerCase()));
  const createTag = () => {
    const value = tagQuery.trim();
    if (!value) return;
    if (value.length > 40 || value.includes(',') || value.includes('，')) { props.reportError(t('标签必须为 1-40 个字符，且不能包含逗号。')); return; }
    if (!selectedTags.includes(value) && selectedTags.length >= 20) { props.reportError(t('最多 20 个标签。')); return; }
    props.createTag(value);
    if (!selectedTags.includes(value)) updateTags([...selectedTags, value]);
    setTagQuery('');
  };
  const open = async (id: string) => {
    setOpeningId(id);
    await props.select(id);
  };
  const publish = async () => {
    if (!content.trim() || publishing || props.disabled) return;
    setPublishing(true);
    try {
      if (!editingId) await props.create({ title: noteTitle(content), content, tags: selectedTags, quick: true, folderId: null });
      if (await props.save()) reset();
    } finally {
      setPublishing(false);
    }
  };
  const insertTask = () => {
    const position = editor.current?.cursor();
    const marker = editor.current?.markInsertion();
    if (!marker || position === undefined) return;
    const leadingBreakLength = position > 0 && content[position - 1] !== '\n' ? 2 : 0;
    editor.current?.insertAt(marker, '- [ ] ');
    editor.current?.goTo(position + leadingBreakLength + 6);
    editor.current?.releaseInsertion(marker);
  };
  const invoke = (action: () => Promise<void>) => {
    setMenu(null);
    void action().catch(() => undefined);
  };

  const openMenu = (button: HTMLButtonElement, id: string) => {
    setMenu((current) => {
      if (current?.id === id) return null;
      const bounds = button.getBoundingClientRect();
      const width = 200;
      const left = Math.max(8, Math.min(bounds.left - width - 8, window.innerWidth - width - 8));
      return { id, panel: null, left, top: bounds.bottom + 6 };
    });
  };

  const setMenuPanel = (panel: 'folders' | 'tags' | null) => {
    setMenu((current) => current ? { ...current, panel } : null);
  };

  const toggleDetails = async (note: NoteSummary) => {
    if (expanded.has(note.id)) {
      setExpanded((current) => {
        const next = new Set(current);
        next.delete(note.id);
        return next;
      });
      return;
    }
    if (detailContent[note.id] === undefined) {
      setDetailLoading(note.id);
      try {
        const detail = await props.details(note.id);
        setDetailContent((current) => ({ ...current, [note.id]: detail.content }));
      } finally {
        setDetailLoading((current) => current === note.id ? null : current);
      }
    }
    setExpanded((current) => new Set(current).add(note.id));
  };

  const menuNote = menu ? props.notes.find((note) => note.id === menu.id) : undefined;

  return <><main className={`quick-notes-workspace ${fullscreen ? 'fullscreen' : ''}`} aria-label={t('小记')}>
    <header className="quick-notes-header">
      <button className="icon-button quick-notes-mobile-menu" aria-label={t('打开导航菜单')} onClick={props.openNavigation}><Menu size={20} /></button>
      <h1>{t('小记')}</h1>
      <div className="segmented" role="group" aria-label={t('小记显示方式')}>
        <button aria-label={t('列表视图')} aria-pressed={view === 'list'} onClick={() => setView('list')}><List size={16} /></button>
        <button aria-label={t('卡片视图')} aria-pressed={view === 'grid'} onClick={() => setView('grid')}><Grid2X2 size={16} /></button>
      </div>
    </header>
    <div className="quick-notes-body">
      <section className="quick-compose-pane" aria-label={t('记录小记')}>
        <div className="quick-compose-card">
          <div className="quick-compose-toolbar">
            {editingId && <button className="quick-editing-label" onClick={reset}><span>{t('正在编辑小记')}</span><X size={14} /></button>}
            <span />
            <button className="icon-button" aria-label={t('插入待办')} onClick={insertTask}><CheckSquare size={18} /></button>
            <button className="icon-button" aria-label={t(fullscreen ? '退出全屏' : '展开编辑器')} aria-pressed={fullscreen} onClick={() => setFullscreen((value) => !value)}>{fullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}</button>
          </div>
          <div className="quick-compose-editor">
            <Editor ref={editor} value={content} mode="live" onChange={updateContent} onSubmit={() => void publish()}
              onTogglePreview={() => undefined} onShowShortcuts={() => undefined} />
          </div>
          <div className="quick-compose-footer">
            <details className="tag-picker meta-tag-picker quick-tag-picker" onToggle={(event) => { if (event.currentTarget.open) event.currentTarget.querySelector('input')?.focus(); }}>
              <summary className="tag-picker-summary" aria-label={t('添加标签')}><Tag size={16} /><span>{selectedTags.length ? selectedTags.length === 1 ? selectedTags[0] : t('{0} 个标签', selectedTags.length) : t('添加标签')}</span><ChevronDown size={14} /></summary>
              <div className="tag-picker-popover" role="group" aria-label={t('选择或创建标签')}>
                <div className="tag-picker-search"><Search size={17} /><input aria-label={t('搜索或回车新建标签…')} placeholder={t('搜索或回车新建标签…')} value={tagQuery}
                  onChange={(event) => setTagQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); createTag(); } }} /></div>
                <div className="tag-picker-options">
                  {availableTags.map((tag) => <label key={tag} className="tag-picker-option"><input type="checkbox" checked={selectedTags.includes(tag)} disabled={!selectedTags.includes(tag) && selectedTags.length >= 20}
                    onChange={(event) => updateTags(event.target.checked ? [...selectedTags, tag] : selectedTags.filter((item) => item !== tag))} />
                    <span className={`tag-color-dot tag-color-${tagColorIndex(tag, props.tagColors)}`} aria-hidden="true" /><span>{tag}</span><small>{props.tagCounts[tag] || ''}</small></label>)}
                  {!availableTags.length && <span className="tag-picker-empty">{tagQuery.trim() ? t('按回车创建新标签') : t('no_tags')}</span>}
                </div>
                {tagQuery.trim() && !availableTags.some((tag) => tag === tagQuery.trim()) && <button className="tag-picker-create" onClick={createTag}><Plus size={16} />{t('新建标签')}</button>}
              </div>
            </details>
            <span className="quick-publish-hint">{t('按 ⌘/Ctrl + Enter 发布')}</span>
            <button className="primary" disabled={!content.trim() || publishing || props.disabled} onClick={() => void publish()}><Send size={15} />{publishing ? t('正在发布…') : t(editingId ? '更新小记' : '小记一下')}</button>
          </div>
        </div>
      </section>
      <section className="quick-feed-pane" aria-label={t('小记列表')}>
        <div className="quick-feed-toolbar">
          <label className="quick-search"><Search size={17} /><input aria-label={t('搜索小记')} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('搜索小记')} /></label>
          <label className="quick-select"><Filter size={16} /><select aria-label={t('筛选标签')} value={filterTag} onChange={(event) => setFilterTag(event.target.value)}><option value="">{t('全部标签')}</option>{props.tags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}</select></label>
          <select className="quick-order" aria-label={t('小记排序')} value={order} onChange={(event) => setOrder(event.target.value as 'newest' | 'oldest')}><option value="newest">{t('最近更新')}</option><option value="oldest">{t('最早更新')}</option></select>
        </div>
        <div className={`quick-feed ${view}`}>
          {props.loading && !filtered.length ? <div className="quick-empty">{t('loading')}</div>
            : filtered.length ? filtered.map((note) => <article className={`quick-note-card ${expanded.has(note.id) ? 'expanded' : ''}`} key={note.id} tabIndex={0} role="group"
              aria-label={t('小记：{0}', note.title || t('未命名笔记'))}
              onClick={() => void open(note.id)} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); void open(note.id); } }}>
              <div className={`quick-card-actions ${menu?.id === note.id ? 'open' : ''}`} data-quick-menu-root onClick={(event) => event.stopPropagation()}>
                <button className="icon-button" aria-label={t('编辑小记')} onClick={() => void open(note.id)}><Pencil size={17} /></button>
                <button className="icon-button" aria-label={t('更多小记操作')} aria-haspopup="menu" aria-expanded={menu?.id === note.id}
                  onClick={(event) => openMenu(event.currentTarget, note.id)}><MoreHorizontal size={18} /></button>
              </div>
              <time>{note.pinned && <Pin size={12} fill="currentColor" aria-label={t('已置顶')} />}{t('更新于 {0}', new Date(note.updatedAt).toLocaleString(dateLocale(), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }))}</time>
              <div className="quick-card-preview">
                <Preview content={expanded.has(note.id)
                  ? props.activeNote?.id === note.id ? props.activeNote.content : detailContent[note.id] ?? note.excerpt
                  : note.excerpt} onImage={() => undefined} />
              </div>
              {note.tags.length > 0 && <footer>{note.tags.map((tag) => <span key={tag}><span className={`tag-color-dot tag-color-${tagColorIndex(tag, props.tagColors)}`} aria-hidden="true" />{tag}</span>)}</footer>}
            </article>) : <div className="quick-empty"><Plus size={26} /><strong>{t(query || filterTag ? '没有匹配的小记' : '还没有小记')}</strong><span>{t('在左侧记下此刻的想法')}</span></div>}
          {props.hasMore && <button className="load-more" onClick={props.loadMore}>{t('加载更多')}</button>}
        </div>
      </section>
    </div>
  </main>{menu && menuNote && createPortal(<div ref={menuElement} className={`quick-card-menu ${menu.panel === 'folders' ? 'quick-card-menu-folders' : ''}`} data-quick-menu-root role="menu" aria-label={t('小记操作')}
    style={{ left: menu.left, top: menu.top }}>
    {menu.panel === 'folders' ? <>
      <button role="menuitem" onClick={() => setMenuPanel(null)}><ChevronLeft size={16} />{t('移动到文件夹')}</button>
      <div className="quick-card-submenu" role="group" aria-label={t('选择文件夹')}>
        {props.folders.length ? (
          <FolderTreePicker
            folders={props.folders}
            allowRoot={false}
            itemRole="menuitem"
            onSelect={(folder) => invoke(() => props.moveToFolder(menuNote.id, folder.id))}
          />
        ) : (
          <span>{t('暂无文件夹')}</span>
        )}
      </div>
    </> : menu.panel === 'tags' ? <>
      <button role="menuitem" onClick={() => setMenuPanel(null)}><ChevronLeft size={16} />{t('添加标签')}</button>
      <div className="quick-card-submenu" role="group" aria-label={t('选择标签')}>
        {props.tags.filter((tag) => !menuNote.tags.includes(tag)).length
          ? props.tags.filter((tag) => !menuNote.tags.includes(tag)).map((tag) => <button key={tag} role="menuitem"
            onClick={() => invoke(() => props.addTag(menuNote.id, tag))}><span className={`tag-color-dot tag-color-${tagColorIndex(tag, props.tagColors)}`} aria-hidden="true" /><span>{tag}</span></button>)
          : <span>{t('暂无可添加标签')}</span>}
      </div>
    </> : <>
      <button role="menuitem" onClick={() => invoke(() => props.togglePin(menuNote))}><Pin size={16} fill={menuNote.pinned ? 'currentColor' : 'none'} />{t(menuNote.pinned ? '取消置顶' : '置顶')}</button>
      <button role="menuitem" disabled={detailLoading === menuNote.id} onClick={() => invoke(() => toggleDetails(menuNote))}><Eye size={16} />{t(expanded.has(menuNote.id) ? '收起详情' : '查看详情')}</button>
      <button role="menuitem" onClick={() => invoke(() => props.copyLink(menuNote))}><Link2 size={16} />{t('复制链接')}</button>
      <button role="menuitem" disabled={props.disabled || menuNote.revision === 0} onClick={() => invoke(() => props.share(menuNote.id))}><Share2 size={16} />{t('分享')}</button>
      <button role="menuitem" disabled={!props.folders.length} onClick={() => setMenuPanel('folders')}><FolderInput size={16} />{t('移动到文件夹')}</button>
      <button role="menuitem" onClick={() => setMenuPanel('tags')}><Tag size={16} />{t('添加标签')}</button>
      <div className="quick-card-menu-separator" role="separator" />
      <button role="menuitem" disabled={props.disabled} onClick={() => invoke(() => props.archive(menuNote.id))}><Archive size={16} />{t('归档')}</button>
      <button role="menuitem" disabled={props.disabled || menuNote.revision === 0} onClick={() => invoke(() => props.showHistory(menuNote))}><History size={16} />{t('查看历史')}</button>
      <button role="menuitem" className="danger" disabled={props.disabled} onClick={() => invoke(() => props.remove(menuNote.id))}><Trash2 size={16} />{t('删除')}</button>
    </>}
  </div>, document.body)}</>;
}
