/* ===== FGE — FORTNITE GLOBAL ENDURANCE — app.js ===== */
'use strict';

// ── CONFIG ──────────────────────────────────────────────
const BIN_ID      = '6ada83fdac6210605a4a3a74';
// Read-only key. The public site never writes, so the master (read/write)
// key must never appear in this file — it was here unused and is now gone.
const ACCESS_KEY  = '$2a$10$G0A4V5Q7TOSTCAm/D4oskenfMyJjU.5SXbAVK5kdCNIkmelTS/.be';
const BIN_URL     = `https://api.jsonbin.io/v3/b/${BIN_ID}`;
// Worker that holds the state a static site can't: race control / live timing.
const API_BASE    = 'https://fge-api.benjaminjameswestley.workers.dev';

// ── STATE ────────────────────────────────────────────────
let rawData       = null;           // full JSONBin record { gt3:{…}, gt4:{…} }
let currentClass  = (() => {
    // Reading storage throws outright in some privacy modes. This runs at the
    // very top of the file, so an exception here would stop app.js loading at
    // all and leave the site on a blank page.
    try { return localStorage.getItem('fge_class') || 'GT3'; } catch (e) { return 'GT3'; }
})();
let currentPage   = 'home';
let standingsTab  = 'drivers';
let driverFocusId = null;
let teamFocusId   = null;
let raceFocusIdx  = null;

// User identity (DOTD / Fantasy / Predictions)
let userId   = (() => { try { return localStorage.getItem('fge_userId'); }   catch (e) { return null; } })();
let userName = (() => { try { return localStorage.getItem('fge_userName'); } catch (e) { return null; } })();

// Driver of the Day — the real tally, fetched from the Worker. Votes used to
// live in localStorage, which meant every visitor saw only their own vote and
// the bar always read 100%.
let dotdData   = null;     // { races: {round: {driver: n}}, myVotes: {round: driver} }
let dotdLoaded = false;
let dotdBusy   = false;

// Live timing, pushed from race control in the admin panel
let liveState     = { status: 'idle', running: [] };
let liveSkew      = 0;      // server clock minus ours, so clocks agree
let livePollTimer = null;
let liveSig       = null;   // so the tower only repaints when it changes

// ── HELPERS: DATA ───────────────────────────────────────
function cls() { return rawData?.[currentClass.toLowerCase()] || emptyClass(); }

function closeNav() {
    document.getElementById('navOverlay')?.classList.remove('open');
    document.getElementById('navToggle')?.classList.remove('open');
}

function emptyClass() {
    return { drivers:[], teams:[], races:[], news:[], fantasy:{}, archive:{}, seasonName:'Season 1' };
}

// Driver/team names and image URLs are admin-entered and get interpolated
// into HTML attributes, so they must be escaped.
function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// Team colours are admin-entered free text and get written into style
// attributes and parsed with parseInt. Anything that isn't a clean 6-digit
// hex is rejected, so a stray value can't break out of the attribute or
// turn into NaN,NaN,NaN inside rgba().
function safeHex(v, fallback) {
    const s = String(v == null ? '' : v).trim();
    if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toUpperCase();
    if (/^#[0-9a-fA-F]{3}$/.test(s)) {
        return ('#' + s[1]+s[1] + s[2]+s[2] + s[3]+s[3]).toUpperCase();
    }
    return fallback;
}

// ── DRIVER IDENTITY ──────────────────────────────────────
// Results used to reference drivers by name alone, so renaming a driver
// orphaned every result they had scored and two drivers sharing a name
// silently merged. Drivers now carry a stable id; everything resolves by
// id first and falls back to the name so existing data keeps working.

function driverKey(drv) {
    if (!drv) return '';
    return drv.id || drv.name || '';
}

/** The driver record a result entry refers to. */
function resolveDriver(res, driversArr) {
    if (!res) return null;
    const list = driversArr || cls().drivers || [];
    if (typeof res === 'object' && res.driverId) {
        const byId = list.find(x => x.id === res.driverId);
        if (byId) return byId;
    }
    const name = (typeof res === 'string') ? res : res.driver;
    if (!name) return null;
    // Unknown driver (deleted, or a typo in old data): keep showing the name
    return list.find(x => x.name === name) || { name };
}

const resultKey  = (res, arr) => driverKey(resolveDriver(res, arr));
const resultName = (res, arr) => {
    const d = resolveDriver(res, arr);
    if (d && d.name) return d.name;
    return (typeof res === 'string') ? res : ((res && res.driver) || '');
};

/** Match a stored fastestLap/dotdWinner (a name, or an id) to a driver key. */
function nameOrIdKey(v, driversArr) {
    if (!v) return '';
    const list = driversArr || cls().drivers || [];
    const hit = list.find(x => x.id === v) || list.find(x => x.name === v);
    return hit ? driverKey(hit) : String(v);
}

function colourFor(name, teamsArr) {
    if (!name) return autoColor('');
    const arr = teamsArr || cls().teams || [];
    let t = arr.find(x => x.name === name);
    if (!t) t = arr.find(x => (x.name||'').toLowerCase() === name.toLowerCase());
    if (!t) t = arr.find(x => (x.name||'').toLowerCase().includes(name.toLowerCase()) || name.toLowerCase().includes((x.name||'').toLowerCase()));
    return safeHex(t && t.color, autoColor(name));
}

function autoColor(name) {
    const p = ['#E10600','#0067FF','#00D2BE','#FF8000','#DC0000','#005AFF','#900000','#2B4562','#006F62','#B6BABD','#FF1E00','#0090FF','#00A3E0'];
    let h = 0;
    for (let i = 0; i < (name||'').length; i++) h = (h * 31 + name.charCodeAt(i)) % p.length;
    return p[h];
}

function hex2rgb(hex) {
    const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
    return `${r},${g},${b}`;
}

// Races are timed, not lap-counted. `laps` is read as a fallback so any
// race entered before the switch still shows its length.
function raceLength(r) {
    const m = (r && (r.minutes ?? r.laps)) || 0;
    if (!m) return '';
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60), rem = m % 60;
    return rem ? `${h}h ${rem}m` : `${h}h`;
}

const hasTime = s => Boolean(s) && !/^\d{4}-\d{2}-\d{2}$/.test(String(s).trim());

function fmtDate(str) {
    if (!str) return '';
    const d = raceStart(str);
    if (!d) return '';
    const date = d.toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' });
    // A stored time is a real moment, so show it in each viewer's own zone.
    if (!hasTime(str)) return date;
    return `${date}, ${d.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' })}`;
}

function ago(str) {
    if (!str) return '';
    const diff = Date.now() - new Date(str).getTime();
    const m = Math.floor(diff/60000), h = Math.floor(m/60), d = Math.floor(h/24);
    if (d > 0) return `${d}d ago`;
    if (h > 0) return `${h}h ago`;
    if (m > 0) return `${m}m ago`;
    return 'just now';
}

function ordinal(n) {
    const s = ['th','st','nd','rd'], v = n%100;
    return n + (s[(v-20)%10] || s[v] || s[0]);
}

function driverName(d) { return d ? (d.name || d.username || 'Unknown') : 'TBC'; }

// Scoring is editable per class from the admin Season tab. These are only
// the fallbacks used before anything has been saved.
const DEFAULT_POINTS = {
    table: [20, 15, 12, 10, 8, 6, 4, 3, 2, 1],
    fastestLap: 1,
    dotd: 0,            // DOTD is an award, not points
};

function pointsCfg(data) {
    const p = ((data || cls()).points) || {};
    const table = Array.isArray(p.table) && p.table.length
        ? p.table.map(n => Number(n) || 0)
        : DEFAULT_POINTS.table;
    const num = (v, d) => (v === '' || v == null || isNaN(Number(v)) ? d : Number(v));
    return {
        table,
        fastestLap: num(p.fastestLap, DEFAULT_POINTS.fastestLap),
        dotd:       num(p.dotd,       DEFAULT_POINTS.dotd),
    };
}

function pointsTable() { return pointsCfg().table; }

function calcStandings(races, drivers, teams, cfg) {
    const pts = {};
    const tpts = {};
    const scoring = cfg || pointsCfg();
    races.forEach(r => {
        if (!r.results) return;
        r.results.forEach((res, i) => {
            // Results come in two shapes: a bare driver name (legacy) or
            // { driver, time }. The old guard required .driver, which a
            // string never has, so legacy results silently scored nothing.
            if (!res) return;
            const p = resultKey(res, drivers);
            if (!p) return;
            const pos = (typeof res === 'object' && res.pos != null) ? res.pos : (i + 1);
            if (String(pos).toUpperCase() === 'DNF') return;
            const earn = scoring.table[Number(pos) - 1] || 0;
            if (!pts[p]) pts[p] = 0;
            pts[p] += earn;
            // fastest lap bonus
            if (r.fastestLap && nameOrIdKey(r.fastestLap, drivers) === p) pts[p] += scoring.fastestLap;
        });
        // DOTD bonus
        if (r.dotdWinner && scoring.dotd) {
            const dk = nameOrIdKey(r.dotdWinner, drivers);
            if (dk) { if (!pts[dk]) pts[dk] = 0; pts[dk] += scoring.dotd; }
        }
    });
    // Team standings
    drivers.forEach(d => {
        const tc = d.team;
        if (!tc) return;
        if (!tpts[tc]) tpts[tc] = 0;
        tpts[tc] += pts[driverKey(d)] || 0;
    });
    return { pts, tpts };
}

function formGuide(driver, races, driversArr) {
    // Accepts a driver record or, for older call sites, a bare name.
    const target = (driver && typeof driver === 'object')
        ? driverKey(driver)
        : nameOrIdKey(driver, driversArr);
    const results = [];
    const racesCopy = [...races].reverse();
    racesCopy.forEach(r => {
        if (!r.results) return;
        const idx = r.results.findIndex(res => resultKey(res, driversArr) === target);
        if (idx === -1) return;
        const res = r.results[idx];
        const pos = typeof res === 'object' ? (res.pos != null ? res.pos : idx + 1) : idx + 1;
        results.push(pos);
        if (results.length >= 5) return;
    });
    return results.slice(0, 5);
}

function formHTML(guide) {
    return guide.map(pos => {
        const ps = String(pos).toUpperCase();
        let cls = 'fg-fin', label = ps;
        if (ps === 'DNF') { cls = 'fg-dnf'; label = 'X'; }
        else if (Number(pos) === 1) cls = 'fg-win';
        else if (Number(pos) <= 3) cls = 'fg-pod';
        return `<div class="fg-dot ${cls}" title="P${pos}">${label}</div>`;
    }).join('');
}

// A bare "YYYY-MM-DD" parses as UTC midnight, which shifts the race by the
// viewer's UTC offset — east of UTC the race reads as already gone hours
// before the day starts. Parse date-only strings as LOCAL midnight instead.
function isDateOnly(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '').trim()); }

function raceStart(dateStr) {
    if (!dateStr) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr).trim());
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    const dt = new Date(dateStr);
    return isNaN(dt.getTime()) ? null : dt;
}

// A date-only race counts as upcoming until the end of that day, so race day
// itself shows "RACE DAY" rather than jumping to the following round.
function raceEnd(dateStr) {
    const s = raceStart(dateStr);
    if (!s) return null;
    return isDateOnly(dateStr) ? new Date(s.getTime() + 86400000) : s;
}

function findNextRace(races) {
    const now = Date.now();
    return (races || [])
        .filter(r => { const e = raceEnd(r.date); return e && e.getTime() > now; })
        .sort((a, b) => raceStart(a.date) - raceStart(b.date))[0] || null;
}

function countdownHTML(targetDate) {
    if (!targetDate) return '';
    const start = raceStart(targetDate);
    if (!start) return '';
    const diff = start.getTime() - Date.now();
    if (diff <= 0) return '<span class="cb-raceday">RACE DAY</span>';
    const d = Math.floor(diff / 86400000);
    const h = Math.floor((diff % 86400000) / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    return `
      <span class="cb-unit"><span id="cd-d">${d}</span><label>DAYS</label></span>
      <span class="cb-sep">:</span>
      <span class="cb-unit"><span id="cd-h">${String(h).padStart(2,'0')}</span><label>HRS</label></span>
      <span class="cb-sep">:</span>
      <span class="cb-unit"><span id="cd-m">${String(m).padStart(2,'0')}</span><label>MIN</label></span>
      <span class="cb-sep">:</span>
      <span class="cb-unit"><span id="cd-s">${String(s).padStart(2,'0')}</span><label>SEC</label></span>`;
}

// ── CLASS SWITCHER ──────────────────────────────────────
// Keeps the browser/PWA chrome in step with the class background
function applyThemeColor(cls) {
    const meta = document.getElementById('themeColorMeta');
    if (meta) meta.setAttribute('content', cls === 'GT4' ? '#071C45' : '#450A07');
}

function switchClass(cls) {
    if (cls === currentClass) return;
    currentClass = cls;
    try { localStorage.setItem('fge_class', cls); } catch(e) {}
    // Drives --class-color and --page-bg: red for GT3, blue for GT4
    document.body.classList.toggle('gt4-mode', cls === 'GT4');
    applyThemeColor(cls);
    syncFviNav();
    syncStewardsNav();
    document.getElementById('csGT3')?.classList.toggle('active', cls === 'GT3');
    document.getElementById('csGT4')?.classList.toggle('active', cls === 'GT4');
    // Tallies are per class, so the cached one is wrong now.
    dotdData = null; dotdLoaded = false;
    renderCurrentPage();
}

// ── FETCH DATA ──────────────────────────────────────────
async function fetchData() {
    try {
        const r = await fetch(`${BIN_URL}/latest`, {
            headers: { 'X-Access-Key': ACCESS_KEY }
        });
        const json = await r.json();
        rawData = json.record;
    } catch(e) {
        console.error('FGE data fetch error', e);
        rawData = { gt3: emptyClass(), gt4: emptyClass() };
    }
}

// ── NAVIGATION ──────────────────────────────────────────
function navigate(page, extra) {
    currentPage = page;
    if (extra) {
        if (extra.driverFocusId != null) driverFocusId = extra.driverFocusId;
        if (extra.teamFocusId != null)   teamFocusId   = extra.teamFocusId;
        if (extra.raceFocusIdx != null)  raceFocusIdx  = extra.raceFocusIdx;
    }
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    const el = document.getElementById(`page-${page}`) || document.getElementById(page);
    if (el) el.classList.add('active');
    document.querySelectorAll('.nav-link').forEach(a => {
        a.classList.toggle('active', a.dataset.page === page);
    });
    // Close nav overlay
    closeNav();
    window.scrollTo(0,0);
    renderCurrentPage();
}

function renderCurrentPage() {
    switch(currentPage) {
        case 'home':       renderHome(); break;
        case 'standings':  renderStandings(); break;
        case 'results':    renderResults(); break;
        case 'calendar':   renderCalendar(); break;
        case 'teams':      renderTeams(); break;
        case 'drivers':    renderDrivers(); break;
        case 'fantasy':    renderFantasy(); break;
        case 'race':       renderRace(); break;
        case 'live':       renderLive(); break;
        case 'cards':      renderCards(); break;
        case 'stewards':   renderStewards(); break;
        case 'dotd':       renderDOTD(); break;
    }
}

// ── HOME PAGE ────────────────────────────────────────────
function renderHome() {
    const d = cls();
    renderLiveBanner();
    renderRaceStrip(d);
    renderCountdown(d);
    renderHomeNews(d);
    renderHomeStandings(d);
}

function renderRaceStrip(d) {
    const next = findNextRace(d.races) || d.races?.[d.races.length-1];
    const el = document.getElementById('raceStrip');
    if (!el || !next) return;
    const isUp = next.date && new Date(next.date) >= new Date();
    el.innerHTML = `
      <span class="rs-round">ROUND ${next.round || '?'}</span>
      <span class="rs-name">${next.name || 'TBC'}</span>
      <span class="rs-track">📍 ${next.track || ''}</span>
      <span class="rs-date">${fmtDate(next.date)}</span>
      <span class="rs-status ${isUp?'up':''}">${isUp?'UPCOMING':'COMPLETED'}</span>`;
}

function renderCountdown(d) {
    const el = document.getElementById('countdownBar');
    if (!el) return;
    const next = findNextRace(d.races);
    if (!next) {
        el.style.display = 'flex';
        el.innerHTML = '<span class="cb-label">NO UPCOMING RACE</span>';
        return;
    }
    el.style.display = 'flex';
    const label = next.name ? `NEXT RACE — ${next.name}` : 'NEXT RACE';
    el.innerHTML = `<span class="cb-label">${label}</span><div class="cb-units">${countdownHTML(next.date)}</div>`;
}

function renderHomeNews(d) {
    const el = document.getElementById('homeNews');
    if (!el) return;
    const news = (d.news || []).slice().reverse();
    if (!news.length) {
        el.innerHTML = `<div class="news-empty">
            <div class="news-empty-icon">📰</div>
            <p>No news published yet.</p>
          </div>`;
        return;
    }
    const hero = news[0];
    const mini = news.slice(1, 4);
    const snippet = s => {
        const t = String(s||'').replace(/\s+/g,' ').trim();
        return t.length > 150 ? t.slice(0,150).replace(/\s\S*$/,'') + '…' : t;
    };

    el.innerHTML = `
      <article class="nh" onclick="openNewsModal(0)">
        ${hero.image
          ? `<div class="nh-bg" style="background-image:url('${esc(hero.image)}')"></div>`
          : `<div class="nh-bg nh-placeholder"></div>`}
        <div class="nh-overlay"></div>
        <div class="nh-content">
          <div class="nh-meta">
            <span class="nh-tag">${esc(hero.tag || currentClass)}</span>
            ${hero.date ? `<span class="nh-date">${ago(hero.date)}</span>` : ''}
          </div>
          <h2>${esc(hero.title || 'FGE News')}</h2>
          <p>${esc(snippet(hero.excerpt || hero.body))}</p>
          <span class="nh-read">READ FULL STORY &rarr;</span>
        </div>
      </article>

      <div class="news-side">
        ${mini.length ? mini.map((n,i) => `
          <article class="nm" onclick="openNewsModal(${i+1})">
            ${n.image
              ? `<div class="nm-img" style="background-image:url('${esc(n.image)}')"></div>`
              : `<div class="nm-img nm-placeholder"><span>FGE</span></div>`}
            <div class="nm-body">
              <div class="nm-meta">
                <span class="nm-tag">${esc(n.tag || currentClass)}</span>
                ${n.date ? `<span class="nm-date">${ago(n.date)}</span>` : ''}
              </div>
              <h4>${esc(n.title || '')}</h4>
            </div>
          </article>`).join('')
        : `<div class="nm nm-none"><p>More stories coming soon.</p></div>`}
      </div>`;
}

function openNewsModal(idx) {
    const d = cls();
    const news = (d.news || []).slice().reverse();
    const n = news[idx];
    if (!n) return;
    const m = document.getElementById('modal');
    const mc = document.getElementById('modalContent');
    if (!m || !mc) return;
    mc.innerHTML = `
      <button class="modal-close" onclick="closeModal()">✕</button>
      ${n.image ? `<div class="modal-news-img" style="background-image:url('${esc(n.image)}')"></div>` : ''}
      <div class="na-meta">
        <span class="nh-tag">${esc(n.tag || currentClass)}</span>
        ${n.date ? `<span class="na-date">${fmtDate(n.date)}</span>` : ''}
      </div>
      <h2 class="na-title">${esc(n.title||'')}</h2>
      ${n.excerpt ? `<p class="na-standfirst">${esc(n.excerpt)}</p>` : ''}
      <div class="na-body">${esc(n.body||'').replace(/\n{2,}/g,'</p><p>').replace(/\n/g,'<br>').replace(/^/,'<p>').replace(/$/,'</p>')}</div>`;
    m.classList.remove('hidden');
}

function renderHomeStandings(d) {
    const el = document.getElementById('homeStandings');
    if (!el) return;
    const { pts } = calcStandings(d.races||[], d.drivers||[], d.teams||[]);
    const sorted = [...(d.drivers||[])].sort((a,b) => (pts[driverKey(b)]||0) - (pts[driverKey(a)]||0)).slice(0,5);
    if (!sorted.length) { el.innerHTML = '<p style="color:var(--muted)">No standings yet.</p>'; return; }
    el.innerHTML = sorted.map((drv, i) => {
        const col = colourFor(drv.team, d.teams);
        const p = pts[driverKey(drv)] || 0;
        return `<div style="display:flex;align-items:center;gap:0.8rem;padding:0.6rem 0;border-bottom:1px solid var(--line);cursor:pointer" onclick="navigate('drivers',{driverFocusId:'${drv.id||drv.name}'})">
          <span style="font-family:var(--font-display);font-size:0.9rem;color:var(--muted);width:22px">${i+1}</span>
          <span class="team-dot" style="background:${col}"></span>
          <span style="flex:1;color:var(--white)">${drv.name}</span>
          <span style="font-family:var(--font-display);color:var(--white)">${p} <span style="color:var(--muted);font-size:0.7rem">PTS</span></span>
        </div>`;
    }).join('');
}

// ── STANDINGS PAGE ───────────────────────────────────────

// ── POINTS PROGRESSION CHART ─────────────────────────────
// Inline SVG so there's no charting library to load. Shows cumulative
// points per driver across the rounds that have results, top N only -
// a full grid of lines is unreadable.

function pointsProgression(d, topN) {
    const cfg = pointsCfg(d);
    const scored = (d.races||[])
        .filter(r => (r.results||[]).length)
        .slice()
        .sort((a,b) => (a.round||0) - (b.round||0));
    if (!scored.length) return null;

    const totals = {};
    const series = {};
    (d.drivers||[]).forEach(dr => { totals[driverKey(dr)] = 0; series[driverKey(dr)] = [0]; });

    scored.forEach(race => {
        const flKey   = nameOrIdKey(race.fastestLap, d.drivers);
        const dotdKey = nameOrIdKey(race.dotdWinner, d.drivers);
        (race.results||[]).forEach((res, i) => {
            const key = resultKey(res, d.drivers);
            if (!key || !(key in totals)) return;
            const pos = (typeof res === 'object' && res.pos != null) ? res.pos : i + 1;
            if (String(pos).toUpperCase() === 'DNF') return;
            let earn = cfg.table[Number(pos) - 1] || 0;
            if (flKey && key === flKey) earn += cfg.fastestLap;
            if (dotdKey && key === dotdKey) earn += cfg.dotd;
            totals[key] += earn;
        });
        Object.keys(series).forEach(k => series[k].push(totals[k]));
    });

    const ranked = (d.drivers||[])
        .map(dr => ({ drv: dr, key: driverKey(dr), pts: totals[driverKey(dr)] || 0 }))
        .sort((a,b) => b.pts - a.pts)
        .filter(x => x.pts > 0)
        .slice(0, topN || 8);

    if (!ranked.length) return null;
    return { rounds: scored, series, ranked, max: Math.max(...ranked.map(r => r.pts), 1) };
}

function renderProgressionChart(d) {
    const data = pointsProgression(d, 8);
    if (!data) return '';
    const { rounds, series, ranked, max } = data;

    const W = 760, H = 300, PL = 38, PR = 12, PT = 14, PB = 30;
    const iw = W - PL - PR, ih = H - PT - PB;
    const n = rounds.length;                 // number of scored rounds
    const x = i => PL + (n === 0 ? iw/2 : (iw * i) / n);
    const y = v => PT + ih - (ih * v) / max;

    // horizontal gridlines at nice intervals
    const step = Math.max(1, Math.ceil(max / 4 / 10) * 10);
    const grid = [];
    for (let v = 0; v <= max; v += step) {
        grid.push(`<line x1="${PL}" y1="${y(v).toFixed(1)}" x2="${W-PR}" y2="${y(v).toFixed(1)}" class="pc-grid"/>
                   <text x="${PL-7}" y="${(y(v)+3.5).toFixed(1)}" class="pc-axis" text-anchor="end">${v}</text>`);
    }

    const xlabels = rounds.map((r, i) =>
        `<text x="${x(i+1).toFixed(1)}" y="${H-10}" class="pc-axis" text-anchor="middle">R${r.round || i+1}</text>`
    ).join('');

    const lines = ranked.map(({ drv, key }) => {
        const col = colourFor(drv.team, d.teams);
        const pts = (series[key] || []).map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
        const last = (series[key] || [])[n] || 0;
        return `<polyline points="${pts}" class="pc-line" style="stroke:${col}"/>
                <circle cx="${x(n).toFixed(1)}" cy="${y(last).toFixed(1)}" r="3.5" style="fill:${col}"/>`;
    }).join('');

    const legend = ranked.map(({ drv, key }) => {
        const col = colourFor(drv.team, d.teams);
        return `<button class="pc-key" onclick="navigate('drivers',{driverFocusId:'${esc(key)}'})">
            <span class="team-dot" style="background:${col}"></span>${esc(drv.name)}
            <b>${series[key][n] || 0}</b>
          </button>`;
    }).join('');

    return `
      <div class="section-head"><h2>POINTS PROGRESSION</h2></div>
      <div class="pc-wrap">
        <svg viewBox="0 0 ${W} ${H}" class="pc-svg" preserveAspectRatio="xMidYMid meet"
             role="img" aria-label="Cumulative championship points by round">
          ${grid.join('')}
          ${xlabels}
          ${lines}
        </svg>
        <div class="pc-legend">${legend}</div>
      </div>`;
}

/**
 * Who can still win the title.
 *
 * A driver is still in it if everything left on the table would take them
 * past the leader's total as it stands — the leader can always score nothing,
 * so that is the fair test. The leader has clinched when even a perfect run
 * from second place cannot reach them.
 */
function titleRace(d, pts, sorted) {
    const races = d.races || [];
    const remaining = races.filter(r => !(r.results || []).length).length;
    if (!sorted.length) return '';

    const cfg = pointsCfg(d);
    const perRace = (cfg.table[0] || 0) + (cfg.fastestLap || 0) + (cfg.dotd || 0);
    const onTable = remaining * perRace;

    const leader     = sorted[0];
    const leaderPts  = pts[driverKey(leader)] || 0;
    const runnerUp   = sorted[1];
    const runnerPts  = runnerUp ? (pts[driverKey(runnerUp)] || 0) : 0;

    if (!remaining) {
        return `
          <div class="tr-panel tr-done">
            <span class="tr-crown">🏆</span>
            <div>
              <div class="tr-head">${esc(leader.name)} wins the championship</div>
              <div class="tr-sub">Season complete — ${leaderPts} points.</div>
            </div>
          </div>`;
    }

    // Clinched: nobody left can reach the leader even with a clean sweep.
    if (runnerUp && runnerPts + onTable < leaderPts) {
        return `
          <div class="tr-panel tr-done">
            <span class="tr-crown">🏆</span>
            <div>
              <div class="tr-head">${esc(leader.name)} has won the championship</div>
              <div class="tr-sub">Unbeatable with ${remaining} round${remaining !== 1 ? 's' : ''} to go.</div>
            </div>
          </div>`;
    }

    const alive = sorted.filter(drv => (pts[driverKey(drv)] || 0) + onTable >= leaderPts);
    const out   = sorted.length - alive.length;

    return `
      <div class="tr-panel">
        <div class="tr-top">
          <h3>WHO CAN STILL WIN IT</h3>
          <span class="tr-meta">${remaining} round${remaining !== 1 ? 's' : ''} left ·
            up to ${onTable} points still on the table</span>
        </div>
        <div class="tr-list">
          ${alive.map((drv, i) => {
              const p    = pts[driverKey(drv)] || 0;
              const gap  = leaderPts - p;
              const col  = safeHex(colourFor(drv.team, d.teams), '#888888');
              const need = gap === 0
                  ? 'Leads the championship'
                  : (gap > onTable - perRace
                      ? `${gap} behind — needs help`
                      : `${gap} behind`);
              return `
                <div class="tr-row">
                  <span class="tr-pos">${i + 1}</span>
                  <span class="tr-bar" style="background:${col}"></span>
                  <span class="tr-name">${esc(drv.name)}</span>
                  <span class="tr-need">${esc(need)}</span>
                  <span class="tr-max">max ${p + onTable}</span>
                </div>`;
          }).join('')}
        </div>
        ${out ? `<div class="tr-out">${out} driver${out !== 1 ? 's are' : ' is'} mathematically out.</div>` : ''}
      </div>`;
}

function renderStandings() {
    const d = cls();
    const { pts, tpts } = calcStandings(d.races||[], d.drivers||[], d.teams||[]);
    const el = document.getElementById('standingsContent');
    if (!el) return;

    if (standingsTab === 'drivers') {
        const sorted = [...(d.drivers||[])].sort((a,b) => (pts[driverKey(b)]||0) - (pts[driverKey(a)]||0));
        if (!sorted.length) { el.innerHTML = '<p style="color:var(--muted);padding:2rem">No driver data yet.</p>'; return; }
        const leader = sorted.length ? (pts[driverKey(sorted[0])] || 0) : 0;
        el.innerHTML = `
          <div class="table-container">
            <table class="standings-table">
              <thead><tr>
                <th>POS</th><th>DRIVER</th><th class="std-hide-mobile">TEAM</th><th class="std-hide-mobile">NAT</th><th class="std-hide-mobile">FORM</th><th>PTS</th>
              </tr></thead>
              <tbody>
                ${sorted.map((drv, i) => {
                    const col = colourFor(drv.team, d.teams);
                    const p = pts[driverKey(drv)] || 0;
                    const gap = i === 0 ? '' : `-${leader - p}`;
                    const guide = formGuide(drv, d.races||[], d.drivers);
                    return `<tr onclick="navigate('drivers',{driverFocusId:'${drv.id||drv.name}'})">
                      <td class="pos">${i+1}</td>
                      <td class="driver"><div class="std-driver"><span class="team-dot" style="background:${col}"></span>${drv.name}</div></td>
                      <td class="rt-team std-hide-mobile"><span class="team-dot" style="background:${col}"></span>${drv.team||'—'}</td>
                      <td class="std-hide-mobile" style="color:var(--muted)">${drv.nationality||''}</td>
                      <td class="std-hide-mobile"><div class="form-guide">${formHTML(guide)}</div></td>
                      <td class="points">${i===0 ? `<span class="pts-leader">${p}</span>` : `<span>${p}</span><br><span class="pts-gap">${gap}</span>`}</td>
                    </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>` + titleRace(d, pts, sorted) + renderProgressionChart(d);
    } else {
        const sorted = [...(d.teams||[])].sort((a,b) => (tpts[b.name]||0) - (tpts[a.name]||0));
        if (!sorted.length) { el.innerHTML = '<p style="color:var(--muted);padding:2rem">No team data yet.</p>'; return; }
        const leader = tpts[sorted[0]?.name] || 0;
        el.innerHTML = `
          <div class="table-container">
            <table class="standings-table">
              <thead><tr><th>POS</th><th>TEAM</th><th>PTS</th></tr></thead>
              <tbody>
                ${sorted.map((t, i) => `
                  <tr onclick="navigate('teams',{teamFocusId:'${t.id||t.name}'})">
                    <td class="pos">${i+1}</td>
                    <td class="rt-team"><span class="team-dot" style="background:${t.color||autoColor(t.name)}"></span>${t.name}</td>
                    <td class="points">${i===0 ? `<span class="pts-leader">${tpts[t.name]||0}</span>` : `${tpts[t.name]||0}<br><span class="pts-gap">-${leader-(tpts[t.name]||0)}</span>`}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>`;
    }
}

// ── RESULTS PAGE ─────────────────────────────────────────
function renderResults() {
    const d = cls();
    const races = (d.races||[]).filter(r=>r.results?.length).slice().reverse();
    const el = document.getElementById('resultsContent');
    if (!el) return;
    if (!races.length) { el.innerHTML = '<p style="color:var(--muted);padding:2rem">No results yet.</p>'; return; }
    el.innerHTML = races.map((race, idx) => {
        const topRes = race.results.slice(0,3).map((res, i) => {
            const drvName = resultName(res, d.drivers);
            const col = colourFor(resolveDriver(res, d.drivers)?.team, d.teams);
            const pos = typeof res === 'object' && res.pos ? res.pos : i+1;
            return `<div class="cp-row"><span class="cp-pos">${ordinal(pos)}</span><span class="team-dot" style="background:${col}"></span><span class="cp-name">${drvName}</span></div>`;
        }).join('');
        return `
          <div style="background:var(--surface);border:1px solid var(--line);border-radius:4px;margin-bottom:1rem;overflow:hidden;cursor:pointer" onclick="openRaceModal(${d.races.indexOf(race)})">
            <div style="background:linear-gradient(90deg,var(--accent),#0A2050);padding:0.8rem 1.2rem;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.5rem">
              <div>
                <span style="font-family:var(--font-display);font-size:0.7rem;color:rgba(255,255,255,0.5);letter-spacing:0.1em">ROUND ${race.round||'?'}</span>
                <div style="font-family:var(--font-display);font-size:1.1rem;color:#fff;letter-spacing:0.06em">${race.name||'Race'}</div>
              </div>
              <div style="text-align:right">
                <div style="font-size:0.8rem;color:rgba(255,255,255,0.5);font-family:var(--font-ui)">${fmtDate(race.date)}</div>
                <div style="font-size:0.78rem;color:rgba(255,255,255,0.4);font-family:var(--font-ui)">${race.track||''}</div>
              </div>
            </div>
            <div style="padding:1rem 1.2rem">${topRes}</div>
          </div>`;
    }).join('');
}

// Races now get a full page rather than a cramped modal.
function openRaceModal(idx) { navigate('race', { raceFocusIdx: idx }); }

function renderRace() {
    const el = document.getElementById('raceContent');
    if (!el) return;
    const d = cls();
    const idx = raceFocusIdx;
    const race = (d.races||[])[idx];
    if (!race) {
        el.innerHTML = `<p class="dp-empty" style="padding:2rem">Race not found.</p>
          <button class="btn btn-secondary" onclick="navigate('results')">&larr; ALL RESULTS</button>`;
        return;
    }

    const results = race.results || [];
    const finished = results.filter(r => String((typeof r==='object'&&r.pos)||'').toUpperCase() !== 'DNF');
    const flKey   = nameOrIdKey(race.fastestLap, d.drivers);
    const dotdKey = nameOrIdKey(race.dotdWinner, d.drivers);
    const cfg = pointsCfg(d);

    const podium = results.slice(0, 3).map((res, i) => {
        const who = resolveDriver(res, d.drivers);
        const col = colourFor(who?.team, d.teams);
        const place = ['gold','silver','bronze'][i];
        return `<div class="rp-step ${place}" style="--tc:${col}">
            <div class="rp-place">${ordinal(i+1)}</div>
            <div class="rp-driver">${esc(resultName(res, d.drivers))}</div>
            <div class="rp-team"><span class="team-dot" style="background:${col}"></span>${esc(who?.team||'—')}</div>
          </div>`;
    }).join('');

    const rows = results.map((res, i) => {
        const who  = resolveDriver(res, d.drivers);
        const key  = resultKey(res, d.drivers);
        const col  = colourFor(who?.team, d.teams);
        const pos  = (typeof res === 'object' && res.pos != null) ? res.pos : i + 1;
        const dnf  = String(pos).toUpperCase() === 'DNF';
        const time = (typeof res === 'object' ? res.time : '') || '';
        let earned = dnf ? 0 : (cfg.table[Number(pos)-1] || 0);
        if (!dnf && flKey && key === flKey) earned += cfg.fastestLap;
        if (!dnf && dotdKey && key === dotdKey) earned += cfg.dotd;
        const medal = pos === 1 ? 'gold' : pos === 2 ? 'silver' : pos === 3 ? 'bronze' : '';
        return `<tr class="${dnf?'rt-dnf':''}" onclick="navigate('drivers',{driverFocusId:'${esc(key)}'})">
            <td class="rp-pos ${medal} ${dnf?'dnf':''}">${dnf ? 'DNF' : pos}</td>
            <td class="rp-name">
              ${esc(resultName(res, d.drivers))}
              ${flKey && key===flKey ? '<span class="rp-badge fl" title="Fastest lap">FL</span>' : ''}
              ${dotdKey && key===dotdKey ? '<span class="rp-badge dotd" title="Driver of the Day">DOTD</span>' : ''}
            </td>
            <td class="rp-teamcell"><span class="team-dot" style="background:${col}"></span>${esc(who?.team||'—')}</td>
            <td class="rp-time">${esc(time) || '—'}</td>
            <td class="rp-pts">${earned || '—'}</td>
          </tr>`;
    }).join('');

    const flName   = flKey   ? (d.drivers||[]).find(x=>driverKey(x)===flKey)?.name   || race.fastestLap : '';
    const dotdName = dotdKey ? (d.drivers||[]).find(x=>driverKey(x)===dotdKey)?.name || race.dotdWinner : '';

    el.innerHTML = `
      <button class="btn btn-secondary dp-back" onclick="navigate('results')">&larr; ALL RESULTS</button>

      <div class="rp-head">
        <span class="rp-round">ROUND ${race.round || '?'}</span>
        <h1 class="rp-title">${esc(race.name || 'Race')}</h1>
        <div class="rp-meta">
          ${race.track ? `<span>📍 ${esc(race.track)}</span>` : ''}
          ${race.date ? `<span>${fmtDate(race.date)}</span>` : ''}
          ${raceLength(race) ? `<span>${raceLength(race)}</span>` : ''}
          <span>${finished.length} classified${results.length-finished.length ? ` · ${results.length-finished.length} DNF` : ''}</span>
        </div>
      </div>

      ${results.length ? `
      <div class="rp-podium">${podium}</div>

      ${(flName || dotdName) ? `<div class="rp-awards">
        ${flName ? `<div class="rp-award fl"><span>⚡ FASTEST LAP</span><b>${esc(flName)}</b></div>` : ''}
        ${dotdName ? `<div class="rp-award dotd"><span>⭐ DRIVER OF THE DAY</span><b>${esc(dotdName)}</b></div>` : ''}
      </div>` : ''}

      <div class="section-head"><h2>CLASSIFICATION</h2></div>
      <div class="table-container">
        <table class="rp-table">
          <thead><tr><th>POS</th><th>DRIVER</th><th class="rp-hide">TEAM</th><th class="rp-hide">TIME</th><th>PTS</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`
      : `<p class="dp-empty" style="padding:2rem 0">No results have been entered for this race yet.</p>`}
    `;
}


// ── CALENDAR PAGE ────────────────────────────────────────
function renderCalendar() {
    const d = cls();
    const races = d.races || [];
    const el = document.getElementById('calendarContent');
    if (!el) return;
    const now = new Date();
    if (!races.length) { el.innerHTML = '<p style="color:var(--muted);padding:2rem">No calendar yet.</p>'; return; }
    el.innerHTML = races.map((race, idx) => {
        const isNext = race.date && new Date(race.date) >= now && !races.slice(0,idx).find(r=>r.date && new Date(r.date) >= now);
        const isPast = race.date && new Date(race.date) < now;
        const { pts } = calcStandings(races, d.drivers||[], d.teams||[]);
        const podium = isPast ? (race.results||[]).slice(0,3).map((res,i) => {
            const n = resultName(res, d.drivers);
            const col = colourFor(resolveDriver(res, d.drivers)?.team, d.teams);
            return `<div class="cp-row"><span class="cp-pos">${ordinal(i+1)}</span><span class="team-dot" style="background:${col}"></span><span class="cp-name">${n}</span></div>`;
        }).join('') : '';
        return `
          <div class="cal-card ${isNext?'next':''}" onclick="openRaceModal(${idx})">
            <div class="cal-card-head">
              <span class="cal-round">ROUND ${race.round||idx+1}</span>
              ${isNext ? '<span class="cal-next-badge">NEXT</span>' : ''}
            </div>
            <div class="cal-name">${race.name||'Race'}</div>
            <div class="cal-track">📍 ${race.track||''}</div>
            <div class="cal-date-lg">${fmtDate(race.date)}</div>
            ${podium ? `<div class="cal-podium">${podium}</div>` : ''}
            <div class="cal-card-foot"><span class="cal-fmt">${raceLength(race)}</span></div>
          </div>`;
    }).join('');
    el.style.display = 'grid';
    el.style.gridTemplateColumns = 'repeat(auto-fill, minmax(220px, 1fr))';
    el.style.gap = '1rem';
}

// ── TEAMS PAGE ───────────────────────────────────────────
function renderTeams() {
    const d = cls();
    const el = document.getElementById('teamsContent');
    if (!el) return;
    if (teamFocusId) { renderTeamProfile(teamFocusId); teamFocusId = null; return; }
    const { tpts } = calcStandings(d.races||[], d.drivers||[], d.teams||[]);
    if (!d.teams?.length) { el.innerHTML = '<p style="color:var(--muted);padding:2rem">No teams registered yet.</p>'; return; }
    el.innerHTML = `<div class="f1-teams-grid">` + d.teams.map(t => {
        const col = t.color || autoColor(t.name);
        const [r,g,b] = [parseInt(col.slice(1,3),16),parseInt(col.slice(3,5),16),parseInt(col.slice(5,7),16)];
        const teamDrivers = d.drivers?.filter(dr => dr.team === t.name) || [];
        return `
          <div class="f1-team-card" style="background:linear-gradient(135deg,rgba(${r},${g},${b},0.18) 0%,var(--surface) 60%);border-top:3px solid ${col}" onclick="navigate('teams',{teamFocusId:'${t.id||t.name}'})">
            <div class="ftc-top">
              <div>
                <div class="ftc-name">${t.name}</div>
                <div style="font-family:var(--font-display);color:var(--accent2);font-size:0.85rem;margin-top:0.2rem">${tpts[t.name]||0} PTS</div>
              </div>
              <div class="ftc-logo">${t.logo ? `<img class="ftc-logo-img" src="${esc(t.logo)}" alt="" loading="lazy" decoding="async">` : `<div style="width:48px;height:48px;border-radius:50%;background:${col};display:flex;align-items:center;justify-content:center;font-family:var(--font-display);color:#fff;font-size:1rem">${(t.name||'').charAt(0)}</div>`}</div>
            </div>
            <div class="ftc-drivers">
              ${teamDrivers.map(dr => `<div class="tdrv"><div class="tdrv-av-fb">${(dr.name||'').charAt(0)}</div><div><div><b>${dr.name}</b></div><div style="font-size:0.7rem;color:var(--muted)">#${dr.number||'?'}</div></div></div>`).join('')}
            </div>
          </div>`;
    }).join('') + '</div>';
}

function renderTeamProfile(id) {
    const d = cls();
    const t = d.teams?.find(x => (x.id||x.name) === id) || d.teams?.[0];
    if (!t) return;
    const el = document.getElementById('teamsContent');
    const { tpts } = calcStandings(d.races||[], d.drivers||[], d.teams||[]);
    const col = t.color || autoColor(t.name);
    const teamDrivers = d.drivers?.filter(dr => dr.team === t.name) || [];
    el.innerHTML = `
      <button class="btn btn-secondary" style="margin-bottom:1rem" onclick="teamFocusId=null;renderTeams()">← Back to Teams</button>
      <div style="background:linear-gradient(135deg,rgba(${parseInt(col.slice(1,3),16)},${parseInt(col.slice(3,5),16)},${parseInt(col.slice(5,7),16)},0.15) 0%,var(--surface) 100%);border:1px solid var(--line);border-top:4px solid ${col};border-radius:4px;padding:2rem;margin-bottom:1.5rem">
        <div style="font-family:var(--font-display);font-size:1.8rem;color:var(--white);letter-spacing:0.08em">${t.name}</div>
        <div style="font-family:var(--font-display);color:var(--accent2);font-size:1.1rem;margin-top:0.3rem">${tpts[t.name]||0} POINTS</div>
        ${t.description ? `<p style="color:var(--muted);margin-top:0.8rem;line-height:1.6">${t.description}</p>` : ''}
        <div style="margin-top:1.2rem">
          <div style="font-family:var(--font-display);font-size:0.72rem;letter-spacing:0.12em;color:var(--muted);margin-bottom:0.6rem">DRIVERS</div>
          <div style="display:flex;flex-wrap:wrap;gap:0.8rem">
            ${teamDrivers.map(dr => `<div style="background:var(--surface2);border-radius:4px;padding:0.6rem 1rem;cursor:pointer" onclick="navigate('drivers',{driverFocusId:'${dr.id||dr.name}'})">
              <div style="font-family:var(--font-ui);color:var(--white)">${dr.name}</div>
              <div style="font-size:0.72rem;color:var(--muted)">#${dr.number||'?'}</div>
            </div>`).join('')}
          </div>
        </div>
      </div>`;
}

// ── DRIVERS PAGE ─────────────────────────────────────────
// ── DRIVER VS DRIVER ─────────────────────────────────────
// Two drivers side by side, including the head-to-head: how many times each
// finished ahead of the other in races they both started.
let compareA = null, compareB = null, compareOpen = false;

function driverStats(drv, d) {
    const key = driverKey(drv);
    const { pts } = calcStandings(d.races || [], d.drivers || [], d.teams || []);
    let starts = 0, wins = 0, podiums = 0, dnfs = 0, finishSum = 0, finishes = 0, best = null;

    (d.races || []).forEach(r => {
        const idx = (r.results || []).findIndex(res => resultKey(res, d.drivers) === key);
        if (idx === -1) return;
        starts++;
        const res = r.results[idx];
        const raw = (typeof res === 'object' && res.pos != null) ? res.pos : idx + 1;
        if (String(raw).toUpperCase() === 'DNF') { dnfs++; return; }
        const pos = Number(raw);
        if (!Number.isFinite(pos)) return;
        finishes++; finishSum += pos;
        if (pos === 1) wins++;
        if (pos <= 3) podiums++;
        if (best == null || pos < best) best = pos;
    });

    return {
        starts, wins, podiums, dnfs, best,
        avg: finishes ? (finishSum / finishes) : null,
        points: pts[key] || 0,
    };
}

/** Races both drivers started: how many each finished ahead. */
function headToHead(a, b, d) {
    const ka = driverKey(a), kb = driverKey(b);
    let aWins = 0, bWins = 0;
    const order = res => {
        const raw = (typeof res === 'object' && res.pos != null) ? res.pos : null;
        if (raw == null) return null;
        if (String(raw).toUpperCase() === 'DNF') return Infinity;   // a finish beats a DNF
        const n = Number(raw);
        return Number.isFinite(n) ? n : null;
    };
    (d.races || []).forEach(r => {
        const ra = (r.results || []).find(res => resultKey(res, d.drivers) === ka);
        const rb = (r.results || []).find(res => resultKey(res, d.drivers) === kb);
        if (!ra || !rb) return;
        const ia = (r.results || []).indexOf(ra), ib = (r.results || []).indexOf(rb);
        const pa = order(ra) ?? ia + 1, pb = order(rb) ?? ib + 1;
        if (pa === pb) return;                      // both out, or unscored
        if (pa < pb) aWins++; else bWins++;
    });
    return { aWins, bWins };
}

function toggleCompare() {
    compareOpen = !compareOpen;
    renderDrivers();
}

function setCompare(which, id) {
    if (which === 'a') compareA = id || null; else compareB = id || null;
    renderDrivers();
}

function renderCompareBox(d) {
    const drivers = d.drivers || [];
    if (drivers.length < 2) return '';

    if (!compareOpen) {
        return `<button class="cmp-open" onclick="toggleCompare()">⇄ COMPARE TWO DRIVERS</button>`;
    }

    const opt = (sel) => drivers.map(x =>
        `<option value="${esc(driverKey(x))}"${driverKey(x) === sel ? ' selected' : ''}>${esc(x.name)}</option>`
    ).join('');

    const a = drivers.find(x => driverKey(x) === compareA) || drivers[0];
    const b = drivers.find(x => driverKey(x) === compareB) || drivers[1];

    let body = '';
    if (a && b && driverKey(a) === driverKey(b)) {
        body = '<p class="cmp-note">Pick two different drivers.</p>';
    } else if (a && b) {
        const sa = driverStats(a, d), sb = driverStats(b, d);
        const h2h = headToHead(a, b, d);
        const ca = safeHex(colourFor(a.team, d.teams), '#888888');
        const cb = safeHex(colourFor(b.team, d.teams), '#888888');
        const num = v => (v == null ? '—' : v);
        const avg = v => (v == null ? '—' : v.toFixed(1));

        const row = (label, va, vb, higherWins) => {
            const na = typeof va === 'number' ? va : null;
            const nb = typeof vb === 'number' ? vb : null;
            let aw = false, bw = false;
            if (na != null && nb != null && na !== nb) {
                aw = higherWins ? na > nb : na < nb;
                bw = !aw;
            }
            return `<div class="cmp-row">
                <span class="cmp-v${aw ? ' win' : ''}">${esc(String(va))}</span>
                <span class="cmp-l">${esc(label)}</span>
                <span class="cmp-v${bw ? ' win' : ''}">${esc(String(vb))}</span>
              </div>`;
        };

        body = `
          <div class="cmp-heads">
            <div class="cmp-head" style="--tc:${ca}">
              <span class="cmp-bar"></span>
              <strong>${esc(a.name)}</strong><span>${esc(a.team || '')}</span>
            </div>
            <div class="cmp-vs">V</div>
            <div class="cmp-head cmp-right" style="--tc:${cb}">
              <span class="cmp-bar"></span>
              <strong>${esc(b.name)}</strong><span>${esc(b.team || '')}</span>
            </div>
          </div>
          <div class="cmp-h2h">
            <span class="cmp-h2h-n${h2h.aWins > h2h.bWins ? ' win' : ''}">${h2h.aWins}</span>
            <span class="cmp-h2h-l">FINISHED AHEAD</span>
            <span class="cmp-h2h-n${h2h.bWins > h2h.aWins ? ' win' : ''}">${h2h.bWins}</span>
          </div>
          <div class="cmp-table">
            ${row('POINTS',   sa.points,  sb.points,  true)}
            ${row('RACES',    sa.starts,  sb.starts,  true)}
            ${row('WINS',     sa.wins,    sb.wins,    true)}
            ${row('PODIUMS',  sa.podiums, sb.podiums, true)}
            ${row('BEST FINISH', num(sa.best), num(sb.best), false)}
            ${row('AVERAGE FINISH', avg(sa.avg), avg(sb.avg), false)}
            ${row('DNFs',     sa.dnfs,    sb.dnfs,    false)}
          </div>`;
    }

    return `
      <div class="cmp-box">
        <div class="cmp-picks">
          <select aria-label="First driver" onchange="setCompare('a', this.value)">${opt(driverKey(a || {}))}</select>
          <span class="cmp-vs-sm">vs</span>
          <select aria-label="Second driver" onchange="setCompare('b', this.value)">${opt(driverKey(b || {}))}</select>
          <button class="cmp-close" onclick="toggleCompare()" aria-label="Close comparison">&times;</button>
        </div>
        ${body}
      </div>`;
}

function renderDrivers() {
    const d = cls();
    const el = document.getElementById('driversContent');
    if (!el) return;
    if (driverFocusId) { renderDriverProfile(driverFocusId); driverFocusId = null; return; }
    const { pts } = calcStandings(d.races||[], d.drivers||[], d.teams||[]);
    if (!d.drivers?.length) { el.innerHTML = '<p style="color:var(--muted);padding:2rem">No drivers registered yet.</p>'; return; }
    const compare = renderCompareBox(d);
    // Ranked by points so the grid reads as a championship order
    const ranked = [...d.drivers].sort((a,b) => (pts[driverKey(b)]||0) - (pts[driverKey(a)]||0));
    el.innerHTML = compare + `<div class="f1-drivers-grid">` + ranked.map((drv, i) => {
        const col = colourFor(drv.team, d.teams);
        const [r,g,b] = [parseInt(col.slice(1,3),16),parseInt(col.slice(3,5),16),parseInt(col.slice(5,7),16)];
        const names = (drv.name||'').trim().split(/\s+/);
        const first = names.slice(0,-1).join(' ');
        const last  = names[names.length-1] || drv.name || '';
        const initials = ((first[0]||'') + (last[0]||'')).toUpperCase();
        return `
          <div class="fdc" style="--tc:${col};--tc-rgb:${r},${g},${b}"
               onclick="navigate('drivers',{driverFocusId:'${esc(drv.id||drv.name)}'})">
            <div class="fdc-rank">${i+1}</div>
            <div class="fdc-num">${esc(drv.number||'')}</div>
            <div class="fdc-media">
              ${drv.photo
                ? `<img class="fdc-photo" src="${esc(drv.photo)}" alt="${esc(drv.name)}" loading="lazy" decoding="async">`
                : `<div class="fdc-initials">${esc(initials)}</div>`}
            </div>
            <div class="fdc-body">
              <div class="fdc-name">
                ${first ? `<span class="fdc-first">${esc(first)}</span>` : ''}
                <span class="fdc-last">${esc(last)}</span>
              </div>
              <div class="fdc-team"><span class="fdc-dot"></span>${esc(drv.team||'No team')}</div>
            </div>
            <div class="fdc-foot">
              <span class="fdc-nat">${esc(drv.nationality||'—')}</span>
              <span class="fdc-pts">${pts[driverKey(drv)]||0}<small>PTS</small></span>
            </div>
          </div>`;
    }).join('') + '</div>';
}

function renderDriverProfile(id) {
    const d = cls();
    const drv = d.drivers?.find(x => x.id === id)
             || d.drivers?.find(x => x.name === id)
             || d.drivers?.[0];
    if (!drv) return;
    const el = document.getElementById('driversContent');
    const { pts } = calcStandings(d.races||[], d.drivers||[], d.teams||[]);
    const col = colourFor(drv.team, d.teams);
    const guide = formGuide(drv, d.races||[], d.drivers);
    const key = driverKey(drv);
    const races = (d.races||[]).filter(r=>r.results?.some(res=>resultKey(res, d.drivers)===key));
    const wins = races.filter(r=>resultKey(r.results?.[0], d.drivers)===key).length;
    const pods = races.filter(r=>r.results?.slice(0,3).some(res=>resultKey(res, d.drivers)===key)).length;
    const [r,g,b] = [parseInt(col.slice(1,3),16),parseInt(col.slice(3,5),16),parseInt(col.slice(5,7),16)];
    const names = (drv.name||'').trim().split(/\s+/);
    const first = names.slice(0,-1).join(' ');
    const last  = names[names.length-1] || drv.name || '';
    const initials = ((first[0]||'') + (last[0]||'')).toUpperCase();

    // Championship position among all drivers
    const order = [...(d.drivers||[])].sort((a,b) => (pts[driverKey(b)]||0) - (pts[driverKey(a)]||0));
    const position = order.findIndex(x => driverKey(x) === key) + 1;
    const best = races.reduce((acc, rc) => {
        const i = (rc.results||[]).findIndex(res => resultKey(res, d.drivers) === key);
        return i >= 0 && (acc === null || i < acc) ? i : acc;
    }, null);

    el.innerHTML = `
      <button class="btn btn-secondary dp-back" onclick="driverFocusId=null;renderDrivers()">&larr; ALL DRIVERS</button>

      <div class="dp" style="--tc:${col};--tc-rgb:${r},${g},${b}">
        <div class="dp-hero">
          <div class="dp-bignum">${esc(drv.number||'')}</div>
          <div class="dp-media">
            ${drv.photo
              ? `<img class="dp-photo" src="${esc(drv.photo)}" alt="${esc(drv.name)}" decoding="async">`
              : `<div class="dp-initials">${esc(initials)}</div>`}
          </div>
          <div class="dp-ident">
            ${position ? `<div class="dp-pos">P${position} <small>IN CHAMPIONSHIP</small></div>` : ''}
            <h1 class="dp-name">
              ${first ? `<span class="dp-first">${esc(first)}</span>` : ''}
              <span class="dp-last">${esc(last)}</span>
            </h1>
            <div class="dp-meta">
              <span class="dp-team"><span class="dp-dot"></span>${esc(drv.team||'No team')}</span>
              ${drv.nationality ? `<span class="dp-nat">${esc(drv.nationality)}</span>` : ''}
              ${drv.number ? `<span class="dp-numtag">#${esc(drv.number)}</span>` : ''}
            </div>
          </div>
        </div>

        <div class="dp-stats">
          <div class="dp-stat hero"><label>POINTS</label><strong>${pts[driverKey(drv)]||0}</strong></div>
          <div class="dp-stat"><label>WINS</label><strong>${wins}</strong></div>
          <div class="dp-stat"><label>PODIUMS</label><strong>${pods}</strong></div>
          <div class="dp-stat"><label>STARTS</label><strong>${races.length}</strong></div>
          <div class="dp-stat"><label>BEST FINISH</label><strong>${best === null ? '—' : 'P'+(best+1)}</strong></div>
        </div>

        <div class="dp-panels">
          <div class="dp-panel">
            <h3>RECENT FORM</h3>
            ${guide && guide.length
              ? `<div class="form-guide">${formHTML(guide)}</div>`
              : `<p class="dp-empty">No races completed yet.</p>`}
          </div>
          ${drv.bio ? `
          <div class="dp-panel">
            <h3>ABOUT</h3>
            <p class="dp-bio">${esc(drv.bio).replace(/\n/g,'<br>')}</p>
          </div>` : ''}
        </div>

        ${races.length ? `
        <div class="dp-panel">
          <h3>RACE BY RACE</h3>
          <div class="dp-results">
            ${races.slice().reverse().map(rc => {
                const i = (rc.results||[]).findIndex(res => resultKey(res, d.drivers) === key);
                const p = i + 1;
                const medal = p===1 ? 'gold' : p===2 ? 'silver' : p===3 ? 'bronze' : '';
                return `<div class="dp-rrow">
                  <span class="dp-rpos ${medal}">P${p}</span>
                  <span class="dp-rname">${esc(rc.name||'Round '+(rc.round||''))}</span>
                  <span class="dp-rtrack">${esc(rc.track||'')}</span>
                </div>`;
            }).join('')}
          </div>
        </div>` : ''}
      </div>`;
}

// ── FANTASY PAGE ─────────────────────────────────────────
// ── FIRE VS ICE ──────────────────────────────────────────
// Season-long faction battle. Every team is assigned Fire or Ice in the
// admin; a team's championship points roll up to its side. Nothing is
// stored for this - it is derived from the same results as the standings.

// Off until the admin turns it on, so it can be set up ahead of a season
// without appearing on the site.
function fviEnabled() {
    // The battle spans both classes, so it's live if either says so.
    return ['gt3','gt4'].some(k =>
        ((rawData && rawData[k] && rawData[k].fireVsIce) || {}).enabled === true);
}

/** Hide the nav entry while the feature is switched off for this class. */
function syncFviNav() {
    const link = document.querySelector('.nav-link[data-page="fantasy"]');
    if (!link) return;
    const on = fviEnabled();
    const li = link.closest('li') || link;
    li.style.display = on ? '' : 'none';
}

const SIDES = {
    fire: { label: 'FIRE', icon: '🔥', color: '#FF5722' },
    ice:  { label: 'ICE',  icon: '❄️', color: '#29B6F6' },
};

function fireIceStandings() {
    // Fire and Ice are league-wide: each side is made up of GT3 *and* GT4
    // teams, and every point either of them scores counts for the faction.
    const out = {
        fire: { pts: 0, teams: [], byClass: { GT3: 0, GT4: 0 } },
        ice:  { pts: 0, teams: [], byClass: { GT3: 0, GT4: 0 } },
        unassigned: [],
    };

    ['gt3','gt4'].forEach(key => {
        const d = (rawData && rawData[key]) || {};
        const label = key.toUpperCase();
        const { tpts } = calcStandings(d.races||[], d.drivers||[], d.teams||[], pointsCfg(d));
        (d.teams||[]).forEach(t => {
            const pts = tpts[t.name] || 0;
            const entry = { ...t, pts, cls: label };
            const side = (t.side === 'fire' || t.side === 'ice') ? t.side : null;
            if (!side) { out.unassigned.push(entry); return; }
            out[side].pts += pts;
            out[side].byClass[label] += pts;
            out[side].teams.push(entry);
        });
    });

    out.fire.teams.sort((a,b) => b.pts - a.pts);
    out.ice.teams.sort((a,b) => b.pts - a.pts);
    return out;
}

/** Which side won a given round, for the round-by-round strip. */
function roundSwing(race, d) {
    const sideOf = {};
    (d.teams||[]).forEach(t => { if (t.side) sideOf[t.name] = t.side; });
    const teamOf = {};
    (d.drivers||[]).forEach(dr => { teamOf[dr.name] = dr.team; });

    const cfg = pointsCfg(d);
    const tally = { fire: 0, ice: 0 };
    (race.results||[]).forEach((res, i) => {
        const name = typeof res === 'string' ? res : res && res.driver;
        if (!name) return;
        const pos = (typeof res === 'object' && res.pos != null) ? res.pos : (i + 1);
        if (String(pos).toUpperCase() === 'DNF') return;
        let earn = cfg.table[Number(pos) - 1] || 0;
        if (race.fastestLap === name) earn += cfg.fastestLap;
        if (race.dotdWinner === name) earn += cfg.dotd;
        const side = sideOf[teamOf[name]];
        if (side) tally[side] += earn;
    });
    return tally;
}

function renderFantasy() {
    const el = document.getElementById('fantasyContent');
    if (!el) return;

    if (!fviEnabled()) {
        el.innerHTML = `<div class="fvi-empty">
            <p><b>Coming next season.</b><br>
               Fire Vs Ice launches with the new season — GT3 and GT4 teams split
               across two sides, with every point they score counting towards
               their faction.</p>
          </div>`;
        return;
    }

    const s = fireIceStandings();
    const assigned = s.fire.teams.length + s.ice.teams.length;
    if (!assigned) {
        el.innerHTML = `<div class="fvi-empty">
            <p>No teams have been assigned a side yet. Set each GT3 and GT4 team to
               Fire or Ice in the admin and the battle starts here.</p>
          </div>`;
        return;
    }

    const total = s.fire.pts + s.ice.pts;
    const firePct = total ? (s.fire.pts / total) * 100 : 50;
    const lead = Math.abs(s.fire.pts - s.ice.pts);
    const leader = s.fire.pts === s.ice.pts ? null : (s.fire.pts > s.ice.pts ? 'fire' : 'ice');

    // Red = GT3, blue = GT4, matching how the sides are announced.
    const clsDot = c => `<span class="fvi-cls ${c.toLowerCase()}" title="${c}"></span>`;

    const sideColumn = key => {
        const side = SIDES[key];
        const data = s[key];
        const gt3 = data.teams.filter(t => t.cls === 'GT3');
        const gt4 = data.teams.filter(t => t.cls === 'GT4');
        const group = (label, list) => !list.length ? '' : `
            <div class="fvi-group">${label} <span>${list.length}</span></div>
            ${list.map(t => `
              <div class="fvi-team">
                ${clsDot(t.cls)}
                <span class="fvi-team-name">${esc(t.name)}</span>
                <span class="fvi-team-pts">${t.pts}</span>
              </div>`).join('')}`;
        return `
          <div class="fvi-col ${key}">
            <div class="fvi-col-head">
              <span class="fvi-icon">${side.icon}</span>
              <span class="fvi-name">${side.label}</span>
              <span class="fvi-col-pts">${data.pts}</span>
            </div>
            <div class="fvi-split">
              <span>GT3 <b>${data.byClass.GT3}</b></span>
              <span>GT4 <b>${data.byClass.GT4}</b></span>
            </div>
            ${data.teams.length
              ? group('GT3', gt3) + group('GT4', gt4)
              : `<p class="fvi-none">No teams on this side yet.</p>`}
          </div>`;
    };

    // Rounds from both classes, newest first.
    const rounds = [];
    ['gt3','gt4'].forEach(k => {
        const d = (rawData && rawData[k]) || {};
        (d.races||[]).filter(r => (r.results||[]).length).forEach(r => {
            rounds.push({ race: r, cls: k.toUpperCase(), sw: roundSwing(r, d) });
        });
    });
    rounds.sort((a,b) => (a.race.round||0) - (b.race.round||0));

    const strip = rounds.map(({race, cls: c, sw}) => {
        const won = sw.fire === sw.ice ? 'draw' : (sw.fire > sw.ice ? 'fire' : 'ice');
        return `<div class="fvi-round ${won}" title="${esc(race.name||'')} (${c}): Fire ${sw.fire} – ${sw.ice} Ice">
            <span class="fvi-round-no">${c} R${race.round || '?'}</span>
            <span class="fvi-round-score">${sw.fire}–${sw.ice}</span>
          </div>`;
    }).join('');

    el.innerHTML = `
      <div class="fvi-board">
        <div class="fvi-score">
          <div class="fvi-score-side fire ${leader==='fire'?'winning':''}">
            <span class="fvi-icon">🔥</span>
            <span class="fvi-score-val">${s.fire.pts}</span>
            <span class="fvi-score-label">FIRE</span>
          </div>
          <div class="fvi-vs">VS</div>
          <div class="fvi-score-side ice ${leader==='ice'?'winning':''}">
            <span class="fvi-icon">❄️</span>
            <span class="fvi-score-val">${s.ice.pts}</span>
            <span class="fvi-score-label">ICE</span>
          </div>
        </div>
        <div class="fvi-bar">
          <div class="fvi-bar-fire" style="width:${firePct.toFixed(1)}%"></div>
          <div class="fvi-bar-ice" style="width:${(100-firePct).toFixed(1)}%"></div>
        </div>
        <p class="fvi-verdict">${
          !total ? 'No points scored yet — all square.'
          : leader === null ? 'Dead level.'
          : `<b class="${leader}">${SIDES[leader].label}</b> leads by <b>${lead}</b> point${lead===1?'':'s'}.`
        }</p>
        <p class="fvi-note">GT3 and GT4 points both count. Whichever side is ahead at
           the end of the season takes it.</p>
      </div>

      ${rounds.length ? `
      <div class="section-head"><h2>ROUND BY ROUND</h2></div>
      <div class="fvi-rounds">${strip}</div>` : ''}

      <div class="section-head"><h2>THE SIDES</h2></div>
      <div class="fvi-cols">
        ${sideColumn('fire')}
        ${sideColumn('ice')}
      </div>

      ${s.unassigned.length ? `
      <div class="section-head"><h2>UNASSIGNED</h2></div>
      <div class="fvi-unassigned">
        <p>These teams have no side yet, so their points count for neither:</p>
        ${s.unassigned.map(t => `<span class="fvi-chip">${clsDot(t.cls)}${esc(t.name)} · ${t.pts}</span>`).join('')}
      </div>` : ''}
    `;
}

async function loadDotd() {
    try {
        const r = await fetch(`${API_BASE}/api/dotd?class=${currentClass.toLowerCase()}`,
                              { cache: 'no-store' });
        const body = await r.json();
        if (body && body.ok) dotdData = body;
    } catch (e) {
        // Leave dotdData null — the page explains itself rather than
        // silently showing a tally of zero.
    }
    dotdLoaded = true;
}

/** Key a race the same way the Worker does, so tallies line up. */
function dotdRaceKey(race) { return String(race.round ?? race.name ?? ''); }

function renderDOTD() {
    const d = cls();
    const el = document.getElementById('dotdContent');
    if (!el) return;

    const races = (d.races || []).filter(r => r.results?.length).slice().reverse();
    if (!races.length) {
        el.innerHTML = '<p style="color:var(--muted);padding:2rem">No completed races yet.</p>';
        return;
    }

    if (!dotdLoaded) {
        el.innerHTML = '<p style="color:var(--muted);padding:2rem">Loading votes…</p>';
        loadDotd().then(() => { if (currentPage === 'dotd') renderDOTD(); });
        return;
    }

    const offline = !dotdData;

    el.innerHTML = (offline
        ? `<div class="dotd-offline">Voting is offline at the moment — the results below
             are still correct, but no new votes can be counted.</div>`
        : '') + races.map(race => {
        const key     = dotdRaceKey(race);
        const votes   = (dotdData && dotdData.races && dotdData.races[key]) || {};
        const myVote  = (dotdData && dotdData.myVotes && dotdData.myVotes[key]) || null;
        const total   = Object.values(votes).reduce((a, b) => a + b, 0);
        const winner  = race.dotdWinner ? resultName(race.dotdWinner, d.drivers) : null;

        // Once a vote is in, show the standings. Before that, keep them hidden
        // so the first few voters don't anchor everyone else.
        const reveal = Boolean(myVote) || Boolean(winner);
        const names  = (race.results || []).map(res => resultName(res, d.drivers)).filter(Boolean);

        return `
          <div class="dotd-race-block">
            <div class="dotd-race-header">
              <h2>${esc(race.name || '')} — Round ${esc(String(race.round || '?'))}</h2>
              <span class="dotd-date">${esc(fmtDate(race.date))}</span>
            </div>
            <div class="dotd-hint">${
                offline ? 'Voting unavailable'
              : myVote ? 'Thanks for voting — one vote each.'
              : 'Vote for your Driver of the Day'}</div>
            <div class="dotd-grid">
              ${names.map(name => {
                  const drv = (d.drivers || []).find(x => x.name === name);
                  const col = safeHex(colourFor(drv?.team, d.teams), '#888888');
                  const n   = votes[name] || 0;
                  const pct = total ? Math.round(n / total * 100) : 0;
                  const mine = myVote === name;
                  const won  = winner === name;
                  return `<div class="dotd-card${mine ? ' dotd-voted' : ''}${won ? ' dotd-winner' : ''}"
                               style="${mine ? `--tc:${col}` : ''}"
                               ${offline || myVote ? '' : `onclick="voteDOTD('${esc(name).replace(/'/g, "\\'")}')"`}
                               ${offline || myVote ? '' : 'role="button" tabindex="0"'}>
                    <div class="dotd-name">${esc(name)}</div>
                    <div class="dotd-team">${esc(drv?.team || '')}</div>
                    ${reveal ? `<div class="dotd-bar-wrap"><div class="dotd-bar" style="width:${pct}%;background:${col}"></div></div>
                      <div class="dotd-pct">${pct}%${n ? ` · ${n}` : ''}</div>` : ''}
                    ${mine ? '<div class="dotd-check">✓ YOUR VOTE</div>' : ''}
                    ${won && !mine ? '<div class="dotd-check">★ DRIVER OF THE DAY</div>' : ''}
                  </div>`;
              }).join('')}
            </div>
            ${reveal ? `<div class="dotd-total">${total} vote${total !== 1 ? 's' : ''}</div>` : ''}
          </div>`;
    }).join('');
}

async function voteDOTD(name) {
    if (dotdBusy) return;
    const d = cls();
    const race = (d.races || []).filter(r => r.results?.length).slice().reverse()
        .find(r => (r.results || []).some(res => resultName(res, d.drivers) === name));
    if (!race) return;

    dotdBusy = true;
    try {
        const r = await fetch(`${API_BASE}/api/dotd`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                class: currentClass.toLowerCase(),
                race: dotdRaceKey(race),
                driver: name,
            }),
        });
        const body = await r.json();
        if (body && body.ok) {
            // The response carries the fresh tally and whatever this person
            // had already voted for, so fold it straight in.
            dotdData = dotdData || { races: {}, myVotes: {} };
            dotdData.races = dotdData.races || {};
            dotdData.myVotes = dotdData.myVotes || {};
            dotdData.races[dotdRaceKey(race)] = body.votes || {};
            if (body.myVote) dotdData.myVotes[dotdRaceKey(race)] = body.myVote;
        } else if (body && body.error) {
            console.warn('DOTD vote rejected:', body.error);
        }
    } catch (e) {
        console.error('DOTD vote failed', e);
    }
    dotdBusy = false;
    renderDOTD();
}

// ── TRADING CARDS ────────────────────────────────────────
// The set is shown here; collecting happens in Discord, which is also the
// login — the site has no accounts and this did not seem worth adding them
// for. These rarity rules mirror worker/src/cards.js exactly; if one changes
// the other has to.
const CARD_TIERS = {
    legendary: { label: 'LEGENDARY', colour: '#FFC400' },
    epic:      { label: 'EPIC',      colour: '#9C27B0' },
    rare:      { label: 'RARE',      colour: '#2196F3' },
    uncommon:  { label: 'UNCOMMON',  colour: '#4CAF50' },
    common:    { label: 'COMMON',    colour: '#9E9E9E' },
};
const TIER_ORDER = ['legendary', 'epic', 'rare', 'uncommon', 'common'];

function cardSetFor(d) {
    const drivers = d.drivers || [];
    const { pts } = calcStandings(d.races || [], drivers, d.teams || []);

    const extra = {};
    drivers.forEach(x => { extra[driverKey(x)] = { wins: 0, podiums: 0, starts: 0 }; });
    (d.races || []).forEach(r => (r.results || []).forEach((res, i) => {
        const k = resultKey(res, drivers);
        const e = extra[k];
        if (!e) return;
        e.starts++;
        const raw = (typeof res === 'object' && res.pos != null) ? res.pos : i + 1;
        if (String(raw).toUpperCase() === 'DNF') return;
        const pos = Number(raw);
        if (!Number.isFinite(pos)) return;
        if (pos === 1) e.wins++;
        if (pos <= 3) e.podiums++;
    }));

    const ranked = drivers.slice()
        .sort((a, b) => (pts[driverKey(b)] || 0) - (pts[driverKey(a)] || 0));

    return ranked.map((drv, i) => {
        const k = driverKey(drv);
        const e = extra[k] || { wins: 0, podiums: 0, starts: 0 };
        const p = pts[k] || 0;
        let rarity;
        if (i === 0 && p > 0)     rarity = 'legendary';
        else if (i <= 2 && p > 0) rarity = 'epic';
        else if (e.wins > 0)      rarity = 'epic';
        else if (e.podiums > 0)   rarity = 'rare';
        else if (p > 0)           rarity = 'uncommon';
        else                      rarity = 'common';
        return { drv, rarity, position: i + 1, points: p, ...e };
    });
}

function renderCards() {
    const d = cls();
    const el = document.getElementById('cardsContent');
    if (!el) return;

    const set = cardSetFor(d);
    if (!set.length) {
        el.innerHTML = '<p style="color:var(--muted);padding:2rem">No drivers in this class yet.</p>';
        return;
    }

    const counts = {};
    set.forEach(c => { counts[c.rarity] = (counts[c.rarity] || 0) + 1; });

    const key = `<div class="tc-key">` + TIER_ORDER.filter(t => counts[t]).map(t =>
        `<span class="tc-chip" style="--tc:${CARD_TIERS[t].colour}">
           <i></i>${CARD_TIERS[t].label} <b>${counts[t]}</b></span>`).join('') + `</div>`;

    const how = `<div class="tc-how">
        <strong>${set.length} cards in the ${esc(currentClass)} set.</strong>
        Collect them in Discord — <code>/cards pack</code> for a free pack every 8 hours,
        <code>/cards collection</code> to see yours.
        Rarity comes from the season: the championship leader is Legendary, the
        championship podium and race winners are Epic, a race podium is Rare.
      </div>`;

    const grid = TIER_ORDER.filter(t => counts[t]).map(t => `
        <h2 class="tc-head" style="--tc:${CARD_TIERS[t].colour}">
          ${CARD_TIERS[t].label}<span>${counts[t]}</span>
        </h2>
        <div class="tc-grid">${
          set.filter(c => c.rarity === t).map(c => cardHTML(c, d)).join('')
        }</div>`).join('');

    el.innerHTML = how + key + grid;
}

function cardHTML(c, d) {
    const drv = c.drv;
    const tier = CARD_TIERS[c.rarity];
    const team = safeHex(colourFor(drv.team, d.teams), '#888888');
    const names = String(drv.name || '').trim().split(/\s+/);
    const initials = ((names[0] || '')[0] || '') + ((names[names.length - 1] || '')[0] || '');
    return `
      <div class="tc" style="--tc:${tier.colour};--team:${team}"
           onclick="navigate('drivers',{driverFocusId:'${esc(driverKey(drv))}'})"
           role="button" tabindex="0"
           onkeydown="if(event.key==='Enter')navigate('drivers',{driverFocusId:'${esc(driverKey(drv))}'})">
        <div class="tc-rar">${tier.label}</div>
        <div class="tc-media">
          ${(drv.cardImage || drv.photo)
            ? `<img src="${esc(drv.cardImage || drv.photo)}" alt="${esc(drv.name)}" loading="lazy" decoding="async">`
            : `<span class="tc-initials">${esc(initials.toUpperCase())}</span>`}
          ${drv.number ? `<span class="tc-num">${esc(String(drv.number))}</span>` : ''}
        </div>
        <div class="tc-name">${esc(drv.name)}</div>
        <div class="tc-team">${esc(drv.team || '—')}</div>
        <div class="tc-stats">
          <span><b>P${c.position}</b>POS</span>
          <span><b>${c.points}</b>PTS</span>
          <span><b>${c.wins}</b>WINS</span>
          <span><b>${c.podiums}</b>POD</span>
        </div>
      </div>`;
}

// ── STEWARDS' DECISIONS ──────────────────────────────────
// Hidden until there is something to show, so the nav doesn't carry an
// empty page around for the first half of a season.
function syncStewardsNav() {
    const li = document.getElementById('navStewards');
    if (!li) return;
    const any = ['gt3','gt4'].some(k => ((rawData && rawData[k] && rawData[k].stewards) || []).length);
    li.style.display = any ? '' : 'none';
}

/** Harsher penalties read as more serious at a glance. */
function penaltyClass(p) {
    const t = String(p || '').toLowerCase();
    if (/disqualif/.test(t))                  return 'dq';
    if (/no further action/.test(t))          return 'nfa';
    if (/warning/.test(t))                    return 'warn';
    return 'pen';
}

function renderStewards() {
    const d = cls();
    const el = document.getElementById('stewardsContent');
    if (!el) return;

    const list = (d.stewards || []).slice();
    if (!list.length) {
        el.innerHTML = `<div class="news-empty">
            <div class="news-empty-icon">⚖️</div>
            <p>No decisions this season.</p>
            <p class="lv-note">Clean racing, or a quiet stewards' room.</p>
          </div>`;
        return;
    }

    // Newest round first, and newest decision first inside a round.
    list.sort((a, b) => (Number(b.round) || 0) - (Number(a.round) || 0) || (b.at || 0) - (a.at || 0));

    const races = d.races || [];
    const raceName = rnd => (races.find(r => String(r.round) === String(rnd)) || {}).name || '';

    let lastRound = null;
    el.innerHTML = `<div class="stw-list">` + list.map(dec => {
        const drv = (d.drivers || []).find(x => (x.id || x.name) === dec.driverId);
        const name = drv ? drv.name : (dec.driverId || 'Unknown');
        const col = safeHex(colourFor(drv?.team, d.teams), '#888888');
        const head = String(dec.round) !== String(lastRound)
            ? `<div class="stw-round">ROUND ${esc(String(dec.round || '?'))}${
                 raceName(dec.round) ? ` — ${esc(raceName(dec.round))}` : ''}</div>` : '';
        lastRound = dec.round;
        return head + `
          <div class="stw-card">
            <span class="stw-bar" style="background:${col}"></span>
            <div class="stw-body">
              <div class="stw-top">
                <span class="stw-driver">${esc(name)}</span>
                <span class="stw-pen stw-${penaltyClass(dec.penalty)}">${esc(dec.penalty || '')}</span>
              </div>
              <div class="stw-reason">${esc(dec.reason || '')}</div>
              ${dec.incident ? `<div class="stw-inc">${esc(dec.incident)}</div>` : ''}
            </div>
          </div>`;
    }).join('') + `</div>`;
}

// ── LIVE TIMING ───────────────────────────────────────────
// Race control (admin) pushes the session to the Worker; this reads it back.
// The nav entry and the home banner only appear while a session is open, so
// the page is invisible the rest of the season.

const LIVE_LABELS = {
    formation: 'FORMATION LAP',
    green:     'GREEN FLAG',
    sc:        'SAFETY CAR',
    vsc:       'VIRTUAL SAFETY CAR',
    red:       'RED FLAG',
    chequered: 'CHEQUERED FLAG',
    finished:  'RACE FINISHED',
};

// Quali has no formation lap and no safety car; the track is simply open,
// then it isn't.
const QUALI_LABELS = {
    green:     'TRACK OPEN',
    red:       'SESSION STOPPED',
    chequered: 'SESSION OVER',
    finished:  'QUALIFYING COMPLETE',
};

function liveIsQuali() { return liveState && liveState.mode === 'quali'; }

function liveLabel(status) {
    return (liveIsQuali() ? QUALI_LABELS[status] : LIVE_LABELS[status]) || '';
}

/** "1:42.391", "42.391" or "1:42" → ms. Anything else → null. */
function lapMs(v) {
    const m = /^(?:(\d+):)?(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(String(v || '').trim());
    if (!m) return null;
    return (+(m[1] || 0)) * 60000 + (+m[2]) * 1000 + (+((m[3] || '0').padEnd(3, '0')));
}

/** Fastest lap set so far, for the gap-to-pole column. */
function poleMs(rows) {
    const t = (rows || []).map(r => lapMs(r.lap)).filter(v => v != null);
    return t.length ? Math.min(...t) : null;
}

function liveNow() { return Date.now() + liveSkew; }

function liveIsOn() {
    return Boolean(liveState && liveState.status && liveState.status !== 'idle');
}

/** Hide the nav entry unless a session is actually running. */
function syncLiveNav() {
    const link = document.querySelector('.nav-link[data-page="live"]');
    if (!link) return;
    const li = link.closest('li') || link;
    li.style.display = liveIsOn() ? '' : 'none';
}

function liveClock(ms) {
    if (ms == null || isNaN(ms)) return '';
    const neg = ms < 0;
    const t = Math.floor(Math.abs(ms) / 1000);
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    const p = n => String(n).padStart(2, '0');
    return (neg ? '-' : '') + (h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`);
}

/** Time left in the race, or the full duration before lights out. */
function liveRaceClock() {
    const s = liveState;
    if (!s.durationMin || !s.lightsOut) return '';
    if (liveNow() < s.lightsOut) return liveClock(s.durationMin * 60000);
    return liveClock(Math.max(0, s.lightsOut + s.durationMin * 60000 - liveNow()));
}

/** A strip on the home page that doubles as the way in to the live page. */
function renderLiveBanner() {
    const el = document.getElementById('liveBanner');
    if (!el) return;
    if (!liveIsOn()) { el.innerHTML = ''; return; }
    const s = liveState;
    const label = liveLabel(s.status);
    el.innerHTML = `
      <div class="lv-banner lv-${esc(s.status)}" data-page="live">
        <span class="lv-dot" data-page="live"></span>
        <span class="lv-bl" data-page="live">${liveIsQuali() ? 'QUALIFYING' : 'LIVE NOW'}</span>
        <span class="lv-bn" data-page="live">${esc(s.raceName || 'Race in progress')}</span>
        <span class="lv-bs" data-page="live">${esc(label)}</span>
        <span class="lv-bgo" data-page="live">WATCH TIMING &rarr;</span>
      </div>`;
}

function renderLive() {
    const el = document.getElementById('liveContent');
    if (!el) return;

    // The clock ticks every second. Rewriting the whole page that often made
    // the tower flicker and killed text selection, so everything except the
    // clock is rebuilt only when the session state has actually changed.
    const sig = liveIsOn()
        ? JSON.stringify([liveState.status, liveState.mode, liveState.round, liveState.raceName,
                          liveState.track, liveState.message, liveState.running])
        : 'idle';
    if (sig === liveSig) { updateLiveClock(); return; }
    liveSig = sig;

    if (!liveIsOn()) {
        el.innerHTML = `
          <div class="news-empty">
            <div class="news-empty-icon">🏁</div>
            <p>No session running right now.</p>
            <p class="lv-note">This page comes alive on race day, the moment race
               control opens the session.</p>
          </div>`;
        return;
    }

    const s     = liveState;
    const quali = liveIsQuali();
    const label = liveLabel(s.status);
    const pre   = Boolean(s.lightsOut) && liveNow() < s.lightsOut;
    const rows  = Array.isArray(s.running) ? s.running : [];
    const pole  = quali ? poleMs(rows) : null;

    let pos = 0;
    const tower = rows.map(r => {
        if (!r.out) pos++;
        const cls = r.out ? 'out' : (pos <= 3 ? 'p' + pos : '');
        const num = String(r.number || '').trim();
        let timeCells;
        if (quali) {
            const t = lapMs(r.lap);
            const delta = (t == null || pole == null) ? ''
                : (t === pole ? 'POLE' : '+' + ((t - pole) / 1000).toFixed(3));
            timeCells = `<span class="lv-lap">${esc(r.lap || '')}</span>
                         <span class="lv-gap${t === pole && t != null ? ' pole' : ''}">${esc(delta)}</span>`;
        } else {
            timeCells = `<span class="lv-gap">${esc(r.gap || '')}</span>`;
        }
        return `
          <div class="lv-row ${cls}">
            <span class="lv-pos">${r.out ? 'OUT' : pos}</span>
            <span class="lv-bar" style="background:${esc(safeHex(r.colour, '#888888'))}"></span>
            <span class="lv-num">${num ? '#' + esc(num) : ''}</span>
            <span class="lv-name">${esc(r.name || '')}</span>
            <span class="lv-team">${esc(r.team || '')}</span>
            ${timeCells}
          </div>`;
    }).join('');

    const head = `
      <div class="lv-head lv-${esc(s.status)}">
        <div class="lv-hl">
          <span class="lv-dot"></span>
          <span class="lv-round">ROUND ${esc(String(s.round ?? '?'))}</span>
          ${quali ? '<span class="lv-sess">QUALIFYING</span>' : ''}
          <span class="lv-race">${esc(s.raceName || '')}</span>
          ${s.track ? `<span class="lv-track">📍 ${esc(s.track)}</span>` : ''}
        </div>
        <div class="lv-hr">
          ${label ? `<span class="lv-flag">${esc(label)}</span>` : ''}
          ${pre
            ? `<span class="lv-clock">${quali ? 'STARTS IN' : 'LIGHTS OUT IN'} ${liveClock(s.lightsOut - liveNow())}</span>`
            : (liveRaceClock() ? `<span class="lv-clock">${liveRaceClock()}</span>` : '')}
        </div>
      </div>`;

    const msg = (s.message || '').trim()
        ? `<div class="lv-msg"><span>RACE CONTROL</span>${esc(s.message.trim())}</div>`
        : '';

    el.innerHTML = head + msg + (rows.length
        ? `<div class="lv-tower${quali ? ' is-quali' : ''}">
             <div class="lv-row lv-thead">
               <span class="lv-pos">POS</span><span class="lv-bar"></span>
               <span class="lv-num">NO</span><span class="lv-name">DRIVER</span>
               <span class="lv-team">TEAM</span>
               ${quali ? '<span class="lv-lap">LAP</span><span class="lv-gap">GAP TO POLE</span>'
                       : '<span class="lv-gap">GAP</span>'}
             </div>
             ${tower}
           </div>`
        : `<p class="lv-note">Race control hasn't published a running order yet.</p>`);
}

/** The one bit that really does change every second. */
function updateLiveClock() {
    const el = document.querySelector('#liveContent .lv-clock');
    if (!el) return;
    const s = liveState;
    const pre = Boolean(s.lightsOut) && liveNow() < s.lightsOut;
    el.textContent = pre
        ? `${liveIsQuali() ? 'STARTS IN' : 'LIGHTS OUT IN'} ${liveClock(s.lightsOut - liveNow())}`
        : liveRaceClock();
}

/** Repaints the live clocks without touching the rest of the page. */
function tickLive() {
    if (!liveIsOn()) return;
    if (currentPage === 'live') renderLive();
}

async function pollLive() {
    const wasOn = liveIsOn();
    try {
        const r = await fetch(`${API_BASE}/api/live`, { cache: 'no-store' });
        const body = await r.json();
        if (body && body.ok) {
            if (body.now) liveSkew = body.now - Date.now();
            liveState = body;
        }
    } catch (e) {
        // Keep the last good state rather than blanking a live page.
    }

    try {
        syncLiveNav();
        renderLiveBanner();
        if (currentPage === 'live') renderLive();
        // Someone sitting on the live page when the session ends shouldn't be
        // stranded on a page that has just left the nav.
        if (wasOn && !liveIsOn() && currentPage === 'live') navigate('home');
    } catch (e) { console.error('live render failed', e); }

    // Hard while a session is open, barely at all otherwise — a tab left
    // open for days would otherwise eat the Worker's request budget.
    clearTimeout(livePollTimer);
    livePollTimer = setTimeout(pollLive, liveIsOn() ? 3000 : 60000);
}

// ── MODAL ─────────────────────────────────────────────────
function closeModal() {
    document.getElementById('modal')?.classList.add('hidden');
}

// ── LIGHTS OUT INTRO ──────────────────────────────────────
function killIntro(el) {
    if (!el) return;
    el.classList.add('hidden');
    el.style.display = 'none';
}

function lightsOut() {
    const el = document.getElementById('lightsOut');
    if (!el) return;

    // Failsafe: no matter what happens below (JS error, storage throw,
    // slow network), the overlay is gone after 3s. It must never be able
    // to sit on top of the page forever.
    setTimeout(() => killIntro(el), 3000);

    let alreadyPlayed = false;
    try { alreadyPlayed = !!sessionStorage.getItem('fge_lit'); } catch(e) {}

    // Intro already played this session (eg. a refresh) — drop the overlay now.
    if (alreadyPlayed) { killIntro(el); return; }

    try { sessionStorage.setItem('fge_lit','1'); } catch(e) {}
    setTimeout(() => {
        el.classList.add('hidden');
        setTimeout(() => { el.style.display = 'none'; }, 400);
    }, 1400);
}

// ── PWA INSTALL ───────────────────────────────────────────
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredPrompt = e;
    const banner = document.getElementById('installBanner');
    if (banner) banner.style.display = 'flex';
});

function installPWA() {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    deferredPrompt.userChoice.then(() => {
        deferredPrompt = null;
        const banner = document.getElementById('installBanner');
        if (banner) banner.style.display = 'none';
    });
}

function dismissInstall() {
    const banner = document.getElementById('installBanner');
    if (banner) banner.style.display = 'none';
    try { localStorage.setItem('fge_install_dismissed', '1'); } catch(e) {}
}

// ── COUNTDOWN TICK ────────────────────────────────────────
function startCountdownTick() {
    setInterval(() => {
        try { tickLive(); } catch(e) {}
        if (currentPage !== 'home') return;
        // Re-render through renderCountdown so the tick and the initial paint
        // can never drift apart in markup or race selection.
        renderCountdown(cls());
    }, 1000);
}

// ── INIT ──────────────────────────────────────────────────
async function init() {
    lightsOut();

    // Full-screen nav overlay toggle
    document.getElementById('navToggle')?.addEventListener('click', () => {
        const overlay = document.getElementById('navOverlay');
        const toggle = document.getElementById('navToggle');
        const isOpen = overlay?.classList.contains('open');
        if (isOpen) { closeNav(); } else { overlay?.classList.add('open'); toggle?.classList.add('open'); }
    });

    // Modal backdrop close
    document.getElementById('modal')?.addEventListener('click', e => {
        if (e.target.id === 'modal') closeModal();
    });

    // Standings DRIVERS/TEAMS tabs — these had no listener at all
    document.querySelectorAll('.tab-btn[data-tab]').forEach(btn => {
        btn.addEventListener('click', () => {
            standingsTab = btn.getAttribute('data-tab');
            document.querySelectorAll('.tab-btn[data-tab]').forEach(b =>
                b.classList.toggle('active', b === btn));
            renderStandings();
        });
    });

    // data-page links (banners, "view full standings", etc.)
    document.addEventListener('click', e => {
        const t = e.target.closest('[data-page]');
        if (!t || t.classList.contains('nav-link')) return;
        e.preventDefault();
        navigate(t.getAttribute('data-page'));
    });

    // Init class switcher UI — apply the saved class colour on first paint
    document.body.classList.toggle('gt4-mode', currentClass === 'GT4');
    applyThemeColor(currentClass);
    document.getElementById('csGT3')?.classList.toggle('active', currentClass === 'GT3');
    document.getElementById('csGT4')?.classList.toggle('active', currentClass === 'GT4');

    // Hide install banner if dismissed
    try {
        if (localStorage.getItem('fge_install_dismissed')) {
            const b = document.getElementById('installBanner');
            if (b) b.style.display = 'none';
        }
    } catch(e) {}

    // Check PWA already installed. Guarded: everything below depends on init
    // getting this far, and this is the sort of line that throws in an
    // embedded or stripped-down webview.
    try {
        if (window.matchMedia?.('(display-mode: standalone)')?.matches) {
            const b = document.getElementById('installBanner');
            if (b) b.style.display = 'none';
        }
    } catch(e) {}

    // A failed fetch must not stop the page from rendering
    try { await fetchData(); } catch(e) { console.error('fetchData failed', e); }
    try { syncFviNav(); } catch(e) {}
    try { syncStewardsNav(); } catch(e) {}
    try { navigate('home'); } catch(e) { console.error('navigate failed', e); }
    try { startCountdownTick(); } catch(e) {}
    try { pollLive(); } catch(e) {}

    // Register service worker
    if ('serviceWorker' in navigator) {
        // updateViaCache:'none' stops the browser serving sw.js itself from
        // its HTTP cache, which is how a worker gets stuck for days. Combined
        // with an explicit update() check, a deploy reaches people promptly.
        navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
            .then(reg => {
                reg.update().catch(()=>{});
                // When a new worker takes over, reload once so the page isn't
                // left running a half-old set of assets.
                let reloaded = false;
                navigator.serviceWorker.addEventListener('controllerchange', () => {
                    if (reloaded) return;
                    reloaded = true;
                    window.location.reload();
                });
            })
            .catch(()=>{});
    }
}

document.addEventListener('DOMContentLoaded', init);
