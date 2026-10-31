-- Past seasons.
--
-- Season 3 buries Seasons 1 and 2: the site only ever shows the current
-- one, and the bin only ever holds it. This is where finished seasons go.
--
-- They live here rather than in the league record because the bin is capped
-- at a megabyte and a season is most of 40KB — a few years of them would
-- quietly fill it and the next save would fail. The full record goes to KV;
-- this table is the index, and it carries a precomputed summary so the
-- records page can add up every season without downloading every race ever
-- run.

CREATE TABLE IF NOT EXISTS season_archive (
  id        TEXT PRIMARY KEY,         -- slug of the season name
  class     TEXT NOT NULL,            -- gt3 | gt4, archived separately
  name      TEXT NOT NULL,
  ended_at  INTEGER NOT NULL,
  rounds    INTEGER NOT NULL DEFAULT 0,
  bytes     INTEGER NOT NULL DEFAULT 0,
  summary   TEXT NOT NULL DEFAULT '{}',  -- JSON from lib/season.js
  key       TEXT NOT NULL                -- the KV key holding the full record
);

CREATE INDEX IF NOT EXISTS idx_archive_class ON season_archive (class, ended_at DESC);
