/**
 * Betting on a race.
 *
 * The maths in the first half is pure and is where all the care is. The
 * rest reads and writes rows.
 *
 * Odds are decimal: 3.50 returns three and a half times the stake,
 * including it. The implied chance of a price is 1/odds, and the sum of
 * those across a field is the "book". A fair book sums to 1.00 and pays
 * out everything it takes; a real one sums to a little more, and the
 * difference is the margin. Keeping the margin as a single number an
 * admin sets means the house edge is one dial, stated in the panel,
 * rather than something buried in the pricing.
 *
 * Prices move with the money. Back a driver heavily and the price
 * shortens; everyone else drifts. That is the whole point of a book, and
 * it is what makes getting on early worth something.
 */

const MIN_ODDS = 1.04;     // below this a bet is barely a bet
const MAX_ODDS = 200;      // above this the number is just noise

const round2 = n => Math.round(n * 100) / 100;
const clampOdds = n => round2(Math.min(MAX_ODDS, Math.max(MIN_ODDS, n)));

/**
 * Turn a set of weights into decimal odds carrying the given margin.
 *
 * Normalising first and applying the margin after means the margin is
 * exactly what it says: a 115 book has its implied chances summing to
 * 1.15 whatever shape the field is.
 */
export function oddsFromWeights(weights, margin = 115) {
  const m = Math.max(100, Number(margin) || 115) / 100;
  const total = weights.reduce((a, b) => a + Math.max(0, b), 0);
  if (!(total > 0)) return weights.map(() => clampOdds(weights.length));

  // The shortest price expressible is MIN_ODDS, so no runner's implied
  // chance can exceed 1/MIN_ODDS. Left unchecked, a runner carrying
  // almost the whole book would price below that, get clamped up, and the
  // book would quietly stop summing to its margin — the house would be
  // giving away the overround exactly when the money was most lopsided.
  // Pegging the offender and spreading the surplus across the rest keeps
  // the sum where it was promised. Repeated, because pegging one runner
  // can push the next over the same ceiling.
  const capP = 1 / MIN_ODDS;
  let p = weights.map(w => (Math.max(0, w) / total) * m);

  for (let i = 0; i < 8; i++) {
    const over = p.map((x, j) => (x > capP ? j : -1)).filter(j => j >= 0);
    if (!over.length) break;
    const pegged = new Set(over);
    let surplus = 0;
    for (const j of over) { surplus += p[j] - capP; p[j] = capP; }
    const freeSum = p.reduce((a, x, j) => a + (pegged.has(j) ? 0 : x), 0);
    if (freeSum <= 0) break;
    p = p.map((x, j) => (pegged.has(j) ? x : x + surplus * (x / freeSum)));
  }

  return p.map(x => (x <= 0 ? MAX_ODDS : clampOdds(1 / x)));
}

/**
 * Opening prices from the championship.
 *
 * Somebody on no points is not a hundred-to-one shot in a six-car field,
 * so every driver gets a floor before the shares are worked out. Without
 * it a new entrant would open at a price nobody would ever lay.
 */
export function seedOdds(runners, margin = 115) {
  const pts = runners.map(r => Math.max(0, Number(r.points) || 0));
  const best = Math.max(1, ...pts);
  // The floor is a quarter of the leader's score, which keeps the spread
  // wide enough to be interesting and narrow enough to be fair.
  const floor = best * 0.25;
  return oddsFromWeights(pts.map(p => p + floor), margin);
}

/**
 * Move the prices toward where the money has gone.
 *
 * Two things are blended: the opening view, which is what the form says,
 * and the weight of money, which is what the room thinks. `pull` decides
 * how far the room gets to move it, and it rises with how much has been
 * staked — a book with ten credits on it should not lurch because one
 * person had a punt, and a book with thousands on it should follow them.
 *
 * `settle` is the amount of money at which the room gets half the say.
 */
export function reprice(runners, margin = 115, settleAt = 5000) {
  const staked = runners.map(r => Math.max(0, Number(r.staked) || 0));
  const total = staked.reduce((a, b) => a + b, 0);

  // The opening prices are the form view, converted back to chances.
  const opening = runners.map(r => 1 / Math.max(MIN_ODDS, Number(r.open_odds) || MIN_ODDS));
  const openSum = opening.reduce((a, b) => a + b, 0) || 1;
  const form = opening.map(p => p / openSum);

  if (total <= 0) return oddsFromWeights(form, margin);

  const money = staked.map(s => s / total);
  const pull = total / (total + Math.max(1, Number(settleAt) || 5000));

  const blended = form.map((f, i) => (1 - pull) * f + pull * money[i]);
  return oddsFromWeights(blended, margin);
}

/** What a winning bet returns, stake included. */
export const returns = (stake, odds) =>
  Math.max(0, Math.round(Math.max(0, Number(stake) || 0) * (Number(odds) || 0)));

/** The book's total implied chance — 1.15 on a 115 book. Used by the tests. */
export const bookSum = odds =>
  round2(odds.reduce((a, o) => a + 1 / o, 0) * 100) / 100;

/* ── Rows ──────────────────────────────────────────────── */

const bookId = (cls, round) => `${String(cls).toLowerCase()}-r${Number(round) || 0}`;

export async function getBook(env, id) {
  try {
    const b = await env.DB.prepare(`SELECT * FROM book WHERE id = ?`).bind(String(id)).first();
    if (!b) return null;
    const rs = await env.DB.prepare(
      `SELECT * FROM book_runner WHERE book_id = ? ORDER BY odds`).bind(String(id)).all();
    return { ...b, runners: rs.results || [] };
  } catch { return null; }
}

/** The one people can bet into: open, for this class, lowest round first. */
export async function openBookFor(env, cls) {
  try {
    const b = await env.DB.prepare(
      `SELECT * FROM book WHERE cls = ? AND status = 'open' ORDER BY round LIMIT 1`)
      .bind(String(cls).toLowerCase()).first();
    return b ? getBook(env, b.id) : null;
  } catch { return null; }
}

export async function listBooks(env) {
  try {
    const rs = await env.DB.prepare(
      `SELECT * FROM book ORDER BY status = 'settled', round DESC LIMIT 40`).all();
    const out = [];
    for (const b of (rs.results || [])) out.push(await getBook(env, b.id));
    return out.filter(Boolean);
  } catch { return []; }
}

/**
 * Open a book, or reopen one that exists.
 *
 * Reopening keeps the runners and their money: an admin nudging the margin
 * or the race name should not wipe out bets already struck.
 */
export async function openBook(env, { cls, round, race, margin, runners }) {
  const id = bookId(cls, round);
  const m = Math.max(100, Math.round(Number(margin) || 115));
  const now = Date.now();
  const existing = await getBook(env, id);

  await env.DB.prepare(
    `INSERT INTO book (id, cls, round, race, status, margin, opened_at, priced_at)
     VALUES (?, ?, ?, ?, 'open', ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       race = excluded.race, margin = excluded.margin, status = 'open'`
  ).bind(id, String(cls).toLowerCase(), Math.round(Number(round) || 0),
         String(race || 'Race').slice(0, 80), m, now, now).run();

  const list = (runners || []).filter(r => r && r.driver_id);
  if (!list.length) return getBook(env, id);

  const seeded = list.some(r => Number(r.odds) > 0)
    ? list.map(r => clampOdds(Number(r.odds)))
    : seedOdds(list, m);

  const keep = new Map((existing ? existing.runners : []).map(r => [r.driver_id, r]));
  await env.DB.batch(list.map((r, i) => env.DB.prepare(
    `INSERT INTO book_runner (book_id, driver_id, name, open_odds, odds, staked)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (book_id, driver_id) DO UPDATE SET
       name = excluded.name, open_odds = excluded.open_odds, odds = excluded.odds`
  ).bind(id, String(r.driver_id), String(r.name || r.driver_id).slice(0, 60),
         seeded[i], seeded[i], keep.has(r.driver_id) ? keep.get(r.driver_id).staked : 0)));

  return getBook(env, id);
}

export async function setBookStatus(env, id, status) {
  const s = ['open', 'closed', 'settled'].includes(status) ? status : 'closed';
  await env.DB.prepare(`UPDATE book SET status = ? WHERE id = ?`).bind(s, String(id)).run();
  return getBook(env, id);
}

export async function deleteBook(env, id) {
  const key = String(id);
  const open = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM book_bet WHERE book_id = ? AND settled = 0`).bind(key).first();
  if (open && open.n > 0) {
    throw new Error(`${open.n} bet${open.n === 1 ? '' : 's'} are still open on this race — settle or void it first`);
  }
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM book_runner WHERE book_id = ?`).bind(key),
    env.DB.prepare(`DELETE FROM book_bet WHERE book_id = ?`).bind(key),
    env.DB.prepare(`DELETE FROM book WHERE id = ?`).bind(key),
  ]);
}

/* ── Pricing run ───────────────────────────────────────── */

/**
 * Reprice every open book. Called hourly.
 *
 * A closed or settled book is left alone: once betting has stopped the
 * price has no job left to do, and moving it would only confuse anyone
 * reading back what they got on at.
 */
export async function repriceAll(env, settleAt) {
  let moved = 0;
  try {
    const rs = await env.DB.prepare(`SELECT * FROM book WHERE status = 'open'`).all();
    for (const b of (rs.results || [])) {
      const full = await getBook(env, b.id);
      if (!full || full.runners.length < 2) continue;
      const next = reprice(full.runners, full.margin, settleAt);
      await env.DB.batch(full.runners.map((r, i) => env.DB.prepare(
        `UPDATE book_runner SET odds = ? WHERE book_id = ? AND driver_id = ?`
      ).bind(next[i], b.id, r.driver_id)));
      await env.DB.prepare(`UPDATE book SET priced_at = ? WHERE id = ?`)
        .bind(Date.now(), b.id).run();
      moved++;
    }
  } catch { /* the table may not exist yet */ }
  return moved;
}

/* ── Settlement ────────────────────────────────────────── */

/**
 * Pay out a book.
 *
 * `pay` is injected rather than imported so this stays testable without a
 * wallet: it is called once per winning bet with (userId, amount, reason).
 *
 * Only unsettled rows are touched and each is marked as it is paid, so
 * running this twice pays once. That matters more than it sounds — an
 * admin pressing a button twice is not an unusual event.
 */
export async function settleBook(env, id, winnerId, pay) {
  const book = await getBook(env, id);
  if (!book) throw new Error('no such book');
  if (book.status === 'settled') throw new Error('that race has already been settled');

  const winner = String(winnerId || '');
  if (!book.runners.some(r => r.driver_id === winner)) {
    throw new Error('that driver is not in this book');
  }

  const rs = await env.DB.prepare(
    `SELECT * FROM book_bet WHERE book_id = ? AND settled = 0`).bind(String(id)).all();
  const bets = rs.results || [];

  let paid = 0, out = 0;
  for (const bet of bets) {
    const won = bet.driver_id === winner;
    const back = won ? returns(bet.stake, bet.odds) : 0;
    if (won && back > 0 && pay) {
      await pay(bet.user_id, back, `Bet won — ${book.race}`);
      paid++; out += back;
    }
    await env.DB.prepare(
      `UPDATE book_bet SET settled = 1, won = ?, returned = ? WHERE id = ?`
    ).bind(won ? 1 : 0, back, bet.id).run();
  }

  await env.DB.prepare(
    `UPDATE book SET status = 'settled', winner = ?, settled_at = ? WHERE id = ?`
  ).bind(winner, Date.now(), String(id)).run();

  const taken = bets.reduce((a, b) => a + b.stake, 0);
  return { bets: bets.length, winners: paid, paidOut: out, staked: taken };
}

/**
 * Give everything back and close the book.
 *
 * For a race that did not happen. A void has to refund the stake rather
 * than pay the odds, and it has to be impossible to do twice.
 */
export async function voidBook(env, id, refund) {
  const book = await getBook(env, id);
  if (!book) throw new Error('no such book');

  const rs = await env.DB.prepare(
    `SELECT * FROM book_bet WHERE book_id = ? AND settled = 0`).bind(String(id)).all();
  const bets = rs.results || [];
  let given = 0;
  for (const bet of bets) {
    if (refund) await refund(bet.user_id, bet.stake, `Bet voided — ${book.race}`);
    given += bet.stake;
    await env.DB.prepare(
      `UPDATE book_bet SET settled = 1, won = 0, returned = ? WHERE id = ?`
    ).bind(bet.stake, bet.id).run();
  }
  await env.DB.prepare(
    `UPDATE book SET status = 'settled', winner = NULL, settled_at = ? WHERE id = ?`
  ).bind(Date.now(), String(id)).run();
  return { refunded: bets.length, total: given };
}

/* ── Placing ───────────────────────────────────────────── */

/**
 * Record a bet at the price showing now.
 *
 * The caller takes the stake out of the wallet first and only calls this
 * once that has succeeded, so there is no path where a row exists for
 * money that was never collected.
 */
export async function placeBet(env, { bookId: id, userId, driverId, stake }) {
  const book = await getBook(env, id);
  if (!book) throw new Error('no such book');
  if (book.status !== 'open') throw new Error('betting is closed on that race');
  const runner = book.runners.find(r => r.driver_id === String(driverId));
  if (!runner) throw new Error('that driver is not in this book');

  const n = Math.round(Number(stake) || 0);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO book_bet (book_id, user_id, driver_id, stake, odds, at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(String(id), String(userId), runner.driver_id, n, runner.odds, Date.now()),
    env.DB.prepare(
      `UPDATE book_runner SET staked = staked + ? WHERE book_id = ? AND driver_id = ?`
    ).bind(n, String(id), runner.driver_id),
  ]);
  return { runner, odds: runner.odds, returns: returns(n, runner.odds) };
}

export async function betsFor(env, userId, limit = 12) {
  try {
    const rs = await env.DB.prepare(
      `SELECT b.*, k.race, k.status, r.name AS driver_name
         FROM book_bet b
         JOIN book k ON k.id = b.book_id
         LEFT JOIN book_runner r ON r.book_id = b.book_id AND r.driver_id = b.driver_id
        WHERE b.user_id = ? ORDER BY b.at DESC LIMIT ?`
    ).bind(String(userId), Math.max(1, Math.min(25, limit))).all();
    return rs.results || [];
  } catch { return []; }
}
