-- FGE economy.
--
-- Packs stop being a thing you wait eight hours for and become a thing you
-- buy. Credits come from working, from the daily, from race prize money and
-- from selling duplicates; they go out on packs. Everything an admin would
-- want to change later — prices, odds, payouts, the cards themselves — lives
-- in a table rather than in the code, so adding a new pack is filling in a
-- form instead of a deploy.
--
-- Every statement is IF NOT EXISTS / INSERT OR IGNORE, because the Migrate
-- workflow re-runs every file whenever any one of them changes, and these
-- hold people's money.

-- ── Money ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wallet (
  user_id    TEXT    PRIMARY KEY,         -- Discord user id; Discord is the login
  balance    INTEGER NOT NULL DEFAULT 0,
  lifetime   INTEGER NOT NULL DEFAULT 0,  -- ever earned, never goes down
  updated_at INTEGER NOT NULL
);

-- Why a balance is what it is. Answers "where did my money go", and makes a
-- wrong balance a thing you can look at rather than a thing you argue about.
CREATE TABLE IF NOT EXISTS ledger (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT    NOT NULL,
  delta   INTEGER NOT NULL,               -- signed; negative is a spend
  reason  TEXT    NOT NULL,
  at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger (user_id, at DESC);

-- ── Working for it ───────────────────────────────────────
-- Editable from the admin panel. Pay is a range so the same job isn't the
-- same number every time.
CREATE TABLE IF NOT EXISTS job (
  id           TEXT    PRIMARY KEY,
  name         TEXT    NOT NULL,
  emoji        TEXT    NOT NULL DEFAULT '🔧',
  blurb        TEXT    NOT NULL DEFAULT '',
  min_pay      INTEGER NOT NULL,
  max_pay      INTEGER NOT NULL,
  cooldown_min INTEGER NOT NULL,          -- minutes between shifts
  enabled      INTEGER NOT NULL DEFAULT 1,
  sort         INTEGER NOT NULL DEFAULT 0
);

-- One row per person per job, so each job has its own clock. 'daily' is a
-- job like any other; its streak lives in `times`.
CREATE TABLE IF NOT EXISTS work_log (
  user_id TEXT    NOT NULL,
  job     TEXT    NOT NULL,
  last_at INTEGER NOT NULL,
  times   INTEGER NOT NULL DEFAULT 0,
  earned  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, job)
);

INSERT OR IGNORE INTO job (id, name, emoji, blurb, min_pay, max_pay, cooldown_min, sort) VALUES
  ('detail',  'Detail the car',      '🧽', 'Twenty minutes and a bucket.',             15,  45,   20, 10),
  ('setup',   'Sell a setup',        '📐', 'Someone will buy anything before a race.', 30,  80,   45, 20),
  ('pitcrew', 'Pit crew shift',      '🔧', 'Wheel gun, four corners, no mistakes.',    60, 130,   90, 30),
  ('marshal', 'Marshal a session',   '🚩', 'Flags, gravel traps and other people''s crashes.', 90, 180, 150, 40),
  ('commentate', 'Commentate a race','🎙', 'Talk for ninety minutes about nothing.',  150, 320,  300, 50);

-- ── Packs you can buy ────────────────────────────────────
-- odds / pool are JSON text, null meaning "use the default".
--   odds      {"common":50,"uncommon":28,"rare":15,"epic":6,"legendary":1}
--   pool      ["driverId","c:custom-id"]  — restricts what can come out
--   guarantee "rare"  — at least one card of this rarity or better
CREATE TABLE IF NOT EXISTS pack_type (
  id         TEXT    PRIMARY KEY,
  name       TEXT    NOT NULL,
  emoji      TEXT    NOT NULL DEFAULT '🃏',
  blurb      TEXT    NOT NULL DEFAULT '',
  price      INTEGER NOT NULL,
  size       INTEGER NOT NULL DEFAULT 5,
  class      TEXT    NOT NULL DEFAULT 'gt3',   -- gt3 | gt4
  odds       TEXT,
  guarantee  TEXT,
  pool       TEXT,
  enabled    INTEGER NOT NULL DEFAULT 1,
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO pack_type (id, name, emoji, blurb, price, size, class, odds, guarantee, sort) VALUES
  ('gt3-standard', 'GT3 Pack',       '🃏', 'Five cards from the GT3 set.',      400, 5, 'gt3', NULL, NULL, 10),
  ('gt4-standard', 'GT4 Pack',       '🃏', 'Five cards from the GT4 set.',      400, 5, 'gt4', NULL, NULL, 20),
  ('gt3-premium',  'GT3 Premium',    '✨', 'Five cards, one Rare or better.',  1100, 5, 'gt3',
     '{"common":28,"uncommon":30,"rare":24,"epic":14,"legendary":4}', 'rare', 30),
  ('gt3-podium',   'Podium Pack',    '🏆', 'Three cards, one Epic or better.', 2500, 3, 'gt3',
     '{"common":0,"uncommon":20,"rare":42,"epic":28,"legendary":10}', 'epic', 40);

-- ── Cards that aren't drivers ────────────────────────────
-- Rarity is set by hand here, unlike driver cards, where it is earned from
-- the championship. Ids carry a 'c:' prefix everywhere so a custom card can
-- never collide with a driver id in card_collection.
CREATE TABLE IF NOT EXISTS custom_card (
  id         TEXT    PRIMARY KEY,         -- 'c:' + slug
  class      TEXT    NOT NULL DEFAULT 'gt3',
  name       TEXT    NOT NULL,
  subtitle   TEXT    NOT NULL DEFAULT '',
  rarity     TEXT    NOT NULL DEFAULT 'rare',
  image      TEXT    NOT NULL DEFAULT '',
  blurb      TEXT    NOT NULL DEFAULT '',
  enabled    INTEGER NOT NULL DEFAULT 1,
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0
);

-- ── Everything else that might want changing ─────────────
-- A key/value table rather than more columns, so the next thing that needs a
-- number doesn't need a migration.
CREATE TABLE IF NOT EXISTS econ_setting (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO econ_setting (key, value) VALUES
  ('currency_name',   'Credits'),
  ('currency_emoji',  '🪙'),
  ('starting_balance','750'),
  ('daily_amount',    '300'),
  ('daily_streak_bonus','75'),
  ('daily_streak_max','7'),
  -- Paid to drivers with a linked Discord account when a result is announced.
  ('prize_table',     '[1200,900,700,550,450,360,290,230,180,140]'),
  ('prize_finish',    '90'),
  ('prize_fastest',   '150'),
  -- What a duplicate is worth when sold back.
  ('sell_values',     '{"common":25,"uncommon":60,"rare":140,"epic":350,"legendary":900}'),
  ('pay_min',         '10'),
  ('pay_max',         '100000');
