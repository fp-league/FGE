/**
 * Reading a Fortnite race leaderboard off a screenshot.
 *
 * Epic does not publish race data — only licensed partners get that — so the
 * positions have to come off the screen of whoever is spectating. The board
 * is a stack of light rows on a darker background with a header above them,
 * which is enough structure to find without hard-coding any coordinates:
 * resolutions differ, and so does where the screenshot was cropped.
 *
 * Rows come from a horizontal brightness profile — a row is bright, the gap
 * between rows is not. Columns come from the same profile taken across the
 * header, because the header cells are separate blocks. Both are measured
 * from the image rather than assumed, so a 1080p capture and a cropped 4K
 * one both work.
 */

/** Runs of consecutive values above the midpoint, ignoring short ones. */
function bands(profile, minRun) {
  let lo = Infinity, hi = -Infinity;
  for (const v of profile) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const thr = (lo + hi) / 2;
  const out = [];
  let run = null;
  for (let i = 0; i < profile.length; i++) {
    if (profile[i] > thr && run === null) run = i;
    else if (profile[i] <= thr && run !== null) {
      if (i - run >= minRun) out.push([run, i]);
      run = null;
    }
  }
  if (run !== null && profile.length - run >= minRun) out.push([run, profile.length]);
  return out;
}

function luma(ctx, w, h) {
  const d = ctx.getImageData(0, 0, w, h).data;
  const out = new Float32Array(w * h);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    out[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  }
  return out;
}

/**
 * Rows measured against their own neighbourhood instead of the whole frame.
 *
 * The profile below thresholds at the midpoint of the brightest and darkest
 * rows in the picture. That works for a board on a dark panel, where the
 * rows are the bright thing. It fails completely for a translucent board
 * over bright gameplay: there the rows sit around 115 and the gaps around
 * 103, inside a frame that ranges 64 to 170 — so the midpoint cuts straight
 * through the middle of the rows and finds nothing.
 *
 * Subtracting a local average first turns "brighter than the sky" into
 * "brighter than what is immediately above and below me", which is what a
 * row actually is. The window is a few row-pitches wide so a row cannot
 * flatten its own trend.
 */
function localBands(L, w, h, x0, x1) {
  const prof = rowProfile(L, w, h, x0, x1);
  const win = Math.max(9, Math.round(h * 0.06)) | 1;
  const half = win >> 1;

  // Running mean, edge-padded, as one pass.
  const out = [];
  let sum = 0;
  for (let i = -half; i <= half; i++) sum += prof[Math.min(h - 1, Math.max(0, i))];
  for (let y = 0; y < h; y++) {
    out.push(prof[y] - sum / win);
    const drop = prof[Math.min(h - 1, Math.max(0, y - half))];
    const add = prof[Math.min(h - 1, Math.max(0, y + half + 1))];
    sum += add - drop;
  }

  const minRun = Math.max(6, Math.round(h * 0.008));
  const bands = [];
  let run = null;
  for (let y = 0; y < h; y++) {
    if (out[y] > 0 && run === null) run = y;
    else if (out[y] <= 0 && run !== null) {
      if (y - run >= minRun) bands.push([run, y]);
      run = null;
    }
  }
  if (run !== null && h - run >= minRun) bands.push([run, h]);
  return bands;
}

function rowProfile(L, w, h, x0, x1) {
  const out = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let x = x0; x < x1; x++) s += L[y * w + x];
    out[y] = s / (x1 - x0);
  }
  return out;
}

function colProfile(L, w, y0, y1) {
  const out = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = y0; y < y1; y++) s += L[y * w + x];
    out[x] = s / (y1 - y0);
  }
  return out;
}

/**
 * Find the table. Returns the header band, the data rows, and the column
 * boundaries, or null when the picture does not look like a leaderboard.
 */
export function findTable(canvas) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const L = luma(ctx, w, h);

  // Ignore the far edges: the title sits top-left and a scrollbar can sit
  // hard right, and neither is part of a row.
  const X0 = Math.round(w * 0.02), X1 = Math.round(w * 0.95);
  const rows = bands(rowProfile(L, w, h, X0, X1), Math.max(8, Math.round(h * 0.015)));
  if (rows.length < 3) {
    const alt = localBands(L, w, h, X0, X1);
    return alt.length >= 3 ? pickRun(alt, L, w, 0.45) : null;
  }

  // Brightness bands come out clean, so hold them to a tight height match —
  // that is what keeps the header out of the data run. The detrended bands
  // are ragged where a row runs into whatever is beneath it, so they need
  // more room.
  return pickRun(rows, L, w, 0.12) || (() => {
    const alt = localBands(L, w, h, X0, X1);
    return alt.length >= 3 ? pickRun(alt, L, w, 0.45) : null;
  })();
}

/**
 * Pick the run of data rows out of a list of bands, and the header above it.
 *
 * Pitch alone is not enough: the header sits a row-pitch above the first
 * finisher, so it joins the run and whatever is above it gets taken for the
 * header instead. Height separates them — the data rows are all the same
 * height and the header is a different one. The height test is against the
 * row before rather than the first row of the run, because the last row of
 * a board often runs into whatever is beneath it.
 */
function pickRun(rows, L, w, heightTol) {
  if (rows.length < 3) return null;
  const tall = ([a, b]) => b - a;
  //
  // Pitch alone is not enough: the header sits one row-pitch above the
  // first finisher, so it joins the run and the title above it gets taken
  // for the header instead. Height separates them — every data row is the
  // same height, and the header is visibly shorter.
  let best = { start: -1, len: 0 };
  for (let i = 0; i < rows.length - 1; i++) {
    const pitch = rows[i + 1][0] - rows[i][0];
    let j = i;
    while (j + 1 < rows.length &&
           Math.abs((rows[j + 1][0] - rows[j][0]) - pitch) <= Math.max(3, pitch * 0.18) &&
           Math.abs(tall(rows[j + 1]) - tall(rows[j])) <= Math.max(3, tall(rows[j]) * heightTol)) j++;
    if (j - i + 1 > best.len) best = { start: i, len: j - i + 1 };
  }
  if (best.len < 2 || best.start < 1) return null;

  const data = rows.slice(best.start, best.start + best.len);
  const header = rows[best.start - 1];
  if (!header) return null;

  let cols = bands(colProfile(L, w, header[0], header[1]), Math.max(12, Math.round(w * 0.01)));
  // Even with no readable header cells there is still a table; one column
  // spanning the lot is enough to read the names out of.
  if (cols.length < 2) cols = [[Math.round(w * 0.02), Math.round(w * 0.95)]];

  return { header, rows: data, cols };
}

/** A padded crop, upscaled and hard-thresholded — what OCR reads best. */
export function cellCanvas(src, x0, y0, x1, y1, scale) {
  const pad = 4, s = scale || 3;
  const sx = Math.max(0, x0 - pad), sy = Math.max(0, y0 - pad);
  const sw = Math.min(src.width, x1 + pad) - sx;
  const sh = Math.min(src.height, y1 + pad) - sy;

  const c = document.createElement('canvas');
  c.width = Math.max(1, sw * s);
  c.height = Math.max(1, sh * s);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);

  // White-on-blue becomes black-on-white. Tesseract is trained on print.
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const on = v > 150 ? 0 : 255;
    d[i] = d[i + 1] = d[i + 2] = on;
    d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** Which column holds the player names — by header text, else the widest. */
export function playerColumn(headers, cols) {
  const i = headers.findIndex(h => /player|name|driver/i.test(h || ''));
  if (i >= 0) return i;
  let widest = 0;
  cols.forEach((c, j) => { if (c[1] - c[0] > cols[widest][1] - cols[widest][0]) widest = j; });
  return widest;
}
