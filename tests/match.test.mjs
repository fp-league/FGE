import { matchAll, score, norm } from '../ocr/match.js';
let pass=0, fail=0;
const ok=(n,c,x)=>{ if(c) pass++; else { fail++; console.log('  FAIL '+n+(x?' → '+x:'')); } };

const GT3 = ["Cainep","Free_Kies","Gross","Rivers","Dice","Henry","Xristos","Peacock","Chongas",
  "DGK","TMK","George","Chobbane","BillyBoy","Maxi","Benny","JustRed","Eclos","Elmoohh","Fronda",
  "Kepa","Malz","Bloom","Zecko","Diogo","Tiny","Nouga","King","Souffa","Boki"].map(name=>({name}));

// Exactly what the OCR produced from the real screenshot.
const READ = ['Caineps','JustRebelti','riverschyu','BillyAmbrosi1','christosV12',
              'DGK Survival','LAMPRAKAKIS','Notfronda'];

console.log('\nWith no Fortnite names saved yet');
{
  const m = matchAll(READ, GT3);
  m.forEach(r => console.log(`  ${r.read.padEnd(15)} → ${(r.driver?.name||'—').padEnd(12)} ` +
    `${r.confidence}${r.certain?'  ok':'  needs a look'}`));
  const got = n => m.find(r => r.read === n)?.driver?.name;
  ok('Caineps finds Cainep', got('Caineps')==='Cainep', got('Caineps'));
  ok('riverschyu finds Rivers', got('riverschyu')==='Rivers', got('riverschyu'));
  ok('DGK Survival finds DGK', got('DGK Survival')==='DGK', got('DGK Survival'));
  ok('Notfronda finds Fronda', got('Notfronda')==='Fronda', got('Notfronda'));
  ok('BillyAmbrosi1 finds BillyBoy', got('BillyAmbrosi1')==='BillyBoy', got('BillyAmbrosi1'));
  // The number matched cold matters less than this: anything it calls
  // certain must be right. A wrong confident match is worse than a flag,
  // because nobody checks the ones it says it is sure about.
  const TRUTH = { Caineps:'Cainep', riverschyu:'Rivers', 'DGK Survival':'DGK',
                  Notfronda:'Fronda', BillyAmbrosi1:'BillyBoy', christosV12:'Xristos' };
  const wrong = m.filter(r => r.certain && TRUTH[r.read] && r.driver.name !== TRUTH[r.read]);
  ok('nothing it calls certain is wrong', wrong.length === 0,
     wrong.map(r=>`${r.read}→${r.driver.name}`).join(','));
  const certain = m.filter(r=>r.certain).length;
  ok('and it still gets half the grid with no help at all', certain>=4, certain+' of 8');
  ok('LAMPRAKAKIS is flagged rather than guessed',
     !m.find(r=>r.read==='LAMPRAKAKIS')?.certain);
}

console.log('\nOnce the Fortnite names are saved');
{
  const saved = GT3.map(d => ({...d}));
  const put=(n,f)=>{ saved.find(d=>d.name===n).fortniteName=f; };
  put('Cainep','Cainep8'); put('Rivers','riverschyu'); put('BillyBoy','BillyAmbros11');
  put('Xristos','christosV12'); put('DGK','DGK Survival'); put('Fronda','NotFrøndra');
  put('Kepa','LAMPRAKAKIS'); put('JustRed','JustRebel11');
  const m = matchAll(READ, saved);
  m.forEach(r => console.log(`  ${r.read.padEnd(15)} → ${(r.driver?.name||'—').padEnd(12)} ` +
    `${r.confidence}${r.certain?'  ok':'  needs a look'}`));
  ok('every row matches', m.every(r=>r.driver), m.filter(r=>!r.driver).map(r=>r.read).join(','));
  ok('and every one is certain', m.every(r=>r.certain),
     m.filter(r=>!r.certain).map(r=>r.read).join(','));
  ok('christosV12 now finds Xristos', m[4].driver.name==='Xristos', m[4].driver.name);
  ok('LAMPRAKAKIS now finds Kepa', m[6].driver.name==='Kepa', m[6].driver.name);
}

console.log('\nThings that must not happen');
{
  const saved = GT3.map(d=>({...d}));
  saved.find(d=>d.name==='Cainep').fortniteName='Cainep8';
  const m = matchAll(['Cainep8','Cainep8'], saved);
  ok('the same driver is never used twice',
     m[0].driver?.name !== m[1].driver?.name || m[1].driver === null,
     `${m[0].driver?.name} / ${m[1].driver?.name}`);

  const none = matchAll(['zzzqqqxyz'], GT3);
  ok('a name like nothing on the grid matches nothing certain', !none[0].certain,
     none[0].driver?.name + ' ' + none[0].confidence);

  ok('an empty read matches nothing', matchAll([''], GT3)[0].driver === null);
  ok('no drivers at all does not throw', matchAll(['x'], []).length === 1);

  // A saved Fortnite name must beat somebody else's FGE name looking similar.
  const trap = [{name:'Rivers'}, {name:'Someone', fortniteName:'riverschyu'}];
  ok('a saved Fortnite name wins over a coincidental FGE match',
     matchAll(['riverschyu'], trap)[0].driver.name === 'Someone');
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
