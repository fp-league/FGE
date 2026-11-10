import { cardSet, openPack, showCollection, showMissing, showCard, showCollectors, grantPacks,
         grantPackType, giveCard } from '../worker/src/cards.js';
let pass=0,fail=0;
const ok=(n,c,x)=>{if(c){pass++;console.log('  ✓ '+n);}else{fail++;console.log('  ✗ '+n+(x?'  → '+x:''));}};

// ── a tiny in-memory stand-in for D1 ──
function fakeDB() {
  const coll = new Map();           // `${u}|${c}|${d}` -> {rarity,copies,first_at}
  const packs = new Map();          // u -> {last_opened,total_packs,total_cards}
  const grants = new Map();         // u -> {packs,total}
  const typed = new Map();          // `${u}|${packId}` -> {packs,total,updated_at}
  const packTypes = new Map();      // id -> row
  const run = (sql, b) => {
    const q = sql.replace(/\s+/g,' ').trim();
    if (q.startsWith('INSERT INTO card_collection')) {
      // openPack binds a literal 1; giveCard binds the count it was asked
      // for, so the two differ by one argument and by the VALUES clause.
      const explicit = /VALUES \(\?, \?, \?, \?, \?, \?\)/.test(q);
      const [u,c,d,r]=b;
      const n = explicit ? b[4] : 1;
      const t = explicit ? b[5] : b[4];
      const k=`${u}|${c}|${d}`;
      const cur=coll.get(k);
      coll.set(k, cur?{...cur,copies:cur.copies+n,rarity:r}:{rarity:r,copies:n,first_at:t});
      return {};
    }
    if (q.startsWith('INSERT INTO pack_grant')) {
      const [u,pid,n]=b; const k=`${u}|${pid}`; const cur=typed.get(k);
      typed.set(k, cur?{packs:cur.packs+n,total:cur.total+n,updated_at:b[4]}
                     :{packs:n,total:n,updated_at:b[4]});
      return {};
    }
    if (q.startsWith('UPDATE pack_grant')) {
      const cur=typed.get(`${b[1]}|${b[2]}`); if(cur) cur.packs--;
      return {};
    }
    if (q.startsWith('INSERT INTO card_packs')) {
      const literalZero = /VALUES \(\?, 0, 1, \?\)/.test(q);
      const u = b[0];
      const when = literalZero ? 0 : b[1];
      const n = literalZero ? b[1] : b[2];
      const cur=packs.get(u);
      // Model the ON CONFLICT clause: the grant path deliberately leaves
      // last_opened alone so a bonus pack does not burn the free one.
      const touchesCooldown = /last_opened = excluded\.last_opened/.test(q);
      packs.set(u, cur
        ? { last_opened: touchesCooldown ? when : cur.last_opened,
            total_packs: cur.total_packs+1, total_cards: cur.total_cards+n }
        : { last_opened: when, total_packs: 1, total_cards: n });
      return {};
    }
    if (q.startsWith('INSERT INTO card_grants')) {
      const [u,n]=b; const cur=grants.get(u);
      grants.set(u, cur?{packs:cur.packs+n,total:cur.total+n}:{packs:n,total:n});
      return {};
    }
    if (q.startsWith('UPDATE card_grants')) {
      const u=b[1]; const cur=grants.get(u); if(cur) cur.packs--;
      return {};
    }
    throw new Error('unhandled run: '+q);
  };
  const snap = o => (o ? { ...o } : null);     // D1 returns a row, not a live object
  const first = (sql,b) => {
    const q = sql.replace(/\s+/g,' ').trim();
    if (q.includes('FROM card_packs')) return snap(packs.get(b[0]));
    if (q.includes('FROM pack_grant g JOIN pack_type p')) {
      const mine=[...typed.entries()].filter(([k,v])=>k.startsWith(b[0]+'|') && v.packs>0)
        .sort((x,y)=>x[1].updated_at-y[1].updated_at)[0];
      if (!mine) return null;
      const pid = mine[0].split('|')[1];
      const pt = packTypes.get(pid) || {};
      return { pack_id: pid, packs: mine[1].packs, name: pt.name, emoji: pt.emoji,
               size: pt.size, odds: pt.odds, pool: pt.pool, guarantee: pt.guarantee };
    }
    if (q.includes('FROM pack_grant WHERE user_id = ? AND pack_id = ?'))
      return snap(typed.get(`${b[0]}|${b[1]}`));
    if (q.includes('FROM pack_type WHERE id')) return snap(packTypes.get(b[0])) ;
    if (q.includes('FROM card_grants')) return snap(grants.get(b[0]));
    if (q.includes('FROM card_collection WHERE user_id = ? AND class = ? AND driver_id = ?'))
      return snap(coll.get(`${b[0]}|${b[1]}|${b[2]}`));
    if (q.startsWith('SELECT 1 FROM card_collection')) return null;
    throw new Error('unhandled first: '+q);
  };
  const all = (sql,b) => {
    const q = sql.replace(/\s+/g,' ').trim();
    // Every spare in the league except this person's own.
    if (q.includes('SELECT DISTINCT driver_id')) {
      const out = [];
      for (const [k, v] of coll) { const [u, c, d] = k.split('|');
        if (c === b[0] && v.copies > 1 && u !== String(b[1])) out.push({ driver_id: d }); }
      return { results: [...new Map(out.map(r => [r.driver_id, r])).values()] };
    }
    // Just the ids somebody holds, which is all /cards missing needs.
    if (/^SELECT driver_id FROM card_collection/.test(q)) {
      const out = [];
      for (const [k, v] of coll) { const [u, c, d] = k.split('|');
        if (u === b[0] && c === b[1]) out.push({ driver_id: d }); }
      return { results: out };
    }
    if (q.includes('SELECT driver_id, rarity, copies') || q.includes('SELECT driver_id, copies')) {
      const out=[];
      for (const [k,v] of coll) { const [u,c,d]=k.split('|');
        if(u===b[0]&&c===b[1]) out.push({driver_id:d,rarity:v.rarity,copies:v.copies}); }
      return {results:out};
    }
    if (q.includes('GROUP BY user_id')) {
      const per={};
      for (const [k,v] of coll) { const [u,c]=k.split('|');
        if(c!==b[0]) continue; (per[u]??={held:0,cards:0}); per[u].held++; per[u].cards+=v.copies; }
      return {results:Object.entries(per).map(([user_id,v])=>({user_id,...v}))
        .sort((a,b)=>b.held-a.held).slice(0,10)};
    }
    throw new Error('unhandled all: '+q);
  };
  const prepare = sql => ({ bind:(...b)=>({ run:async()=>run(sql,b), first:async()=>first(sql,b), all:async()=>all(sql,b), _sql:sql,_b:b }) });
  return { prepare, batch: async stmts => { for(const s of stmts) await s.run(); },
           _coll:coll, _packs:packs, _grants:grants, _typed:typed, _packTypes:packTypes };
}

const mk=(id,name,team)=>({id,name,team,number:id.slice(1),nationality:'GB',photo:`https://x/${id}.png`});
const drivers=[mk('d1','Maxi','Apex'),mk('d2','Morrison','Vortex'),mk('d3','Kai','Apex'),
               mk('d4','Rees','Nord'),mk('d5','Vale','Nord'),mk('d6','Hollis','Crimson'),
               mk('d7','Tanaka','Crimson'),mk('d8','Newcomer','Apex')];
const res=(...k)=>k.map((x,i)=>({driver:drivers.find(d=>d.id===x).name,driverId:x,pos:i+1}));
const CD={ drivers, teams:[], points:{table:[20,15,12,10,8,6,4,3,2,1],fastestLap:1,dotd:0},
  races:[
    {round:1,results:res('d1','d2','d3','d4','d5','d6','d7'),fastestLap:'d1'},
    {round:2,results:res('d2','d1','d4','d3','d5','d6','d7')},
    {round:3,results:res('d1','d2','d3','d5','d4','d6','d7')},
  ]};
// Totals: Maxi 56, Morrison 50, Kai 34, Rees 30, Vale 26, Hollis 18, Tanaka 12.
// Rees is the useful case: a race podium (R2 P3) but only 4th overall.
const RECORD={gt3:CD,gt4:{drivers:[],teams:[],races:[]}};
const inter=(id,name)=>({member:{user:{id,username:name,global_name:name}}});

/* A pack with card art answers with several embeds — a summary followed by
   one per card. Everything these tests assert about lives on the summary. */
const head=r=>(r && Array.isArray(r.embeds) ? r.embeds[0] : r);

console.log('\nRARITY IS EARNED');
{
  const set=cardSet(CD);
  const by=n=>set.find(c=>c.name===n);
  ok('every driver is in the set', set.length===8, String(set.length));
  // Maxi 20+1+15=36, Morrison 15+20=35
  ok('championship leader is legendary', by('Maxi').rarity==='legendary', by('Maxi').rarity);
  ok('championship runner-up is epic', by('Morrison').rarity==='epic', by('Morrison').rarity);
  ok('championship third is still epic', by('Kai').rarity==='epic', by('Kai').rarity);
  ok('a race podium but no title fight is rare', by('Rees').rarity==='rare',
     by('Rees').rarity+' pos'+by('Rees').position+' podiums'+by('Rees').podiums);
  ok('a points scorer is uncommon', by('Vale').rarity==='uncommon', by('Vale').rarity);
  ok('someone who never raced is common', by('Newcomer').rarity==='common', by('Newcomer').rarity);
  ok('exactly one legendary', set.filter(c=>c.rarity==='legendary').length===1);
  ok('stats carried on the card, fastest lap included',
     by('Maxi').wins===2 && by('Maxi').points===56 && by('Maxi').podiums===3,
     JSON.stringify({w:by('Maxi').wins,p:by('Maxi').points,pod:by('Maxi').podiums}));
}

console.log('\nOPENING A PACK');
{
  const db=fakeDB();
  const e=head(await openPack({DB:db}, inter('u1','Ben'), RECORD));
  ok('five cards', (e.description.match(/\n/g)||[]).length===4, e.description);
  ok('all marked new on a first pack', !/dupe/.test(e.description), e.description);
  const names=[...e.description.matchAll(/\*\*(.+?)\*\*/g)].map(m=>m[1]);
  ok('no driver appears twice in one pack', new Set(names).size===names.length, names.join(','));
  ok('progress in the footer', /\/8 collected/.test(e.footer.text), e.footer.text);
  ok('stored in the collection', db._coll.size>0 && db._coll.size<=5, String(db._coll.size));
  ok('pack recorded', db._packs.get('u1').total_packs===1);
  ok('card count recorded', db._packs.get('u1').total_cards===5);
}

console.log('\nTHE COOLDOWN HOLDS');
{
  const db=fakeDB();
  await openPack({DB:db}, inter('u1','Ben'), RECORD);
  const second=head(await openPack({DB:db}, inter('u1','Ben'), RECORD));
  ok('a second pack is refused', /Not yet/.test(second.title), second.title);
  ok('it says how long', /ready in \*\*/.test(second.description), second.description);
  ok('nothing extra was stored', db._packs.get('u1').total_packs===1);

  // someone else is unaffected
  const other=head(await openPack({DB:db}, inter('u2','Sam'), RECORD));
  ok('another person can still open', !/Not yet/.test(other.title||''));
}

console.log('\nDUPLICATES STACK');
{
  const db=fakeDB();
  const now=Date.now();
  // force a pack, then rewind the clock so the cooldown has passed
  await openPack({DB:db}, inter('u1','Ben'), RECORD);
  for (let i=0;i<6;i++) {
    db._packs.get('u1').last_opened = now - 9*60*60*1000;
    await openPack({DB:db}, inter('u1','Ben'), RECORD);
  }
  const total=[...db._coll.values()].reduce((n,v)=>n+v.copies,0);
  ok('every card landed somewhere', total===35, String(total));
  ok('collection never exceeds the set', db._coll.size<=8, String(db._coll.size));
  const dupes=[...db._coll.values()].filter(v=>v.copies>1).length;
  ok('duplicates stacked rather than duplicating rows', dupes>0, String(dupes));
}

console.log('\nCOLLECTION');
{
  const db=fakeDB();
  await openPack({DB:db}, inter('u1','Ben'), RECORD);
  const c=await showCollection({DB:db}, inter('u1','Ben'), RECORD);
  ok('shows a count out of the set', /of 8\*\* drivers/.test(c.description), c.description);
  ok('shows a percentage', /% complete/.test(c.description));
  ok('grouped into rarity fields', (c.fields||[]).length>0);
  ok('rarest group first', RARITY_ORDER(c.fields), (c.fields||[]).map(f=>f.name).join(' | '));

  const empty=await showCollection({DB:db}, inter('u9','Nobody'), RECORD);
  ok('empty collection explains how to start', /pack/.test(empty.description), empty.description);
}
console.log('\nWHAT IS MISSING');
{
  const db = fakeDB();
  const env = { DB: db };

  // Nothing opened yet: everything is missing.
  const all = await showMissing(env, inter('u1','Ben'), RECORD);
  ok('a new collector is short the whole set',
     /\*\*8\*\* short/.test(all.description), all.description);
  ok('and is told how far along they are', /0 of 8, 0% complete/.test(all.description),
     all.description);
  ok('the gaps are grouped by rarity', (all.fields || []).length > 0);
  ok('rarest first', RARITY_ORDER(all.fields), (all.fields||[]).map(f=>f.name).join(' | '));
  const named = (all.fields || []).map(f => f.value).join(', ');
  ok('and every card in the set is named somewhere',
     cardSet(RECORD.gt3, null).every(c => named.includes(c.name)), named);

  // Open one pack: the collection and the gaps must add up to the set.
  await openPack(env, inter('u1','Ben'), RECORD);
  const some = await showMissing(env, inter('u1','Ben'), RECORD);
  const held = await showCollection(env, inter('u1','Ben'), RECORD);
  const haveN = Number((held.description.match(/\*\*(\d+) of/) || [])[1]);
  const gapN  = Number((some.description.match(/\*\*(\d+)\*\* short/) || [])[1]);
  ok('what you have and what you are missing add up to the set',
     haveN + gapN === 8, `${haveN} + ${gapN}`);
  ok('nothing you already own is listed as missing', (() => {
    const names = (some.fields || []).map(f => f.value).join(', ');
    const mine  = (held.fields || []).map(f => f.value).join(', ')
      .split(', ').map(x => x.replace(/ ×\d+$/, '')).filter(Boolean);
    return mine.every(n => !names.split(', ').map(v => v.replace(/ · .*$/, '')).includes(n));
  })(), JSON.stringify((some.fields||[]).map(f=>f.value)));

  // The hint that makes it useful: someone else holding a spare.
  const fresh = fakeDB();
  const e2 = { DB: fresh };
  const set = cardSet(RECORD.gt3, null);
  const wanted = set[0];
  // u2 holds two of the first card; u1 holds none of it.
  fresh._coll.set(`u2|all|${wanted.id}`, { rarity: wanted.rarity, copies: 2 });
  const hint = await showMissing(e2, inter('u1','Ben'), RECORD);
  const line = (hint.fields || []).map(f => f.value).join(' | ');
  ok('a card somebody has spare is marked', /spare going/.test(line), line);
  ok('and the footer points at trading', /\/trade offer/.test(hint.footer.text), hint.footer.text);
  ok('only that one is marked', (line.match(/spare going/g) || []).length === 1, line);

  // A single copy is not a spare: nobody trades their only one.
  const only = fakeDB();
  only._coll.set(`u2|all|${wanted.id}`, { rarity: wanted.rarity, copies: 1 });
  const noHint = await showMissing({ DB: only }, inter('u1','Ben'), RECORD);
  ok('one copy is not a spare',
     !/spare going/.test((noHint.fields||[]).map(f=>f.value).join(' ')));
  ok('and it says so plainly', /Nobody has a spare/.test(noHint.footer.text), noHint.footer.text);

  // Your own duplicates must not be offered to you as a trade.
  const mineOnly = fakeDB();
  mineOnly._coll.set(`u1|all|${wanted.id}`, { rarity: wanted.rarity, copies: 3 });
  const self = await showMissing({ DB: mineOnly }, inter('u1','Ben'), RECORD);
  ok('a card you hold is not in your own gaps',
     !(self.fields||[]).map(f=>f.value).join(' ').includes(wanted.name),
     JSON.stringify((self.fields||[]).map(f=>f.value)));

  // The complete set, which is the path that never gets exercised by hand.
  const full = fakeDB();
  set.forEach(c => full._coll.set(`u1|all|${c.id}`, { rarity: c.rarity, copies: 1 }));
  const done = await showMissing({ DB: full }, inter('u1','Ben'), RECORD);
  ok('a finished set is celebrated, not listed', /every card in the set/.test(done.description),
     done.description);
  ok('and has no gap fields', !(done.fields || []).length);

  // Looking at someone else reads in the third person.
  const theirs = await showMissing(env, inter('u1','Ben'), RECORD, 'u9');
  ok('someone else is "they"', /They are/.test(theirs.description), theirs.description);
  const mineText = await showMissing(env, inter('u1','Ben'), RECORD);
  ok('and you are "you"', /You are/.test(mineText.description), mineText.description);

  // The spare lookup is a bonus; losing it must not lose the command.
  const broken = fakeDB();
  const realAll = broken.prepare;
  broken.prepare = sql => (/SELECT DISTINCT driver_id/.test(sql)
    ? { bind: () => ({ all: async () => { throw new Error('no such table'); } }) }
    : realAll.call(broken, sql));
  const survived = await showMissing({ DB: broken }, inter('u1','Ben'), RECORD);
  ok('a failed spare lookup still lists the gaps',
     (survived.fields || []).length > 0, JSON.stringify(survived));
}

function RARITY_ORDER(fields){
  const order=['Legendary','Epic','Rare','Uncommon','Common'];
  const seen=(fields||[]).map(f=>order.findIndex(o=>f.name.includes(o)));
  return seen.every((v,i)=>i===0||v>=seen[i-1]);
}

console.log('\nONE CARD');
{
  const db=fakeDB();
  const notOwned=await showCard({DB:db}, inter('u1','Ben'), RECORD, 'Maxi');
  ok('finds the driver', /Maxi/.test(notOwned.title), notOwned.title);
  ok('shows rarity', /Legendary/.test(notOwned.description), notOwned.description);
  ok('says you do not own it', notOwned.fields.some(f=>f.value==='Not yet'));
  ok('uses the photo', notOwned.image && /d1\.png/.test(notOwned.image.url));
  ok('case does not matter', /Maxi/.test((await showCard({DB:db}, inter('u1'), RECORD,'maxi')).title));
  ok('partial name works', /Morrison/.test((await showCard({DB:db}, inter('u1'), RECORD,'morr')).title));
  const miss=await showCard({DB:db}, inter('u1'), RECORD,'Nobody At All');
  ok('unknown name says so', /No such card/.test(miss.title), miss.title);
  const none=await showCard({DB:db}, inter('u1'), RECORD,'');
  ok('empty query asks for a name', /Which driver/.test(none.title));
}

console.log('\nCOLLECTORS');
{
  const db=fakeDB();
  await openPack({DB:db}, inter('u1','Ben'), RECORD);
  await openPack({DB:db}, inter('u2','Sam'), RECORD);
  const l=await showCollectors({DB:db}, RECORD);
  ok('lists collectors', /<@u1>|<@u2>/.test(l.description), l.description);
  ok('shows completion', /\d+%/.test(l.description));
  const empty=await showCollectors({DB:fakeDB()}, RECORD);
  ok('empty leaderboard invites a first pack', /Be first/.test(empty.description));
}

console.log('\nAN EMPTY LEAGUE');
{
  // There is one set now, so "no cards" means no drivers anywhere rather
  // than an empty class sitting next to a full one.
  const db=fakeDB();
  const EMPTY={gt3:{drivers:[],teams:[],races:[]},gt4:{drivers:[],teams:[],races:[]}};
  const e=head(await openPack({DB:db}, inter('u1','Ben'), EMPTY));
  ok('no drivers anywhere means no pack', /No cards yet/.test(e.title), e.title);
  ok('nothing written', db._coll.size===0);
}

console.log('\nGRANTED PACKS');
{
  const db=fakeDB();
  await openPack({DB:db}, inter('u1','Ben'), RECORD);   // uses the free one
  const blocked=head(await openPack({DB:db}, inter('u1','Ben'), RECORD));
  ok('cooldown blocks a second pack', /Not yet/.test(blocked.title));

  const g=await grantPacks({DB:db}, 'u1', 3);
  ok('grant recorded', g.granted===3 && g.waiting===3, JSON.stringify(g));

  const bonus=head(await openPack({DB:db}, inter('u1','Ben'), RECORD));
  ok('a granted pack beats the cooldown', !/Not yet/.test(bonus.title||''), bonus.title);
  ok('says how many are left', /2 bonus packs left/.test(bonus.footer.text), bonus.footer.text);
  ok('one grant was spent', db._grants.get('u1').packs===2, String(db._grants.get('u1').packs));

  await openPack({DB:db}, inter('u1','Ben'), RECORD);
  await openPack({DB:db}, inter('u1','Ben'), RECORD);
  ok('all three grants spendable', db._grants.get('u1').packs===0,
     String(db._grants.get('u1').packs));
  const after=head(await openPack({DB:db}, inter('u1','Ben'), RECORD));
  ok('back to the cooldown once they run out', /Not yet/.test(after.title), after.title);

  ok('a bonus pack did not eat the free one',
     /ready in/.test(after.description), after.description);
}

console.log('\nGRANT LIMITS');
{
  const db=fakeDB();
  const a=await grantPacks({DB:db}, 'u9', 0);
  ok('zero becomes one', a.granted===1, String(a.granted));
  const b=await grantPacks({DB:db}, 'u8', 9999);
  ok('capped at 50', b.granted===50, String(b.granted));
  const c=await grantPacks({DB:db}, 'u7', 'nonsense');
  ok('junk becomes one', c.granted===1, String(c.granted));
  const d2=await grantPacks({DB:db}, 'u9', 2);
  ok('grants stack', d2.waiting===3, JSON.stringify(d2));
}

console.log('\nCARD ART');
{
  const rec=JSON.parse(JSON.stringify(RECORD));
  rec.gt3.drivers[0].cardImage='https://x/art1.png';
  const set=cardSet(rec.gt3);
  ok('card art carried on the set', set.find(c=>c.name==='Maxi').cardImage==='https://x/art1.png');
  const db=fakeDB();
  const card=await showCard({DB:db}, inter('u1'), rec, 'Maxi');
  ok('card art wins over the photo', /art1\.png/.test(card.image.url), card.image.url);
  const plain=await showCard({DB:db}, inter('u1'), rec, 'Morrison');
  ok('falls back to the photo', /d2\.png/.test(plain.image.url), plain.image.url);
}

console.log('\nODDS ON A REAL-SIZED SET');
{
  // 30 drivers shaped like the actual league: one leader, a couple on the
  // championship podium, a few race-podium finishers, a midfield on points
  // and a tail who have not scored. The 8-driver set above is too small to
  // say anything about odds - there, tier sizes dominate the weights.
  const big = [];
  for (let i = 1; i <= 30; i++) big.push(mk('b'+i, 'Driver'+i, 'T'+(i%8)));
  const bres = (...k) => k.map((x,i)=>({driver:'Driver'+x.slice(1), driverId:x, pos:i+1}));
  const BIG = { drivers: big, teams: [],
    points:{table:[20,15,12,10,8,6,4,3,2,1],fastestLap:1,dotd:0},
    races: [
      // b1 wins the lot, b2 and b3 hold the championship podium all season.
      { round:1, results: bres('b1','b2','b3','b8','b9','b10','b11','b12','b13','b14') },
      { round:2, results: bres('b1','b2','b3','b9','b10','b11','b12','b13','b14','b15') },
      { round:3, results: bres('b1','b2','b3','b10','b11','b12','b13','b14','b15','b16') },
      // One wet race: b4 and b5 grab a podium without winning and without
      // ever threatening the title. That is exactly what Rare means.
      { round:4, results: bres('b1','b4','b5','b6','b7','b2','b3','b17','b8','b9') },
    ]};
  const BIGREC = { gt3: BIG, gt4: { drivers: [], teams: [], races: [] } };

  const tiers = {};
  cardSet(BIG).forEach(c => { tiers[c.rarity] = (tiers[c.rarity]||0)+1; });
  ok('set has a sensible shape',
     tiers.common >= 10 && tiers.legendary === 1 && tiers.rare >= 1 && tiers.epic >= 2,
     JSON.stringify(tiers));

  const db = fakeDB(); const now = Date.now();
  const counts = {};
  await openPack({DB:db}, inter('u1','Ben'), BIGREC);
  for (let i=0;i<500;i++) {
    db._packs.get('u1').last_opened = now - 9*60*60*1000;
    const e=head(await openPack({DB:db}, inter('u1','Ben'), BIGREC));
    for (const line of e.description.split('\n')) {
      const m = /— (\w+)/.exec(line); if (m) counts[m[1]] = (counts[m[1]]||0)+1;
    }
  }
  const tot = Object.values(counts).reduce((a,b)=>a+b,0);
  const pct = k => 100*(counts[k]||0)/tot;
  const seen = JSON.stringify(Object.fromEntries(
    ['Common','Uncommon','Rare','Epic','Legendary'].map(k=>[k,+pct(k).toFixed(1)])));

  ok('commons are the bulk', pct('Common') > 35, seen);
  ok('legendaries stay scarce', pct('Legendary') < 5, seen);
  ok('every tier can still appear',
     ['Common','Uncommon','Rare','Epic','Legendary'].every(k=>counts[k] > 0), seen);
  ok('each tier is rarer than the one below it',
     pct('Common') > pct('Uncommon') && pct('Uncommon') > pct('Rare') &&
     pct('Rare') > pct('Epic') && pct('Epic') > pct('Legendary'), seen);
  ok('a legendary is a treat, not a routine', pct('Legendary') < 3, seen);
}


/* ── Giving a specific thing ───────────────────────────── */
console.log('\nAn admin giving something specific');
{
  const db = fakeDB();
  const env = { DB: db };
  // A pack that can only ever produce legendaries, so what it drew is
  // obvious from the cards that came out.
  db._packTypes.set('podium', { id:'podium', name:'Podium Pack', emoji:'🏆', size:3,
    odds: '{"common":0,"uncommon":0,"rare":0,"epic":0,"legendary":10}',
    pool: null, guarantee: 'legendary' });
  db._packTypes.set('plain', { id:'plain', name:'Standard Pack', emoji:'🃏', size:5,
    odds: null, pool: null, guarantee: null });

  const out = await grantPackType(env, 'u1', 'podium', 2);
  ok('a typed pack can be given', out.granted === 2 && out.pack.name === 'Podium Pack');
  ok('and queues against that pack', db._typed.get('u1|podium').packs === 2);

  let threw = false;
  try { await grantPackType(env, 'u1', 'nope', 1); } catch { threw = true; }
  ok('an unknown pack is refused', threw);

  // Opening spends the typed grant and draws on ITS odds.
  const r1 = await openPack(env, inter('u1','Ben'), RECORD);
  ok('opening spends a typed grant', db._typed.get('u1|podium').packs === 1,
     String(db._typed.get('u1|podium').packs));
  const held = [...db._coll.entries()].filter(([k]) => k.startsWith('u1|'));
  ok('it drew that pack\u2019s size, not the default',
     held.reduce((a,[,v]) => a + v.copies, 0) === 3,
     String(held.reduce((a,[,v]) => a + v.copies, 0)));
  ok('and honoured its guarantee', held.some(([,v]) => v.rarity === 'legendary'),
     held.map(([,v]) => v.rarity).join());
  ok('a given pack does not burn the free one', db._packs.get('u1').last_opened === 0,
     String(db._packs.get('u1').last_opened));

  // Typed grants are spent before generic ones.
  await grantPacks(env, 'u1', 1);
  await openPack(env, inter('u1','Ben'), RECORD);
  ok('the typed one goes first', db._typed.get('u1|podium').packs === 0 &&
     db._grants.get('u1').packs === 1,
     `${db._typed.get('u1|podium').packs} typed, ${db._grants.get('u1').packs} generic`);

  // And once typed ones run out, the generic one is used.
  await openPack(env, inter('u1','Ben'), RECORD);
  ok('then the generic one', db._grants.get('u1').packs === 0,
     String(db._grants.get('u1').packs));
}

console.log('\nGiving a card outright');
{
  const db = fakeDB();
  const env = { DB: db };
  const given = await giveCard(env, 'u2', 'd1', 1, RECORD);
  ok('a card can be handed over', given.given === 1 && given.card.id === 'd1');
  ok('and lands in the collection', db._coll.get('u2|all|d1').copies === 1,
     JSON.stringify(db._coll.get('u2|all|d1')));
  ok('at the rarity the card actually is',
     db._coll.get('u2|all|d1').rarity === given.card.rarity, given.card.rarity);

  const more = await giveCard(env, 'u2', 'd1', 3, RECORD);
  ok('giving again adds copies', db._coll.get('u2|all|d1').copies === 4,
     String(db._coll.get('u2|all|d1').copies));
  ok('and reports the new total', more.nowHolds === 4, String(more.nowHolds));

  const byName = await giveCard(env, 'u2', 'Morrison', 1, RECORD);
  ok('a card can be named instead of its id', byName.card.id === 'd2', byName.card.id);

  let threw = false;
  try { await giveCard(env, 'u2', 'nobody-at-all', 1, RECORD); } catch { threw = true; }
  ok('an unknown card is refused', threw);
  ok('and nothing was written for it', !db._coll.has('u2|all|nobody-at-all'));

  // The count is bounded so a slipped keypress cannot mint a thousand.
  const lots = await giveCard(env, 'u3', 'd1', 5000, RECORD);
  ok('the number of copies is capped', lots.given === 99, String(lots.given));
  const none = await giveCard(env, 'u4', 'd1', 0, RECORD);
  ok('and never below one', none.given === 1, String(none.given));
}

console.log(`\n${pass}/${pass+fail} passed`);
process.exit(fail?1:0);
