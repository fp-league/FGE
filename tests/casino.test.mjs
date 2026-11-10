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
  REELS, JACKPOT, SLOT_PAYS, pullSlots, slotPayout, slotReturn,
  cardValue, hiLoOdds, hiLoMultiplier, hiLoWon, HL_RETURN,
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

/* ── slots ─────────────────────────────────────────────── */
console.log('\nSLOTS');
{
  ok('six symbols, all distinct', REELS.length === 6 && new Set(REELS).size === 6);
  ok('the jackpot symbol is one of them', REELS.includes(JACKPOT));

  // Worked out, not sampled: every one of the 216 outcomes enumerated and
  // paid, which must agree with the closed form the code advertises.
  let total = 0, counts = { jackpot: 0, trio: 0, pair: 0, nothing: 0 };
  for (const a of REELS) for (const b of REELS) for (const c of REELS) {
    const pay = slotPayout([a, b, c]);
    total += pay.mult;
    if (pay.mult === SLOT_PAYS.jackpot) counts.jackpot++;
    else if (pay.mult === SLOT_PAYS.trio) counts.trio++;
    else if (pay.mult === SLOT_PAYS.pair) counts.pair++;
    else counts.nothing++;
  }
  const n = REELS.length, combos = n ** 3;
  ok('every combination is covered', counts.jackpot + counts.trio + counts.pair + counts.nothing === combos);
  ok('exactly one jackpot line', counts.jackpot === 1, String(counts.jackpot));
  ok('five other three-of-a-kinds', counts.trio === n - 1, String(counts.trio));
  ok('ninety two-of-a-kinds', counts.pair === 3 * n * (n - 1), String(counts.pair));
  ok('the advertised return matches the enumeration',
     Math.abs(slotReturn() - total / combos) < 1e-12,
     `${slotReturn()} vs ${total / combos}`);

  // The number that actually matters: the house takes a cut, but a
  // sensible one. A league economy that pays out over 100% prints money.
  const rtp = slotReturn();
  ok('the house has an edge at all', rtp < 1, String(rtp));
  ok('and it is not a daylight robbery', rtp > 0.9, String(rtp));

  ok('three flags is the jackpot',
     slotPayout([JACKPOT, JACKPOT, JACKPOT]).mult === SLOT_PAYS.jackpot);
  const other = REELS.find(r => r !== JACKPOT);
  ok('three of anything else pays less',
     slotPayout([other, other, other]).mult === SLOT_PAYS.trio);
  ok('two of a kind pays a little', slotPayout([other, other, JACKPOT]).mult === SLOT_PAYS.pair);
  ok('a pair counts whichever reels it is on',
     slotPayout([other, JACKPOT, other]).mult === SLOT_PAYS.pair &&
     slotPayout([JACKPOT, other, other]).mult === SLOT_PAYS.pair);
  ok('three different symbols pay nothing',
     slotPayout([REELS[0], REELS[1], REELS[2]]).mult === 0);
  ok('and every outcome says why', [[JACKPOT,JACKPOT,JACKPOT],[other,other,other],
      [other,other,JACKPOT],[REELS[0],REELS[1],REELS[2]]]
      .every(r => typeof slotPayout(r).why === 'string' && slotPayout(r).why.length > 0));

  // The reels must actually use the whole strip.
  const seen = new Set();
  let i = 0;
  const cycle = () => { const v = (i % 600) / 600; i++; return v; };
  for (let k = 0; k < 600; k++) pullSlots(cycle).forEach(x => seen.add(x));
  ok('every symbol can come up', seen.size === REELS.length, String(seen.size));
  ok('a pull is three reels', pullSlots(() => 0).length === 3);
}

/* ── higher or lower ───────────────────────────────────── */
console.log('\nHIGHER OR LOWER');
{
  ok('aces are high', cardValue('A♠') === 14);
  ok('and the court cards rank under them',
     cardValue('K♠') === 13 && cardValue('Q♠') === 12 && cardValue('J♠') === 11);
  ok('numbers are themselves', cardValue('2♥') === 2 && cardValue('10♦') === 10);
  ok('suit makes no difference', cardValue('7♠') === cardValue('7♣'));

  const deck = freshDeck();
  const low = hiLoOdds('2♠', deck.filter(c => c !== '2♠'));
  ok('almost everything beats a two', low.higher > 0.9, String(low.higher));
  ok('and almost nothing is under it', low.lower === 0, String(low.lower));
  const high = hiLoOdds('A♠', deck.filter(c => c !== 'A♠'));
  ok('almost nothing beats an ace', high.higher < 0.06, String(high.higher));
  const mid = hiLoOdds('8♠', deck.filter(c => c !== '8♠'));
  ok('eight is close to a coin flip', Math.abs(mid.higher - mid.lower) < 0.1,
     `${mid.higher} / ${mid.lower}`);
  // Ties are the house edge, so the two sides must NOT sum to one.
  ok('the matching ranks go to the house', mid.higher + mid.lower < 1,
     String(mid.higher + mid.lower));
  ok('an empty deck offers nothing', hiLoOdds('8♠', []).higher === 0);

  // The price has to track the odds, or one button is a gift.
  ok('a likely call pays little', hiLoMultiplier(0.92) < 1.1, String(hiLoMultiplier(0.92)));
  ok('an even call pays about double', Math.abs(hiLoMultiplier(0.47) - 2.02) < 0.1,
     String(hiLoMultiplier(0.47)));
  ok('a long shot pays a lot', hiLoMultiplier(0.1) > 8, String(hiLoMultiplier(0.1)));
  ok('the edge is the same whichever way you go',
     [0.2, 0.4, 0.6, 0.8].every(p => Math.abs(p * hiLoMultiplier(p) - HL_RETURN) < 0.02));
  ok('the house keeps a cut', HL_RETURN < 1 && HL_RETURN > 0.9, String(HL_RETURN));
  ok('a certainty still nudges the pot', hiLoMultiplier(1) >= 1.01, String(hiLoMultiplier(1)));
  ok('an impossible call pays nothing', hiLoMultiplier(0) === 0);

  ok('higher means higher', hiLoWon('7♠', '8♥', 'higher') === true);
  ok('lower means lower', hiLoWon('7♠', '6♥', 'lower') === true);
  ok('wrong way round loses', hiLoWon('7♠', '8♥', 'lower') === false);
  ok('a tie loses on higher', hiLoWon('7♠', '7♥', 'higher') === false);
  ok('and a tie loses on lower', hiLoWon('7♠', '7♥', 'lower') === false);

  // The whole game priced end to end: pick the better side every time and
  // the return still has to land near the advertised edge.
  let staked = 0, returned = 0;
  let seed = 12345;
  const rng = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let r = 0; r < 4000; r++) {
    const d = shuffle(freshDeck(), rng);
    const shown = d.pop();
    const o = hiLoOdds(shown, d);
    const call = o.higher >= o.lower ? 'higher' : 'lower';
    const m = hiLoMultiplier(call === 'higher' ? o.higher : o.lower);
    staked += 1;
    if (hiLoWon(shown, d.pop(), call)) returned += m;
  }
  const rtp = returned / staked;
  ok('playing it well returns close to the advertised edge',
     Math.abs(rtp - HL_RETURN) < 0.05, `${rtp.toFixed(3)} vs ${HL_RETURN}`);
  ok('and never better than even', rtp < 1.02, String(rtp));
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
