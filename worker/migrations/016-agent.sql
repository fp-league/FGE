-- Changes the agent has proposed but nobody has approved.
--
-- The whole safety of the thing rests on one property: what gets applied
-- is exactly what somebody looked at. So the edit is written down when it
-- is proposed and read back from here when it is approved — never
-- regenerated. Asking the model again at approval time would mean the
-- owner approves one change and a different one runs.
--
-- `status` is also the lock. Approving is an UPDATE guarded on
-- status = 'pending', so two owners pressing the button within a second
-- of each other cannot both pass — which for a change that opens a pull
-- request would otherwise open two.
--
-- Safe to re-run: the Migrate workflow replays every file whenever any
-- one of them changes.

CREATE TABLE IF NOT EXISTS proposal (
  id         TEXT    PRIMARY KEY,
  asked_by   TEXT    NOT NULL,          -- Discord user id
  request    TEXT    NOT NULL,          -- what they typed, verbatim
  summary    TEXT    NOT NULL,          -- the model's one line about it
  kind       TEXT    NOT NULL,          -- 'code' for now; 'data' later
  edits      TEXT    NOT NULL,          -- JSON [{path, find, replace, why}]
  status     TEXT    NOT NULL DEFAULT 'pending',  -- pending|applied|rejected|expired
  decided_by TEXT,
  result     TEXT,                      -- the pull request url, or the error
  at         INTEGER NOT NULL,
  decided_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_proposal_open ON proposal (status, at DESC);
CREATE INDEX IF NOT EXISTS idx_proposal_user ON proposal (asked_by, at DESC);
