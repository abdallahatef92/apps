/**
 * End-to-end exercise of the real ingest pipeline: read a workbook, auto-map its
 * columns, stage with validation, post to the star schema, then run the stored
 * SQL and check the numbers. Runs the actual main-process modules, with only the
 * `electron` module stubbed. See `npm run test:e2e`.
 */
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase, getDb } from '../src/main/db';
import { readWorkbook } from '../src/main/ingest/workbook';
import { suggestMapping } from '../src/main/ingest/targetFields';
import { postBatch, stageFile } from '../src/main/ingest/importer';
import { runStoredQuery } from '../src/main/services/queryRunner';
import { clearProjectData, deleteProject, projectFootprint } from '../src/main/services/projectAdmin';
import { buildRegisterWorkbook } from '../src/main/services/registerReport';
import { scNorm } from '../src/main/db/systemQueries';
import { exportResult } from '../src/main/services/exportExcel';
import { buildSubcontractReport, buildSubcontractWorkbook } from '../src/main/services/subcontractReport';
import { buildMaterialReport, buildMaterialWorkbook } from '../src/main/services/materialReport';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { writeFileSync } from 'node:fs';
import {
  CERT_TOTALS, MB51_TOTALS, makeActualsFile, makeBudgetFile, makeCertificateFile, makeCji3File,
  makeMaterialListFile, makeMb51File, makeMe2nFile, makePoServiceFile, makeScRulesFile, makeScRulesPoFile, makeSubcontractorFile, makeWbsTreeFile,
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
 * The project cut-off (docs/flow-redesign.md): v_posting holds back every line
 * posted after the cut-off, v_posting_all still sees them, and the status
 * queries report exactly what is held back.
 *
 * Cost lines in the CJI3 fixture: D1 1,000,000 (18 Jan), D2 300,000 + 200,000
 * (11 Feb), D3 250,000 (20 Feb, material), D4 -50,000 (5 Mar, material return);
 * income R1 1,200,000 (31 Mar).
 */
async function cutoffScenario(dir: string): Promise<void> {
  console.log('\n--- project cut-off ---');
  openDatabase(join(dir, 'cutoff.db'));
  const db = getDb();
  const projectKey = Number(db.prepare('INSERT INTO dim_project (project_code, project_name) VALUES (?,?)')
    .run('P-100', 'Test Plant').lastInsertRowid);
  const file = join(dir, 'cji3-cutoff.xlsx');
  await makeCji3File(file);
  await load(file, 'ACTUAL', 6, '2026-04-01', null, projectKey);
  // Code the cement so the coding figures have something on both sides.
  db.prepare("INSERT INTO material_work_package (project_key, material_code, work_package) VALUES (?, 'MAT-CEM-01', 'DIV03')")
    .run(projectKey);

  const sum = (view: string) => Number((db.prepare(`SELECT COALESCE(SUM(amount),0) a FROM ${view} WHERE project_key = ?`)
    .get(projectKey) as any).a);
  const setCutoff = (d: string | null) => {
    if (d === null) db.prepare('DELETE FROM project_cutoff WHERE project_key = ?').run(projectKey);
    else db.prepare(`INSERT INTO project_cutoff (project_key, cutoff_date) VALUES (?, ?)
                     ON CONFLICT(project_key) DO UPDATE SET cutoff_date = excluded.cutoff_date`).run(projectKey, d);
  };
  const status = () => runStoredQuery('CUTOFF_STATUS', { project_key: projectKey }).rows[0] as any;
  const flow = () => runStoredQuery('FLOW_STATUS', { project_key: projectKey }).rows[0] as any;

  // No cut-off: everything counts.
  near('no cut-off: actual cost is the whole extract', sum('v_actual'), 1_700_000);
  near('no cut-off: revenue is the whole extract', sum('v_revenue'), 1_200_000);
  let s = status();
  check('no cut-off: nothing held back', s.cutoff_date === null && s.lines_after_cutoff === 0
    && s.amount_after_cutoff === 0, JSON.stringify(s));
  check('latest posting date read from the uncut lines', s.latest_posting_date === '2026-03-05', s.latest_posting_date);
  let f = flow();
  near('FLOW_STATUS actual_to_cutoff without a cut-off', f.actual_to_cutoff, 1_700_000);
  near('FLOW_STATUS cut-off month falls back to the latest period (Mar)', f.actual_cutoff_month, -50_000);
  near('FLOW_STATUS coded = the coded cement', f.coded_amount, 200_000);
  near('FLOW_STATUS unallocated = subcontract PO without detail', f.unallocated_amount, 1_500_000);
  near('FLOW_STATUS coded_pct', f.coded_pct, 11.8);
  check('FLOW_STATUS latest data date', f.latest_data_date === '2026-04-01', f.latest_data_date);
  check('FLOW_STATUS source counts come from v_data_freshness',
    f.total_sources === (db.prepare('SELECT COUNT(*) n FROM v_data_freshness').get() as any).n
    && f.stale_sources >= 0, `${f.stale_sources} of ${f.total_sources}`);

  // Cut-off between D2 (11 Feb) and D3 (20 Feb): D3 and D4 are held back.
  setCutoff('2026-02-15');
  near('cut-off 15 Feb: actual drops by D3 + D4', sum('v_actual'), 1_700_000 - 200_000);
  near('cut-off 15 Feb: v_posting_all still sees every cost line',
    Number((db.prepare("SELECT SUM(amount) a FROM v_posting_all WHERE project_key = ? AND posting_nature = 'COST'")
      .get(projectKey) as any).a), 1_700_000);
  near('cut-off 15 Feb: income after the cut-off is held back too', sum('v_revenue'), 0);
  s = status();
  check('CUTOFF_STATUS reports the cut-off', s.cutoff_date === '2026-02-15', s.cutoff_date);
  check('CUTOFF_STATUS counts the 2 held-back cost lines', s.lines_after_cutoff === 2, String(s.lines_after_cutoff));
  near('CUTOFF_STATUS amount held back = D3 + D4', s.amount_after_cutoff, 200_000);
  check('the held-back lines stay in fact_actual',
    (db.prepare('SELECT COUNT(*) n FROM fact_actual WHERE project_key = ?').get(projectKey) as any).n === 6);
  f = flow();
  near('FLOW_STATUS actual_to_cutoff at 15 Feb', f.actual_to_cutoff, 1_500_000);
  near('FLOW_STATUS actual in the cut-off month (Feb, to the 15th)', f.actual_cutoff_month, 500_000);
  near('FLOW_STATUS coded at 15 Feb (cement not yet posted)', f.coded_amount, 0);
  near('FLOW_STATUS coded_pct at 15 Feb', f.coded_pct, 0);

  // The cut-off day itself counts.
  setCutoff('2026-02-20');
  near('cut-off 20 Feb: a line posted on the cut-off day counts', sum('v_actual'), 1_750_000);
  s = status();
  check('cut-off 20 Feb: only the return is held back', s.lines_after_cutoff === 1, String(s.lines_after_cutoff));
  near('cut-off 20 Feb: held-back amount is the return', s.amount_after_cutoff, -50_000);
  near('FLOW_STATUS coded at 20 Feb', flow().coded_amount, 250_000);

  // A line with no posting date falls back to its period end.
  db.prepare(`UPDATE fact_actual SET posting_date_key = NULL
              WHERE project_key = ? AND document_no = 'D3'`).run(projectKey);
  near('no posting date: D3 falls back to its period end (28 Feb) and is held back',
    sum('v_actual'), 1_500_000);
  near('and CUTOFF_STATUS counts it as held back', status().amount_after_cutoff, 200_000);
  setCutoff('2026-02-28');
  near('period end on the cut-off day counts', sum('v_actual'), 1_750_000);

  setCutoff(null);
  near('clearing the cut-off restores the original total', sum('v_actual'), 1_700_000);
  near('clearing the cut-off restores revenue', sum('v_revenue'), 1_200_000);
  s = status();
  check('cleared: nothing held back', s.cutoff_date === null && s.lines_after_cutoff === 0, JSON.stringify(s));
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

/**
 * The monthly subcontract cost report: ZSCPROG01 certificates with their SAP
 * traps (WBS splits, opening and pending lines, adjustments, qty-only lines,
 * VAT-inclusive A2 prices) plus the ZSCSRV1 PO service-line register.
 */
async function subcontractReport(dir: string): Promise<void> {
  console.log('\n--- subcontract cost report ---');
  openDatabase(join(dir, 'screport.db'));
  const db = getDb();
  const projectKey = Number(db.prepare('INSERT INTO dim_project (project_code, project_name) VALUES (?,?)')
    .run('P-200', 'Report Plant').lastInsertRowid);

  const certPath = join(dir, 'zscprog01.xlsx');
  await makeCertificateFile(certPath);
  const cert = await load(certPath, 'SERVICE', 7, '2026-02-28', null, projectKey);
  check('approval flag read from "Character 1"', cert.suggested.is_approved === 'Character 1', String(cert.suggested.is_approved));
  check('opening flag read from "Flag"', cert.suggested.is_opening === 'Flag', String(cert.suggested.is_opening));
  check('tax code read from "Tx", not taken for the contract type', cert.suggested.tax_code === 'Tx', String(cert.suggested.tax_code));
  check('contract type read from its Arabic caption', cert.suggested.contract_type === 'نوع العقد', String(cert.suggested.contract_type));
  check('profit centre read as a profit centre, not as the project',
    cert.suggested.profit_center === 'Profit Ctr' && cert.suggested.project_code === undefined,
    `${cert.suggested.profit_center} / ${cert.suggested.project_code}`);
  check('WBS split repeat and footer skipped', cert.staged.skippedCount === 2, String(cert.staged.skippedCount));
  check('8 certificate lines posted', cert.posted.posted === 8, String(cert.posted.posted));
  check('line identity kept despite the split', cert.posted.byLineKey === true);
  near('staged total counts the split line once', cert.staged.amountTotal, CERT_TOTALS.month1.total);

  const batch = db.prepare('SELECT control_total FROM import_batch WHERE import_batch_id = ?')
    .get(cert.staged.importBatchId) as any;
  near('SAP grand-total footer captured', Number(batch.control_total), CERT_TOTALS.month1.footer);

  const sum = (where: string) => Number((db.prepare(
    `SELECT COALESCE(SUM(amount_net),0) a FROM v_service_line WHERE project_key = ? AND ${where}`)
    .get(projectKey) as any).a);
  near('report total', sum('1=1'), CERT_TOTALS.month1.total);
  near('approved since go-live', sum("bucket NOT IN ('OPENING','PENDING')"), CERT_TOTALS.month1.approved);
  near('opening balance', sum("bucket = 'OPENING'"), CERT_TOTALS.month1.opening);
  near('pending (not approved)', sum("bucket = 'PENDING'"), CERT_TOTALS.month1.pending);
  near('adjustments', sum("line_class = 'Adjustment'"), CERT_TOTALS.month1.adjustments);

  const one = (where: string) => db.prepare(`SELECT * FROM v_service_line WHERE project_key = ? AND ${where}`)
    .get(projectKey) as any;
  check('split line records its two WBS rows', one("amount_net = 100000").split_count === 2);
  near('A2 price carries its 14% VAT back out', Number(one("service_code = 'S0901' AND amount_net <> 0").net_rate), 100);
  check('qty-only line classed as such', one("service_code = 'S0901' AND amount_net = 0").line_class === 'Qty only');
  near('amount off qty × rate is an adjustment reported at its own rate (no Normal line on that PO line)',
    Number(one('amount_net = 12000').report_qty), 12);
  check('amount off qty × rate is classed Adjustment', one('amount_net = 12000').line_class === 'Adjustment');
  check('certificate = PO + serial', one('amount_net = 12000').certificate_id === '4600001|C2',
    String(one('amount_net = 12000').certificate_id));
  check('no type of works before ZSCSRV1 gives one', one('amount_net = 12000').tow === '(no type of works)' || one('amount_net = 12000').tow === 'Civil');
  check('other profit centre flagged', one("service_code = 'L01'").is_other_pc === 1);
  const concrete = one("amount_net = 100000");
  check('trade from the service code', concrete.trade === '03' && concrete.trade_label === '03 Concrete',
    `${concrete.trade} ${concrete.trade_label}`);

  const snap = db.prepare('SELECT COUNT(*) n FROM service_line_snapshot WHERE import_batch_id = ?')
    .get(cert.staged.importBatchId) as any;
  check('the upload is kept as a snapshot', snap.n === 8, String(snap.n));

  const poPath = join(dir, 'zscsrv1.xlsx');
  await makePoServiceFile(poPath);
  const po = await load(poPath, 'PO_SERVICE', 11, '2026-02-28', null, projectKey);
  check('3 PO service lines posted', po.posted.posted === 3, String(po.posted.posted));
  check('PO service lines keyed on PO + item + line', po.posted.byLineKey === true);

  const level = (where: string) => (db.prepare(`SELECT m.match_level FROM v_service_line_po_match m
      JOIN v_service_line s ON s.service_line_id = m.service_line_id
      WHERE s.project_key = ? AND ${where}`).get(projectKey) as any)?.match_level;
  check('certificate line matched exactly', level('s.amount_net = 100000') === 'Exact', level('s.amount_net = 100000'));
  check('price difference recognised', level("s.service_code = 'S0401'") === 'Text (price differs)', level("s.service_code = 'S0401'"));
  check('A2 line matched on its gross price', level("s.service_code = 'S0901' AND s.amount_net <> 0") === 'Exact');
  check('line with no PO service line reported', level("s.service_code = 'L01'") === 'Not found');

  // ---- the report's own queries ------------------------------------------
  const P = { project_key: projectKey };
  const kpi = runStoredQuery('SC_REPORT_KPI', P).rows[0] as any;
  near('KPI certified', kpi.certified_amount, CERT_TOTALS.month1.total);
  near('KPI approved', kpi.approved_amount, CERT_TOTALS.month1.approved);
  near('KPI opening', kpi.opening_amount, CERT_TOTALS.month1.opening);
  near('KPI pending', kpi.pending_amount, CERT_TOTALS.month1.pending);
  near('KPI adjustments', kpi.adjustments_amount, CERT_TOTALS.month1.adjustments);
  check('KPI subcontractors with a non-zero total', kpi.subcontractors === 2, String(kpi.subcontractors));
  near('KPI other profit centre', kpi.other_profit_centre_amount, 5_000);
  near('KPI amount SAP repeated on the split', kpi.repeated_on_wbs_splits_amount, 100_000);

  const months = runStoredQuery('SC_MONTH_BY_TRADE', P).rows as any[];
  const monthSum = (m: string) => months.filter((r) => r.period_key === m).reduce((a, r) => a + Number(r.amount), 0);
  near('approved January by trade', monthSum('2026-01'), 100_000);
  near('approved February by trade', monthSum('2026-02'), 25_000);
  check('opening and pending kept out of the monthly chart',
    !months.some((r) => r.period_key === 'OPENING' || r.period_key === 'PENDING'));

  const trades = runStoredQuery('SC_TRADE_SUMMARY', P).rows as any[];
  const concreteTrade = trades.find((r) => r.trade === '03 Concrete');
  near('concrete total', Number(concreteTrade?.total_amount), 140_000);
  near('concrete pending', Number(concreteTrade?.pending_amount), 30_000);

  const active = runStoredQuery('SC_ACTIVE_SUBS_BY_MONTH', P).rows as any[];
  check('two subcontractors active in February',
    active.find((r) => r.period_key === '2026-02')?.active_subcontractors === 2);

  const top = runStoredQuery('SC_TOP_SERVICES', P).rows as any[];
  const conc = top.find((r) => r.service_code === 'S0302');
  check('top service unit from the PO service UOM', conc?.unit === 'M3', String(conc?.unit));
  near('top service qty at report qty (adjustments at the PO line rate)', Number(conc?.qty), 140);
  near('top service amount incl. adjustment', Number(conc?.amount), 140_000);

  const qty = runStoredQuery('SC_QTY_RECONCILIATION', P).rows as any[];
  const concLine = qty.find((r) => r.po_no === '4600001' && Number(r.po_item) === 10);
  near('certified qty against the concrete PO line', Number(concLine?.certified_qty), 140);
  near('received − certified', Number(concLine?.difference), 0);
  const plaster = qty.find((r) => r.po_no === '4600002');
  check('qty-only line explains the plaster difference', plaster?.explained === 'Excluded lines', String(plaster?.explained));

  const checks = runStoredQuery('SC_CHECKS', P).rows as any[];
  const diff = checks.find((r) => String(r.check).startsWith('Difference'));
  check('footer − splits − lines reconciles', diff?.status === 'ok', `${diff?.status} ${diff?.value}`);
  check('unmatched certificate line flagged',
    checks.find((r) => String(r.check).startsWith('Certificate lines with no'))?.value === 1);

  // ---- changes since last load -------------------------------------------
  const first = runStoredQuery('SC_CHANGES_SUMMARY', P).rows[0] as any;
  check('one load: nothing to compare yet', first.loads === 1 && runStoredQuery('SC_CHANGES', P).rowCount === 0,
    `${first.loads} loads`);

  const cert2Path = join(dir, 'zscprog01_m2.xlsx');
  await makeCertificateFile(cert2Path, true);
  const cert2 = await load(cert2Path, 'SERVICE', 7, '2026-03-31', null, projectKey);
  check('second month merges on line identity', cert2.posted.byLineKey === true);

  const summary = runStoredQuery('SC_CHANGES_SUMMARY', P).rows[0] as any;
  check('two loads compared', summary.loads === 2, String(summary.loads));
  check('one new line', summary.new_lines === 1, String(summary.new_lines));
  near('new line amount', summary.new_amount, 20_000);
  check('one changed line', summary.changed_lines === 1, String(summary.changed_lines));
  near('changed amount is the movement', summary.changed_amount, 1_000);
  check('one newly approved line', summary.newly_approved_lines === 1, String(summary.newly_approved_lines));
  near('newly approved counts at its full amount', summary.newly_approved_amount, 30_000);
  check('one removed line', summary.removed_lines === 1, String(summary.removed_lines));
  near('removed amount', summary.removed_amount, -5_000);

  const changes = runStoredQuery('SC_CHANGES', P).rows as any[];
  const changed = changes.find((r) => r.change_type === 'Amount changed');
  check('changed line carries before and now', changed?.before === 10_000 && changed?.now === 11_000,
    `${changed?.before} → ${changed?.now}`);
  check('removed line is the other-profit-centre one',
    changes.find((r) => r.change_type === 'Removed')?.service_code === 'L01');

  const hist = runStoredQuery('SC_LOAD_HISTORY', P).rows as any[];
  check('load history has both uploads in order',
    hist.length === 2 && hist[0].data_date === '2026-02-28' && hist[1].data_date === '2026-03-31',
    hist.map((h) => h.data_date).join(','));
  near('first load total', hist[0].total_amount, CERT_TOTALS.month1.total);
  near('second load total', hist[1].total_amount, 181_000);
  near('second load pending cleared', hist[1].pending_amount, 0);

  // ---- the native report page's sheet queries tie out ---------------------
  {
    const sheet = (code: string, extra: Record<string, unknown> = {}) => runStoredQuery(code, { ...P, ...extra }).rows as any[];
    const total = (rows: any[], col: string) => rows.reduce((a, r) => a + Number(r[col] ?? 0), 0);
    const kp = runStoredQuery('SC_REPORT_KPI', P).rows[0] as any;
    const lineCount = Number((db.prepare('SELECT COUNT(*) n FROM v_service_line WHERE project_key = ?').get(projectKey) as any).n);

    const services = sheet('SC_SHEET_SERVICES');
    near('Services: To date sums to the KPI', total(services, 'todate_amount'), kp.to_date_amount);
    near('Services: Previous sums to the KPI', total(services, 'previous_amount'), kp.previous_amount);
    near('Services: This month sums to the KPI', total(services, 'month_amount'), kp.this_month_amount);
    near('Services: Pending sums to the KPI', total(services, 'pending_amount'), kp.pending_amount);
    near('Subcontractors: To date sums to the KPI', total(sheet('SC_SHEET_SUBS'), 'todate_amount'), kp.to_date_amount);
    near('Subcontractors: Pending sums to the KPI', total(sheet('SC_SHEET_SUBS'), 'pending_amount'), kp.pending_amount);
    near('PO register: To date sums to the KPI', total(sheet('SC_SHEET_PO_REGISTER'), 'todate_amount'), kp.to_date_amount);
    near('Cost by DIV sums to the KPI', total(sheet('SC_SHEET_DIV'), 'to_date'), kp.to_date_amount);
    near('Cost by type of works sums to the KPI', total(sheet('SC_SHEET_TOW'), 'to_date'), kp.to_date_amount);
    near('Cost per month table sums to the KPI', total(sheet('SC_SHEET_MONTHS_TABLE'), 'total'), kp.to_date_amount);
    near('Cost per month chart rows sum to the KPI', total(sheet('SC_SHEET_MONTHS'), 'amount'), kp.to_date_amount);
    for (const code of ['SC_SHEET_SERVICE_MONTH', 'SC_SHEET_PO_MONTH']) {
      const rows = sheet(code);
      near(`${code}: periods other than Pending sum to To date`, total(rows.filter((r) => r.period !== 'Pending'), 'amount'), kp.to_date_amount);
      near(`${code}: Pending period sums to Pending`, total(rows.filter((r) => r.period === 'Pending'), 'amount'), kp.pending_amount);
    }
    const recon = sheet('SC_SAP_RECON');
    check('SAP reconciliation has its seven steps', recon.length === 7, String(recon.length));
    near('SAP reconciliation ends at To date', Number(recon[6].amount), kp.to_date_amount);
    const lines = sheet('SC_SHEET_LINES');
    check('Lines: one row per counted + pending line', lines.length === lineCount, `${lines.length} vs ${lineCount}`);
    near('Lines: amounts sum to certified', total(lines, 'amount'), kp.certified_amount);
    check('Lines: Pending rows are the pending lines',
      lines.filter((r) => r.period === 'Pending').length
        === Number((db.prepare(`SELECT COUNT(*) n FROM v_service_line WHERE project_key = ? AND report_bucket = 'PENDING'`).get(projectKey) as any).n));
    const codingStatus = sheet('SC_SHEET_CODING_STATUS')[0];
    check('Coding band counts the same services as the Services sheet', Number(codingStatus.services) === services.length,
      `${codingStatus.services} vs ${services.length}`);
    check('PO-side description normalisation is the views own',
      Number((db.prepare(`SELECT COUNT(*) n FROM v_service_line WHERE ${scNorm('service_text')} IS NOT service_text_norm`).get() as any).n) === 0);
    check('the PO register finds ZSCSRV1 quantities', sheet('SC_SHEET_PO_REGISTER').some((r) => r.po_qty !== null));

    // the filter params: a type of works, a subcontractor, a work package, a month, a search
    const tows = db.prepare(`SELECT tow, SUM(CASE WHEN report_bucket <> 'PENDING' THEN a ELSE 0 END) td, SUM(a) tot FROM v_service_line
                             WHERE project_key = ? GROUP BY tow ORDER BY tot DESC`).all(projectKey) as any[];
    const t0 = tows[0];
    for (const f of [t0.tow, `~${t0.tow}`]) {
      near(`tow filter ${f}: Services To date is that type amount`, total(sheet('SC_SHEET_SERVICES', { tow: f }), 'todate_amount'), t0.td);
      near(`tow filter ${f}: Subcontractors To date`, total(sheet('SC_SHEET_SUBS', { tow: f }), 'todate_amount'), t0.td);
      near(`tow filter ${f}: PO register To date`, total(sheet('SC_SHEET_PO_REGISTER', { tow: f }), 'todate_amount'), t0.td);
      near(`tow filter ${f}: cost per month`, total(sheet('SC_SHEET_MONTHS_TABLE', { tow: f }), 'total'), t0.td);
      near(`tow filter ${f}: Lines`, total(sheet('SC_SHEET_LINES', { tow: f }), 'amount'), t0.tot);
    }
    if (tows.length > 1) {
      check('the tow filter reduces the total', total(sheet('SC_SHEET_SERVICES', { tow: t0.tow }), 'todate_amount')
        < total(services, 'todate_amount') || Math.abs(t0.td - kp.to_date_amount) < 0.01);
    }
    const v0 = db.prepare(`SELECT vendor_key, SUM(CASE WHEN report_bucket <> 'PENDING' THEN a ELSE 0 END) td FROM v_service_line
                           WHERE project_key = ? GROUP BY vendor_key ORDER BY td DESC`).get(projectKey) as any;
    near('vendor filter: Services To date is that subcontractor', total(sheet('SC_SHEET_SERVICES', { vendor: v0.vendor_key }), 'todate_amount'), v0.td);
    check('vendor filter: one subcontractor row', sheet('SC_SHEET_SUBS', { vendor: v0.vendor_key }).length === 1);
    near('not-coded + coded work package filters add up to To date',
      total(sheet('SC_SHEET_SERVICES', { pkg: '~(not coded)' }), 'todate_amount')
        + (db.prepare(`SELECT DISTINCT work_package w FROM v_service_line WHERE project_key = ? AND work_package IS NOT NULL`).all(projectKey) as any[])
          .reduce((a, r) => a + total(sheet('SC_SHEET_SERVICES', { pkg: `~${r.w}` }), 'todate_amount'), 0),
      kp.to_date_amount);
    const m0 = db.prepare(`SELECT period_key, SUM(a) a FROM v_service_line WHERE project_key = ? AND period_key IS NOT NULL
                           GROUP BY period_key ORDER BY period_key LIMIT 1`).get(projectKey) as any;
    near('month filter: Lines are that month', total(sheet('SC_SHEET_LINES', { month: m0.period_key }), 'amount'), m0.a);
    const q0 = db.prepare(`SELECT service_code c FROM v_service_line WHERE project_key = ? AND service_code IS NOT NULL LIMIT 1`).get(projectKey) as any;
    near('search filter on a service code', total(sheet('SC_SHEET_LINES', { q: q0.c }), 'amount'),
      Number((db.prepare(`SELECT SUM(a) s FROM v_service_line WHERE project_key = ? AND INSTR(LOWER(COALESCE(service_code,'') || ' ' || COALESCE(service_text,'') || ' ' ||
        COALESCE(vendor_name,'') || ' ' || COALESCE(po_no,'') || ' ' || COALESCE(tow,'')), LOWER(?)) > 0`).get(projectKey, q0.c) as any).s));

    // drill-down: one service's lines, then one PO line's
    const s0 = services.find((r) => r.service_code) ?? services[0];
    const drillRows = sheet('SC_SHEET_LINES', { service_code: `~${s0.service_code}`, service_norm: `~${s0.service_norm}` });
    near('drill: a service lines sum to its Services row (To date + Pending)', total(drillRows, 'amount'),
      Number(s0.todate_amount) + Number(s0.pending_amount));
    const poRow = sheet('SC_SHEET_PO_REGISTER')[0];
    near('drill: a PO line lines sum to its register row (To date + Pending)',
      total(sheet('SC_SHEET_LINES', { po_no: `~${poRow.po_no}`, service_code: `~${poRow.service_code}`, service_norm: `~${poRow.service_norm}` }), 'amount'),
      Number(poRow.todate_amount) + Number(poRow.pending_amount));
    near('invoices register is filtered too',
      Number(sheet('SC_INVOICES_REGISTER', { tow: t0.tow }).find((r) => r.vendor === 'All subcontractors' && r.bucket === 'To date')?.amount ?? 0), t0.td);
    // every filter at once still runs
    for (const code of ['SC_SHEET_MONTHS', 'SC_SHEET_DIV', 'SC_SHEET_CODING', 'SC_SHEET_SERVICES', 'SC_SHEET_SERVICE_MONTH', 'SC_SHEET_PO_REGISTER',
                        'SC_SHEET_PO_MONTH', 'SC_SHEET_SUBS', 'SC_SHEET_LINES', 'SC_CHANGES']) {
      sheet(code, { tow: 'x', vendor: 1, pkg: '~x', month: '2026-01', q: 'x', service_code: '~x', service_norm: '~x', po_no: '~x' });
    }
  }

  // ---- the monthly workbook ---------------------------------------------
  // make the workbook face Pending lines: one certificate loses its date, another its approval
  db.prepare(`UPDATE fact_service_line SET invoice_date_key = NULL, period_key = NULL WHERE service_line_id =
              (SELECT MIN(service_line_id) FROM fact_service_line WHERE project_key = ? AND amount_net <> 0 AND COALESCE(is_opening, 0) = 0)`).run(projectKey);
  db.prepare(`UPDATE fact_service_line SET is_approved = 0 WHERE service_line_id =
              (SELECT MAX(service_line_id) FROM fact_service_line WHERE project_key = ? AND amount_net <> 0 AND COALESCE(is_opening, 0) = 0)`).run(projectKey);
  const report = await buildSubcontractReport(projectKey);
  const wkpi = runStoredQuery('SC_REPORT_KPI', P).rows[0] as any;
  check('workbook named after project and report month',
    report.fileName === `P-200_SC_Report_${wkpi.report_month}.xlsx`, report.fileName);
  const wbPath = join(dir, report.fileName);
  writeFileSync(wbPath, report.buffer);
  { const bad = await sheetPrOrderOk(report.buffer); check('SC workbook: sheetPr children in schema order (Excel opens without repair)', bad.length === 0, bad.join(',')); }
  if (process.env.SC_SAMPLE_OUT) writeFileSync(process.env.SC_SAMPLE_OUT, report.buffer);   // optional: keep a sample for eyeballing
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(wbPath);
  // the v2.6 tool's sheet set, in its order; _Codes/_Meta/_Cal/_Ref are hidden
  const names = wb.worksheets.map((w) => w.name).join(',');
  check('workbook sheets in the v2.6 order', names === 'Summary,Coding,Lists,_Codes,Service Summary,Service per Month,'
    + 'PO Register,PO per Month,Subcontractor Summary,Invoices Register,Checks,Changes,Data,Notes,_Meta,_Cal,_Ref', names);
  check('helper sheets are hidden', ['_Codes', '_Meta', '_Cal', '_Ref'].every((n) => wb.getWorksheet(n)!.state === 'hidden'));
  const cutName = (wb.definedNames.model as Array<{ name: string; ranges: string[] }>).find((d) => d.name === 'CutDate');
  check('cut date is the named input Summary!B4', cutName?.ranges[0] === 'Summary!$B$4', JSON.stringify(cutName));

  const data = wb.getWorksheet('Data')!;
  const hdr = new Map<string, number>();
  (data.getRow(1).values as unknown[]).forEach((v, i) => { if (typeof v === 'string') hdr.set(v, i); });
  const cell = (r: number, h: string) => {
    const v = data.getCell(r, hdr.get(h)!).value as any;
    return v && typeof v === 'object' && 'result' in v ? v.result : v;
  };
  const counted = db.prepare('SELECT COUNT(*) n FROM v_service_line WHERE project_key = ? AND amount_net <> 0').get(projectKey) as any;
  check('Data has one row per counted certificate line', data.actualRowCount - 1 === counted.n, `${data.actualRowCount - 1} vs ${counted.n}`);

  // Summary: live cut date, formulas, totals tie to SC_REPORT_KPI
  const sm = wb.getWorksheet('Summary')!;
  check('Summary!B4 holds the cut date as a date', sm.getCell('B4').value instanceof Date, String(sm.getCell('B4').value));
  const cutExpected = (db.prepare('SELECT cutoff_date FROM project_cutoff WHERE project_key = ?').get(projectKey) as any)?.cutoff_date;
  if (cutExpected) check('cut date is the project cut-off', (sm.getCell('B4').value as Date).toISOString().slice(0, 10) === cutExpected);
  const toDateCell = sm.getCell('C7').value as any;
  check('Summary To date is a live formula', toDateCell && typeof toDateCell === 'object' && toDateCell.formula === 'A7+B7', JSON.stringify(toDateCell));
  near('Summary To date equals SC_REPORT_KPI', toDateCell.result, wkpi.to_date_amount);
  near('Summary Previous equals SC_REPORT_KPI', (sm.getCell('A7').value as any).result, wkpi.previous_amount);
  near('Summary This month equals SC_REPORT_KPI', (sm.getCell('B7').value as any).result, wkpi.this_month_amount);
  near('Summary Pending equals SC_REPORT_KPI', Number((sm.getCell('D7').value as any).result ?? 0), wkpi.pending_amount);

  // Pending lines are in the workbook, with a reason and never dated 1900
  const dataRows = Array.from({ length: data.actualRowCount - 1 }, (_, i) => i + 2);
  const pendingRows = dataRows.filter((r) => cell(r, 'Period') === 'Pending');
  const pendingExpected = db.prepare(`SELECT COUNT(*) n FROM v_service_line WHERE project_key = ? AND amount_net <> 0
                                      AND report_bucket = 'PENDING'`).get(projectKey) as any;
  check('Pending lines present on Data', pendingRows.length === pendingExpected.n && pendingRows.length > 0,
    `${pendingRows.length} vs ${pendingExpected.n}`);
  near('Pending lines add up to the headline', pendingRows.reduce((a, r) => a + Number(cell(r, 'Amount')), 0), wkpi.pending_amount);
  check('every Pending line says why', pendingRows.every((r) => String(cell(r, 'Pending reason') ?? '') !== ''));
  check('no certificate date before 2000',
    dataRows.every((r) => { const d = data.getCell(r, hdr.get('Cert. date')!).value; return !(d instanceof Date) || d.getUTCFullYear() >= 2000; }));
  // MNL = the Subcontract cost type's MNL code (SUB)
  check('MNL is SUB on every Data line', dataRows.every((r) => cell(r, 'MNL') === 'SUB'),
    String(cell(dataRows[0], 'MNL')));
  const dataCode = db.prepare(`SELECT mnl FROM dim_cost_type WHERE code = 'SUBCONTRACT'`).get() as any;
  check('SUBCONTRACT cost type carries mnl SUB (migration 023)', dataCode.mnl === 'SUB');
  const coding = wb.getWorksheet('Coding')!;
  check('Coding sheet has a drop-down on DIV',
    JSON.stringify(coding.getCell(5, 5).dataValidation ?? {}).includes('_Codes'), JSON.stringify(coding.getCell(5, 5).dataValidation));
  check('Invoices Register sheet has rows', wb.getWorksheet('Invoices Register')!.actualRowCount > 5);
  const changesSheet = wb.getWorksheet('Changes')!;
  check('Changes sheet lists the changed lines',
    changesSheet.getSheetValues().filter((r: any) => Array.isArray(r) && ['New', 'Amount changed', 'Approved since last load', 'Removed']
      .includes(r[1])).length === 4);
  const checksSheet = wb.getWorksheet('Checks')!;
  check('Checks sheet carries the app checks',
    checksSheet.getSheetValues().some((r: any) => Array.isArray(r) && r.some((c: any) => c === 'Certified = To date + Pending')));
}

/**
 * The tool's rules inside v_service_line: cut-off, pend_reason, report month,
 * buckets, Adjustment qty at the PO line's certified rate, certificates.
 */
async function scRules(dir: string): Promise<void> {
  console.log('\n--- subcontract rules: cut-off, buckets, adjustments ---');
  openDatabase(join(dir, 'screrules.db'));
  const db = getDb();
  const projectKey = Number(db.prepare('INSERT INTO dim_project (project_code, project_name) VALUES (?,?)')
    .run('P-300', 'Rules Plant').lastInsertRowid);
  const path = join(dir, 'screrules.xlsx');
  await makeScRulesFile(path);
  const cert = await load(path, 'SERVICE', 7, '2026-03-31', null, projectKey);
  check('8 certificate lines posted', cert.posted.posted === 8, String(cert.posted.posted));

  const view = (name: string) => (where: string) => db.prepare(
    `SELECT * FROM ${name} WHERE project_key = ? AND ${where}`).get(projectKey) as any;
  const sum = (name: string, where: string) => Number((db.prepare(
    `SELECT COALESCE(SUM(amount_net),0) a FROM ${name} WHERE project_key = ? AND ${where}`).get(projectKey) as any).a);
  const ser = (s: string) => `invoice_serial = '${s}'`;

  // ---- no cut-off yet: only 'Not approved' and 'No date' are pending
  let v = view('v_service_line');
  check('undated line keeps no period', v(ser('C5')).period_key === null);
  check('undated line is pending: No date', v(ser('C5')).pend_reason === 'No date');
  check('unapproved line is pending: Not approved', v(ser('C7')).pend_reason === 'Not approved');
  check('with no cut-off a March line counts', v(ser('C6')).pend_reason === null);
  check('no cut-off: report month is the latest counted month', v(ser('C6')).report_month === '2026-03',
    String(v(ser('C6')).report_month));

  // ---- cut-off 2026-02-28
  db.prepare("INSERT INTO project_cutoff (project_key, cutoff_date) VALUES (?, '2026-02-28')").run(projectKey);
  v = view('v_service_line');
  check('after-cut line is pending: After cut date', v(ser('C6')).pend_reason === 'After cut date');
  check('report month = month of the cut-off', v(ser('C1')).report_month === '2026-02');
  check('counted line has no pend_reason', v(ser('C1')).pend_reason === null);
  check('opening bucket', v(ser('C0')).bucket === 'OPENING' && v(ser('C0')).report_bucket === 'OPENING');
  check('January line is PREVIOUS', v(ser('C1')).report_bucket === 'PREVIOUS' && v(ser('C1')).bucket === '2026-01');
  check('February line is THIS_MONTH', v(ser('C2')).report_bucket === 'THIS_MONTH');
  check('all three pending reasons bucket as PENDING',
    ['C5', 'C6', 'C7'].every((x) => v(ser(x)).bucket === 'PENDING' && v(ser(x)).report_bucket === 'PENDING'));
  near('total (nothing dropped by the cut)', sum('v_service_line', '1=1'), 171_000);
  near('pending = no date + after cut + not approved', sum('v_service_line', "bucket = 'PENDING'"), 14_000);
  near('opening', sum('v_service_line', "report_bucket = 'OPENING'"), 10_000);
  near('previous', sum('v_service_line', "report_bucket = 'PREVIOUS'"), 100_000);
  near('this month', sum('v_service_line', "report_bucket = 'THIS_MONTH'"), 47_000);
  near('to date includes opening', sum('v_service_line', "report_bucket <> 'PENDING'"), 157_000);
  const all = view('v_service_line_all');
  check('v_service_line_all ignores the cut-off', all(ser('C6')).pend_reason === null);
  near('pending without the cut-off', sum('v_service_line_all', "bucket = 'PENDING'"), 11_000);

  // ---- line rules
  check('certified line is Normal', v(ser('C1')).line_class === 'Normal');
  near('Normal line reports the certificate qty', v(ser('C1')).report_qty, 100);
  check('80%-paid line is an Adjustment', v(ser('C2')).line_class === 'Adjustment');
  near('80%-paid qty = amount / PO-line certified rate', v(ser('C2')).report_qty, 40);
  check('hold release is an Adjustment', v(ser('C3')).line_class === 'Adjustment');
  near('hold release qty', v(ser('C3')).report_qty, 5);
  check('re-price is an Adjustment', v(ser('C4')).line_class === 'Adjustment');
  near('re-price qty uses the certified rate, not its own 0.10', v(ser('C4')).report_qty, 2);
  check('adjustment rate source is the PO line', v(ser('C4')).rate_src === 'PO line');
  near('opening line is Normal at its own qty', v(ser('C0')).report_qty, 20);
  check('certificate id = PO | serial', v(ser('C2')).certificate_id === '5000001|C2');
  check('eight certificates', Number((db.prepare(
    'SELECT COUNT(DISTINCT certificate_id) n FROM v_service_line WHERE project_key = ?').get(projectKey) as any).n) === 8);
  check('normalised description collapses spacing', v(ser('C1')).service_text_norm === 'concrete c30',
    String(v(ser('C1')).service_text_norm));

  const P = { project_key: projectKey };
  const kpi = runStoredQuery('SC_REPORT_KPI', P).rows[0] as any;
  near('KPI to date includes opening', kpi.to_date_amount, 157_000);
  near('KPI pending', kpi.pending_amount, 14_000);
  check('KPI certificates counted by PO + serial (pending excluded)', kpi.certificates === 5, String(kpi.certificates));

  // ---- Type of Works from ZSCSRV1
  check('no type of works before ZSCSRV1', v(ser('C1')).tow === '(no type of works)');
  const poPath = join(dir, 'scrules_po.xlsx');
  await makeScRulesPoFile(poPath);
  await load(poPath, 'PO_SERVICE', 11, '2026-03-31', null, projectKey);
  check('tow = first non-empty works type of the PO', view('v_service_line')(ser('C1')).tow === 'Civil works',
    String(view('v_service_line')(ser('C1')).tow));
  db.prepare("INSERT INTO dim_tow_order (project_key, tow, sort_order) VALUES (?, 'Civil works', 1)").run(projectKey);
}

/**
 * MB51 / ME2N / material list, and the headline actual that swaps CJI3 material
 * for MB51 issues per project (v_actual_cost).
 */
async function materialIssue(dir: string): Promise<void> {
  console.log('\n--- material: MB51 issues, ME2N prices, v_actual_cost ---');
  openDatabase(join(dir, 'material.db'));
  const db = getDb();
  const rd = (code: string) => Number((db.prepare(
    'SELECT report_definition_id id FROM report_definition WHERE code = ?').get(code) as any).id);
  const p1 = Number(db.prepare('INSERT INTO dim_project (project_code, project_name) VALUES (?,?)')
    .run('P-100', 'With MB51').lastInsertRowid);
  const p2 = Number(db.prepare('INSERT INTO dim_project (project_code, project_name) VALUES (?,?)')
    .run('P-200', 'CJI3 only').lastInsertRowid);
  const one = (sql: string, ...args: unknown[]) => db.prepare(sql).get(...args) as any;
  const num = (sql: string, ...args: unknown[]) => Number((Object.values(one(sql, ...args))[0]) ?? 0);

  // ---- CJI3 for both projects first: material is the CJI3 postings
  const cji3 = join(dir, 'mat-cji3.xlsx');
  await makeCji3File(cji3);
  await load(cji3, 'ACTUAL', 6, '2026-03-31', null, p1);
  await load(cji3, 'ACTUAL', 6, '2026-03-31', null, p2);
  const headline = (p: number) => Number((runStoredQuery('KPI_PROJECT', { project_key: p }).rows[0] as any).actual_cost);
  near('before MB51: P-100 headline actual is CJI3', headline(p1), 1_700_000);
  near('before MB51: CJI3 material in the headline', num(
    "SELECT SUM(amount) FROM v_actual_cost WHERE project_key = ? AND cost_type = 'MATERIAL' AND source = 'CJI3'", p1),
    MB51_TOTALS.cji3Material);

  // ---- MB51
  const mbPath = join(dir, 'mb51.xlsx');
  await makeMb51File(mbPath);
  const mb = await load(mbPath, 'MATISSUE', rd('SAP_MB51'), '2026-03-31', null, p1);
  check('MB51 movement type auto-mapped', mb.suggested.movement_type === 'Movement Type', mb.suggested.movement_type);
  check('MB51 amount auto-mapped', mb.suggested.amount === 'Amt.in Loc.Cur.', mb.suggested.amount);
  check('MB51 document line auto-mapped', mb.suggested.document_line === 'Material Doc.Item', mb.suggested.document_line);
  check('MB51 line key is document + year + item', mb.staged.lineKey.used.join('+') === 'document_no+fiscal_year+document_line'
    && mb.staged.lineKey.usable, mb.staged.lineKey.used.join('+'));
  check('SAP total row and the pasted-twice line are skipped (2 of 14)', mb.staged.skippedCount === 2,
    String(mb.staged.skippedCount));
  check('12 movement lines posted (all movements, the duplicate counted once)', mb.posted.posted === 12, String(mb.posted.posted));
  near('control total = the footer of the file', Number((one(
    'SELECT control_total c FROM import_batch WHERE import_batch_id = ?', mb.staged.importBatchId)).c),
    MB51_TOTALS.fileTotal);
  check('a repeated document line was not duplicated', num(
    "SELECT COUNT(*) FROM fact_material_issue WHERE document_no = '4900000002'") === 1);

  // ---- the views, before and after the cut-off
  near('v_material_issue total, no cut-off', num('SELECT SUM(amount) FROM v_material_issue WHERE project_key = ?', p1),
    MB51_TOTALS.issuesDatedNoCut);
  check('receipts, transfers, zero-value and unknown movements are not issues', num(
    "SELECT COUNT(*) FROM v_material_issue WHERE project_key = ? AND movement_type IN ('101','301','ZZ9')", p1) === 0
    && num("SELECT COUNT(*) FROM v_material_issue_all WHERE material_code = 'MAT-OWN-03'") === 0);
  near('issue types: project 221/222', num(
    "SELECT SUM(amount) FROM v_material_issue WHERE issue_type = 'P'"), 440_000);   // 80k + 250k - 50k + 120k + 40k
  near('issue types: Z21 to subcontractors', num("SELECT SUM(amount) FROM v_material_issue WHERE issue_type = 'S'"), 30_000);
  near('issue types: scrap', num("SELECT SUM(amount) FROM v_material_issue WHERE issue_type = 'X'"), 5_000);
  check('the SAP sign is kept beside the cost sign', one(
    "SELECT sap_amount a, amount b FROM v_material_issue WHERE document_no = '4900000003'").a === 50_000
    && one("SELECT amount b FROM v_material_issue WHERE document_no = '4900000003'").b === -50_000);
  check('Z21 keeps the subcontractor code', one(
    "SELECT vendor_code v FROM v_material_issue WHERE movement_type = 'Z21'").v === 'V001');
  check('unknown movement type is classified UNKNOWN', one(
    "SELECT movement_kind k FROM v_material_movement WHERE movement_type = 'ZZ9'").k === 'UNKNOWN');
  check('zero-value owner-supplied line kept in the movement view', one(
    "SELECT valuation_type v FROM v_material_movement WHERE material_code = 'MAT-OWN-03'").v === 'CUSTOMER');

  db.prepare("INSERT INTO project_cutoff (project_key, cutoff_date) VALUES (?, '2026-03-31')").run(p1);
  near('cut-off 2026-03-31 holds back the April issue', num('SELECT SUM(amount) FROM v_material_issue WHERE project_key = ?', p1),
    MB51_TOTALS.issuesDatedCut);
  near('v_material_issue_all ignores the cut-off (and shows the undated line)', num(
    'SELECT SUM(amount) FROM v_material_issue_all WHERE project_key = ?', p1), MB51_TOTALS.issuesAll);
  check('pending reasons: after cut-off and no posting date', one(
    "SELECT GROUP_CONCAT(pending_reason) r FROM (SELECT pending_reason FROM v_material_issue_all WHERE pending_reason IS NOT NULL ORDER BY 1)").r
    === 'After cut-off,No posting date');
  const byMonth = Object.fromEntries((db.prepare(
    'SELECT period_key, SUM(amount) a FROM v_material_issue WHERE project_key = ? GROUP BY period_key').all(p1) as any[])
    .map((r) => [r.period_key, r.a]));
  check('issues by month', byMonth['2026-01'] === 80_000 && byMonth['2026-02'] === 400_000 && byMonth['2026-03'] === -45_000,
    JSON.stringify(byMonth));

  // ---- v_actual_cost: MB51 replaces CJI3 material for P-100 only
  near('P-100 material in v_actual_cost = MB51 to the cut-off', num(
    "SELECT SUM(amount) FROM v_actual_cost WHERE project_key = ? AND cost_type = 'MATERIAL'", p1), MB51_TOTALS.issuesDatedCut);
  check('P-100: no CJI3 material row left in v_actual_cost', num(
    "SELECT COUNT(*) FROM v_actual_cost WHERE project_key = ? AND cost_type = 'MATERIAL' AND source = 'CJI3'", p1) === 0);
  near('P-100 headline actual = CJI3 non-material + MB51', headline(p1), 1_500_000 + MB51_TOTALS.issuesDatedCut);
  near('P-200 (no MB51) keeps CJI3 material', num(
    "SELECT SUM(amount) FROM v_actual_cost WHERE project_key = ? AND cost_type = 'MATERIAL'", p2), MB51_TOTALS.cji3Material);
  near('P-200 headline actual is unchanged', headline(p2), 1_700_000);
  near('v_actual (CJI3) is untouched for P-100', num(
    "SELECT SUM(amount) FROM v_actual WHERE project_key = ? AND cost_type = 'MATERIAL'", p1), MB51_TOTALS.cji3Material);
  const heat = runStoredQuery('COST_HEATMAP', { project_key: p1 });
  near('heatmap material = MB51', (heat.rows as any[]).filter((r) => r.cost_type === 'MATERIAL')
    .reduce((s, r) => s + Number(r.actual_amount), 0), MB51_TOTALS.issuesDatedCut);
  const trend = runStoredQuery('ACT_MONTHLY_TREND', { project_key: p1 });
  near('monthly trend ends at the headline', Number((trend.rows.at(-1) as any).cumulative_amount), headline(p1));
  const flow = runStoredQuery('FLOW_STATUS', { project_key: p1 }).rows[0] as any;
  near('FLOW_STATUS actual to cut-off follows v_actual_cost', Number(flow.actual_to_cutoff), headline(p1));

  const recon = runStoredQuery('MAT_RECON', { project_key: p1 }).rows as any[];
  const feb = recon.find((r) => r.period_key === '2026-02');
  check('MAT_RECON February: MB51 400,000 vs CJI3 250,000', feb?.mb51_amount === 400_000 && feb?.cji3_amount === 250_000,
    JSON.stringify(feb));
  near('MAT_RECON February difference', Number(feb?.difference), 150_000);

  // ---- ME2N and the material list
  const mePath = join(dir, 'me2n.xlsx');
  await makeMe2nFile(mePath);
  const me = await load(mePath, 'MATPO', rd('SAP_ME2N'), '2026-03-31', null, p1);
  check('ME2N total row skipped, service line staged with a warning', me.staged.skippedCount === 1 && me.staged.warnCount === 1,
    `${me.staged.skippedCount} skipped, ${me.staged.warnCount} warn`);
  check('6 PO material lines loaded (the service line has no material)', me.posted.posted === 6, String(me.posted.posted));
  near('ME2N control total = the footer', Number(one(
    'SELECT control_total c FROM import_batch WHERE import_batch_id = ?', me.staged.importBatchId).c), 498_000);
  check('purchase vs stock transport kind', num("SELECT COUNT(*) FROM v_po_material_line WHERE kind = 'PUR'") === 5
    && num("SELECT COUNT(*) FROM v_po_material_line WHERE kind = 'STO'") === 1);
  near('weighted PO price: deleted line left out', num(
    "SELECT weighted_price FROM v_po_material_price WHERE material_code = 'MAT-CEM-01'"), 820);
  near('weighted PO price: price unit 10 and stock transfer', num(
    "SELECT weighted_price FROM v_po_material_price WHERE material_code = 'MAT-STL-02'"), 660);
  check('group from ME2N: the more frequent group wins', one(
    "SELECT material_group g, group_source s FROM dim_material WHERE material_code = 'MAT-STL-02'").g === 'M030201'
    && one("SELECT group_source s FROM dim_material WHERE material_code = 'MAT-STL-02'").s === 'ME2N');

  const listPath = join(dir, 'mm60.xlsx');
  await makeMaterialListFile(listPath);
  const ml = await load(listPath, 'MATLIST', rd('SAP_MM60'), '2026-03-31', null, null);
  check('material list posted with no project', ml.posted.posted === 3 && ml.staged.errorCount === 0,
    `${ml.posted.posted} posted, ${ml.staged.errorCount} errors`);
  const mat = (c: string) => one('SELECT * FROM dim_material WHERE material_code = ?', c);
  check('list never overrides an ME2N group, but fills type and unit',
    mat('MAT-CEM-01').material_group === 'M0001' && mat('MAT-CEM-01').group_source === 'ME2N'
    && mat('MAT-CEM-01').material_type === 'ROH' && mat('MAT-CEM-01').base_unit === 'TON');
  check('list gives a group to a material on no PO line', mat('MAT-PIPE-04').material_group === 'M2204'
    && mat('MAT-PIPE-04').group_source === 'MATLIST');
  check('list creates a material not seen yet', mat('MAT-NEW-05')?.material_group === 'S0401');
  check('issue view resolves family and group name through dim_material_group', one(
    "SELECT family f, material_group_name n FROM v_material_issue WHERE material_code = 'MAT-CEM-01' LIMIT 1").f === 'M'
    && one("SELECT material_group_name n FROM v_material_issue WHERE material_code = 'MAT-CEM-01' LIMIT 1").n === 'CEMENT');
  const price = (runStoredQuery('MAT_PO_PRICE', { project_key: p1 }).rows as any[]).find((r) => r.material_code === 'MAT-CEM-01');
  // to the cut-off cement is 100 + 300 - 60 = 340 TON for 280,000
  check('MAT_PO_PRICE: cement issued at 823.53 against a 820 PO price (+0.4 %)',
    Math.abs(Number(price?.issue_rate) - 823.5294) < 0.01 && Math.abs(Number(price?.vs_po_pct) - 0.4) < 0.05,
    JSON.stringify(price));

  // ---- loading the same MB51 again merges, never doubles
  const again = await load(mbPath, 'MATISSUE', rd('SAP_MB51'), '2026-04-15', null, p1);
  check('re-loading MB51 replaces every line by its key', again.posted.replaced === 12 && again.posted.byLineKey,
    `${again.posted.replaced} replaced`);
  near('no doubling after a reload', num('SELECT SUM(amount) FROM v_material_issue WHERE project_key = ?', p1),
    MB51_TOTALS.issuesDatedCut);

  // ---- the Material Cost Report workbook (material:exportReport)
  db.prepare("INSERT OR REPLACE INTO material_work_package (project_key, material_code, work_package) VALUES (?, 'MAT-CEM-01', 'DIV03')").run(p1);
  const rep = await buildMaterialReport(p1);
  check('material report file name', /^P1_Material_Report_2026-03\.xlsx$/.test(rep.fileName), rep.fileName);
  const xb = new ExcelJS.Workbook();
  await xb.xlsx.load(rep.buffer as any);
  const names = xb.worksheets.map((w) => w.name);
  check('material report sheets in order', names.join(',') ===
    'Summary,Coding,Lists,_Codes,Material Summary,Material per Month,PO Register,Stores Transfers,Checks,Data,Notes,_Meta,_Cal', names.join(','));
  const countedLines = num('SELECT COUNT(*) FROM v_material_issue_all WHERE project_key = ?', p1);
  check('Data sheet has one row per counted issue line', xb.getWorksheet('Data')!.actualRowCount - 1 === countedLines,
    `${xb.getWorksheet('Data')!.actualRowCount - 1} vs ${countedLines}`);
  const cellRes = (c: any) => (c && typeof c === 'object' && 'result' in c ? c.result : c);
  const mkpi = runStoredQuery('MAT_KPI', { project_key: p1 }).rows[0] as any;
  near('Summary To date equals MAT_KPI to_date', Number(cellRes(xb.getWorksheet('Summary')!.getCell('C7').value)), Number(mkpi.to_date));
  near('Summary This month equals MAT_KPI', Number(cellRes(xb.getWorksheet('Summary')!.getCell('B7').value)), Number(mkpi.this_month));
  const cs = xb.getWorksheet('Coding')!;
  const hdr = (cs.getRow(4).values as any[]).map((v) => cellRes(v));
  const mnlCol = hdr.indexOf('MNL'), ceCol = hdr.indexOf('Cost element');
  let mnlMat = 0, rows = 0, ceFilled = 0;
  cs.eachRow((row, n) => { if (n < 5) return; rows++; if (row.getCell(mnlCol).value === 'MAT') mnlMat++;
    if (String(row.getCell(ceCol).value ?? '').trim() !== '') ceFilled++; });
  check('MNL is MAT on every coding row', rows > 0 && mnlMat === rows, `${mnlMat}/${rows}`);
  check('Cost element is left blank on every coding row', ceFilled === 0, String(ceFilled));
  let formulas = 0;
  xb.getWorksheet('Material Summary')!.eachRow((row) => row.eachCell((c) => { if (c.value && typeof c.value === 'object' && 'formula' in (c.value as any)) formulas++; }));
  check('live formulas are written', formulas > 0, String(formulas));
  const sample = process.env.MAT_SAMPLE_OUT;
  if (sample) writeFileSync(sample, rep.buffer);
  { const bad = await sheetPrOrderOk(rep.buffer); check('Material workbook: sheetPr children in schema order (Excel opens without repair)', bad.length === 0, bad.join(',')); }

  // ---- the native Material page's sheet queries (docs/port/native-report.md)
  {
    const sh = (code: string, p: Record<string, unknown> = {}) =>
      runStoredQuery(code, { project_key: p1, ...p }).rows as any[];
    const sum = (rows: any[], col: string) => rows.reduce((s, r) => s + (Number(r[col]) || 0), 0);
    const kpiNow = runStoredQuery('MAT_KPI', { project_key: p1 }).rows[0] as any;
    const mats = sh('MAT_SHEET_MATERIALS');
    near('sheets: Materials to-date sum = MAT_KPI to_date', sum(mats, 'to_date_amount'), Number(kpiNow.to_date));
    near('sheets: Materials previous + this month = to date', sum(mats, 'previous_amount') + sum(mats, 'this_month_amount'), Number(kpiNow.to_date));
    near('sheets: Materials pending sum = MAT_KPI pending', sum(mats, 'pending_amount'), Number(kpiNow.pending));
    const tot = sh('MAT_SHEET_TOTALS')[0];
    near('sheets: TOTAL row = MAT_KPI to_date', Number(tot.to_date), Number(kpiNow.to_date));
    // filters are SQL: the coded package, an uncoded one, a division, a month, a search
    near('sheets: :pkg DIV03 keeps the coded cement only', sum(sh('MAT_SHEET_MATERIALS', { pkg: 'DIV03' }), 'to_date_amount'), 280_000);
    near('sheets: :pkg (none) is everything not coded', sum(sh('MAT_SHEET_MATERIALS', { pkg: '(none)' }), 'to_date_amount'), Number(kpiNow.to_date) - 280_000);
    const opts = sh('MAT_FILTER_OPTIONS');
    const fam = opts.filter((o) => o.kind === 'family')[0];
    check('sheets: filter options list family, division, pkg and month',
      ['family', 'division', 'pkg', 'month'].every((k) => opts.some((o) => o.kind === k)), JSON.stringify(opts.map((o) => o.kind)));
    near('sheets: a :family filter reduces the total to that family\'s share',
      sum(sh('MAT_SHEET_MATERIALS', { family: fam.value }), 'to_date_amount'),
      sum(sh('MAT_COST_BY_FAMILY').filter((f) => f.code === fam.value), 'to_date'));
    const div = opts.find((o) => o.kind === 'division' && o.value === 'M03');
    check('sheets: division M03 is an option', !!div, JSON.stringify(opts.filter((o) => o.kind === 'division')));
    near('sheets: :division M03 keeps the rebar only', sum(sh('MAT_SHEET_MATERIALS', { division: 'M03' }), 'to_date_amount'), 150_000);
    near('sheets: :month 2026-02 keeps that month', sum(sh('MAT_SHEET_MATERIALS', { month: '2026-02' }), 'to_date_amount'), 400_000);
    near('sheets: :q searches code and description', sum(sh('MAT_SHEET_MATERIALS', { q: 'rebar' }), 'to_date_amount'), 150_000);
    check('sheets: a :family that matches nothing leaves no rows', sh('MAT_SHEET_MATERIALS', { family: 'ZZZ' }).length === 0);
    // the Summary tables tie to the KPI whichever dimension they split on
    for (const dim of ['family', 'division', 'pkg']) {
      near(`sheets: cost by ${dim} sums to MAT_KPI to_date`, sum(sh('MAT_SHEET_BY_DIM', { dim }), 'to_date'), Number(kpiNow.to_date));
    }
    near('sheets: cost per month table total = MAT_KPI to_date', sum(sh('MAT_SHEET_MONTH_TABLE'), 'total'), Number(kpiNow.to_date));
    near('sheets: cost per month by type total = MAT_KPI to_date', sum(sh('MAT_SHEET_MONTH_TYPE'), 'amount'), Number(kpiNow.to_date));
    const mm = sh('MAT_SHEET_MATERIAL_MONTH');
    near('sheets: Material per Month "To date" column = MAT_KPI to_date', sum(mm.filter((r) => r.period === 'To date'), 'amount'), Number(kpiNow.to_date));
    near('sheets: Material per Month months add up to the same', sum(mm.filter((r) => r.period !== 'To date'), 'amount'), Number(kpiNow.to_date));
    // Lines: one row per counted issue line, all of them; pending only when asked for
    const counted = num('SELECT COUNT(*) FROM v_material_issue WHERE project_key = ?', p1);
    const lines = sh('MAT_SHEET_LINES');
    check('sheets: Lines has one row per counted issue line', lines.length === counted, `${lines.length} vs ${counted}`);
    near('sheets: Lines amount = MAT_KPI to_date', sum(lines, 'amount'), Number(kpiNow.to_date));
    check('sheets: Lines with include_pending adds the held-back ones',
      sh('MAT_SHEET_LINES', { include_pending: 1 }).length === num('SELECT COUNT(*) FROM v_material_issue_all WHERE project_key = ?', p1));
    check('sheets: Lines drill-down narrows to one material',
      sh('MAT_SHEET_LINES', { material_code: 'MAT-CEM-01' }).length === 3
      && sh('MAT_SHEET_LINES', { material_code: 'MAT-CEM-01' }).every((r) => r.material_code === 'MAT-CEM-01'));
    // ME2N: purchase lines and stores transfers partition the non-deleted lines
    const po = sh('MAT_SHEET_PO_REGISTER'), sto = sh('MAT_SHEET_STO');
    check('sheets: PO register + stores transfers = every non-deleted ME2N line',
      po.length + sto.length === num('SELECT COUNT(*) FROM v_po_material_line WHERE project_key = ? AND is_deleted = 0', p1),
      `${po.length} + ${sto.length}`);
    check('sheets: the stores transfer is the plant-code supplier line', sto.length === 1 && sto[0].from_store === 'SBD1', JSON.stringify(sto));
    near('sheets: PO register open value = sum of open_value on purchase lines', sum(po, 'open_value'),
      num("SELECT COALESCE(SUM(open_value), 0) FROM v_po_material_line WHERE project_key = ? AND is_deleted = 0 AND NOT (kind = 'STO' AND COALESCE(net_value, 0) = 0)", p1));
    const pom = sh('MAT_SHEET_PO_MATERIALS');
    near('sheets: PO by material issued amount follows MB51 to date',
      sum(pom, 'issued_amount'), sum(mats.filter((m) => pom.some((p) => p.material_code === m.material_code)), 'to_date_amount'));
    check('sheets: Coding lists every issued material and flags the uncoded ones',
      sh('MAT_SHEET_CODING').length === mats.length && sum(sh('MAT_SHEET_CODING'), 'to_code') === mats.filter((m) => m.pkg === '(none)').length);
  }

}

/** Excel rejects a sheet whose <sheetPr> has <pageSetUpPr> before <outlinePr> (ExcelJS 4.4.0 order). */
/**
 * Actual-cost source architecture (plan rev. 4): where a category's detail source is
 * loaded it replaces that category's CJI3 lines in v_actual_cost - certificates per PO,
 * order detail per order, MB51 per project - reconciled (COST_SOURCE_RECON), never added.
 * Rows are written straight to the fact tables so every figure is known by construction.
 */
async function costSources(dir: string): Promise<void> {
  console.log('\n--- cost sources: certificates / order detail replace CJI3 (v_actual_cost) ---');
  openDatabase(join(dir, 'costsources.db'));
  const db = getDb();
  const one = (sql: string, ...args: unknown[]) => db.prepare(sql).get(...args) as any;
  const num = (sql: string, ...args: unknown[]) => Number((Object.values(one(sql, ...args))[0]) ?? 0);
  const pk = Number(db.prepare('INSERT INTO dim_project (project_code, project_name) VALUES (?,?)')
    .run('P-SRC', 'Cost sources').lastInsertRowid);
  const wbs = Number(db.prepare(
    'INSERT INTO dim_wbs (project_key, wbs_code, wbs_name, wbs_path) VALUES (?,?,?,?)')
    .run(pk, 'P-SRC.01', 'Works', '/P-SRC/01/').lastInsertRowid);
  const ce = (code: string, type: string) => Number(db.prepare(
    'INSERT INTO dim_cost_element (cost_element_code, cost_element_name, cost_type) VALUES (?,?,?)')
    .run(code, 'GL ' + code, type).lastInsertRowid);
  const ceSub = ce('30500100', 'SUBCONTRACT'), ceLab = ce('30100100', 'LABOR'), ceMat = ce('30200100', 'MATERIAL'),
    ceSettle = ce('30900100', 'INDIRECT'), ceGa = ce('30990100', 'GA'),
    ceEqu = ce('30600100', 'EQUIPMENT'), ceFleet = ce('30610100', 'FLEET'), ceHouse = ce('30620100', 'HOUSING');
  const batch = (rd: number, module: string) => Number(db.prepare(`INSERT INTO import_batch
    (report_definition_id, module, data_date, period_key, project_key, file_name, status, row_count_file, row_count_posted)
    VALUES (?,?,'2026-02-28','2026-02',?,'synthetic','POSTED',1,1)`).run(rd, module, pk).lastInsertRowid);
  const bA = batch(1, 'ACTUAL'), bS = batch(7, 'SERVICE'), bO = batch(9, 'ORDER');

  // ---- CJI3 (240,000 of it will be set aside; 87,000 stays)
  const insA = db.prepare(`INSERT INTO fact_actual
    (import_batch_id, project_key, wbs_key, cost_element_key, period_key, amount, document_no, po_no,
     partner_object_type, partner_object) VALUES (?,?,?,?,'2026-02',?,?,?,?,?)`);
  let doc = 0;
  const cji3 = (cek: number, amount: number, po: string | null = null, order: string | null = null) =>
    insA.run(bA, pk, wbs, cek, amount, String(100000 + ++doc), po, order ? 'Order' : null, order);
  cji3(ceSub, 100_000, '4500001');          // PO has certificates -> set aside
  cji3(ceSub, 60_000, '4500002');           // PO has certificates -> set aside
  cji3(ceSub, 30_000, '4500003');           // PO with no certificates -> kept
  cji3(ceLab, 20_000);                      // kept
  cji3(ceMat, 10_000);                      // no MB51 for this project -> kept
  cji3(ceSettle, 80_000, null, 'ORD1');     // order settlement, ORD1 has WBS detail -> set aside
  cji3(ceSettle, 15_000, null, 'ORD2');     // no detail for ORD2 -> kept
  cji3(ceSettle, 5_000, null, 'ORD3');      // ORD3 detail is cost-centre only -> kept
  cji3(ceGa, 7_000);                        // G&A: CJI3 only -> kept
  near('CJI3 total (v_actual)', num('SELECT SUM(amount) FROM v_actual WHERE project_key = ?', pk), 327_000);

  // ---- certificates: PO 4500001 and 4500002 (+ one not approved line, held back as pending)
  const insC = db.prepare(`INSERT INTO fact_service_line
    (import_batch_id, project_key, wbs_key, cost_element_key, period_key, invoice_date_key, po_no, invoice_no, invoice_serial,
     item_no, line_no, service_code, service_text, amount_net, quantity_current, unit_rate, is_approved, is_opening)
    VALUES (?,?,?,?,'2026-02',20260215,?,?,?,'10','1',?,?,?,1,?,?,0)`);
  let ser = 0;
  const cert = (po: string, code: string, text: string, amount: number, approved = 1) =>
    insC.run(bS, pk, wbs, ceSub, po, 'INV' + po, String(++ser), code, text, amount, amount, approved);
  cert('4500001', 'S0101', 'Block work', 60_000);
  cert('4500001', 'S0201', 'Hire of crane', 25_000);
  cert('4500001', 'S0101', 'Block work', 7_000, 0);   // not approved -> pending
  cert('4500002', 'S0301', 'Labour gang', 20_000);
  cert('4500002', 'S0401', 'Plaster', 30_000);

  // ---- ZINT01 order detail: ORD1 settled (WBS 79,000 + a cost-centre line), ORD3 only on a cost centre
  const insO = db.prepare(`INSERT INTO fact_order_line
    (import_batch_id, project_key, wbs_key, cost_element_key, period_key, order_no, category, amount)
    VALUES (?,?,?,?,'2026-02',?,?,?)`);
  insO.run(bO, pk, wbs, ceEqu, 'ORD1', 'WBS', 50_000);
  insO.run(bO, pk, wbs, ceFleet, 'ORD1', 'WBS', 20_000);
  insO.run(bO, pk, wbs, ceHouse, 'ORD1', 'WBS', 9_000);
  insO.run(bO, pk, wbs, ceEqu, 'ORD1', 'CTR', 3_000);
  insO.run(bO, pk, wbs, ceEqu, 'ORD3', 'CTR', 4_000);

  const total = () => num('SELECT SUM(amount) FROM v_actual_cost WHERE project_key = ?', pk);
  const byType = (): Record<string, number> => Object.fromEntries((db.prepare(
    `SELECT COALESCE(cost_type,'?') t, SUM(amount) a FROM v_actual_cost WHERE project_key = ? GROUP BY 1`).all(pk) as any[])
    .map((r) => [r.t, r.a]));
  const bySource = (): Record<string, number> => Object.fromEntries((db.prepare(
    'SELECT source s, SUM(amount) a FROM v_actual_cost WHERE project_key = ? GROUP BY 1').all(pk) as any[])
    .map((r) => [r.s, r.a]));

  // ---- certificates replace the CJI3 subcontract postings per PO
  near('certificates To date = counted lines (pending 7,000 held back)', num(
    'SELECT SUM(amount_net) FROM v_service_line WHERE project_key = ? AND pend_reason IS NULL', pk), 135_000);
  check('the not-approved certificate line stays out of v_actual_cost', num(
    "SELECT COUNT(*) FROM v_actual_cost WHERE project_key = ? AND source = 'CERT' AND amount = 7000", pk) === 0);
  check('CJI3 subcontract postings of POs with certificates are excluded', num(
    "SELECT COUNT(*) FROM v_actual_cost WHERE project_key = ? AND source = 'CJI3' AND amount IN (100000, 60000)", pk) === 0);
  near('a PO without certificates keeps its CJI3 amount', num(
    "SELECT SUM(amount) FROM v_actual_cost WHERE project_key = ? AND source = 'CJI3' AND cost_type = 'SUBCONTRACT'", pk), 30_000);
  near('SUBCONTRACT headline = PO without certificates 30,000 + certificates To date 135,000',
    byType().SUBCONTRACT, 30_000 + 135_000);
  check('service MNL defaults to SUB', num("SELECT COUNT(*) FROM v_service_line WHERE project_key = ? AND mnl <> 'SUB'", pk) === 0);

  // ---- a service coded LAB / EQU moves to Labor / Equipment
  db.prepare('INSERT INTO service_mnl (project_key, service_code, service_text, mnl) VALUES (?,?,?,?)').run(pk, 'S0301', 'Labour gang', 'LAB');
  db.prepare('INSERT INTO service_mnl (project_key, service_code, service_text, mnl) VALUES (?,?,?,?)').run(pk, 'S0201', 'Hire of crane', 'EQU');
  check('v_service_line carries the override', one(
    "SELECT mnl m FROM v_service_line WHERE project_key = ? AND service_code = 'S0301'", pk).m === 'LAB');
  const t = byType();
  near('SUBCONTRACT = PO without certificates 30,000 + block work 60,000 + plaster 30,000', t.SUBCONTRACT, 120_000);
  near('LABOR = CJI3 labour 20,000 + labour gang certificate 20,000', t.LABOR, 40_000);
  near('EQUIPMENT = crane certificate 25,000 + ZINT01 equipment 50,000', t.EQUIPMENT, 75_000);
  near('FLEET = ZINT01 fleet detail', t.FLEET, 20_000);
  near('HOUSING = ZINT01 house rent detail', t.HOUSING, 9_000);
  near('MATERIAL (no MB51) keeps CJI3', t.MATERIAL, 10_000);
  near('G&A is CJI3 only', t.GA, 7_000);
  near('INDIRECT = the two unreplaced settlements (ORD2 15,000 + ORD3 5,000)', t.INDIRECT, 20_000);

  // ---- order settlement: CJI3 posting replaced by WBS detail, CTR excluded
  check('the ORD1 settlement posting is set aside, ORD2 and ORD3 stay', num(
    "SELECT COUNT(*) FROM v_actual_cost WHERE project_key = ? AND source = 'CJI3' AND amount IN (15000, 5000)", pk) === 2
    && num("SELECT COUNT(*) FROM v_actual_cost WHERE project_key = ? AND source = 'CJI3' AND amount = 80000", pk) === 0);
  near('order detail in the headline = WBS rows only (79,000; the 3,000 and 4,000 cost-centre lines excluded)',
    bySource().ORDER, 79_000);

  // ---- no double count anywhere: total = sum of parts
  const s = bySource();
  near('sources: CJI3 kept', s.CJI3, 87_000);
  near('sources: certificates', s.CERT, 135_000);
  near('sources: order detail', s.ORDER, 79_000);
  near('headline total = 87,000 kept + 135,000 certificates + 79,000 order detail', total(), 301_000);
  near('by cost type adds up to the headline', Object.values(byType()).reduce((a, b) => a + Number(b), 0), 301_000);
  near('v_actual - set aside + detail = headline', num('SELECT SUM(amount) FROM v_actual WHERE project_key = ?', pk)
    - num('SELECT SUM(amount) FROM v_actual_set_aside WHERE project_key = ?', pk) + s.CERT + s.ORDER, total());
  near('KPI_PROJECT actual follows v_actual_cost', Number((runStoredQuery('KPI_PROJECT', { project_key: pk }).rows[0] as any).actual_cost), 301_000);
  near('ACT_BY_COST_TYPE sums to the headline', (runStoredQuery('ACT_BY_COST_TYPE', { project_key: pk, period_to: null }).rows as any[])
    .reduce((a, r) => a + Number(r.actual_amount), 0), 301_000);
  const pkg = runStoredQuery('PKG_SUMMARY', { project_key: pk });
  near('PKG_SUMMARY counts each certificate once (package split = headline)',
    (pkg.rows as any[]).reduce((a, r) => a + Number(r.actual_amount), 0), 301_000);

  // ---- the reconciliation check
  const rec = (runStoredQuery('COST_SOURCE_RECON', { project_key: pk }).rows as any[]);
  const row = (src: string, type: string) => rec.find((r) => r.source === src && r.cost_type === type);
  const ct = row('CERT', 'TOTAL'), ot = row('ORDER', 'TOTAL'), mt = row('MB51', 'TOTAL');
  check('recon CERT: loaded, CJI3 160,000 set aside vs 135,000 certificates', ct?.detail_loaded === 1
    && ct.cji3_set_aside === 160_000 && ct.detail_amount === 135_000, JSON.stringify(ct));
  near('recon CERT: difference -25,000 (timing / not yet certified)', ct?.difference, -25_000);
  near('recon CERT: CJI3 subcontract kept for the PO without certificates', ct?.cji3_kept, 30_000);
  check('recon ORDER: CJI3 80,000 set aside vs 79,000 detail, difference -1,000', ot?.detail_loaded === 1
    && ot.cji3_set_aside === 80_000 && ot.detail_amount === 79_000 && ot.difference === -1_000, JSON.stringify(ot));
  check('recon ORDER by type: equipment / fleet / house rent detail', row('ORDER', 'EQUIPMENT')?.detail_amount === 50_000
    && row('ORDER', 'FLEET')?.detail_amount === 20_000 && row('ORDER', 'HOUSING')?.detail_amount === 9_000
    && row('ORDER', 'INDIRECT')?.cji3_set_aside === 80_000);
  check('recon MB51: not loaded, CJI3 material stays the actual', mt?.detail_loaded === 0
    && mt.cji3_set_aside === 0 && mt.detail_amount === 0 && mt.cji3_kept === 10_000, JSON.stringify(mt));
  check('recon CERT by type: labor 20,000 and equipment 25,000 detail have no CJI3 side', row('CERT', 'LABOR')?.detail_amount === 20_000
    && row('CERT', 'EQUIPMENT')?.detail_amount === 25_000 && row('CERT', 'SUBCONTRACT')?.detail_amount === 90_000);

  // ---- clearing the override puts the service back
  db.prepare('DELETE FROM service_mnl WHERE project_key = ?').run(pk);
  near('without overrides every certificate is SUBCONTRACT again', byType().SUBCONTRACT, 165_000);

  // ---- the cut-off holds back certificates and order detail; "detail loaded" does not flip
  db.prepare("INSERT INTO project_cutoff (project_key, cutoff_date) VALUES (?, '2026-01-31')").run(pk);
  near('cut-off before the data: nothing counts', total(), 0);
  const rec2 = (runStoredQuery('COST_SOURCE_RECON', { project_key: pk }).rows as any[]);
  check('cut-off does not flip a PO / order between sources',
    rec2.find((r) => r.source === 'CERT' && r.cost_type === 'TOTAL')?.detail_loaded === 1
    && rec2.find((r) => r.source === 'ORDER' && r.cost_type === 'TOTAL')?.detail_loaded === 1);
  db.prepare("UPDATE project_cutoff SET cutoff_date = '2026-02-28' WHERE project_key = ?").run(pk);
  near('cut-off at month end: everything counts', total(), 301_000);
  db.prepare('DELETE FROM project_cutoff WHERE project_key = ?').run(pk);

  // ---- the rule table is data: switching a source off puts CJI3 back
  db.prepare("UPDATE cost_source_rule SET is_active = 0 WHERE source = 'ORDER'").run();
  near('ORDER rules inactive: no order detail in the headline', bySource().ORDER ?? 0, 0);
  near('...settlement postings are the actual again: CJI3 + certificates only', total(), 327_000 - 160_000 + 135_000);
  db.prepare("UPDATE cost_source_rule SET is_active = 1 WHERE source = 'ORDER'").run();
  check('future sources are present but inactive', num(
    "SELECT COUNT(*) FROM cost_source_rule WHERE source IN ('LABOUR','ASSET') AND is_active = 0") === 2);

  // ---- cost types
  const types = Object.fromEntries((db.prepare('SELECT code, label, mnl FROM dim_cost_type').all() as any[]).map((r) => [r.code, r]));
  check('new cost types seeded', types.FLEET?.label === 'Fleet / Transportation rent' && types.FLEET.mnl === 'EQU'
    && types.HOUSING?.label === 'House rent' && types.DEPRECIATION?.label === 'Asset depreciation'
    && types.GA?.label === 'G&A (Finance – HR)' && types.EQUIPMENT.label === 'Equipment / Fuel');
  check('the old Asset Depreciation type is kept (marked legacy), not deleted', /legacy/.test(types.ASSET_DEPRECIATION?.label ?? ''),
    String(types.ASSET_DEPRECIATION?.label));

  // ---- the Actual cost register (REG_*) reads v_actual_cost and adds up to it
  const regAll = (q: string, extra: Record<string, unknown> = {}) =>
    runStoredQuery(q, { project_key: pk, rows_by: null, source: null, cost_type: null, item_key: null, ...extra }).rows as any[];
  const headline = num(`SELECT SUM(amount) FROM v_actual_cost WHERE project_key = ${pk}`);
  near('REG_KPI actual to cut-off = v_actual_cost', Number(regAll('REG_KPI')[0].actual_to_cutoff), headline);
  for (const rb of ['item', 'package', 'wbs']) {
    near(`REG_MONTHLY by ${rb} adds up to the headline`, regAll('REG_MONTHLY', { rows_by: rb }).reduce((t, r) => t + Number(r.amount), 0), headline);
  }
  const regRows = regAll('REG_MONTHLY');
  const present = (db.prepare(`SELECT DISTINCT source s FROM v_actual_cost WHERE project_key = ?`).all(pk) as any[]).map((r) => r.s);
  check('REG_MONTHLY names every source present on its rows', present.length >= 2
    && present.every((x) => regRows.some((r) => String(r.src).split(',').includes(x))),
    `present ${present.join(',')} / rows ${[...new Set(regRows.map((r) => r.src))].join(',')}`);
  const top = regRows[0];
  near('REG_LINES of one row add up to that row', regAll('REG_LINES', { cost_type: `~${top.cost_type}`, item_key: `~${top.item_key}` })
    .reduce((t, r) => t + Number(r.amount), 0), Number(top.item_total));
  near('REG_MONTHLY source filter keeps only that source', regAll('REG_MONTHLY', { source: 'MB51' }).reduce((t, r) => t + Number(r.amount), 0),
    num(`SELECT SUM(amount) FROM v_actual_cost WHERE project_key = ${pk} AND source = 'MB51'`));
  const book = await buildRegisterWorkbook(pk, null, null);
  const wbk = new ExcelJS.Workbook(); await wbk.xlsx.load(book.buffer as any);
  check('register workbook sheets: Per month, Lines', wbk.worksheets.map((w) => w.name).join(',') === 'Per month,Lines',
    wbk.worksheets.map((w) => w.name).join(','));
  { const bad = await sheetPrOrderOk(book.buffer); check('register workbook: sheetPr children in schema order (Excel opens without repair)', bad.length === 0, bad.join(',')); }
}

/**
 * The build workspace: step statuses (BUILD_STATUS), the checks behind them and
 * report readiness (REPORT_READINESS), from a fresh project through each load.
 * Every upload step is judged at the project cut-off; Subcontractors and
 * Materials are standalone reports that do not wait for CJI3.
 */
async function buildWorkspace(dir: string): Promise<void> {
  console.log('\n--- build workspace: step status, checks, report readiness ---');
  openDatabase(join(dir, 'build.db'));
  const db = getDb();
  const rd = (code: string) => Number((db.prepare(
    'SELECT report_definition_id id FROM report_definition WHERE code = ?').get(code) as any).id);
  const mk = (code: string, name: string) => Number(db.prepare(
    'INSERT INTO dim_project (project_code, project_name) VALUES (?,?)').run(code, name).lastInsertRowid);
  const steps = (p: number): Record<string, any> => Object.fromEntries(
    (runStoredQuery('BUILD_STATUS', { project_key: p }).rows as any[]).map((r) => [r.step_code, r]));
  const ready = (p: number): Record<string, any> => Object.fromEntries(
    (runStoredQuery('REPORT_READINESS', { project_key: p }).rows as any[]).map((r) => [r.report_page, r]));
  const checks = (p: number, step: string) => (runStoredQuery('BUILD_CHECKS', { project_key: p }).rows as any[])
    .filter((r) => r.step_code === step);
  const st = (p: number) => Object.fromEntries(Object.entries(steps(p)).map(([k, v]) => [k, v.status]));
  const setCutoff = (p: number, d: string | null) => {
    if (d === null) db.prepare('DELETE FROM project_cutoff WHERE project_key = ?').run(p);
    else db.prepare(`INSERT INTO project_cutoff (project_key, cutoff_date) VALUES (?, ?)
                     ON CONFLICT(project_key) DO UPDATE SET cutoff_date = excluded.cutoff_date`).run(p, d);
  };
  const same = (label: string, actual: unknown, expected: unknown) =>
    check(label, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}`);

  // ---- seed data: steps, links, inputs ----
  const empty = mk('P-B00', 'Empty');
  const seeded = Object.keys(steps(empty));
  check('16 build steps seeded (B01-B12, B15-B18; no B13/B14)', seeded.length === 16
    && !seeded.includes('B13') && !seeded.includes('B14'), seeded.join(','));
  same('steps load through their report definitions', (db.prepare(
    `SELECT s.step_code, GROUP_CONCAT(rd.code) c FROM build_step_report s
     JOIN report_definition rd USING (report_definition_id)
     WHERE s.step_code IN ('B05','B06','B07','B08','B09','B10') GROUP BY s.step_code ORDER BY s.step_code`).all() as any[])
    .map((r) => `${r.step_code}:${r.c}`),
    ['B05:SAP_ORDER_DETAIL', 'B06:SAP_MB51', 'B07:SAP_SC_REPORT', 'B08:SAP_ZSCSRV1', 'B09:SAP_ME2N', 'B10:SAP_MM60']);
  check('signature captions seeded on the report definitions', JSON.parse(
    (db.prepare("SELECT signature_columns s FROM report_definition WHERE code = 'SAP_ZSCSRV1'").get() as any).s)[1]
    === 'PO Service Code');

  // ---- a fresh project: nothing loaded ----
  const p1 = mk('P-B01', 'Build plant');
  same('fresh project: every step Ready / Waiting / Optional', st(p1), {
    B01: 'Complete', B04: 'Ready to load', B11: 'Waiting', B07: 'Ready to load',
    B08: 'Ready to load', B15: 'Not available', B18: 'Waiting', B06: 'Ready to load', B09: 'Ready to load',
    B10: 'Ready to load', B05: 'Waiting', B16: 'Optional', B17: 'Optional', B02: 'Optional', B03: 'Optional', B12: 'Waiting',
  });
  let r = ready(p1);
  same('fresh project: every report Waiting',
    Object.values(r).map((x: any) => `${x.report_page}:${x.status}`).sort(),
    ['costreport:Waiting', 'dashboard:Waiting', 'material:Waiting', 'reports:Waiting', 'subcontractor:Waiting']);
  check('Waiting names what is missing', /B04/.test(r.dashboard.missing) && /B07/.test(r.subcontractor.missing)
    && /B06/.test(r.material.missing), r.dashboard.missing);

  // ---- CJI3 ----
  const cji3 = join(dir, 'build-cji3.xlsx');
  await makeCji3File(cji3);
  await load(cji3, 'ACTUAL', 6, '2026-03-31', null, p1);
  // the fixture has no partner-object columns: make the cement delivery a settlement from an order
  db.prepare(`UPDATE fact_actual SET partner_object_type = 'Order', partner_object = 'ORD9'
              WHERE project_key = ? AND document_no = 'D3'`).run(p1);
  let s = steps(p1);
  check('CJI3 posted -> B04 Complete', s.B04.status === 'Complete', s.B04.status);
  check('B04 carries lines, data date and latest posting', s.B04.lines === 6 && s.B04.data_date === '2026-03-31'
    && s.B04.latest_posting === '2026-03-31', `${s.B04.lines} ${s.B04.data_date} ${s.B04.latest_posting}`);
  check('settled order without ZINTC1 detail -> B05 Needs action', s.B05.status === 'Needs action', s.B05.status);
  check('B05 check says how many orders lack detail',
    checks(p1, 'B05').some((c) => c.level === 'todo' && /1 settled orders/.test(c.message)),
    JSON.stringify(checks(p1, 'B05')));
  check('unallocated subcontract cost -> B12 Needs action', s.B12.status === 'Needs action', s.B12.summary);
  const otherGls = Number((db.prepare(
    `SELECT COUNT(DISTINCT cost_element_code) n FROM v_actual WHERE project_key = ? AND (cost_type IS NULL OR cost_type = 'OTHER')`)
    .get(p1) as any).n);
  check('B11 follows the GLs resolving to Other', s.B11.status === (otherGls > 0 ? 'Needs action' : 'Complete'),
    `${s.B11.status} - ${s.B11.summary}`);
  check('B15 is planned, not loadable', s.B15.status === 'Not available');
  r = ready(p1);
  check('Home no longer Waiting once B04 is in', r.dashboard.status !== 'Waiting', `${r.dashboard.status}: ${r.dashboard.missing}`);
  check('WBS and budget are what Home still improves with',
    /B02/.test(r.dashboard.missing) && /B03/.test(r.dashboard.missing), r.dashboard.missing);
  check('Subcontractors and Materials stay Waiting without their own sheets',
    r.subcontractor.status === 'Waiting' && r.material.status === 'Waiting');

  // ---- a cut-off after the CJI3 data ----
  setCutoff(p1, '2026-06-30');
  s = steps(p1);
  check('cut-off after the CJI3 data -> B04 Behind cut-off', s.B04.status === 'Behind cut-off', `${s.B04.status} ${s.B04.summary}`);
  check('the Behind cut-off check is a warning', checks(p1, 'B04').some((c) => c.level === 'warn'));
  check('B05 still counts a Behind cut-off B04 as loaded', s.B05.status === 'Needs action', s.B05.status);
  check('Home turns Behind cut-off', ready(p1).dashboard.status === 'Behind cut-off', ready(p1).dashboard.status);
  setCutoff(p1, '2026-02-15');
  check('cut-off inside the data: B04 reaches the cut-off month', steps(p1).B04.status === 'Complete', steps(p1).B04.status);
  check('lines after the cut-off are reported on B04', checks(p1, 'B04').some((c) =>
    c.level === 'warn' && /after the cut-off/.test(c.message)), JSON.stringify(checks(p1, 'B04')));
  setCutoff(p1, null);
  check('clearing the cut-off restores Complete', steps(p1).B04.status === 'Complete');

  // ---- a staged file that is not posted ----
  const sheet = (await readWorkbook(cji3)).sheets[0];
  const staged = await stageFile({
    filePath: cji3, fileName: 'build-cji3-new.xlsx', fileHash: 'build-new', fileSize: 1, sheetName: sheet.sheetName,
    headerRow: sheet.headerRow, module: 'ACTUAL', reportDefinitionId: 6, dataDate: '2026-04-30', periodKey: null,
    projectKey: p1, scenarioKey: null, notes: null,
    mapping: Object.entries(suggestMapping('ACTUAL', sheet.columns))
      .map(([target_field, source_column]) => ({ target_field, source_column })),
    saveMapping: false,
  }, 'e2e');
  check('a staged, unposted file -> B04 Needs action', steps(p1).B04.status === 'Needs action', steps(p1).B04.status);
  check('and says so', checks(p1, 'B04').some((c) => c.level === 'todo' && /staged/.test(c.message)));
  db.prepare("UPDATE import_batch SET status = 'REJECTED' WHERE import_batch_id = ?").run(staged.importBatchId);
  check('a rejected batch no longer needs action', steps(p1).B04.status === 'Complete');

  // ---- certificates + PO lines, no CJI3: Subcontractors is standalone ----
  const p2 = mk('P-B02', 'Subcontract only');
  const certPath = join(dir, 'build-zscprog01.xlsx');
  await makeCertificateFile(certPath);
  await load(certPath, 'SERVICE', 7, '2026-02-28', null, p2);
  s = steps(p2);
  check('certificates posted -> B07 Complete', s.B07.status === 'Complete', `${s.B07.status} ${s.B07.summary}`);
  check('B08 still Ready to load', s.B08.status === 'Ready to load', s.B08.status);
  check('services without an MNL decision -> B18 Needs action', s.B18.status === 'Needs action', s.B18.summary);
  r = ready(p2);
  check('certificates alone: Subcontractors Waiting for B08',
    r.subcontractor.status === 'Waiting' && /B08/.test(r.subcontractor.missing), `${r.subcontractor.status} ${r.subcontractor.missing}`);
  const poPath = join(dir, 'build-zscsrv1.xlsx');
  await makePoServiceFile(poPath);
  await load(poPath, 'PO_SERVICE', 11, '2026-02-28', null, p2);
  check('PO lines posted -> B08 Complete', steps(p2).B08.status === 'Complete', steps(p2).B08.status);
  r = ready(p2);
  check('B07 + B08 with no CJI3: Subcontractors Ready', r.subcontractor.status === 'Ready',
    `${r.subcontractor.status} ${r.subcontractor.missing}`);
  check('Home, Actual cost and Cost report stay Waiting (no CJI3)',
    r.dashboard.status === 'Waiting' && r.reports.status === 'Waiting' && r.costreport.status === 'Waiting',
    `${r.dashboard.status}/${r.reports.status}/${r.costreport.status}`);
  check('Materials Waiting on the same project', r.material.status === 'Waiting');
  check('B11 Waiting on B04', steps(p2).B11.status === 'Waiting', steps(p2).B11.status);
  check('B07 has detail rows from the existing checks', checks(p2, 'B07').length >= 1);
  db.prepare(`INSERT OR REPLACE INTO service_mnl (project_key, service_code, service_text, mnl)
              SELECT DISTINCT project_key, COALESCE(service_code,''), COALESCE(service_text,''), 'SUB'
              FROM v_service_line_all WHERE project_key = ?`).run(p2);
  check('every service decided -> B18 Complete', steps(p2).B18.status === 'Complete', steps(p2).B18.summary);
  check('a decision on B18 does not change Subcontractors readiness', ready(p2).subcontractor.status === 'Ready');

  // ---- Materials: MB51 alone, then ME2N, then the material list (MB52) ----
  const p3 = mk('P-B03', 'Materials only');
  await load(await fixture(dir, 'build-mb51.xlsx', makeMb51File), 'MATISSUE', rd('SAP_MB51'), '2026-03-31', null, p3);
  s = steps(p3);
  check('MB51 posted -> B06 Complete', s.B06.status === 'Complete', `${s.B06.status} ${s.B06.summary}`);
  check('B09 / B10 still Ready to load', s.B09.status === 'Ready to load' && s.B10.status === 'Ready to load');
  r = ready(p3);
  check('MB51 alone: Materials Waiting for ME2N and MB52', r.material.status === 'Waiting'
    && /B09/.test(r.material.missing) && /B10/.test(r.material.missing), `${r.material.status} ${r.material.missing}`);
  await load(await fixture(dir, 'build-me2n.xlsx', makeMe2nFile), 'MATPO', rd('SAP_ME2N'), '2026-03-31', null, p3);
  check('ME2N posted -> B09 Complete', steps(p3).B09.status === 'Complete', steps(p3).B09.status);
  check('ME2N alone: Materials still Waiting (B10)', ready(p3).material.status === 'Waiting' && /B10/.test(ready(p3).material.missing));
  await load(await fixture(dir, 'build-mm60.xlsx', makeMaterialListFile), 'MATLIST', rd('SAP_MM60'), '2026-03-31', null, null);
  check('material list (no project in the file) counts for the project with MB51 -> B10 Complete',
    steps(p3).B10.status === 'Complete', steps(p3).B10.status);
  check('B06 + B09 + B10 loaded: Materials Ready', ready(p3).material.status === 'Ready',
    `${ready(p3).material.status} ${ready(p3).material.missing}`);
  const other = steps(empty);
  check('the material list does not leak onto a project without MB51', other.B10.status === 'Ready to load', other.B10.status);
  check('B06 has its status line in BUILD_CHECKS (MAT_CHECKS warnings are fetched by Home on demand)', checks(p3, 'B06').length >= 1);
  const tl = runStoredQuery('BUILD_TIMELINE', { project_key: p3 }).rows as any[];
  const tlB06 = tl.find((r) => r.step_code === 'B06');
  check('BUILD_TIMELINE gives the MB51 file a real date span (no 0000-00-00 from undated lines)',
    !!tlB06 && /^20\d\d-/.test(tlB06.date_from) && tlB06.date_to >= tlB06.date_from, JSON.stringify(tlB06));
  check('BUILD_TIMELINE draws the material list at its data date (no dates in the file)',
    tl.some((r) => r.step_code === 'B10' && r.date_from == null && r.data_date), JSON.stringify(tl.map((r) => r.step_code)));
  const vpb = db.prepare('SELECT COUNT(*) n FROM v_project_batch WHERE project_key = ?').get(p3) as any;
  check('v_project_batch lists the MB51, ME2N and material list batches', vpb.n === 3, String(vpb.n));

  // ---- removing a project's data / the project (Settings > Projects) ----
  const count = (t: string, p: number) => (db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE project_key = ?`).get(p) as any).n;
  const p3Issues = count('fact_material_issue', p3);
  const listBatches = (db.prepare("SELECT COUNT(*) n FROM import_batch WHERE module = 'MATLIST'").get() as any).n;
  setCutoff(p1, '2026-03-31');
  const fp = projectFootprint(p1);
  check('footprint counts the project lines and files before removal', fp.lines > 0 && fp.files >= 1, JSON.stringify(fp));
  const cleared = clearProjectData(p1);
  check('remove data: the project keeps no fact lines', count('fact_actual', p1) === 0 && cleared.lines === fp.lines,
    `${count('fact_actual', p1)} left, removed ${cleared.lines} of ${fp.lines}`);
  check('remove data: its files are gone, the project and its cut-off stay',
    (db.prepare('SELECT COUNT(*) n FROM import_batch WHERE project_key = ?').get(p1) as any).n === 0
    && count('dim_project', p1) === 1 && count('project_cutoff', p1) === 1, JSON.stringify(cleared));
  check('remove data: a copy of the database was saved first', existsSync(cleared.backupPath), cleared.backupPath);
  same('remove data: CJI3 is Ready to load again and the timeline is empty',
    [steps(p1).B04.status, runStoredQuery('BUILD_TIMELINE', { project_key: p1 }).rows.length], ['Ready to load', 0]);
  const p2Lines = count('fact_service_line', p2);
  const removed = deleteProject(p2);
  check('delete project: the project row and its certificate lines are gone',
    count('dim_project', p2) === 0 && count('fact_service_line', p2) === 0 && removed.lines >= p2Lines,
    `${count('dim_project', p2)} / ${count('fact_service_line', p2)} / ${removed.lines}`);
  check('delete project: other projects and the shared material list are untouched',
    count('fact_material_issue', p3) === p3Issues
    && (db.prepare("SELECT COUNT(*) n FROM import_batch WHERE module = 'MATLIST'").get() as any).n === listBatches,
    `${count('fact_material_issue', p3)} vs ${p3Issues}`);
}

async function fixture(dir: string, name: string, make: (p: string) => Promise<void>): Promise<string> {
  const p = join(dir, name);
  await make(p);
  return p;
}

async function sheetPrOrderOk(buffer: any): Promise<string[]> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(buffer);
  const bad: string[] = [];
  for (const name of Object.keys(zip.files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))) {
    const pr = /<sheetPr\b[\s\S]*?<\/sheetPr>/.exec(await zip.file(name)!.async('string'))?.[0] ?? '';
    const o = pr.indexOf('<outlinePr'), g = pr.indexOf('<pageSetUpPr');
    if (o >= 0 && g >= 0 && g < o) bad.push(name);
  }
  return bad;
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
  await cutoffScenario(dir);
  await subcontractReport(dir);
  await scRules(dir);
  await materialIssue(dir);
  await costSources(dir);
  await buildWorkspace(dir);

  // E2E_KEEP_DIR=<path> copies the fixture databases there for manual UI review instead of deleting them.
  if (process.env.E2E_KEEP_DIR) cpSync(dir, process.env.E2E_KEEP_DIR, { recursive: true });
  rmSync(dir, { recursive: true, force: true });
  console.log(failures === 0 ? '\nAll pipeline checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
