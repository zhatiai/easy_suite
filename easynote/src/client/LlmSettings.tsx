import { useState } from 'react';
import { loadLlmConfig, saveLlmConfig } from './drafts';
import { validateLlmConfig } from './api';
import { t } from './i18n';

export function LlmSettings({ userId }: { userId: string }) {
  const [config, setConfig] = useState(() => loadLlmConfig(userId));
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  return <form className="llm-settings" onSubmit={(event) => {
    event.preventDefault();
    try {
      const normalized = { baseURL: config.baseURL.trim().replace(/\/+$/, ''), model: config.model.trim(), apiKey: config.apiKey.trim() };
      validateLlmConfig(normalized);
      saveLlmConfig(userId, normalized);
      setConfig(normalized); setError(''); setSaved(true);
    } catch { setError(t('llm_save_error')); setSaved(false); }
  }}>
    <p className="llm-hint">{t('llm_storage_hint')}</p>
    <label>{t('llm_endpoint')}<input type="url" required placeholder="https://api.openai.com/v1" autoComplete="off" value={config.baseURL}
      onChange={(event) => { setSaved(false); setConfig({ ...config, baseURL: event.target.value }); }} /></label>
    <p className="llm-hint">{t('llm_endpoint_hint')}</p>
    <label>{t('llm_model')}<input required autoComplete="off" value={config.model}
      onChange={(event) => { setSaved(false); setConfig({ ...config, model: event.target.value }); }} /></label>
    <label>{t('llm_key')}<input type="password" required autoComplete="new-password" value={config.apiKey}
      onChange={(event) => { setSaved(false); setConfig({ ...config, apiKey: event.target.value }); }} /></label>
    <div className="llm-settings-actions"><button className="primary" type="submit">{t('保存')}</button>
      <button type="button" onClick={() => {
        try { saveLlmConfig(userId, null); setConfig({ baseURL: '', model: '', apiKey: '' }); setSaved(false); setError(''); }
        catch { setError(t('llm_save_error')); }
      }}>{t('llm_clear')}</button></div>
    {saved && <p role="status">{t('llm_saved')}</p>}
    {error && <p role="alert">{error}</p>}
  </form>;
}
