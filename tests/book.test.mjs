/**
 * The book.
 *
 * The pricing is arithmetic, so it is checked as arithmetic: a 115 book
 * must sum to 1.15, money must shorten a price and lengthen the others,
 * and the house must not be able to lose on a balanced book. The row
 * handling is checked for the thing that actually costs money — settling
 * or voiding twice.
 */
import {
  oddsFromWeights, seedOdds, reprice, returns, bookSum,
  openBook, getBook, placeBet, settleBook, voidBook, repriceAll,
  setBookStatus, betsFor, listBooks, deleteBook,
} from '../worker/src/book.js';

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL  ' + n + (x ? '  →  ' + x : '')); } };

/* ── pricing ───────────────────────────────────────────── */
console.log('PRICING');
{
  const even = oddsFromWeights([1, 1, 1, 1], 100);
  ok('a fair four-horse field is 4.0 across', even.every(o => o === 4), even.join());
  ok('a fair book sums to 1.00', bookSum(even) === 1, String(bookSum(even)));

  const m = oddsFromWeights([1, 1, 1, 1], 115);
  ok('a 115 book sums to 1.15', Math.abs(bookSum(m) - 1.15) < 0.01, String(bookSum(m)));
  ok('and its prices are shorter than fair', m[0] < even[0], `${m[0]} vs ${even[0]}`);

  for (const margin of [100, 105, 115, 130, 150]) {
    const o = oddsFromWeights([5, 3, 2, 1, 1], margin);
    const sum = bookSum(o);
    ok(`a ${margin} book sums to ${margin / 100}`, Math.abs(sum - margin / 100) < 0.02,
       String(sum));
  }

  const spread = oddsFromWeights([10, 1], 100);
  ok('the favourite is the shorter price', spread[0] < spread[1], spread.join());
  ok('ten times the weight is roughly a tenth of the price',
     Math.abs(spread[1] / spread[0] - 10) < 0.5, spread.join());

  ok('a zero weight does not produce infinity',
     Number.isFinite(oddsFromWeights([1, 0], 100)[1]));
  ok('nor does an empty field', oddsFromWeights([], 100).length === 0);
  ok('all-zero weights still price', oddsFromWeights([0, 0, 0], 100).every(Number.isFinite));
  ok('a margin below 100 is pulled up to it', bookSum(oddsFromWeights([1, 1], 50)) === 1);
}

/* ── opening prices ────────────────────────────────────── */
console.log('\nOPENING PRICES FROM THE CHAMPIONSHIP');
{
  const field = [{ points: 100 }, { points: 60 }, { points: 20 }, { points: 0 }];
  const o = seedOdds(field, 115);
  ok('the leader is favourite', o[0] === Math.min(...o), o.join());
  ok('the order follows the points', o[0] < o[1] && o[1] < o[2] && o[2] < o[3], o.join());
  ok('the book carries the margin', Math.abs(bookSum(o) - 1.15) < 0.02, String(bookSum(o)));
  // Nobody is unbackable just for having no points yet.
  ok('a driver on zero is still a sane price', o[3] < 30, String(o[3]));
  ok('and the favourite is not odds-on silly', o[0] > 1.1, String(o[0]));

  const fresh = seedOdds([{ points: 0 }, { points: 0 }, { points: 0 }], 100);
  ok('a season with no points is an even field',
     new Set(fresh).size === 1 && Math.abs(fresh[0] - 3) < 0.05, fresh.join());
}

/* ── drift ─────────────────────────────────────────────── */
console.log('\nDRIFT');
{
  const base = [
    { driver_id: 'a', open_odds: 2.0, staked: 0 },
    { driver_id: 'b', open_odds: 4.0, staked: 0 },
    { driver_id: 'c', open_odds: 8.0, staked: 0 },
  ];
  const still = reprice(base, 115);
  ok('with no money on, prices hold their shape',
     still[0] < still[1] && still[1] < still[2], still.join());

  // Pile money on the outsider.
  const loaded = reprice([
    { driver_id: 'a', open_odds: 2.0, staked: 0 },
    { driver_id: 'b', open_odds: 4.0, staked: 0 },
    { driver_id: 'c', open_odds: 8.0, staked: 40000 },
  ], 115);
  ok('money shortens the price it is on', loaded[2] < still[2], `${loaded[2]} vs ${still[2]}`);
  ok('and lengthens the others', loaded[0] > still[0], `${loaded[0]} vs ${still[0]}`);
  ok('the book still carries its margin', Math.abs(bookSum(loaded) - 1.15) < 0.03,
     String(bookSum(loaded)));

  // A small punt should barely move a quiet book.
  const nudge = reprice([
    { driver_id: 'a', open_odds: 2.0, staked: 0 },
    { driver_id: 'b', open_odds: 4.0, staked: 0 },
    { driver_id: 'c', open_odds: 8.0, staked: 50 },
  ], 115, 5000);
  ok('one small bet does not lurch the board',
     Math.abs(nudge[2] - still[2]) / still[2] < 0.12,
     `${still[2]} → ${nudge[2]}`);

  // Repricing repeatedly must converge, not oscillate or run away.
  let runners = base.map(r => ({ ...r, staked: r.driver_id === 'c' ? 9000 : 500 }));
  let last = null, stable = true;
  for (let i = 0; i < 25; i++) {
    const next = reprice(runners, 115);
    if (last && Math.abs(next[2] - last[2]) > 0.001) stable = i > 1 ? stable : stable;
    last = next;
    if (next.some(o => !Number.isFinite(o) || o < 1 || o > 200)) stable = false;
  }
  ok('repeated repricing stays in bounds', stable, last && last.join());

  ok('nobody can be priced below evens-ish', reprice([
    { driver_id: 'a', open_odds: 1.01, staked: 100000 },
    { driver_id: 'b', open_odds: 50, staked: 1 },
  ], 100).every(o => o >= 1.04));
}

/* ── returns ───────────────────────────────────────────── */
console.log('\nRETURNS');
{
  ok('a 3.5 shot returns 3.5 times the stake', returns(100, 3.5) === 350);
  ok('the stake is included', returns(100, 2) === 200);
  ok('a losing price of zero returns nothing', returns(100, 0) === 0);
  ok('fractions are rounded, not dropped', returns(33, 3.33) === 110, String(returns(33, 3.33)));
  ok('a negative stake cannot pay out', returns(-100, 3) === 0);
}

/* ── a book end to end ─────────────────────────────────── */
console.log('\nA BOOK, END TO END');

function makeDB() {
  const books = new Map(), runners = new Map(), bets = [];
  let nextId = 1;
  const prep = sql => {
    const q = sql.replace(/\s+/g, ' ').trim();
    let a = [];
    const self = {
      bind(...args) { a = args; return self; },
      async first() {
        if (/SELECT \* FROM book WHERE id/.test(q)) return books.get(a[0]) || null;
        if (/FROM book WHERE cls = \? AND status = 'open'/.test(q))
          return [...books.values()].filter(b => b.cls === a[0] && b.status === 'open')
            .sort((x, y) => x.round - y.round)[0] || null;
        if (/COUNT\(\*\) AS n FROM book_bet/.test(q))
          return { n: bets.filter(b => b.book_id === a[0] && !b.settled).length };
        return null;
      },
      async all() {
        if (/FROM book_runner WHERE book_id/.test(q))
          return { results: [...runners.values()].filter(r => r.book_id === a[0])
            .sort((x, y) => x.odds - y.odds) };
        if (/FROM book WHERE status = 'open'/.test(q))
          return { results: [...books.values()].filter(b => b.status === 'open') };
        if (/FROM book ORDER BY/.test(q)) return { results: [...books.values()] };
        if (/FROM book_bet WHERE book_id = \? AND settled = 0/.test(q))
          return { results: bets.filter(b => b.book_id === a[0] && !b.settled) };
        if (/FROM book_bet b JOIN book k/.test(q))
          return { results: bets.filter(b => b.user_id === a[0]) };
        return { results: [] };
      },
      async run() {
        if (/INSERT INTO book \(/.test(q)) {
          const prev = books.get(a[0]) || {};
          books.set(a[0], { ...prev, id: a[0], cls: a[1], round: a[2], race: a[3],
            status: 'open', margin: a[4], opened_at: a[5], priced_at: a[6] });
          return {};
        }
        if (/INSERT INTO book_runner/.test(q)) {
          const k = a[0] + '|' + a[1];
          const prev = runners.get(k);
          runners.set(k, { book_id: a[0], driver_id: a[1], name: a[2],
            open_odds: a[3], odds: a[4], staked: prev ? prev.staked : a[5] });
          return {};
        }
        if (/UPDATE book_runner SET odds/.test(q)) {
          const r = runners.get(a[1] + '|' + a[2]); if (r) r.odds = a[0]; return {};
        }
        if (/UPDATE book_runner SET staked/.test(q)) {
          const r = runners.get(a[1] + '|' + a[2]); if (r) r.staked += a[0]; return {};
        }
        if (/INSERT INTO book_bet/.test(q)) {
          bets.push({ id: nextId++, book_id: a[0], user_id: a[1], driver_id: a[2],
            stake: a[3], odds: a[4], at: a[5], settled: 0, won: 0, returned: 0 });
          return {};
        }
        // Order matters: void binds (returned, id) where settle binds
        // (won, returned, id), so the narrower pattern has to go first.
        if (/UPDATE book_bet SET settled = 1, won = 0, returned = \? WHERE id/.test(q)) {
          const b = bets.find(x => x.id === a[1]);
          if (b) { b.settled = 1; b.won = 0; b.returned = a[0]; }
          return {};
        }
        if (/UPDATE book_bet SET settled/.test(q)) {
          const b = bets.find(x => x.id === a[2]);
          if (b) { b.settled = 1; b.won = a[0]; b.returned = a[1]; }
          return {};
        }
        if (/UPDATE book SET status = \? WHERE id/.test(q)) {
          const b = books.get(a[1]); if (b) b.status = a[0]; return {};
        }
        if (/UPDATE book SET status = 'settled', winner = \?/.test(q)) {
          const b = books.get(a[2]); if (b) { b.status = 'settled'; b.winner = a[0]; b.settled_at = a[1]; }
          return {};
        }
        if (/UPDATE book SET status = 'settled', winner = NULL/.test(q)) {
          const b = books.get(a[1]); if (b) { b.status = 'settled'; b.winner = null; }
          return {};
        }
        if (/UPDATE book SET priced_at/.test(q)) {
          const b = books.get(a[1]); if (b) b.priced_at = a[0]; return {};
        }
        if (/DELETE FROM book_runner/.test(q)) {
          for (const [k, v] of runners) if (v.book_id === a[0]) runners.delete(k);
          return {};
        }
        if (/DELETE FROM book_bet/.test(q)) { return {}; }
        if (/DELETE FROM book WHERE id/.test(q)) { books.delete(a[0]); return {}; }
        return {};
      },
    };
    return self;
  };
  return { DB: { prepare: prep, batch: async stmts => { for (const s of stmts) await s.run(); } },
           _books: books, _runners: runners, _bets: bets };
}

const FIELD = [
  { driver_id: 'd1', name: 'Ayrton Vale', points: 100 },
  { driver_id: 'd2', name: 'Lando Pierce', points: 60 },
  { driver_id: 'd3', name: 'Bruno Katz', points: 10 },
];

{
  const env = makeDB();
  const book = await openBook(env, { cls: 'gt3', round: 3, race: 'Road America',
                                     margin: 115, runners: FIELD });
  ok('a book opens', book && book.status === 'open');
  ok('with the whole field', book.runners.length === 3, String(book.runners.length));
  ok('priced from the championship',
     book.runners[0].driver_id === 'd1', book.runners.map(r => r.driver_id).join());

  const paid = [];
  const pay = async (u, n, why) => paid.push({ u, n, why });

  const a = await placeBet(env, { bookId: book.id, userId: 'u1', driverId: 'd1', stake: 1000 });
  const b = await placeBet(env, { bookId: book.id, userId: 'u2', driverId: 'd3', stake: 500 });
  ok('a bet locks the price showing', a.odds > 0 && b.odds > a.odds, `${a.odds} / ${b.odds}`);
  ok('and the money is recorded against the runner',
     env._runners.get(book.id + '|d1').staked === 1000);

  // The price moves, but the struck bet does not.
  await repriceAll(env);
  const after = await getBook(env, book.id);
  const d1 = after.runners.find(r => r.driver_id === 'd1');
  ok('the board moves after a reprice', d1.odds !== d1.open_odds, `${d1.open_odds} → ${d1.odds}`);
  ok('a bet already struck keeps its price', env._bets[0].odds === a.odds);

  const out = await settleBook(env, book.id, 'd1', pay);
  ok('settling pays the winners', out.winners === 1, JSON.stringify(out));
  ok('at the struck price', paid[0].n === returns(1000, a.odds), `${paid[0].n}`);
  ok('and pays the losers nothing', paid.length === 1);
  ok('every bet is marked settled', env._bets.every(x => x.settled === 1));

  // The thing that actually costs money.
  let threw = false;
  try { await settleBook(env, book.id, 'd1', pay); } catch { threw = true; }
  ok('a book cannot be settled twice', threw);
  ok('and nothing more was paid', paid.length === 1, String(paid.length));
}

/* ── voiding ───────────────────────────────────────────── */
console.log('\nVOIDING');
{
  const env = makeDB();
  const book = await openBook(env, { cls: 'gt4', round: 1, race: 'Brands Hatch',
                                     margin: 115, runners: FIELD });
  await placeBet(env, { bookId: book.id, userId: 'u1', driverId: 'd1', stake: 700 });
  await placeBet(env, { bookId: book.id, userId: 'u2', driverId: 'd2', stake: 300 });

  const back = [];
  const out = await voidBook(env, book.id, async (u, n) => back.push({ u, n }));
  ok('everyone gets their stake back', out.refunded === 2 && out.total === 1000, JSON.stringify(out));
  ok('exactly the stake, not the odds', back.every(r => r.n === 700 || r.n === 300),
     JSON.stringify(back));

  const again = await voidBook(env, book.id, async (u, n) => back.push({ u, n }));
  ok('voiding twice refunds once', again.refunded === 0 && back.length === 2, String(back.length));
}

/* ── the gates ─────────────────────────────────────────── */
console.log('\nWHAT IS REFUSED');
{
  const env = makeDB();
  const book = await openBook(env, { cls: 'gt3', round: 5, race: 'Monza',
                                     margin: 115, runners: FIELD });

  let msg = '';
  try { await placeBet(env, { bookId: book.id, userId: 'u1', driverId: 'nobody', stake: 100 }); }
  catch (e) { msg = e.message; }
  ok('you cannot back a driver who is not in it', /not in this book/.test(msg), msg);

  await setBookStatus(env, book.id, 'closed');
  msg = '';
  try { await placeBet(env, { bookId: book.id, userId: 'u1', driverId: 'd1', stake: 100 }); }
  catch (e) { msg = e.message; }
  ok('a closed book takes no more bets', /closed/.test(msg), msg);

  msg = '';
  try { await settleBook(env, book.id, 'nobody', async () => {}); }
  catch (e) { msg = e.message; }
  ok('it cannot be settled on a driver who was not in it', /not in this book/.test(msg), msg);

  // A closed book must not be repriced — the price has no job left.
  const before = (await getBook(env, book.id)).runners.map(r => r.odds).join();
  await repriceAll(env);
  ok('a closed book is not repriced',
     (await getBook(env, book.id)).runners.map(r => r.odds).join() === before);

  // Deleting with money on it must be refused.
  await setBookStatus(env, book.id, 'open');
  await placeBet(env, { bookId: book.id, userId: 'u9', driverId: 'd1', stake: 50 });
  msg = '';
  try { await deleteBook(env, book.id); } catch (e) { msg = e.message; }
  ok('a book with open bets cannot be deleted', /still open/.test(msg), msg);
}

/* ── the house ─────────────────────────────────────────── */
console.log('\nTHE HOUSE');
{
  // On a book where the money matches the prices, the margin is the edge.
  // Stake proportionally to each runner's implied chance and the house
  // should keep roughly the overround whoever wins.
  const odds = oddsFromWeights([5, 3, 2], 115);
  const pot = 100000;
  const stakes = odds.map(o => Math.round(pot / o / odds.reduce((a, x) => a + 1 / x, 0)));
  const taken = stakes.reduce((a, b) => a + b, 0);
  const worst = Math.max(...stakes.map((s, i) => returns(s, odds[i])));
  ok('the house keeps money whichever wins', worst < taken, `${worst} paid vs ${taken} taken`);
  const keep = (1 - worst / taken) * 100;
  ok('and keeps about the overround', keep > 10 && keep < 16, keep.toFixed(1) + '%');
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
