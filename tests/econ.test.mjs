/**
 * Economy tests. The fake D1 below is a real in-memory SQLite-ish store for
 * the handful of tables the economy touches — enough to run the actual
 * module rather than a mock of it, so a bug in the SQL shows up here.
 */
import { cardSet, combinedSet, drawPack, packEmbeds, RARITY, RARITIES, SET } from '../worker/src/cards.js';
import * as econ from '../worker/src/economy.js';
import * as games from '../worker/src/games.js';
import { SET as BUCKET } from '../worker/src/cards.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  →  ' + extra : '')); }
};

/* ── A fake D1 ─────────────────────────────────────────── */

function makeDB() {
  const t = {
    wallet: new Map(), ledger: [], work_log: new Map(),
    job: new Map(), pack_type: new Map(), custom_card: new Map(),
    econ_setting: new Map(), card_collection: new Map(), card_packs: new Map(),
    trade: new Map(), card_season: new Map(), card_season_holding: new Map(),
  };

  function run(sql, a) {
    const q = sql.replace(/\s+/g, ' ').trim();

    if (/SELECT key, value FROM econ_setting/.test(q))
      return { results: [...t.econ_setting].map(([key, value]) => ({ key, value })) };
    if (/INSERT INTO econ_setting/.test(q)) { t.econ_setting.set(a[0], a[1]); return {}; }

    if (/SELECT balance, lifetime FROM wallet WHERE user_id/.test(q))
      return t.wallet.get(a[0]) || null;
    if (/INSERT INTO wallet/.test(q)) {
      if (!t.wallet.has(a[0])) t.wallet.set(a[0], { balance: a[1], lifetime: a[2] });
      return {};
    }
    if (/UPDATE wallet SET balance = \? , updated_at/.test(q) ||
        /UPDATE wallet SET balance = balance \+ \?, updated_at = \? WHERE user_id = \? AND balance >= \?/.test(q)) {
      const w = t.wallet.get(a[2]);
      if (!w || w.balance < a[3]) return { meta: { changes: 0 } };
      w.balance += a[0];
      return { meta: { changes: 1 } };
    }
    if (/UPDATE wallet SET balance = balance \+ \?, lifetime = lifetime \+ \?/.test(q)) {
      const w = t.wallet.get(a[3]);
      if (w) { w.balance += a[0]; w.lifetime += a[1]; }
      return { meta: { changes: 1 } };
    }
    if (/INSERT INTO ledger/.test(q)) {
      t.ledger.push({ user_id: a[0], delta: a[1], reason: a[2], at: a[3] });
      return {};
    }
    if (/SELECT 1 FROM ledger WHERE reason LIKE/.test(q)) {
      const like = a[0].replace('%', '');
      return t.ledger.some(l => l.reason.startsWith(like)) ? { 1: 1 } : null;
    }
    if (/SELECT delta, reason FROM ledger/.test(q))
      return { results: t.ledger.filter(l => l.user_id === a[0]).slice(-5).reverse() };
    if (/SELECT COUNT\(\*\) AS n FROM wallet WHERE balance >/.test(q))
      return { n: [...t.wallet.values()].filter(w => w.balance > a[0]).length };
    if (/SELECT user_id, balance, lifetime FROM wallet/.test(q))
      return { results: [...t.wallet].map(([user_id, w]) => ({ user_id, ...w }))
        .sort((x, y) => y.balance - x.balance) };

    // /work now opens a shift row and pays when it is answered.
    if (/INSERT INTO casino_game/.test(q)) {
      t.casino_game = t.casino_game || new Map();
      t.casino_game.set(a[0], { id: a[0], user_id: a[1], kind: a[2], bet: a[3], state: a[4], at: a[5] });
      return {};
    }
    if (/FROM casino_game WHERE id/.test(q))
      return (t.casino_game && t.casino_game.get(a[0])) || null;
    if (/DELETE FROM casino_game/.test(q)) {
      if (t.casino_game) t.casino_game.delete(a[0]);
      return {};
    }

    if (/SELECT id, name, emoji, blurb, min_pay, max_pay, cooldown_min FROM job/.test(q))
      return { results: [...t.job.values()].filter(j => j.enabled !== 0) };
    if (/SELECT job, last_at, times, earned FROM work_log WHERE user_id/.test(q))
      return { results: [...t.work_log.values()].filter(w => w.user_id === a[0]) };
    if (/SELECT last_at, times FROM work_log WHERE user_id = \? AND job = 'daily'/.test(q))
      return t.work_log.get(a[0] + '|daily') || null;
    if (/INSERT INTO work_log/.test(q)) {
      const k = a[0] + '|' + (q.includes("'daily'") ? 'daily' : a[1]);
      const job = q.includes("'daily'") ? 'daily' : a[1];
      const [last_at, times, earned] = q.includes("'daily'") ? [a[1], a[2], a[3]] : [a[2], 1, a[3]];
      const prev = t.work_log.get(k);
      t.work_log.set(k, {
        user_id: a[0], job, last_at,
        times: prev ? (q.includes("'daily'") ? times : prev.times + 1) : times,
        earned: (prev ? prev.earned : 0) + earned,
      });
      return {};
    }

    if (/SELECT \* FROM pack_type WHERE enabled = 1 AND class/.test(q))
      return { results: [...t.pack_type.values()].filter(p => p.enabled !== 0 && p.class === a[0]) };
    if (/SELECT \* FROM pack_type WHERE enabled = 1/.test(q))
      return { results: [...t.pack_type.values()].filter(p => p.enabled !== 0) };
    if (/SELECT \* FROM pack_type/.test(q)) return { results: [...t.pack_type.values()] };
    if (/INSERT INTO pack_type/.test(q)) {
      t.pack_type.set(a[0], { id: a[0], name: a[1], emoji: a[2], blurb: a[3], price: a[4],
        size: a[5], class: a[6], odds: a[7], guarantee: a[8], pool: a[9], enabled: a[10], sort: a[11] });
      return {};
    }
    if (/DELETE FROM pack_type/.test(q)) { t.pack_type.delete(a[0]); return {}; }

    // Before the SELECTs, not after: "DELETE FROM custom_card WHERE id = ?"
    // also contains "FROM custom_card", so the loose pattern below was
    // answering it with a list of rows and deleting nothing. Every delete
    // of a custom card quietly did nothing here, which is why no test ever
    // caught it.
    if (/DELETE FROM custom_card/.test(q)) { t.custom_card.delete(a[0]); return {}; }
    if (/FROM custom_card WHERE class/.test(q))
      return { results: [...t.custom_card.values()].filter(c => c.class === a[0] && c.enabled !== 0) };
    if (/FROM custom_card/.test(q)) return { results: [...t.custom_card.values()] };
    if (/INSERT INTO custom_card/.test(q)) {
      t.custom_card.set(a[0], { id: a[0], class: a[1], name: a[2], subtitle: a[3], rarity: a[4],
        image: a[5], blurb: a[6], enabled: a[7], sort: a[8] });
      return {};
    }

    if (/SELECT driver_id, rarity, copies FROM card_collection/.test(q))
      return { results: [...t.card_collection.values()]
        .filter(c => c.user_id === a[0] && c.class === a[1] && c.copies > 1) };
    if (/SELECT driver_id, copies FROM card_collection/.test(q))
      return { results: [...t.card_collection.values()].filter(c => c.user_id === a[0] && c.class === a[1]) };
    if (/SELECT COUNT\(\*\) AS held/.test(q)) {
      const mine = [...t.card_collection.values()].filter(c => c.user_id === a[0]);
      return { held: mine.length, copies: mine.reduce((n, c) => n + c.copies, 0) };
    }
    if (/INSERT INTO card_collection/.test(q)) {
      const k = [a[0], a[1], a[2]].join('|');
      const prev = t.card_collection.get(k);
      if (prev) { prev.copies++; prev.rarity = a[3]; }
      else t.card_collection.set(k, { user_id: a[0], class: a[1], driver_id: a[2], rarity: a[3], copies: 1 });
      return {};
    }
    if (/UPDATE card_collection SET copies = 1/.test(q)) {
      const c = t.card_collection.get([a[0], a[1], a[2]].join('|'));
      if (c) c.copies = 1;
      return {};
    }
    if (/UPDATE card_collection SET copies = copies - \?/.test(q)) {
      const c = t.card_collection.get([a[1], a[2], a[3]].join('|'));
      if (c && c.copies - a[0] >= 1) c.copies -= a[0];
      return {};
    }
    // Matched on the WHERE clause, not just the table: a looser pattern here
    // swallowed the class-wide delete that ending a card season uses.
    if (/DELETE FROM card_collection WHERE driver_id/.test(q)) {
      for (const [k, c] of t.card_collection) if (c.driver_id === a[0]) t.card_collection.delete(k);
      return {};
    }
    if (/FROM card_packs WHERE user_id/.test(q)) return t.card_packs.get(a[0]) || null;
    if (/INSERT INTO card_packs/.test(q)) {
      const prev = t.card_packs.get(a[0]) || { total_packs: 0, total_cards: 0 };
      t.card_packs.set(a[0], { total_packs: prev.total_packs + 1, total_cards: prev.total_cards + a[1] });
      return {};
    }
    if (/INSERT INTO trade/.test(q)) {
      const id = (t.trade.size ? Math.max(...t.trade.keys()) : 0) + 1;
      t.trade.set(id, { id, from_user:a[0], to_user:a[1], give_card:a[2], want_card:a[3],
                        status:'open', created_at:a[4], closed_at:null });
      return {};
    }
    if (/SELECT id FROM trade WHERE from_user/.test(q)) {
      const r = [...t.trade.values()].filter(x => x.from_user===a[0] && x.to_user===a[1] && x.status==='open')
        .sort((x,y)=>y.created_at-x.created_at)[0];
      return r ? { id: r.id } : null;
    }
    if (/SELECT \* FROM trade WHERE id/.test(q)) return t.trade.get(Number(a[0])) || null;
    if (/SELECT \* FROM trade WHERE status = 'open'/.test(q)) {
      return { results: [...t.trade.values()].filter(x =>
        x.status==='open' && x.created_at > a[0] && (x.to_user===a[1] || x.from_user===a[2]))
        .sort((x,y)=>y.created_at-x.created_at) };
    }
    if (/UPDATE trade SET status = '(\w+)'/.test(q)) {
      const st = /UPDATE trade SET status = '(\w+)'/.exec(q)[1];
      const r = t.trade.get(Number(a[1])); if (r) { r.status = st; r.closed_at = a[0]; }
      return {};
    }
    if (/UPDATE trade SET status = \?/.test(q)) {
      const r = t.trade.get(Number(a[2])); if (r) { r.status = a[0]; r.closed_at = a[1]; }
      return {};
    }
    if (/SELECT copies FROM card_collection WHERE user_id = \? AND class = \? AND driver_id = \?/.test(q)) {
      return t.card_collection.get([a[0],a[1],a[2]].join('|')) || null;
    }
    if (/UPDATE card_collection SET copies = copies - 1/.test(q)) {
      const c = t.card_collection.get([a[0],a[1],a[2]].join('|'));
      if (c && c.copies - 1 >= 1) c.copies -= 1;
      return {};
    }
    if (/SELECT user_id, driver_id, rarity, copies FROM card_collection WHERE class/.test(q)) {
      return { results: [...t.card_collection.values()].filter(c => c.class === a[0]) };
    }
    if (/INSERT INTO card_season_holding/.test(q)) {
      t.card_season_holding.set([a[0],a[1],a[2]].join('|'),
        { season_id:a[0], user_id:a[1], driver_id:a[2], rarity:a[3], copies:a[4] });
      return {};
    }
    if (/INSERT INTO card_season /.test(q)) {
      t.card_season.set(a[0], { id:a[0], name:a[1], ended_at:a[2], cleared:a[3],
                                holders:a[4], cards:a[5], top:a[6] });
      return {};
    }
    if (/SELECT id, name, ended_at, cleared, holders, cards, top/.test(q)) {
      return { results: [...t.card_season.values()] };
    }
    if (/DELETE FROM card_collection WHERE class/.test(q)) {
      for (const [k,c] of t.card_collection) if (c.class === a[0]) t.card_collection.delete(k);
      return {};
    }
    if (/DELETE FROM card_packs/.test(q)) { t.card_packs.clear(); return {}; }
    if (/DELETE FROM job/.test(q)) { t.job.delete(a[0]); return {}; }
    if (/DELETE FROM work_log WHERE job/.test(q)) {
      for (const [k, w] of t.work_log) if (w.job === a[0]) t.work_log.delete(k);
      return {};
    }
    if (/INSERT INTO job/.test(q)) {
      t.job.set(a[0], { id: a[0], name: a[1], emoji: a[2], blurb: a[3], min_pay: a[4],
        max_pay: a[5], cooldown_min: a[6], enabled: a[7], sort: a[8] });
      return {};
    }
    if (/SELECT \* FROM job/.test(q)) return { results: [...t.job.values()] };

    throw new Error('fake DB has no case for: ' + q.slice(0, 90));
  }

  const prep = sql => ({
    bind: (...a) => ({
      first: async () => { const r = run(sql, a); return r && r.results ? (r.results[0] || null) : r; },
      all:   async () => { const r = run(sql, a); return r && r.results ? r : { results: r ? [r] : [] }; },
      run:   async () => run(sql, a),
      _sql: sql, _args: a,
    }),
    first: async () => { const r = run(sql, []); return r && r.results ? (r.results[0] || null) : r; },
    all:   async () => { const r = run(sql, []); return r && r.results ? r : { results: [] }; },
    run:   async () => run(sql, []),
  });

  return {
    _t: t,
    prepare: prep,
    batch: async stmts => { for (const s of stmts) await s.run(); return []; },
  };
}

const env = () => { const DB = makeDB(); return { DB, _t: DB._t }; };
const who = id => ({ member: { user: { id, username: 'u' + id, global_name: 'User ' + id } }, data: {} });

/* A small league: three drivers, one race run. */
const LEAGUE = {
  gt3: {
    points: { table: [20, 15, 12, 10, 8, 6, 4, 3, 2, 1], fastestLap: 1 },
    drivers: [
      { id: 'd1', name: 'Alpha', discordId: '111' },
      { id: 'd2', name: 'Bravo', discordId: '222' },
      { id: 'd3', name: 'Charlie' },                       // no Discord: unpayable
    ],
    races: [{ round: 1, name: 'Round One',
      results: [{ driverId: 'd1', pos: 1 }, { driverId: 'd2', pos: 2 }, { driverId: 'd3', pos: 3 }],
      fastestLap: { driverId: 'd2' } }],
  },
  gt4: {
    points: { table: [20, 15, 12, 10, 8, 6, 4, 3, 2, 1], fastestLap: 1 },
    drivers: [
      { id: 'g1', name: 'Delta', discordId: '444' },
      { id: 'g2', name: 'Echo' },
      // Alpha races in both classes. One person, one card.
      { id: 'd1', name: 'Alpha', discordId: '111' },
    ],
    races: [{ round: 1, name: 'GT4 One',
      results: [{ driverId: 'g1', pos: 1 }, { driverId: 'g2', pos: 2 }, { driverId: 'd1', pos: 3 }] }],
  },
};

/* ── Settings and wallets ──────────────────────────────── */
console.log('\nWallets');
{
  const e = env();
  const w = await econ.wallet(e, '111');
  ok('a new wallet opens with the starting balance', w.balance === 750, 'got ' + w.balance);
  ok('and it is flagged new', w.isNew === true);

  const again = await econ.wallet(e, '111');
  ok('opening it twice does not pay twice', again.balance === 750 && again.isNew === false);

  const up = await econ.adjust(e, '111', 500, 'test');
  ok('credit adds to the balance', up.balance === 1250, 'got ' + up.balance);
  ok('and to lifetime', up.lifetime === 1250, 'got ' + up.lifetime);

  const down = await econ.adjust(e, '111', -200, 'test');
  ok('debit subtracts', down.balance === 1050, 'got ' + down.balance);
  ok('a debit does not raise lifetime', down.lifetime === 1250, 'got ' + down.lifetime);

  const over = await econ.adjust(e, '111', -99999, 'test');
  ok('overdrawing is refused, not clamped', over === null);
  const still = await econ.wallet(e, '111');
  ok('and the balance is untouched after a refused debit', still.balance === 1050, 'got ' + still.balance);
}

/* ── Work ──────────────────────────────────────────────── */
console.log('\nWork');
{
  const e = env();
  await econ.saveJob(e, { id: 'pitcrew', name: 'Pit crew', min_pay: 60, max_pay: 60, cooldown_min: 90 });

  const board = await econ.doWork(e, who('111'), '');
  ok('no job named shows the board', /Pit crew/.test(board.description) && board.title === 'Work');

  const first = await econ.doWork(e, who('111'), 'pitcrew');
  ok('clocking on asks something', first.type === 4 && !!first.data.components.length,
     JSON.stringify(first).slice(0, 80));
  ok('and pays nothing until it is answered', (await econ.wallet(e, '111')).balance === 750,
     'got ' + (await econ.wallet(e, '111')).balance);

  // Answer it, and the money arrives.
  const cid = first.data.components[0].components[0].custom_id;
  const gid = cid.split(':')[1];
  const st = JSON.parse(e._t.casino_game.get(gid).state);
  await games.handleComponent({ member: { user: { id: '111' } },
    data: { custom_id: `wk:${gid}:${st.q.answer}` } }, e);
  const w1 = await econ.wallet(e, '111');
  ok('a right answer pays the fixed rate', w1.balance === 810, 'got ' + w1.balance);

  const second = await econ.doWork(e, who('111'), 'pitcrew');
  ok('the same job cannot be done twice in a row', /Not yet/.test(second.title), second.title);
  const w2 = await econ.wallet(e, '111');
  ok('a refused shift pays nothing', w2.balance === 810, 'got ' + w2.balance);

  const byName = await econ.doWork(e, who('222'), 'Pit crew');
  ok('a job can be named instead of its id', byName.type === 4 && !byName.title,
     JSON.stringify(byName).slice(0, 60));

  const nope = await econ.doWork(e, who('333'), 'astronaut');
  ok('an unknown job says so', /No such job/.test(nope.title));

  // Pay must stay inside the advertised range, every time.
  await econ.saveJob(e, { id: 'wide', name: 'Wide', min_pay: 10, max_pay: 20, cooldown_min: 1 });
  let outside = 0;
  for (let i = 0; i < 60; i++) {
    e._t.work_log.delete('999|wide');
    const before = (await econ.wallet(e, '999')).balance;
    const r = await econ.doWork(e, who('999'), 'wide');
    const id = r.data.components[0].components[0].custom_id.split(':')[1];
    const ans = JSON.parse(e._t.casino_game.get(id).state).q.answer;
    await games.handleComponent({ member: { user: { id: '999' } },
      data: { custom_id: `wk:${id}:${ans}` } }, e);
    const paid = (await econ.wallet(e, '999')).balance - before;
    if (paid < 10 || paid > 20) outside++;
  }
  ok('pay never leaves the advertised range', outside === 0, outside + ' of 60 outside');
}

/* ── Daily ─────────────────────────────────────────────── */
console.log('\nDaily');
{
  const e = env();
  const d1 = await econ.doDaily(e, who('111'));
  ok('day one pays the base', /\*\*300\*\*/.test(d1.description), d1.description);
  ok('plus one streak step', /\*\*75\*\* \S+ streak/.test(d1.description), d1.description);
  ok('and says day 1', /Day 1/.test(d1.description));

  const again = await econ.doDaily(e, who('111'));
  ok('claiming twice is refused', /Already claimed/.test(again.title));

  // Yesterday: streak continues.
  e._t.work_log.get('111|daily').last_at = Date.now() - 25 * 3600e3;
  const d2 = await econ.doDaily(e, who('111'));
  ok('a claim the next day continues the streak', /Day 2/.test(d2.description), d2.description);

  // Three days ago: streak breaks.
  e._t.work_log.get('111|daily').last_at = Date.now() - 3 * 24 * 3600e3;
  const d3 = await econ.doDaily(e, who('111'));
  ok('missing two days resets the streak', /Day 1/.test(d3.description), d3.description);

  // Streak bonus is capped.
  e._t.work_log.set('111|daily', { user_id: '111', job: 'daily',
    last_at: Date.now() - 25 * 3600e3, times: 40, earned: 0 });
  const capped = await econ.doDaily(e, who('111'));
  ok('the bonus caps at the configured maximum', /525/.test(capped.description), capped.description);
  ok('and says so', /maxed out/.test(capped.description));
}

/* ── Pack odds ─────────────────────────────────────────── */
console.log('\nPacks');
{
  // A set big enough that pack odds are measurable.
  const many = [];
  RARITIES.forEach(r => { for (let i = 0; i < 12; i++) many.push({ id: r + i, name: r + i, rarity: r }); });

  const out = [];
  for (let i = 0; i < 4000; i++) out.push(...drawPack(many, { size: 5 }));
  const share = r => out.filter(c => c.rarity === r).length / out.length;
  ok('house odds give commons about half the cards', Math.abs(share('common') - 0.5) < 0.06,
     share('common').toFixed(3));
  ok('and legendaries about one in a hundred', share('legendary') < 0.035,
     share('legendary').toFixed(3));

  // Zero weight must mean never, not rarely.
  const noCommons = [];
  for (let i = 0; i < 600; i++) noCommons.push(...drawPack(many, { size: 5, odds: { common: 0, uncommon: 50, rare: 30, epic: 15, legendary: 5 } }));
  ok('a tier weighted 0 never appears', !noCommons.some(c => c.rarity === 'common'));

  // Guarantee.
  let missed = 0;
  for (let i = 0; i < 800; i++) {
    const p = drawPack(many, { size: 5, guarantee: 'epic' });
    if (!p.some(c => RARITIES.indexOf(c.rarity) >= RARITIES.indexOf('epic'))) missed++;
  }
  ok('a guarantee is always honoured', missed === 0, missed + ' packs missed it');

  // A guarantee must survive its own tier being weighted to nothing.
  let missed2 = 0;
  for (let i = 0; i < 400; i++) {
    const p = drawPack(many, { size: 3, guarantee: 'legendary',
      odds: { common: 90, uncommon: 10, rare: 0, epic: 0, legendary: 0 } });
    if (!p.some(c => c.rarity === 'legendary')) missed2++;
  }
  ok('a guarantee beats odds that would forbid it', missed2 === 0, missed2 + ' missed');

  // Size and no-duplicates-within-a-pack.
  const p5 = drawPack(many, { size: 7 });
  ok('pack size is honoured', p5.length === 7, 'got ' + p5.length);
  ok('a pack never holds the same card twice', new Set(p5.map(c => c.id)).size === 7);

  // Pool restriction.
  const pooled = drawPack(many, { size: 5, pool: ['common0', 'rare3', 'epic7'] });
  ok('a pool restricts what can come out',
     pooled.every(c => ['common0', 'rare3', 'epic7'].includes(c.id)));
  ok('and a pool smaller than the pack just gives fewer cards', pooled.length === 3);

  // A pool of ids that no longer exist falls back rather than giving nothing.
  const ghost = drawPack(many, { size: 4, pool: ['deleted1', 'deleted2'] });
  ok('a pool of missing ids falls back to the whole set', ghost.length === 4);
}

/* ── Buying ────────────────────────────────────────────── */
console.log('\nBuying');
{
  const e = env();
  await econ.savePack(e, { id: 'std', name: 'Standard', price: 400, size: 3 });

  const shop = await econ.showShop(e, who('111'));
  ok('the shop lists the pack', /Standard/.test(shop.description));

  const bought = await econ.buyPack(e, who('111'), 'std', LEAGUE);
  ok('buying opens the pack', /opened a Standard/.test(bought.title), bought.title);
  const w = await econ.wallet(e, '111');
  ok('and the price comes out of the wallet', w.balance === 350, 'got ' + w.balance);

  const broke = await econ.buyPack(e, who('111'), 'std', LEAGUE);
  ok('a second buy with 350 left is refused', /Not enough/.test(broke.title), broke.title);
  const w2 = await econ.wallet(e, '111');
  ok('and a refused buy costs nothing', w2.balance === 350, 'got ' + w2.balance);

  const held = [...e._t.card_collection.values()].reduce((n, c) => n + c.copies, 0);
  ok('the cards are in the collection', held === 3, 'got ' + held);

  const nope = await econ.buyPack(e, who('222'), 'nothing-like-this', LEAGUE);
  ok('an unknown pack says so', /No such pack/.test(nope.title));

  // A pack whose pool is empty must refund rather than silently take money.
  await econ.savePack(e, { id: 'broken', name: 'Broken', price: 100, size: 3,
    odds: { common: 0, uncommon: 0, rare: 0, epic: 0, legendary: 0 } });
  const before = (await econ.wallet(e, '222')).balance;
  await econ.buyPack(e, who('222'), 'broken', LEAGUE);
  const after = (await econ.wallet(e, '222')).balance;
  ok('a pack with every tier at zero still draws rather than taking the money for nothing',
     after === before - 100, `before ${before} after ${after}`);
}

/* ── Selling ───────────────────────────────────────────── */
console.log('\nSelling');
{
  const e = env();
  // Alpha is the championship leader, so legendary; give three copies.
  const set = combinedSet(LEAGUE, []);
  const alpha = set.find(c => c.name === 'Alpha');
  e._t.card_collection.set('111|all|d1',
    { user_id: '111', class: 'all', driver_id: 'd1', rarity: alpha.rarity, copies: 3 });

  const list = await econ.sellCard(e, who('111'), '', null, LEAGUE);
  ok('with no name it lists the spares', /Alpha/.test(list.description), list.description);
  ok('and counts only the spares, not the kept copy', /×2 spare/.test(list.description), list.description);

  const sold = await econ.sellCard(e, who('111'), 'Alpha', 1, LEAGUE);
  ok('selling one works', /Sold 1/.test(sold.title), sold.title);
  ok('at the legendary rate', /900/.test(sold.description), sold.description);
  ok('leaving two copies', e._t.card_collection.get('111|all|d1').copies === 2);

  await econ.sellCard(e, who('111'), 'Alpha', 99, LEAGUE);
  ok('selling more than you have spare stops at the spares',
     e._t.card_collection.get('111|all|d1').copies === 1);

  const last = await econ.sellCard(e, who('111'), 'Alpha', 1, LEAGUE);
  ok('the last copy can never be sold', /Nothing spare/.test(last.title), last.title);
  ok('and it is still there', e._t.card_collection.get('111|all|d1').copies === 1);

  // Sell all.
  // A card is worth whatever its rarity is NOW, not whatever it was when it
  // was pulled — the stored rarity here is deliberately stale and must be
  // ignored. Bravo and Charlie sit 2nd and 3rd in the championship, so both
  // price as Epic even though the collection row says Common.
  e._t.card_collection.set('111|all|d2',
    { user_id: '111', class: 'all', driver_id: 'd2', rarity: 'common', copies: 4 });
  e._t.card_collection.set('111|all|d3',
    { user_id: '111', class: 'all', driver_id: 'd3', rarity: 'common', copies: 2 });
  const before = (await econ.wallet(e, '111')).balance;
  const all = await econ.sellCard(e, who('111'), 'all', null, LEAGUE);
  ok('selling all clears every spare', /Sold the lot/.test(all.title), all.title);
  ok('and keeps one of each',
     e._t.card_collection.get('111|all|d2').copies === 1 &&
     e._t.card_collection.get('111|all|d3').copies === 1);
  const after = (await econ.wallet(e, '111')).balance;
  ok('pricing off current rarity, not the stale stored one',
     after - before === 4 * 350, 'got ' + (after - before));
}

/* ── Paying each other ─────────────────────────────────── */
console.log('\nTransfers');
{
  const e = env();
  await econ.wallet(e, '111'); await econ.wallet(e, '222');
  const sent = await econ.payUser(e, who('111'), '222', 250);
  ok('a transfer goes through', /Sent/.test(sent.title), sent.title);
  ok('the sender loses it', (await econ.wallet(e, '111')).balance === 500);
  ok('the receiver gains it', (await econ.wallet(e, '222')).balance === 1000);

  const self = await econ.payUser(e, who('111'), '111', 10);
  ok('paying yourself is refused', /That is you/.test(self.title));

  const tooMuch = await econ.payUser(e, who('111'), '222', 999999);
  ok('paying more than the cap is refused', /Too big/.test(tooMuch.title), tooMuch.title);

  const tooLittle = await econ.payUser(e, who('111'), '222', 1);
  ok('paying under the floor is refused', /Too small/.test(tooLittle.title));

  const broke = await econ.payUser(e, who('111'), '222', 5000);
  ok('paying more than you have is refused', /Not enough/.test(broke.title), broke.title);
  ok('and nothing moved', (await econ.wallet(e, '111')).balance === 500 &&
     (await econ.wallet(e, '222')).balance === 1000);
}

/* ── Prize money ───────────────────────────────────────── */
console.log('\nPrize money');
{
  const e = env();
  const race = LEAGUE.gt3.races[0];
  const r1 = await econ.payRace(e, 'gt3', race, LEAGUE.gt3.drivers);
  ok('only drivers with a linked Discord account are paid', r1.paid === 2, 'paid ' + r1.paid);
  ok('the winner gets P1 money', (await econ.wallet(e, '111')).balance === 750 + 1200,
     'got ' + (await econ.wallet(e, '111')).balance);
  ok('second gets P2 money plus fastest lap',
     (await econ.wallet(e, '222')).balance === 750 + 900 + 150,
     'got ' + (await econ.wallet(e, '222')).balance);

  const r2 = await econ.payRace(e, 'gt3', race, LEAGUE.gt3.drivers);
  ok('announcing the same round twice does not pay twice', r2.note === 'already paid');
  ok('and balances are unchanged', (await econ.wallet(e, '111')).balance === 1950);

  // A DNF earns nothing.
  const e2 = env();
  await econ.payRace(e2, 'gt3', { round: 9,
    results: [{ driverId: 'd1', pos: 'DNF' }, { driverId: 'd2', pos: 1 }] }, LEAGUE.gt3.drivers);
  ok('a DNF is paid nothing', (await econ.wallet(e2, '111')).balance === 750,
     'got ' + (await econ.wallet(e2, '111')).balance);
}

/* ── Custom cards in the set ───────────────────────────── */
console.log('\nCustom cards');
{
  const withCustom = cardSet(LEAGUE.gt3, [
    { id: 'c:peely', name: 'Peely', rarity: 'epic', image: 'x.png', subtitle: 'Wave 2', enabled: 1 },
    { id: 'c:off',   name: 'Hidden', rarity: 'rare', enabled: 0 },
  ]);
  ok('an enabled custom card joins the set', withCustom.some(c => c.id === 'c:peely'));
  ok('a disabled one does not', !withCustom.some(c => c.id === 'c:off'));
  const peely = withCustom.find(c => c.id === 'c:peely');
  ok('it keeps the rarity it was given', peely.rarity === 'epic');
  ok('it is marked custom', peely.custom === true);
  ok('and the driver cards are unaffected', withCustom.filter(c => !c.custom).length === 3);

  const bad = cardSet(LEAGUE.gt3, [{ id: 'c:x', name: 'X', rarity: 'mythic', enabled: 1 }]);
  ok('a rarity that is not real falls back to rare',
     bad.find(c => c.id === 'c:x').rarity === 'rare');

  // Custom ids must not collide with driver ids.
  const e = env();
  const id = await econ.saveCustomCard(e, { name: 'd1', rarity: 'rare' });
  ok('a custom card id is always prefixed', id.startsWith('c:'), id);
  ok('so it cannot collide with a driver id', id !== 'd1');

  // Deleting a custom card removes it from collections too.
  e._t.card_collection.set('111|all|c:d1',
    { user_id: '111', class: 'all', driver_id: 'c:d1', rarity: 'rare', copies: 2 });
  await econ.deleteCustomCard(e, 'c:d1');
  ok('deleting a card takes it out of collections', !e._t.card_collection.has('111|all|c:d1'));
}

/* ── One set ───────────────────────────────────────────── */
console.log('\nOne set');
{
  const all = combinedSet(LEAGUE, []);
  ok('both classes are in the set', all.some(c => c.name === 'Alpha') && all.some(c => c.name === 'Delta'));
  ok('a driver entered in both classes appears once',
     all.filter(c => c.name === 'Alpha').length === 1);
  const alpha = all.find(c => c.name === 'Alpha');
  ok('at the better of their two rarities', alpha.rarity === 'legendary', alpha.rarity);
  ok('five people, five cards', all.length === 5, 'got ' + all.length);
  ok('each card remembers which class earned it',
     all.find(c => c.name === 'Delta').cls === 'gt4');
  ok('the GT4 leader is Legendary in their own right',
     all.find(c => c.name === 'Delta').rarity === 'legendary');

  // Rarity is ranked within a class, so a GT4 leader is not outranked by a
  // GT3 midfielder just because GT3 is the bigger grid.
  const order = all.filter(c => !c.custom).map(c => c.rarity);
  const idx = r => RARITIES.indexOf(r);
  ok('the set reads rarest first',
     order.every((r, i) => i === 0 || idx(order[i - 1]) >= idx(r)), order.join(','));

  const withCustom = combinedSet(LEAGUE, [{ id: 'c:x', name: 'X', rarity: 'epic', enabled: 1 }]);
  ok('custom cards join the one set', withCustom.length === 6);
  ok('a class with no data does not break it', combinedSet({ gt3: LEAGUE.gt3 }, []).length === 3);
  ok('an empty record gives an empty set', combinedSet({}, []).length === 0);
}

/* ── Admin saves ───────────────────────────────────────── */
console.log('\nAdmin');
{
  const e = env();
  const id = await econ.savePack(e, { name: 'Podium Pack!!', price: '2500', size: '3',
    guarantee: 'epic', odds: { common: 0, epic: 50 } });
  ok('a pack id is slugged from the name', id === 'podium-pack', id);
  const p = e._t.pack_type.get(id);
  ok('every pack goes in the one set', p.class === SET);
  ok('numbers arriving as strings are stored as numbers', p.price === 2500 && p.size === 3);
  ok('odds are stored as JSON', typeof p.odds === 'string' && JSON.parse(p.odds).epic === 50);

  await econ.savePack(e, { id, name: 'Podium Pack', price: 3000, size: 3 });
  ok('saving the same id edits rather than duplicating', e._t.pack_type.size === 1);
  ok('and the edit took', e._t.pack_type.get(id).price === 3000);

  const big = await econ.savePack(e, { name: 'Huge', price: 1, size: 500 });
  ok('an absurd pack size is clamped', e._t.pack_type.get(big).size === 20);

  const j = await econ.saveJob(e, { name: 'Test Job', min_pay: 200, max_pay: 50, cooldown_min: 0 });
  ok('a max below the min is corrected rather than stored', e._t.job.get(j).max_pay === 200);
  ok('a zero cooldown becomes at least a minute', e._t.job.get(j).cooldown_min === 1);

  const cfg = await econ.setSettings(e, { daily_amount: '999', nonsense_key: 'x' });
  ok('a known setting is saved', cfg.daily_amount === '999');
  ok('an unknown key is ignored', !('nonsense_key' in cfg));
}

/* ── Card art in Discord ───────────────────────────────── */
console.log('\nCard art');
{
  const head = { title: 'opened a pack', description: 'lines', color: 1, footer: { text: 'f' } };
  const withArt = [
    { id: 'a', name: 'Alpha', rarity: 'legendary', cardImage: 'a.png', number: '7', team: 'Red' },
    { id: 'b', name: 'Bravo', rarity: 'rare', photo: 'b.png', number: '', team: '' },
    { id: 'c', name: 'Charlie', rarity: 'common', cardImage: '', photo: '', number: '', team: '' },
  ];
  const out = packEmbeds(head, withArt, { a: 1, b: 3 });
  ok('the summary stays first', out.embeds[0] === head);
  ok('one embed per card that has art', out.embeds.length === 3, 'got ' + out.embeds.length);
  ok('a card with no art is left out', !out.embeds.some(e => /Charlie/.test(e.title || '')));
  ok('the art is a full image, not a corner thumbnail',
     out.embeds[1].image.url === 'a.png' && !out.embeds[1].thumbnail);
  ok('card art is preferred over the driver photo', out.embeds[1].image.url === 'a.png');
  ok('a photo is used when there is no card art', out.embeds[2].image.url === 'b.png');
  ok('each card embed is coloured by its own rarity',
     out.embeds[1].color === RARITY.legendary.colour &&
     out.embeds[2].color === RARITY.rare.colour);
  ok('a first copy is marked new', /NEW/.test(out.embeds[1].description));
  ok('a third copy is marked a duplicate', /duplicate/.test(out.embeds[2].description));

  // Discord takes at most ten embeds in one message.
  const many = Array.from({ length: 20 }, (_, i) =>
    ({ id: 'x' + i, name: 'X' + i, rarity: 'common', cardImage: 'x.png', number: '', team: '' }));
  ok('never more than ten embeds', packEmbeds(head, many, {}).embeds.length === 10,
     String(packEmbeds(head, many, {}).embeds.length));

  // No art anywhere: the old single-embed shape, not an empty gallery.
  const none = packEmbeds(head, [{ id: 'z', name: 'Z', rarity: 'common' }], {});
  ok('a pack with no art at all stays one plain embed', none === head);
}

/* ── Trading ───────────────────────────────────────────── */
console.log('\nTrading');
{
  const e = env();
  const hold = (uid, card, copies) => e._t.card_collection.set(`${uid}|${BUCKET}|${card}`,
    { user_id: uid, class: BUCKET, driver_id: card, rarity: 'rare', copies });

  hold('111', 'd1', 3);          // two spare
  hold('222', 'd2', 2);          // one spare
  hold('111', 'd3', 1);          // no spare

  const bad = await econ.offerTrade(e, who('111'), '222', 'Charlie', 'Bravo', LEAGUE);
  ok('you cannot offer your last copy', /no spare/i.test(bad.title), bad.title);

  const self = await econ.offerTrade(e, who('111'), '111', 'Alpha', 'Bravo', LEAGUE);
  ok('you cannot trade with yourself', /That is you/.test(self.title));

  const same = await econ.offerTrade(e, who('111'), '222', 'Alpha', 'Alpha', LEAGUE);
  ok('the same card on both sides is refused', /Same card/.test(same.title));

  const theyLack = await econ.offerTrade(e, who('111'), '222', 'Alpha', 'Charlie', LEAGUE);
  ok('you cannot ask for a card they have no spare of',
     /They have no spare/.test(theyLack.title), theyLack.title);

  const made = await econ.offerTrade(e, who('111'), '222', 'Alpha', 'Bravo', LEAGUE);
  ok('a good offer is made', /Trade offered/.test(made.title), made.title);
  ok('and nothing has moved yet',
     e._t.card_collection.get(`111|${BUCKET}|d1`).copies === 3 &&
     e._t.card_collection.get(`222|${BUCKET}|d2`).copies === 2);

  const id = [...e._t.trade.keys()][0];
  const notYours = await econ.acceptTrade(e, who('333'), id, LEAGUE);
  ok('someone else cannot accept it', /Not yours/.test(notYours.title), notYours.title);

  const listed = await econ.listTrades(e, who('222'), LEAGUE);
  ok('it shows in their list', /Waiting on you/.test(JSON.stringify(listed.fields)));

  const done = await econ.acceptTrade(e, who('222'), id, LEAGUE);
  ok('the recipient can accept', /Trade done/.test(done.title), done.title);
  ok('the giver loses one', e._t.card_collection.get(`111|${BUCKET}|d1`).copies === 2);
  ok('the receiver gains one', e._t.card_collection.get(`222|${BUCKET}|d1`).copies === 1);
  ok('and the other card comes back', e._t.card_collection.get(`111|${BUCKET}|d2`).copies === 1);
  ok('leaving them one', e._t.card_collection.get(`222|${BUCKET}|d2`).copies === 1);

  const twice = await econ.acceptTrade(e, who('222'), id, LEAGUE);
  ok('it cannot be accepted twice', /Already settled/.test(twice.title), twice.title);
}

console.log('\nTrades that go stale');
{
  const e = env();
  const hold = (uid, card, copies) => e._t.card_collection.set(`${uid}|${BUCKET}|${card}`,
    { user_id: uid, class: BUCKET, driver_id: card, rarity: 'rare', copies });
  hold('111', 'd1', 2); hold('222', 'd2', 2);
  await econ.offerTrade(e, who('111'), '222', 'Alpha', 'Bravo', LEAGUE);
  const id = [...e._t.trade.keys()][0];

  // The spare is sold between the offer and the answer.
  e._t.card_collection.get(`111|${BUCKET}|d1`).copies = 1;
  const gone = await econ.acceptTrade(e, who('222'), id, LEAGUE);
  ok('a spare sold in the meantime kills the trade', /has gone/.test(gone.title), gone.title);
  ok('and the offer is closed', e._t.trade.get(id).status === 'dead');
  ok('with nothing moved', !e._t.card_collection.has(`222|${BUCKET}|d1`));

  // Expiry.
  hold('111', 'd1', 2);
  await econ.offerTrade(e, who('111'), '222', 'Alpha', 'Bravo', LEAGUE);
  const id2 = [...e._t.trade.keys()].pop();
  e._t.trade.get(id2).created_at = Date.now() - 72 * 3600e3;
  const late = await econ.acceptTrade(e, who('222'), id2, LEAGUE);
  ok('an old offer expires', /Too late/.test(late.title), late.title);
}

console.log('\nDeclining and cancelling');
{
  const e = env();
  const hold = (uid, card, copies) => e._t.card_collection.set(`${uid}|${BUCKET}|${card}`,
    { user_id: uid, class: BUCKET, driver_id: card, rarity: 'rare', copies });
  hold('111', 'd1', 2); hold('222', 'd2', 2);
  await econ.offerTrade(e, who('111'), '222', 'Alpha', 'Bravo', LEAGUE);
  const id = [...e._t.trade.keys()][0];

  const wrongWay = await econ.closeTrade(e, who('111'), id, 'declined');
  ok('the offerer cannot decline their own offer', /Not yours/.test(wrongWay.title));
  const cancelled = await econ.closeTrade(e, who('111'), id, 'cancelled');
  ok('but they can cancel it', /Cancelled/.test(cancelled.title), cancelled.title);
  ok('and it is closed', e._t.trade.get(id).status === 'cancelled');

  const after = await econ.acceptTrade(e, who('222'), id, LEAGUE);
  ok('a cancelled trade cannot then be accepted', /Already settled/.test(after.title));
}

/* ── Ending a card season ──────────────────────────────── */
console.log('\nCard seasons');
{
  const e = env();
  const hold = (uid, card, copies) => e._t.card_collection.set(`${uid}|${BUCKET}|${card}`,
    { user_id: uid, class: BUCKET, driver_id: card, rarity: 'rare', copies });
  hold('111','d1',3); hold('111','d2',1); hold('222','d1',2);
  e._t.card_packs.set('111', { total_packs: 4, total_cards: 20 });

  const kept = await econ.endCardSeason(e, { name: 'Season 1 cards', clear: false });
  ok('it counts the collectors', kept.holders === 2, String(kept.holders));
  ok('and the cards', kept.cards === 6, String(kept.cards));
  ok('a snapshot is taken', e._t.card_season_holding.size === 3,
     String(e._t.card_season_holding.size));
  ok('archive-and-keep leaves collections alone', e._t.card_collection.size === 3);
  ok('and leaves the pack counts alone', e._t.card_packs.size === 1);

  const seasons = await econ.listCardSeasons(e);
  ok('the season is listed', seasons.length === 1 && seasons[0].name === 'Season 1 cards');
  ok('with its leading collectors', seasons[0].top.length === 2);
  ok('ranked by unique cards held', seasons[0].top[0].user_id === '111',
     JSON.stringify(seasons[0].top));

  const wiped = await econ.endCardSeason(e, { name: 'Season 2 cards', clear: true });
  ok('archive-and-clear empties every collection', e._t.card_collection.size === 0);
  ok('and resets the pack counters', e._t.card_packs.size === 0);
  ok('but only after the snapshot exists',
     [...e._t.card_season_holding.values()].some(h => h.season_id === 'season-2-cards'));
  ok('and it is marked as cleared', wiped.cleared === true);

  let threw = null;
  try { await econ.endCardSeason(e, { name: 'Empty', clear: true }); }
  catch (err) { threw = err.message; }
  ok('ending a season nobody collected in is refused',
     /nobody holds any cards/.test(threw || ''), threw);
}

console.log('\nDELETING A BATCH OF CUSTOM CARDS');
{
  const e = env();
  const mk = (id, rarity) => e._t.custom_card.set(id, { id, name: id, rarity, class: BUCKET });
  mk('c:pfp-ben', 'common'); mk('c:pfp-sam', 'common'); mk('c:pfp-joe', 'common');
  mk('c:gold-ben', 'legendary'); mk('c:gold-sam', 'legendary');

  // Two people hold copies of the cards about to go.
  e._t.card_collection.set('1|c:pfp-ben', { user_id: '1', class: BUCKET, driver_id: 'c:pfp-ben', copies: 2 });
  e._t.card_collection.set('2|c:pfp-ben', { user_id: '2', class: BUCKET, driver_id: 'c:pfp-ben', copies: 1 });
  e._t.card_collection.set('1|c:gold-ben', { user_id: '1', class: BUCKET, driver_id: 'c:gold-ben', copies: 1 });

  const out = await econ.deleteCustomCards(e, ['c:pfp-ben', 'c:pfp-sam', 'c:pfp-joe']);
  ok('it reports how many went', out.deleted === 3, JSON.stringify(out));
  ok('the old commons are gone', !e._t.custom_card.has('c:pfp-ben') &&
     !e._t.custom_card.has('c:pfp-sam') && !e._t.custom_card.has('c:pfp-joe'));
  ok('the new ones are untouched', e._t.custom_card.has('c:gold-ben') &&
     e._t.custom_card.has('c:gold-sam'), String(e._t.custom_card.size));

  // A card nobody can render must not stay in a collection.
  ok('copies people pulled go too',
     ![...e._t.card_collection.values()].some(r => r.driver_id === 'c:pfp-ben'),
     JSON.stringify([...e._t.card_collection.values()]));
  ok('but only of the deleted cards',
     [...e._t.card_collection.values()].some(r => r.driver_id === 'c:gold-ben'));

  // The things that would make a bulk delete dangerous.
  ok('nothing selected deletes nothing', (await econ.deleteCustomCards(e, [])).deleted === 0);
  ok('and neither does rubbish', (await econ.deleteCustomCards(e, null)).deleted === 0);
  ok('the other cards survived all that', e._t.custom_card.size === 2, String(e._t.custom_card.size));

  const dupes = await econ.deleteCustomCards(e, ['c:gold-sam', 'c:gold-sam', '']);
  ok('a repeated id counts once', dupes.deleted === 1, JSON.stringify(dupes));

  // More than one chunk, since D1 will not take an unbounded batch.
  const e2 = env();
  const many = [];
  for (let i = 0; i < 60; i++) { const id = `c:x${i}`; many.push(id);
    e2._t.custom_card.set(id, { id, name: id, rarity: 'common', class: BUCKET }); }
  const big = await econ.deleteCustomCards(e2, many);
  ok('a batch larger than one chunk still clears', big.deleted === 60, JSON.stringify(big));
  ok('and leaves nothing behind', e2._t.custom_card.size === 0, String(e2._t.custom_card.size));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
