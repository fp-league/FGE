/**
 * FGE API — Cloudflare Worker
 *
 * Holds the shared state the static site can't: DOTD votes and fantasy
 * entries. Keys live in Worker secrets and are never sent to the browser.
 *
 * What makes the results trustworthy:
 *  - one vote per person per race is a D1 PRIMARY KEY, not a client check
 *  - the Worker reads the league data itself and validates every write
 *    against it, so you can't vote on a race that hasn't run, vote for
 *    someone who wasn't in it, or submit fantasy picks after the results
 *    are already published
 *  - voters are identified by a salted hash of their IP; raw IPs are
 *    never stored
 */

import { verifyRequest, handleCommand } from './discord.js';

const MAX_NAME = 24;
const MAX_IDENT = 64;
const MAX_ENTRIES_PER_VOTER = 3;   // stops one person farming fantasy sign-ups
const LEAGUE_TTL_MS = 30_000;

const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;   // 3MB per image
const UPLOADS_PER_HOUR = 40;                // per IP, stops bucket flooding
const ALLOWED_IMAGE_TYPES = {
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/png':  'png',
  'image/gif':  'gif',
  'image/avif': 'avif',
};

/* ── helpers ─────────────────────────────────────────────── */

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = String(env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const allow = allowed.includes('*')
    ? '*'
    : (allowed.includes(origin) ? origin : (allowed[0] || ''));
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(body, init, request, env) {
  return new Response(JSON.stringify(body), {
    status: (init && init.status) || 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...corsHeaders(request, env),
    },
  });
}

const bad = (msg, request, env, status = 400) =>
  json({ ok: false, error: msg }, { status }, request, env);

/** Salted hash of the caller's IP. Identifies a voter without storing an IP. */
async function voterHash(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || '0.0.0.0';
  const salt = env.VOTE_SALT || 'fge-unsalted';
  const buf = new TextEncoder().encode(`${ip}|${salt}`);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].slice(0, 16)
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

/** League data, read with the read-only key and cached briefly. */
let leagueCache = { at: 0, data: null };
async function league(env) {
  const now = Date.now();
  if (leagueCache.data && now - leagueCache.at < LEAGUE_TTL_MS) return leagueCache.data;
  const res = await fetch(`https://api.jsonbin.io/v3/b/${env.BIN_ID}/latest`, {
    headers: { 'X-Access-Key': env.BIN_READ_KEY },
  });
  if (!res.ok) throw new Error('league fetch failed: ' + res.status);
  const body = await res.json();
  leagueCache = { at: now, data: body.record || {} };
  return leagueCache.data;
}

const normClass = c => (String(c || '').toLowerCase() === 'gt4' ? 'gt4' : 'gt3');

function findRace(data, cls, raceKey) {
  const races = (data && data[cls] && data[cls].races) || [];
  const key = String(raceKey);
  return races.find(r => String(r.round) === key) ||
         races.find(r => r.name === raceKey) || null;
}

const finishersOf = race =>
  ((race && race.results) || [])
    .map(r => (typeof r === 'string' ? r : r && r.driver))
    .filter(Boolean);

const driverNames = (data, cls) =>
  (((data && data[cls] && data[cls].drivers) || []).map(d => d.name).filter(Boolean));

const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

/* ── routes ──────────────────────────────────────────────── */

/** GET /api/dotd?class=gt3 — tallies for every race, plus this caller's own votes */
async function getDotd(request, env) {
  const cls = normClass(new URL(request.url).searchParams.get('class'));
  const me = await voterHash(request, env);

  const tally = await env.DB.prepare(
    `SELECT race, driver, COUNT(*) AS votes
       FROM dotd_votes WHERE class = ?
      GROUP BY race, driver`
  ).bind(cls).all();

  const mine = await env.DB.prepare(
    `SELECT race, driver FROM dotd_votes WHERE class = ? AND voter = ?`
  ).bind(cls, me).all();

  const races = {};
  for (const row of (tally.results || [])) {
    (races[row.race] ||= {})[row.driver] = row.votes;
  }
  const myVotes = {};
  for (const row of (mine.results || [])) myVotes[row.race] = row.driver;

  return json({ ok: true, races, myVotes }, null, request, env);
}

/** POST /api/dotd { class, race, driver } */
async function postDotd(request, env) {
  let body;
  try { body = await request.json(); } catch { return bad('invalid JSON body', request, env); }

  const cls    = normClass(body.class);
  const race   = clean(body.race, MAX_IDENT);
  const driver = clean(body.driver, MAX_NAME * 2);
  if (!race || !driver) return bad('race and driver are required', request, env);

  let data;
  try { data = await league(env); }
  catch { return bad('could not reach league data, try again', request, env, 503); }

  // A DOTD vote only makes sense for a race that has actually been run,
  // and only for someone who was in it.
  const r = findRace(data, cls, race);
  if (!r) return bad('unknown race', request, env, 404);
  const ran = finishersOf(r);
  if (!ran.length) return bad('that race has no results yet', request, env, 409);
  if (!ran.includes(driver)) return bad('that driver was not in this race', request, env, 422);

  const me = await voterHash(request, env);
  const res = await env.DB.prepare(
    `INSERT INTO dotd_votes (class, race, voter, driver, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (class, race, voter) DO NOTHING`
  ).bind(cls, String(r.round ?? race), me, driver, Date.now()).run();

  const counted = (res.meta && res.meta.changes) > 0;

  const tally = await env.DB.prepare(
    `SELECT driver, COUNT(*) AS votes FROM dotd_votes
      WHERE class = ? AND race = ? GROUP BY driver`
  ).bind(cls, String(r.round ?? race)).all();

  const existing = await env.DB.prepare(
    `SELECT driver FROM dotd_votes WHERE class = ? AND race = ? AND voter = ?`
  ).bind(cls, String(r.round ?? race), me).first();

  const votes = {};
  for (const row of (tally.results || [])) votes[row.driver] = row.votes;

  return json({
    ok: true,
    counted,                                    // false => already voted
    myVote: existing ? existing.driver : null,
    votes,
  }, null, request, env);
}

/** GET /api/fantasy?class=gt3 — every entry, for scoring the leaderboard */
async function getFantasy(request, env) {
  const cls = normClass(new URL(request.url).searchParams.get('class'));
  const rows = await env.DB.prepare(
    `SELECT race, user_id, user_name, winner, fastest, updated_at
       FROM fantasy_entries WHERE class = ?`
  ).bind(cls).all();
  return json({ ok: true, entries: rows.results || [] }, null, request, env);
}

/** POST /api/fantasy { class, race, userId, userName, winner, fastest } */
async function postFantasy(request, env) {
  let body;
  try { body = await request.json(); } catch { return bad('invalid JSON body', request, env); }

  const cls      = normClass(body.class);
  const race     = clean(body.race, MAX_IDENT);
  const userId   = clean(body.userId, MAX_IDENT);
  const userName = clean(body.userName, MAX_NAME);
  const winner   = clean(body.winner, MAX_NAME * 2);
  const fastest  = clean(body.fastest, MAX_NAME * 2);

  if (!race || !userId || !userName) {
    return bad('race, userId and userName are required', request, env);
  }

  let data;
  try { data = await league(env); }
  catch { return bad('could not reach league data, try again', request, env, 503); }

  const r = findRace(data, cls, race);
  if (!r) return bad('unknown race', request, env, 404);

  // Picks close the moment results exist — otherwise you could "predict"
  // a race that has already been scored.
  if (finishersOf(r).length) {
    return bad('picks are closed, that race already has results', request, env, 409);
  }

  const roster = driverNames(data, cls);
  if (winner  && !roster.includes(winner))  return bad('unknown driver for winner', request, env, 422);
  if (fastest && !roster.includes(fastest)) return bad('unknown driver for fastest lap', request, env, 422);

  const me = await voterHash(request, env);
  const key = String(r.round ?? race);

  // One person shouldn't be able to mint unlimited fantasy identities.
  const own = await env.DB.prepare(
    `SELECT COUNT(DISTINCT user_id) AS n FROM fantasy_entries
      WHERE class = ? AND race = ? AND voter = ? AND user_id <> ?`
  ).bind(cls, key, me, userId).first();
  if ((own && own.n) >= MAX_ENTRIES_PER_VOTER) {
    return bad('too many fantasy entries from here for this race', request, env, 429);
  }

  await env.DB.prepare(
    `INSERT INTO fantasy_entries
       (class, race, user_id, user_name, voter, winner, fastest, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (class, race, user_id) DO UPDATE SET
       user_name  = excluded.user_name,
       winner     = excluded.winner,
       fastest    = excluded.fastest,
       updated_at = excluded.updated_at`
  ).bind(cls, key, userId, userName, me, winner || null, fastest || null, Date.now()).run();

  return json({ ok: true, race: key, winner: winner || null, fastest: fastest || null },
    null, request, env);
}

/* ── image uploads (R2) ──────────────────────────────────── */

/**
 * POST /api/upload
 *   headers: Content-Type: image/*, X-Admin-Token: <token>
 *   body:    raw image bytes
 *   → { ok, url }
 *
 * Images live in R2 rather than in the JSONBin record, because a bin holds
 * only 1MB in total and that has to cover all the league data. The bin
 * stores just the returned URL.
 */
/** R2 if it's bound, otherwise KV. KV needs no card, so it's the default. */
const imageStore = env =>
  env.IMAGES ? 'r2' : (env.IMAGES_KV ? 'kv' : null);

async function postUpload(request, env) {
  const store = imageStore(env);
  if (!store) {
    return bad('image storage is not configured on this Worker', request, env, 501);
  }
  if (env.ADMIN_TOKEN) {
    const given = request.headers.get('X-Admin-Token') || '';
    if (given !== env.ADMIN_TOKEN) return bad('not authorised', request, env, 401);
  }

  const type = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  const ext = ALLOWED_IMAGE_TYPES[type];
  if (!ext) return bad('unsupported image type: ' + (type || 'none'), request, env, 415);

  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > MAX_UPLOAD_BYTES) {
    return bad(`image too large, max ${Math.round(MAX_UPLOAD_BYTES/1048576)}MB`, request, env, 413);
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length) return bad('empty body', request, env);
  if (bytes.length > MAX_UPLOAD_BYTES) {
    return bad(`image too large, max ${Math.round(MAX_UPLOAD_BYTES/1048576)}MB`, request, env, 413);
  }

  // Cheap per-IP rate limit so the bucket can't be flooded.
  const who = await voterHash(request, env);
  const since = Date.now() - 3_600_000;
  try {
    const recent = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM uploads WHERE voter = ? AND created_at > ?`
    ).bind(who, since).first();
    if ((recent && recent.n) >= UPLOADS_PER_HOUR) {
      return bad('upload limit reached, try again later', request, env, 429);
    }
  } catch { /* uploads table missing — don't block the upload on it */ }

  const key = `${new Date().toISOString().slice(0,10)}/${crypto.randomUUID()}.${ext}`;

  if (store === 'r2') {
    await env.IMAGES.put(key, bytes, {
      httpMetadata: {
        contentType: type,
        cacheControl: 'public, max-age=31536000, immutable',
      },
    });
  } else {
    // KV values can be an ArrayBuffer; the content type rides along as metadata.
    await env.IMAGES_KV.put(key, bytes, { metadata: { type } });
  }

  try {
    await env.DB.prepare(
      `INSERT INTO uploads (key, voter, bytes, created_at) VALUES (?, ?, ?, ?)`
    ).bind(key, who, bytes.length, Date.now()).run();
  } catch { /* logging only */ }

  const base = String(env.IMAGE_BASE_URL || '').replace(/\/+$/, '');
  const url = base ? `${base}/${key}` : new URL(`/img/${key}`, request.url).toString();
  return json({ ok: true, url, key, bytes: bytes.length }, null, request, env);
}

/**
 * GET /img/<key> — serves an uploaded image.
 *
 * Responses are cached in Cloudflare's edge cache as well as the browser,
 * so a popular page doesn't spend a KV read per image per visitor.
 */
async function getImage(request, env, pathname) {
  const store = imageStore(env);
  if (!store) return new Response('not configured', { status: 501 });

  const key = decodeURIComponent(pathname.replace(/^\/img\//, ''));
  if (!key) return new Response('not found', { status: 404 });

  const cache = caches.default;
  const hit = await cache.match(request);
  if (hit) return hit;

  let body, type;
  if (store === 'r2') {
    const obj = await env.IMAGES.get(key);
    if (!obj) return new Response('not found', { status: 404 });
    body = await obj.arrayBuffer();
    type = (obj.httpMetadata && obj.httpMetadata.contentType) || 'application/octet-stream';
  } else {
    const got = await env.IMAGES_KV.getWithMetadata(key, { type: 'arrayBuffer' });
    if (!got || !got.value) return new Response('not found', { status: 404 });
    body = got.value;
    type = (got.metadata && got.metadata.type) || 'application/octet-stream';
  }

  const res = new Response(body, {
    headers: {
      'Content-Type': type,
      // Keys are random and never reused, so these are safe to cache forever.
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Access-Control-Allow-Origin': '*',
    },
  });
  await cache.put(request, res.clone());
  return res;
}

/* ── entry ───────────────────────────────────────────────── */

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    try {
      if (pathname === '/api/dotd') {
        if (request.method === 'GET')  return await getDotd(request, env);
        if (request.method === 'POST') return await postDotd(request, env);
      }
      if (pathname === '/api/fantasy') {
        if (request.method === 'GET')  return await getFantasy(request, env);
        if (request.method === 'POST') return await postFantasy(request, env);
      }
      // Discord posts slash commands here. The body must be read as text
      // before parsing, because the signature covers the raw bytes.
      if (pathname === '/discord/interactions' && request.method === 'POST') {
        const raw = await request.text();
        const ok = await verifyRequest(request, raw, env.DISCORD_PUBLIC_KEY);
        if (!ok) return new Response('bad signature', { status: 401 });

        let interaction;
        try { interaction = JSON.parse(raw); }
        catch { return new Response('bad body', { status: 400 }); }

        // Discord pings the endpoint to validate it
        if (interaction.type === 1) {
          return new Response(JSON.stringify({ type: 1 }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        if (interaction.type === 2) {
          let record;
          try { record = await league(env); }
          catch {
            return new Response(JSON.stringify({
              type: 4,
              data: { content: "Couldn't reach the league data just now — try again in a moment." },
            }), { headers: { 'Content-Type': 'application/json' } });
          }
          return new Response(JSON.stringify(handleCommand(interaction, record)), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        return new Response(JSON.stringify({ type: 4, data: { content: 'Unsupported interaction.' } }),
          { headers: { 'Content-Type': 'application/json' } });
      }

      if (pathname === '/api/upload' && request.method === 'POST') {
        return await postUpload(request, env);
      }
      if (pathname.startsWith('/img/') && request.method === 'GET') {
        return await getImage(request, env, pathname);
      }
      if (pathname === '/api/health') {
        return json({
          ok: true,
          now: Date.now(),
          images: imageStore(env) || 'none',
          discord: Boolean(env.DISCORD_PUBLIC_KEY),
        }, null, request, env);
      }
      return bad('not found', request, env, 404);
    } catch (err) {
      return json({ ok: false, error: 'server error', detail: String(err && err.message || err) },
        { status: 500 }, request, env);
    }
  },
};
