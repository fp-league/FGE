-- Adds the race_control table to a Worker that is already deployed.
--
-- Run this, NOT schema.sql: schema.sql rebuilds every table from scratch and
-- would throw away the DOTD votes and fantasy entries along the way.
--
--   npx wrangler d1 execute fge --remote --file=./migrations/001-race-control.sql
--
-- Safe to run as many times as you like, and non-destructive: every
-- migration is re-run whenever any of them changes, and dropping this table
-- would end a session that happened to be live at the time.

CREATE TABLE IF NOT EXISTS race_control (
  id           TEXT    PRIMARY KEY,     -- always 'live'
  class        TEXT,                    -- gt3 | gt4
  mode         TEXT,                    -- race | quali
  round        INTEGER,
  race_name    TEXT,
  track        TEXT,
  status       TEXT    NOT NULL,        -- idle|formation|green|sc|vsc|red|chequered|finished
  message      TEXT,
  lights_out   INTEGER,                 -- unix ms, when the session starts
  duration_min INTEGER,
  running      TEXT,                    -- JSON array of the running order
  updated_at   INTEGER NOT NULL
);

INSERT OR IGNORE INTO race_control (id, mode, status, updated_at) VALUES ('live', 'race', 'idle', 0);
