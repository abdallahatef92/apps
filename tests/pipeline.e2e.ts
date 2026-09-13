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
import { makeActualsFile, makeBudgetFile } from './makeFixtures';
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

  rmSync(dir, { recursive: true, force: true });
  console.log(failures === 0 ? '\nAll pipeline checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
