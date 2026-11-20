-- Repair wallets that walked past the point where a balance can be read.
--
-- The ceiling used to be 2^53-1 and was only applied to amounts arriving
-- from outside. The add itself happens in SQL, so a wallet sitting at the
-- ceiling went straight over it on the next payout. SQLite stored the
-- bigger integer without complaint; the driver then threw
--   RangeError: Value is too large to be represented as a JavaScript number
-- on every read of that row — including /rich, which selects the top ten
-- by balance and therefore handed the error to everybody.
--
-- The repair has to be done entirely in SQL for that reason: anything that
-- SELECTs the bad value throws before it can fix it. A plain UPDATE never
-- brings it across the boundary.
--
-- COALESCE covers a NULL, and MIN() covers a float that got in as well as
-- an oversized integer, because 9.9e30 is still greater than the ceiling.
-- Replaying this on an already-clean table changes nothing.

UPDATE wallet
   SET balance  = MIN(COALESCE(balance,  0), 1000000000000000),
       lifetime = MIN(COALESCE(lifetime, 0), 1000000000000000);

-- The ledger holds the same risk: one oversized delta and /balance's
-- recent-activity list throws for that player.
UPDATE ledger
   SET delta = MAX(MIN(COALESCE(delta, 0), 1000000000000000), -1000000000000000);
