/**
 * Time penalties, applied to a running order.
 *
 * A penalty that only shows on screen is a note. The point is that it moves
 * people: five seconds for a track-limits abuse should drop a driver behind
 * whoever was four seconds back, and the classification that gets saved
 * should already say so.
 *
 * Gaps in race control are free text, because that is what a human watching
 * a stream can actually type. So they are parsed rather than assumed, and
 * anything unparseable leaves that driver where they were instead of
 * throwing them to the back.
 */

const LAP = 1e6;        // a lap down beats any number of seconds

/**
 * "+1.234" → 1.234, "1:02.5" → 62.5, "+2 LAPS" → 2000000, "" → 0.
 * Returns null when it cannot tell, which callers treat as "leave it".
 */
export function gapSeconds(raw) {
  const s = String(raw == null ? '' : raw).trim().toUpperCase();
  if (!s || s === 'LEADER' || s === '-' || s === '—') return 0;

  const laps = /^\+?\s*(\d+)\s*LAPS?\b/.exec(s);
  if (laps) return Number(laps[1]) * LAP;

  // M:SS.mmm, or H:MM:SS.mmm
  const clock = /^\+?\s*(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(s);
  if (clock) {
    const h = Number(clock[1] || 0), m = Number(clock[2]), sec = Number(clock[3]);
    return h * 3600 + m * 60 + sec;
  }

  const plain = /^\+?\s*(\d+(?:\.\d+)?)\s*S?$/.exec(s);
  if (plain) return Number(plain[1]);

  return null;
}

/**
 * Re-order a running list with penalties added to each driver's gap.
 *
 * Classification order is finishers, then retirements, then
 * disqualifications — the convention, and the one that makes a DSQ mean
 * something. Within finishers it is corrected time; within the other two
 * groups the existing order is kept, because nothing better is known.
 *
 * The sort is stable and keyed on the original index, so drivers whose
 * times cannot be read — or who are all on the same gap — come out in the
 * order the operator put them in rather than shuffled.
 */
export function applyPenalties(running) {
  const rows = (running || []).map((r, i) => {
    const base = gapSeconds(r.gap);
    const pen = Math.max(0, Number(r.pen) || 0);
    return {
      row: r,
      i,
      group: r.dsq ? 2 : (r.out ? 1 : 0),
      // Unreadable gap: keep them put by sorting on their current position.
      known: base != null,
      key: base == null ? null : base + pen,
      pen,
    };
  });

  const finishers = rows.filter(r => r.group === 0);
  const readable = finishers.filter(r => r.known);

  // If nothing has a readable gap there is nothing to work from, so leave
  // the order exactly as it is rather than inventing one.
  if (!readable.length) return { running: (running || []).slice(), moved: [], usable: false };

  // An unreadable gap sits at the position it already holds, measured
  // against the readable ones around it, so it neither jumps nor sinks.
  let lastKnown = 0;
  finishers.forEach(r => {
    if (r.known) lastKnown = r.key;
    else r.key = lastKnown;          // same as the driver ahead, ties broken by index
  });

  const sorted = rows.slice().sort((a, b) =>
    a.group - b.group ||
    (a.key - b.key) ||
    a.i - b.i);

  const moved = [];
  sorted.forEach((r, newIdx) => {
    if (newIdx !== r.i) {
      moved.push({ name: r.row.name, from: r.i + 1, to: newIdx + 1, pen: r.pen });
    }
  });

  return { running: sorted.map(r => r.row), moved, usable: true };
}

/** "+5s" for a badge, or '' when there is no penalty. */
export function penLabel(r) {
  if (r && r.dsq) return 'DSQ';
  const n = Math.max(0, Number(r && r.pen) || 0);
  if (!n) return '';
  return `+${Number.isInteger(n) ? n : n.toFixed(1)}s`;
}
