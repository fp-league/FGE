-- Stream graphics: the lower third, the fastest lap flash and the battle box.
--
-- A separate table rather than columns on race_control, because SQLite has
-- no ALTER TABLE ... ADD COLUMN IF NOT EXISTS and the Migrate workflow
-- replays every file whenever any of them changes. A new table with
-- IF NOT EXISTS is safe to apply any number of times; an ALTER would fail
-- on the second run and take the whole migration with it.
--
-- One row, like race_control. Each field is JSON or null — null meaning the
-- graphic is off, which is what the overlay shows almost all the time.

CREATE TABLE IF NOT EXISTS race_graphics (
  id         TEXT PRIMARY KEY,
  lower      TEXT,          -- {"driverId":"d_x"} — the name card
  flash      TEXT,          -- {"kind":"fastestlap","name":"…","time":"…","at":1730…}
  battle     TEXT,          -- {"a":"d_x","b":"d_y"}
  updated_at INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO race_graphics (id, updated_at) VALUES ('live', 0);
