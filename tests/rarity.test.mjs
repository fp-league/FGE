/**
 * A rarity an admin invented has to behave like one that shipped: come out
 * of packs at its weight, sit in the right place on the ladder, satisfy a
 * guarantee, and be worth its sell value. This runs the real cards.js and
 * economy.js against it.
 */
import { setRarities, RARITIES, RARITY, CORE_RARITIES, drawPack, combinedSet }
  from '../worker/src/cards.js';

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL  ' + n + (x ? '  →  ' + x : '')); } };

const LADDER = [
  { id: 'common',    label: 'Common',    colour: '#9E9E9E', icon: '⚪', weight: 50, sort: 10, sell: 25,   built_in: 1 },
  { id: 'uncommon',  label: 'Uncommon',  colour: '#4CAF50', icon: '🟢', weight: 28, sort: 20, sell: 60,   built_in: 1 },
  { id: 'rare',      label: 'Rare',      colour: '#2196F3', icon: '🔵', weight: 15, sort: 30, sell: 140,  built_in: 1 },
  { id: 'epic',      label: 'Epic',      colour: '#9C27B0', icon: '🟣', weight: 6,  sort: 40, sell: 350,  built_in: 1 },
  { id: 'mythic',    label: 'Mythic',    colour: '#FF3366', icon: '🔴', weight: 3,  sort: 45, sell: 1500, built_in: 0 },
  { id: 'legendary', label: 'Legendary', colour: '#FFC400', icon: '🟡', weight: 1,  sort: 50, sell: 900,  built_in: 1 },
];

console.log('THE LADDER');
{
  setRarities(LADDER);
  ok('a new rarity takes its place by sort',
     RARITIES.join(',') === 'common,uncommon,rare,epic,mythic,legendary', RARITIES.join(','));
  ok('it is rarer than epic', RARITIES.indexOf('mythic') > RARITIES.indexOf('epic'));
  ok('and commoner than legendary', RARITIES.indexOf('mythic') < RARITIES.indexOf('legendary'));
  ok('hex is kept for the site', RARITY.mythic.hex === '#FF3366', RARITY.mythic.hex);
  ok('and converted for Discord', RARITY.mythic.colour === 0xFF3366, String(RARITY.mythic.colour));
  ok('its sell value is on the ladder', RARITY.mythic.sell === 1500);
  ok('it is not marked built-in', RARITY.mythic.builtIn === false);
  ok('the five are still the core', CORE_RARITIES.join(',') === 'common,uncommon,rare,epic,legendary');
}

console.log('\nRESILIENCE');
{
  setRarities([{ id: 'mythic', label: 'Mythic', colour: '#FF3366', weight: 3, sort: 45, sell: 1500 }]);
  ok('a ladder missing the built-ins gets them back',
     CORE_RARITIES.every(r => RARITIES.includes(r)), RARITIES.join(','));
  ok('and the custom one survives', RARITIES.includes('mythic'));

  setRarities(null);
  ok('no ladder at all falls back to the five',
     RARITIES.join(',') === 'common,uncommon,rare,epic,legendary', RARITIES.join(','));

  setRarities([{ id: 'broken' }]);
  ok('a half-written row does not take the set down', RARITY.broken && RARITY.broken.label === 'broken');
  ok('and gets a usable colour', RARITY.broken.colour === 0x9E9E9E, String(RARITY.broken.colour));
}

console.log('\nIT COMES OUT OF PACKS');
{
  setRarities(LADDER);
  // One card at every rarity, so a draw can reach any of them.
  const custom = LADDER.map((r, i) => ({
    id: 'c:' + r.id, class: 'all', name: 'Card ' + r.label, rarity: r.id,
    subtitle: '', image: '', blurb: '', enabled: 1, sort: i,
  }));
  const set = combinedSet({ gt3: { drivers: [], races: [] } }, custom);
  ok('the custom rarity is in the set', set.some(c => c.rarity === 'mythic'),
     set.map(c => c.rarity).join(','));

  // 4000 cards is enough for a weight-3-in-103 rarity to show up reliably
  // without the test being flaky.
  const counts = {};
  for (let i = 0; i < 800; i++) {
    for (const c of drawPack(set, { size: 5 })) counts[c.rarity] = (counts[c.rarity] || 0) + 1;
  }
  ok('mythic is pulled', (counts.mythic || 0) > 0, JSON.stringify(counts));
  ok('rarer than epic in practice', (counts.mythic || 0) < (counts.epic || 0), JSON.stringify(counts));
  ok('commoner than legendary in practice', (counts.mythic || 0) > (counts.legendary || 0), JSON.stringify(counts));

  // Odds that name only the new rarity must produce only that rarity —
  // given enough distinct cards at it, since a pack does not repeat a card.
  const manyMythic = Array.from({ length: 8 }, (_, i) => ({
    id: 'c:myth' + i, class: 'all', name: 'Mythic ' + i, rarity: 'mythic',
    subtitle: '', image: '', blurb: '', enabled: 1, sort: i,
  }));
  const bigSet = combinedSet({ gt3: { drivers: [], races: [] } }, custom.concat(manyMythic));
  const only = drawPack(bigSet, { size: 5, odds: { common: 0, uncommon: 0, rare: 0, epic: 0,
                                                   mythic: 10, legendary: 0 } });
  ok('a pack can be made of nothing else', only.every(c => c.rarity === 'mythic'),
     only.map(c => c.rarity).join(','));
  ok('and it is still five cards', only.length === 5, String(only.length));
}

console.log('\nGUARANTEES');
{
  setRarities(LADDER);
  const custom = LADDER.map((r, i) => ({
    id: 'c:' + r.id, class: 'all', name: 'Card ' + r.label, rarity: r.id,
    subtitle: '', image: '', blurb: '', enabled: 1, sort: i,
  }));
  const set = combinedSet({ gt3: { drivers: [], races: [] } }, custom);

  let held = true, lifted = true;
  for (let i = 0; i < 300; i++) {
    const p = drawPack(set, { size: 3, guarantee: 'mythic' });
    if (!p.some(c => RARITIES.indexOf(c.rarity) >= RARITIES.indexOf('mythic'))) held = false;
    // A guarantee below the new rarity must still accept it as satisfying.
    const q = drawPack(set, { size: 3, guarantee: 'epic' });
    if (!q.some(c => RARITIES.indexOf(c.rarity) >= RARITIES.indexOf('epic'))) lifted = false;
  }
  ok('a pack guaranteeing the new rarity delivers it', held);
  ok('and it satisfies a lower guarantee', lifted);
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
