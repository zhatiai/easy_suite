import { useEffect, useMemo, type ReactNode } from 'react';
import { FileText, FolderOpen, LoaderCircle } from 'lucide-react';
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
        <header className="folder-overview-header"><FolderOpen size={34} /><h1 id="folder-overview-title">{props.folder.name}</h1></header>
        <dl className="folder-overview-meta">
          <div><dt>{t('created_at')}</dt><dd>{new Date(props.folder.createdAt).toLocaleString(dateLocale(), { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</dd></div>
          <div><dt>{t('total_files')}</dt><dd>{t('{0} 个文件', totalFiles)}</dd></div>
        </dl>
        <section className="folder-overview-tree" aria-labelledby="folder-overview-contents"><h2 id="folder-overview-contents">{t('folder_contents')}</h2>{renderContents(props.folder)}</section>
      </div>
    </div>
  </section>;
}
