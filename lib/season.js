/**
 * A season, summed up.
 *
 * Used in two places that must agree: the admin panel computes it when a
 * season is archived, and the site computes it for the season still
 * running. Records are then the two added together, which only works if
 * both sides count the same way — so they count here, once.
 *
 * The summary is deliberately small. Keeping every archived season's full
 * results just to work out who has the most wins would mean the records
 * page downloading every race ever run.
 */

const DEFAULT_TABLE = [20, 15, 12, 10, 8, 6, 4, 3, 2, 1];

export const dKey = d => (d && (d.id || d.name)) || '';

export function pointsCfg(cd) {
  const p = (cd && cd.points) || {};
  const num = (v, d) => (v === '' || v == null || isNaN(Number(v)) ? d : Number(v));
  return {
    table: Array.isArray(p.table) && p.table.length ? p.table.map(n => Number(n) || 0) : DEFAULT_TABLE,
    fastestLap: num(p.fastestLap, 1),
    dotd: num(p.dotd, 0),
  };
}

/** A result entry → the key of the driver it belongs to. */
export function resultKey(res, drivers) {
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
 * Per-driver totals for one season, plus who won it.
 *
 * Only races with a classification count. An empty round on the calendar is
 * a race that has not happened, not a race everyone retired from.
 */
export function seasonSummary(cd, seasonName) {
  const drivers = (cd && cd.drivers) || [];
  const cfg = pointsCfg(cd);
  const scored = ((cd && cd.races) || []).filter(r => (r.results || []).length);

  const stat = {};
  const touch = (key, name, team) => {
    if (!stat[key]) {
      stat[key] = { key, name: name || key, team: team || '',
                    races: 0, wins: 0, podiums: 0, points: 0,
                    fastestLaps: 0, dotd: 0, dnfs: 0, best: null };
    }
    return stat[key];
  };
  drivers.forEach(d => touch(dKey(d), d.name, d.team));

  scored.forEach(race => {
    (race.results || []).forEach((res, i) => {
      const key = resultKey(res, drivers);
      if (!key) return;
      const known = drivers.find(x => dKey(x) === key);
      const s = touch(key, known ? known.name : key, known ? known.team : '');
      s.races++;

      const raw = (typeof res === 'object' && res.pos != null) ? res.pos : i + 1;
      if (String(raw).toUpperCase() === 'DNF') { s.dnfs++; return; }
      const pos = Number(raw);
      if (!Number.isFinite(pos)) return;

      s.points += cfg.table[pos - 1] || 0;
      if (pos === 1) s.wins++;
      if (pos <= 3) s.podiums++;
      if (s.best == null || pos < s.best) s.best = pos;
    });

    if (race.fastestLap) {
      const k = resultKey(race.fastestLap, drivers);
      if (stat[k]) { stat[k].fastestLaps++; stat[k].points += cfg.fastestLap; }
    }
    if (race.dotdWinner) {
      const k = resultKey(race.dotdWinner, drivers);
      if (stat[k]) { stat[k].dotd++; stat[k].points += cfg.dotd; }
    }
  });

  const table = Object.values(stat).sort((a, b) =>
    b.points - a.points || b.wins - a.wins || b.podiums - a.podiums ||
    a.name.localeCompare(b.name));

  // A champion needs a season that actually ran and points that were
  // actually scored. Nought points at the top of an empty table is not a
  // title, and recording one would put a ghost in the hall of fame.
  const champion = (scored.length && table.length && table[0].points > 0) ? table[0] : null;

  const teams = {};
  table.forEach(d => {
    if (!d.team) return;
    teams[d.team] = (teams[d.team] || 0) + d.points;
  });
  const teamTable = Object.entries(teams).map(([team, points]) => ({ team, points }))
    .sort((a, b) => b.points - a.points || a.team.localeCompare(b.team));
  const teamChampion = (scored.length && teamTable.length && teamTable[0].points > 0)
    ? teamTable[0] : null;

  return {
    season: seasonName || (cd && cd.seasonName) || 'Season',
    rounds: scored.length,
    drivers: table,
    teams: teamTable,
    champion: champion ? { key: champion.key, name: champion.name,
                           team: champion.team, points: champion.points } : null,
    teamChampion,
  };
}

/**
 * Career totals across several season summaries.
 *
 * Merged by driver key, so a driver keeps their history when they change
 * team but gets counted twice if their id ever changes — which is why
 * renaming a driver keeps their id.
 */
export function careerTotals(summaries) {
  const out = {};
  (summaries || []).forEach(sum => {
    (sum.drivers || []).forEach(d => {
      const c = out[d.key] || (out[d.key] = {
        key: d.key, name: d.name, team: d.team,
        seasons: 0, races: 0, wins: 0, podiums: 0, points: 0,
        fastestLaps: 0, dotd: 0, dnfs: 0, titles: 0, best: null,
      });
      // The most recent name and team win, so the hall of fame shows people
      // as they are now rather than as they were three seasons ago.
      c.name = d.name || c.name;
      c.team = d.team || c.team;
      if (d.races > 0) c.seasons++;
      c.races += d.races || 0;
      c.wins += d.wins || 0;
      c.podiums += d.podiums || 0;
      c.points += d.points || 0;
      c.fastestLaps += d.fastestLaps || 0;
      c.dotd += d.dotd || 0;
      c.dnfs += d.dnfs || 0;
      if (d.best != null && (c.best == null || d.best < c.best)) c.best = d.best;
    });
    if (sum.champion && out[sum.champion.key]) out[sum.champion.key].titles++;
  });
  return Object.values(out).filter(d => d.races > 0);
}

/** The leaderboards the records page shows. */
export function records(summaries) {
  const career = careerTotals(summaries);
  const top = (field, min) => career
    .filter(d => (d[field] || 0) >= (min == null ? 1 : min))
    .sort((a, b) => b[field] - a[field] || b.points - a.points || a.name.localeCompare(b.name))
    .slice(0, 10)
    .map(d => ({ name: d.name, team: d.team, value: d[field] }));

  return {
    career,
    titles:      top('titles'),
    wins:        top('wins'),
    podiums:     top('podiums'),
    points:      top('points'),
    starts:      top('races'),
    fastestLaps: top('fastestLaps'),
    dotd:        top('dotd'),
    champions: (summaries || [])
      .filter(s => s.champion)
      .map(s => ({ season: s.season, rounds: s.rounds,
                   driver: s.champion.name, points: s.champion.points,
                   team: s.teamChampion ? s.teamChampion.team : null })),
  };
}
