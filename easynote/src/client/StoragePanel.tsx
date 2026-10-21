import { useEffect, useState } from 'react';
import { AlertTriangle, Bell, BellOff, Check, Database, FileText, HardDrive, History, LoaderCircle, Paperclip, RotateCw, Trash2 } from 'lucide-react';
import type { StorageAlertConfig, StorageStats } from '../shared/types';
import { api } from './api';
import { t } from './i18n';

export const STORAGE_ALERT_KEY_PREFIX = 'easynote-storage-alert:';
export const DEFAULT_STORAGE_ALERT_THRESHOLD = 80;

export function getStorageAlertConfig(userId: string): StorageAlertConfig {
  try {
    const raw = localStorage.getItem(`${STORAGE_ALERT_KEY_PREFIX}${userId}`);
    if (raw) {
      const parsed = JSON.parse(raw);
      const threshold = typeof parsed.thresholdPercent === 'number' && parsed.thresholdPercent >= 10 && parsed.thresholdPercent <= 99
        ? parsed.thresholdPercent
        : DEFAULT_STORAGE_ALERT_THRESHOLD;
      return {
        enabled: parsed.enabled !== false,
        thresholdPercent: threshold,
      };
    }
  } catch { /* ignore */ }
  return { enabled: true, thresholdPercent: DEFAULT_STORAGE_ALERT_THRESHOLD };
}

export function saveStorageAlertConfig(userId: string, config: StorageAlertConfig): void {
  try {
    localStorage.setItem(`${STORAGE_ALERT_KEY_PREFIX}${userId}`, JSON.stringify(config));
  } catch { /* ignore */ }
}

export function formatStorageBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

interface Props {
  userId: string;
  disabled: boolean;
  isAdmin: boolean;
  notify(message: string): void;
  reportError(error: string): void;
}

export function StoragePanel({ userId, disabled, isAdmin, notify, reportError }: Props) {
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [alertConfig, setAlertConfig] = useState<StorageAlertConfig>(() => getStorageAlertConfig(userId));
  const [customThreshold, setCustomThreshold] = useState(() => ![70, 80, 90, 95].includes(alertConfig.thresholdPercent));

  const fetchStats = async () => {
    setLoading(true);
    try {
      const data = await api.storage();
      setStats(data);
    } catch (error) {
      reportError(String(error));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchStats();
  }, []);

  const updateAlertConfig = (updater: (prev: StorageAlertConfig) => StorageAlertConfig) => {
    setAlertConfig((prev) => {
      const next = updater(prev);
      saveStorageAlertConfig(userId, next);
      return next;
    });
  };

  const isOverAlert = !!stats && alertConfig.enabled && stats.usedPercent >= alertConfig.thresholdPercent;
  const isNearFull = !!stats && stats.usedPercent >= 95;
  const barStatusClass = isNearFull ? 'danger' : isOverAlert ? 'warning' : 'normal';

  const percentText = stats
    ? stats.usedPercent > 0
      ? `${stats.usedPercent}%`
      : stats.usedBytes > 0
        ? '< 0.1%'
        : '0%'
    : '0%';

  return <div className="storage-panel">
    <section className="storage-overview">
      <header className="storage-panel-header">
        <div className="storage-panel-title">
          <HardDrive size={18} />
          <strong>{t('Cloudflare 存储空间')}</strong>
        </div>
        <button className="storage-refresh-btn" disabled={disabled || loading} onClick={() => void fetchStats()} aria-label={t('刷新')}>
          {loading ? <LoaderCircle size={15} className="spin" /> : <RotateCw size={15} />}
          <span>{t('刷新')}</span>
        </button>
      </header>

      {loading && !stats ? (
        <div className="panel-empty">{t('正在获取存储信息…')}</div>
      ) : stats ? (
        <>
          <div className="storage-progress-container">
            <div className="storage-progress-header">
              <span>{t('已用比例')}</span>
              <strong className={`storage-percent ${barStatusClass}`}>{percentText}</strong>
            </div>
            <div className="storage-progress-track" role="progressbar" aria-valuenow={stats.usedPercent} aria-valuemin={0} aria-valuemax={100}>
              <div
                className={`storage-progress-fill ${barStatusClass}`}
                style={{ width: `${Math.min(100, Math.max(stats.usedBytes > 0 ? 1 : 0, stats.usedPercent))}%` }}
              />
            </div>
          </div>

          <div className="storage-metric-grid">
            <div className="storage-metric-item">
              <span className="storage-metric-label">{t('总计已用空间')}</span>
              <strong className="storage-metric-value">{formatStorageBytes(stats.usedBytes)}</strong>
            </div>
            <div className="storage-metric-item">
              <span className="storage-metric-label">{t('剩余空间')}</span>
              <strong className="storage-metric-value">{formatStorageBytes(stats.remainingBytes)}</strong>
            </div>
            <div className="storage-metric-item">
              <span className="storage-metric-label">{t('用户配额')}</span>
              <strong className="storage-metric-value">{formatStorageBytes(stats.quotaBytes)}</strong>
            </div>
            <div className="storage-metric-item">
              <span className="storage-metric-label">{t('文件数量')}</span>
              <strong className="storage-metric-value">{t('{0} 个文件', stats.fileCount)}</strong>
            </div>
          </div>

          <div className="storage-breakdown">
            <header className="storage-breakdown-header">
              <span>{t('存储空间明细')}</span>
            </header>
            <div className="storage-breakdown-list">
              <div className="storage-breakdown-row">
                <div className="storage-breakdown-info">
                  <FileText size={15} />
                  <span>{t('笔记正文 (D1)')}</span>
                </div>
                <div className="storage-breakdown-meta">
                  <span>{t('{0} 篇活跃笔记', stats.noteCount)}</span>
                  <strong>{formatStorageBytes(stats.notesBytes)}</strong>
                </div>
              </div>

              <div className="storage-breakdown-row">
                <div className="storage-breakdown-info">
                  <History size={15} />
                  <span>{t('历史版本 (D1)')}</span>
                </div>
                <div className="storage-breakdown-meta">
                  <span>{t('{0} 个修订版本', stats.versionCount)}</span>
                  <strong>{formatStorageBytes(stats.versionsBytes)}</strong>
                </div>
              </div>

              {stats.trashCount > 0 && (
                <div className="storage-breakdown-row">
                  <div className="storage-breakdown-info">
                    <Trash2 size={15} />
                    <span>{t('回收站 (D1)')}</span>
                  </div>
                  <div className="storage-breakdown-meta">
                    <span>{t('{0} 篇废弃笔记', stats.trashCount)}</span>
                    <strong>{formatStorageBytes(stats.trashBytes)}</strong>
                  </div>
                </div>
              )}

              <div className="storage-breakdown-row">
                <div className="storage-breakdown-info">
                  <Paperclip size={15} />
                  <span>{t('图片与附件 (R2)')}</span>
                </div>
                <div className="storage-breakdown-meta">
                  <span>{t('{0} 个媒体文件', stats.fileCount)}</span>
                  <strong>{formatStorageBytes(stats.filesBytes)}</strong>
                </div>
              </div>

              {isAdmin && stats.d1DatabaseBytes !== null && stats.d1DatabaseBytes !== undefined && (
                <div className="storage-breakdown-row admin-row">
                  <div className="storage-breakdown-info">
                    <Database size={15} />
                    <span>{t('D1 数据库占用')}</span>
                  </div>
                  <div className="storage-breakdown-meta">
                    <strong>{formatStorageBytes(stats.d1DatabaseBytes)}</strong>
                  </div>
                </div>
              )}
            </div>
          </div>

          {isOverAlert && (
            <div className="storage-alert-banner warning" role="alert">
              <AlertTriangle size={16} />
              <div>
                <strong>{t('存储容量预警')}</strong>
                <p>{t('storage_warning_notice', stats.usedPercent, alertConfig.thresholdPercent)}</p>
              </div>
            </div>
          )}
        </>
      ) : null}
    </section>

    <section className="storage-alert-config">
      <header className="storage-section-header">
        <Bell size={16} />
        <h3>{t('容量告警配置')}</h3>
      </header>

      <div className="setting-row">
        <span>{t('启用存储容量告警')}</span>
        <button
          role="switch"
          aria-checked={alertConfig.enabled}
          aria-label={t('启用存储容量告警')}
          className={`switch ${alertConfig.enabled ? 'on' : ''}`}
          disabled={disabled}
          onClick={() => updateAlertConfig((prev) => ({ ...prev, enabled: !prev.enabled }))}
        >
          {alertConfig.enabled ? <Check size={14} /> : <BellOff size={14} />}
        </button>
      </div>

      {alertConfig.enabled && (
        <>
          <div className="setting-row">
            <span>{t('告警触发阈值')}</span>
            <div className="storage-threshold-controls">
              <div className="button-group">
                {[70, 80, 90, 95].map((threshold) => (
                  <button
                    key={threshold}
                    type="button"
                    className={alertConfig.thresholdPercent === threshold && !customThreshold ? 'primary' : ''}
                    disabled={disabled}
                    onClick={() => {
                      setCustomThreshold(false);
                      updateAlertConfig((prev) => ({ ...prev, thresholdPercent: threshold }));
                    }}
                  >
                    {threshold}%
                  </button>
                ))}
                <button
                  type="button"
                  className={customThreshold || ![70, 80, 90, 95].includes(alertConfig.thresholdPercent) ? 'primary' : ''}
                  disabled={disabled}
                  onClick={() => setCustomThreshold(true)}
                >
                  {t('自定义')}
                </button>
              </div>
              {(customThreshold || ![70, 80, 90, 95].includes(alertConfig.thresholdPercent)) && (
                <div className="storage-custom-input">
                  <input
                    type="number"
                    min={10}
                    max={99}
                    value={alertConfig.thresholdPercent}
                    disabled={disabled}
                    aria-label={t('自定义阈值百分比')}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      if (Number.isFinite(val) && val >= 10 && val <= 99) {
                        updateAlertConfig((prev) => ({ ...prev, thresholdPercent: Math.round(val) }));
                      }
                    }}
                  />
                  <span>%</span>
                </div>
              )}
            </div>
          </div>

          <p className="storage-config-desc">
            {t('当附件存储使用量达到或超过该阈值时，系统将在上传或启动时产生通知提醒。')}
          </p>

          <div className="setting-row test-alert-row">
            <span>{t('测试通知效果')}</span>
            <button
              disabled={disabled || !stats}
              onClick={() => {
                const samplePercent = stats ? stats.usedPercent : 85;
                notify(t('storage_warning_notice', samplePercent, alertConfig.thresholdPercent));
              }}
            >
              <Bell size={14} />
              {t('发送测试告警')}
            </button>
          </div>
        </>
      )}
    </section>
  </div>;
}
