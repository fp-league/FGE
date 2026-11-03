/**
 * Typeahead for the slash commands.
 *
 * Several options used to be free text you had to get exactly right —
 * `/buy pack:` wanted a pack name, `/sell name:` wanted a card name, and
 * getting either slightly wrong came back as "nothing called that". The
 * names live in the database and change whenever an admin edits them, so
 * the person typing is the last one who should have to remember them.
 *
 * Discord sends an APPLICATION_COMMAND_AUTOCOMPLETE interaction (type 4)
 * on each keystroke and expects a list back within three seconds, so every
 * source here is either an in-isolate cache or one small D1 read. The
 * commands themselves still accept typed text, because an option with
 * autocomplete is a suggestion box, not a closed list — someone on a flaky
 * connection can still type "podium" and have it work.
 */

import { listPackTypes, listJobs, listSpares } from './economy.js';
import { fullSet, RARITY } from './cards.js';
import { rouletteChoices, betChoices } from './games.js';

const MAX = 25;                      // Discord's hard limit on choices
const cut = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));

/** A choice Discord will accept: both fields are capped at 100 characters. */
const choice = (name, value) => ({ name: cut(name, 100), value: cut(String(value), 100) });

/**
 * Find the option the person is typing in.
 *
 * Options nest: /trade offer give:… arrives as a subcommand holding the
 * real options, so this walks down rather than reading the top level.
 */
function focused(options, trail = []) {
  for (const o of options || []) {
    if (o.type === 1 || o.type === 2) {            // SUB_COMMAND / _GROUP
      const hit = focused(o.options, trail.concat(o.name));
      if (hit) return hit;
    } else if (o.focused) {
      return { option: o, trail, siblings: options || [] };
    }
  }
  return null;
}

/**
 * Rank matches the way a person expects: what they typed at the start of a
 * name first, then anywhere in it. Everything is compared lowercased, so
 * "GT3 Pack" is found by "gt3", "pack" or "Pack".
 */
function search(items, q) {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return items.slice(0, MAX);
  const starts = [], holds = [];
  for (const it of items) {
    const hay = String(it.hay || it.name).toLowerCase();
    const at = hay.indexOf(needle);
    if (at === 0) starts.push(it);
    else if (at > 0) holds.push(it);
    if (starts.length >= MAX) break;
  }
  return starts.concat(holds).slice(0, MAX);
}

const reply = choices => ({ type: 8, data: { choices: choices.slice(0, MAX) } });

// ── The sources ──────────────────────────────────────────

async function packChoices(env, q) {
  const packs = (await listPackTypes(env)).filter(p => p.enabled !== 0);
  return search(packs.map(p => ({
    hay: `${p.name} ${p.id}`,
    // The price is the thing you actually want to know while choosing.
    name: `${p.emoji || '🃏'} ${p.name} — ${p.price}`,
    // The id, so the pack is unambiguous even if two share a name.
    value: p.id,
  })), q).map(c => choice(c.name, c.value));
}

async function jobChoices(env, q) {
  const jobs = (await listJobs(env)).filter(j => j.enabled !== 0);
  return search(jobs.map(j => ({
    hay: `${j.name} ${j.id}`,
    name: `${j.emoji || '🔧'} ${j.name} — ${j.min_pay}–${j.max_pay}`,
    value: j.id,
  })), q).map(c => choice(c.name, c.value));
}

/** Every card in the set, rarest first so the interesting ones are on top. */
async function cardChoices(env, record, q) {
  const set = await fullSet(env, record);
  const items = set.map(c => ({
    hay: `${c.name} ${c.team || ''}`,
    name: `${(RARITY[c.rarity] || {}).icon || '⚪'} ${c.name}` +
          (c.team ? ` — ${c.team}` : ''),
    value: c.name,
  }));
  return search(items, q).map(c => choice(c.name, c.value));
}

/**
 * Only the cards someone can actually part with.
 *
 * Offering a card you do not have spare is the commonest way a trade fails,
 * and it fails after you have typed two names and picked a person. Listing
 * the spares means the offer is valid before it is sent.
 */
async function spareChoices(env, record, userId, q) {
  if (!userId) return [];
  const have = new Map((await listSpares(env, userId)).map(r => [r.driver_id, r.copies]));
  if (!have.size) return [];
  const set = await fullSet(env, record);
  const items = set
    .filter(c => have.has(c.id))
    .map(c => ({
      hay: c.name,
      name: `${(RARITY[c.rarity] || {}).icon || '⚪'} ${c.name} — ${have.get(c.id) - 1} spare`,
      value: c.name,
    }));
  return search(items, q).map(c => choice(c.name, c.value));
}

const classOf = (data, trail) => {
  if (data.name === 'gt3' || data.name === 'gt4') return data.name;
  const flat = (data.options || []).find(o => o.name === 'class');
  const nested = trail.length
    ? (((data.options || [])[0] || {}).options || []).find(o => o.name === 'class')
    : null;
  const v = (flat || nested || {}).value;
  return String(v || 'gt3').toLowerCase() === 'gt4' ? 'gt4' : 'gt3';
};

function driverChoices(record, cls, q) {
  const drivers = ((record || {})[cls] || {}).drivers || [];
  return search(drivers.map(d => ({
    hay: `${d.name} ${d.team || ''}`,
    name: d.number ? `#${d.number} ${d.name}${d.team ? ` — ${d.team}` : ''}`
                   : `${d.name}${d.team ? ` — ${d.team}` : ''}`,
    value: d.name,
  })), q).map(c => choice(c.name, c.value));
}

function teamChoices(record, cls, q) {
  const cd = (record || {})[cls] || {};
  // Teams can be a list of their own or only implied by the drivers.
  const named = (cd.teams || []).map(t => (typeof t === 'string' ? t : t && t.name)).filter(Boolean);
  const fromDrivers = (cd.drivers || []).map(d => d.team).filter(Boolean);
  const seen = [...new Set(named.concat(fromDrivers))];
  return search(seen.map(t => ({ name: t, value: t })), q).map(c => choice(c.name, c.value));
}

// ── Dispatch ─────────────────────────────────────────────

/**
 * Returns a type-8 response, or null when nothing sensible can be offered —
 * in which case the caller sends an empty list, because Discord expects an
 * answer to every autocomplete interaction and sulks if it does not get one.
 */
export async function handleAutocomplete(interaction, record, env) {
  const data = interaction.data || {};
  const hit = focused(data.options);
  if (!hit) return null;

  const { option, trail, siblings } = hit;
  const q = option.value;
  const path = [data.name, ...trail].join(' ');
  const sib = n => ((siblings.find(o => o.name === n) || {}).value);

  switch (`${path} ${option.name}`) {
    case 'buy pack':
      return reply(await packChoices(env, q));

    case 'work job':
      return reply(await jobChoices(env, q));

    // The named bets, plus whatever number is being typed offered back as
    // a straight bet — listing all thirty-seven would bury the rest.
    case 'bet driver':
      return reply((await betChoices(env, classOf(data, trail), q))
        .map(c => choice(c.name, c.value)));

    case 'roulette on':
      return reply(rouletteChoices(q).map(c => choice(c.name, c.value)));

    // Selling is from your own spares; naming a card you have only one of
    // is never going to work, so it is not offered.
    case 'sell name': {
      const mine = await spareChoices(env, record, (interaction.member?.user || interaction.user || {}).id, q);
      // "all" is a real argument to /sell and worth surfacing.
      const all = choice('💰 all — every spare you own', 'all');
      return reply(q && !'all'.startsWith(String(q).toLowerCase()) ? mine : [all, ...mine]);
    }

    case 'cards card name':
      return reply(await cardChoices(env, record, q));

    // Your spares on one side, theirs on the other, so an offer can only be
    // built out of cards that actually exist to trade.
    case 'trade offer give':
      return reply(await spareChoices(env, record, (interaction.member?.user || interaction.user || {}).id, q));
    case 'trade offer want':
      return reply(await spareChoices(env, record, sib('user'), q));

    default: break;
  }

  // Driver and team names appear on both command shapes — /driver name and
  // /gt4 driver name — so they are matched on the option, not the path.
  if (option.name === 'name' && /(^|\s)driver$/.test(path)) {
    return reply(driverChoices(record, classOf(data, trail), q));
  }
  if (option.name === 'team' && /(^|\s)lineups$/.test(path)) {
    return reply(teamChoices(record, classOf(data, trail), q));
  }

  return null;
}
