/**
 * /rob, against a stand-in for D1 that actually holds balances, so the
 * money is checked by arithmetic rather than by reading the code.
 */
import * as econ from '../worker/src/economy.js';

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL  ' + n + (x ? '  →  ' + x : '')); } };

function makeDB(settings = {}) {
  const wallets = new Map();          // id -> {balance, lifetime}
  const work = new Map();             // id|job -> {last_at, times}
  const ledger = [];
  const cfg = new Map(Object.entries(settings));

  const api = sql => {
    const q = sql.replace(/\s+/g, ' ').trim();
    let a = [];
    const self = {
      bind(...args) { a = args; return self; },
      async all() {
        if (/SELECT key, value FROM econ_setting/.test(q))
          return { results: [...cfg].map(([key, value]) => ({ key, value: String(value) })) };
        return { results: [] };
      },
      async first() {
        if (/SELECT balance, lifetime FROM wallet/.test(q)) return wallets.get(a[0]) || null;
        if (/SELECT last_at, times FROM work_log/.test(q)) return work.get(a[0] + '|' + a[1]) || null;
        return null;
      },
      async run() {
        if (/INSERT INTO wallet/.test(q)) {
          if (!wallets.has(a[0])) wallets.set(a[0], { balance: a[1], lifetime: a[2] });
          return {};
        }
        if (/UPDATE wallet SET balance = balance \+ \?, updated_at = \? WHERE user_id = \? AND balance >= \?/.test(q)) {
          const w = wallets.get(a[2]);
          if (!w || w.balance < a[3]) return { meta: { changes: 0 } };
          w.balance += a[0];
          return { meta: { changes: 1 } };
        }
        if (/UPDATE wallet SET balance = balance \+ \?, lifetime = lifetime \+ \?/.test(q)) {
          const w = wallets.get(a[3]);
          if (w) { w.balance += a[0]; w.lifetime += a[1]; }
          return { meta: { changes: 1 } };
        }
        if (/INSERT INTO ledger/.test(q)) {
          ledger.push({ user_id: a[0], delta: a[1], reason: a[2] });
          return {};
        }
        if (/INSERT INTO work_log/.test(q)) {
          const k = a[0] + '|' + a[1];
          const prev = work.get(k);
          work.set(k, { last_at: a[2], times: (prev ? prev.times : 0) + 1 });
          return {};
        }
        return {};
      },
    };
    return self;
  };
  return { DB: { prepare: api }, _wallets: wallets, _work: work, _ledger: ledger };
}

const who = id => ({ member: { user: { id, username: 'u' + id } } });
const seed = (env, id, balance) => env._wallets.set(id, { balance, lifetime: balance });
const bal = (env, id) => (env._wallets.get(id) || {}).balance;
const text = r => `${r.title} ${r.description || ''}`;

/* ── refusals ──────────────────────────────────────────── */
console.log('IT REFUSES THE RIGHT THINGS');
{
  let env = makeDB({ rob_enabled: '0' });
  seed(env, 'a', 5000); seed(env, 'b', 5000);
  ok('switched off means off', /switched off/i.test(text(await econ.robUser(env, who('a'), 'b'))));

  env = makeDB();
  seed(env, 'a', 5000);
  ok('cannot rob yourself', /that is you/i.test(text(await econ.robUser(env, who('a'), 'a'))));
  ok('needs a target', /rob who/i.test(text(await econ.robUser(env, who('a'), null))));

  env = makeDB({ rob_min_balance: '250' });
  seed(env, 'a', 100); seed(env, 'b', 9000);
  const broke = await econ.robUser(env, who('a'), 'b');
  ok('you need something to lose', /nothing to lose/i.test(text(broke)), text(broke));
  ok('and a refused attempt costs the target nothing', bal(env, 'b') === 9000, String(bal(env, 'b')));

  env = makeDB({ rob_target_min: '400' });
  seed(env, 'a', 9000); seed(env, 'b', 399);
  const poor = await econ.robUser(env, who('a'), 'b');
  ok('the broke cannot be targeted', /not worth it/i.test(text(poor)), text(poor));
  ok('and nothing moved', bal(env, 'a') === 9000 && bal(env, 'b') === 399);
  ok('a refusal does not start the cooldown', env._work.size === 0, String(env._work.size));
}

/* ── success ───────────────────────────────────────────── */
console.log('\nWHEN IT WORKS');
{
  const env = makeDB({ rob_success_pct: '100', rob_take_min_pct: '10', rob_take_max_pct: '10' });
  seed(env, 'a', 1000); seed(env, 'b', 5000);
  const r = await econ.robUser(env, who('a'), 'b');
  ok('it says so', /got away/i.test(text(r)), text(r));
  ok('exactly the stated slice moves', bal(env, 'b') === 4500, String(bal(env, 'b')));
  ok('and lands in the robber', bal(env, 'a') === 1500, String(bal(env, 'a')));
  ok('nothing is created or destroyed', bal(env, 'a') + bal(env, 'b') === 6000);
  ok('both sides are in the ledger', env._ledger.filter(l => /Robbed/.test(l.reason)).length === 2);
}

/* ── failure ───────────────────────────────────────────── */
console.log('\nWHEN IT DOES NOT');
{
  const env = makeDB({ rob_success_pct: '0', rob_fine_pct: '20' });
  seed(env, 'a', 1000); seed(env, 'b', 5000);
  const r = await econ.robUser(env, who('a'), 'b');
  ok('it says so', /caught/i.test(text(r)), text(r));
  ok('the robber is fined', bal(env, 'a') === 800, String(bal(env, 'a')));
  ok('and the fine goes to the target, not nowhere', bal(env, 'b') === 5200, String(bal(env, 'b')));
  ok('still nothing created or destroyed', bal(env, 'a') + bal(env, 'b') === 6000);
}

/* ── the floors actually hold ──────────────────────────── */
console.log('\nNOBODY GETS STRIPPED BARE');
{
  // 200 attempts at the most aggressive settings the panel allows.
  const env = makeDB({ rob_success_pct: '100', rob_take_min_pct: '100', rob_take_max_pct: '100',
                       rob_cooldown_min: '0', rob_target_min: '400' });
  seed(env, 'a', 500); seed(env, 'b', 100000);
  let lowest = Infinity, refusals = 0;
  for (let i = 0; i < 200; i++) {
    const r = await econ.robUser(env, who('a'), 'b');
    if (/not worth it/i.test(text(r))) refusals++;
    lowest = Math.min(lowest, bal(env, 'b'));
  }
  ok('the target never drops below the floor', lowest >= 0, String(lowest));
  ok('and is protected once under it', refusals > 0, `${refusals} refusals`);
  ok('the total is still conserved', bal(env, 'a') + bal(env, 'b') === 100500,
     String(bal(env, 'a') + bal(env, 'b')));
}

/* ── cooldown ──────────────────────────────────────────── */
console.log('\nCOOLDOWN');
{
  const env = makeDB({ rob_success_pct: '100', rob_cooldown_min: '120' });
  seed(env, 'a', 1000); seed(env, 'b', 5000);
  await econ.robUser(env, who('a'), 'b');
  const after = bal(env, 'b');
  const second = await econ.robUser(env, who('a'), 'b');
  ok('a second go is held off', /lie low/i.test(text(second)), text(second));
  ok('and takes nothing', bal(env, 'b') === after);

  // Failure must start it too, or failing would be free.
  const env2 = makeDB({ rob_success_pct: '0', rob_cooldown_min: '120' });
  seed(env2, 'a', 1000); seed(env2, 'b', 5000);
  await econ.robUser(env2, who('a'), 'b');
  ok('failing starts the cooldown as well',
     /lie low/i.test(text(await econ.robUser(env2, who('a'), 'b'))));
}

/* ── odds ──────────────────────────────────────────────── */
console.log('\nTHE ODDS ARE THE ODDS');
{
  let wins = 0;
  for (let i = 0; i < 600; i++) {
    const env = makeDB({ rob_success_pct: '35', rob_take_min_pct: '5', rob_take_max_pct: '5' });
    seed(env, 'a', 1000); seed(env, 'b', 5000);
    if (/got away/i.test(text(await econ.robUser(env, who('a'), 'b')))) wins++;
  }
  const rate = wins / 600 * 100;
  ok('35% comes out near 35 over 600 runs', rate > 28 && rate < 42, rate.toFixed(1) + '%');
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
