/**
 * Blackjack and roulette.
 *
 * Everything in the top half of this file is pure: shuffling, scoring,
 * drawing the cards and settling a spin all take values and return values,
 * so the rules can be tested without a database or a Discord payload
 * anywhere near them. The bottom half is the part that talks to D1 and
 * builds embeds.
 *
 * The house edge is the ordinary one for each game rather than anything
 * invented — blackjack pays 3:2 on a natural and the dealer stands on all
 * 17s, roulette is single-zero. A league economy is not a casino's balance
 * sheet, and rules people already know are easier to trust than rules that
 * quietly take more.
 */

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

/* ── Cards ─────────────────────────────────────────────── */

export function freshDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(r + s);
  return deck;
}

/** Fisher–Yates. `rng` is injectable so a test can deal a known hand. */
export function shuffle(deck, rng = Math.random) {
  const d = deck.slice();
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

export const rankOf = card => card.slice(0, -1);
export const suitOf = card => card.slice(-1);

/**
 * Best total for a hand, and whether an ace is still counting as eleven.
 *
 * Aces are counted as eleven and demoted one at a time while the hand is
 * bust, which is the only way "A,6" is 17 and "A,6,10" is 17 as well.
 */
export function score(hand) {
  let total = 0, aces = 0;
  for (const c of hand) {
    const r = rankOf(c);
    if (r === 'A') { aces++; total += 11; }
    else if (r === 'K' || r === 'Q' || r === 'J' || r === '10') total += 10;
    else total += Number(r);
  }
  let soft = aces > 0;
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  if (total > 21 || aces === 0) soft = false;
  return { total, soft, bust: total > 21 };
}

export const isBlackjack = hand => hand.length === 2 && score(hand).total === 21;

/**
 * The cards, drawn.
 *
 * Three lines per card in a fixed three-character box, so a row of them
 * lines up in Discord's monospace block. The rank sits top-left and
 * bottom-right the way it does on a real card, which is also what makes a
 * fanned row readable when only the left edge of each is visible.
 */
export function drawCards(hand, hideFrom = -1) {
  const top = [], mid = [], bot = [], edge = [];
  hand.forEach((card, i) => {
    const hidden = hideFrom >= 0 && i >= hideFrom;
    edge.push('┌───┐');
    if (hidden) { top.push('│▒▒▒│'); mid.push('│▒▒▒│'); bot.push('│▒▒▒│'); return; }
    const r = rankOf(card), s = suitOf(card);
    top.push('│' + r.padEnd(3) + '│');
    mid.push('│ ' + s + ' │');
    bot.push('│' + r.padStart(3) + '│');
  });
  return [
    edge.join(' '),
    top.join(' '),
    mid.join(' '),
    bot.join(' '),
    edge.map(() => '└───┘').join(' '),
  ].join('\n');
}

/** "18" or "soft 17" — the distinction decides whether another card is safe. */
export function sayScore(hand) {
  const s = score(hand);
  if (isBlackjack(hand)) return 'blackjack';
  if (s.bust) return `${s.total} — bust`;
  return s.soft ? `soft ${s.total}` : String(s.total);
}

/* ── Blackjack ─────────────────────────────────────────── */

export function dealBlackjack(rng = Math.random) {
  const deck = shuffle(freshDeck(), rng);
  return {
    deck,
    player: [deck.pop(), deck.pop()],
    dealer: [deck.pop(), deck.pop()],
    done: false,
    doubled: false,
  };
}

export function hit(game) {
  const g = { ...game, player: game.player.concat([game.deck[game.deck.length - 1]]),
              deck: game.deck.slice(0, -1) };
  if (score(g.player).bust) g.done = true;
  return g;
}

/** The dealer reveals and draws to 17, standing on all 17s including soft. */
export function dealerPlay(game) {
  let deck = game.deck.slice(), dealer = game.dealer.slice();
  while (score(dealer).total < 17) dealer.push(deck.pop());
  return { ...game, deck, dealer, done: true };
}

/**
 * What the hand is worth, as a multiple of the stake.
 *
 * 0 means the stake is gone, 1 is a push, 2 doubles it, 2.5 is a natural
 * at 3:2. Returning a multiplier rather than a delta keeps doubling down
 * honest: the stake has already been doubled by then, so the same numbers
 * still apply.
 */
export function settle(game) {
  const p = score(game.player), d = score(game.dealer);
  const pBJ = isBlackjack(game.player), dBJ = isBlackjack(game.dealer);

  if (pBJ && dBJ) return { mult: 1,   outcome: 'push',  why: 'Both blackjack.' };
  if (pBJ)        return { mult: 2.5, outcome: 'win',   why: 'Blackjack, paid 3:2.' };
  if (dBJ)        return { mult: 0,   outcome: 'loss',  why: 'Dealer had blackjack.' };
  if (p.bust)     return { mult: 0,   outcome: 'loss',  why: `Bust on ${p.total}.` };
  if (d.bust)     return { mult: 2,   outcome: 'win',   why: `Dealer bust on ${d.total}.` };
  if (p.total > d.total) return { mult: 2, outcome: 'win',  why: `${p.total} beats ${d.total}.` };
  if (p.total < d.total) return { mult: 0, outcome: 'loss', why: `${d.total} beats ${p.total}.` };
  return { mult: 1, outcome: 'push', why: `Both ${p.total}.` };
}

/* ── Roulette ──────────────────────────────────────────── */

// Single zero. The reds are the standard European layout rather than
// anything derived, because "is 19 red" has one right answer.
const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

export const colourOf = n => (n === 0 ? 'green' : RED.has(n) ? 'red' : 'black');

export const BETS = [
  { id: 'red',    label: 'Red',            pays: 1,  hits: n => colourOf(n) === 'red' },
  { id: 'black',  label: 'Black',          pays: 1,  hits: n => colourOf(n) === 'black' },
  { id: 'odd',    label: 'Odd',            pays: 1,  hits: n => n !== 0 && n % 2 === 1 },
  { id: 'even',   label: 'Even',           pays: 1,  hits: n => n !== 0 && n % 2 === 0 },
  { id: 'low',    label: 'Low (1–18)',     pays: 1,  hits: n => n >= 1 && n <= 18 },
  { id: 'high',   label: 'High (19–36)',   pays: 1,  hits: n => n >= 19 && n <= 36 },
  { id: 'dozen1', label: 'First dozen (1–12)',  pays: 2, hits: n => n >= 1 && n <= 12 },
  { id: 'dozen2', label: 'Second dozen (13–24)', pays: 2, hits: n => n >= 13 && n <= 24 },
  { id: 'dozen3', label: 'Third dozen (25–36)',  pays: 2, hits: n => n >= 25 && n <= 36 },
];

/**
 * Find the bet someone asked for: one of the named ones, or a straight-up
 * number. A number pays 35:1, which is where the game gets its drama.
 */
export function parseBet(input) {
  const q = String(input == null ? '' : input).trim().toLowerCase();
  if (!q) return null;
  const named = BETS.find(b => b.id === q)
             || BETS.find(b => b.label.toLowerCase() === q)
             || BETS.find(b => b.label.toLowerCase().startsWith(q));
  if (named) return named;
  if (/^\d{1,2}$/.test(q)) {
    const n = Number(q);
    if (n >= 0 && n <= 36) {
      return { id: String(n), label: `Straight up on ${n}`, pays: 35, hits: x => x === n };
    }
  }
  return null;
}

export const spin = (rng = Math.random) => Math.floor(rng() * 37);

/** Multiplier on the stake: 0 for a loss, pays + 1 for a win. */
export function settleSpin(bet, n) {
  return bet.hits(n) ? bet.pays + 1 : 0;
}

/** The result, shown as the pocket it landed in. */
export function drawWheel(n) {
  const c = colourOf(n);
  const dot = c === 'red' ? '🔴' : c === 'black' ? '⚫' : '🟢';
  // Centred in a fixed box. padStart alone made a single digit one
  // character wider than a double, so the frame changed shape depending
  // on where the ball landed.
  const t = String(n);
  const lead = Math.floor((6 - t.length) / 2);
  return [
    '┌──────┐',
    `│${' '.repeat(lead)}${t}${' '.repeat(6 - t.length - lead)}│`,
    '└──────┘',
  ].join('\n') + `\n${dot} ${c}`;
}

/* ── Slots ─────────────────────────────────────────────── */
/**
 * Three reels, six symbols, every symbol equally likely.
 *
 * Equal weights are a deliberate choice: a weighted reel can be tuned to
 * any return you like, but nobody reading the code can tell what the
 * return IS without simulating it. With a flat reel the whole paytable is
 * 216 outcomes and the return is arithmetic — see slotReturn(), which the
 * tests check exactly rather than by rolling dice ten thousand times and
 * hoping.
 */
export const REELS = ['🏁', '🏆', '⚙️', '🛞', '⛽', '🔧'];
export const JACKPOT = '🏁';

/** Multipliers on the stake, paid as the total returned. */
export const SLOT_PAYS = { jackpot: 33, trio: 13, pair: 1.2 };

export const pullSlots = (rng = Math.random) =>
  [0, 0, 0].map(() => REELS[Math.floor(rng() * REELS.length)]);

export function slotPayout(reels) {
  const [a, b, c] = reels;
  if (a === b && b === c) {
    return a === JACKPOT
      ? { mult: SLOT_PAYS.jackpot, why: 'Three chequered flags — the jackpot.' }
      : { mult: SLOT_PAYS.trio, why: `Three ${a} in a row.` };
  }
  if (a === b || b === c || a === c) {
    return { mult: SLOT_PAYS.pair, why: 'Two of a kind.' };
  }
  return { mult: 0, why: 'Nothing lines up.' };
}

/**
 * The exact return to player, worked out rather than measured.
 *
 * n symbols on 3 reels: n ways to line up three of a kind (one of them
 * the jackpot), 3n(n-1) ways to get exactly two, and the rest nothing.
 */
export function slotReturn() {
  const n = REELS.length, total = n ** 3;
  const trios = n - 1;                 // three of a kind that is not the jackpot
  const pairs = 3 * n * (n - 1);       // exactly two matching
  return (SLOT_PAYS.jackpot + trios * SLOT_PAYS.trio + pairs * SLOT_PAYS.pair) / total;
}

/* ── Higher or lower ───────────────────────────────────── */
/**
 * The multiplier is priced off the real odds of the card on the table.
 *
 * A 2 showing makes "higher" nearly certain, so it pays nearly nothing; an
 * 8 is a coin flip and pays close to double. Quoting one flat multiplier
 * would mean the same button was a gift on one card and a mugging on the
 * next, and only the people who had worked that out would ever win.
 *
 * Both prices are shown on the buttons before anything is pressed, so the
 * house edge is the same whichever way you go and there is nothing to
 * work out.
 */
export const HL_RETURN = 0.95;        // the house keeps 5%, whatever you back

export const cardValue = card => {
  const r = rankOf(card);
  if (r === 'A') return 14;
  if (r === 'K') return 13;
  if (r === 'Q') return 12;
  if (r === 'J') return 11;
  return Number(r);
};

/** Chance the next card off `deck` is higher / lower than `card`. Ties lose. */
export function hiLoOdds(card, deck) {
  const v = cardValue(card);
  const left = deck.length;
  if (!left) return { higher: 0, lower: 0 };
  let hi = 0, lo = 0;
  for (const c of deck) {
    const n = cardValue(c);
    if (n > v) hi++; else if (n < v) lo++;
  }
  return { higher: hi / left, lower: lo / left };
}

/**
 * What one correct call pays, as a multiplier on the pot.
 *
 * Capped at 1.01 so a near-certain call still nudges the pot upward — a
 * button that says "x1.00" is not a choice, it is a dare with no prize.
 */
export const hiLoMultiplier = p =>
  (p <= 0 ? 0 : Math.max(1.01, Math.round((HL_RETURN / p) * 100) / 100));

/** Did the call come in? Ties go to the house, which is where the edge is. */
export const hiLoWon = (shown, next, call) =>
  (call === 'higher' ? cardValue(next) > cardValue(shown)
                     : cardValue(next) < cardValue(shown));
