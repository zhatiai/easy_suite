import { useEffect, useMemo, type ReactNode } from 'react';
import { Copy, FileText, FolderInput, FolderOpen, FolderPlus, LoaderCircle, Plus, Share2, Upload } from 'lucide-react';
import type { Folder } from '../shared/types';
import type { ExplorerFolderState } from './useNotebook';
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
  shareFolder?(folder: Folder): void;
  copyFolderPath?(folder: Folder): void;
  copyFolderId?(folder: Folder): void;
}

export function FolderOverview(props: FolderOverviewProps) {
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

  const renderContents = (folder: Folder): ReactNode => {
    const children = childrenByParent.get(folder.id) ?? [];
    const state = props.explorerFolders[props.explorerFolderKey(folder.id)];
    return <ul className="folder-overview-children">
      {children.map((child) => <li className="folder-overview-branch" key={child.id}>
        <div className="folder-overview-folder"><FolderOpen size={18} /><strong>{child.name}</strong><small>{t('{0} 个文件', child.noteCount)}</small></div>
        {renderContents(child)}
      </li>)}
      {state?.notes.map((note) => <li key={note.id}>
        <button className="folder-overview-file" onClick={() => props.openNote(note.id)}>
          <FileText size={17} />
          <span><strong>{note.title || t('untitled_note')}</strong><small>{new Date(note.updatedAt).toLocaleString(dateLocale(), { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · {t('修订 {0}', note.revision)}</small></span>
        </button>
      </li>)}
      {state?.loading && <li className="folder-overview-state"><LoaderCircle className="spin" size={15} />{t('loading')}</li>}
      {state?.error && <li className="folder-overview-state error"><span>{t('加载失败')}</span><button onClick={() => void props.ensureFolder(folder.id, { force: true })}>{t('retry')}</button></li>}
    </ul>;
  };

  const totalFiles = subtree.reduce((total, folder) => total + folder.noteCount, 0);
  return <section className="folder-overview" aria-labelledby="folder-overview-title">
    <div className="folder-overview-scroll">
      <div className="folder-overview-content">
        <header className="folder-overview-header">
          <div className="folder-overview-heading">
            <FolderOpen size={32} />
            <h1 id="folder-overview-title" title={props.folder.name}>{props.folder.name}</h1>
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
        <section className="folder-overview-tree" aria-labelledby="folder-overview-contents"><h2 id="folder-overview-contents">{t('folder_contents')}</h2>{renderContents(props.folder)}</section>
      </div>
    </div>
  </section>;
}
