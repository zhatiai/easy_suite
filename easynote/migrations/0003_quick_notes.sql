ALTER TABLE notes ADD COLUMN is_quick INTEGER NOT NULL DEFAULT 0 CHECK(is_quick IN (0, 1));

DROP INDEX notes_one_blank;
CREATE UNIQUE INDEX notes_one_blank ON notes(user_id, COALESCE(folder_id, ''))
  WHERE is_quick=0 AND title='' AND content='' AND tags='[]' AND archived=0 AND deleted_at IS NULL;

CREATE INDEX notes_quick ON notes(user_id, is_quick, deleted_at, archived, pinned DESC, updated_at DESC, id);
