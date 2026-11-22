/**
 * A D1 stand-in backed by real SQLite.
 *
 * The other suites here fake D1 with a Map and a list of regexes matched
 * against the SQL. That works until the thing under test depends on what
 * SQL actually does — and this one does, all the way through. Every guard
 * in a ranked match is an UPDATE with a WHERE clause that only matches
 * once, and `changes` being 0 is the entire mechanism. A regex fake would
 * have to be taught each guard individually, which means the test would
 * be checking a second implementation of the rule rather than the rule.
 *
 * It has also bitten this repo before: a fake matched `FROM custom_card`
 * ahead of `DELETE FROM custom_card`, so every delete silently did
 * nothing and every test passed.
 *
 * So: node:sqlite, with the project's own migrations applied. The schema
 * under test is then the schema that ships.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', 'worker', 'migrations');

/** Statements a D1 schema may carry that plain SQLite will not take. */
const skippable = sql => /^\s*$/.test(sql);

export function makeD1({ migrations = true } = {}) {
  const db = new DatabaseSync(':memory:');

  if (migrations) {
    for (const f of readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) {
      const sql = readFileSync(join(MIGRATIONS, f), 'utf8');
      if (skippable(sql)) continue;
      try { db.exec(sql); }
      catch (e) { throw new Error(`migration ${f} failed: ${e.message}`); }
    }
  }

  const prepare = sql => {
    // D1 allows a bind() that supplies no arguments; node:sqlite does not
    // mind either, so the only translation needed is the result shape.
    let args = [];
    const api = {
      bind(...a) { args = a.map(v => v === undefined ? null : v); return api; },
      async run() {
        const r = db.prepare(sql).run(...args);
        return { success: true,
                 meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
      },
      async first(col) {
        const row = db.prepare(sql).get(...args);
        if (row === undefined) return null;
        return col === undefined ? row : row[col];
      },
      async all() {
        return { success: true, results: db.prepare(sql).all(...args) };
      },
    };
    return api;
  };

  return {
    prepare,
    async batch(list) { return Promise.all(list.map(s => s.run())); },
    async exec(sql) { db.exec(sql); return { count: 1 }; },
    _raw: db,
    _close: () => db.close(),
  };
}

/** A whole env, with a wallet helper since nearly everything touches one. */
export function makeEnv(opts) {
  const DB = makeD1(opts);
  return {
    DB,
    _give(userId, amount) {
      DB._raw.prepare(
        `INSERT INTO wallet (user_id, balance, lifetime, updated_at)
              VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET balance = excluded.balance`
      ).run(String(userId), amount, amount, Date.now());
    },
    _balance(userId) {
      const r = DB._raw.prepare('SELECT balance FROM wallet WHERE user_id = ?')
        .get(String(userId));
      return r ? r.balance : 0;
    },
    _row(table, id) {
      return DB._raw.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(String(id));
    },
  };
}
