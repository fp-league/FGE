/**
 * The casino and the shift, played through the real handlers against a
 * stand-in D1 that holds balances and game rows.
 *
 * The rules are covered in casino.test.mjs. What matters here is the
 * money: that a stake leaves once, that a payout arrives once, and that
 * no sequence of button presses can produce credits out of nothing.
 */
import * as games from '../worker/src/games.js';
import { shiftQuestion, ALL_QUESTIONS } from '../worker/src/shift.js';

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL  ' + n + (x ? '  →  ' + x : '')); } };

function makeDB(settings = {}) {
  const wallets = new Map(), rows = new Map(), work = new Map(), ledger = [];
  const cfg = new Map(Object.entries({ starting_balance: '1000', ...settings }));
  const prep = sql => {
    const q = sql.replace(/\s+/g, ' ').trim();
    let a = [];
    const self = {
      bind(...args) { a = args; return self; },
      async all() {
        if (/SELECT key, value FROM econ_setting/.test(q))
          return { results: [...cfg].map(([key, value]) => ({ key, value: String(value) })) };
        return { results: [] };
      },
      async first() {
        if (/SELECT balance, lifetime FROM wallet/.test(q)) return wallets.get(a[0]) || null;
        if (/FROM casino_game WHERE id/.test(q)) return rows.get(a[0]) || null;
        if (/SELECT last_at, times FROM work_log/.test(q)) return work.get(a[0] + '|' + a[1]) || null;
        return null;
      },
      async run() {
        if (/INSERT INTO wallet/.test(q)) {
          if (!wallets.has(a[0])) wallets.set(a[0], { balance: a[1], lifetime: a[2] });
          return {};
        }
        if (/UPDATE wallet SET balance = balance \+ \?, updated_at = \? WHERE user_id = \? AND balance >= \?/.test(q)) {
          const w = wallets.get(a[2]);
          if (!w || w.balance < a[3]) return { meta: { changes: 0 } };
          w.balance += a[0]; return { meta: { changes: 1 } };
        }
        if (/UPDATE wallet SET balance = balance \+ \?, lifetime = lifetime \+ \?/.test(q)) {
          const w = wallets.get(a[3]);
          if (w) { w.balance += a[0]; w.lifetime += a[1]; }
          return { meta: { changes: 1 } };
        }
        if (/INSERT INTO ledger/.test(q)) { ledger.push({ u: a[0], d: a[1], why: a[2] }); return {}; }
        if (/INSERT INTO casino_game/.test(q)) {
          rows.set(a[0], { id: a[0], user_id: a[1], kind: a[2], bet: a[3], state: a[4], at: a[5] });
          return {};
        }
        if (/DELETE FROM casino_game WHERE id/.test(q)) { rows.delete(a[0]); return {}; }
        if (/DELETE FROM casino_game WHERE at </.test(q)) {
          let n = 0;
          for (const [k, v] of rows) if (v.at < a[0]) { rows.delete(k); n++; }
          return { meta: { changes: n } };
        }
        if (/INSERT INTO work_log/.test(q)) {
          const k = a[0] + '|' + a[1], prev = work.get(k);
          work.set(k, { user_id: a[0], job: a[1], last_at: a[2],
                        times: (prev ? prev.times : 0) + 1,
                        earned: (prev ? prev.earned : 0) + (a[3] || 0) });
          return {};
        }
        return {};
      },
    };
    return self;
  };
  return { DB: { prepare: prep }, _w: wallets, _rows: rows, _work: work, _ledger: ledger };
}

const who = id => ({ member: { user: { id, username: 'u' + id } } });
const press = (id, cid) => ({ member: { user: { id } }, data: { custom_id: cid } });
const seed = (env, id, bal) => env._w.set(id, { balance: bal, lifetime: bal });
const bal = (env, id) => (env._w.get(id) || {}).balance;
const btns = r => ((r.data.components || [])[0] || { components: [] }).components.map(b => b.custom_id);
const txt = r => JSON.stringify(r.data ? r.data.embeds : r);

/* ── the question table ────────────────────────────────── */
console.log('THE QUESTIONS');
{
  ok('every question has an answer in range',
     ALL_QUESTIONS.every(q => q.answer >= 0 && q.answer < q.options.length));
  ok('every question has at least two options',
     ALL_QUESTIONS.every(q => q.options.length >= 2));
  // Discord truncates a long button label, and a truncated answer is an
  // unfair question.
  const long = ALL_QUESTIONS.flatMap(q => q.options).filter(o => o.length > 40);
  ok('no option is too long for a button', long.length === 0, long.join(' | '));
  ok('no duplicate options in a question',
     ALL_QUESTIONS.every(q => new Set(q.options).size === q.options.length));
  ok('every question explains itself', ALL_QUESTIONS.every(q => (q.note || '').length > 10));
  ok('there are questions for every seeded job',
     ['marshal','setup','pitcrew','detail','commentate']
       .every(j => ALL_QUESTIONS.some(q => q.job === j)));

  // The right answer is written first in the table, so it must be moved.
  let firsts = 0;
  for (let i = 0; i < 400; i++) if (shiftQuestion('marshal').answer === 0) firsts++;
  ok('the answer is not always the first button', firsts < 300, `${firsts}/400`);
  ok('and it is sometimes', firsts > 20, `${firsts}/400`);

  const q = shiftQuestion('marshal');
  ok('an unknown job still gets a question', shiftQuestion('nonsense-job').options.length >= 2);
  ok('the shuffled answer still points at the right text',
     typeof q.options[q.answer] === 'string' && q.options[q.answer].length > 0);
}

/* ── blackjack money ───────────────────────────────────── */
console.log('\nBLACKJACK');
{
  let env = makeDB(); seed(env, 'a', 5000);
  const r = await games.startBlackjack(env, who('a'), 500);
  // Checked on the ledger, not the balance: a natural settles inside this
  // same call and pays back, so about one deal in twenty left the balance
  // ABOVE where it started and failed an assertion on the balance alone.
  // The stake still left first, which is the thing being tested.
  ok('the stake leaves immediately',
     env._ledger.some(l => l.u === 'a' && l.d === -500),
     JSON.stringify(env._ledger));
  const open = env._rows.size === 1;
  if (open) {
    ok('buttons are offered', btns(r).length === 3, btns(r).join());
    ok('one of them is hit', btns(r).some(b => b.endsWith(':hit')));
  } else {
    // A natural settles on the deal and leaves no row behind.
    ok('a natural settles without buttons', (r.data.components || []).length === 0);
    ok('and leaves no game row', env._rows.size === 0);
  }

  // Not your hand.
  env = makeDB(); seed(env, 'a', 5000); seed(env, 'b', 5000);
  let started = null;
  for (let i = 0; i < 40 && !started; i++) {
    const e2 = makeDB(); seed(e2, 'a', 5000); seed(e2, 'b', 5000);
    const res = await games.startBlackjack(e2, who('a'), 500);
    if (e2._rows.size === 1) started = { env: e2, res };
  }
  ok('a hand that needs decisions can be dealt', !!started);
  if (started) {
    const id = btns(started.res)[0].split(':')[1];
    const before = bal(started.env, 'b');
    const nope = await games.handleComponent(press('b', `bj:${id}:hit`), started.env);
    ok('someone else cannot play your hand', /not your hand/i.test(txt(nope)), txt(nope));
    ok('and it costs them nothing', bal(started.env, 'b') === before);

    // Standing settles and removes the row.
    const out = await games.handleComponent(press('a', `bj:${id}:stand`), started.env);
    ok('standing finishes the hand', out.type === 7, String(out.type));
    ok('the row is cleared', started.env._rows.size === 0);
    ok('the buttons are taken away', (out.data.components || []).length === 0);

    // A second press on a dead id must not pay again.
    const after = bal(started.env, 'a');
    const again = await games.handleComponent(press('a', `bj:${id}:stand`), started.env);
    ok('pressing again does nothing', /already finished/i.test(txt(again)));
    ok('and pays nothing', bal(started.env, 'a') === after, String(bal(started.env, 'a')));
  }

  // Stakes are bounded and must be affordable.
  env = makeDB({ bet_min: '50', bet_max: '1000' }); seed(env, 'a', 5000);
  ok('under the minimum is refused', /too small/i.test(JSON.stringify(
     await games.startBlackjack(env, who('a'), 10))));
  ok('over the maximum is refused', /too big/i.test(JSON.stringify(
     await games.startBlackjack(env, who('a'), 999999))));
  ok('nothing was taken for a refused stake', bal(env, 'a') === 5000, String(bal(env, 'a')));

  env = makeDB(); seed(env, 'a', 100);
  ok('you cannot stake what you do not have', /not enough/i.test(JSON.stringify(
     await games.startBlackjack(env, who('a'), 500))));
  ok('and the balance is untouched', bal(env, 'a') === 100);

  env = makeDB({ casino_enabled: '0' }); seed(env, 'a', 5000);
  ok('the casino can be shut', /closed/i.test(JSON.stringify(
     await games.startBlackjack(env, who('a'), 500))));
  ok('and a shut casino takes nothing', bal(env, 'a') === 5000);
}

/* ── the house must not lose money overall ─────────────── */
console.log('\nOVER MANY HANDS');
{
  // Play 400 hands, always standing. The player should end down, and at
  // no point should the bank be able to go negative.
  let bank = 0;
  for (let i = 0; i < 400; i++) {
    const env = makeDB(); seed(env, 'a', 100000);
    const r = await games.startBlackjack(env, who('a'), 100);
    if (env._rows.size === 1) {
      const id = btns(r)[0].split(':')[1];
      await games.handleComponent(press('a', `bj:${id}:stand`), env);
    }
    bank += 100000 - bal(env, 'a');
  }
  ok('the house is ahead over 400 hands standing every time', bank > 0, String(bank));
  // Standing on everything is a bad strategy, so the loss should be real
  // but not absurd — a sanity check that payouts are not inverted.
  ok('and not absurdly so', bank < 400 * 100 * 0.5, String(bank));
}

/* ── roulette money ────────────────────────────────────── */
console.log('\nROULETTE');
{
  let env = makeDB(); seed(env, 'a', 10000);
  const r = await games.playRoulette(env, who('a'), 'red', 500);
  ok('the wheel is drawn', /┌──────┐/.test(JSON.stringify(r)));
  ok('the balance moved by a whole stake either way',
     bal(env, 'a') === 9500 || bal(env, 'a') === 10500, String(bal(env, 'a')));

  env = makeDB(); seed(env, 'a', 10000);
  ok('an unknown bet is refused', /no such bet/i.test(JSON.stringify(
     await games.playRoulette(env, who('a'), 'banana', 500))));
  ok('and takes nothing', bal(env, 'a') === 10000);

  // Money flow end to end, on an even-money bet.
  //
  // This was a straight-up number, which pays 36x on a 1-in-37 chance: a
  // standard deviation of 13 points over 2000 spins, so any band tight
  // enough to mean something failed several times in a hundred runs. A
  // flaky test is worse than no test — it teaches you to re-run until
  // green. Red has the same 97.3% return with a sd of 2.2, so the same
  // sample says something without crying wolf.
  let stake = 0, ret = 0;
  for (let i = 0; i < 2000; i++) {
    const e = makeDB(); seed(e, 'a', 100000);
    await games.playRoulette(e, who('a'), 'red', 100);
    stake += 100; ret += bal(e, 'a') - 99900;
  }
  const rtp = ret / stake * 100;
  ok('an even-money bet returns about 97% over 2000 spins',
     rtp > 87 && rtp < 108, rtp.toFixed(1) + '%');

  // The long-odds arithmetic is checked exactly rather than statistically:
  // back one number until it comes in, then look at what was paid.
  let paid = null;
  for (let i = 0; i < 4000 && paid === null; i++) {
    const e = makeDB(); seed(e, 'a', 100000);
    await games.playRoulette(e, who('a'), '17', 100);
    const delta = bal(e, 'a') - 100000;
    if (delta > 0) paid = delta;
  }
  ok('a winning straight bet pays exactly 35 to 1', paid === 3500,
     paid === null ? 'never came in' : String(paid));
}

/* ── the shift ─────────────────────────────────────────── */
console.log('\nTHE SHIFT');
{
  const job = { id: 'marshal', name: 'Marshal a session', emoji: '🚩',
                min_pay: 90, max_pay: 180, cooldown_min: 150 };
  let env = makeDB(); seed(env, 'a', 1000);
  const r = await games.startShift(env, who('a'), job, { currency_name: 'Credits' }, 1);
  ok('a question is asked', /\?/.test(JSON.stringify(r.data.embeds)));
  ok('there are buttons to answer with', btns(r).length >= 2, String(btns(r).length));
  ok('nothing is paid yet', bal(env, 'a') === 1000, String(bal(env, 'a')));
  ok('and no cooldown is set yet', env._work.size === 0);

  const id = btns(r)[0].split(':')[1];
  const state = JSON.parse(env._rows.get(id).state);
  const right = state.q.answer;

  const win = await games.handleComponent(press('a', `wk:${id}:${right}`), env);
  ok('a right answer pays', bal(env, 'a') > 1000, String(bal(env, 'a')));
  ok('within the job range', bal(env, 'a') - 1000 >= 90 && bal(env, 'a') - 1000 <= 180,
     String(bal(env, 'a') - 1000));
  ok('and the cooldown is recorded', env._work.size === 1);
  ok('the buttons are taken away', (win.data.components || []).length === 0);
  ok('the row is cleared', env._rows.size === 0);
  ok('it says what the right answer was', /right/i.test(JSON.stringify(win.data.embeds)));

  // Wrong answers still pay something, and say what it should have been.
  env = makeDB({ shift_fail_pct: '40' }); seed(env, 'a', 1000);
  const r2 = await games.startShift(env, who('a'), job, { currency_name: 'Credits' }, 1);
  const id2 = btns(r2)[0].split(':')[1];
  const s2 = JSON.parse(env._rows.get(id2).state);
  const wrong = (s2.q.answer + 1) % s2.q.options.length;
  const lose = await games.handleComponent(press('a', `wk:${id2}:${wrong}`), env);
  const got = bal(env, 'a') - 1000;
  ok('a wrong answer still pays something', got > 0, String(got));
  ok('but less than the floor of the range', got < 90, String(got));
  ok('and the right answer is given', JSON.stringify(lose.data.embeds).includes(s2.q.options[s2.q.answer]));

  // Somebody else's shift.
  env = makeDB(); seed(env, 'a', 1000); seed(env, 'b', 1000);
  const r3 = await games.startShift(env, who('a'), job, { currency_name: 'Credits' }, 1);
  const id3 = btns(r3)[0].split(':')[1];
  const steal = await games.handleComponent(press('b', `wk:${id3}:0`), env);
  ok('you cannot answer someone else’s shift', /not your shift/i.test(txt(steal)));
  ok('and are not paid for it', bal(env, 'b') === 1000);

  // Answering twice must not pay twice.
  const paidOnce = await games.handleComponent(press('a', `wk:${id3}:0`), env);
  const afterOne = bal(env, 'a');
  await games.handleComponent(press('a', `wk:${id3}:0`), env);
  ok('answering twice pays once', bal(env, 'a') === afterOne, String(bal(env, 'a')));
}

/* ── housekeeping ──────────────────────────────────────── */
console.log('\nSWEEPING');
{
  const env = makeDB(); seed(env, 'a', 5000);
  await games.startShift(env, who('a'),
    { id: 'marshal', name: 'M', emoji: '🚩', min_pay: 10, max_pay: 20, cooldown_min: 5 },
    { currency_name: 'Credits' }, 1);
  ok('a row exists', env._rows.size === 1);
  ok('a fresh row is not swept', await games.sweepGames(env) === 0);
  for (const v of env._rows.values()) v.at = Date.now() - 2 * 60 * 60 * 1000;
  ok('an abandoned one is', await games.sweepGames(env) === 1);
  ok('and it is gone', env._rows.size === 0);
}

/* ── slots ─────────────────────────────────────────────── */
console.log('\nSLOTS — the money');
{
  const env = makeDB(); seed(env, 'a', 10000);
  const before = bal(env, 'a');
  const r = await games.playSlots(env, who('a'), 500);
  ok('it pays out or it does not, but it always answers', !!r && !!r.title, txt(r));
  // The only four things that can happen to the balance on a 500 stake.
  // Anything else means the stake or the payout was applied twice, or not
  // at all \u2014 which is the bug class worth catching here.
  const legal = [-500, Math.round(500 * 1.2) - 500, 500 * 13 - 500, 500 * 33 - 500];
  const moved = bal(env, 'a') - before;
  ok('the balance moved by exactly one of the paytable outcomes',
     legal.includes(moved), `${moved}, expected one of ${legal.join()}`);

  // Forced outcomes, so every branch is actually exercised rather than
  // left to whatever the shuffle happened to give.
  for (const [mult, label] of [[0, 'a loss'], [1.2, 'a pair'], [13, 'a trio'], [33, 'the jackpot']]) {
    const e = makeDB(); seed(e, 'x', 100000);
    const open = bal(e, 'x');
    const real = Math.random;
    // Three equal reels for a win, three different for a loss.
    let i = 0;
    Math.random = () => (mult === 0 ? [0, 1, 2][i++ % 3] / 6
                       : mult === 1.2 ? [0, 0, 2][i++ % 3] / 6
                       : mult === 13 ? 1 / 6 : 0);
    await games.playSlots(e, who('x'), 500);
    Math.random = real;
    ok(`${label} pays ${mult}x`, bal(e, 'x') - open === Math.round(500 * mult) - 500,
       `${bal(e, 'x') - open}`);
  }

  // Over many spins the ledger has to track the paytable, not drift.
  const e2 = makeDB(); seed(e2, 'b', 5_000_000);
  const start = bal(e2, 'b');
  const N = 3000, stake = 100;
  for (let i = 0; i < N; i++) await games.playSlots(e2, who('b'), stake);
  const net = bal(e2, 'b') - start;
  const rtp = 1 + net / (N * stake);
  // Wide band on purpose: a 33x jackpot makes the variance large, and a
  // tight assertion here would fail on an unlucky week rather than on a bug.
  ok('the realised return is in the right country',
     rtp > 0.6 && rtp < 1.4, String(rtp.toFixed(3)));
  ok('the house is not giving money away on average over 3000 spins',
     net < N * stake, String(net));

  ok('too small a stake is refused',
     /smallest stake/i.test(txt(await games.playSlots(makeDB(), who('z'), 1))));
  const broke = makeDB(); seed(broke, 'c', 10);
  ok('and so is one you cannot cover',
     /Not enough/i.test(txt(await games.playSlots(broke, who('c'), 500))));
  ok('a refused spin takes nothing', bal(broke, 'c') === 10, String(bal(broke, 'c')));
}

/* ── higher or lower ───────────────────────────────────── */
console.log('\nHIGHER OR LOWER — the money');
{
  const env = makeDB(); seed(env, 'a', 10000);
  const r = await games.startHiLo(env, who('a'), 500);
  ok('the stake leaves immediately', bal(env, 'a') === 9500, String(bal(env, 'a')));
  const ids = btns(r);
  ok('there are three ways out', ids.length === 3, ids.join());
  ok('higher, lower and take it',
     ids.some(i => i.endsWith(':higher')) && ids.some(i => i.endsWith(':lower')) &&
     ids.some(i => i.endsWith(':cash')), ids.join());
  ok('the price is on the button',
     /Higher ×\d/.test(JSON.stringify(r.data.components)), JSON.stringify(r.data.components));

  // Cashing out straight away returns exactly the stake, never more.
  const cash = ids.find(i => i.endsWith(':cash'));
  const out = await games.handleComponent(press('a', cash), env);
  ok('taking it immediately returns the stake', bal(env, 'a') === 10000, String(bal(env, 'a')));
  ok('and says so', /Cashed out/.test(txt(out)), txt(out));
  ok('the buttons go', ((out.data.components || []).length === 0));
  ok('and it cannot be cashed twice',
     /already finished/i.test(txt(await games.handleComponent(press('a', cash), env))));
  ok('which did not pay again', bal(env, 'a') === 10000, String(bal(env, 'a')));

  // Somebody else's game is not yours to press.
  const e2 = makeDB(); seed(e2, 'a', 10000); seed(e2, 'b', 10000);
  const g = await games.startHiLo(e2, who('a'), 500);
  const theirs = btns(g).find(i => i.endsWith(':cash'));
  ok('a stranger cannot cash your game',
     /Not your game/i.test(txt(await games.handleComponent(press('b', theirs), e2))));
  ok('and your pot is untouched', bal(e2, 'a') === 9500, String(bal(e2, 'a')));
  ok('as is theirs', bal(e2, 'b') === 10000, String(bal(e2, 'b')));

  // Play it out: whatever happens, the balance only ever moves by the
  // stake out and at most one payout in.
  for (let t = 0; t < 40; t++) {
    const e = makeDB(); seed(e, 'a', 100000);
    const open = bal(e, 'a');
    let res = await games.startHiLo(e, who('a'), 1000);
    let guard = 0;
    while ((res.data.components || []).length && guard++ < 20) {
      const b = btns(res);
      const go = b.find(i => i.endsWith(':higher')) || b.find(i => i.endsWith(':cash'));
      res = await games.handleComponent(press('a', go), e);
    }
    const end = bal(e, 'a');
    ok(`run ${t}: never ends mid-hand`, (res.data.components || []).length === 0);
    ok(`run ${t}: a loss costs exactly the stake, never more`,
       end >= open - 1000, `${open} -> ${end}`);
  }

  ok('too small a stake is refused',
     /smallest stake/i.test(txt(await games.startHiLo(makeDB(), who('z'), 1))));
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
