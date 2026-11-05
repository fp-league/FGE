-- Giving someone a particular pack.
--
-- card_grants is a plain counter: an admin could hand out packs, but not
-- say which kind, so a reward for winning a race opened with the same odds
-- as the free 8-hourly one. That made "here, have a Podium Pack" something
-- an admin could not actually do.
--
-- A separate queue rather than a column on card_grants, because the two
-- behave differently and conflating them would mean picking an arbitrary
-- type for every generic grant already sitting in the old table. Generic
-- grants keep working exactly as they did; typed ones are spent first,
-- since they are the ones someone was deliberately given.
--
-- Safe to re-run: the Migrate workflow replays every file whenever any one
-- of them changes, and this holds things people have been promised.

CREATE TABLE IF NOT EXISTS pack_grant (
  user_id    TEXT    NOT NULL,
  pack_id    TEXT    NOT NULL,          -- pack_type.id
  packs      INTEGER NOT NULL DEFAULT 0, -- waiting to be opened
  total      INTEGER NOT NULL DEFAULT 0, -- ever given, never goes down
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, pack_id)
);

CREATE INDEX IF NOT EXISTS idx_pack_grant_user ON pack_grant (user_id);
