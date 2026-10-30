-- Packs handed out by an admin, on top of the free one every 8 hours.
--
-- A separate table rather than a column on card_packs, because SQLite has no
-- ALTER TABLE ... ADD COLUMN IF NOT EXISTS, and every migration re-runs
-- whenever any of them changes. A new table with IF NOT EXISTS is safe to
-- apply any number of times; an ALTER would fail on the second run.

CREATE TABLE IF NOT EXISTS card_grants (
  user_id    TEXT    PRIMARY KEY,
  packs      INTEGER NOT NULL DEFAULT 0,   -- unopened, waiting for them
  total      INTEGER NOT NULL DEFAULT 0,   -- ever granted, for the record
  updated_at INTEGER NOT NULL
);
