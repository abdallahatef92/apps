import { getDb } from '../db';
import { FACT_TABLE } from '../ingest/importer';
import type { LineageQueryRef, LineageResult, LineageView } from '../../shared/types';

/**
 * Every real table/view name that a bit of SQL text touches, found by scanning
 * every `FROM`/`JOIN` token (not just the outer clause) and keeping the ones
 * that are real `sqlite_master` names. This is what lets a CTE that unions
 * several views (e.g. UNIFIED_COST_REGISTER) resolve correctly — a naive
 * "first FROM clause" parse would miss two of its three real sources.
 */
function tablesReferencedBy(sql: string, knownNames: Set<string>): Set<string> {
  const found = new Set<string>();
  for (const m of sql.matchAll(/\b(?:FROM|JOIN)\s+["']?(\w+)["']?/gi)) {
    if (knownNames.has(m[1])) found.add(m[1]);
  }
  return found;
}

export function buildLineage(reportDefinitionId: number): LineageResult {
  const db = getDb();

  const report = db.prepare(`
    SELECT rd.report_definition_id, rd.name, rd.module, rd.description,
           ss.name AS source_system
    FROM report_definition rd JOIN source_system ss ON ss.source_system_id = rd.source_system_id
    WHERE rd.report_definition_id = ?`).get(reportDefinitionId) as
    { report_definition_id: number; name: string; module: string; description: string | null; source_system: string } | undefined;
  if (!report) throw new Error(`Report definition ${reportDefinitionId} not found.`);

  const latestBatch = db.prepare(`
    SELECT import_batch_id, status, data_date, imported_at, row_count_posted
    FROM import_batch WHERE report_definition_id = ?
    ORDER BY imported_at DESC LIMIT 1`).get(reportDefinitionId) as
    { import_batch_id: number; status: string; data_date: string; imported_at: string; row_count_posted: number } | undefined
    ?? null;

  const factName = FACT_TABLE[report.module];
  const fact = factName
    ? { name: factName, isDimension: false }
    : report.module === 'MASTER' ? { name: 'dim_wbs', isDimension: true } : null;

  const allViews = db.prepare(
    `SELECT name, sql FROM sqlite_master WHERE type = 'view' AND sql IS NOT NULL`,
  ).all() as { name: string; sql: string }[];
  const allTablesAndViews = new Set<string>([
    ...allViews.map((v) => v.name),
    ...(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[])
      .map((t) => t.name),
  ]);

  const views: LineageView[] = [];
  if (fact) {
    const seen = new Set<string>([fact.name]);
    // Direct hop: views reading the fact/dimension table itself.
    let frontier = [fact.name];
    for (let hop = 0; hop < 2 && frontier.length; hop++) {
      const next: string[] = [];
      for (const v of allViews) {
        if (seen.has(v.name)) continue;
        const refs = tablesReferencedBy(v.sql, allTablesAndViews);
        const from = frontier.find((f) => refs.has(f));
        if (from) {
          views.push({ name: v.name, from });
          seen.add(v.name);
          next.push(v.name);
        }
      }
      frontier = next;
    }
  }

  const viewNames = new Set(views.map((v) => v.name));
  const querySourceNames = new Set<string>([...viewNames, ...(fact ? [fact.name] : [])]);

  const queries = db.prepare(
    `SELECT code, name, category, description, sql_text FROM query_library WHERE is_active = 1`,
  ).all() as { code: string; name: string; category: string | null; description: string | null; sql_text: string }[];

  const matchingQueries: LineageQueryRef[] = queries
    .map((q) => {
      const refs = tablesReferencedBy(q.sql_text, allTablesAndViews);
      const sources = [...refs].filter((r) => querySourceNames.has(r));
      return sources.length ? { code: q.code, name: q.name, category: q.category, description: q.description, sources } : null;
    })
    .filter((q): q is LineageQueryRef => q !== null);

  return { report, latestBatch, fact, views, queries: matchingQueries };
}
