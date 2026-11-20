import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocket } from 'ws';
import { once } from 'node:events';
import { Miniflare } from 'miniflare';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHmac, pbkdf2Sync, randomUUID } from 'node:crypto';
import { createIngress, publicOrigin, loadRuntimeBindings, ResilientCronScheduler, runMigrationGatekeeper } from '../scripts/server.mjs';

test('Migration gatekeeper initializes schema and is idempotent', { timeout: 30_000 }, async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'easynote-gatekeeper-test-'));
  try {
    // 1. First run creates tables and records migrations
    await runMigrationGatekeeper(tempDir);

    // 2. Second run is a no-op / skips existing
    await runMigrationGatekeeper(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('Server host starts, serves healthz, assets, API 404 and shuts down gracefully', { timeout: 30_000 }, async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'easynote-server-test-'));
  const port = 8795;
  const healthPort = 8796;

  const child = spawn(process.execPath, ['scripts/server.mjs'], {
    env: {
      ...process.env,
      DATA_DIR: tempDir,
      PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
      INITIAL_OWNER: JSON.stringify({ username: 'tester', verifier: { salt: 'a'.repeat(64),
        proof: createHmac('sha256', pbkdf2Sync('Test-only-EasyNote-938!', Buffer.from('a'.repeat(64), 'hex'), 100000, 32, 'sha256'))
          .update('easynote/password/v1').digest('hex') } }),
      PORT: String(port),
      HEALTH_PORT: String(healthPort),
      ALLOW_LOCAL_HTTP: 'true',
      SHUTDOWN_GRACE_MS: '200',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  try {
    // Poll healthz until 200
    let ready = false;
    for (let i = 0; i < 40; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${healthPort}/healthz`);
        if (res.status === 200) {
          const body = await res.json();
          if (body.status === 'ok' && body.isReady) {
            ready = true;
            break;
          }
        }
      } catch {
        /* wait */
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    assert.equal(ready, true, `Server failed to become healthy. Output:\nSTDOUT: ${stdout}\nSTDERR: ${stderr}`);

    // Verify SPA HTML on root
    const rootRes = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(rootRes.status, 200);
    const rootText = await rootRes.text();
    assert.match(rootText, /<!DOCTYPE html>/i);

    // Verify SPA routing fallback
    const spaRes = await fetch(`http://127.0.0.1:${port}/notes/test-note-123`);
    assert.equal(spaRes.status, 200);
    const spaText = await spaRes.text();
    assert.match(spaText, /<!DOCTYPE html>/i);

    // Verify API request returns JSON error (401 or 404), NEVER HTML
    const apiRes = await fetch(`http://127.0.0.1:${port}/api/not-existing-endpoint`);
    const apiJson = await apiRes.json();
    assert.ok(apiJson.error, 'API must return JSON error object');
    assert.equal(apiRes.headers.get('content-type')?.includes('application/json'), true);

    // Verify graceful shutdown on SIGTERM
    const exitPromise = new Promise((resolve) => {
      child.on('exit', (code, signal) => resolve({ code, signal }));
    });

    child.kill('SIGTERM');
    const exitResult = await exitPromise;
    assert.ok(exitResult.code === 0 || exitResult.code === 143, `Expected clean exit (0 or 143), got ${exitResult.code}`);
  } finally {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    await rm(tempDir, { recursive: true, force: true });
  }
});


test('public origin rejects insecure production and ambiguous origins', () => {
  for (const value of ['', 'http://notes.example.com', 'https://notes.example.com/', 'https://a:b@notes.example.com']) {
    assert.throws(() => publicOrigin({ PUBLIC_ORIGIN: value, ALLOW_LOCAL_HTTP: 'true' }));
  }
  assert.equal(publicOrigin({ PUBLIC_ORIGIN: 'https://notes.example.com' }).origin, 'https://notes.example.com');
  assert.equal(publicOrigin({ PUBLIC_ORIGIN: 'http://127.0.0.1:8791', ALLOW_LOCAL_HTTP: 'true' }).protocol, 'http:');
});

test('server loads every known binding override and fails for missing explicit owner file', async () => {
  const bindings = await loadRuntimeBindings('/nonexistent', { MAX_NOTES: '200', UNRELATED_SECRET: 'ignore' });
  assert.equal(bindings.MAX_NOTES, '200');
  assert.equal(bindings.UNRELATED_SECRET, undefined);
  await assert.rejects(loadRuntimeBindings('/nonexistent', { INITIAL_OWNER_FILE: '/nonexistent/owner' }), /ENOENT/);
  const dataDir = await mkdtemp(path.join(tmpdir(), 'easynote-owner-file-'));
  try {
    const verifier = JSON.stringify({ username: 'tester', verifier: { salt: 'a'.repeat(64), proof: 'b'.repeat(64) } });
    await writeFile(path.join(dataDir, 'initial-owner.json'), verifier, { mode: 0o600 });
    assert.equal((await loadRuntimeBindings(dataDir, {})).INITIAL_OWNER, verifier);
    assert.equal((await loadRuntimeBindings(dataDir, { INITIAL_OWNER: 'environment-owner' })).INITIAL_OWNER, 'environment-owner');
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('ingress strips runtime headers and trusts only explicitly enabled proxy IPs', async () => {
  const target = http.createServer((req, res) => res.end(JSON.stringify(req.headers)));
  target.listen(0, '127.0.0.1');
  await once(target, 'listening');
  try {
    for (const trust of [false, true]) {
      const ingress = createIngress(new URL(`http://127.0.0.1:${target.address().port}`), new URL('https://notes.example.test'), trust,
        [new URL('https://alias.example.test')]);
      ingress.listen(0, '127.0.0.1');
      await once(ingress, 'listening');
      try {
        const headers = await new Promise((resolve, reject) => {
          const req = http.get({ host: '127.0.0.1', port: ingress.address().port, headers: {
            Host: 'notes.example.test', 'X-Real-IP': '192.0.2.1', 'CF-Connecting-IP': '192.0.2.2',
            'MF-Original-URL': 'https://attacker.test', 'X-Forwarded-Proto': 'http', 'X-Forwarded-Host': 'attacker.test',
          } }, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => resolve(JSON.parse(body)));
          });
          req.on('error', reject);
        });
        assert.equal(headers['cf-connecting-ip'], trust ? '192.0.2.1' : '127.0.0.1');
        assert.equal(headers['x-forwarded-proto'], 'https');
        assert.equal(headers['x-forwarded-host'], 'notes.example.test');
        assert.equal(headers['mf-original-url'], undefined);
        assert.equal(headers['x-real-ip'], undefined);
        for (const host of ['alias.example.test', 'attacker.test']) {
          const response = await new Promise((resolve, reject) => {
            const req = http.get({ host: '127.0.0.1', port: ingress.address().port, headers: { Host: host } }, (res) => {
              let body = '';
              res.on('data', (chunk) => { body += chunk; });
              res.on('end', () => resolve({ status: res.statusCode, headers: JSON.parse(body || '{}') }));
            });
            req.on('error', reject);
          });
          assert.equal(response.status, host === 'alias.example.test' ? 200 : 400);
          if (response.status === 200) assert.equal(response.headers['x-forwarded-host'], host);
        }
      } finally { await new Promise((resolve) => ingress.close(resolve)); }
    }
  } finally { await new Promise((resolve) => target.close(resolve)); }
});

test('cron serializes overlapping runs and reports failure', async () => {
  let release;
  let count = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const scheduler = new ResilientCronScheduler({ getWorker: async () => ({ scheduled: async () => { count++; await gate; } }) });
  const first = scheduler.dispatchScheduled();
  await scheduler.dispatchScheduled();
  release();
  await first;
  assert.equal(count, 1);
  assert.ok(scheduler.getStatus().lastSuccessAt);
  const broken = new ResilientCronScheduler({ getWorker: async () => { throw new Error('failed'); } });
  await broken.dispatchScheduled();
  assert.match(broken.getStatus().lastError, /failed/);
  assert.equal(broken.getStatus().running, false);
});


test('unconfigured server starts healthy, accepts web setup and preserves HTTPS, tenancy and data across restart', { timeout: 30_000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'easynote-persistence-'));
  const port = 8797;
  const origin = 'https://notes.example.test';
  const password = 'Test-only-EasyNote-938!';
  let child;
  let output = '';
  async function start() {
    child = spawn(process.execPath, ['scripts/server.mjs'], {
      env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), HEALTH_PORT: '8798',
        PUBLIC_ORIGIN: origin, PUBLIC_ORIGIN_ALIASES: 'https://alias.example.test', INITIAL_OWNER: '', ALLOW_LOCAL_HTTP: 'false', TRUST_PROXY: 'false' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(output);
      try {
        if ((await fetch('http://127.0.0.1:8798/healthz')).ok) return;
      } catch { /* wait for process */ }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Server not ready: ${output}`);
  }
  async function stop() {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const [code] = await exited;
    assert.equal(code, 0, output);
  }
  // Node fetch overwrites Host; use the actual HTTP transport with an explicit public Host.
  function request(route, method = 'GET', body, auth = {}, extra = {}) {
    return new Promise((resolve, reject) => {
      const bytes = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
      const req = http.request({ host: '127.0.0.1', port, path: route, method,
        headers: { Host: 'notes.example.test', Origin: origin, ...auth,
          ...(bytes === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bytes) }), ...extra },
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers,
          text: Buffer.concat(chunks).toString(), json() { return JSON.parse(this.text); } }));
      });
      req.on('error', reject);
      req.end(bytes);
    });
  }
  const login = async (username) => {
    const result = await request('/api/login', 'POST', { username, password });
    assert.equal(result.status, 200, result.text);
    assert.match(result.headers['set-cookie'][0], /^__Host-easynote=.*; Secure/);
    return { Cookie: result.headers['set-cookie'][0].split(';')[0], 'X-CSRF-Token': result.json().csrf };
  };
  let socket;
  try {
    await start();
    assert.equal((await request('/api/session')).json().configured, false);
    assert.equal((await request('/api/setup', 'POST', { username: 'tester', password }, {},
      { Host: 'alias.example.test', Origin: 'https://alias.example.test' })).status, 200);
    assert.equal((await request('/api/session')).json().configured, true);
    const root = await request('/');
    assert.equal(root.status, 200);
    assert.match(root.headers['content-security-policy'], /frame-ancestors/);
    for (const route of ['/cdn-cgi/explorer', '/cdn-cgi/handler/scheduled', '/cdn-cgi/platform-proxy', '/%63dn-cgi/explorer']) {
      assert.equal((await request(route)).status, 400);
    }
    assert.equal((await request('/api/session', 'GET', undefined, {}, { Host: 'attacker.test' })).status, 400);
    const auth = await login('tester');
    assert.equal((await request('/.well-known/oauth-authorization-server')).json().issuer, origin);
    assert.equal((await request('/.well-known/unknown')).status, 404);
    const unauthorized = await request('/mcp', 'POST', {});
    assert.equal(unauthorized.status, 401);
    assert.match(unauthorized.headers['www-authenticate'], /https:\/\/notes.example.test/);
    const id = randomUUID();
    const fileId = randomUUID();
    const folderId = randomUUID();
    assert.equal((await request('/api/folders', 'POST', { id: folderId, name: '服务端兼容', parentId: null }, auth)).status, 201, output);
    const upload = await request(`/api/files/${fileId}`, 'PUT', 'persistent attachment', auth,
      { 'Content-Type': 'text/plain', 'X-Filename': 'test.txt' });
    assert.equal(upload.status, 201, upload.text);
    const body = { title: '服务器持久化', content: `兼容测试 [file](/api/files/${fileId})`, tags: [],
      pinned: false, archived: false, deletedAt: null, folderId, revision: 0, operationId: randomUUID(), createVersion: true };
    assert.equal((await request(`/api/notes/${id}`, 'POST', body, auth, { Origin: 'https://attacker.test' })).status, 403);
    assert.equal((await request(`/api/notes/${id}`, 'POST', body, { Cookie: auth.Cookie })).status, 403);
    // Forged runtime/proxy headers cannot change routing, URL origins or authorization.
    const spoof = { 'MF-Original-URL': 'https://attacker.test/api/session', 'MF-Op': 'GET',
      'X-Forwarded-Host': 'attacker.test', 'X-Forwarded-Proto': 'http', 'CF-Connecting-IP': '192.0.2.100' };
    const created = await request(`/api/notes/${id}`, 'POST', body, auth, spoof);
    assert.equal(created.status, 201, created.text);
    assert.equal((await request(`/api/notes/${id}`, 'POST', body, auth)).json().note.revision, 1);
    assert.equal((await request(`/api/notes/${id}`, 'PUT', { ...body, revision: 2, operationId: randomUUID() }, auth)).status, 409);
    const search = await request(`/api/notes?q=${encodeURIComponent('服务器')}`, 'GET', undefined, auth);
    assert.equal(search.json().notes[0].id, id);
    const share = await request(`/api/notes/${id}/share`, 'POST', { expiresInHours: null }, auth, spoof);
    assert.equal(share.status, 201, share.text);
    assert.ok(share.json().url.startsWith(origin));
    const shareToken = share.json().url.split('/').at(-1);
    assert.equal((await request(`/api/public/shares/${shareToken}`)).status, 200);
    const credential = await request('/api/integrations/tokens', 'POST', { name: 'Docker test', access: 'read-write', expiresInDays: null }, auth);
    assert.equal(credential.status, 201, credential.text);
    const bearer = { Authorization: `Bearer ${credential.json().secret}` };
    const mcp = await request('/mcp', 'POST', { jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'server-test', version: '1' } } }, bearer,
      { Accept: 'application/json, text/event-stream' });
    assert.equal(mcp.status, 200, mcp.text);
    assert.match(mcp.text, /serverInfo/);
    assert.equal((await request('/api/admin/users', 'POST', { username: 'other', password }, auth)).status, 201);
    const other = await login('other');
    assert.equal((await request(`/api/notes/${id}`, 'GET', undefined, other)).status, 404);
    assert.equal((await request(`/api/files/${fileId}`, 'GET', undefined, other)).status, 404);
    assert.equal((await request('/api/sync', 'GET', undefined, other)).json().changes.length, 0);
    socket = new WebSocket(`ws://127.0.0.1:${port}/api/events?client=${randomUUID()}`,
      { headers: { Host: 'notes.example.test', Origin: origin, Cookie: auth.Cookie } });
    await once(socket, 'open');
    const notification = once(socket, 'message');
    const update = { ...body, content: body.content + '\nupdated', revision: 1, operationId: randomUUID() };
    assert.equal((await request(`/api/notes/${id}`, 'PUT', update, auth)).status, 200);
    assert.equal(JSON.parse(String((await notification)[0])).type, 'notes-changed');
    const pong = once(socket, 'message');
    socket.send('ping');
    assert.equal(String((await pong)[0]), 'pong');
    const transferKey = await request('/api/admin/server-transfer/key', 'POST', {}, auth);
    assert.equal(transferKey.status, 200, transferKey.text);
    const schedule = await request('/api/admin/server-transfer', 'PUT', {
      backup: { url: 'https://backup.example.test', token: transferKey.json().token },
      sync: { url: 'https://sync.example.test', token: transferKey.json().token }, intervalMinutes: 1440,
      syncIntervalMinutes: 2880, backupMode: 'incremental', syncMode: 'incremental', receivingEnabled: true, confirm: 'OVERWRITE',
    }, auth);
    assert.equal(schedule.status, 200, schedule.text);
    const scheduledTransfer = schedule.json();
    // An open WebSocket must not prevent graceful shutdown.
    await stop();
    await start();
    assert.equal((await request('/api/setup', 'POST', { username: 'replacement', password })).status, 409);
    await login('tester');
    const restoredTransfer = (await request('/api/admin/server-transfer', 'GET', undefined, auth)).json();
    assert.equal(restoredTransfer.instanceId, scheduledTransfer.instanceId);
    assert.equal(restoredTransfer.nextBackupAt, scheduledTransfer.nextBackupAt);
    assert.equal(restoredTransfer.nextSyncAt, scheduledTransfer.nextSyncAt);
    assert.equal(restoredTransfer.settings.syncMode, 'incremental');
    assert.equal(restoredTransfer.settings.syncIntervalMinutes, 2880);
    assert.equal(restoredTransfer.hasBackupToken, true);
    assert.equal(restoredTransfer.hasReceivingToken, true);
    assert.equal(restoredTransfer.settings.backup.token, '');
    assert.equal((await request(`/api/notes/${id}`, 'GET', undefined, auth)).json().note.revision, 2);
    assert.equal((await request(`/api/files/${fileId}`, 'GET', undefined, auth)).text, 'persistent attachment');
    assert.equal((await request(`/api/notes/${id}/versions`, 'GET', undefined, auth)).status, 200);
    assert.ok((await request('/api/sync?after=0', 'GET', undefined, auth)).json().changes.some((item) => item.noteId === id));
    assert.equal((await request('/api/integrations/status', 'GET', undefined, bearer)).status, 200);
    assert.equal((await request(`/api/public/shares/${shareToken}`)).status, 200);
    await stop();
  } finally {
    socket?.terminate();
    if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    await rm(dataDir, { recursive: true, force: true });
  }
});


test('migrations roll back schema and ledger together and reject changed migrations', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'easynote-migration-failure-'));
  const migrations = path.join(directory, 'migrations');
  await mkdir(migrations);
  const migration = path.join(migrations, '0001_test.sql');
  try {
    await writeFile(migration, 'CREATE TABLE example (id TEXT);\nINSERT INTO missing VALUES(1);\n');
    await assert.rejects(runMigrationGatekeeper(directory, migrations), /missing/);
    const runtime = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response(); } }',
      host: '127.0.0.1', port: 0, cf: false, d1Databases: { DB: 'easynote-db' }, d1Persist: path.join(directory, 'state/d1') });
    try {
      const db = await runtime.getD1Database('DB');
      assert.equal(await db.prepare("SELECT name FROM sqlite_master WHERE name='example'").first(), null);
      assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM _easynote_migrations').first()).count, 0);
    } finally { await runtime.dispose(); }
    await writeFile(migration, 'CREATE TABLE example (id TEXT);\n');
    await runMigrationGatekeeper(directory, migrations);
    await writeFile(migration, 'CREATE TABLE example (id INTEGER);\n');
    await assert.rejects(runMigrationGatekeeper(directory, migrations), /changed after application/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('scheduled cleanup invokes the actual Worker handler', async () => {
  const runtime = new Miniflare({ modules: true, scriptPath: path.resolve('dist/worker/index.js'),
    compatibilityDate: '2026-08-06', compatibilityFlags: ['nodejs_compat'], cf: false,
    host: '127.0.0.1', port: 0,
    d1Databases: ['DB'], r2Buckets: ['IMAGES'], durableObjects: { NOTE_EVENTS: 'NoteEvents', SERVER_TRANSFER: { className: 'ServerTransfer', useSQLite: true } },
    bindings: await loadRuntimeBindings('/nonexistent', {}) });
  try {
    const db = await runtime.getD1Database('DB');
    const { readdir, readFile } = await import('node:fs/promises');
    const { migrationStatements } = await import('../scripts/server.mjs');
    for (const name of (await readdir('migrations')).filter((name) => name.endsWith('.sql')).sort()) {
      await db.batch(migrationStatements(await readFile(`migrations/${name}`, 'utf8')).map((sql) => db.prepare(sql)));
    }
    await db.prepare("INSERT INTO login_attempts VALUES('expired',0,1)").run();
    const scheduler = new ResilientCronScheduler(runtime);
    await scheduler.dispatchScheduled();
    assert.equal(scheduler.getStatus().lastError, null);
    assert.ok(scheduler.getStatus().lastSuccessAt);
    assert.equal(await db.prepare("SELECT * FROM login_attempts WHERE key='expired'").first(), null);
  } finally { await runtime.dispose(); }
});
