/**
 * The part of the games that talks to Discord and to D1.
 *
 * casino.js holds the rules and knows nothing about either. This file
 * holds the stake, the buttons and the row in the database, and is the
 * only place money moves.
 *
 * One rule runs through all of it: the stake leaves the wallet when the
 * game starts, not when it ends. A hand that is abandoned halfway, a
 * Worker that restarts, a button pressed twice — none of those can pay out
 * twice or leave a bet uncollected, because by then the money has already
 * gone and the only question left is what comes back.
 */

import {
  dealBlackjack, hit, dealerPlay, settle, drawCards, sayScore, score, isBlackjack,
  parseBet, spin, settleSpin, drawWheel, colourOf, BETS,
} from './casino.js';
import { settings, money, wallet, adjust } from './economy.js';

const GOLD = 0xFFC400;
const BRAND = 0xE10600;
const GREY = 0x9E9E9E;
const GREEN = 0x4CAF50;

const simple = (title, description, color) => ({ title, description, color: color || GREY });
const num = (v, d) => (v === '' || v == null || isNaN(Number(v)) ? d : Number(v));
const userOf = i => (i.member && i.member.user) || i.user || {};
const nameOf = u => u.global_name || u.username || 'Someone';

/** Short, unguessable, and short enough to sit in a custom_id. */
const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

/* ── The in-flight game row ────────────────────────────── */

async function saveGame(env, id, userId, kind, bet, state) {
  await env.DB.prepare(
    `INSERT INTO casino_game (id, user_id, kind, bet, state, at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET state = excluded.state, at = excluded.at`
  ).bind(id, String(userId), kind, Math.round(bet), JSON.stringify(state), Date.now()).run();
}

async function loadGame(env, id) {
  const row = await env.DB.prepare(
    `SELECT id, user_id, kind, bet, state, at FROM casino_game WHERE id = ?`).bind(String(id)).first();
  if (!row) return null;
  try { return { ...row, state: JSON.parse(row.state) }; } catch { return null; }
}

const dropGame = (env, id) =>
  env.DB.prepare(`DELETE FROM casino_game WHERE id = ?`).bind(String(id)).run();

/**
 * Clear games nobody came back to.
 *
 * The stake is already gone by the time a row exists, so an abandoned row
 * is not money in limbo — it is only clutter. An hour is far longer than
 * any hand takes.
 */
export async function sweepGames(env) {
  try {
    const cut = Date.now() - 60 * 60 * 1000;
    const res = await env.DB.prepare(`DELETE FROM casino_game WHERE at < ?`).bind(cut).run();
    return (res.meta && res.meta.changes) || 0;
  } catch { return 0; }
}

/* ── Buttons ───────────────────────────────────────────── */

const button = (id, label, style = 2, disabled = false) =>
  ({ type: 2, style, label, custom_id: id, disabled });

const row = (...buttons) => ({ type: 1, components: buttons.filter(Boolean) });

/** A reply that carries buttons. embedReply in index.js cannot. */
export const withButtons = (embed, components, ephemeral) => ({
  type: 4,
  data: {
    embeds: [embed],
    components: components || [],
    allowed_mentions: { parse: [] },
    ...(ephemeral ? { flags: 64 } : {}),
  },
});

/** The same, but replacing the message the button was on. */
export const replaceWith = (embed, components) => ({
  type: 7,
  data: { embeds: [embed], components: components || [], allowed_mentions: { parse: [] } },
});

/* ── Stakes ────────────────────────────────────────────── */

async function takeStake(env, userId, amount, cfg, reason) {
  const lo = num(cfg.bet_min, 50), hi = num(cfg.bet_max, 25000);
  const n = Math.round(Number(amount) || 0);
  if (!Number.isFinite(n) || n < lo) {
    return { error: simple('Too small', `The smallest stake is ${money(lo, cfg)}.`) };
  }
  if (n > hi) {
    return { error: simple('Too big', `The largest stake is ${money(hi, cfg)}.`) };
  }
  const out = await adjust(env, userId, -n, reason, cfg);
  if (!out) {
    const w = await wallet(env, userId, cfg);
    return { error: simple('Not enough',
      `That is ${money(n, cfg)} and you have ${money(w.balance, cfg)}.`) };
  }
  return { stake: n, after: out };
}

const casinoOff = cfg => num(cfg.casino_enabled, 1) !== 1;

/* ── Blackjack ─────────────────────────────────────────── */

function blackjackEmbed(game, bet, cfg, done, result) {
  const hidden = !done;
  const lines = [
    '```',
    `DEALER  ${hidden ? '?' : sayScore(game.dealer)}`,
    drawCards(game.dealer, hidden ? 1 : -1),
    '',
    `YOU     ${sayScore(game.player)}`,
    drawCards(game.player),
    '```',
  ];
  const e = {
    title: done ? (result.outcome === 'win' ? '🂡 You win'
                 : result.outcome === 'push' ? '🂡 Push' : '🂡 Dealer takes it')
                : '🂡 Blackjack',
    description: lines.join('\n'),
    color: done ? (result.outcome === 'win' ? GREEN : result.outcome === 'push' ? GREY : BRAND) : GOLD,
  };
  if (done) {
    const back = Math.round(bet * result.mult);
    e.fields = [{
      name: result.why,
      value: result.mult === 0 ? `Lost ${money(bet, cfg)}.`
           : result.mult === 1 ? `Stake returned — ${money(bet, cfg)}.`
           : `Returned ${money(back, cfg)} on a ${money(bet, cfg)} stake.`,
    }];
  } else {
    e.footer = { text: `Stake ${money(bet, cfg)}` };
  }
  return e;
}

export async function startBlackjack(env, interaction, amount) {
  const user = userOf(interaction);
  if (!user.id) return simple('Who are you?', "Couldn't read your Discord account.");
  const cfg = await settings(env);
  if (casinoOff(cfg)) return simple('Closed', 'The casino is shut in this league.');

  const taken = await takeStake(env, user.id, amount, cfg, 'Blackjack stake');
  if (taken.error) return taken.error;

  const game = dealBlackjack();
  const id = newId();

  // A natural ends it before anyone presses anything.
  if (isBlackjack(game.player) || isBlackjack(game.dealer)) {
    const result = settle(game);
    if (result.mult > 0) {
      await adjust(env, user.id, Math.round(taken.stake * result.mult), 'Blackjack', cfg);
    }
    return withButtons(blackjackEmbed(game, taken.stake, cfg, true, result), []);
  }

  await saveGame(env, id, user.id, 'blackjack', taken.stake, game);
  // Doubling is only offered on the opening two cards, which is the rule
  // and also the only point at which it is a decision rather than a trap.
  return withButtons(blackjackEmbed(game, taken.stake, cfg, false), [
    row(button(`bj:${id}:hit`, 'Hit', 1),
        button(`bj:${id}:stand`, 'Stand', 2),
        button(`bj:${id}:double`, 'Double', 2)),
  ]);
}

async function finishBlackjack(env, g, cfg, game) {
  const played = dealerPlay(game);
  const result = settle(played);
  if (result.mult > 0) {
    await adjust(env, g.user_id, Math.round(g.bet * result.mult), 'Blackjack', cfg);
  }
  await dropGame(env, g.id);
  return replaceWith(blackjackEmbed(played, g.bet, cfg, true, result), []);
}

async function onBlackjackButton(env, interaction, id, action) {
  const user = userOf(interaction);
  const g = await loadGame(env, id);
  if (!g || g.kind !== 'blackjack') {
    return withButtons(simple('Gone', 'That hand has already finished.'), [], true);
  }
  if (String(g.user_id) !== String(user.id)) {
    return withButtons(simple('Not your hand', 'Deal your own with `/blackjack`.'), [], true);
  }
  const cfg = await settings(env);
  let game = g.state;

  if (action === 'double') {
    // Doubling takes a second stake, draws exactly one card and ends it.
    const extra = await adjust(env, user.id, -g.bet, 'Blackjack double', cfg);
    if (!extra) {
      return withButtons(simple('Not enough to double',
        `Doubling needs another ${money(g.bet, cfg)}.`), [], true);
    }
    game = hit(game);
    const doubled = { ...g, bet: g.bet * 2 };
    if (score(game.player).bust) {
      const result = settle({ ...game, dealer: game.dealer });
      await dropGame(env, g.id);
      return replaceWith(blackjackEmbed(game, doubled.bet, cfg, true, result), []);
    }
    return finishBlackjack(env, doubled, cfg, game);
  }

  if (action === 'hit') {
    game = hit(game);
    if (score(game.player).bust) {
      const result = settle(game);
      await dropGame(env, g.id);
      return replaceWith(blackjackEmbed(game, g.bet, cfg, true, result), []);
    }
    await saveGame(env, g.id, g.user_id, 'blackjack', g.bet, game);
    return replaceWith(blackjackEmbed(game, g.bet, cfg, false), [
      row(button(`bj:${g.id}:hit`, 'Hit', 1), button(`bj:${g.id}:stand`, 'Stand', 2)),
    ]);
  }

  return finishBlackjack(env, g, cfg, game);
}

/* ── Roulette ──────────────────────────────────────────── */

export async function playRoulette(env, interaction, on, amount) {
  const user = userOf(interaction);
  if (!user.id) return simple('Who are you?', "Couldn't read your Discord account.");
  const cfg = await settings(env);
  if (casinoOff(cfg)) return simple('Closed', 'The casino is shut in this league.');

  const bet = parseBet(on);
  if (!bet) {
    return simple('No such bet',
      'Back a colour, odd or even, high or low, a dozen, or a number from 0 to 36.');
  }

  const taken = await takeStake(env, user.id, amount, cfg, `Roulette: ${bet.label}`);
  if (taken.error) return taken.error;

  const n = spin();
  const mult = settleSpin(bet, n);
  const back = Math.round(taken.stake * mult);
  if (back > 0) await adjust(env, user.id, back, `Roulette: ${bet.label}`, cfg);

  const w = await wallet(env, user.id, cfg);
  return {
    title: mult > 0 ? '🎡 Winner' : '🎡 No luck',
    description: '```\n' + drawWheel(n) + '\n```',
    color: mult > 0 ? GREEN : BRAND,
    fields: [{
      name: bet.label,
      value: mult > 0
        ? `Paid ${bet.pays}:1 — ${money(back, cfg)} back on ${money(taken.stake, cfg)}.`
        : `Lost ${money(taken.stake, cfg)}.`,
    }],
    footer: { text: `${nameOf(user)} · balance ${money(w.balance, cfg)}` },
  };
}

/** The bet types, for the command's typeahead. */
export const rouletteChoices = q => {
  const all = BETS.map(b => ({ name: b.label, value: b.id, pays: b.pays }));
  // Numbers are not listed one by one — thirty-seven of them would bury
  // the named bets — but a typed number is offered back as a straight bet.
  const typed = String(q || '').trim();
  if (/^\d{1,2}$/.test(typed) && Number(typed) <= 36) {
    all.unshift({ name: `${typed} — straight up, pays 35:1`, value: typed, pays: 35 });
  }
  const needle = typed.toLowerCase();
  return all
    .filter(b => !needle || b.name.toLowerCase().includes(needle) || b.value === needle)
    .slice(0, 25)
    .map(b => ({ name: b.pays === 35 ? b.name : `${b.name} — pays ${b.pays}:1`, value: b.value }));
};

/* ── Routing ───────────────────────────────────────────── */

/**
 * A button press. Returns null when the custom_id is not ours, so other
 * component handlers can be added later without touching this one.
 */
export async function handleComponent(interaction, env) {
  const id = String((interaction.data || {}).custom_id || '');
  const [tag, gameId, action] = id.split(':');
  if (tag === 'bj') return onBlackjackButton(env, interaction, gameId, action);
  if (tag === 'wk') return onShiftButton(env, interaction, gameId, action);
  return null;
}

/* ── The shift activity ────────────────────────────────── */
// Imported late to keep the casino's rules free of job logic.
import { shiftQuestion, SHIFT_FALLBACK } from './shift.js';

/**
 * Clocking on now asks something before it pays.
 *
 * A job used to be a cooldown with a payout attached — the only decision
 * was which one had come up. A question makes a shift a thing you do, and
 * tying the questions to the job and to racing means the economy rewards
 * knowing the sport rather than rewards a timer.
 *
 * Getting it wrong still pays. The shift happened; it just went badly.
 */
export async function startShift(env, interaction, job, cfg, done) {
  const user = userOf(interaction);
  const q = shiftQuestion(job.id) || SHIFT_FALLBACK;
  const id = newId();

  await saveGame(env, id, user.id, 'shift', 0, {
    job: { id: job.id, name: job.name, emoji: job.emoji,
           min: num(job.min_pay, 0), max: num(job.max_pay, 0), cooldown: num(job.cooldown_min, 60) },
    q: { prompt: q.prompt, options: q.options, answer: q.answer, note: q.note },
    done,
  });

  return withButtons({
    title: `${job.emoji || '🔧'} ${job.name}`,
    description: `**${q.prompt}**`,
    color: GOLD,
    footer: { text: `Pays ${money(num(job.min_pay, 0), cfg)}–${money(num(job.max_pay, 0), cfg)}` },
  }, [row(...q.options.map((opt, i) =>
    button(`wk:${id}:${i}`, opt.length > 78 ? opt.slice(0, 77) + '…' : opt, 2)))]);
}

async function onShiftButton(env, interaction, id, choiceRaw) {
  const user = userOf(interaction);
  const g = await loadGame(env, id);
  if (!g || g.kind !== 'shift') {
    return withButtons(simple('Gone', 'That shift has already been clocked off.'), [], true);
  }
  if (String(g.user_id) !== String(user.id)) {
    return withButtons(simple('Not your shift', 'Clock on yourself with `/work`.'), [], true);
  }

  const cfg = await settings(env);
  const { job, q, done } = g.state;
  const choice = Number(choiceRaw);
  const right = choice === q.answer;

  const span = Math.max(0, job.max - job.min);
  const full = job.min + Math.round(Math.random() * span);
  // A wrong answer is still a shift worked, at the bottom of the range.
  const share = Math.min(100, Math.max(0, num(cfg.shift_fail_pct, 40)));
  const pay = right ? full : Math.max(1, Math.round(full * share / 100));

  await env.DB.prepare(
    `INSERT INTO work_log (user_id, job, last_at, times, earned) VALUES (?, ?, ?, 1, ?)
     ON CONFLICT (user_id, job) DO UPDATE SET
       last_at = excluded.last_at, times = times + 1, earned = earned + excluded.earned`
  ).bind(user.id, job.id, Date.now(), pay).run();

  const w = await adjust(env, user.id, pay, `Work: ${job.name}`, cfg);
  await dropGame(env, g.id);

  const chosen = q.options[choice] || '—';
  return replaceWith({
    title: `${job.emoji || '🔧'} ${job.name}`,
    description: right
      ? `**${chosen}** — right.\n${nameOf(user)} earned ${money(pay, cfg)}.`
      : `**${chosen}** — not quite. It was **${q.options[q.answer]}**.\n` +
        `${nameOf(user)} earned ${money(pay, cfg)} for turning up.`,
    color: right ? GREEN : GREY,
    fields: q.note ? [{ name: 'For next time', value: q.note }] : undefined,
    footer: { text: `Shift ${done} · balance ${money(w.balance, cfg)}` },
  }, []);
}

/* ── Betting on a race ─────────────────────────────────── */

import {
  openBookFor, getBook, placeBet, betsFor, returns as betReturns,
} from './book.js';

const price = n => (Number(n) || 0).toFixed(2);

/** The board, longest shot last, with where the money has gone. */
export async function showOdds(env, interaction, cls) {
  const cfg = await settings(env);
  const book = await openBookFor(env, cls);
  if (!book) {
    return simple('Nothing open',
      `No book is running on ${String(cls).toUpperCase()} right now.`);
  }
  const pot = book.runners.reduce((a, r) => a + (Number(r.staked) || 0), 0);
  const lines = book.runners.map(r => {
    const drift = Number(r.odds) - Number(r.open_odds);
    const arrow = Math.abs(drift) < 0.05 ? '  ' : drift < 0 ? '▼' : '▲';
    return `\`${price(r.odds).padStart(6)}\` ${arrow} **${r.name}**` +
           (r.staked ? `  ·  ${money(r.staked, cfg)} on` : '');
  });
  return {
    title: `🎟 ${book.race}`,
    description: lines.join('\n'),
    color: GOLD,
    fields: [{
      name: 'How it works',
      value: `Prices move every hour toward wherever the money goes, so getting on early ` +
             `is worth something. Your price is locked when you bet.\n` +
             `\`/bet driver:<name> amount:<stake>\``,
    }],
    footer: { text: pot ? `${money(pot, cfg)} staked in total` : 'No money on yet' },
  };
}

export async function placeRaceBet(env, interaction, cls, driverQuery, amount) {
  const user = userOf(interaction);
  if (!user.id) return simple('Who are you?', "Couldn't read your Discord account.");
  const cfg = await settings(env);

  const book = await openBookFor(env, cls);
  if (!book) {
    return simple('Nothing open', `No book is running on ${String(cls).toUpperCase()} right now.`);
  }

  const q = String(driverQuery || '').trim().toLowerCase();
  const runner = book.runners.find(r => r.driver_id.toLowerCase() === q)
              || book.runners.find(r => r.name.toLowerCase() === q)
              || book.runners.find(r => r.name.toLowerCase().includes(q));
  if (!runner) {
    return simple('Not in this race',
      `Nobody called “${driverQuery}” is running. \`/odds\` shows the field.`);
  }

  const taken = await takeStake(env, user.id, amount, cfg, `Bet: ${runner.name}`);
  if (taken.error) return taken.error;

  // The stake is already out of the wallet; if the row fails to write, it
  // goes straight back rather than vanishing.
  let placed;
  try {
    placed = await placeBet(env, { bookId: book.id, userId: user.id,
                                   driverId: runner.driver_id, stake: taken.stake });
  } catch (err) {
    await adjust(env, user.id, taken.stake, 'Bet refunded', cfg);
    return simple('Could not place that', String(err && err.message || err));
  }

  const w = await wallet(env, user.id, cfg);
  return {
    title: '🎟 Bet on',
    description: `**${runner.name}** to win ${book.race}\n` +
                 `${money(taken.stake, cfg)} at **${price(placed.odds)}**`,
    color: GOLD,
    fields: [{ name: 'Returns if it wins', value: money(placed.returns, cfg) }],
    footer: { text: `${nameOf(user)} · balance ${money(w.balance, cfg)}` },
  };
}

export async function showMyBets(env, interaction) {
  const user = userOf(interaction);
  if (!user.id) return simple('Who are you?', "Couldn't read your Discord account.");
  const cfg = await settings(env);
  const rows = await betsFor(env, user.id, 12);
  if (!rows.length) {
    return simple('Nothing on', 'You have not had a bet yet. `/odds` shows what is running.');
  }
  const lines = rows.map(b => {
    const stake = money(b.stake, cfg);
    const name = b.driver_name || b.driver_id;
    if (!b.settled) {
      return `⏳ **${name}** — ${stake} at ${price(b.odds)} · ` +
             `${money(betReturns(b.stake, b.odds), cfg)} if it wins`;
    }
    return b.won
      ? `✅ **${name}** — ${stake} at ${price(b.odds)} · won ${money(b.returned, cfg)}`
      : `❌ **${name}** — ${stake} at ${price(b.odds)}`;
  });
  const open = rows.filter(b => !b.settled);
  return {
    title: '🎟 Your bets',
    description: lines.join('\n'),
    color: GOLD,
    footer: { text: open.length
      ? `${open.length} still running · ${money(open.reduce((a, b) => a + b.stake, 0), cfg)} at risk`
      : 'Nothing outstanding' },
  };
}

/** Runners in the open book, for the /bet typeahead. */
export async function betChoices(env, cls, q) {
  const book = await openBookFor(env, cls);
  if (!book) return [];
  const needle = String(q || '').trim().toLowerCase();
  return book.runners
    .filter(r => !needle || r.name.toLowerCase().includes(needle))
    .slice(0, 25)
    .map(r => ({ name: `${r.name} — ${price(r.odds)}`, value: r.driver_id }));
}
