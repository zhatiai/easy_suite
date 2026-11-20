import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('..', import.meta.url));
let root;
let bin;
let calls;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'easynote-docker-deploy-'));
  bin = join(root, 'bin');
  calls = join(root, 'docker-calls');
  await mkdir(bin);
  const docker = `#!/usr/bin/env bash
printf '%s|%s|%s|%s|%s|%s|%s\\n' "$*" "$EASYNOTE_DATA_DIR" "$EASYNOTE_PORT" "$PUBLIC_ORIGIN" "$PUBLIC_ORIGIN_ALIASES" "$TRUST_PROXY" "$ALLOW_LOCAL_HTTP" >> "$DOCKER_CALLS"
`;
  await writeFile(join(bin, 'docker'), docker);
  await chmod(join(bin, 'docker'), 0o755);
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

function run(extraEnv = {}, args = []) {
  const env = {
    ...process.env,
    PATH: `${bin}:/usr/bin:/bin`,
    DOCKER_CALLS: calls,
    ...extraEnv,
  };
  for (const key of ['EASYNOTE_DATA_DIR', 'EASYNOTE_PORT', 'PUBLIC_ORIGIN', 'PUBLIC_ORIGIN_ALIASES', 'TRUST_PROXY', 'ALLOW_LOCAL_HTTP']) {
    if (!(key in extraEnv)) delete env[key];
  }
  return spawnSync('/bin/bash', [join(project, 'deploy_bydocker.sh'), ...args], {
    cwd: project,
    env,
    encoding: 'utf8',
  });
}

test('check mode uses safe defaults without writing system configuration', async () => {
  const config = join(root, 'missing', 'docker.env');
  const result = run({ EASYNOTE_DOCKER_CONFIG: config }, ['--check']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /data:\s+\/var\/lib\/easynote\/data/);
  assert.match(result.stdout, /origin: http:\/\/127\.0\.0\.1:8791/);
  await assert.rejects(stat(config), { code: 'ENOENT' });
});

test('first deployment saves environment choices and starts Compose', async () => {
  const config = join(root, 'etc', 'docker.env');
  const data = join(root, 'persistent data');
  await mkdir(data);
  await writeFile(calls, '');
  const result = run({
    EASYNOTE_DOCKER_CONFIG: config,
    EASYNOTE_DATA_DIR: data,
    EASYNOTE_PORT: '9876',
    PUBLIC_ORIGIN: 'https://notes.example.test',
    PUBLIC_ORIGIN_ALIASES: 'https://notes-alt.example.test',
    TRUST_PROXY: 'true',
    ALLOW_LOCAL_HTTP: 'false',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await stat(config)).mode & 0o777, 0o600);
  assert.ok((await readFile(config, 'utf8')).includes(`EASYNOTE_DATA_DIR=${data}\n`));
  const log = await readFile(calls, 'utf8');
  assert.match(log, /compose build\|/);
  assert.match(log, /compose up -d --wait\|/);
  assert.match(log, /compose logs --tail=100 easynote\|/);
  assert.match(log, /https:\/\/notes\.example\.test\|https:\/\/notes-alt\.example\.test\|true\|false/);
});

test('system configuration is reused and an environment variable overrides it without rewriting it', async () => {
  const config = join(root, 'etc', 'docker.env');
  const before = await readFile(config, 'utf8');
  await writeFile(calls, '');
  const result = run({ EASYNOTE_DOCKER_CONFIG: config, EASYNOTE_PORT: '9999' }, ['--check']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /port:\s+127\.0\.0\.1:9999/);
  assert.equal(await readFile(config, 'utf8'), before);
  assert.match(await readFile(calls, 'utf8'), /compose config --quiet\|[^|]+\|9999\|https:\/\/notes\.example\.test/);
});

test('invalid persistent paths are rejected before Docker is called', async () => {
  await writeFile(calls, '');
  const result = run({
    EASYNOTE_DOCKER_CONFIG: join(root, 'another.env'),
    EASYNOTE_DATA_DIR: 'relative/data',
  }, ['--check']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /EASYNOTE_DATA_DIR must be an absolute directory/);
  assert.equal(await readFile(calls, 'utf8'), '');
});
