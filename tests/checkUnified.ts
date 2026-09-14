/**
 * Verify the unified cost register reconciles: direct-cost lines (no PO, or PO
 * with no service detail) plus subcontract service-line detail must equal total
 * actual cost exactly, with no gaps and no double-counting.
 *
 *   npm run check:unified -- <db>
 */
import { openDatabase, getDb } from '../src/main/db';
import { runStoredQuery } from '../src/main/services/queryRunner';

const [dbPath] = process.argv.slice(2);
let failures = 0;
const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });
function near(label: string, actual: number, expected: number, tol = 0.02): void {
  if (Math.abs(actual - expected) <= tol) console.log(`  ok   ${label} — ${fmt(actual)}`);
  else { failures++; console.error(`  FAIL ${label} — got ${fmt(actual)}, expected ${fmt(expected)}`); }
}

async function main(): Promise<void> {
  openDatabase(dbPath);
  const db = getDb();
  const projectKey = (db.prepare('SELECT project_key FROM dim_project LIMIT 1').get() as any).project_key;

  const totalActual = Number((db.prepare(
    'SELECT COALESCE(SUM(amount),0) a FROM v_actual WHERE project_key = ?').get(projectKey) as any).a);
  const totalServiceNet = Number((db.prepare(
    'SELECT COALESCE(SUM(amount_net),0) a FROM v_service_line WHERE project_key = ?').get(projectKey) as any).a);

  const register = runStoredQuery('UNIFIED_COST_REGISTER', { project_key: projectKey, period_from: null, period_to: null });
  const bySource: Record<string, { amount: number; lines: number }> = {};
  for (const r of register.rows as any[]) {
    const b = bySource[r.source] ?? { amount: 0, lines: 0 };
    b.amount += Number(r.amount ?? 0); b.lines++;
    bySource[r.source] = b;
  }
  console.log('\nregister rows by source:', JSON.stringify(
    Object.fromEntries(Object.entries(bySource).map(([k, v]) => [k, { amount: fmt(v.amount), lines: v.lines }]))));

  const registerTotal = Object.values(bySource).reduce((s, v) => s + v.amount, 0);
  near('unified register total equals total actual cost (no gap, no double-count)', registerTotal, totalActual);
  near('the SERVICE half of the register equals total service-line net', bySource.SERVICE?.amount ?? 0, totalServiceNet);

  const flagged = (register.rows as any[]).filter((r) => r.po_missing_detail === 1);
  console.log(`\nPOs with a CJI3 posting but no service detail loaded: ${flagged.length} row(s)`);
  for (const r of flagged.slice(0, 5)) console.log(`  ${r.po_no}  ${fmt(r.amount)}  ${r.reference}`);

  const summary = runStoredQuery('UNIFIED_COST_SUMMARY', { project_key: projectKey });
  const summaryTotal = (summary.rows as any[]).reduce((s, r) => s + Number(r.total_amount ?? 0), 0);
  near('monthly summary total matches too', summaryTotal, totalActual);

  // Sanity: no line should appear as both ACTUAL and SERVICE for the same PO.
  const posInBoth = new Set(
    (register.rows as any[]).filter((r) => r.source === 'ACTUAL' && r.po_no).map((r) => r.po_no));
  const serviceHasThose = (register.rows as any[])
    .filter((r) => r.source === 'SERVICE' && posInBoth.has(r.po_no));
  if (serviceHasThose.length > 0) {
    failures++;
    console.error(`  FAIL a PO appears in both ACTUAL and SERVICE — double count on ${serviceHasThose[0].po_no}`);
  } else {
    console.log('  ok   no PO appears on both sides of the merge');
  }

  console.log(failures === 0 ? '\nAll unified-register checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
