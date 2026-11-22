-- Ranked 1v1.
--
-- Two tables: one row per match in flight or finished, one row per person
-- holding their standing. IF NOT EXISTS throughout, because the migrate
-- workflow replays every file in this folder on each run.

CREATE TABLE IF NOT EXISTS ranked_match (
  id          TEXT PRIMARY KEY,
  challenger  TEXT NOT NULL,
  opponent    TEXT NOT NULL,
  -- open → live → done, or declined / expired from open.
  status      TEXT NOT NULL DEFAULT 'open',
  -- The whole battle state as JSON: lap number and both cars. Kept in one
  -- column because nothing ever queries inside it — it is read, played
  -- one lap, and written back.
  state       TEXT,
  -- This lap's hidden picks. NULL means not yet chosen, and the guarded
  -- UPDATE that sets one is what makes a double tap impossible.
  a_move      TEXT,
  b_move      TEXT,
  lap         INTEGER NOT NULL DEFAULT 1,
  winner      TEXT,
  at          INTEGER NOT NULL,
  decided_at  INTEGER
);

CREATE INDEX IF NOT EXISTS ranked_match_status ON ranked_match (status, at);

CREATE TABLE IF NOT EXISTS ranked_rating (
  user_id TEXT PRIMARY KEY,
  rating  INTEGER NOT NULL DEFAULT 1000,
  played  INTEGER NOT NULL DEFAULT 0,
  won     INTEGER NOT NULL DEFAULT 0,
  lost    INTEGER NOT NULL DEFAULT 0,
  drawn   INTEGER NOT NULL DEFAULT 0,
  -- Positive on a winning run, negative on a losing one, zero after a draw.
  streak  INTEGER NOT NULL DEFAULT 0,
  best    INTEGER NOT NULL DEFAULT 1000,
  at      INTEGER
);

CREATE INDEX IF NOT EXISTS ranked_rating_board ON ranked_rating (rating DESC);
