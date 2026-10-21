import { unfinishedTasks } from '../shared/tasks';
import { idPattern, type SharedFolder, type SharedNote } from '../shared/types';
import type { Identity } from './auth';
import { ApiError, digest, json, numberSetting, readJson, token, type Env } from './core';
import { loadNote, toNote, type NoteRow } from './notes';
import type { StoredFileRow } from './images';

const shareTokenPattern = /^[a-f0-9]{64}$/;
const isImage = (mime: string) => ['image/jpeg', 'image/png', 'image/webp'].includes(mime);

function shareExpiryHours(data: Record<string, unknown>): number | null {
  const value = data.expiresInHours;
  if (Object.keys(data).some((key) => key !== 'expiresInHours') ||
      !(value === null || typeof value === 'number' && Number.isSafeInteger(value) &&
        value >= 1 && value <= 24 * 30)) {
    throw new ApiError(400, 'Share expiry must be permanent or between 1 and 720 hours.');
  }
  return value;
}

export async function featureRoutes(
  request: Request,
  env: Env,
  user: Identity,
  path: string,
): Promise<Response | null> {
  if (path === '/api/tasks' && request.method === 'GET') {
    const rows = await env.DB.prepare(`SELECT * FROM notes
      WHERE user_id=? AND deleted_at IS NULL ORDER BY updated_at DESC,id`).bind(user.id).all<NoteRow>();
    return json({ tasks: rows.results.flatMap((row) => unfinishedTasks(toNote(row))) });
  }

  if (path === '/api/storage' && request.method === 'GET') {
    const [notesRow, trashRow, versionsRow, filesRow] = await Promise.all([
      env.DB.prepare(`
        SELECT
          COUNT(*) AS noteCount,
          COALESCE(SUM(LENGTH(CAST(title AS BLOB)) + LENGTH(CAST(content AS BLOB)) + LENGTH(CAST(tags AS BLOB))), 0) AS notesBytes
        FROM notes
        WHERE user_id=? AND deleted_at IS NULL
      `).bind(user.id).first<{ noteCount: number; notesBytes: number }>(),

      env.DB.prepare(`
        SELECT
          COUNT(*) AS trashCount,
          COALESCE(SUM(LENGTH(CAST(title AS BLOB)) + LENGTH(CAST(content AS BLOB)) + LENGTH(CAST(tags AS BLOB))), 0) AS trashBytes
        FROM notes
        WHERE user_id=? AND deleted_at IS NOT NULL
      `).bind(user.id).first<{ trashCount: number; trashBytes: number }>(),

      env.DB.prepare(`
        SELECT
          COUNT(v.revision) AS versionCount,
          COALESCE(SUM(LENGTH(CAST(v.title AS BLOB)) + LENGTH(CAST(v.content AS BLOB)) + LENGTH(CAST(v.tags AS BLOB))), 0) AS versionsBytes
        FROM note_versions v
        JOIN notes n ON n.id=v.note_id
        WHERE n.user_id=?
      `).bind(user.id).first<{ versionCount: number; versionsBytes: number }>(),

      env.DB.prepare(
        "SELECT COUNT(*) AS fileCount, COALESCE(SUM(size), 0) AS filesBytes FROM images WHERE user_id=? AND status='ready'"
      ).bind(user.id).first<{ fileCount: number; filesBytes: number }>(),
    ]);

    const notesBytes = notesRow?.notesBytes ?? 0;
    const noteCount = notesRow?.noteCount ?? 0;
    const trashBytes = trashRow?.trashBytes ?? 0;
    const trashCount = trashRow?.trashCount ?? 0;
    const versionsBytes = versionsRow?.versionsBytes ?? 0;
    const versionCount = versionsRow?.versionCount ?? 0;
    const filesBytes = filesRow?.filesBytes ?? 0;
    const fileCount = filesRow?.fileCount ?? 0;

    const usedBytes = notesBytes + trashBytes + versionsBytes + filesBytes;
    const quotaBytes = numberSetting(env, 'IMAGE_QUOTA_BYTES', 1024, 10 * 1024 ** 3);
    const remainingBytes = Math.max(0, quotaBytes - usedBytes);
    const usedPercent = quotaBytes > 0 ? Math.min(100, Math.round((usedBytes / quotaBytes) * 1000) / 10) : 0;

    let d1DatabaseBytes: number | null = null;
    if (user.role === 'admin') {
      try {
        const pageCount = await env.DB.prepare('PRAGMA page_count').first<{ page_count: number }>();
        const pageSize = await env.DB.prepare('PRAGMA page_size').first<{ page_size: number }>();
        if (pageCount?.page_count && pageSize?.page_size) {
          d1DatabaseBytes = pageCount.page_count * pageSize.page_size;
        }
      } catch { /* ignore */ }
    }

    return json({
      usedBytes,
      quotaBytes,
      remainingBytes,
      usedPercent,
      notesBytes,
      noteCount,
      versionsBytes,
      versionCount,
      trashBytes,
      trashCount,
      filesBytes,
      fileCount,
      d1DatabaseBytes,
    });
  }

  if (path === '/api/shares' && request.method === 'GET') {
    const [noteRows, folderRows] = await Promise.all([
      env.DB.prepare(`SELECT s.note_id,s.created_at,s.expires_at,
        n.title,n.updated_at,n.archived
        FROM note_shares s JOIN notes n ON n.id=s.note_id
        WHERE n.user_id=? AND n.deleted_at IS NULL
          AND (s.expires_at IS NULL OR s.expires_at>?)
        ORDER BY s.expires_at IS NULL,s.expires_at,s.created_at DESC`)
        .bind(user.id, Date.now())
        .all<{
          note_id: string;
          created_at: number;
          expires_at: number | null;
          title: string;
          updated_at: number;
          archived: number;
        }>(),
      env.DB.prepare(`SELECT s.folder_id,s.created_at,s.expires_at,
        f.name,f.updated_at
        FROM folder_shares s JOIN folders f ON f.id=s.folder_id
        WHERE f.user_id=?
          AND (s.expires_at IS NULL OR s.expires_at>?)
        ORDER BY s.expires_at IS NULL,s.expires_at,s.created_at DESC`)
        .bind(user.id, Date.now())
        .all<{
          folder_id: string;
          created_at: number;
          expires_at: number | null;
          name: string;
          updated_at: number;
        }>(),
    ]);

    return json({
      shares: noteRows.results.map((row) => ({
        noteId: row.note_id,
        title: row.title,
        noteUpdatedAt: row.updated_at,
        archived: Boolean(row.archived),
        createdAt: row.created_at,
        expiresAt: row.expires_at,
      })),
      folderShares: folderRows.results.map((row) => ({
        folderId: row.folder_id,
        name: row.name,
        folderUpdatedAt: row.updated_at,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
      })),
    });
  }

  const noteMatch = /^\/api\/notes\/([^/]+)\/share$/.exec(path);
  if (noteMatch) {
    const noteId = noteMatch[1];
    if (!idPattern.test(noteId)) throw new ApiError(404, 'Note not found.');
    const note = await loadNote(env, user.id, noteId);
    if (!note || note.deleted_at !== null) throw new ApiError(404, 'Note not found.');

    if (request.method === 'GET') {
      const share = await env.DB.prepare(`SELECT created_at,expires_at FROM note_shares
        WHERE note_id=? AND (expires_at IS NULL OR expires_at>?)`).bind(noteId, Date.now())
        .first<{ created_at: number; expires_at: number | null }>();
      return json({
        share: share ? { createdAt: share.created_at, expiresAt: share.expires_at } : null,
      });
    }
    if (request.method === 'POST') {
      const data = await readJson(request, 1024);
      const expiresInHours = shareExpiryHours(data);
      const value = token();
      const now = Date.now();
      const expiresAt = expiresInHours === null ? null : now + expiresInHours * 3600_000;
      await env.DB.batch([
        env.DB.prepare('DELETE FROM note_shares WHERE note_id=?').bind(noteId),
        env.DB.prepare('INSERT INTO note_shares(token_hash,note_id,expires_at,created_at) VALUES(?,?,?,?)')
          .bind(await digest(value), noteId, expiresAt, now),
      ]);
      return json({
        share: { createdAt: now, expiresAt },
        url: `${new URL(request.url).origin}/shared/${value}`,
      }, 201);
    }
    if (request.method === 'PATCH') {
      const expiresInHours = shareExpiryHours(await readJson(request, 1024));
      const current = await env.DB.prepare(`SELECT created_at,expires_at FROM note_shares
        WHERE note_id=? AND (expires_at IS NULL OR expires_at>?)`).bind(noteId, Date.now())
        .first<{ created_at: number; expires_at: number | null }>();
      if (!current) throw new ApiError(404, 'Share link not found or expired.');
      const expiresAt = expiresInHours === null || current.expires_at === null
        ? null
        : current.expires_at + expiresInHours * 3600_000;
      await env.DB.prepare('UPDATE note_shares SET expires_at=? WHERE note_id=?')
        .bind(expiresAt, noteId).run();
      return json({ share: { createdAt: current.created_at, expiresAt } });
    }
    if (request.method === 'DELETE') {
      await env.DB.prepare(`DELETE FROM note_shares WHERE note_id=? AND EXISTS
        (SELECT 1 FROM notes WHERE id=? AND user_id=?)`).bind(noteId, noteId, user.id).run();
      return json({ ok: true });
    }
  }

  const folderMatch = /^\/api\/folders\/([^/]+)\/share$/.exec(path);
  if (folderMatch) {
    const folderId = folderMatch[1];
    if (!idPattern.test(folderId)) throw new ApiError(404, 'Folder not found.');
    const folder = await env.DB.prepare('SELECT id,name FROM folders WHERE id=? AND user_id=?')
      .bind(folderId, user.id).first<{ id: string; name: string }>();
    if (!folder) throw new ApiError(404, 'Folder not found.');

    if (request.method === 'GET') {
      const share = await env.DB.prepare(`SELECT created_at,expires_at FROM folder_shares
        WHERE folder_id=? AND (expires_at IS NULL OR expires_at>?)`).bind(folderId, Date.now())
        .first<{ created_at: number; expires_at: number | null }>();
      return json({
        share: share ? { createdAt: share.created_at, expiresAt: share.expires_at } : null,
      });
    }
    if (request.method === 'POST') {
      const data = await readJson(request, 1024);
      const expiresInHours = shareExpiryHours(data);
      const value = token();
      const now = Date.now();
      const expiresAt = expiresInHours === null ? null : now + expiresInHours * 3600_000;
      await env.DB.batch([
        env.DB.prepare('DELETE FROM folder_shares WHERE folder_id=?').bind(folderId),
        env.DB.prepare('INSERT INTO folder_shares(token_hash,folder_id,expires_at,created_at) VALUES(?,?,?,?)')
          .bind(await digest(value), folderId, expiresAt, now),
      ]);
      return json({
        share: { createdAt: now, expiresAt },
        url: `${new URL(request.url).origin}/shared/${value}`,
      }, 201);
    }
    if (request.method === 'PATCH') {
      const expiresInHours = shareExpiryHours(await readJson(request, 1024));
      const current = await env.DB.prepare(`SELECT created_at,expires_at FROM folder_shares
        WHERE folder_id=? AND (expires_at IS NULL OR expires_at>?)`).bind(folderId, Date.now())
        .first<{ created_at: number; expires_at: number | null }>();
      if (!current) throw new ApiError(404, 'Share link not found or expired.');
      const expiresAt = expiresInHours === null || current.expires_at === null
        ? null
        : current.expires_at + expiresInHours * 3600_000;
      await env.DB.prepare('UPDATE folder_shares SET expires_at=? WHERE folder_id=?')
        .bind(expiresAt, folderId).run();
      return json({ share: { createdAt: current.created_at, expiresAt } });
    }
    if (request.method === 'DELETE') {
      await env.DB.prepare(`DELETE FROM folder_shares WHERE folder_id=? AND EXISTS
        (SELECT 1 FROM folders WHERE id=? AND user_id=?)`).bind(folderId, folderId, user.id).run();
      return json({ ok: true });
    }
  }

  return null;
}

export async function publicShareRoutes(
  request: Request,
  env: Env,
  path: string,
): Promise<Response | null> {
  const shareMatch = /^\/api\/public\/shares\/([a-f0-9]{64})$/.exec(path);
  if (shareMatch && request.method === 'GET') {
    const rawToken = shareMatch[1];
    const hashedToken = await digest(rawToken);

    // 1. Try note share
    const noteRow = await env.DB.prepare(`SELECT n.*,s.expires_at AS share_expires_at
      FROM note_shares s JOIN notes n ON n.id=s.note_id
      JOIN users u ON u.id=n.user_id
      WHERE s.token_hash=? AND (s.expires_at IS NULL OR s.expires_at>?) AND n.deleted_at IS NULL
        AND u.enabled=1 AND u.deletion_requested_at IS NULL`)
      .bind(hashedToken, Date.now()).first<NoteRow & { share_expires_at: number | null }>();

    if (noteRow) {
      const note = toNote(noteRow);
      const publicPrefix = `/api/public/shares/${rawToken}`;
      const shared: SharedNote = {
        title: note.title,
        content: note.content.replace(
          /\/api\/(images|files)\/([0-9a-f-]{36})(?![0-9a-f-])/gi,
          (_source, kind: string, id: string) => `${publicPrefix}/${kind.toLowerCase()}/${id}`,
        ),
        tags: note.tags,
        updatedAt: note.updatedAt,
        expiresAt: noteRow.share_expires_at,
      };
      return json({ note: shared });
    }

    // 2. Try folder share
    const folderRow = await env.DB.prepare(`SELECT f.id,f.name,f.parent_id,f.user_id,s.expires_at AS share_expires_at
      FROM folder_shares s JOIN folders f ON f.id=s.folder_id
      JOIN users u ON u.id=f.user_id
      WHERE s.token_hash=? AND (s.expires_at IS NULL OR s.expires_at>?)
        AND u.enabled=1 AND u.deletion_requested_at IS NULL`)
      .bind(hashedToken, Date.now()).first<{
        id: string;
        name: string;
        parent_id: string | null;
        user_id: string;
        share_expires_at: number | null;
      }>();

    if (folderRow) {
      const [treeRows, noteRows] = await Promise.all([
        env.DB.prepare(`WITH RECURSIVE tree(id, parent_id, name) AS (
          SELECT id, parent_id, name FROM folders WHERE id=? AND user_id=?
          UNION ALL
          SELECT f.id, f.parent_id, f.name FROM folders f JOIN tree t ON f.parent_id=t.id
          WHERE f.user_id=?
        ) SELECT id, parent_id, name FROM tree`).bind(folderRow.id, folderRow.user_id, folderRow.user_id)
          .all<{ id: string; parent_id: string | null; name: string }>(),
        env.DB.prepare(`WITH RECURSIVE tree(id) AS (
          SELECT id FROM folders WHERE id=? AND user_id=?
          UNION ALL
          SELECT f.id FROM folders f JOIN tree t ON f.parent_id=t.id
          WHERE f.user_id=?
        )
        SELECT n.* FROM notes n
        WHERE n.user_id=? AND n.folder_id IN (SELECT id FROM tree)
          AND n.deleted_at IS NULL AND n.archived=0
        ORDER BY n.updated_at DESC`).bind(folderRow.id, folderRow.user_id, folderRow.user_id, folderRow.user_id)
          .all<NoteRow>(),
      ]);

      const publicPrefix = `/api/public/shares/${rawToken}`;
      const sharedFolder: SharedFolder = {
        id: folderRow.id,
        name: folderRow.name,
        expiresAt: folderRow.share_expires_at,
        folders: treeRows.results.map((r) => ({
          id: r.id,
          parentId: r.id === folderRow.id ? null : r.parent_id,
          name: r.name,
        })),
        notes: noteRows.results.map((r) => {
          const n = toNote(r);
          return {
            id: n.id,
            folderId: n.folderId,
            title: n.title,
            content: n.content.replace(
              /\/api\/(images|files)\/([0-9a-f-]{36})(?![0-9a-f-])/gi,
              (_source, kind: string, id: string) => `${publicPrefix}/${kind.toLowerCase()}/${id}`,
            ),
            tags: n.tags,
            updatedAt: n.updatedAt,
          };
        }),
      };
      return json({ folder: sharedFolder });
    }

    throw new ApiError(404, 'Share link not found or expired.');
  }

  const fileMatch = /^\/api\/public\/shares\/([a-f0-9]{64})\/(images|files)\/([0-9a-f-]{36})$/.exec(path);
  if (!fileMatch || request.method !== 'GET') return null;
  const [, rawToken, route, id] = fileMatch;
  if (!shareTokenPattern.test(rawToken) || !idPattern.test(id)) throw new ApiError(404, 'Shared file not found.');
  const hashedToken = await digest(rawToken);

  let row = await env.DB.prepare(`SELECT i.* FROM note_shares s
    JOIN notes n ON n.id=s.note_id
    JOIN users u ON u.id=n.user_id
    JOIN image_refs r ON r.note_id=n.id AND r.revision=n.revision
    JOIN images i ON i.id=r.image_id AND i.user_id=n.user_id
    WHERE s.token_hash=? AND (s.expires_at IS NULL OR s.expires_at>?) AND n.deleted_at IS NULL
      AND u.enabled=1 AND u.deletion_requested_at IS NULL
      AND i.id=? AND i.status='ready'`)
    .bind(hashedToken, Date.now(), id).first<StoredFileRow>();

  if (!row) {
    row = await env.DB.prepare(`WITH RECURSIVE tree(id) AS (
      SELECT f.id FROM folder_shares s JOIN folders f ON f.id=s.folder_id
      WHERE s.token_hash=? AND (s.expires_at IS NULL OR s.expires_at>?)
      UNION ALL
      SELECT f.id FROM folders f JOIN tree t ON f.parent_id=t.id
    )
    SELECT i.* FROM tree t
    JOIN notes n ON n.folder_id=t.id AND n.deleted_at IS NULL
    JOIN users u ON u.id=n.user_id AND u.enabled=1 AND u.deletion_requested_at IS NULL
    JOIN image_refs r ON r.note_id=n.id AND r.revision=n.revision
    JOIN images i ON i.id=r.image_id AND i.user_id=n.user_id
    WHERE i.id=? AND i.status='ready' LIMIT 1`)
      .bind(hashedToken, Date.now(), id).first<StoredFileRow>();
  }

  if (!row || route === 'images' && !isImage(row.mime)) throw new ApiError(404, 'Shared file not found.');
  const object = await env.IMAGES.get(`${row.user_id}/${row.id}`);
  if (!object) throw new ApiError(404, 'Shared file bytes not found.');
  return new Response(object.body, {
    headers: {
      'Content-Type': row.mime,
      'Content-Length': String(row.size),
      'Content-Disposition': `${route === 'images' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
    },
  });
}
