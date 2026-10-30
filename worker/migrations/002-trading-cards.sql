-- Trading cards: who owns what.
--
--   npx wrangler d1 execute fge --remote --file=./migrations/002-trading-cards.sql
--
-- Or just push this file — the Migrate workflow runs anything that changes
-- under worker/migrations/.
--
-- Uses CREATE TABLE IF NOT EXISTS rather than DROP, because unlike
-- race_control these hold people's collections. Running it twice is safe and
-- destroys nothing.

CREATE TABLE IF NOT EXISTS card_collection (
  user_id   TEXT    NOT NULL,          -- Discord user id; Discord is the login
  class     TEXT    NOT NULL,          -- gt3 | gt4, separate sets
  driver_id TEXT    NOT NULL,
  rarity    TEXT    NOT NULL,          -- as it was when last pulled
  copies    INTEGER NOT NULL DEFAULT 1,
  first_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, class, driver_id)
);

-- Collector leaderboard reads by class.
CREATE INDEX IF NOT EXISTS idx_cards_class ON card_collection (class, user_id);

CREATE TABLE IF NOT EXISTS card_packs (
  user_id     TEXT    PRIMARY KEY,
  last_opened INTEGER NOT NULL,        -- drives the 8 hour cooldown
  total_packs INTEGER NOT NULL DEFAULT 0,
  total_cards INTEGER NOT NULL DEFAULT 0
);
