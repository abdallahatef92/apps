/**
 * Build a demo database from the sample fixtures — used for screenshots and for
 * trying the app out before real data arrives. `npm run demo:seed -- <path>`
 */
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openDatabase, getDb } from '../src/main/db';
import { readWorkbook } from '../src/main/ingest/workbook';
import { suggestMapping } from '../src/main/ingest/targetFields';
import { postBatch, stageFile } from '../src/main/ingest/importer';
import { makeActualsFile, makeBudgetFile } from './makeFixtures';
import type { ColumnMappingEntry, Module } from '../src/shared/types';

const dbPath = process.argv[2] ?? join(process.cwd(), 'demo.db');

async function load(filePath: string, module: Module, reportId: number,
                    dataDate: string, period: string | null, projectKey: number) {
  const preview = await readWorkbook(filePath);
  const sheet = preview.sheets[0];
  const mapping: ColumnMappingEntry[] = Object.entries(suggestMapping(module, sheet.columns))
    .map(([target_field, source_column]) => ({ target_field, source_column }));
  const staged = await stageFile({
    filePath, fileName: preview.fileName, fileHash: preview.fileHash, fileSize: preview.fileSize,
    sheetName: sheet.sheetName, headerRow: sheet.headerRow, module, reportDefinitionId: reportId,
    dataDate, periodKey: period, projectKey, scenarioKey: null, notes: null, mapping, saveMapping: true,
  }, 'demo');
  postBatch(staged.importBatchId);
}

async function main(): Promise<void> {
  for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
  openDatabase(dbPath);
  const db = getDb();

  const projectKey = Number(db.prepare(
    `INSERT INTO dim_project (project_code, project_name, client_name, currency_key, contract_value)
     VALUES (?,?,?,1,?)`)
    .run('P-100', 'Riyadh Process Plant', 'Northern Energy', 14_500_000).lastInsertRowid);

  const dir = dirname(dbPath);
  const actuals = join(dir, 'demo-SAP_CJI3_2026_03.xlsx');
  const budget = join(dir, 'demo-Budget_Rev3.xlsx');
  await makeActualsFile(actuals, '2026-03-31');
  await makeBudgetFile(budget);

  await load(budget, 'BUDGET', 3, '2026-01-01', null, projectKey);
  await load(actuals, 'ACTUAL', 1, '2026-03-31', '2026-03', projectKey);

  // A simple time-phased forecast for the remaining budget, so the S-curve has
  // all three series: spread whatever is left evenly over Apr–Jun.
  const scenarioKey = Number(db.prepare(`INSERT INTO dim_scenario
    (project_key, scenario_code, scenario_name, scenario_type, version_no, data_date, is_current)
    VALUES (?,?,?,'FORECAST',1,?,1)`)
    .run(projectKey, 'FORECAST-2026-03-31', 'Forecast v1 (2026-03-31)', '2026-03-31').lastInsertRowid);

  const batchId = Number(db.prepare(`INSERT INTO import_batch
    (report_definition_id, module, data_date, period_key, project_key, file_name, status,
     row_count_file, row_count_posted)
    VALUES (4,'FORECAST',?,NULL,?,'demo-forecast.xlsx','POSTED',0,0)`)
    .run('2026-03-31', projectKey).lastInsertRowid);

  const remaining = db.prepare(`
    SELECT b.wbs_key, b.cost_element_key,
           SUM(b.budget_amount) - COALESCE((
             SELECT SUM(a.amount) FROM v_actual a
             WHERE a.wbs_key = b.wbs_key AND a.cost_element_key = b.cost_element_key), 0) AS etc
    FROM v_budget b WHERE b.project_key = ?
    GROUP BY b.wbs_key, b.cost_element_key`).all(projectKey) as any[];

  const ins = db.prepare(`INSERT INTO fact_forecast
    (import_batch_id, scenario_key, project_key, wbs_key, cost_element_key, period_key,
     forecast_amount, forecast_method) VALUES (?,?,?,?,?,?,?,'REMAINING_BUDGET')`);
  let n = 0;
  for (const r of remaining) {
    const etc = Math.max(0, Number(r.etc));
    for (const p of ['2026-04', '2026-05', '2026-06']) {
      ins.run(batchId, scenarioKey, projectKey, r.wbs_key, r.cost_element_key, p, etc / 3);
      n++;
    }
  }
  db.prepare('UPDATE import_batch SET row_count_file = ?, row_count_posted = ? WHERE import_batch_id = ?')
    .run(n, n, batchId);

  console.log(`Demo database written to ${dbPath} (${n} forecast rows).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
