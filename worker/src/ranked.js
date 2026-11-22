/**
 * The ladder.
 *
 * One combined rating per person rather than one per division: the fight
 * in battle.js is the same fight whoever you normally race, so splitting
 * it would only thin out the pool and make a rating mean less.
 *
 * Standard Elo, because it is the thing everybody already understands and
 * it needs no tuning to be fair. Three departures from the textbook, each
 * for a reason:
 *
 *   PLACEMENT   the first five races move you further and faster. A new
 *               rating is a guess, and the point of placements is to stop
 *               charging the next twenty opponents for that guess.
 *   FLOOR       a rating cannot fall below 100. Below that the number
 *               stops being information and starts being a reason to make
 *               a second account.
 *   NO DECAY    not implemented. A league this size would punish people
 *               for having a job.
 */

export const START_RATING = 1000;
export const K_PLACEMENT = 64;
export const K_NORMAL = 32;
export const PLACEMENT_RACES = 5;
export const RATING_FLOOR = 100;
export const WIN_CREDITS = 250;   // a ranked win pays, a ranked loss does not cost

/** The chance the ratings say `self` has against `them`. */
export const expected = (self, them) => 1 / (1 + Math.pow(10, (them - self) / 400));

export const kFor = played => played < PLACEMENT_RACES ? K_PLACEMENT : K_NORMAL;

/**
 * New ratings after one result.
 *
 * `score` is from A's point of view: 1 win, 0 loss, 0.5 draw. Both sides
 * are computed from the ratings as they were BEFORE the race, or the
 * second calculation would be reacting to the first.
 */
export function rate(a, b, score) {
  const ea = expected(a.rating, b.rating);
  const eb = expected(b.rating, a.rating);
  const ka = kFor(a.played), kb = kFor(b.played);
  const floor = n => Math.max(RATING_FLOOR, Math.round(n));
  return {
    a: floor(a.rating + ka * (score - ea)),
    b: floor(b.rating + kb * ((1 - score) - eb)),
  };
}

/** A rank name, so the number means something at a glance. */
export function tierOf(rating) {
  if (rating >= 1600) return { name: 'Champion', emoji: '👑' };
  if (rating >= 1400) return { name: 'Platinum', emoji: '💠' };
  if (rating >= 1250) return { name: 'Gold',     emoji: '🥇' };
  if (rating >= 1100) return { name: 'Silver',   emoji: '🥈' };
  if (rating >= 900)  return { name: 'Bronze',   emoji: '🥉' };
  return { name: 'Rookie', emoji: '🔰' };
}

/* ── storage ───────────────────────────────────────────── */

export async function getRating(env, userId) {
  const row = await env.DB.prepare(
    `SELECT user_id, rating, played, won, lost, drawn, streak, best
       FROM ranked_rating WHERE user_id = ?`).bind(String(userId)).first();
  if (row) return row;
  return { user_id: String(userId), rating: START_RATING, played: 0,
           won: 0, lost: 0, drawn: 0, streak: 0, best: START_RATING };
}

/**
 * Write both sides of a result.
 *
 * The upsert carries every counter rather than reading and writing back,
 * so two races finishing at the same moment cannot lose one of the two.
 */
export async function applyResult(env, aId, bId, score) {
  const [a, b] = await Promise.all([getRating(env, aId), getRating(env, bId)]);
  const next = rate(a, b, score);

  const save = (who, rating, result) => {
    const won = result === 1 ? 1 : 0;
    const lost = result === 0 ? 1 : 0;
    const drawn = result === 0.5 ? 1 : 0;
    // A streak is positive for wins and negative for losses, so one column
    // says both "on a run" and "having a nightmare".
    const streak = result === 1 ? Math.max(1, (who.streak || 0) + 1)
                 : result === 0 ? Math.min(-1, (who.streak || 0) - 1)
                 : 0;
    return env.DB.prepare(
      `INSERT INTO ranked_rating (user_id, rating, played, won, lost, drawn, streak, best, at)
            VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET
            rating = excluded.rating,
            played = ranked_rating.played + 1,
            won    = ranked_rating.won    + excluded.won,
            lost   = ranked_rating.lost   + excluded.lost,
            drawn  = ranked_rating.drawn  + excluded.drawn,
            streak = excluded.streak,
            best   = MAX(ranked_rating.best, excluded.rating),
            at     = excluded.at`
    ).bind(String(who.user_id), rating, won, lost, drawn, streak,
           Math.max(who.best || 0, rating), Date.now()).run();
  };

  await save(a, next.a, score);
  await save(b, next.b, score === 0.5 ? 0.5 : 1 - score);

  return {
    a: { before: a.rating, after: next.a, delta: next.a - a.rating, played: a.played },
    b: { before: b.rating, after: next.b, delta: next.b - b.rating, played: b.played },
  };
}

export async function ladder(env, limit = 10) {
  const rows = await env.DB.prepare(
    `SELECT user_id, rating, played, won, lost, drawn, streak
       FROM ranked_rating WHERE played > 0
      ORDER BY rating DESC, won DESC, played ASC LIMIT ?`).bind(limit).all();
  return rows.results || [];
}
