/**
 * Load the three real SAP extracts into a database and reconcile them.
 *
 * Not part of `npm test` — it needs the source files, which are not in the repo.
 *   npm run load:real -- <out.db> <cji3.xlsx> <subcontractor.xlsx> <wbs_tree.xlsx>
 */
import { rmSync } from 'node:fs';
import { openDatabase, getDb } from '../src/main/db';
import { readWorkbook } from '../src/main/ingest/workbook';
import { suggestMapping } from '../src/main/ingest/targetFields';
import { postBatch, stageFile } from '../src/main/ingest/importer';
import { runStoredQuery } from '../src/main/services/queryRunner';
import type { ColumnMappingEntry, Module } from '../src/shared/types';

const [dbPath, cji3Path, scPath, wbsPath] = process.argv.slice(2);

async function load(filePath: string, module: Module, reportId: number, dataDate: string,
                    projectKey: number | null, overrides: Record<string, string> = {}) {
  const preview = await readWorkbook(filePath);
  const sheet = preview.sheets[0];
  const suggested = { ...suggestMapping(module, sheet.columns), ...overrides };
  for (const [k, v] of Object.entries(overrides)) if (v === '') delete (suggested as any)[k];

  const mapping: ColumnMappingEntry[] = Object.entries(suggested)
    .filter(([, col]) => !!col)
    .map(([target_field, source_column]) => ({ target_field, source_column }));

  const staged = await stageFile({
    filePath, fileName: preview.fileName, fileHash: preview.fileHash, fileSize: preview.fileSize,
    sheetName: sheet.sheetName, headerRow: sheet.headerRow, module, reportDefinitionId: reportId,
    dataDate, periodKey: null, projectKey, scenarioKey: null, notes: null,
    mapping, saveMapping: true,
  }, 'real-load');

  const posted = postBatch(staged.importBatchId);
  console.log(`\n${preview.fileName}`);
  console.log(`  header row ${sheet.headerRow} · ${staged.rowCount} rows read · ` +
    `${staged.validCount} valid · ${staged.skippedCount} subtotal rows skipped · ${staged.errorCount} rejected`);
  console.log(`  control total ${staged.amountTotal.toLocaleString(undefined,{maximumFractionDigits:2})} · posted ${posted.posted}`);
  if (staged.issues.length) console.log('  first issue:', staged.issues[0].message);
  return { preview, sheet, suggested, staged, posted };
}

const fmt = (n: unknown) => Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 });

async function main(): Promise<void> {
  for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
  openDatabase(dbPath);
  const db = getDb();

  const projectKey = Number(db.prepare(
    `INSERT INTO dim_project (project_code, project_name, client_name, currency_key) VALUES (?,?,?,?)`)
    .run('C-DIST', 'District 5', 'Alshorouk', 6).lastInsertRowid);

  // WBS structure first, so postings land on an already-shaped hierarchy.
  const wbs = await load(wbsPath, 'MASTER', 8, '2026-03-31', projectKey);
  console.log('  auto-mapped:', JSON.stringify(wbs.suggested));

  const cji = await load(cji3Path, 'ACTUAL', 6, '2026-03-31', projectKey);
  console.log('  auto-mapped:', JSON.stringify(cji.suggested));

  const sc = await load(scPath, 'SERVICE', 7, '2026-03-31', projectKey);
  console.log('  auto-mapped:', JSON.stringify(sc.suggested));

  console.log('\n================ RECONCILIATION ================');
  const t = db.prepare(`
    SELECT (SELECT COALESCE(SUM(amount),0)      FROM v_posting WHERE project_key = ?) AS net_file,
           (SELECT COALESCE(SUM(amount),0)      FROM v_actual  WHERE project_key = ?) AS cost,
           (SELECT COALESCE(SUM(amount),0)      FROM v_revenue WHERE project_key = ?) AS revenue,
           (SELECT COALESCE(SUM(amount_net),0)  FROM v_service_line WHERE project_key = ?) AS service_net,
           (SELECT COUNT(*) FROM dim_wbs WHERE project_key = ?) AS wbs_rows,
           (SELECT COUNT(*) FROM dim_wbs WHERE project_key = ? AND parent_wbs_key IS NOT NULL) AS wbs_parented,
           (SELECT MAX(wbs_level) FROM dim_wbs WHERE project_key = ?) AS wbs_depth`)
    .get(projectKey, projectKey, projectKey, projectKey, projectKey, projectKey, projectKey) as any;

  console.log(`  CJI3 file net total (cost - revenue) : ${fmt(t.net_file)}`);
  console.log(`  Actual COST                          : ${fmt(t.cost)}`);
  console.log(`  Revenue billed                       : ${fmt(t.revenue)}`);
  console.log(`  Service lines (net)                  : ${fmt(t.service_net)}`);
  console.log(`  WBS elements ${t.wbs_rows} (${t.wbs_parented} parented, depth ${t.wbs_depth})`);

  const po = runStoredQuery('SC_PO_RECONCILIATION', { project_key: projectKey, tolerance: 1 });
  const byStatus: Record<string, number> = {};
  for (const r of po.rows as any[]) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  console.log('\n  PO reconciliation:', JSON.stringify(byStatus));
  console.log('  worst differences:');
  for (const r of (po.rows as any[]).slice(0, 3)) {
    console.log(`    ${r.po_no}  actual ${fmt(r.actual_amount)}  service ${fmt(r.service_line_amount)}  diff ${fmt(r.difference)}  ${r.status}`);
  }

  for (const code of ['ACT_BY_COST_TYPE', 'COST_VS_REVENUE', 'SC_BY_SUPPLIER', 'SC_BY_CATEGORY',
                      'WBS_ROLLUP', 'ACT_BY_DOC_TYPE', 'ACT_BY_WBS', 'SC_COVERAGE']) {
    const r = runStoredQuery(code, { project_key: projectKey, max_level: 3, tolerance: 1 });
    console.log(`  ${code.padEnd(22)} ${String(r.rowCount).padStart(4)} rows in ${r.ms} ms`);
  }

  console.log('\n  Cost by type:');
  for (const r of runStoredQuery('ACT_BY_COST_TYPE', { project_key: projectKey }).rows as any[]) {
    console.log(`    ${String(r.cost_type).padEnd(12)} ${fmt(r.actual_amount).padStart(16)}  ${r.pct_of_total}%`);
  }
  console.log('\n  Top subcontractors:');
  for (const r of (runStoredQuery('SC_BY_SUPPLIER', { project_key: projectKey }).rows as any[]).slice(0, 5)) {
    console.log(`    ${String(r.supplier).slice(0, 34).padEnd(36)} ${fmt(r.work_done_net).padStart(16)}`);
  }
  console.log(`\nDatabase written to ${dbPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
