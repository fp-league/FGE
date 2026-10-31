/**
 * Finished seasons.
 *
 * The league record only ever holds the season being raced, so without this
 * Season 3 buries Seasons 1 and 2. Archiving keeps the champions, the
 * results and the records reachable.
 *
 * The full record goes to KV and only its summary comes back in a listing.
 * The records page needs totals from every season ever run; making it
 * download every race to work them out would be a slow page that gets
 * slower every year.
 */

const PREFIX = 'arch/';

const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '').slice(0, 48) || `s${Date.now().toString(36)}`;

export async function listArchive(env, cls) {
  try {
    const rows = cls
      ? await env.DB.prepare(
          `SELECT id, class, name, ended_at, rounds, bytes, summary
             FROM season_archive WHERE class = ? ORDER BY ended_at DESC`).bind(cls).all()
      : await env.DB.prepare(
          `SELECT id, class, name, ended_at, rounds, bytes, summary
             FROM season_archive ORDER BY ended_at DESC`).all();
    return (rows.results || []).map(r => ({
      ...r,
      summary: (() => { try { return JSON.parse(r.summary); } catch { return {}; } })(),
    }));
  } catch { return []; }
}

export async function readArchive(env, id) {
  const key = String(id || '');
  const row = await env.DB.prepare(
    `SELECT key FROM season_archive WHERE id = ?`).bind(key).first();
  if (!row) throw new Error('no such season');
  const json = await env.IMAGES_KV.get(row.key);
  if (json == null) throw new Error('the archived season is missing from storage');
  return json;
}

/**
 * Archive one class's season.
 *
 * Re-archiving the same name overwrites rather than duplicating, so a
 * mistake is fixed by doing it again instead of leaving two Season 2s.
 */
export async function saveArchive(env, { cls, name, record, summary }) {
  if (!env.IMAGES_KV) throw new Error('no KV namespace bound to store seasons in');
  const klass = cls === 'gt4' ? 'gt4' : 'gt3';
  const label = String(name || '').trim() || 'Season';
  const id = `${klass}-${slug(label)}`;
  const key = PREFIX + id;

  if (!record || !Array.isArray(record.races) || !record.races.some(r => (r.results || []).length)) {
    throw new Error('that season has no results in it — nothing worth archiving');
  }

  const json = JSON.stringify(record);
  const now = Date.now();
  await env.IMAGES_KV.put(key, json);
  await env.DB.prepare(
    `INSERT INTO season_archive (id, class, name, ended_at, rounds, bytes, summary, key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       name = excluded.name, ended_at = excluded.ended_at, rounds = excluded.rounds,
       bytes = excluded.bytes, summary = excluded.summary, key = excluded.key`
  ).bind(id, klass, label, now,
         Number((summary && summary.rounds) || 0), json.length,
         JSON.stringify(summary || {}), key).run();

  return { id, key, bytes: json.length, name: label, class: klass };
}

export async function deleteArchive(env, id) {
  const row = await env.DB.prepare(
    `SELECT key FROM season_archive WHERE id = ?`).bind(String(id)).first();
  if (!row) return;
  try { await env.IMAGES_KV.delete(row.key); } catch { /* index row goes anyway */ }
  await env.DB.prepare(`DELETE FROM season_archive WHERE id = ?`).bind(String(id)).run();
}
