import { CODE_FINGERPRINT } from '../shared/codeFingerprint.generated';
import { serverFingerprintMismatch, type ServerConnection, type ServerTransferJob, type ServerTransferMode, type ServerTransferSettings, type ServerTransferStatus } from '../shared/serverTransfer';
import { limitInitialSetup, requireIdentity, requireInitialSetup } from './auth';
import { ApiError, digest, json, localHttp, readJson, requestOrigin, token, type Env } from './core';
import { cleanup, objectKey, type StoredFileRow } from './images';
import { routes } from './routes';

// Parent tables precede dependants. FTS is rebuilt by the existing notes triggers.
const tables = ['users', 'oauth_clients', 'integration_tokens', 'login_attempts', 'account_attempts',
  'app_state', 'folders', 'notes', 'note_versions', 'images', 'image_refs', 'purged_notes',
  'note_shares', 'folder_shares', 'note_changes'] as const;
type Table = typeof tables[number];
type Row = Record<string, string | number | null>;
interface RowReference { keys: Row; hash: string }
type TransferRow = Row | { reference: RowReference };
const primaryKeys: Record<Table, string[]> = {
  users: ['id'], oauth_clients: ['client_id'], integration_tokens: ['id'], login_attempts: ['key'],
  account_attempts: ['key'], app_state: ['id'], folders: ['id'], notes: ['id'],
  note_versions: ['note_id', 'revision'], images: ['id'], image_refs: ['note_id', 'image_id', 'revision'],
  purged_notes: ['id'], note_shares: ['token_hash'], folder_shares: ['token_hash'], note_changes: ['sequence'],
};
function transferMode(value: unknown): ServerTransferMode {
  if (value === undefined) return 'overwrite';
  if (value !== 'overwrite' && value !== 'incremental') throw new ApiError(400, 'Invalid synchronization mode.');
  return value;
}
const rowHash = (table: Table, row: Row) => digest(JSON.stringify(Object.keys(row).sort()
  .filter((key) => table !== 'images' || key !== 'storage_key').map((key) => [key, row[key]])));
const reference = async (table: Table, row: Row): Promise<RowReference> => ({
  keys: Object.fromEntries(primaryKeys[table].map((key) => [key, row[key]])), hash: await rowHash(table, row),
});
interface Lock {
  id: string;
  mode: 'export' | 'import';
  fingerprint: string;
  expiresAt: number;
  counts: Record<Table, number>;
  received: Partial<Record<Table, number>>;
  columns: Partial<Record<Table, string[]>>;
  transferMode?: ServerTransferMode;
}
interface Job extends NonNullable<ServerTransferStatus['job']> {
  connection: ServerConnection;
  phase: 'connect' | 'begin' | 'rows' | 'files' | 'commit' | 'finish';
  table: number;
  offset: number;
  fileOffset: number;
  counts?: Record<Table, number>;
  retries?: number;
  totalFiles?: number;
}
interface StoredState {
  instanceId: string;
  settings: ServerTransferSettings;
  receivingHash?: string;
  nextBackupAt: number | null;
  nextSyncAt?: number | null;
  lock?: Lock;
  job?: Job;
  history?: ServerTransferJob[];
  garbage?: { prefix?: string; oldObjects?: boolean };
  bootstrap?: { tokenHash: string; expiresAt: number; jobId: string };
}
const emptyConnection = (): ServerConnection => ({ url: '', token: '' });
const leaseMs = 10 * 60_000;
const peerPath = '/api/server-transfer/peer/';
const adminPath = '/api/admin/server-transfer';
const stage = (table: Table) => `__transfer_${table}`;
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const ok = () => json({ ok: true });

export class ServerTransfer {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly state: DurableObjectState, private readonly env: Env) {}

  // Admission, requests and alarms share one queue. A snapshot starts after earlier writes finish.
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async load(): Promise<StoredState> {
    return await this.state.storage.get<StoredState>('config') ?? {
      instanceId: crypto.randomUUID(),
      settings: { backup: emptyConnection(), sync: emptyConnection(), intervalMinutes: 0, receivingEnabled: false },
      nextBackupAt: null,
    };
  }

  private async save(data: StoredState): Promise<void> {
    await this.state.storage.put('config', data);
    const times = [
      data.job?.state === 'running' ? Date.now() + 100 : null,
      data.lock?.expiresAt,
      data.garbage && !data.lock ? Date.now() + 1000 : null,
      ...(!data.lock && !data.garbage && data.job?.state !== 'running' ? [data.nextBackupAt, data.nextSyncAt] : []),
    ].filter((value): value is number => typeof value === 'number');
    if (times.length) await this.state.storage.setAlarm(Math.max(Date.now() + 100, Math.min(...times)));
    else await this.state.storage.deleteAlarm();
  }

  private status(data: StoredState): ServerTransferStatus {
    const job = data.job;
    const current = job ? this.jobStatus(job) : null;
    return {
      fingerprint: CODE_FINGERPRINT, instanceId: data.instanceId,
      settings: { ...data.settings, backup: { ...data.settings.backup, token: '' }, sync: { ...data.settings.sync, token: '' } },
      hasBackupToken: !!data.settings.backup.token, hasSyncToken: !!data.settings.sync.token,
      hasReceivingToken: !!data.receivingHash, nextBackupAt: data.nextBackupAt, nextSyncAt: data.nextSyncAt ?? null,
      maintenance: !!data.lock || !!data.garbage,
      job: current,
      jobs: [...(current ? [current] : []), ...(data.history ?? [])].sort((a, b) => b.startedAt - a.startedAt),
    };
  }

  private jobStatus(job: Job): ServerTransferJob {
    const counts = job.counts;
    return { id: job.id, direction: job.direction, mode: job.mode ?? 'overwrite', state: job.state, startedAt: job.startedAt,
      finishedAt: job.finishedAt, rows: job.rows, files: job.files, error: job.error,
      progress: {
        phase: job.phase,
        recordsProcessed: counts ? tables.slice(0, job.table).reduce((sum, table) => sum + counts[table], 0) + job.offset : 0,
        recordsTotal: counts ? tables.reduce((sum, table) => sum + counts[table], 0) : null,
        filesProcessed: job.fileOffset,
        filesTotal: job.totalFiles ?? null,
      },
    };
  }

  fetch(request: Request): Promise<Response> {
    return this.serial(async () => {
      try { return await this.handle(request); }
      catch (error) {
        if (error instanceof ApiError) return json({ error: { message: error.message } }, error.status);
        console.error(JSON.stringify({ event: 'server-transfer-request-failed', path: new URL(request.url).pathname }));
        return json({ error: { message: 'Server transfer request failed.' } }, 500);
      }
    });
  }

  private async handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const data = await this.load();
    if (!await this.state.storage.get('config')) await this.save(data);
    if (data.lock && data.lock.expiresAt <= Date.now()) await this.abandon(data);
    if (path === '/api/setup/backup') return this.backupSetup(request, data);
    if (path.startsWith(peerPath)) {
      if (!data.settings.receivingEnabled || !data.receivingHash ||
          await digest(request.headers.get('Authorization') ?? '') !== data.receivingHash) {
        throw new ApiError(401, 'Server transfer authentication required.');
      }
      if (request.headers.get('X-EasyNote-Fingerprint') !== CODE_FINGERPRINT) {
        throw new ApiError(409, serverFingerprintMismatch);
      }
      return this.peer(request, data, path.slice(peerPath.length));
    }
    if (path === adminPath || path.startsWith(`${adminPath}/`)) {
      const user = await requireIdentity(request, this.env);
      if (user.role !== 'admin') throw new ApiError(403, 'Administrator access required.');
      if (path === adminPath && request.method === 'GET') return json(this.status(data));
      if (data.lock || data.job?.state === 'running' || data.garbage) throw new ApiError(409, 'A server transfer is already active.');
      if (path === `${adminPath}/key` && request.method === 'POST') {
        const secret = token();
        data.receivingHash = await digest(`Bearer ${secret}`);
        data.settings.receivingEnabled = true;
        await this.save(data);
        return json({ token: secret });
      }
      if (path === adminPath && request.method === 'PUT') {
        const body = await readJson(request);
        data.settings.backup = this.connection(body.backup, data.settings.backup, request);
        data.settings.sync = this.connection(body.sync, data.settings.sync, request);
        data.settings.backupMode = transferMode(body.backupMode ?? data.settings.backupMode);
        data.settings.syncMode = transferMode(body.syncMode ?? data.settings.syncMode);
        const interval = body.intervalMinutes;
        const syncInterval = body.syncIntervalMinutes ?? data.settings.syncIntervalMinutes ?? 0;
        if (typeof interval !== 'number' || !Number.isSafeInteger(interval) || interval < 0 || interval > 525600 ||
            interval > 0 && (!data.settings.backup.url || !data.settings.backup.token)) {
          throw new ApiError(400, 'Invalid backup interval or missing backup connection.');
        }
        if (typeof syncInterval !== 'number' || !Number.isSafeInteger(syncInterval) || syncInterval < 0 || syncInterval > 525600 ||
            syncInterval > 0 && (!data.settings.sync.url || !data.settings.sync.token)) {
          throw new ApiError(400, 'Invalid pull interval or missing source connection.');
        }
        if (typeof body.receivingEnabled !== 'boolean' || body.receivingEnabled && !data.receivingHash) {
          throw new ApiError(400, 'Generate a receiving token first.');
        }
        if ((interval > 0 || syncInterval > 0) && body.confirm !== 'OVERWRITE') throw new ApiError(400, 'Explicit scheduled synchronization confirmation required.');
        data.settings.intervalMinutes = interval;
        data.settings.syncIntervalMinutes = syncInterval;
        data.settings.receivingEnabled = body.receivingEnabled;
        data.nextBackupAt = interval ? Date.now() + interval * 60_000 : null;
        data.nextSyncAt = syncInterval ? Date.now() + syncInterval * 60_000 : null;
        await this.save(data);
        return json(this.status(data));
      }
      if (path === `${adminPath}/run` && request.method === 'POST') {
        const body = await readJson(request);
        if ((body.direction !== 'push' && body.direction !== 'pull') || body.confirm !== 'OVERWRITE') {
          throw new ApiError(400, 'Explicit overwrite confirmation required.');
        }
        this.start(data, body.direction);
        await this.save(data);
        return json(this.status(data), 202);
      }
      if (path === `${adminPath}/jobs` && request.method === 'DELETE') {
        delete data.job;
        data.history = [];
        await this.save(data);
        return json(this.status(data));
      }
      throw new ApiError(404, 'Endpoint not found.');
    }
    if (path === '/__cleanup') {
      if (!data.lock) await cleanup(this.env);
      return ok();
    }
    if (data.bootstrap && data.bootstrap.jobId === data.job?.id && path === '/api/session' && request.method === 'GET') {
      return routes.fetch(request, this.env);
    }
    if (data.lock || data.bootstrap && data.job?.state === 'running') {
      return json({ error: { message: 'Server transfer maintenance in progress.' } }, 503, { 'Retry-After': '10' });
    }
    const response = await routes.fetch(request, this.env);
    // The stateless MCP handler can finish its writes while producing its response stream.
    if (path === '/mcp' && response.body) return new Response(await response.arrayBuffer(), response);
    return response;
  }

  private async backupSetup(request: Request, data: StoredState): Promise<Response> {
    const name = localHttp(request, this.env) ? 'easynote_setup_dev' : '__Host-easynote-setup';
    const status = () => {
      const { fingerprint, maintenance, job } = this.status(data);
      return { fingerprint, maintenance, job, sourceUrl: data.settings.sync.url, intervalMinutes: data.settings.syncIntervalMinutes ?? 0 };
    };
    if (request.method === 'GET') {
      const secret = request.headers.get('Cookie')?.split(';').map((part) => part.trim())
        .find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
      if (!secret || !/^[a-f0-9]{64}$/.test(secret) || !data.bootstrap || data.bootstrap.expiresAt <= Date.now() ||
          data.bootstrap.jobId !== data.job?.id || await digest(secret) !== data.bootstrap.tokenHash) return json(null);
      return json(status());
    }
    if (request.method !== 'POST') throw new ApiError(405, 'Method not allowed.');
    await requireInitialSetup(request, this.env);
    if (data.lock || data.garbage || data.job?.state === 'running') throw new ApiError(409, 'A server transfer is already active.');
    const body = await readJson(request, 4096);
    if (Object.keys(body).some((key) => !['source', 'mode', 'intervalMinutes'].includes(key)) ||
        typeof body.intervalMinutes !== 'number' || !Number.isSafeInteger(body.intervalMinutes) ||
        body.intervalMinutes < 0 || body.intervalMinutes > 525600) throw new ApiError(400, 'Invalid backup setup fields.');
    const connection = this.connection(body.source, emptyConnection(), request);
    if (!connection.url || !connection.token) throw new ApiError(400, 'Configure the server URL and token first.');
    await limitInitialSetup(request, this.env);
    data.settings.sync = connection;
    data.settings.syncMode = transferMode(body.mode);
    data.settings.syncIntervalMinutes = body.intervalMinutes;
    this.start(data, 'pull');
    const secret = token();
    data.bootstrap = { tokenHash: await digest(secret), expiresAt: Date.now() + 86400_000, jobId: data.job!.id };
    await this.save(data);
    return json(status(), 202, { 'Set-Cookie': `${name}=${secret}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${localHttp(request, this.env) ? '' : '; Secure'}` });
  }

  private connection(value: unknown, previous: ServerConnection, request: Request): ServerConnection {
    if (!value || typeof value !== 'object' || !('url' in value) || !('token' in value) ||
        typeof value.url !== 'string' || typeof value.token !== 'string') throw new ApiError(400, 'Invalid server connection.');
    if (!value.url) return emptyConnection();
    let url: URL;
    try { url = new URL(value.url); } catch { throw new ApiError(400, 'Invalid server URL.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
        url.origin === requestOrigin(request)) throw new ApiError(400, 'Use a different HTTPS server origin.');
    const secret = value.token || (url.origin === previous.url ? previous.token : '');
    if (secret && !/^[a-f0-9]{64}$/.test(secret)) throw new ApiError(400, 'Invalid server transfer token.');
    return { url: url.origin, token: secret };
  }

  private start(data: StoredState, direction: 'push' | 'pull'): void {
    const connection = direction === 'push' ? data.settings.backup : data.settings.sync;
    if (!connection.url || !connection.token) throw new ApiError(400, 'Configure the server URL and token first.');
    if (data.job) data.history = [this.jobStatus(data.job), ...(data.history ?? [])].slice(0, 49);
    data.job = { id: crypto.randomUUID(), direction, connection: { ...connection }, state: 'running',
      mode: transferMode(direction === 'push' ? data.settings.backupMode : data.settings.syncMode),
      startedAt: Date.now(), phase: 'connect', table: 0, offset: 0, fileOffset: 0, rows: 0, files: 0 };
    if (direction === 'push') data.nextBackupAt = null;
    else data.nextSyncAt = null;
  }

  private requireLock(data: StoredState, id: string, mode?: Lock['mode']): Lock {
    const lock = data.lock;
    if (!lock || lock.id !== id || lock.fingerprint !== CODE_FINGERPRINT || lock.expiresAt <= Date.now() || mode && lock.mode !== mode) {
      throw new ApiError(409, 'Transfer lease is missing, expired or incompatible.');
    }
    lock.expiresAt = Date.now() + leaseMs;
    return lock;
  }

  private async counts(): Promise<Record<Table, number>> {
    const counts = {} as Record<Table, number>;
    for (const table of tables) counts[table] = (await this.env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
    return counts;
  }

  private async columns(table: Table): Promise<string[]> {
    const rows = await this.env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
    return rows.results.map((row) => row.name);
  }

  private async begin(data: StoredState, id: string, mode: Lock['mode'], counts?: Record<Table, number>, synchronization: ServerTransferMode = 'overwrite'): Promise<Lock> {
    if (data.lock?.id === id && data.lock.mode === mode) {
      if ((data.lock.transferMode ?? 'overwrite') !== synchronization) throw new ApiError(409, 'Transfer mode changed.');
      return this.requireLock(data, id, mode);
    }
    if (data.lock || data.garbage) throw new ApiError(409, 'Server is busy.');
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new ApiError(400, 'Invalid transfer ID.');
    const schema: Partial<Record<Table, string[]>> = {};
    if (mode === 'import') {
      if (!counts || tables.some((table) => !Number.isSafeInteger(counts[table]) || counts[table] < 0)) throw new ApiError(400, 'Invalid transfer manifest.');
      for (const table of tables) {
        const columns = await this.columns(table);
        schema[table] = columns;
        await this.env.DB.batch([
          this.env.DB.prepare(`DROP TABLE IF EXISTS ${stage(table)}`),
          this.env.DB.prepare(`CREATE TABLE ${stage(table)} (__transfer_row INTEGER PRIMARY KEY, ${columns.map(quote).join(',')})`),
        ]);
      }
      await this.env.DB.batch([
        this.env.DB.prepare('CREATE TABLE IF NOT EXISTS __transfer_files (id TEXT PRIMARY KEY, storage_key TEXT NOT NULL)'),
        this.env.DB.prepare('DELETE FROM __transfer_files'),
      ]);
    }
    data.lock = { id, mode, transferMode: synchronization, fingerprint: CODE_FINGERPRINT, expiresAt: Date.now() + leaseMs,
      counts: mode === 'export' ? await this.counts() : counts!, received: {}, columns: schema };
    await this.save(data);
    return data.lock;
  }

  private async page(data: StoredState, id: string, table: Table, offset: number): Promise<Row[]> {
    this.requireLock(data, id, 'export');
    if (!tables.includes(table) || !Number.isSafeInteger(offset) || offset < 0) throw new ApiError(400, 'Invalid table page.');
    const rows = await this.env.DB.prepare(`SELECT * FROM ${table} ORDER BY rowid LIMIT ${table === 'notes' || table === 'note_versions' ? 5 : 40} OFFSET ?`).bind(offset).all<Row>();
    await this.save(data);
    const page: Row[] = [];
    let bytes = 0;
    for (const row of rows.results) {
      const size = new TextEncoder().encode(JSON.stringify(row)).length;
      if (page.length && bytes + size > 7 * 1024 ** 2) break;
      page.push(row); bytes += size;
    }
    return page;
  }

  private async matchingRow(table: Table, value: unknown): Promise<Row | null> {
    if (!value || typeof value !== 'object' || !('keys' in value) || !('hash' in value) ||
        typeof value.hash !== 'string' || !/^[a-f0-9]{64}$/.test(value.hash) ||
        !value.keys || typeof value.keys !== 'object' || Array.isArray(value.keys)) throw new ApiError(400, 'Invalid row reference.');
    const keys = value.keys as Record<string, unknown>;
    const columns = primaryKeys[table];
    if (Object.keys(keys).length !== columns.length || columns.some((key) =>
      typeof keys[key] !== 'string' && (typeof keys[key] !== 'number' || !Number.isFinite(keys[key])))) {
      throw new ApiError(400, 'Invalid row identity.');
    }
    const row = await this.env.DB.prepare(`SELECT * FROM ${table} WHERE ${columns.map((key) => `${quote(key)}=?`).join(' AND ')}`)
      .bind(...columns.map((key) => keys[key])).first<Row>();
    return row && await rowHash(table, row) === value.hash ? row : null;
  }

  private async checkRows(data: StoredState, id: string, table: Table, offset: number, entries: unknown): Promise<number[]> {
    const lock = this.requireLock(data, id, 'import');
    if (lock.transferMode !== 'incremental' || !tables.includes(table) || !Number.isSafeInteger(offset) || offset < 0 ||
        !Array.isArray(entries) || entries.length > 40 || offset + entries.length > lock.counts[table]) {
      throw new ApiError(400, 'Invalid incremental manifest.');
    }
    const changed: number[] = [];
    for (let index = 0; index < entries.length; index++) {
      if (!await this.matchingRow(table, entries[index])) changed.push(index);
    }
    await this.save(data);
    return changed;
  }

  private async stageRows(data: StoredState, id: string, table: Table, offset: number, rows: TransferRow[]): Promise<void> {
    const lock = this.requireLock(data, id, 'import');
    if (!tables.includes(table) || !Number.isSafeInteger(offset) || offset < 0 || !Array.isArray(rows) || rows.length > 40 ||
        offset !== (lock.received[table] ?? 0) && offset + rows.length !== (lock.received[table] ?? 0) || offset + rows.length > lock.counts[table]) throw new ApiError(400, 'Invalid transfer page sequence.');
    const columns = lock.columns[table];
    if (!columns) throw new ApiError(409, 'Transfer schema is missing.');
    const statements: D1PreparedStatement[] = [];
    for (const entry of rows) {
      let row: Row;
      if (entry && typeof entry === 'object' && 'reference' in entry) {
        if (lock.transferMode !== 'incremental' || Object.keys(entry).length !== 1) throw new ApiError(400, 'Unexpected row reference.');
        const existing = await this.matchingRow(table, entry.reference);
        if (!existing) throw new ApiError(409, 'Referenced row changed or is missing.');
        row = existing;
      } else row = entry as Row;
      if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).length !== columns.length ||
          columns.some((column) => !(column in row) || row[column] !== null &&
            typeof row[column] !== 'string' && (typeof row[column] !== 'number' || !Number.isFinite(row[column])))) {
        throw new ApiError(400, 'Invalid transferred row.');
      }
      statements.push(this.env.DB.prepare(`INSERT OR REPLACE INTO ${stage(table)}
        (__transfer_row,${columns.map(quote).join(',')}) VALUES(?,${columns.map(() => '?').join(',')})`)
        .bind(offset + statements.length, ...columns.map((column) => row[column])));
    }
    if (statements.length) await this.env.DB.batch(statements);
    lock.received[table] = Math.max(lock.received[table] ?? 0, offset + rows.length);
    await this.save(data);
  }

  private async fileAt(data: StoredState, id: string, offset: number): Promise<StoredFileRow | null> {
    this.requireLock(data, id, 'export');
    if (!Number.isSafeInteger(offset) || offset < 0) throw new ApiError(400, 'Invalid file offset.');
    const row = await this.env.DB.prepare("SELECT * FROM images WHERE status='ready' ORDER BY id LIMIT 1 OFFSET ?")
      .bind(offset).first<StoredFileRow>();
    await this.save(data);
    return row;
  }

  private async exportFile(data: StoredState, id: string, fileId: string): Promise<Response> {
    this.requireLock(data, id, 'export');
    const row = await this.env.DB.prepare("SELECT * FROM images WHERE id=? AND status='ready'").bind(fileId).first<StoredFileRow>();
    const object = row ? await this.env.IMAGES.get(objectKey(row)) : null;
    if (!object || !row || object.size !== row.size) throw new ApiError(409, 'Source file is missing or damaged.');
    await this.save(data);
    return new Response(object.body, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(object.size) } });
  }

  private async importFile(data: StoredState, id: string, fileId: string, request: Request | Response): Promise<void> {
    this.requireLock(data, id, 'import');
    const row = await this.env.DB.prepare(`SELECT * FROM ${stage('images')} WHERE id=? AND status='ready'`)
      .bind(fileId).first<StoredFileRow>();
    if (!row || !request.body || Number(request.headers.get('Content-Length')) !== row.size ||
        !/^[a-f0-9]{64}$/.test(row.sha256)) throw new ApiError(400, 'Invalid transferred file.');
    const key = `replication/${id}/${row.user_id}/${row.id}`;
    // R2 checks SHA-256 before publishing an object and streams bytes without buffering the file.
    try { await this.env.IMAGES.put(key, request.body, { sha256: row.sha256, httpMetadata: { contentType: row.mime } }); }
    catch (error) {
      if (error instanceof Error && error.message.includes('SHA-256 checksum you specified did not match')) {
        throw new ApiError(409, 'Transferred file checksum verification failed.');
      }
      throw new ApiError(502, 'Transferred file could not be received or stored. Check connectivity and storage.');
    }
    const head = await this.env.IMAGES.head(key);
    if (!head || head.size !== row.size) throw new ApiError(409, 'Transferred file size verification failed.');
    await this.env.DB.batch([
      this.env.DB.prepare('INSERT OR REPLACE INTO __transfer_files VALUES(?,?)').bind(row.id, key),
      this.env.DB.prepare(`UPDATE ${stage('images')} SET storage_key=? WHERE id=?`).bind(key, row.id),
    ]);
    await this.save(data);
  }

  private async needsFile(data: StoredState, id: string, fileId: string): Promise<boolean> {
    const lock = this.requireLock(data, id, 'import');
    if (lock.transferMode !== 'incremental') return true;
    const incoming = await this.env.DB.prepare(`SELECT * FROM ${stage('images')} WHERE id=? AND status='ready'`)
      .bind(fileId).first<StoredFileRow>();
    if (!incoming) throw new ApiError(400, 'Unknown incoming file.');
    const existing = await this.env.DB.prepare("SELECT * FROM images WHERE id=? AND status='ready'").bind(fileId).first<StoredFileRow>();
    if (!existing || existing.user_id !== incoming.user_id || existing.sha256 !== incoming.sha256 || existing.size !== incoming.size) return true;
    const key = objectKey(existing);
    const object = await this.env.IMAGES.head(key);
    if (!object || object.size !== incoming.size) return true;
    await this.env.DB.batch([
      this.env.DB.prepare('INSERT OR REPLACE INTO __transfer_files VALUES(?,?)').bind(fileId, key),
      this.env.DB.prepare(`UPDATE ${stage('images')} SET storage_key=? WHERE id=?`).bind(key, fileId),
    ]);
    await this.save(data);
    return false;
  }

  private async mergeTarget(lock: Lock): Promise<void> {
    const collision = await this.env.DB.prepare(`SELECT 1 FROM ${stage('users')} s JOIN users t ON s.username=t.username
      WHERE s.id<>t.id AND NOT EXISTS(SELECT 1 FROM ${stage('users')} replacing WHERE replacing.id=t.id) LIMIT 1`).first();
    if (collision) throw new ApiError(409, 'Incremental sync found the same username with different account IDs. Resolve the account conflict first.');
    for (const table of ['folders', 'notes', 'images', 'integration_tokens', 'purged_notes'] as const) {
      const foreign = await this.env.DB.prepare(`SELECT 1 FROM ${stage(table)} s JOIN ${table} t ON s.id=t.id
        WHERE s.user_id<>t.user_id LIMIT 1`).first();
      if (foreign) throw new ApiError(409, 'Incremental sync found an ID belonging to a different account.');
    }
    // Materialize the merged snapshot locally. Source primary keys win; target-only rows survive.
    const statements: D1PreparedStatement[] = [];
    for (const table of tables) {
      const columns = lock.columns[table];
      if (!columns) throw new ApiError(409, 'Transfer schema is missing.');
      if (table === 'note_changes') {
        statements.push(this.env.DB.prepare(`INSERT INTO ${stage(table)} (user_id,note_id,changed_at)
          SELECT t.user_id,t.note_id,t.changed_at FROM note_changes t WHERE NOT EXISTS
          (SELECT 1 FROM ${stage(table)} s WHERE s.user_id=t.user_id AND s.note_id=t.note_id AND s.changed_at=t.changed_at)`));
        continue;
      }
      const identity = primaryKeys[table].map((key) => `s.${quote(key)}=t.${quote(key)}`).join(' AND ');
      const association = table === 'note_shares' ? ' OR s.note_id=t.note_id' : table === 'folder_shares' ? ' OR s.folder_id=t.folder_id' : '';
      // A replicated note or folder owns its sharing state, including a revoked share.
      const sharing = table === 'note_shares'
        ? ` AND NOT EXISTS(SELECT 1 FROM ${stage('notes')} n WHERE n.id=t.note_id AND n.__transfer_row<${lock.counts.notes})`
        : table === 'folder_shares'
          ? ` AND NOT EXISTS(SELECT 1 FROM ${stage('folders')} f WHERE f.id=t.folder_id AND f.__transfer_row<${lock.counts.folders})` : '';
      statements.push(this.env.DB.prepare(`INSERT INTO ${stage(table)} (${columns.map(quote).join(',')})
        SELECT ${columns.map((key) => `t.${quote(key)}`).join(',')} FROM ${table} t
        WHERE NOT EXISTS(SELECT 1 FROM ${stage(table)} s WHERE (${identity})${association})${sharing}`));
    }
    await this.env.DB.batch(statements);
    const crossTenant = await this.env.DB.prepare(`SELECT 1 FROM ${stage('folders')} f JOIN ${stage('folders')} p ON f.parent_id=p.id WHERE f.user_id<>p.user_id
      UNION ALL SELECT 1 FROM ${stage('notes')} n JOIN ${stage('folders')} f ON n.folder_id=f.id WHERE n.user_id<>f.user_id
      UNION ALL SELECT 1 FROM ${stage('note_versions')} v JOIN ${stage('notes')} n ON v.note_id=n.id JOIN ${stage('folders')} f ON v.folder_id=f.id WHERE n.user_id<>f.user_id
      UNION ALL SELECT 1 FROM ${stage('image_refs')} r JOIN ${stage('notes')} n ON r.note_id=n.id JOIN ${stage('images')} i ON r.image_id=i.id WHERE n.user_id<>i.user_id
      UNION ALL SELECT 1 FROM ${stage('purged_notes')} p JOIN ${stage('notes')} n ON p.id=n.id WHERE p.user_id<>n.user_id LIMIT 1`).first();
    if (crossTenant) throw new ApiError(409, 'Incremental sync would create a cross-account reference.');
    const cycle = await this.env.DB.prepare(`WITH RECURSIVE ancestors(id,parent_id) AS (
      SELECT id,parent_id FROM ${stage('folders')} UNION
      SELECT a.id,f.parent_id FROM ancestors a JOIN ${stage('folders')} f ON f.id=a.parent_id)
      SELECT 1 FROM ancestors WHERE id=parent_id LIMIT 1`).first();
    if (cycle) throw new ApiError(409, 'Incremental sync would create a folder cycle.');
    // Both replicas' permanent-deletion tombstones prevent old snapshots resurrecting notes.
    await this.env.DB.batch([
      ...(['note_versions', 'image_refs', 'note_shares'] as const).map((table) => this.env.DB.prepare(
        `DELETE FROM ${stage(table)} WHERE note_id IN (SELECT id FROM ${stage('purged_notes')})`)),
      this.env.DB.prepare(`DELETE FROM ${stage('notes')} WHERE id IN (SELECT id FROM ${stage('purged_notes')})`),
      this.env.DB.prepare(`UPDATE ${stage('note_changes')} SET sequence=__transfer_row+1`),
    ]);
  }

  private async commit(data: StoredState, id: string): Promise<void> {
    // An acknowledged commit can be retried after a lost response, including a DO restart.
    const generation = await this.env.DB.prepare('SELECT generation FROM server_dataset WHERE id=1').first<{ generation: string }>();
    if (generation?.generation === id) {
      data.garbage = { oldObjects: true };
      await this.save(data);
      return;
    }
    const lock = this.requireLock(data, id, 'import');
    if (tables.some((table) => (lock.received[table] ?? 0) !== lock.counts[table])) throw new ApiError(409, 'Transfer is incomplete.');
    const missing = await this.env.DB.prepare(`SELECT COUNT(*) AS n FROM ${stage('images')} i
      LEFT JOIN __transfer_files f ON f.id=i.id WHERE i.status='ready' AND f.id IS NULL`).first<{ n: number }>();
    if (missing?.n) throw new ApiError(409, 'Missing transferred files.');
    if (lock.transferMode === 'incremental') await this.mergeTarget(lock);
    const crossTenantBoard = await this.env.DB.prepare(`SELECT 1 FROM ${stage('images')} i
      JOIN ${stage('folders')} f ON i.board_folder_id=f.id WHERE i.user_id<>f.user_id LIMIT 1`).first();
    if (crossTenantBoard) throw new ApiError(409, 'Whiteboard folder belongs to a different account.');
    const admins = await this.env.DB.prepare(`SELECT COUNT(*) AS n FROM ${stage('users')}
      WHERE role='admin' AND enabled=1 AND deletion_requested_at IS NULL`).first<{ n: number }>();
    if (!admins?.n) throw new ApiError(409, 'Missing enabled administrator.');
    const statements = [
      this.env.DB.prepare('PRAGMA defer_foreign_keys=ON'),
      this.env.DB.prepare('CREATE TABLE IF NOT EXISTS __transfer_old_objects (storage_key TEXT PRIMARY KEY)'),
      this.env.DB.prepare("INSERT OR IGNORE INTO __transfer_old_objects SELECT COALESCE(storage_key,user_id||'/'||id) FROM images"),
      this.env.DB.prepare('DELETE FROM sessions'),
      this.env.DB.prepare('DELETE FROM oauth_codes'),
      ...[...tables].reverse().map((table) => this.env.DB.prepare(`DELETE FROM ${table}`)),
    ];
    for (const table of tables) {
      const schema = lock.columns[table];
      if (!schema) throw new ApiError(409, 'Transfer schema is missing.');
      const columns = schema.map(quote).join(',');
      statements.push(this.env.DB.prepare(`INSERT INTO ${table} (${columns}) SELECT ${columns} FROM ${stage(table)} ORDER BY __transfer_row`));
    }
    statements.push(this.env.DB.prepare('UPDATE server_dataset SET generation=? WHERE id=1').bind(id));
    try { await this.env.DB.batch(statements); }
    catch (error) {
      if (lock.transferMode === 'incremental' && /constraint|UNIQUE/i.test(String(error))) {
        throw new ApiError(409, 'Incremental merge violates data constraints. Resolve conflicting folder names, blank notes, shares or tokens.');
      }
      throw error;
    }
    // Keep maintenance until finish. Cleanup is durable and only removes pre-commit objects.
    data.garbage = { oldObjects: true };
    await this.save(data);
  }

  private async finish(data: StoredState, id: string): Promise<void> {
    if (data.lock?.id === id) {
      delete data.lock;
      await this.save(data);
    }
  }

  private async abandon(data: StoredState): Promise<void> {
    const lock = data.lock;
    if (!lock) return;
    const generation = await this.env.DB.prepare('SELECT generation FROM server_dataset WHERE id=1').first<{ generation: string }>();
    if (lock.mode === 'import') data.garbage = generation?.generation === lock.id ? { oldObjects: true } : { prefix: `replication/${lock.id}/` };
    delete data.lock;
    if (data.job?.state === 'running') {
      data.job.state = 'failed'; data.job.error = 'Transfer lease expired.'; data.job.finishedAt = Date.now();
      this.reschedule(data);
    }
    await this.save(data);
  }

  private async peer(request: Request, data: StoredState, action: string): Promise<Response> {
    if (action === 'info' && request.method === 'GET') return json({ fingerprint: CODE_FINGERPRINT, instanceId: data.instanceId });
    const url = new URL(request.url);
    const id = url.searchParams.get('id') ?? '';
    if (action === 'begin' && request.method === 'POST') {
      if (data.job?.state === 'running') throw new ApiError(409, 'A local job is active.');
      const body = await readJson(request);
      if (body.mode !== 'export' && body.mode !== 'import') throw new ApiError(400, 'Invalid transfer mode.');
      return json(await this.begin(data, id, body.mode, body.counts as Record<Table, number> | undefined, transferMode(body.transferMode)));
    }
    if (action === 'manifest' && request.method === 'GET') {
      const table = url.searchParams.get('table') as Table;
      const rows = await this.page(data, id, table, Number(url.searchParams.get('offset')));
      return json({ entries: await Promise.all(rows.map((row) => reference(table, row))) });
    }
    if (action === 'rows-check' && request.method === 'POST') {
      const body = await readJson(request, 64 * 1024);
      return json({ changed: await this.checkRows(data, id, url.searchParams.get('table') as Table,
        Number(url.searchParams.get('offset')), body.entries) });
    }
    if (action === 'rows') {
      const table = url.searchParams.get('table') as Table;
      const offset = Number(url.searchParams.get('offset'));
      if (request.method === 'GET') {
        const rows = await this.page(data, id, table, offset);
        const indices = url.searchParams.get('indices');
        if (indices === null) return json({ rows });
        const requested = indices.split(',').map(Number);
        if (requested.length > 40 || requested.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= rows.length) ||
            new Set(requested).size !== requested.length) throw new ApiError(400, 'Invalid requested row indices.');
        return json({ rows: requested.map((index) => rows[index]) });
      }
      if (request.method === 'POST') {
        const body = await readJson(request, 8 * 1024 ** 2);
        await this.stageRows(data, id, table, offset, body.rows as TransferRow[]);
        return ok();
      }
    }
    if (action === 'file' && request.method === 'GET') return json({ file: await this.fileAt(data, id, Number(url.searchParams.get('offset'))) });
    if (action === 'object-check' && request.method === 'POST') return json({ needed: await this.needsFile(data, id, url.searchParams.get('file') ?? '') });
    if (action === 'object') {
      const fileId = url.searchParams.get('file') ?? '';
      if (request.method === 'GET') return this.exportFile(data, id, fileId);
      if (request.method === 'PUT') { await this.importFile(data, id, fileId, request); return ok(); }
    }
    if (action === 'commit' && request.method === 'POST') { await this.commit(data, id); return ok(); }
    if (action === 'finish' && request.method === 'POST') { await this.finish(data, id); return ok(); }
    if (action === 'abort' && request.method === 'POST') {
      if (data.lock?.id === id) await this.abandon(data);
      return ok();
    }
    throw new ApiError(404, 'Endpoint not found.');
  }

  private async remote(job: Job, action: string, method = 'GET', body?: unknown, query = '', stream?: Response): Promise<Response> {
    const headers = new Headers({ Authorization: `Bearer ${job.connection.token}`, 'X-EasyNote-Fingerprint': CODE_FINGERPRINT });
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    if (stream) {
      headers.set('Content-Type', 'application/octet-stream');
      headers.set('Content-Length', stream.headers.get('Content-Length') ?? '');
    }
    const response = await fetch(`${job.connection.url}${peerPath}${action}?id=${job.id}${query}`, {
      method, headers, body: stream?.body ?? (body === undefined ? undefined : JSON.stringify(body)),
      redirect: 'manual', signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      let detail = '';
      if ((response.status === 401 || response.status === 409) &&
          response.headers.get('Content-Type')?.startsWith('application/json') && response.body) {
        try {
          const body = await readJson(new Request(job.connection.url, { method: 'POST',
            headers: { 'Content-Type': 'application/json' }, body: response.body }), 4096);
          const message = body.error && typeof body.error === 'object' && 'message' in body.error ? body.error.message : null;
          if (typeof message === 'string' && [
            'Server transfer authentication required.',
            serverFingerprintMismatch,
            'Server is busy.',
            'Transfer lease is missing, expired or incompatible.',
            'Incremental sync found the same username with different account IDs. Resolve the account conflict first.',
            'Incremental sync found an ID belonging to a different account.',
            'Incremental sync would create a cross-account reference.',
            'Incremental sync would create a folder cycle.',
            'Incremental merge violates data constraints. Resolve conflicting folder names, blank notes, shares or tokens.',
          ].includes(message)) detail = ` ${message}`;
        } catch { /* Preserve the status-only error for unknown or malformed peer responses. */ }
      }
      if (!response.bodyUsed) await response.body?.cancel();
      throw new ApiError(response.status, `Remote server rejected ${action} (${response.status}).${detail}`);
    }
    return response;
  }

  private reschedule(data: StoredState): void {
    if (data.job?.direction === 'pull') {
      if (data.bootstrap?.jobId === data.job.id && data.job.state === 'failed') {
        data.nextSyncAt = null;
        return;
      }
      const interval = data.settings.syncIntervalMinutes ?? 0;
      data.nextSyncAt = interval ? Date.now() + interval * 60_000 : null;
    } else {
      const interval = data.settings.intervalMinutes;
      data.nextBackupAt = interval ? Date.now() + interval * 60_000 : null;
    }
  }

  alarm(): Promise<void> {
    return this.serial(async () => {
      const data = await this.load();
      if (data.lock && data.lock.expiresAt <= Date.now()) await this.abandon(data);
      if (data.garbage && !data.lock) {
        try { await this.collect(data); }
        catch {
          console.error(JSON.stringify({ event: 'server-transfer-cleanup-retry' }));
          await this.save(data);
          await this.state.storage.setAlarm(Date.now() + 30_000);
          return;
        }
      }
      if (!data.lock && !data.garbage && data.job?.state !== 'running') {
        const due = [
          { direction: 'push' as const, at: data.nextBackupAt ?? Infinity },
          { direction: 'pull' as const, at: data.nextSyncAt ?? Infinity },
        ].filter((entry) => entry.at <= Date.now()).sort((a, b) => a.at - b.at)[0];
        if (due) this.start(data, due.direction);
      }
      const job = data.job;
      if (job?.state === 'running') {
        try {
          await this.step(data, job);
          job.retries = 0;
        }
        catch (error) {
          // File writes replace the same staging key. Commit retries use the generation marker.
          const retryLimit = job.phase === 'files' ? 3 : job.phase === 'commit' || job.phase === 'finish' ? 12 : 0;
          if (!(error instanceof ApiError && error.status < 500) && (job.retries ?? 0) < retryLimit) {
            job.retries = (job.retries ?? 0) + 1;
            await this.save(data);
            await this.state.storage.setAlarm(Date.now() + 5000);
            return;
          }
          job.state = 'failed'; job.finishedAt = Date.now();
          job.error = error instanceof ApiError ? error.message : 'Server transfer failed. Check connectivity and storage.';
          try { await this.remote(job, 'abort', 'POST'); } catch { /* The peer's durable lease releases maintenance. */ }
          await this.abandon(data);
          job.connection = emptyConnection();
          this.reschedule(data);
        }
      }
      await this.save(data);
    });
  }

  private async incrementalRows(data: StoredState, job: Job, table: Table, query: string): Promise<TransferRow[]> {
    if (job.direction === 'push') {
      const rows = await this.page(data, job.id, table, job.offset);
      const entries = await Promise.all(rows.map((row) => reference(table, row)));
      const { changed } = await (await this.remote(job, 'rows-check', 'POST', { entries }, query)).json<{ changed: number[] }>();
      if (!Array.isArray(changed) || changed.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= rows.length)) {
        throw new ApiError(409, 'Invalid incremental response.');
      }
      return rows.map((row, index) => changed.includes(index) ? row : { reference: entries[index] });
    }
    const { entries } = await (await this.remote(job, 'manifest', 'GET', undefined, query)).json<{ entries: RowReference[] }>();
    const changed = await this.checkRows(data, job.id, table, job.offset, entries);
    const rows = changed.length
      ? (await (await this.remote(job, 'rows', 'GET', undefined, `${query}&indices=${changed.join(',')}`)).json<{ rows: Row[] }>()).rows
      : [];
    if (rows.length !== changed.length) throw new ApiError(409, 'Incomplete incremental response.');
    const frame: TransferRow[] = entries.map((entry) => ({ reference: entry }));
    changed.forEach((index, position) => { frame[index] = rows[position]; });
    return frame;
  }

  private async step(data: StoredState, job: Job): Promise<void> {
    const push = job.direction === 'push';
    const mode = job.mode ?? 'overwrite';
    if (data.lock) this.requireLock(data, job.id);
    if (job.phase === 'connect') {
      const info = await (await this.remote(job, 'info')).json<{ fingerprint: string; instanceId: string }>();
      if (info.fingerprint !== CODE_FINGERPRINT) throw new ApiError(409, serverFingerprintMismatch);
      if (info.instanceId === data.instanceId) throw new ApiError(409, 'The source and target are the same EasyNote server.');
      if (push) job.counts = (await this.begin(data, job.id, 'export', undefined, mode)).counts;
      else job.counts = (await (await this.remote(job, 'begin', 'POST', { mode: 'export', transferMode: mode })).json<Lock>()).counts;
      job.phase = 'begin';
    } else if (job.phase === 'begin') {
      if (push) await this.remote(job, 'begin', 'POST', { mode: 'import', counts: job.counts, transferMode: mode });
      else await this.begin(data, job.id, 'import', job.counts, mode);
      job.phase = 'rows';
    } else if (job.phase === 'rows') {
      const table = tables[job.table];
      const query = `&table=${table}&offset=${job.offset}`;
      const rows = mode === 'incremental' ? await this.incrementalRows(data, job, table, query) : push ? await this.page(data, job.id, table, job.offset) :
        (await (await this.remote(job, 'rows', 'GET', undefined, query)).json<{ rows: Row[] }>()).rows;
      if (push) await this.remote(job, 'rows', 'POST', { rows }, query);
      else await this.stageRows(data, job.id, table, job.offset, rows);
      job.offset += rows.length;
      job.rows += rows.filter((row) => !('reference' in row)).length;
      if (job.offset === job.counts![table]) {
        job.table++; job.offset = 0;
        if (job.table === tables.length) {
          job.totalFiles = (await this.env.DB.prepare(`SELECT COUNT(*) AS n FROM ${push ? 'images' : stage('images')} WHERE status='ready'`)
            .first<{ n: number }>())!.n;
          job.phase = 'files';
        }
      } else if (!rows.length) throw new ApiError(409, 'Source table changed during transfer.');
    } else if (job.phase === 'files') {
      const row = push ? await this.fileAt(data, job.id, job.fileOffset) :
        (await (await this.remote(job, 'file', 'GET', undefined, `&offset=${job.fileOffset}`)).json<{ file: StoredFileRow | null }>()).file;
      if (!row) job.phase = 'commit';
      else {
        const query = `&file=${encodeURIComponent(row.id)}`;
        const needed = mode !== 'incremental' || (push
          ? (await (await this.remote(job, 'object-check', 'POST', undefined, query)).json<{ needed: boolean }>()).needed
          : await this.needsFile(data, job.id, row.id));
        if (needed) {
          if (push) await this.remote(job, 'object', 'PUT', undefined, query, await this.exportFile(data, job.id, row.id));
          else await this.importFile(data, job.id, row.id, await this.remote(job, 'object', 'GET', undefined, query));
          job.files++;
        }
        job.fileOffset++;
      }
    } else if (job.phase === 'commit') {
      if (push) await this.remote(job, 'commit', 'POST');
      else await this.commit(data, job.id);
      job.phase = 'finish';
    } else {
      await this.remote(job, 'finish', 'POST');
      await this.finish(data, job.id);
      job.state = 'completed'; job.finishedAt = Date.now();
      // Credentials are no longer needed in the job record.
      job.connection = emptyConnection();
      this.reschedule(data);
    }
  }

  private async collect(data: StoredState): Promise<void> {
    const garbage = data.garbage!;
    if (garbage.prefix) {
      const list = await this.env.IMAGES.list({ prefix: garbage.prefix, limit: 100 });
      if (list.objects.length) { await this.env.IMAGES.delete(list.objects.map((object) => object.key)); return; }
    }
    if (garbage.oldObjects) {
      const rows = await this.env.DB.prepare('SELECT storage_key FROM __transfer_old_objects LIMIT 10').all<{ storage_key: string }>();
      if (rows.results.length) {
        for (const row of rows.results) {
          const referenced = await this.env.DB.prepare("SELECT 1 AS found FROM images WHERE COALESCE(storage_key,user_id||'/'||id)=? LIMIT 1")
            .bind(row.storage_key).first();
          if (!referenced) await this.env.IMAGES.delete(row.storage_key);
          await this.env.DB.prepare('DELETE FROM __transfer_old_objects WHERE storage_key=?').bind(row.storage_key).run();
        }
        return;
      }
    }
    for (const table of tables) await this.env.DB.prepare(`DROP TABLE IF EXISTS ${stage(table)}`).run();
    await this.env.DB.prepare('DROP TABLE IF EXISTS __transfer_files').run();
    delete data.garbage;
  }
}
