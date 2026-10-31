-- Driver signups.
--
-- People currently message Ben and Ben types it in. This is the form, and
-- the queue behind it.
--
-- Signups are not drivers. They sit here until someone looks at them and
-- decides, so a public form can never put a name on the grid by itself.

CREATE TABLE IF NOT EXISTS signup (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  discord    TEXT    NOT NULL DEFAULT '',
  fortnite   TEXT    NOT NULL DEFAULT '',
  class      TEXT    NOT NULL DEFAULT 'gt3',    -- which they are asking for
  experience TEXT    NOT NULL DEFAULT '',
  note       TEXT    NOT NULL DEFAULT '',
  status     TEXT    NOT NULL DEFAULT 'new',    -- new | accepted | declined
  created_at INTEGER NOT NULL,
  -- A salted hash of the sender's IP, the same one DOTD votes use. Raw
  -- addresses are never stored; this only exists to rate limit.
  voter      TEXT    NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_signup_status ON signup (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signup_voter  ON signup (voter, created_at DESC);
