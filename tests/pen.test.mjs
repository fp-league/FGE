import { gapSeconds, applyPenalties, penLabel } from '../lib/penalties.js';
let pass=0, fail=0;
const ok=(n,c,x)=>{ if(c) pass++; else { fail++; console.log('  FAIL '+n+(x?' → '+x:'')); } };

console.log('\nReading a gap');
{
  const cases = [['',0],['LEADER',0],['-',0],['+1.234',1.234],['1.234',1.234],
    ['+0.5',0.5],['12.0',12],['+5s',5],['1:02.5',62.5],['30:24.267',1824.267],
    ['1:00:00',3600],['+1 LAP',1e6],['+2 LAPS',2e6],['+3laps',3e6]];
  cases.forEach(([inp,want]) => ok(`"${inp}" reads as ${want}`,
    Math.abs(gapSeconds(inp)-want) < 1e-6, String(gapSeconds(inp))));
  ok('nonsense reads as unknown, not zero', gapSeconds('spun off') === null);
  ok('and so does a stray word', gapSeconds('PIT') === null);
}

console.log('\nApplying them');
{
  const grid = () => ([
    {name:'A', gap:''},        {name:'B', gap:'+1.2'},
    {name:'C', gap:'+3.9'},    {name:'D', gap:'+4.4'},
    {name:'E', gap:'+9.0'},
  ]);

  const none = applyPenalties(grid());
  ok('with no penalties nothing moves', none.moved.length === 0);
  ok('and the order is unchanged', none.running.map(r=>r.name).join('') === 'ABCDE');

  // B takes five seconds: 1.2 + 5 = 6.2, which is behind C and D but ahead of E.
  const g = grid(); g[1].pen = 5;
  const out = applyPenalties(g);
  ok('a five second penalty drops them past two cars',
     out.running.map(r=>r.name).join('') === 'ACDBE', out.running.map(r=>r.name).join(''));
  ok('and it says who moved', out.moved.some(m=>m.name==='B' && m.from===2 && m.to===4),
     JSON.stringify(out.moved));

  // Not enough to lose a place.
  const g2 = grid(); g2[1].pen = 2;       // 1.2 + 2 = 3.2, still ahead of C at 3.9
  ok('a penalty too small to matter changes nothing',
     applyPenalties(g2).running.map(r=>r.name).join('') === 'ABCDE');

  // The leader can be penalised too.
  const g3 = grid(); g3[0].pen = 5;       // 0 + 5 = 5, behind D at 4.4
  ok('the leader can lose the win',
     applyPenalties(g3).running.map(r=>r.name).join('') === 'BCDAE',
     applyPenalties(g3).running.map(r=>r.name).join(''));
}

console.log('\nRetirements and disqualifications');
{
  const g = [{name:'A',gap:''},{name:'B',gap:'+1',dsq:true},
             {name:'C',gap:'+2'},{name:'D',gap:'',out:true},{name:'E',gap:'+3'}];
  const out = applyPenalties(g);
  ok('finishers first, then retirements, then DSQ',
     out.running.map(r=>r.name).join('') === 'ACEDB', out.running.map(r=>r.name).join(''));
  ok('a DSQ goes last however good their time was', out.running[4].name === 'B');
}

console.log('\nWhen the gaps cannot be read');
{
  const g = [{name:'A',gap:''},{name:'B',gap:'spun'},{name:'C',gap:'+2'}];
  const out = applyPenalties(g);
  ok('an unreadable gap keeps its place',
     out.running.map(r=>r.name).join('') === 'ABC', out.running.map(r=>r.name).join(''));

  const blind = applyPenalties([{name:'A',gap:'?'},{name:'B',gap:'??'}]);
  ok('no readable gaps at all means the order is left alone', blind.usable === false);
  ok('and it is handed back untouched', blind.running.map(r=>r.name).join('') === 'AB');

  ok('an empty order does not throw', applyPenalties([]).running.length === 0);
  ok('and neither does nothing at all', applyPenalties(null).running.length === 0);
}

console.log('\nTies and stability');
{
  const g = [{name:'A',gap:'+1'},{name:'B',gap:'+1'},{name:'C',gap:'+1'}];
  ok('equal gaps keep the operator order',
     applyPenalties(g).running.map(r=>r.name).join('') === 'ABC');
  const g2 = [{name:'A',gap:'+1',pen:1},{name:'B',gap:'+2'}];
  ok('a penalty landing exactly level does not leapfrog',
     applyPenalties(g2).running.map(r=>r.name).join('') === 'AB');
}

console.log('\nBadges');
{
  ok('no penalty shows nothing', penLabel({}) === '');
  ok('whole seconds have no decimal', penLabel({pen:5}) === '+5s');
  ok('part seconds get one', penLabel({pen:2.5}) === '+2.5s');
  ok('a DSQ says DSQ', penLabel({dsq:true, pen:5}) === 'DSQ');
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
