import { useEffect, useState } from 'react';
import { Check, Copy, Link2, LoaderCircle, RefreshCw, Trash2 } from 'lucide-react';
import type { FolderShare } from '../shared/types';
import { api } from './api';
import { dateLocale, t } from './i18n';

interface Props {
  folderId: string;
  folderName: string;
  disabled: boolean;
  notify(message: string): void;
  reportError(message: string): void;
}

export function FolderSharing({ folderId, folderName, disabled, notify, reportError }: Props) {
  const [share, setShare] = useState<FolderShare | null>(null);
  const [expiresInHours, setExpiresInHours] = useState('168');
  const [url, setUrl] = useState('');
  const [working, setWorking] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    setWorking(true);
    void api.folderShare(folderId).then((result) => {
      if (active) setShare(result.share);
    }).catch((error: unknown) => reportError(String(error)))
      .finally(() => { if (active) setWorking(false); });
    return () => { active = false; };
  }, [folderId, reportError]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch (error) {
      reportError(String(error));
    }
  };

  const create = async () => {
    setWorking(true);
    try {
      const result = await api.createFolderShare(folderId, expiresInHours === 'permanent' ? null : Number(expiresInHours));
      setCopied(false);
      setShare(result.share);
      setUrl(result.url);
      notify(t('只读分享链接已创建'));
    } catch (error) {
      reportError(String(error));
    } finally {
      setWorking(false);
    }
  };

  const revoke = async () => {
    setWorking(true);
    try {
      await api.revokeFolderShare(folderId);
      setCopied(false);
      setShare(null);
      setUrl('');
      notify(t('share_revoked'));
    } catch (error) {
      reportError(String(error));
    } finally {
      setWorking(false);
    }
  };

  return <div className="note-sharing folder-sharing">
    <div className="folder-sharing-target">
      <strong>{folderName}</strong>
    </div>
    {share && <div className="share-status">
      <Link2 size={17} />
      <div><strong>{t('share_active')}</strong><span>{share.expiresAt === null
        ? t('never_expires')
        : t('share_until', new Date(share.expiresAt).toLocaleString(dateLocale()))}</span></div>
    </div>}
    {url && <div className="share-url" role="status">
      <input readOnly aria-label={t('share_readonly_link')} value={url} onFocus={(event) => event.currentTarget.select()} />
      <button className={copied ? 'copy-confirmed' : ''} aria-live="polite" onClick={() => void copy()}>
        {copied ? <Check size={15} /> : <Copy size={15} />}{copied ? t('copied') : t('copy')}
      </button>
    </div>}
    <label className="single-field">{t('expiration')}<select value={expiresInHours} onChange={(event) => setExpiresInHours(event.target.value)}>
      <option value="1">{t('hours_1')}</option>
      <option value="24">{t('days_1')}</option>
      <option value="168">{t('days_7')}</option>
      <option value="720">{t('days_30')}</option>
      <option value="permanent">{t('permanent')}</option>
    </select></label>
    <div className="dialog-actions">
      {share && <button className="danger" disabled={disabled || working} onClick={() => void revoke()}>
        <Trash2 size={15} />{t('revoke')}
      </button>}
      <button className="primary" disabled={disabled || working} onClick={() => void create()}>
        {working ? <LoaderCircle className="spin" size={15} /> : share ? <RefreshCw size={15} /> : <Link2 size={15} />}
        {share ? t('replace_link') : t('create_link')}
      </button>
    </div>
  </div>;
}
