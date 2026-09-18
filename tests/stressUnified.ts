/**
 * Timing harness for UNIFIED_COST_REGISTER / UNIFIED_COST_SUMMARY against a
 * synthetic dataset sized like a real multi-year project (tens of thousands
 * of postings) — there is no large real dataset in the repo (`load:real`
 * needs external files), and `npm run check:unified` only proves numeric
 * correctness on whatever small database it's pointed at.
 *
 * This is purely a timing script — no assertions, no pass/fail. It exists to
 * turn "feels slow" into a `ms` number that can be compared before and after
 * a change. Row generation is fully deterministic (index-based, no
 * Math.random()) so two runs against a freshly-built database are directly
 * comparable.
 *
 *   npm run stress:unified [-- <db>]
 *
 * With no path, a temp database is created and left in place (path is
 * printed) so a second invocation can reuse the exact same data by passing
 * that path back in — useful for comparing a code change against the same
 * dataset rather than a freshly regenerated one.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, getDb } from '../src/main/db';
import { runStoredQuery } from '../src/main/services/queryRunner';

const ACTUAL_ROWS = 80_000;
const SERVICE_ROWS = 15_000;
const ORDER_ROWS = 5_000;
const WBS_COUNT = 30;
const COST_ELEMENT_COUNT = 400;
const DOC_TYPES = ['RE', 'KR', 'SA', 'WE', 'ZP'];
const VENDOR_COUNT = 10;
const PO_COUNT = 2_000;
const ORDER_NO_COUNT = 500;
const PERIODS = 36; // 2023-01 .. 2025-12, well inside ensureCalendar's 2018-2040 range

function seed(dbPath: string): number {
  openDatabase(dbPath);
  const db = getDb();

  const projectKey = Number(db.prepare(
    `INSERT INTO dim_project (project_code, project_name) VALUES ('STRESS-1','Stress test project')`)
    .run().lastInsertRowid);

  const insWbs = db.prepare(`INSERT INTO dim_wbs (project_key, wbs_code, wbs_name, wbs_path, wbs_level)
                              VALUES (?,?,?,?,1)`);
  const wbsKeys: number[] = [];
  for (let i = 0; i < WBS_COUNT; i++) {
    const code = `WBS-${String(i).padStart(3, '0')}`;
    wbsKeys.push(Number(insWbs.run(projectKey, code, `${code} works`, `/${code}/`).lastInsertRowid));
  }

  // Most cost elements carry no explicit cost_type from the source file — the
  // realistic case, per CLAUDE.md — so v_posting's per-row correlated
  // subquery against cost_type_rule actually fires for the large majority.
  const insCe = db.prepare(`INSERT INTO dim_cost_element (cost_element_code, cost_element_name, cost_type)
                             VALUES (?,?,?)`);
  const COST_TYPES = ['LABOR', 'MATERIAL', 'SUBCONTRACT', 'EQUIPMENT', 'INDIRECT'];
  const ceKeys: number[] = [];
  for (let i = 0; i < COST_ELEMENT_COUNT; i++) {
    const code = String(30000000 + i * 100);
    const explicit = i % 10 === 0 ? COST_TYPES[i % COST_TYPES.length] : null; // ~10% stated explicitly
    ceKeys.push(Number(insCe.run(code, `Cost element ${code}`, explicit).lastInsertRowid));
  }

  const insVendor = db.prepare('INSERT INTO dim_vendor (vendor_code, vendor_name) VALUES (?,?)');
  const vendorKeys: number[] = [];
  for (let i = 0; i < VENDOR_COUNT; i++) {
    vendorKeys.push(Number(insVendor.run(`V-${i}`, `Vendor ${i}`).lastInsertRowid));
  }

  // A realistic mix of account-range GLOB rules plus a few exact allocations,
  // so the priority-ordered CASE in v_posting is genuinely walked, not empty.
  const insRule = db.prepare(`INSERT INTO cost_type_rule (priority, cost_element_glob, document_type_glob, cost_type)
                               VALUES (?,?,?,?)`);
  insRule.run(100, '300*', null, 'LABOR');
  insRule.run(110, '301*', null, 'EQUIPMENT');
  insRule.run(120, '302*', null, 'MATERIAL');
  insRule.run(130, '303*', null, 'SUBCONTRACT');
  insRule.run(900, '3*', null, 'OTHER');
  insRule.run(1, String(30000000 + 5 * 100), 'RE', 'INDIRECT'); // an exact allocation, like Settings writes

  const periods: string[] = [];
  for (let m = 0; m < PERIODS; m++) {
    const year = 2023 + Math.floor(m / 12);
    const month = (m % 12) + 1;
    periods.push(`${year}-${String(month).padStart(2, '0')}`);
  }

  const actualBatch = Number(db.prepare(`INSERT INTO import_batch
      (report_definition_id, module, data_date, period_key, project_key, file_name, status, row_count_file, row_count_posted)
      VALUES (6,'ACTUAL','2025-12-31','2025-12',?,'stress-cji3.xlsx','POSTED',?,?)`)
    .run(projectKey, ACTUAL_ROWS, ACTUAL_ROWS).lastInsertRowid);
  const serviceBatch = Number(db.prepare(`INSERT INTO import_batch
      (report_definition_id, module, data_date, period_key, project_key, file_name, status, row_count_file, row_count_posted)
      VALUES (7,'SERVICE','2025-12-31','2025-12',?,'stress-service.xlsx','POSTED',?,?)`)
    .run(projectKey, SERVICE_ROWS, SERVICE_ROWS).lastInsertRowid);
  const orderBatch = Number(db.prepare(`INSERT INTO import_batch
      (report_definition_id, module, data_date, period_key, project_key, file_name, status, row_count_file, row_count_posted)
      VALUES (9,'ORDER','2025-12-31','2025-12',?,'stress-order.xlsx','POSTED',?,?)`)
    .run(projectKey, ORDER_ROWS, ORDER_ROWS).lastInsertRowid);

  // Half the PO/order pool "has detail loaded" (excluded from direct_cost);
  // the other half is a CJI3-only posting with missing_detail = 1.
  const poWithDetail = new Set<number>();
  for (let i = 0; i < PO_COUNT; i += 2) poWithDetail.add(i);
  const orderWithDetail = new Set<number>();
  for (let i = 0; i < ORDER_NO_COUNT; i += 2) orderWithDetail.add(i);

  const insActual = db.prepare(`INSERT INTO fact_actual
      (import_batch_id, project_key, wbs_key, cost_element_key, vendor_key, period_key,
       document_no, document_type, po_no, partner_object_type, partner_object, amount, quantity)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  const run = db.transaction((n: number) => {
    for (let i = 0; i < n; i++) {
      const wbs = wbsKeys[i % WBS_COUNT];
      const ce = ceKeys[i % COST_ELEMENT_COUNT];
      const vendor = vendorKeys[i % VENDOR_COUNT];
      const period = periods[i % PERIODS];
      const docType = DOC_TYPES[i % DOC_TYPES.length];
      const amount = 1000 + (i % 5000);
      // ~30% carry a PO, ~10% settle from an internal order, the rest direct cost.
      const bucket = i % 10;
      let poNo: string | null = null, partnerType: string | null = null, partnerObj: string | null = null;
      if (bucket < 3) {
        poNo = `PO-${i % PO_COUNT}`;
      } else if (bucket === 3) {
        partnerType = 'Order';
        partnerObj = `ORD-${i % ORDER_NO_COUNT}`;
      }
      insActual.run(actualBatch, projectKey, wbs, ce, vendor, period,
        `DOC${i}`, docType, poNo, partnerType, partnerObj, amount, 1);
    }
  });
  run(ACTUAL_ROWS);

  const insService = db.prepare(`INSERT INTO fact_service_line
      (import_batch_id, project_key, wbs_key, cost_element_key, vendor_key, period_key,
       po_no, invoice_no, invoice_serial, category, uom, quantity_current, amount_net)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const runService = db.transaction((n: number) => {
    for (let i = 0; i < n; i++) {
      const poIndex = [...poWithDetail][i % poWithDetail.size];
      insService.run(serviceBatch, projectKey, wbsKeys[i % WBS_COUNT], ceKeys[i % COST_ELEMENT_COUNT],
        vendorKeys[i % VENDOR_COUNT], periods[i % PERIODS], `PO-${poIndex}`, `INV-${i}`, `C${i % 12}`,
        'Civil works', 'LS', 1, 500 + (i % 2000));
    }
  });
  runService(SERVICE_ROWS);

  const insOrder = db.prepare(`INSERT INTO fact_order_line
      (import_batch_id, project_key, wbs_key, cost_element_key, vendor_key, period_key,
       order_no, order_description, category, uom, quantity, amount)
      VALUES (?,?,?,?,?,?,?,?,'WBS',?,?,?)`);
  const runOrder = db.transaction((n: number) => {
    for (let i = 0; i < n; i++) {
      const orderIndex = [...orderWithDetail][i % orderWithDetail.size];
      insOrder.run(orderBatch, projectKey, wbsKeys[i % WBS_COUNT], ceKeys[i % COST_ELEMENT_COUNT],
        vendorKeys[i % VENDOR_COUNT], periods[i % PERIODS], `ORD-${orderIndex}`,
        'Settled order work', 'EA', 1, 300 + (i % 1500));
    }
  });
  runOrder(ORDER_ROWS);

  return projectKey;
}

function time(label: string, fn: () => { ms: number; rowCount: number; truncated: boolean }): void {
  const r = fn();
  console.log(`  ${label.padEnd(52)} ${String(r.ms).padStart(6)} ms   ${r.rowCount.toLocaleString()} rows${r.truncated ? ' (truncated)' : ''}`);
}

async function main(): Promise<void> {
  const dbPath = process.argv[2] ?? join(mkdtempSync(join(tmpdir(), 'ci-stress-')), 'stress.db');
  console.log(`Seeding ${ACTUAL_ROWS.toLocaleString()} actual / ${SERVICE_ROWS.toLocaleString()} service / `
    + `${ORDER_ROWS.toLocaleString()} order rows into ${dbPath} ...`);
  const t0 = Date.now();
  const projectKey = seed(dbPath);
  console.log(`Seeded in ${Date.now() - t0} ms.\n`);

  const narrowPeriod = { period_from: '2025-06', period_to: '2025-07' };

  console.log('UNIFIED_COST_REGISTER:');
  time('unbounded (period_from/to = null)', () => runStoredQuery('UNIFIED_COST_REGISTER',
    { project_key: projectKey, period_from: null, period_to: null }));
  time('unbounded, second run (warm cache)', () => runStoredQuery('UNIFIED_COST_REGISTER',
    { project_key: projectKey, period_from: null, period_to: null }));
  time('narrow period (2 months)', () => runStoredQuery('UNIFIED_COST_REGISTER',
    { project_key: projectKey, ...narrowPeriod }));

  console.log('\nUNIFIED_COST_SUMMARY (no period params — always full history):');
  time('full history', () => runStoredQuery('UNIFIED_COST_SUMMARY', { project_key: projectKey }));
  time('full history, second run (warm cache)', () => runStoredQuery('UNIFIED_COST_SUMMARY', { project_key: projectKey }));

  console.log(`\nDatabase left at ${dbPath} — pass this path back in to reuse the same dataset:`);
  console.log(`  npm run stress:unified -- ${dbPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
