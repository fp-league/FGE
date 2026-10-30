-- Adds the race_control table to a Worker that is already deployed.
--
-- Run this, NOT schema.sql: schema.sql rebuilds every table from scratch and
-- would throw away the DOTD votes and fantasy entries along the way.
--
--   npx wrangler d1 execute fge --remote --file=./migrations/001-race-control.sql
--
-- Safe to run as many times as you like. race_control holds nothing but
-- "what is happening right now", so dropping it costs nothing — it just ends
-- any session that happened to be open.

DROP TABLE IF EXISTS race_control;
CREATE TABLE race_control (
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

INSERT INTO race_control (id, mode, status, updated_at) VALUES ('live', 'race', 'idle', 0);

-- Applied via GitHub Actions on first run of the Migrate workflow.
