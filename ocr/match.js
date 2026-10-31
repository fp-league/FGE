/**
 * Matching a Fortnite leaderboard to the FGE grid.
 *
 * OCR gets the finishing order right and the spelling roughly right:
 * "BillyAmbros11" comes back as "BillyAmbrosi1", "NotFrøndra" as
 * "Notfronda". And even read perfectly, a Fortnite name is not an FGE name —
 * christosV12 races as Xristos, NotFrøndra as Fronda.
 *
 * So matching happens in two parts. Each driver can carry the Fortnite name
 * they actually play under, which makes the match near-exact. Until that is
 * filled in, fuzzy matching against the FGE name gets most of the grid and
 * flags the rest, and confirming a match saves it — so the list only ever
 * needs sorting out once.
 */

/** Lowercase, drop anything that is not a letter or digit. */
export function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Also drop trailing digits and common prefixes. Fortnite names collect
 * numbers ("JustRebel11", "Cainep8") that carry no meaning, and "Not" in
 * NotFrøndra is decoration rather than identity.
 */
function core(s) {
  let v = norm(s).replace(/\d+$/, '');
  v = v.replace(/^(not|the|its|im|xx|ttv|yt)/, '');
  return v || norm(s);
}

/** Levenshtein, capped — these are short strings. */
function lev(a, b) {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1,
                        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

const ratio = (a, b) => (!a.length && !b.length ? 1 : 1 - lev(a, b) / Math.max(a.length, b.length));

/**
 * How well one OCR'd name fits one driver, 0 to 1.
 *
 * A saved Fortnite name scores on its own scale above everything else, so a
 * driver who has told us what they play as always wins over a coincidental
 * resemblance to somebody else's FGE name.
 */
export function score(read, driver) {
  const r = norm(read), rc = core(read);
  if (!r) return 0;

  const fn = driver.fortniteName ? norm(driver.fortniteName) : '';
  if (fn) {
    if (fn === r) return 1;
    const s = Math.max(ratio(fn, r), ratio(core(driver.fortniteName), rc));
    if (s >= 0.72) return 0.80 + s * 0.19;        // 0.80–0.99, above any name match
  }

  const n = norm(driver.name), nc = core(driver.name);
  if (!n) return 0;
  if (n === r) return 0.79;

  let best = 0;
  // A Fortnite name usually contains the FGE name rather than equalling it:
  // riverschyu is Rivers, DGK Survival is DGK.
  if (r.startsWith(n) || n.startsWith(r)) best = Math.max(best, 0.74);
  if (rc.startsWith(nc) || nc.startsWith(rc)) best = Math.max(best, 0.72);
  if (n.length >= 4 && r.includes(n)) best = Math.max(best, 0.70);
  if (nc.length >= 4 && rc.includes(nc)) best = Math.max(best, 0.68);

  best = Math.max(best, ratio(n, r) * 0.68, ratio(nc, rc) * 0.66);
  return Math.min(best, 0.78);
}

/**
 * Match a read-off leaderboard to the grid, in order.
 *
 * Each driver can only be used once — the same person cannot finish twice,
 * and without that one strong name pulls in every row that looks like it.
 * Rows are assigned best-first rather than top-down so a confident match
 * further down the order is not blocked by a weak guess above it.
 */
export function matchAll(readNames, drivers, opts) {
  const o = opts || {};
  const accept = o.accept ?? 0.66;     // below this it is a guess, not a match
  const margin = o.margin ?? 0.04;     // and it must beat the runner-up

  const pairs = [];
  readNames.forEach((read, row) => {
    drivers.forEach((driver, di) => {
      const s = score(read, driver);
      if (s > 0) pairs.push({ row, di, s });
    });
  });
  pairs.sort((a, b) => b.s - a.s);

  const byRow = new Map(), usedDriver = new Set(), usedRow = new Set();
  const runnerUp = new Map();
  for (const p of pairs) {
    if (usedRow.has(p.row)) {
      if (!runnerUp.has(p.row)) runnerUp.set(p.row, p.s);
      continue;
    }
    if (usedDriver.has(p.di)) continue;
    usedRow.add(p.row); usedDriver.add(p.di);
    byRow.set(p.row, p);
  }

  return readNames.map((read, row) => {
    const hit = byRow.get(row);
    if (!hit) return { read, driver: null, confidence: 0, certain: false };
    const second = runnerUp.get(row) || 0;
    const certain = hit.s >= accept && (hit.s - second) >= margin;
    return {
      read,
      driver: drivers[hit.di],
      confidence: Math.round(hit.s * 100) / 100,
      certain,
    };
  });
}
