CREATE TABLE folders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK(length(name) BETWEEN 1 AND 120)
);
CREATE UNIQUE INDEX folders_sibling_name ON folders(user_id, COALESCE(parent_id, ''), name COLLATE NOCASE);
CREATE INDEX folders_parent ON folders(user_id, parent_id, name COLLATE NOCASE);

ALTER TABLE notes ADD COLUMN folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL;
ALTER TABLE note_versions ADD COLUMN folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL;

DROP INDEX notes_one_blank;
CREATE UNIQUE INDEX notes_one_blank ON notes(user_id, COALESCE(folder_id, ''))
  WHERE title='' AND content='' AND tags='[]' AND archived=0 AND deleted_at IS NULL;
CREATE INDEX notes_folder ON notes(user_id, folder_id, deleted_at, archived, pinned DESC, updated_at DESC, id);
