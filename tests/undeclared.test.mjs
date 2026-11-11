/**
 * No page may use a name it never declares.
 *
 * `currentClass.toLowerCase()` lived in manage.html for weeks. It is the
 * name app.js uses; the panel's is adminClass. It parses fine, it sits in
 * a function only one button reaches, and the ReferenceError it throws is
 * swallowed by a catch that turns it into a toast — so End Season had
 * never once worked, and nothing said so.
 *
 * Every test in this repo is written against behaviour, which is right,
 * but behaviour tests only cover paths somebody thought to drive. This
 * covers every line instead, and only this class of fault.
 */
import { undeclared, GROUPS } from '../tools/undeclared.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL  ' + n + (x ? '  →  ' + x : '')); } };

console.log('EVERY NAME A PAGE USES IS ONE IT HAS');
{
  const found = undeclared(GROUPS);
  ok('nothing is undeclared', found.length === 0,
     found.map(p => `${p.file}:${p.line} ${p.name}`).join('; '));

  // The checker has to actually be capable of failing, or a green run
  // means nothing. Prove it against the real bug.
  const broken = [['tests/fixtures/undeclared-page.html']];
  const caught = undeclared(broken);
  ok('and the check can still fail', caught.some(p => p.name === 'currentClass'),
     JSON.stringify(caught));
  ok('it points at the line', caught.some(p => p.line > 0));

  // Things that must NOT be reported, or the check gets switched off.
  ok('a browser global is fine', !caught.some(p => p.name === 'document'));
  ok('a function declared later in the file is fine',
     !caught.some(p => p.name === 'definedBelow'));
  ok('so is one hung off window', !caught.some(p => p.name === 'fromWindow'));
  ok('a destructured binding is fine', !caught.some(p => p.name === 'alpha'));
  ok('a catch parameter is fine', !caught.some(p => p.name === 'err'));
  ok('a property with the same name as nothing is fine',
     !caught.some(p => p.name === 'notAVariable'));
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
