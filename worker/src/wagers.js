/**
 * The two games that are not played against the house.
 *
 * Everything else in the casino is one person against the bank, with the
 * edge built into the paytable. These two move money between players
 * instead: a duel is one against one, the lottery is everybody into the
 * same pot. The rake is the only thing the house takes, and it is stated
 * on screen both times.
 *
 * Money rules that matter more than the games:
 *   - A stake leaves the moment a wager is offered, never when it is
 *     settled. A challenge that cannot be paid for is not a challenge.
 *   - Every claim on a stake is an UPDATE guarded on its current status,
 *     so two taps a second apart cannot both win it.
 *   - Nothing is ever refunded twice, for the same reason.
 */

import { settings, adjust, wallet, money, safeAmount } from './economy.js';

const GREEN = 0x4CAF50, GOLD = 0xFFC400, GREY = 0x9E9E9E, BRAND = 0xE10600;

const userOf = i => (i.member && i.member.user) || i.user || {};
const nameOf = u => u.global_name || u.username || 'someone';
const simple = (title, description, color) => ({ title, description, color: color || GREY });
const casinoOff = cfg => String(cfg.casino_enabled || '1') !== '1';

export const DUEL_RAKE = 0.05;        // the house keeps this of the pot
export const DUEL_EXPIRY_MIN = 30;    // an unanswered challenge is refunded
export const LOTTERY_MIN_PLAYERS = 2; // fewer and the pot rolls over

/* ── stakes ────────────────────────────────────────────── */

/**
 * Take a stake, or explain why not.
 *
 * Deliberately not shared with games.js: that one is written around a
 * single player opening a game against the bank, and bending it to also
 * mean "the second person in a duel" would make both harder to read.
 */
async function takeStake(env, userId, amount, cfg, why) {
  const min = Number(cfg.bet_min) || 50;
  const max = Number(cfg.bet_max) || 25000;
  const stake = safeAmount(amount);
  if (!Number.isFinite(Number(amount)) || stake < min) {
    return { error: simple('Too small', `The smallest stake is ${money(min, cfg)}.`) };
  }
  if (stake > max) {
    return { error: simple('Too big', `The most you can stake at once is ${money(max, cfg)}.`) };
  }
  const w = await wallet(env, userId, cfg);
  if (w.balance < stake) {
    return { error: simple('Not enough',
      `That needs ${money(stake, cfg)} and you have ${money(w.balance, cfg)}.`) };
  }
  await adjust(env, userId, -stake, why, cfg);
  return { stake };
}

/* ── Duel ──────────────────────────────────────────────── */

/** Two six-sided rolls each, re-rolled until somebody is ahead. */
export function rollDuel(rng = Math.random) {
  const die = () => 1 + Math.floor(rng() * 6);
  for (let tries = 0; tries < 50; tries++) {
    const a = [die(), die()], b = [die(), die()];
    const sa = a[0] + a[1], sb = b[0] + b[1];
    if (sa !== sb) return { a, b, sa, sb, winner: sa > sb ? 'challenger' : 'opponent' };
  }
  // Fifty consecutive ties is not going to happen, but a loop with no
  // exit is worse than a coin flip, so it has one.
  return { a: [6, 6], b: [1, 1], sa: 12, sb: 2, winner: 'challenger' };
}

/** What the winner actually receives from a duel of this size. */
export const duelPrize = stake => {
  const pot = stake * 2;
  return pot - Math.round(pot * DUEL_RAKE);
};

export async function startDuel(env, interaction, targetId, amount) {
  const me = userOf(interaction);
  if (!me.id) return simple('Who are you?', "Couldn't read your Discord account.");
  const cfg = await settings(env);
  if (casinoOff(cfg)) return simple('Closed', 'The casino is shut in this league.');

  const them = String(targetId || '');
  if (!them) return simple('Who?', 'Name somebody to challenge.');
  if (them === String(me.id)) {
    return simple('Not like that', 'You cannot duel yourself, and you would lose the rake.');
  }

  const taken = await takeStake(env, me.id, amount, cfg, 'Duel stake');
  if (taken.error) return taken.error;

  const id = crypto.randomUUID().slice(0, 12);
  await env.DB.prepare(
    `INSERT INTO duel (id, challenger, opponent, stake, at) VALUES (?, ?, ?, ?, ?)`
  ).bind(id, String(me.id), them, taken.stake, Date.now()).run();

  return {
    content: `<@${them}>`,
    allowed_mentions: { users: [them] },
    embeds: [{
      title: '⚔ A duel',
      description: `**${nameOf(me)}** stakes ${money(taken.stake, cfg)} on two dice.\n` +
                   `<@${them}> — match it and highest total takes ` +
                   `${money(duelPrize(taken.stake), cfg)}.`,
      color: GOLD,
      footer: { text: `The house keeps ${Math.round(DUEL_RAKE * 100)}% of the pot. ` +
                      `Unanswered after ${DUEL_EXPIRY_MIN} minutes and the stake comes back.` },
    }],
    components: [{ type: 1, components: [
      { type: 2, style: 3, label: 'Accept', custom_id: `du:${id}:accept` },
      { type: 2, style: 4, label: 'Decline', custom_id: `du:${id}:decline` },
    ] }],
  };
}

export async function onDuelButton(env, interaction, id, action) {
  const me = userOf(interaction);
  const cfg = await settings(env);
  const row = await env.DB.prepare(`SELECT * FROM duel WHERE id = ?`).bind(id).first();

  if (!row) return { type: 4, data: { flags: 64, content: 'That duel is gone.' } };
  if (String(row.opponent) !== String(me.id)) {
    return { type: 4, data: { flags: 64, content:
      'That challenge is not yours to answer.' } };
  }
  if (row.status !== 'open') {
    return { type: 4, data: { flags: 64, content: 'That one has already been answered.' } };
  }

  if (action === 'decline') {
    const claim = await env.DB.prepare(
      `UPDATE duel SET status = 'declined', decided_at = ? WHERE id = ? AND status = 'open'`
    ).bind(Date.now(), id).run();
    if (!claim.meta || !claim.meta.changes) {
      return { type: 4, data: { flags: 64, content: 'Already answered.' } };
    }
    await adjust(env, row.challenger, row.stake, 'Duel declined', cfg);
    return { type: 7, data: {
      embeds: [simple('Declined', `<@${row.opponent}> turned it down. ` +
        `${money(row.stake, cfg)} went back to <@${row.challenger}>.`)],
      components: [],
      allowed_mentions: { parse: [] },
    } };
  }

  // Can they cover it? Checked before the claim, so a failed accept
  // leaves the challenge open for them to try again.
  const w = await wallet(env, me.id, cfg);
  if (w.balance < row.stake) {
    return { type: 4, data: { flags: 64, content:
      `You need ${money(row.stake, cfg)} to match that and you have ${money(w.balance, cfg)}.` } };
  }

  const claim = await env.DB.prepare(
    `UPDATE duel SET status = 'played', decided_at = ? WHERE id = ? AND status = 'open'`
  ).bind(Date.now(), id).run();
  if (!claim.meta || !claim.meta.changes) {
    return { type: 4, data: { flags: 64, content: 'Somebody got there first.' } };
  }

  await adjust(env, me.id, -row.stake, 'Duel stake', cfg);

  const r = rollDuel();
  const winnerId = r.winner === 'challenger' ? row.challenger : row.opponent;
  const prize = duelPrize(row.stake);
  await adjust(env, winnerId, prize, 'Duel won', cfg);
  await env.DB.prepare(`UPDATE duel SET winner = ?, detail = ? WHERE id = ?`)
    .bind(String(winnerId), JSON.stringify(r), id).run();

  const dice = n => ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'][n] || String(n);
  return { type: 7, data: {
    embeds: [{
      title: '⚔ Duel',
      description:
        `<@${row.challenger}>  ${dice(r.a[0])}${dice(r.a[1])}  **${r.sa}**\n` +
        `<@${row.opponent}>  ${dice(r.b[0])}${dice(r.b[1])}  **${r.sb}**\n\n` +
        `<@${winnerId}> takes ${money(prize, cfg)}.`,
      color: GREEN,
      footer: { text: `${money(row.stake * 2, cfg)} in, ` +
                      `${money(row.stake * 2 - prize, cfg)} to the house.` },
    }],
    components: [],
    allowed_mentions: { parse: [] },
  } };
}

/**
 * Give back the stake on challenges nobody answered.
 *
 * Guarded on status so a duel accepted in the same minute as the sweep
 * cannot also be refunded.
 */
export async function sweepDuels(env) {
  const cutoff = Date.now() - DUEL_EXPIRY_MIN * 60000;
  const rows = await env.DB.prepare(
    `SELECT id, challenger, stake FROM duel WHERE status = 'open' AND at < ?`
  ).bind(cutoff).all();

  let refunded = 0;
  for (const r of (rows.results || [])) {
    const claim = await env.DB.prepare(
      `UPDATE duel SET status = 'expired', decided_at = ? WHERE id = ? AND status = 'open'`
    ).bind(Date.now(), r.id).run();
    if (!claim.meta || !claim.meta.changes) continue;
    await adjust(env, r.challenger, r.stake, 'Duel expired');
    refunded++;
  }
  return refunded;
}

/* ── Lottery ───────────────────────────────────────────── */

/**
 * One pot, everybody in, weighted by tickets held.
 *
 * The whole pot goes to the winner. Every other game here keeps an edge,
 * and a lottery that also skimmed would be the fourth place the same
 * money is taxed; this one is pure redistribution, which is also what
 * makes a rolled-over pot worth talking about.
 *
 * It rolls rather than draws when fewer than two people have bought in,
 * because a draw with one entrant is just giving somebody their own money
 * back with extra steps.
 */
export const ticketPrice = cfg => Math.max(1, Number(cfg.lottery_price) || 500);
export const drawEveryHours = cfg => Math.max(1, Number(cfg.lottery_hours) || 24);

/** The open draw, created if there is not one. */
export async function openDraw(env) {
  const row = await env.DB.prepare(
    `SELECT * FROM lottery_draw WHERE status = 'open' ORDER BY n DESC LIMIT 1`).first();
  if (row) return row;

  const last = await env.DB.prepare(
    `SELECT MAX(n) AS n FROM lottery_draw`).first();
  const n = (last && last.n ? last.n : 0) + 1;
  await env.DB.prepare(
    `INSERT INTO lottery_draw (n, pot, status, opened_at) VALUES (?, 0, 'open', ?)`
  ).bind(n, Date.now()).run();
  return { n, pot: 0, status: 'open', opened_at: Date.now() };
}

export async function buyTickets(env, interaction, count) {
  const me = userOf(interaction);
  if (!me.id) return simple('Who are you?', "Couldn't read your Discord account.");
  const cfg = await settings(env);
  if (casinoOff(cfg)) return simple('Closed', 'The casino is shut in this league.');

  const want = Math.max(1, Math.min(100, safeAmount(count, 1)));
  const price = ticketPrice(cfg);
  const cost = want * price;

  const w = await wallet(env, me.id, cfg);
  if (w.balance < cost) {
    return simple('Not enough',
      `${want} ticket${want === 1 ? '' : 's'} costs ${money(cost, cfg)} and you have ` +
      `${money(w.balance, cfg)}.`);
  }

  const draw = await openDraw(env);
  await adjust(env, me.id, -cost, 'Lottery tickets', cfg);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO lottery_ticket (draw, user_id, tickets, spent, at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(draw, user_id) DO UPDATE SET
         tickets = tickets + excluded.tickets,
         spent   = spent + excluded.spent,
         at      = excluded.at`
    ).bind(draw.n, String(me.id), want, cost, Date.now()),
    env.DB.prepare(`UPDATE lottery_draw SET pot = pot + ? WHERE n = ?`).bind(cost, draw.n),
  ]);

  const after = await drawState(env, draw.n);
  return {
    title: '🎟 In the draw',
    description: `${want} ticket${want === 1 ? '' : 's'} for ${money(cost, cfg)}.\n` +
                 `You hold **${after.mine(String(me.id))}** of **${after.tickets}**.`,
    color: GREEN,
    fields: [{ name: `Pot ${money(after.pot, cfg)}`,
               value: `${after.players} player${after.players === 1 ? '' : 's'} in · ` +
                      describeWhen(after.row, cfg) }],
  };
}

/** Tickets, players and pot for one draw, with a per-user lookup. */
export async function drawState(env, n) {
  const row = await env.DB.prepare(`SELECT * FROM lottery_draw WHERE n = ?`).bind(n).first();
  const rows = await env.DB.prepare(
    `SELECT user_id, tickets FROM lottery_ticket WHERE draw = ?`).bind(n).all();
  const held = (rows.results || []);
  return {
    row, n,
    pot: row ? row.pot : 0,
    tickets: held.reduce((a, r) => a + r.tickets, 0),
    players: held.length,
    held,
    mine: id => (held.find(r => String(r.user_id) === String(id)) || { tickets: 0 }).tickets,
  };
}

function describeWhen(row, cfg) {
  if (!row) return 'drawn once enough people are in';
  const due = row.opened_at + drawEveryHours(cfg) * 3600000;
  const left = due - Date.now();
  if (left <= 0) return 'due now';
  const h = Math.floor(left / 3600000), m = Math.round((left % 3600000) / 60000);
  return h ? `drawn in about ${h}h ${m}m` : `drawn in about ${m}m`;
}

export async function showLottery(env, interaction) {
  const cfg = await settings(env);
  const me = userOf(interaction);
  const draw = await openDraw(env);
  const s = await drawState(env, draw.n);
  const mine = s.mine(String(me.id));

  const last = await env.DB.prepare(
    `SELECT * FROM lottery_draw WHERE status = 'drawn' ORDER BY n DESC LIMIT 1`).first();

  return {
    title: `🎟 Lottery · draw ${s.n}`,
    description: `**${money(s.pot, cfg)}** in the pot.\n` +
                 `${s.players} player${s.players === 1 ? '' : 's'}, ` +
                 `${s.tickets} ticket${s.tickets === 1 ? '' : 's'} — ${describeWhen(s.row, cfg)}.`,
    color: s.pot ? GOLD : GREY,
    fields: [
      { name: 'Your tickets',
        value: mine
          ? `**${mine}** — about a ${Math.round(mine / s.tickets * 100)}% shot`
          : `None yet. ${money(ticketPrice(cfg), cfg)} each with \`/lottery buy\`.` },
      ...(last ? [{ name: `Last won by`,
        value: `<@${last.winner}> took ${money(last.won, cfg)} on draw ${last.n}.` }] : []),
    ],
    footer: { text: s.players < LOTTERY_MIN_PLAYERS
      ? `Needs ${LOTTERY_MIN_PLAYERS} players or the pot rolls into the next draw.`
      : 'Winner takes the whole pot.' },
  };
}

/**
 * Draw it, if it is due. Returns what happened, or null if nothing did.
 *
 * Called from the hourly cron, so it has to be safe to call at any time
 * and cheap when there is nothing to do.
 */
export async function runLotteryDraw(env, now = Date.now()) {
  const cfg = await settings(env);
  const row = await env.DB.prepare(
    `SELECT * FROM lottery_draw WHERE status = 'open' ORDER BY n DESC LIMIT 1`).first();
  if (!row) return null;
  if (now < row.opened_at + drawEveryHours(cfg) * 3600000) return null;

  const s = await drawState(env, row.n);

  // Not enough interest: carry the pot and the clock into a new draw
  // rather than handing one person their own stake back.
  if (s.players < LOTTERY_MIN_PLAYERS) {
    const claim = await env.DB.prepare(
      `UPDATE lottery_draw SET status = 'rolled', drawn_at = ? WHERE n = ? AND status = 'open'`
    ).bind(now, row.n).run();
    if (!claim.meta || !claim.meta.changes) return null;
    const next = row.n + 1;
    await env.DB.prepare(
      `INSERT INTO lottery_draw (n, pot, status, opened_at) VALUES (?, ?, 'open', ?)`
    ).bind(next, row.pot, now).run();
    // The tickets move with the pot, so nobody has to buy in twice.
    await env.DB.prepare(`UPDATE lottery_ticket SET draw = ? WHERE draw = ?`)
      .bind(next, row.n).run();
    return { rolled: true, n: row.n, into: next, pot: row.pot };
  }

  const claim = await env.DB.prepare(
    `UPDATE lottery_draw SET status = 'drawn', drawn_at = ? WHERE n = ? AND status = 'open'`
  ).bind(now, row.n).run();
  if (!claim.meta || !claim.meta.changes) return null;   // another tick got it

  const winner = pickWinner(s.held);
  await adjust(env, winner, row.pot, `Lottery draw ${row.n}`, cfg);
  await env.DB.prepare(
    `UPDATE lottery_draw SET winner = ?, won = ?, tickets = ?, players = ? WHERE n = ?`
  ).bind(String(winner), row.pot, s.tickets, s.players, row.n).run();

  return { rolled: false, n: row.n, winner, pot: row.pot,
           tickets: s.tickets, players: s.players };
}

/** Weighted by tickets held. Exported so the weighting can be tested. */
export function pickWinner(held, rng = Math.random) {
  const total = held.reduce((a, r) => a + r.tickets, 0);
  if (total <= 0) return null;
  let roll = rng() * total;
  for (const r of held) {
    roll -= r.tickets;
    if (roll < 0) return String(r.user_id);
  }
  return String(held[held.length - 1].user_id);
}
