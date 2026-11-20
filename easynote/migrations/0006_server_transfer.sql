ALTER TABLE images ADD COLUMN storage_key TEXT;
CREATE TABLE server_dataset (
  id INTEGER PRIMARY KEY CHECK(id=1),
  generation TEXT NOT NULL
);
INSERT INTO server_dataset VALUES(1, lower(hex(randomblob(16))));
