/**
 * Reading a live board, over and over.
 *
 * One screenshot at a time was the manual version. This is the same reader
 * run on a frame every few seconds off a shared window, so the running
 * order and the gaps keep themselves up to date and nobody types anything
 * during a race.
 *
 * The expensive part is OCR, and almost none of it is necessary on a given
 * pass: the names in a leaderboard barely change from frame to frame, even
 * while the order does. So each name cell is hashed, and a cell whose
 * pixels have not moved reuses the name it had — which turns twenty reads
 * per frame into two or three.
 */

/**
 * A cheap hash of a cell's pixels.
 *
 * Downsamples to a small grid of average brightness. Insensitive to the
 * video noise and compression wobble that comes with a shared window, and
 * sensitive to the glyphs actually changing — which is the only difference
 * that matters.
 */
export function cellHash(ctx, x0, y0, x1, y1) {
  const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
  let img;
  try { img = ctx.getImageData(x0, y0, w, h); } catch { return ''; }
  const d = img.data;

  const GX = 8, GY = 3;
  const sum = new Float64Array(GX * GY);
  const cnt = new Float64Array(GX * GY);
  for (let y = 0; y < h; y++) {
    const gy = Math.min(GY - 1, (y * GY / h) | 0);
    for (let x = 0; x < w; x++) {
      const gx = Math.min(GX - 1, (x * GX / w) | 0);
      const i = (y * w + x) * 4;
      sum[gy * GX + gx] += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      cnt[gy * GX + gx]++;
    }
  }
  // Normalised against the cell's own range before quantising. Absolute
  // brightness drifts with video compression and with a row highlighting
  // itself, and neither means the text changed; what survives both is the
  // shape of light and dark within the cell.
  const avg = new Float64Array(sum.length);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < sum.length; i++) {
    avg[i] = sum[i] / (cnt[i] || 1);
    if (avg[i] < lo) lo = avg[i];
    if (avg[i] > hi) hi = avg[i];
  }
  const span = hi - lo;
  // A flat cell has no shape to compare; call them all the same rather
  // than letting noise decide.
  if (span < 8) return 'flat';

  let out = '';
  for (let i = 0; i < avg.length; i++) {
    out += String.fromCharCode(65 + Math.min(7, ((avg[i] - lo) / span * 8) | 0));
  }
  return out;
}

/** "30:24.267" → 1824.267. "1:02:03.4" → 3723.4. Null when unreadable. */
export function parseClock(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(s);
  if (m) {
    return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }
  const plain = /^(\d+(?:\.\d+)?)$/.exec(s);
  return plain ? Number(plain[1]) : null;
}

/**
 * Turn what was read off the board into a running order.
 *
 * The board shows each driver's total race time and the lap they are on,
 * which is everything needed for a real gap: the difference from the
 * leader's time, or a lap count when they are down one. A driver whose
 * time cannot be read keeps their position and gets no gap rather than a
 * made-up one.
 */
export function buildOrder(read, matched) {
  const rows = read.map((r, i) => ({
    name: r.name,
    lap: Number.isFinite(r.lap) ? r.lap : null,
    time: parseClock(r.time),
    driver: matched[i] ? matched[i].driver : null,
    certain: matched[i] ? matched[i].certain : false,
  }));

  const lead = rows.find(r => r.time != null);
  const leadLap = rows.reduce((m, r) => (r.lap != null && r.lap > m ? r.lap : m), 0);

  return rows.map((r, i) => {
    let gap = '';
    if (i === 0) {
      gap = '';
    } else if (r.lap != null && leadLap && r.lap < leadLap) {
      const down = leadLap - r.lap;
      gap = `+${down} LAP${down > 1 ? 'S' : ''}`;
    } else if (lead && r.time != null && lead.time != null) {
      const d = r.time - lead.time;
      gap = d > 0 ? `+${d.toFixed(3)}` : '';
    }
    return { ...r, gap };
  });
}

/**
 * Is this worth sending?
 *
 * Gaps tick constantly, so comparing everything would push on every single
 * frame and flood the overlay. The order is what matters; gaps ride along
 * when it changes, or when enough time has passed that they have gone
 * stale on screen.
 */
export function shouldPush(prev, next, sinceMs, staleMs) {
  if (!prev || prev.length !== next.length) return true;
  for (let i = 0; i < next.length; i++) {
    const a = prev[i], b = next[i];
    const ka = a.driver ? (a.driver.id || a.driver.name) : a.name;
    const kb = b.driver ? (b.driver.id || b.driver.name) : b.name;
    if (ka !== kb) return true;
  }
  return sinceMs >= (staleMs == null ? 15000 : staleMs);
}
