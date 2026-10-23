/* ===== FGE — FORTNITE GLOBAL ENDURANCE — app.js ===== */
'use strict';

// ── CONFIG ──────────────────────────────────────────────
const BIN_ID      = '6ada83fdac6210605a4a3a74';
const ACCESS_KEY  = '$2a$10$G0A4V5Q7TOSTCAm/D4oskenfMyJjU.5SXbAVK5kdCNIkmelTS/.be';
const MASTER_KEY  = '$2a$10$wTYTzJ9.QfJDLLb52xi7hO4ILuoejGhm9MIlOYUReOH/t3JpyrRPS';
const ADMIN_PASS  = 'YOUR_ADMIN_PASS';
const BIN_URL     = `https://api.jsonbin.io/v3/b/${BIN_ID}`;

// ── STATE ────────────────────────────────────────────────
let rawData       = null;           // full JSONBin record { gt3:{…}, gt4:{…} }
let currentClass  = localStorage.getItem('fge_class') || 'GT3';
let currentPage   = 'home';
let standingsTab  = 'drivers';
let driverFocusId = null;
let teamFocusId   = null;
let raceFocusIdx  = null;

// User identity (DOTD / Fantasy / Predictions)
let userId = localStorage.getItem('fge_userId') || null;
let userName = localStorage.getItem('fge_userName') || null;

// ── HELPERS: DATA ───────────────────────────────────────
function cls() { return rawData?.[currentClass.toLowerCase()] || emptyClass(); }

function closeNav() {
    document.getElementById('navOverlay')?.classList.remove('open');
    document.getElementById('navToggle')?.classList.remove('open');
}

function emptyClass() {
    return { drivers:[], teams:[], races:[], news:[], fantasy:{}, archive:{}, seasonName:'Season 1' };
}

function colourFor(name, teamsArr) {
    if (!name) return autoColor('');
    const arr = teamsArr || cls().teams || [];
    let t = arr.find(x => x.name === name);
    if (!t) t = arr.find(x => (x.name||'').toLowerCase() === name.toLowerCase());
    if (!t) t = arr.find(x => (x.name||'').toLowerCase().includes(name.toLowerCase()) || name.toLowerCase().includes((x.name||'').toLowerCase()));
    return (t && t.color) ? t.color : autoColor(name);
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

function fmtDate(str) {
    if (!str) return '';
    const d = new Date(str);
    return d.toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' });
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

function pointsTable() { return [25,18,15,12,10,8,6,4,2,1]; }

function calcStandings(races, drivers, teams) {
    const pts = {};
    const tpts = {};
    races.forEach(r => {
        if (!r.results) return;
        r.results.forEach((res, i) => {
            if (!res || !res.driver) return;
            const p = (typeof res === 'string') ? res : res.driver;
            const pos = (typeof res === 'object' && res.pos != null) ? res.pos : (i + 1);
            if (String(pos).toUpperCase() === 'DNF') return;
            const earn = pointsTable()[Number(pos) - 1] || 0;
            if (!pts[p]) pts[p] = 0;
            pts[p] += earn;
            // fastest lap bonus
            if (r.fastestLap && r.fastestLap === p) pts[p] += 1;
        });
        // DOTD bonus
        if (r.dotdWinner) { if (!pts[r.dotdWinner]) pts[r.dotdWinner] = 0; pts[r.dotdWinner] += 1; }
    });
    // Team standings
    drivers.forEach(d => {
        const tc = d.team;
        if (!tc) return;
        if (!tpts[tc]) tpts[tc] = 0;
        tpts[tc] += pts[d.name] || 0;
    });
    return { pts, tpts };
}

function formGuide(driverName, races) {
    const results = [];
    const racesCopy = [...races].reverse();
    racesCopy.forEach(r => {
        if (!r.results) return;
        const idx = r.results.findIndex(res => {
            if (typeof res === 'string') return res === driverName;
            return res.driver === driverName;
        });
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

function countdownHTML(targetDate) {
    if (!targetDate) return '';
    const diff = new Date(targetDate) - Date.now();
    if (diff <= 0) return '<span style="color:var(--gt4)">RACE DAY</span>';
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
function switchClass(cls) {
    if (cls === currentClass) return;
    currentClass = cls;
    try { localStorage.setItem('fge_class', cls); } catch(e) {}
    // Drives --class-color: red for GT3, blue for GT4
    document.body.classList.toggle('gt4-mode', cls === 'GT4');
    const car = document.getElementById('csCar');
    if (car) {
        car.classList.toggle('gt4-pos', cls === 'GT4');
    }
    document.getElementById('csGT3')?.classList.toggle('active', cls === 'GT3');
    document.getElementById('csGT4')?.classList.toggle('active', cls === 'GT4');
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
        case 'dotd':       renderDOTD(); break;
    }
}

// ── HOME PAGE ────────────────────────────────────────────
function renderHome() {
    const d = cls();
    renderRaceStrip(d);
    renderCountdown(d);
    renderHomeNews(d);
    renderHomeStandings(d);
}

function renderRaceStrip(d) {
    const next = d.races?.find(r => r.date && new Date(r.date) >= new Date()) || d.races?.[d.races.length-1];
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
    const next = d.races?.find(r => r.date && new Date(r.date) >= new Date());
    const el = document.getElementById('countdownBar');
    if (!el) return;
    if (!next) { el.innerHTML = '<span class="cb-label">NO UPCOMING RACE</span>'; return; }
    el.innerHTML = `<span class="cb-label">NEXT RACE</span><div class="cb-units">${countdownHTML(next.date)}</div>`;
}

function renderHomeNews(d) {
    const el = document.getElementById('homeNews');
    if (!el) return;
    const news = (d.news || []).slice().reverse();
    if (!news.length) { el.innerHTML = '<p style="color:var(--muted)">No news yet.</p>'; return; }
    const hero = news[0];
    const mini = news.slice(1, 4);
    el.innerHTML = `
      <div class="news-hero" onclick="openNewsModal(0)">
        <div class="nh-bg nh-placeholder" ${hero.image ? `style="background-image:url('${hero.image}')"` : ''}></div>
        <div class="nh-overlay"></div>
        <div class="nh-content">
          <span class="nh-tag">${hero.tag || currentClass}</span>
          <h2>${hero.title || 'FGE News'}</h2>
          <p>${hero.excerpt || hero.body?.substring(0,120) || ''}</p>
        </div>
      </div>
      <div class="news-side">
        ${mini.map((n,i) => `
          <div class="news-mini" onclick="openNewsModal(${i+1})">
            <div class="news-mini-img placeholder" ${n.image ? `style="background-image:url('${n.image}')"` : ''}></div>
            <div class="news-mini-body">
              <div class="news-date">${ago(n.date)}</div>
              <h4>${n.title || ''}</h4>
            </div>
          </div>`).join('')}
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
      ${n.image ? `<div class="modal-news-img" style="background-image:url('${n.image}')"></div>` : ''}
      <span class="nh-tag">${n.tag || currentClass}</span>
      <h2 style="font-family:var(--font-display);color:var(--white);margin:0.5rem 0;letter-spacing:0.06em">${n.title||''}</h2>
      <p style="color:var(--muted);font-size:0.82rem;margin-bottom:1rem">${fmtDate(n.date)}</p>
      <div style="color:var(--text);line-height:1.7;font-size:0.92rem">${(n.body||'').replace(/\n/g,'<br>')}</div>`;
    m.classList.remove('hidden');
}

function renderHomeStandings(d) {
    const el = document.getElementById('homeStandings');
    if (!el) return;
    const { pts } = calcStandings(d.races||[], d.drivers||[], d.teams||[]);
    const sorted = [...(d.drivers||[])].sort((a,b) => (pts[b.name]||0) - (pts[a.name]||0)).slice(0,5);
    if (!sorted.length) { el.innerHTML = '<p style="color:var(--muted)">No standings yet.</p>'; return; }
    el.innerHTML = sorted.map((drv, i) => {
        const col = colourFor(drv.team, d.teams);
        const p = pts[drv.name] || 0;
        return `<div style="display:flex;align-items:center;gap:0.8rem;padding:0.6rem 0;border-bottom:1px solid var(--line);cursor:pointer" onclick="navigate('drivers',{driverFocusId:'${drv.id||drv.name}'})">
          <span style="font-family:var(--font-display);font-size:0.9rem;color:var(--muted);width:22px">${i+1}</span>
          <span class="team-dot" style="background:${col}"></span>
          <span style="flex:1;color:var(--white)">${drv.name}</span>
          <span style="font-family:var(--font-display);color:var(--white)">${p} <span style="color:var(--muted);font-size:0.7rem">PTS</span></span>
        </div>`;
    }).join('');
}

// ── STANDINGS PAGE ───────────────────────────────────────
function renderStandings() {
    const d = cls();
    const { pts, tpts } = calcStandings(d.races||[], d.drivers||[], d.teams||[]);
    const el = document.getElementById('standingsContent');
    if (!el) return;

    if (standingsTab === 'drivers') {
        const sorted = [...(d.drivers||[])].sort((a,b) => (pts[b.name]||0) - (pts[a.name]||0));
        if (!sorted.length) { el.innerHTML = '<p style="color:var(--muted);padding:2rem">No driver data yet.</p>'; return; }
        const leader = pts[sorted[0]?.name] || 0;
        el.innerHTML = `
          <div class="table-container">
            <table class="standings-table">
              <thead><tr>
                <th>POS</th><th>DRIVER</th><th class="std-hide-mobile">TEAM</th><th class="std-hide-mobile">NAT</th><th class="std-hide-mobile">FORM</th><th>PTS</th>
              </tr></thead>
              <tbody>
                ${sorted.map((drv, i) => {
                    const col = colourFor(drv.team, d.teams);
                    const p = pts[drv.name] || 0;
                    const gap = i === 0 ? '' : `-${leader - p}`;
                    const guide = formGuide(drv.name, d.races||[]);
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
          </div>`;
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
            const drvName = typeof res === 'string' ? res : res.driver;
            const col = colourFor(d.drivers?.find(x=>x.name===drvName)?.team, d.teams);
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

function openRaceModal(idx) {
    const d = cls();
    const race = d.races?.[idx];
    if (!race) return;
    const m = document.getElementById('modal');
    const mc = document.getElementById('modalContent');
    if (!m || !mc) return;
    const rows = (race.results||[]).map((res, i) => {
        const drvName = typeof res === 'string' ? res : res.driver;
        const pos = typeof res === 'object' && res.pos ? res.pos : i+1;
        const time = typeof res === 'object' ? (res.time || '') : '';
        const col = colourFor(d.drivers?.find(x=>x.name===drvName)?.team, d.teams);
        return `<tr>
          <td class="rt-pos">${pos}</td>
          <td class="rt-winner">${drvName}</td>
          <td class="rt-team"><span class="team-dot" style="background:${col}"></span>${d.drivers?.find(x=>x.name===drvName)?.team||'—'}</td>
          <td class="rt-time">${time}</td>
        </tr>`;
    }).join('');
    mc.innerHTML = `
      <button class="modal-close" onclick="closeModal()">✕</button>
      <div class="modal-race-head">
        <span style="font-family:var(--font-display);font-size:0.7rem;color:var(--accent2);letter-spacing:0.12em">ROUND ${race.round||'?'}</span>
        <div class="modal-race-num">${race.name||'Race'}</div>
        <div style="color:var(--muted);font-size:0.82rem;font-family:var(--font-ui)">${fmtDate(race.date)} · ${race.track||''}</div>
      </div>
      ${race.fastestLap ? `<div style="margin:0.5rem 0;font-size:0.82rem;color:var(--accent2);font-family:var(--font-ui)">⚡ Fastest Lap: ${race.fastestLap}</div>` : ''}
      <div class="table-container" style="margin-top:1rem">
        <table class="results-table">
          <thead><tr><th>POS</th><th>DRIVER</th><th>TEAM</th><th>TIME</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    m.classList.remove('hidden');
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
            const n = typeof res === 'string' ? res : res.driver;
            const col = colourFor(d.drivers?.find(x=>x.name===n)?.team, d.teams);
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
            <div class="cal-card-foot"><span class="cal-fmt">${race.laps ? `${race.laps} laps` : ''}</span></div>
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
              <div class="ftc-logo">${t.logo ? `<img class="ftc-logo-img" src="${t.logo}" alt="">` : `<div style="width:48px;height:48px;border-radius:50%;background:${col};display:flex;align-items:center;justify-content:center;font-family:var(--font-display);color:#fff;font-size:1rem">${(t.name||'').charAt(0)}</div>`}</div>
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
function renderDrivers() {
    const d = cls();
    const el = document.getElementById('driversContent');
    if (!el) return;
    if (driverFocusId) { renderDriverProfile(driverFocusId); driverFocusId = null; return; }
    const { pts } = calcStandings(d.races||[], d.drivers||[], d.teams||[]);
    if (!d.drivers?.length) { el.innerHTML = '<p style="color:var(--muted);padding:2rem">No drivers registered yet.</p>'; return; }
    el.innerHTML = `<div class="f1-drivers-grid">` + d.drivers.map(drv => {
        const col = colourFor(drv.team, d.teams);
        const [r,g,b] = [parseInt(col.slice(1,3),16),parseInt(col.slice(3,5),16),parseInt(col.slice(5,7),16)];
        const names = (drv.name||'').split(' ');
        const first = names.slice(0,-1).join(' ') || '';
        const last = names[names.length-1] || drv.name;
        return `
          <div class="f1-driver-card" style="background:linear-gradient(135deg,rgba(${r},${g},${b},0.18) 0%,var(--surface) 60%);border-left:3px solid ${col}" onclick="navigate('drivers',{driverFocusId:'${drv.id||drv.name}'})">
            <div class="fdc-info">
              <div class="fdc-name">
                ${first ? `<span class="fdc-first">${first}</span>` : ''}
                <span class="fdc-last">${last}</span>
              </div>
              <div class="fdc-team" style="color:${col}">${drv.team||'—'}</div>
              <div class="fdc-nat">${drv.nationality||''}</div>
              <div style="font-family:var(--font-display);color:var(--accent2);margin-top:0.5rem">${pts[drv.name]||0} PTS</div>
            </div>
            <div class="fdc-num">${drv.number||''}</div>
          </div>`;
    }).join('') + '</div>';
}

function renderDriverProfile(id) {
    const d = cls();
    const drv = d.drivers?.find(x => (x.id||x.name) === id) || d.drivers?.[0];
    if (!drv) return;
    const el = document.getElementById('driversContent');
    const { pts } = calcStandings(d.races||[], d.drivers||[], d.teams||[]);
    const col = colourFor(drv.team, d.teams);
    const guide = formGuide(drv.name, d.races||[]);
    const races = (d.races||[]).filter(r=>r.results?.some(res=>(typeof res==='string'?res:res.driver)===drv.name));
    const wins = races.filter(r=>{const res=r.results?.[0];return (typeof res==='string'?res:res.driver)===drv.name;}).length;
    const pods = races.filter(r=>r.results?.slice(0,3).some(res=>(typeof res==='string'?res:res.driver)===drv.name)).length;
    el.innerHTML = `
      <button class="btn btn-secondary" style="margin-bottom:1rem" onclick="driverFocusId=null;renderDrivers()">← Back to Drivers</button>
      <div style="background:var(--surface);border:1px solid var(--line);border-top:4px solid ${col};border-radius:4px;padding:2rem;margin-bottom:1.5rem">
        <div class="driver-profile-page">
          <div class="dpp-photo-col">
            ${drv.photo ? `<img class="dpp-photo" src="${drv.photo}" alt="">` : `<div class="dpp-fallback">${(drv.name||'').charAt(0)}</div>`}
            <div class="dpp-number" style="color:${col}">#${drv.number||'?'}</div>
            <div class="dpp-nat">${drv.nationality||''}</div>
          </div>
          <div class="dpp-info">
            <h1>${drv.name}</h1>
            <div class="dpp-team" style="color:${col}">${drv.team||'No team'}</div>
            <div class="dpp-stats">
              <div class="dpp-stat"><label>POINTS</label><strong style="color:var(--accent2)">${pts[drv.name]||0}</strong></div>
              <div class="dpp-stat"><label>WINS</label><strong>${wins}</strong></div>
              <div class="dpp-stat"><label>PODIUMS</label><strong>${pods}</strong></div>
              <div class="dpp-stat"><label>RACES</label><strong>${races.length}</strong></div>
            </div>
            <div style="margin-top:0.8rem">
              <div style="font-family:var(--font-display);font-size:0.72rem;letter-spacing:0.12em;color:var(--muted);margin-bottom:0.4rem">RECENT FORM</div>
              <div class="form-guide">${formHTML(guide)}</div>
            </div>
            ${drv.bio ? `<p style="color:var(--muted);margin-top:1rem;line-height:1.6;font-size:0.9rem">${drv.bio}</p>` : ''}
          </div>
        </div>
      </div>`;
}

// ── FANTASY PAGE ─────────────────────────────────────────
function renderFantasy() {
    const el = document.getElementById('fantasyContent');
    if (!el) return;
    if (!userId) {
        el.innerHTML = `
          <div class="fantasy-join">
            <div class="fj-card">
              <h2>JOIN FANTASY LEAGUE</h2>
              <p>Pick your driver, team and fastest lap for each race and compete for the championship.</p>
              <input id="fantasyNameInput" type="text" placeholder="Enter your username…" maxlength="20">
              <button class="btn btn-primary" style="width:100%" onclick="joinFantasy()">JOIN NOW</button>
            </div>
          </div>`;
        return;
    }
    const d = cls();
    const next = d.races?.find(r => r.date && new Date(r.date) >= new Date());
    const past = (d.races||[]).filter(r=>r.results?.length).slice().reverse();
    el.innerHTML = `
      <div class="fantasy-header">
        <h2 style="font-family:var(--font-display);color:var(--white);letter-spacing:0.08em">FANTASY — ${currentClass}</h2>
        <span style="color:var(--muted);font-size:0.85rem">Playing as: <b style="color:var(--white)">${userName}</b></span>
      </div>
      <div class="fantasy-tabs">
        <button class="fantasy-tab-btn active" id="ftab-pick" onclick="switchFantasyTab('pick')">MY PICKS</button>
        <button class="fantasy-tab-btn" id="ftab-lb" onclick="switchFantasyTab('leaderboard')">LEADERBOARD</button>
      </div>
      <div id="fantasyTabContent">${renderFantasyPicks(next, d)}</div>`;
}

function renderFantasyPicks(next, d) {
    if (!next) return '<p style="color:var(--muted)">No upcoming races to pick for.</p>';
    const key = `${currentClass}_${next.round||next.name}_${userId}`;
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(`fge_fp_${key}`) || '{}'); } catch(e) {}
    return `
      <div class="ftp-section">
        <h3>${next.name||'Next Race'} — Round ${next.round||'?'}</h3>
        <p class="ftp-hint">📅 ${fmtDate(next.date)}</p>
        <div class="ftp-hint">Pick your race winner, fastest lap driver, and team of the race.</div>
      </div>
      <div class="ftp-section">
        <h3>🏆 Race Winner</h3>
        <p class="ftp-hint">Who wins the race?</p>
        <div class="ftp-grid">
          ${(d.drivers||[]).map(drv => {
              const col = colourFor(drv.team, d.teams);
              const picked = saved.winner === drv.name;
              return `<div class="ftp-card ${picked?'picked':''}" style="${picked?`--tc:${col}`:''}" onclick="pickFantasy('winner','${drv.name}','${key}')">
                <span class="team-dot" style="background:${col}"></span>
                <div class="ftpc-name">${drv.name}</div>
                <div class="ftpc-team">${drv.team||''}</div>
                ${picked ? '<div class="ftpc-check">✓ PICKED</div>' : ''}
              </div>`;
          }).join('')}
        </div>
      </div>
      <div class="ftp-section">
        <h3>⚡ Fastest Lap</h3>
        <p class="ftp-hint">Who sets the fastest lap?</p>
        <div class="ftp-grid">
          ${(d.drivers||[]).map(drv => {
              const col = colourFor(drv.team, d.teams);
              const picked = saved.fastest === drv.name;
              return `<div class="ftp-card ${picked?'picked':''}" style="${picked?`--tc:${col}`:''}" onclick="pickFantasy('fastest','${drv.name}','${key}')">
                <span class="team-dot" style="background:${col}"></span>
                <div class="ftpc-name">${drv.name}</div>
                <div class="ftpc-team">${drv.team||''}</div>
                ${picked ? '<div class="ftpc-check">✓ PICKED</div>' : ''}
              </div>`;
          }).join('')}
        </div>
      </div>`;
}

function switchFantasyTab(tab) {
    document.querySelectorAll('.fantasy-tab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(`ftab-${tab}`)?.classList.add('active');
    const el = document.getElementById('fantasyTabContent');
    if (!el) return;
    const d = cls();
    if (tab === 'leaderboard') {
        // Simple local leaderboard placeholder
        el.innerHTML = '<p style="color:var(--muted);padding:1.5rem">Leaderboard coming soon.</p>';
    } else {
        const next = d.races?.find(r => r.date && new Date(r.date) >= new Date());
        el.innerHTML = renderFantasyPicks(next, d);
    }
}

function joinFantasy() {
    const val = document.getElementById('fantasyNameInput')?.value.trim();
    if (!val) return;
    userId = `${val}_${Date.now()}`;
    userName = val;
    localStorage.setItem('fge_userId', userId);
    localStorage.setItem('fge_userName', userName);
    renderFantasy();
}

function pickFantasy(type, val, key) {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(`fge_fp_${key}`) || '{}'); } catch(e) {}
    saved[type] = val;
    localStorage.setItem(`fge_fp_${key}`, JSON.stringify(saved));
    const d = cls();
    const next = d.races?.find(r => r.date && new Date(r.date) >= new Date());
    const el = document.getElementById('fantasyTabContent');
    if (el) el.innerHTML = renderFantasyPicks(next, d);
}

// ── DOTD PAGE ─────────────────────────────────────────────
function renderDOTD() {
    const d = cls();
    const el = document.getElementById('dotdContent');
    if (!el) return;
    const races = (d.races||[]).filter(r=>r.results?.length).slice().reverse();
    if (!races.length) { el.innerHTML = '<p style="color:var(--muted);padding:2rem">No completed races yet.</p>'; return; }
    el.innerHTML = races.map(race => {
        const drivers = (race.results||[]).map(res => typeof res === 'string' ? res : res.driver).filter(Boolean);
        const voteKey = `${currentClass}_dotd_${race.round||race.name}`;
        let myVote = null;
        try { myVote = localStorage.getItem(voteKey); } catch(e) {}
        const votes = {};
        try {
            const stored = JSON.parse(localStorage.getItem(`${voteKey}_counts`) || '{}');
            Object.assign(votes, stored);
        } catch(e) {}
        const totalVotes = Object.values(votes).reduce((a,b)=>a+b,0);
        return `
          <div class="dotd-race-block">
            <div class="dotd-race-header">
              <h2>${race.name} — Round ${race.round||'?'}</h2>
              <span class="dotd-date">${fmtDate(race.date)}</span>
            </div>
            <div class="dotd-hint">Vote for your Driver of the Day</div>
            <div class="dotd-grid">
              ${drivers.map(name => {
                  const col = colourFor(d.drivers?.find(x=>x.name===name)?.team, d.teams);
                  const voteCount = votes[name] || 0;
                  const pct = totalVotes ? Math.round(voteCount/totalVotes*100) : 0;
                  const isVoted = myVote === name;
                  return `<div class="dotd-card ${isVoted?'dotd-voted':''}" style="${isVoted?`--tc:${col}`:''}" onclick="voteDOTD('${name}','${voteKey}')">
                    <div class="dotd-name">${name}</div>
                    <div class="dotd-team">${d.drivers?.find(x=>x.name===name)?.team||''}</div>
                    ${myVote ? `<div class="dotd-bar-wrap"><div class="dotd-bar" style="width:${pct}%;background:${col}"></div></div>
                    <div class="dotd-pct">${pct}%</div>` : ''}
                    ${isVoted ? '<div class="dotd-check">✓ YOUR VOTE</div>' : ''}
                  </div>`;
              }).join('')}
            </div>
            ${myVote ? `<div class="dotd-total">${totalVotes} vote${totalVotes!==1?'s':''}</div>` : ''}
          </div>`;
    }).join('');
}

function voteDOTD(name, key) {
    let existing = null;
    try { existing = localStorage.getItem(key); } catch(e) {}
    if (existing) return; // already voted
    try {
        localStorage.setItem(key, name);
        const counts = JSON.parse(localStorage.getItem(`${key}_counts`) || '{}');
        counts[name] = (counts[name]||0) + 1;
        localStorage.setItem(`${key}_counts`, JSON.stringify(counts));
    } catch(e) {}
    renderDOTD();
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
        if (currentPage !== 'home') return;
        const d = cls();
        const next = d.races?.find(r => r.date && new Date(r.date) >= new Date());
        if (!next) return;
        const el = document.getElementById('countdownBar');
        if (el) el.innerHTML = `<span class="cb-label">NEXT RACE</span><div class="cb-units">${countdownHTML(next.date)}</div>`;
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

    // Init class switcher UI — apply the saved class colour on first paint
    document.body.classList.toggle('gt4-mode', currentClass === 'GT4');
    const car = document.getElementById('csCar');
    if (car) car.classList.toggle('gt4-pos', currentClass === 'GT4');
    document.getElementById('csGT3')?.classList.toggle('active', currentClass === 'GT3');
    document.getElementById('csGT4')?.classList.toggle('active', currentClass === 'GT4');

    // Hide install banner if dismissed
    try {
        if (localStorage.getItem('fge_install_dismissed')) {
            const b = document.getElementById('installBanner');
            if (b) b.style.display = 'none';
        }
    } catch(e) {}

    // Check PWA already installed
    if (window.matchMedia('(display-mode: standalone)').matches) {
        const b = document.getElementById('installBanner');
        if (b) b.style.display = 'none';
    }

    // A failed fetch must not stop the page from rendering
    try { await fetchData(); } catch(e) { console.error('fetchData failed', e); }
    try { navigate('home'); } catch(e) { console.error('navigate failed', e); }
    try { startCountdownTick(); } catch(e) {}

    // Register service worker
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./sw.js').catch(()=>{});
    }
}

document.addEventListener('DOMContentLoaded', init);
