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

const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

const RARITY = {
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
export function cardSet(cd) {
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

  return ranked.map((d, i) => {
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
      rarity, position: i + 1, ...s,
    };
  });
}

/** Pack odds, falling through to a lower tier when one is empty. */
function rollRarity(byRarity) {
  const pool = RARITIES.filter(r => (byRarity[r] || []).length);
  if (!pool.length) return null;
  const total = pool.reduce((n, r) => n + RARITY[r].weight, 0);
  let roll = Math.random() * total;
  for (const r of pool) {
    roll -= RARITY[r].weight;
    if (roll <= 0) return r;
  }
  return pool[0];
}

/**
 * A pack never contains the same driver twice — a real pack doesn't, and
 * pulling one driver three times out of five feels broken rather than
 * unlucky. Duplicates across packs are the whole point and still happen.
 */
function drawPack(set) {
  const taken = new Set();
  const out = [];

  for (let i = 0; i < PACK_SIZE && taken.size < set.length; i++) {
    // Rebuild the tiers each draw from what is still available, so a tier
    // that runs out stops being rolled rather than yielding nothing.
    const byRarity = {};
    set.forEach(c => { if (!taken.has(c.id)) (byRarity[c.rarity] ||= []).push(c); });

    const r = rollRarity(byRarity);
    if (!r) break;
    const pool = byRarity[r];
    const card = pool[Math.floor(Math.random() * pool.length)];
    taken.add(card.id);
    out.push(card);
  }
  return out;
}

const userOf = i => (i.member && i.member.user) || i.user || {};

function fmtLeft(ms) {
  const m = Math.ceil(ms / 60000);
  if (m < 60) return `${m} minute${m !== 1 ? 's' : ''}`;
  const h = Math.floor(m / 60), rem = m % 60;
  return `${h}h${rem ? ` ${rem}m` : ''}`;
}

const classLabel = c => (c === 'gt4' ? 'GT4' : 'GT3');
const classColour = c => (c === 'gt4' ? 0x0033A0 : 0xE10600);

/* ── /pack ─────────────────────────────────────────────── */
export async function openPack(env, interaction, cls, record) {
  const user = userOf(interaction);
  if (!user.id) return simple('Who are you?', "Couldn't read your Discord account.", 0x9E9E9E);

  const cd = (record && record[cls]) || {};
  const set = cardSet(cd);
  if (!set.length) {
    return simple('No cards yet', `There are no ${classLabel(cls)} drivers to make cards from.`, 0x9E9E9E);
  }

  const now = Date.now();
  const row = await env.DB.prepare(
    `SELECT last_opened, total_packs FROM card_packs WHERE user_id = ?`
  ).bind(user.id).first();

  if (row && now - row.last_opened < COOLDOWN_MS) {
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
  ).bind(user.id, cls, c.id, c.rarity, now));

  stmts.push(env.DB.prepare(
    `INSERT INTO card_packs (user_id, last_opened, total_packs, total_cards)
     VALUES (?, ?, 1, ?)
     ON CONFLICT (user_id) DO UPDATE SET
       last_opened = excluded.last_opened,
       total_packs = total_packs + 1,
       total_cards = total_cards + excluded.total_cards`
  ).bind(user.id, now, pulled.length));

  await env.DB.batch(stmts);

  // Which of these were new? Worked out after the write so duplicates read true.
  const owned = await env.DB.prepare(
    `SELECT driver_id, copies FROM card_collection WHERE user_id = ? AND class = ?`
  ).bind(user.id, cls).all();
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
  const embed = {
    title: `${user.global_name || user.username} opened a ${classLabel(cls)} pack`,
    description: lines.join('\n'),
    color: RARITY[best.rarity].colour,
    footer: { text: `${have}/${set.length} drivers collected · next pack in 8h` },
  };
  if (best.photo) embed.thumbnail = { url: best.photo };
  return embed;
}

/* ── /collection ───────────────────────────────────────── */
export async function showCollection(env, interaction, cls, record, targetId) {
  const user = userOf(interaction);
  const id = targetId || user.id;
  if (!id) return simple('Who are you?', "Couldn't read your Discord account.", 0x9E9E9E);

  const cd = (record && record[cls]) || {};
  const set = cardSet(cd);
  const byId = {};
  set.forEach(c => { byId[c.id] = c; });

  const rows = await env.DB.prepare(
    `SELECT driver_id, rarity, copies FROM card_collection WHERE user_id = ? AND class = ?`
  ).bind(id, cls).all();

  const held = (rows.results || []).filter(r => byId[r.driver_id]);
  if (!held.length) {
    return simple(`No ${classLabel(cls)} cards yet`,
      targetId ? 'They have not opened a pack yet.' : 'Open your first with `/cards pack`.',
      classColour(cls));
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

  return {
    title: `${name} — ${classLabel(cls)}`,
    description: `**${held.length} of ${set.length}** drivers · ${pct}% complete` +
                 (dupes ? ` · ${dupes} duplicate${dupes !== 1 ? 's' : ''}` : ''),
    color: classColour(cls),
    fields,
  };
}

/* ── /card ─────────────────────────────────────────────── */
export async function showCard(env, interaction, cls, record, query) {
  const user = userOf(interaction);
  const cd = (record && record[cls]) || {};
  const set = cardSet(cd);
  const q = String(query || '').trim().toLowerCase();
  if (!q) return simple('Which driver?', 'Give me a name, e.g. `/cards card name:Maxi`.', 0x9E9E9E);

  const card = set.find(c => c.name.toLowerCase() === q)
            || set.find(c => c.name.toLowerCase().includes(q))
            || set.find(c => String(c.number) === q);
  if (!card) {
    return simple('No such driver', `Nothing in the ${classLabel(cls)} set matches “${query}”.`, 0x9E9E9E);
  }

  let owned = null;
  if (user.id) {
    owned = await env.DB.prepare(
      `SELECT copies FROM card_collection WHERE user_id = ? AND class = ? AND driver_id = ?`
    ).bind(user.id, cls, card.id).first();
  }

  const r = RARITY[card.rarity];
  const embed = {
    title: `${r.icon} ${card.name}${card.number ? `  #${card.number}` : ''}`,
    description: `**${r.label}** · ${classLabel(cls)}${card.team ? ` · ${card.team}` : ''}` +
                 `${card.nationality ? ` · ${card.nationality}` : ''}`,
    color: r.colour,
    fields: [
      { name: 'Championship', value: `P${card.position}`, inline: true },
      { name: 'Points',   value: String(card.points),  inline: true },
      { name: 'Starts',   value: String(card.starts),  inline: true },
      { name: 'Wins',     value: String(card.wins),    inline: true },
      { name: 'Podiums',  value: String(card.podiums), inline: true },
      { name: 'In your collection',
        value: owned ? `Yes ×${owned.copies}` : 'Not yet', inline: true },
    ],
  };
  if (card.photo) embed.image = { url: card.photo };
  return embed;
}

/* ── /collectors ───────────────────────────────────────── */
export async function showCollectors(env, cls, record) {
  const cd = (record && record[cls]) || {};
  const total = cardSet(cd).length;

  const rows = await env.DB.prepare(
    `SELECT user_id, COUNT(*) AS held, SUM(copies) AS cards
       FROM card_collection WHERE class = ?
      GROUP BY user_id ORDER BY held DESC, cards DESC LIMIT 10`
  ).bind(cls).all();

  const list = rows.results || [];
  if (!list.length) {
    return simple('No collectors yet', 'Nobody has opened a pack. Be first with `/cards pack`.',
      classColour(cls));
  }

  const medal = i => ['🥇', '🥈', '🥉'][i] || `\`${String(i + 1).padStart(2)}\``;
  return {
    title: `Top ${classLabel(cls)} collectors`,
    description: list.map((r, i) =>
      `${medal(i)} <@${r.user_id}> — **${r.held}/${total}**` +
      ` (${Math.round(r.held / total * 100)}%) · ${r.cards} cards`).join('\n'),
    color: classColour(cls),
    footer: { text: 'Ranked by unique drivers held' },
  };
}

function simple(title, description, color) {
  return { title, description, color };
}

export const CARD_VIEWS = ['pack', 'collection', 'card', 'collectors'];
