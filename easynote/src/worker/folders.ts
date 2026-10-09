import { idPattern, type Folder } from '../shared/types';
import type { Identity } from './auth';
import { ApiError, json, readJson, type Env } from './core';
import { publishNoteChanges } from './events';

interface FolderRow {
  id: string;
  name: string;
  parent_id: string | null;
  created_at: number;
  updated_at: number;
  note_count: number;
}

const toFolder = (row: FolderRow): Folder => ({
  id: row.id,
  name: row.name,
  parentId: row.parent_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  noteCount: row.note_count,
});

function folderName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 120 || /[\/\\\u0000-\u001f]/.test(name)) {
    throw new ApiError(400, 'Folder names must be 1-120 characters and cannot contain slashes or control characters.');
  }
  return name;
}

function parentId(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !idPattern.test(value)) throw new ApiError(400, 'Invalid parent folder.');
  return value;
}

async function ownedFolder(env: Env, userId: string, id: string): Promise<boolean> {
  return !!await env.DB.prepare('SELECT 1 FROM folders WHERE id=? AND user_id=?').bind(id, userId).first();
}

export async function listFolders(env: Env, userId: string): Promise<Folder[]> {
  const rows = await env.DB.prepare(`SELECT f.id,f.name,f.parent_id,f.created_at,f.updated_at,
    COUNT(n.id) AS note_count FROM folders f LEFT JOIN notes n
      ON n.folder_id=f.id AND n.user_id=f.user_id AND n.deleted_at IS NULL
    WHERE f.user_id=? GROUP BY f.id ORDER BY f.name COLLATE NOCASE,f.id`)
    .bind(userId).all<FolderRow>();
  return rows.results.map(toFolder);
}

export async function folderRoutes(request: Request, env: Env, user: Identity, path: string): Promise<Response | null> {
  if (path === '/api/folders' && request.method === 'GET') return json({ folders: await listFolders(env, user.id) });
  if (path === '/api/folders' && request.method === 'POST') {
    const data = await readJson(request, 4096);
    if (Object.keys(data).some((key) => !['id', 'name', 'parentId'].includes(key)) ||
        typeof data.id !== 'string' || !idPattern.test(data.id)) throw new ApiError(400, 'Invalid folder fields.');
    const name = folderName(data.name);
    const parent = parentId(data.parentId ?? null);
    if (parent && !await ownedFolder(env, user.id, parent)) throw new ApiError(404, 'Parent folder not found.');
    const now = Date.now();
    try {
      await env.DB.prepare('INSERT INTO folders(id,user_id,parent_id,name,created_at,updated_at) VALUES(?,?,?,?,?,?)')
        .bind(data.id, user.id, parent, name, now, now).run();
    } catch {
      throw new ApiError(409, 'A folder with this name already exists in that location.');
    }
    await publishNoteChanges(env, user.id, request);
    return json({ folder: { id: data.id, name, parentId: parent, createdAt: now, updatedAt: now, noteCount: 0 } satisfies Folder }, 201);
  }
  const mergeMatch = /^\/api\/folders\/([^/]+)\/merge$/.exec(path);
  if (mergeMatch && request.method === 'POST') {
    const id = mergeMatch[1];
    if (!idPattern.test(id) || !await ownedFolder(env, user.id, id)) throw new ApiError(404, 'Folder not found.');
    const data = await readJson(request, 4096);
    if (Object.keys(data).some((key) => key !== 'targetId')) throw new ApiError(400, 'Invalid merge fields.');
    const target = parentId(data.targetId);
    if (!target || target === id) throw new ApiError(409, 'Choose a different target folder.');
    if (!await ownedFolder(env, user.id, target)) throw new ApiError(404, 'Target folder not found.');
    const descendant = await env.DB.prepare(`WITH RECURSIVE descendants(id) AS (
      SELECT id FROM folders WHERE parent_id=? AND user_id=?
      UNION ALL SELECT f.id FROM folders f JOIN descendants d ON f.parent_id=d.id WHERE f.user_id=?
    ) SELECT 1 FROM descendants WHERE id=?`).bind(id, user.id, user.id, target).first();
    if (descendant) throw new ApiError(409, 'A folder cannot be merged into one of its descendants.');
    const collision = await env.DB.prepare(`SELECT 1 FROM folders source_child JOIN folders target_child
      ON target_child.user_id=source_child.user_id AND target_child.parent_id=?
      AND target_child.name=source_child.name COLLATE NOCASE
      WHERE source_child.user_id=? AND source_child.parent_id=? LIMIT 1`)
      .bind(target, user.id, id).first();
    if (collision) throw new ApiError(409, 'A child folder with the same name already exists in the target folder.');
    const now = Date.now();
    const mutation = crypto.randomUUID();
    const results = await env.DB.batch([
      env.DB.prepare(`UPDATE notes SET deleted_at=? WHERE user_id=? AND folder_id=?
        AND title='' AND content='' AND tags='[]' AND archived=0 AND deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM notes target_note WHERE target_note.user_id=? AND target_note.folder_id=?
          AND target_note.title='' AND target_note.content='' AND target_note.tags='[]'
          AND target_note.archived=0 AND target_note.deleted_at IS NULL)`)
        .bind(now, user.id, id, user.id, target),
      env.DB.prepare(`UPDATE notes SET folder_id=?,updated_at=?,revision=revision+1,mutation_id=?,mutation_hash=?
        WHERE user_id=? AND folder_id=?`).bind(target, now, mutation, mutation, user.id, id),
      env.DB.prepare(`INSERT INTO note_changes(user_id,note_id,changed_at)
        SELECT user_id,id,? FROM notes WHERE user_id=? AND mutation_id=?`).bind(now, user.id, mutation),
      env.DB.prepare('UPDATE folders SET parent_id=?,updated_at=? WHERE user_id=? AND parent_id=?')
        .bind(target, now, user.id, id),
      env.DB.prepare('DELETE FROM folders WHERE id=? AND user_id=?').bind(id, user.id),
    ]);
    if (!results[4].meta.changes) throw new ApiError(404, 'Folder not found.');
    await publishNoteChanges(env, user.id, request);
    return json({
      ok: true,
      movedNotes: results[1].meta.changes ?? 0,
      movedFolders: results[3].meta.changes ?? 0,
    });
  }
  const match = /^\/api\/folders\/([^/]+)$/.exec(path);
  if (!match) return null;
  const id = match[1];
  if (!idPattern.test(id) || !await ownedFolder(env, user.id, id)) throw new ApiError(404, 'Folder not found.');
  if (request.method === 'PATCH') {
    const data = await readJson(request, 4096);
    if (!Object.keys(data).length || Object.keys(data).some((key) => !['name', 'parentId'].includes(key))) {
      throw new ApiError(400, 'Invalid folder fields.');
    }
    const current = await env.DB.prepare('SELECT name,parent_id FROM folders WHERE id=? AND user_id=?')
      .bind(id, user.id).first<{ name: string; parent_id: string | null }>();
    const name = data.name === undefined ? current!.name : folderName(data.name);
    const parent = data.parentId === undefined ? current!.parent_id : parentId(data.parentId);
    if (parent === id) throw new ApiError(409, 'A folder cannot contain itself.');
    if (parent) {
      if (!await ownedFolder(env, user.id, parent)) throw new ApiError(404, 'Parent folder not found.');
      const cycle = await env.DB.prepare(`WITH RECURSIVE descendants(id) AS (
        SELECT id FROM folders WHERE parent_id=? AND user_id=?
        UNION ALL SELECT f.id FROM folders f JOIN descendants d ON f.parent_id=d.id WHERE f.user_id=?
      ) SELECT 1 FROM descendants WHERE id=?`).bind(id, user.id, user.id, parent).first();
      if (cycle) throw new ApiError(409, 'A folder cannot be moved inside one of its descendants.');
    }
    const now = Date.now();
    try {
      await env.DB.prepare('UPDATE folders SET name=?,parent_id=?,updated_at=? WHERE id=? AND user_id=?')
        .bind(name, parent, now, id, user.id).run();
    } catch {
      throw new ApiError(409, 'A folder with this name already exists in that location.');
    }
    await publishNoteChanges(env, user.id, request);
    const folder = (await listFolders(env, user.id)).find((item) => item.id === id)!;
    return json({ folder });
  }
  if (request.method === 'DELETE') {
    const now = Date.now();
    const mutation = crypto.randomUUID();
    const results = await env.DB.batch([
      env.DB.prepare(`WITH RECURSIVE tree(id) AS (
        SELECT id FROM folders WHERE id=? AND user_id=?
        UNION ALL SELECT f.id FROM folders f JOIN tree t ON f.parent_id=t.id WHERE f.user_id=?
      ) UPDATE notes SET deleted_at=? WHERE user_id=? AND folder_id IN (SELECT id FROM tree)
        AND title='' AND content='' AND tags='[]' AND archived=0 AND deleted_at IS NULL`)
        .bind(id, user.id, user.id, now, user.id),
      env.DB.prepare(`WITH RECURSIVE tree(id) AS (
        SELECT id FROM folders WHERE id=? AND user_id=?
        UNION ALL SELECT f.id FROM folders f JOIN tree t ON f.parent_id=t.id WHERE f.user_id=?
      ) UPDATE notes SET folder_id=NULL,updated_at=?,revision=revision+1,mutation_id=?,mutation_hash=?
        WHERE user_id=? AND folder_id IN (SELECT id FROM tree)`)
        .bind(id, user.id, user.id, now, mutation, mutation, user.id),
      env.DB.prepare(`INSERT INTO note_changes(user_id,note_id,changed_at)
        SELECT user_id,id,? FROM notes WHERE user_id=? AND mutation_id=?`).bind(now, user.id, mutation),
      env.DB.prepare('DELETE FROM folders WHERE id=? AND user_id=?').bind(id, user.id),
    ]);
    if (!results[3].meta.changes) throw new ApiError(404, 'Folder not found.');
    await publishNoteChanges(env, user.id, request);
    return json({ ok: true, movedNotes: results[1].meta.changes ?? 0 });
  }
  return null;
}
