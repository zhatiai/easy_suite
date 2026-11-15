import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('cold backup refuses unavailable Docker and invalid retention; successful backup restarts and restricts access', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'easynote-cold-backup-'));
  const bin = path.join(root, 'bin');
  const data = path.join(root, 'data');
  const backups = path.join(root, 'backups');
  await mkdir(bin);
  await mkdir(path.join(data, 'state'), { recursive: true });
  await writeFile(path.join(data, 'state', 'test'), 'cold backup bytes');
  await writeFile(path.join(bin, 'docker'), `#!/usr/bin/env node
const { existsSync, writeFileSync } = require('node:fs');
if (process.env.TEST_DOCKER_DOWN === '1') process.exit(23);
const args = process.argv.slice(2);
if (args[0] === 'inspect') {
  const format = args[1];
  if (format.includes('.State.Running')) console.log(existsSync(process.env.TEST_STOPPED) ? 'false' : 'true');
  else if (format.includes('.Mounts')) console.log(process.env.TEST_DATA);
  else console.log('"healthy"');
} else if (args[0] === 'stop') writeFileSync(process.env.TEST_STOPPED, 'stopped');
else if (args[0] === 'start') writeFileSync(process.env.TEST_RESTARTED, 'restarted');
else process.exit(24);
`, { mode: 0o700 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_DATA: data,
    TEST_STOPPED: path.join(root, 'stopped'), TEST_RESTARTED: path.join(root, 'restarted') };
  const run = (args, extra = {}) => spawnSync('bash', ['scripts/backup.sh', '--data-dir', data, '--backup-dir', backups, ...args],
    { env: { ...env, ...extra }, encoding: 'utf8' });
  try {
    assert.notEqual(run(['--keep', '0']).status, 0);
    assert.notEqual(run([], { TEST_DOCKER_DOWN: '1' }).status, 0);
    await assert.rejects(stat(backups), /ENOENT/);
    const success = run([]);
    assert.equal(success.status, 0, success.stderr);
    assert.equal(await readFile(env.TEST_RESTARTED, 'utf8'), 'restarted');
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(backups);
    const archive = files.find((name) => name.endsWith('.tar.gz'));
    assert.ok(archive);
    assert.equal((await stat(path.join(backups, archive))).mode & 0o777, 0o600);
    const checksum = await readFile(path.join(backups, `${archive}.sha256`), 'utf8');
    assert.ok(checksum.trim().endsWith(archive));
    assert.ok(!checksum.includes(backups));
    const extracted = spawnSync('tar', ['-xOzf', path.join(backups, archive), 'state/test'], { encoding: 'utf8' });
    assert.equal(extracted.status, 0, extracted.stderr);
    assert.equal(extracted.stdout, 'cold backup bytes');
  } finally { await rm(root, { recursive: true, force: true }); }
});
