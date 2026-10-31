-- Card seasons.
--
-- Rarity is earned from the championship, so when a season ends and the
-- results are archived the whole set re-rates itself to Common overnight.
-- Collections, though, just carry on — which is a decision nobody has
-- actually made.
--
-- This records it. A card season can be archived (everyone keeps what they
-- have, but there is a record of how it stood) or archived and cleared
-- (everyone starts again). The snapshot is what makes the second one
-- survivable.

CREATE TABLE IF NOT EXISTS card_season (
  id        TEXT PRIMARY KEY,
  name      TEXT    NOT NULL,
  ended_at  INTEGER NOT NULL,
  cleared   INTEGER NOT NULL DEFAULT 0,   -- were collections wiped
  holders   INTEGER NOT NULL DEFAULT 0,
  cards     INTEGER NOT NULL DEFAULT 0,
  top       TEXT    NOT NULL DEFAULT '[]' -- JSON: the leading collectors
);

-- Who held what when the season ended. One row per person per card, same
-- shape as card_collection so it can be read back the same way.
CREATE TABLE IF NOT EXISTS card_season_holding (
  season_id TEXT    NOT NULL,
  user_id   TEXT    NOT NULL,
  driver_id TEXT    NOT NULL,
  rarity    TEXT    NOT NULL,
  copies    INTEGER NOT NULL,
  PRIMARY KEY (season_id, user_id, driver_id)
);

CREATE INDEX IF NOT EXISTS idx_cs_holding ON card_season_holding (season_id, user_id);
