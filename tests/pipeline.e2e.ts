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

  // The real material identity (MATNR) — distinct from the GL account, and
  // must not be silently dropped by the upload mapping.
  check('Material column auto-mapped', cji.suggested.material_code === 'Material', String(cji.suggested.material_code));
  const material = db.prepare(`SELECT material_code, material_name, SUM(amount) amt, COUNT(*) n
      FROM v_actual WHERE project_key = ? AND material_code IS NOT NULL
      GROUP BY material_code, material_name`).get(projectKey) as any;
  check('material rows carry the real material number', material?.material_code === 'MAT-CEM-01', String(material?.material_code));
  check('material description carried across', material?.material_name === 'Portland Cement 42.5N', String(material?.material_name));
  check('material postings counted', material?.n === 2, String(material?.n));
  near('material rows amount', Number(material?.amt), 200_000);
  check('subcontract/labour/income rows carry no material code',
    (db.prepare(`SELECT COUNT(*) n FROM v_actual WHERE project_key = ? AND cost_type <> 'MATERIAL' AND material_code IS NOT NULL`)
      .get(projectKey) as any).n === 0);

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

/**
 * Cost type is a rule, not a constant.
 *
 * The account ranges that used to be written into importer.ts are seeded into
 * cost_type_rule, so a file is classified exactly as before. What changes is
 * where the decision happens: per posting row, inside v_posting. That is what
 * lets a rule match on document type — which lives on the fact, not on the cost
 * element — and lets a correction reach cost already loaded without re-importing.
 */
async function costTypeRules(dir: string): Promise<void> {
  console.log('\n--- cost type mapping ---');
  openDatabase(join(dir, 'costtype.db'));
  const db = getDb();
  const projectKey = Number(db.prepare('INSERT INTO dim_project (project_code, project_name) VALUES (?,?)')
    .run('P-100', 'Test Plant').lastInsertRowid);

  const cjiPath = join(dir, 'cji3_costtype.xlsx');
  await makeCji3File(cjiPath);
  await load(cjiPath, 'ACTUAL', 6, '2026-03-31', '2026-03', projectKey);

  const byType = (): Record<string, number> => Object.fromEntries(
    (db.prepare(`SELECT COALESCE(cost_type,'UNMAPPED') AS t, SUM(amount) AS a
                 FROM v_actual WHERE project_key = ? GROUP BY 1`).all(projectKey) as any[])
      .map((r) => [r.t, r.a]));

  const seeded = byType();
  near('305* reads as subcontract, as the hard-coded range did', seeded.SUBCONTRACT ?? 0, 1_500_000);
  near('302* reads as material, as the hard-coded range did', seeded.MATERIAL ?? 0, 200_000);
  check('no cost falls outside the rules', seeded.UNMAPPED === undefined, String(seeded.UNMAPPED));
  check('revenue still carries no cost type',
    (db.prepare(`SELECT COUNT(*) n FROM v_posting
                 WHERE posting_nature = 'REVENUE' AND cost_type IS NOT NULL`).get() as any).n === 0);

  // The point of the change: one account splits by how it was posted.
  db.prepare(`INSERT INTO cost_type_rule (priority, cost_element_glob, document_type_glob, cost_type, note)
              VALUES (1, '302*', 'WA', 'EQUIPMENT', 'Material on a WA document is plant hire here')`).run();

  const after = byType();
  near('a document-type rule moves that spend to equipment', after.EQUIPMENT ?? 0, 200_000);
  check('and leaves nothing behind under material', (after.MATERIAL ?? 0) === 0, String(after.MATERIAL ?? 0));
  near('spend on another account is untouched', after.SUBCONTRACT ?? 0, 1_500_000);
  near('and the cost total never moved',
    Object.values(after).reduce((sum, n) => sum + n, 0), 1_700_000);
  check('the correction reached posted cost without a re-import',
    (db.prepare('SELECT COUNT(*) n FROM import_batch').get() as any).n === 1);

  // Order decides, not specificity — the account rule is still there, just above now.
  db.prepare("UPDATE cost_type_rule SET priority = 999 WHERE document_type_glob = 'WA'").run();
  near('demoting it below the account rule hands the spend back', byType().MATERIAL ?? 0, 200_000);

  db.prepare('UPDATE cost_type_rule SET is_active = 0').run();
  near('with every rule off the money is still there, only unmapped', byType().UNMAPPED ?? 0, 1_700_000);
  db.prepare('UPDATE cost_type_rule SET is_active = 1').run();
  db.prepare("DELETE FROM cost_type_rule WHERE document_type_glob = 'WA'").run();

  // ---- allocating a named pair -------------------------------------------
  // The combinations are derived from the postings, so the list is exactly what
  // occurs: 305* arrives on SC, 302* on WA, and income on RV is not cost at all.
  const combos = db.prepare(`
    SELECT a.cost_element_code AS c, COALESCE(a.document_type,'') AS d,
           COUNT(*) AS n, SUM(a.amount) AS amt, a.cost_type AS resolved,
           (SELECT r.cost_type FROM cost_type_rule r
             WHERE r.is_active = 1 AND r.cost_element_glob = a.cost_element_code
               AND r.document_type_glob = COALESCE(a.document_type,'')
             ORDER BY r.priority, r.rule_id LIMIT 1) AS assigned
    FROM v_actual a
    GROUP BY a.cost_element_code, COALESCE(a.document_type,''), a.cost_type
    ORDER BY ABS(SUM(a.amount)) DESC`).all() as any[];

  check('combinations are derived from the postings, not from the chart',
    combos.length === 2, String(combos.length));
  check('a pair carries its document type', combos.some((r) => r.c === '30501100' && r.d === 'SC'));
  check('income is not offered as a cost combination',
    !combos.some((r) => r.c.startsWith('4')));
  check('nothing is allocated until the user says so',
    combos.every((r) => r.assigned === null));

  // Allocate one pair against the range it would otherwise inherit.
  db.prepare(`INSERT INTO cost_type_rule (priority, cost_element_glob, document_type_glob, cost_type, note)
              VALUES (1, '30501100', 'SC', 'LABOR', 'Allocated for document type SC')`).run();

  const allocated = byType();
  near('an allocation beats the account range it sits under', allocated.LABOR ?? 0, 1_500_000);
  check('and the range no longer claims that spend', (allocated.SUBCONTRACT ?? 0) === 0,
    String(allocated.SUBCONTRACT ?? 0));
  near('cost elements it does not name are untouched', allocated.MATERIAL ?? 0, 200_000);
  near('and the total is still the total',
    Object.values(allocated).reduce((sum, n) => sum + n, 0), 1_700_000);

  const reread = db.prepare(`SELECT (SELECT r.cost_type FROM cost_type_rule r
      WHERE r.is_active = 1 AND r.cost_element_glob = '30501100' AND r.document_type_glob = 'SC'
      LIMIT 1) AS assigned`).get() as any;
  check('the screen can tell an allocation from an inherited guess', reread.assigned === 'LABOR');

  // Clearing it hands the pair back to the patterns.
  db.prepare("DELETE FROM cost_type_rule WHERE cost_element_glob = '30501100' AND document_type_glob = 'SC'").run();
  near('clearing an allocation returns the pair to the patterns', byType().SUBCONTRACT ?? 0, 1_500_000);
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
  await costTypeRules(dir);
  await lineIdentity(dir);

  rmSync(dir, { recursive: true, force: true });
  console.log(failures === 0 ? '\nAll pipeline checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
