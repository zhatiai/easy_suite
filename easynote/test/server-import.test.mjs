import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Miniflare } from 'miniflare';
import { importServerBackup } from '../scripts/server-import.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('portable backup imports folders, notes, shares and file bytes; refuses corruption and existing targets', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'easynote-import-'));
  const backup = path.join(root, 'backup');
  const target = path.join(root, 'data');
  const user = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const file = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const folder = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const note = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const bytes = Buffer.from('portable attachment');
  await mkdir(path.join(backup, 'objects', user), { recursive: true });
  const objectPath = path.join(backup, 'objects', user, file);
  await writeFile(objectPath, bytes);
  const migrationHash = createHash('sha256');
  let schema = '';
  for (const name of (await readdir('migrations')).filter((name) => name.endsWith('.sql')).sort()) {
    const content = await readFile(path.join('migrations', name));
    schema += content + '\n';
    migrationHash.update(name).update('\0').update(content).update('\0');
  }
  // Deliberately put children before parents, as a D1 dump may do.
  const sql = schema + `
INSERT INTO notes(id,user_id,title,content,dedup_hash,created_at,updated_at,mutation_id,mutation_hash,folder_id) VALUES('${note}','${user}','服务器迁移','persistent text','hash',1,1,'op','hash','${folder}');
INSERT INTO folders(id,user_id,parent_id,name,created_at,updated_at,description) VALUES('${folder}','${user}',NULL,'folder',1,1,'description');
INSERT INTO users(id,username,password_verifier,created_at,updated_at,role,approved_at) VALUES('${user}','tester','{}',1,1,'admin',1);
INSERT INTO "images" ("id","user_id","filename","mime","size","width","height","sha256","status","created_at","last_used_at") VALUES('${file}','${user}','test.txt','text/plain',${bytes.length},0,0,'${hash(bytes)}','ready',1,1);
INSERT INTO folder_shares(token_hash,folder_id,created_at) VALUES('token','${folder}',1);
INSERT INTO image_refs(note_id,image_id,revision) VALUES('${note}','${file}',1);
`;
  await writeFile(path.join(backup, 'database.sql'), sql);
  await writeFile(path.join(backup, 'manifest.json'), JSON.stringify({
    format: 'easynote-disaster-recovery', version: 1,
    database: { size: Buffer.byteLength(sql), sha256: hash(sql) }, migrationsSha256: migrationHash.digest('hex'),
    objects: [{ key: `${user}/${file}`, path: `objects/${user}/${file}`, size: bytes.length, sha256: hash(bytes), mime: 'text/plain' }],
  }));
  let runtime;
  try {
    await importServerBackup(backup, target, true);
    await assert.rejects(stat(target), /ENOENT/);
    await writeFile(objectPath, 'corrupt');
    await assert.rejects(importServerBackup(backup, target), /checksum/);
    await assert.rejects(stat(target), /ENOENT/);
    await writeFile(objectPath, bytes);
    await importServerBackup(backup, target);
    runtime = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response(); } }',
      host: '127.0.0.1', port: 0, cf: false, d1Databases: { DB: 'easynote-db' },
      d1Persist: path.join(target, 'state/d1'), r2Buckets: { IMAGES: 'easynote-images' }, r2Persist: path.join(target, 'state/r2') });
    const db = await runtime.getD1Database('DB');
    assert.equal((await db.prepare('SELECT folder_id FROM notes WHERE id=?').bind(note).first()).folder_id, folder);
    assert.equal((await db.prepare('SELECT description FROM folders WHERE id=?').bind(folder).first()).description, 'description');
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM folder_shares').first()).count, 1);
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM notes_fts WHERE notes_fts MATCH ?').bind('服务器').first()).count, 1);
    const bucket = await runtime.getR2Bucket('IMAGES');
    assert.equal(await (await bucket.get(`${user}/${file}`)).text(), bytes.toString());
    await assert.rejects(importServerBackup(backup, target), /state already exists/);
  } finally {
    await runtime?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
