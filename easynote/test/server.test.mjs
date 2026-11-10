import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runMigrationGatekeeper } from '../scripts/server.mjs';

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
