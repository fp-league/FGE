-- Close the ranked challenges left over from the broken deploy.
--
-- /ranked was registered and clickable for about ten minutes before the
-- routing and the buttons were fixed, so people opened challenges that
-- could never be accepted. Each one holds its two drivers' one-at-a-time
-- slot until the sweep gets to it, which means neither of them can start
-- a real race in the meantime.
--
-- The cutoff is a fixed timestamp — 2026-11-22 12:22:00 UTC, a couple of
-- minutes before this ships — and not "now". The migrate workflow replays
-- every file in this folder on every run, so a clause of the form
-- "everything currently open" would quietly kill a live race on some
-- unrelated deploy months from now. Bounded by a fixed moment in the
-- past, this touches the same handful of rows every time it runs and
-- nothing else, forever.
--
-- 'expired' rather than 'done': nothing was raced, so nobody's rating
-- moves and nobody is paid.

UPDATE ranked_match
   SET status = 'expired',
       decided_at = 1795350120000
 WHERE status IN ('open', 'live')
   AND at < 1795350120000;
