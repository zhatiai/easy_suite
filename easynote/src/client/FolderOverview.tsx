import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ChevronDown,
  ChevronUp,
  Copy,
  FileText,
  FolderInput,
  FolderOpen,
  FolderPlus,
  LoaderCircle,
  Plus,
  Pencil,
  Search,
  Share2,
  Upload,
  X,
} from 'lucide-react';
import type { Folder } from '../shared/types';
import type { ExplorerFolderState } from './useNotebook';
import { updateTruncatedTitle } from './truncatedTitle';
import { dateLocale, t } from './i18n';

interface FolderOverviewProps {
  folder: Folder;
  folders: Folder[];
  explorerFolders: Record<string, ExplorerFolderState>;
  explorerFolderKey(folderId: string | null): string;
  ensureFolder(folderId: string | null, options?: { append?: boolean; force?: boolean }): Promise<void>;
  openNote(id: string): void;
  createChild?(parentId: string): void;
  createNoteIn?(folderId: string): void;
  uploadFileTo?(folderId: string): void;
  moveFolder?(folder: Folder): void;
  editFolder?(folder: Folder): void;
  shareFolder?(folder: Folder): void;
  copyFolderPath?(folder: Folder): void;
  copyFolderId?(folder: Folder): void;
}

interface MatchItem {
  id: string;
  type: 'folder' | 'note';
  text: string;
}

export function FolderOverview(props: FolderOverviewProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const childrenByParent = useMemo(() => {
    const map = new Map<string, Folder[]>();
    for (const folder of props.folders) {
      if (!folder.parentId) continue;
      const siblings = map.get(folder.parentId) ?? [];
      siblings.push(folder);
      map.set(folder.parentId, siblings);
    }
    for (const siblings of map.values()) siblings.sort((left, right) => left.name.localeCompare(right.name, dateLocale()));
    return map;
  }, [props.folders]);

  const subtree = useMemo(() => {
    const result: Folder[] = [];
    const visit = (folder: Folder) => {
      result.push(folder);
      for (const child of childrenByParent.get(folder.id) ?? []) visit(child);
    };
    visit(props.folder);
    return result;
  }, [childrenByParent, props.folder]);

  useEffect(() => {
    for (const folder of subtree) {
      const state = props.explorerFolders[props.explorerFolderKey(folder.id)];
      if (!state) void props.ensureFolder(folder.id);
      else if (!state.loading && !state.error && state.nextOffset !== null) void props.ensureFolder(folder.id, { append: true });
    }
  }, [props.ensureFolder, props.explorerFolderKey, props.explorerFolders, subtree]);

  // Collect matches in DFS tree order matching natural rendering order
  const matches = useMemo(() => {
    const trimmed = searchQuery.trim().toLowerCase();
    if (!trimmed) return [];
    const list: MatchItem[] = [];

    const collect = (f: Folder) => {
      const children = childrenByParent.get(f.id) ?? [];
      for (const child of children) {
        if (child.name.toLowerCase().includes(trimmed)) {
          list.push({ id: `folder-${child.id}`, type: 'folder', text: child.name });
        }
        collect(child);
      }
      const state = props.explorerFolders[props.explorerFolderKey(f.id)];
      if (state?.notes) {
        for (const note of state.notes) {
          const title = note.title || t('untitled_note');
          if (title.toLowerCase().includes(trimmed)) {
            list.push({ id: `note-${note.id}`, type: 'note', text: title });
          }
        }
      }
    };

    collect(props.folder);
    return list;
  }, [childrenByParent, props.folder, props.explorerFolders, props.explorerFolderKey, searchQuery]);

  useEffect(() => {
    setActiveMatchIndex(0);
  }, [searchQuery]);

  useEffect(() => {
    if (activeMatchIndex >= matches.length && matches.length > 0) {
      setActiveMatchIndex(0);
    }
  }, [matches.length, activeMatchIndex]);

  // Smooth scroll to currently active match element
  useEffect(() => {
    if (!searchQuery.trim() || matches.length === 0) return;
    const currentMatch = matches[activeMatchIndex];
    if (!currentMatch) return;
    const el = document.querySelector(`[data-search-id="${currentMatch.id}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [activeMatchIndex, matches, searchQuery]);

  const handleNextMatch = () => {
    if (!matches.length) return;
    setActiveMatchIndex((prev) => (prev + 1) % matches.length);
  };

  const handlePrevMatch = () => {
    if (!matches.length) return;
    setActiveMatchIndex((prev) => (prev - 1 + matches.length) % matches.length);
  };

  const handleClearSearch = () => {
    setSearchQuery('');
    setActiveMatchIndex(0);
    searchInputRef.current?.focus();
  };

  const renderHighlightedText = (text: string, itemId: string) => {
    const trimmed = searchQuery.trim();
    if (!trimmed) return text;
    const lowerText = text.toLowerCase();
    const lowerQuery = trimmed.toLowerCase();
    const isCurrent = matches[activeMatchIndex]?.id === itemId;
    const parts: ReactNode[] = [];
    let lastIndex = 0;
    let index = lowerText.indexOf(lowerQuery, lastIndex);

    while (index !== -1) {
      if (index > lastIndex) {
        parts.push(text.slice(lastIndex, index));
      }
      const matchText = text.slice(index, index + trimmed.length);
      parts.push(
        <mark
          key={index}
          className={`folder-search-highlight ${isCurrent ? 'active' : ''}`}
        >
          {matchText}
        </mark>
      );
      lastIndex = index + trimmed.length;
      index = lowerText.indexOf(lowerQuery, lastIndex);
    }

    if (lastIndex < text.length) {
      parts.push(text.slice(lastIndex));
    }
    return parts;
  };

  const renderContents = (folder: Folder): ReactNode => {
    const children = childrenByParent.get(folder.id) ?? [];
    const state = props.explorerFolders[props.explorerFolderKey(folder.id)];
    return <ul className="folder-overview-children">
      {children.map((child) => {
        const folderItemId = `folder-${child.id}`;
        const isCurrent = matches[activeMatchIndex]?.id === folderItemId;
        return <li className={`folder-overview-branch ${isCurrent ? 'search-match-active' : ''}`} key={child.id} data-search-id={folderItemId}>
          <div className="folder-overview-folder" onPointerEnter={(event) => updateTruncatedTitle(event.currentTarget, event.currentTarget.querySelector<HTMLElement>('strong'))}>
            <FolderOpen size={18} />
            <strong>{renderHighlightedText(child.name, folderItemId)}</strong>
            <small>{t('{0} 个文件', child.noteCount)}</small>
          </div>
          {renderContents(child)}
        </li>;
      })}
      {state?.notes.map((note) => {
        const noteItemId = `note-${note.id}`;
        const isCurrent = matches[activeMatchIndex]?.id === noteItemId;
        const title = note.title || t('untitled_note');
        return <li key={note.id} data-search-id={noteItemId} className={isCurrent ? 'search-match-active' : ''}>
          <button onPointerEnter={(event) => updateTruncatedTitle(event.currentTarget, event.currentTarget.querySelector<HTMLElement>('strong'))} className="folder-overview-file" onClick={() => props.openNote(note.id)}>
            <FileText size={17} />
            <span>
              <strong>{renderHighlightedText(title, noteItemId)}</strong>
              <small>{new Date(note.updatedAt).toLocaleString(dateLocale(), { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · {t('修订 {0}', note.revision)}</small>
            </span>
          </button>
        </li>;
      })}
      {state?.loading && <li className="folder-overview-state"><LoaderCircle className="spin" size={15} />{t('loading')}</li>}
      {state?.error && <li className="folder-overview-state error"><span>{t('加载失败')}</span><button onClick={() => void props.ensureFolder(folder.id, { force: true })}>{t('retry')}</button></li>}
    </ul>;
  };

  const totalFiles = subtree.reduce((total, folder) => total + folder.noteCount, 0);
  return <section className="folder-overview" aria-labelledby="folder-overview-title">
    <div className="folder-overview-scroll">
      <div className="folder-overview-content">
        <header className="folder-overview-header">
          <div className="folder-overview-intro">
            <div className="folder-overview-heading">
              <FolderOpen size={32} />
              <h1 id="folder-overview-title" onPointerEnter={(event) => updateTruncatedTitle(event.currentTarget)}>{props.folder.name}</h1>
            </div>
            {(props.folder.description || props.editFolder) && <div className="folder-description-row">
              {props.folder.description && <p className="folder-overview-description">{props.folder.description}</p>}
              {props.editFolder && <button type="button"
                className={props.folder.description ? 'icon-button folder-description-edit' : 'note-description-action folder-description-add'}
                aria-label={t(props.folder.description ? '编辑描述' : '添加描述')}
                title={t(props.folder.description ? '编辑描述' : '添加描述')}
                onClick={() => props.editFolder?.(props.folder)}>
                {props.folder.description ? <Pencil size={14} /> : <><Plus size={14} /><span>{t('添加描述')}</span></>}
              </button>}
            </div>}
          </div>
          {(props.createChild || props.createNoteIn || props.uploadFileTo || props.moveFolder || props.shareFolder || props.copyFolderPath || props.copyFolderId) && <div className="folder-overview-actions">
            {props.createChild && <button type="button" className="secondary folder-action-primary" aria-label={t('新建子文件夹')} data-tooltip={t('新建子文件夹')} onClick={() => props.createChild?.(props.folder.id)}><FolderPlus size={15} /><span className="folder-action-text">{t('新建子文件夹')}</span></button>}
            {props.uploadFileTo && <button type="button" className="secondary folder-action-primary" aria-label={t('上传文件')} data-tooltip={t('上传文件')} onClick={() => props.uploadFileTo?.(props.folder.id)}><Upload size={15} /><span className="folder-action-text">{t('上传文件')}</span></button>}
            {props.moveFolder && <button type="button" className="secondary folder-action-secondary" aria-label={t('移动文件夹')} data-tooltip={t('移动文件夹')} onClick={() => props.moveFolder?.(props.folder)}><FolderInput size={15} /><span className="folder-action-text">{t('移动文件夹')}</span></button>}
            {props.shareFolder && <button type="button" className="secondary folder-action-secondary" aria-label={t('分享文件夹')} data-tooltip={t('分享文件夹')} onClick={() => props.shareFolder?.(props.folder)}><Share2 size={15} /><span className="folder-action-text">{t('分享文件夹')}</span></button>}
            {props.copyFolderPath && <button type="button" className="secondary folder-action-secondary" aria-label={t('复制路径')} data-tooltip={t('复制路径')} onClick={() => props.copyFolderPath?.(props.folder)}><Copy size={15} /><span className="folder-action-text">{t('复制路径')}</span></button>}
            {props.copyFolderId && <button type="button" className="secondary folder-action-secondary" aria-label={t('复制 ID')} data-tooltip={t('复制 ID')} onClick={() => props.copyFolderId?.(props.folder)}><Copy size={15} /><span className="folder-action-text">{t('复制 ID')}</span></button>}
            {props.createNoteIn && <button type="button" className="primary folder-action-primary" aria-label={t('new_note')} data-tooltip={t('new_note')} onClick={() => props.createNoteIn?.(props.folder.id)}><Plus size={15} /><span className="folder-action-text">{t('new_note')}</span></button>}
          </div>}
        </header>

        <dl className="folder-overview-meta">
          <div><dt>{t('created_at')}</dt><dd>{new Date(props.folder.createdAt).toLocaleString(dateLocale(), { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</dd></div>
          <div><dt>{t('total_files')}</dt><dd>{t('{0} 个文件', totalFiles)}</dd></div>
        </dl>

        {/* 搜索入口：图二位置 */}
        <div className="folder-overview-search" role="search" aria-label={t('搜索文件夹内容')}>
          <div className="folder-overview-search-input-wrap">
            <Search size={15} className="folder-overview-search-icon" aria-hidden="true" />
            <input
              ref={searchInputRef}
              type="text"
              className="folder-overview-search-input"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  if (e.shiftKey) handlePrevMatch();
                  else handleNextMatch();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  handleClearSearch();
                }
              }}
              placeholder={t('搜索当前文件夹内容…')}
              aria-label={t('搜索当前文件夹内容')}
            />
            {searchQuery && (
              <button
                type="button"
                className="folder-overview-search-clear"
                title={t('清空搜索')}
                aria-label={t('清空搜索')}
                onClick={handleClearSearch}
              >
                <X size={14} />
              </button>
            )}
          </div>

          {searchQuery.trim() && (
            <div className="folder-overview-search-nav">
              <span className="folder-overview-search-count">
                {matches.length > 0
                  ? t('{0} / {1}', activeMatchIndex + 1, matches.length)
                  : t('无匹配')}
              </span>
              <button
                type="button"
                className="folder-overview-nav-btn"
                disabled={matches.length === 0}
                title={t('上一个匹配项')}
                aria-label={t('上一个匹配项')}
                onClick={handlePrevMatch}
              >
                <ChevronUp size={15} />
              </button>
              <button
                type="button"
                className="folder-overview-nav-btn"
                disabled={matches.length === 0}
                title={t('下一个匹配项')}
                aria-label={t('下一个匹配项')}
                onClick={handleNextMatch}
              >
                <ChevronDown size={15} />
              </button>
              <button
                type="button"
                className="folder-overview-cancel-btn"
                onClick={handleClearSearch}
              >
                {t('取消')}
              </button>
            </div>
          )}
        </div>

        <section className="folder-overview-tree" aria-labelledby="folder-overview-contents">
          <h2 id="folder-overview-contents">{t('folder_contents')}</h2>
          {renderContents(props.folder)}
        </section>
      </div>
    </div>
  </section>;
}
