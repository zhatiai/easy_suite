import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { ArrowLeft, BookOpen, Download, Maximize2, Minimize2, PenLine, Save, Trash2, Upload, X } from 'lucide-react';
import { CaptureUpdateAction, Excalidraw, MainMenu, exportToBlob, exportToSvg, loadFromBlob, serializeAsJSON } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import '@excalidraw/excalidraw/index.css';
import type { WhiteboardFile } from '../shared/types';
import { api, ApiError } from './api';
import { t, uiLanguage } from './i18n';
import './whiteboard.css';

const legacyAutomaticBackgrounds = new Set(['#f7f7f5', '#f7f3ea', '#f4f3ee']);

Object.assign(window, {
  EXCALIDRAW_ASSET_PATH: import.meta.env.DEV ? '/node_modules/@excalidraw/excalidraw/dist/prod/' : '/whiteboard-assets/',
});

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function exportWhiteboardFile(file: Blob, format: 'png' | 'svg'): Promise<Blob> {
  const scene = await loadFromBlob(file, null, null);
  if (!scene.elements.length) throw new Error('Whiteboard is empty.');
  const options = {
    elements: scene.elements,
    files: scene.files,
    appState: { ...scene.appState, exportEmbedScene: false, exportWithDarkMode: false },
  };
  if (format === 'svg') {
    return new Blob([(await exportToSvg(options)).outerHTML], { type: 'image/svg+xml' });
  }
  return exportToBlob({ ...options, mimeType: 'image/png', maxWidthOrHeight: 4096 });
}

export default function WhiteboardEditor({
  target, dark, canvasColor, online, fullscreen, toggleFullscreen, leaveGuard, maxBytes, close, onSaved, onDeleted,
}: {
  target: WhiteboardFile;
  dark: boolean;
  canvasColor: string;
  online: boolean;
  fullscreen: boolean;
  toggleFullscreen(): void;
  leaveGuard: Ref<() => boolean>;
  maxBytes: number;
  close(): void;
  onSaved(board: WhiteboardFile): void;
  onDeleted(id: string): void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const canvasRoot = useRef<HTMLDivElement>(null);
  const baseline = useRef<string | null>(null);
  const [editing, setEditing] = useState(target.revision === 0);
  const [board, setBoard] = useState(target);
  const [name, setName] = useState(target.name.slice(0, -'.excalidraw'.length));
  const [initial, setInitial] = useState<Awaited<ReturnType<typeof loadFromBlob>> | null>(null);
  const [loaded, setLoaded] = useState(!target.revision);
  const [editor, setEditor] = useState<ExcalidrawImperativeAPI | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!target.revision) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort('timeout'), 30_000);
    api.whiteboard(target.id, controller.signal).then(async ({ board: current, file }) => {
      const scene = await loadFromBlob(file, null, null);
      if (controller.signal.aborted) return;
      if (legacyAutomaticBackgrounds.has(scene.appState.viewBackgroundColor?.toLowerCase() || '')) {
        scene.appState.viewBackgroundColor = canvasColor;
      }
      setBoard(current);
      setName(current.name.slice(0, -'.excalidraw'.length));
      setInitial(scene);
      setLoaded(true);
    }).catch(() => {
      if (!controller.signal.aborted || controller.signal.reason === 'timeout') setError(t('board_load_failed'));
    }).finally(() => window.clearTimeout(timer));
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [target.id, target.revision, retry]);

  const filename = (name.trim() || t('board_untitled')) + '.excalidraw';
  const snapshot = () => editor && serializeAsJSON(editor.getSceneElements(), editor.getAppState(), editor.getFiles(), 'local');
  const isDirty = () => loaded && (filename !== board.name || baseline.current !== null && snapshot() !== baseline.current);
  useEffect(() => {
    function beforeUnload(event: BeforeUnloadEvent) {
      if (busy || isDirty()) { event.preventDefault(); event.returnValue = true; }
    }
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  });
  const canLeave = () => !busy && (!isDirty() || window.confirm(t('board_discard')));
  useImperativeHandle(leaveGuard, () => canLeave);
  const leave = () => { if (canLeave()) close(); };
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 2200);
    return () => window.clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!editor || !loaded || (editing && !fullscreen)) return;
    let frame = 0;
    let layoutFrame = 0;
    const fit = () => {
      const elements = editor.getSceneElements().filter((element) => !element.isDeleted);
      if (elements.length) editor.scrollToContent(elements, {
        fitToViewport: true,
        viewportZoomFactor: 0.9,
        maxZoom: 2,
        animate: false,
      });
    };
    const scheduleFit = () => {
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(layoutFrame);
      frame = window.requestAnimationFrame(() => {
        layoutFrame = window.requestAnimationFrame(fit);
      });
    };
    scheduleFit();
    const observer = new ResizeObserver(scheduleFit);
    if (canvasRoot.current) observer.observe(canvasRoot.current);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(layoutFrame);
    };
  }, [editing, editor, fullscreen, loaded]);

  const save = async () => {
    const scene = snapshot();
    if (!scene || busy || !online) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const saved = await api.saveWhiteboard({ ...board, name: filename }, JSON.parse(scene));
      baseline.current = scene;
      setBoard(saved);
      onSaved(saved);
      setNotice(t('board_saved'));
    } catch (cause) {
      const message = cause instanceof ApiError ? cause.body.error?.message : '';
      setError(message === 'Whiteboard changed.' || cause instanceof ApiError && cause.status === 404
        ? t('board_conflict') : cause instanceof ApiError && cause.status === 413 ? t('board_too_large') : t('board_save_failed'));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (busy || !window.confirm(t('board_delete_confirm', board.name))) return;
    setBusy(true);
    setError('');
    try {
      await api.deleteWhiteboard(board);
      onDeleted(board.id);
      close();
    } catch {
      setError(t('board_delete_failed'));
    } finally {
      setBusy(false);
    }
  };
  const importScene = async (file: File) => {
    if (!editor || !editing || busy) return;
    setError('');
    if (file.size > maxBytes) { setError(t('board_too_large')); return; }
    setBusy(true);
    try {
      const raw = await file.text();
      const scene = JSON.parse(raw);
      if (scene?.type !== 'excalidraw' || !Array.isArray(scene.elements)) throw new Error('Invalid Excalidraw scene.');
      const imported = await loadFromBlob(new Blob([raw], { type: 'application/json' }), null, null);
      if (editor.getSceneElements().length && !window.confirm(t('board_import_replace'))) return;
      baseline.current ??= snapshot();
      editor.addFiles(Object.values(imported.files));
      editor.updateScene({
        elements: imported.elements,
        appState: {
          viewBackgroundColor: imported.appState.viewBackgroundColor,
          selectedElementIds: {},
        },
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      editor.scrollToContent(imported.elements, { fitToViewport: true });
      setNotice(t('board_imported'));
    } catch {
      setError(t('board_import_failed'));
    } finally {
      setBusy(false);
    }
  };

  const exportBoard = async (format: 'excalidraw' | 'png' | 'svg') => {
    if (!editor || busy) return;
    setError('');
    if (format === 'excalidraw') {
      const scene = snapshot();
      if (scene) download(new Blob([scene], { type: 'application/json' }), filename);
      return;
    }
    const elements = editor.getSceneElements();
    if (!elements.length) { setError(t('board_empty')); return; }
    setBusy(true);
    const options = { elements, files: editor.getFiles(),
      appState: { ...editor.getAppState(), exportEmbedScene: false, exportWithDarkMode: false } };
    try {
      const blob = format === 'svg'
        ? new Blob([(await exportToSvg(options)).outerHTML], { type: 'image/svg+xml' })
        : await exportToBlob({ ...options, mimeType: 'image/png', maxWidthOrHeight: 4096 });
      download(blob, filename.replace(/\.excalidraw$/, `.${format}`));
    } catch {
      setError(t('board_export_failed'));
    } finally {
      setBusy(false);
    }
  };

  return <section className={`whiteboard-workspace${fullscreen ? ' whiteboard-fullscreen' : ''}`} aria-label={t('board_label')}
    onKeyDownCapture={(event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        event.stopPropagation();
        if (editing) void save();
      }
    }}>
    <header className="workspace-toolbar whiteboard-header">
      <button type="button" className="icon-button whiteboard-close" title={t('close')} aria-label={t('close')} disabled={busy} onClick={leave}>
        <X className="whiteboard-close-icon" size={18} /><ArrowLeft className="whiteboard-back-icon" size={18} />
      </button>
      {editing ? <input aria-label={t('board_filename')} value={name} maxLength={168} disabled={!loaded || busy}
        onChange={(event) => setName(event.target.value)} />
        : <span className="whiteboard-name" title={filename}>{name || t('board_untitled')}</span>}
      <div className="segmented" role="group" aria-label={t('显示模式')}>
        <button type="button" title={t('编辑模式')} aria-label={t('编辑模式')} aria-pressed={editing} disabled={!editor || busy}
          onClick={() => setEditing(true)}><PenLine size={16} /></button>
        <button type="button" title={t('预览模式')} aria-label={t('预览模式')} aria-pressed={!editing} disabled={!editor || busy}
          onClick={() => setEditing(false)}><BookOpen size={16} /></button>
      </div>
      {editing ? <>
        <button type="button" className="icon-button" title={t('board_import')} aria-label={t('board_import')} disabled={!editor || busy}
          onClick={() => fileInput.current?.click()}><Upload size={17} /></button>
        <input ref={fileInput} hidden type="file" accept=".excalidraw,application/vnd.excalidraw+json" aria-label={t('board_import')}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file) void importScene(file);
          }} />
        <button type="button" className="icon-button" title={t('save')} aria-label={t('save')} disabled={!editor || busy || !online}
          onClick={() => void save()}><Save size={17} /></button>
      </> : <details className="whiteboard-export"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && event.currentTarget.open) {
            event.stopPropagation();
            event.currentTarget.open = false;
            event.currentTarget.querySelector('summary')?.focus();
          }
        }}>
        <summary role="button" className="icon-button" title={t('board_export')} aria-label={t('board_export')}><Download size={17} /></summary>
        <div className="whiteboard-export-options">
          {([['excalidraw', 'board_source'], ['png', 'board_png'], ['svg', 'board_svg']] as const).map(([format, label]) =>
            <button key={format} type="button" disabled={!editor || busy} onClick={(event) => {
              const menu = event.currentTarget.closest('details');
              if (menu) { menu.open = false; menu.querySelector('summary')?.focus(); }
              void exportBoard(format);
            }}>{t(label)}</button>)}
        </div>
      </details>}
      <button type="button" className="icon-button" title={t(fullscreen ? '退出全屏' : '进入全屏')}
        aria-label={t(fullscreen ? '退出全屏' : '进入全屏')} aria-pressed={fullscreen}
        aria-controls="document-workspace" onClick={toggleFullscreen}>
        {fullscreen ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
      </button>
    </header>
    {(error || !online || notice) && <div className="whiteboard-status" role={error ? 'alert' : 'status'}>{error || (!online ? t('board_offline') : notice)}</div>}
    {!loaded ? <div className="workspace-empty">
      {error ? <button className="secondary" onClick={() => { setError(''); setRetry((value) => value + 1); }}>{t('retry')}</button> : t('loading')}
    </div> : <div ref={canvasRoot} className="whiteboard-canvas" onDropCapture={(event) => {
      const file = event.dataTransfer.files[0];
      const boardFile = file && (file.name.toLowerCase().endsWith('.excalidraw') || file.type === 'application/vnd.excalidraw+json');
      if (!editing || busy || boardFile) {
        event.preventDefault();
        event.stopPropagation();
        if (editing && boardFile) void importScene(file);
      }
    }}>
      <Excalidraw initialData={initial ? { ...initial, scrollToContent: true } : { appState: { viewBackgroundColor: canvasColor } }} excalidrawAPI={setEditor}
        langCode={uiLanguage() === 'zh' ? 'zh-CN' : 'en'} theme={dark ? 'dark' : 'light'} validateEmbeddable={false}
        viewModeEnabled={!editing}
        onChange={(elements, state, files) => { baseline.current ??= serializeAsJSON(elements.filter((element) => !element.isDeleted), state, files, 'local'); }}
        UIOptions={{ canvasActions: { changeViewBackgroundColor: true, export: false, saveAsImage: false, saveToActiveFile: false, loadScene: false } }}>
        <MainMenu>
          <MainMenu.Item icon={<Download size={16} />} onSelect={() => void exportBoard('excalidraw')}>{t('board_source')}</MainMenu.Item>
          {board.revision > 0 && online && <MainMenu.Item icon={<Trash2 size={16} />} onSelect={() => void remove()}>{t('board_delete')}</MainMenu.Item>}
          <MainMenu.DefaultItems.ChangeCanvasBackground />
          <MainMenu.DefaultItems.Help />
        </MainMenu>
      </Excalidraw>
    </div>}
  </section>;
}
