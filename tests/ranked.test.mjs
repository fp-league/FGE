/**
 * Ranked 1v1.
 *
 * Two separable things, tested separately. The engine is pure, so its
 * rules can be checked by playing laps with a fixed rng and reading the
 * numbers. The Discord layer is all about concurrency — hidden picks,
 * one lap per pair of taps, no double moves — so it runs against real
 * SQLite (tests/d1-sqlite.mjs) where a guarded UPDATE genuinely either
 * matches a row or does not.
 */
import { MOVES, MOVE_KEYS, newBattle, newDriver, resolve, finished, canPick,
         START_TYRES, START_ERS, MAX_ERS, RACE_LAPS, PICK_TIMEOUT_MIN,
         startRanked, onRankedButton, showLadder, showRankedStats, sweepRanked }
  from '../worker/src/battle.js';
import { rate, expected, tierOf, kFor, getRating, applyResult, ladder,
         START_RATING, K_NORMAL, K_PLACEMENT, PLACEMENT_RACES, RATING_FLOOR, WIN_CREDITS }
  from '../worker/src/ranked.js';
import { wallet, settings } from '../worker/src/economy.js';
import { makeEnv } from './d1-sqlite.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL  ' + n + (x ? '  →  ' + x : '')); } };

const who = id => ({ member: { user: { id, username: 'D' + id } } });
const fixed = v => () => v;              // no damage variance
const txt = e => JSON.stringify(e || {});

/* ── the rules ─────────────────────────────────────────── */
{
  console.log('\nTHE COUNTER TRIANGLE');

  const lap = (x, y) => resolve(newBattle(), x, y, fixed(0.5));

  // Each of the three should beat exactly the one it is meant to, which
  // is worth stating as damage rather than as a winner: the triangle is
  // the whole game, and a sign error in it would not fail anything else.
  const dive = lap('dive', 'slip');
  ok('a dive bomb lands hard on someone following',
     dive.hitA === MOVES.dive.dmg, String(dive.hitA));

  const blocked = lap('dive', 'defend');
  ok('but a defence shuts the door completely', blocked.hitA === 0, String(blocked.hitA));
  ok('and the diver flat-spots his own set', blocked.selfA > MOVES.dive.self,
     String(blocked.selfA));
  ok('which costs him more than the dive would have gained',
     blocked.state.a.tyres < blocked.state.b.tyres,
     `${blocked.state.a.tyres} vs ${blocked.state.b.tyres}`);

  const through = lap('slip', 'defend');
  ok('a slipstream goes through a defence at full value',
     through.hitA === MOVES.slip.dmg, String(through.hitA));

  const caught = lap('dive', 'pit');
  ok('catching someone in the pits is half again',
     caught.hitA === Math.round(MOVES.dive.dmg * 1.5), String(caught.hitA));
  ok('though they do get the tyres back',
     caught.state.b.tyres === START_TYRES + MOVES.pit.heal - caught.hitA,
     String(caught.state.b.tyres));

  const quiet = lap('defend', 'defend');
  ok('two defences are a stalemate',
     quiet.state.a.tyres === START_TYRES && quiet.state.b.tyres === START_TYRES);
  ok('and both batteries charge', quiet.state.a.ers === START_ERS + 1);

  console.log('\nERS');
  ok('a dive costs a bar', lap('dive', 'slip').state.a.ers === START_ERS - MOVES.dive.cost);
  ok('a slipstream builds one', lap('slip', 'slip').state.a.ers === START_ERS + 1);
  ok('a battery cannot go over full',
     resolve({ lap: 1, a: { tyres: 100, ers: MAX_ERS, pits: 0 }, b: newDriver() },
             'slip', 'slip', fixed(0.5)).state.a.ers === MAX_ERS);
  ok('a flat battery cannot dive', !canPick({ tyres: 50, ers: 0 }, 'dive'));
  ok('but can always slipstream', canPick({ tyres: 50, ers: 0 }, 'slip'));
  ok('and can always pit', canPick({ tyres: 50, ers: 0 }, 'pit'));
  ok('a pit refills it', resolve({ lap: 1, a: { tyres: 20, ers: 0, pits: 0 }, b: newDriver() },
                                 'pit', 'slip', fixed(0.5)).state.a.ers === MAX_ERS);

  console.log('\nTHE LAP IS SIMULTANEOUS');
  // If damage were applied one side at a time, a driver who is about to
  // be knocked out would stop dealing their own. Both should land.
  const mutual = resolve({ lap: 1, a: { tyres: 8, ers: 3, pits: 0 },
                                   b: { tyres: 8, ers: 3, pits: 0 } },
                         'dive', 'dive', fixed(0.5));
  ok('both dives land even when both are fatal',
     mutual.state.a.tyres <= 0 && mutual.state.b.tyres <= 0,
     `${mutual.state.a.tyres} / ${mutual.state.b.tyres}`);
  ok('and an exact mutual knockout is a draw', finished(mutual.state) === 'draw',
     String(finished(mutual.state)));

  console.log('\nHOW IT ENDS');
  ok('nothing is decided while both have tyres', finished(newBattle()) === null);
  ok('running out loses it',
     finished({ lap: 3, a: { tyres: 0, ers: 1 }, b: { tyres: 40, ers: 1 } }) === 'b');
  ok('the flag goes to whoever has more left',
     finished({ lap: RACE_LAPS + 1, a: { tyres: 50, ers: 1 }, b: { tyres: 40, ers: 1 } }) === 'a');
  ok('level at the flag is a draw',
     finished({ lap: RACE_LAPS + 1, a: { tyres: 40, ers: 1 }, b: { tyres: 40, ers: 1 } }) === 'draw');
  ok('and the race cannot run past its distance',
     finished({ lap: RACE_LAPS + 1, a: { tyres: 99, ers: 1 }, b: { tyres: 40, ers: 1 } }) !== null);

  // A game that can be won by picking the same thing twelve times is not
  // a game. Spamming the big move should lose to someone reading it.
  console.log('\nSPAM LOSES');
  let s = newBattle(), guard = 0;
  while (!finished(s) && guard++ < 40) {
    // One driver dives whenever the battery allows, the other covers.
    const aMove = canPick(s.a, 'dive') ? 'dive' : 'slip';
    s = resolve(s, aMove, 'defend', fixed(0.5)).state;
  }
  ok('a driver who only ever dives is beaten by a driver who reads it',
     finished(s) === 'b', `${finished(s)} · ${s.a.tyres} vs ${s.b.tyres}`);

  console.log('\nPURE');
  const seq = () => { let i = 0; const n = [0.1, 0.9, 0.5, 0.3]; return () => n[i++ % n.length]; };
  const one = resolve(newBattle(), 'dive', 'slip', seq());
  const two = resolve(newBattle(), 'dive', 'slip', seq());
  ok('the same inputs give the same lap', JSON.stringify(one) === JSON.stringify(two));
  const before = newBattle();
  resolve(before, 'dive', 'dive', fixed(0.5));
  ok('and the state passed in is not modified', before.a.tyres === START_TYRES);
  ok('variance stays inside ±10%', (() => {
    const lo = resolve(newBattle(), 'slip', 'slip', fixed(0)).hitA;
    const hi = resolve(newBattle(), 'slip', 'slip', fixed(1)).hitA;
    return lo >= Math.round(MOVES.slip.dmg * 0.9) && hi <= Math.round(MOVES.slip.dmg * 1.1);
  })());
}

/* ── the ladder maths ──────────────────────────────────── */
{
  console.log('\nRATING');
  ok('even money between equals', Math.abs(expected(1000, 1000) - 0.5) < 1e-9);
  ok('a 400 point gap is roughly 10 to 1',
     Math.abs(expected(1400, 1000) - 10 / 11) < 0.001);

  const even = rate({ rating: 1000, played: 30 }, { rating: 1000, played: 30 }, 1);
  ok('beating an equal is worth half K', even.a - 1000 === K_NORMAL / 2, String(even.a));
  ok('and costs them the same', 1000 - even.b === K_NORMAL / 2);

  const upset = rate({ rating: 900, played: 30 }, { rating: 1600, played: 30 }, 1);
  const expectedWin = rate({ rating: 1600, played: 30 }, { rating: 900, played: 30 }, 1);
  ok('an upset is worth far more than a win you were supposed to get',
     (upset.a - 900) > (expectedWin.a - 1600) * 5,
     `${upset.a - 900} vs ${expectedWin.a - 1600}`);

  ok('placements move faster', kFor(0) === K_PLACEMENT && kFor(PLACEMENT_RACES) === K_NORMAL);

  const draw = rate({ rating: 1300, played: 30 }, { rating: 1000, played: 30 }, 0.5);
  ok('a draw costs the favourite', draw.a < 1300, String(draw.a));
  ok('and pays the underdog', draw.b > 1000, String(draw.b));
  ok('a rating cannot fall through the floor',
     rate({ rating: RATING_FLOOR, played: 50 }, { rating: 2000, played: 50 }, 0).a === RATING_FLOOR);

  // Elo is only fair if it is closed: what one side gains the other loses.
  let drift = 0;
  for (const [ra, rb] of [[1000, 1000], [1200, 900], [800, 1700], [1500, 1499]]) {
    const r = rate({ rating: ra, played: 30 }, { rating: rb, played: 30 }, 1);
    drift += (r.a - ra) + (r.b - rb);
  }
  ok('and the ladder invents no points along the way', Math.abs(drift) <= 4, String(drift));

  ok('tiers climb in order', (() => {
    const names = [0, 950, 1150, 1300, 1450, 1700].map(n => tierOf(n).name);
    return new Set(names).size === names.length;
  })());
}

/* ── a whole race, through the buttons ─────────────────── */

/** Play a match to the flag, both drivers tapping in turn. */
async function race(env, a, b, pickA, pickB) {
  const open = await startRanked(env, who(a), b);
  const id = open.components[0].components[0].custom_id.split(':')[1];
  await onRankedButton(env, who(b), id, 'accept');
  let out = null;
  for (let lap = 0; lap < RACE_LAPS + 2; lap++) {
    const row = env._row('ranked_match', id);
    if (!row || row.status !== 'live') break;
    const state = JSON.parse(row.state);
    await onRankedButton(env, who(a), id, pickA(state.a));
    out = await onRankedButton(env, who(b), id, pickB(state.b));
  }
  return { id, out };
}

{
  console.log('\nA RACE');
  const env = makeEnv();
  const aggressive = d => (canPick(d, 'dive') ? 'dive' : 'slip');
  const careful = d => (d.tyres < 40 ? 'pit' : 'defend');

  const { id, out } = await race(env, 'a1', 'b1', aggressive, careful);
  const row = env._row('ranked_match', id);
  ok('the race finishes', row.status === 'done', row.status);
  ok('and it has a winner recorded', !!row.winner, String(row.winner));
  ok('the closing message says so', /flag|Dead heat/i.test(txt(out)), txt(out).slice(0, 160));
  ok('and the buttons are taken away', out.data.components.length === 0);

  const [ra, rb] = [await getRating(env, 'a1'), await getRating(env, 'b1')];
  ok('both drivers have a rating now', ra.played === 1 && rb.played === 1);
  ok('one went up and one went down',
     (ra.rating - START_RATING) === -(rb.rating - START_RATING) &&
     ra.rating !== START_RATING,
     `${ra.rating} / ${rb.rating}`);
  ok('the win is counted on one side only', ra.won + rb.won === 1 || row.winner === 'draw');
  // Against the opening balance, not against zero: a wallet is created
  // with the league's starting credits the first time it is touched, so
  // the absolute figure says nothing about whether the purse was paid.
  const opening = (await wallet(env, 'fresh', await settings(env))).balance;
  const loserId = row.winner === 'a1' ? 'b1' : 'a1';
  ok('the winner is paid the purse', env._balance(row.winner) - opening === WIN_CREDITS,
     `${env._balance(row.winner)} against an opening ${opening}`);
  ok('and the loser is not charged for losing',
     env._balance(loserId) === 0 || env._balance(loserId) === opening,
     String(env._balance(loserId)));
}

/* ── the guards ────────────────────────────────────────── */
{
  console.log('\nWHO MAY DO WHAT');
  const env = makeEnv();
  const open = await startRanked(env, who('x'), 'y');
  const id = open.components[0].components[0].custom_id.split(':')[1];

  const stranger = await onRankedButton(env, who('z'), id, 'accept');
  ok('a passer-by cannot accept somebody else’s challenge',
     /not yours/i.test(txt(stranger)), txt(stranger));
  const selfAccept = await onRankedButton(env, who('x'), id, 'accept');
  ok('nor can the challenger accept their own',
     /called out/i.test(txt(selfAccept)), txt(selfAccept));

  await onRankedButton(env, who('y'), id, 'accept');
  const twice = await onRankedButton(env, who('y'), id, 'accept');
  ok('and it cannot be accepted twice', /already|not running/i.test(txt(twice)), txt(twice));

  const second = await startRanked(env, who('x'), 'q');
  ok('nobody can have two races at once', /one at a time/i.test(txt(second)), txt(second));

  const mine = await startRanked(env, who('m'), 'm');
  ok('and nobody can race themselves', /yourself|cannot race/i.test(txt(mine)), txt(mine));

  console.log('\nONE PICK EACH, PER LAP');
  const first = await onRankedButton(env, who('x'), id, 'slip');
  ok('the first pick locks in', /Locked in|locked/i.test(txt(first)), txt(first).slice(0, 120));
  ok('and does not run the lap yet', env._row('ranked_match', id).lap === 1);

  const again = await onRankedButton(env, who('x'), id, 'dive');
  ok('the same driver cannot pick again', /already picked/i.test(txt(again)), txt(again));
  ok('and the first pick still stands', env._row('ranked_match', id).a_move === 'slip');

  await onRankedButton(env, who('y'), id, 'defend');
  ok('the second pick runs the lap', env._row('ranked_match', id).lap === 2);
  ok('and both picks are cleared for the next one', (() => {
    const r = env._row('ranked_match', id);
    return r.a_move === null && r.b_move === null;
  })());

  console.log('\nERS IS ENFORCED ON THE TAP');
  // Drain the battery, then try to spend what is not there. The buttons
  // are also disabled, but a tap can arrive from a stale message.
  const drained = env._row('ranked_match', id);
  const st = JSON.parse(drained.state);
  st.a.ers = 0;
  env.DB._raw.prepare('UPDATE ranked_match SET state = ? WHERE id = ?')
    .run(JSON.stringify(st), id);
  const flat = await onRankedButton(env, who('x'), id, 'dive');
  ok('a flat battery is refused', /ERS|flat/i.test(txt(flat)), txt(flat));
  ok('and nothing was written', env._row('ranked_match', id).a_move === null);
}

/* ── two taps at the same instant ──────────────────────── */
{
  console.log('\nSIMULTANEOUS TAPS');
  const env = makeEnv();
  const open = await startRanked(env, who('p'), 'q');
  const id = open.components[0].components[0].custom_id.split(':')[1];
  await onRankedButton(env, who('q'), id, 'accept');

  // Both arrive together. Exactly one of them must run the lap; the other
  // must be told the lap is already going, and the lap must advance once.
  const [r1, r2] = await Promise.all([
    onRankedButton(env, who('p'), id, 'slip'),
    onRankedButton(env, who('q'), id, 'slip'),
  ]);
  ok('the lap advances exactly once', env._row('ranked_match', id).lap === 2,
     String(env._row('ranked_match', id).lap));
  const ran = [r1, r2].filter(r => r && r.type === 7 && /Lap 2/.test(txt(r)));
  ok('and only one response carries the result', ran.length <= 1, String(ran.length));

  // The same person hammering the button is the other half of the race.
  const spam = await Promise.all(
    Array.from({ length: 6 }, () => onRankedButton(env, who('p'), id, 'slip')));
  const taken = spam.filter(r => !/already picked/i.test(txt(r)));
  ok('six taps from one driver count as one pick', taken.length === 1, String(taken.length));
}

/* ── walking away ──────────────────────────────────────── */
{
  console.log('\nABANDONED');
  const env = makeEnv();
  const open = await startRanked(env, who('s'), 't');
  const id = open.components[0].components[0].custom_id.split(':')[1];

  ok('a fresh challenge is not swept', await sweepRanked(env) === 0);

  env.DB._raw.prepare('UPDATE ranked_match SET at = ?, decided_at = NULL WHERE id = ?')
    .run(Date.now() - (PICK_TIMEOUT_MIN + 1) * 60000, id);
  ok('a stale one is', await sweepRanked(env) === 1);
  ok('and it is marked expired', env._row('ranked_match', id).status === 'expired');

  const after = await getRating(env, 's');
  ok('walking away changes nobody’s rating', after.played === 0 && after.rating === START_RATING);
  ok('and the slot is free again',
     !/one at a time/i.test(txt(await startRanked(env, who('s'), 'u'))));
}

/* ── the boards ────────────────────────────────────────── */
{
  console.log('\nLADDER AND RECORD');
  const env = makeEnv();
  const empty = await showLadder(env);
  ok('an empty ladder says so rather than showing nothing',
     /Nobody has raced/i.test(txt(empty)), txt(empty).slice(0, 120));

  await applyResult(env, 'w', 'l', 1);
  await applyResult(env, 'w', 'l', 1);
  await applyResult(env, 'w', 'l', 0.5);

  const board = await showLadder(env);
  ok('the winner is top', txt(board).indexOf('<@w>') < txt(board).indexOf('<@l>'));
  ok('with their record beside them', /2W 0L 1D/.test(txt(board)), txt(board).slice(0, 220));

  const r = await getRating(env, 'w');
  ok('three races are counted', r.played === 3, String(r.played));
  ok('a draw resets the streak rather than extending it', r.streak === 0, String(r.streak));
  ok('and the best rating is remembered', r.best >= r.rating, `${r.best} / ${r.rating}`);

  const loser = await getRating(env, 'l');
  ok('the loser’s streak is negative', loser.streak < 0 || loser.drawn === 1,
     String(loser.streak));

  const card = await showRankedStats(env, who('w'), 'w');
  ok('a record card shows the tier', /Gold|Silver|Bronze|Rookie|Platinum|Champion/.test(txt(card)),
     txt(card).slice(0, 140));
  ok('and the win rate', /%/.test(txt(card)));
  ok('placements are flagged while they last', /[Pp]lacement/.test(txt(card)), txt(card).slice(0, 300));

  const nobody = await showRankedStats(env, who('nn'), 'nn');
  ok('somebody who has never raced gets told so', /not raced/i.test(txt(nobody)));
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
