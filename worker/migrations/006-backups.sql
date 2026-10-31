-- Daily backups.
--
-- One bad click in the admin panel currently overwrites a whole season and
-- there is nothing to go back to. A cron in the Worker takes a copy of the
-- league every day; this table is the index of what exists.
--
-- The snapshot itself lives in KV rather than here. A season's data runs to
-- most of a megabyte and D1 is the wrong shape for blobs, while the index
-- needs to be cheap to list and order — which is exactly what a table is
-- good at.

CREATE TABLE IF NOT EXISTS backup (
  key       TEXT PRIMARY KEY,          -- the KV key holding the snapshot
  taken_at  INTEGER NOT NULL,
  bytes     INTEGER NOT NULL,
  kind      TEXT NOT NULL DEFAULT 'auto',   -- auto | manual | pre-restore
  summary   TEXT NOT NULL DEFAULT ''        -- "GT3 34 drivers, 8 races · GT4 …"
);

CREATE INDEX IF NOT EXISTS idx_backup_at ON backup (taken_at DESC);
