import { parseClock, buildOrder, shouldPush, cellHash } from '../lib/watch.js';
let pass=0, fail=0;
const ok=(n,c,x)=>{ if(c) pass++; else { fail++; console.log('  FAIL '+n+(x?' → '+x:'')); } };

console.log('\nReading the clock');
{
  ok('mm:ss.mmm', Math.abs(parseClock('30:24.267')-1824.267) < 1e-6);
  ok('h:mm:ss.m', Math.abs(parseClock('1:02:03.4')-3723.4) < 1e-6);
  ok('a bare number', parseClock('42.5') === 42.5);
  ok('nothing is null', parseClock('') === null);
  ok('rubbish is null', parseClock('--:--') === null);
  ok('a partial read is null', parseClock('30:') === null);
}

console.log('\nGaps off the real board');
{
  // Exactly the eight rows from the screenshot.
  const read = [
    { name:'Cainep8',      lap:24, time:'30:24.267' },
    { name:'JustRebel11',  lap:24, time:'30:24.501' },
    { name:'riverschyu',   lap:24, time:'30:29.744' },
    { name:'BillyAmbros11',lap:24, time:'30:30.179' },
    { name:'christosV12',  lap:24, time:'30:32.483' },
    { name:'DGK Survival', lap:24, time:'30:33.051' },
    { name:'LAMPRAKAKIS',  lap:24, time:'30:35.957' },
    { name:'NotFrondra',   lap:23, time:'29:19.200' },
  ];
  const out = buildOrder(read, read.map(()=>({driver:null,certain:false})));
  ok('the leader has no gap', out[0].gap === '', out[0].gap);
  ok('second is +0.234', out[1].gap === '+0.234', out[1].gap);
  ok('third is +5.477', out[2].gap === '+5.477', out[2].gap);
  ok('seventh is +11.690', out[6].gap === '+11.690', out[6].gap);
  ok('a lap down says so, not a huge time', out[7].gap === '+1 LAP', out[7].gap);

  const two = buildOrder([read[0], { name:'x', lap:22, time:'28:00.000' }],
                         [{driver:null},{driver:null}]);
  ok('two laps down is plural', two[1].gap === '+2 LAPS', two[1].gap);

  const blind = buildOrder([read[0], { name:'y', lap:24, time:'--' }],
                           [{driver:null},{driver:null}]);
  ok('an unreadable time gets no gap rather than a wrong one', blind[1].gap === '', blind[1].gap);
  ok('but keeps its position', blind[1].name === 'y');
}

console.log('\nDeciding whether to send');
{
  const row = n => ({ name:n, driver:{ id:n } });
  const a = [row('a'), row('b'), row('c')];
  ok('nothing before means send', shouldPush(null, a, 0));
  ok('an unchanged order soon after does not', shouldPush(a, a.slice(), 1000) === false);
  ok('a swap does', shouldPush(a, [row('b'), row('a'), row('c')], 1000));
  ok('someone joining does', shouldPush(a, [...a, row('d')], 1000));
  ok('someone dropping does', shouldPush(a, a.slice(0,2), 1000));
  ok('and an unchanged order eventually does, so gaps do not go stale',
     shouldPush(a, a.slice(), 20000));
  ok('the stale window is adjustable', shouldPush(a, a.slice(), 6000, 5000));
}

console.log('\nHashing a cell');
{
  // A stand-in 2D context over raw RGBA.
  const mk = (w,h,fill) => {
    const d = new Uint8ClampedArray(w*h*4);
    for (let i=0;i<w*h;i++){ const v=fill(i%w, (i/w)|0); d[i*4]=d[i*4+1]=d[i*4+2]=v; d[i*4+3]=255; }
    return { getImageData: (x,y,gw,gh) => ({ data: d, width:gw, height:gh }) };
  };
  const text  = mk(80,20,(x,y)=> (x>10&&x<40&&y>5&&y<15) ? 240 : 20);
  const same  = mk(80,20,(x,y)=> (x>10&&x<40&&y>5&&y<15) ? 238 : 22);   // compression wobble
  const other = mk(80,20,(x,y)=> (x>40&&x<70&&y>5&&y<15) ? 240 : 20);   // different glyphs

  const h1 = cellHash(text,0,0,80,20);
  ok('a hash is produced', h1.length === 24, String(h1.length));
  ok('the same text through noise hashes the same',
     cellHash(same,0,0,80,20) === h1, cellHash(same,0,0,80,20) + ' vs ' + h1);
  ok('different text hashes differently', cellHash(other,0,0,80,20) !== h1);
  ok('a context that throws gives an empty hash',
     cellHash({ getImageData(){ throw new Error('tainted'); } },0,0,10,10) === '');

  // A row highlighting itself changes every pixel's brightness without
  // changing a single letter, and must not trigger a re-read.
  const lit = mk(80,20,(x,y)=> (x>10&&x<40&&y>5&&y<15) ? 255 : 90);
  ok('a highlighted row hashes the same as the unlit one',
     cellHash(lit,0,0,80,20) === h1, cellHash(lit,0,0,80,20) + ' vs ' + h1);

  const blank = mk(80,20,()=>128);
  ok('an empty cell is simply flat', cellHash(blank,0,0,80,20) === 'flat');
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
