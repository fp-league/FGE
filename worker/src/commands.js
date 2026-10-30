/**
 * The slash command definitions, in one place.
 *
 * Shared by register-commands.mjs (run from a machine with the bot token)
 * and by the Worker's /api/discord/register endpoint (which uses the token
 * it already holds as a secret). Two copies would drift, and a drifted
 * command list is a bot that answers the wrong thing.
 */

const CLASS_OPTION = {
  name: 'class',
  description: 'Which class (defaults to GT3)',
  type: 3,                      // STRING
  required: false,
  choices: [
    { name: 'GT3', value: 'gt3' },
    { name: 'GT4', value: 'gt4' },
  ],
};

const commands = [
  {
    name: 'standings',
    description: 'Current championship standings',
    options: [
      {
        name: 'type',
        description: 'Drivers or constructors (defaults to drivers)',
        type: 3,
        required: false,
        choices: [
          { name: 'Drivers', value: 'drivers' },
          { name: 'Teams',   value: 'teams' },
        ],
      },
      CLASS_OPTION,
    ],
  },
  {
    name: 'results',
    description: 'Race classification',
    options: [
      { name: 'round', description: 'Round number (defaults to the latest race)', type: 4, required: false },
      CLASS_OPTION,
    ],
  },
  { name: 'calendar', description: 'Full season calendar', options: [CLASS_OPTION] },
  { name: 'nextrace', description: 'The next race and when it starts', options: [CLASS_OPTION] },
  {
    name: 'lineups',
    description: 'Team lineups',
    options: [
      { name: 'team', description: 'Show one team only', type: 3, required: false },
      CLASS_OPTION,
    ],
  },
  {
    name: 'driver',
    description: 'A driver’s season so far',
    options: [
      { name: 'name', description: 'Driver name', type: 3, required: true },
      CLASS_OPTION,
    ],
  },
];

/* Class-prefixed variants: /gt3 standings, /gt4 results, ... so nobody has
   to pass `class:` every time. Same views, class fixed by the command. */
const TYPE_OPTION = {
  name: 'type', description: 'Drivers or constructors (defaults to drivers)', type: 3, required: false,
  choices: [{ name: 'Drivers', value: 'drivers' }, { name: 'Teams', value: 'teams' }],
};

const subcommands = [
  { name: 'standings', description: 'Championship standings', type: 1, options: [TYPE_OPTION] },
  { name: 'results',   description: 'Race classification',    type: 1,
    options: [{ name: 'round', description: 'Round number (defaults to the latest race)', type: 4, required: false }] },
  { name: 'calendar',  description: 'Full season calendar',   type: 1 },
  { name: 'nextrace',  description: 'The next race and when it starts', type: 1 },
  { name: 'lineups',   description: 'Team lineups',           type: 1,
    options: [{ name: 'team', description: 'Show one team only', type: 3, required: false }] },
  { name: 'driver',    description: 'A driver’s season so far', type: 1,
    options: [{ name: 'name', description: 'Driver name', type: 3, required: true }] },
];

commands.push(
  { name: 'gt3', description: 'GT3 — standings, results, calendar and lineups', options: subcommands },
  { name: 'gt4', description: 'GT4 — standings, results, calendar and lineups', options: subcommands },
);

// ── Trading cards ────────────────────────────────────────
// Reuses the class picker declared at the top of this file.
commands.push({
  name: 'cards',
  description: 'FGE driver trading cards — open packs and build a collection',
  options: [
    { name: 'pack', description: 'Open a pack of 5 driver cards (one free pack every 8 hours)',
      type: 1, options: [CLASS_OPTION] },
    { name: 'collection', description: 'See a collection', type: 1, options: [
      { name: 'user', description: 'Whose collection (defaults to yours)', type: 6, required: false },
      CLASS_OPTION,
    ] },
    { name: 'card', description: 'Look at one driver’s card', type: 1, options: [
      { name: 'name', description: 'Driver name', type: 3, required: true },
      CLASS_OPTION,
    ] },
    { name: 'collectors', description: 'Who has collected the most', type: 1, options: [CLASS_OPTION] },
  ],
});

// ── Economy ──────────────────────────────────────────────
// Top level rather than subcommands of /cards: these are the things people
// run twenty times a day, and `/work` beats `/cards economy work`.
commands.push(
  {
    name: 'work',
    description: 'Do a job for credits — run it with no job to see the board',
    options: [{ name: 'job', description: 'Which job (leave blank to see them all)',
                type: 3, required: false }],
  },
  { name: 'daily', description: 'Claim your daily credits and keep your streak' },
  {
    name: 'balance',
    description: 'Your wallet — balance, rank and what you have been spending',
    options: [{ name: 'user', description: 'Whose wallet (defaults to yours)',
                type: 6, required: false }],
  },
  {
    name: 'pay',
    description: 'Send credits to someone else',
    options: [
      { name: 'user',   description: 'Who to pay',  type: 6, required: true },
      { name: 'amount', description: 'How much',    type: 4, required: true },
    ],
  },
  { name: 'rich', description: 'Who has the most credits' },
  {
    name: 'shop',
    description: 'Packs you can buy',
    options: [CLASS_OPTION],
  },
  {
    name: 'buy',
    description: 'Buy and open a pack',
    options: [{ name: 'pack', description: 'Which pack (see /shop)', type: 3, required: true }],
  },
  {
    name: 'sell',
    description: 'Sell duplicate cards for credits — your last copy is never sold',
    options: [
      { name: 'name',   description: 'Driver or card name, or "all" for every spare',
        type: 3, required: false },
      { name: 'amount', description: 'How many copies (defaults to all the spares)',
        type: 4, required: false },
      CLASS_OPTION,
    ],
  },
);

export const COMMANDS = commands;
