import { getDb } from '../db';
import type { QueryResult } from '../../shared/types';

/** Hard cap so a careless query can never lock up the UI. */
const MAX_ROWS = 50_000;

/** Named parameters actually referenced by a statement, e.g. `:project_key`. */
export function extractParams(sql: string): string[] {
  const stripped = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''");
  const found = new Set<string>();
  for (const m of stripped.matchAll(/(?<![:\w]):([a-zA-Z_]\w*)/g)) found.add(m[1]);
  return [...found];
}

function coerce(value: unknown): string | number | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  const s = String(value).trim();
  if (s === '') return null;
  // A numeric-looking string is bound as a number so `= :project_key` matches an INTEGER key.
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

/**
 * Execute an arbitrary SELECT against the warehouse.
 *
 * Read-only is enforced by better-sqlite3's own `readonly` flag on the prepared
 * statement, so DDL/DML is rejected before it can run — the runner is safe to
 * expose to the query editor in the UI.
 */
export function runSelect(sql: string, params: Record<string, unknown> = {}): QueryResult {
  const started = Date.now();
  const trimmed = sql.trim().replace(/;\s*$/, '');
  if (!trimmed) throw new Error('Query is empty.');

  const stmt = getDb().prepare(trimmed);
  if (!stmt.readonly) {
    throw new Error('Only read-only statements (SELECT / WITH) can be run here.');
  }

  const binding: Record<string, string | number | null> = {};
  for (const name of extractParams(trimmed)) binding[name] = coerce(params[name]);

  stmt.raw(false);
  const rows = stmt.all(binding) as Record<string, unknown>[];
  const columns = stmt.columns().map((c) => c.name);

  return {
    columns: columns.length ? columns : rows[0] ? Object.keys(rows[0]) : [],
    rows: rows.slice(0, MAX_ROWS),
    rowCount: rows.length,
    truncated: rows.length > MAX_ROWS,
    ms: Date.now() - started,
  };
}

/** Run a stored query from the library by code, logging the run. */
export function runStoredQuery(code: string, params: Record<string, unknown> = {}): QueryResult {
  const db = getDb();
  const row = db.prepare('SELECT query_id, sql_text FROM query_library WHERE code = ? AND is_active = 1')
    .get(code) as { query_id: number; sql_text: string } | undefined;
  if (!row) throw new Error(`Query "${code}" not found.`);

  try {
    const result = runSelect(row.sql_text, params);
    db.prepare(`INSERT INTO query_run_log (query_id, params_json, row_count, ms)
                VALUES (?,?,?,?)`)
      .run(row.query_id, JSON.stringify(params), result.rowCount, result.ms);
    return result;
  } catch (err) {
    db.prepare(`INSERT INTO query_run_log (query_id, params_json, error) VALUES (?,?,?)`)
      .run(row.query_id, JSON.stringify(params), (err as Error).message);
    throw err;
  }
}
