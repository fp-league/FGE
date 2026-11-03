-- Games that take more than one click.
--
-- Discord HTTP interactions are stateless: a button press arrives as a
-- fresh request with nothing but the custom_id on it. A hand of blackjack
-- spans several presses, and the deck, the hands and the stake all have to
-- survive in between. A custom_id is capped at 100 characters and anything
-- packed into one is visible and editable by the person clicking, which is
-- not where a bet belongs. So the state lives here and the id in the button
-- is only a key.
--
-- `state` is JSON because the shape differs per game and will keep
-- changing; there is nothing here worth querying across rows.
--
-- Rows are short-lived — a hand lasts a minute — and are deleted as each
-- game ends. The sweep in the Worker clears anything abandoned, so a player
-- who walks away mid-hand cannot leave a stake in limbo.

CREATE TABLE IF NOT EXISTS casino_game (
  id      TEXT    PRIMARY KEY,          -- short random, goes in the custom_id
  user_id TEXT    NOT NULL,             -- only this person's clicks count
  kind    TEXT    NOT NULL,             -- 'blackjack' | 'shift'
  bet     INTEGER NOT NULL DEFAULT 0,   -- already debited when the row is made
  state   TEXT    NOT NULL,
  at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_casino_user ON casino_game (user_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_casino_at   ON casino_game (at);
