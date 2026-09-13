/**
 * End-to-end exercise of the real ingest pipeline: read a workbook, auto-map its
 * columns, stage with validation, post to the star schema, then run the stored
 * SQL and check the numbers. Runs the actual main-process modules, with only the
 * `electron` module stubbed. See `npm run test:e2e`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase, getDb } from '../src/main/db';
import { readWorkbook } from '../src/main/ingest/workbook';
import { suggestMapping } from '../src/main/ingest/targetFields';
import { deleteBatch, postBatch, stageFile } from '../src/main/ingest/importer';
import { runStoredQuery } from '../src/main/services/queryRunner';
import { exportResult } from '../src/main/services/exportExcel';
import {
  makeActualsFile, makeBudgetFile, makeCji3File, makeSubcontractorFile, makeWbsTreeFile,
} from './makeFixtures';
import type { ColumnMappingEntry, Module } from '../src/shared/types';

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ok   ${label}${detail ? ` — ${detail}` : ''}`);
  else { failures++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
function near(label: string, actual: number, expected: number, tol = 0.01): void {
  check(label, Math.abs(actual - expected) <= tol, `got ${actual.toLocaleString()}, expected ${expected.toLocaleString()}`);
}

async function load(filePath: string, module: Module, reportId: number,
                   dataDate: string, period: string | null, projectKey: number | null) {
  const preview = await readWorkbook(filePath);
  const sheet = preview.sheets[0];
  const suggested = suggestMapping(module, sheet.columns);
  const mapping: ColumnMappingEntry[] = Object.entries(suggested)
    .map(([target_field, source_column]) => ({ target_field, source_column }));

  const staged = await stageFile({
    filePath, fileName: preview.fileName, fileHash: preview.fileHash, fileSize: preview.fileSize,
    sheetName: sheet.sheetName, headerRow: sheet.headerRow, module, reportDefinitionId: reportId,
    dataDate, periodKey: period, projectKey, scenarioKey: null, notes: null,
    mapping, saveMapping: true,
  }, 'e2e');

  return { preview, sheet, suggested, staged, posted: postBatch(staged.importBatchId) };
}

/**
 * Re-uploading the same extract must never add cost twice, however the project
 * was chosen. The wizard's project field is only a hint for files with no project
 * column, and it legitimately differs between uploads — the first import of a
 * fresh database has no project to pick yet — so scope has to come from the rows.
 */
async function duplicateGuards(dir: string): Promise<void> {
  console.log('\n--- duplicate protection ---');
  openDatabase(join(dir, 'dup.db'));
  const db = getDb();
  // The project code the fixture's rows carry, so both uploads resolve to it
  // whether the wizard names it or the importer reads it off the file.
  const projectKey = Number(db.prepare('INSERT INTO dim_project (project_code, project_name) VALUES (?,?)')
    .run('P-100', 'Test Plant').lastInsertRowid);

  const file = join(dir, 'dup-cji3.xlsx');
  await makeCji3File(file);

  const upload = async (project: number | null) => {
    const preview = await readWorkbook(file);
    const sheet = preview.sheets[0];
    const mapping: ColumnMappingEntry[] = Object.entries(suggestMapping('ACTUAL', sheet.columns))
      .map(([target_field, source_column]) => ({ target_field, source_column }));
    return stageFile({
      filePath: file, fileName: 'cji3.xlsx', fileHash: preview.fileHash, fileSize: preview.fileSize,
      sheetName: sheet.sheetName, headerRow: sheet.headerRow, module: 'ACTUAL',
      reportDefinitionId: 6, dataDate: '2026-09-13', periodKey: null, projectKey: project,
      scenarioKey: null, notes: null, mapping, saveMapping: true,
    }, 'dup-test');
  };

  // First upload: no project exists yet, so the wizard takes it from the file.
  const first = await upload(null);
  check('first upload sees no duplicate', first.duplicateOf === null);
  postBatch(first.importBatchId);
  near('cost after one upload',
    (db.prepare('SELECT COALESCE(SUM(amount),0) a FROM v_actual').get() as any).a, 1_700_000);

  // Second upload of the very same file, this time with the project selected.
  const second = await upload(projectKey);
  check('re-upload of identical content is detected at staging',
    second.duplicateOf?.importBatchId === first.importBatchId,
    String(second.duplicateOf?.importBatchId));

  let refused = false;
  try { postBatch(second.importBatchId); } catch { refused = true; }
  check('posting an identical file is refused', refused);
  near('cost unchanged after the refusal',
    (db.prepare('SELECT COALESCE(SUM(amount),0) a FROM v_actual').get() as any).a, 1_700_000);

  // Forcing it through must still supersede, despite the differing project hint.
  postBatch(second.importBatchId, { allowDuplicate: true });
  near('forcing a duplicate supersedes instead of doubling',
    (db.prepare('SELECT COALESCE(SUM(amount),0) a FROM v_actual').get() as any).a, 1_700_000);
  check('the earlier batch is superseded even though its project hint differed',
    (db.prepare('SELECT status FROM import_batch WHERE import_batch_id = ?')
      .get(first.importBatchId) as any).status === 'SUPERSEDED');

  // Deleting the live batch restores what it replaced, rather than emptying the warehouse.
  deleteBatch(second.importBatchId);
  check('the superseded batch is restored to POSTED',
    (db.prepare('SELECT status FROM import_batch WHERE import_batch_id = ?')
      .get(first.importBatchId) as any).status === 'POSTED');
  near('cost is back to a single copy after the delete',
    (db.prepare('SELECT COALESCE(SUM(amount),0) a FROM v_actual').get() as any).a, 1_700_000);

  // The inverse: scoping by the rows must not make one project's extract wipe out
  // another's just because they came from the same report.
  const otherKey = Number(db.prepare('INSERT INTO dim_project (project_code, project_name) VALUES (?,?)')
    .run('P-200', 'Second Plant').lastInsertRowid);
  const otherFile = join(dir, 'dup-cji3-p200.xlsx');
  await makeCji3File(otherFile);
  const other = await (async () => {
    const preview = await readWorkbook(otherFile);
    const sheet = preview.sheets[0];
    const mapping: ColumnMappingEntry[] = Object.entries(suggestMapping('ACTUAL', sheet.columns))
      .filter(([f]) => f !== 'project_code') // force it onto the second project
      .map(([target_field, source_column]) => ({ target_field, source_column }));
    return stageFile({
      filePath: otherFile, fileName: 'cji3-p200.xlsx', fileHash: 'different-content-hash',
      fileSize: preview.fileSize, sheetName: sheet.sheetName, headerRow: sheet.headerRow,
      module: 'ACTUAL', reportDefinitionId: 6, dataDate: '2026-09-13', periodKey: null,
      projectKey: otherKey, scenarioKey: null, notes: null, mapping, saveMapping: false,
    }, 'dup-test');
  })();
  postBatch(other.importBatchId);

  check('another project\'s extract does not supersede the first',
    (db.prepare('SELECT status FROM import_batch WHERE import_batch_id = ?')
      .get(first.importBatchId) as any).status === 'POSTED');
  near('both projects are counted',
    (db.prepare('SELECT COALESCE(SUM(amount),0) a FROM v_actual').get() as any).a, 3_400_000);
}

/**
 * The SAP-shaped scenario: a CJI3 extract with subtotal rows and income postings,
 * the subcontractor sub-ledger beneath its PO, and the project structure export.
 */
async function sapScenario(dir: string): Promise<void> {
  console.log('\n--- SAP-shaped extracts ---');
  openDatabase(join(dir, 'sap.db'));
  const db = getDb();
  const projectKey = Number(db.prepare('INSERT INTO dim_project (project_code, project_name) VALUES (?,?)')
    .run('P-100', 'Test Plant').lastInsertRowid);

  // Structure first, so postings land on a hierarchy that already exists.
  const treePath = join(dir, 'wbs_tree.xlsx');
  await makeWbsTreeFile(treePath);
  const tree = await load(treePath, 'MASTER', 8, '2026-03-31', null, projectKey);
  check('WBS code read from the "Title" column', tree.suggested.wbs_code === 'Title', tree.suggested.wbs_code);
  check('WBS name read from the "Description" column', tree.suggested.wbs_name === 'Description', tree.suggested.wbs_name);
  check('8 WBS elements built (repeated root collapsed)', tree.posted.posted === 8, String(tree.posted.posted));

  const foundations = db.prepare(`SELECT w.wbs_level, w.wbs_path, w.is_leaf, p.wbs_code AS parent
      FROM dim_wbs w LEFT JOIN dim_wbs p ON p.wbs_key = w.parent_wbs_key
      WHERE w.wbs_code = 'P-100.CIV.01'`).get() as any;
  check('hierarchy parented from the level column', foundations.parent === 'P-100.CIV', String(foundations.parent));
  check('materialised path built', foundations.wbs_path === '/P-100/P-100.CIV/P-100.CIV.01/', foundations.wbs_path);
  check('leaf flag set', foundations.is_leaf === 1);
  const branch = db.prepare("SELECT is_leaf FROM dim_wbs WHERE wbs_code = 'P-100.CIV'").get() as any;
  check('a node with children is not a leaf', branch.is_leaf === 0);
  check('planned dates carried across',
    (db.prepare("SELECT planned_finish f FROM dim_wbs WHERE wbs_code = 'P-100.CIV.01'").get() as any).f === '2026-03-31');

  // CJI3: subtotals must be skipped and income kept out of cost.
  const cjiPath = join(dir, 'cji3.xlsx');
  await makeCji3File(cjiPath);
  const cji = await load(cjiPath, 'ACTUAL', 6, '2026-03-31', '2026-03', projectKey);
  check('WBS Element preferred over the generic Object column',
    cji.suggested.wbs_code === 'WBS Element', cji.suggested.wbs_code);
  check('purchase order mapped', cji.suggested.po_no === 'Purchasing Document', String(cji.suggested.po_no));
  check('cost type not stolen by the "Object Type" column',
    cji.suggested.cost_type === undefined, String(cji.suggested.cost_type));
  check('4 subtotal rows skipped', cji.staged.skippedCount === 4, String(cji.staged.skippedCount));
  check('5 detail rows posted', cji.posted.posted === 5, String(cji.posted.posted));
  near('control total equals the file grand total, not the sum of every row',
    cji.staged.amountTotal, 500_000);

  const split = db.prepare(`SELECT
      (SELECT COALESCE(SUM(amount),0) FROM v_actual  WHERE project_key = ?) AS cost,
      (SELECT COALESCE(SUM(amount),0) FROM v_revenue WHERE project_key = ?) AS revenue,
      (SELECT COALESCE(SUM(amount),0) FROM v_posting WHERE project_key = ?) AS net`)
    .get(projectKey, projectKey, projectKey) as any;
  near('actual COST excludes income', split.cost, 1_700_000);
  near('revenue reported positive', split.revenue, 1_200_000);
  near('cost less revenue reproduces the file total', split.net, 500_000);

  const types = db.prepare(`SELECT cost_type, SUM(amount) amt FROM v_actual
    WHERE project_key = ? GROUP BY cost_type ORDER BY cost_type`).all(projectKey) as any[];
  check('cost types inferred from the account range',
    types.map((t) => t.cost_type).join(',') === 'MATERIAL,SUBCONTRACT',
    types.map((t) => t.cost_type).join(','));
  check('income cost element carries no cost type',
    (db.prepare("SELECT cost_type, posting_nature n FROM dim_cost_element WHERE cost_element_code='40101100'")
      .get() as any).n === 'REVENUE');

  // Subcontractor sub-ledger: reconciles to actuals, never added to them.
  const scPath = join(dir, 'subcontractor.xlsx');
  await makeSubcontractorFile(scPath);
  const sc = await load(scPath, 'SERVICE', 7, '2026-03-31', null, projectKey);
  check('supplier name read despite the misleading caption',
    sc.suggested.vendor_name === 'Account Number of Supplier', String(sc.suggested.vendor_name));
  check('2 certificate subtotal rows skipped', sc.staged.skippedCount === 2, String(sc.staged.skippedCount));
  check('2 service lines posted', sc.posted.posted === 2, String(sc.posted.posted));

  const afterSc = db.prepare('SELECT COALESCE(SUM(amount),0) a FROM v_actual WHERE project_key = ?')
    .get(projectKey) as any;
  near('loading the sub-ledger does not change actual cost', afterSc.a, 1_700_000);

  const recon = runStoredQuery('SC_PO_RECONCILIATION', { project_key: projectKey, tolerance: 1 });
  const po = (recon.rows as any[]).find((r) => r.po_no === '4500001');
  near('PO actual', Number(po.actual_amount), 1_500_000);
  near('PO service lines', Number(po.service_line_amount), 1_500_000);
  check('PO reconciles', po.status === 'RECONCILED', String(po.status));

  const rollup = runStoredQuery('WBS_ROLLUP', { project_key: projectKey, max_level: 2 });
  const civ = (rollup.rows as any[]).find((r) => r.wbs_code === 'P-100.CIV');
  near('actuals roll up the tree through the materialised path', Number(civ.actual_rollup), 1_500_000);

  const pl = runStoredQuery('COST_VS_REVENUE', { project_key: projectKey });
  near('margin equals revenue less cost',
    Number((pl.rows.at(-1) as any).margin_cum), 1_200_000 - 1_700_000);

  for (const code of ['SC_BY_SUPPLIER', 'SC_BY_CATEGORY', 'SC_LINE_DETAIL', 'SC_COVERAGE',
                      'REVENUE_BY_WBS', 'ACT_BY_DOC_TYPE']) {
    const r = runStoredQuery(code, { project_key: projectKey, po_no: null });
    check(`${code} runs`, r.rowCount >= 0, `${r.rowCount} rows`);
  }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ci-e2e-'));
  openDatabase(join(dir, 'e2e.db'));
  const db = getDb();

  const projectKey = Number(db.prepare('INSERT INTO dim_project (project_code, project_name) VALUES (?,?)')
    .run('P-100', 'Test Plant').lastInsertRowid);

  // ---- actuals ------------------------------------------------------------
  const actualsPath = join(dir, 'SAP_CJI3_2026_03.xlsx');
  await makeActualsFile(actualsPath, '2026-03-31');
  const a = await load(actualsPath, 'ACTUAL', 1, '2026-03-31', '2026-03', projectKey);

  check('header row detected below the title block', a.sheet.headerRow === 4, `row ${a.sheet.headerRow}`);
  check('data date read from the file', a.preview.detectedDataDate === '2026-03-31', String(a.preview.detectedDataDate));
  check('WBS column auto-mapped', a.suggested.wbs_code === 'WBS Element', a.suggested.wbs_code);
  check('amount column auto-mapped', a.suggested.amount === 'Val/COArea Crcy', a.suggested.amount);
  check('vendor column auto-mapped', a.suggested.vendor_name === 'Name of offsetting account', a.suggested.vendor_name);
  check('all 10 rows staged clean', a.staged.rowCount === 10 && a.staged.errorCount === 0,
    `${a.staged.rowCount} rows, ${a.staged.errorCount} errors`);
  check('10 rows posted', a.posted.posted === 10, String(a.posted.posted));

  // 1,240,500 + 820,000 + 96,750.50 + 2,105,000 + 740,200 - 16,450
  //   + 415,300 + 187,600 + 1,015,900 + 1,200,000
  const EXPECTED_ACTUAL = 7_804_800.5;
  near('control total (parenthesised credit read as negative)', a.staged.amountTotal, EXPECTED_ACTUAL);

  const total = db.prepare('SELECT SUM(amount) AS a FROM v_actual WHERE project_key = ?').get(projectKey) as any;
  near('actuals visible through v_actual', total.a, EXPECTED_ACTUAL);

  const dims = db.prepare(`SELECT
      (SELECT COUNT(*) FROM dim_wbs WHERE project_key = ?) AS wbs,
      (SELECT COUNT(*) FROM dim_cost_element) AS ce,
      (SELECT COUNT(*) FROM dim_vendor) AS vendor`).get(projectKey) as any;
  check('4 WBS elements created', dims.wbs === 4, String(dims.wbs));
  check('6 cost elements created', dims.ce === 6, String(dims.ce));
  check('6 vendors created', dims.vendor === 6, String(dims.vendor));

  const periods = db.prepare('SELECT DISTINCT period_key FROM v_actual ORDER BY 1').all() as any[];
  check('periods derived from posting dates', periods.map((p) => p.period_key).join(',') === '2026-01,2026-02,2026-03',
    periods.map((p) => p.period_key).join(','));

  // ---- budget -------------------------------------------------------------
  const budgetPath = join(dir, 'Budget_Rev3.xlsx');
  await makeBudgetFile(budgetPath);
  const b = await load(budgetPath, 'BUDGET', 3, '2026-01-01', null, projectKey);
  check('7 budget rows posted', b.posted.posted === 7, String(b.posted.posted));
  near('budget total', b.staged.amountTotal, 12_211_000);

  const scenario = db.prepare("SELECT * FROM dim_scenario WHERE scenario_type = 'BUDGET'").get() as any;
  check('budget version created and marked current', scenario?.is_current === 1 && scenario?.is_baseline === 1);

  // ---- stored SQL ---------------------------------------------------------
  const bva = runStoredQuery('BVA_BY_WBS', { project_key: projectKey });
  check('budget vs actual covers every WBS', bva.rowCount === 4, `${bva.rowCount} rows`);
  const civ01 = bva.rows.find((r) => r.wbs_code === 'P-100.CIV.01') as any;
  near('CIV.01 budget', civ01.budget_amount, 2_725_000);
  near('CIV.01 actual', civ01.actual_amount, 2_157_250.5);
  near('CIV.01 variance', civ01.variance_amount, 567_749.5);
  const civ02 = bva.rows.find((r) => r.wbs_code === 'P-100.CIV.02') as any;
  near('CIV.02 actual', civ02.actual_amount, 2_215_900);
  near('CIV.02 variance is negative', civ02.variance_amount, -415_900);
  check('CIV.02 flagged as over budget', civ02.status === 'OVER', String(civ02.status));

  const overruns = runStoredQuery('TOP_OVERRUNS', { project_key: projectKey, top_n: 20 });
  check('only the overrunning WBS is listed', overruns.rowCount === 1, `${overruns.rowCount} rows`);
  near('overrun amount', Number((overruns.rows[0] as any).overrun_amount), 415_900);

  const byType = runStoredQuery('ACT_BY_COST_TYPE', { project_key: projectKey, period_to: null });
  const shares = (byType.rows as any[]).reduce((s, r) => s + Number(r.pct_of_total), 0);
  near('cost-type shares sum to 100%', shares, 100, 0.2);

  const trend = runStoredQuery('ACT_MONTHLY_TREND', { project_key: projectKey });
  near('cumulative trend ends at the total', Number((trend.rows.at(-1) as any).cumulative_amount), EXPECTED_ACTUAL);

  const fresh = runStoredQuery('DATA_FRESHNESS', {});
  const actualRow = (fresh.rows as any[]).find((r) => r.report_code === 'SAP_ACTUAL_LINE');
  check('freshness reports the actuals data date', actualRow.latest_data_date === '2026-03-31', actualRow.latest_data_date);

  // ---- re-upload supersedes ----------------------------------------------
  const refreshPath = join(dir, 'SAP_CJI3_2026_03_rerun.xlsx');
  await makeActualsFile(refreshPath, '2026-04-15');
  const a2 = await load(refreshPath, 'ACTUAL', 1, '2026-04-15', '2026-03', projectKey);
  const afterTotal = db.prepare('SELECT SUM(amount) AS a FROM v_actual WHERE project_key = ?').get(projectKey) as any;
  near('re-upload replaces rather than doubles', afterTotal.a, EXPECTED_ACTUAL);

  const superseded = db.prepare("SELECT status FROM import_batch WHERE import_batch_id = ?")
    .get(a.staged.importBatchId) as any;
  check('previous batch marked SUPERSEDED', superseded.status === 'SUPERSEDED', superseded.status);
  check('superseded rows kept for audit',
    (db.prepare('SELECT COUNT(*) n FROM fact_actual').get() as any).n === 20);
  check('newer batch is the live one', a2.posted.posted === 10);

  // ---- export -------------------------------------------------------------
  const out = join(dir, 'bva.xlsx');
  await exportResult(out, bva, { title: 'Budget vs Actual by WBS', context: { Project: 'P-100' } });
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(out);
  check('export produced a Data sheet with a totals row',
    wb.getWorksheet('Data')!.rowCount === bva.rowCount + 2, `${wb.getWorksheet('Data')!.rowCount} rows`);
  check('export carries a lineage sheet', !!wb.getWorksheet('Report info'));

  await sapScenario(dir);
  await duplicateGuards(dir);

  rmSync(dir, { recursive: true, force: true });
  console.log(failures === 0 ? '\nAll pipeline checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
