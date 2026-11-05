/* Live timing + overlay tests */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const DIR = require('path').join(__dirname, '..');
const read = f => fs.readFileSync(path.join(DIR, f), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
    if (cond) { pass++; console.log('  ✓ ' + name); }
    else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
};

const LEAGUE = {
    gt3: { drivers: [], teams: [], races: [], news: [] },
    gt4: { drivers: [], teams: [], races: [], news: [] },
};

function session(over) {
    return Object.assign({
        ok: true, status: 'green', class: 'gt3', round: 4,
        raceName: 'Spa 90', track: 'Spa-Francorchamps',
        message: '', lightsOut: Date.now() - 600000, durationMin: 90,
        running: [
            { driverId:'d1', name:'Maxi',    team:'Apex',   colour:'#E10600', number:'1',  gap:'LEADER', out:false },
            { driverId:'d2', name:'Morrison',team:'Vortex', colour:'#0033A0', number:'44', gap:'+1.204', out:false },
            { driverId:'d3', name:'Kai',     team:'Apex',   colour:'#E10600', number:'7',  gap:'+3.8',   out:false },
            { driverId:'d4', name:'Rees',    team:'Nord',   colour:'bogus',   number:'12', gap:'+9.1',   out:false },
            { driverId:'d5', name:'Vale',    team:'Nord',   colour:'#2e7d32', number:'3',  gap:'',       out:true  },
        ],
        updatedAt: Date.now(), now: Date.now(),
    }, over || {});
}

/** Boot index.html + app.js the way a browser would, with a stubbed network. */
async function boot(liveBody) {
    const calls = { live: 0 };
    const dom = new JSDOM(read('index.html'), {
        url: 'https://fp-league.github.io/FGE/',
        runScripts: 'dangerously',
        pretendToBeVisual: true,
        beforeParse(w) {
            w.fetch = async (url) => {
                if (String(url).includes('/api/live')) {
                    calls.live++;
                    return { ok: true, json: async () =>
                        (typeof liveBody === 'function' ? liveBody(calls.live) : liveBody) };
                }
                return { ok: true, json: async () => ({ record: LEAGUE }) };
            };
            w.scrollTo = () => {};
        },
    });
    const w = dom.window;
    await new Promise(r => w.addEventListener('load', r));
    // index.html's <script src="app.js"> isn't fetched by jsdom, so run it the
    // same way the browser does — as a classic script, in global scope.
    const s = w.document.createElement('script');
    s.textContent = read('app.js');
    w.document.body.appendChild(s);
    w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
    // let init()'s awaits and the first poll settle
    for (let i = 0; i < 15; i++) await new Promise(r => setImmediate(r));
    return { dom, w, calls };
}

// `let` at a script's top level is a lexical global, not a window property.
const cp = w => w.eval('currentPage');

(async () => {

console.log('\nIDLE — nothing running');
{
    const { w } = await boot({ ok: true, status: 'idle', running: [], now: Date.now() });
    const li = w.document.querySelector('.nav-link[data-page="live"]').closest('li');
    ok('nav entry stays hidden', li.style.display === 'none', li.style.display);
    ok('home banner empty', w.document.getElementById('liveBanner').innerHTML.trim() === '');
    w.navigate('live');
    const html = w.document.getElementById('liveContent').innerHTML;
    ok('live page explains itself', /No session running/.test(html));
    ok('no tower drawn', !/lv-tower/.test(html));
}

console.log('\nLIVE — green flag, order published');
{
    const { w } = await boot(session());
    const li = w.document.querySelector('.nav-link[data-page="live"]').closest('li');
    ok('nav entry revealed', li.style.display === '', JSON.stringify(li.style.display));

    const b = w.document.getElementById('liveBanner').innerHTML;
    ok('home banner shows LIVE NOW', /LIVE NOW/.test(b));
    ok('home banner names the race', /Spa 90/.test(b));
    ok('home banner is a link to the page', /data-page="live"/.test(b));

    w.navigate('live');
    const html = w.document.getElementById('liveContent').innerHTML;
    ok('round shown', /ROUND 4/.test(html));
    ok('track shown', /Spa-Francorchamps/.test(html));
    ok('green flag pill', /GREEN FLAG/.test(html));
    ok('header carries status class', /lv-head lv-green/.test(html));

    const doc = w.document;
    const rows = [...doc.querySelectorAll('#liveContent .lv-row')].filter(r => !r.classList.contains('lv-thead'));
    ok('five rows', rows.length === 5, String(rows.length));
    ok('P1 numbered 1', rows[0].querySelector('.lv-pos').textContent.trim() === '1');
    ok('P1 marked gold', rows[0].classList.contains('p1'));
    ok('P3 marked bronze', rows[2].classList.contains('p3'));
    ok('P4 has no podium class', !/\bp[123]\b/.test(rows[3].className));
    ok('retired row marked OUT', rows[4].querySelector('.lv-pos').textContent.trim() === 'OUT');
    ok('retired row dimmed', rows[4].classList.contains('out'));
    ok('retired driver takes no position', rows[3].querySelector('.lv-pos').textContent.trim() === '4');
    ok('gap shown', /\+1\.204/.test(html));
    ok('number shown', /#44/.test(html));
    ok('team shown', /Vortex/.test(html));

    const bar = rows[3].querySelector('.lv-bar').getAttribute('style');
    ok('invalid team colour falls back', /#888888/.test(bar), bar);
    const bar0 = rows[0].querySelector('.lv-bar').getAttribute('style');
    ok('valid team colour kept', /#E10600/i.test(bar0), bar0);
}

console.log('\nCLOCKS');
{
    const lo = Date.now() - 30 * 60000;          // lights out 30 min ago
    const { w } = await boot(session({ lightsOut: lo, durationMin: 90 }));
    w.navigate('live');
    const txt = w.document.querySelector('#liveContent .lv-clock').textContent.trim();
    ok('counts down from duration', /^(59|60):\d\d$/.test(txt), txt);

    const { w: w2 } = await boot(session({ status: 'formation', lightsOut: Date.now() + 5 * 60000 }));
    w2.navigate('live');
    const t2 = w2.document.querySelector('#liveContent .lv-clock').textContent.trim();
    ok('pre-race shows LIGHTS OUT IN', /^LIGHTS OUT IN 0[45]:\d\d$/.test(t2), t2);

    const { w: w3 } = await boot(session({ lightsOut: Date.now() - 95 * 60000, durationMin: 90 }));
    w3.navigate('live');
    ok('never counts past zero', w3.document.querySelector('#liveContent .lv-clock').textContent.trim() === '00:00');

    const { w: w4 } = await boot(session({ lightsOut: null, durationMin: null }));
    w4.navigate('live');
    ok('no clock without a time set', !w4.document.querySelector('#liveContent .lv-clock'));
}

console.log('\nNO FLICKER — the tower only repaints when it changes');
{
    const { w } = await boot(session());
    w.navigate('live');
    const el = w.document.getElementById('liveContent');
    const rowBefore = el.querySelectorAll('.lv-row')[1];
    const clockBefore = el.querySelector('.lv-clock').textContent;
    // a second passes
    w.eval('liveSkew -= 1500');
    w.eval('tickLive()');
    const rowAfter = el.querySelectorAll('.lv-row')[1];
    ok('row elements are reused, not rebuilt', rowBefore === rowAfter);
    ok('clock still advances', el.querySelector('.lv-clock').textContent !== clockBefore,
        clockBefore + ' → ' + el.querySelector('.lv-clock').textContent);

    // a real change does rebuild
    w.eval("liveState.running[0].gap = '+0.5'");
    w.eval('renderLive()');
    ok('a changed gap does repaint', el.querySelectorAll('.lv-row')[1] !== rowAfter);
    ok('new gap shown', /\+0\.5/.test(el.innerHTML));
}

console.log('\nRACE CONTROL MESSAGE');
{
    const { w } = await boot(session({ message: 'Car 44 under investigation' }));
    w.navigate('live');
    const html = w.document.getElementById('liveContent').innerHTML;
    ok('message rendered', /Car 44 under investigation/.test(html));
    ok('message labelled', /RACE CONTROL/.test(html));

    const { w: w2 } = await boot(session({ message: '   ' }));
    w2.navigate('live');
    ok('blank message hidden', !/lv-msg/.test(w2.document.getElementById('liveContent').innerHTML));
}

console.log('\nFLAG STATES');
for (const [st, label] of [['formation','FORMATION LAP'],['sc','SAFETY CAR'],['vsc','VIRTUAL SAFETY CAR'],
                           ['red','RED FLAG'],['chequered','CHEQUERED FLAG'],['finished','RACE FINISHED']]) {
    const { w } = await boot(session({ status: st, lightsOut: Date.now() - 1000 }));
    w.navigate('live');
    const html = w.document.getElementById('liveContent').innerHTML;
    ok(st + ' → ' + label, html.includes(label));
}

console.log('\nESCAPING');
{
    const { w } = await boot(session({
        raceName: '<img src=x onerror=alert(1)>',
        message: '<svg onload=alert(2)>',
        running: [{ driverId:'x', name:'<script>alert(3)</script>', team:'"><b>pwn</b>',
                    colour:'#fff" onmouseover="alert(4)', number:'1', gap:'+0.0', out:false }],
    }));
    w.navigate('live');
    const el = w.document.getElementById('liveContent');
    ok('no script element injected', !el.querySelector('script'));
    ok('no img element injected', !el.querySelector('img'));
    ok('no svg element injected', !el.querySelector('svg'));
    ok('no bold element injected', !el.querySelector('b'));
    // The header row is also .lv-row/.lv-name — take the first data row.
    const row = [...el.querySelectorAll('.lv-row')].find(r => !r.classList.contains('lv-thead'));
    ok('driver name kept as text', row.querySelector('.lv-name').textContent.includes('alert(3)'));
    ok('team name kept as text', row.querySelector('.lv-team').textContent.includes('pwn'));
    const bar = row.querySelector('.lv-bar').getAttribute('style');
    ok('colour attribute cannot break out', /#888888/.test(bar) && !/onmouseover/.test(bar), bar);
    const banner = w.document.getElementById('liveBanner').innerHTML;
    ok('banner escapes the race name', !/<img/i.test(banner) && /onerror/.test(banner));
}

console.log('\nSESSION ENDING');
{
    // first poll live, every poll after that idle
    const { w } = await boot(n => n === 1
        ? session()
        : { ok: true, status: 'idle', running: [], now: Date.now() });
    w.navigate('live');
    ok('started on the live page', cp(w) === 'live');
    await w.pollLive();
    for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
    ok('viewer sent home when the session ends', cp(w) === 'home', cp(w));
    const li = w.document.querySelector('.nav-link[data-page="live"]').closest('li');
    ok('nav entry hidden again', li.style.display === 'none');
}

console.log('\nRESILIENCE');
{
    const { w } = await boot(() => { throw new Error('offline'); });
    ok('a dead API does not break the site', w.document.getElementById('home').classList.contains('active'));
    ok('nav entry stays hidden when the API is down',
        w.document.querySelector('.nav-link[data-page="live"]').closest('li').style.display === 'none');

    // Last good state survives a dropped poll
    const { w: w2 } = await boot(n => { if (n > 1) throw new Error('offline'); return session(); });
    w2.navigate('live');
    await w2.pollLive();
    for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
    ok('last good state kept through a dropped poll',
        /Spa 90/.test(w2.document.getElementById('liveContent').innerHTML));
    ok('viewer not kicked off the page by a dropped poll', cp(w2) === 'live');
}

console.log('\nPOLL BUDGET');
{
    const src = read('app.js');
    const m = /livePollTimer = setTimeout\(pollLive, liveIsOn\(\) \? (\d+) : (\d+)\)/.exec(src);
    ok('adaptive poll interval present', Boolean(m));
    if (m) {
        const live = +m[1], idle = +m[2];
        ok('live poll at most every 3s', live >= 3000, String(live));
        ok('idle poll at least 60s apart', idle >= 60000, String(idle));
        // Worker free tier is 100k requests/day
        ok('an idle tab stays well inside the free tier', (86400000 / idle) < 2000,
            Math.round(86400000 / idle) + ' req/day');
    }
    ok('only one timer can ever be pending', /clearTimeout\(livePollTimer\)/.test(src));
}

console.log('\nSERVICE WORKER');
{
    const sw = read('sw.js');
    ok('API never cached', /\/api\//.test(sw) && /workers\.dev/.test(sw));
    // Was pinned to fge-v10, which failed the moment the cache was bumped —
    // the thing worth asserting is that the name is versioned at all and
    // that activate drops every cache that is not the current one.
    ok('cache name is versioned', /const CACHE = 'fge-v\d+'/.test(sw));
    ok('old caches are deleted on activate', /keys\.filter\(k => k !== CACHE\)/.test(sw));
    ok('pre-cache does not pull full-size art', !/'\.\/porsche\.webp'/.test(sw));
}

console.log('\nOVERLAY (OBS browser source)');
{
    const body = session();
    const dom = new JSDOM(read('overlay.html'), {
        url: 'https://fp-league.github.io/FGE/overlay.html',
        runScripts: 'dangerously', pretendToBeVisual: true,
        beforeParse(w) {
            w.fetch = async () => ({ ok: true, json: async () => body });
        },
    });
    const w = dom.window;
    await new Promise(r => w.addEventListener('load', r));
    for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r));
    const doc = w.document;

    ok('transparent background for OBS', !/background:\s*(#|rgb)/i.test(
        (doc.querySelector('style').textContent.match(/html,body\s*{[^}]*}/) || [''])[0]));
    ok('tower visible', !doc.getElementById('tower').classList.contains('hidden'));
    const rows = [...doc.querySelectorAll('#rows .row')];
    ok('rows rendered', rows.length === 5, String(rows.length));
    ok('P1 first', rows[0].querySelector('.pos').textContent.trim() === '1');
    ok('OUT row last', rows[4].querySelector('.pos').textContent.trim() === 'OUT');
    ok('round in header', doc.getElementById('twRound').textContent.trim() === 'R4');
    ok('race clock running', /^\d?\d?:?\d\d:\d\d$|^\d\d:\d\d$/.test(doc.getElementById('twClock').textContent.trim()),
        doc.getElementById('twClock').textContent);
    ok('green flag band shown', doc.getElementById('flag').className === 'on green');
    ok('no pill while racing green', doc.getElementById('status').className === '');
    ok('row cap honoured', /MAX_ROWS/.test(read('overlay.html')));
    ok('adaptive overlay polling', /status !== 'idle'\) \? 1000 : 15000/.test(read('overlay.html')));
    w.close();
}

console.log('\nOVERLAY — escaping and states');
{
    const body = session({
        status: 'sc', message: '<b>Safety car deployed</b>',
        running: [{ driverId:'x', name:'<script>alert(1)</script>', team:'t',
                    colour:'red" onmouseover="alert(2)', number:'1', gap:'LEADER', out:false }],
    });
    const dom = new JSDOM(read('overlay.html'), {
        url: 'https://fp-league.github.io/FGE/overlay.html',
        runScripts: 'dangerously', pretendToBeVisual: true,
        beforeParse(w) { w.fetch = async () => ({ ok: true, json: async () => body }); },
    });
    const w = dom.window;
    await new Promise(r => w.addEventListener('load', r));
    for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r));
    const doc = w.document;
    ok('no script injected into the tower', !doc.querySelector('#rows script'));
    ok('name kept as text', doc.querySelector('#rows .name').textContent.includes('alert(1)'));
    ok('colour cannot add an attribute', !doc.querySelector('#rows .bar').getAttribute('onmouseover'));
    ok('bad colour falls back to grey', /#888888/i.test(doc.querySelector('#rows .bar').getAttribute('style')),
        doc.querySelector('#rows .bar').getAttribute('style'));
    ok('car number on the overlay', doc.querySelector('#rows .num').textContent.trim() === '#1');
    ok('safety car pill shown', doc.getElementById('status').textContent === 'SAFETY CAR');
    ok('safety car band shown', /\bsc\b/.test(doc.getElementById('flag').className));
    ok('message is text, not markup', !doc.querySelector('#msg b') &&
        doc.getElementById('msgTxt').textContent.includes('Safety car deployed'));
    w.close();
}

console.log('\nOVERLAY — idle shows nothing at all');
{
    const dom = new JSDOM(read('overlay.html'), {
        url: 'https://fp-league.github.io/FGE/overlay.html',
        runScripts: 'dangerously', pretendToBeVisual: true,
        beforeParse(w) { w.fetch = async () => ({ ok: true, json: async () => ({ ok:true, status:'idle', running:[], now:Date.now() }) }); },
    });
    const w = dom.window;
    await new Promise(r => w.addEventListener('load', r));
    for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r));
    const doc = w.document;
    ok('tower hidden', doc.getElementById('tower').classList.contains('hidden'));
    ok('flag band hidden', doc.getElementById('flag').className === '');
    ok('pill hidden', doc.getElementById('status').className === '');
    ok('message hidden', doc.getElementById('msg').className === '');
    ok('countdown hidden', doc.getElementById('pre').className === '');
    w.close();
}


console.log('\nQUALI MODE — site');
{
    const q = session({ mode:'quali', status:'green', lightsOut: Date.now()-600000, durationMin:20,
        running:[
            {driverId:'a',name:'Maxi',    team:'Apex',  colour:'#E10600', number:'1',  lap:'1:42.391', out:false},
            {driverId:'b',name:'Morrison',team:'Vortex',colour:'#0033A0', number:'44', lap:'1:42.904', out:false},
            {driverId:'c',name:'Kai',     team:'Apex',  colour:'#E10600', number:'7',  lap:'',         out:false},
            {driverId:'d',name:'Vale',    team:'Nord',  colour:'#2e7d32', number:'3',  lap:'',         out:true },
        ]});
    const { w } = await boot(q);
    w.navigate('live');
    const el = w.document.getElementById('liveContent');
    const html = el.innerHTML;
    ok('labelled QUALIFYING', /QUALIFYING/.test(html));
    ok('track open, not green flag', /TRACK OPEN/.test(html) && !/GREEN FLAG/.test(html));
    ok('lap column header', /GAP TO POLE/.test(html));
    ok('tower in quali layout', /lv-tower is-quali/.test(html));

    const rows = [...el.querySelectorAll('.lv-row')].filter(r => !r.classList.contains('lv-thead'));
    ok('lap time shown', rows[0].querySelector('.lv-lap').textContent.trim() === '1:42.391');
    ok('fastest marked POLE', rows[0].querySelector('.lv-gap').textContent.trim() === 'POLE');
    ok('pole highlighted', rows[0].querySelector('.lv-gap').classList.contains('pole'));
    ok('delta to pole computed', rows[1].querySelector('.lv-gap').textContent.trim() === '+0.513',
        rows[1].querySelector('.lv-gap').textContent);
    ok('no lap yet shows no delta', rows[2].querySelector('.lv-gap').textContent.trim() === '');
    ok('home banner says QUALIFYING', /QUALIFYING/.test(w.document.getElementById('liveBanner').innerHTML));

    // lap parsing
    ok('parses m:ss.mmm', w.eval("lapMs('1:42.391')") === 102391);
    ok('parses ss.mmm',   w.eval("lapMs('42.391')")   === 42391);
    ok('parses m:ss',     w.eval("lapMs('1:42')")     === 102000);
    ok('pads short millis', w.eval("lapMs('1:42.3')") === 102300);
    ok('rejects junk',    w.eval("lapMs('soon')")     === null);
    ok('rejects empty',   w.eval("lapMs('')")         === null);
}

console.log('\nQUALI — pre-session wording');
{
    const { w } = await boot(session({ mode:'quali', status:'green', lightsOut: Date.now()+300000 }));
    w.navigate('live');
    ok('says STARTS IN, not LIGHTS OUT',
        /STARTS IN/.test(w.document.querySelector('#liveContent .lv-clock').textContent));
}

console.log('\nQUALI — overlay');
{
    const body = session({ mode:'quali', status:'green', lightsOut: Date.now()-60000, durationMin:20,
        running:[
            {driverId:'a',name:'Maxi',    team:'Apex',  colour:'#E10600', number:'1',  lap:'1:42.391', out:false},
            {driverId:'b',name:'Morrison',team:'Vortex',colour:'#0033A0', number:'44', lap:'1:43.000', out:false},
        ]});
    const dom = new JSDOM(read('overlay.html'), {
        url:'https://fp-league.github.io/FGE/overlay.html', runScripts:'dangerously', pretendToBeVisual:true,
        beforeParse(w){ w.fetch = async () => ({ ok:true, json: async () => body }); },
    });
    const w = dom.window;
    await new Promise(r => w.addEventListener('load', r));
    for (let i=0;i<12;i++) await new Promise(r => setImmediate(r));
    const doc = w.document;
    ok('tower switches to quali layout', doc.getElementById('tower').classList.contains('quali'));
    ok('QUALI badge shown', doc.getElementById('twSess').style.display === '');
    ok('lap time rendered', doc.querySelector('#rows .lap').textContent.trim() === '1:42.391');
    ok('pole marked', doc.querySelectorAll('#rows .gap')[0].textContent.trim() === 'POLE');
    ok('delta computed', doc.querySelectorAll('#rows .gap')[1].textContent.trim() === '+0.609',
        doc.querySelectorAll('#rows .gap')[1].textContent);
    ok('no safety car pill in quali', doc.getElementById('status').textContent !== 'SAFETY CAR');
    w.close();
}

console.log('\nRACE MODE UNCHANGED BY ALL THIS');
{
    const { w } = await boot(session());
    w.navigate('live');
    const html = w.document.getElementById('liveContent').innerHTML;
    ok('still says GREEN FLAG', /GREEN FLAG/.test(html));
    ok('still a GAP column', /lv-gap">GAP</.test(html));
    ok('no quali layout', !/is-quali/.test(html));
    ok('no QUALIFYING badge', !/lv-sess/.test(html));
}


console.log('\nTIMER — start from now, and count up with no length set');
{
  // Length set: counts down
  const { w } = await boot(session({ lightsOut: Date.now() - 10*60000, durationMin: 60 }));
  w.navigate('live');
  const t = w.document.querySelector('#liveContent .lv-clock').textContent.trim();
  ok('counts down when a length is set', /^(49|50):\d\d$/.test(t), t);

  // No length: counts up from lights out rather than showing nothing
  const { w: w2 } = await boot(session({ lightsOut: Date.now() - 125000, durationMin: 0 }));
  w2.navigate('live');
  const t2 = w2.document.querySelector('#liveContent .lv-clock').textContent.trim();
  ok('counts up when no length is set', /^0[23]:\d\d$/.test(t2), t2);

  // No lights out at all: no clock
  const { w: w3 } = await boot(session({ lightsOut: null, durationMin: 0 }));
  w3.navigate('live');
  ok('no clock without a start time', !w3.document.querySelector('#liveContent .lv-clock'));
}

console.log('\nTIMER — overlay agrees');
{
  const body = session({ lightsOut: Date.now() - 95000, durationMin: 0 });
  const dom = new JSDOM(read('overlay.html'), {
    url:'https://fp-league.github.io/FGE/overlay.html', runScripts:'dangerously', pretendToBeVisual:true,
    beforeParse(w){ w.fetch = async () => ({ ok:true, json: async () => body }); },
  });
  const w = dom.window;
  await new Promise(r => w.addEventListener('load', r));
  for (let i=0;i<12;i++) await new Promise(r => setImmediate(r));
  const t = w.document.getElementById('twClock').textContent.trim();
  ok('overlay counts up too', /^0[12]:\d\d$/.test(t), t);
  w.close();
}

console.log('\nRACE CONTROL — the start button (source)');
{
  const m = read('manage.html');
  ok('start button exists', /function rcStartTimer/.test(m));
  ok('starts from now', /rcPush\(\{ lightsOut: Date\.now\(\), status: 'green' \}\)/.test(m));
  ok('refuses without a session', /rcStartTimer[\s\S]{0,200}Load a session first/.test(m));
  ok('asks before restarting a running clock', /clock is already running/.test(m));
  ok('reset sends 0, not null', /rcPush\(\{ lightsOut: 0 \}\)/.test(m));
  ok('reset explains why 0', /COALESCE, so null would mean/.test(m));
  ok('T is a shortcut', /=== 't'\) \{ e\.preventDefault\(\); rcStartTimer\(\)/.test(m));
  ok('operator sees the same clock', /function rcTick/.test(m));
  ok('clock ticks once a second', /setInterval\(\(\) => \{ if \(currentSec === 'control'\) rcTick\(\); \}, 1000\)/.test(m));
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

})().catch(e => { console.error(e); process.exit(1); });
