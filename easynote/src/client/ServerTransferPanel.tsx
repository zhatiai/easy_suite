import { useEffect, useState } from 'react';
import { serverFingerprintMismatch, type ServerTransferSettings, type ServerTransferStatus } from '../shared/serverTransfer';
import { api } from './api';
import { dateLocale, t } from './i18n';

export function ServerTransferPanel({ disabled, offline }: { disabled: boolean; offline: boolean }) {
  const [status, setStatus] = useState<ServerTransferStatus | null>(null);
  const [settings, setSettings] = useState<ServerTransferSettings | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [secret, setSecret] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (offline) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const value = await api.serverTransferStatus();
        if (!disposed) { setStatus(value); setSettings((current) => current ?? value.settings); }
      } catch (error) { if (!disposed) setError(String(error)); }
      finally { if (!disposed) timer = setTimeout(() => void refresh(), 3000); }
    };
    void refresh();
    return () => { disposed = true; clearTimeout(timer); };
  }, [offline]);

  const action = async (operation: () => Promise<void>) => {
    setWorking(true); setError(''); setMessage('');
    try { await operation(); }
    catch (error) { setError(String(error)); }
    finally { setWorking(false); }
  };
  if (!settings || !status) return <p role="status">{error || t('loading')}</p>;
  const locked = disabled || offline || working || status.maintenance || status.job?.state === 'running';
  const jobs = status.jobs ?? (status.job ? [status.job] : []);
  const mode = (kind: 'backup' | 'sync') => <label>{t(kind === 'backup' ? 'server_push_mode' : 'server_pull_mode')}
    <select value={(kind === 'backup' ? settings.backupMode : settings.syncMode) ?? 'overwrite'} disabled={locked}
      onChange={(event) => setSettings({ ...settings, [kind === 'backup' ? 'backupMode' : 'syncMode']: event.target.value })}>
      <option value="overwrite">{t('server_mode_overwrite')}</option>
      <option value="incremental">{t('server_mode_incremental')}</option>
    </select>
  </label>;
  const connection = (kind: 'backup' | 'sync') => <>
    <label>{t('server_url')}<input type="url" autoComplete="off" placeholder="https://notes.example.com" value={settings[kind].url} disabled={locked}
      onChange={(event) => setSettings({ ...settings, [kind]: { ...settings[kind], url: event.target.value } })} /></label>
    <label>{t('server_token')}<input type="password" autoComplete="new-password" maxLength={64} value={settings[kind].token} disabled={locked}
      placeholder={(kind === 'backup' ? status.hasBackupToken : status.hasSyncToken) ? t('server_token_saved') : ''}
      onChange={(event) => setSettings({ ...settings, [kind]: { ...settings[kind], token: event.target.value } })} /></label>
  </>;
  return <div className="account-security server-transfer-panel">
    {error && <p className="error" role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    <section>
      <h3>{t('server_fingerprint')}</h3>
      <code className="server-fingerprint">{status.fingerprint}</code>
      <p className="settings-hint">{t('server_fingerprint_hint')}</p>
    </section>
    <section>
      <h3>{t('server_receiving')}</h3>
      <p className="settings-hint">{t('server_receiving_hint')}</p>
      <label><span><input type="checkbox" checked={settings.receivingEnabled} disabled={locked || !status.hasReceivingToken}
        onChange={(event) => setSettings({ ...settings, receivingEnabled: event.target.checked })} /> {t('server_receiving_enabled')}</span></label>
      <button disabled={locked} onClick={() => void action(async () => {
        const value = await api.createServerTransferKey();
        setSecret(value.token);
        const next = await api.serverTransferStatus();
        setStatus(next); setSettings({ ...settings, receivingEnabled: true });
      })}>{t('server_generate_token')}</button>
      {secret && <div className="token-secret" role="status"><strong>{t('server_token_once')}</strong><code>{secret}</code>
        <button onClick={() => void action(async () => { await navigator.clipboard.writeText(secret); setMessage(t('copied')); })}>{t('copy')}</button></div>}
    </section>
    <section><h3>{t('server_backup')}</h3><p className="settings-hint">{t('server_push_hint')}</p>{connection('backup')}{mode('backup')}
      <label>{t('server_interval')}<input type="number" min={0} max={525600} step={1} value={settings.intervalMinutes} disabled={locked}
        onChange={(event) => setSettings({ ...settings, intervalMinutes: Number(event.target.value) })} /></label>
      <p className="settings-hint">{t('server_interval_hint')}</p>
    </section>
    <section><h3>{t('server_sync')}</h3>{connection('sync')}{mode('sync')}
      <label>{t('server_pull_interval')}<input type="number" min={0} max={525600} step={1} value={settings.syncIntervalMinutes ?? 0} disabled={locked}
        onChange={(event) => setSettings({ ...settings, syncIntervalMinutes: Number(event.target.value) })} /></label>
      <p className="settings-hint">{t('server_sync_hint')}</p>
    </section>
    <section>
      <p className="settings-hint">{t('server_account_hint')}</p>
      <p className="settings-hint">{t('server_overwrite_warning')}</p>
      <p className="settings-hint">{t('server_incremental_hint')}</p>
      <label>{t('server_confirmation')}<input value={confirmation} autoComplete="off" disabled={locked}
        onChange={(event) => setConfirmation(event.target.value)} /></label>
      <div className="server-transfer-actions">
        <button className="primary" disabled={locked || (settings.intervalMinutes > 0 || (settings.syncIntervalMinutes ?? 0) > 0) && confirmation !== 'OVERWRITE'} onClick={() => void action(async () => {
          const next = await api.saveServerTransfer(settings, confirmation);
          setStatus(next); setSettings(next.settings); setMessage(t('server_saved')); setConfirmation('');
        })}>{t('server_save')}</button>
        {(['push', 'pull'] as const).map((direction) => <button key={direction} className="danger"
          disabled={locked || confirmation !== 'OVERWRITE'} onClick={() => void action(async () => {
            await api.saveServerTransfer(settings, confirmation);
            setStatus(await api.runServerTransfer(direction, confirmation));
            setConfirmation('');
          })}>{t(direction === 'push' ? 'server_push' : 'server_pull')}</button>)}
      </div>
    </section>
    {status.maintenance && <p role="status">{t('server_maintenance')}</p>}
    <section className="server-transfer-history">
      <header><h3>{t('server_jobs')}</h3><button className="danger" disabled={locked || jobs.length === 0}
        onClick={() => void action(async () => {
          setStatus(await api.clearServerTransferJobs());
          setMessage(t('server_jobs_cleared'));
        })}>{t('server_clear_jobs')}</button></header>
      <div aria-live="polite">
        {jobs.length === 0 ? <p className="settings-hint">{t('server_no_jobs')}</p> : <ol>
          {jobs.map((job) => <li key={job.id}>
            <div className="server-transfer-job-heading">
              <strong>{t(`server_job_${job.state}`)} · {t(job.direction === 'push' ? 'server_push' : 'server_pull')}</strong>
              <time dateTime={new Date(job.startedAt).toISOString()}>{new Date(job.startedAt).toLocaleString(dateLocale())}</time>
            </div>
            <p>{t(job.mode === 'incremental' ? 'server_mode_incremental' : 'server_mode_overwrite')} · {t('server_progress', job.rows, job.files)}</p>
            {job.error && <p className="error" role="alert">{job.error}{job.error.endsWith(serverFingerprintMismatch) &&
              <> {t('server_fingerprint_mismatch_hint')}</>}</p>}
          </li>)}
        </ol>}
      </div>
    </section>
    {status.nextBackupAt && <p className="settings-hint">{t('server_next_backup', new Date(status.nextBackupAt).toLocaleString(dateLocale()))}</p>}
    {status.nextSyncAt && <p className="settings-hint">{t('server_next_pull', new Date(status.nextSyncAt).toLocaleString(dateLocale()))}</p>}
  </div>;
}
