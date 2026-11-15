import { noteLinkIds } from '../shared/noteLinks';
import type { NoteLinkDirection, NoteLinkPage, NoteSummary } from '../shared/types';
import { ApiError, type Env } from './core';
import { loadNote, toNote, type NoteRow } from './notes';

const summary = (row: NoteRow): NoteSummary => {
  const { content, ...note } = toNote(row);
  return { ...note, excerpt: content.slice(0, 180) };
};

export async function noteLinks(
  env: Env, userId: string, id: string, direction: NoteLinkDirection, offset: number, limit: number,
): Promise<NoteLinkPage> {
  const current = await loadNote(env, userId, id);
  if (!current || current.deleted_at !== null) throw new ApiError(404, 'Note not found.');
  if (direction === 'outgoing') {
    const ids = noteLinkIds(current.content).filter((target) => target !== id.toLowerCase());
    const page = ids.slice(offset, offset + limit);
    if (!page.length) return { notes: [], missingIds: [], nextOffset: null };
    const rows = await env.DB.prepare(`SELECT id,title,substr(content,1,180) AS content,tags,pinned,is_quick,archived,
      folder_id,deleted_at,created_at,updated_at,revision FROM notes WHERE user_id=? AND deleted_at IS NULL
      AND id COLLATE NOCASE IN (SELECT value FROM json_each(?))`).bind(userId, JSON.stringify(page)).all<NoteRow>();
    const found = new Map(rows.results.map((row) => [row.id.toLowerCase(), row]));
    return {
      notes: page.flatMap((target) => { const row = found.get(target); return row ? [summary(row)] : []; }),
      missingIds: page.filter((target) => !found.has(target)),
      nextOffset: offset + limit < ids.length ? offset + limit : null,
    };
  }
  // The existing trigram index also covers notes written before link queries were introduced.
  const rows = await env.DB.prepare(`SELECT n.* FROM notes_fts JOIN notes n ON n.rowid=notes_fts.rowid
    WHERE notes_fts MATCH ? AND n.user_id=? AND n.deleted_at IS NULL AND n.id<>? COLLATE NOCASE
    ORDER BY n.updated_at DESC,n.id ASC LIMIT ? OFFSET ?`)
    .bind(`"${id}"`, userId, id, limit + 1, offset).all<NoteRow>();
  return {
    notes: rows.results.slice(0, limit).filter((row) => noteLinkIds(row.content).includes(id.toLowerCase())).map(summary),
    missingIds: [],
    nextOffset: rows.results.length > limit ? offset + limit : null,
  };
}
