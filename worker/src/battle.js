/**
 * Ranked 1v1 — a race boiled down to a fight.
 *
 * Two drivers, four moves, hidden picks. Both choose at the same time and
 * the turn only resolves once the second pick lands, which is the whole
 * point: a game where you can see the other person's move before choosing
 * is a stat check, and a game where you cannot is a read.
 *
 * The resources are the two a real stint is actually about.
 *
 *   TYRES  the health bar. At zero you are in the wall and the race is
 *          over. Everything costs tyres, including your own aggression.
 *   ERS    three bars, spent to attack hard and rebuilt by driving
 *          sensibly. Without it the big move is simply unavailable, which
 *          is what stops the fight being DIVE BOMB twelve times.
 *
 * The moves form a triangle, with a fourth option off to the side:
 *
 *   SLIPSTREAM  beats DEFEND     — you cannot block someone who just
 *                                  drives around the outside
 *   DIVE BOMB   beats SLIPSTREAM — aggression beats patience
 *   DEFEND      beats DIVE BOMB  — they lock up and flat-spot the set
 *   PIT STOP    beats nobody, recovers everything, and takes whatever is
 *               coming at half again. The gamble.
 *
 * Nothing in this file talks to Discord or to the database. It is a pure
 * function of (state, two moves, rng) so the tests can play whole races
 * deterministically, and so the rules can be reasoned about without a
 * fixture. The Discord layer is at the bottom of the file and the rating
 * maths lives in ranked.js.
 */

export const START_TYRES = 100;
export const START_ERS = 2;
export const MAX_ERS = 3;
export const RACE_LAPS = 12;
export const PICK_TIMEOUT_MIN = 10;

/**
 * The four moves.
 *
 * `dmg` and `self` are before any interaction between the two picks;
 * everything situational is in resolve() rather than here, so this table
 * stays readable as a summary of what each move is for.
 */
export const MOVES = {
  slip: {
    key: 'slip', name: 'Slipstream', emoji: '🌀', style: 1,
    blurb: 'Tuck in and take the run. Reliable, builds ERS, and goes straight through a defence.',
    dmg: 14, self: 0, ers: +1, cost: 0,
  },
  dive: {
    key: 'dive', name: 'Dive Bomb', emoji: '🔻', style: 4,
    blurb: 'Send it up the inside. Huge, costs a bar, and ruinous if they saw it coming.',
    dmg: 30, self: 6, ers: 0, cost: 1,
  },
  defend: {
    key: 'defend', name: 'Defend', emoji: '🛡', style: 2,
    blurb: 'Cover the inside line. Blunts almost everything and punishes a dive.',
    dmg: 0, self: 0, ers: +1, cost: 0,
  },
  pit: {
    key: 'pit', name: 'Pit Stop', emoji: '🔧', style: 2,
    blurb: 'Fresh rubber and a full battery — but you are a sitting duck for one lap.',
    dmg: 0, self: 0, ers: MAX_ERS, cost: 0, heal: 28,
  },
};

export const MOVE_KEYS = Object.keys(MOVES);

/** A driver at the start of a race. */
export const newDriver = () => ({ tyres: START_TYRES, ers: START_ERS, pits: 0 });

export const newBattle = () => ({ lap: 1, a: newDriver(), b: newDriver() });

/** Can this driver pick this move right now? */
export function canPick(driver, key) {
  const move = MOVES[key];
  if (!move) return false;
  return (driver.ers || 0) >= move.cost;
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/**
 * Damage variance, ±10%.
 *
 * Small on purpose. This decides a ladder position, so the read should
 * matter more than the roll; the wobble is there to stop two identical
 * reads producing an identical race, not to create upsets.
 */
const vary = (base, rng) => base === 0 ? 0 : Math.round(base * (0.9 + rng() * 0.2));

/**
 * Play one lap.
 *
 * Returns a new state plus a plain-language account of what happened, so
 * the Discord layer never has to re-derive the story from the numbers.
 * Pure: same state, same moves, same rng sequence, same result.
 */
export function resolve(state, moveA, moveB, rng = Math.random) {
  const a = { ...state.a }, b = { ...state.b };
  const notes = [];

  const outcome = (self, them, move, other, who) => {
    const m = MOVES[move], o = MOVES[other];
    let dmg = 0, selfHit = m.self, heal = 0;

    if (move === 'pit') {
      heal = m.heal;
      self.pits += 1;
    }

    if (m.dmg) {
      dmg = m.dmg;
      // DEFEND is the answer to a dive and nearly the answer to a
      // slipstream — but only nearly, or defending would be free.
      if (other === 'defend') {
        if (move === 'dive') {
          dmg = 0;
          selfHit += 18;
          notes.push({ who, text: 'sent it up the inside, got the door shut, and ' +
                                  'flat-spotted the set' });
        } else {
          notes.push({ who, text: 'went round the outside anyway — a defence does not ' +
                                  'stop a run' });
        }
      }
      // A car in the pit lane cannot dodge.
      if (other === 'pit' && dmg) {
        dmg = Math.round(dmg * 1.5);
        notes.push({ who, text: 'caught them stationary in the pit box' });
      }
    }
    return { dmg: vary(dmg, rng), selfHit, heal };
  };

  // 'a' / 'b' rather than a name: the engine does not know who these
  // people are, and the Discord layer substitutes when it prints.
  const ra = outcome(a, b, moveA, moveB, 'a');
  const rb = outcome(b, a, moveB, moveA, 'b');

  // Everything is applied together, so a lap is genuinely simultaneous:
  // neither driver gets to be dead before their own move lands.
  a.tyres = clamp(a.tyres - rb.dmg - ra.selfHit + ra.heal, -999, START_TYRES);
  b.tyres = clamp(b.tyres - ra.dmg - rb.selfHit + rb.heal, -999, START_TYRES);

  const spend = (d, key) => {
    const m = MOVES[key];
    d.ers = key === 'pit' ? MAX_ERS : clamp((d.ers || 0) - m.cost + (m.ers || 0), 0, MAX_ERS);
  };
  spend(a, moveA);
  spend(b, moveB);

  const next = { lap: state.lap + 1, a, b };
  return { state: next, hitA: ra.dmg, hitB: rb.dmg, selfA: ra.selfHit, selfB: rb.selfHit,
           healA: ra.heal, healB: rb.heal, notes };
}

/**
 * Is it over, and who won?
 *
 * 'a' | 'b' | 'draw' | null. A draw is a real outcome rather than
 * something to break arbitrarily — the rating maths handles it, and
 * inventing a winner out of a dead heat is worse than recording one.
 */
export function finished(state) {
  const { a, b } = state;
  const aOut = a.tyres <= 0, bOut = b.tyres <= 0;
  if (aOut || bOut) {
    if (aOut && bOut) {
      if (a.tyres === b.tyres) return 'draw';
      return a.tyres > b.tyres ? 'a' : 'b';
    }
    return aOut ? 'b' : 'a';
  }
  if (state.lap > RACE_LAPS) {
    if (a.tyres === b.tyres) return 'draw';
    return a.tyres > b.tyres ? 'a' : 'b';
  }
  return null;
}

/** Why it ended, for the closing embed. */
export function endReason(state, winner) {
  if (winner === 'draw') return 'Dead heat at the flag.';
  const loser = winner === 'a' ? state.b : state.a;
  if (loser.tyres <= 0) return 'Out of tyres and into the barrier.';
  return `The flag, on tyre life — ${Math.round(state.a.tyres)} to ${Math.round(state.b.tyres)}.`;
}

/* ══ Discord ═══════════════════════════════════════════════
   Everything above this line is the game. Everything below is how it is
   shown and how two people's taps are turned into laps without either of
   them being able to see the other's pick, or to pick twice.           */

import { settings, adjust, money } from './economy.js';
import { getRating, applyResult, ladder, tierOf, WIN_CREDITS,
         START_RATING, PLACEMENT_RACES } from './ranked.js';

const RED = 0xE8192C, GOLD = 0xFFC400, GREY = 0x9E9E9E, GREEN = 0x4CAF50;
const userOf = i => (i.member && i.member.user) || i.user || {};
const nameOf = u => u.global_name || u.username || 'someone';
const ephemeral = content => ({ type: 4, data: { flags: 64, content } });

/** A tyre bar that reads at a glance on a phone. */
function bar(n, width = 10) {
  const pct = Math.max(0, Math.min(1, n / START_TYRES));
  const full = Math.round(pct * width);
  const block = pct > 0.5 ? '🟩' : pct > 0.25 ? '🟨' : '🟥';
  return block.repeat(full) + '⬛'.repeat(width - full);
}

const ersBar = n => '🔋'.repeat(Math.max(0, n)) + '▫️'.repeat(Math.max(0, MAX_ERS - n));

function carLine(label, d) {
  return `**${label}**\n${bar(d.tyres)} \`${Math.max(0, Math.round(d.tyres))}\`\n` +
         `${ersBar(d.ers)}`;
}

/** The move buttons, with anything unaffordable greyed out for both. */
function moveRow(id, state) {
  const short = (a, b) => Math.max(a.ers, b.ers);
  return [{ type: 1, components: MOVE_KEYS.map(k => ({
    type: 2,
    style: MOVES[k].style,
    label: MOVES[k].name,
    emoji: { name: MOVES[k].emoji },
    custom_id: `rk:${id}:${k}`,
    // Disabled only when NEITHER driver could use it, since one set of
    // buttons is shared. The per-driver check happens on the tap, where
    // it can say whose battery is flat.
    disabled: MOVES[k].cost > short(state.a, state.b),
  })) }];
}

function liveEmbed(row, state, names, story) {
  return {
    title: `🏁 Ranked · Lap ${Math.min(state.lap, RACE_LAPS)} of ${RACE_LAPS}`,
    description: (story ? story + '\n\n' : '') +
      `${carLine(names.a, state.a)}\n\n${carLine(names.b, state.b)}`,
    color: RED,
    footer: { text: 'Both pick in secret. The lap runs when the second one is in.' },
  };
}

/* ── starting one ──────────────────────────────────────── */

export async function startRanked(env, interaction, targetId) {
  const me = userOf(interaction);
  if (!me.id) return { title: 'Who are you?', description: "Couldn't read your Discord account.", color: GREY };
  const them = String(targetId || '');
  if (!them) return { title: 'Who?', description: 'Name somebody to challenge.', color: GREY };
  if (them === String(me.id)) {
    return { title: 'Not like that', description: 'You cannot race yourself up the ladder.', color: GREY };
  }

  // One live match each. Two at once would let someone farm a friend in
  // one window while stalling a real opponent in another.
  const busy = await env.DB.prepare(
    `SELECT id FROM ranked_match WHERE status IN ('open','live')
       AND (challenger = ? OR opponent = ? OR challenger = ? OR opponent = ?)`
  ).bind(String(me.id), String(me.id), them, them).first();
  if (busy) {
    return { title: 'One at a time', color: GREY,
      description: 'One of you already has a challenge open or a race running.' };
  }

  const [mine, theirs] = await Promise.all([getRating(env, me.id), getRating(env, them)]);
  const id = crypto.randomUUID().slice(0, 12);
  await env.DB.prepare(
    `INSERT INTO ranked_match (id, challenger, opponent, status, at) VALUES (?, ?, ?, 'open', ?)`
  ).bind(id, String(me.id), them, Date.now()).run();

  const t = tierOf(mine.rating), o = tierOf(theirs.rating);
  return {
    content: `<@${them}>`,
    allowed_mentions: { users: [them] },
    embeds: [{
      title: '🏁 Ranked challenge',
      description:
        `<@${me.id}> ${t.emoji} ${mine.rating}  —vs—  <@${them}> ${o.emoji} ${theirs.rating}\n\n` +
        'Twelve laps, wheel to wheel. Pick a move each lap without seeing theirs.\n\n' +
        MOVE_KEYS.map(k => `${MOVES[k].emoji} **${MOVES[k].name}** — ${MOVES[k].blurb}`).join('\n'),
      color: GOLD,
      footer: { text: `Winner takes the rating and ${WIN_CREDITS} credits. ` +
                      `Unanswered after ${PICK_TIMEOUT_MIN} minutes and it lapses.` },
    }],
    components: [{ type: 1, components: [
      { type: 2, style: 3, label: 'Accept', custom_id: `rk:${id}:accept` },
      { type: 2, style: 4, label: 'Decline', custom_id: `rk:${id}:decline` },
    ] }],
  };
}

/* ── playing it ────────────────────────────────────────── */

const loadMatch = (env, id) =>
  env.DB.prepare(`SELECT * FROM ranked_match WHERE id = ?`).bind(String(id)).first();

const readState = row => {
  try { return JSON.parse(row.state); } catch { return null; }
};

/** Which side of the match this person is, or null if they are neither. */
const sideOf = (row, userId) =>
  String(row.challenger) === String(userId) ? 'a'
  : String(row.opponent) === String(userId) ? 'b' : null;

async function namesFor(env, interaction, row) {
  // Mentions render as names in the embed and cost no extra fetch, and
  // allowed_mentions keeps them from pinging on every single lap.
  return { a: `<@${row.challenger}>`, b: `<@${row.opponent}>` };
}

export async function onRankedButton(env, interaction, id, action) {
  const me = userOf(interaction);
  const row = await loadMatch(env, id);
  if (!row) return ephemeral('That race is gone.');

  const side = sideOf(row, me.id);
  if (!side) return ephemeral('That one is not yours.');

  if (action === 'accept' || action === 'decline') {
    if (side !== 'b') return ephemeral('Only the driver who was called out can answer.');
    if (row.status !== 'open') return ephemeral('That has already been answered.');

    if (action === 'decline') {
      const claim = await env.DB.prepare(
        `UPDATE ranked_match SET status = 'declined', decided_at = ?
          WHERE id = ? AND status = 'open'`).bind(Date.now(), id).run();
      if (!claim.meta || !claim.meta.changes) return ephemeral('Already answered.');
      return { type: 7, data: {
        embeds: [{ title: 'Turned down', color: GREY,
                   description: `<@${row.opponent}> is not racing today.` }],
        components: [], allowed_mentions: { parse: [] } } };
    }

    const state = newBattle();
    const claim = await env.DB.prepare(
      `UPDATE ranked_match SET status = 'live', state = ?, lap = 1, decided_at = ?
        WHERE id = ? AND status = 'open'`
    ).bind(JSON.stringify(state), Date.now(), id).run();
    if (!claim.meta || !claim.meta.changes) return ephemeral('Already answered.');

    const names = await namesFor(env, interaction, row);
    return { type: 7, data: {
      embeds: [liveEmbed(row, state, names, '**Lights out.**')],
      components: moveRow(id, state),
      allowed_mentions: { parse: [] } } };
  }

  /* ── a move ── */
  const move = MOVES[action];
  if (!move) return ephemeral('That is not a move.');
  if (row.status !== 'live') return ephemeral('That race is not running.');

  const state = readState(row);
  if (!state) return ephemeral('That race lost its state — it has been abandoned.');

  if (!canPick(state[side], action)) {
    return ephemeral(`${move.name} costs a bar of ERS and yours is flat. ` +
                     'Slipstream or defend to build it back up.');
  }

  // The guard, not a read-then-write: whichever tap arrives second finds
  // the column already set and is told so, rather than overwriting a pick.
  const col = side === 'a' ? 'a_move' : 'b_move';
  const mine = await env.DB.prepare(
    `UPDATE ranked_match SET ${col} = ? WHERE id = ? AND lap = ? AND ${col} IS NULL
       AND status = 'live'`).bind(action, id, row.lap).run();
  if (!mine.meta || !mine.meta.changes) {
    return ephemeral('You have already picked this lap. Waiting on them.');
  }

  const fresh = await loadMatch(env, id);
  const names = await namesFor(env, interaction, row);

  if (!fresh.a_move || !fresh.b_move) {
    const waitingOn = side === 'a' ? names.b : names.a;
    const locked = side === 'a' ? names.a : names.b;
    return { type: 7, data: {
      embeds: [{ ...liveEmbed(row, state, names),
                 footer: { text: 'Locked in. Waiting on the other car.' },
                 description: liveEmbed(row, state, names).description +
                   `\n\n🔒 ${locked} is in — ${waitingOn} to pick.` }],
      components: moveRow(id, state),
      allowed_mentions: { parse: [] } } };
  }

  // Both are in. Only one of the two requests gets to run the lap: the
  // claim is guarded on the lap number it was computed from, so the
  // other one finds the lap already advanced and says nothing.
  const played = resolve(state, fresh.a_move, fresh.b_move);
  const winner = finished(played.state);

  const claim = await env.DB.prepare(
    `UPDATE ranked_match SET state = ?, lap = ?, a_move = NULL, b_move = NULL,
            status = ?, winner = ?, decided_at = ?
      WHERE id = ? AND lap = ? AND a_move IS NOT NULL AND b_move IS NOT NULL`
  ).bind(JSON.stringify(played.state), played.state.lap,
         winner ? 'done' : 'live',
         winner ? (winner === 'draw' ? 'draw' : (winner === 'a' ? row.challenger : row.opponent)) : null,
         Date.now(), id, row.lap).run();
  if (!claim.meta || !claim.meta.changes) {
    return ephemeral('That lap is already running.');
  }

  const cfg = await settings(env);
  const story = [
    `${names.a} ${MOVES[fresh.a_move].emoji} **${MOVES[fresh.a_move].name}**  ·  ` +
    `${names.b} ${MOVES[fresh.b_move].emoji} **${MOVES[fresh.b_move].name}**`,
    ...played.notes.map(n => `› ${n.who === 'a' ? names.a : names.b} ${n.text}.`),
  ].join('\n');

  if (!winner) {
    return { type: 7, data: {
      embeds: [liveEmbed(row, played.state, names, story)],
      components: moveRow(id, played.state),
      allowed_mentions: { parse: [] } } };
  }

  /* ── the flag ── */
  const score = winner === 'draw' ? 0.5 : winner === 'a' ? 1 : 0;
  const moved = await applyResult(env, row.challenger, row.opponent, score);
  const winnerId = winner === 'draw' ? null
                 : winner === 'a' ? row.challenger : row.opponent;
  if (winnerId) await adjust(env, winnerId, WIN_CREDITS, 'Ranked win', cfg);

  const sign = n => (n > 0 ? `+${n}` : String(n));
  const line = (who, id2, m) => {
    const t = tierOf(m.after);
    const place = m.played + 1 <= PLACEMENT_RACES
      ? `  ·  placement ${m.played + 1}/${PLACEMENT_RACES}` : '';
    return `${who} ${t.emoji} **${m.after}** (${sign(m.delta)})${place}`;
  };

  return { type: 7, data: {
    embeds: [{
      title: winner === 'draw' ? '🏁 Dead heat' : '🏁 Chequered flag',
      description:
        story + '\n\n' + endReason(played.state, winner) + '\n\n' +
        (winnerId ? `**${winnerId === row.challenger ? names.a : names.b} takes it.**\n\n` : '\n') +
        line(names.a, row.challenger, moved.a) + '\n' +
        line(names.b, row.opponent, moved.b) +
        (winnerId ? `\n\nWinner's purse: ${money(WIN_CREDITS, cfg)}.` : ''),
      color: winner === 'draw' ? GREY : GREEN,
    }],
    components: [], allowed_mentions: { parse: [] } } };
}

/* ── the ladder commands ───────────────────────────────── */

export async function showLadder(env) {
  const rows = await ladder(env, 10);
  if (!rows.length) {
    return { title: '🏁 Ranked ladder', color: GREY,
             description: 'Nobody has raced yet. `/ranked challenge` starts it.' };
  }
  const medal = i => ['🥇', '🥈', '🥉'][i] || `\`${String(i + 1).padStart(2)}\``;
  return {
    title: '🏁 Ranked ladder',
    description: rows.map((r, i) => {
      const t = tierOf(r.rating);
      const run = r.streak >= 3 ? `  🔥${r.streak}` : '';
      return `${medal(i)} <@${r.user_id}> — ${t.emoji} **${r.rating}**  ` +
             `\`${r.won}W ${r.lost}L${r.drawn ? ` ${r.drawn}D` : ''}\`${run}`;
    }).join('\n'),
    color: RED,
    allowed_mentions: { parse: [] },
  };
}

export async function showRankedStats(env, interaction, targetId) {
  const who = String(targetId || userOf(interaction).id || '');
  if (!who) return { title: 'Who?', description: 'Could not tell who you meant.', color: GREY };
  const r = await getRating(env, who);
  if (!r.played) {
    return { title: 'No races yet', color: GREY,
             description: `<@${who}> has not raced ranked. \`/ranked challenge\` fixes that.`,
             allowed_mentions: { parse: [] } };
  }
  const t = tierOf(r.rating);
  const rate = Math.round((r.won / r.played) * 100);
  const run = r.streak > 0 ? `${r.streak} straight wins`
            : r.streak < 0 ? `${-r.streak} straight losses` : 'nothing going either way';
  return {
    title: `${t.emoji} ${t.name} · ${r.rating}`,
    description:
      `<@${who}>\n\n` +
      `**${r.won}W ${r.lost}L${r.drawn ? ` ${r.drawn}D` : ''}** in ${r.played} — ${rate}% wins\n` +
      `Best: **${r.best}**\nForm: ${run}` +
      (r.played < PLACEMENT_RACES
        ? `\n\n_Placement — ${PLACEMENT_RACES - r.played} to go, ratings move faster until then._`
        : ''),
    color: RED,
    allowed_mentions: { parse: [] },
  };
}

/**
 * Abandon anything nobody came back to.
 *
 * A challenge nobody answered, or a race where somebody walked away
 * mid-lap, would otherwise hold both drivers' one-at-a-time slot for
 * good. Nothing is staked on a ranked match, so an abandoned one simply
 * stops existing — no rating change for either side, which is the right
 * answer when there is no way to tell a rage quit from a flat battery.
 */
export async function sweepRanked(env) {
  const cutoff = Date.now() - PICK_TIMEOUT_MIN * 60 * 1000;
  const stale = await env.DB.prepare(
    `SELECT id FROM ranked_match WHERE status IN ('open','live')
       AND COALESCE(decided_at, at) < ?`).bind(cutoff).all();
  const rows = stale.results || [];
  for (const r of rows) {
    await env.DB.prepare(
      `UPDATE ranked_match SET status = 'expired', decided_at = ?
        WHERE id = ? AND status IN ('open','live')`).bind(Date.now(), r.id).run();
  }
  return rows.length;
}
