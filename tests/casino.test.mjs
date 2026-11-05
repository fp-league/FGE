/**
 * The casino rules, checked as arithmetic.
 *
 * Everything here is pure, so the dealer can be given a known shoe and the
 * payouts checked against the real odds rather than eyeballed.
 */
import {
  freshDeck, shuffle, score, isBlackjack, drawCards, sayScore,
  dealBlackjack, hit, dealerPlay, settle,
  colourOf, BETS, parseBet, spin, settleSpin, drawWheel,
} from '../worker/src/casino.js';

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL  ' + n + (x ? '  →  ' + x : '')); } };

/* ── deck ──────────────────────────────────────────────── */
console.log('THE DECK');
{
  const d = freshDeck();
  ok('fifty-two cards', d.length === 52, String(d.length));
  ok('no duplicates', new Set(d).size === 52);
  ok('thirteen of each suit', ['♠','♥','♦','♣'].every(s => d.filter(c => c.endsWith(s)).length === 13));
  ok('four of each rank', ['A','10','K'].every(r => d.filter(c => c.slice(0,-1) === r).length === 4));

  // A shuffle must be a permutation, not a new set of cards.
  const s = shuffle(d);
  ok('a shuffle keeps every card', new Set(s).size === 52 && s.length === 52);
  ok('and actually moves them', s.join() !== d.join());

  // Seeded: the same rng gives the same shoe, which is what makes the
  // rest of these tests possible.
  const seeded = () => { let x = 42; return () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648; };
  ok('a seeded shuffle repeats', shuffle(d, seeded()).join() === shuffle(d, seeded()).join());
}

/* ── scoring ───────────────────────────────────────────── */
console.log('\nSCORING');
{
  const t = h => score(h).total;
  ok('pips add up', t(['2♠','3♥','4♦']) === 9);
  ok('faces are ten', t(['K♠','Q♥']) === 20);
  ok('an ace is eleven when it fits', t(['A♠','6♥']) === 17);
  ok('and one when it does not', t(['A♠','6♥','10♦']) === 17);
  ok('two aces are not twenty-two', t(['A♠','A♥']) === 12, String(t(['A♠','A♥'])));
  ok('three aces and an eight', t(['A♠','A♥','A♦','8♣']) === 21, String(t(['A♠','A♥','A♦','8♣'])));
  ok('soft is reported', score(['A♠','6♥']).soft === true);
  ok('and stops being soft once demoted', score(['A♠','6♥','10♦']).soft === false);
  ok('bust is reported', score(['K♠','Q♥','5♦']).bust === true);
  ok('twenty-one is not bust', score(['K♠','A♥']).bust === false);

  ok('two cards to 21 is blackjack', isBlackjack(['A♠','K♥']) === true);
  ok('three cards to 21 is not', isBlackjack(['7♠','7♥','7♦']) === false);
  ok('sayScore names a natural', sayScore(['A♠','K♥']) === 'blackjack', sayScore(['A♠','K♥']));
  ok('sayScore marks soft', sayScore(['A♠','6♥']) === 'soft 17', sayScore(['A♠','6♥']));
  ok('sayScore says bust', /bust/.test(sayScore(['K♠','Q♥','5♦'])));
}

/* ── the drawing ───────────────────────────────────────── */
console.log('\nTHE CARDS AS DRAWN');
{
  const art = drawCards(['A♠','10♥']);
  const lines = art.split('\n');
  ok('five lines tall', lines.length === 5, String(lines.length));
  const widths = [...new Set(lines.map(l => l.length))];
  ok('every line the same width', widths.length === 1, widths.join());
  ok('the rank shows', art.includes('A') && art.includes('10'));
  ok('the suits show', art.includes('♠') && art.includes('♥'));

  // A ten is two characters where a king is one; the box must not grow.
  const king = drawCards(['K♠']).split('\n').map(l => l.length);
  const ten  = drawCards(['10♠']).split('\n').map(l => l.length);
  ok('a ten is the same width as a king', king.join() === ten.join(), king.join() + ' vs ' + ten.join());

  const hole = drawCards(['A♠','K♥'], 1);
  ok('the hole card is covered', hole.includes('▒'));
  ok('and the up card still shows', hole.includes('A'));
  ok('while the covered rank does not', !hole.includes('K'));
  const hw = [...new Set(hole.split('\n').map(l => l.length))];
  ok('covering does not change the width', hw.length === 1, hw.join());
}

/* ── play ──────────────────────────────────────────────── */
console.log('\nPLAY');
{
  const g = dealBlackjack();
  ok('two cards each', g.player.length === 2 && g.dealer.length === 2);
  ok('four come off the deck', g.deck.length === 48, String(g.deck.length));
  ok('nobody is dealt the same card twice',
     new Set(g.player.concat(g.dealer)).size === 4);

  const after = hit(g);
  ok('a hit adds one card', after.player.length === 3);
  ok('and takes it off the deck', after.deck.length === g.deck.length - 1);
  ok('the original hand is untouched', g.player.length === 2);

  // Dealer draws to 17 and stands, including on soft 17.
  for (let i = 0; i < 200; i++) {
    const d = dealerPlay(dealBlackjack());
    const s = score(d.dealer);
    if (!(s.total >= 17 || s.bust)) { ok('dealer always reaches 17', false, String(s.total)); break; }
    if (i === 199) ok('dealer always reaches 17', true);
  }
  const soft17 = dealerPlay({ deck: freshDeck(), dealer: ['A♠','6♥'], player: [] });
  ok('and stands on a soft 17', soft17.dealer.length === 2, soft17.dealer.join());
}

/* ── settlement ────────────────────────────────────────── */
console.log('\nSETTLEMENT');
{
  const s = (p, d) => settle({ player: p, dealer: d });
  ok('a natural pays 3:2', s(['A♠','K♥'], ['9♠','8♥']).mult === 2.5);
  ok('two naturals push', s(['A♠','K♥'], ['A♦','Q♣']).mult === 1);
  ok('the dealer natural takes it', s(['K♠','Q♥'], ['A♦','Q♣']).mult === 0);
  ok('bust loses even if the dealer busts too',
     s(['K♠','Q♥','5♦'], ['K♣','Q♦','4♥']).mult === 0);
  ok('a dealer bust pays even money', s(['10♠','8♥'], ['K♣','Q♦','4♥']).mult === 2);
  ok('the higher hand wins', s(['10♠','9♥'], ['10♣','8♦']).mult === 2);
  ok('the lower hand loses', s(['10♠','7♥'], ['10♣','8♦']).mult === 0);
  ok('equal totals push', s(['10♠','8♥'], ['9♣','9♦']).mult === 1);
  ok('21 in three cards beats 20', s(['7♠','7♥','7♦'], ['K♣','Q♦']).mult === 2);
  ok('but loses to a natural', s(['7♠','7♥','7♦'], ['A♣','Q♦']).mult === 0);

  // The multiplier is on the stake, so doubling needs no special case.
  ok('a win on a doubled stake returns four times the original',
     s(['10♠','9♥'], ['10♣','8♦']).mult * 2 === 4);
}

/* ── roulette ──────────────────────────────────────────── */
console.log('\nROULETTE');
{
  ok('zero is green', colourOf(0) === 'green');
  ok('1 is red', colourOf(1) === 'red');
  ok('2 is black', colourOf(2) === 'black');
  ok('19 is red', colourOf(19) === 'red');
  let reds = 0, blacks = 0;
  for (let n = 0; n <= 36; n++) { if (colourOf(n) === 'red') reds++; if (colourOf(n) === 'black') blacks++; }
  ok('eighteen of each colour', reds === 18 && blacks === 18, `${reds}/${blacks}`);

  ok('red is found by name', parseBet('red').id === 'red');
  ok('and by a prefix', parseBet('seco').id === 'dozen2', String(parseBet('seco') && parseBet('seco').id));
  ok('a number is a straight bet', parseBet('17').pays === 35);
  ok('zero can be backed', parseBet('0').hits(0) === true);
  ok('37 is not a pocket', parseBet('37') === null);
  ok('nonsense is refused', parseBet('banana') === null);

  const r = BETS.find(b => b.id === 'red');
  ok('red wins on red', settleSpin(r, 1) === 2);
  ok('red loses on black', settleSpin(r, 2) === 0);
  ok('red loses on zero', settleSpin(r, 0) === 0, String(settleSpin(r, 0)));
  const odd = BETS.find(b => b.id === 'odd');
  ok('zero is neither odd nor even', settleSpin(odd, 0) === 0 &&
     settleSpin(BETS.find(b => b.id === 'even'), 0) === 0);
  ok('a dozen pays 2:1', settleSpin(BETS.find(b => b.id === 'dozen2'), 13) === 3);
  ok('a straight pays 35:1', settleSpin(parseBet('17'), 17) === 36);

  // The wheel must cover every pocket and no others.
  const seen = new Set();
  for (let i = 0; i < 20000; i++) seen.add(spin());
  ok('every pocket can come up', seen.size === 37, String(seen.size));
  ok('and nothing outside 0–36', [...seen].every(n => n >= 0 && n <= 36));

  // The edge should be the real single-zero one: 2.7%.
  let stake = 0, back = 0;
  for (let i = 0; i < 200000; i++) { const n = spin(); stake += 1; back += settleSpin(r, n); }
  const edge = (1 - back / stake) * 100;
  ok('the house edge is the single-zero 2.7%', edge > 1.5 && edge < 4, edge.toFixed(2) + '%');

  const w = drawWheel(7);
  ok('the wheel shows the number', w.includes('7'));
  ok('and names the colour', /red/.test(w));
  ok('zero draws as green', /green/.test(drawWheel(0)));
  // The frame must not change shape with the number in it.
  const widths = new Set();
  for (let n = 0; n <= 36; n++) drawWheel(n).split('\n').slice(0, 3).forEach(l => widths.add(l.length));
  ok('the wheel is the same width for every pocket', widths.size === 1, [...widths].join());
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
