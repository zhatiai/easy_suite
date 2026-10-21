import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Archive, ArchiveRestore, ArrowLeft, BookOpen, Check, CheckSquare, ChevronDown, ChevronLeft, ChevronRight, ClipboardList, Code2, Command, Copy, Download, Eye, FileText, Folder as FolderIcon, FolderInput, FolderOpen, FolderPlus, GitMerge, HardDrive, History, ImagePlus, Keyboard, Link2, ListTree, LoaderCircle, LogOut, Maximize2, Menu, Minimize2, Moon, MoreHorizontal, NotebookPen, Paperclip, Pencil, Pin, Plus, Printer, RefreshCw, Save, Search, Settings, Share2, ShieldCheck, Square, Sun, TableOfContents, Tag, Tags, Trash2, Upload, Users, WifiOff, X, RotateCcw, PenLine } from 'lucide-react';
import type { Folder, ManagedNoteShare, Note, NoteInput, NoteSummary, NoteTask, Session, SharedFolder, SharedNote, Version } from '../shared/types';
import { folderRelativePath, noteRelativePath } from '../shared/types';
import { api, setSession, setUnauthorizedHandler, uploadAttachment, uploadImage } from './api';
import { AccountSecurity } from './AccountSecurity';
import { AiAccess } from './AiAccess';
import { StoragePanel, getStorageAlertConfig } from './StoragePanel';
import { Editor, Preview, toggleMarkdownTask, type EditorHandle } from './Editor';
import { DocumentViewer, type DocumentViewerFile } from './DocumentViewer';
import { preloadPdfjs } from './pdfjs';
import { NoteSharing } from './NoteSharing';
import { FolderSharing } from './FolderSharing';
import { ShareManagement } from './ShareManagement';
import { UserManagement } from './UserManagement';
import { NavigationRail } from './NavigationRail';
import { NotebookExplorer } from './NotebookExplorer';
import { FolderOverview } from './FolderOverview';
import { FolderTreePicker } from './FolderTreePicker';
import { DocumentMetaBar } from './DocumentMetaBar';
import { QuickNotes } from './QuickNotes';
import { clearAccountStorage, forgetCachedSession, loadOfflineSession, cacheSession } from './drafts';
import { headings, noteLink } from './knowledge';
import { hasToc, toggleToc, updateToc } from './toc';
import {
  createPdfFile,
  defaultPdfOptions,
  downloadPdfFile,
  isMobilePdfTarget,
  pdfFilename,
  renderPdfPreviewPages,
  type PdfExportOptions,
} from './pdf';
import { useNotebook } from './useNotebook';
import { exportArchive, exportLocalDrafts, importExternalFiles } from './transfer';
import type { NoteConflictField } from './merge';
import { dateLocale, setUiLanguage, t, translate, uiLanguage } from './i18n';
import { tagColorIndex } from './tagColors';

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

function IconButton({ label, children, className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  const tooltip = label ? t(label) : '';
  const resolvedClass = className ? (className.includes('icon-button') ? className : `icon-button ${className}`) : 'icon-button';
  return <button className={resolvedClass} data-tooltip={tooltip || undefined} aria-label={props['aria-label'] || tooltip || undefined} {...props}>{children}</button>;
}

function BrandIcon({ size }: { size: number }) {
  return <img className="brand-icon" src="/easynote-icon.svg" width={size} height={size} alt="" aria-hidden="true" />;
}

function mergeTargets(folders: Folder[], sourceId: string): Folder[] {
  const excluded = new Set([sourceId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of folders) {
      if (folder.parentId && excluded.has(folder.parentId) && !excluded.has(folder.id)) {
        excluded.add(folder.id);
        changed = true;
      }
    }
  }
  return folders.filter((folder) => !excluded.has(folder.id));
}

function FolderTree({ folders, selected, disabled, choose, createChild, edit, remove, move }: {
  folders: Folder[];
  selected: string | null | undefined;
  disabled: boolean;
  choose(id: string): void;
  createChild(id: string): void;
  edit(folder: Folder): void;
  remove(folder: Folder): void;
  move?(folder: Folder): void;
}) {
  const render = (parentId: string | null, depth: number): ReactNode => folders
    .filter((folder) => folder.parentId === parentId)
    .map((folder) => <div key={folder.id} className="folder-tree-branch">
      <div className={`folder-tree-row ${selected === folder.id ? 'active' : ''}`} style={{ paddingLeft: `${8 + depth * 15}px` }}>
        <button className="folder-tree-select" onClick={() => choose(folder.id)}><FolderOpen size={15} /><span>{folder.name}</span><small>{folder.noteCount || ''}</small></button>
        <IconButton label="新建子文件夹" disabled={disabled} onClick={() => createChild(folder.id)}><Plus size={12} /></IconButton>
        {move && <IconButton label="移动文件夹" disabled={disabled} onClick={() => move(folder)}><FolderInput size={12} /></IconButton>}
        <IconButton label="编辑文件夹" disabled={disabled} onClick={() => edit(folder)}><Pencil size={12} /></IconButton>
        <IconButton label="删除文件夹" disabled={disabled} className="danger-icon" onClick={() => remove(folder)}><Trash2 size={12} /></IconButton>
      </div>
      {render(folder.id, depth + 1)}
    </div>);
  return <nav className="folder-tree" aria-label={t('文件夹')}>{render(null, 0)}</nav>;
}

const DialogFeedbackContext = createContext<((target: HTMLElement, mounted: boolean) => void) | null>(null);

function Modal({ title, children, close, className }: { title: string; children: ReactNode; close(): void; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);
  const registerFeedback = useContext(DialogFeedbackContext);
  useEffect(() => { ref.current?.showModal(); }, []);
  useLayoutEffect(() => {
    const target = feedbackRef.current;
    if (!target || !registerFeedback) return;
    registerFeedback(target, true);
    return () => registerFeedback(target, false);
  }, [registerFeedback]);
  return <dialog className={className} ref={ref}
    onCancel={(e) => { e.preventDefault(); close(); }} onClick={(e) => { if (e.target === ref.current) close(); }}>
    <header className="dialog-header"><h2>{t(title)}</h2><IconButton label={t('close')} onClick={close}><X size={18} /></IconButton></header>
    <div className="dialog-feedback-anchor" ref={feedbackRef} />
    {children}
  </dialog>;
}

function PdfPagePreview({ pages, progress, error }: { pages: Blob[]; progress: string; error: string }) {
  const [urls, setUrls] = useState<string[]>([]);
  useEffect(() => {
    const next = pages.map((page) => URL.createObjectURL(page));
    setUrls(next);
    return () => next.forEach((url) => URL.revokeObjectURL(url));
  }, [pages]);
  return <section className="pdf-preview-panel" aria-label={t('PDF 分页预览')} aria-busy={!!progress}>
    <header><strong>{t('分页预览')}</strong><span>{pages.length ? t('{0} 页', pages.length) : ''}</span></header>
    <div className="pdf-preview-pages">
      {progress || pages.length > 0 && !urls.length
        ? <div className="pdf-preview-status"><LoaderCircle className="spin" size={18} />{progress || t('正在打开分页预览')}</div>
        : error
          ? <div className="pdf-preview-error" role="alert">{error}</div>
          : urls.map((url, index) => <figure key={url}>
            <img src={url} alt={t('PDF 第 {0} 页', index + 1)} />
            <figcaption>{index + 1} / {urls.length}</figcaption>
          </figure>)}
    </div>
  </section>;
}

function moveButtonFocus(event: ReactKeyboardEvent<HTMLElement>, selector: string) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(selector)]
    .filter((button) => !button.disabled);
  if (!buttons.length) return;
  const current = event.target instanceof Element ? event.target.closest<HTMLButtonElement>(selector) : null;
  const index = current ? buttons.indexOf(current) : -1;
  const next = event.key === 'Home' ? 0
    : event.key === 'End' ? buttons.length - 1
      : event.key === 'ArrowDown' ? Math.min(index + 1, buttons.length - 1)
        : Math.max(index < 0 ? buttons.length - 1 : index - 1, 0);
  event.preventDefault();
  buttons[next].focus();
}

const conflictFieldName: Record<NoteConflictField, string> = {
  title: '标题',
  content: '正文',
  tags: '标签',
  pinned: '置顶状态',
  quick: '笔记类型',
  archived: '归档状态',
  folderId: '所属文件夹',
  deletedAt: '删除状态',
};

function conflictFieldValue(note: Note, field: NoteConflictField): string {
  if (field === 'tags') return note.tags.join('、') || t('无标签');
  if (field === 'pinned') return note.pinned ? t('已置顶') : t('未置顶');
  if (field === 'quick') return note.quick ? t('小记') : t('正常笔记');
  if (field === 'archived') return note.archived ? t('已归档') : t('未归档');
  if (field === 'folderId') return note.folderId ?? t('根目录');
  if (field === 'deletedAt') return note.deletedAt ? t('已移入回收站') : t('正常笔记');
  return note[field] || t('（空）');
}

function nextFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function sourceLineOffset(content: string, line: number) {
  let offset = 0;
  for (let index = 0; index < line; index++) {
    const newline = content.indexOf('\n', offset);
    if (newline < 0) return content.length;
    offset = newline + 1;
  }
  return offset;
}

async function waitForPrintReady() {
  const deadline = Date.now() + 15_000;
  await nextFrame();
  await nextFrame();
  while (Date.now() < deadline) {
    const root = document.querySelector<HTMLElement>('.print-document[data-printing="true"]');
    const images = [...(root?.querySelectorAll<HTMLImageElement>('img') ?? [])];
    const diagramsReady = !root?.querySelector('[data-mermaid-source]');
    const imagesReady = images.every((image) => image.complete && image.naturalWidth > 0);
    const fontsReady = !document.fonts || document.fonts.status === 'loaded';
    if (root && diagramsReady && imagesReady && fontsReady) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(t('PDF 内容准备超时，请检查笔记中的图片或图表后重试。'));
}

function canSharePdf(file: File) {
  try {
    return typeof navigator.share === 'function' &&
      typeof navigator.canShare === 'function' &&
      navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

function SharedPage({ token }: { token: string }) {
  const [data, setData] = useState<{ note?: SharedNote; folder?: SharedFolder } | null>(null);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void api.sharedItem(token).then((value) => {
      setData(value);
      if (value.note) {
        document.title = `${value.note.title || t('untitled_note')} · EasyNote`;
      } else if (value.folder) {
        document.title = `${value.folder.name} · EasyNote`;
        if (value.folder.notes.length) setSelectedNoteId(value.folder.notes[0].id);
      }
    }).catch((reason: unknown) => setError(String(reason)));
  }, [token]);

  if (error) {
    return <main className="shared-page">
      <header><div className="brand"><BrandIcon size={25} /><span>EasyNote</span></div><span>{t('只读分享')}</span></header>
      <div className="shared-error"><h1>{t('链接不可用')}</h1><p>{t('分享链接不存在、已撤销或已经过期。')}</p></div>
    </main>;
  }

  if (!data) {
    return <main className="shared-page">
      <header><div className="brand"><BrandIcon size={25} /><span>EasyNote</span></div><span>{t('只读分享')}</span></header>
      <div className="shared-loading"><LoaderCircle className="spin" size={22} />{t('正在读取笔记…')}</div>
    </main>;
  }

  if (data.note) {
    const note = data.note;
    return <main className="shared-page">
      <header><div className="brand"><BrandIcon size={25} /><span>EasyNote</span></div><span>{t('只读分享')}</span></header>
      <article className="shared-document">
        <h1>{note.title || t('untitled_note')}</h1>
        <div className="document-meta">
          <time>{t('更新于 {0}', new Date(note.updatedAt).toLocaleString(dateLocale()))}</time>
          <span>{note.expiresAt === null ? t('永久有效') : t('有效至 {0}', new Date(note.expiresAt).toLocaleString(dateLocale()))}</span>
        </div>
        <Preview content={note.content} onImage={(src) => window.open(src, '_blank', 'noopener,noreferrer')} />
      </article>
    </main>;
  }

  if (data.folder) {
    const folder = data.folder;
    const currentNote = folder.notes.find((n) => n.id === selectedNoteId) ?? folder.notes[0];
    return <main className="shared-page shared-folder-page">
      <header>
        <div className="brand"><BrandIcon size={25} /><span>EasyNote</span></div>
        <span className="shared-folder-name"><FolderIcon size={16} />{folder.name}</span>
        <span>{t('只读分享')}</span>
      </header>
      <div className="shared-folder-layout">
        <aside className="shared-folder-sidebar">
          <div className="shared-folder-sidebar-header">
            <span>{t('文件列表')}</span>
            <small>{folder.notes.length} {t('篇笔记')}</small>
          </div>
          {!folder.notes.length ? <div className="panel-empty">{t('no_notes')}</div> :
            <ul className="shared-folder-note-list">
              {folder.notes.map((n) => (
                <li key={n.id}>
                  <button
                    className={`shared-folder-note-btn ${n.id === currentNote?.id ? 'active' : ''}`}
                    onClick={() => setSelectedNoteId(n.id)}
                  >
                    <span className="shared-folder-note-title">{n.title || t('untitled_note')}</span>
                    <span className="shared-folder-note-time">{new Date(n.updatedAt).toLocaleDateString(dateLocale())}</span>
                  </button>
                </li>
              ))}
            </ul>
          }
        </aside>
        <div className="shared-folder-main">
          {currentNote ? (
            <article className="shared-document">
              <h1>{currentNote.title || t('untitled_note')}</h1>
              <div className="document-meta">
                <time>{t('更新于 {0}', new Date(currentNote.updatedAt).toLocaleString(dateLocale()))}</time>
                <span>{folder.expiresAt === null ? t('永久有效') : t('有效至 {0}', new Date(folder.expiresAt).toLocaleString(dateLocale()))}</span>
              </div>
              <Preview content={currentNote.content} onImage={(src) => window.open(src, '_blank', 'noopener,noreferrer')} />
            </article>
          ) : (
            <div className="panel-empty">{t('no_notes')}</div>
          )}
        </div>
      </div>
    </main>;
  }

  return null;
}

export default function App() {
  const shared = /^\/shared\/([a-f0-9]{64})$/.exec(window.location.pathname);
  return shared ? <SharedPage token={shared[1]} /> : <PrivateApp />;
}

function PrivateApp() {
  const [session, updateSession] = useState<Session | null>(null);
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState('');
  const bootGeneration = useRef(0);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [authMode, setAuthMode] = useState<'login' | 'register' | 'reset'>('login');
  const [confirmation, setConfirmation] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [issuedRecoveryCode, setIssuedRecoveryCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const applySession = (value: Session) => {
    setSession(value);
    updateSession(value);
    if (value.user && !value.offline) void cacheSession(value);
  };
  const restoreSession = async (value: Session, cached: Session | null) => {
    applySession(value);
    if (!cached?.user || cached.user.id === value.user?.id) return;
    setPassword('');
    setBootError(value.user ? '' : t('登录已过期，请重新登录。'));
    try { await clearAccountStorage(cached.user.id); }
    catch (error) { setBootError((message) => `${message}\n${String(error)}`.trim()); }
  };
  const boot = () => {
    const generation = ++bootGeneration.current;
    setBooting(true);
    setBootError('');
    let cached: Session | null = null;
    const local = loadOfflineSession().then((value) => {
      if (generation !== bootGeneration.current) return;
      cached = value;
      if (cached?.user) applySession(cached);
    }).catch(() => { /* A cache failure must not block online login. */ });
    void api.session().then(async (value) => {
      await local;
      if (generation === bootGeneration.current) return restoreSession(value, cached);
    }).catch(async (error: unknown) => {
      await local;
      if (generation === bootGeneration.current && !cached?.user) setBootError(String(error));
    }).finally(() => {
      if (generation === bootGeneration.current) setBooting(false);
    });
    return () => { bootGeneration.current++; };
  };
  useEffect(() => {
    setUnauthorizedHandler(() => {
      bootGeneration.current++;
      setBooting(false);
      setPassword('');
      setBootError(t('登录已过期，请重新登录。'));
      updateSession((current) => {
        if (current?.user) void forgetCachedSession(current.user.id);
        return current ? { ...current, user: null, csrf: null, expiresAt: null, offline: false } : current;
      });
    });
    return () => setUnauthorizedHandler(null);
  }, []);
  useEffect(() => {
    const capturePrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    const installed = () => setInstallPrompt(null);
    window.addEventListener('beforeinstallprompt', capturePrompt);
    window.addEventListener('appinstalled', installed);
    return () => {
      window.removeEventListener('beforeinstallprompt', capturePrompt);
      window.removeEventListener('appinstalled', installed);
    };
  }, []);
  useEffect(boot, []);
  useEffect(() => {
    if (!session?.offline || booting) return;
    let running = false;
    let cancelled = false;
    const reconnect = async () => {
      if (running || !navigator.onLine) return;
      running = true;
      try {
        const value = await api.session();
        if (!cancelled) await restoreSession(value, session);
      } catch { /* Keep the cached library available until the server returns. */ }
      finally { running = false; }
    };
    const timer = setInterval(() => void reconnect(), 5_000);
    window.addEventListener('online', reconnect);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener('online', reconnect);
    };
  }, [booting, session?.offline, session?.user?.id]);
  if (booting && !session) return <main className="login">
    <div className="login-form" role="status" aria-live="polite">
      <div className="brand login-brand"><BrandIcon size={32} /><h1>EasyNote</h1></div>
      <div className="login-heading">{t('正在连接')}</div>
      <LoaderCircle className="spin" size={22} aria-label={t('正在连接')} />
    </div>
  </main>;
  if (session?.user) return <AccountWorkspace
    key={session.user.id}
    session={session}
    installApp={installPrompt ? async () => {
      const prompt = installPrompt;
      setInstallPrompt(null);
      await prompt.prompt();
      await prompt.userChoice;
    } : undefined}
    logout={async () => {
      bootGeneration.current++;
      setBooting(false);
      let storageError = '';
      try { await clearAccountStorage(session.user!.id); }
      catch (error) { storageError = t('本机离线数据清理失败：{0}', String(error)); }
      setPassword('');
      setBootError(storageError);
      applySession({ ...session, user: null, csrf: null, expiresAt: null, offline: false });
    }}
  />;
  return <main className="login">
    <form className="login-form" onSubmit={(e) => {
      e.preventDefault(); setBusy(true); setBootError('');
      const action = authMode === 'login'
        ? api.login(username, password).then((value) => { applySession(value); setPassword(''); })
        : authMode === 'register'
          ? password !== confirmation
            ? Promise.reject(new Error(t('两次输入的密码不一致。')))
            : api.register(username, password).then((value) => {
              setIssuedRecoveryCode(value.recoveryCode);
              setPassword('');
              setConfirmation('');
            })
          : password !== confirmation
            ? Promise.reject(new Error(t('两次输入的新密码不一致。')))
            : api.resetPassword(username, recoveryCode, password).then(() => {
              setAuthMode('login');
              setPassword('');
              setConfirmation('');
              setRecoveryCode('');
              setBootError(t('密码已重置，请登录。'));
            });
      void action.catch((error: unknown) => setBootError(String(error))).finally(() => setBusy(false));
    }}>
      <div className="brand login-brand"><BrandIcon size={32} /><h1>EasyNote</h1></div>
      <div className="login-heading">{authMode === 'register' ? t('创建账户') : authMode === 'reset' ? t('恢复账户') :
        session ? session.configured ? t('登录笔记') : t('等待初始化') : t('登录笔记')}</div>
      {issuedRecoveryCode && <div className="recovery-result" role="status">
        <strong>{t('保存恢复代码')}</strong>
        <code>{issuedRecoveryCode}</code>
        <p>{t('账号需要管理员批准后才能登录，此代码仅显示一次。')}</p>
        <button type="button" onClick={() => void navigator.clipboard.writeText(issuedRecoveryCode)}>{t('复制恢复代码')}</button>
      </div>}
      <label>{t('username')}<input autoComplete="username" required maxLength={32} value={username} onChange={(e) => setUsername(e.target.value)} /></label>
      {authMode === 'reset' && <label>{t('恢复代码')}<input autoComplete="off" required value={recoveryCode} onChange={(e) => setRecoveryCode(e.target.value)} /></label>}
      <label>{authMode === 'reset' ? t('新密码') : t('password')}<input autoComplete={authMode === 'login' ? 'current-password' : 'new-password'}
        type="password" required minLength={authMode === 'login' ? undefined : 12} maxLength={128}
        value={password} onChange={(e) => setPassword(e.target.value)} /></label>
      {authMode !== 'login' && <label>{t('确认密码')}<input autoComplete="new-password" type="password" required minLength={12}
        maxLength={128} value={confirmation} onChange={(e) => setConfirmation(e.target.value)} /></label>}
      <button className="primary" disabled={busy || !session?.configured || authMode === 'register' && !session.registrationEnabled}>
        {busy ? t('处理中…') : authMode === 'register' ? t('提交注册') : authMode === 'reset' ? t('重置密码') : t('登录')}
      </button>
      <div className="login-actions">
        {authMode !== 'login' ? <button type="button" onClick={() => { setAuthMode('login'); setBootError(''); }}>{t('返回登录')}</button> :
          <>{session?.registrationEnabled && <button type="button" onClick={() => { setAuthMode('register'); setIssuedRecoveryCode(''); }}>{t('注册')}</button>}
            <button type="button" onClick={() => setAuthMode('reset')}>{t('使用恢复代码')}</button></>}
      </div>
      {bootError && <div role="alert" className="error-box"><pre>{bootError}</pre><button type="button" onClick={boot}>{t('重新连接')}</button></div>}
    </form>
  </main>;
}

function AccountWorkspace({ session, installApp, logout }: { session: Session; installApp?(): Promise<void>; logout(): Promise<void> }) {
  const [ownsLock, setOwnsLock] = useState<boolean | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let release: (() => void) | undefined;
    let hasLock = false;
    let channel: BroadcastChannel | undefined;

    if (!navigator.locks) { setOwnsLock(false); return; }

    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(`easynote-editor-lock:${session.user!.id}`);
      channel.onmessage = (e) => {
        if (e.data?.type === 'claim' && hasLock) {
          hasLock = false;
          channel?.postMessage({ type: 'yielded' });
          release?.();
          if (!cancelled) setOwnsLock(false);
        }
      };
    }

    void navigator.locks.request(`easynote-editor:${session.user!.id}`, { ifAvailable: true }, async (lock) => {
      if (cancelled) return;
      setOwnsLock(!!lock);
      if (lock) {
        hasLock = true;
        await new Promise<void>((resolve) => { release = resolve; });
        hasLock = false;
      }
    }).catch(() => { if (!cancelled) setOwnsLock(false); });

    return () => {
      cancelled = true;
      channel?.close();
      release?.();
    };
  }, [session.user!.id, attempt]);

  const handleReopen = () => {
    setOwnsLock(null);
    if (typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel(`easynote-editor-lock:${session.user!.id}`);
      let done = false;
      const proceed = () => {
        if (done) return;
        done = true;
        channel.close();
        setAttempt((n) => n + 1);
      };
      channel.onmessage = (e) => {
        if (e.data?.type === 'yielded') proceed();
      };
      channel.postMessage({ type: 'claim' });
      setTimeout(proceed, 150);
    } else {
      setAttempt((n) => n + 1);
    }
  };

  if (ownsLock) return <Notebook session={session} installApp={installApp} logout={logout} />;
  return <main className="login"><div className="login-form">
    <div className="brand login-brand"><BrandIcon size={32} /><h1>EasyNote</h1></div>
    <div className="login-heading">{ownsLock === null ? t('正在打开笔记') : navigator.locks ? t('另一个标签页正在编辑') : t('浏览器不支持安全编辑锁')}</div>
    {ownsLock === false && navigator.locks && <button className="primary" onClick={handleReopen}>{t('重新打开')}</button>}
  </div></main>;
}

function Notebook({ session, installApp, logout }: { session: Session; installApp?(): Promise<void>; logout(): Promise<void> }) {
  const book = useNotebook(session);
  const [visibleNoteLimit, setVisibleNoteLimit] = useState(50);
  const [layout, setLayout] = useState<'edit' | 'preview'>('preview');
  const [editMode, setEditMode] = useState<'live' | 'markdown'>('live');
  const [quickNotes, setQuickNotes] = useState(false);
  const [mobileNote, setMobileNote] = useState(false);
  const [mobileNavigation, setMobileNavigation] = useState(false);
  const [mobileSearch, setMobileSearch] = useState(false);
  const [mobileNoteActions, setMobileNoteActions] = useState(false);
  const [noteActionMenu, setNoteActionMenu] = useState<{ left: number; top: number } | null>(null);
  const [sidebar, setSidebar] = useState(() => localStorage.getItem('easynote-navigation-visible') !== 'false');
  const [noteListVisible, setNoteListVisible] = useState(() => localStorage.getItem('easynote-note-list-visible') !== 'false');
  const [resizingList, setResizingList] = useState(false);
  const [noteListWidth, setNoteListWidth] = useState(() => {
    const stored = localStorage.getItem('easynote-note-list-width');
    if (stored === null) return 340;
    const saved = Number(stored);
    return Number.isFinite(saved) ? Math.min(440, Math.max(220, saved)) : 340;
  });
  const noteListWidthRef = useRef(noteListWidth);
  const resizeStart = useRef<{ pointerId: number; x: number; width: number } | null>(null);
  const tagPickerRef = useRef<HTMLDetailsElement>(null);
  const noteActionMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const el = tagPickerRef.current;
      if (el && el.open && !el.contains(e.target as Node)) el.open = false;
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const el = tagPickerRef.current;
      if (el && el.open && e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        el.open = false;
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);
  useEffect(() => {
    if (!noteActionMenu) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!noteActionMenuRef.current?.contains(event.target as Node)) setNoteActionMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setNoteActionMenu(null);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [noteActionMenu]);
  const [settings, setSettings] = useState(false);
  const [storageModal, setStorageModal] = useState(false);
  const [accountSecurity, setAccountSecurity] = useState(false);
  const [userManagement, setUserManagement] = useState(false);
  const [registrationEnabled, setRegistrationEnabled] = useState(session.registrationEnabled);
  const [taskCenter, setTaskCenter] = useState(false);
  const [tasks, setTasks] = useState<NoteTask[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [shareManagement, setShareManagement] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [sharingFolder, setSharingFolder] = useState<Folder | null>(null);
  const [commandPalette, setCommandPalette] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');
  const [commandNotes, setCommandNotes] = useState<NoteSummary[]>([]);
  const [shortcutHelp, setShortcutHelp] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [pdfProgress, setPdfProgress] = useState('');
  const [pdfExport, setPdfExport] = useState(false);
  const [pdfName, setPdfName] = useState('');
  const [pdfOptions, setPdfOptions] = useState<PdfExportOptions>(defaultPdfOptions);
  const [pdfPreviewFile, setPdfPreviewFile] = useState<File | null>(null);
  const [pdfPreviewPages, setPdfPreviewPages] = useState<Blob[]>([]);
  const [pdfPreviewError, setPdfPreviewError] = useState('');
  const [printNote, setPrintNote] = useState<Note | null>(null);
  const [inspector, setInspector] = useState(false);
  const [backlinks, setBacklinks] = useState<NoteSummary[]>([]);
  const [linkPicker, setLinkPicker] = useState(false);
  const [linkQuery, setLinkQuery] = useState('');
  const [linkNotes, setLinkNotes] = useState<NoteSummary[]>([]);
  const [tagManager, setTagManager] = useState(false);
  const [folderEditor, setFolderEditor] = useState<{ id?: string; name: string; parentId: string | null } | null>(null);
  const [folderOverviewId, setFolderOverviewId] = useState<string | null>(null);
  const [deletingFolder, setDeletingFolder] = useState<Folder | null>(null);
  const [mergingFolder, setMergingFolder] = useState<{ folder: Folder; targetId: string } | null>(null);
  const [movingFolder, setMovingFolder] = useState<{ folder: Folder; targetParentId: string | null } | null>(null);
  const [movingNote, setMovingNote] = useState<{ ids: string[]; title: string; currentFolderId: string | null; targetFolderId: string | null } | null>(null);
  const [importFolderId, setImportFolderId] = useState<string | null>(book.folderId ?? null);
  const [newTagInput, setNewTagInput] = useState('');
  const [editingTag, setEditingTag] = useState<string | null>(null);
  const [editingTagValue, setEditingTagValue] = useState('');
  const [mergingTag, setMergingTag] = useState<string | null>(null);
  const [mergingTarget, setMergingTarget] = useState('');
  const [deletingTag, setDeletingTag] = useState<string | null>(null);
  const [noteTagQuery, setNoteTagQuery] = useState('');
  const [selectionMode, setSelectionMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkTagOpen, setBulkTagOpen] = useState(false);
  const [bulkTag, setBulkTag] = useState('');
  const [versionList, setVersionList] = useState<Version[] | null>(null);
  const [versionNoteId, setVersionNoteId] = useState('');
  const [chosenVersion, setChosenVersion] = useState<Version | null>(null);
  const [confirmAction, setConfirmAction] = useState<'trash' | 'bulk-trash' | 'purge' | 'purge-all' | null>(null);
  const [lightbox, setLightbox] = useState('');
  const [docViewerFile, setDocViewerFile] = useState<DocumentViewerFile | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{
    total: number;
    current: number;
    filename: string;
    percent: number;
    statusText: string;
  } | null>(null);
  useEffect(() => {
    preloadPdfjs();
  }, []);
  const [syncing, setSyncing] = useState(false);
  const pdfGeneration = useRef(0);
  const [transfer, setTransfer] = useState('');
  const [notice, setNotice] = useState<{ id: number; text: string } | null>(null);
  const [copyFeedback, setCopyFeedback] = useState(false);
  const copyFeedbackTimer = useRef<number | null>(null);
  const [dark, setDark] = useState(() => localStorage.getItem('easynote-theme') === 'dark');
  const [lightBackground, setLightBackground] = useState<'light' | 'white' | 'warm'>(() => {
    const stored = localStorage.getItem('easynote-light-background');
    return stored === 'white' || stored === 'warm' ? stored : 'light';
  });
  const [documentFullscreen, setDocumentFullscreen] = useState(false);
  const editor = useRef<EditorHandle>(null);
  const editorCursor = useRef(0);
  const pendingEditorOffset = useRef<{ noteId: string; offset: number } | null>(null);
  const pendingInsertion = useRef<string | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const commandList = useRef<HTMLDivElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const attachmentInput = useRef<HTMLInputElement>(null);
  const folderUploadInput = useRef<HTMLInputElement>(null);
  const folderUploadTarget = useRef<string | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const importFolderInput = useRef<HTMLInputElement>(null);
  const dialogFeedbackTargets = useRef<HTMLElement[]>([]);
  const [dialogFeedbackTarget, setDialogFeedbackTarget] = useState<HTMLElement | null>(null);
  const registerDialogFeedback = useCallback((target: HTMLElement, mounted: boolean) => {
    const remaining = dialogFeedbackTargets.current.filter((item) => item !== target);
    dialogFeedbackTargets.current = mounted ? [...remaining, target] : remaining;
    setDialogFeedbackTarget(dialogFeedbackTargets.current.at(-1) ?? null);
  }, []);
  const note = book.note;
  const hasEmbeddedDocs = useMemo(() => {
    if (!note?.content) return false;
    return /\[([^\]]+)\]\(([^)]+\.(?:pdf|txt)(?:\?[^)]*)?|\/api\/(?:files|public\/shares\/[a-f0-9]{64}\/files)\/[0-9a-f-]{36})\)/i.test(note.content);
  }, [note?.content]);
  const pendingIds = useMemo(() => new Set(book.pending.map((item) => item.id)), [book.pending]);
  const visibleNotes = book.notes.slice(0, visibleNoteLimit);
  const hasHiddenNotes = visibleNotes.length < book.notes.length;
  const outline = useMemo(() => headings(note?.content ?? ''), [note?.content]);
  useEffect(() => setVisibleNoteLimit(50), [book.query, book.tag, book.view]);
  const updateNoteListWidth = (value: number) => {
    const next = Math.min(440, Math.max(220, Math.round(value)));
    noteListWidthRef.current = next;
    setNoteListWidth(next);
  };
  const beginNoteListResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !noteListVisible || event.target instanceof Element && event.target.closest('button')) return;
    event.preventDefault();
    resizeStart.current = { pointerId: event.pointerId, x: event.clientX, width: noteListWidthRef.current };
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizingList(true);
  };
  const moveNoteListResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = resizeStart.current;
    if (!start || start.pointerId !== event.pointerId) return;
    updateNoteListWidth(start.width + event.clientX - start.x);
  };
  const finishNoteListResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (resizeStart.current?.pointerId !== event.pointerId) return;
    resizeStart.current = null;
    setResizingList(false);
    localStorage.setItem('easynote-note-list-width', String(noteListWidthRef.current));
  };
  const resizeNoteListWithKeyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!noteListVisible) return;
    const widths: Record<string, number> = {
      ArrowLeft: noteListWidthRef.current - 12,
      ArrowRight: noteListWidthRef.current + 12,
      Home: 220,
      End: 440,
    };
    if (!(event.key in widths)) return;
    event.preventDefault();
    updateNoteListWidth(widths[event.key]);
    localStorage.setItem('easynote-note-list-width', String(Math.min(440, Math.max(220, widths[event.key]))));
  };
  const setNavigationVisible = (visible: boolean) => {
    setSidebar(visible);
    localStorage.setItem('easynote-navigation-visible', String(visible));
  };
  const setExplorerVisible = (visible: boolean) => {
    setNoteListVisible(visible);
    localStorage.setItem('easynote-note-list-visible', String(visible));
  };
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : lightBackground;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#1c1c1e' : lightBackground === 'warm' ? '#fbfaf7' : lightBackground === 'white' ? '#ffffff' : '#f9f9f9');
    localStorage.setItem('easynote-theme', dark ? 'dark' : 'light');
    localStorage.setItem('easynote-light-background', lightBackground);
  }, [dark, lightBackground]);
  useEffect(() => {
    const pending = pendingEditorOffset.current;
    editorCursor.current = pending && pending.noteId === note?.id
      ? pending.offset
      : 0;
  }, [note?.id]);
  useEffect(() => {
    const pending = pendingEditorOffset.current;
    if (!pending || layout !== 'edit' || pending.noteId !== note?.id) return;
    const offset = pending.offset;
    pendingEditorOffset.current = null;
    const frame = requestAnimationFrame(() => editor.current?.goTo(offset));
    return () => cancelAnimationFrame(frame);
  }, [layout, note?.id]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4500);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    setCopyFeedback(false);
  }, [note?.id]);
  useEffect(() => {
    return () => {
      if (copyFeedbackTimer.current) window.clearTimeout(copyFeedbackTimer.current);
    };
  }, []);
  const showNotice = (text: string) => setNotice({ id: Date.now(), text });
  useEffect(() => {
    if (!session.user || session.offline || !book.online) return;
    void api.storage().then((stats) => {
      const alertConfig = getStorageAlertConfig(session.user!.id);
      if (alertConfig.enabled && stats.usedPercent >= alertConfig.thresholdPercent) {
        showNotice(t('storage_warning_notice', stats.usedPercent, alertConfig.thresholdPercent));
      }
    }).catch(() => {});
  }, [session.user?.id, session.offline, book.online]);
  useEffect(() => {
    if (!pdfExport || !printNote) return;
    const generation = ++pdfGeneration.current;
    const timer = window.setTimeout(() => {
      setPrinting(true);
      setPdfProgress(t('正在生成分页预览'));
      setPdfPreviewError('');
      setPdfPreviewFile(null);
      setPdfPreviewPages([]);
      void (async () => {
        await waitForPrintReady();
        const source = document.querySelector<HTMLElement>('.print-document[data-printing="true"]');
        if (!source) throw new Error(t('PDF 内容尚未准备完成。'));
        const file = await createPdfFile(source, printNote.title, printNote.title, pdfOptions);
        if (pdfGeneration.current !== generation) return;
        setPdfProgress(t('正在渲染分页预览'));
        const pages = await renderPdfPreviewPages(file);
        if (pdfGeneration.current !== generation) return;
        setPdfPreviewFile(file);
        setPdfPreviewPages(pages);
      })().catch((error: unknown) => {
        if (pdfGeneration.current === generation) {
          setPdfPreviewError(String(error).replace(/^Error:\s*/, ''));
        }
      }).finally(() => {
        if (pdfGeneration.current === generation) {
          setPdfProgress('');
          setPrinting(false);
        }
      });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [pdfExport, printNote, pdfOptions]);
  const showShortcutHelp = () => {
    setCommandPalette(false);
    setShortcutHelp(true);
  };
  const editAt = (offset: number) => {
    editorCursor.current = offset;
    if (layout === 'edit') {
      editor.current?.goTo(offset);
      return;
    }
    if (note) pendingEditorOffset.current = { noteId: note.id, offset };
    setLayout('edit');
  };
  const showPreview = () => {
    if (!note || note.deletedAt) return;
    editorCursor.current = editor.current?.cursor() ?? editorCursor.current;
    setLayout('preview');
  };
  const toggleLayout = () => {
    if (!note || note.deletedAt) return;
    if (layout === 'edit') showPreview();
    else editAt(Math.min(editorCursor.current, note.content.length));
  };
  const toggleDocumentFullscreen = () => setDocumentFullscreen((current) => !current);
  const run = async (action: () => Promise<unknown>) => {
    try { await action(); } catch (e) { book.setError(String(e)); }
  };
  const createNote = (input?: Partial<NoteInput>) => run(async () => {
    setFolderOverviewId(null);
    await book.create(input);
    setMobileNavigation(false);
    setMobileNoteActions(false);
    setMobileNote(true);
    setLayout('edit');
  });
  const createNoteInFolder = (folderId: string) => run(async () => {
    setFolderOverviewId(null);
    await book.create({ folderId });
    setMobileNavigation(false);
    setMobileNoteActions(false);
    setMobileNote(true);
    setLayout('edit');
  });
  const insertFiles = async (files: File[], insertion?: string) => {
    if (!note || uploading) return;
    if (!files.length) return;
    if (!book.online || session.offline) { book.setError(t('附件需要联网上传。')); return; }
    const target = note;
    const marker = insertion ?? pendingInsertion.current ?? editor.current?.markInsertion();
    pendingInsertion.current = null;
    setUploading(true);
    setUploadProgress({
      total: files.length,
      current: 1,
      filename: files[0]?.name || '',
      percent: 0,
      statusText: t('正在准备上传...'),
    });
    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        setUploadProgress({
          total: files.length,
          current: i + 1,
          filename: file.name,
          percent: Math.round((i / files.length) * 100),
          statusText: t('正在上传并处理文档 ({0}/{1})...', i + 1, files.length),
        });

        const onFileProgress = (loaded: number, total: number) => {
          if (total > 0) {
            const filePct = loaded / total;
            const overallPct = Math.min(99, Math.round(((i + filePct) / files.length) * 100));
            setUploadProgress({
              total: files.length,
              current: i + 1,
              filename: file.name,
              percent: overallPct,
              statusText: t('正在上传：{0}%', Math.round(filePct * 100)),
            });
          }
        };

        const label = file.name.replace(/[\[\]\\\r\n]/g, '');
        const stored = file.type.startsWith('image/')
          ? await uploadImage(file, session.config.maxImageBytes, session.config.maxImagePixels, onFileProgress)
          : await uploadAttachment(file, session.config.maxAttachmentBytes, onFileProgress);
        const markdown = file.type.startsWith('image/') ? `![${label}](${stored.url})` : `[${label}](${stored.url})`;
        if (!marker || !editor.current?.insertAt(marker, markdown)) book.append(target, markdown);
      }
      setUploadProgress((prev) => prev ? { ...prev, percent: 100, statusText: t('上传完成') } : null);
      const onlyImages = files.every((file) => file.type.startsWith('image/'));
      showNotice(onlyImages ? t('图片已插入') : files.length === 1 ? t('附件已插入') : t('已插入 {0} 个文件', files.length));
      void api.storage().then((stats) => {
        const alertConfig = getStorageAlertConfig(session.user!.id);
        if (alertConfig.enabled && stats.usedPercent >= alertConfig.thresholdPercent) {
          showNotice(t('storage_warning_notice', stats.usedPercent, alertConfig.thresholdPercent));
        }
      }).catch(() => {});
    } catch (e) { book.setError(String(e)); }
    finally {
      if (marker) editor.current?.releaseInsertion(marker);
      setUploading(false);
      setUploadProgress(null);
      if (imageInput.current) imageInput.current.value = '';
      if (attachmentInput.current) attachmentInput.current.value = '';
    }
  };
  const uploadFileToFolder = (folderId: string) => {
    folderUploadTarget.current = folderId;
    folderUploadInput.current?.click();
  };
  const uploadFilesToFolder = async (folderId: string, files: File[]) => {
    if (!files.length) return;
    if (!book.online || session.offline) {
      book.setError(t('附件需要联网上传。'));
      return;
    }
    setUploading(true);
    setUploadProgress({
      total: files.length,
      current: 1,
      filename: files[0]?.name || '',
      percent: 0,
      statusText: t('正在准备上传...'),
    });
    try {
      let createdCount = 0;
      let lastCreatedNoteId: string | null = null;
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        setUploadProgress({
          total: files.length,
          current: i + 1,
          filename: file.name,
          percent: Math.round((i / files.length) * 100),
          statusText: t('正在上传并处理文档 ({0}/{1})...', i + 1, files.length),
        });

        const onFileProgress = (loaded: number, total: number) => {
          if (total > 0) {
            const filePct = loaded / total;
            const overallPct = Math.min(99, Math.round(((i + filePct) / files.length) * 100));
            setUploadProgress({
              total: files.length,
              current: i + 1,
              filename: file.name,
              percent: overallPct,
              statusText: t('正在上传：{0}%', Math.round(filePct * 100)),
            });
          }
        };

        const isPdf = file.name.endsWith('.pdf') || file.type === 'application/pdf';
        const isTxt = file.name.endsWith('.txt') || file.type === 'text/plain';
        const isMd = file.name.endsWith('.md') || file.name.endsWith('.markdown') || file.type === 'text/markdown';

        if (isPdf) {
          const stored = await uploadAttachment(file, session.config.maxAttachmentBytes, onFileProgress);
          const rawTitle = file.name.replace(/\.pdf$/i, '').trim() || t('untitled_note');
          const content = `[${file.name}](${stored.url})\n`;
          const created = await book.create({
            title: rawTitle,
            content,
            folderId,
          });
          lastCreatedNoteId = created.id;
          createdCount++;
        } else if (isTxt || isMd) {
          const content = await file.text();
          const rawTitle = file.name.replace(/\.(txt|md|markdown)$/i, '').trim() || t('untitled_note');
          const created = await book.create({
            title: rawTitle,
            content,
            folderId,
          });
          lastCreatedNoteId = created.id;
          createdCount++;
        } else {
          const stored = await uploadAttachment(file, session.config.maxAttachmentBytes, onFileProgress);
          const rawTitle = file.name.trim() || t('untitled_note');
          const content = `[${file.name}](${stored.url})\n`;
          const created = await book.create({
            title: rawTitle,
            content,
            folderId,
          });
          lastCreatedNoteId = created.id;
          createdCount++;
        }
      }

      setUploadProgress((prev) => prev ? { ...prev, percent: 100, statusText: t('上传完成') } : null);
      void book.ensureExplorerFolder(folderId, { force: true });

      if (createdCount === 1 && lastCreatedNoteId) {
        showNotice(t('文件已上传并创建笔记'));
        await openNote(lastCreatedNoteId, 'preview');
      } else if (createdCount > 1) {
        showNotice(t('已成功上传 {0} 个文件并创建笔记', createdCount));
        if (lastCreatedNoteId) await openNote(lastCreatedNoteId, 'preview');
      }
    } catch (err: unknown) {
      book.setError(String(err));
    } finally {
      setUploading(false);
      setUploadProgress(null);
    }
  };
  const chooseView = (view: string, tag = '') => {
    setFolderOverviewId(null);
    setQuickNotes(false);
    setShareManagement(false);
    book.setView(view);
    book.setTag(tag);
    book.setFolderId(undefined);
    setMobileNavigation(false);
    setMobileNote(false);
    setSelectionMode(false);
    setSelected(new Set());
  };
  const chooseFolder = (id: string) => {
    setFolderOverviewId(null);
    setQuickNotes(false);
    setShareManagement(false);
    book.setView('all');
    book.setTag('');
    book.setFolderId(id);
    setMobileNavigation(false);
    setMobileNote(false);
  };
  const toggleMobileSearch = () => {
    if (mobileSearch || book.query) {
      book.setQuery('');
      setMobileSearch(false);
      searchInput.current?.blur();
      return;
    }
    setMobileSearch(true);
    requestAnimationFrame(() => searchInput.current?.focus());
  };
  const setNoteFields = (patch: Partial<NoteInput>) => book.edit(patch);
  const syncNow = async (createVersion = true) => {
    if (syncing) return;
    const hadPending = book.pending.length > 0;
    const checkpointId = createVersion ? note?.id : undefined;
    setSyncing(true);
    try {
      if (await book.retry(checkpointId)) {
        showNotice(checkpointId ? t('已保存并记录历史版本') :
          hadPending ? t('草稿已保存并同步') : t('已同步，内容为最新'));
      }
    } finally {
      setSyncing(false);
    }
  };
  const openNote = async (id: string, nextLayout: 'edit' | 'preview' = 'preview') => {
    setFolderOverviewId(null);
    setQuickNotes(false);
    await book.select(id);
    setLayout(nextLayout);
    setMobileNavigation(false);
    setMobileNoteActions(false);
    setMobileNote(true);
    setVersionList(null);
    setCommandPalette(false);
    setLinkPicker(false);
  };
  const openTaskCenter = async () => {
    setTaskCenter(true);
    setTasksLoading(true);
    try { setTasks(await book.tasks()); }
    catch (error) { book.setError(String(error)); }
    finally { setTasksLoading(false); }
  };
  const openTask = async (task: NoteTask) => {
    if (note?.id === task.noteId && layout === 'edit') {
      setTaskCenter(false);
      setMobileNote(true);
      requestAnimationFrame(() => requestAnimationFrame(() => editor.current?.goTo(task.offset)));
      return;
    }
    pendingEditorOffset.current = { noteId: task.noteId, offset: task.offset };
    setTaskCenter(false);
    await openNote(task.noteId, 'edit');
  };
  const openManagedShare = async (share: ManagedNoteShare) => {
    setShareManagement(false);
    chooseView(share.archived ? 'archive' : 'all');
    await openNote(share.noteId);
  };
  const openHistory = (target: Pick<Note, 'id' | 'revision'> | null = note) => {
    if (!target || target.revision === 0) return;
    void run(async () => {
      const result = await api.versions(target.id);
      setVersionNoteId(target.id);
      setVersionList(result.versions);
      setChosenVersion(null);
    });
  };
  const restoreVersion = async () => {
    if (!note || !chosenVersion || syncing) return;
    const targetId = note.id;
    const version = chosenVersion;
    setSyncing(true);
    try {
      if (!await book.retry(targetId)) return;
      book.edit({
        title: version.title,
        content: version.content,
        tags: version.tags,
        archived: version.archived,
      });
      if (!await book.retry()) return;
      setVersionList(null);
      setChosenVersion(null);
      setLayout('edit');
      showNotice(t('已恢复版本，恢复前内容已保留'));
    } finally {
      setSyncing(false);
    }
  };
  const exportCurrentNote = () => {
    if (!note || printing) return;
    setPdfName(note.title);
    setPdfOptions(defaultPdfOptions);
    setPdfPreviewFile(null);
    setPdfPreviewPages([]);
    setPdfPreviewError('');
    setPrintNote({ ...note, tags: [...note.tags] });
    setPdfProgress(t('正在准备分页预览'));
    setPdfExport(true);
  };
  const closePdfExport = () => {
    if (printing) return;
    pdfGeneration.current += 1;
    setPdfExport(false);
    setPrintNote(null);
    setPdfPreviewFile(null);
    setPdfPreviewPages([]);
    setPdfPreviewError('');
    setPdfProgress('');
  };
  const confirmPdfExport = async () => {
    if (!pdfPreviewFile || printing) return;
    const file = new File([pdfPreviewFile], pdfFilename(pdfName.replace(/\.pdf$/i, '')), {
      type: pdfPreviewFile.type,
      lastModified: pdfPreviewFile.lastModified,
    });
    if (isMobilePdfTarget() && canSharePdf(file)) {
      try {
        await navigator.share({ files: [file], title: file.name });
        closePdfExport();
        showNotice(t('PDF 已交给系统保存'));
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
      }
    }
    downloadPdfFile(file);
    closePdfExport();
    showNotice(t('PDF 已下载'));
  };
  const copyMarkdown = (source: 'toolbar' | 'menu' = 'toolbar') => {
    if (!note) return;
    void navigator.clipboard.writeText(note.content).then(() => {
      if (source === 'toolbar') {
        if (copyFeedbackTimer.current) window.clearTimeout(copyFeedbackTimer.current);
        setCopyFeedback(true);
        copyFeedbackTimer.current = window.setTimeout(() => setCopyFeedback(false), 2000);
      } else {
        showNotice(t('已复制 Markdown 内容'));
      }
    }).catch((error) => {
      book.setError(String(error));
    });
  };
  const copyFolderPath = (folder: Folder) => {
    const path = folderRelativePath(folder.id, book.folders);
    void navigator.clipboard.writeText(path).then(() => {
      showNotice(t('已复制路径'));
    }).catch((error) => {
      book.setError(String(error));
    });
  };
  const copyFolderId = (folder: Folder) => {
    void navigator.clipboard.writeText(folder.id).then(() => {
      showNotice(t('已复制 ID'));
    }).catch((error) => {
      book.setError(String(error));
    });
  };
  const copyNotePath = (targetNote: { title: string; folderId?: string | null }) => {
    const path = noteRelativePath(targetNote, book.folders, t('untitled_note'));
    void navigator.clipboard.writeText(path).then(() => {
      showNotice(t('已复制路径'));
    }).catch((error) => {
      book.setError(String(error));
    });
  };
  const copyNoteId = (targetNote: { id: string }) => {
    void navigator.clipboard.writeText(targetNote.id).then(() => {
      showNotice(t('已复制 ID'));
    }).catch((error) => {
      book.setError(String(error));
    });
  };
  const beginLinkInsertion = () => {
    pendingInsertion.current = editor.current?.markInsertion() ?? null;
    setLinkQuery('');
    setLinkPicker(true);
  };
  const insertNoteLink = (target: NoteSummary) => {
    const marker = pendingInsertion.current;
    if (marker && editor.current?.insertAt(marker, noteLink(target.id, target.title))) {
      editor.current.releaseInsertion(marker);
    } else if (note) {
      book.append(note, noteLink(target.id, target.title));
    }
    pendingInsertion.current = null;
    setLinkPicker(false);
  };
  const downloadPrivateFile = async (id: string, href: string) => {
    let url = href;
    if (!book.online || session.offline) {
      const cached = await book.cachedFile(id);
      if (!cached) throw new Error(t('这个附件尚未保存到本机。'));
      url = cached;
    }
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = '';
    anchor.click();
    if (url.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  const openDocViewerForCurrentNote = () => {
    if (!note) {
      setDocViewerFile({
        filename: 'document.pdf',
        url: '',
        type: 'pdf',
      });
      return;
    }
    const matches = Array.from(note.content.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g));
    const docMatch = matches.find((m) => {
      const text = m[1] || '';
      const href = m[2] || '';
      return /\.pdf$/i.test(text) || /\.pdf$/i.test(href) || /\.txt$/i.test(text) || /\.txt$/i.test(href);
    });
    if (docMatch) {
      const filename = docMatch[1];
      const href = docMatch[2];
      const isPdf = /\.pdf$/i.test(filename) || /\.pdf$/i.test(href);
      const fileId = /^(?:\/api\/files\/|\/api\/public\/shares\/[a-f0-9]{64}\/files\/)([0-9a-f-]{36})$/i.exec(href)?.[1];
      setDocViewerFile({
        id: fileId,
        url: href,
        filename,
        type: isPdf ? 'pdf' : 'txt',
      });
    } else {
      setDocViewerFile({
        filename: 'document.pdf',
        url: '',
        type: 'pdf',
      });
    }
  };
  const handleInsertFromDocViewer = (markdown: string) => {
    if (note) {
      book.append(note, markdown);
      showNotice(t('已将内容追加到当前笔记'));
    } else {
      void createNote({ content: markdown });
      showNotice(t('已基于文档创建新笔记'));
    }
  };
  const handleCreateNoteFromDocViewer = (title: string, markdown: string) => {
    void createNote({ title, content: markdown });
    showNotice(t('已基于文档创建新笔记'));
  };
  const handleUploadDocFromViewer = async (file: File) => {
    if (!session.user) throw new Error(t('用户未登录'));
    const stored = await uploadAttachment(file, session.config.maxAttachmentBytes);
    if (note) {
      const label = file.name.replace(/[\[\]\\\r\n]/g, '');
      const linkMd = `[${label}](${stored.url})`;
      book.append(note, linkMd);
    }
    return { id: stored.id, url: stored.url, filename: stored.filename, mime: stored.mime };
  };
  useEffect(() => {
    if (!commandPalette) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void book.searchAll(commandQuery).then((results) => { if (!cancelled) setCommandNotes(results); })
        .catch((error: unknown) => { if (!cancelled) book.setError(String(error)); });
    }, 80);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [commandPalette, commandQuery]);
  useEffect(() => {
    if (!linkPicker) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void book.searchAll(linkQuery).then((results) => {
        if (!cancelled) setLinkNotes(results.filter((item) => item.id !== note?.id));
      }).catch((error: unknown) => { if (!cancelled) book.setError(String(error)); });
    }, 80);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [linkPicker, linkQuery, note?.id]);
  useEffect(() => {
    if (!inspector || !note) { setBacklinks([]); return; }
    let cancelled = false;
    void book.backlinks(note.id).then((results) => { if (!cancelled) setBacklinks(results); })
      .catch((error: unknown) => { if (!cancelled) book.setError(String(error)); });
    return () => { cancelled = true; };
  }, [inspector, note?.id, note?.revision, book.offlineLibrary]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.repeat) return;
      const modifier = event.metaKey || event.ctrlKey;
      if (!modifier || document.querySelector('dialog[open]')) return;
      const key = event.key.toLocaleLowerCase();
      if (key === 'k') {
        event.preventDefault();
        setCommandPalette(true);
        setCommandQuery('');
      } else if (key === 's' && (note || book.pending.length)) {
        event.preventDefault();
        void syncNow();
      } else if (key === 'p' && note) {
        event.preventDefault();
        exportCurrentNote();
      } else if (key === 'e' && note && !note.deletedAt) {
        event.preventDefault();
        toggleLayout();
      } else if (key === 'enter' && note && !note.deletedAt) {
        event.preventDefault();
        toggleLayout();
      } else if (key === '/') {
        event.preventDefault();
        showShortcutHelp();
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  });
  const toggleSelected = (id: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const allVisibleSelected = book.notes.length > 0 &&
    selected.size === book.notes.length &&
    book.notes.every((item) => selected.has(item.id));
  const toggleSelectAll = () => {
    setSelected(allVisibleSelected ? new Set() : new Set(book.notes.map((item) => item.id)));
  };
  const exitSelectionMode = () => {
    setSelected(new Set());
    setSelectionMode(false);
    setBulkTag('');
    setBulkTagOpen(false);
  };
  const finishBulk = (message: string) => {
    exitSelectionMode();
    showNotice(message);
  };
  const applyBulkArchive = () => void run(async () => {
    const ids = [...selected];
    const archived = book.view !== 'archive';
    const count = await book.bulkUpdate(ids, () => ({ archived, deletedAt: null }));
    finishBulk(archived ? t('已归档 {0} 篇笔记', count) : t('已取消归档 {0} 篇笔记', count));
  });
  const applyBulkTag = () => void run(async () => {
    const value = bulkTag.trim();
    if (!value || value.length > 40) throw new Error(t('标签必须为 1-40 个字符。'));
    const count = await book.bulkUpdate([...selected], (item) => ({ tags: [...new Set([...item.tags, value])] }));
    finishBulk(t('已为 {0} 篇笔记添加标签', count));
  });
  const submitMoveNote = (targetFolderId: string | null) => {
    if (!movingNote) return;
    void run(async () => {
      await book.bulkUpdate(movingNote.ids, () => ({ folderId: targetFolderId }));
      const targetName = targetFolderId ? book.folders.find((f) => f.id === targetFolderId)?.name ?? '' : t('根目录');
      if (movingNote.ids.length === 1) {
        showNotice(t('已移动到文件夹“{0}”', targetName));
      } else {
        showNotice(t('已移动 {0} 篇笔记到文件夹“{1}”', movingNote.ids.length, targetName));
      }
      setMovingNote(null);
      if (selectionMode) exitSelectionMode();
    });
  };
  const submitMoveFolder = (targetParentId: string | null) => {
    if (!movingFolder) return;
    void run(async () => {
      await book.updateFolder(movingFolder.folder.id, { parentId: targetParentId });
      const targetName = targetParentId ? book.folders.find((f) => f.id === targetParentId)?.name ?? '' : t('根目录');
      showNotice(t('文件夹“{0}”已移动到“{1}”', movingFolder.folder.name, targetName));
      setMovingFolder(null);
    });
  };
  const moveToTrash = (ids: string[]) => {
    const deletedAt = Date.now();
    return book.bulkUpdate(ids, () => ({ deletedAt, archived: false }));
  };
  const moveCurrentToTrash = async () => {
    if (!note) throw new Error(t('当前笔记不可用，请刷新后重试。'));
    const index = book.notes.findIndex((item) => item.id === note.id);
    const next = index >= 0 ? book.notes[index + 1] : undefined;
    await moveToTrash([note.id]);
    if (next) {
      await openNote(next.id);
    } else {
      book.clearSelection();
      book.setQuery('');
      setMobileSearch(false);
      chooseView('all');
    }
    showNotice(t('已移入回收站'));
  };
  const applyBulkTrash = async () => {
    const count = await moveToTrash([...selected]);
    finishBulk(t('已将 {0} 篇笔记移入回收站', count));
  };
  const handleSaveEditTag = () => void run(async () => {
    if (!editingTag) return;
    const target = editingTagValue.trim();
    if (!target || target.length > 40 || target.includes(',') || target.includes('，')) {
      throw new Error(t('标签必须为 1-40 个字符，且不能包含逗号。'));
    }
    if (target === editingTag) {
      setEditingTag(null);
      return;
    }
    if (book.tags.includes(target)) throw new Error(t('该标签已存在。'));
    const count = await book.manageTag(editingTag, target);
    setEditingTag(null);
    showNotice(count ? t('已将 #{0} 重命名为 #{1}，更新了 {2} 篇笔记', editingTag, target, count) : t('已将 #{0} 重命名为 #{1}', editingTag, target));
  });
  const handleConfirmMergeTag = () => void run(async () => {
    if (!mergingTag || !mergingTarget) return;
    const from = mergingTag;
    const to = mergingTarget;
    const count = await book.manageTag(from, to);
    setMergingTag(null);
    showNotice(count ? t('已将 #{0} 合并到 #{1}，更新了 {2} 篇笔记', from, to, count) : t('已将 #{0} 合并到 #{1}', from, to));
  });
  const handleConfirmDeleteTag = () => void run(async () => {
    if (!deletingTag) return;
    const target = deletingTag;
    const count = await book.manageTag(target, null);
    setDeletingTag(null);
    showNotice(count ? t('已删除标签 #{0}，更新了 {1} 篇笔记', target, count) : t('已删除标签 #{0}', target));
  });
  const goToHeading = (offset: number) => {
    editAt(offset);
  };
  const noteHasToc = useMemo(() => (note ? hasToc(note.content) : false), [note?.content]);
  const toggleNoteToc = () => {
    if (!note) return;
    const result = toggleToc(note.content);
    if (result.action === 'no_headings') {
      showNotice(t('当前笔记没有标题，无法生成目录'));
      return;
    }
    setNoteFields({ content: result.content });
    showNotice(result.action === 'inserted' ? t('已在顶部插入目录') : t('已移除顶部目录'));
  };
  const updateNoteToc = (manual = false) => {
    if (!note || !hasToc(note.content)) return;
    const { content: updatedContent, changed } = updateToc(note.content);
    if (changed) {
      setNoteFields({ content: updatedContent });
      if (manual) showNotice(t('已更新顶部目录'));
    } else if (manual) {
      showNotice(t('目录已是最新'));
    }
  };
  useEffect(() => {
    if (!note || note.deletedAt || !hasToc(note.content)) return;
    const timer = setTimeout(() => {
      const { content: updatedContent, changed } = updateToc(note.content);
      if (changed) {
        setNoteFields({ content: updatedContent });
      }
    }, 1500);
    return () => clearTimeout(timer);
  }, [note?.id, note?.content, note?.deletedAt]);
  const transferAction = async <T,>(action: () => Promise<T>, success: string | ((result: T) => string)) => {
    if (book.pending.length || book.busy || uploading) { book.setError(t('还有未保存的内容，请先完成保存。')); return; }
    setTransfer(t('正在准备…'));
    try {
      const result = await action();
      showNotice(typeof success === 'function' ? success(result) : success);
      await book.refresh();
    }
    catch (e) { book.setError(String(e)); }
    finally { setTransfer(''); }
  };
  const viewName = book.view === 'trash' ? t('trash') : book.view === 'archive' ? t('归档笔记') : t('all_notes');
  const activeFolder = book.folderId ? book.folders.find((folder) => folder.id === book.folderId) : null;
  const folderOverview = folderOverviewId ? book.folders.find((folder) => folder.id === folderOverviewId) ?? null : null;
  const activeFolderScopeId = folderOverviewId ?? book.folderId ?? null;
  const activeView = activeFolder?.name ?? viewName;
  const disabled = !!transfer || uploading || book.busy || syncing;
  const commandMatch = (...labels: string[]) => {
    const query = commandQuery.trim().toLocaleLowerCase();
    return !query || labels.some((label) => label.toLocaleLowerCase().includes(query));
  };
  const commandActions = [
    {
      id: 'new', label: t('新建笔记'), aliases: ['新建', 'new', 'create'], icon: <Plus size={16} />, shortcut: '',
      disabled: !!transfer || book.loading,
      action: () => { setCommandPalette(false); void createNote(); },
    },
    ...(book.view === 'all' && !book.tag ? [{
      id: activeFolderScopeId ? 'new-subfolder' : 'new-folder',
      label: activeFolderScopeId ? t('新建子文件夹') : t('新建文件夹'),
      aliases: activeFolderScopeId
        ? ['新建子文件夹', '子文件夹', 'new subfolder', 'subfolder']
        : ['新建文件夹', '文件夹', 'new folder', 'folder'],
      icon: <FolderPlus size={16} />,
      shortcut: '',
      disabled: disabled || !book.online,
      action: () => { setCommandPalette(false); setFolderEditor({ name: '', parentId: activeFolderScopeId }); },
    }] : []),
    {
      id: 'save', label: t('sync_and_save_version'), aliases: ['保存', '同步', '保存并同步', 'save', 'sync'], icon: <Save size={16} />, shortcut: 'Cmd/Ctrl+S',
      disabled: disabled || (!note && !book.pending.length),
      action: () => { setCommandPalette(false); void syncNow(); },
    },
    {
      id: 'move-note', label: t('移动到文件夹'), aliases: ['移动', '文件夹', 'move', 'folder'], icon: <FolderInput size={16} />, shortcut: '',
      disabled: disabled || !note || !!note.deletedAt,
      action: () => { setCommandPalette(false); if (note) setMovingNote({ ids: [note.id], title: note.title, currentFolderId: note.folderId, targetFolderId: note.folderId }); },
    },
    {
      id: 'search', label: t('搜索笔记'), aliases: ['搜索', 'search', 'find'], icon: <Search size={16} />, shortcut: '',
      disabled: false,
      action: () => {
        book.setQuery(commandQuery);
        setCommandPalette(false);
        requestAnimationFrame(() => searchInput.current?.focus());
      },
    },
    {
      id: 'doc-viewer', label: t('打开文档阅读与批注'), aliases: ['文档', 'pdf', 'txt', '批注', '阅读', 'document', 'annotate'], icon: <BookOpen size={16} />,
      shortcut: '', disabled: false,
      action: () => { setCommandPalette(false); openDocViewerForCurrentNote(); },
    },
    {
      id: 'layout', label: layout === 'edit' ? t('切换到预览模式') : t('切换到编辑模式'),
      aliases: ['编辑', '预览', '切换', 'edit', 'preview'], icon: layout === 'edit' ? <BookOpen size={16} /> : <PenLine size={16} />,
      shortcut: 'Ctrl+E / Cmd+Enter', disabled: !note || !!note.deletedAt,
      action: () => { setCommandPalette(false); toggleLayout(); },
    },
    {
      id: 'pin', label: note?.pinned ? t('取消置顶') : t('置顶笔记'), aliases: ['置顶', 'pin', 'unpin'],
      icon: <Pin size={16} />, shortcut: '', disabled: !note || !!note.deletedAt || !!transfer,
      action: () => { setCommandPalette(false); if (note) setNoteFields({ pinned: !note.pinned }); },
    },
    {
      id: 'archive', label: note?.archived ? t('取消归档') : t('归档笔记'), aliases: ['归档', 'archive', 'unarchive'],
      icon: note?.archived ? <ArchiveRestore size={16} /> : <Archive size={16} />, shortcut: '',
      disabled: !note || !!note.deletedAt || !!transfer,
      action: () => { setCommandPalette(false); if (note) setNoteFields({ archived: !note.archived }); },
    },
    {
      id: 'history', label: t('查看历史版本'), aliases: ['历史', '版本', 'history', 'version'], icon: <History size={16} />,
      shortcut: '', disabled: disabled || !note || note.revision === 0,
      action: () => { setCommandPalette(false); openHistory(); },
    },
    {
      id: 'outline', label: t('打开大纲与反向链接'), aliases: ['大纲', '反向链接', 'outline', 'backlinks'], icon: <ListTree size={16} />,
      shortcut: '', disabled: !note,
      action: () => { setCommandPalette(false); setInspector(true); },
    },
    ...(note && !note.deletedAt ? [{
      id: 'toc', label: noteHasToc ? t('移除目录') : t('插入目录'),
      aliases: ['目录', '插入目录', '移除目录', 'toc', 'table of contents'],
      icon: <TableOfContents size={16} />,
      shortcut: '', disabled: disabled || !!transfer,
      action: () => { setCommandPalette(false); toggleNoteToc(); },
    }] : []),
    ...(note && !note.deletedAt && noteHasToc ? [{
      id: 'update-toc', label: t('update_toc'),
      aliases: ['更新目录', '刷新目录', 'update toc', 'refresh toc'],
      icon: <RefreshCw size={16} />,
      shortcut: '', disabled: disabled || !!transfer,
      action: () => { setCommandPalette(false); updateNoteToc(true); },
    }] : []),
    {
      id: 'tasks', label: t('打开任务中心'), aliases: ['任务', '待办', 'TODO', 'tasks', 'todo'], icon: <ClipboardList size={16} />,
      shortcut: '', disabled: false,
      action: () => { setCommandPalette(false); void openTaskCenter(); },
    },
    {
      id: 'share-management', label: t('打开分享管理'), aliases: ['分享', '分享管理', 'share', 'shares'], icon: <Share2 size={16} />,
      shortcut: '', disabled: !book.online || !!session.offline,
      action: () => { setCommandPalette(false); setShareManagement(true); },
    },
    {
      id: 'link', label: t('insert_internal_link'), aliases: ['链接', 'link', 'internal link'], icon: <Link2 size={16} />,
      shortcut: '', disabled: !note || !!note.deletedAt || !!transfer,
      action: () => {
        setCommandPalette(false);
        setLayout('edit');
        requestAnimationFrame(beginLinkInsertion);
      },
    },
    {
      id: 'pdf', label: t('导出当前笔记为 PDF'), aliases: ['PDF', '打印', '导出', 'pdf', 'export'], icon: <Printer size={16} />,
      shortcut: 'Cmd/Ctrl+P', disabled: !note || printing,
      action: () => { setCommandPalette(false); exportCurrentNote(); },
    },
    {
      id: 'copy-markdown', label: t('复制 Markdown 内容'), aliases: ['复制', 'copy', 'markdown', 'md'], icon: <Copy size={16} />,
      shortcut: '', disabled: !note,
      action: () => { setCommandPalette(false); copyMarkdown('menu'); },
    },
    {
      id: 'copy-id', label: t('复制 ID'), aliases: ['复制ID', '复制 ID', '复制对象ID', '对象ID', 'copy id', 'id'], icon: <Copy size={16} />,
      shortcut: '', disabled: !note,
      action: () => { setCommandPalette(false); if (note) copyNoteId(note); },
    },
    {
      id: 'share', label: t('创建只读分享链接'), aliases: ['分享', '只读链接', 'share', 'readonly'], icon: <Share2 size={16} />,
      shortcut: '', disabled: !note || note.revision === 0 || !!note.deletedAt || book.pending.some((item) => item.id === note.id),
      action: () => { setCommandPalette(false); setSharing(true); },
    },
    {
      id: 'settings', label: t('打开设置'), aliases: ['设置', 'settings', 'config'], icon: <Settings size={16} />,
      shortcut: '', disabled: false,
      action: () => { setCommandPalette(false); setSettings(true); },
    },
    {
      id: 'shortcuts', label: t('查看快捷键'), aliases: ['快捷键', '帮助', 'shortcuts', 'help'], icon: <Keyboard size={16} />,
      shortcut: 'Cmd/Ctrl+/', disabled: false, action: showShortcutHelp,
    },
  ].filter((command) => commandMatch(command.label, ...command.aliases));
  const focusCommand = (edge: 'first' | 'last' = 'first') => {
    const buttons = [...(commandList.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    buttons[edge === 'first' ? 0 : buttons.length - 1]?.focus();
  };
  const errorFeedback = book.error && <div className="error-strip" role="alert">
    <details><summary>{t('操作未完成')}</summary><pre>{book.error}</pre></details>
    <button onClick={() => void syncNow()} disabled={book.busy || syncing}>{syncing ? t('正在重试…') : t('retry')}</button>
    <IconButton label={t('关闭错误')} onClick={() => book.setError('')}><X size={15} /></IconButton>
  </div>;
  const noticeFeedback = notice && <div className="toast" role="status"><Check size={16} />{notice.text}</div>;
  return <DialogFeedbackContext.Provider value={registerDialogFeedback}>
    <div
      className={`app-shell ${sidebar ? '' : 'sidebar-hidden'} ${noteListVisible ? '' : 'note-list-hidden'} ${mobileNote ? 'mobile-note' : ''} ${resizingList ? 'resizing-list' : ''} ${inspector ? 'inspector-open' : ''} ${documentFullscreen ? 'document-focus-mode' : ''}`}
      style={{ '--note-list-width': `${noteListWidth}px` } as CSSProperties}
    >
    <NavigationRail
      username={session.user!.username}
      view={book.view}
      activeTag={book.tag}
      sharing={shareManagement}
      quickNotes={quickNotes}
      tags={book.tags}
      tagCounts={book.tagCounts}
      tagColors={book.tagColors}
      folders={book.folders}
      activeFolderId={book.folderId}
      disabled={!!transfer || book.loading}
      online={book.online && !session.offline}
      collapsed={!sidebar}
      createNote={() => void createNote()}
      openSearch={() => {
        setExplorerVisible(true);
        requestAnimationFrame(() => searchInput.current?.focus());
      }}
      chooseView={chooseView}
      chooseFolder={chooseFolder}
      openTasks={() => void openTaskCenter()}
      openQuickNotes={() => {
        setQuickNotes(true);
        setShareManagement(false);
        book.setView('quick');
        book.setTag('');
        book.setFolderId(undefined);
        book.setQuery('');
        setMobileNavigation(false);
        setMobileNote(false);
      }}
      openSharing={() => setShareManagement(true)}
      openSettings={() => setSettings(true)}
      createFolder={() => setFolderEditor({ name: '', parentId: null })}
      manageTags={() => {
        setEditingTag(null); setMergingTag(null); setDeletingTag(null); setTagManager(true);
      }}
      renameTag={(tag) => {
        setTagManager(false); setEditingTag(tag); setEditingTagValue(tag); setMergingTag(null); setDeletingTag(null);
      }}
      mergeTag={(tag) => {
        const targets = book.tags.filter((value) => value !== tag);
        setTagManager(false); setMergingTag(tag); setMergingTarget(targets[0] ?? ''); setEditingTag(null); setDeletingTag(null);
      }}
      deleteTag={(tag) => {
        setTagManager(false); setDeletingTag(tag); setEditingTag(null); setMergingTag(null);
      }}
      setTagColor={book.setTagColor}
    />
    <div className="pane-divider navigation-divider" aria-hidden="false">
      <button className="pane-toggle" aria-label={t(sidebar ? '收起导航栏' : '展开导航栏')} aria-controls="navigation-rail" aria-expanded={sidebar}
        onClick={() => setNavigationVisible(!sidebar)}>{sidebar ? <ChevronLeft size={15} /> : <ChevronRight size={15} />}</button>
    </div>
    {quickNotes ? <QuickNotes
      notes={book.notes}
      activeNote={book.note}
      tags={book.tags}
      tagCounts={book.tagCounts}
      folders={book.folders}
      tagColors={book.tagColors}
      loading={book.loading}
      disabled={!book.online || !!session.offline || !!transfer}
      hasMore={book.nextOffset !== null}
      create={book.create}
      select={book.select}
      edit={book.edit}
      save={() => book.retry()}
      loadMore={() => void book.loadMore()}
      openNavigation={() => setMobileNavigation(true)}
      details={async (id) => (await api.note(id)).note}
      togglePin={(item) => run(async () => {
        await book.bulkUpdate([item.id], () => ({ pinned: !item.pinned }));
        showNotice(t(item.pinned ? '已取消置顶' : '已置顶'));
      })}
      copyLink={(item) => run(async () => {
        await navigator.clipboard.writeText(noteLink(item.id, item.title));
        showNotice(t('链接已复制'));
      })}
      share={(id) => run(async () => {
        await book.select(id);
        setSharing(true);
      })}
      moveToFolder={(id, folderId) => run(async () => {
        const folder = book.folders.find((item) => item.id === folderId);
        await book.bulkUpdate([id], () => ({ folderId, quick: false }));
        showNotice(t('已移动到文件夹“{0}”', folder?.name ?? t('文件夹')));
      })}
      addTag={(id, tag) => run(async () => {
        await book.bulkUpdate([id], (item) => ({ tags: [...new Set([...item.tags, tag])] }));
        showNotice(t('已添加标签 #{0}', tag));
      })}
      createTag={book.addTag}
      reportError={book.setError}
      archive={(id) => run(async () => {
        await book.bulkUpdate([id], () => ({ archived: true, deletedAt: null }));
        showNotice(t('已归档'));
      })}
      showHistory={async (item) => { openHistory(item); }}
      remove={(id) => run(async () => {
        await moveToTrash([id]);
        showNotice(t('已移入回收站'));
      })}
    /> : <><NotebookExplorer
      title={activeView}
      view={book.view}
      query={book.query}
      activeTag={book.tag}
      tagColors={book.tagColors}
      activeFolderId={book.folderId}
      folders={book.folders}
      notes={visibleNotes}
      currentNote={note}
      pendingIds={pendingIds}
      selectionMode={selectionMode}
      selectedIds={selected}
      inspectedFolderId={folderOverviewId}
      loading={book.loading}
      disabled={!book.online || !!session.offline || !!transfer}
      nextOffset={book.nextOffset}
      explorerFolders={book.explorerFolders}
      explorerFolderKey={book.explorerFolderKey}
      ensureFolder={book.ensureExplorerFolder}
      searchInput={searchInput}
      mobileSearch={mobileSearch}
      headerActions={<>
        <IconButton label="打开导航菜单" className="icon-button mobile-menu-trigger" onClick={() => setMobileNavigation(true)}><Menu size={21} /></IconButton>
        {!(mobileSearch || book.query) && <IconButton label="搜索笔记" className="icon-button mobile-search-trigger" onClick={toggleMobileSearch}><Search size={20} /></IconButton>}
        <IconButton label="快速跳转" className="icon-button list-command-action" onClick={() => { setCommandQuery(''); setCommandPalette(true); }}><Command size={16} /></IconButton>
        {book.view !== 'trash' && <IconButton label={selectionMode ? '退出批量选择' : '批量选择'} className="icon-button list-bulk-action" aria-pressed={selectionMode} onClick={() => selectionMode ? exitSelectionMode() : setSelectionMode(true)}>{selectionMode ? <CheckSquare size={16} /> : <Square size={16} />}</IconButton>}
        <IconButton label={syncing ? '正在同步全部' : '同步全部'} className="icon-button list-sync-action" onClick={() => void syncNow(false)} disabled={book.busy || syncing}>{syncing ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}</IconButton>
        {book.view === 'trash' && (book.notes.length > 0 || !!book.query || !!book.tag) && <IconButton label="全部永久删除" className="icon-button danger-icon list-purge-action" onClick={() => setConfirmAction('purge-all')} disabled={disabled || book.pending.length > 0}><Trash2 size={17} /></IconButton>}
        {book.view === 'all' && !book.tag && <IconButton label={activeFolderScopeId ? '新建子文件夹' : '新建文件夹'} className="icon-button list-create-folder-action" onClick={() => setFolderEditor({ name: '', parentId: activeFolderScopeId })} disabled={disabled || !book.online}><FolderPlus size={18} /></IconButton>}
        <IconButton label="新建笔记" className="icon-button list-create-action" onClick={() => void createNote()} disabled={!!transfer || book.loading}><Plus size={18} /></IconButton>
      </>}
      bulkToolbar={selectionMode ? <div className="bulk-toolbar">
        <div className="bulk-toolbar-header">
          <span>{uiLanguage() === 'en' ? `${selected.size} selected` : `已选 ${selected.size} 篇`}</span>
          <button aria-label={allVisibleSelected ? t('clear_selection') : t('select_all')} disabled={!book.notes.length} onClick={toggleSelectAll}>{allVisibleSelected ? <Square size={14} /> : <CheckSquare size={14} />}{allVisibleSelected ? t('clear_selection') : t('select_all')}</button>
          <button aria-label={t('exit_selection')} onClick={exitSelectionMode}><X size={14} />{t('cancel')}</button>
        </div>
        <div className="bulk-toolbar-actions">
          <button disabled={!selected.size || disabled} onClick={() => setMovingNote({ ids: [...selected], title: '', currentFolderId: null, targetFolderId: null })}><FolderInput size={14} />{t('移动')}</button>
          <button disabled={!selected.size || disabled} onClick={applyBulkArchive}>{book.view === 'archive' ? <ArchiveRestore size={14} /> : <Archive size={14} />}{book.view === 'archive' ? t('unarchive') : t('archive')}</button>
          <button disabled={!selected.size || disabled} onClick={() => setBulkTagOpen(true)}><Tag size={14} />{t('加标签')}</button>
          <button className="danger" disabled={!selected.size || disabled} onClick={() => setConfirmAction('bulk-trash')}><Trash2 size={14} />{t('delete')}</button>
        </div>
      </div> : undefined}
      setQuery={(value) => { book.setQuery(value); setMobileSearch(!!value); }}
      clearSearch={() => { book.setQuery(''); setMobileSearch(false); requestAnimationFrame(() => searchInput.current?.focus()); }}
      inspectFolder={(id) => {
        setFolderOverviewId((current) => current === id ? current : id);
        setMobileNote(true);
      }}
      createChild={(parentId) => setFolderEditor({ name: '', parentId })}
      createNoteIn={(folderId) => void createNoteInFolder(folderId)}
      uploadFileTo={uploadFileToFolder}
      moveFolder={(folder) => setMovingFolder({ folder, targetParentId: folder.parentId })}
      mergeFolder={(folder) => setMergingFolder({ folder, targetId: mergeTargets(book.folders, folder.id)[0]?.id ?? '' })}
      removeFolder={setDeletingFolder}
      shareFolder={(folder) => setSharingFolder(folder)}
      copyFolderPath={copyFolderPath}
      copyFolderId={copyFolderId}
      openNote={(id) => void openNote(id)}
      toggleSelected={toggleSelected}
      openNoteMenu={(id, trigger) => {
        const rect = trigger.getBoundingClientRect();
        void openNote(id).then(() => {
          if (window.matchMedia('(max-width: 640px)').matches) { setMobileNoteActions(true); return; }
          const width = 230;
          const height = 500;
          setNoteActionMenu({
            left: Math.min(Math.max(8, rect.left - 8), window.innerWidth - width - 8),
            top: Math.min(rect.bottom + 4, window.innerHeight - height - 8),
          });
        });
      }}
      loadMore={() => { setVisibleNoteLimit((value) => value + 50); if (!hasHiddenNotes && book.nextOffset !== null) void run(book.loadMore); }}
      createNote={() => void createNote()}
    />
    <div
      className="note-list-resizer pane-divider explorer-divider"
      role="separator"
      aria-label="调整笔记列表宽度"
      aria-orientation="vertical"
      aria-valuemin={220}
      aria-valuemax={440}
      aria-valuenow={noteListVisible ? noteListWidth : 0}
      aria-disabled={!noteListVisible}
      tabIndex={noteListVisible ? 0 : -1}
      title="拖动调整宽度，双击恢复默认"
      onPointerDown={beginNoteListResize}
      onPointerMove={moveNoteListResize}
      onPointerUp={finishNoteListResize}
      onPointerCancel={finishNoteListResize}
      onDoubleClick={(event) => {
        if (!noteListVisible || event.target instanceof Element && event.target.closest('button')) return;
        updateNoteListWidth(340);
        localStorage.setItem('easynote-note-list-width', '340');
      }}
      onKeyDown={resizeNoteListWithKeyboard}
    >
      <button className="pane-toggle" aria-label={t(noteListVisible ? '收起笔记列表' : '展开笔记列表')} aria-controls="notebook-explorer" aria-expanded={noteListVisible}
        onClick={() => setExplorerVisible(!noteListVisible)}>{noteListVisible ? <ChevronLeft size={15} /> : <ChevronRight size={15} />}</button>
    </div>
    <main id="document-workspace" className="workspace">
      <header className="workspace-toolbar">
        <IconButton label="返回笔记列表" className="icon-button mobile-back" onClick={() => setMobileNote(false)}><ArrowLeft size={18} /></IconButton>
        <span className={`save-status ${!book.online || session.offline ? 'offline' : book.pending.length || syncing || uploading ? 'pending' : 'saved'}`} aria-live="polite">
          <span className="save-status-icon" aria-hidden="true">{!book.online || session.offline ? <WifiOff size={15} /> : syncing || uploading ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}</span>
          <span>{!book.online || session.offline ? book.status : uploading ? t('uploading_files') : syncing ? t('syncing') : folderOverview ? t('folder_overview') : note ? book.status : t('note_workspace')}</span>
        </span>
        <div className="toolbar-right">
          {note && !folderOverview && <><div className="segmented" aria-label={t('显示模式')}><button title={t('edit')} aria-label={t('编辑模式')} aria-pressed={layout === 'edit'} onClick={() => editAt(Math.min(editorCursor.current, note.content.length))}><PenLine size={16} /></button><button title={t('preview')} aria-label={t('预览模式')} aria-pressed={layout === 'preview'} onClick={showPreview}><BookOpen size={16} /></button></div>
            {layout === 'edit' && <div className="segmented edit-mode-segmented" role="group" aria-label={t('编辑模式选择')}>
              <button title={t('实时渲染')} aria-label={t('实时渲染')} aria-pressed={editMode === 'live'} onClick={() => setEditMode('live')}><Eye size={14} /><span>{t('实时渲染')}</span></button>
              <button title={t('MD 语法')} aria-label={t('MD 语法')} aria-pressed={editMode === 'markdown'} onClick={() => setEditMode('markdown')}><Code2 size={14} /><span>{t('MD 语法')}</span></button>
            </div>}
            <IconButton label="插入内部链接" className="icon-button toolbar-link-action" disabled={!!note.deletedAt || !!transfer} onClick={beginLinkInsertion}><Link2 size={17} /></IconButton>
            <IconButton label={noteHasToc ? '移除目录' : '插入目录'} className={`icon-button toolbar-toc-action ${noteHasToc ? 'active' : ''}`} aria-pressed={noteHasToc} disabled={!note || !!note.deletedAt || !!transfer} onClick={toggleNoteToc}><TableOfContents size={17} /></IconButton>
            <IconButton label="大纲与反向链接" className="icon-button toolbar-outline-action" aria-pressed={inspector} onClick={() => setInspector((value) => !value)}><ListTree size={17} /></IconButton>
            <IconButton label={documentFullscreen ? '退出全屏' : '进入全屏'} className="icon-button document-fullscreen-toggle" aria-controls="document-workspace" aria-pressed={documentFullscreen} onClick={toggleDocumentFullscreen}>{documentFullscreen ? <Minimize2 size={17} /> : <Maximize2 size={17} />}</IconButton>
            <IconButton label={syncing ? '正在同步并更新历史版本' : '同步并更新历史版本'} disabled={disabled} onClick={() => void syncNow()}>{syncing ? <LoaderCircle className="spin" size={17} /> : <Save size={17} />}</IconButton>
            <IconButton label="移动到文件夹" className="icon-button toolbar-move-action" disabled={disabled || !!note.deletedAt} onClick={() => setMovingNote({ ids: [note.id], title: note.title, currentFolderId: note.folderId, targetFolderId: note.folderId })}><FolderInput size={17} /></IconButton>
            <IconButton label={note.pinned ? '取消置顶' : '置顶'} disabled={!!note.deletedAt || !!transfer} onClick={() => setNoteFields({ pinned: !note.pinned })}><Pin size={17} fill={note.pinned ? 'currentColor' : 'none'} /></IconButton>
            <IconButton label={note.archived ? '取消归档' : '归档'} disabled={!!note.deletedAt || !!transfer} onClick={() => setNoteFields({ archived: !note.archived })}>{note.archived ? <ArchiveRestore size={17} /> : <Archive size={17} />}</IconButton>
            <IconButton label="只读分享" className="icon-button toolbar-share-action" disabled={disabled || note.revision === 0 || !!note.deletedAt || book.pending.some((item) => item.id === note.id)}
              onClick={() => setSharing(true)}><Share2 size={17} /></IconButton>
            <div className="toolbar-copy-anchor">
              <IconButton
                label={copyFeedback ? '' : '复制 Markdown 内容'}
                aria-label={t('复制 Markdown 内容')}
                className={`icon-button toolbar-copy-action ${copyFeedback ? 'copied' : ''}`}
                disabled={!note}
                onClick={() => copyMarkdown('toolbar')}
              >
                {copyFeedback ? <Check size={17} className="copy-success-icon" /> : <Copy size={17} />}
              </IconButton>
              {copyFeedback && (
                <div className="toast toolbar-copy-toast" role="status">
                  <Check size={14} />
                  <span>{t('已复制 Markdown 内容')}</span>
                </div>
              )}
            </div>
            <IconButton label={pdfProgress || '导出当前笔记为 PDF'} className="icon-button print-action" disabled={printing} onClick={exportCurrentNote}>{printing ? <LoaderCircle className="spin" size={17} /> : <Printer size={17} />}</IconButton>
            <IconButton label="历史版本" className="icon-button toolbar-history-action" disabled={disabled || note.revision === 0} onClick={() => openHistory()}><History size={17} /></IconButton>
            {!note.deletedAt ? <IconButton label="移入回收站" className="toolbar-trash-action" disabled={disabled} onClick={() => setConfirmAction('trash')}><Trash2 size={17} /></IconButton> :
              <IconButton label="恢复笔记" className="toolbar-trash-action" disabled={disabled} onClick={() => setNoteFields({ deletedAt: null })}><RotateCcw size={17} /></IconButton>}
            <IconButton label="更多笔记操作" className="icon-button mobile-note-menu-trigger" onClick={() => setMobileNoteActions(true)}><MoreHorizontal size={20} /></IconButton>
          </>}
        </div>
      </header>
      {!dialogFeedbackTarget && errorFeedback}
      {folderOverview ? <div className="workspace-body"><FolderOverview
        folder={folderOverview}
        folders={book.folders}
        explorerFolders={book.explorerFolders}
        explorerFolderKey={book.explorerFolderKey}
        ensureFolder={book.ensureExplorerFolder}
        openNote={(id) => void openNote(id, 'preview')}
        createChild={(parentId) => setFolderEditor({ name: '', parentId })}
        createNoteIn={(folderId) => void createNoteInFolder(folderId)}
        uploadFileTo={uploadFileToFolder}
        moveFolder={(folder) => setMovingFolder({ folder, targetParentId: folder.parentId })}
        shareFolder={(folder) => setSharingFolder(folder)}
        copyFolderPath={copyFolderPath}
        copyFolderId={copyFolderId}
      /></div> : note ? <>
        {note.deletedAt && <div className="trash-banner"><span>{t('已移入回收站')}</span><button onClick={() => setConfirmAction('purge')} disabled={disabled || book.pending.some((n) => n.id === note.id)}>{t('delete_permanently')}</button></div>}
        <div className="workspace-body">
          <div className={`document-scroll ${hasEmbeddedDocs ? 'has-embedded-doc-scroll' : ''}`}>
            <div className={`document ${documentFullscreen ? 'wide' : ''} ${hasEmbeddedDocs ? 'has-embedded-doc' : ''}`}>
              <input className="note-title" aria-label={t('note_title')} placeholder={t('untitled_note')} maxLength={256} value={note.title} readOnly={!!note.deletedAt || !!transfer} onChange={(e) => setNoteFields({ title: e.target.value })} />
              <DocumentMetaBar
                note={note}
                folders={book.folders}
                allTags={book.tags}
                tagColors={book.tagColors}
                tagCounts={book.tagCounts}
                query={noteTagQuery}
                pickerRef={tagPickerRef}
                disabled={!!note.deletedAt || !!transfer}
                setQuery={setNoteTagQuery}
                setFolder={(folderId) => setNoteFields({ folderId })}
                setTags={(tags) => setNoteFields({ tags })}
                reportError={book.setError}
              />
              {layout === 'preview' || note.deletedAt || transfer
                ? <Preview content={note.content} userId={session.user?.id} onImage={setLightbox} onNote={(id) => void openNote(id)}
                    onFile={(id, href) => void run(() => downloadPrivateFile(id, href))}
                    onViewDocument={(doc) => setDocViewerFile(doc)}
                    onInsertToNote={handleInsertFromDocViewer}
                    onCreateNoteFromContent={handleCreateNoteFromDocViewer}
                    onTask={!note.deletedAt && !transfer ? (index, checked) =>
                      setNoteFields({ content: toggleMarkdownTask(note.content, index, checked) }) : undefined}
                    resolveFile={book.offlineLibrary ? book.cachedFile : undefined} dark={dark}
                    searchQuery={book.query}
                    onEditLine={!note.deletedAt && !transfer ? (line) => editAt(sourceLineOffset(note.content, line)) : undefined}
                    onRefreshToc={noteHasToc ? () => updateNoteToc(true) : undefined} />
                : <div className={`editing-surface ${editMode === 'live' ? 'live' : 'markdown-only'}`}>
                    <div className="editing-source" aria-label={t('Markdown 编辑器')}>
                      <Editor ref={editor} key={note.id} value={note.content} mode={editMode} onChange={(content) => setNoteFields({ content })}
                        onImages={(files, insertion) => void insertFiles(files, insertion)}
                        onTogglePreview={toggleLayout} onShowShortcuts={showShortcutHelp} searchQuery={book.query}
                        onRefreshToc={noteHasToc ? () => updateNoteToc(true) : undefined} />
                    </div>
                  </div>}
            </div>
          </div>
          {inspector && <aside className="knowledge-panel" aria-label={t('笔记导航')}>
            <header><span>{t('outline_and_links')}</span><IconButton label="关闭笔记导航" onClick={() => setInspector(false)}><X size={15} /></IconButton></header>
            <section><h3>{t('outline')}</h3>{outline.length ? <nav>{outline.map((heading, index) =>
              <button key={`${heading.offset}-${index}`} style={{ paddingLeft: `${8 + Math.max(0, heading.level - 1) * 10}px` }} onClick={() => goToHeading(heading.offset)}>{heading.text}</button>)}</nav>
              : <div className="panel-empty">{t('no_headings')}</div>}</section>
            <section><h3>{t('backlinks')}</h3>{backlinks.length ? <nav>{backlinks.map((item) =>
              <button key={item.id} onClick={() => void openNote(item.id)}><Link2 size={13} />{item.title || t('untitled_note')}</button>)}</nav>
              : <div className="panel-empty">{t('no_backlinks')}</div>}</section>
          </aside>}
        </div>
        <footer className="document-footer">
          <span className="footer-note-path"><FileText size={14} />{note.title || t('untitled_note')}</span>
          <span className="word-count">{t('{0} 字符', note.content.length.toLocaleString())}</span>
          <IconButton label={pdfProgress || t('导出当前笔记为 PDF')} className="icon-button mobile-pdf-action" disabled={printing}
            onClick={exportCurrentNote}>{printing ? <LoaderCircle className="spin" size={17} /> : <Printer size={17} />}</IconButton>
          <IconButton label={t('只读分享')} className="icon-button mobile-share-action"
            disabled={disabled || note.revision === 0 || !!note.deletedAt || book.pending.some((item) => item.id === note.id)}
            onClick={() => setSharing(true)}><Share2 size={17} /></IconButton>
          <IconButton label={t('文档阅读与批注')} disabled={disabled || !!note.deletedAt}
            onClick={() => openDocViewerForCurrentNote()}><BookOpen size={18} /></IconButton>
          <IconButton label={t('插入附件')} disabled={uploading || !!note.deletedAt || !!transfer || !book.online} onClick={() => {
            pendingInsertion.current = editor.current?.markInsertion() ?? null;
            attachmentInput.current?.click();
          }}><Paperclip size={18} /></IconButton>
          <IconButton label={t('插入图片')} disabled={uploading || !!note.deletedAt || !!transfer || !book.online} onClick={() => {
            pendingInsertion.current = editor.current?.markInsertion() ?? null;
            imageInput.current?.click();
          }}><ImagePlus size={19} /></IconButton>
          <input hidden ref={attachmentInput} type="file" accept=".pdf,.md,.txt,.csv,.json,application/pdf,text/plain,text/markdown,text/csv,application/json" multiple onChange={(e) => void insertFiles(Array.from(e.target.files ?? []))} />
          <input hidden ref={imageInput} type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(e) => void insertFiles(Array.from(e.target.files ?? []))} />
        </footer>
      </> : <div className="workspace-empty"><PenLine size={36} /><h2>{t('你的笔记')}</h2><button className="primary" disabled={book.loading || !!transfer} onClick={() => void createNote()}><Plus size={16} />{t('新建笔记')}</button></div>}
    </main></>}
    {!dialogFeedbackTarget && noticeFeedback}
    {dialogFeedbackTarget && createPortal(<>{errorFeedback}{noticeFeedback}</>, dialogFeedbackTarget)}
    <input hidden ref={importInput} type="file" accept=".zip,.md,.markdown,.txt" multiple onChange={(e) => {
      const files = Array.from(e.target.files ?? []);
      if (files.length) void transferAction(() =>
        importExternalFiles(files, session.config, setTransfer, book.findDuplicates, importFolderId), ({ imported, skipped }) =>
        imported ? (skipped ? t('已导入 {0} 篇，跳过 {1} 篇重复笔记', imported, skipped) : t('已导入 {0} 篇笔记', imported)) : t('未导入：{0} 篇笔记已存在', skipped));
      e.target.value = '';
    }} />
    <input hidden ref={importFolderInput} type="file" multiple {...{ webkitdirectory: '' }} onChange={(e) => {
      const files = Array.from(e.target.files ?? []);
      if (files.length) void transferAction(() =>
        importExternalFiles(files, session.config, setTransfer, book.findDuplicates, importFolderId), ({ imported, skipped }) =>
        imported ? (skipped ? t('已导入 {0} 篇，跳过 {1} 篇重复笔记', imported, skipped) : t('已导入 {0} 篇笔记', imported)) : t('未导入：{0} 篇笔记已存在', skipped));
      e.target.value = '';
    }} />
    <input hidden ref={folderUploadInput} type="file" accept=".pdf,.txt,.md,.markdown,.zip,.json,.csv,application/pdf,text/plain,text/markdown,application/zip" multiple onChange={(e) => {
      const files = Array.from(e.target.files ?? []);
      const targetId = folderUploadTarget.current;
      e.target.value = '';
      if (targetId && files.length) void uploadFilesToFolder(targetId, files);
    }} />
    {mobileNavigation && <Modal title="EasyNote" className="mobile-navigation-dialog" close={() => setMobileNavigation(false)}>
      <nav className="mobile-navigation-list" aria-label={t('移动端笔记分类')}>
        <button className={!quickNotes && !shareManagement && book.view === 'all' && !book.tag && book.folderId === undefined ? 'active' : ''} onClick={() => chooseView('all')}><FileText size={18} />{t('all_notes')}</button>
        <button className={quickNotes ? 'active' : ''} onClick={() => {
          setQuickNotes(true); setShareManagement(false); book.setView('quick'); book.setTag(''); book.setFolderId(undefined); book.setQuery(''); setMobileNavigation(false);
        }}><NotebookPen size={18} />{t('小记')}</button>
        <button onClick={() => { setMobileNavigation(false); void openTaskCenter(); }}><ClipboardList size={18} />{t('task_center')}</button>
        <button className={!shareManagement && book.view === 'archive' ? 'active' : ''} onClick={() => chooseView('archive')}><Archive size={18} />{t('archive')}</button>
        <button className={shareManagement ? 'active' : ''} disabled={!book.online || !!session.offline}
          onClick={() => { setMobileNavigation(false); setShareManagement(true); }}><Share2 size={18} />{t('sharing')}</button>
        <button className={!shareManagement && book.view === 'trash' ? 'active' : ''} onClick={() => chooseView('trash')}><Trash2 size={18} />{t('trash')}</button>
      </nav>
      {book.folders.length > 0 && <>
        <div className="mobile-navigation-label">
          <span>{t('文件夹')}</span>
          <button className="section-action" aria-label={t('新建文件夹')} disabled={!book.online || !!session.offline} onClick={() => { setMobileNavigation(false); setFolderEditor({ name: '', parentId: null }); }}><Plus size={16} /></button>
        </div>
        <FolderTree folders={book.folders} selected={book.folderId} disabled={!book.online || !!session.offline} choose={chooseFolder}
          createChild={(parentId) => { setMobileNavigation(false); setFolderEditor({ name: '', parentId }); }}
          move={(folder) => { setMobileNavigation(false); setMovingFolder({ folder, targetParentId: folder.parentId }); }}
          edit={(folder) => { setMobileNavigation(false); setFolderEditor({ id: folder.id, name: folder.name, parentId: folder.parentId }); }}
          remove={(folder) => { setMobileNavigation(false); setDeletingFolder(folder); }} />
      </>}
      {book.tags.length > 0 && <>
        <div className="mobile-navigation-label">{t('tags')}</div>
        <nav className="mobile-navigation-list" aria-label={t('mobile_tags')}>{book.tags.map((tag) =>
          <button key={tag} className={!shareManagement && book.tag === tag ? 'active' : ''} onClick={() => chooseView(book.view, tag)}><span className={`tag-color-dot tag-color-${tagColorIndex(tag, book.tagColors)}`} aria-hidden="true" />{tag}</button>)}
        </nav>
      </>}
      <div className="mobile-navigation-actions">
        <button onClick={() => { setMobileNavigation(false); setCommandQuery(''); setCommandPalette(true); }}><Command size={18} />{t('quick_open')}</button>
        {book.view !== 'trash' && <button onClick={() => {
          setMobileNavigation(false);
          setSelectionMode(true);
          setSelected(new Set());
        }}><CheckSquare size={18} />{t('select_multiple')}</button>}
        <button disabled={book.busy || syncing} onClick={() => { setMobileNavigation(false); void syncNow(false); }}><RefreshCw size={18} />{t('sync_all')}</button>
        {book.view === 'trash' && (book.notes.length > 0 || !!book.query || !!book.tag) &&
          <button className="danger" disabled={disabled || book.pending.length > 0} onClick={() => { setMobileNavigation(false); setConfirmAction('purge-all'); }}><Trash2 size={18} />{t('全部永久删除')}</button>}
        <button onClick={() => { setMobileNavigation(false); setSettings(true); }}><Settings size={18} />{t('settings')}</button>
      </div>
    </Modal>}
    {noteActionMenu && note && <div className="note-action-popover" role="menu" aria-label={t('笔记操作')} ref={noteActionMenuRef}
      style={{ left: noteActionMenu.left, top: noteActionMenu.top }}>
      <button role="menuitem" disabled={disabled} onClick={() => { setNoteActionMenu(null); void syncNow(); }}><Save size={17} />{t('sync_and_save_version')}</button>
      <button role="menuitem" disabled={!!note.deletedAt || !!transfer} onClick={() => { setNoteActionMenu(null); beginLinkInsertion(); }}><Link2 size={17} />{t('insert_internal_link')}</button>
      <button role="menuitem" disabled={disabled || !note || !!note.deletedAt} onClick={() => { setNoteActionMenu(null); toggleNoteToc(); }}><TableOfContents size={17} />{noteHasToc ? t('移除目录') : t('插入目录')}</button>
      {noteHasToc && <button role="menuitem" disabled={disabled || !note || !!note.deletedAt} onClick={() => { setNoteActionMenu(null); updateNoteToc(true); }}><RefreshCw size={17} />{t('update_toc')}</button>}
      <button role="menuitem" onClick={() => { setNoteActionMenu(null); setInspector((value) => !value); }}><ListTree size={17} />{t('outline_and_links')}</button>
      <button role="menuitem" disabled={disabled || !!note.deletedAt} onClick={() => { setNoteActionMenu(null); setMovingNote({ ids: [note.id], title: note.title, currentFolderId: note.folderId, targetFolderId: note.folderId }); }}><FolderInput size={17} />{t('移动到文件夹')}</button>
      <button role="menuitem" disabled={!!note.deletedAt || !!transfer} onClick={() => { setNoteActionMenu(null); setNoteFields({ pinned: !note.pinned }); }}><Pin size={17} fill={note.pinned ? 'currentColor' : 'none'} />{note.pinned ? t('取消置顶') : t('置顶')}</button>
      <button role="menuitem" disabled={!!note.deletedAt || !!transfer} onClick={() => { setNoteActionMenu(null); setNoteFields({ archived: !note.archived }); }}>{note.archived ? <ArchiveRestore size={17} /> : <Archive size={17} />}{note.archived ? t('取消归档') : t('归档')}</button>
      <button role="menuitem" className="menu-share-action" disabled={disabled || note.revision === 0 || !!note.deletedAt || book.pending.some((item) => item.id === note.id)}
        onClick={() => { setNoteActionMenu(null); setSharing(true); }}><Share2 size={17} />{t('readonly_share')}</button>
      <button role="menuitem" disabled={!note} onClick={() => { setNoteActionMenu(null); copyNotePath(note); }}><Copy size={17} />{t('复制路径')}</button>
      <button role="menuitem" disabled={!note} onClick={() => { setNoteActionMenu(null); copyNoteId(note); }}><Copy size={17} />{t('复制 ID')}</button>
      <button role="menuitem" disabled={!note} onClick={() => { setNoteActionMenu(null); copyMarkdown('menu'); }}><Copy size={17} />{t('复制 Markdown 内容')}</button>
      <button role="menuitem" disabled={disabled || note.revision === 0} onClick={() => { setNoteActionMenu(null); openHistory(); }}><History size={17} />{t('version_history')}</button>
      {!note.deletedAt
        ? <button role="menuitem" className="danger" disabled={disabled} onClick={() => { setNoteActionMenu(null); setConfirmAction('trash'); }}><Trash2 size={17} />{t('move_to_trash')}</button>
        : <button role="menuitem" onClick={() => { setNoteActionMenu(null); setNoteFields({ deletedAt: null }); }}><RotateCcw size={17} />{t('restore_note')}</button>}
    </div>}
    {mobileNoteActions && note && <Modal title="笔记操作" className="mobile-actions-dialog" close={() => setMobileNoteActions(false)}>
      <div className="mobile-action-list">
        <button disabled={disabled} onClick={() => { setMobileNoteActions(false); void syncNow(); }}><Save size={18} />{t('sync_and_save_version')}</button>
        <button disabled={!!note.deletedAt || !!transfer} onClick={() => { setMobileNoteActions(false); beginLinkInsertion(); }}><Link2 size={18} />{t('insert_internal_link')}</button>
        <button disabled={disabled || !note || !!note.deletedAt} onClick={() => { setMobileNoteActions(false); toggleNoteToc(); }}><TableOfContents size={18} />{noteHasToc ? t('移除目录') : t('插入目录')}</button>
        {noteHasToc && <button disabled={disabled || !note || !!note.deletedAt} onClick={() => { setMobileNoteActions(false); updateNoteToc(true); }}><RefreshCw size={18} />{t('update_toc')}</button>}
        <button onClick={() => { setMobileNoteActions(false); setInspector((value) => !value); }}><ListTree size={18} />{t('outline_and_links')}</button>
        <button disabled={disabled || !!note.deletedAt} onClick={() => { setMobileNoteActions(false); setMovingNote({ ids: [note.id], title: note.title, currentFolderId: note.folderId, targetFolderId: note.folderId }); }}><FolderInput size={18} />{t('移动到文件夹')}</button>
        <button disabled={!!note.deletedAt || !!transfer} onClick={() => { setMobileNoteActions(false); setNoteFields({ pinned: !note.pinned }); }}><Pin size={18} fill={note.pinned ? 'currentColor' : 'none'} />{note.pinned ? t('取消置顶') : t('置顶')}</button>
        <button disabled={!!note.deletedAt || !!transfer} onClick={() => { setMobileNoteActions(false); setNoteFields({ archived: !note.archived }); }}>{note.archived ? <ArchiveRestore size={18} /> : <Archive size={18} />}{note.archived ? t('取消归档') : t('归档')}</button>
        <button className="mobile-share-action" disabled={disabled || note.revision === 0 || !!note.deletedAt || book.pending.some((item) => item.id === note.id)}
          onClick={() => { setMobileNoteActions(false); setSharing(true); }}><Share2 size={18} />{t('readonly_share')}</button>
        <button disabled={!note} onClick={() => { setMobileNoteActions(false); copyNotePath(note); }}><Copy size={18} />{t('复制路径')}</button>
        <button disabled={!note} onClick={() => { setMobileNoteActions(false); copyNoteId(note); }}><Copy size={18} />{t('复制 ID')}</button>
        <button className="mobile-pdf-action" disabled={printing} onClick={() => { setMobileNoteActions(false); exportCurrentNote(); }}><Printer size={18} />{t('导出为 PDF')}</button>
        <button disabled={!note} onClick={() => { setMobileNoteActions(false); copyMarkdown('menu'); }}><Copy size={18} />{t('复制 Markdown 内容')}</button>
        <button disabled={disabled || note.revision === 0} onClick={() => { setMobileNoteActions(false); openHistory(); }}><History size={18} />{t('version_history')}</button>
        {!note.deletedAt
          ? <button className="danger" disabled={disabled} onClick={() => { setMobileNoteActions(false); setConfirmAction('trash'); }}><Trash2 size={18} />{t('move_to_trash')}</button>
          : <button onClick={() => { setMobileNoteActions(false); setNoteFields({ deletedAt: null }); }}><RotateCcw size={18} />{t('restore_note')}</button>}
      </div>
    </Modal>}
    {folderEditor && <Modal title={folderEditor.id ? t('编辑文件夹') : folderEditor.parentId ? t('新建子文件夹') : t('新建文件夹')} close={() => setFolderEditor(null)}>
      <form className="folder-form" onSubmit={(event) => {
        event.preventDefault();
        const name = folderEditor.name.trim();
        if (!name) return;
        void run(async () => {
          if (folderEditor.id) await book.updateFolder(folderEditor.id, { name, parentId: folderEditor.parentId });
          else await book.createFolder(name, folderEditor.parentId);
          setFolderEditor(null);
        });
      }}>
        <label>{t('文件夹名称')}<input autoFocus maxLength={120} value={folderEditor.name}
          onChange={(event) => setFolderEditor({ ...folderEditor, name: event.target.value })} /></label>
        <label>{t('上级文件夹')}<select value={folderEditor.parentId ?? ''}
          onChange={(event) => setFolderEditor({ ...folderEditor, parentId: event.target.value || null })}>
          <option value="">{t('根目录')}</option>
          {book.folders.filter((folder) => folder.id !== folderEditor.id).map((folder) =>
            <option key={folder.id} value={folder.id}>{folder.name}</option>)}
        </select></label>
        <div className="dialog-actions"><button type="button" onClick={() => setFolderEditor(null)}>{t('cancel')}</button>
          <button className="primary" type="submit" disabled={!folderEditor.name.trim()}>{t('save')}</button></div>
      </form>
    </Modal>}
    {deletingFolder && <Modal title="删除文件夹" close={() => setDeletingFolder(null)}>
      <p>{t('删除文件夹“{0}”及其子文件夹？其中的笔记会移到根目录，完全空白笔记会移入回收站。', deletingFolder.name)}</p>
      <div className="dialog-actions"><button onClick={() => setDeletingFolder(null)}>{t('cancel')}</button><button className="danger" onClick={() => void run(async () => {
        const moved = await book.deleteFolder(deletingFolder.id);
        setDeletingFolder(null);
        showNotice(t('文件夹已删除，{0} 篇笔记已移到根目录', moved));
      })}>{t('delete')}</button></div>
    </Modal>}
    {mergingFolder && <Modal title="合并文件夹到" close={() => setMergingFolder(null)}>
      <form className="folder-form" onSubmit={(event) => {
        event.preventDefault();
        if (!mergingFolder.targetId) return;
        const target = book.folders.find((folder) => folder.id === mergingFolder.targetId);
        if (!target) return;
        void run(async () => {
          const result = await book.mergeFolder(mergingFolder.folder.id, target.id);
          setMergingFolder(null);
          showNotice(t('文件夹“{0}”已合并到“{1}”，移动了 {2} 篇笔记和 {3} 个子文件夹', mergingFolder.folder.name, target.name, result.movedNotes, result.movedFolders));
        });
      }}>
        <p>{t('合并后，直属笔记和子文件夹会移入目标文件夹，源文件夹会被删除。')}</p>
        <label>{t('目标文件夹')}<select autoFocus value={mergingFolder.targetId}
          onChange={(event) => setMergingFolder({ ...mergingFolder, targetId: event.target.value })}>
          {mergeTargets(book.folders, mergingFolder.folder.id).map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
        </select></label>
        <div className="dialog-actions"><button type="button" onClick={() => setMergingFolder(null)}>{t('cancel')}</button>
          <button className="danger" type="submit" disabled={!mergingFolder.targetId}>{t('merge')}</button></div>
      </form>
    </Modal>}
    {movingFolder && <Modal title="移动文件夹到" close={() => setMovingFolder(null)}>
      <form className="folder-form" onSubmit={(event) => {
        event.preventDefault();
        submitMoveFolder(movingFolder.targetParentId);
      }}>
        <p>{t('将文件夹“{0}”移动到目标文件夹：', movingFolder.folder.name)}</p>
        <div className="folder-picker-field">
          <span className="folder-picker-field-label">{t('目标文件夹')}</span>
          <FolderTreePicker
            folders={mergeTargets(book.folders, movingFolder.folder.id)}
            value={movingFolder.targetParentId}
            onChange={(targetParentId) => setMovingFolder({ ...movingFolder, targetParentId })}
            onConfirm={() => {
              if (!disabled && movingFolder.targetParentId !== movingFolder.folder.parentId) {
                submitMoveFolder(movingFolder.targetParentId);
              }
            }}
          />
        </div>
        <div className="dialog-actions"><button type="button" onClick={() => setMovingFolder(null)}>{t('cancel')}</button>
          <button className="primary" type="submit" disabled={disabled || movingFolder.targetParentId === movingFolder.folder.parentId}>{t('移动')}</button></div>
      </form>
    </Modal>}
    {movingNote && <Modal title={movingNote.ids.length > 1 ? t('移动笔记到') : t('移动到文件夹')} close={() => setMovingNote(null)}>
      <form className="folder-form" onSubmit={(event) => {
        event.preventDefault();
        submitMoveNote(movingNote.targetFolderId);
      }}>
        <p>{movingNote.ids.length > 1
          ? t('将已选 {0} 篇笔记移动到目标文件夹：', movingNote.ids.length)
          : t('将笔记“{0}”移动到目标文件夹：', movingNote.title || t('untitled_note'))}</p>
        <div className="folder-picker-field">
          <span className="folder-picker-field-label">{t('目标文件夹')}</span>
          <FolderTreePicker
            folders={book.folders}
            value={movingNote.targetFolderId}
            onChange={(targetFolderId) => setMovingNote({ ...movingNote, targetFolderId })}
            onConfirm={() => {
              if (!disabled && !(movingNote.ids.length === 1 && movingNote.targetFolderId === movingNote.currentFolderId)) {
                submitMoveNote(movingNote.targetFolderId);
              }
            }}
          />
        </div>
        <div className="dialog-actions"><button type="button" onClick={() => setMovingNote(null)}>{t('cancel')}</button>
          <button className="primary" type="submit" disabled={disabled || (movingNote.ids.length === 1 && movingNote.targetFolderId === movingNote.currentFolderId)}>{t('移动')}</button></div>
      </form>
    </Modal>}
    {settings && <Modal title="设置" close={() => { if (!transfer) setSettings(false); }}>
      <div className="setting-row"><span>语言/Language</span><select aria-label={t('language')} value={uiLanguage()} onChange={(event) => setUiLanguage(event.target.value as 'zh' | 'en')}>
        <option value="zh">中文</option><option value="en">English</option>
      </select></div>
      <div className="setting-row"><span>{t('深色外观')}</span><button role="switch" aria-checked={dark} aria-label={t('深色外观')} className={`switch ${dark ? 'on' : ''}`} onClick={() => setDark(!dark)}>{dark ? <Moon size={14} /> : <Sun size={14} />}</button></div>
      {!dark && <div className="setting-row"><span>{t('浅色背景')}</span><select aria-label={t('浅色背景')} value={lightBackground}
        onChange={(event) => setLightBackground(event.target.value as 'light' | 'white' | 'warm')}>
        <option value="light">{t('柔和灰白')}</option><option value="white">{t('纯白')}</option><option value="warm">{t('暖白')}</option>
      </select></div>}
      <div className="setting-row"><span>{t('离线笔记库')}{book.offlineLibrary ? (uiLanguage() === 'en' ? ` · ${book.offlineCount} notes` : ` · ${book.offlineCount} 篇`) : ''}</span><button role="switch" aria-checked={book.offlineLibrary} aria-label={t('离线笔记库')} className={`switch ${book.offlineLibrary ? 'on' : ''}`} disabled={disabled || session.offline} onClick={() => void run(() => book.configureOffline(!book.offlineLibrary))}>{book.offlineLibrary ? <Check size={14} /> : <WifiOff size={14} />}</button></div>
      {installApp && <div className="setting-row"><span>{t('app')}</span><button disabled={disabled} onClick={() => void run(installApp)}><Download size={16} />{t('安装 EasyNote')}</button></div>}
      <div className="setting-row"><span>{t('导出')}</span><div className="button-group">
        <button disabled={!!transfer || !book.online} onClick={() => void transferAction(() => exportArchive(setTransfer), t('备份已下载'))}><Download size={16} />{t('导出 ZIP')}</button>
        <button disabled={!!transfer || !book.pending.length} onClick={() => {
          setTransfer(t('正在准备草稿…'));
          void exportLocalDrafts(session.user!.id, setTransfer).then((count) => showNotice(t('drafts_exported', count)))
            .catch((error: unknown) => book.setError(String(error))).finally(() => setTransfer(''));
        }}><Download size={16} />{t('导出草稿')}</button>
      </div></div>
      <div className="setting-row"><span>{t('导入到')}</span><select aria-label={t('导入所属文件夹')} value={importFolderId ?? ''}
        onChange={(event) => setImportFolderId(event.target.value || null)}><option value="">{t('根目录')}</option>
        {book.folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></div>
      <div className="setting-row"><span>{t('导入')}</span><div className="button-group">
        <button disabled={!!transfer || !book.online} onClick={() => importInput.current?.click()}><Upload size={16} />{t('导入文件')}</button>
        <button disabled={!!transfer || !book.online} onClick={() => importFolderInput.current?.click()}><FolderOpen size={16} />{t('导入目录')}</button>
      </div></div>
      <div className="setting-row"><span>{t('存储空间与告警')}</span><button disabled={disabled || session.offline} onClick={() => { setSettings(false); setStorageModal(true); }}><HardDrive size={16} />{t('查看与配置')}</button></div>
      <div className="setting-row"><span>{t('账户安全')}</span><button disabled={disabled || session.offline} onClick={() => { setSettings(false); setAccountSecurity(true); }}><ShieldCheck size={16} />{t('管理')}</button></div>
      {session.user!.role === 'admin' && <div className="setting-row"><span>{t('用户与注册')}</span><button disabled={disabled || session.offline}
        onClick={() => { setSettings(false); setUserManagement(true); }}><Users size={16} />{t('管理用户')}</button></div>}
      <AiAccess disabled={disabled || !book.online || !!session.offline} reportError={book.setError} notify={showNotice} />
      <details className="import-guide">
        <summary>{t('查看导入格式示例')}</summary>
        <p>{t('请选择 EasyNote 导出的完整 ZIP，不要解压后逐个选择笔记文件。')}</p>
        <p>{t('也可导入 Obsidian 目录、通用 Markdown/TXT ZIP 或多个 Markdown/TXT 文件；本地 Wiki 链接、相对链接和受支持附件会自动转换。')}</p>
        <pre>{uiLanguage() === 'en' ? `easynote-YYYY-MM-DD.zip
  manifest.json
  notes/
    sample-note.md
    untitled.md
  files/
    <file-id>-attachment-name` : `easynote-YYYY-MM-DD.zip
  manifest.json
  notes/
    示例笔记.md
    未命名.md
  files/
    <file-id>-附件名`}</pre>
        <p><code>manifest.json</code> {uiLanguage() === 'en' ? 'Example:' : '示例：'}</p>
        <pre>{uiLanguage() === 'en' ? `{
  "format": "easynote",
  "version": 2,
  "notes": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "path": "notes/sample-note.md",
      "title": "Sample Note",
      "tags": ["sample"],
      "pinned": false,
      "archived": false,
      "deletedAt": null
    }
  ],
  "files": []
}` : `{
  "format": "easynote",
  "version": 2,
  "notes": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "path": "notes/示例笔记.md",
      "title": "示例笔记",
      "tags": ["示例"],
      "pinned": false,
      "archived": false,
      "deletedAt": null
    }
  ],
  "files": []
}`}</pre>
        <p>{t('笔记文件优先使用标题命名，重名时自动编号；ZIP 根据清单恢复原标题。单独导入 Markdown 或 TXT 时，正文首个非空行作为标题。正文完全一致或完全空白的重复笔记会自动跳过。')}</p>
      </details>
      {transfer && <div className="transfer-progress" role="status">{transfer}</div>}
      <div className="setting-row"><span>{session.user!.username}</span><button disabled={disabled} onClick={() => void run(async () => {
        if (book.pending.length) throw new Error(t('本机还有未上传草稿，请先完成保存。'));
        if (book.online && !session.offline) await api.logout();
        await logout();
      })}><LogOut size={16} />{t('退出登录')}</button></div>
      <div className="setting-row"><span>{t('版本')}</span><span className="setting-value">EasyNote {__EASYNOTE_VERSION__}</span></div>
    </Modal>}
    {storageModal && <Modal title="存储空间与告警" close={() => setStorageModal(false)}>
      <StoragePanel
        userId={session.user!.id}
        disabled={disabled || !!book.pending.length || !book.online || !!session.offline}
        isAdmin={session.user!.role === 'admin'}
        notify={showNotice}
        reportError={book.setError}
      />
    </Modal>}
    {accountSecurity && <Modal title="账户安全" close={() => setAccountSecurity(false)}>
      <AccountSecurity username={session.user!.username} disabled={disabled || !!book.pending.length || !book.online || !!session.offline}
        notify={showNotice} reportError={book.setError} logout={logout} />
    </Modal>}
    {userManagement && <Modal title="用户与注册" close={() => setUserManagement(false)}>
      <UserManagement currentUserId={session.user!.id} registrationEnabled={registrationEnabled}
        onRegistrationChange={setRegistrationEnabled}
        disabled={disabled || !book.online || !!session.offline} notify={showNotice} reportError={book.setError} />
    </Modal>}
    {taskCenter && <Modal title="任务中心" close={() => setTaskCenter(false)}>
      <div className="task-center">
        {tasksLoading ? <div className="panel-empty">{t('正在汇总待办…')}</div> : !tasks.length
          ? <div className="panel-empty">{t('没有未完成的待办事项')}</div>
          : tasks.map((task) => <button key={`${task.noteId}:${task.offset}`} onClick={() => void openTask(task)}>
            <span className="task-center-copy">
              <span>{task.text}</span>
              <small>{task.noteTitle || t('untitled_note')} · {t('第 {0} 行', task.line)}{task.archived ? ` · ${t('已归档')}` : ''}</small>
            </span>
            <ChevronRight size={16} aria-hidden="true" />
          </button>)}
      </div>
    </Modal>}
    {shareManagement && <Modal title="分享管理" className="share-management-dialog" close={() => setShareManagement(false)}>
      <ShareManagement disabled={disabled || !book.online || !!session.offline}
        notify={showNotice} openNote={(share) => void openManagedShare(share)} reportError={book.setError} />
    </Modal>}
    {sharing && note && <Modal title="只读分享" close={() => setSharing(false)}>
      <NoteSharing noteId={note.id} disabled={disabled || !!note.deletedAt || book.pending.some((item) => item.id === note.id)}
        notify={showNotice} reportError={book.setError} />
    </Modal>}
    {sharingFolder && <Modal title={t('分享文件夹')} close={() => setSharingFolder(null)}>
      <FolderSharing folderId={sharingFolder.id} folderName={sharingFolder.name} disabled={disabled || !book.online || !!session.offline}
        notify={showNotice} reportError={book.setError} />
    </Modal>}
    {commandPalette && <Modal title="快速跳转" close={() => setCommandPalette(false)}>
      <label className="command-search"><Search size={16} /><input autoFocus aria-label={t('快速跳转搜索')} value={commandQuery}
        onChange={(event) => setCommandQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            focusCommand(event.key === 'ArrowDown' ? 'first' : 'last');
          } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            focusCommand();
            commandList.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.click();
          }
        }} /></label>
      <div ref={commandList} className="command-list" onKeyDown={(event) => moveButtonFocus(event, 'button')}>
        {commandActions.map((command) => <button key={command.id} disabled={command.disabled} onClick={command.action}>
          {command.icon}<span>{command.label}</span>{command.shortcut && <kbd>{command.shortcut}</kbd>}
        </button>)}
        {commandNotes.map((item) => <button key={item.id} onClick={() => void openNote(item.id)}><FileText size={16} /><span>{item.title || t('untitled_note')}</span></button>)}
      </div>
    </Modal>}
    {shortcutHelp && <Modal title="快捷键" close={() => setShortcutHelp(false)}>
      <div className="shortcut-list">
        <div><span>{t('打开快速跳转')}</span><kbd>Cmd/Ctrl+K</kbd></div>
        <div><span>{t('sync_and_save_version')}</span><kbd>Cmd/Ctrl+S</kbd></div>
        <div><span>{t('编辑 / 预览')}</span><kbd>Ctrl+E / Cmd+Enter</kbd></div>
        <div><span>{t('导出当前笔记为 PDF')}</span><kbd>Cmd/Ctrl+P</kbd></div>
        <div><span>{t('粗体')}</span><kbd>Cmd/Ctrl+B</kbd></div>
        <div><span>{t('斜体')}</span><kbd>Cmd/Ctrl+I</kbd></div>
        <div><span>{t('快捷键帮助')}</span><kbd>Cmd/Ctrl+/</kbd></div>
        <div><span>{t('关闭弹窗')}</span><kbd>Esc</kbd></div>
        <div><span>{t('命令或笔记列表导航')}</span><kbd>↑ / ↓</kbd></div>
      </div>
    </Modal>}
    {linkPicker && <Modal title="插入内部链接" close={() => {
      if (pendingInsertion.current) editor.current?.releaseInsertion(pendingInsertion.current);
      pendingInsertion.current = null;
      setLinkPicker(false);
    }}>
      <label className="command-search"><Search size={16} /><input autoFocus aria-label={t('搜索链接目标')} value={linkQuery} onChange={(event) => setLinkQuery(event.target.value)} /></label>
      <div className="command-list">{linkNotes.map((item) =>
        <button key={item.id} onClick={() => insertNoteLink(item)}><Link2 size={16} /><span>{item.title || t('untitled_note')}</span></button>)}</div>
    </Modal>}
    {!tagManager && editingTag && <Modal title="重命名标签" className="tag-quick-action-dialog" close={() => setEditingTag(null)}>
      <form className="tag-quick-action-form" onSubmit={(event) => { event.preventDefault(); handleSaveEditTag(); }}>
        <label>{t('新标签名称')}
          <span className="tag-quick-input"><span className={`tag-color-dot tag-color-${tagColorIndex(editingTag, book.tagColors)}`} aria-hidden="true" />
            <input autoFocus aria-label={t('新标签名称')} maxLength={40} value={editingTagValue} onChange={(event) => setEditingTagValue(event.target.value)} /></span>
        </label>
        <div className="dialog-actions"><button type="button" onClick={() => setEditingTag(null)}>{t('cancel')}</button>
          <button type="submit" className="primary" disabled={disabled || !editingTagValue.trim() || editingTagValue.trim() === editingTag}>{t('save')}</button></div>
      </form>
    </Modal>}
    {!tagManager && mergingTag && <Modal title="合并标签" className="tag-quick-action-dialog" close={() => setMergingTag(null)}>
      <div className="tag-quick-action-form">
        <div className="tag-quick-source"><span className={`tag-color-dot tag-color-${tagColorIndex(mergingTag, book.tagColors)}`} aria-hidden="true" /><span>{mergingTag}</span></div>
        <label>{t('合并至')}<select autoFocus aria-label={t('合并至')} value={mergingTarget} onChange={(event) => setMergingTarget(event.target.value)}>
          {book.tags.filter((tag) => tag !== mergingTag).map((tag) => <option key={tag} value={tag}>{tag}</option>)}</select></label>
        <div className="dialog-actions"><button type="button" onClick={() => setMergingTag(null)}>{t('cancel')}</button>
          <button type="button" className="primary" disabled={disabled || !mergingTarget} onClick={handleConfirmMergeTag}>{t('确认合并')}</button></div>
      </div>
    </Modal>}
    {!tagManager && deletingTag && <Modal title="删除标签" className="tag-quick-action-dialog" close={() => setDeletingTag(null)}>
      <div className="tag-delete-confirmation"><Trash2 size={20} aria-hidden="true" /><div><strong>{t('删除标签“{0}”？', deletingTag)}</strong><p>{t('标签会从所有笔记中移除，笔记本身不会被删除。')}</p></div></div>
      <div className="dialog-actions"><button type="button" onClick={() => setDeletingTag(null)}>{t('cancel')}</button>
        <button type="button" className="danger" disabled={disabled} onClick={handleConfirmDeleteTag}>{t('确认删除')}</button></div>
    </Modal>}
    {tagManager && <Modal title="管理标签" className="tag-manager-dialog" close={() => {
      setTagManager(false);
      setEditingTag(null);
      setMergingTag(null);
      setDeletingTag(null);
    }}>
      <div className="tag-manager-content">
        <form className="tag-manager-add" onSubmit={(e) => {
          e.preventDefault();
          const val = newTagInput.trim();
          if (!val) return;
          if (val.length > 40 || val.includes(',') || val.includes('，')) {
            book.setError(t('标签必须为 1-40 个字符，且不能包含逗号。'));
            return;
          }
          if (book.tags.includes(val)) {
            book.setError(t('该标签已存在。'));
            return;
          }
          book.addTag(val);
          setNewTagInput('');
          showNotice(t('已新增标签 #{0}', val));
        }}>
          <input
            placeholder={t('输入新标签名称…')}
            maxLength={40}
            value={newTagInput}
            onChange={(e) => setNewTagInput(e.target.value)}
          />
          <button type="submit" className="primary" disabled={disabled || !newTagInput.trim()}>
            <Plus size={15} />{t('add')}
          </button>
        </form>

        <div className="tag-manager-list" role="list">
          {book.tags.length === 0 ? (
            <div className="tag-manager-empty">{t('暂无标签，在上方输入名称创建新标签')}</div>
          ) : (
            book.tags.map((tag) => {
              if (editingTag === tag) {
                return (
                  <div key={tag} className="tag-manager-row editing" role="listitem">
                    <label className="tag-manager-edit-field">
                      <span className={`tag-color-dot tag-color-${tagColorIndex(tag, book.tagColors)}`} aria-hidden="true" />
                      <input
                        autoFocus
                        aria-label={t('重命名')}
                        maxLength={40}
                        value={editingTagValue}
                        onChange={(e) => setEditingTagValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void handleSaveEditTag();
                          if (e.key === 'Escape') setEditingTag(null);
                        }}
                      />
                    </label>
                    <div className="tag-manager-row-actions">
                      <button className="primary" disabled={disabled || !editingTagValue.trim()} onClick={() => void handleSaveEditTag()}>{t('save')}</button>
                      <button onClick={() => setEditingTag(null)}>{t('cancel')}</button>
                    </div>
                  </div>
                );
              }
              if (mergingTag === tag) {
                const targetOptions = book.tags.filter((t) => t !== tag);
                return (
                  <div key={tag} className="tag-manager-row merging" role="listitem">
                    <span className="tag-manager-label">{t('将 #{0} 合并到：', tag)}</span>
                    <select value={mergingTarget} onChange={(e) => setMergingTarget(e.target.value)}>
                      {targetOptions.map((t) => <option key={t} value={t}>#{t}</option>)}
                    </select>
                    <div className="tag-manager-row-actions">
                      <button className="primary" disabled={disabled || !mergingTarget} onClick={() => void handleConfirmMergeTag()}>{t('确认合并')}</button>
                      <button onClick={() => setMergingTag(null)}>{t('cancel')}</button>
                    </div>
                  </div>
                );
              }
              if (deletingTag === tag) {
                return (
                  <div key={tag} className="tag-manager-row deleting" role="listitem">
                    <span className="tag-manager-label danger-text">{t('从所有笔记中删除 #{0}？', tag)}</span>
                    <div className="tag-manager-row-actions">
                      <button className="danger" disabled={disabled} onClick={() => void handleConfirmDeleteTag()}>{t('确认删除')}</button>
                      <button onClick={() => setDeletingTag(null)}>{t('cancel')}</button>
                    </div>
                  </div>
                );
              }
              return (
                <div key={tag} className="tag-manager-row" role="listitem">
                  <span className="tag-manager-badge"><span className={`tag-color-dot tag-color-${tagColorIndex(tag, book.tagColors)}`} aria-hidden="true" /><span>{tag}</span><small>{book.tagCounts[tag] || ''}</small></span>
                  <div className="tag-manager-row-actions">
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => {
                        setEditingTag(tag);
                        setEditingTagValue(tag);
                        setMergingTag(null);
                        setDeletingTag(null);
                      }}
                    >
                      <Pencil size={13} />{t('edit')}
                    </button>
                    <button
                      type="button"
                      disabled={disabled || book.tags.length <= 1}
                      onClick={() => {
                        const targets = book.tags.filter((t) => t !== tag);
                        setMergingTag(tag);
                        setMergingTarget(targets[0] || '');
                        setEditingTag(null);
                        setDeletingTag(null);
                      }}
                    >
                      <GitMerge size={13} />{t('merge')}
                    </button>
                    <button
                      type="button"
                      className="danger-btn"
                      disabled={disabled}
                      onClick={() => {
                        setDeletingTag(tag);
                        setEditingTag(null);
                        setMergingTag(null);
                      }}
                    >
                      <Trash2 size={13} />{t('delete')}
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
      <div className="dialog-actions">
        <button onClick={() => {
          setTagManager(false);
          setEditingTag(null);
          setMergingTag(null);
          setDeletingTag(null);
        }}>{t('done')}</button>
      </div>
    </Modal>}
    {bulkTagOpen && <Modal title="批量添加标签" close={() => setBulkTagOpen(false)}>
      <label className="single-field">{t('tags')}<input autoFocus maxLength={40} value={bulkTag} onChange={(event) => setBulkTag(event.target.value)} /></label>
      <div className="dialog-actions"><button onClick={() => setBulkTagOpen(false)}>{t('cancel')}</button><button className="primary" disabled={!bulkTag.trim() || disabled} onClick={applyBulkTag}>{t('add')}</button></div>
    </Modal>}
    {book.conflict && <Modal title="检测到版本冲突" className="conflict-dialog" close={() => book.setConflict(null)}>
      <div className="conflict-summary">
        <strong>{book.conflict.local.title || t('untitled_note')}</strong>
        <span>{book.conflict.remote
          ? t('本机基于修订 {0}，云端已到修订 {1}', book.conflict.base?.revision ?? book.conflict.local.revision, book.conflict.remote.revision)
          : t('云端笔记已永久删除，本机草稿仍然安全保留。')}</span>
      </div>
      {book.conflict.remote && <div className="conflict-fields">
        {book.conflict.fields.map((field) => <section key={field}>
          <h3>{t(conflictFieldName[field])}</h3>
          <div className="conflict-versions">
            <div><span>{t('本机修改')}</span><pre>{conflictFieldValue(book.conflict!.local, field)}</pre></div>
            <div><span>{t('云端修改')}</span><pre>{conflictFieldValue(book.conflict!.remote!, field)}</pre></div>
          </div>
        </section>)}
      </div>}
      <div className="dialog-actions conflict-actions">
        <button onClick={() => book.setConflict(null)}>{t('稍后处理')}</button>
        {book.conflict.remote
          ? <>
            <button onClick={() => void run(book.conflictCopy)}>{t('另存副本')}</button>
            <button onClick={() => void run(() => book.resolveConflict('remote'))}>{t('采用云端')}</button>
            <button className="primary" onClick={() => void run(() => book.resolveConflict('local'))}>{t('采用本机')}</button>
          </>
          : <>
            <button onClick={() => void run(book.discardConflict)}>{t('放弃草稿')}</button>
            <button className="primary" onClick={() => void run(book.conflictCopy)}>{t('另存为新笔记')}</button>
          </>}
      </div>
    </Modal>}
    {versionList && versionNoteId === note?.id && <Modal title="历史版本" close={() => { setVersionList(null); setChosenVersion(null); }}>
      <div className="version-list">{versionList.map((version) => <button key={version.revision} className={chosenVersion?.revision === version.revision ? 'selected' : ''} onClick={() => setChosenVersion(version)}><span>{t('修订 {0}', version.revision)} · {version.actorType === 'ai' ? `AI：${version.actorName}` : version.actorName}</span><time>{new Date(version.savedAt).toLocaleString(dateLocale())}</time></button>)}</div>
      {chosenVersion && <><div className="version-preview"><h3>{chosenVersion.title}</h3><Preview content={chosenVersion.content} onImage={setLightbox} onFile={(id, href) => void run(() => downloadPrivateFile(id, href))} onViewDocument={(doc) => setDocViewerFile(doc)} resolveFile={book.offlineLibrary ? book.cachedFile : undefined} dark={dark} /></div><div className="dialog-actions"><button className="primary" disabled={disabled || !!note?.deletedAt} onClick={() => void restoreVersion()}>
        <RotateCcw size={15} />{t('恢复此版本')}
      </button></div></>}
    </Modal>}
    {confirmAction && <Modal title={confirmAction === 'purge-all' ? t('永久删除全部笔记？') : confirmAction === 'purge' ? t('永久删除这篇笔记？') :
      confirmAction === 'bulk-trash' ? t('将 {0} 篇笔记移入回收站？', selected.size) : t('移入回收站？')} close={() => setConfirmAction(null)}>
      <div className="confirm-title">{confirmAction === 'purge-all' ? t('将永久删除回收站中的全部笔记，此操作无法撤销。') :
        confirmAction === 'bulk-trash' ? t('选中的 {0} 篇笔记将移入回收站，可稍后恢复。', selected.size) : note?.title || t('untitled_note')}</div>
      <div className="dialog-actions"><button onClick={() => setConfirmAction(null)}>{t('cancel')}</button><button className={confirmAction === 'trash' ? 'primary' : 'danger'} onClick={() => void run(async () => {
        if (confirmAction === 'purge-all') {
          const deleted = await book.purgeTrash();
          showNotice(t('已永久删除 {0} 篇笔记', deleted));
        } else if (confirmAction === 'purge') await book.purge();
        else if (confirmAction === 'bulk-trash') await applyBulkTrash();
        else await moveCurrentToTrash();
        setConfirmAction(null);
      })}>{confirmAction === 'purge-all' ? t('全部永久删除') : confirmAction === 'purge' ? t('永久删除') :
        confirmAction === 'bulk-trash' ? t('delete') : t('move_to_trash')}</button></div>
    </Modal>}
    {pdfExport && <Modal title="导出为 PDF" className="pdf-export-dialog" close={closePdfExport}>
      <div className="pdf-export-layout">
        <PdfPagePreview pages={pdfPreviewPages} progress={pdfProgress} error={pdfPreviewError} />
        <div className="pdf-export-sidebar">
          <div className="pdf-export-form">
            <label className="single-field"><span>{t('文件名')}</span><span className="pdf-name-input">
              <input aria-label={t('PDF 文件名')} maxLength={120} value={pdfName}
                onChange={(event) => setPdfName(event.target.value)} /><span>.pdf</span>
            </span></label>
            <div className="pdf-export-options">
              <label><span>{t('纸张')}</span><select aria-label={t('PDF 纸张')} value={pdfOptions.pageSize} disabled={printing}
                onChange={(event) => setPdfOptions((value) => ({ ...value, pageSize: event.target.value as PdfExportOptions['pageSize'] }))}>
                <option value="A4">A4</option>
                <option value="LETTER">Letter</option>
              </select></label>
              <label><span>{t('缩放')}</span><select aria-label={t('PDF 缩放')} value={pdfOptions.scale} disabled={printing}
                onChange={(event) => setPdfOptions((value) => ({ ...value, scale: Number(event.target.value) }))}>
                <option value="85">85%</option>
                <option value="100">100%</option>
                <option value="115">115%</option>
              </select></label>
            </div>
            <fieldset className="pdf-orientation" disabled={printing}>
              <legend>{t('方向')}</legend>
              <div className="segmented" aria-label={t('PDF 方向')}>
                <button type="button" aria-pressed={pdfOptions.orientation === 'portrait'}
                  onClick={() => setPdfOptions((value) => ({ ...value, orientation: 'portrait' }))}>{t('纵向')}</button>
                <button type="button" aria-pressed={pdfOptions.orientation === 'landscape'}
                  onClick={() => setPdfOptions((value) => ({ ...value, orientation: 'landscape' }))}>{t('横向')}</button>
              </div>
            </fieldset>
          </div>
          <div className="dialog-actions">
            <button disabled={printing} onClick={closePdfExport}>{t('cancel')}</button>
            <button className="primary" disabled={printing || !pdfPreviewFile || !pdfName.trim()}
              onClick={() => void confirmPdfExport()}>
              {printing ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}
              {t('导出 PDF')}
            </button>
          </div>
        </div>
      </div>
    </Modal>}
    {lightbox && <Modal title="图片" close={() => setLightbox('')}><img className="lightbox-image" src={lightbox} alt={t('笔记图片')} /></Modal>}
    {uploadProgress && (
      <div className="upload-modal-backdrop" role="dialog" aria-modal="true" aria-label={t('上传进度')}>
        <div className="upload-progress-card">
          <div className="upload-progress-header">
            <div className="upload-progress-icon-wrap">
              <Upload size={22} className="upload-pulse-icon" />
            </div>
            <div>
              <h3 className="upload-progress-title">{t('上传文件中')}</h3>
              <p className="upload-progress-subtitle">
                {t('正在处理第 {0} / {1} 个文件', uploadProgress.current, uploadProgress.total)}
              </p>
            </div>
          </div>
          <div className="upload-progress-file-pill" title={uploadProgress.filename}>
            <FileText size={15} />
            <span className="upload-progress-filename">{uploadProgress.filename}</span>
          </div>
          <div className="upload-progress-track" role="progressbar" aria-valuenow={uploadProgress.percent} aria-valuemin={0} aria-valuemax={100}>
            <div className="upload-progress-bar-fill" style={{ width: `${uploadProgress.percent}%` }} />
          </div>
          <div className="upload-progress-footer">
            <span className="upload-progress-status">{uploadProgress.statusText}</span>
            <span className="upload-progress-pct">{uploadProgress.percent}%</span>
          </div>
        </div>
      </div>
    )}
    {docViewerFile && (
      <DocumentViewer
        file={docViewerFile}
        userId={session.user?.id || ''}
        onClose={() => setDocViewerFile(null)}
        onInsertToNote={handleInsertFromDocViewer}
        onCreateNoteFromContent={handleCreateNoteFromDocViewer}
        onUploadNewDocument={handleUploadDocFromViewer}
        resolveFile={book.offlineLibrary ? book.cachedFile : undefined}
      />
    )}
    {printNote && <section className={`print-document ${pdfExport ? 'pdf-rendering' : ''}`} data-printing={pdfExport ? 'true' : 'false'} aria-hidden="true">
      <Preview content={printNote.content} onImage={() => undefined}
        resolveFile={book.offlineLibrary ? book.cachedFile : undefined} dark={false} eagerImages />
    </section>}
    </div>
  </DialogFeedbackContext.Provider>;
}
