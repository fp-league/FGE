-- One set, not two.
--
-- GT3 and GT4 cards were separate collections you built separately and
-- separate packs you bought separately, which made two small sets instead of
-- one that feels worth completing. This folds them together under the class
-- key 'all'.
--
-- The class column stays. SQLite will not drop one, the 004 seeds still
-- reference it, and a row saying which bucket it came from is worth more
-- than a tidier table. Everything written from here on goes in as 'all'.
--
-- Safe to re-run: every statement is a no-op once nothing is left outside
-- 'all', which matters because the Migrate workflow replays every file
-- whenever any of them changes.

-- Collections. Someone who held the same card id in both classes — which
-- happens when a driver is entered in both — ends up with the copies added
-- together rather than one row silently losing to the other, so the
-- aggregate happens before the insert rather than relying on the conflict.
INSERT INTO card_collection (user_id, class, driver_id, rarity, copies, first_at)
  SELECT user_id, 'all', driver_id,
         -- Rarity is ranked, not alphabetical: MAX('uncommon','legendary')
         -- would pick 'uncommon'. The stored value is only ever a snapshot
         -- anyway — the live set decides what a card is now — but a wrong
         -- one here would be a lie sitting in the table.
         (SELECT c2.rarity FROM card_collection c2
           WHERE c2.user_id = c1.user_id AND c2.driver_id = c1.driver_id
             AND c2.class <> 'all'
           ORDER BY CASE c2.rarity
             WHEN 'legendary' THEN 5 WHEN 'epic' THEN 4 WHEN 'rare' THEN 3
             WHEN 'uncommon' THEN 2 ELSE 1 END DESC LIMIT 1),
         SUM(copies), MIN(first_at)
    FROM card_collection c1
   WHERE class <> 'all'
   GROUP BY user_id, driver_id
  ON CONFLICT (user_id, class, driver_id)
  DO UPDATE SET copies = copies + excluded.copies;

DELETE FROM card_collection WHERE class <> 'all';

-- The two standard packs were the same pack at the same price with a
-- different label on it, so the GT4 one goes and the GT3 one loses its
-- prefix. Everything else just stops being class-specific.
DELETE FROM pack_type WHERE id = 'gt4-standard';

UPDATE pack_type SET class = 'all' WHERE class <> 'all';
UPDATE pack_type SET name = 'Standard Pack', blurb = 'Five cards from the whole set.'
  WHERE id = 'gt3-standard';
UPDATE pack_type SET name = 'Premium Pack', blurb = 'Five cards, one Rare or better.'
  WHERE id = 'gt3-premium';

UPDATE custom_card SET class = 'all' WHERE class <> 'all';
