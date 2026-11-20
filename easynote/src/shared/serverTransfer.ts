export const serverFingerprintMismatch = 'Server code fingerprints differ.';

export interface ServerConnection {
  url: string;
  token: string;
}

export type ServerTransferMode = 'overwrite' | 'incremental';

export interface BackupSetupInput {
  source: ServerConnection;
  mode: ServerTransferMode;
  intervalMinutes: number;
}

export type BackupSetupStatus = Pick<ServerTransferStatus, 'fingerprint' | 'maintenance' | 'job'> & {
  sourceUrl: string;
  intervalMinutes: number;
};

export interface ServerTransferSettings {
  backup: ServerConnection;
  sync: ServerConnection;
  intervalMinutes: number;
  receivingEnabled: boolean;
  backupMode?: ServerTransferMode;
  syncMode?: ServerTransferMode;
  syncIntervalMinutes?: number;
}

export interface ServerTransferJob {
  id: string;
  direction: 'push' | 'pull';
  mode?: ServerTransferMode;
  state: 'running' | 'completed' | 'failed';
  startedAt: number;
  finishedAt?: number;
  rows: number;
  files: number;
  error?: string;
  progress?: {
    phase: 'connect' | 'begin' | 'rows' | 'files' | 'commit' | 'finish';
    recordsProcessed: number;
    recordsTotal: number | null;
    filesProcessed: number;
    filesTotal: number | null;
  };
}

export interface ServerTransferStatus {
  fingerprint: string;
  instanceId: string;
  settings: ServerTransferSettings;
  hasBackupToken: boolean;
  hasSyncToken: boolean;
  hasReceivingToken: boolean;
  nextBackupAt: number | null;
  nextSyncAt?: number | null;
  maintenance: boolean;
  job: ServerTransferJob | null;
  jobs: ServerTransferJob[];
}
