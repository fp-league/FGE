/**
 * FGE Discord bot — HTTP interactions.
 *
 * Discord POSTs slash commands to the Worker and we reply in the response,
 * so there is no gateway connection and nothing to keep running. The whole
 * bot is stateless: every command reads the same league record the website
 * does, so it can never disagree with the site.
 *
 * Commands: /standings /results /calendar /nextrace /lineups /driver
 */

const RED  = 0xE10600;   // GT3
const BLUE = 0x5599FF;   // GT4
const GREY = 0x888888;

/* ── scoring (mirrors app.js) ────────────────────────────── */

const DEFAULT_POINTS = { table: [20, 15, 12, 10, 8, 6, 4, 3, 2, 1], fastestLap: 1, dotd: 0 };

function pointsCfg(cd) {
  const p = (cd && cd.points) || {};
  const num = (v, d) => (v === '' || v == null || isNaN(Number(v)) ? d : Number(v));
  return {
    table: Array.isArray(p.table) && p.table.length ? p.table.map(n => Number(n) || 0) : DEFAULT_POINTS.table,
    fastestLap: num(p.fastestLap, DEFAULT_POINTS.fastestLap),
    dotd: num(p.dotd, DEFAULT_POINTS.dotd),
  };
}

const driverKey = d => (d && (d.id || d.name)) || '';

function resolveDriver(res, drivers) {
  if (!res) return null;
  const list = drivers || [];
  if (typeof res === 'object' && res.driverId) {
    const byId = list.find(x => x.id === res.driverId);
    if (byId) return byId;
  }
  const name = typeof res === 'string' ? res : res.driver;
  if (!name) return null;
  return list.find(x => x.name === name) || { name };
}

const resultKey  = (res, drivers) => driverKey(resolveDriver(res, drivers));
const resultName = (res, drivers) => {
  const d = resolveDriver(res, drivers);
  return (d && d.name) || (typeof res === 'string' ? res : (res && res.driver) || '');
};

function nameOrIdKey(v, drivers) {
  if (!v) return '';
  const list = drivers || [];
  const hit = list.find(x => x.id === v) || list.find(x => x.name === v);
  return hit ? driverKey(hit) : String(v);
}

export function calcStandings(cd) {
  const drivers = cd.drivers || [];
  const races = cd.races || [];
  const cfg = pointsCfg(cd);
  const pts = {}, tpts = {};

  races.forEach(r => {
    if (!r.results) return;
    const flKey = nameOrIdKey(r.fastestLap, drivers);
    const dotdKey = nameOrIdKey(r.dotdWinner, drivers);
    r.results.forEach((res, i) => {
      const k = resultKey(res, drivers);
      if (!k) return;
      const pos = (typeof res === 'object' && res.pos != null) ? res.pos : i + 1;
      if (String(pos).toUpperCase() === 'DNF') return;
      let earn = cfg.table[Number(pos) - 1] || 0;
      if (flKey && k === flKey) earn += cfg.fastestLap;
      pts[k] = (pts[k] || 0) + earn;
    });
    if (dotdKey && cfg.dotd) pts[dotdKey] = (pts[dotdKey] || 0) + cfg.dotd;
  });

  drivers.forEach(d => {
    if (!d.team) return;
    tpts[d.team] = (tpts[d.team] || 0) + (pts[driverKey(d)] || 0);
  });
  return { pts, tpts, cfg };
}

/* ── helpers ─────────────────────────────────────────────── */

const classColour = cls => (cls === 'gt4' ? BLUE : RED);
const classLabel  = cls => (cls === 'gt4' ? 'GT4' : 'GT3');

function fmtDate(s) {
  if (!s) return 'TBC';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s).trim());
  const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(s);
  if (isNaN(d.getTime())) return 'TBC';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function raceLength(r) {
  const m = (r && (r.minutes ?? r.laps)) || 0;
  if (!m) return '';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}

/** A date-only race counts as upcoming until the end of that day. */
function raceStart(s) {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s).trim());
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function findNextRace(races) {
  const now = Date.now();
  return (races || [])
    .filter(r => {
      const s = raceStart(r.date);
      return s && s.getTime() + 86400000 > now;
    })
    .sort((a, b) => raceStart(a.date) - raceStart(b.date))[0] || null;
}

const medal = i => (i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `\`${String(i + 1).padStart(2, ' ')}\``);

const trim = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');

/* ── command builders ────────────────────────────────────── */

export function buildStandings(cd, cls, mode) {
  const { pts, tpts } = calcStandings(cd);
  const label = classLabel(cls);

  if (mode === 'teams') {
    const rows = (cd.teams || [])
      .map(t => ({ name: t.name, pts: tpts[t.name] || 0 }))
      .sort((a, b) => b.pts - a.pts);
    if (!rows.length) return simple(`${label} Team Standings`, 'No teams yet.', classColour(cls));
    const lead = rows[0].pts;
    return {
      title: `${label} — Constructors' Standings`,
      color: classColour(cls),
      description: rows.slice(0, 15).map((t, i) =>
        `${medal(i)} **${trim(t.name, 28)}** — ${t.pts}${i ? ` *(-${lead - t.pts})*` : ''}`
      ).join('\n'),
      footer: { text: `${cd.seasonName || 'Season'} · ${rows.length} teams` },
    };
  }

  const rows = (cd.drivers || [])
    .map(d => ({ name: d.name, team: d.team, pts: pts[driverKey(d)] || 0 }))
    .sort((a, b) => b.pts - a.pts)
    .filter(r => r.pts > 0);
  if (!rows.length) return simple(`${label} Standings`, 'No points scored yet.', classColour(cls));
  const lead = rows[0].pts;
  return {
    title: `${label} — Drivers' Standings`,
    color: classColour(cls),
    description: rows.slice(0, 20).map((d, i) =>
      `${medal(i)} **${trim(d.name, 20)}** — ${d.pts}${i ? ` *(-${lead - d.pts})*` : ''}`
    ).join('\n'),
    footer: { text: `${cd.seasonName || 'Season'} · ${rows.length} scoring drivers` },
  };
}

export function buildResults(cd, cls, round) {
  const scored = (cd.races || []).filter(r => (r.results || []).length);
  if (!scored.length) return simple(`${classLabel(cls)} Results`, 'No races have been run yet.', classColour(cls));

  const race = round != null
    ? scored.find(r => Number(r.round) === Number(round))
    : scored[scored.length - 1];
  if (!race) return simple('Not found', `No results for round ${round}.`, GREY);

  const drivers = cd.drivers || [];
  const cfg = pointsCfg(cd);
  const flKey = nameOrIdKey(race.fastestLap, drivers);
  const dotdKey = nameOrIdKey(race.dotdWinner, drivers);

  const lines = (race.results || []).map((res, i) => {
    const k = resultKey(res, drivers);
    const pos = (typeof res === 'object' && res.pos != null) ? res.pos : i + 1;
    const dnf = String(pos).toUpperCase() === 'DNF';
    let earn = dnf ? 0 : (cfg.table[Number(pos) - 1] || 0);
    if (!dnf && flKey && k === flKey) earn += cfg.fastestLap;
    if (!dnf && dotdKey && k === dotdKey) earn += cfg.dotd;
    const badge = (flKey && k === flKey ? ' ⚡' : '') + (dotdKey && k === dotdKey ? ' ⭐' : '');
    const place = dnf ? '`DNF`' : medal(Number(pos) - 1);
    return `${place} ${dnf ? '~~' : '**'}${trim(resultName(res, drivers), 20)}${dnf ? '~~' : '**'}${badge}` +
           (earn ? ` — ${earn}` : '');
  });

  const dnfs = (race.results || []).filter(r => String((typeof r === 'object' && r.pos) || '').toUpperCase() === 'DNF').length;
  const meta = [race.track, fmtDate(race.date), raceLength(race)].filter(Boolean).join(' · ');

  return {
    title: `Round ${race.round || '?'} — ${trim(race.name || 'Race', 80)}`,
    description: trim(lines.join('\n'), 4000),
    color: classColour(cls),
    footer: { text: `${classLabel(cls)} · ${meta}${dnfs ? ` · ${dnfs} DNF` : ''}` },
  };
}

export function buildCalendar(cd, cls) {
  const races = (cd.races || []).slice().sort((a, b) => (a.round || 0) - (b.round || 0));
  if (!races.length) return simple(`${classLabel(cls)} Calendar`, 'No races scheduled.', classColour(cls));
  const next = findNextRace(races);

  const lines = races.map(r => {
    const done = (r.results || []).length > 0;
    const isNext = next && r.round === next.round;
    const mark = done ? '✅' : isNext ? '🔴' : '⬜';
    const when = r.date ? `<t:${Math.floor(raceStart(r.date).getTime() / 1000)}:d>` : 'TBC';
    return `${mark} **R${r.round || '?'}** ${trim(r.name || '', 34)} — ${when}`;
  });

  return {
    title: `${classLabel(cls)} — ${cd.seasonName || 'Season'} Calendar`,
    description: trim(lines.join('\n'), 4000),
    color: classColour(cls),
    footer: { text: `${races.filter(r => (r.results || []).length).length} of ${races.length} rounds completed` },
  };
}

export function buildNextRace(cd, cls) {
  const next = findNextRace(cd.races || []);
  if (!next) return simple(`${classLabel(cls)} — Next Race`, 'No upcoming races on the calendar.', classColour(cls));
  const ts = raceStart(next.date);
  const fields = [];
  if (next.track) fields.push({ name: 'Circuit', value: next.track, inline: true });
  if (raceLength(next)) fields.push({ name: 'Length', value: raceLength(next), inline: true });
  if (ts) fields.push({ name: 'Starts', value: `<t:${Math.floor(ts.getTime() / 1000)}:F>\n<t:${Math.floor(ts.getTime() / 1000)}:R>`, inline: false });
  return {
    title: `Round ${next.round || '?'} — ${trim(next.name || 'Race', 80)}`,
    color: classColour(cls),
    fields,
    footer: { text: `${classLabel(cls)} · ${cd.seasonName || 'Season'}` },
  };
}

export function buildLineups(cd, cls, teamName) {
  const teams = cd.teams || [];
  const drivers = cd.drivers || [];
  if (!teams.length) return simple(`${classLabel(cls)} Lineups`, 'No teams yet.', classColour(cls));

  const wanted = teamName
    ? teams.filter(t => t.name.toLowerCase().includes(String(teamName).toLowerCase()))
    : teams;
  if (!wanted.length) return simple('Not found', `No team matching “${teamName}”.`, GREY);

  const { tpts } = calcStandings(cd);
  const fields = wanted.slice(0, 25).map(t => {
    const line = drivers.filter(d => d.team === t.name);
    return {
      name: `${trim(t.name, 40)} — ${tpts[t.name] || 0} pts`,
      value: line.length
        ? line.map(d => `• ${d.number ? `\`#${d.number}\` ` : ''}${d.name}${d.nationality ? ` *(${d.nationality})*` : ''}`).join('\n')
        : '*No drivers listed*',
      inline: false,
    };
  });

  return {
    title: `${classLabel(cls)} — Team Lineups`,
    color: classColour(cls),
    fields,
    footer: { text: `${wanted.length} team${wanted.length === 1 ? '' : 's'} · ${cd.seasonName || 'Season'}` },
  };
}

export function buildDriver(cd, cls, query) {
  const drivers = cd.drivers || [];
  const q = String(query || '').toLowerCase();
  const drv = drivers.find(d => d.name.toLowerCase() === q)
           || drivers.find(d => d.name.toLowerCase().includes(q));
  if (!drv) return simple('Not found', `No ${classLabel(cls)} driver matching “${query}”.`, GREY);

  const { pts } = calcStandings(cd);
  const key = driverKey(drv);
  const races = (cd.races || []).filter(r => (r.results || []).some(res => resultKey(res, drivers) === key));

  let wins = 0, podiums = 0, dnfs = 0, best = null;
  const form = [];
  races.forEach(r => {
    const res = (r.results || []).find(x => resultKey(x, drivers) === key);
    const idx = (r.results || []).indexOf(res);
    const pos = (typeof res === 'object' && res.pos != null) ? res.pos : idx + 1;
    if (String(pos).toUpperCase() === 'DNF') { dnfs++; form.push('✖'); return; }
    const p = Number(pos);
    if (p === 1) wins++;
    if (p <= 3) podiums++;
    if (best === null || p < best) best = p;
    form.push(String(p));
  });

  const order = drivers.map(d => ({ k: driverKey(d), p: pts[driverKey(d)] || 0 }))
    .sort((a, b) => b.p - a.p);
  const position = order.findIndex(x => x.k === key) + 1;

  return {
    title: `${drv.name}${drv.number ? ` · #${drv.number}` : ''}`,
    description: [drv.team && `**${drv.team}**`, drv.nationality].filter(Boolean).join(' · ') || undefined,
    color: classColour(cls),
    fields: [
      { name: 'Points',  value: String(pts[key] || 0), inline: true },
      { name: 'Position', value: position ? `P${position}` : '—', inline: true },
      { name: 'Starts',  value: String(races.length), inline: true },
      { name: 'Wins',    value: String(wins), inline: true },
      { name: 'Podiums', value: String(podiums), inline: true },
      { name: 'Best',    value: best === null ? '—' : `P${best}`, inline: true },
      ...(form.length ? [{ name: 'Form (recent last)', value: '`' + form.slice(-8).join('` `') + '`', inline: false }] : []),
    ],
    footer: { text: `${classLabel(cls)} · ${cd.seasonName || 'Season'}${dnfs ? ` · ${dnfs} DNF` : ''}` },
  };
}

function simple(title, description, color) {
  return { title, description, color };
}

/* ── signature verification ──────────────────────────────── */

const hexToBytes = hex => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
};

/** Discord signs every request; an unverified endpoint fails their checks. */
export async function verifyRequest(request, body, publicKey) {
  const sig = request.headers.get('X-Signature-Ed25519');
  const ts  = request.headers.get('X-Signature-Timestamp');
  if (!sig || !ts || !publicKey) return false;
  const data = new TextEncoder().encode(ts + body);
  for (const algo of ['Ed25519', 'NODE-ED25519']) {
    try {
      const key = await crypto.subtle.importKey('raw', hexToBytes(publicKey), { name: algo, namedCurve: 'NODE-ED25519' }, false, ['verify']);
      return await crypto.subtle.verify(algo, key, hexToBytes(sig), data);
    } catch (e) { /* try the other name */ }
  }
  return false;
}

/* ── interaction router ──────────────────────────────────── */

const SUBCOMMAND = 1;   // Discord option type for a subcommand

/**
 * Commands come in two shapes, both supported:
 *   /standings type:teams class:GT4      — flat, GT3 unless class is given
 *   /gt4 standings type:teams            — class baked into the command
 */
function route(interaction) {
  const name = (interaction.data && interaction.data.name) || '';
  const opts = (interaction.data && interaction.data.options) || [];

  if (name === 'gt3' || name === 'gt4') {
    const sub = opts.find(o => o.type === SUBCOMMAND) || opts[0];
    return {
      cls: name,
      view: (sub && sub.name) || '',
      options: (sub && sub.options) || [],
    };
  }

  const cls = (opts.find(o => o.name === 'class') || {}).value;
  return {
    cls: String(cls || 'gt3').toLowerCase() === 'gt4' ? 'gt4' : 'gt3',
    view: name,
    options: opts,
  };
}

const pick = (options, name) => {
  const o = (options || []).find(x => x.name === name);
  return o ? o.value : undefined;
};

export function handleCommand(interaction, record) {
  const { cls, view, options } = route(interaction);
  const cd = (record && record[cls]) || {};

  let embed;
  switch (view) {
    case 'standings': embed = buildStandings(cd, cls, pick(options, 'type') || 'drivers'); break;
    case 'results':   embed = buildResults(cd, cls, pick(options, 'round')); break;
    case 'calendar':  embed = buildCalendar(cd, cls); break;
    case 'nextrace':  embed = buildNextRace(cd, cls); break;
    case 'lineups':   embed = buildLineups(cd, cls, pick(options, 'team')); break;
    case 'driver':    embed = buildDriver(cd, cls, pick(options, 'name')); break;
    default:          embed = simple('Unknown command', `\`${view || '?'}\` isn't something I know.`, GREY);
  }

  if (!embed.footer) embed.footer = { text: 'FGE' };
  embed.footer.text += ' · fp-league.github.io/FGE';

  return { type: 4, data: { embeds: [embed] } };
}
