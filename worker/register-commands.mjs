/**
 * Registers the FGE slash commands with Discord. Run once, and again
 * whenever the command list below changes.
 *
 *   node register-commands.mjs
 *
 * Needs two environment variables (from the Discord developer portal):
 *   DISCORD_APP_ID   — General Information -> Application ID
 *   DISCORD_TOKEN    — Bot -> Reset Token
 *
 * PowerShell:
 *   $env:DISCORD_APP_ID="..."; $env:DISCORD_TOKEN="..."; node register-commands.mjs
 *
 * Pass a guild id as the first argument to register them to one server,
 * which appears instantly instead of taking up to an hour:
 *   node register-commands.mjs 123456789012345678
 */

const APP_ID = process.env.DISCORD_APP_ID;
const TOKEN  = process.env.DISCORD_TOKEN;
const GUILD  = process.argv[2];

if (!APP_ID || !TOKEN) {
  console.error('Set DISCORD_APP_ID and DISCORD_TOKEN first. See the comment at the top of this file.');
  process.exit(1);
}

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

const url = GUILD
  ? `https://discord.com/api/v10/applications/${APP_ID}/guilds/${GUILD}/commands`
  : `https://discord.com/api/v10/applications/${APP_ID}/commands`;

const res = await fetch(url, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', Authorization: `Bot ${TOKEN}` },
  body: JSON.stringify(commands),
});

if (!res.ok) {
  console.error(`Failed (HTTP ${res.status}):`);
  console.error(await res.text());
  process.exit(1);
}

const out = await res.json();
console.log(`Registered ${out.length} commands ${GUILD ? `to guild ${GUILD}` : 'globally'}:`);
out.forEach(c => {
  const subs = (c.options || []).filter(o => o.type === 1).map(o => o.name);
  console.log('  /' + c.name + (subs.length ? ' → ' + subs.join(', ') : ''));
});
if (!GUILD) console.log('\nGlobal commands can take up to an hour to appear. Pass a guild id to see them straight away.');
