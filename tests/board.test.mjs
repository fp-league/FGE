/** findTable against the real Fortnite screenshot, via a stub canvas. */
import { findTable, playerColumn } from '../ocr/read-board.js';
import fs from 'fs';
import path from 'path';
import { PNG } from 'pngjs';

/**
 * The real frames, decoded.
 *
 * These were raw RGBA buffers sitting outside the repository — 44 MB for
 * the three, which is not something to commit. The same pixels as PNG are
 * 4 MB and decode to a byte-identical buffer, so the detector sees exactly
 * what it saw before.
 */
const here = path.dirname(new URL(import.meta.url).pathname);
function frame(name) {
  const png = PNG.sync.read(fs.readFileSync(path.join(here, 'fixtures', name + '.png')));
  return { width: png.width, height: png.height, data: png.data };
}
const asCanvas = f => ({
  width: f.width, height: f.height,
  getContext: () => ({ getImageData: () => ({ data: f.data }) }),
});

const fn = frame('fn');
const W = fn.width, H = fn.height;
const canvas = asCanvas(fn);

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x ? ' → ' + x : '')); } };

const t = findTable(canvas);
console.log('header:', t && t.header);
console.log('rows:  ', t && t.rows.length, t && t.rows.slice(0, 3));
console.log('cols:  ', t && t.cols);

ok('it finds a table at all', Boolean(t));
ok('eight finishers', t.rows.length === 8, String(t.rows.length));
ok('the header is the band above them', t.header[0] === 267 && t.header[1] === 296,
   JSON.stringify(t.header));
ok('the ROUND 1 OF 3 title is not mistaken for a row',
   !t.rows.some(r => r[0] < 250), JSON.stringify(t.rows[0]));
// Seven: WINS, PLAYER, LAP, LAPS LED, PIT STOPS, LAP TIME, TRACK LIMITS.
ok('all seven columns', t.cols.length === 7, String(t.cols.length));
ok('PLAYER is the second of them',
   Math.abs(t.cols[1][0] - 164) < 6, String(t.cols[1][0]));

// Rows must be evenly spaced — that is the property the pitch search uses.
const pitches = t.rows.slice(1).map((r, i) => r[0] - t.rows[i][0]);
const spread = Math.max(...pitches) - Math.min(...pitches);
ok('rows come out evenly spaced', spread <= 2, 'spread ' + spread + ' from ' + pitches.join(','));

const HEADERS = ['WINS','PLAYER','LAP','LAPS LED','PIT STOPS','LAP TIME','TRACK LIMITS'];
ok('the player column is found by its header',
   playerColumn(HEADERS, t.cols) === 1, String(playerColumn(HEADERS, t.cols)));
ok('and by being the widest when the header will not read',
   playerColumn(['','','','','','',''], t.cols) === 1,
   String(playerColumn(['','','','','','',''], t.cols)));

// A board sitting in a whole gameplay frame. Boxing it is still the
// accurate way — the columns in particular only separate cleanly on a
// crop — but it is no longer all-or-nothing.
{
  const BX = 40, BY = 60;
  const fs2 = frame('fullscreen');
  const FW = fs2.width, FH = fs2.height;
  const full = fs2.data;
  const whole = asCanvas(fs2);
  ok('a board in a full gameplay frame is found at all', Boolean(findTable(whole)));

  const crop = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const s = ((y + BY) * FW + (x + BX)) * 4, d = (y * W + x) * 4;
    crop[d] = full[s]; crop[d+1] = full[s+1]; crop[d+2] = full[s+2]; crop[d+3] = 255;
  }
  const boxed = { width: W, height: H,
    getContext: () => ({ getImageData: () => ({ data: crop }) }) };
  const t2 = findTable(boxed);
  ok('and boxed to the board it is exact', Boolean(t2));
  ok('with every row', t2 && t2.rows.length === 8, t2 ? String(t2.rows.length) : 'none');
  ok('and every column', t2 && t2.cols.length === 7, t2 ? String(t2.cols.length) : 'none');
}

// A real 4K capture of a translucent board over bright gameplay — the one
// that was failing. Its rows sit around 115 and its gaps around 103 inside
// a frame ranging 64 to 170, so the midpoint of the whole picture falls in
// the middle of the rows and finds nothing. The local comparison does.
{
  const real = frame('real');
  const t = findTable(asCanvas(real));
  ok('the translucent board is found', Boolean(t));
  ok('with all six drivers', t && t.rows.length === 6, t ? String(t.rows.length) : 'none');
  ok('and the header above them', t && t.header[1] < t.rows[0][0],
     t ? JSON.stringify(t.header) : 'none');
  ok('rows evenly spaced', (() => {
    if (!t) return false;
    const p = t.rows.slice(1).map((r, i) => r[0] - t.rows[i][0]);
    return Math.max(...p) - Math.min(...p) <= 3;
  })());
  // The name column is what the order depends on; the numeric ones run
  // together on an uncropped frame and the gaps quietly go unread.
  ok('the player column is separated', t && t.cols.length >= 2 &&
     Math.abs(t.cols[1][0] - 508) < 30, t ? JSON.stringify(t.cols[1]) : 'none');
}

// Nonsense in, nothing out — never a confident wrong answer.
const flat = { width: 40, height: 40,
  getContext: () => ({ getImageData: () => ({ data: new Uint8Array(40*40*4).fill(128) }) }) };
ok('a blank image finds no table', findTable(flat) === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
