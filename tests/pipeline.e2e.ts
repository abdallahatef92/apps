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
import { postBatch, stageFile } from '../src/main/ingest/importer';
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
 * Overlapping extracts must merge on line identity, never accumulate.
 *
 * The reported workflow: a large CJI3 export is cut into months and loaded in
 * parts, then one part is re-run with a different posting period. Batch-level
 * replacement cannot express that — it either loses the months a part did not
 * cover or duplicates the ones it did — so identity lives on the line.
 */
async function lineIdentity(dir: string): Promise<void> {
  console.log('\n--- line identity and duplicate protection ---');
  openDatabase(join(dir, 'dup.db'));
  const db = getDb();
  const projectKey = Number(db.prepare('INSERT INTO dim_project (project_code, project_name) VALUES (?,?)')
    .run('P-100', 'Test Plant').lastInsertRowid);

  const cost = () => Number((db.prepare('SELECT COALESCE(SUM(amount),0) a FROM v_actual')
    .get() as any).a);

  const upload = async (file: string, name: string, period: string | null,
                        project: number | null, drop: string[] = []) => {
    const preview = await readWorkbook(file);
    const sheet = preview.sheets[0];
    const mapping: ColumnMappingEntry[] = Object.entries(suggestMapping('ACTUAL', sheet.columns))
      .filter(([f]) => !drop.includes(f))
      .map(([target_field, source_column]) => ({ target_field, source_column }));
    return stageFile({
      filePath: file, fileName: name, fileHash: preview.fileHash, fileSize: preview.fileSize,
      sheetName: sheet.sheetName, headerRow: sheet.headerRow, module: 'ACTUAL',
      reportDefinitionId: 6, dataDate: '2026-09-13', periodKey: period, projectKey: project,
      scenarioKey: null, notes: null, mapping, saveMapping: false,
    }, 'line-test');
  };

  // --- the split load -------------------------------------------------------
  const janFile = join(dir, 'cji3-jan.xlsx');
  const febMarFile = join(dir, 'cji3-feb-mar.xlsx');
  const fullFile = join(dir, 'cji3-full.xlsx');
  await makeCji3File(janFile, { onlyMonths: ['2026-01'] });
  await makeCji3File(febMarFile, { onlyMonths: ['2026-02', '2026-03'] });
  await makeCji3File(fullFile);

  const jan = await upload(janFile, 'cji3 jan.xlsx', null, projectKey);
  check('the SAP line key is recognised',
    jan.lineKey.used.join('+') === 'document_no+document_line+fiscal_year',
    jan.lineKey.used.join('+'));
  check('the key is usable', jan.lineKey.usable);
  postBatch(jan.importBatchId);
  near('January part', cost(), 1_000_000);

  const rest = await upload(febMarFile, 'cji3 feb-mar.xlsx', null, projectKey);
  const restPost = postBatch(rest.importBatchId);
  check('the second part adds rather than replaces', restPost.replaced === 0, String(restPost.replaced));
  near('both parts together', cost(), 1_700_000);
  check('the January batch is still live, not superseded',
    (db.prepare('SELECT status FROM import_batch WHERE import_batch_id = ?')
      .get(jan.importBatchId) as any).status === 'POSTED');

  // Two lines of document D2 must both survive: the posting row separates them.
  check('lines sharing a document number are kept apart',
    (db.prepare("SELECT COUNT(*) n FROM v_actual WHERE document_no = 'D2'").get() as any).n === 2);

  // --- the full export on top ----------------------------------------------
  const full = await upload(fullFile, 'cji3 - dist.xlsx', null, projectKey);
  check('the full export reports what it will replace',
    full.lineKey.willReplace === 6, String(full.lineKey.willReplace));
  const fullPost = postBatch(full.importBatchId);
  check('every row merged onto an existing line',
    fullPost.replaced === fullPost.posted && fullPost.byLineKey,
    `${fullPost.replaced} of ${fullPost.posted}`);
  near('loading the whole export over the parts changes nothing', cost(), 1_700_000);

  // --- the reported trigger: same file, different posting period ------------
  const again = await upload(fullFile, 'cji3 - dist.xlsx', '2026-08', projectKey);
  check('an identical file is still flagged', again.duplicateOf !== null);
  postBatch(again.importBatchId);
  near('re-running with a different posting period changes nothing', cost(), 1_700_000);
  check('duplicate rows were not created',
    (db.prepare('SELECT COUNT(*) n FROM fact_actual').get() as any).n === 6);

  // --- a source with no line identity still gets batch-level protection -----
  openDatabase(join(dir, 'nokey.db'));
  const p2 = Number(getDb().prepare('INSERT INTO dim_project (project_code, project_name) VALUES (?,?)')
    .run('P-100', 'Test Plant').lastInsertRowid);
  const keyless = () => Number((getDb().prepare('SELECT COALESCE(SUM(amount),0) a FROM v_actual')
    .get() as any).a);

  const first = await upload(fullFile, 'cji3.xlsx', null, p2, ['document_no', 'document_line', 'fiscal_year']);
  check('without identity columns the key is unusable', !first.lineKey.usable);
  check('and the user is told why',
    first.issues.some((i) => i.severity === 'WARN' && i.message.includes('No line identity')));
  postBatch(first.importBatchId);
  near('keyless load', keyless(), 1_700_000);

  const second = await upload(fullFile, 'cji3.xlsx', null, p2, ['document_no', 'document_line', 'fiscal_year']);
  let refused = false;
  try { postBatch(second.importBatchId); } catch { refused = true; }
  check('a keyless identical file is refused', refused);
  postBatch(second.importBatchId, { allowDuplicate: true });
  near('and forcing it supersedes rather than doubling', keyless(), 1_700_000);
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
  check('6 detail rows posted', cji.posted.posted === 6, String(cji.posted.posted));
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

  // ---- re-upload merges on line identity ----------------------------------
  const refreshPath = join(dir, 'SAP_CJI3_2026_03_rerun.xlsx');
  await makeActualsFile(refreshPath, '2026-04-15');
  const a2 = await load(refreshPath, 'ACTUAL', 1, '2026-04-15', '2026-03', projectKey);
  const afterTotal = db.prepare('SELECT SUM(amount) AS a FROM v_actual WHERE project_key = ?').get(projectKey) as any;
  near('re-upload replaces rather than doubles', afterTotal.a, EXPECTED_ACTUAL);

  check('every row merged onto its existing line', a2.posted.replaced === 10, String(a2.posted.replaced));
  check('one row per posting line, not two copies',
    (db.prepare('SELECT COUNT(*) n FROM fact_actual').get() as any).n === 10);
  check('the earlier batch stays live — lines were rewritten, not the batch replaced',
    (db.prepare('SELECT status FROM import_batch WHERE import_batch_id = ?')
      .get(a.staged.importBatchId) as any).status === 'POSTED');
  check('the rewritten lines are attributed to the newer batch',
    (db.prepare('SELECT COUNT(*) n FROM fact_actual WHERE import_batch_id = ?')
      .get(a2.staged.importBatchId) as any).n === 10);

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
  await lineIdentity(dir);

  rmSync(dir, { recursive: true, force: true });
  console.log(failures === 0 ? '\nAll pipeline checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
