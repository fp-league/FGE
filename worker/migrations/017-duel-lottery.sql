-- Two games that are not played against the house.
--
-- Everything in the casino so far is one person against the bank. These
-- are the two shapes that were missing: one against another person, and
-- everybody into the same pot.
--
-- Safe to re-run: the Migrate workflow replays every file whenever any
-- one of them changes, so this only ever creates and never alters.

-- ── Duels ────────────────────────────────────────────────
-- The challenger's stake leaves when the challenge is made, so a duel
-- can never be offered with money that is not there. The opponent's
-- leaves when they accept. `status` is also the lock: accepting is an
-- UPDATE guarded on 'open', so a double tap cannot take two stakes.
CREATE TABLE IF NOT EXISTS duel (
  id          TEXT    PRIMARY KEY,
  challenger  TEXT    NOT NULL,
  opponent    TEXT    NOT NULL,
  stake       INTEGER NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'open',  -- open|played|declined|expired
  winner      TEXT,
  detail      TEXT,                              -- JSON: what each side rolled
  at          INTEGER NOT NULL,
  decided_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_duel_open ON duel (status, at);
CREATE INDEX IF NOT EXISTS idx_duel_user ON duel (challenger, at DESC);

-- ── Lottery ──────────────────────────────────────────────
-- One row per draw. The pot is held here rather than summed from tickets
-- so that a rolled-over pot survives having no tickets of its own.
CREATE TABLE IF NOT EXISTS lottery_draw (
  n           INTEGER PRIMARY KEY,
  pot         INTEGER NOT NULL DEFAULT 0,
  status      TEXT    NOT NULL DEFAULT 'open',  -- open|drawn|rolled
  winner      TEXT,
  won         INTEGER,
  tickets     INTEGER,
  players     INTEGER,
  opened_at   INTEGER NOT NULL,
  drawn_at    INTEGER
);

-- One row per person per draw, not per ticket: a thousand tickets is one
-- row with a count, and the draw weights by that count.
CREATE TABLE IF NOT EXISTS lottery_ticket (
  draw        INTEGER NOT NULL,
  user_id     TEXT    NOT NULL,
  tickets     INTEGER NOT NULL DEFAULT 0,
  spent       INTEGER NOT NULL DEFAULT 0,
  at          INTEGER NOT NULL,
  PRIMARY KEY (draw, user_id)
);
CREATE INDEX IF NOT EXISTS idx_lottery_draw ON lottery_ticket (draw);
