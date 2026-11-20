import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, cp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

test('code fingerprints are path-independent, reflect source and lock changes, and do not retrigger unchanged builds', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'easynote-fingerprint-'));
  try {
    for (const checkout of ['first', 'second']) {
      const directory = path.join(root, checkout);
      for (const child of ['src/shared', 'public', 'migrations', 'scripts']) await mkdir(path.join(directory, child), { recursive: true });
      for (const name of ['package.json', 'package-lock.json', 'wrangler.json', 'vite.config.ts', 'src/main.ts']) await writeFile(path.join(directory, name), '{}');
      await cp(new URL('../scripts/fingerprint.mjs', import.meta.url), path.join(directory, 'scripts/fingerprint.mjs'));
    }
    const generate = (checkout) => execFileSync(process.execPath, ['scripts/fingerprint.mjs'], { cwd: path.join(root, checkout) });
    const output = (checkout) => path.join(root, checkout, 'src/shared/codeFingerprint.generated.ts');
    generate('first'); generate('second');
    const original = await readFile(output('first'), 'utf8');
    assert.equal(original, await readFile(output('second'), 'utf8'));
    const modifiedAt = (await stat(output('first'))).mtimeMs;
    generate('first');
    assert.equal((await stat(output('first'))).mtimeMs, modifiedAt);
    await writeFile(path.join(root, 'first/src/main.ts'), '[]');
    generate('first');
    const changed = await readFile(output('first'), 'utf8');
    assert.notEqual(changed, original);
    await writeFile(path.join(root, 'first/package-lock.json'), '[]');
    generate('first');
    assert.notEqual(await readFile(output('first'), 'utf8'), changed);
  } finally { await rm(root, { recursive: true, force: true }); }
});
