-- Adds the race_control table to a Worker that is already deployed.
--
-- schema.sql is the full build and starts by DROPping every table, so running
-- it again on a live database would throw away the votes. Run this instead:
--
--   npx wrangler d1 execute fge --remote --file=./migrations/001-race-control.sql
--
-- Safe to run twice: it creates nothing that already exists and the INSERT is
-- ignored once the 'live' row is there.

CREATE TABLE IF NOT EXISTS race_control (
  id           TEXT    PRIMARY KEY,     -- always 'live'
  class        TEXT,                    -- gt3 | gt4
  round        INTEGER,
  race_name    TEXT,
  track        TEXT,
  status       TEXT    NOT NULL,        -- idle|formation|green|sc|vsc|red|chequered|finished
  message      TEXT,
  lights_out   INTEGER,                 -- unix ms, when the race starts
  duration_min INTEGER,
  running      TEXT,                    -- JSON array of the running order
  updated_at   INTEGER NOT NULL
);

INSERT OR IGNORE INTO race_control (id, status, updated_at) VALUES ('live', 'idle', 0);
