import { seasonSummary, seasonFinale, careerTotals, records } from '../lib/season.js';
let pass=0, fail=0;
const ok=(n,c,x)=>{ if(c) pass++; else { fail++; console.log('  FAIL '+n+(x?' → '+x:'')); } };

const D = [{id:'a',name:'Alpha',team:'Red'},{id:'b',name:'Bravo',team:'Red'},
           {id:'c',name:'Charlie',team:'Blue'}];
const PTS = { table:[20,15,12,10,8,6,4,3,2,1], fastestLap:1, dotd:2 };

console.log('\nOne season');
{
  const cd = { drivers:D, points:PTS, races:[
    { round:1, results:[{driverId:'a',pos:1},{driverId:'b',pos:2},{driverId:'c',pos:3}],
      fastestLap:{driverId:'b'}, dotdWinner:{driverId:'c'} },
    { round:2, results:[{driverId:'b',pos:1},{driverId:'a',pos:'DNF'},{driverId:'c',pos:2}] },
    { round:3, results:[] },     // on the calendar, not yet run
  ]};
  const s = seasonSummary(cd, 'Season 1');
  ok('only scored rounds count', s.rounds === 2, String(s.rounds));
  const by = Object.fromEntries(s.drivers.map(d=>[d.name,d]));
  ok('Alpha: 20 points from one win', by.Alpha.points === 20, String(by.Alpha.points));
  ok('and a DNF logged', by.Alpha.dnfs === 1);
  ok('a DNF still counts as a start', by.Alpha.races === 2, String(by.Alpha.races));
  ok('Bravo gets the fastest lap point', by.Bravo.points === 15+1+20, String(by.Bravo.points));
  ok('Charlie gets the DOTD points', by.Charlie.points === 12+2+15, String(by.Charlie.points));
  ok('wins counted', by.Bravo.wins === 1 && by.Alpha.wins === 1);
  ok('podiums counted', by.Charlie.podiums === 2, String(by.Charlie.podiums));
  ok('best finish tracked', by.Charlie.best === 2, String(by.Charlie.best));
  ok('the champion is the points leader', s.champion.name === 'Bravo', s.champion.name);
  ok('and the team title follows the points', s.teamChampion.team === 'Red', s.teamChampion.team);
}

console.log('\nSeasons that should have no champion');
{
  ok('a season with no races has none',
     seasonSummary({drivers:D, points:PTS, races:[]}, 'x').champion === null);
  ok('and one where nobody scored has none',
     seasonSummary({drivers:D, points:{table:[0,0,0]},
       races:[{results:[{driverId:'a',pos:1}]}]}, 'x').champion === null);
  ok('an empty class does not throw', seasonSummary({}, 'x').drivers.length === 0);
  ok('and neither does nothing at all', seasonSummary(null, 'x').rounds === 0);
}

console.log('\nAcross seasons');
{
  const mk = (name, order) => seasonSummary({ drivers:D, points:PTS,
    races:[{ results: order.map((id,i)=>({driverId:id,pos:i+1})) }] }, name);
  const all = [mk('S1',['a','b','c']), mk('S2',['a','c','b']), mk('S3',['b','a','c'])];

  const career = careerTotals(all);
  const by = Object.fromEntries(career.map(c=>[c.name,c]));
  ok('starts add up', by.Alpha.races === 3, String(by.Alpha.races));
  ok('wins add up', by.Alpha.wins === 2, String(by.Alpha.wins));
  ok('titles counted from the champion of each season', by.Alpha.titles === 2, String(by.Alpha.titles));
  ok('seasons counted', by.Charlie.seasons === 3, String(by.Charlie.seasons));
  ok('best finish is the best across all of them', by.Charlie.best === 2, String(by.Charlie.best));

  const r = records(all);
  ok('the wins board is led by the most wins', r.wins[0].name === 'Alpha', r.wins[0].name);
  ok('the titles board agrees', r.titles[0].name === 'Alpha' && r.titles[0].value === 2);
  ok('every season appears in the champions list', r.champions.length === 3);
  ok('with its name', r.champions[0].season === 'S1', r.champions[0].season);
  ok('nobody with zero of something is listed for it',
     r.titles.every(t => t.value > 0));

  // A driver who never raced must not appear anywhere.
  const ghost = careerTotals([seasonSummary({drivers:[...D,{id:'z',name:'Ghost'}],
    points:PTS, races:[{results:[{driverId:'a',pos:1}]}]}, 'S')]);
  ok('a driver who never started is left out', !ghost.some(c=>c.name==='Ghost'));
}

console.log('\nIdentity');
{
  // Renaming keeps the id, so history follows the person.
  const s1 = seasonSummary({drivers:[{id:'a',name:'Old Name',team:'Red'}], points:PTS,
    races:[{results:[{driverId:'a',pos:1}]}]}, 'S1');
  const s2 = seasonSummary({drivers:[{id:'a',name:'New Name',team:'Blue'}], points:PTS,
    races:[{results:[{driverId:'a',pos:1}]}]}, 'S2');
  const c = careerTotals([s1, s2]);
  ok('a renamed driver keeps one career', c.length === 1, String(c.length));
  ok('and shows under the name they use now', c[0].name === 'New Name', c[0].name);
  ok('with both wins', c[0].wins === 2, String(c[0].wins));
  ok('and the team they are in now', c[0].team === 'Blue', c[0].team);
}
console.log('\nTHE END-OF-SEASON RECAP');
{
  const D = [{ id:'a', name:'Ana', team:'Red' }, { id:'b', name:'Bo', team:'Blue' },
             { id:'c', name:'Cy', team:'Red' }];
  const PTS = { table: [25, 18, 15], fastestLap: 1, dotd: 1 };
  const cd = { drivers: D, points: PTS, races: [
    { round:1, name:'Opener', track:'Salty', results:[
      {driverId:'c',pos:1},{driverId:'b',pos:2},{driverId:'a',pos:3}] },
    { round:2, name:'Round Two', track:'Tilted', results:[
      {driverId:'a',pos:1},{driverId:'b',pos:2},{driverId:'c',pos:3}] },
    { round:3, name:'Finale', track:'Pleasant', results:[
      {driverId:'a',pos:1},{driverId:'c',pos:2},{driverId:'b',pos:3}] },
    { round:4, name:'Not run', results:[] },
  ]};
  const f = seasonFinale(cd, 'Season 1');

  ok('there is a finale', !!f);
  ok('it names the season', f.season === 'Season 1', f.season);
  ok('it counts only rounds that ran', f.rounds === 3, String(f.rounds));
  ok('the champion is the points leader', f.champion.name === 'Ana', f.champion && f.champion.name);
  ok('and agrees with the archive',
     f.champion.name === seasonSummary(cd, 'Season 1').champion.name);
  ok('the runner-up is second', f.runnerUp.name === 'Cy', f.runnerUp && f.runnerUp.name);
  ok('with the gap worked out',
     f.gap === f.champion.points - f.runnerUp.points, String(f.gap));
  ok('the team title is there', f.teamChampion.team === 'Red', JSON.stringify(f.teamChampion));

  ok('every round that ran has a winner', f.winners.length === 3, String(f.winners.length));
  ok('and the one that did not is left out', !f.winners.some(w => w.name === 'Not run'));
  ok('the opener went to Cy', f.winners[0].winner === 'Cy', JSON.stringify(f.winners[0]));
  ok('the finale went to Ana', f.winners[2].winner === 'Ana');
  ok('round names carry through', f.winners[1].name === 'Round Two');
  ok('so do tracks', f.winners[0].track === 'Salty');

  ok('most wins is counted', f.mostWins.name === 'Ana' && f.mostWins.wins === 2,
     JSON.stringify(f.mostWins));
  ok('the climber came from behind', f.climber && f.climber.name === 'Ana',
     JSON.stringify(f.climber));
  ok('from third to first', f.climber.from === 3 && f.climber.to === 1,
     JSON.stringify(f.climber));

  // The winner is whoever finished first, not whoever is listed first.
  const outOfOrder = seasonFinale({ drivers: D, points: PTS, races: [
    { round:1, name:'R', results:[{driverId:'b',pos:2},{driverId:'a',pos:1}] }] }, 'S');
  ok('an out-of-order grid still finds P1',
     outOfOrder.winners[0].winner === 'Ana', JSON.stringify(outOfOrder.winners));

  // Legacy races store a bare name with no pos at all.
  const legacy = seasonFinale({ drivers: D, points: PTS,
    races: [{ round:1, name:'R', results:['Ana','Bo'] }] }, 'S');
  ok('a legacy result still names a winner',
     legacy && legacy.winners[0].winner === 'Ana', JSON.stringify(legacy && legacy.winners));

  // Nothing to celebrate must produce nothing, not an empty podium.
  ok('a season with no rounds has no finale',
     seasonFinale({ drivers: D, points: PTS, races: [] }, 'S') === null);
  ok('nor one where nobody scored',
     seasonFinale({ drivers: D, points: { table:[0,0,0] },
       races:[{ results:[{driverId:'a',pos:1}] }] }, 'S') === null);
  ok('an empty class does not throw', seasonFinale({}, 'S') === null);
  ok('and neither does nothing at all', seasonFinale(null, 'S') === null);

  // One round: a climber needs somewhere to have climbed from.
  const single = seasonFinale({ drivers: D, points: PTS,
    races: [{ round:1, name:'R', results:[{driverId:'a',pos:1},{driverId:'b',pos:2}] }] }, 'S');
  ok('one round gives no climber', single.climber === null, JSON.stringify(single.climber));
  ok('but still gives a champion', single.champion.name === 'Ana');
  ok('and a runner-up', single.runnerUp.name === 'Bo');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);