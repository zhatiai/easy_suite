ALTER TABLE images ADD COLUMN board_revision INTEGER;
ALTER TABLE images ADD COLUMN board_folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL;
CREATE INDEX images_whiteboards ON images(user_id, board_folder_id) WHERE board_revision IS NOT NULL;
