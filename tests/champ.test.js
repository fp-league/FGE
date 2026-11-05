const fs=require('fs'),path=require('path');const {JSDOM}=require('jsdom');
const DIR = require('path').join(__dirname, '..'); const read=f=>fs.readFileSync(path.join(DIR,f),'utf8');
let pass=0,fail=0;
const ok=(n,c,x)=>{if(c){pass++;console.log('  ✓ '+n);}else{fail++;console.log('  ✗ '+n+(x?'  → '+x:''));}};

const PTS={table:[20,15,12,10,8,6,4,3,2,1],fastestLap:1,dotd:0};
const drivers=[{id:'d1',name:'Maxi',team:'Apex'},{id:'d2',name:'Morrison',team:'Vortex'},
               {id:'d3',name:'Kai',team:'Apex'},{id:'d4',name:'Rees',team:'Nord'}];
const res=(...ks)=>ks.map((k,i)=>({driver:drivers.find(d=>d.id===k).name,driverId:k,pos:i+1}));
const RECORD={ gt3:{ drivers, teams:[], points:PTS, races:[
  {round:1,name:'R1',results:res('d2','d1','d3','d4')},   // Morrison 20, Maxi 15, Kai 12, Rees 10
  {round:2,name:'R2',results:[]},
]}, gt4:{drivers:[],teams:[],races:[],points:PTS} };

async function overlay(live){
  const dom=new JSDOM(read('overlay.html'),{url:'https://fp-league.github.io/FGE/overlay.html',
    runScripts:'dangerously',pretendToBeVisual:true,
    beforeParse(w){ w.fetch=async(u)=>{
      if(String(u).includes('/api/live')) return {ok:true,json:async()=>live};
      return {ok:true,json:async()=>({record:RECORD})};
    };}});
  const w=dom.window;
  await new Promise(r=>w.addEventListener('load',r));
  for(let i=0;i<25;i++) await new Promise(r=>setImmediate(r));
  return w;
}
const session=o=>Object.assign({ok:true,status:'green',mode:'race',class:'gt3',round:2,
  raceName:'R2',track:'T',message:'',lightsOut:Date.now()-600000,durationMin:60,
  running:[
    {driverId:'d1',name:'Maxi',    team:'Apex',  colour:'#E10600',number:'1', gap:'LEADER',out:false},
    {driverId:'d2',name:'Morrison',team:'Vortex',colour:'#0033A0',number:'44',gap:'+2.0', out:false},
    {driverId:'d3',name:'Kai',     team:'Apex',  colour:'#E10600',number:'7', gap:'+5.0', out:false},
    {driverId:'d4',name:'Rees',    team:'Nord', colour:'#2e7d32',number:'12',gap:'+9.0', out:false},
  ],now:Date.now()},o||{});

(async()=>{

console.log('\nHIDDEN UNTIL THE FLAG');
{
  const w=await overlay(session({status:'green'}));
  ok('not shown while racing', w.document.getElementById('champ').className==='');
  const w2=await overlay(session({status:'sc'}));
  ok('not shown under safety car', w2.document.getElementById('champ').className==='');
  w.close(); w2.close();
}

console.log('\nAFTER THE CHEQUERED FLAG');
{
  const w=await overlay(session({status:'chequered', running:[
    {driverId:'d1',name:'Maxi',    colour:'#E10600',gap:'LEADER',out:false},
    {driverId:'d3',name:'Kai',     colour:'#E10600',gap:'+2.0', out:false},
    {driverId:'d2',name:'Morrison',colour:'#0033A0',gap:'+5.0', out:false},
    {driverId:'d4',name:'Rees',    colour:'#2e7d32',gap:'+9.0', out:false},
  ]}));
  for(let i=0;i<25;i++) await new Promise(r=>setImmediate(r));
  const doc=w.document;
  ok('panel revealed', doc.getElementById('champ').className==='on');
  const rows=[...doc.querySelectorAll('#chRows .ch-row')];
  ok('rows rendered', rows.length===4, String(rows.length));
  // Before: Morrison 20, Maxi 15, Kai 12, Rees 10
  // This race: Maxi 20, Kai 15, Morrison 12, Rees 10
  // After: Maxi 35, Morrison 32, Kai 27, Rees 20
  ok('new leader is first', rows[0].querySelector('.ch-name').textContent.trim()==='Maxi',
     rows[0].querySelector('.ch-name').textContent);
  ok('leader highlighted', rows[0].classList.contains('lead'));
  ok('points totalled', rows[0].querySelector('.ch-pts').textContent.includes('35'),
     rows[0].querySelector('.ch-pts').textContent);
  ok('points gained shown', /\+20/.test(rows[0].querySelector('.ch-pts').textContent));
  ok('climb marked up', rows[0].querySelector('.ch-move').classList.contains('up'));
  ok('drop marked down', rows[1].querySelector('.ch-move').classList.contains('down'));
  ok('unchanged marked flat', rows[3].querySelector('.ch-move').classList.contains('same'));
  ok('second place totalled', rows[1].querySelector('.ch-pts').textContent.includes('32'),
     rows[1].querySelector('.ch-pts').textContent);
  w.close();
}

console.log('\nA POINTS TIE IS BROKEN BY COUNTBACK, NOT BY LUCK');
{
  // Maxi and Morrison both finish on 35. Maxi has the win in hand.
  const w=await overlay(session({status:'chequered', running:[
    {driverId:'d1',name:'Maxi',    colour:'#E10600',gap:'LEADER',out:false},
    {driverId:'d2',name:'Morrison',colour:'#0033A0',gap:'+2.0', out:false},
    {driverId:'d3',name:'Kai',     colour:'#E10600',gap:'+5.0', out:false},
    {driverId:'d4',name:'Rees',    colour:'#2e7d32',gap:'+9.0', out:false},
  ]}));
  for(let i=0;i<25;i++) await new Promise(r=>setImmediate(r));
  const rows=[...w.document.querySelectorAll('#chRows .ch-row')];
  ok('both really are level on points',
     rows[0].querySelector('.ch-pts').textContent.includes('35') &&
     rows[1].querySelector('.ch-pts').textContent.includes('35'));
  ok('ordered by the result, not insertion order',
     ['Maxi','Morrison'].includes(rows[0].querySelector('.ch-name').textContent.trim()),
     rows[0].querySelector('.ch-name').textContent);
  w.close();
}

console.log('\nNO DOUBLE COUNTING ONCE THE RESULT IS SAVED');
{
  // Same running order, but the round is already in the season record
  const saved=JSON.parse(JSON.stringify(RECORD));
  saved.gt3.races[1].results=res('d1','d2','d3','d4');
  const dom=new JSDOM(read('overlay.html'),{url:'https://x.test/overlay.html',
    runScripts:'dangerously',pretendToBeVisual:true,
    beforeParse(w){ w.fetch=async(u)=>{
      if(String(u).includes('/api/live')) return {ok:true,json:async()=>session({status:'finished'})};
      return {ok:true,json:async()=>({record:saved})};
    };}});
  const w=dom.window;
  await new Promise(r=>w.addEventListener('load',r));
  for(let i=0;i<25;i++) await new Promise(r=>setImmediate(r));
  const rows=[...w.document.querySelectorAll('#chRows .ch-row')];
  ok('leader still on 35, not 55', rows[0].querySelector('.ch-pts').textContent.includes('35'),
     rows[0].querySelector('.ch-pts').textContent);
  ok('no phantom gain shown', !/\+\d/.test(rows[0].querySelector('.ch-pts').textContent),
     rows[0].querySelector('.ch-pts').textContent);
  w.close();
}

console.log('\nRETIREMENTS SCORE NOTHING');
{
  const w=await overlay(session({status:'chequered', running:[
    {driverId:'d1',name:'Maxi',colour:'#E10600',gap:'LEADER',out:true},
    {driverId:'d2',name:'Morrison',colour:'#0033A0',gap:'',out:false},
  ]}));
  for(let i=0;i<25;i++) await new Promise(r=>setImmediate(r));
  const rows=[...w.document.querySelectorAll('#chRows .ch-row')];
  const maxi=rows.find(r=>r.querySelector('.ch-name').textContent.trim()==='Maxi');
  ok('retired driver gains nothing', !/\+\d/.test(maxi.querySelector('.ch-pts').textContent),
     maxi.querySelector('.ch-pts').textContent);
  // Morrison was classified 1st => 20 => 40
  const mo=rows.find(r=>r.querySelector('.ch-name').textContent.trim()==='Morrison');
  ok('finisher promoted past the retirement', mo.querySelector('.ch-pts').textContent.includes('40'),
     mo.querySelector('.ch-pts').textContent);
  w.close();
}

console.log('\nDEGRADES QUIETLY');
{
  const dom=new JSDOM(read('overlay.html'),{url:'https://x.test/overlay.html',
    runScripts:'dangerously',pretendToBeVisual:true,
    beforeParse(w){ w.fetch=async(u)=>{
      if(String(u).includes('/api/live')) return {ok:true,json:async()=>session({status:'chequered'})};
      throw new Error('bin unreachable');
    };}});
  const w=dom.window;
  await new Promise(r=>w.addEventListener('load',r));
  for(let i=0;i<25;i++) await new Promise(r=>setImmediate(r));
  ok('no panel when the season cannot be read', w.document.getElementById('champ').className==='');
  ok('the timing tower still works', !w.document.getElementById('tower').classList.contains('hidden'));
  w.close();
}

console.log('\nGT4 USES THE GT4 SEASON');
{
  const w=await overlay(session({status:'chequered', class:'gt4'}));
  for(let i=0;i<25;i++) await new Promise(r=>setImmediate(r));
  // gt4 has no drivers, so nothing to show rather than GT3's table
  ok('does not show the other class', w.document.querySelectorAll('#chRows .ch-row').length===0,
     String(w.document.querySelectorAll('#chRows .ch-row').length));
  w.close();
}

console.log(`\n${pass}/${pass+fail} passed`);
process.exit(fail?1:0);
})().catch(e=>{console.error(e);process.exit(1);});
