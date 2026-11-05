/**
 * Slash command typeahead.
 *
 * Runs the real handleAutocomplete against a small stand-in for D1, so the
 * option-walking, the ranking and the Discord shape are all exercised
 * rather than described.
 */
import { handleAutocomplete } from '../worker/src/autocomplete.js';
import { COMMANDS } from '../worker/src/commands.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  →  ' + extra : '')); }
};

/* ── stand-in D1 ───────────────────────────────────────── */
const PACKS = [
  { id: 'gt3-standard', name: 'Standard Pack', emoji: '🃏', price: 400, enabled: 1, sort: 10 },
  { id: 'gt3-premium',  name: 'Premium Pack',  emoji: '✨', price: 1100, enabled: 1, sort: 20 },
  { id: 'gt3-podium',   name: 'Podium Pack',   emoji: '🏆', price: 2500, enabled: 1, sort: 30 },
  { id: 'off',          name: 'Retired Pack',  emoji: '🃏', price: 1, enabled: 0, sort: 40 },
];
const JOBS = [
  { id: 'detail', name: 'Detail the car', emoji: '🧽', min_pay: 15, max_pay: 45, cooldown_min: 20 },
  { id: 'pitcrew', name: 'Pit crew shift', emoji: '🔧', min_pay: 60, max_pay: 130, cooldown_min: 90 },
];
// Ben holds three of Ayrton (2 spare) and two of Lando (1 spare); Kai holds
// two of Max. Anything with one copy is not a spare and must never appear.
const COLLECTION = [
  { user_id: 'u-ben', driver_id: 'd1', rarity: 'legendary', copies: 3 },
  { user_id: 'u-ben', driver_id: 'd2', rarity: 'rare',      copies: 2 },
  { user_id: 'u-ben', driver_id: 'd3', rarity: 'common',    copies: 1 },
  { user_id: 'u-kai', driver_id: 'd4', rarity: 'epic',      copies: 2 },
];

const DB = {
  prepare(sql) {
    const q = sql.replace(/\s+/g, ' ').trim();
    let args = [];
    const api = {
      bind(...a) { args = a; return api; },
      async all() {
        if (/FROM pack_type WHERE enabled = 1/.test(q))
          return { results: PACKS.filter(p => p.enabled === 1) };
        if (/FROM job WHERE enabled = 1/.test(q))
          return { results: JOBS };
        if (/FROM card_collection/.test(q) && /copies > 1/.test(q))
          return { results: COLLECTION.filter(c => c.user_id === args[0] && c.copies > 1) };
        if (/FROM custom_card/.test(q)) return { results: [] };
        return { results: [] };
      },
      async first() { return null; },
      async run() { return {}; },
    };
    return api;
  },
};
const env = { DB };

// Two drivers with points so the rarity ladder is exercised, plus one with
// none. cardSet ranks on points, so d1 leads.
const record = {
  gt3: {
    drivers: [
      { id: 'd1', name: 'Ayrton Vale',  team: 'Vale Racing',   number: 1 },
      { id: 'd2', name: 'Lando Pierce', team: 'Pierce Motors', number: 44 },
      { id: 'd3', name: 'Bruno Katz',   team: 'Vale Racing',   number: 7 },
      { id: 'd4', name: 'Max Ferrand',  team: 'Ferrand GP',    number: 3 },
    ],
    races: [{ round: 1, results: [{ driverId: 'd1', pos: 1 }, { driverId: 'd2', pos: 2 },
                                  { driverId: 'd4', pos: 3 }] }],
  },
  gt4: { drivers: [{ id: 'g1', name: 'Rosa Lindt', team: 'Lindt Sport' }], races: [] },
};

const user = id => ({ member: { user: { id } } });
const names = r => (r.data.choices || []).map(c => c.name);
const values = r => (r.data.choices || []).map(c => c.value);

async function ac(data, who = 'u-ben') {
  return handleAutocomplete({ ...user(who), data }, record, env);
}
const focus = (name, value) => ({ name, type: 3, value, focused: true });

/* ── the command list ──────────────────────────────────── */
console.log('COMMAND DEFINITIONS');
{
  // Counting them was brittle — it broke every time a command gained a
  // picker. What matters is which options are pickers, so name them.
  const pickers = new Set();
  const collect = (opts, path) => (opts || []).forEach(o => {
    if (o.autocomplete) pickers.add((path + ' ' + o.name).trim());
    collect(o.options, path + ' ' + o.name);
  });
  COMMANDS.forEach(c => collect(c.options, c.name));
  const want = ['buy pack', 'work job', 'sell name', 'cards card name',
                'trade offer give', 'trade offer want', 'driver name', 'lineups team',
                'gt3 driver name', 'gt4 driver name', 'gt3 lineups team', 'gt4 lineups team',
                'roulette on', 'bet driver'];
  const missing = want.filter(w => !pickers.has(w));
  ok('every option that should be a picker is one', missing.length === 0, missing.join(', '));

  // An option cannot carry both a fixed choice list and autocomplete —
  // Discord rejects the registration outright.
  const clash = [];
  const walk = (opts, path) => (opts || []).forEach(o => {
    if (o.autocomplete && o.choices) clash.push(path + ' ' + o.name);
    walk(o.options, path + ' ' + o.name);
  });
  COMMANDS.forEach(c => walk(c.options, c.name));
  ok('no option has choices and autocomplete at once', clash.length === 0, clash.join(', '));

  const buy = COMMANDS.find(c => c.name === 'buy');
  ok('/buy pack is a picker', buy.options[0].autocomplete === true);
}

/* ── packs ─────────────────────────────────────────────── */
console.log('\n/buy pack');
{
  const r = await ac({ name: 'buy', options: [focus('pack', '')] });
  ok('all enabled packs offered', r.data.choices.length === 3, String(r.data.choices.length));
  ok('a disabled pack is never offered', !values(r).includes('off'));
  ok('the value is the pack id', values(r).includes('gt3-premium'));
  ok('the price is shown while choosing', names(r).some(n => n.includes('1100')));

  const p = await ac({ name: 'buy', options: [focus('pack', 'pod')] });
  ok('filters as you type', values(p).length === 1 && values(p)[0] === 'gt3-podium', values(p).join());

  const byId = await ac({ name: 'buy', options: [focus('pack', 'gt3-prem')] });
  ok('the id matches too', values(byId)[0] === 'gt3-premium');

  const none = await ac({ name: 'buy', options: [focus('pack', 'zzzz')] });
  ok('no match is an empty list, not an error', none.data.choices.length === 0);
}

/* ── jobs ──────────────────────────────────────────────── */
console.log('\n/work job');
{
  const r = await ac({ name: 'work', options: [focus('job', '')] });
  ok('jobs offered', values(r).join() === 'detail,pitcrew', values(r).join());
  ok('pay range is shown', names(r).some(n => n.includes('60–130')));
}

/* ── spares ────────────────────────────────────────────── */
console.log('\n/sell and /trade use spares only');
{
  const r = await ac({ name: 'sell', options: [focus('name', '')] }, 'u-ben');
  ok('"all" is offered first', values(r)[0] === 'all', values(r).join());
  ok('only spares are listed', values(r).includes('Ayrton Vale') && values(r).includes('Lando Pierce'));
  ok('a single copy is not a spare', !values(r).includes('Bruno Katz'), values(r).join());
  ok('the spare count is shown', names(r).some(n => /2 spare/.test(n)), names(r).join(' | '));

  const typed = await ac({ name: 'sell', options: [focus('name', 'lan')] }, 'u-ben');
  ok('typing hides the "all" shortcut', !values(typed).includes('all'), values(typed).join());
  ok('and filters the spares', values(typed).join() === 'Lando Pierce', values(typed).join());

  const nobody = await ac({ name: 'sell', options: [focus('name', '')] }, 'u-nobody');
  ok('someone with nothing gets just the shortcut', values(nobody).join() === 'all', values(nobody).join());
}

console.log('\n/trade offer give|want');
{
  const data = {
    name: 'trade',
    options: [{ name: 'offer', type: 1, options: [
      { name: 'user', type: 6, value: 'u-kai' },
      focus('give', ''),
    ] }],
  };
  const give = await ac(data, 'u-ben');
  ok('give offers your own spares', values(give).includes('Ayrton Vale'), values(give).join());
  ok('and not theirs', !values(give).includes('Max Ferrand'), values(give).join());

  const wantData = {
    name: 'trade',
    options: [{ name: 'offer', type: 1, options: [
      { name: 'user', type: 6, value: 'u-kai' },
      focus('want', ''),
    ] }],
  };
  const want = await ac(wantData, 'u-ben');
  ok('want offers THEIR spares', values(want).join() === 'Max Ferrand', values(want).join());
  ok('and not yours', !values(want).includes('Ayrton Vale'));

  // Picking the card before the person is a normal order to type in.
  const noUser = {
    name: 'trade',
    options: [{ name: 'offer', type: 1, options: [focus('want', '')] }],
  };
  const w2 = await ac(noUser, 'u-ben');
  ok('want with no person chosen yet is empty, not a crash', w2.data.choices.length === 0);
}

/* ── cards, drivers, teams ─────────────────────────────── */
console.log('\n/cards card, /driver, /lineups');
{
  const c = await ac({ name: 'cards', options: [{ name: 'card', type: 1, options: [focus('name', 'ayr')] }] });
  ok('card names come from the live set', values(c).join() === 'Ayrton Vale', values(c).join());

  const d = await ac({ name: 'driver', options: [focus('name', ''), { name: 'class', type: 3, value: 'gt3' }] });
  ok('drivers offered for the flat command', values(d).includes('Bruno Katz'), values(d).join());
  ok('the number is shown', names(d).some(n => n.startsWith('#1 ')), names(d).join(' | '));

  const g4 = await ac({ name: 'gt4', options: [{ name: 'driver', type: 1, options: [focus('name', '')] }] });
  ok('the class-prefixed command uses that class', values(g4).join() === 'Rosa Lindt', values(g4).join());

  const t = await ac({ name: 'lineups', options: [focus('team', '')] });
  ok('teams are deduplicated', values(t).filter(x => x === 'Vale Racing').length === 1, values(t).join());
  ok('all teams offered', values(t).length === 3, values(t).join());
}

/* ── shape and limits ──────────────────────────────────── */
console.log('\nDISCORD SHAPE');
{
  const r = await ac({ name: 'buy', options: [focus('pack', '')] });
  ok('responds with type 8', r.type === 8, String(r.type));
  ok('every name is within 100 chars', r.data.choices.every(c => c.name.length <= 100));
  ok('every value is within 100 chars', r.data.choices.every(c => String(c.value).length <= 100));

  // 60 packs, one option: Discord takes 25 and drops the request otherwise.
  const many = Array.from({ length: 60 }, (_, i) =>
    ({ id: 'p' + i, name: 'Pack ' + i, emoji: '🃏', price: 100, enabled: 1 }));
  const bigEnv = { DB: { prepare: () => ({ bind() { return this; },
    async all() { return { results: many }; }, async first() { return null; } }) } };
  const big = await handleAutocomplete({ ...user('u-ben'), data: { name: 'buy', options: [focus('pack', '')] } },
                                        record, bigEnv);
  ok('never more than 25 choices', big.data.choices.length === 25, String(big.data.choices.length));

  const unknown = await ac({ name: 'balance', options: [focus('whatever', 'x')] });
  ok('an option with no source returns null', unknown === null);

  const noFocus = await ac({ name: 'buy', options: [{ name: 'pack', type: 3, value: 'x' }] });
  ok('nothing focused returns null', noFocus === null);
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
