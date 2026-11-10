import { readdir, readFile, mkdir, access, writeFile, unlink } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
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
export async function runMigrationGatekeeper(dataDir) {
  const d1PersistDir = path.join(dataDir, 'state', 'd1');
  console.log(`[gatekeeper] Initializing migration gatekeeper at ${d1PersistDir}...`);

  const migrationConfig = convertOptions({
    modules: true,
    script: 'export default { fetch() { return new Response("migration-ok"); } }',
    d1Databases: { DB: 'easynote-db' },
    d1Persist: d1PersistDir,
    handleSIGINT: false,
    handleSIGTERM: false,
    port: 0,
  });

  const mf = new Miniflare(migrationConfig);
  try {
    await mf.ready;
    const db = await mf.getD1Database('DB');

    await db.prepare(
      'CREATE TABLE IF NOT EXISTS _easynote_migrations (name TEXT PRIMARY KEY, applied_at INTEGER)'
    ).run();

    const migrationsDir = path.resolve('migrations');
    const entries = await readdir(migrationsDir);
    const sqlFiles = entries.filter((name) => name.endsWith('.sql')).sort();

    for (const file of sqlFiles) {
      const existing = await db.prepare('SELECT 1 FROM _easynote_migrations WHERE name = ?').bind(file).first();
      if (existing) {
        continue;
      }

      console.log(`[gatekeeper] Applying migration ${file}...`);
      const sqlContent = await readFile(path.join(migrationsDir, file), 'utf8');
      const statements = migrationStatements(sqlContent);

      await db.batch(statements.map((s) => db.prepare(s)));
      await db.prepare('INSERT INTO _easynote_migrations (name, applied_at) VALUES (?, ?)').bind(file, Date.now()).run();
      console.log(`[gatekeeper] Migration ${file} applied successfully.`);
    }

    const appliedRows = await db.prepare('SELECT name, applied_at FROM _easynote_migrations ORDER BY applied_at ASC').all();
    console.log(`[gatekeeper] All migrations verified (${appliedRows.results.length} total applied).`);
  } catch (error) {
    console.error('[gatekeeper] FATAL: Migration gatekeeper failed:', error);
    try { await mf.dispose(); } catch { /* ignore */ }
    throw error;
  }

  await mf.dispose();
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
    this.intervalId = setInterval(() => {
      const now = new Date();
      if (now.getMinutes() === cronMinute) {
        this.dispatchScheduled(now);
      }
    }, 60_000);
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
  const server = http.createServer((req, res) => {
    if (req.url === '/healthz' || req.url === '/health') {
      const status = statusGetter();
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

  server.listen(port, '0.0.0.0');
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

/**
 * Load runtime bindings from wrangler.json and process.env.
 */
export async function loadRuntimeBindings() {
  let vars = {};
  try {
    const wranglerContent = await readFile(path.resolve('wrangler.json'), 'utf8');
    const wranglerConfig = JSON.parse(wranglerContent);
    vars = wranglerConfig.vars || {};
  } catch (err) {
    console.warn('[config] Could not read wrangler.json vars, using defaults:', err.message);
  }

  const bindings = { ...vars };

  // Explicit env overrides
  if (process.env.ALLOW_LOCAL_HTTP !== undefined) {
    bindings.ALLOW_LOCAL_HTTP = process.env.ALLOW_LOCAL_HTTP;
  }
  if (process.env.INITIAL_OWNER) {
    bindings.INITIAL_OWNER = process.env.INITIAL_OWNER;
  }

  return bindings;
}

/**
 * Main application bootstrap.
 */
async function main() {
  console.log('=== EasyNote Linux Container Host starting ===');

  const dataDir = process.env.DATA_DIR || '/data';
  const port = Number(process.env.PORT || 8791);
  const healthPort = Number(process.env.HEALTH_PORT || 8792);

  const status = {
    isReady: false,
    isShuttingDown: false,
    startTime: Date.now(),
    cron: null,
  };

  let cronScheduler = null;
  let healthServer = null;
  let mf = null;

  // Graceful shutdown registration
  const shutdown = async (signal) => {
    if (status.isShuttingDown) return;
    status.isShuttingDown = true;
    console.log(`\n[lifecycle] Received ${signal}. Initiating graceful shutdown...`);

    if (cronScheduler) {
      cronScheduler.stop();
    }

    if (healthServer) {
      healthServer.close();
    }

    const graceMs = Number(process.env.SHUTDOWN_GRACE_MS ?? 1000);
    if (graceMs > 0) {
      console.log(`[lifecycle] Waiting for in-flight requests (grace period ${graceMs}ms)...`);
      await new Promise((resolve) => setTimeout(resolve, graceMs));
    }

    if (mf) {
      console.log('[lifecycle] Disposing Miniflare runtime and flushing SQLite WAL...');
      try {
        await mf.dispose();
      } catch (err) {
        console.error('[lifecycle] Error disposing Miniflare:', err);
      }
    }

    console.log('[lifecycle] Clean exit completed.');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  try {
    // 1. Data directories & permissions
    console.log(`[storage] Verifying data volume at ${dataDir}...`);
    await ensureDataDirectories(dataDir);
    console.log('[storage] Storage directories verified and writable.');

    // 2. Migration Gatekeeper
    await runMigrationGatekeeper(dataDir);

    // 3. Prepare bindings & Miniflare 4 configuration
    const runtimeBindings = await loadRuntimeBindings();
    console.log(`[config] Loaded runtime bindings: ALLOW_LOCAL_HTTP=${runtimeBindings.ALLOW_LOCAL_HTTP}`);

    const clientDir = path.resolve('dist/client');
    const workerScript = path.resolve('dist/worker/index.js');

    // Miniflare 4 stable configuration
    const mfConfig = convertOptions({
      modules: true,
      scriptPath: workerScript,
      compatibilityDate: '2026-08-06',
      compatibilityFlags: ['nodejs_compat'],
      bindings: runtimeBindings,

      d1Databases: {
        DB: 'easynote-db',
      },
      r2Buckets: {
        IMAGES: 'easynote-images',
      },
      durableObjects: {
        NOTE_EVENTS: 'NoteEvents',
      },

      defaultPersistRoot: path.join(dataDir, 'state'),
      d1Persist: path.join(dataDir, 'state', 'd1'),
      r2Persist: path.join(dataDir, 'state', 'r2'),
      durableObjectsPersist: path.join(dataDir, 'state', 'do'),

      assets: {
        directory: clientDir,
        binding: 'ASSETS',
        routerConfig: {
          has_user_worker: true,
        },
        assetConfig: {
          html_handling: 'auto-trailing-slash',
          not_found_handling: 'single-page-application',
        },
      },

      handleSIGINT: false,
      handleSIGTERM: false,

      ...(process.env.HTTPS === 'true' || process.env.ENABLE_HTTPS === 'true' ? { https: true } : {}),

      host: '0.0.0.0',
      port,
    });

    console.log(`[runtime] Launching Miniflare on 0.0.0.0:${port}...`);
    mf = new Miniflare(mfConfig);
    await mf.ready;
    console.log(`[runtime] Worker service is listening on http://0.0.0.0:${port}`);

    // 4. Start Cron Scheduler
    cronScheduler = new ResilientCronScheduler(mf);
    cronScheduler.start(17);
    console.log('[cron] ResilientCronScheduler started (runs at minute 17 each hour).');

    // 5. Start Health Check Server
    healthServer = createHealthServer(() => ({
      isReady: status.isReady,
      isShuttingDown: status.isShuttingDown,
      uptime: Math.floor((Date.now() - status.startTime) / 1000),
      cron: cronScheduler.getStatus(),
    }), healthPort);
    console.log(`[health] Decoupled health service listening on 127.0.0.1:${healthPort}/healthz`);

    // 6. Mark ready
    status.isReady = true;
    console.log('=== EasyNote container is READY and accepting traffic ===');
  } catch (error) {
    console.error('[fatal] Startup failure:', error);
    if (mf) {
      try { await mf.dispose(); } catch { /* ignore */ }
    }
    process.exit(1);
  }
}

// Only run automatically if executed directly as script
if (process.argv[1] && (process.argv[1].endsWith('server.mjs') || process.argv[1].endsWith('server.js'))) {
  main();
}
