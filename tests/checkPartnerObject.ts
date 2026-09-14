/**
 * Verify an order-settlement CJI3 line is captured correctly: mapped from the
 * real "Partner Object Type" / "Partner Object" columns, kept as an ordinary
 * actual posting (nothing excluded — there is no detail source yet to
 * substitute in for it), and its cost type still resolves via cost_type_rule.
 *
 *   npm run check:partner -- <cji3-with-orders.xlsx>
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, getDb } from '../src/main/db';
import { readWorkbook } from '../src/main/ingest/workbook';
import { suggestMapping } from '../src/main/ingest/targetFields';
import { postBatch, stageFile } from '../src/main/ingest/importer';
import type { ColumnMappingEntry } from '../src/shared/types';

const [filePath] = process.argv.slice(2);
let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
}

async function main(): Promise<void> {
  const dbPath = join(tmpdir(), 'ci-partner-object.db');
  for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
  openDatabase(dbPath);
  const db = getDb();

  const projectKey = Number(db.prepare(
    `INSERT INTO dim_project (project_code, project_name) VALUES (?,?)`)
    .run('C-DIST', 'District 5').lastInsertRowid);

  const preview = await readWorkbook(filePath);
  const sheet = preview.sheets[0];
  const suggested = suggestMapping('ACTUAL', sheet.columns);
  console.log('auto-mapped:', JSON.stringify(suggested, null, 2));

  check('Partner Object Type auto-maps', suggested.partner_object_type === 'Partner Object Type');
  check('Partner Object auto-maps', suggested.partner_object === 'Partner Object');
  check('WBS code still prefers "WBS Element" over the bare "Object" column',
    suggested.wbs_code === 'WBS Element', String(suggested.wbs_code));
  check('Document type still maps to its own column', suggested.document_type === 'Document Type');

  const mapping: ColumnMappingEntry[] = Object.entries(suggested)
    .filter(([, col]) => !!col)
    .map(([target_field, source_column]) => ({ target_field, source_column }));

  const staged = await stageFile({
    filePath, fileName: preview.fileName, fileHash: preview.fileHash, fileSize: preview.fileSize,
    sheetName: sheet.sheetName, headerRow: sheet.headerRow, module: 'ACTUAL', reportDefinitionId: 6,
    dataDate: '2026-08-31', periodKey: null, projectKey, scenarioKey: null, notes: null,
    mapping, saveMapping: false,
  }, 'test');
  console.log(`\nstaged ${staged.rowCount} rows: ${staged.validCount} valid, `
    + `${staged.skippedCount} skipped, ${staged.errorCount} errors`);

  const posted = postBatch(staged.importBatchId);
  console.log(`posted ${posted.posted} rows`);

  const rows = db.prepare(`
    SELECT document_no, document_type, cost_element_code, cost_type,
           partner_object_type, partner_object, partner_object_name, amount
    FROM v_actual WHERE project_key = ? ORDER BY document_no`).all(projectKey) as any[];

  check('every real row posted (12 real lines in the sample, 2 subtotal rows skipped)',
    rows.length === 12, String(rows.length));
  check('all settlement rows carry a blank document type, as CJI3 gives them',
    rows.every((r) => !r.document_type));
  check('all settlement rows are keyed on the internal order via Partner Object',
    rows.every((r) => r.partner_object_type === 'Order' && /^\d+$/.test(r.partner_object)));
  check('cost element 30103100 still resolves to EQUIPMENT via the existing 301* rule',
    rows.every((r) => r.cost_element_code === '30103100' && r.cost_type === 'EQUIPMENT'));

  const total = rows.reduce((s, r) => s + Number(r.amount), 0);
  console.log(`\ntotal posted: ${total.toLocaleString()}`);
  check('nothing was excluded — total equals the file\'s own control total',
    Math.abs(total - staged.amountTotal) < 0.01,
    `${total} vs ${staged.amountTotal}`);

  const orders = db.prepare(`
    SELECT partner_object, COUNT(*) n, SUM(amount) amt
    FROM v_actual WHERE project_key = ? GROUP BY partner_object ORDER BY partner_object`).all(projectKey) as any[];
  console.log(`\n${orders.length} distinct internal orders settled into this WBS:`);
  for (const o of orders) console.log(`  order ${o.partner_object}: ${o.n} line(s), ${Number(o.amt).toLocaleString()}`);

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
