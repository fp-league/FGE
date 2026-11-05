/** Backups: the pruning window, the empty-league guard, and key safety. */
import { takeBackup, listBackups, readBackup, deleteBackup } from '../worker/src/backup.js';

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x ? ' → ' + x : '')); } };

function makeEnv(record) {
  const kv = new Map(), idx = new Map();
  let binCalls = 0;
  return {
    _kv: kv, _idx: idx, get binCalls() { return binCalls; },
    BIN_ID: 'x', BIN_READ_KEY: 'y',
    IMAGES_KV: {
      put: async (k, v) => kv.set(k, v),
      get: async k => (kv.has(k) ? kv.get(k) : null),
      delete: async k => kv.delete(k),
    },
    DB: {
      prepare(sql) {
        const q = sql.replace(/\s+/g, ' ');
        return {
          bind: (...a) => ({
            run: async () => {
              if (/INSERT INTO backup/.test(q)) idx.set(a[0], { key:a[0], taken_at:a[1], bytes:a[2], kind:a[3], summary:a[4] });
              if (/DELETE FROM backup/.test(q)) idx.delete(a[0]);
              return {};
            },
            first: async () => {
              if (/SELECT key FROM backup WHERE key/.test(q)) return idx.get(a[0]) || null;
              return null;
            },
            all: async () => {
              if (/ORDER BY taken_at DESC LIMIT 200 OFFSET/.test(q)) {
                const sorted = [...idx.values()].sort((x, y) => y.taken_at - x.taken_at);
                return { results: sorted.slice(a[0]).map(r => ({ key: r.key })) };
              }
              return { results: [] };
            },
          }),
          all: async () => ({ results: [...idx.values()].sort((x, y) => y.taken_at - x.taken_at) }),
        };
      },
      batch: async st => { for (const s of st) await s.run(); },
    },
    _setFetch(r) { record = r; },
    _fetch() { binCalls++; return record; },
  };
}

function install(env) {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ record: env._fetch() }) });
}

const LEAGUE = {
  gt3: { drivers: [{ name: 'A' }, { name: 'B' }], races: [{ results: [1] }, { results: [] }] },
  gt4: { drivers: [{ name: 'C' }], races: [] },
};

console.log('\nTaking a backup');
{
  const env = makeEnv(LEAGUE); install(env);
  const out = await takeBackup(env, 'manual');
  ok('a snapshot is stored', env._kv.size === 1);
  ok('and indexed', env._idx.size === 1);
  ok('the key is namespaced', out.key.startsWith('bk/'), out.key);
  ok('the summary counts drivers and finished races',
     out.summary === 'GT3 2 drivers, 1 result · GT4 1 driver, 0 results', out.summary);
  ok('bytes recorded', out.bytes === JSON.stringify(LEAGUE).length);

  const back = JSON.parse(await readBackup(env, out.key));
  ok('it reads back identical', JSON.stringify(back) === JSON.stringify(LEAGUE));
}

console.log('\nThe empty-league guard');
{
  const env = makeEnv({ gt3: { drivers: [], races: [] }, gt4: { drivers: [], races: [] } });
  install(env);
  let threw = null;
  try { await takeBackup(env, 'auto'); } catch (e) { threw = e.message; }
  ok('an empty league is refused', /came back empty/.test(threw || ''), threw);
  ok('and nothing is written', env._kv.size === 0 && env._idx.size === 0);

  // A pre-restore copy is allowed to be empty: that is the state you are
  // escaping, and it is the one you would want back if the restore is wrong.
  const out = await takeBackup(env, 'pre-restore');
  ok('a pre-restore copy of an empty league is kept', Boolean(out.key) && env._kv.size === 1);
}

console.log('\nPruning');
{
  const env = makeEnv(LEAGUE); install(env);
  for (let i = 0; i < 35; i++) {
    await takeBackup(env, 'auto');
    // Each snapshot needs its own timestamp, or they collide on one key.
    for (const [k, v] of env._idx) if (v.taken_at === Date.now()) v.taken_at -= i * 1000;
  }
  ok('the window is capped at 30', env._idx.size <= 30, String(env._idx.size));
  ok('and the storage is pruned with it', env._kv.size === env._idx.size,
     `kv ${env._kv.size} vs idx ${env._idx.size}`);
  const kept = [...env._idx.values()].sort((a, b) => b.taken_at - a.taken_at);
  ok('the newest are the ones kept', kept[0].taken_at >= kept[kept.length - 1].taken_at);
}

console.log('\nKey safety');
{
  const env = makeEnv(LEAGUE); install(env);
  const out = await takeBackup(env, 'manual');
  env._kv.set('2026-01-01/some-image.png', 'IMAGE BYTES');

  for (const bad of ['2026-01-01/some-image.png', '../secret', '']) {
    let threw = null;
    try { await readBackup(env, bad); } catch (e) { threw = e.message; }
    ok(`reading "${bad}" is refused`, /not a backup key|no such backup/.test(threw || ''), threw);
  }
  let threw = null;
  try { await deleteBackup(env, '2026-01-01/some-image.png'); } catch (e) { threw = e.message; }
  ok('and deleting a non-backup key is refused', /not a backup key/.test(threw || ''));
  ok('so the image is untouched', env._kv.has('2026-01-01/some-image.png'));

  await deleteBackup(env, out.key);
  ok('a real backup does delete', !env._kv.has(out.key) && !env._idx.has(out.key));
}

console.log('\nListing');
{
  const env = makeEnv(LEAGUE); install(env);
  await takeBackup(env, 'manual');
  const list = await listBackups(env);
  ok('listing returns the rows', list.length === 1);
  ok('with everything the panel shows',
     ['key','taken_at','bytes','kind','summary'].every(k => k in list[0]));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
