/**
 * The two games where the money comes from other players.
 *
 * Against the bank you only have to get the paytable right. Here a stake
 * moves between people, so the things worth testing are not the dice:
 * they are that a stake leaves exactly once, arrives exactly once, and
 * that no sequence of taps makes credits out of nothing.
 */
import { rollDuel, duelPrize, startDuel, onDuelButton, sweepDuels,
         buyTickets, showLottery, runLotteryDraw, pickWinner, openDraw,
         drawState, DUEL_RAKE, DUEL_EXPIRY_MIN, LOTTERY_MIN_PLAYERS }
  from '../worker/src/wagers.js';

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL  ' + n + (x ? '  →  ' + x : '')); } };

/* ── a D1 that knows only what these two games touch ───── */
function makeDB() {
  const t = { wallet: new Map(), ledger: [], setting: new Map(),
              duel: new Map(), draw: new Map(), ticket: new Map() };
  const run = async (q, a) => {
    q = q.replace(/\s+/g, ' ').trim();

    if (/SELECT key, value FROM econ_setting/.test(q)) {
      return { results: [...t.setting.entries()].map(([key, value]) => ({ key, value })) };
    }
    if (/SELECT balance, lifetime FROM wallet/.test(q)) return t.wallet.get(a[0]) || null;
    if (/INSERT INTO wallet/.test(q)) {
      if (!t.wallet.has(a[0])) t.wallet.set(a[0], { balance: a[1], lifetime: a[2] });
      return {};
    }
    if (/UPDATE wallet SET balance = balance \+ \?, updated_at/.test(q)) {
      const w = t.wallet.get(a[2]);
      if (!w || w.balance < a[3]) return { meta: { changes: 0 } };
      w.balance += a[0];
      return { meta: { changes: 1 } };
    }
    if (/UPDATE wallet SET balance = balance \+ \?, lifetime/.test(q)) {
      const w = t.wallet.get(a[3]);
      if (w) { w.balance += a[0]; w.lifetime += a[1]; }
      return { meta: { changes: 1 } };
    }
    if (/INSERT INTO ledger/.test(q)) { t.ledger.push({ user_id: a[0], delta: a[1], reason: a[2] }); return {}; }

    // duels
    if (/INSERT INTO duel/.test(q)) {
      t.duel.set(a[0], { id: a[0], challenger: a[1], opponent: a[2], stake: a[3],
                         status: 'open', winner: null, detail: null, at: a[4] });
      return {};
    }
    if (/SELECT \* FROM duel WHERE id/.test(q)) return t.duel.get(a[0]) || null;
    if (/SELECT id, challenger, stake FROM duel WHERE status = 'open' AND at </.test(q)) {
      return { results: [...t.duel.values()].filter(d => d.status === 'open' && d.at < a[0]) };
    }
    if (/UPDATE duel SET status = \? , decided_at|UPDATE duel SET status = \?, decided_at/.test(q)) {
      const d = t.duel.get(a[2]);
      if (!d || d.status !== 'open') return { meta: { changes: 0 } };
      d.status = a[0]; d.decided_at = a[1];
      return { meta: { changes: 1 } };
    }
    if (/UPDATE duel SET status = 'declined'/.test(q) || /UPDATE duel SET status = 'played'/.test(q)
        || /UPDATE duel SET status = 'expired'/.test(q)) {
      const want = q.match(/status = '(\w+)'/)[1];
      const d = t.duel.get(a[1]);
      if (!d || d.status !== 'open') return { meta: { changes: 0 } };
      d.status = want; d.decided_at = a[0];
      return { meta: { changes: 1 } };
    }
    if (/UPDATE duel SET winner = \?, detail/.test(q)) {
      const d = t.duel.get(a[2]); if (d) { d.winner = a[0]; d.detail = a[1]; }
      return { meta: { changes: 1 } };
    }

    // lottery
    if (/SELECT \* FROM lottery_draw WHERE status = 'open'/.test(q)) {
      return [...t.draw.values()].filter(d => d.status === 'open').sort((x, y) => y.n - x.n)[0] || null;
    }
    if (/SELECT \* FROM lottery_draw WHERE status = 'drawn'/.test(q)) {
      return [...t.draw.values()].filter(d => d.status === 'drawn').sort((x, y) => y.n - x.n)[0] || null;
    }
    if (/SELECT MAX\(n\) AS n FROM lottery_draw/.test(q)) {
      const ns = [...t.draw.keys()];
      return { n: ns.length ? Math.max(...ns) : 0 };
    }
    if (/SELECT \* FROM lottery_draw WHERE n/.test(q)) return t.draw.get(a[0]) || null;
    if (/INSERT INTO lottery_draw/.test(q)) {
      // Two forms: opening a draw hard-codes pot 0 and binds (n, now);
      // rolling one binds (n, pot, now). Reading them the same way put a
      // timestamp in the pot.
      const opening = /VALUES \(\?, 0,/.test(q);
      t.draw.set(a[0], { n: a[0], pot: opening ? 0 : a[1], status: 'open',
                         opened_at: opening ? a[1] : a[2],
                         winner: null, won: null, tickets: null, players: null });
      return {};
    }
    if (/UPDATE lottery_draw SET pot = pot \+ \?/.test(q)) {
      const d = t.draw.get(a[1]); if (d) d.pot += a[0]; return {};
    }
    if (/UPDATE lottery_draw SET status = '(drawn|rolled)'/.test(q)) {
      const want = q.match(/status = '(\w+)'/)[1];
      const d = t.draw.get(a[1]);
      if (!d || d.status !== 'open') return { meta: { changes: 0 } };
      d.status = want; d.drawn_at = a[0];
      return { meta: { changes: 1 } };
    }
    if (/UPDATE lottery_draw SET winner/.test(q)) {
      const d = t.draw.get(a[4]);
      if (d) Object.assign(d, { winner: a[0], won: a[1], tickets: a[2], players: a[3] });
      return {};
    }
    if (/SELECT user_id, tickets FROM lottery_ticket WHERE draw/.test(q)) {
      return { results: [...t.ticket.values()].filter(r => r.draw === a[0])
                 .map(r => ({ user_id: r.user_id, tickets: r.tickets })) };
    }
    if (/INSERT INTO lottery_ticket/.test(q)) {
      const key = a[0] + '|' + a[1];
      const prev = t.ticket.get(key);
      t.ticket.set(key, { draw: a[0], user_id: a[1],
        tickets: (prev ? prev.tickets : 0) + a[2], spent: (prev ? prev.spent : 0) + a[3], at: a[4] });
      return {};
    }
    if (/UPDATE lottery_ticket SET draw = \?/.test(q)) {
      for (const [k, v] of [...t.ticket.entries()]) {
        if (v.draw === a[1]) { t.ticket.delete(k); v.draw = a[0]; t.ticket.set(a[0] + '|' + v.user_id, v); }
      }
      return {};
    }
    throw new Error('unexpected sql: ' + q.slice(0, 90));
  };

  const prep = sql => { let b = []; return {
    bind(...x) { b = x; return this; },
    async run()   { return (await run(sql, b)) || {}; },
    async first() { return await run(sql, b); },
    async all()   { const r = await run(sql, b); return r && r.results ? r : { results: [] }; },
  }; };
  return { _t: t, prepare: prep, batch: async st => { for (const s of st) await s.run(); return []; } };
}

const env = () => { const DB = makeDB(); return { DB, _t: DB._t }; };
const give = (e, id, n) => e._t.wallet.set(id, { balance: n, lifetime: n });
const bal  = (e, id) => (e._t.wallet.get(id) || { balance: 0 }).balance;
const who  = id => ({ member: { user: { id, username: 'u' + id } } });
const txt  = r => JSON.stringify(r);

/* ── duels ─────────────────────────────────────────────── */
console.log('DICE');
{
  let hi = 0, lo = 0;
  for (let i = 0; i < 4000; i++) {
    const r = rollDuel();
    if (r.sa === r.sb) { fail++; console.log('  FAIL  a tie was returned'); break; }
    r.winner === 'challenger' ? hi++ : lo++;
  }
  ok('it never returns a tie', true);
  ok('neither side is favoured', Math.abs(hi - lo) < 250, `${hi} v ${lo}`);
  ok('two dice each', rollDuel().a.length === 2 && rollDuel().b.length === 2);
  ok('totals match the dice', (() => { const r = rollDuel();
      return r.sa === r.a[0] + r.a[1] && r.sb === r.b[0] + r.b[1]; })());
  ok('every face is possible', (() => {
      const seen = new Set();
      for (let i = 0; i < 2000; i++) rollDuel().a.forEach(d => seen.add(d));
      return seen.size === 6; })());

  // The rake is the only money the house takes here.
  ok('the winner gets the pot less the rake', duelPrize(1000) === 1900, String(duelPrize(1000)));
  ok('which is the stated percentage',
     Math.abs((2000 - duelPrize(1000)) / 2000 - DUEL_RAKE) < 1e-9);
  ok('and is never more than the pot', duelPrize(50) < 100 && duelPrize(50) > 50);
}

console.log('\nA DUEL, END TO END');
{
  const e = env(); give(e, 'a', 10000); give(e, 'b', 10000);
  const out = await startDuel(e, who('a'), 'b', 1000);
  ok('the challenger pays up front', bal(e, 'a') === 9000, String(bal(e, 'a')));
  ok('the opponent does not, yet', bal(e, 'b') === 10000, String(bal(e, 'b')));
  ok('the person called out is pinged', /"users":\["b"\]/.test(txt(out)), txt(out).slice(0, 120));
  ok('with accept and decline',
     /du:[\w-]+:accept/.test(txt(out)) && /du:[\w-]+:decline/.test(txt(out)));

  const id = txt(out).match(/du:([\w-]+):accept/)[1];
  // Nobody else may answer it.
  const nosy = await onDuelButton(e, who('c'), id, 'accept');
  ok('a bystander cannot accept', /not yours to answer/.test(txt(nosy)), txt(nosy));
  ok('and nothing moved', bal(e, 'a') === 9000 && bal(e, 'b') === 10000);

  const played = await onDuelButton(e, who('b'), id, 'accept');
  const total = bal(e, 'a') + bal(e, 'b');
  ok('it resolves', /takes/.test(txt(played)), txt(played).slice(0, 160));
  ok('exactly the rake leaves the two of them', total === 20000 - 100, String(total));
  // Either side can win, so assert on the pair rather than on a name.
  // Both staked 1000 up front, so the winner lands on 10900 and the
  // loser on 9000 whichever way the dice went.
  const [top, bottom] = [bal(e, 'a'), bal(e, 'b')].sort((x, y) => y - x);
  ok('the winner ends 900 up', top === 10900, String(top));
  ok('and the loser 1000 down', bottom === 9000, String(bottom));
  ok('the buttons go', (played.data.components || []).length === 0);

  const again = await onDuelButton(e, who('b'), id, 'accept');
  ok('it cannot be accepted twice', /already been answered/.test(txt(again)));
  ok('and nothing moved again', bal(e, 'a') + bal(e, 'b') === 19900);
}

console.log('\nDECLINING, AND NOT BEING ABLE TO PAY');
{
  const e = env(); give(e, 'a', 10000); give(e, 'b', 10000);
  const out = await startDuel(e, who('a'), 'b', 2000);
  const id = txt(out).match(/du:([\w-]+):accept/)[1];
  const no = await onDuelButton(e, who('b'), id, 'decline');
  ok('declining says so', /Declined/.test(txt(no)));
  ok('and gives the stake back', bal(e, 'a') === 10000, String(bal(e, 'a')));
  ok('the opponent is untouched', bal(e, 'b') === 10000);
  ok('a declined duel cannot then be accepted',
     /already been answered/.test(txt(await onDuelButton(e, who('b'), id, 'accept'))));
  ok('and still nobody paid', bal(e, 'a') === 10000 && bal(e, 'b') === 10000);

  const poor = env(); give(poor, 'a', 10000); give(poor, 'b', 100);
  const o2 = await startDuel(poor, who('a'), 'b', 5000);
  const id2 = txt(o2).match(/du:([\w-]+):accept/)[1];
  const cant = await onDuelButton(poor, who('b'), id2, 'accept');
  ok('somebody who cannot match it is told', /you have/.test(txt(cant)), txt(cant));
  ok('their money is untouched', bal(poor, 'b') === 100);
  ok('and the challenge is still open for another go',
     poor._t.duel.get(id2).status === 'open');

  ok('you cannot duel yourself',
     /cannot duel yourself/.test(txt(await startDuel(env(), who('a'), 'a', 500))));
  const broke = env(); give(broke, 'a', 10);
  ok('nor stake what you do not have',
     /Not enough/.test(txt(await startDuel(broke, who('a'), 'b', 5000))));
  ok('and that takes nothing', bal(broke, 'a') === 10);
}

console.log('\nCHALLENGES NOBODY ANSWERS');
{
  const e = env(); give(e, 'a', 10000); give(e, 'b', 10000);
  const out = await startDuel(e, who('a'), 'b', 1500);
  const id = txt(out).match(/du:([\w-]+):accept/)[1];
  ok('a fresh challenge is not swept', (await sweepDuels(e)) === 0);
  ok('and the stake stays out', bal(e, 'a') === 8500);

  e._t.duel.get(id).at = Date.now() - (DUEL_EXPIRY_MIN + 1) * 60000;
  ok('an old one is', (await sweepDuels(e)) === 1);
  ok('the stake comes back', bal(e, 'a') === 10000, String(bal(e, 'a')));
  ok('it is marked expired', e._t.duel.get(id).status === 'expired');
  ok('sweeping again refunds nothing', (await sweepDuels(e)) === 0);
  ok('so it is never paid twice', bal(e, 'a') === 10000);
  ok('and an expired one cannot be accepted',
     /already been answered/.test(txt(await onDuelButton(e, who('b'), id, 'accept'))));
}

/* ── lottery ───────────────────────────────────────────── */
console.log('\nTHE DRAW IS WEIGHTED BY TICKETS');
{
  const held = [{ user_id: 'a', tickets: 1 }, { user_id: 'b', tickets: 9 }];
  ok('the first ticket wins on a low roll', pickWinner(held, () => 0.0) === 'a');
  ok('the bulk holder on a high one', pickWinner(held, () => 0.99) === 'b');
  ok('the boundary belongs to the second', pickWinner(held, () => 0.1) === 'b');
  let b = 0;
  for (let i = 0; i < 6000; i++) if (pickWinner(held) === 'b') b++;
  ok('nine tickets in ten wins about nine times in ten',
     Math.abs(b / 6000 - 0.9) < 0.03, String((b / 6000).toFixed(3)));
  ok('no tickets, no winner', pickWinner([]) === null);
  ok('zero-ticket rows cannot win', pickWinner([{ user_id: 'z', tickets: 0 }]) === null);
}

console.log('\nBUYING IN');
{
  const e = env(); give(e, 'a', 10000);
  const r = await buyTickets(e, who('a'), 3);
  ok('tickets cost what they cost', bal(e, 'a') === 8500, String(bal(e, 'a')));
  ok('and it says how many you hold', /\*\*3\*\*/.test(txt(r)), txt(r).slice(0, 180));
  const s = await drawState(e, 1);
  ok('the pot holds the money', s.pot === 1500, String(s.pot));
  ok('one player so far', s.players === 1);

  await buyTickets(e, who('a'), 2);
  const s2 = await drawState(e, 1);
  ok('buying again adds rather than replaces', s2.mine('a') === 5, String(s2.mine('a')));
  ok('and the pot grows with it', s2.pot === 2500, String(s2.pot));
  ok('still one player', s2.players === 1);

  const poor = env(); give(poor, 'b', 100);
  ok('you cannot buy what you cannot afford',
     /Not enough/.test(txt(await buyTickets(poor, who('b'), 1))));
  ok('and that takes nothing', bal(poor, 'b') === 100);

  const many = env(); give(many, 'c', 10_000_000);
  await buyTickets(many, who('c'), 999);
  ok('a silly number of tickets is capped at 100',
     (await drawState(many, 1)).mine('c') === 100,
     String((await drawState(many, 1)).mine('c')));
}

console.log('\nDRAWING IT');
{
  const e = env(); give(e, 'a', 10000); give(e, 'b', 10000);
  await buyTickets(e, who('a'), 2);
  await buyTickets(e, who('b'), 2);
  const pot = (await drawState(e, 1)).pot;

  ok('it is not drawn before it is due', (await runLotteryDraw(e)) === null);
  ok('and the pot is still there', (await drawState(e, 1)).pot === pot);

  const later = Date.now() + 25 * 3600000;
  const drew = await runLotteryDraw(e, later);
  ok('it draws when due', drew && !drew.rolled, txt(drew));
  ok('the winner is one of the two', ['a', 'b'].includes(drew.winner), txt(drew));
  ok('the whole pot is paid out', drew.pot === pot, `${drew.pot} v ${pot}`);
  ok('nothing is created or destroyed',
     bal(e, 'a') + bal(e, 'b') === 20000, String(bal(e, 'a') + bal(e, 'b')));
  ok('the winner is up by the other side\'s stake',
     bal(e, drew.winner) === 10000 + pot / 2, String(bal(e, drew.winner)));
  ok('drawing again does nothing', (await runLotteryDraw(e, later)) === null);
  ok('and pays nobody twice', bal(e, 'a') + bal(e, 'b') === 20000);
}

console.log('\nTOO FEW PLAYERS, SO IT ROLLS');
{
  const e = env(); give(e, 'a', 10000);
  await buyTickets(e, who('a'), 4);
  const later = Date.now() + 25 * 3600000;
  const out = await runLotteryDraw(e, later);
  ok('it rolls rather than drawing', out && out.rolled === true, txt(out));
  ok('nobody is paid', bal(e, 'a') === 8000, String(bal(e, 'a')));
  ok('the pot carries into the next draw',
     (await drawState(e, out.into)).pot === 2000,
     String((await drawState(e, out.into)).pot));
  ok('and so do the tickets already bought',
     (await drawState(e, out.into)).mine('a') === 4);
  ok('needing more than one player is the reason', LOTTERY_MIN_PLAYERS === 2);

  // Second player joins the rolled pot and it can be drawn.
  give(e, 'b', 10000);
  await buyTickets(e, who('b'), 4);
  const drew = await runLotteryDraw(e, later + 25 * 3600000);
  ok('the rolled pot is then won', drew && !drew.rolled, txt(drew));
  ok('and it includes the money that rolled over', drew.pot === 4000, String(drew.pot));
  ok('with the books still balanced',
     bal(e, 'a') + bal(e, 'b') === 20000, String(bal(e, 'a') + bal(e, 'b')));
}

console.log('\nWHAT THE PANEL SHOWS');
{
  const e = env(); give(e, 'a', 10000);
  const empty = await showLottery(e, who('a'));
  ok('an empty pot still answers', /draw 1/.test(txt(empty)), txt(empty).slice(0, 140));
  ok('and nudges you to buy', /lottery buy/.test(txt(empty)));
  await buyTickets(e, who('a'), 1);
  const some = await showLottery(e, who('a'));
  ok('it shows your odds once you are in', /shot/.test(txt(some)), txt(some).slice(0, 220));
  ok('and warns when it will roll', /rolls into the next draw/.test(txt(some)));
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
