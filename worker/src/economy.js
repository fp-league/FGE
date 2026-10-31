/**
 * FGE economy.
 *
 * Credits are earned — by working, by turning up every day, by finishing a
 * race, by selling duplicates you didn't want — and spent on packs. The
 * eight-hourly free pack stays, because an economy nobody can get into is
 * just a wall, but everything above it is bought.
 *
 * Nothing here is hard-coded that an admin might sensibly want to change:
 * prices, odds, payouts, jobs and the cards themselves all live in D1 and
 * are edited from the admin panel. The code decides the rules, the tables
 * decide the numbers.
 */

import { RARITY, RARITIES, drawPack, fullSet, SET, packEmbeds } from './cards.js';

const userOf = i => (i.member && i.member.user) || i.user || {};
const nameOf = u => u.global_name || u.username || 'Someone';
const classLabel = c => (c === 'gt4' ? 'GT4' : 'GT3');
const GOLD = 0xFFC400;
const BRAND = 0xE10600;   // one set, one colour
const GREY = 0x9E9E9E;

const simple = (title, description, color) => ({ title, description, color: color || GREY });

/* ── Settings ──────────────────────────────────────────── */

const DEFAULTS = {
  currency_name: 'Credits',
  currency_emoji: '🪙',
  starting_balance: '750',
  daily_amount: '300',
  daily_streak_bonus: '75',
  daily_streak_max: '7',
  prize_table: '[1200,900,700,550,450,360,290,230,180,140]',
  prize_finish: '90',
  prize_fastest: '150',
  sell_values: '{"common":25,"uncommon":60,"rare":140,"epic":350,"legendary":900}',
  pay_min: '10',
  pay_max: '100000',
  // Maintenance. One switch: the bot refuses every command and the site
  // puts up a holding screen, so the league can be worked on without
  // anyone pulling a pack out of a half-finished set.
  maintenance: '0',
  maintenance_title: 'ERROR',
  maintenance_message: 'FGE is being worked on right now. Everything is coming back shortly.',
};

/**
 * Every setting, with the defaults filled in for anything missing. Falls back
 * entirely to the defaults when the table isn't there, so a Worker deployed
 * before the migration ran still answers instead of throwing.
 */
export async function settings(env) {
  const out = { ...DEFAULTS };
  try {
    const rows = await env.DB.prepare(`SELECT key, value FROM econ_setting`).all();
    for (const r of (rows.results || [])) out[r.key] = r.value;
  } catch { /* defaults */ }
  return out;
}

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
function parseJson(v, d) { try { const o = JSON.parse(v); return o == null ? d : o; } catch { return d; } }

/** `1,250 🪙` — the one place money is turned into text. */
export function money(n, cfg) {
  return `**${Math.round(Number(n) || 0).toLocaleString('en-GB')}** ${(cfg && cfg.currency_emoji) || '🪙'}`;
}

/* ── Wallets ───────────────────────────────────────────── */

/**
 * Somebody's balance, creating the wallet with the starting balance the
 * first time they do anything. A new player with nothing could not buy a
 * pack, so the opening balance is the economy's front door.
 */
export async function wallet(env, userId, cfg) {
  const id = String(userId);
  const row = await env.DB.prepare(
    `SELECT balance, lifetime FROM wallet WHERE user_id = ?`).bind(id).first();
  if (row) return { balance: row.balance, lifetime: row.lifetime, isNew: false };

  const start = Math.max(0, num((cfg || await settings(env)).starting_balance, 750));
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO wallet (user_id, balance, lifetime, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id) DO NOTHING`).bind(id, start, start, now),
    env.DB.prepare(
      `INSERT INTO ledger (user_id, delta, reason, at) VALUES (?, ?, ?, ?)`
    ).bind(id, start, 'Welcome bonus', now),
  ]);
  return { balance: start, lifetime: start, isNew: true };
}

/**
 * Move money. Returns null when a spend would overdraw, so callers can say
 * "you can't afford that" rather than leaving someone in the red.
 *
 * The balance check and the write are one UPDATE with the condition in the
 * WHERE clause: two requests arriving together can't both pass a separate
 * check and both deduct.
 */
export async function adjust(env, userId, delta, reason, cfg) {
  const id = String(userId);
  const d = Math.round(Number(delta) || 0);
  const now = Date.now();
  await wallet(env, id, cfg);

  if (d < 0) {
    const res = await env.DB.prepare(
      `UPDATE wallet SET balance = balance + ?, updated_at = ?
        WHERE user_id = ? AND balance >= ?`
    ).bind(d, now, id, -d).run();
    const changed = (res.meta && (res.meta.changes ?? res.meta.rows_written)) ?? 1;
    if (!changed) return null;
  } else {
    await env.DB.prepare(
      `UPDATE wallet SET balance = balance + ?, lifetime = lifetime + ?, updated_at = ?
        WHERE user_id = ?`).bind(d, d, now, id).run();
  }

  await env.DB.prepare(
    `INSERT INTO ledger (user_id, delta, reason, at) VALUES (?, ?, ?, ?)`
  ).bind(id, d, String(reason || '').slice(0, 120), now).run();

  const row = await env.DB.prepare(
    `SELECT balance, lifetime FROM wallet WHERE user_id = ?`).bind(id).first();
  return { balance: row ? row.balance : 0, lifetime: row ? row.lifetime : 0 };
}

/* ── Time ──────────────────────────────────────────────── */

function fmtLeft(ms) {
  const m = Math.ceil(ms / 60000);
  if (m < 60) return `${m} minute${m !== 1 ? 's' : ''}`;
  const h = Math.floor(m / 60), rem = m % 60;
  return `${h}h${rem ? ` ${rem}m` : ''}`;
}

const rand = (lo, hi) => lo + Math.floor(Math.random() * (Math.max(lo, hi) - lo + 1));

/* ── Jobs ──────────────────────────────────────────────── */

export async function listJobs(env) {
  try {
    const rows = await env.DB.prepare(
      `SELECT id, name, emoji, blurb, min_pay, max_pay, cooldown_min
         FROM job WHERE enabled = 1 ORDER BY sort, min_pay`).all();
    return rows.results || [];
  } catch { return []; }
}

/* ── /work ─────────────────────────────────────────────── */

export async function doWork(env, interaction, wanted) {
  const user = userOf(interaction);
  if (!user.id) return simple('Who are you?', "Couldn't read your Discord account.");

  const cfg = await settings(env);
  const jobs = await listJobs(env);
  if (!jobs.length) return simple('No work going', 'There are no jobs set up yet.');

  const now = Date.now();
  const logs = await env.DB.prepare(
    `SELECT job, last_at, times, earned FROM work_log WHERE user_id = ?`).bind(user.id).all();
  const by = {};
  for (const r of (logs.results || [])) by[r.job] = r;

  const readyAt = j => (by[j.id] ? by[j.id].last_at + j.cooldown_min * 60000 : 0);

  // No job named: show the board, with what's ready and what isn't. Picking
  // from a list beats guessing a job id.
  const q = String(wanted || '').trim().toLowerCase();
  if (!q) {
    const lines = jobs.map(j => {
      const left = readyAt(j) - now;
      const state = left > 0 ? `ready in ${fmtLeft(left)}` : '**ready**';
      return `${j.emoji} **${j.name}** — ${j.min_pay}–${j.max_pay} ${cfg.currency_emoji} · ${state}\n` +
             ` \`/work job:${j.id}\`${j.blurb ? ` — ${j.blurb}` : ''}`;
    });
    const ready = jobs.filter(j => readyAt(j) <= now).length;
    return {
      title: 'Work',
      description: lines.join('\n'),
      color: ready ? GOLD : GREY,
      footer: { text: ready ? `${ready} job${ready !== 1 ? 's' : ''} ready now`
                            : 'Nothing ready — come back later' },
    };
  }

  const job = jobs.find(j => j.id === q)
           || jobs.find(j => j.name.toLowerCase() === q)
           || jobs.find(j => j.name.toLowerCase().includes(q));
  if (!job) return simple('No such job', `Nothing called “${wanted}”. Run \`/work\` to see the board.`);

  const left = readyAt(job) - now;
  if (left > 0) {
    return simple(`${job.emoji} Not yet`,
      `**${job.name}** is ready again in **${fmtLeft(left)}**.\nRun \`/work\` to see what else is going.`);
  }

  const pay = rand(num(job.min_pay, 0), num(job.max_pay, 0));
  await env.DB.prepare(
    `INSERT INTO work_log (user_id, job, last_at, times, earned) VALUES (?, ?, ?, 1, ?)
     ON CONFLICT (user_id, job) DO UPDATE SET
       last_at = excluded.last_at, times = times + 1, earned = earned + excluded.earned`
  ).bind(user.id, job.id, now, pay).run();

  const w = await adjust(env, user.id, pay, `Work: ${job.name}`, cfg);
  const done = (by[job.id] ? by[job.id].times : 0) + 1;

  return {
    title: `${job.emoji} ${job.name}`,
    description: `${nameOf(user)} earned ${money(pay, cfg)}.\nBalance: ${money(w.balance, cfg)}`,
    color: GOLD,
    footer: { text: `Shift ${done} · ready again in ${fmtLeft(job.cooldown_min * 60000)}` },
  };
}

/* ── /daily ────────────────────────────────────────────── */

const DAY = 24 * 60 * 60 * 1000;

export async function doDaily(env, interaction) {
  const user = userOf(interaction);
  if (!user.id) return simple('Who are you?', "Couldn't read your Discord account.");

  const cfg = await settings(env);
  const now = Date.now();
  const row = await env.DB.prepare(
    `SELECT last_at, times FROM work_log WHERE user_id = ? AND job = 'daily'`
  ).bind(user.id).first();

  // 22 hours, not 24, so claiming at the same time each day doesn't slowly
  // drift out of reach.
  const WINDOW = 22 * 60 * 60 * 1000;
  if (row && now - row.last_at < WINDOW) {
    return simple('Already claimed',
      `Your next daily is ready in **${fmtLeft(WINDOW - (now - row.last_at))}**.`);
  }

  // Miss two days and the streak is gone; that is what a streak is.
  const streak = (row && now - row.last_at < 2 * DAY) ? (row.times || 0) + 1 : 1;
  const base  = Math.max(0, num(cfg.daily_amount, 300));
  const step  = Math.max(0, num(cfg.daily_streak_bonus, 75));
  const cap   = Math.max(1, num(cfg.daily_streak_max, 7));
  const bonus = step * Math.min(streak, cap);
  const total = base + bonus;

  await env.DB.prepare(
    `INSERT INTO work_log (user_id, job, last_at, times, earned) VALUES (?, 'daily', ?, ?, ?)
     ON CONFLICT (user_id, job) DO UPDATE SET
       last_at = excluded.last_at, times = excluded.times, earned = earned + excluded.earned`
  ).bind(user.id, now, streak, total).run();

  const w = await adjust(env, user.id, total, `Daily (streak ${streak})`, cfg);

  return {
    title: '📅 Daily claimed',
    description: `${money(base, cfg)} + ${money(bonus, cfg)} streak bonus\n` +
                 `**Day ${streak}**${streak >= cap ? ' — bonus is maxed out' : ''}\n` +
                 `Balance: ${money(w.balance, cfg)}`,
    color: GOLD,
    footer: { text: 'Come back within 48 hours to keep the streak' },
  };
}

/* ── /balance ──────────────────────────────────────────── */

export async function showBalance(env, interaction, targetId) {
  const user = userOf(interaction);
  const id = targetId || user.id;
  if (!id) return simple('Who are you?', "Couldn't read your Discord account.");

  const cfg = await settings(env);
  const w = await wallet(env, id, cfg);

  const rank = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM wallet WHERE balance > ?`).bind(w.balance).first();

  const packs = await env.DB.prepare(
    `SELECT total_packs, total_cards FROM card_packs WHERE user_id = ?`).bind(String(id)).first();
  const held = await env.DB.prepare(
    `SELECT COUNT(*) AS held, COALESCE(SUM(copies),0) AS copies
       FROM card_collection WHERE user_id = ?`).bind(String(id)).first();

  const recent = await env.DB.prepare(
    `SELECT delta, reason FROM ledger WHERE user_id = ? ORDER BY at DESC LIMIT 5`
  ).bind(String(id)).all();

  const fields = [
    { name: 'Balance',  value: money(w.balance, cfg),  inline: true },
    { name: 'Ever earned', value: money(w.lifetime, cfg), inline: true },
    { name: 'Rank',     value: `#${(rank ? rank.n : 0) + 1}`, inline: true },
  ];
  if (packs || held) {
    fields.push({ name: 'Packs opened', value: String((packs && packs.total_packs) || 0), inline: true });
    fields.push({ name: 'Cards held', value: String((held && held.copies) || 0), inline: true });
    fields.push({ name: 'Unique', value: String((held && held.held) || 0), inline: true });
  }

  const log = (recent.results || []).map(r =>
    `${r.delta >= 0 ? '＋' : '−'}${Math.abs(r.delta).toLocaleString('en-GB')} · ${r.reason}`);

  return {
    title: targetId ? 'Wallet' : `${nameOf(user)}'s wallet`,
    description: targetId ? `<@${id}>` : undefined,
    color: GOLD,
    fields: log.length ? [...fields, { name: 'Recent', value: log.join('\n') }] : fields,
    footer: { text: w.isNew ? 'Opened with a welcome bonus' : 'Earn more with /work and /daily' },
  };
}

/* ── /rich ─────────────────────────────────────────────── */

export async function showRich(env) {
  const cfg = await settings(env);
  const rows = await env.DB.prepare(
    `SELECT user_id, balance, lifetime FROM wallet
      ORDER BY balance DESC, lifetime DESC LIMIT 10`).all();
  const list = rows.results || [];
  if (!list.length) return simple('Nobody has anything yet', 'Start earning with `/work`.');

  const medal = i => ['🥇', '🥈', '🥉'][i] || `\`${String(i + 1).padStart(2)}\``;
  return {
    title: `Richest in the paddock`,
    description: list.map((r, i) =>
      `${medal(i)} <@${r.user_id}> — ${money(r.balance, cfg)}`).join('\n'),
    color: GOLD,
    footer: { text: 'By balance. Spending drops you down it.' },
  };
}

/* ── /pay ──────────────────────────────────────────────── */

export async function payUser(env, interaction, toId, amount) {
  const user = userOf(interaction);
  if (!user.id) return simple('Who are you?', "Couldn't read your Discord account.");
  if (!toId) return simple('Pay who?', 'Pick someone: `/pay user:@them amount:500`.');
  if (String(toId) === String(user.id)) {
    return simple('That is you', 'Moving money to yourself achieves very little.');
  }

  const cfg = await settings(env);
  const n = Math.round(Number(amount) || 0);
  const lo = num(cfg.pay_min, 10), hi = num(cfg.pay_max, 100000);
  if (!Number.isFinite(n) || n < lo) return simple('Too small', `The smallest transfer is ${money(lo, cfg)}.`);
  if (n > hi) return simple('Too big', `The largest transfer is ${money(hi, cfg)}.`);

  const out = await adjust(env, user.id, -n, `Paid <@${toId}>`, cfg);
  if (!out) {
    const w = await wallet(env, user.id, cfg);
    return simple('Not enough', `That is ${money(n, cfg)} and you have ${money(w.balance, cfg)}.`);
  }
  await adjust(env, toId, n, `From <@${user.id}>`, cfg);

  return {
    title: '💸 Sent',
    description: `${nameOf(user)} → <@${toId}>  ·  ${money(n, cfg)}\n` +
                 `Your balance: ${money(out.balance, cfg)}`,
    color: GOLD,
  };
}

/* ── Packs for sale ────────────────────────────────────── */

export async function listPackTypes(env) {
  try {
    const rows = await env.DB.prepare(
      `SELECT * FROM pack_type WHERE enabled = 1 ORDER BY sort, price`).all();
    return rows.results || [];
  } catch { return []; }
}

/** DB row → the shape drawPack wants. */
function packOpts(row) {
  return {
    size: row.size,
    odds: parseJson(row.odds, null),
    pool: parseJson(row.pool, null),
    guarantee: RARITIES.includes(row.guarantee) ? row.guarantee : null,
  };
}

/* ── /shop ─────────────────────────────────────────────── */

export async function showShop(env, interaction) {
  const cfg = await settings(env);
  const packs = await listPackTypes(env);
  if (!packs.length) {
    return simple('Shop is empty', 'No packs are on sale. An admin can add some.', BRAND);
  }

  const user = userOf(interaction);
  const w = user.id ? await wallet(env, user.id, cfg) : { balance: 0 };

  const lines = packs.map(p => {
    const bits = [`${p.size} cards`];
    if (p.guarantee) bits.push(`${RARITY[p.guarantee].icon} ${RARITY[p.guarantee].label}+ guaranteed`);
    if (p.pool) bits.push('limited set');
    const afford = w.balance >= p.price ? '' : '  *(can\'t afford)*';
    return `${p.emoji} **${p.name}** — ${money(p.price, cfg)}${afford}\n` +
           ` ${bits.join(' · ')}${p.blurb ? ` — ${p.blurb}` : ''}\n` +
           ` \`/buy pack:${p.id}\``;
  });

  return {
    title: 'Shop',
    description: lines.join('\n'),
    color: BRAND,
    footer: { text: `You have ${w.balance.toLocaleString('en-GB')} ${cfg.currency_emoji}` +
                    ' · /work and /daily to earn more' },
  };
}

/* ── /buy ──────────────────────────────────────────────── */

export async function buyPack(env, interaction, packId, record) {
  const user = userOf(interaction);
  if (!user.id) return simple('Who are you?', "Couldn't read your Discord account.");

  const cfg = await settings(env);
  const all = await listPackTypes(env);
  if (!all.length) return simple('Shop is empty', 'No packs are on sale yet.');

  const q = String(packId || '').trim().toLowerCase();
  const pack = all.find(p => p.id.toLowerCase() === q)
            || all.find(p => p.name.toLowerCase() === q)
            || all.find(p => p.name.toLowerCase().includes(q));
  if (!pack) {
    return simple('No such pack',
      `Nothing called “${packId}”. Run \`/shop\` to see what's on sale.`);
  }

  const set = await fullSet(env, record);
  if (!set.length) {
    return simple('Nothing to put in it', 'There are no cards yet.');
  }

  // Take the money first. If the draw somehow fails afterwards it refunds;
  // the other order hands out cards to people who couldn't pay.
  const paid = await adjust(env, user.id, -pack.price, `Bought ${pack.name}`, cfg);
  if (!paid) {
    const w = await wallet(env, user.id, cfg);
    const short = pack.price - w.balance;
    return simple('Not enough',
      `**${pack.name}** costs ${money(pack.price, cfg)} and you have ${money(w.balance, cfg)}.\n` +
      `${money(short, cfg)} short — try \`/work\`.`);
  }

  let pulled;
  try {
    pulled = drawPack(set, packOpts(pack));
    if (!pulled.length) throw new Error('empty pack');
  } catch (err) {
    await adjust(env, user.id, pack.price, `Refund: ${pack.name}`, cfg);
    return simple('That pack came out empty',
      'Your money has been refunded. Tell an admin the pack is set up wrong.');
  }

  const now = Date.now();
  await env.DB.batch([
    ...pulled.map(c => env.DB.prepare(
      `INSERT INTO card_collection (user_id, class, driver_id, rarity, copies, first_at)
       VALUES (?, ?, ?, ?, 1, ?)
       ON CONFLICT (user_id, class, driver_id)
       DO UPDATE SET copies = copies + 1, rarity = excluded.rarity`
    ).bind(user.id, SET, c.id, c.rarity, now)),
    // A bought pack counts towards the totals but leaves the free-pack clock
    // alone — paying for one shouldn't cost you your eight-hourly.
    env.DB.prepare(
      `INSERT INTO card_packs (user_id, last_opened, total_packs, total_cards)
       VALUES (?, 0, 1, ?)
       ON CONFLICT (user_id) DO UPDATE SET
         total_packs = total_packs + 1,
         total_cards = total_cards + excluded.total_cards`
    ).bind(user.id, pulled.length),
  ]);

  const owned = await env.DB.prepare(
    `SELECT driver_id, copies FROM card_collection WHERE user_id = ? AND class = ?`
  ).bind(user.id, SET).all();
  const copies = {};
  for (const r of (owned.results || [])) copies[r.driver_id] = r.copies;

  const best = pulled.reduce((a, b) =>
    RARITIES.indexOf(b.rarity) > RARITIES.indexOf(a.rarity) ? b : a, pulled[0]);

  const lines = pulled.map(c => {
    const isNew = (copies[c.id] || 0) <= 1;
    return `${RARITY[c.rarity].icon} **${c.name}**${c.number ? ` #${c.number}` : ''}` +
           ` — ${RARITY[c.rarity].label}${isNew ? '  ✨ NEW' : '  ·  dupe'}`;
  });

  const have = Object.keys(copies).filter(k => set.some(c => c.id === k)).length;
  const summary = {
    title: `${pack.emoji} ${nameOf(user)} opened a ${pack.name}`,
    description: lines.join('\n'),
    color: RARITY[best.rarity].colour,
    footer: { text: `${have}/${set.length} collected · ${paid.balance.toLocaleString('en-GB')} ` +
                    `${cfg.currency_emoji} left · dupes sell with /sell` },
  };
  return packEmbeds(summary, pulled, copies);
}

/* ── /sell ─────────────────────────────────────────────── */

/**
 * Sells duplicates only. The copy you keep is never sellable, so nobody
 * wakes up having dismantled their own collection, and a pile of dupes is
 * worth something instead of being dead weight.
 */
export async function sellCard(env, interaction, query, howMany, record) {
  const user = userOf(interaction);
  if (!user.id) return simple('Who are you?', "Couldn't read your Discord account.");

  const cfg = await settings(env);
  const values = parseJson(cfg.sell_values, {}) || {};
  const set = await fullSet(env, record);
  return sellFrom(env, user, query, howMany, cfg, values, set);
}

async function sellFrom(env, user, query, howMany, cfg, values, set) {
  const rows = await env.DB.prepare(
    `SELECT driver_id, rarity, copies FROM card_collection
      WHERE user_id = ? AND class = ? AND copies > 1`).bind(user.id, SET).all();
  const dupes = rows.results || [];
  const byId = {};
  set.forEach(c => { byId[c.id] = c; });
  const price = r => Math.max(0, num(values[r], 0));

  const q = String(query || '').trim().toLowerCase();

  // No name: show what's sellable and what it's worth.
  if (!q) {
    const sellable = dupes.filter(r => byId[r.driver_id]);
    if (!sellable.length) {
      return simple('No duplicates',
        'You have no spare cards. Your last copy of a card is never sellable.', BRAND);
    }
    const total = sellable.reduce((n, r) => n + (r.copies - 1) * price(byId[r.driver_id].rarity), 0);
    const lines = sellable
      .sort((a, b) => RARITIES.indexOf(byId[b.driver_id].rarity) - RARITIES.indexOf(byId[a.driver_id].rarity))
      .slice(0, 20)
      .map(r => {
        const c = byId[r.driver_id];
        return `${RARITY[c.rarity].icon} **${c.name}** ×${r.copies - 1} spare — ` +
               `${(price(c.rarity)).toLocaleString('en-GB')} ${cfg.currency_emoji} each`;
      });
    return {
      title: 'Spare cards',
      description: lines.join('\n') + (sellable.length > 20 ? `\n…and ${sellable.length - 20} more` : ''),
      color: BRAND,
      footer: { text: `All of it is worth ${total.toLocaleString('en-GB')} ${cfg.currency_emoji}` +
                      ' · sell one with /sell name:… · /sell name:all' },
    };
  }

  // `all` dumps every spare in one go.
  if (q === 'all') {
    const sellable = dupes.filter(r => byId[r.driver_id] && r.copies > 1);
    if (!sellable.length) return simple('No duplicates', 'Nothing spare to sell.', BRAND);
    let total = 0, cards = 0;
    const stmts = [];
    for (const r of sellable) {
      const spare = r.copies - 1;
      total += spare * price(byId[r.driver_id].rarity);
      cards += spare;
      stmts.push(env.DB.prepare(
        `UPDATE card_collection SET copies = 1
          WHERE user_id = ? AND class = ? AND driver_id = ?`).bind(user.id, SET, r.driver_id));
    }
    await env.DB.batch(stmts);
    const w = await adjust(env, user.id, total, `Sold ${cards} spare cards`, cfg);
    return {
      title: '💰 Sold the lot',
      description: `${cards} spare card${cards !== 1 ? 's' : ''} → ${money(total, cfg)}\n` +
                   `Balance: ${money(w.balance, cfg)}`,
      color: GOLD,
      footer: { text: 'One of each is still in your collection' },
    };
  }

  const card = set.find(c => c.name.toLowerCase() === q)
            || set.find(c => c.name.toLowerCase().includes(q))
            || set.find(c => String(c.number) === q);
  if (!card) return simple('No such card', `Nothing in the set matches “${query}”.`);

  const row = dupes.find(r => r.driver_id === card.id);
  const spare = row ? row.copies - 1 : 0;
  if (spare < 1) {
    return simple('Nothing spare',
      `You have no duplicate of **${card.name}**. Your last copy is never sellable.`);
  }

  const n = Math.max(1, Math.min(spare, Math.round(Number(howMany) || spare)));
  const take = n * price(card.rarity);

  await env.DB.prepare(
    `UPDATE card_collection SET copies = copies - ?
      WHERE user_id = ? AND class = ? AND driver_id = ? AND copies - ? >= 1`
  ).bind(n, user.id, SET, card.id, n).run();

  const w = await adjust(env, user.id, take, `Sold ${n}× ${card.name}`, cfg);

  const art = card.cardImage || card.photo;
  return {
    title: `💰 Sold ${n}× ${card.name}`,
    description: `${RARITY[card.rarity].icon} ${RARITY[card.rarity].label} → ${money(take, cfg)}\n` +
                 `Balance: ${money(w.balance, cfg)}`,
    color: GOLD,
    ...(art ? { thumbnail: { url: art } } : {}),
    footer: { text: `${spare - n} spare left · one copy stays in your collection` },
  };
}

/* ── Race prize money ──────────────────────────────────── */

/**
 * Pays the field after a result is announced. Only drivers with a Discord
 * account linked on their driver page get paid — there is nowhere to put the
 * money otherwise. Returns a short summary for the admin panel.
 *
 * Idempotent per round: the ledger reason carries the round, and a second
 * announce of the same round pays nobody twice.
 */
export async function payRace(env, cls, race, drivers) {
  const cfg = await settings(env);
  const table = parseJson(cfg.prize_table, []) || [];
  const finish = num(cfg.prize_finish, 0);
  const fastest = num(cfg.prize_fastest, 0);
  const round = race && (race.round ?? race.name) ;
  const tag = `R${round} ${classLabel(cls)}`;

  const already = await env.DB.prepare(
    `SELECT 1 FROM ledger WHERE reason LIKE ? LIMIT 1`).bind(`Prize money ${tag}%`).first();
  if (already) return { ok: true, paid: 0, total: 0, note: 'already paid' };

  const idOf = name => {
    const d = (drivers || []).find(x => x.name === name || x.id === name);
    return d && d.discordId ? String(d.discordId) : null;
  };
  const resName = res => (typeof res === 'string') ? res : (res && res.driver) || '';
  const resId = res => {
    if (res && typeof res === 'object' && res.driverId) {
      const d = (drivers || []).find(x => x.id === res.driverId);
      if (d && d.discordId) return String(d.discordId);
    }
    return idOf(resName(res));
  };

  const owed = {};
  (race.results || []).forEach((res, i) => {
    const uid = resId(res);
    if (!uid) return;
    const raw = (res && typeof res === 'object' && res.pos != null) ? res.pos : i + 1;
    if (String(raw).toUpperCase() === 'DNF') return;
    const pos = Number(raw);
    if (!Number.isFinite(pos)) return;
    owed[uid] = (owed[uid] || 0) + (num(table[pos - 1], 0) || finish);
  });
  if (race.fastestLap) {
    const uid = resId(race.fastestLap);
    if (uid) owed[uid] = (owed[uid] || 0) + fastest;
  }

  let total = 0;
  for (const [uid, amount] of Object.entries(owed)) {
    if (amount <= 0) continue;
    await adjust(env, uid, amount, `Prize money ${tag}`, cfg);
    total += amount;
  }
  return { ok: true, paid: Object.keys(owed).length, total };
}

/* ── Admin ─────────────────────────────────────────────── */

const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '').slice(0, 48) || `x${Date.now().toString(36)}`;

export async function adminConfig(env) {
  const [cfg, jobs, packs] = await Promise.all([settings(env), listJobs(env), listPackTypes(env)]);
  let cards = [];
  try {
    const rows = await env.DB.prepare(`SELECT * FROM custom_card ORDER BY sort, name`).all();
    cards = rows.results || [];
  } catch { /* not migrated */ }
  let allPacks = packs;
  try {
    const rows = await env.DB.prepare(`SELECT * FROM pack_type ORDER BY sort, price`).all();
    allPacks = rows.results || packs;
  } catch { /* use enabled-only */ }
  let allJobs = jobs;
  try {
    const rows = await env.DB.prepare(`SELECT * FROM job ORDER BY sort, min_pay`).all();
    allJobs = rows.results || jobs;
  } catch { /* use enabled-only */ }
  return { settings: cfg, jobs: allJobs, packs: allPacks, cards, rarities: RARITIES };
}

export async function setSettings(env, patch) {
  const stmts = [];
  for (const [k, v] of Object.entries(patch || {})) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, k)) continue;
    stmts.push(env.DB.prepare(
      `INSERT INTO econ_setting (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`).bind(k, String(v)));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return settings(env);
}

export async function savePack(env, p) {
  const id = slug(p.id || p.name);
  const odds = p.odds && typeof p.odds === 'object' ? JSON.stringify(p.odds)
             : (typeof p.odds === 'string' && p.odds.trim()) ? p.odds : null;
  const pool = Array.isArray(p.pool) && p.pool.length ? JSON.stringify(p.pool.map(String)) : null;
  await env.DB.prepare(
    `INSERT INTO pack_type (id, name, emoji, blurb, price, size, class, odds, guarantee, pool,
                            enabled, sort, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       name = excluded.name, emoji = excluded.emoji, blurb = excluded.blurb,
       price = excluded.price, size = excluded.size, class = excluded.class,
       odds = excluded.odds, guarantee = excluded.guarantee, pool = excluded.pool,
       enabled = excluded.enabled, sort = excluded.sort`
  ).bind(
    id, String(p.name || 'Pack').slice(0, 60), String(p.emoji || '🃏').slice(0, 8),
    String(p.blurb || '').slice(0, 200),
    Math.max(0, Math.round(num(p.price, 0))),
    Math.max(1, Math.min(20, Math.round(num(p.size, 5)))),
    SET, odds, RARITIES.includes(p.guarantee) ? p.guarantee : null, pool,
    p.enabled === false || p.enabled === 0 ? 0 : 1,
    Math.round(num(p.sort, 0)), Date.now()
  ).run();
  return id;
}

export async function deletePack(env, id) {
  await env.DB.prepare(`DELETE FROM pack_type WHERE id = ?`).bind(String(id)).run();
}

export async function saveCustomCard(env, c) {
  // Every custom id carries the prefix, so it can never collide with a
  // driver id inside card_collection.
  let id = String(c.id || '');
  if (!id.startsWith('c:')) id = 'c:' + slug(id || c.name);
  await env.DB.prepare(
    `INSERT INTO custom_card (id, class, name, subtitle, rarity, image, blurb, enabled, sort, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       class = excluded.class, name = excluded.name, subtitle = excluded.subtitle,
       rarity = excluded.rarity, image = excluded.image, blurb = excluded.blurb,
       enabled = excluded.enabled, sort = excluded.sort`
  ).bind(
    id, SET, String(c.name || 'Untitled').slice(0, 60), String(c.subtitle || '').slice(0, 80),
    RARITIES.includes(c.rarity) ? c.rarity : 'rare',
    String(c.image || '').slice(0, 500), String(c.blurb || '').slice(0, 300),
    c.enabled === false || c.enabled === 0 ? 0 : 1,
    Math.round(num(c.sort, 0)), Date.now()
  ).run();
  return id;
}

export async function deleteCustomCard(env, id) {
  const key = String(id);
  // The cards people pulled go too; leaving them would show a card nobody
  // can look at any more.
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM custom_card WHERE id = ?`).bind(key),
    env.DB.prepare(`DELETE FROM card_collection WHERE driver_id = ?`).bind(key),
  ]);
}

export async function saveJob(env, j) {
  const id = slug(j.id || j.name);
  const lo = Math.max(0, Math.round(num(j.min_pay, 0)));
  const hi = Math.max(lo, Math.round(num(j.max_pay, lo)));
  await env.DB.prepare(
    `INSERT INTO job (id, name, emoji, blurb, min_pay, max_pay, cooldown_min, enabled, sort)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       name = excluded.name, emoji = excluded.emoji, blurb = excluded.blurb,
       min_pay = excluded.min_pay, max_pay = excluded.max_pay,
       cooldown_min = excluded.cooldown_min, enabled = excluded.enabled, sort = excluded.sort`
  ).bind(
    id, String(j.name || 'Job').slice(0, 60), String(j.emoji || '🔧').slice(0, 8),
    String(j.blurb || '').slice(0, 200), lo, hi,
    Math.max(1, Math.round(num(j.cooldown_min, 60))),
    j.enabled === false || j.enabled === 0 ? 0 : 1,
    Math.round(num(j.sort, 0))
  ).run();
  return id;
}

export async function deleteJob(env, id) {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM job WHERE id = ?`).bind(String(id)),
    env.DB.prepare(`DELETE FROM work_log WHERE job = ?`).bind(String(id)),
  ]);
}

/** Balances for the member list in the admin panel. */
export async function allWallets(env) {
  try {
    const rows = await env.DB.prepare(
      `SELECT user_id, balance, lifetime, updated_at FROM wallet ORDER BY balance DESC`).all();
    return rows.results || [];
  } catch { return []; }
}

export const ECON_COMMANDS = ['work', 'daily', 'balance', 'pay', 'rich', 'shop', 'buy', 'sell'];

/* ── Trading ───────────────────────────────────────────── */

/**
 * Card trading.
 *
 * A spare can only be sold back to the house, which makes every duplicate
 * worth exactly its sell price and nothing else. Trading makes a collection
 * something two people can work on: the card you will never use is the one
 * somebody else is missing.
 *
 * An offer is a row, not a message. The bot can restart, the other person
 * can answer an hour later, and nothing moves until they accept.
 *
 * Only duplicates can be offered or asked for. Trading away your only copy
 * of something is how people lose collections to a persuasive friend, and
 * the rule that your last copy is never sellable should not stop applying
 * because the buyer is a person rather than the house.
 */

const TRADE_WINDOW_MS = 48 * 60 * 60 * 1000;   // an offer nobody answers expires

/** How many spare copies someone has of one card. */
async function spareCount(env, userId, cardId) {
  const row = await env.DB.prepare(
    `SELECT copies FROM card_collection WHERE user_id = ? AND class = ? AND driver_id = ?`
  ).bind(String(userId), SET, String(cardId)).first();
  return row ? Math.max(0, row.copies - 1) : 0;
}

function findCard(set, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return null;
  return set.find(c => c.name.toLowerCase() === q)
      || set.find(c => c.name.toLowerCase().includes(q))
      || set.find(c => String(c.number) === q)
      || null;
}

/* ── /trade offer ──────────────────────────────────────── */
export async function offerTrade(env, interaction, toId, giveQ, wantQ, record) {
  const user = userOf(interaction);
  if (!user.id) return simple('Who are you?', "Couldn't read your Discord account.");
  if (!toId) return simple('Trade with who?', 'Pick someone: `/trade offer user:@them give:… want:…`');
  if (String(toId) === String(user.id)) {
    return simple('That is you', 'Trading with yourself would not achieve much.');
  }

  const cfg = await settings(env);
  const set = await fullSet(env, record);
  const give = findCard(set, giveQ);
  const want = findCard(set, wantQ);
  if (!give) return simple('No such card', `Nothing in the set matches “${giveQ}”.`);
  if (!want) return simple('No such card', `Nothing in the set matches “${wantQ}”.`);
  if (give.id === want.id) return simple('Same card', 'That is the same card on both sides.');

  if (await spareCount(env, user.id, give.id) < 1) {
    return simple('You have no spare',
      `You need a duplicate of **${give.name}** to trade it away. Your last copy stays yours.`);
  }
  if (await spareCount(env, toId, want.id) < 1) {
    return simple('They have no spare',
      `<@${toId}> has no duplicate of **${want.name}** to give.`);
  }

  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO trade (from_user, to_user, give_card, want_card, status, created_at)
     VALUES (?, ?, ?, ?, 'open', ?)`
  ).bind(String(user.id), String(toId), give.id, want.id, now).run();

  const row = await env.DB.prepare(
    `SELECT id FROM trade WHERE from_user = ? AND to_user = ? AND status = 'open'
      ORDER BY created_at DESC LIMIT 1`).bind(String(user.id), String(toId)).first();

  return {
    title: '🤝 Trade offered',
    description: `${nameOf(user)} offers <@${toId}>:\n\n` +
                 `**Gives** ${RARITY[give.rarity].icon} ${give.name}\n` +
                 `**Wants** ${RARITY[want.rarity].icon} ${want.name}\n\n` +
                 `<@${toId}> — \`/trade accept id:${row ? row.id : '?'}\` to take it, ` +
                 `\`/trade decline id:${row ? row.id : '?'}\` to turn it down.`,
    color: BRAND,
    footer: { text: 'Nothing moves until they accept · offers expire after 48 hours' },
  };
}

/* ── /trade list ───────────────────────────────────────── */
export async function listTrades(env, interaction, record) {
  const user = userOf(interaction);
  if (!user.id) return simple('Who are you?', "Couldn't read your Discord account.");

  const set = await fullSet(env, record);
  const byId = {};
  set.forEach(c => { byId[c.id] = c; });
  const nameOfCard = id => (byId[id] ? byId[id].name : 'a card that no longer exists');

  const cutoff = Date.now() - TRADE_WINDOW_MS;
  const rows = await env.DB.prepare(
    `SELECT * FROM trade WHERE status = 'open' AND created_at > ?
        AND (to_user = ? OR from_user = ?)
      ORDER BY created_at DESC LIMIT 15`
  ).bind(cutoff, String(user.id), String(user.id)).all();

  const list = rows.results || [];
  if (!list.length) {
    return simple('No open trades',
      'Offer one with `/trade offer user:@them give:… want:…`.', BRAND);
  }

  const incoming = list.filter(t => t.to_user === String(user.id));
  const outgoing = list.filter(t => t.from_user === String(user.id));
  const fields = [];
  if (incoming.length) fields.push({ name: `Waiting on you (${incoming.length})`,
    value: incoming.map(t =>
      `\`#${t.id}\` <@${t.from_user}> gives **${nameOfCard(t.give_card)}** ` +
      `for your **${nameOfCard(t.want_card)}**`).join('\n').slice(0, 1020) });
  if (outgoing.length) fields.push({ name: `Waiting on them (${outgoing.length})`,
    value: outgoing.map(t =>
      `\`#${t.id}\` you give **${nameOfCard(t.give_card)}** ` +
      `for <@${t.to_user}>'s **${nameOfCard(t.want_card)}**`).join('\n').slice(0, 1020) });

  return {
    title: 'Open trades',
    description: incoming.length
      ? 'Accept one with `/trade accept id:…`.'
      : 'Nothing needs your answer right now.',
    color: BRAND,
    fields,
  };
}

/* ── /trade accept ─────────────────────────────────────── */
export async function acceptTrade(env, interaction, id, record) {
  const user = userOf(interaction);
  if (!user.id) return simple('Who are you?', "Couldn't read your Discord account.");

  const t = await env.DB.prepare(`SELECT * FROM trade WHERE id = ?`).bind(Number(id) || 0).first();
  if (!t) return simple('No such trade', `There is no trade \`#${id}\`.`);
  if (t.to_user !== String(user.id)) {
    return simple('Not yours to accept', `Trade \`#${t.id}\` was offered to someone else.`);
  }
  if (t.status !== 'open') return simple('Already settled', `Trade \`#${t.id}\` is ${t.status}.`);
  if (Date.now() - t.created_at > TRADE_WINDOW_MS) {
    await env.DB.prepare(`UPDATE trade SET status = 'dead', closed_at = ? WHERE id = ?`)
      .bind(Date.now(), t.id).run();
    return simple('Too late', `Trade \`#${t.id}\` expired. Ask them to offer it again.`);
  }

  // Check both sides again at the moment of the swap. The spares that
  // existed when the offer was made may have been sold or traded since.
  if (await spareCount(env, t.from_user, t.give_card) < 1 ||
      await spareCount(env, t.to_user, t.want_card) < 1) {
    await env.DB.prepare(`UPDATE trade SET status = 'dead', closed_at = ? WHERE id = ?`)
      .bind(Date.now(), t.id).run();
    return simple('That one has gone',
      'One of those spare cards is no longer spare. The offer has been closed.');
  }

  const set = await fullSet(env, record);
  const byId = {};
  set.forEach(c => { byId[c.id] = c; });
  const give = byId[t.give_card], want = byId[t.want_card];
  if (!give || !want) {
    await env.DB.prepare(`UPDATE trade SET status = 'dead', closed_at = ? WHERE id = ?`)
      .bind(Date.now(), t.id).run();
    return simple('That card is gone', 'One of those cards is no longer in the set.');
  }

  const now = Date.now();
  const move = (fromUser, toUser, cardId, rarity) => ([
    env.DB.prepare(
      `UPDATE card_collection SET copies = copies - 1
        WHERE user_id = ? AND class = ? AND driver_id = ? AND copies - 1 >= 1`
    ).bind(fromUser, SET, cardId),
    env.DB.prepare(
      `INSERT INTO card_collection (user_id, class, driver_id, rarity, copies, first_at)
       VALUES (?, ?, ?, ?, 1, ?)
       ON CONFLICT (user_id, class, driver_id)
       DO UPDATE SET copies = copies + 1`
    ).bind(toUser, SET, cardId, rarity, now),
  ]);

  await env.DB.batch([
    ...move(t.from_user, t.to_user, t.give_card, give.rarity),
    ...move(t.to_user, t.from_user, t.want_card, want.rarity),
    env.DB.prepare(`UPDATE trade SET status = 'done', closed_at = ? WHERE id = ?`).bind(now, t.id),
  ]);

  const best = RARITIES.indexOf(give.rarity) >= RARITIES.indexOf(want.rarity) ? give : want;
  const embed = {
    title: '🤝 Trade done',
    description: `<@${t.from_user}> ⇄ <@${t.to_user}>\n\n` +
                 `${RARITY[give.rarity].icon} **${give.name}** → <@${t.to_user}>\n` +
                 `${RARITY[want.rarity].icon} **${want.name}** → <@${t.from_user}>`,
    color: RARITY[best.rarity].colour,
    footer: { text: `Trade #${t.id}` },
  };
  const art = best.cardImage || best.photo;
  if (art) embed.thumbnail = { url: art };
  return embed;
}

/* ── /trade decline, /trade cancel ─────────────────────── */
export async function closeTrade(env, interaction, id, how) {
  const user = userOf(interaction);
  if (!user.id) return simple('Who are you?', "Couldn't read your Discord account.");

  const t = await env.DB.prepare(`SELECT * FROM trade WHERE id = ?`).bind(Number(id) || 0).first();
  if (!t) return simple('No such trade', `There is no trade \`#${id}\`.`);
  if (t.status !== 'open') return simple('Already settled', `Trade \`#${t.id}\` is ${t.status}.`);

  const mine = how === 'cancelled' ? t.from_user === String(user.id)
                                   : t.to_user === String(user.id);
  if (!mine) {
    return simple('Not yours',
      how === 'cancelled' ? 'You can only cancel a trade you offered.'
                          : 'You can only decline a trade offered to you.');
  }

  await env.DB.prepare(`UPDATE trade SET status = ?, closed_at = ? WHERE id = ?`)
    .bind(how, Date.now(), t.id).run();
  return simple(how === 'cancelled' ? 'Cancelled' : 'Declined',
    `Trade \`#${t.id}\` is closed. Nothing changed hands.`, GREY);
}

export const TRADE_VIEWS = ['offer', 'list', 'accept', 'decline', 'cancel'];

/* ── Card seasons ──────────────────────────────────────── */

/**
 * Ending a card season.
 *
 * Rarity comes from the championship, so archiving a racing season
 * re-rates the whole set to Common on its own. What happens to people's
 * collections is a separate decision and nobody had made it, so this makes
 * it one: archive and keep, or archive and clear.
 *
 * Either way a snapshot is taken first. Clearing without one would be the
 * single most destructive thing in the admin panel.
 */
const csSlug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '').slice(0, 48) || `cs${Date.now().toString(36)}`;

export async function endCardSeason(env, { name, clear }) {
  const label = String(name || '').trim() || 'Card season';
  const id = csSlug(label);
  const now = Date.now();

  const rows = await env.DB.prepare(
    `SELECT user_id, driver_id, rarity, copies FROM card_collection WHERE class = ?`
  ).bind(SET).all();
  const held = rows.results || [];
  if (!held.length) throw new Error('nobody holds any cards — nothing to archive');

  const byUser = {};
  held.forEach(r => { byUser[r.user_id] = (byUser[r.user_id] || 0) + r.copies; });
  const top = Object.entries(byUser)
    .map(([user_id, cards]) => ({
      user_id, cards,
      unique: held.filter(h => h.user_id === user_id).length,
    }))
    .sort((a, b) => b.unique - a.unique || b.cards - a.cards)
    .slice(0, 10);

  // Snapshot in batches: a season's holdings can be thousands of rows and
  // D1 will not take them in one statement.
  const CHUNK = 50;
  for (let i = 0; i < held.length; i += CHUNK) {
    await env.DB.batch(held.slice(i, i + CHUNK).map(r => env.DB.prepare(
      `INSERT INTO card_season_holding (season_id, user_id, driver_id, rarity, copies)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (season_id, user_id, driver_id) DO UPDATE SET
         rarity = excluded.rarity, copies = excluded.copies`
    ).bind(id, r.user_id, r.driver_id, r.rarity, r.copies)));
  }

  await env.DB.prepare(
    `INSERT INTO card_season (id, name, ended_at, cleared, holders, cards, top)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       name = excluded.name, ended_at = excluded.ended_at, cleared = excluded.cleared,
       holders = excluded.holders, cards = excluded.cards, top = excluded.top`
  ).bind(id, label, now, clear ? 1 : 0, Object.keys(byUser).length,
         held.reduce((n, r) => n + r.copies, 0), JSON.stringify(top)).run();

  // Only now, with the snapshot written, is it safe to wipe anything.
  if (clear) {
    await env.DB.prepare(`DELETE FROM card_collection WHERE class = ?`).bind(SET).run();
    await env.DB.prepare(`DELETE FROM card_packs`).run();
  }

  return { id, name: label, cleared: Boolean(clear),
           holders: Object.keys(byUser).length,
           cards: held.reduce((n, r) => n + r.copies, 0) };
}

export async function listCardSeasons(env) {
  try {
    const rows = await env.DB.prepare(
      `SELECT id, name, ended_at, cleared, holders, cards, top
         FROM card_season ORDER BY ended_at DESC`).all();
    return (rows.results || []).map(r => ({
      ...r,
      top: (() => { try { return JSON.parse(r.top); } catch { return []; } })(),
    }));
  } catch { return []; }
}
