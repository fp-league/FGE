/**
 * FGE trading cards.
 *
 * Discord is the login. The site has no accounts and adding them for this
 * would be a lot of machinery for a league that already lives in one server,
 * so a collection is keyed by Discord user id and nothing else.
 *
 * Rarity is earned rather than invented: it comes from what a driver has
 * actually done this season, so the set re-rates itself as the championship
 * moves and a Legendary genuinely means something.
 */

export const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

export const RARITY = {
  common:    { label: 'Common',    colour: 0x9E9E9E, icon: '⚪', weight: 50 },
  uncommon:  { label: 'Uncommon',  colour: 0x4CAF50, icon: '🟢', weight: 28 },
  rare:      { label: 'Rare',      colour: 0x2196F3, icon: '🔵', weight: 15 },
  epic:      { label: 'Epic',      colour: 0x9C27B0, icon: '🟣', weight: 6  },
  legendary: { label: 'Legendary', colour: 0xFFC400, icon: '🟡', weight: 1  },
};

const PACK_SIZE = 5;
const COOLDOWN_MS = 8 * 60 * 60 * 1000;      // one free pack every 8 hours

const dKey = d => (d && (d.id || d.name)) || '';

function pointsCfg(cd) {
  const p = (cd && cd.points) || {};
  const num = (v, d) => (v === '' || v == null || isNaN(Number(v)) ? d : Number(v));
  return {
    table: Array.isArray(p.table) && p.table.length ? p.table.map(n => Number(n) || 0)
                                                    : [20, 15, 12, 10, 8, 6, 4, 3, 2, 1],
    fastestLap: num(p.fastestLap, 1),
    dotd: num(p.dotd, 0),
  };
}

function keyOf(res, drivers) {
  if (!res) return '';
  if (typeof res === 'object' && res.driverId) {
    const byId = (drivers || []).find(x => x.id === res.driverId);
    if (byId) return dKey(byId);
  }
  const name = (typeof res === 'string') ? res : res.driver;
  if (!name) return '';
  const byName = (drivers || []).find(x => x.name === name);
  return byName ? dKey(byName) : name;
}

/**
 * Every driver in a class with the season record that decides their rarity.
 */
export function cardSet(cd, custom) {
  const drivers = cd.drivers || [];
  const cfg = pointsCfg(cd);
  const stat = {};
  drivers.forEach(d => { stat[dKey(d)] = { points: 0, wins: 0, podiums: 0, starts: 0 }; });

  (cd.races || []).forEach(r => {
    (r.results || []).forEach((res, i) => {
      const k = keyOf(res, drivers);
      const s = stat[k];
      if (!s) return;
      s.starts++;
      const raw = (typeof res === 'object' && res.pos != null) ? res.pos : i + 1;
      if (String(raw).toUpperCase() === 'DNF') return;
      const pos = Number(raw);
      if (!Number.isFinite(pos)) return;
      s.points += cfg.table[pos - 1] || 0;
      if (r.fastestLap && keyOf(r.fastestLap, drivers) === k) s.points += cfg.fastestLap;
      if (pos === 1) s.wins++;
      if (pos <= 3) s.podiums++;
    });
    if (r.dotdWinner && cfg.dotd) {
      const dk = keyOf(r.dotdWinner, drivers);
      if (stat[dk]) stat[dk].points += cfg.dotd;
    }
  });

  const ranked = drivers.slice().sort((a, b) => stat[dKey(b)].points - stat[dKey(a)].points);

  const driverCards = ranked.map((d, i) => {
    const s = stat[dKey(d)];
    let rarity;
    if (i === 0 && s.points > 0)        rarity = 'legendary';   // championship leader
    else if (i <= 2 && s.points > 0)    rarity = 'epic';        // championship podium
    else if (s.wins > 0)                rarity = 'epic';        // a race winner
    else if (s.podiums > 0)             rarity = 'rare';
    else if (s.points > 0)              rarity = 'uncommon';
    else                                rarity = 'common';
    return {
      id: dKey(d), name: d.name, team: d.team || '', number: String(d.number ?? ''),
      nationality: d.nationality || '', photo: d.photo || '',
      cardImage: d.cardImage || '',
      rarity, position: i + 1, custom: false, ...s,
    };
  });

  // Admin-made cards sit in the same set and pull from the same packs. They
  // have no championship record, so the stat fields are zeroed rather than
  // absent — everything downstream reads them without checking which kind
  // of card it is holding.
  const extras = (custom || [])
    .filter(c => c && c.id && c.enabled !== 0)
    .map((c, i) => ({
      id: String(c.id), name: c.name || 'Untitled', team: c.subtitle || '', number: '',
      nationality: '', photo: '', cardImage: c.image || '',
      blurb: c.blurb || '',
      rarity: RARITIES.includes(c.rarity) ? c.rarity : 'rare',
      position: driverCards.length + i + 1, custom: true,
      points: 0, wins: 0, podiums: 0, starts: 0,
    }));

  return driverCards.concat(extras);
}

/**
 * Pack odds, falling through to a lower tier when one is empty.
 *
 * `odds` is a pack type's own weights; without one the house weights apply.
 * A tier weighted 0 is excluded outright rather than made very unlikely,
 * which is how an admin says "no Commons in this pack" and means it.
 */
function rollRarity(byRarity, odds, floor) {
  const w = r => {
    const v = odds && odds[r] != null ? Number(odds[r]) : RARITY[r].weight;
    return Number.isFinite(v) && v > 0 ? v : 0;
  };
  const min = floor ? RARITIES.indexOf(floor) : 0;
  let pool = RARITIES.filter((r, i) => i >= min && (byRarity[r] || []).length && w(r) > 0);

  // A guarantee must be honoured even if the admin weighted that tier to
  // nothing; fall back to flat odds across whatever qualifies.
  if (!pool.length && floor) {
    pool = RARITIES.filter((r, i) => i >= min && (byRarity[r] || []).length);
    if (pool.length) return pool[Math.floor(Math.random() * pool.length)];
  }
  // Every weighted tier is empty — take whatever is left rather than nothing.
  if (!pool.length) pool = RARITIES.filter(r => (byRarity[r] || []).length);
  if (!pool.length) return null;

  const total = pool.reduce((n, r) => n + w(r), 0);
  if (total <= 0) return pool[pool.length - 1];
  let roll = Math.random() * total;
  for (const r of pool) {
    roll -= w(r);
    if (roll <= 0) return r;
  }
  return pool[0];
}

/**
 * A pack never contains the same driver twice — a real pack doesn't, and
 * pulling one driver three times out of five feels broken rather than
 * unlucky. Duplicates across packs are the whole point and still happen.
 */
export function drawPack(set, opts) {
  const o = opts || {};
  const size = Math.max(1, Math.min(20, Number(o.size) || PACK_SIZE));

  // A pack type can restrict itself to a handful of cards. An id in the pool
  // that no longer exists is ignored; an empty result falls back to the whole
  // set rather than handing out nothing.
  let source = set;
  if (Array.isArray(o.pool) && o.pool.length) {
    const want = new Set(o.pool.map(String));
    const narrowed = set.filter(c => want.has(c.id));
    if (narrowed.length) source = narrowed;
  }

  const taken = new Set();
  const out = [];

  for (let i = 0; i < size && taken.size < source.length; i++) {
    // Rebuild the tiers each draw from what is still available, so a tier
    // that runs out stops being rolled rather than yielding nothing.
    const byRarity = {};
    source.forEach(c => { if (!taken.has(c.id)) (byRarity[c.rarity] ||= []).push(c); });

    // The guarantee is spent on the last card, and only if nothing already
    // pulled has met it — so a lucky pack isn't also forced to be a good one.
    const met = o.guarantee &&
      out.some(c => RARITIES.indexOf(c.rarity) >= RARITIES.indexOf(o.guarantee));
    const floor = (o.guarantee && !met && i === size - 1) ? o.guarantee : null;

    const r = rollRarity(byRarity, o.odds, floor);
    if (!r) break;
    const pool = byRarity[r];
    const card = pool[Math.floor(Math.random() * pool.length)];
    taken.add(card.id);
    out.push(card);
  }
  return out;
}

const userOf = i => (i.member && i.member.user) || i.user || {};

/**
 * Admin-made cards for a class. Returns [] rather than throwing when the
 * table is missing, so a Worker that hasn't run the economy migration still
 * serves driver cards instead of erroring.
 */
export async function loadCustom(env) {
  try {
    const rows = await env.DB.prepare(
      `SELECT id, name, subtitle, rarity, image, blurb, enabled
         FROM custom_card WHERE enabled = 1 ORDER BY sort, name`).all();
    return rows.results || [];
  } catch { return []; }
}

/**
 * There is one set, not two.
 *
 * Rarity is still earned inside a class — being the GT4 leader means being
 * the best in GT4, and ranking a GT4 driver against GT3 points would be
 * comparing two different championships. So each class is rated on its own
 * and the two results are poured into one set afterwards.
 *
 * A driver entered in both classes appears once, at whichever rarity they
 * earned higher; two cards of the same person would be a bug, not a bonus.
 */
export function combinedSet(record, custom) {
  const out = [];
  const seen = new Map();

  for (const cls of ['gt3', 'gt4']) {
    const cd = (record && record[cls]) || {};
    cardSet(cd, null).forEach(c => {
      const card = { ...c, cls };
      const prev = seen.get(card.id);
      if (!prev) { seen.set(card.id, card); out.push(card); return; }
      if (RARITIES.indexOf(card.rarity) > RARITIES.indexOf(prev.rarity)) {
        Object.assign(prev, card);           // same object, so order is kept
      }
    });
  }

  // Order the whole set by rarity, then by where they sit in their own
  // championship, so a merged set still reads top-down.
  out.sort((a, b) =>
    RARITIES.indexOf(b.rarity) - RARITIES.indexOf(a.rarity) ||
    a.position - b.position ||
    a.name.localeCompare(b.name));

  (custom || [])
    .filter(c => c && c.id && c.enabled !== 0)
    .forEach((c, i) => out.push({
      id: String(c.id), name: c.name || 'Untitled', team: c.subtitle || '', number: '',
      nationality: '', photo: '', cardImage: c.image || '', blurb: c.blurb || '',
      rarity: RARITIES.includes(c.rarity) ? c.rarity : 'rare',
      position: out.length + i + 1, custom: true, cls: '',
      points: 0, wins: 0, podiums: 0, starts: 0,
    }));

  return out;
}

/** The whole set: every driver in the league plus anything an admin added. */
export async function fullSet(env, record) {
  return combinedSet(record, await loadCustom(env));
}

/**
 * One collection, so one bucket. The class column stays on the table
 * because SQLite will not drop one and because the history is worth
 * keeping; everything written from here on goes in under 'all', and
 * migration 005 folded the old per-class rows into it.
 */
export const SET = 'all';

function fmtLeft(ms) {
  const m = Math.ceil(ms / 60000);
  if (m < 60) return `${m} minute${m !== 1 ? 's' : ''}`;
  const h = Math.floor(m / 60), rem = m % 60;
  return `${h}h${rem ? ` ${rem}m` : ''}`;
}

const classLabel = c => (c === 'gt4' ? 'GT4' : 'GT3');
const classColour = c => (c === 'gt4' ? 0x0033A0 : 0xE10600);

// One set means one colour on the embeds rather than a class red/blue.
const BRAND = 0xE10600;

/**
 * A pack as Discord renders it: a summary, then one embed per card so the
 * art is actually visible. A thumbnail in the corner of a single embed is
 * the one card in a pack of five and about 80px wide, which is no way to
 * look at a card you just pulled.
 *
 * Ten embeds is Discord's ceiling for one message, so the summary plus nine
 * cards. Cards with no art still appear in the summary lines; they just have
 * nothing to show.
 */
export function packEmbeds(summary, pulled, copies) {
  const MAX_EMBEDS = 10;
  const art = c => c.cardImage || c.photo;
  const shown = pulled.filter(art).slice(0, MAX_EMBEDS - 1);
  if (!shown.length) return summary;

  return {
    embeds: [summary, ...shown.map(c => {
      const isNew = (copies[c.id] || 0) <= 1;
      return {
        title: `${RARITY[c.rarity].icon} ${c.name}${c.number ? `  #${c.number}` : ''}`,
        description: `**${RARITY[c.rarity].label}**` +
                     `${c.team ? ` · ${c.team}` : ''}` +
                     `${isNew ? '  ·  ✨ NEW' : '  ·  duplicate'}`,
        color: RARITY[c.rarity].colour,
        image: { url: art(c) },
      };
    })],
  };
}

/* ── /pack ─────────────────────────────────────────────── */
export async function openPack(env, interaction, record) {
  const user = userOf(interaction);
  if (!user.id) return simple('Who are you?', "Couldn't read your Discord account.", 0x9E9E9E);

  const set = await fullSet(env, record);
  if (!set.length) {
    return simple('No cards yet', 'There are no drivers to make cards from.', 0x9E9E9E);
  }

  const now = Date.now();
  const row = await env.DB.prepare(
    `SELECT last_opened, total_packs FROM card_packs WHERE user_id = ?`
  ).bind(user.id).first();

  // A pack handed out by an admin jumps the queue, and deliberately does not
  // consume the free one — being given a pack should not cost you your
  // 8-hourly.
  let granted = null;
  try {
    granted = await env.DB.prepare(
      `SELECT packs FROM card_grants WHERE user_id = ?`
    ).bind(user.id).first();
  } catch { /* table not migrated yet; carry on with the cooldown only */ }
  const useGrant = Boolean(granted && granted.packs > 0);

  if (!useGrant && row && now - row.last_opened < COOLDOWN_MS) {
    const left = COOLDOWN_MS - (now - row.last_opened);
    return simple('Not yet',
      `Your next pack is ready in **${fmtLeft(left)}**.\nOne free pack every 8 hours.`,
      0x9E9E9E);
  }

  const pulled = drawPack(set);

  // One row per driver per collection; a duplicate bumps the count.
  const stmts = pulled.map(c => env.DB.prepare(
    `INSERT INTO card_collection (user_id, class, driver_id, rarity, copies, first_at)
     VALUES (?, ?, ?, ?, 1, ?)
     ON CONFLICT (user_id, class, driver_id)
     DO UPDATE SET copies = copies + 1, rarity = excluded.rarity`
  ).bind(user.id, SET, c.id, c.rarity, now));

  if (useGrant) {
    // Spend the grant, leave the cooldown clock alone.
    stmts.push(env.DB.prepare(
      `UPDATE card_grants SET packs = packs - 1, updated_at = ? WHERE user_id = ?`
    ).bind(now, user.id));
    stmts.push(env.DB.prepare(
      `INSERT INTO card_packs (user_id, last_opened, total_packs, total_cards)
       VALUES (?, 0, 1, ?)
       ON CONFLICT (user_id) DO UPDATE SET
         total_packs = total_packs + 1,
         total_cards = total_cards + excluded.total_cards`
    ).bind(user.id, pulled.length));
  } else {
    stmts.push(env.DB.prepare(
      `INSERT INTO card_packs (user_id, last_opened, total_packs, total_cards)
       VALUES (?, ?, 1, ?)
       ON CONFLICT (user_id) DO UPDATE SET
         last_opened = excluded.last_opened,
         total_packs = total_packs + 1,
         total_cards = total_cards + excluded.total_cards`
    ).bind(user.id, now, pulled.length));
  }

  await env.DB.batch(stmts);

  // Which of these were new? Worked out after the write so duplicates read true.
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

  const have = Object.keys(copies).length;
  const left = useGrant ? (granted.packs - 1) : 0;
  const summary = {
    title: `${user.global_name || user.username} opened a pack`,
    description: lines.join('\n'),
    color: RARITY[best.rarity].colour,
    footer: { text: `${have}/${set.length} collected · ` +
      (left > 0 ? `${left} bonus pack${left !== 1 ? 's' : ''} left`
                : useGrant ? 'that was a bonus pack — your free one is still waiting'
                : 'next pack in 8h') },
  };
  return packEmbeds(summary, pulled, copies);
}

/* ── /collection ───────────────────────────────────────── */
export async function showCollection(env, interaction, record, targetId) {
  const user = userOf(interaction);
  const id = targetId || user.id;
  if (!id) return simple('Who are you?', "Couldn't read your Discord account.", 0x9E9E9E);

  const set = await fullSet(env, record);
  const byId = {};
  set.forEach(c => { byId[c.id] = c; });

  const rows = await env.DB.prepare(
    `SELECT driver_id, rarity, copies FROM card_collection WHERE user_id = ? AND class = ?`
  ).bind(id, SET).all();

  const held = (rows.results || []).filter(r => byId[r.driver_id]);
  if (!held.length) {
    return simple('No cards yet',
      targetId ? 'They have not opened a pack yet.' : 'Open your first with `/cards pack`.',
      BRAND);
  }

  // Group by rarity, rarest first — that is how anyone reads a collection.
  const groups = {};
  held.forEach(r => { (groups[r.rarity] ||= []).push({ ...byId[r.driver_id], copies: r.copies }); });

  const fields = RARITIES.slice().reverse()
    .filter(r => groups[r])
    .map(r => ({
      name: `${RARITY[r].icon} ${RARITY[r].label} (${groups[r].length})`,
      value: groups[r]
        .sort((a, b) => a.position - b.position)
        .map(c => `${c.name}${c.copies > 1 ? ` ×${c.copies}` : ''}`)
        .join(', ')
        .slice(0, 1020),
    }));

  const pct = Math.round(held.length / set.length * 100);
  const dupes = held.reduce((n, r) => n + Math.max(0, r.copies - 1), 0);
  const name = targetId ? 'Collection' : `${user.global_name || user.username}'s collection`;

  // Thirty images would be unreadable, so the collection shows the best card
  // in it — which is the one anyone asking to see a collection wants anyway.
  const best = held
    .map(r => byId[r.driver_id])
    .filter(c => c && (c.cardImage || c.photo))
    .sort((a, b) => RARITIES.indexOf(b.rarity) - RARITIES.indexOf(a.rarity) ||
                    a.position - b.position)[0];

  return {
    title: name,
    ...(best ? { thumbnail: { url: best.cardImage || best.photo } } : {}),
    description: `**${held.length} of ${set.length}** drivers · ${pct}% complete` +
                 (dupes ? ` · ${dupes} duplicate${dupes !== 1 ? 's' : ''}` : ''),
    color: BRAND,
    fields,
  };
}

/* ── /card ─────────────────────────────────────────────── */
export async function showCard(env, interaction, record, query) {
  const user = userOf(interaction);
  const set = await fullSet(env, record);
  const q = String(query || '').trim().toLowerCase();
  if (!q) return simple('Which driver?', 'Give me a name, e.g. `/cards card name:Maxi`.', 0x9E9E9E);

  const card = set.find(c => c.name.toLowerCase() === q)
            || set.find(c => c.name.toLowerCase().includes(q))
            || set.find(c => String(c.number) === q);
  if (!card) {
    return simple('No such card', `Nothing in the set matches “${query}”.`, 0x9E9E9E);
  }

  let owned = null;
  if (user.id) {
    owned = await env.DB.prepare(
      `SELECT copies FROM card_collection WHERE user_id = ? AND class = ? AND driver_id = ?`
    ).bind(user.id, SET, card.id).first();
  }

  const r = RARITY[card.rarity];
  // A custom card has no season behind it, so showing P31 / 0 points / 0
  // starts would be six fields of nothing. It gets its blurb instead.
  const fields = card.custom
    ? [{ name: 'In your collection', value: owned ? `Yes ×${owned.copies}` : 'Not yet', inline: true }]
    : [
        { name: 'Championship', value: `P${card.position}`, inline: true },
        { name: 'Points',   value: String(card.points),  inline: true },
        { name: 'Starts',   value: String(card.starts),  inline: true },
        { name: 'Wins',     value: String(card.wins),    inline: true },
        { name: 'Podiums',  value: String(card.podiums), inline: true },
        { name: 'In your collection',
          value: owned ? `Yes \u00d7${owned.copies}` : 'Not yet', inline: true },
      ];

  const embed = {
    title: `${r.icon} ${card.name}${card.number ? `  #${card.number}` : ''}`,
    description: `**${r.label}**${card.cls ? ` · ${classLabel(card.cls)}` : ''}` +
                 `${card.team ? ` · ${card.team}` : ''}` +
                 `${card.nationality ? ` · ${card.nationality}` : ''}` +
                 `${card.blurb ? `\n\n${card.blurb}` : ''}`,
    color: r.colour,
    fields,
  };
  const art = card.cardImage || card.photo;
  if (art) embed.image = { url: art };
  return embed;
}

/* ── /collectors ───────────────────────────────────────── */
export async function showCollectors(env, record) {
  const total = (await fullSet(env, record)).length;

  const rows = await env.DB.prepare(
    `SELECT user_id, COUNT(*) AS held, SUM(copies) AS cards
       FROM card_collection WHERE class = ?
      GROUP BY user_id ORDER BY held DESC, cards DESC LIMIT 10`
  ).bind(SET).all();

  const list = rows.results || [];
  if (!list.length) {
    return simple('No collectors yet', 'Nobody has opened a pack. Be first with `/cards pack`.',
      BRAND);
  }

  const medal = i => ['🥇', '🥈', '🥉'][i] || `\`${String(i + 1).padStart(2)}\``;
  return {
    title: 'Top collectors',
    description: list.map((r, i) =>
      `${medal(i)} <@${r.user_id}> — **${r.held}/${total}**` +
      ` (${Math.round(r.held / total * 100)}%) · ${r.cards} cards`).join('\n'),
    color: BRAND,
    footer: { text: 'Ranked by unique drivers held' },
  };
}

function simple(title, description, color) {
  return { title, description, color };
}

/** Hand someone packs from the admin panel. */
export async function grantPacks(env, userId, count) {
  const n = Math.max(1, Math.min(50, Number(count) || 1));
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO card_grants (user_id, packs, total, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET
       packs = packs + excluded.packs,
       total = total + excluded.packs,
       updated_at = excluded.updated_at`
  ).bind(String(userId), n, n, now).run();

  const row = await env.DB.prepare(
    `SELECT packs, total FROM card_grants WHERE user_id = ?`
  ).bind(String(userId)).first();
  return { granted: n, waiting: row ? row.packs : n, everGranted: row ? row.total : n };
}

export const CARD_VIEWS = ['pack', 'collection', 'card', 'collectors'];
