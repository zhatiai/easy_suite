import { useEffect, useMemo, useRef, useState } from 'react';
import { FileText, Link2, LocateFixed, Plus } from 'lucide-react';
import { folderRelativePath, type Folder, type Note, type NoteLinkDirection, type NoteLinkPage, type NoteSummary } from '../shared/types';
import { fileLinks, noteLinkOccurrences } from '../shared/noteLinks';
import type { DocumentViewerFile } from './DocumentViewer';
import { t } from './i18n';

export interface NoteConnectionsProps {
  note: Note;
  revision: number;
  offlineLibrary: boolean;
  load(note: Note, direction: NoteLinkDirection, offset?: number): Promise<NoteLinkPage>;
  onOpen(id: string): void;
  onInsert(): void;
  folders: Folder[];
  onLocate(id: string, file?: boolean): void;
  onFile(file: DocumentViewerFile): void;
  disabled: boolean;
}

const emptyPage: NoteLinkPage = { notes: [], missingIds: [], nextOffset: null };

function LinkSection({ note, direction, revision, offlineLibrary, load, onOpen, onInsert, disabled, folders, onLocate, onFile }: NoteConnectionsProps & { direction: NoteLinkDirection }) {
  const [page, setPage] = useState(emptyPage);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retryCount, setRetryCount] = useState(0);
  const loader = useRef(load);
  loader.current = load;
  const generation = useRef(0);
  const outgoing = direction === 'outgoing';
  const files = useMemo(() => outgoing ? fileLinks(note.content) : [], [note.content, outgoing]);
  const occurrences = useMemo(() => {
    const counts = new Map<string, number>();
    if (outgoing) for (const id of noteLinkOccurrences(note.content)) counts.set(id, (counts.get(id) ?? 0) + 1);
    return counts;
  }, [note.content, outgoing]);
  useEffect(() => {
    const current = ++generation.current;
    setPage(emptyPage);
    setError('');
    setLoading(true);
    const timer = window.setTimeout(() => {
      const result = note.deletedAt !== null || !offlineLibrary && note.revision === 0
        ? Promise.resolve(emptyPage) : loader.current(note, direction);
      void result.then((value) => { if (current === generation.current) setPage(value); })
        .catch((cause: unknown) => { if (current === generation.current) setError(String(cause)); })
        .finally(() => { if (current === generation.current) setLoading(false); });
    }, 150);
    return () => { window.clearTimeout(timer); generation.current++; };
  }, [note.id, note.content, note.revision, note.deletedAt, direction, revision, offlineLibrary, retryCount]);

  const more = async () => {
    if (page.nextOffset === null || loading) return;
    const current = generation.current;
    setLoading(true);
    setError('');
    try {
      const next = await loader.current(note, direction, page.nextOffset);
      if (current === generation.current) setPage((previous) => ({
        notes: [...previous.notes, ...next.notes.filter((item) => !previous.notes.some((existing) => existing.id === item.id))],
        missingIds: [...new Set([...previous.missingIds, ...next.missingIds])],
        nextOffset: next.nextOffset,
      }));
    } catch (cause) { if (current === generation.current) setError(String(cause)); }
    finally { if (current === generation.current) setLoading(false); }
  };

  return <section className="note-connections" aria-label={t(outgoing ? 'navigation_references' : 'backlinks')} aria-busy={loading}>
    <div className="connections-header"><span className="connections-count">{page.notes.length + files.length > 0 && `${t('entity_count', page.notes.length + files.length)}${page.nextOffset !== null ? '+' : ''}`}</span>
      {outgoing && <button className="icon-button" aria-label={t('add_note_link')} title={t('add_note_link')} disabled={disabled} onClick={onInsert}><Plus size={15} /></button>}
    </div>
    {(page.notes.length > 0 || files.length > 0) && <nav>{page.notes.map((item) => <div key={item.id} className="connection-row">
      <button aria-label={item.title || t('untitled_note')} data-full-name
        data-full-name-content={`${item.title || t('untitled_note')}\n${folderRelativePath(item.folderId, folders) || t('根目录')}`}
        onClick={() => onOpen(item.id)}><Link2 size={13} />
        <span className="connection-copy"><span data-full-name-label>{item.title || t('untitled_note')}</span><small aria-hidden="true">{folderRelativePath(item.folderId, folders) || t('根目录')}{outgoing && (occurrences.get(item.id.toLowerCase()) ?? 0) > 1 ? ` · ${t('reference_count', occurrences.get(item.id.toLowerCase())!)}` : ''}</small></span>
      </button>
      {outgoing && <button className="icon-button" aria-label={t('locate_note_reference', item.title || t('untitled_note'))} onClick={() => onLocate(item.id)}><LocateFixed size={14} /></button>}
    </div>)}
      {files.map((file) => <div className="connection-row" key={file.id}><button aria-label={file.filename} data-full-name data-full-name-content={`${file.filename}\n${file.url}`} onClick={() => onFile({ ...file, type: /\.pdf$/i.test(file.filename) ? 'pdf' : 'txt' })}><FileText size={13} /><span data-full-name-label>{file.filename}</span></button>
        <button className="icon-button" aria-label={t('locate_note_reference', file.filename)} onClick={() => onLocate(file.id, true)}><LocateFixed size={14} /></button></div>)}
    </nav>}
    {!loading && !error && page.notes.length === 0 && files.length === 0 && page.nextOffset === null && <div className="panel-empty">{t(outgoing ? 'no_outgoing_links' : 'no_backlinks')}</div>}
    {page.missingIds.length > 0 && <div className="panel-empty">{t('unavailable_note_links', page.missingIds.length)}</div>}
    {error && <div className="connections-error" role="alert">{error}<button onClick={() => { if (page.nextOffset !== null) void more(); else setRetryCount((value) => value + 1); }}>{t('retry')}</button></div>}
    {loading && <div className="panel-empty" role="status">{t('loading')}</div>}
    {page.nextOffset !== null && <button className="connections-more" disabled={loading} onClick={() => void more()}>{t('load_more')}</button>}
  </section>;
}

export function NoteConnections(props: NoteConnectionsProps & { direction: NoteLinkDirection }) {
  return <div className="note-connections-panel"><LinkSection {...props} /></div>;
}
