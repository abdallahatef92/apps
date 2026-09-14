/**
 * Verify order settlement as a Detail Substitution source, end to end.
 *
 * Two things are checked against the real order-detail export:
 *   1. It maps and posts correctly on its own — auto-mapping, the category
 *      split (WBS settled vs. still on a cost centre), and the control total.
 *   2. Loaded alongside a CJI3 settlement posting for one of its own orders,
 *      the unified cost register drops that posting (superseded by the
 *      order's own detail) and does not double it — the same proof
 *      check:unified runs for the PO case, on the order-settlement path.
 *
 *   npm run check:order -- <order-detail.xlsx>
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, getDb } from '../src/main/db';
import { readWorkbook } from '../src/main/ingest/workbook';
import { suggestMapping } from '../src/main/ingest/targetFields';
import { postBatch, stageFile } from '../src/main/ingest/importer';
import { runStoredQuery } from '../src/main/services/queryRunner';
import type { ColumnMappingEntry } from '../src/shared/types';

const [filePath] = process.argv.slice(2);
let failures = 0;
const fmt = (n: unknown) => Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
}
function near(label: string, actual: number, expected: number, tol = 0.02): void {
  check(label, Math.abs(actual - expected) <= tol, `got ${fmt(actual)}, expected ${fmt(expected)}`);
}

async function main(): Promise<void> {
  const dbPath = join(tmpdir(), 'ci-order-settlement.db');
  for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
  openDatabase(dbPath);
  const db = getDb();

  const projectKey = Number(db.prepare(
    `INSERT INTO dim_project (project_code, project_name) VALUES (?,?)`)
    .run('C-DIST', 'District 5').lastInsertRowid);

  const preview = await readWorkbook(filePath);
  const sheet = preview.sheets[0];
  const suggested = suggestMapping('ORDER', sheet.columns);
  console.log('auto-mapped:', JSON.stringify(suggested, null, 2));

  check('Order auto-maps', suggested.order_no === 'Order');
  check('WBS auto-maps to wbs_code, not swallowed by Order/Object synonyms', suggested.wbs_code === 'WBS');
  check('Category auto-maps', suggested.category === 'Category');
  check('Cost element auto-maps', suggested.cost_element_code === 'Cost Element');
  check('Fiscal year reads from Year', suggested.fiscal_year === 'Year');
  check('Posting month reads from Month', suggested.period_month === 'Month');
  check('Actual amount auto-maps', suggested.amount === 'Actual');

  const mapping: ColumnMappingEntry[] = Object.entries(suggested)
    .filter(([, col]) => !!col)
    .map(([target_field, source_column]) => ({ target_field, source_column }));

  const staged = await stageFile({
    filePath, fileName: preview.fileName, fileHash: preview.fileHash, fileSize: preview.fileSize,
    sheetName: sheet.sheetName, headerRow: sheet.headerRow, module: 'ORDER', reportDefinitionId: 9,
    dataDate: '2026-09-30', periodKey: null, projectKey, scenarioKey: null, notes: null,
    mapping, saveMapping: false,
  }, 'test');
  console.log(`\nstaged ${staged.rowCount} rows: ${staged.validCount} valid, `
    + `${staged.skippedCount} skipped, ${staged.errorCount} errors`);
  const posted = postBatch(staged.importBatchId);
  console.log(`posted ${posted.posted} rows`);

  const totals = db.prepare(`
    SELECT category, COUNT(*) n, SUM(amount) amt
    FROM v_order_line WHERE project_key = ? GROUP BY category`).all(projectKey) as any[];
  console.log('\nby category:', JSON.stringify(totals.map((t) => ({ ...t, amt: fmt(t.amt) }))));

  const wbsRow = totals.find((t) => t.category === 'WBS');
  const ctrRow = totals.find((t) => t.category === 'CTR');
  check('settled-to-WBS lines are present', !!wbsRow && wbsRow.n > 0);
  check('cost-centre-only lines are present', !!ctrRow && ctrRow.n > 0);

  const fileTotal = totals.reduce((s, t) => s + Number(t.amt), 0);
  near('nothing lost or gained — posted total equals the file control total', fileTotal, staged.amountTotal);

  // ---- the substitution itself --------------------------------------------
  // Simulate the CJI3 side properly: in real use, every order that settled
  // onto a WBS shows up there too, so give each one its own settlement
  // posting here, sized to exactly what its own detail totals — otherwise the
  // register would legitimately include order detail with no matching CJI3
  // posting behind it and the totals below would not be expected to reconcile.
  const perOrder = db.prepare(`
    SELECT wbs_key, order_no, SUM(amount) amt, COUNT(*) n
    FROM v_order_line WHERE project_key = ? AND category = 'WBS'
    GROUP BY order_no, wbs_key`).all(projectKey) as any[];
  console.log(`\nsimulating a CJI3 settlement posting for each of ${perOrder.length} settled order(s)`);

  const otherActualBatch = Number(db.prepare(`INSERT INTO import_batch
    (report_definition_id, module, data_date, period_key, project_key, file_name, status, row_count_file, row_count_posted)
    VALUES (6,'ACTUAL','2026-09-30','2026-09',?, 'synthetic-cji3.xlsx', 'POSTED', 2, 2)`)
    .run(projectKey).lastInsertRowid);
  const insSettlement = db.prepare(`INSERT INTO fact_actual
    (import_batch_id, project_key, wbs_key, period_key, amount, document_no, document_type,
     partner_object_type, partner_object)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  perOrder.forEach((o, i) => insSettlement.run(
    otherActualBatch, projectKey, o.wbs_key, '2026-09', o.amt,
    `1000999${String(i).padStart(2, '0')}`, '', 'Order', o.order_no));

  const target = perOrder[0];
  // And one ordinary direct-cost line with no PO and no partner object, which
  // must always stay in the register untouched.
  db.prepare(`INSERT INTO fact_actual
    (import_batch_id, project_key, wbs_key, period_key, amount, document_no, document_type)
    VALUES (?,?,?,?,?,?,?)`).run(
    otherActualBatch, projectKey, target.wbs_key, '2026-09', 55555, '100099998', 'RE');

  const totalActual = Number((db.prepare(
    'SELECT COALESCE(SUM(amount),0) a FROM v_actual WHERE project_key = ?').get(projectKey) as any).a);

  const register = runStoredQuery('UNIFIED_COST_REGISTER',
    { project_key: projectKey, period_from: null, period_to: null });
  const bySource: Record<string, number> = {};
  for (const r of register.rows as any[]) bySource[r.source] = (bySource[r.source] ?? 0) + Number(r.amount ?? 0);
  console.log('\nregister by source:', JSON.stringify(
    Object.fromEntries(Object.entries(bySource).map(([k, v]) => [k, fmt(v)]))));

  const registerTotal = Object.values(bySource).reduce((s, v) => s + v, 0);
  near('register total equals total actual cost — no gap, no double-count', registerTotal, totalActual);

  const anySettlementStillDirect = (register.rows as any[]).some(
    (r) => r.source === 'ACTUAL' && String(r.reference).startsWith('1000999') && r.reference !== '100099998');
  check('every settled order\'s CJI3 posting is superseded, none shown as direct cost',
    !anySettlementStillDirect);

  const orderRowsForTarget = (register.rows as any[]).filter(
    (r) => r.source === 'ORDER' && r.reference === target.order_no);
  check('its own detail lines appear instead', orderRowsForTarget.length === target.n,
    String(orderRowsForTarget.length));

  const ctrLeaked = (register.rows as any[]).some((r) => r.source === 'ORDER' && r.category === 'CTR');
  check('a cost-centre-only line never enters the register', !ctrLeaked);

  const plainLineKept = (register.rows as any[]).some(
    (r) => r.source === 'ACTUAL' && r.reference === '100099998' && Number(r.amount) === 55555);
  check('an ordinary direct-cost line with no PO and no order is untouched', plainLineKept);

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
