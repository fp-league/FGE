-- Rarities become data.
--
-- The five tiers were a constant in cards.js, repeated in economy.js, in
-- app.js and three times over in manage.html. Adding a sixth meant editing
-- four files and a deploy, which is not something a league admin should
-- have to ask for.
--
-- `sort` is the ladder, ascending, so the commonest is lowest — the same
-- order the code already relies on when it asks whether one card is rarer
-- than another. The built-ins are spaced ten apart so a new tier can be
-- slotted between two existing ones without renumbering anything.
--
-- `built_in` marks the five that driver cards are computed against: a
-- championship leader is Legendary by name, so those five cannot be
-- deleted. They can be renamed, recoloured and repriced freely.
--
-- Every statement is IF NOT EXISTS / INSERT OR IGNORE, because the Migrate
-- workflow replays every file whenever any one of them changes and these
-- rows decide what people's collections are worth.

CREATE TABLE IF NOT EXISTS rarity (
  id       TEXT    PRIMARY KEY,            -- slug, used in card_collection.rarity
  label    TEXT    NOT NULL,
  colour   TEXT    NOT NULL DEFAULT '#9E9E9E',   -- hex; the site and Discord both use it
  icon     TEXT    NOT NULL DEFAULT '⚪',         -- shown beside the name in Discord
  weight   INTEGER NOT NULL DEFAULT 10,          -- default pack odds when a pack sets none
  sort     INTEGER NOT NULL DEFAULT 50,          -- the ladder: ascending, commonest first
  sell     INTEGER NOT NULL DEFAULT 25,          -- default credits for a duplicate
  built_in INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO rarity (id, label, colour, icon, weight, sort, sell, built_in) VALUES
  ('common',    'Common',    '#9E9E9E', '⚪', 50, 10,  25, 1),
  ('uncommon',  'Uncommon',  '#4CAF50', '🟢', 28, 20,  60, 1),
  ('rare',      'Rare',      '#2196F3', '🔵', 15, 30, 140, 1),
  ('epic',      'Epic',      '#9C27B0', '🟣',  6, 40, 350, 1),
  ('legendary', 'Legendary', '#FFC400', '🟡',  1, 50, 900, 1);

-- The five above must stay undeletable even if an older copy of this file
-- inserted them without the flag.
UPDATE rarity SET built_in = 1
 WHERE id IN ('common', 'uncommon', 'rare', 'epic', 'legendary');
