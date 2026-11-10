import { useEffect, useState } from 'react';
import { Archive, ClipboardList, FileText, Folder, GitMerge, MoreHorizontal, NotebookPen, Palette, Pencil, Plus, Search, Settings, Share2, Tag, Trash2 } from 'lucide-react';
import type { Folder as FolderItem } from '../shared/types';
import { dateLocale, t } from './i18n';
import { updateTruncatedTitle } from './truncatedTitle';
import { TAG_COLOR_COUNT, tagColorIndex } from './tagColors';

interface NavigationRailProps {
  username: string;
  view: string;
  activeTag: string;
  sharing: boolean;
  quickNotes: boolean;
  tags: string[];
  tagCounts: Record<string, number>;
  tagColors: Record<string, number>;
  folders: FolderItem[];
  activeFolderId: string | null | undefined;
  disabled: boolean;
  online: boolean;
  openSearch(): void;
  chooseView(view: string, tag?: string): void;
  chooseFolder(id: string): void;
  openTasks(): void;
  openQuickNotes(): void;
  openSharing(): void;
  openSettings(): void;
  createFolder(): void;
  manageTags(): void;
  renameTag(tag: string): void;
  mergeTag(tag: string): void;
  deleteTag(tag: string): void;
  setTagColor(tag: string, color: number): void;
}

export function NavigationRail(props: NavigationRailProps) {
  const [searchDismissed, setSearchDismissed] = useState(false);
  const [colorTarget, setColorTarget] = useState<string | null>(null);
  const allNotesActive = !props.quickNotes && !props.sharing && props.view === 'all' && !props.activeTag && props.activeFolderId === undefined;
  const rootFolders = props.folders
    .filter((folder) => folder.parentId === null)
    .sort((left, right) => left.name.localeCompare(right.name, dateLocale()));
  useEffect(() => {
    const closeMenus = () => {
      setColorTarget(null);
      for (const menu of document.querySelectorAll<HTMLDetailsElement>('.tag-action-menu[open]')) menu.removeAttribute('open');
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('.tag-action-menu')) return;
      closeMenus();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const openMenu = document.querySelector<HTMLDetailsElement>('.tag-action-menu[open]');
      if (!openMenu) return;
      event.preventDefault();
      openMenu.removeAttribute('open');
      setColorTarget(null);
      openMenu.querySelector<HTMLElement>('summary')?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);
  const closeTagMenu = (target: HTMLElement) => {
    target.closest('details')?.removeAttribute('open');
    setColorTarget(null);
  };
  return <aside className={`sidebar navigation-rail auto-navigation-rail ${searchDismissed ? 'search-dismissed' : ''}`} id="navigation-rail"
    onPointerEnter={() => setSearchDismissed(false)} onPointerLeave={() => setSearchDismissed(false)}
    onFocusCapture={() => setSearchDismissed(false)}>
    <div className="brand navigation-brand">
      <img className="brand-icon" src="/easynote-icon.svg" width="32" height="32" alt="" aria-hidden="true" />
      <span className="brand-copy"><strong>EasyNote</strong><small>{t('记录，让思考更轻松')}</small></span>
    </div>
    <button className="navigation-search navigation-summary" aria-label={t('搜索笔记')} onClick={() => { setSearchDismissed(true); props.openSearch(); }}><Search size={18} /><span>{t('搜索笔记')}</span></button>
    <nav className="primary-navigation" aria-label={t('note_categories')}>
      <button aria-label={t('all_notes')} title={t('all_notes')} className={allNotesActive ? 'active' : ''} aria-current={allNotesActive ? 'page' : undefined} onClick={() => props.chooseView('all')}><FileText size={18} /><span className="navigation-label">{t('all_notes')}</span></button>
      <button aria-label={t('小记')} title={t('小记')} className={props.quickNotes ? 'active' : ''} aria-current={props.quickNotes ? 'page' : undefined} onClick={props.openQuickNotes}><NotebookPen size={18} /><span className="navigation-label">{t('小记')}</span></button>
      <button aria-label={t('task_center')} title={t('task_center')} onClick={props.openTasks}><ClipboardList size={18} /><span className="navigation-label">{t('task_center')}</span></button>
      <button aria-label={t('归档笔记')} className={!props.sharing && props.view === 'archive' ? 'active' : ''} onClick={() => props.chooseView('archive')}><Archive size={18} /><span className="navigation-label">{t('archive')}</span></button>
      <button aria-label={t('分享管理')} className={props.sharing ? 'active' : ''} disabled={!props.online} onClick={props.openSharing}><Share2 size={18} /><span className="navigation-label">{t('sharing')}</span></button>
      <button aria-label={t('trash')} title={t('trash')} className={!props.sharing && props.view === 'trash' ? 'active' : ''} onClick={() => props.chooseView('trash')}><Trash2 size={18} /><span className="navigation-label">{t('trash')}</span></button>
    </nav>
    <div className="navigation-scroll">
      <div className="section-label"><span>{t('文件夹')}</span><button className="section-action" aria-label={t('新建文件夹')} disabled={!props.online} onClick={props.createFolder}><Plus size={16} /></button></div>
      <nav className="folder-nav" aria-label={t('文件夹')}>
        {rootFolders.map((folder) => <button key={folder.id} className={`navigation-summary ${props.activeFolderId === folder.id ? 'active' : ''}`} aria-current={props.activeFolderId === folder.id ? 'page' : undefined}
          onPointerEnter={(event) => updateTruncatedTitle(event.currentTarget, event.currentTarget.querySelector<HTMLElement>('span'))} onClick={() => props.chooseFolder(folder.id)}>
          <Folder size={17} /><span>{folder.name}</span><small>{folder.noteCount || ''}</small>
        </button>)}
      </nav>
      <div className="section-label"><span>{t('tags')}</span><button className="section-action" aria-label={t('管理标签')} onClick={props.manageTags}><Plus size={16} /></button></div>
      <nav className="tag-nav" aria-label={t('tags')}>
        {props.tags.map((tag) => {
          const color = tagColorIndex(tag, props.tagColors);
          const active = !props.sharing && props.activeTag === tag;
          return <div className={`tag-navigation-row ${active ? 'active' : ''}`} key={tag}>
            <button className="tag-navigation-select" aria-current={active ? 'page' : undefined} onClick={() => props.chooseView(props.view, tag)}>
              <span className={`tag-color-dot tag-color-${color}`} aria-hidden="true" /><span>{tag}</span><small>{props.tagCounts[tag] || ''}</small>
            </button>
            <details className="tag-action-menu" onToggle={(event) => {
              if (!event.currentTarget.open) return;
              setColorTarget(null);
              for (const menu of document.querySelectorAll<HTMLDetailsElement>('.tag-action-menu[open]')) {
                if (menu !== event.currentTarget) menu.removeAttribute('open');
              }
              const trigger = event.currentTarget.querySelector('summary')?.getBoundingClientRect();
              if (!trigger) return;
              const menuWidth = 188;
              event.currentTarget.style.setProperty('--tag-menu-left', `${Math.min(trigger.right + 5, window.innerWidth - menuWidth - 8)}px`);
              event.currentTarget.style.setProperty('--tag-menu-top', `${Math.max(8, Math.min(trigger.top - 7, window.innerHeight - 284))}px`);
            }}>
              <summary className="tag-row-more" aria-label={t('标签操作')}><MoreHorizontal size={16} /></summary>
              <div className="tag-action-popover" role="menu">
                <button role="menuitem" disabled={props.disabled} onClick={(event) => { closeTagMenu(event.currentTarget); props.renameTag(tag); }}><Pencil size={16} />{t('重命名')}</button>
                <button role="menuitem" disabled={props.disabled || props.tags.length <= 1} onClick={(event) => { closeTagMenu(event.currentTarget); props.mergeTag(tag); }}><GitMerge size={16} />{t('合并至')}</button>
                <button role="menuitem" className="danger" disabled={props.disabled} onClick={(event) => { closeTagMenu(event.currentTarget); props.deleteTag(tag); }}><Trash2 size={16} />{t('delete')}</button>
                <button role="menuitem" aria-expanded={colorTarget === tag} onClick={() => setColorTarget((current) => current === tag ? null : tag)}><Palette size={16} />{t('设置颜色')}</button>
                {colorTarget === tag && <div className="tag-color-palette" aria-label={t('设置颜色')}>
                  {Array.from({ length: TAG_COLOR_COUNT }, (_, index) => <button key={index} type="button" className={`tag-color-choice tag-color-${index} ${color === index ? 'selected' : ''}`}
                    aria-label={`${t('设置颜色')} ${index + 1}`} aria-pressed={color === index} onClick={(event) => { props.setTagColor(tag, index); closeTagMenu(event.currentTarget); }} />)}
                </div>}
              </div>
            </details>
          </div>;
        })}
      </nav>
    </div>
    <div className="sidebar-bottom">
      <button aria-label={t('settings')} title={t('settings')} className="account" onClick={props.openSettings}><Settings size={18} /><span>{t('settings')}</span><small>{props.username}</small></button>
    </div>
  </aside>;
}
