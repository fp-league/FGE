-- Card trading.
--
-- Duplicates can only be sold back to the house, which makes a spare
-- Legendary worth exactly 900 and nothing else. Trading makes a collection
-- something two people can work on.
--
-- An offer is a row rather than a message, so it survives the bot
-- restarting and can be answered an hour later. Nothing moves until the
-- other person accepts.

CREATE TABLE IF NOT EXISTS trade (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user  TEXT    NOT NULL,
  to_user    TEXT    NOT NULL,
  give_card  TEXT    NOT NULL,      -- card id the offerer hands over
  want_card  TEXT    NOT NULL,      -- card id they want back
  status     TEXT    NOT NULL DEFAULT 'open',   -- open | done | declined | cancelled | dead
  created_at INTEGER NOT NULL,
  closed_at  INTEGER
);

-- Answering an offer means finding the open ones addressed to you.
CREATE INDEX IF NOT EXISTS idx_trade_to   ON trade (to_user, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trade_from ON trade (from_user, status, created_at DESC);
