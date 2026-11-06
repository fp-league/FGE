/**
 * Choosing what the model sees, tested against the real files.
 *
 * A model that is not shown `.hero` cannot edit `.hero`. These run real
 * requests against the actual index.html, styles.css and app.js, so a
 * change that makes the picker worse shows up as the right rule no longer
 * being in the slice.
 */
import fs from 'node:fs';
import path from 'node:path';
import { keywords, chunk, score, pickContext, checkEdit, diffOf, rankPaths }
  from '../worker/src/context.js';

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL  ' + n + (x ? '  →  ' + x : '')); } };

const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const FILES = {
  'index.html': fs.readFileSync(path.join(root, 'index.html'), 'utf8'),
  'styles.css': fs.readFileSync(path.join(root, 'styles.css'), 'utf8'),
  'app.js': fs.readFileSync(path.join(root, 'app.js'), 'utf8'),
};

console.log('KEYWORDS');
{
  ok('the subject survives', keywords('make the hero blue').includes('hero'));
  ok('and the modifier', keywords('make the hero blue').includes('blue'));
  ok('filler is dropped', !keywords('can you please make the hero blue').includes('please'));
  ok('order is kept', keywords('make the hero blue')[0] === 'hero',
     keywords('make the hero blue').join());
  ok('two-letter words go', !keywords('fix the nav at top').includes('at'));
  ok('hyphens hold together', keywords('fix the class-switcher').includes('class-switcher'));
  ok('nothing from nothing', keywords('').length === 0);
  ok('a request of only filler gives nothing', keywords('please can you').length === 0);
}

console.log('\nCHUNKING');
{
  const cs = chunk(FILES['styles.css'], 'styles.css');
  ok('the stylesheet is cut up', cs.length > 50, String(cs.length));
  ok('no chunk is enormous', cs.every(c => c.text.split('\n').length <= 60),
     String(Math.max(...cs.map(c => c.text.split('\n').length))));
  ok('line numbers run forward', cs.every(c => c.end >= c.start));
  ok('nothing is empty', cs.every(c => c.text.trim().length > 0));

  // Every line of the file has to be in exactly one chunk, or an edit can
  // be asked for against text the model was never shown.
  const total = cs.reduce((a, c) => a + c.text.split('\n').length, 0);
  const real = FILES['styles.css'].split('\n').length;
  ok('the whole file is covered, once', Math.abs(total - real) <= 1, `${total} vs ${real}`);
}

console.log('\nTHE RIGHT SLICE COMES BACK');
{
  // Each of these is a request someone would actually type, with the
  // thing the model must be able to see in order to answer it.
  // Each wants ANY of the listed anchors: "the next race card" means two
  // real things in this codebase — the white card on the home page and
  // the calendar's own race card — and surfacing either gives the model
  // something it can legitimately act on. Demanding one specific rule
  // would be testing my guess about the request, not the picker.
  const cases = [
    ['make the hero headline smaller',          ['.hero-title']],
    ['the footer bar should be darker',         ['.footer']],
    ['change the next race card background',    ['.nb-card', '.cal-card']],
    ['rename the standings tab',                ['standings']],
    ['the countdown should say days not hours', ['countdown', 'cb-units']],
  ];
  for (const [request, anchors] of cases) {
    const { text, chunks } = pickContext(FILES, request);
    const hit = anchors.some(a => text.includes(a));
    ok(`"${request}" surfaces ${anchors.join(' or ')}`, hit,
       chunks.length ? chunks.map(c => `${c.path}:${c.start}`).join(' ') : 'nothing picked');
    ok(`  ...and stays inside the budget`, text.length <= 6400, String(text.length));
  }
}

console.log('\nTHE BUDGET HOLDS');
{
  const { text } = pickContext(FILES, 'hero title footer nav card table button colour');
  ok('a request that matches everything is still bounded', text.length <= 6400, String(text.length));
  ok('and still returns something useful', text.length > 1000, String(text.length));

  const tiny = pickContext(FILES, 'hero', 500);
  ok('a small budget is respected', tiny.text.length <= 600, String(tiny.text.length));

  const none = pickContext(FILES, 'zzzqqq nonexistent gibberish');
  ok('a request matching nothing returns nothing', none.chunks.length === 0,
     String(none.chunks.length));
  ok('rather than everything', none.text === '');
}

console.log('\nCHOOSING WHICH FILES TO EVEN OPEN');
{
  const tree = ['index.html', 'styles.css', 'app.js', 'manage.html', 'sw.js',
                'worker/src/economy.js', 'worker/src/index.js', 'lib/fx.js',
                'tests/econ.test.mjs', 'robots.txt'];
  const CORE = ['index.html', 'styles.css', 'app.js'];

  const named = rankPaths(tree, 'in manage.html make the save button green', CORE);
  ok('a file named in the request is picked', named.includes('manage.html'), named.join());
  ok('and comes first', named[0] === 'manage.html', named.join());

  const economy = rankPaths(tree, 'fix the economy payout', CORE);
  ok('a word matching a filename reaches the worker',
     economy.includes('worker/src/economy.js'), economy.join());

  const vague = rankPaths(tree, 'make the hero title smaller', CORE);
  ok('a request naming no file falls back to the site files',
     CORE.every(c => vague.includes(c)), vague.join());

  const capped = rankPaths(tree, 'index styles app manage worker economy lib tests robots', CORE, 6);
  ok('the shortlist is capped', capped.length <= 9, String(capped.length));
  ok('well under the 50-request ceiling a Worker gets', capped.length < 50);
}

console.log('\nEDITS ARE CHECKED BEFORE ANYONE SEES THEM');
{
  const files = { 'a.css': '.hero { color: red; }\n.foot { color: red; }\n' };

  const good = checkEdit(files, { path: 'a.css', find: '.hero { color: red; }',
                                  replace: '.hero { color: blue; }' });
  ok('a clean edit passes', good.ok === true, good.why);
  ok('and says where it lands', good.line === 1, String(good.line));
  ok('and carries the result', /blue/.test(good.after) && /\.foot \{ color: red/.test(good.after));

  const invented = checkEdit(files, { path: 'a.css', find: '.nav { color: pink; }', replace: 'x' });
  ok('invented text is caught', invented.ok === false);
  ok('and says so plainly', /not in a\.css/.test(invented.why), invented.why);

  const twice = checkEdit(files, { path: 'a.css', find: 'color: red;', replace: 'color: blue;' });
  ok('ambiguous text is caught', twice.ok === false);
  ok('and says how many times', /2 times/.test(twice.why), twice.why);

  ok('a file it was not shown is refused',
     checkEdit(files, { path: 'worker/src/index.js', find: 'x', replace: 'y' }).ok === false);
  ok('an empty find is refused', checkEdit(files, { path: 'a.css', find: '', replace: 'y' }).ok === false);
  ok('a no-op is refused',
     checkEdit(files, { path: 'a.css', find: '.foot', replace: '.foot' }).ok === false);
  ok('a missing edit object does not throw', checkEdit(files, null).ok === false);

  // Deleting is a legitimate edit and must not be mistaken for a no-op.
  const del = checkEdit(files, { path: 'a.css', find: '.foot { color: red; }\n', replace: '' });
  ok('deletion is allowed', del.ok === true, del.why);
}

console.log('\nTHE DIFF');
{
  const d = diffOf({ find: '.hero { color: red; }', replace: '.hero { color: blue; }' });
  ok('shows what goes', d.includes('- .hero { color: red; }'));
  ok('and what arrives', d.includes('+ .hero { color: blue; }'));

  const big = diffOf({ find: 'x\n'.repeat(900), replace: 'y' }, 300);
  ok('a long diff is cut to fit a Discord field', big.length <= 300, String(big.length));
  ok('and says it was cut', big.endsWith('...'));

  const gone = diffOf({ find: 'a', replace: '' });
  ok('a deletion shows no added line', !gone.includes('+'), gone);
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
