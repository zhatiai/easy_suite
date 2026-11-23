import { idPattern, type WhiteboardFile } from '../shared/types';
import type { Identity } from './auth';
import { ApiError, clientConfig, digest, json, numberSetting, readJson, type Env } from './core';
import { objectKey, type StoredFileRow } from './images';

type BoardRow = StoredFileRow & { board_revision: number; board_folder_id: string | null };
const metadata = (row: BoardRow): WhiteboardFile => ({
  id: row.id, name: row.filename, folderId: row.board_folder_id, revision: row.board_revision,
});

export async function whiteboardRoutes(request: Request, env: Env, user: Identity, path: string): Promise<Response | null> {
  if (path === '/api/whiteboards' && request.method === 'GET') {
    const rows = await env.DB.prepare(`SELECT id,filename,board_revision,board_folder_id FROM images
      WHERE user_id=? AND status='ready' AND board_revision IS NOT NULL ORDER BY filename,id`).bind(user.id).all<BoardRow>();
    return json({ boards: rows.results.map(metadata) });
  }
  const id = /^\/api\/whiteboards\/([^/]+)$/.exec(path)?.[1];
  if (!id || !idPattern.test(id)) return null;
  const row = await env.DB.prepare(`SELECT * FROM images WHERE id=? AND user_id=? AND status='ready'
    AND board_revision IS NOT NULL`).bind(id, user.id).first<BoardRow>();
  if (request.method === 'GET') {
    if (!row) throw new ApiError(404, 'Whiteboard not found.');
    const object = await env.IMAGES.get(objectKey(row));
    if (!object) throw new ApiError(404, 'Whiteboard file not found.');
    return new Response(object.body, { headers: {
      'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
      'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Whiteboard-Revision': String(row.board_revision),
      'X-Whiteboard-Name': encodeURIComponent(row.filename),
      'X-Whiteboard-Folder': row.board_folder_id ?? '',
    } });
  }
  if (request.method !== 'PUT' && request.method !== 'DELETE') return null;
  const limit = Math.min(clientConfig(env).maxAttachmentBytes, 5 * 1024 * 1024);
  const data = await readJson(request, request.method === 'DELETE' ? 1024 : limit + 4096);
  const revision = data.revision;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) {
    throw new ApiError(400, 'Invalid whiteboard revision.');
  }
  if (request.method === 'DELETE') {
    if (!row) throw new ApiError(404, 'Whiteboard not found.');
    const deleted = await env.DB.prepare("UPDATE images SET status='deleting' WHERE id=? AND user_id=? AND board_revision=? AND status='ready'")
      .bind(id, user.id, revision).run();
    if (!deleted.meta.changes) throw new ApiError(409, 'Whiteboard changed.');
    return json({ ok: true });
  }
  if (revision > 0 && !row) throw new ApiError(404, 'Whiteboard not found.');
  const { scene } = data;
  const folderId = row ? row.board_folder_id : data.folderId;
  const name = typeof data.name === 'string' ? data.name.trim() : '';
  if (name.length <= '.excalidraw'.length || name.length > 180 || !name.endsWith('.excalidraw') || /[/\\\u0000-\u001f]/.test(name) ||
      !(folderId === null || typeof folderId === 'string' && idPattern.test(folderId))) {
    throw new ApiError(400, 'Invalid whiteboard filename or folder.');
  }
  if (!scene || typeof scene !== 'object' || !('type' in scene) || scene.type !== 'excalidraw' ||
      !('version' in scene) || scene.version !== 2 || !('elements' in scene) || !Array.isArray(scene.elements)) {
    throw new ApiError(400, 'Invalid Excalidraw scene.');
  }
  const bytes = new TextEncoder().encode(JSON.stringify(scene));
  if (bytes.length > limit) throw new ApiError(413, 'Whiteboard exceeds the configured size limit.');
  const hash = await digest(bytes);
  if (row?.board_revision === revision + 1 && row.sha256 === hash && row.filename === name && row.board_folder_id === folderId) {
    return json(metadata(row));
  }
  if ((row?.board_revision ?? 0) !== revision) throw new ApiError(409, 'Whiteboard changed.');
  if (folderId && !await env.DB.prepare('SELECT 1 FROM folders WHERE id=? AND user_id=?').bind(folderId, user.id).first()) {
    throw new ApiError(404, 'Folder not found.');
  }
  const now = Date.now();
  const stagingId = crypto.randomUUID();
  const key = `${user.id}/${stagingId}`;
  // Track unpublished bytes in the existing cleanup queue before writing to R2.
  const staged = await env.DB.prepare(`INSERT INTO images
    (id,user_id,filename,mime,size,width,height,sha256,status,created_at,last_used_at,storage_key)
    SELECT ?,?,?,'application/json',?,0,0,?,'pending',?,?,?
    WHERE COALESCE((SELECT SUM(size) FROM images WHERE user_id=?),0)+?<=?`)
    .bind(stagingId, user.id, name, bytes.length, hash, now, now, key, user.id, bytes.length,
      numberSetting(env, 'IMAGE_QUOTA_BYTES', 1024, 10 * 1024 ** 3)).run();
  if (!staged.meta.changes) throw new ApiError(409, 'Storage quota exceeded.');
  try {
    await env.IMAGES.put(key, bytes, { httpMetadata: { contentType: 'application/json' } });
    const next: WhiteboardFile = { id, name, folderId, revision: revision + 1 };
    const hasFolder = '(? IS NULL OR EXISTS(SELECT 1 FROM folders WHERE id=? AND user_id=?))';
    const publish = row
      ? env.DB.prepare(`UPDATE images SET filename=?,size=?,sha256=?,last_used_at=?,storage_key=?,board_revision=?,board_folder_id=?
          WHERE id=? AND user_id=? AND board_revision=? AND status='ready' AND board_folder_id IS ? AND ${hasFolder}`)
          .bind(name, bytes.length, hash, now, key, next.revision, folderId, id, user.id, revision, folderId, folderId, folderId, user.id)
      : env.DB.prepare(`INSERT OR IGNORE INTO images
          (id,user_id,filename,mime,size,width,height,sha256,status,created_at,last_used_at,storage_key,board_revision,board_folder_id)
          SELECT ?,?,?,'application/json',?,0,0,?,'ready',?,?,?,?,? WHERE ${hasFolder}`)
          .bind(id, user.id, name, bytes.length, hash, now, now, key, next.revision, folderId, folderId, folderId, user.id);
    // Swap the staging row to the old object so both publication and reclamation survive interruption.
    const published = 'EXISTS(SELECT 1 FROM images WHERE id=? AND user_id=? AND storage_key=? AND status=\'ready\')';
    const retire = row
      ? env.DB.prepare(`UPDATE images SET status='deleting',storage_key=?,size=? WHERE id=? AND user_id=? AND ${published}`)
          .bind(objectKey(row), row.size, stagingId, user.id, id, user.id, key)
      : env.DB.prepare(`DELETE FROM images WHERE id=? AND user_id=? AND ${published}`)
          .bind(stagingId, user.id, id, user.id, key);
    const [result] = await env.DB.batch([publish, retire]);
    if (!result.meta.changes) throw new ApiError(409, 'Whiteboard or folder changed.');
    return json(next, row ? 200 : 201);
  } catch (error) {
    await env.DB.prepare("UPDATE images SET status='deleting' WHERE id=? AND user_id=? AND status='pending'")
      .bind(stagingId, user.id).run();
    throw error;
  }
}
