import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronRight, FileText, Folder as FolderIcon, Link2, Search } from 'lucide-react';
import { folderRelativePath, type Folder, type LinkedFile, type NoteSummary } from '../shared/types';
import { t } from './i18n';
import { folderEntityCounts } from './knowledge';

export type LinkTarget = { kind: 'note'; note: NoteSummary } | { kind: 'file'; file: LinkedFile };
export const linkTargetKey = (target: LinkTarget) => target.kind === 'note' ? `note:${target.note.id}` : `file:${target.file.id}`;

type BrowseNotes = (folderId: string | null, offset?: number) => Promise<{ notes: NoteSummary[]; nextOffset: number | null }>;
interface FolderTargetsProps {
  folderId: string | null;
  sourceId: string;
  childrenByParent: Map<string | null, Folder[]>;
  entityCounts: Map<string, number>;
  rootCount: number | null;
  browseNotes: BrowseNotes;
  renderTarget(target: LinkTarget): ReactNode;
}

function FolderTargets(props: FolderTargetsProps) {
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [offset, setOffset] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const loader = useRef(props.browseNotes);
  loader.current = props.browseNotes;
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    void loader.current(props.folderId, offset).then((page) => {
      if (!active) return;
      setNotes((previous) => {
        const ids = new Set(previous.map((note) => note.id));
        return [...previous, ...page.notes.filter((note) => note.id !== props.sourceId && !ids.has(note.id))];
      });
      setNextOffset(page.nextOffset);
    }).catch((cause: unknown) => { if (active) setError(String(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [props.folderId, props.sourceId, offset, retry]);
  const children = props.childrenByParent.get(props.folderId) ?? [];
  const contents = <>
    {notes.map((note) => props.renderTarget({ kind: 'note', note }))}
    {loading && <div className="panel-empty" role="status">{t('loading')}</div>}
    {error && <div className="error" role="alert">{error}<button onClick={() => setRetry((value) => value + 1)}>{t('retry')}</button></div>}
    {!loading && !error && (!children.length || props.folderId === null) && !notes.length && nextOffset === null && <div className="panel-empty">{t('no_notes')}</div>}
    {nextOffset !== null && <button disabled={loading} onClick={() => setOffset(nextOffset)}>{t('load_more')}</button>}
  </>;
  return <>
    {children.map((folder) => <LinkFolder key={folder.id} {...props} folder={folder} />)}
    {props.folderId === null ? <details className="link-picker-folder link-picker-root-notes">
      <summary><ChevronRight size={15} /><FileText size={17} /><span>{t('root_notes')}</span><small>{props.rootCount ?? '…'}</small></summary>
      <div className="link-picker-children">{contents}</div>
    </details> : contents}
  </>;
}

function LinkFolder({ folder, ...props }: FolderTargetsProps & { folder: Folder }) {
  const [open, setOpen] = useState(false);
  return <details className="link-picker-folder" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary data-full-name>
      <ChevronRight size={15} /><FolderIcon size={17} /><span data-full-name-label>{folder.name}</span>
      <small aria-label={t('direct_entity_count', props.entityCounts.get(folder.id) ?? 0)}>{props.entityCounts.get(folder.id) ?? 0}</small>
    </summary>
    {open && <div className="link-picker-children"><FolderTargets {...props} folderId={folder.id} /></div>}
  </details>;
}

export function NoteLinkPicker({ sourceId, folders, browseNotes, getCounts, searchNotes, searchFiles, insert, cancel }: {
  sourceId: string;
  folders: Folder[];
  browseNotes: BrowseNotes;
  getCounts(): Promise<{ rootNotes: number; files: number }>;
  searchNotes(query: string): Promise<NoteSummary[]>;
  searchFiles(query: string, offset?: number): Promise<{ files: LinkedFile[]; nextOffset: number | null }>;
  insert(targets: LinkTarget[]): void;
  cancel(): void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<LinkTarget[]>([]);
  const [selected, setSelected] = useState(new Map<string, LinkTarget>());
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [counts, setCounts] = useState<{ rootNotes: number; files: number } | null>(null);
  const entityCounts = useMemo(() => folderEntityCounts(folders), [folders]);
  const searching = !!query.trim();
  const childrenByParent = useMemo(() => {
    const ids = new Set(folders.map((folder) => folder.id));
    const map = new Map<string | null, Folder[]>();
    for (const folder of folders) {
      const parentId = folder.parentId && ids.has(folder.parentId) ? folder.parentId : null;
      const children = map.get(parentId) ?? [];
      children.push(folder);
      map.set(parentId, children);
    }
    for (const children of map.values()) children.sort((a, b) => a.name.localeCompare(b.name));
    return map;
  }, [folders]);
  const list = useRef<HTMLDivElement>(null);
  const loaders = useRef({ searchNotes, searchFiles, getCounts });
  loaders.current = { searchNotes, searchFiles, getCounts };
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    setResults([]);
    setLoading(true);
    setError('');
    setNextOffset(null);
    const timer = window.setTimeout(() => {
      void Promise.allSettled([query.trim() ? loaders.current.searchNotes(query) : Promise.resolve([]), loaders.current.searchFiles(query),
        query.trim() ? Promise.resolve(null) : loaders.current.getCounts()]).then(([notesResult, filesResult, countsResult]) => {
        if (generation.current !== current) return;
        const notes = notesResult.status === 'fulfilled' ? notesResult.value : [];
        const files = filesResult.status === 'fulfilled' ? filesResult.value : { files: [], nextOffset: null };
        if (notesResult.status === 'rejected' || filesResult.status === 'rejected' || countsResult.status === 'rejected') setError(t('link_search_partial_failure'));
        if (countsResult.status === 'fulfilled' && countsResult.value) setCounts(countsResult.value);
        setResults([...notes.filter((note) => note.id !== sourceId).map((note): LinkTarget => ({ kind: 'note', note })),
          ...files.files.map((file): LinkTarget => ({ kind: 'file', file }))]);
        setNextOffset(files.nextOffset);
      }).catch((cause: unknown) => { if (generation.current === current) setError(String(cause)); })
        .finally(() => { if (generation.current === current) setLoading(false); });
    }, 100);
    return () => { window.clearTimeout(timer); generation.current++; };
  }, [query, sourceId, retry]);
  const more = async () => {
    if (nextOffset === null || loading) return;
    const current = generation.current;
    setLoading(true);
    try {
      const page = await loaders.current.searchFiles(query, nextOffset);
      if (generation.current !== current) return;
      setResults((previous) => {
        const found = new Set(previous.map(linkTargetKey));
        return [...previous, ...page.files.map((file): LinkTarget => ({ kind: 'file', file })).filter((target) => !found.has(linkTargetKey(target)))];
      });
      setNextOffset(page.nextOffset);
    } catch (cause) { if (generation.current === current) setError(String(cause)); }
    finally { if (generation.current === current) setLoading(false); }
  };
  const renderTarget = (target: LinkTarget) => {
    const key = linkTargetKey(target);
    const title = target.kind === 'note' ? target.note.title || t('untitled_note') : target.file.filename;
    const path = target.kind === 'note' ? folderRelativePath(target.note.folderId, folders) || t('根目录') : t('insert_attachment');
    return <label className="link-picker-row" key={key} data-full-name>
      <input type="checkbox" aria-label={title} checked={selected.has(key)} onChange={(event) => {
        const checked = event.target.checked;
        setSelected((previous) => { const next = new Map(previous); if (checked) next.set(key, target); else next.delete(key); return next; });
      }} />
      {target.kind === 'note' ? <Link2 size={16} /> : <FileText size={16} />}
      <span className="link-picker-copy"><span data-full-name-label>{title}</span><small>{path}{target.kind === 'note' && target.note.archived ? ` · ${t('已归档')}` : ''}</small></span>
    </label>;
  };
  return <>
    <label className="command-search"><Search size={16} /><input autoFocus aria-label={t('搜索链接目标')} placeholder={t('search_link_targets')}
      value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
        if (event.key === 'ArrowDown' && !event.nativeEvent.isComposing) {
          event.preventDefault(); list.current?.querySelector<HTMLElement>('summary, input, button:not(:disabled)')?.focus();
        }
      }} /></label>
    {error && <div className="error" role="alert">{error}<button onClick={() => setRetry((value) => value + 1)}>{t('retry')}</button></div>}
    <div ref={list} className="note-link-picker" aria-busy={loading} onKeyDown={(event) => {
      if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      const inputs = [...(list.current?.querySelectorAll<HTMLElement>('summary, input, button:not(:disabled)') ?? [])]
        .filter((element) => element.getClientRects().length > 0);
      const index = inputs.indexOf(document.activeElement as HTMLElement);
      if (index < 0) return;
      event.preventDefault(); inputs[(index + (event.key === 'ArrowDown' ? 1 : inputs.length - 1)) % inputs.length]?.focus();
    }}>
      {!searching && <FolderTargets folderId={null} sourceId={sourceId} childrenByParent={childrenByParent} entityCounts={entityCounts} rootCount={counts?.rootNotes ?? null} browseNotes={browseNotes} renderTarget={renderTarget} />}
      {searching ? results.map(renderTarget) : <details className="link-picker-folder">
        <summary><ChevronRight size={15} /><FileText size={17} /><span>{t('附件')}</span><small>{counts?.files ?? '…'}</small></summary>
        <div className="link-picker-children">{results.map(renderTarget)}
          {loading && <div className="panel-empty" role="status">{t('loading')}</div>}
          {!loading && !results.length && !error && <div className="panel-empty">{t('no_attachments')}</div>}
          {nextOffset !== null && <button disabled={loading} onClick={() => void more()}>{t('load_more')}</button>}
        </div>
      </details>}
      {searching && loading && <div className="panel-empty" role="status">{t('loading')}</div>}
      {searching && !loading && !error && !results.length && <div className="panel-empty">{t('no_matching_notes')}</div>}
      {searching && nextOffset !== null && <button disabled={loading} onClick={() => void more()}>{t('load_more')}</button>}
    </div>
    <div className="dialog-actions link-picker-actions"><span>{t('selected_link_count', selected.size)}</span><button onClick={cancel}>{t('cancel')}</button>
      <button className="primary" disabled={!selected.size} onClick={() => insert([...selected.values()])}>{t('insert_selected_links')}</button></div>
  </>;
}
