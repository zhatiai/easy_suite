import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUpRight, CopyX, Maximize2, Minimize2, X } from 'lucide-react';
import { folderRelativePath, type Folder, type Note, type NoteSummary } from '../shared/types';
import { ApiError } from './api';
import { DocumentViewer, type DocumentViewerFile } from './DocumentViewer';
import { Preview } from './Editor';
import { t } from './i18n';

export type ReferenceTarget = { kind: 'note'; id: string } | { kind: 'file'; file: DocumentViewerFile };
interface Frame { key: number; target: ReferenceTarget; fullscreen: boolean }
interface ReferenceProps {
  folders: Folder[];
  userId: string;
  dark: boolean;
  loadNote(id: string, signal?: AbortSignal): Promise<Note>;
  resolveFile?(id: string): Promise<string | null>;
  resolveNoteLinks(ids: string[], signal?: AbortSignal): Promise<NoteSummary[]>;
  onImage(src: string): void;
  onPromote(note: Note): void;
}

function ReferenceLayer({ frame, active, open, close, closeAll, toggleFullscreen, ...props }: ReferenceProps & {
  frame: Frame;
  active: boolean;
  open(target: ReferenceTarget, trigger?: HTMLElement): void;
  close(): void;
  closeAll(): void;
  toggleFullscreen(): void;
}) {
  const [note, setNote] = useState<Note | null>(null);
  const [loading, setLoading] = useState(frame.target.kind === 'note');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const scroll = useRef<HTMLDivElement>(null);
  const scrollTop = useRef(0);
  const returnFocus = useRef<HTMLElement | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const noteId = frame.target.kind === 'note' ? frame.target.id : '';
  const loader = useRef(props.loadNote);
  loader.current = props.loadNote;
  useEffect(() => {
    if (!noteId) return;
    const controller = new AbortController();
    setError('');
    setLoading(true);
    void loader.current(noteId, controller.signal).then((value) => {
      if (controller.signal.aborted) return;
      if (value.deletedAt !== null) throw new Error(t('note_link_unavailable'));
      setNote(value);
    }).catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      setError(cause instanceof ApiError && [404, 410].includes(cause.status) ? t('note_link_unavailable') :
        cause instanceof Error ? t(cause.message) : String(cause));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [noteId, retry]);
  useLayoutEffect(() => {
    if (!active) return;
    if (scroll.current) scroll.current.scrollTop = scrollTop.current;
    const target = returnFocus.current?.isConnected ? returnFocus.current : closeButton.current;
    target?.focus({ preventScroll: true });
  }, [active, loading]);
  const follow = (target: ReferenceTarget, trigger?: HTMLElement) => {
    scrollTop.current = scroll.current?.scrollTop ?? 0;
    returnFocus.current = trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    open(target, trigger);
  };
  const title = frame.target.kind === 'file' ? frame.target.file.filename : note?.title || t(loading ? 'loading' : 'untitled_note');
  return <section className="reference-layer" hidden={!active}>
    <header className="reference-preview-header">
      <div><h2>{title}</h2>{note && <small>{folderRelativePath(note.folderId, props.folders) || t('根目录')}</small>}</div>
      <div className="reference-window-actions">
        <button className="icon-button" aria-label={t(frame.fullscreen ? 'exit_reference_fullscreen' : 'reference_fullscreen')}
          title={t(frame.fullscreen ? 'exit_reference_fullscreen' : 'reference_fullscreen')} aria-pressed={frame.fullscreen} onClick={toggleFullscreen}>
          {frame.fullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
        </button>
        <button ref={closeButton} className="icon-button" aria-label={t('close_reference_layer')} title={t('close_reference_layer')} onClick={close}><X size={18} /></button>
        <button className="icon-button" aria-label={t('close_all_references')} title={t('close_all_references')} onClick={closeAll}><CopyX size={18} /></button>
      </div>
    </header>
    <div className="reference-preview-toolbar"><span>{t(frame.target.kind === 'note' ? 'note_reference' : '附件')}</span>
      {frame.target.kind === 'note' && <button disabled={!note || loading || !!error} onClick={() => { if (note) props.onPromote(note); }}><ArrowUpRight size={14} />{t('open_reference_main')}</button>}
    </div>
    {frame.target.kind === 'file' ? <div className="reference-file-viewer">
      <DocumentViewer embedded file={frame.target.file} userId={props.userId} resolveFile={props.resolveFile} onExpandFullscreen={toggleFullscreen} />
    </div> : <div ref={scroll} className="reference-preview-content" onScroll={(event) => { if (active) scrollTop.current = event.currentTarget.scrollTop; }}>
      {loading && <div className="panel-empty" role="status">{t('loading')}</div>}
      {error && <div className="reference-preview-error" role="alert"><p>{error}</p><button onClick={() => setRetry((value) => value + 1)}>{t('retry')}</button></div>}
      {!loading && !error && note && <>
        <Preview content={note.content} dark={props.dark} userId={props.userId} onImage={props.onImage} resolveFile={props.resolveFile}
          folders={props.folders} resolveNoteLinks={props.resolveNoteLinks} onNote={(id, trigger) => follow({ kind: 'note', id }, trigger)}
          onViewDocument={(file, trigger) => follow({ kind: 'file', file }, trigger)} />
      </>}
    </div>}
  </section>;
}

export function ReferencePreview({ target, onClose, ...props }: ReferenceProps & { target: ReferenceTarget; onClose(): void }) {
  const nextKey = useRef(1);
  const [stack, setStack] = useState<Frame[]>([{ key: 0, target, fullscreen: false }]);
  const dialog = useRef<HTMLDialogElement>(null);
  const current = stack[stack.length - 1];
  useEffect(() => { dialog.current?.showModal(); }, []);
  const previousTarget = useRef(target);
  useEffect(() => {
    if (previousTarget.current === target) return;
    previousTarget.current = target;
    setStack([{ key: nextKey.current++, target, fullscreen: false }]);
  }, [target]);
  const close = () => {
    if (stack.length === 1) onClose();
    else setStack((previous) => previous.slice(0, -1));
  };
  return <dialog ref={dialog} className={`reference-preview ${current.fullscreen ? 'reference-fullscreen' : ''}`} aria-label={t('reference_preview')}
    onCancel={(event) => { event.preventDefault(); close(); }}
    onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
    {stack.map((frame, index) => <ReferenceLayer key={frame.key} {...props} frame={frame} active={index === stack.length - 1}
      open={(next) => setStack((previous) => [...previous, { key: nextKey.current++, target: next, fullscreen: false }])}
      close={close} closeAll={onClose} toggleFullscreen={() => setStack((previous) => previous.map((item) => item.key === frame.key ? { ...item, fullscreen: !item.fullscreen } : item))} />)}
  </dialog>;
}
