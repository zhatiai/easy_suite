import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowDownUp, Check, HardDrive, KeyRound, Settings, ShieldCheck, Sparkles, Users, WifiOff } from 'lucide-react';
import { t } from './i18n';

const sections = [
  { id: 'general', label: 'settings_general', description: 'settings_general_description', icon: Settings },
  { id: 'data', label: 'settings_data', description: 'settings_data_description', icon: ArrowDownUp },
  { id: 'storage', label: '存储空间与告警', description: 'settings_storage_description', icon: HardDrive },
  { id: 'security', label: '账户安全', description: 'settings_security_description', icon: ShieldCheck },
  { id: 'llm', label: 'llm_settings', description: 'llm_settings_description', icon: Sparkles },
  { id: 'ai', label: 'ai_access', description: 'settings_ai_description', icon: KeyRound },
  { id: 'users', label: '用户与注册', description: 'settings_users_description', icon: Users },
] as const;

export type SettingsSection = typeof sections[number]['id'];

function currentSection(): SettingsSection | null {
  const match = /^\/settings(?:\/([^/]+))?\/?$/.exec(location.pathname);
  if (!match) return null;
  return sections.find((section) => section.id === match[1])?.id ?? 'general';
}

export function useSettingsNavigation() {
  const [section, setSection] = useState(currentSection);
  const returnFocus = useRef<HTMLElement | null>(null);
  const restoreFocus = useRef(false);

  useEffect(() => {
    const update = () => setSection(currentSection());
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);

  useLayoutEffect(() => {
    if (section) {
      restoreFocus.current = true;
      return;
    }
    if (!restoreFocus.current) return;
    restoreFocus.current = false;
    const frame = requestAnimationFrame(() => {
      const fallback = [...document.querySelectorAll<HTMLElement>('.account, .mobile-menu-trigger')]
        .find((element) => element.getClientRects().length > 0);
      const target = returnFocus.current?.isConnected ? returnFocus.current : fallback;
      target?.focus({ preventScroll: true });
      returnFocus.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [section]);

  const open = useCallback((next: SettingsSection = 'general') => {
    if (!section) {
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      history.pushState({ ...history.state, easynoteSettings: true }, '', `/settings/${next}`);
    } else {
      history.replaceState(history.state, '', `/settings/${next}`);
    }
    setSection(next);
  }, [section]);

  const close = useCallback(() => {
    if (history.state?.easynoteSettings) {
      history.back();
    } else {
      history.replaceState(history.state, '', '/');
      setSection(null);
    }
  }, []);

  return { section, open, close };
}

interface Props {
  section: SettingsSection;
  isAdmin: boolean;
  username: string;
  offline: boolean;
  progress: string;
  feedback: ReactNode;
  content: Record<SettingsSection, ReactNode>;
  navigate(section: SettingsSection): void;
  close(): void;
}

export function SettingsPage({ section, isAdmin, username, offline, progress, feedback, content, navigate, close }: Props) {
  const available = sections.filter((item) => item.id !== 'users' || isAdmin);
  const active = available.find((item) => item.id === section) ?? sections[0];
  const canMountActive = !offline || ['general', 'data', 'security', 'llm'].includes(active.id);
  const [visited, setVisited] = useState<SettingsSection[]>(canMountActive ? [active.id] : []);
  const heading = useRef<HTMLHeadingElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const nav = useRef<HTMLElement>(null);
  const title = t(active.label);

  useEffect(() => {
    const previousTitle = document.title;
    return () => { document.title = previousTitle; };
  }, []);

  useEffect(() => { document.title = `${title} · ${t('settings')} · EasyNote`; }, [title]);

  useLayoutEffect(() => {
    heading.current?.focus({ preventScroll: true });
    scroller.current?.scrollTo(0, 0);
    const revealCategory = () => nav.current?.querySelector('[aria-current="page"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    revealCategory();
    const observer = new ResizeObserver(revealCategory);
    if (nav.current) observer.observe(nav.current);
    return () => observer.disconnect();
  }, [active.id]);

  useEffect(() => {
    if (!canMountActive) return;
    setVisited((current) => current.includes(active.id) ? current : [...current, active.id]);
  }, [active.id, canMountActive]);

  // Canonicalize direct links and keep admin-only panels out of non-admin sessions.
  useLayoutEffect(() => {
    if (location.pathname !== `/settings/${active.id}`) navigate(active.id);
  }, [active.id, navigate]);

  return <main className="settings-page" aria-label={t('settings')}>
    <header className="settings-topbar">
      <button className="settings-back" onClick={close}><ArrowLeft size={17} />{t('settings_back')}</button>
      <span className="settings-account" title={username}>{username}</span>
    </header>
    <div className="settings-layout">
      <aside className="settings-sidebar">
        <h1>{t('settings')}</h1>
        <nav ref={nav} aria-label={t('settings_navigation')}>
          {available.map(({ id, label, icon: Icon }) => <a key={id} href={`/settings/${id}`}
            aria-current={active.id === id ? 'page' : undefined}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
              event.preventDefault();
              navigate(id);
            }}><Icon size={17} /><span>{t(label)}</span></a>)}
        </nav>
      </aside>
      <div className="settings-scroll" ref={scroller}>
        <div className="settings-content">
          <header className="settings-heading">
            <h2 ref={heading} tabIndex={-1}>{title}</h2>
            <p>{t(active.description)}</p>
          </header>
          <div className="settings-feedback">{feedback}</div>
          {offline && <div className="settings-offline" role="status"><WifiOff size={16} />{t('settings_offline')}</div>}
          {progress && <div className="settings-progress" role="status"><span className="settings-progress-dot" />{progress}</div>}
          {available.filter((item) => visited.includes(item.id) || item.id === active.id && canMountActive).map(({ id, label }) =>
            <section className="settings-panel" key={id} hidden={id !== active.id} aria-label={t(label)}>
              {content[id]}
            </section>)}
          {active.id === 'general' && <p className="settings-autosave"><Check size={13} />{t('settings_autosave')}</p>}
        </div>
      </div>
    </div>
  </main>;
}
