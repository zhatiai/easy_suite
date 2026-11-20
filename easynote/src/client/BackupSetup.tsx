import { useEffect, useRef, useState } from 'react';
import { Check, LoaderCircle, ShieldCheck } from 'lucide-react';
import { serverFingerprintMismatch, type BackupSetupStatus, type ServerTransferMode } from '../shared/serverTransfer';
import { api } from './api';
import { PasswordInput } from './PasswordInput';
import { t } from './i18n';

export function BackupSetup({ initialStatus, onComplete, onBack }: {
  initialStatus: BackupSetupStatus | null;
  onComplete(): Promise<void>;
  onBack(): void;
}) {
  const [status, setStatus] = useState(initialStatus);
  const [url, setUrl] = useState(initialStatus?.sourceUrl ?? '');
  const [token, setToken] = useState('');
  const [mode, setMode] = useState<ServerTransferMode>(initialStatus?.job?.mode ?? 'overwrite');
  const [interval, setIntervalMinutes] = useState(initialStatus?.intervalMinutes ?? 120);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const progressHeading = useRef<HTMLHeadingElement>(null);
  const running = status?.job?.state === 'running' || status?.maintenance === true;
  const job = status?.job;
  useEffect(() => {
    if (running) progressHeading.current?.focus();
  }, [running]);
  const progress = job?.progress;
  const phase = progress?.phase ?? 'connect';
  const stage = phase === 'connect' || phase === 'begin' ? 0 : phase === 'rows' ? 1 : phase === 'files' ? 2 : 3;
  const finished = job?.state === 'completed' && !status?.maintenance;
  const processed = phase === 'rows' ? progress?.recordsProcessed : progress?.filesProcessed;
  const total = phase === 'rows' ? progress?.recordsTotal : progress?.filesTotal;
  let percent: number | undefined;
  if (finished) percent = 100;
  else if ((phase === 'rows' || phase === 'files') && total != null && processed != null) {
    percent = total === 0 ? 100 : Math.min(100, Math.floor(processed / total * 100));
  } else if (!job || job.state === 'failed') percent = 0;
  const stages = ['setup_stage_connect', 'setup_stage_rows', 'setup_stage_files', 'setup_stage_finish'] as const;
  useEffect(() => {
    if (!status?.job) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const next = await api.backupSetupStatus();
        if (disposed) return;
        if (!next) { setError(t('setup_backup_expired')); return; }
        setStatus(next);
        setError('');
        if (next.job?.state === 'completed' && !next.maintenance) {
          await onComplete();
          return;
        }
      } catch (reason) { if (!disposed) setError(String(reason)); }
      if (!disposed) timer = setTimeout(() => void refresh(), 3000);
    };
    void refresh();
    return () => { disposed = true; clearTimeout(timer); };
  }, [status?.job?.id, onComplete]);
  return <form className="backup-setup-layout" onSubmit={(event) => {
    event.preventDefault();
    setBusy(true); setError('');
    void api.setupBackup({ source: { url, token }, mode, intervalMinutes: interval })
      .then((value) => { setStatus(value); setToken(''); })
      .catch((reason: unknown) => setError(String(reason)))
      .finally(() => setBusy(false));
  }}>
    <section className="backup-setup-config" aria-labelledby="backup-setup-title">
      <h2 id="backup-setup-title">{t('setup_backup')}</h2>
      <p className="backup-setup-intro">{t('setup_backup_intro')}</p>
      <fieldset disabled={busy || running} className="setup-fields">
        <label>{t('server_url')}<input type="url" autoComplete="off" placeholder="https://notes.example.com" required value={url}
          onChange={(event) => setUrl(event.target.value)} /></label>
        <label>{t('server_token')}<PasswordInput aria-label={t('server_token')} autoComplete="new-password" required maxLength={64} value={token}
          onChange={(event) => setToken(event.target.value)} /></label>
        <div className="backup-setup-options">
          <label>{t('server_pull_mode')}<select value={mode} onChange={(event) => setMode(event.target.value === 'incremental' ? 'incremental' : 'overwrite')}>
            <option value="overwrite">{t('server_mode_overwrite')}</option>
            <option value="incremental">{t('server_mode_incremental')}</option>
          </select></label>
          <label>{t('server_pull_interval')}<input type="number" required min={0} max={525600} step={1} value={interval}
            onChange={(event) => setIntervalMinutes(Number(event.target.value))} /></label>
        </div>
        <p className="settings-hint backup-setup-mode-hint">{t(mode === 'overwrite' ? 'setup_overwrite_hint' : 'setup_incremental_hint')}</p>
        <p className="settings-hint">{t('setup_interval_short')}</p>
        <button className="primary backup-setup-submit">{(busy || running) && <LoaderCircle className="spin" size={16} />}
          {busy || running ? t('setup_syncing') : t('setup_backup_start')}</button>
      </fieldset>
      {error && <p className="error" role="alert">{error}</p>}
      <details className="backup-setup-help"><summary>{t('setup_source_help')}</summary><p>{t('setup_backup_hint')}</p><p>{t('server_fingerprint_hint')}</p></details>
      <div className="login-actions"><button type="button" disabled={busy || running} onClick={onBack}>{t('setup_administrator')}</button></div>
    </section>
    <aside className="backup-setup-monitor" aria-labelledby="backup-progress-title" data-state={job?.state ?? 'idle'}>
      <h3 id="backup-progress-title" tabIndex={-1} ref={progressHeading}>{t('setup_progress_title')}</h3>
      <div className="backup-setup-status" role="status" aria-live="polite">
        <div className="backup-setup-stage"><strong>{finished ? t('server_job_completed') : job?.state === 'failed' ? t('server_job_failed') : job ? t(stages[stage]) : t('setup_waiting')}</strong>
          {percent !== undefined && <span>{percent}%</span>}</div>
        <progress aria-label={t('setup_progress_title')} max={100} value={percent} />
        <p className="settings-hint">{finished ? t('setup_signin_next') : status?.maintenance && job?.state === 'completed'
          ? t('setup_finishing') : job?.state === 'failed' ? t('setup_progress_retry')
          : job ? t('setup_progress_live') : t('setup_progress_idle')}</p>
        <dl className="backup-setup-metrics">
          <div><dt>{t('setup_records_processed')}</dt><dd>{progress?.recordsProcessed ?? job?.rows ?? 0}<span> / {progress?.recordsTotal ?? '—'}</span></dd></div>
          <div><dt>{t('setup_files_processed')}</dt><dd>{progress?.filesProcessed ?? job?.files ?? 0}<span> / {progress?.filesTotal ?? '—'}</span></dd></div>
        </dl>
        {job?.error && <p className="error" role="alert">{job.error}{job.error.endsWith(serverFingerprintMismatch) &&
          <> {t('server_fingerprint_mismatch_hint')}</>}</p>}
      </div>
      <ol className="backup-setup-stages" aria-label={t('setup_progress_title')}>
        {stages.map((label, index) => <li key={label} data-complete={finished || index < stage} aria-current={job && !finished && index === stage ? 'step' : undefined}>
          <span className="backup-stage-icon">{finished || index < stage ? <Check size={13} /> : job && index === stage && running ? <LoaderCircle className="spin" size={13} /> : <span />}</span>
          <span>{t(label)}</span>
        </li>)}
      </ol>
      <div className="backup-setup-account"><ShieldCheck size={20} /><div><h4>{t('setup_existing_account')}</h4><p>{t('setup_account_short')}</p></div></div>
    </aside>
  </form>;
}
