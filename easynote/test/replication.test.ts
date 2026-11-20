import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Response } from 'miniflare';
import { createRuntime, testCsrf, testPassword, testToken, testUserId } from './runtime';
import { digest } from '../src/worker/core';
import type { ServerTransferStatus } from '../src/shared/serverTransfer';

type Instance = Awaited<ReturnType<typeof createRuntime>>;
const origin = 'https://source.example.test';
const targetOrigin = 'https://target.example.test';
const adminPath = '/api/admin/server-transfer';
const peerPath = '/api/server-transfer/peer/';
function admin(instance: Instance, path = adminPath, method = 'GET', body?: unknown, serverOrigin = origin) {
  return instance.runtime.dispatchFetch(`${serverOrigin}${path}`, {
    method, headers: { Origin: serverOrigin, Cookie: `__Host-easynote=${testToken}`, 'X-CSRF-Token': testCsrf,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function status(instance: Instance): Promise<ServerTransferStatus> {
  const response = await admin(instance);
  assert.equal(response.status, 200, await response.clone().text());
  return await response.json() as ServerTransferStatus;
}
async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const end = Date.now() + 80_000;
  while (Date.now() < end) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Transfer did not reach the expected state.');
}
async function seedSession(instance: Instance) {
  await instance.db.prepare('INSERT OR REPLACE INTO sessions VALUES(?,?,?,?)')
    .bind(await digest(testToken), testUserId, testCsrf, Date.now() + 86400_000).run();
}

test('first-install backup imports existing accounts without creating a local administrator', { timeout: 120_000 }, async () => {
  const source = await createRuntime();
  let mismatch = false;
  try {
    const key = await admin(source, `${adminPath}/key`, 'POST', {});
    const { token: sourceToken } = await key.json() as { token: string };
    const noteId = randomUUID();
    assert.equal((await admin(source, `/api/notes/${noteId}`, 'POST', {
      title: 'Source account note', content: 'Imported for the existing account', tags: [], pinned: false,
      archived: false, deletedAt: null, revision: 0, operationId: randomUUID(),
    })).status, 201);
    for (const mode of ['overwrite', 'incremental'] as const) {
      const fresh = await createRuntime(undefined, { seedOwner: false, initialOwner: false, outboundService: async (request) => {
        const headers = new Headers(request.headers);
        if (mismatch) headers.set('X-EasyNote-Fingerprint', '0'.repeat(64));
        return source.runtime.dispatchFetch(request.url, { method: request.method,
          headers: Object.fromEntries(headers), body: request.body ? await request.arrayBuffer() : undefined });
      } });
      const setupPath = `${targetOrigin}/api/setup/backup`;
      const input = { source: { url: origin, token: sourceToken }, mode, intervalMinutes: 120 };
      const start = (body: unknown = input, extra: Record<string, string> = {}) => fresh.runtime.dispatchFetch(setupPath, {
        method: 'POST', headers: { Origin: targetOrigin, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body),
      });
      const progress = async (cookie: string): Promise<Pick<ServerTransferStatus, 'job' | 'maintenance'>> => {
        const response = await fresh.runtime.dispatchFetch(setupPath, { headers: { Cookie: cookie } });
        assert.equal(response.status, 200);
        return await response.json() as Pick<ServerTransferStatus, 'job' | 'maintenance'>;
      };
      try {
        assert.equal((await start(input, { Origin: '' })).status, 403);
        assert.equal((await start(input, { Origin: 'https://attacker.test' })).status, 403);
        assert.equal((await start(input, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
        assert.equal((await start({ ...input, intervalMinutes: -1 })).status, 400);
        assert.equal((await start({ ...input, mode: 'unknown' })).status, 400);
        assert.equal((await start({ ...input, source: { url: targetOrigin, token: sourceToken } })).status, 400);
        assert.equal((await fresh.runtime.dispatchFetch(setupPath)).status, 200);
        assert.equal(await (await fresh.runtime.dispatchFetch(setupPath)).json(), null);
        mismatch = true;
        const failed = await start();
        assert.equal(failed.status, 202);
        const oldCookie = failed.headers.get('Set-Cookie')!.split(';')[0];
        const first = await waitFor(() => progress(oldCookie), (value) => value.job?.state === 'failed' && !value.maintenance);
        assert.match(first.job?.error ?? '', /409/);
        assert.equal(await fresh.db.prepare('SELECT id FROM users LIMIT 1').first(), null);
        mismatch = false;
        const response = await start();
        assert.equal(response.status, 202);
        const cookieHeader = response.headers.get('Set-Cookie')!;
        assert.match(cookieHeader, /HttpOnly; SameSite=Strict; Max-Age=86400; Secure/);
        const cookie = cookieHeader.split(';')[0];
        assert.equal(await (await fresh.runtime.dispatchFetch(setupPath, { headers: { Cookie: oldCookie } })).json(), null);
        assert.equal((await start()).status, 409);
        const owner = await fresh.runtime.dispatchFetch(`${targetOrigin}/api/setup`, { method: 'POST',
          headers: { Origin: targetOrigin, 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'unwanted-owner', password: testPassword }) });
        assert.equal(owner.status, 503);
        const session = await (await fresh.runtime.dispatchFetch(`${targetOrigin}/api/session`)).json() as { configured: boolean };
        assert.equal(session.configured, false);
        const result = await waitFor(() => progress(cookie), (value) => value.job?.state === 'completed' && !value.maintenance);
        assert.equal(result.job?.mode, mode);
        assert.ok(result.job?.progress?.recordsTotal);
        assert.equal(result.job?.progress?.recordsProcessed, result.job?.progress?.recordsTotal);
        assert.equal(result.job?.progress?.filesProcessed, result.job?.progress?.filesTotal);
        assert.equal('settings' in result, false);
        assert.equal(JSON.stringify(result).includes(sourceToken), false);
        assert.equal((await fresh.db.prepare('SELECT count(*) AS n FROM users').first<{ n: number }>())?.n, 1);
        assert.ok(await fresh.db.prepare('SELECT id FROM notes WHERE id=? AND user_id=?').bind(noteId, testUserId).first());
        assert.equal((await start()).status, 409);
        assert.equal((await admin(fresh)).status, 401);
        const login = await fresh.runtime.dispatchFetch(`${targetOrigin}/api/login`, { method: 'POST',
          headers: { Origin: targetOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'tester', password: testPassword }) });
        assert.equal(login.status, 200);
        const imported = await login.json() as { user: { id: string }; csrf: string };
        const notes = await fresh.runtime.dispatchFetch(`${targetOrigin}/api/notes`, {
          headers: { Cookie: login.headers.get('Set-Cookie')!.split(';')[0] },
        });
        assert.equal(notes.status, 200);
        assert.match(await notes.text(), /Source account note/);
        assert.equal(imported.user.id, testUserId);
        await waitFor(() => status(source), (value) => !value.maintenance);
      } finally { await fresh.runtime.dispose(); }
    }
    const configured = await createRuntime(undefined, { seedOwner: false });
    try {
      const response = await configured.runtime.dispatchFetch(`${targetOrigin}/api/setup/backup`, { method: 'POST',
        headers: { Origin: targetOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      assert.equal(response.status, 409);
    } finally { await configured.runtime.dispose(); }
  } finally { await source.runtime.dispose(); }
});

test('whole-instance server transfers stage, validate and overwrite across isolated runtimes', { timeout: 180_000 }, async (t) => {
  let target!: Instance;
  let fault: 'none' | 'fingerprint' | 'corrupt' | 'network' | 'interrupted' | 'lostCommit' | 'commitMismatch' | 'fileNetwork' | 'fileUnavailable' = 'none';
  let fileAttempts = 0;
  const source = await createRuntime(undefined, { outboundService: async (request) => {
    const path = new URL(request.url).pathname;
    if ((fault === 'fileNetwork' || fault === 'fileUnavailable') && path.endsWith('/object') && request.method === 'GET') {
      fileAttempts++;
      if (fault === 'fileUnavailable' || fileAttempts <= 2) return new Response('temporarily unavailable', { status: 503 });
    }
    if (fault === 'network' || fault === 'interrupted' && path.endsWith('/rows') && request.method === 'POST') return new Response('unavailable', { status: 503 });
    const headers = new Headers(request.headers);
    if (fault === 'fingerprint' || fault === 'commitMismatch' && path.endsWith('/commit')) headers.set('X-EasyNote-Fingerprint', '0'.repeat(64));
    const bytes = request.body ? await request.arrayBuffer() : undefined;
    if (fault === 'corrupt' && path.endsWith('/object') && bytes?.byteLength) new Uint8Array(bytes)[0] ^= 0xff;
    const response = await target.runtime.dispatchFetch(request.url, { method: request.method, headers: Object.fromEntries(headers),
      body: bytes });
    if (fault === 'lostCommit' && path.endsWith('/commit')) {
      fault = 'none';
      await response.body?.cancel();
      return new Response('acknowledgement lost', { status: 503 });
    }
    return response;
  } });
  target = await createRuntime();
  try {
    const sourceStatus = await status(source);
    const targetStatus = await status(target);
    assert.equal(sourceStatus.fingerprint, targetStatus.fingerprint);
    assert.match(sourceStatus.fingerprint, /^[a-f0-9]{64}$/);
    assert.notEqual(sourceStatus.instanceId, targetStatus.instanceId);
    const keyResponse = await admin(target, `${adminPath}/key`, 'POST', {});
    const { token: receivingToken } = await keyResponse.json() as { token: string };
    assert.match(receivingToken, /^[a-f0-9]{64}$/);
    const settings = { backup: { url: targetOrigin, token: receivingToken }, sync: { url: targetOrigin, token: receivingToken }, intervalMinutes: 0, receivingEnabled: false };
    const configure = await admin(source, adminPath, 'PUT', settings);
    assert.equal(configure.status, 200, await configure.clone().text());
    assert.equal(JSON.stringify(await status(source)).includes(receivingToken), false);
    assert.equal((await status(source)).hasBackupToken, true);

    const noteId = randomUUID();
    const fileId = randomUUID();
    const save = await admin(source, `/api/notes/${noteId}`, 'POST', { title: 'Transferred note', content: 'whole-instance content',
      tags: [], pinned: false, archived: false, deletedAt: null, revision: 0, operationId: randomUUID(), createVersion: true });
    assert.equal(save.status, 201, await save.clone().text());
    const upload = await source.runtime.dispatchFetch(`${origin}/api/files/${fileId}`, { method: 'PUT',
      headers: { Origin: origin, Cookie: `__Host-easynote=${testToken}`, 'X-CSRF-Token': testCsrf, 'Content-Type': 'text/plain', 'X-Filename': 'example.txt' },
      body: 'attachment bytes' });
    assert.equal(upload.status, 201, await upload.clone().text());
    const foreignUser = randomUUID();
    await source.db.prepare("INSERT INTO users(id,username,password_verifier,role,enabled,created_at,updated_at) VALUES(?,?,'{}','user',1,1,1)")
      .bind(foreignUser, 'other-tenant').run();
    const foreignNote = randomUUID();
    await source.db.prepare("INSERT INTO notes(id,user_id,title,content,dedup_hash,created_at,updated_at,mutation_id,mutation_hash) VALUES(?,?,'Tenant two','private','hash',1,1,'mutation','hash')")
      .bind(foreignNote, foreignUser).run();
    const oldGeneration = (await target.db.prepare('SELECT generation FROM server_dataset').first<{ generation: string }>())!.generation;
    const sentinel = randomUUID();
    await target.db.prepare("INSERT INTO notes(id,user_id,title,content,dedup_hash,created_at,updated_at,mutation_id,mutation_hash) VALUES(?,?,'Old target','old','hash',1,1,'mutation','hash')")
      .bind(sentinel, testUserId).run();
    const run = async () => {
      const response = await admin(source, `${adminPath}/run`, 'POST', { direction: 'push', confirm: 'OVERWRITE' });
      assert.equal(response.status, 202, await response.clone().text());
      return waitFor(() => status(source), (value) => value.job?.state !== 'running');
    };
    const stillOriginal = async () => {
      assert.ok(await target.db.prepare('SELECT id FROM notes WHERE id=?').bind(sentinel).first());
      assert.equal((await target.db.prepare('SELECT generation FROM server_dataset').first<{ generation: string }>())!.generation, oldGeneration);
    };

    await t.test('dedicated authentication, fingerprint, admin and CSRF boundaries', async () => {
      const peer = await target.runtime.dispatchFetch(`${targetOrigin}${peerPath}info`);
      assert.equal(peer.status, 401);
      const mismatch = await target.runtime.dispatchFetch(`${targetOrigin}${peerPath}info`, {
        headers: { Authorization: `Bearer ${receivingToken}`, 'X-EasyNote-Fingerprint': '0'.repeat(64) } });
      assert.equal(mismatch.status, 409);
      const csrf = await source.runtime.dispatchFetch(`${origin}${adminPath}/key`, { method: 'POST',
        headers: { Cookie: `__Host-easynote=${testToken}`, Origin: origin } });
      assert.equal(csrf.status, 403);
      const badConfirm = await admin(source, `${adminPath}/run`, 'POST', { direction: 'push' });
      assert.equal(badConfirm.status, 400);
      const badSchedule = await admin(source, adminPath, 'PUT', { ...settings, intervalMinutes: 1 });
      assert.equal(badSchedule.status, 400);
      await source.db.prepare("UPDATE users SET role='user' WHERE id=?").bind(testUserId).run();
      assert.equal((await admin(source)).status, 403);
      await source.db.prepare("UPDATE users SET role='admin' WHERE id=?").bind(testUserId).run();
      fault = 'fingerprint';
      const { job } = await run();
      assert.equal(job?.state, 'failed');
      assert.equal(job?.error, 'Remote server rejected info (409). Server code fingerprints differ.');
      await stillOriginal();
    });
    await t.test('atomic rollback on invalid tenant references, maintenance and explicit abort', async () => {
      const transferId = randomUUID();
      const peer = (action: string, method: string, body?: unknown, query = '') => target.runtime.dispatchFetch(
        `${targetOrigin}${peerPath}${action}?id=${transferId}${query}`, {
          method, headers: { Authorization: `Bearer ${receivingToken}`, 'X-EasyNote-Fingerprint': sourceStatus.fingerprint,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      const counts = Object.fromEntries(['users', 'oauth_clients', 'integration_tokens', 'login_attempts', 'account_attempts',
        'app_state', 'folders', 'notes', 'note_versions', 'images', 'image_refs', 'purged_notes', 'note_shares', 'folder_shares', 'note_changes']
        .map((table) => [table, ['users', 'notes', 'app_state'].includes(table) ? 1 : 0]));
      assert.equal((await peer('begin', 'POST', { mode: 'import', counts })).status, 200);
      assert.equal((await admin(target, '/api/notes')).status, 503);
      const user = await source.db.prepare('SELECT * FROM users WHERE id=?').bind(testUserId).first();
      const note = await source.db.prepare('SELECT * FROM notes WHERE id=?').bind(noteId).first<Record<string, unknown>>();
      assert.ok(note);
      note.user_id = randomUUID();
      for (const [table, row] of [['users', user], ['notes', note], ['app_state', { id: 1, self_registration_enabled: 0 }]] as const) {
        assert.equal((await peer('rows', 'POST', { rows: [row] }, `&table=${table}&offset=0`)).status, 200);
      }
      assert.equal((await peer('commit', 'POST')).status, 500);
      await stillOriginal();
      assert.equal((await peer('abort', 'POST')).status, 200);
      await waitFor(() => status(target), (value) => !value.maintenance);
    });
    await t.test('corrupt attachment rolls back and releases maintenance', async () => {
      fault = 'corrupt';
      const result = await run();
      assert.equal(result.job?.state, 'failed');
      assert.match(result.job?.error ?? '', /object \(409\)/);
      await stillOriginal();
      await waitFor(async () => admin(target, '/api/session'), (response) => response.status === 200);
      // Wait for durable staging garbage collection before starting another import.
      await new Promise((resolve) => setTimeout(resolve, 2500));
    });
    await t.test('interrupted rows and commit fingerprint mismatch leave the original dataset intact', async () => {
      for (const failure of ['interrupted', 'commitMismatch'] as const) {
        fault = failure;
        const result = await run();
        assert.equal(result.job?.state, 'failed', JSON.stringify(result.job));
        await stillOriginal();
        await waitFor(() => status(target), (value) => !value.maintenance);
      }
    });
    await t.test('push overwrites all tenants and attachment bytes while preserving target transfer settings', async () => {
      fault = 'lostCommit';
      const result = await run();
      assert.equal(result.job?.state, 'completed', JSON.stringify(result.job));
      assert.equal(result.job?.files, 1);
      assert.equal(result.job?.progress?.filesProcessed, 1);
      assert.equal(result.job?.progress?.filesTotal, 1);
      assert.equal(await target.db.prepare('SELECT id FROM notes WHERE id=?').bind(sentinel).first(), null);
      assert.ok(await target.db.prepare('SELECT id FROM notes WHERE id=?').bind(foreignNote).first());
      assert.equal((await admin(target, '/api/notes')).status, 401);
      await seedSession(target);
      const file = await admin(target, `/api/files/${fileId}`);
      assert.equal(file.status, 200, await file.clone().text());
      assert.equal(await file.text(), 'attachment bytes');
      const newStatus = await status(target);
      assert.equal(newStatus.instanceId, targetStatus.instanceId);
      assert.equal(newStatus.hasReceivingToken, true);
      const session = await admin(target, '/api/session');
      const data = await session.json() as { datasetId: string };
      assert.notEqual(data.datasetId, oldGeneration);
    });
    await t.test('persistent attachment outages stop after bounded retries and preserve the destination', async () => {
      await waitFor(() => status(source), (value) => !value.maintenance);
      await waitFor(() => status(target), (value) => !value.maintenance);
      fault = 'fileUnavailable';
      fileAttempts = 0;
      const response = await admin(source, `${adminPath}/run`, 'POST', { direction: 'pull', confirm: 'OVERWRITE' });
      assert.equal(response.status, 202);
      const result = await waitFor(() => status(source), (value) => value.job?.state !== 'running');
      assert.equal(result.job?.state, 'failed', JSON.stringify(result.job));
      assert.match(result.job?.error ?? '', /object \(503\)/);
      assert.equal(fileAttempts, 4);
      await waitFor(() => status(source), (value) => !value.maintenance);
      assert.equal((await source.db.prepare('SELECT content FROM notes WHERE id=?').bind(noteId).first<{ content: string }>())?.content,
        'whole-instance content');
      fault = 'none';
    });
    await t.test('pull overwrites this instance and is idempotent after replacement', async () => {
      fault = 'fileNetwork';
      fileAttempts = 0;
      await waitFor(() => status(target), (value) => !value.maintenance);
      await target.db.prepare("UPDATE notes SET content='pulled content' WHERE id=?").bind(noteId).run();
      const response = await admin(source, `${adminPath}/run`, 'POST', { direction: 'pull', confirm: 'OVERWRITE' });
      assert.equal(response.status, 202, await response.clone().text());
      await waitFor(async () => source.db.prepare('SELECT content FROM notes WHERE id=?').bind(noteId).first<{ content: string }>(),
        (row) => row?.content === 'pulled content');
      await waitFor(async () => admin(source, '/api/session'), (response) => response.status === 200);
      await seedSession(source);
      const result = await waitFor(() => status(source), (value) => value.job?.state !== 'running');
      assert.equal(result.job?.state, 'completed', JSON.stringify(result.job));
      assert.equal(fileAttempts, 3);
      assert.equal(result.job?.files, 1);
      fault = 'none';
      assert.equal((await status(source)).hasBackupToken, true);
      const file = await admin(source, `/api/files/${fileId}`);
      assert.equal(await file.text(), 'attachment bytes');
    });
    await t.test('server-side interval runs with no browser and schedules its next backup', { timeout: 90_000 }, async () => {
      await waitFor(() => status(source), (value) => !value.maintenance);
      const lastJob = (await status(source)).job?.id;
      const response = await admin(source, adminPath, 'PUT', { ...settings, intervalMinutes: 1, confirm: 'OVERWRITE' });
      assert.equal(response.status, 200, await response.clone().text());
      const scheduled = await status(source);
      assert.ok(scheduled.nextBackupAt && scheduled.nextBackupAt > Date.now());
      const result = await waitFor(() => status(source), (value) => !!value.job && value.job.id !== lastJob && value.job.state !== 'running');
      assert.equal(result.job?.state, 'completed', JSON.stringify(result.job));
      assert.ok(result.nextBackupAt && result.nextBackupAt > Date.now());
      assert.equal((await admin(source, adminPath, 'PUT', settings)).status, 200);
      assert.ok(result.jobs.length >= 2);
      assert.deepEqual(result.jobs.map((job) => job.startedAt), result.jobs.map((job) => job.startedAt).sort((a, b) => b - a));
      const cleared = await admin(source, `${adminPath}/jobs`, 'DELETE');
      assert.equal(cleared.status, 200, await cleared.clone().text());
      const clearedStatus = await cleared.json() as ServerTransferStatus;
      assert.equal(clearedStatus.job, null);
      assert.deepEqual(clearedStatus.jobs, []);
    });
  } finally { await source.runtime.dispose(); await target.runtime.dispose(); }
});


test('incremental transfers preserve target-only data and support reverse scheduled pulls', { timeout: 240_000 }, async (t) => {
  let left!: Instance;
  let right!: Instance;
  let blockForward = false;
  let corrupt = false;
  let loseCommit = false;
  let objectWrites = 0;
  let fullNotes = 0;
  const forward = async (request: Request, target: Instance) => {
    const url = new URL(request.url);
    const bytes = request.body ? await request.arrayBuffer() : undefined;
    if (url.pathname.endsWith('/object') && request.method === 'PUT') {
      objectWrites++;
      if (corrupt && bytes?.byteLength) new Uint8Array(bytes)[0] ^= 0xff;
    }
    if (url.pathname.endsWith('/rows') && request.method === 'POST' && url.searchParams.get('table') === 'notes') {
      const body = JSON.parse(new TextDecoder().decode(bytes)) as { rows: Array<Record<string, unknown>> };
      fullNotes += body.rows.filter((row) => !('reference' in row)).length;
    }
    const response = await target.runtime.dispatchFetch(request.url, { method: request.method,
      headers: Object.fromEntries(request.headers), body: bytes });
    if (loseCommit && url.pathname.endsWith('/commit') && response.ok) {
      loseCommit = false;
      await response.body?.cancel();
      return new Response('lost acknowledgement', { status: 503 });
    }
    return response;
  };
  left = await createRuntime(undefined, { outboundService: async (request) => blockForward
    ? new Response('forward network unavailable', { status: 503 }) : forward(request as unknown as Request, right) });
  right = await createRuntime(undefined, { outboundService: async (request) => forward(request as unknown as Request, left) });
  const sourceNote = randomUUID();
  const targetNote = randomUUID();
  const fileId = randomUUID();
  const saveNote = async (instance: Instance, id: string, title: string) => {
    const response = await admin(instance, `/api/notes/${id}`, 'POST', {
      title, content: title, tags: [], pinned: false, archived: false, deletedAt: null,
      revision: 0, operationId: randomUUID(),
    });
    assert.equal(response.status, 201, await response.clone().text());
  };
  const settle = async () => waitFor(async () => {
    await seedSession(left); await seedSession(right);
    return [await status(left), await status(right)];
  }, (states) => states.every((state) => !state.maintenance && state.job?.state !== 'running'));
  const run = async (instance: Instance, direction: 'push' | 'pull') => {
    assert.equal((await admin(instance, `${adminPath}/run`, 'POST', { direction, confirm: 'OVERWRITE' })).status, 202);
    await waitFor(async () => {
      await seedSession(instance);
      return status(instance);
    }, (state) => state.job?.state !== 'running');
    const result = await status(instance);
    await settle();
    return result;
  };
  try {
    const key = await (await admin(right, `${adminPath}/key`, 'POST', {})).json() as { token: string };
    const settings = { backup: { url: targetOrigin, token: key.token }, sync: { url: '', token: '' },
      backupMode: 'incremental', syncMode: 'incremental', intervalMinutes: 0, syncIntervalMinutes: 0, receivingEnabled: false };
    assert.equal((await admin(left, adminPath, 'PUT', settings)).status, 200);
    assert.equal((await admin(left, adminPath, 'PUT', { ...settings, syncIntervalMinutes: 1, confirm: 'OVERWRITE' })).status, 400);
    assert.equal((await admin(left, adminPath, 'PUT', { ...settings, backupMode: 'invalid' })).status, 400);
    await saveNote(left, sourceNote, 'source content');
    await saveNote(right, targetNote, 'target-only content');
    const upload = await left.runtime.dispatchFetch(`${origin}/api/files/${fileId}`, { method: 'PUT', headers: {
      Origin: origin, Cookie: `__Host-easynote=${testToken}`, 'X-CSRF-Token': testCsrf,
      'Content-Type': 'text/plain', 'X-Filename': 'incremental.txt',
    }, body: 'incremental attachment' });
    assert.equal(upload.status, 201);
    await t.test('source wins, target-only notes survive and unchanged bytes are skipped', async () => {
      const first = await run(left, 'push');
      assert.equal(first.job?.state, 'completed', JSON.stringify(first.job));
      assert.equal(first.job?.mode, 'incremental');
      assert.equal(first.job?.files, 1);
      assert.ok(await right.db.prepare('SELECT id FROM notes WHERE id=?').bind(targetNote).first());
      for (const id of [sourceNote, targetNote]) {
        assert.equal((await admin(right, `/api/notes/${id}/share`, 'POST', { expiresInHours: null })).status, 201);
      }
      await right.db.prepare("UPDATE notes SET content='target edit' WHERE id=?").bind(sourceNote).run();
      await left.db.prepare("UPDATE notes SET content='source edit',revision=revision+1 WHERE id=?").bind(sourceNote).run();
      objectWrites = 0; fullNotes = 0;
      const second = await run(left, 'push');
      assert.equal(second.job?.state, 'completed', JSON.stringify(second.job));
      assert.equal(second.job?.files, 0);
      assert.equal(objectWrites, 0);
      assert.equal(fullNotes, 1);
      assert.equal(await right.db.prepare('SELECT note_id FROM note_shares WHERE note_id=?').bind(sourceNote).first(), null);
      assert.ok(await right.db.prepare('SELECT note_id FROM note_shares WHERE note_id=?').bind(targetNote).first());
      assert.equal((await right.db.prepare('SELECT content FROM notes WHERE id=?').bind(sourceNote).first())?.content, 'source edit');
      objectWrites = 0; fullNotes = 0;
      const unchanged = await run(left, 'push');
      assert.equal(unchanged.job?.state, 'completed', JSON.stringify(unchanged.job));
      assert.equal(objectWrites, 0);
      assert.equal(fullNotes, 0);
      loseCommit = true;
      const retried = await run(left, 'push');
      assert.equal(retried.job?.state, 'completed', JSON.stringify(retried.job));
      assert.ok(await right.db.prepare('SELECT id FROM notes WHERE id=?').bind(targetNote).first());
    });
    await t.test('tombstones from either side prevent resurrection', async () => {
      const now = Date.now();
      await left.db.batch([
        left.db.prepare('DELETE FROM notes WHERE id=?').bind(sourceNote),
        left.db.prepare('INSERT INTO purged_notes VALUES(?,?,?)').bind(sourceNote, testUserId, now),
      ]);
      const stale = randomUUID();
      await saveNote(left, stale, 'stale source');
      await right.db.prepare('INSERT INTO purged_notes VALUES(?,?,?)').bind(stale, testUserId, now).run();
      const result = await run(left, 'push');
      assert.equal(result.job?.state, 'completed', JSON.stringify(result.job));
      for (const id of [sourceNote, stale]) {
        assert.equal(await right.db.prepare('SELECT id FROM notes WHERE id=?').bind(id).first(), null);
        assert.ok(await right.db.prepare('SELECT id FROM purged_notes WHERE id=?').bind(id).first());
      }
      assert.ok(await right.db.prepare('SELECT id FROM notes WHERE id=?').bind(targetNote).first());
    });
    await t.test('account collisions fail without changing the destination', async () => {
      const leftId = randomUUID(); const rightId = randomUUID();
      for (const [instance, id] of [[left, leftId], [right, rightId]] as const) {
        await instance.db.prepare("INSERT INTO users(id,username,password_verifier,role,enabled,created_at,updated_at) VALUES(?,'collision','{}','user',1,1,1)").bind(id).run();
      }
      const generation = (await right.db.prepare('SELECT generation FROM server_dataset').first())?.generation;
      const failed = await run(left, 'push');
      assert.equal(failed.job?.state, 'failed');
      assert.match(failed.job?.error ?? '', /commit \(409\)/);
      assert.equal((await right.db.prepare('SELECT generation FROM server_dataset').first())?.generation, generation);
      assert.ok(await right.db.prepare('SELECT id FROM notes WHERE id=?').bind(targetNote).first());
      await left.db.prepare('DELETE FROM users WHERE id=?').bind(leftId).run();
      await right.db.prepare('DELETE FROM users WHERE id=?').bind(rightId).run();
    });
    await t.test('cross-tenant IDs and unique folder conflicts roll back the merge', async () => {
      const foreign = randomUUID();
      await left.db.prepare("INSERT INTO users(id,username,password_verifier,role,enabled,created_at,updated_at) VALUES(?,'foreign-owner','{}','user',1,1,1)").bind(foreign).run();
      await saveNote(left, targetNote, 'same ID under another tenant');
      await left.db.prepare('UPDATE notes SET user_id=? WHERE id=?').bind(foreign, targetNote).run();
      const before = (await right.db.prepare('SELECT generation FROM server_dataset').first())?.generation;
      const invalidOwner = await run(left, 'push');
      assert.equal(invalidOwner.job?.state, 'failed');
      assert.match(invalidOwner.job?.error ?? '', /different account/);
      assert.equal((await right.db.prepare('SELECT generation FROM server_dataset').first())?.generation, before);
      await left.db.prepare('DELETE FROM notes WHERE id=?').bind(targetNote).run();
      await left.db.prepare('DELETE FROM users WHERE id=?').bind(foreign).run();
      const sourceFolder = randomUUID(); const targetFolder = randomUUID();
      for (const [instance, id] of [[left, sourceFolder], [right, targetFolder]] as const) {
        assert.equal((await admin(instance, '/api/folders', 'POST', { id, name: 'folder collision', parentId: null })).status, 201);
      }
      const invalidFolder = await run(left, 'push');
      assert.equal(invalidFolder.job?.state, 'failed');
      assert.match(invalidFolder.job?.error ?? '', /data constraints/);
      assert.equal((await right.db.prepare('SELECT generation FROM server_dataset').first())?.generation, before);
      assert.ok(await right.db.prepare('SELECT id FROM notes WHERE id=?').bind(targetNote).first());
      await left.db.prepare('DELETE FROM folders WHERE id=?').bind(sourceFolder).run();
      await right.db.prepare('DELETE FROM folders WHERE id=?').bind(targetFolder).run();
    });
    await t.test('changed attachments are verified before atomic publication', async () => {
      const old = await right.db.prepare('SELECT storage_key,sha256 FROM images WHERE id=?').bind(fileId).first<{ storage_key: string; sha256: string }>();
      const content = 'changed incremental attachment';
      await left.bucket.put(`${testUserId}/${fileId}`, content);
      await left.db.prepare('UPDATE images SET size=?,sha256=? WHERE id=?').bind(content.length, await digest(content), fileId).run();
      corrupt = true;
      const failed = await run(left, 'push');
      assert.equal(failed.job?.state, 'failed');
      assert.equal((await right.db.prepare('SELECT sha256 FROM images WHERE id=?').bind(fileId).first())?.sha256, old?.sha256);
      assert.equal(await (await right.bucket.get(old!.storage_key))?.text(), 'incremental attachment');
      corrupt = false;
      const recovered = await run(left, 'push');
      assert.equal(recovered.job?.state, 'completed', JSON.stringify(recovered.job));
      assert.equal(recovered.job?.files, 1);
    });
    await t.test('reverse pulls work while forward connectivity is unavailable', async () => {
      const sourceKey = await (await admin(left, `${adminPath}/key`, 'POST', {})).json() as { token: string };
      const reverse = { backup: { url: '', token: '' }, sync: { url: origin, token: sourceKey.token },
        syncMode: 'incremental', intervalMinutes: 0, syncIntervalMinutes: 0, receivingEnabled: true };
      assert.equal((await admin(right, adminPath, 'PUT', reverse, targetOrigin)).status, 200);
      const reverseNote = randomUUID();
      await saveNote(left, reverseNote, 'reverse new content');
      blockForward = true;
      const result = await run(right, 'pull');
      assert.equal(result.job?.state, 'completed', JSON.stringify(result.job));
      assert.ok(await right.db.prepare('SELECT id FROM notes WHERE id=?').bind(reverseNote).first());
      assert.ok(await right.db.prepare('SELECT id FROM notes WHERE id=?').bind(targetNote).first());
      const scheduled = await admin(right, adminPath, 'PUT', { ...reverse, syncIntervalMinutes: 1, confirm: 'OVERWRITE' }, targetOrigin);
      assert.equal(scheduled.status, 200);
      const next = await status(right);
      assert.ok(next.nextSyncAt && next.nextSyncAt > Date.now());
      assert.equal(next.nextBackupAt, null);
      const completed = await waitFor(async () => {
        await seedSession(right);
        return status(right);
      }, (state) => !!state.job && state.job.id !== result.job?.id && state.job.state !== 'running');
      assert.equal(completed.job?.state, 'completed', JSON.stringify(completed.job));
      assert.ok(completed.nextSyncAt && completed.nextSyncAt > Date.now());
      await settle();
      assert.equal((await admin(right, adminPath, 'PUT', reverse, targetOrigin)).status, 200);
    });
  } finally { await left.runtime.dispose(); await right.runtime.dispose(); }
});


test('legacy settings updates preserve new transfer modes and pull schedules', async () => {
  const instance = await createRuntime();
  const settings = { backup: { url: targetOrigin, token: 'a'.repeat(64) },
    sync: { url: 'https://another-source.example.test', token: 'b'.repeat(64) },
    intervalMinutes: 60, syncIntervalMinutes: 5, backupMode: 'incremental', syncMode: 'incremental',
    receivingEnabled: false, confirm: 'OVERWRITE' };
  try {
    assert.equal((await admin(instance, adminPath, 'PUT', settings)).status, 200);
    const { backupMode: _backupMode, syncMode: _syncMode, syncIntervalMinutes: _syncInterval, ...legacy } = settings;
    assert.equal((await admin(instance, adminPath, 'PUT', legacy)).status, 200);
    const updated = await status(instance);
    assert.equal(updated.settings.backupMode, 'incremental');
    assert.equal(updated.settings.syncMode, 'incremental');
    assert.equal(updated.settings.syncIntervalMinutes, 5);
    assert.ok(updated.nextSyncAt && updated.nextSyncAt > Date.now());
  } finally { await instance.runtime.dispose(); }
});
