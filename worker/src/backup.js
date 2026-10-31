/**
 * Daily backups.
 *
 * The league lives in one JSONBin record that the admin panel overwrites on
 * every save. There is no history and no undo, so one bad click — a deleted
 * driver, a wiped race, a paste into the wrong field — takes a season with
 * it and there is nothing to go back to.
 *
 * A cron takes a copy every night. The Worker only has the read key, which
 * is all a backup needs; restoring is done from the admin panel, which
 * already holds the write key. That keeps the Worker unable to overwrite the
 * league even if something went badly wrong here, which is the right way
 * round for a thing whose whole job is to be the safety net.
 */

const KEEP = 30;                       // a month of nights
const PREFIX = 'bk/';

/** Fresh from the bin, never the Worker's cache — a cached backup is a lie. */
async function fetchLeague(env) {
  const res = await fetch(`https://api.jsonbin.io/v3/b/${env.BIN_ID}/latest`, {
    headers: { 'X-Access-Key': env.BIN_READ_KEY },
  });
  if (!res.ok) throw new Error(`bin fetch failed: ${res.status}`);
  const body = await res.json();
  if (!body || !body.record) throw new Error('bin returned no record');
  return body.record;
}

/** "GT3 34 drivers, 8 races · GT4 22 drivers, 6 races" */
function summarise(record) {
  return ['gt3', 'gt4']
    .map(k => {
      const cd = record[k];
      if (!cd) return null;
      const d = (cd.drivers || []).length;
      const r = (cd.races || []).filter(x => (x.results || []).length).length;
      return `${k.toUpperCase()} ${d} driver${d !== 1 ? 's' : ''}, ${r} result${r !== 1 ? 's' : ''}`;
    })
    .filter(Boolean).join(' · ') || 'empty';
}

/**
 * Refuse to save a snapshot that is obviously a wipe.
 *
 * A backup of an empty league would be worse than no backup — it fills the
 * window with nothing and pushes the last good copy off the end. If the bin
 * comes back empty, that is a reason to keep what we already have.
 */
function looksReal(record) {
  return ['gt3', 'gt4'].some(k => ((record[k] || {}).drivers || []).length > 0);
}

export async function takeBackup(env, kind) {
  if (!env.IMAGES_KV) throw new Error('no KV namespace bound to store backups in');

  const record = await fetchLeague(env);
  if (!looksReal(record) && kind !== 'pre-restore') {
    throw new Error('the league came back empty — not overwriting the backup window with it');
  }

  const json = JSON.stringify(record);
  const now = Date.now();
  const key = PREFIX + new Date(now).toISOString().replace(/[:.]/g, '-');

  await env.IMAGES_KV.put(key, json);
  await env.DB.prepare(
    `INSERT INTO backup (key, taken_at, bytes, kind, summary) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET
       taken_at = excluded.taken_at, bytes = excluded.bytes,
       kind = excluded.kind, summary = excluded.summary`
  ).bind(key, now, json.length, String(kind || 'auto'), summarise(record)).run();

  const pruned = await prune(env);
  return { key, bytes: json.length, takenAt: now, summary: summarise(record), pruned };
}

/** Keep the most recent KEEP, drop the rest from both KV and the index. */
async function prune(env) {
  const rows = await env.DB.prepare(
    `SELECT key FROM backup ORDER BY taken_at DESC LIMIT 200 OFFSET ?`).bind(KEEP).all();
  const old = (rows.results || []).map(r => r.key);
  if (!old.length) return 0;

  for (const key of old) {
    try { await env.IMAGES_KV.delete(key); } catch { /* index row goes anyway */ }
  }
  await env.DB.batch(old.map(k => env.DB.prepare(`DELETE FROM backup WHERE key = ?`).bind(k)));
  return old.length;
}

export async function listBackups(env) {
  const rows = await env.DB.prepare(
    `SELECT key, taken_at, bytes, kind, summary FROM backup
      ORDER BY taken_at DESC LIMIT 60`).all();
  return rows.results || [];
}

export async function readBackup(env, key) {
  const k = String(key || '');
  // Only ever read our own keys — the same KV namespace holds the images.
  if (!k.startsWith(PREFIX)) throw new Error('not a backup key');
  const row = await env.DB.prepare(`SELECT key FROM backup WHERE key = ?`).bind(k).first();
  if (!row) throw new Error('no such backup');
  const json = await env.IMAGES_KV.get(k);
  if (json == null) throw new Error('the snapshot is missing from storage');
  return json;
}

export async function deleteBackup(env, key) {
  const k = String(key || '');
  if (!k.startsWith(PREFIX)) throw new Error('not a backup key');
  try { await env.IMAGES_KV.delete(k); } catch { /* index row goes anyway */ }
  await env.DB.prepare(`DELETE FROM backup WHERE key = ?`).bind(k).run();
}
