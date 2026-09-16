import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { app } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import coreSql from './migrations/001_core.sql?raw';
import seedSql from './migrations/002_seed.sql?raw';
import sapRealitySql from './migrations/003_sap_reality.sql?raw';
import lineIdentitySql from './migrations/004_line_identity.sql?raw';
import vizSpecSql from './migrations/005_viz_spec.sql?raw';
import detailSubstitutionSql from './migrations/006_detail_substitution.sql?raw';
import costTypeRulesSql from './migrations/007_cost_type_rules.sql?raw';
import partnerObjectSql from './migrations/008_partner_object.sql?raw';
import orderSettlementSql from './migrations/009_order_settlement.sql?raw';
import costTypeRegistrySql from './migrations/010_cost_type_registry.sql?raw';
import { SYSTEM_QUERIES } from './systemQueries';

interface Migration {
  version: number;
  name: string;
  sql: string;
  /**
   * Set when the SQL manages its own transaction — needed for a table rebuild,
   * because `PRAGMA foreign_keys` is a no-op inside an open transaction.
   */
  selfTransacting?: boolean;
}

const MIGRATIONS: Migration[] = [
  { version: 1, name: '001_core', sql: coreSql },
  { version: 2, name: '002_seed', sql: seedSql },
  { version: 3, name: '003_sap_reality', sql: sapRealitySql, selfTransacting: true },
  { version: 4, name: '004_line_identity', sql: lineIdentitySql },
  { version: 5, name: '005_viz_spec', sql: vizSpecSql },
  { version: 6, name: '006_detail_substitution', sql: detailSubstitutionSql },
  { version: 7, name: '007_cost_type_rules', sql: costTypeRulesSql },
  { version: 8, name: '008_partner_object', sql: partnerObjectSql },
  { version: 9, name: '009_order_settlement', sql: orderSettlementSql },
  { version: 10, name: '010_cost_type_registry', sql: costTypeRegistrySql, selfTransacting: true },
];

let db: DB | null = null;

export function getDb(): DB {
  if (!db) throw new Error('Database not opened yet — call openDatabase() first.');
  return db;
}

export function currentDbPath(): string {
  return getDb().name;
}

export function defaultDbPath(): string {
  return join(app.getPath('userData'), 'data', 'cost-intelligence.db');
}

/** Open (creating if needed) a database file and bring it fully up to date. */
export function openDatabase(dbPath: string): DB {
  if (db) {
    db.close();
    db = null;
  }
  mkdirSync(dirname(dbPath), { recursive: true });
  const fresh = !existsSync(dbPath);

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  migrate(db);
  seedSystemQueries(db);
  ensureCalendar(db, 2018, 2040);

  if (fresh) console.log(`[db] created new database at ${dbPath}`);
  return db;
}

function migrate(conn: DB): void {
  conn.exec(`CREATE TABLE IF NOT EXISTS schema_migration (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  const applied = new Set<number>(
    conn.prepare('SELECT version FROM schema_migration').all().map((r: any) => r.version as number),
  );

  const record = conn.prepare('INSERT INTO schema_migration (version, name) VALUES (?, ?)');

  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    if (m.selfTransacting) {
      conn.exec(m.sql);
      record.run(m.version, m.name);
    } else {
      const run = conn.transaction(() => {
        conn.exec(m.sql);
        record.run(m.version, m.name);
      });
      run();
    }
    const violations = conn.pragma('foreign_key_check') as unknown[];
    if (violations.length > 0) {
      throw new Error(`Migration ${m.name} left ${violations.length} foreign key violation(s).`);
    }
    console.log(`[db] applied migration ${m.name}`);
  }
}

/**
 * System queries live in code and are re-applied on every start, so a query fix
 * ships with the app. Anything the user wrote (is_system = 0) is left alone.
 */
function seedSystemQueries(conn: DB): void {
  const upsert = conn.prepare(`
    INSERT INTO query_library
      (code, name, module, category, description, sql_text, params_json, viz_json, is_system)
    VALUES (@code, @name, @module, @category, @description, @sql_text, @params_json, @viz_json, 1)
    ON CONFLICT(code) DO UPDATE SET
      name = excluded.name, module = excluded.module, category = excluded.category,
      description = excluded.description, sql_text = excluded.sql_text,
      params_json = excluded.params_json, viz_json = excluded.viz_json,
      updated_at = datetime('now')
    WHERE query_library.is_system = 1`);

  const run = conn.transaction(() => {
    for (const q of SYSTEM_QUERIES) {
      upsert.run({
        code: q.code,
        name: q.name,
        module: q.module,
        category: q.category,
        description: q.description,
        sql_text: q.sql.trim(),
        params_json: JSON.stringify(q.params),
        viz_json: JSON.stringify(q.viz ?? {}),
      });
    }
  });
  run();
}

const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];

/** Populate dim_date / dim_period once; cheap and idempotent. */
function ensureCalendar(conn: DB, fromYear: number, toYear: number): void {
  const have = conn.prepare('SELECT COUNT(*) AS n FROM dim_period').get() as { n: number };
  if (have.n > 0) return;

  const insPeriod = conn.prepare(`INSERT INTO dim_period
    (period_key, year_no, month_no, quarter_no, label, start_date, end_date, period_index)
    VALUES (?,?,?,?,?,?,?,?)`);
  const insDate = conn.prepare(`INSERT INTO dim_date
    (date_key, full_date, day_of_month, month_no, month_name, month_abbr, quarter_no, year_no,
     period_key, month_end, is_month_end) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);

  const pad = (n: number) => String(n).padStart(2, '0');

  const run = conn.transaction(() => {
    for (let y = fromYear; y <= toYear; y++) {
      for (let m = 1; m <= 12; m++) {
        const periodKey = `${y}-${pad(m)}`;
        const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
        const start = `${y}-${pad(m)}-01`;
        const end = `${y}-${pad(m)}-${pad(lastDay)}`;
        const quarter = Math.ceil(m / 3);
        insPeriod.run(periodKey, y, m, quarter, `${MONTHS[m - 1].slice(0, 3)} ${y}`,
          start, end, (y - fromYear) * 12 + m);

        for (let d = 1; d <= lastDay; d++) {
          insDate.run(
            y * 10000 + m * 100 + d, `${y}-${pad(m)}-${pad(d)}`, d, m,
            MONTHS[m - 1], MONTHS[m - 1].slice(0, 3), quarter, y, periodKey, end,
            d === lastDay ? 1 : 0,
          );
        }
      }
    }
  });
  run();
  console.log('[db] calendar populated');
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}
