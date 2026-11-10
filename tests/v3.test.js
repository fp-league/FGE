/* v3 feature tests */
const fs = require('fs'); const path = require('path');
const { JSDOM } = require('jsdom');
const DIR = require('path').join(__dirname, '..');
const read = f => fs.readFileSync(path.join(DIR, f), 'utf8');
let pass=0, fail=0;
const ok=(n,c,x)=>{ if(c){pass++;console.log('  ✓ '+n);} else {fail++;console.log('  ✗ '+n+(x?'  → '+x:''));} };

const PTS = { table:[20,15,12,10,8,6,4,3,2,1], fastestLap:1, dotd:0 };
const drivers = [
  {id:'d1',name:'Maxi',    team:'Apex',   number:'1'},
  {id:'d2',name:'Morrison',team:'Vortex', number:'44'},
  {id:'d3',name:'Kai',     team:'Apex',   number:'7'},
  {id:'d4',name:'Rees',    team:'Nord',   number:'12'},
];
const teams = [
  {name:'Apex',color:'#E10600'},{name:'Vortex',color:'#0033A0'},{name:'Nord',color:'#2e7d32'},
];
const res = (...ks) => ks.map((k,i)=>({driver:drivers.find(d=>d.id===k).name, driverId:k, pos:i+1, time:''}));
function league(over) {
  const gt3 = Object.assign({
    drivers, teams, news:[], points: PTS, stewards: [],
    races: [
      {round:1,name:'Race One', track:'A', date:'2026-01-05', results:res('d1','d2','d3','d4'), fastestLap:'d1'},
      {round:2,name:'Race Two', track:'B', date:'2026-02-05', results:res('d2','d1','d4','d3')},
      {round:3,name:'Race Three',track:'C',date:'2026-12-05', results:[]},
    ],
  }, over||{});
  return { gt3, gt4: { drivers:[], teams:[], races:[], news:[], points:PTS } };
}

async function boot(opts={}) {
  const rec = opts.record || league();
  const dotd = opts.dotd !== undefined ? opts.dotd : { ok:true, races:{}, myVotes:{} };
  const posted = [];
  const dom = new JSDOM(read('index.html'), {
    url:'https://fp-league.github.io/FGE/', runScripts:'dangerously', pretendToBeVisual:true,
    beforeParse(w){
      w.scrollTo = () => {};
      w.fetch = async (url, init) => {
        const u = String(url);
        if (u.includes('/api/live')) return { ok:true, json: async()=>({ok:true,status:'idle',running:[],now:Date.now()}) };
        if (u.includes('/api/dotd')) {
          if (init && init.method === 'POST') { posted.push(JSON.parse(init.body)); return { ok:true, json: async()=>opts.voteReply||{ok:true,counted:true,myVote:JSON.parse(init.body).driver,votes:{[JSON.parse(init.body).driver]:1}} }; }
          if (dotd === null) throw new Error('offline');
          return { ok:true, json: async()=>dotd };
        }
        return { ok:true, json: async()=>({record:rec}) };
      };
    },
  });
  const w = dom.window;
  await new Promise(r=>w.addEventListener('load',r));
  const s = w.document.createElement('script'); s.textContent = read('app.js');
  w.document.body.appendChild(s);
  w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
  for(let i=0;i<20;i++) await new Promise(r=>setImmediate(r));
  return { w, posted };
}

(async () => {

console.log('\nWHO CAN STILL WIN IT');
{
  const { w } = await boot();
  w.navigate('standings');
  const h = w.document.getElementById('standingsContent').innerHTML;
  ok('panel shown while races remain', /WHO CAN STILL WIN IT/.test(h));
  ok('counts the remaining round', /1 round left/.test(h), (h.match(/\d+ rounds? left/)||[])[0]);
  ok('21 points still on the table', /up to 21 points/.test(h), (h.match(/up to \d+ points/)||[])[0]);
  // Maxi 20+1+15=36, Morrison 15+20=35, Kai 12+10=22, Rees 10+12=22
  ok('leader leads the championship', /Leads the championship/.test(h));
  ok('everyone still mathematically in it', !/mathematically out/.test(h));

  // Gap column bug: leader must be found by id, not name
  ok('gap column is not negative', !/>-\d+<\/span>\s*<\/td>/.test(h) || !/-3[0-9]/.test(h));
}

console.log('\nTITLE ALREADY DECIDED');
{
  // An exact tie is NOT clinched: Maxi 81, Morrison 60 + 21 still available
  // = 81. A countback would decide it, so the title is still open.
  const tie = league();
  tie.gt3.races[1].results = res('d1','d2','d3','d4');
  tie.gt3.races.push({round:4,name:'R4',date:'2026-03-05',results:res('d1','d2','d3','d4')});
  tie.gt3.races.push({round:5,name:'R5',date:'2026-04-05',results:res('d1','d2','d3','d4')});
  const { w: wt } = await boot({ record: tie });
  wt.navigate('standings');
  const ht = wt.document.getElementById('standingsContent').innerHTML;
  ok('a drawable title is not called won', !/has won the championship/.test(ht));
  ok('still shows the permutations', /WHO CAN STILL WIN IT/.test(ht));

  // Drop Morrison to 3rd once (15 -> 12) and it IS settled: 57 + 21 = 78 < 81
  const won = league();
  won.gt3.races[1].results = res('d1','d3','d2','d4');
  won.gt3.races.push({round:4,name:'R4',date:'2026-03-05',results:res('d1','d2','d3','d4')});
  won.gt3.races.push({round:5,name:'R5',date:'2026-04-05',results:res('d1','d2','d3','d4')});
  const { w } = await boot({ record: won });
  w.navigate('standings');
  const h = w.document.getElementById('standingsContent').innerHTML;
  ok('clinched title detected', /has won the championship/.test(h));
  ok('names the champion', /Maxi/.test(h));
  ok('says how many rounds are left', /1 round to go/.test(h), (h.match(/\d+ rounds? to go/)||[])[0]);
}

console.log('\nSEASON OVER');
{
  const rec = league();
  rec.gt3.races = rec.gt3.races.filter(r => (r.results||[]).length);
  const { w } = await boot({ record: rec });
  w.navigate('standings');
  ok('declares the winner', /wins the championship/.test(w.document.getElementById('standingsContent').innerHTML));
}

console.log('\nDRIVER vs DRIVER');
{
  const { w } = await boot();
  w.navigate('drivers');
  ok('compare button offered', /COMPARE TWO DRIVERS/.test(w.document.getElementById('driversContent').innerHTML));
  w.toggleCompare();
  const h = w.document.getElementById('driversContent').innerHTML;
  ok('two pickers shown', (h.match(/<select/g)||[]).length === 2);
  ok('head-to-head shown', /FINISHED AHEAD/.test(h));
  ok('points row', /POINTS/.test(h));
  ok('average finish row', /AVERAGE FINISH/.test(h));

  // Maxi vs Morrison: R1 Maxi 1st Morrison 2nd; R2 Morrison 1st Maxi 2nd => 1-1
  const n = [...w.document.querySelectorAll('.cmp-h2h-n')].map(e=>e.textContent.trim());
  ok('head-to-head is 1-1', n[0]==='1' && n[1]==='1', n.join('-'));

  w.setCompare('b','d3');   // Maxi vs Kai: Maxi ahead both times
  const n2 = [...w.document.querySelectorAll('.cmp-h2h-n')].map(e=>e.textContent.trim());
  ok('2-0 against Kai', n2[0]==='2' && n2[1]==='0', n2.join('-'));

  w.setCompare('b','d1');
  ok('same driver twice is refused', /Pick two different drivers/.test(w.document.getElementById('driversContent').innerHTML));
}

console.log('\nSTEWARDS');
{
  const { w } = await boot();
  ok('nav hidden with no decisions',
     w.document.getElementById('navStewards').style.display === 'none');
  w.navigate('stewards');
  ok('empty state explains itself', /No decisions this season/.test(w.document.getElementById('stewardsContent').innerHTML));

  const rec = league({ stewards: [
    {round:2, driverId:'d2', penalty:'5 second penalty', reason:'Causing a collision', incident:'Lap 14, turn 9', at:2},
    {round:1, driverId:'d3', penalty:'Warning', reason:'Track limits', at:1},
    {round:2, driverId:'d4', penalty:'Disqualified', reason:'Technical infringement', at:3},
  ]});
  const { w: w2 } = await boot({ record: rec });
  ok('nav appears once something is logged',
     w2.document.getElementById('navStewards').style.display === '');
  w2.navigate('stewards');
  const h = w2.document.getElementById('stewardsContent').innerHTML;
  ok('decision shown', /Causing a collision/.test(h));
  ok('driver named', /Morrison/.test(h));
  ok('incident shown', /Lap 14, turn 9/.test(h));
  ok('grouped by round', (h.match(/stw-round/g)||[]).length === 2, String((h.match(/stw-round/g)||[]).length));
  ok('newest round first', h.indexOf('ROUND 2') < h.indexOf('ROUND 1'));
  ok('disqualification styled hardest', /stw-pen stw-dq/.test(h));
  ok('warning styled as a warning', /stw-pen stw-warn/.test(h));
}

console.log('\nSTEWARDS — escaping');
{
  const rec = league({ stewards:[{round:1,driverId:'d1',penalty:'<img src=x onerror=alert(1)>',reason:'<script>alert(2)</script>',at:1}] });
  const { w } = await boot({ record: rec });
  w.navigate('stewards');
  const el = w.document.getElementById('stewardsContent');
  ok('no img injected', !el.querySelector('img'));
  ok('no script injected', !el.querySelector('script'));
  ok('text preserved', el.textContent.includes('alert(2)'));
}

console.log('\nDOTD — real voting');
{
  const { w, posted } = await boot({ dotd: { ok:true, races:{'1':{Maxi:3,Morrison:1}}, myVotes:{} } });
  w.navigate('dotd');
  for(let i=0;i<8;i++) await new Promise(r=>setImmediate(r));
  let h = w.document.getElementById('dotdContent').innerHTML;
  ok('asks for a vote', /Vote for your Driver of the Day/.test(h));
  ok('percentages hidden before voting', !/dotd-bar/.test(h));

  await w.voteDOTD('Kai');
  for(let i=0;i<6;i++) await new Promise(r=>setImmediate(r));
  ok('vote was POSTed', posted.length === 1, JSON.stringify(posted));
  ok('posts the right driver', posted[0] && posted[0].driver === 'Kai');
  ok('posts a race key', posted[0] && String(posted[0].race).length > 0);
  ok('posts the class', posted[0] && posted[0].class === 'gt3');

  h = w.document.getElementById('dotdContent').innerHTML;
  ok('shows the tally after voting', /dotd-bar/.test(h));
  ok('marks your vote', /YOUR VOTE/.test(h));
  ok('thanks you', /Thanks for voting/.test(h));
}

console.log('\nDOTD — already voted, and offline');
{
  const { w } = await boot({ dotd: { ok:true, races:{'2':{Maxi:2,Morrison:3}}, myVotes:{'2':'Morrison'} } });
  w.navigate('dotd');
  for(let i=0;i<8;i++) await new Promise(r=>setImmediate(r));
  const h = w.document.getElementById('dotdContent').innerHTML;
  ok('previous vote restored across devices', /YOUR VOTE/.test(h));
  ok('tally visible', /60%|40%/.test(h), (h.match(/\d+%/g)||[]).join(','));

  const { w: w2 } = await boot({ dotd: null });
  w2.navigate('dotd');
  for(let i=0;i<8;i++) await new Promise(r=>setImmediate(r));
  const h2 = w2.document.getElementById('dotdContent').innerHTML;
  ok('offline is stated, not faked', /Voting is offline/.test(h2));
  ok('cards are not clickable offline', !/onclick="voteDOTD/.test(h2));
}

console.log('\nRACE CONTROL — shortcuts and quali grid (source)');
{
  const m = read('manage.html');
  ok('key map present', /RC_KEYS = \{ f:'formation', g:'green', s:'sc', v:'vsc', r:'red', c:'chequered' \}/.test(m));
  ok('ignores typing in fields', /tag === 'input' \|\| tag === 'textarea'/.test(m));
  ok('only on the race control tab', /currentSec !== 'control'/.test(m));
  ok('red flag asks first', /Throw a RED FLAG\?/.test(m));
  ok('quali hides the flags it has not got', /\['formation','sc','vsc'\]\.includes\(status\)/.test(m));
  ok('grid-from-quali exists', /function rcGridFromQuali/.test(m));
  ok('grid clears laps and un-retires', /lap: '', gap: '', out: false/.test(m));
  ok('entry list reads availability', /av\[drv\.id \|\| drv\.name\] === 'out'/.test(m));
  ok('announce sends only class and round', /JSON\.stringify\(\{ class: adminClass\.toLowerCase\(\), round \}\)/.test(m));
}

console.log('\nCUSTOM CARDS — clearing a batch of old art');
{
  const m = read('manage.html');
  ok('rows can be ticked', /class="cc-tick" data-id=/.test(m));
  ok('a rarity chip takes the whole tier', /function ecPickRarity/.test(m));
  ok('clicking it again lets them go', /allOn \? ccPicked\.delete\(c\.id\) : ccPicked\.add\(c\.id\)/.test(m));
  ok('the bar only exists when something is picked', /bar\.style\.display = n \? 'flex' : 'none'/.test(m));
  ok('deleting a batch still asks first', /showDelConfirm\(this, 'ecDeletePicked\(\)'\)/.test(m));
  ok('a card deleted elsewhere cannot stay selected',
     /ccPicked\.forEach\(id => \{ if \(!live\.has\(id\)\) ccPicked\.delete\(id\); \}\)/.test(m));
  ok('the one-at-a-time delete is still there', /ecDeleteCard\(/.test(m));
  ok('the tick has a label for screen readers', /aria-label="Select \$\{esc\(c\.name\)\}"/.test(m));
  ok('and the chip is reachable by keyboard', /onkeydown="if\(event\.key==='Enter'/.test(m));

  const i = read('worker/src/index.js');
  ok('the worker takes a list', /case 'deleteCards'/.test(i));
  const e = read('worker/src/economy.js');
  ok('which is capped', /\.slice\(0, 200\)/.test(e));
  ok('and chunked, because D1 will not take an unbounded batch',
     /const CHUNK = 25/.test(e));
}

console.log('\nTHE NEW CASINO GAMES');
{
  const cm = read('worker/src/commands.js'), i = read('worker/src/index.js'),
        g = read('worker/src/games.js');
  ok('slots is registered', /name: 'slots'/.test(cm));
  ok('higher or lower is registered', /name: 'higherlower'/.test(cm));
  ok('both take a stake',
     /name: 'slots'[\s\S]{0,220}name: 'bet'/.test(cm) &&
     /name: 'higherlower'[\s\S]{0,240}name: 'bet'/.test(cm));
  ok('slots is routed', /case 'slots':/.test(i));
  ok('higher or lower is routed', /case 'higherlower':/.test(i));
  ok('its buttons are routed', /tag === 'hl'/.test(g));

  // Both must respect the same switch and the same limits as the rest.
  ok('slots closes with the casino', /playSlots[\s\S]{0,400}casinoOff\(cfg\)/.test(g));
  ok('so does higher or lower', /startHiLo[\s\S]{0,400}casinoOff\(cfg\)/.test(g));
  ok('both take the stake through the shared limits',
     /playSlots[\s\S]{0,500}takeStake\(/.test(g) && /startHiLo[\s\S]{0,500}takeStake\(/.test(g));

  // The pot cannot run away.
  ok('a run is capped', /HL_MAX_STREAK = \d+/.test(g));
  ok('and so is the deck', /HL_MIN_DECK = \d+/.test(g));
  ok('the price is fixed before the card is drawn',
     g.indexOf('const mult = hiLoMultiplier(') < g.indexOf('const next = deck.pop();'));
}

console.log('\nEND OF SEASON');
{
  const a = read('app.js'), m = read('manage.html'), c = read('styles.css'),
        h = read('index.html');

  // The recap is computed from races that are about to be deleted, so
  // order is the whole correctness story here.
  ok('the recap is written before the calendar is cleared',
     m.indexOf('cd.finale = window.seasonFinale') < m.indexOf('cd.races = [];'));
  ok('and a broken recap cannot stop a season ending',
     /catch \(err\) \{[\s\S]{0,400}cd\.finale = null;/.test(m));
  ok('both pages can reach it', /window\.seasonFinale/.test(h) && /window\.seasonFinale/.test(m));

  ok('it plays from the render path', /maybePlayFinale\(currentClass, dataFor\(currentClass\)\)/.test(a));
  ok('and never blocks the page if it throws',
     /try \{ maybePlayFinale[\s\S]{0,120}catch \(e\)/.test(a));
  ok('nothing to celebrate shows nothing', /if \(!f \|\| !f\.champion\) return;/.test(a));
  ok('an old season is not news', /FINALE_DAYS \* 864e5/.test(a));
  ok('it plays once per visitor', /if \(finaleSeen\(key\)\) return;/.test(a));
  ok('and only counts as seen once it is on screen',
     a.indexOf('document.body.appendChild(el)') < a.indexOf('markFinaleSeen(key)'));
  ok('storage that throws does not break it',
     /catch \(e\) \{ return false; \}/.test(a));

  // It must never trap anyone.
  ok('escape closes it', /if \(e\.key === 'Escape'\) \{ closeFinale\(\); return; \}/.test(a));
  ok('focus is kept inside while it is open', /e\.key !== 'Tab'/.test(a));
  ok('the backdrop closes it', /if \(e\.target === el\) closeFinale\(\)/.test(a));
  ok('closing releases the scroll lock', /document\.body\.style\.overflow = '';/.test(a));
  ok('and unbinds the key handler', /removeEventListener\('keydown', finaleKeys\)/.test(a));
  ok('and clears its timers', /finaleTimers\.forEach\(clearTimeout\)/.test(a));
  ok('it is announced as a dialog', /setAttribute\('aria-modal', 'true'\)/.test(a));

  ok('reduced motion skips the reveal', /el\.classList\.add\('fin-all'\);\s*\n\s*return;/.test(a));
  ok('and the stylesheet agrees',
     /@media \(prefers-reduced-motion: reduce\) \{[\s\S]{0,160}\.fin-stage \{ opacity: 1/.test(c));
  ok('the overlay is opaque, so the page cannot ghost through',
     /\.fin \{[\s\S]{0,400}background: var\(--page-deep\);/.test(c));
  ok('names that do not fit still wrap', /\.fin-champ \{[\s\S]{0,260}overflow-wrap: anywhere/.test(c));
}

console.log('\nTHREE DIVISIONS, NOT TWO');
{
  const a = read('app.js'), h = read('index.html'), c = read('styles.css');
  ok('the site lists its divisions once', /const CLASSES = \['gt3', 'gt4', 'truck'\]/.test(a));
  ok('and nothing still spells the old pair out',
     !/\['gt3', ?'gt4'\]/.test(a.replace(/const CLASSES = .*/, '')));
  ok('the switcher has a Truck button', /id="csTRUCK"/.test(h));
  ok('which carries the supplied artwork', /src="truck-logo\.webp"/.test(h));
  ok('shown at its own size rather than scaled up',
     /class="cs-logo cs-logo-sm" width="42" height="18"/.test(h));
  ok('signup offers it too', /<option value="truck">/.test(h));
  ok('the body gets one mode class per division',
     /`\$\{k\}-mode`, classKey\(cls\) === k/.test(a));

  // White accent: the thing every other class could take for granted is
  // that white text reads on the fill. Here the fill IS white.
  ok('there is a token for text on the fill', /--class-fill-ink: #fff;/.test(c));
  ok('truck flips it to near-black', /body\.truck-mode[\s\S]{0,400}--class-fill-ink: #121214/.test(c));
  ok('and no rule still hardcodes white on the fill',
     !/background: var\(--class-fill\); color: #fff/.test(c));
  ok('the footer text follows the token too',
     /\.footer-content p \{\s*color: var\(--class-fill-ink\)/.test(c));
  ok('primary button keeps a hover, since white cannot brighten',
     /body\.truck-mode \.btn-primary:hover \{ filter: brightness\(0\.88\); \}/.test(c));

  const cl = read('worker/src/classes.js');
  ok('the worker lists its divisions once too', /CLASSES = \['gt3', 'gt4', 'truck'\]/.test(cl));
  ok('an unknown division falls back rather than throwing',
     /CLASSES\.includes\(k\) \? k : CLASSES\[0\]/.test(cl));
  ok('truck has an embed colour', /truck: 0xFFFFFF/.test(cl));
  ok('and its own announce channel by name',
     /ANNOUNCE_CHANNEL_\$\{CLASS_LABEL\[normClass\(cls\)\]\}/.test(cl));
  // The white accent broke two things no other class could break.
  ok('the logo block is dropped, not painted white over white artwork',
     /body\.truck-mode \.nav-logo \.logo-img \{[\s\S]{0,120}background: transparent/.test(c));
  ok('and replaced with a rule so the mark still reads',
     /body\.truck-mode \.nav-logo \.logo-img \{[\s\S]{0,200}border-left: 3px solid var\(--class-color\)/.test(c));
  ok('the hero copy is held clear of the slab on a phone',
     /body\.truck-mode \.hero-inner \{ max-width: 68%; \}/.test(c));
  ok('and tighter still on the smallest screens',
     /body\.truck-mode \.hero-inner \{ max-width: 74%; \}/.test(c));

  ok('the angled strip under the bar is truck-only',
     /body\.truck-mode \.navbar::after/.test(c));
  ok('buttons get a cut corner', /body\.truck-mode \.btn-primary,[\s\S]{0,120}clip-path: polygon/.test(c));
  ok('the calendar is denser', /body\.truck-mode \.cal-card \{[\s\S]{0,80}padding: 0\.8rem 0\.9rem/.test(c));

  // Scoping: none of it may leak to the other two divisions.
  const truckRules = (c.match(/^body\.truck-mode[^\n]*/gm) || []);
  ok('every truck rule is scoped to the body class', truckRules.length >= 8, String(truckRules.length));
  ok('and nothing styles truck without that scope',
     !/^\.truck-/m.test(c), 'an unscoped .truck- rule exists');

  // The hero car is per division, and only Truck's changed.
  ok('the hero image can be addressed', /class="hero-car" id="heroCar"/.test(h));
  ok('gt3 and gt4 still share the Porsche',
     /gt3: GT_CAR,\s*\n\s*gt4: GT_CAR,/.test(a));
  ok('truck has its own art', /truck: \{ src: 'truck-car\.webp'/.test(a));
  // A stale srcset silently wins over a new src, so it has to be removed,
  // not just left behind when swapping to an image that has none.
  ok('swapping away from the Porsche clears its srcset',
     /img\.removeAttribute\('srcset'\)/.test(a));
  ok('and its sizes with it', /img\.removeAttribute\('sizes'\)/.test(a));
  ok('the swap runs on a class change', /applyClassCar\(cls\)/.test(a));
  ok('and on first paint', /applyClassCar\(currentClass\)/.test(a));
  ok('truck art is positioned clear of the slab',
     /body\.truck-mode \.hero-car \{[\s\S]{0,120}right: 20%/.test(c));

  ok('the bot offers a /truck command',
     /name: 'truck', description: 'Trucks/.test(read('worker/src/commands.js')));
}

console.log('\nWORKER — announce endpoint');
{
  const i = read('worker/src/index.js');
  ok('route present', /pathname === '\/api\/announce'/.test(i));
  ok('admin token required', /postAnnounce[\s\S]{0,300}X-Admin-Token/.test(i));
  ok('explains what to set when neither route is configured',
     /set ANNOUNCE_CHANNEL_GT3 \/ ANNOUNCE_CHANNEL_GT4/.test(i));
  ok('can post as the bot without a webhook secret',
     /const viaBot = Boolean\(env\.DISCORD_TOKEN && channel\)/.test(i));
  ok('picks the channel for the class',
     /const channel = announceChannel\(env, cls\)/.test(i));
  ok('class is defined before the channel lookup uses it',
     i.indexOf("const cls = normClass(body.class)") <
     i.indexOf("announceChannel(env, cls)"));
  ok('cache busted before reading', /leagueCache = \{ at: 0, data: null \}/.test(i));
  ok('reuses buildResults', /buildResults\(cd, cls, round\)/.test(i));
  ok('health reports either route', /announce: Boolean\(env\.DISCORD_WEBHOOK_URL \|\| \(env\.DISCORD_TOKEN/.test(i));
  ok('grant endpoint present', /pathname === '\/api\/cards\/grant'/.test(i));
  ok('grant requires the admin token', /postGrantPacks[\s\S]{0,250}X-Admin-Token/.test(i));
  ok('grant validates the user id', /\^\\d\{5,25\}\$/.test(i));
  ok('mode validated', /mode must be race or quali/.test(i));
}


console.log('\nCARD GALLERY');
{
  const { w } = await boot();
  w.navigate('cards');
  const el = w.document.getElementById('cardsContent');
  const h = el.innerHTML;
  ok('every driver gets a card', el.querySelectorAll('.tc').length === 4,
     String(el.querySelectorAll('.tc').length));
  ok('explains that collecting is in Discord', /\/cards pack/.test(h));
  // One set now: the cards page shows GT3 and GT4 together rather than
  // whichever class the rest of the site is on.
  ok('set size stated', /4 cards in the set/.test(h), (h.match(/\d+ cards in the set[^<]*/)||[])[0]);
  ok('rarity key shown', /tc-key/.test(h));
  ok('grouped by rarity', el.querySelectorAll('.tc-head').length >= 2,
     String(el.querySelectorAll('.tc-head').length));

  // The count sits in a span with no space before it, so strip the digits.
  const heads = [...el.querySelectorAll('.tc-head')]
      .map(x => x.textContent.trim().replace(/\d+/g, '').trim());
  const order = ['LEGENDARY','EPIC','RARE','UNCOMMON','COMMON'];
  const idx = heads.map(x => order.indexOf(x));
  ok('rarest section first', idx.every((v,i) => i===0 || v > idx[i-1]), heads.join(' > '));
  ok('leader is legendary', heads[0] === 'LEGENDARY', heads.join(','));

  const first = el.querySelector('.tc');
  ok('card shows the name', /Maxi/.test(first.textContent));
  ok('card shows stats', /PTS/.test(first.textContent) && /WINS/.test(first.textContent));
  ok('card is keyboard reachable', first.getAttribute('tabindex') === '0');
}

console.log('\nSITE AND BOT AGREE ON RARITY');
{
  const { w } = await boot();
  const siteSet = w.eval('cardSetFor(cls()).map(c => c.drv.name + ":" + c.rarity).join(",")');
  ok('a rarity for everyone', siteSet.split(',').length === 4, siteSet);
  ok('exactly one legendary', siteSet.split(',').filter(x => x.endsWith(':legendary')).length === 1, siteSet);
  ok('the leader is the legendary', /Maxi:legendary/.test(siteSet), siteSet);
}

console.log('\nCARD GALLERY — escaping');
{
  const rec = league();
  rec.gt3.drivers = [{ id:'x', name:'<script>alert(1)</script>', team:'"><b>x</b>',
                       number:'<img src=y onerror=alert(2)>', photo:'' }];
  rec.gt3.races = [];
  const { w } = await boot({ record: rec });
  w.navigate('cards');
  const el = w.document.getElementById('cardsContent');
  ok('no script injected', !el.querySelector('script'));
  // .tc-stats uses <b> legitimately, so check the team cell specifically.
  ok('team name cannot inject markup', el.querySelector('.tc-team').children.length === 0);
  ok('team name kept as text', el.querySelector('.tc-team').textContent.includes('<b>'));
  ok('name kept as text', el.querySelector('.tc-name').textContent.includes('alert(1)'));
  ok('number kept as text', el.querySelector('.tc-num').textContent.includes('onerror'));
}

console.log(`\n${pass}/${pass+fail} passed`);
process.exit(fail?1:0);
})().catch(e=>{console.error(e);process.exit(1);});
