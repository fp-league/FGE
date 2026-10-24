-- FGE vote + fantasy store (Cloudflare D1 / SQLite)
--
-- The composite PRIMARY KEYs are the whole point: they make
-- "one vote per person per race" a database guarantee rather than
-- something the browser is politely asked to respect.

DROP TABLE IF EXISTS dotd_votes;
CREATE TABLE dotd_votes (
  class      TEXT    NOT NULL,          -- 'gt3' | 'gt4'
  race       TEXT    NOT NULL,          -- race round, as text
  voter      TEXT    NOT NULL,          -- salted hash of IP, never a raw IP
  driver     TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (class, race, voter)
);
CREATE INDEX idx_dotd_tally ON dotd_votes (class, race, driver);

DROP TABLE IF EXISTS fantasy_entries;
CREATE TABLE fantasy_entries (
  class      TEXT    NOT NULL,
  race       TEXT    NOT NULL,
  user_id    TEXT    NOT NULL,          -- from the browser, e.g. "jake_1699..."
  user_name  TEXT    NOT NULL,
  voter      TEXT    NOT NULL,          -- salted IP hash, used to cap sign-up spam
  winner     TEXT,                      -- predicted race winner
  fastest    TEXT,                      -- predicted fastest lap
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (class, race, user_id)
);
CREATE INDEX idx_fantasy_race  ON fantasy_entries (class, race);
CREATE INDEX idx_fantasy_voter ON fantasy_entries (class, race, voter);

-- Upload log. Only used for the per-IP rate limit and for seeing what's
-- in the bucket; the images themselves live in R2.
DROP TABLE IF EXISTS uploads;
CREATE TABLE uploads (
  key        TEXT    PRIMARY KEY,
  voter      TEXT    NOT NULL,
  bytes      INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_uploads_voter ON uploads (voter, created_at);

-- Live race control. One row, id 'live', holding the current session.
-- Kept as a single row rather than a log because the overlay and the site
-- only ever need "what is happening right now".
DROP TABLE IF EXISTS race_control;
CREATE TABLE race_control (
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
INSERT INTO race_control (id, status, updated_at) VALUES ('live', 'idle', 0);
