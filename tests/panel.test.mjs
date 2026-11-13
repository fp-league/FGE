/**
 * The admin panel, actually driven.
 *
 * Every other test of manage.html reads its source and matches patterns.
 * That is why End Season could call a variable that does not exist for
 * weeks: the text was all present and correct, and nothing ever pressed
 * the button.
 *
 * This loads the real page into jsdom, runs its real scripts, stubs the
 * network, and calls the real functions. Two things make that work and
 * both were learned the hard way:
 *
 *   - jsdom must run scripts for real. Evaluating the script text with
 *     win.eval() looks equivalent and is not: `let` inside an eval is
 *     private to that eval, so the page's functions close over a copy of
 *     the state that nothing outside can reach, and every assertion is
 *     made against a ghost.
 *   - setup has to go in via a <script> element for the same reason.
 *     window.adminData = x makes a property the page never reads.
 */
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL  ' + n + (x ? '  →  ' + x : '')); } };

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const html = fs.readFileSync(path.join(ROOT, 'manage.html'), 'utf8');
const season = await import(path.join(ROOT, 'lib/season.js'));

const DRIVERS = [{ id:'a', name:'Ana', team:'Red' }, { id:'b', name:'Bo', team:'Blue' },
                 { id:'c', name:'Cy', team:'Red' }];
const SCORED = [
  { round:1, name:'Opener', results:[{driverId:'c',pos:1},{driverId:'b',pos:2},{driverId:'a',pos:3}] },
  { round:2, name:'Finale', results:[{driverId:'a',pos:1},{driverId:'b',pos:2},{driverId:'c',pos:3}] },
];
const record = races => ({
  gt3: { drivers: DRIVERS, teams: [{ name:'Red' }], news: [], seasonName: 'Season 4',
         points: { table:[25,18,15], fastestLap:1, dotd:1 }, races },
  gt4: { drivers: [], teams: [], races: [], news: [] },
});

/** Load the panel with a given record and a given reply from /api/archive. */
/** Every window opened, so they can all be shut: the page leaves timers
 *  running and an open jsdom window keeps Node alive for ever. */
const OPEN = [];

async function panel(rec, archiveReply, savePut = () => ({ ok: true, status: 200, text: async () => '{}' })) {
  const calls = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://fp-league.github.io/FGE/manage.html',
    beforeParse(win) {
      win.__toasts = [];
      win.fetch = async (url, opt = {}) => {
        const u = String(url);
        calls.push((opt.method || 'GET') + ' ' + u.replace(/^https?:\/\/[^/]+/, ''));
        if (u.includes('/latest')) return { ok: true, json: async () => ({ record: rec }) };
        if (u.includes('/api/archive') && (opt.method === 'POST')) return archiveReply();
        if (opt.method === 'PUT' && u.includes('/v3/b/')) return savePut();
        return { ok: true, status: 200, text: async () => '{}',
                 json: async () => ({ ok: true, name: 'Season 4' }) };
      };
      win.alert = () => {}; win.confirm = () => true;
      // The page logs its own failures, which is the point of them; here
      // they are collected rather than printed so a passing run is quiet.
      win.__logged = [];
      win.console.error = (...a) => win.__logged.push(a.map(String).join(' '));
    },
  });
  const win = dom.window;
  OPEN.push(win);
  await new Promise(r => setTimeout(r, 300));
  win.seasonSummary = season.seasonSummary;
  win.seasonFinale = season.seasonFinale;

  const run = code => {
    const el = win.document.createElement('script');
    el.textContent = code;
    win.document.body.appendChild(el);
    el.remove();
  };
  // Run the page's own loader against the stubbed record and see what it
  // makes of it. The panel only loads after a login, so this has to be
  // called rather than waited for.
  run('window.__loaded = loadData();');
  try { await win.__loaded; } catch { /* reported by the assertions */ }
  const afterLoad = win.eval('adminData ? Object.keys(adminData).sort().join() : "(null)"');
  run(`adminData = ${JSON.stringify(rec)};
       CLASSES.forEach(k => { if (!adminData[k]) adminData[k] = emptyClass(); });
       adminClass = 'GT3';
       toast = (m, k) => window.__toasts.push(String(m));`);
  return { win, calls, run, afterLoad,
    end: async () => {
      run(`window.__done = (async () => { try { await endSeason(); return 'ok'; }
             catch (e) { return 'UNCAUGHT ' + e.message; } })();`);
      return win.__done;
    },
    last: () => win.__toasts[win.__toasts.length - 1] || '',
    races: () => win.eval('adminData.gt3.races.length'),
    finale: () => win.eval('adminData.gt3.finale ? adminData.gt3.finale.champion.name : null'),
  };
}

const goodArchive = () => ({ ok: true, status: 200,
  text: async () => JSON.stringify({ ok: true, name: 'Season 4' }) });

console.log('THE PAGE LOADS AND ITS STATE IS REACHABLE');
{
  const p = await panel(record(SCORED), goodArchive);
  ok('endSeason exists', p.win.eval('typeof endSeason') === 'function');
  // The check that makes every assertion below meaningful.
  ok('the page sees the record we gave it', p.races() === 2, String(p.races()));
  ok('and d() returns that same object', p.win.eval('d() === adminData.gt3') === true);
}

console.log('\nTHE PANEL KNOWS EVERY DIVISION');
{
  // The site and the bot both learned about Truck; the panel did not, so
  // there was no way to add a truck driver, race or result, and no way to
  // end a truck season.
  const p = await panel(record(SCORED), goodArchive);
  const win = p.win, doc = win.document;

  ok('it lists three divisions', win.eval('CLASSES.length') === 3, win.eval('CLASSES.join()'));
  ok('and the same ones the site does',
     win.eval('CLASSES.join()') === 'gt3,gt4,truck', win.eval('CLASSES.join()'));

  for (const label of ['GT3', 'GT4', 'TRUCK']) {
    ok(`there is a ${label} pill`, !!doc.getElementById('cp' + label));
  }

  // Switching must light the right pill and only the right pill.
  win.eval("switchClass('TRUCK')");
  ok('switching sets the division', win.eval('adminClass') === 'TRUCK', win.eval('adminClass'));
  ok('the truck pill is active', /\bactive\b/.test(doc.getElementById('cpTRUCK').className),
     doc.getElementById('cpTRUCK').className);
  ok('and the others are not',
     !/\bactive\b/.test(doc.getElementById('cpGT3').className) &&
     !/\bactive\b/.test(doc.getElementById('cpGT4').className));
  ok('the accent follows the division',
     win.eval("document.documentElement.style.getPropertyValue('--accent').trim()") === '#FFFFFF',
     win.eval("document.documentElement.style.getPropertyValue('--accent')"));

  win.eval("switchClass('GT3')");
  ok('switching back restores red',
     win.eval("document.documentElement.style.getPropertyValue('--accent').trim()") === '#E10600');
  ok('and the gt3 pill', /\bactive\b/.test(doc.getElementById('cpGT3').className));

  // The record we served has only gt3 and gt4, exactly like the real one
  // written before Truck existed. Editing Truck at all depends on the
  // page filling that gap when it loads.
  ok('loading a record without Truck still creates it',
     p.afterLoad === 'gt3,gt4,truck', p.afterLoad);
  ok('and the divisions that were there survive',
     win.eval('adminData.gt3.races.length') === 2, String(win.eval('adminData.gt3.races.length')));

  // d() has to follow the switch, or every section edits the wrong class.
  win.eval("switchClass('TRUCK')");
  ok('the editor follows the switch', win.eval('d() === adminData.truck') === true);
  ok('and truck starts empty', win.eval('d().races.length') === 0);
  win.eval("switchClass('GT3')");

  // A white accent breaks the one thing the other two take for granted:
  // that white text reads on a button filled with it.
  ok('there is a token for text on the accent fill',
     /--accent-ink:\s*#fff/.test(html));
  ok('and the filled button uses it, not plain white',
     /\.btn-white\s*\{ background:var\(--accent\); color:var\(--accent-ink\); \}/.test(html));
  win.eval("switchClass('GT3')");
  ok('gt3 keeps white text on its red fill',
     win.eval("document.documentElement.style.getPropertyValue('--accent-ink').trim()") === '#fff');
  win.eval("switchClass('TRUCK')");
  ok('truck flips it to near-black',
     win.eval("document.documentElement.style.getPropertyValue('--accent-ink').trim()") === '#0A0A0C',
     win.eval("document.documentElement.style.getPropertyValue('--accent-ink')"));
  ok('and truck gets the inverted hover, since white cannot brighten',
     win.document.body.classList.contains('truck-admin'));
  win.eval("switchClass('GT4')");
  ok('which is dropped again for the others',
     !win.document.body.classList.contains('truck-admin'));
  win.eval("switchClass('GT3')");

  // A backup from before Truck must not wipe it.
  win.eval(`pendingRestore = { gt3: { drivers:[], teams:[], races:[], news:[] } };
            adminData.truck = adminData.truck || emptyClass();
            adminData.truck.drivers = [{ id:'t1', name:'Keeper' }];`);
  ok('restoring an older backup keeps a division it does not mention',
     win.eval(`CLASSES.forEach(k => { adminData[k] = pendingRestore[k] || adminData[k] || emptyClass(); });
               adminData.truck.drivers.length`) === 1,
     String(win.eval('adminData.truck.drivers.length')));
}

console.log('\nTHE CONFIRM ON A DESTRUCTIVE BUTTON');
{
  // The helper used to overwrite btn.closest('.td-actions'). END SEASON
  // and the cards' ARCHIVE AND CLEAR sit in .form-actions, so that was
  // null, assigning to it threw, and both buttons did nothing at all —
  // no confirm, no toast, nothing to see.
  const p = await panel(record(SCORED), goodArchive);
  const win = p.win, doc = win.document;

  const endBtn = [...doc.querySelectorAll('button')]
    .find(b => (b.getAttribute('onclick') || '').includes('endSeason'));
  ok('the END SEASON button exists', !!endBtn);
  ok('and it is NOT inside a table cell', endBtn && !endBtn.closest('.td-actions'),
     endBtn ? endBtn.parentElement.className : '');

  // The press itself must not throw.
  let threw = null;
  try { win.eval('showDelConfirm(' +
    '[...document.querySelectorAll("button")].find(b => (b.getAttribute("onclick")||"").includes("endSeason")),' +
    ' "endSeason()")'); } catch (e) { threw = e.message; }
  ok('pressing it does not throw', threw === null, String(threw));

  const confirm = doc.querySelector('.del-ask');
  ok('a confirm appears', !!confirm);
  // Existing is not the same as visible. The first version of this fix
  // reused a class the stylesheet already defined as display:none, so the
  // button was replaced by something nobody could see and simply vanished.
  ok('and can actually be seen',
     confirm && win.getComputedStyle(confirm).display !== 'none',
     confirm ? win.getComputedStyle(confirm).display : 'no element');
  ok('as can its YES',
     confirm && win.getComputedStyle(confirm.querySelector('.btn-confirm')).display !== 'none');
  ok('it asks', /Sure\?/.test(confirm ? confirm.textContent : ''), confirm && confirm.textContent);
  ok('with a YES that calls the action',
     (confirm.querySelector('.btn-confirm').getAttribute('onclick') || '') === 'endSeason()');
  ok('and a NO', !!confirm.querySelector('[data-cancel]'));

  // The neighbours must survive. Overwriting the container ate them.
  const stillThere = [...doc.querySelectorAll('button')]
    .some(b => (b.getAttribute('onclick') || '').includes('archiveOnly'));
  ok('the buttons beside it are untouched', stillThere);

  // NO puts the original back, with no re-render needed.
  confirm.querySelector('[data-cancel]').dispatchEvent(new win.Event('click', { bubbles: true }));
  const back = [...doc.querySelectorAll('button')]
    .find(b => (b.getAttribute('onclick') || '').includes('endSeason'));
  ok('saying no restores the button', !!back, 'button did not come back');
  ok('and the confirm is gone', !doc.querySelector('.del-ask'));

  // The same helper must still work in the place it always worked.
  const row = doc.createElement('div');
  row.innerHTML = '<div class="td-actions"><button id="rowBtn">DEL</button></div>';
  doc.body.appendChild(row);
  let rowThrew = null;
  try { win.eval('showDelConfirm(document.getElementById("rowBtn"), "void 0")'); }
  catch (e) { rowThrew = e.message; }
  ok('a table-row button still confirms', rowThrew === null, String(rowThrew));
  ok('and gets its confirm', !!row.querySelector('.del-ask'));
  ok('which is visible too',
     win.getComputedStyle(row.querySelector('.del-ask')).display !== 'none',
     win.getComputedStyle(row.querySelector('.del-ask')).display);

  // The cards button had the identical fault.
  const cardBtn = [...doc.querySelectorAll('button')]
    .find(b => (b.getAttribute('onclick') || '').includes('endCardSeason(true)'));
  if (cardBtn) {
    let cardThrew = null;
    try { win.eval('showDelConfirm(' +
      '[...document.querySelectorAll("button")].find(b => (b.getAttribute("onclick")||"").includes("endCardSeason(true)")),' +
      ' "endCardSeason(true)")'); } catch (e) { cardThrew = e.message; }
    ok('the cards archive-and-clear button also confirms', cardThrew === null, String(cardThrew));
  }
}

console.log('\nENDING A SEASON');
{
  const p = await panel(record(SCORED), goodArchive);
  const out = await p.end();
  ok('it completes', out === 'ok', out);
  ok('it says so', /is in the archive/.test(p.last()), p.last());
  ok('the calendar is cleared', p.races() === 0, String(p.races()));
  ok('the season is renamed', p.win.eval('adminData.gt3.seasonName') === 'Season 5',
     p.win.eval('adminData.gt3.seasonName'));
  ok('the recap is written', p.finale() === 'Ana', String(p.finale()));
  ok('it backed up first', p.calls.some(c => c.includes('/api/backups')));
  ok('then archived', p.calls.some(c => c.includes('POST /api/archive')));
  ok('and only then saved', p.calls.findIndex(c => c.includes('POST /api/archive')) <
                            p.calls.findIndex(c => c.startsWith('PUT /v3/b/')));
}

console.log('\nWHEN IT CANNOT, IT SAYS WHY AND CHANGES NOTHING');
{
  const empty = await panel(record([]), goodArchive);
  await empty.end();
  ok('no races names the division', /GT3 has no races/.test(empty.last()), empty.last());

  const unscored = await panel(record([{ round:1, name:'Opener', results: [] }]), goodArchive);
  await unscored.end();
  ok('races with no results says how many',
     /GT3 has 1 race but none with results/.test(unscored.last()), unscored.last());
  ok('and leaves the calendar alone', unscored.races() === 1, String(unscored.races()));

  // An auth wall returns HTML. Parsing that as JSON used to throw
  // "Unexpected token '<'", which told nobody anything.
  const denied = await panel(record(SCORED),
    () => ({ ok: false, status: 401, text: async () => '<html>Unauthorized</html>' }));
  await denied.end();
  ok('a 401 reports the status', /replied 401/.test(denied.last()), denied.last());
  ok('and shows what came back', /Unauthorized/.test(denied.last()), denied.last());
  ok('nothing was cleared', denied.races() === 2, String(denied.races()));

  const blank = await panel(record(SCORED),
    () => ({ ok: false, status: 500, text: async () => '' }));
  await blank.end();
  ok('an empty 500 is still legible', /replied 500 with an empty body/.test(blank.last()),
     blank.last());
  ok('and changed nothing', blank.races() === 2);

  const refused = await panel(record(SCORED),
    () => ({ ok: false, status: 409, text: async () => JSON.stringify({ ok:false, error:'already archived' }) }));
  await refused.end();
  ok('a real error message is passed through', /already archived/.test(refused.last()),
     refused.last());
  ok('and the full error is logged for the console',
     refused.win.__logged.some(l => /endSeason failed/.test(l)),
     JSON.stringify(refused.win.__logged));
  ok('and nothing moved', refused.races() === 2);
  ok('no save was attempted on any failure',
     !refused.calls.some(c => c.startsWith('PUT /v3/b/')), refused.calls.join(', '));
}

OPEN.forEach(w => { try { w.close(); } catch { /* already gone */ } });

console.log('\nWHEN THE ARCHIVE WORKS BUT THE SAVE DOES NOT');
{
  // saveData reports failure by returning false rather than throwing, so
  // endSeason used to go on and announce a cleared calendar that was
  // still full — while the archive had in fact been written.
  const p = await panel(record(SCORED), goodArchive,
    () => ({ ok: false, status: 429, text: async () => 'Too Many Requests' }));
  const out = await p.end();
  ok('it does not throw', out === 'ok', out);
  ok('it does not claim the season rolled over',
     !/starts with the same grid/.test(p.last()), p.last());
  ok('it says the archive is safe', /IS archived and safe/.test(p.last()), p.last());
  ok('and that the save is what failed', /Clearing the calendar failed to save/.test(p.last()),
     p.last());
  ok('the archive really was written', p.calls.some(c => c.includes('POST /api/archive')));
  ok('and a save really was attempted', p.calls.some(c => c.startsWith('PUT /v3/b/')));
}

console.log(`\n${pass}/${pass + fail} passed`);
// The page's own timers would otherwise hold the process open.
process.exit(fail ? 1 : 0);
