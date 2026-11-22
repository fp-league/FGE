/**
 * Every registered command reaches a handler.
 *
 * This suite exists because of a specific failure. `/ranked` was built,
 * tested thoroughly, deployed, and registered with Discord — it appeared
 * in the picker, people clicked it, and the bot answered "`ranked` isn't
 * something I know." The handler was fine. The command was never added to
 * ECON_COMMANDS, which is the gate index.js checks before dispatching, so
 * the interaction fell through to the league-data handler, which has
 * never heard of it either.
 *
 * Every other test called the handlers directly. Not one of them crossed
 * the join between "Discord sends an interaction with this name" and
 * "some function runs" — which is precisely where the bug was, and the
 * same gap had already silently killed slots, higherlower, duel and
 * lottery, none of which had ever been registered so nobody had noticed.
 *
 * So this checks the join, in both directions: nothing registered is
 * unrouted, and nothing routed is unregistered.
 */
import { COMMANDS } from '../worker/src/commands.js';
import { ECON_COMMANDS } from '../worker/src/economy.js';
import { DATA_VIEWS } from '../worker/src/discord.js';
import { OWN_BRANCH_COMMANDS } from '../worker/src/index.js';
import { CLASSES } from '../worker/src/classes.js';

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL  ' + n + (x ? '  →  ' + x : '')); } };

const registered = COMMANDS.map(c => c.name);
const routed = [...ECON_COMMANDS, ...DATA_VIEWS, ...OWN_BRANCH_COMMANDS, ...CLASSES];

console.log('\nEVERY COMMAND REACHES A HANDLER');

const unrouted = registered.filter(n => !routed.includes(n));
ok('nothing is registered with Discord that the Worker cannot route',
   unrouted.length === 0,
   unrouted.length ? unrouted.join(', ') + ' — registered but no handler claims them' : '');

const orphan = routed.filter(n => !registered.includes(n));
ok('and nothing is routed that was never registered',
   orphan.length === 0,
   orphan.length ? orphan.join(', ') + ' — handled but not in COMMANDS' : '');

const seen = new Map();
for (const n of routed) seen.set(n, (seen.get(n) || 0) + 1);
const twice = [...seen].filter(([, c]) => c > 1).map(([n]) => n);
ok('no command is claimed by two handlers at once', twice.length === 0, twice.join(', '));

console.log('\nTHE SHAPE DISCORD WILL ACCEPT');

for (const c of COMMANDS) {
  // Discord rejects the whole PUT if any one of these is wrong, which
  // takes every command down rather than the offending one.
  const bad = [];
  if (!/^[-_a-z0-9]{1,32}$/.test(c.name)) bad.push('name');
  if (!c.description || c.description.length > 100) bad.push('description');
  for (const o of c.options || []) {
    if (!/^[-_a-z0-9]{1,32}$/.test(o.name)) bad.push(`option ${o.name} name`);
    if (!o.description || o.description.length > 100) bad.push(`option ${o.name} description`);
    for (const s of o.options || []) {
      if (!/^[-_a-z0-9]{1,32}$/.test(s.name)) bad.push(`${o.name}.${s.name} name`);
      if (!s.description || s.description.length > 100) bad.push(`${o.name}.${s.name} description`);
    }
  }
  ok(`/${c.name} is a shape Discord will take`, bad.length === 0, bad.join(', '));
}

// A subcommand group means the arguments live one level down, and a
// handler that reads them from the top level finds nothing. /ranked had
// this shape and so does /lottery, /cards and /trade.
console.log('\nSUBCOMMANDS');
const nested = COMMANDS.filter(c => (c.options || []).some(o => o.type === 1));
ok('the commands with subcommands are the ones expected',
   nested.length > 0 && nested.every(c => OWN_BRANCH_COMMANDS.includes(c.name) ||
                                          ECON_COMMANDS.includes(c.name) ||
                                          CLASSES.includes(c.name)),
   nested.map(c => c.name).join(', '));

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
