-- A book on a race.
--
-- Decimal odds throughout: 3.50 means a winning stake comes back three and
-- a half times, stake included. One number, no fractions to parse, and the
-- implied chance is just 1/odds — which is what makes the repricing below
-- arithmetic rather than guesswork.
--
-- Odds are stored per runner and also on each bet. A price that moves after
-- someone has backed it must not change what they are owed, so the bet
-- carries the number it was struck at and settlement never looks at the
-- board again.
--
-- Stakes leave the wallet when a bet is placed. Settlement only ever pays
-- in, so a book that is settled twice cannot take money a second time —
-- and the `settled` flag on each row means it cannot pay twice either.

CREATE TABLE IF NOT EXISTS book (
  id         TEXT    PRIMARY KEY,          -- '<class>-r<round>'
  cls        TEXT    NOT NULL,
  round      INTEGER NOT NULL,
  race       TEXT    NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'open',   -- open | closed | settled
  -- The overround, as a percentage. 100 is a fair book that pays out
  -- exactly what it takes; 115 keeps roughly thirteen percent.
  margin     INTEGER NOT NULL DEFAULT 115,
  opened_at  INTEGER NOT NULL,
  priced_at  INTEGER NOT NULL DEFAULT 0,   -- last time the hourly cron moved it
  settled_at INTEGER,
  winner     TEXT
);

CREATE TABLE IF NOT EXISTS book_runner (
  book_id   TEXT NOT NULL,
  driver_id TEXT NOT NULL,
  name      TEXT NOT NULL,
  open_odds REAL NOT NULL,                 -- what the admin set, kept for reference
  odds      REAL NOT NULL,                 -- what is showing now
  staked    INTEGER NOT NULL DEFAULT 0,    -- how much is on, which is what moves the price
  PRIMARY KEY (book_id, driver_id)
);

CREATE TABLE IF NOT EXISTS book_bet (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id   TEXT    NOT NULL,
  user_id   TEXT    NOT NULL,
  driver_id TEXT    NOT NULL,
  stake     INTEGER NOT NULL,
  odds      REAL    NOT NULL,              -- struck at placement, never revisited
  at        INTEGER NOT NULL,
  settled   INTEGER NOT NULL DEFAULT 0,
  won       INTEGER NOT NULL DEFAULT 0,
  returned  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_bet_book ON book_bet (book_id, settled);
CREATE INDEX IF NOT EXISTS idx_bet_user ON book_bet (user_id, at DESC);
