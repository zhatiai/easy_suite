import { readdir, readFile, mkdir, writeFile, unlink } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import path from 'node:path';
import http from 'node:http';
import { fork } from 'node:child_process';
import * as miniflareModule from 'miniflare';

const Miniflare = miniflareModule.Miniflare;
const convertOptions = (miniflareModule).convertV4MiniflareOptions ?? ((opts) => opts);

/**
 * Split SQL schema into discrete statements, handling triggers correctly.
 */
export function migrationStatements(schema) {
  const statements = [];
  let current = '';
  let inTrigger = false;
  for (const line of schema.split('\n')) {
    current += `${line}\n`;
    const trimmed = line.trim();
    if (!inTrigger && /^CREATE TRIGGER\b/i.test(current.trimStart())) inTrigger = true;
    if (inTrigger ? /^END;$/.test(trimmed) : trimmed.endsWith(';')) {
      statements.push(current.trim());
      current = '';
      inTrigger = false;
    }
  }
  if (current.trim()) throw new Error('Migration contains an unterminated SQL statement.');
  return statements;
}

/**
 * Gatekeeper: verify and execute all pending D1 migrations in an isolated instance
 * before main traffic is accepted.
 */
export async function runMigrationGatekeeper(dataDir, migrationsDir = path.resolve('migrations')) {
  const d1PersistDir = path.join(dataDir, 'state', 'd1');
  console.log(`[gatekeeper] Initializing migration gatekeeper at ${d1PersistDir}...`);

  const migrationConfig = convertOptions({
    modules: true,
    script: 'export default { fetch() { return new Response("migration-ok"); } }',
    d1Databases: { DB: 'easynote-db' },
    d1Persist: d1PersistDir,
    handleSIGINT: false,
    handleSIGTERM: false,
    host: '127.0.0.1', port: 0, cf: false,
  });

  const mf = new Miniflare(migrationConfig);
  try {
    await mf.ready;
    const db = await mf.getD1Database('DB');

    await db.prepare(
      'CREATE TABLE IF NOT EXISTS _easynote_migrations (name TEXT PRIMARY KEY, applied_at INTEGER)'
    ).run();

    // Older container releases recorded only the filename. Preserve their ledger.
    const columns = await db.prepare('PRAGMA table_info(_easynote_migrations)').all();
    if (!columns.results.some((column) => column.name === 'sha256')) {
      await db.prepare('ALTER TABLE _easynote_migrations ADD COLUMN sha256 TEXT').run();
    }
    const entries = await readdir(migrationsDir);
    const sqlFiles = entries.filter((name) => name.endsWith('.sql')).sort();

    const applied = await db.prepare('SELECT name FROM _easynote_migrations').all();
    if (applied.results.some((row) => !sqlFiles.includes(row.name))) {
      throw new Error('Database has unknown migrations; use a matching or newer image.');
    }
    for (const file of sqlFiles) {
      const sqlContent = await readFile(path.join(migrationsDir, file), 'utf8');
      const sha256 = createHash('sha256').update(sqlContent).digest('hex');
      const existing = await db.prepare('SELECT sha256 FROM _easynote_migrations WHERE name = ?').bind(file).first();
      if (existing) {
        if (existing.sha256 && existing.sha256 !== sha256) throw new Error(`Migration changed after application: ${file}`);
        if (!existing.sha256) await db.prepare('UPDATE _easynote_migrations SET sha256=? WHERE name=?').bind(sha256, file).run();
        continue;
      }

      console.log(`[gatekeeper] Applying migration ${file}...`);
      const statements = migrationStatements(sqlContent);

      await db.batch([
        ...statements.map((s) => db.prepare(s)),
        db.prepare('INSERT INTO _easynote_migrations (name, applied_at, sha256) VALUES (?, ?, ?)').bind(file, Date.now(), sha256),
      ]);
      console.log(`[gatekeeper] Migration ${file} applied successfully.`);
    }

    const appliedRows = await db.prepare('SELECT name, applied_at FROM _easynote_migrations ORDER BY applied_at ASC').all();
    console.log(`[gatekeeper] All migrations verified (${appliedRows.results.length} total applied).`);
  } catch (error) {
    console.error('[gatekeeper] FATAL: Migration gatekeeper failed:', error);
    throw error;
  } finally {
    await mf.dispose();
  }
  console.log('[gatekeeper] Gatekeeper completed and SQLite handles released.');
}

/**
 * Resilient Cron Scheduler with state machine and concurrency lock.
 */
export class ResilientCronScheduler {
  constructor(mf) {
    this.mf = mf;
    this.intervalId = null;
    this.state = {
      running: false,
      lastStartedAt: null,
      lastFinishedAt: null,
      lastSuccessAt: null,
      lastError: null,
    };
  }

  start(cronMinute = 17) {
    if (this.intervalId) throw new Error('Scheduler already started.');
    let lastHour = '';
    this.intervalId = setInterval(() => {
      const now = new Date();
      const hour = now.toISOString().slice(0, 13);
      if (now.getUTCMinutes() === cronMinute && hour !== lastHour) {
        lastHour = hour;
        void this.dispatchScheduled(now);
      }
    }, 1000);
  }

  async dispatchScheduled(scheduledTime = new Date()) {
    if (this.state.running) {
      console.warn(JSON.stringify({
        event: 'cron-skipped',
        reason: 'previous-task-still-running',
        time: scheduledTime.toISOString(),
      }));
      return;
    }

    this.state.running = true;
    this.state.lastStartedAt = Date.now();
    this.state.lastError = null;

    try {
      console.info(JSON.stringify({ event: 'cron-started', time: scheduledTime.toISOString() }));
      const worker = await this.mf.getWorker();
      await worker.scheduled({
        cron: '17 * * * *',
        scheduledTime: scheduledTime.getTime(),
      });

      this.state.lastFinishedAt = Date.now();
      this.state.lastSuccessAt = this.state.lastFinishedAt;
      console.info(JSON.stringify({
        event: 'cron-finished',
        durationMs: this.state.lastFinishedAt - this.state.lastStartedAt,
      }));
    } catch (error) {
      this.state.lastFinishedAt = Date.now();
      this.state.lastError = String(error);
      console.error(JSON.stringify({ event: 'cron-failed', error: String(error) }));
    } finally {
      this.state.running = false;
    }
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  getStatus() {
    return { ...this.state };
  }
}

/**
 * Decoupled Health Check Server on port 8792.
 */
export function createHealthServer(statusGetter, port = 8792) {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/healthz' || req.url === '/health') {
      const status = await statusGetter();
      if (!status.isReady || status.isShuttingDown) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'unavailable', ...status }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok', ...status }));
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(port, '127.0.0.1');
  return server;
}

/**
 * Check and create required storage directories.
 */
export async function ensureDataDirectories(dataDir) {
  const dirs = [
    dataDir,
    path.join(dataDir, 'state'),
    path.join(dataDir, 'state', 'd1'),
    path.join(dataDir, 'state', 'r2'),
    path.join(dataDir, 'state', 'do'),
    path.join(dataDir, 'backups'),
  ];

  for (const dir of dirs) {
    await mkdir(dir, { recursive: true });
  }

  // Verify write permission
  const testFile = path.join(dataDir, `.write_test_${Date.now()}`);
  await writeFile(testFile, 'test');
  await unlink(testFile);
}

/** Load the same defaults as Cloudflare, with explicit server overrides. */
export async function loadRuntimeBindings(dataDir = process.env.DATA_DIR || '/data', env = process.env) {
  const config = JSON.parse(await readFile(path.resolve('wrangler.json'), 'utf8'));
  const bindings = { ...config.vars };
  for (const key of Object.keys(bindings)) {
    if (env[key] !== undefined) bindings[key] = env[key];
  }
  if (env.INITIAL_OWNER) bindings.INITIAL_OWNER = env.INITIAL_OWNER;
  else {
    try { bindings.INITIAL_OWNER = await readFile(env.INITIAL_OWNER_FILE || path.join(dataDir, 'initial-owner.json'), 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT' || env.INITIAL_OWNER_FILE) throw error; }
  }
  return bindings;
}

export function publicOrigin(env = process.env) {
  if (!env.PUBLIC_ORIGIN) throw new Error('PUBLIC_ORIGIN is required (for example https://notes.example.com).');
  const url = new URL(env.PUBLIC_ORIGIN);
  if (url.origin !== env.PUBLIC_ORIGIN || url.username || url.password ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && env.ALLOW_LOCAL_HTTP === 'true' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('PUBLIC_ORIGIN must be an HTTPS origin; HTTP is allowed only for explicit loopback development.');
  }
  return url;
}

/** Keep Miniflare control routes and headers off the public socket, including upgrades. */
export function createIngress(target, origin, trustProxy = false, aliases = []) {
  const origins = [origin, ...aliases];
  function headersFor(req) {
    const pathname = new URL(req.url, origin).pathname;
    if (!req.url.startsWith('/') || req.url.startsWith('//') ||
        decodeURIComponent(pathname).startsWith('/cdn-cgi/')) return null;
    const selectedOrigin = origins.find((allowed) => req.headers.host === allowed.host);
    if (!selectedOrigin) return null;
    const headers = { ...req.headers };
    for (const key of Object.keys(headers)) {
      if (/^(mf-|cf-|x-forwarded-|x-real-ip$|forwarded$)/i.test(key)) delete headers[key];
    }
    const ip = trustProxy && typeof req.headers['x-real-ip'] === 'string' && isIP(req.headers['x-real-ip'])
      ? req.headers['x-real-ip'] : req.socket.remoteAddress;
    headers['cf-connecting-ip'] = ip;
    headers['x-forwarded-proto'] = selectedOrigin.protocol.slice(0, -1);
    headers['x-forwarded-host'] = selectedOrigin.host;
    return headers;
  }
  const server = http.createServer((req, res) => {
    let headers;
    try { headers = headersFor(req); } catch { /* malformed URL */ }
    if (!headers) { res.writeHead(400); res.end(); return; }
    // A rejected Worker request may leave its body unread; do not reuse that upstream connection.
    const upstream = http.request(target, {
      method: req.method, path: req.url, agent: false, headers: { ...headers, connection: 'close' },
    }, (response) => {
      res.writeHead(response.statusCode, response.headers);
      response.on('error', () => res.destroy());
      response.pipe(res);
    });
    upstream.on('error', (error) => {
      console.error(JSON.stringify({ event: 'ingress-upstream-error', code: error.code }));
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
    req.pipe(upstream);
  });
  server.on('upgrade', (req, socket, head) => {
    let headers;
    try { headers = headersFor(req); } catch { /* malformed URL */ }
    if (!headers) { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return; }
    const upstream = http.request(target, { method: req.method, path: req.url, headers });
    upstream.on('upgrade', (response, peer, peerHead) => {
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers)
        .map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`);
      if (peerHead.length) socket.write(peerHead);
      if (head.length) peer.write(head);
      peer.on('error', () => socket.destroy());
      socket.on('error', () => peer.destroy());
      socket.on('close', () => peer.destroy());
      peer.on('close', () => socket.destroy());
      peer.pipe(socket).pipe(peer);
    });
    upstream.on('response', (response) => {
      socket.write(`HTTP/1.1 ${response.statusCode} Rejected\r\nConnection: close\r\n\r\n`);
      response.pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.end();
  });
  return server;
}

async function main() {
  const dataDir = process.env.DATA_DIR || '/data';
  const origin = publicOrigin();
  const aliases = (process.env.PUBLIC_ORIGIN_ALIASES || '').split(',').filter(Boolean)
    .map((value) => publicOrigin({ ...process.env, PUBLIC_ORIGIN: value.trim() }));
  if (aliases.some((alias) => alias.protocol !== origin.protocol)) throw new Error('Public origins must use the same protocol.');
  const port = Number(process.env.PORT || 8791);
  const healthPort = Number(process.env.HEALTH_PORT || 8792);
  for (const value of [port, healthPort]) {
    if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error('Invalid server port.');
  }
  const status = { isReady: false, isShuttingDown: false };
  let mf;
  let ingress;
  let healthServer;
  let cronScheduler;
  const sockets = new Set();
  const shutdown = async () => {
    if (status.isShuttingDown) return;
    status.isShuttingDown = true;
    cronScheduler?.stop();
    healthServer?.close();
    const closed = ingress ? new Promise((resolve) => ingress.close(resolve)) : Promise.resolve();
    const deadline = setTimeout(() => { for (const socket of sockets) socket.destroy(); }, 5000);
    deadline.unref();
    await closed;
    clearTimeout(deadline);
    // Wait for a scheduled cleanup before disposing its database handles.
    while (cronScheduler?.state.running) await new Promise((resolve) => setTimeout(resolve, 50));
    await mf?.dispose();
  };
  try {
    await ensureDataDirectories(dataDir);
    await runMigrationGatekeeper(dataDir);
    const bindings = await loadRuntimeBindings(dataDir);
    // Container traffic is HTTP internally; only explicit loopback development may use dev cookies.
    bindings.ALLOW_LOCAL_HTTP = origin.protocol === 'http:' ? 'true' : 'false';
    const config = JSON.parse(await readFile(path.resolve('wrangler.json'), 'utf8'));
    mf = new Miniflare(convertOptions({
      modules: true, scriptPath: path.resolve('dist/worker/index.js'),
      compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags,
      bindings, cf: false,
      d1Databases: { DB: 'easynote-db' }, r2Buckets: { IMAGES: 'easynote-images' },
      durableObjects: { NOTE_EVENTS: { className: 'NoteEvents', useSQLite: true }, SERVER_TRANSFER: { className: 'ServerTransfer', useSQLite: true } },
      d1Persist: path.join(dataDir, 'state/d1'), r2Persist: path.join(dataDir, 'state/r2'),
      durableObjectsPersist: path.join(dataDir, 'state/do'),
      assets: {
        directory: path.resolve('dist/client'), binding: 'ASSETS', run_worker_first: true,
        routerConfig: { has_user_worker: true },
        assetConfig: { html_handling: 'auto-trailing-slash', not_found_handling: 'single-page-application' },
      },
      host: '127.0.0.1', port: 0, upstream: origin.origin,
      unsafeProxySharedSecret: randomBytes(32).toString('hex'),
      handleSIGINT: false, handleSIGTERM: false,
    }));
    const target = await mf.ready;
    const probe = async () => {
      const response = await fetch(new URL('/api/session', target), {
        headers: { Host: origin.host }, signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) throw new Error('Worker readiness probe failed.');
      return response.json();
    };
    await probe();
    ingress = createIngress(target, origin, process.env.TRUST_PROXY === 'true', aliases);
    ingress.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise((resolve, reject) => {
      ingress.once('error', reject);
      ingress.listen(port, '0.0.0.0', resolve);
    });
    cronScheduler = new ResilientCronScheduler(mf);
    cronScheduler.start();
    healthServer = createHealthServer(async () => {
      let workerReady = false;
      try { await probe(); workerReady = true; } catch { /* unhealthy runtime */ }
      return { ...status, isReady: status.isReady && workerReady, cron: cronScheduler.getStatus() };
    }, healthPort);
    await new Promise((resolve, reject) => { healthServer.once('error', reject); healthServer.once('listening', resolve); });
    status.isReady = true;
    process.on('message', (message) => {
      if (message?.type !== 'easynote-shutdown') return;
      void shutdown().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
    });
    process.on('disconnect', () => { void shutdown().finally(() => process.exit(1)); });
    console.log(`EasyNote READY at ${origin.origin}; local ingress port ${port}.`);
  } catch (error) {
    await shutdown();
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--runtime') {
    main().catch((error) => { console.error(`EasyNote: ${error.message}`); process.exitCode = 1; });
  } else {
    // Miniflare installs synchronous exit hooks. Relay signals over IPC so disposal can finish first.
    const child = fork(fileURLToPath(import.meta.url), ['--runtime'], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
      if (child.connected) child.send({ type: 'easynote-shutdown' });
    });
    child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
    child.on('exit', (code) => { process.exitCode = code ?? 1; });
  }
}
