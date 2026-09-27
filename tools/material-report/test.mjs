// Fixture tests for the material report engine. Small SAP-shaped extracts that reproduce the real traps:
// subtotal rows, the second "Posting Row" column, 222 reversals, Z21 / Z52 / 261, stock-transport receipts,
// deleted PO items, price units of 1000, a cost line with no movement, a non-WA line – and the monthly loop.
// Optional: MCR_REAL=<dir with the three exports> also runs the real files and prints the reconciliation.
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const E = require('./engine.js');
const ExcelJS = require('exceljs');
const XLSX = require('xlsx');

let fails = 0, passes = 0;
const eq = (got, want, what) => {
  const ok = typeof want === 'number' ? Math.abs(got - want) < 1e-6 : JSON.stringify(got) === JSON.stringify(want);
  if (ok) passes++; else { fails++; console.log(`FAIL ${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};
const D = (s) => new Date(s + 'T00:00:00Z');

// ---------------------------------------------------------------- ME2N
const ME = [['PO history/release documentation', 'Purchase Requisition', 'Purchasing Document', 'Document Date', 'Item', 'Supplier/Supplying Plant', 'Issuing Storage Loc.', 'Plant', 'Storage Location',
  'Material', 'Material Group', 'Short Text', 'Order Unit', 'Deletion Indicator', 'Order Quantity', 'Price Unit', 'Net Price', 'Net Order Value',
  'Still to be delivered (qty)', 'Still to be delivered (value)', 'Still to be invoiced (qty)', 'Still to be invoiced (val.)']];
const po = (poNo, date, item, vendor, mat, grp, text, unit, del, qty, pu, np, val, oq, ov) => ME.push(['', '', poNo, D(date), item, vendor, '', 'DIST', 'DIST', mat, grp, text, unit, del, qty, pu, np, val, oq, ov, 0, 0]);
po('5000000001', '2026-01-10', 10, '200000633  Steel Co', '13000040', 'M030201', 'Rebar 10mm', 'TO', '', 100, 1, 30000, 3000000, 20, 600000);
po('5000000002', '2026-03-05', 10, '200000999  Other Steel', '13000040', 'M030201', 'Rebar 10mm', 'TO', '', 50, 1, 33000, 1650000, 0, 0);
po('5000000003', '2026-02-01', 10, '100008269  Brick Co', '14000077', 'M0402', 'Solid brick', 'PC', '', 10000, 1000, 2500, 25000, 0, 0);   // 2.50 per piece
po('5000000004', '2026-02-02', 10, '100008269  Brick Co', '14000077', 'M0402', 'Solid brick', 'PC', 'L', 5000, 1000, 9999, 49995, 5000, 49995); // deleted
po('3000000001', '2026-01-15', 10, 'SBD1 Main stores', '11000001', 'SM001', 'Helmet', 'PC', '', 40, 0, 0, 0, 10, 0);                 // stock transport
// ---------------------------------------------------------------- MB51
const MB = [['Material', 'Plant', 'Name 1', 'Storage Location', 'Movement Type', 'Movement Type Text', 'Special Stock', 'Material Document', 'Material Doc.Item', 'Posting Date',
  'Material Description', 'Material Doc. Year', 'Qty in unit of entry', 'Amt.in Loc.Cur.', 'Unit of Entry', 'Document Date', 'Entry Date', 'Time of Entry', 'Purchase order', 'Item',
  'Supplier', 'Reference', 'WBS Element', 'Order', 'Reservation', 'Item number of reservation', 'User Name', 'Batch', 'Document Header Text', 'Text', 'Valuation Type', 'Ext. Amount in LC', 'Customer']];
const mv = (mat, mvt, text, doc, item, date, qty, amt, unit, po_, poi, wbs, order) => MB.push([mat, 'DIST', 'District 5', 'DIST', mvt, text, '', doc, item, D(date), 'desc ' + mat, date.slice(0, 4),
  qty, amt, unit, D(date), D(date), '10:00:00', po_ || '', poi || 0, '', '', wbs || '', order || '', 0, 0, 'U1', '', '', '', '', 0, '']);
mv('13000040', '101', 'GR goods receipt', '5000000101', 1, '2026-01-20', 80, 2400000, 'TO', '5000000001', 10);
mv('13000040', 'Z52', 'GR Cust Stk (Value)', '5000000102', 1, '2026-01-25', 30, 900000, 'TO');
mv('13000040', '221', 'GI for project', '4900000001', 1, '2026-01-28', -60, -1800000, 'TO', '', 0, 'C-DIST.01');
mv('13000040', '221', 'GI for project', '4900000002', 1, '2026-02-10', -40, -1300000, 'TO', '', 0, 'C-DIST.02');
mv('13000040', '222', 'RE for project', '4900000003', 1, '2026-02-12', 5, 162500, 'TO', '', 0, 'C-DIST.02');
mv('13000040', 'Z21', 'GI SCont W/Ded', '4900000004', 2, '2026-02-15', -10, -325000, 'TO', '', 0, 'C-DIST.02');
mv('14000077', '101', 'GR goods receipt', '5000000103', 1, '2026-02-05', 10000, 25000, 'PC', '5000000003', 10);
mv('14000077', '221', 'GI for project', '4900000005', 1, '2026-02-20', -12000, -30000, 'PC', '', 0, 'C-DIST.01');      // more out than in
mv('14000077', '261', 'GI for order', '4900000006', 1, '2026-02-21', -100, -250, 'PC', '', 0, '', '430000001');
mv('11000001', '101', 'GR stock in transit', '5000000104', 1, '2026-01-16', 30, 0, 'PC', '3000000001', 10);
mv('11000001', '551', 'GI scrapping', '4900000007', 1, '2026-02-25', -1, 0, 'PC');                                     // zero-value scrap, no cost line
mv('11000001', '999', 'Mystery movement', '4900000008', 1, '2026-02-26', -2, 0, 'PC');
// ---------------------------------------------------------------- CJI3
const CJ = [['Document Date', 'Object Type', 'Cost Element', 'Cost element name', 'Cost element descr.', 'Name', 'Object', 'Document Header Text', 'Purchase Order Text', 'Val/COArea Crcy',
  'Vbl. value/Obj. curr', 'CO area currency', 'Value TranCurr', 'Transaction Currency', 'WBS Element', 'Project definition', 'Offsetting Account', 'Document Number', 'Posting Row',
  'Reference Key', 'Reference Org. Unit', 'Reversal Organizatns', 'Reversal Ref. No.', 'Reference procedure', 'Dr/Cr indicator', 'Debit Type', 'Document Type', 'Posting Date',
  'Company Code', 'Row in op. version', 'Created on', 'Time of Entry', 'Purchasing Document', 'Item', 'Fiscal Year', 'Offsetting Account Type', 'Name of offsetting account',
  'Name of offsetting account', 'Exchange Rate Type', 'Ledger', 'Material', 'Material Description', 'Total quantity', 'Total Quantity', 'Posted unit of meas.', 'Unit of Measure',
  'Object Type', 'CO Object Name', 'Original Bus. Trans', 'Object Currency', 'Profitab. Segmt No.', 'From Period', 'To Period', 'Period', 'Ref. Company Code', 'Ref. document number',
  'Ref. Document Type', 'Posting Row', 'FI Posting Item', 'Ref. Fiscal Year', 'Report Currency', 'Reversal document', 'Reversed']];
const W = CJ[0].length;
// the CO posting row is 1 while the material document item is 2 – the second "Posting Row" column must be the one used
const cj = (doc, date, ce, wbs, amt, mat, qty, unit, refDoc, refItem, docType, coRow) => { const r = new Array(W).fill('');
  Object.assign(r, { 2: ce, 3: 'Main Material', 9: amt, 14: wbs, 15: 'C-DIST', 17: doc, 18: coRow || 1, 23: 'MKPF', 26: docType || 'WA', 27: D(date), 34: date.slice(0, 4),
    40: mat, 41: 'desc ' + mat, 42: qty, 44: unit, 47: 'WBS name', 55: refDoc, 57: refItem, 58: 2, 59: date.slice(0, 4), 67: 'DIST' }); CJ.push(r); };
cj('A01', '2026-01-28', '30201100', 'C-DIST.01', 1800000, '13000040', 60, 'TO', '4900000001', 1);
cj('A02', '2026-02-10', '30201100', 'C-DIST.02', 1300000, '13000040', 40, 'TO', '4900000002', 1);
cj('A03', '2026-02-12', '30201100', 'C-DIST.02', -162500, '13000040', -5, 'TO', '4900000003', 1);
cj('A04', '2026-02-15', '30201100', 'C-DIST.02', 325000, '13000040', 10, 'TO', '4900000004', 2);
cj('A05', '2026-02-20', '30201100', 'C-DIST.01', 30000, '14000077', 12000, 'PC', '4900000005', 1);
cj('A06', '2026-02-28', '30201100', 'C-DIST.01', 777, '14000077', 1, 'PC', '4900009999', 1);            // no movement behind it
cj('A07', '2026-02-28', '30201100', 'C-DIST.01', 5000, '14000077', 0, 'PC', '5100000001', 1, 'RE');     // not a goods issue
const all = 1800000 + 1300000 - 162500 + 325000 + 30000 + 777 + 5000;
{ const s = new Array(W).fill(''); s[2] = '30201100'; s[9] = all; CJ.push(s); }                       // cost element subtotal
{ const s = new Array(W).fill(''); s[9] = all; CJ.push(s); }                                           // grand total

// ================================================================ month 1
const src = { me: ME, mb: MB, cji: CJ };
eq(E.detectKind(ME), 'me', 'detect ME2N'); eq(E.detectKind(MB), 'mb', 'detect MB51'); eq(E.detectKind(CJ), 'cji', 'detect CJI3');
const A = E.analyse(src, {});
eq(A.errors, undefined, 'no layout errors');
const cost = 1800000 + 1300000 - 162500 + 325000 + 30000 + 777;
eq(A.k.cost, cost, 'material cost = WA lines only, subtotals skipped');
eq(A.k.printedTotal, all, 'printed grand total read');
eq(A.checks.find((c) => c.id === 'total').level, 'good', 'detail ties to printed total (all doc types)');
eq(A.nonWA.length, 1, 'RE line set aside');
eq(A.k.project, 1800000 + 1300000 - 162500 + 30000, 'project consumption includes the 222 reversal');
eq(A.k.subcon, 325000, 'Z21 is recoverable cost');
eq(A.k.unmatched, 777, 'cost with no movement');
eq(A.cost.find((l) => l.docNo === 'A04').mov.item, '2', 'match uses the reference item (second Posting Row column)');
eq(A.checks.find((c) => c.id === 'unmatched').count, 1, 'unmatched check counts it');
eq(A.checks.find((c) => c.id === 'disagree').count, 0, 'matched lines agree');
eq(A.k.ownerSupplied, 900000, 'Z52 owner supplied value');
eq(A.k.toOrders, 250, 'issued to orders kept outside cost');
const rebar = A.mats.get('13000040');
eq(rebar.qty.RCV_V, 80, 'rebar received from vendor'); eq(rebar.qty.OWNER, 30, 'rebar owner supplied');
eq(rebar.qty.ISS_P, -95, 'rebar issued to project net of 222'); eq(rebar.qty.ISS_S, -10, 'rebar to subcontractors');
eq(rebar.balance, 5, 'rebar stock balance'); eq(rebar.consQty, 105, 'rebar consumed');
eq(rebar.issuePrice, (1800000 + 1300000 - 162500 + 325000) / 105, 'rebar issue price');
eq(rebar.ordered, 150, 'ordered qty'); eq(rebar.openQty, 20, 'open qty');
eq(rebar.price.wavg, (30000 * 100 + 33000 * 50) / 150, 'weighted PO price'); eq(rebar.price.last.po, '5000000002', 'last PO by date');
eq(rebar.group, 'M030201', 'group from ME2N'); eq(rebar.sugg.package[0], 'DIV 0302', 'rebar group suggests DIV 0302');
const brick = A.mats.get('14000077');
eq(brick.price.wavg, 2.5, 'price unit 1000 → 2.50 per piece; deleted item ignored'); eq(brick.ordered, 10000, 'deleted item not ordered'); eq(brick.openQty, 0, 'deleted item not open');
eq(brick.balance, 10000 - 12000 - 100, 'brick balance negative'); eq(A.checks.find((c) => c.id === 'negstock').count, 1, 'negative stock flagged (brick only)');
eq(brick.qty.ISS_O, -100, 'issue to order in chain');
const helmet = A.mats.get('11000001');
eq(helmet.qty.RCV_S, 30, 'transit receipt is from stores'); eq(helmet.stoOpen, 10, 'STO open tracked apart'); eq(helmet.ordered, 0, 'STO not counted as ordered');
eq(helmet.sugg.package[0], 'INDIRECT', 'SM group suggests INDIRECT');
eq(A.checks.find((c) => c.id === 'mvt').count, 1, 'unknown movement type flagged');
eq(A.checks.find((c) => c.id === 'nocost').count, 1, 'zero-value scrap without cost line listed');
eq(A.months, [202601, 202602], 'months'); eq(A.byGroup[0].key, 'M030201', 'largest group first');
eq(A.byPackage.map((p) => p.key), ['UNALLOCATED'], 'nothing coded yet');
eq(A.monthlyRows.map((o) => [o.material, o.lineType, o.id]).sort(), [['13000040', 'Project', 1], ['13000040', 'To subcontractors', 2], ['14000077', 'No MB51 movement', 3], ['14000077', 'Project', 4]],
  'Material Monthly rows = material × line type, numbered');
eq(A.monthlyRows.find((o) => o.key === '13000040|Project').qtyByMonth, { 202601: 60, 202602: 35 }, 'monthly qty net of the 222 return');

// ================================================================ workbook → next month
const buf = await E.buildWorkbook(A, { ExcelJS });
const wb = XLSX.read(buf, { cellDates: true });
eq(['Dashboard', 'Material Monthly', '_Rows', 'Materials', 'Price', 'Material Coding', 'Changes', 'Checks', 'Load history', 'Cost Detail', 'Movements', 'PO Lines', 'Movement Rules', 'Lists', '_Meta', '_Snap', '_POs'].every((n) => wb.SheetNames.includes(n)), true, 'all sheets written');
const aoa = {}; for (const n of wb.SheetNames) aoa[n] = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: '' });
const cd = aoa['Cost Detail']; const cdh = cd.findIndex((r) => r.includes('Amount'));
eq(cd.slice(cdh + 1).filter((r) => r[0] instanceof Date).reduce((s, r) => s + r[cdh >= 0 ? cd[cdh].indexOf('Amount') : 0], 0), cost, 'Cost Detail sums to cost');
// someone codes rebar in Excel
const mc = aoa['Material Coding'], h = mc.findIndex((r) => r.includes('Package'));
for (const r of mc.slice(h + 1)) if (r[0] === '13000040') { r[4] = 'DIV 0302'; r[5] = 'MAT'; }
const P = E.readPrevious(aoa);
eq(P.coding.get('13000040'), { package: 'DIV 0302', mnl: 'MAT', cec: '' }, 'coding read back from the report');
eq(P.loads.length, 1, 'history carried'); eq(P.rows.size, 4, 'row IDs carried');
{ const mmS = aoa['Material Monthly']; const ids = mmS.slice(3).map((r) => r[mmS[1].indexOf('Row ID')]).filter((x) => typeof x === 'number');
  eq(ids.length, 4, 'four data rows on Material Monthly'); } eq(P.snap.size, A.list.length, 'snapshot carried');
// month 2: one more issue of rebar, one new PO line
MB.push(MB[3].slice()); Object.assign(MB[MB.length - 1], { 7: '4900000010', 9: D('2026-03-03'), 12: -2, 13: -66000 });
{ const r = CJ[1].slice(); r[17] = 'A10'; r[27] = D('2026-03-03'); r[9] = 66000; r[42] = 2; r[55] = '4900000010'; r[57] = 1; r[34] = '2026'; CJ.splice(CJ.length - 2, 0, r); }
ME.push(ME[1].slice()); Object.assign(ME[ME.length - 1], { 2: '5000000009', 3: D('2026-03-02'), 14: 5, 17: 150000, 18: 5, 19: 150000 });
const B = E.analyse({ me: ME, mb: MB, cji: CJ }, { coding: P.coding, prev: P });
eq(B.loadNo, 2, 'second load numbered');
eq(B.monthlyRows.find((o) => o.key === '13000040|Project').id, 1, 'Row ID kept across loads');
eq(B.monthlyRows.find((o) => o.key === '13000040|Project').qtyByMonth[202603], 2, 'new month lands on the same row');
eq(B.mats.get('13000040').package, 'DIV 0302', 'package applied');
eq(B.byPackage.find((p) => p.key === 'DIV 0302').total, rebar.cost + 66000, 'package roll-up');
eq(B.changes.rows.map((x) => [x.type, x.r.material]), [['Cost moved', '13000040']], 'only rebar changed');
eq(B.changes.rows[0].now.cost - B.changes.rows[0].prev.cost, 66000, 'Δ cost');
eq(B.changes.newPO.map((l) => l.key), ['5000000009/10'], 'new PO line found');

// ================================================================ real extracts (optional)
if (process.env.MCR_REAL) {
  const dir = process.env.MCR_REAL, s = {};
  for (const f of readdirSync(dir).filter((f) => /\.xlsx$/i.test(f))) { const w = XLSX.read(readFileSync(`${dir}/${f}`), { cellDates: true });
    const a = XLSX.utils.sheet_to_json(w.Sheets[w.SheetNames[0]], { header: 1, raw: true, defval: '' }); const k = E.detectKind(a); if (k) s[k] = a; }
  const R = E.analyse(s, {});
  console.log(`real: ${R.PLANT} ${R.PROJECT} to ${E.dtext(R.dataDate)} · cost ${E.fmt(R.k.cost)} · printed ${E.fmt(R.k.printedTotal)} · unmatched ${E.fmt(R.k.unmatched)} · project ${E.fmt(R.k.project)} · subcon ${E.fmt(R.k.subcon)} · scrap ${E.fmt(R.k.scrap)}`);
  for (const c of R.checks) console.log(`  ${c.level.padEnd(4)} ${c.title}${c.count ? ' (' + c.count + ')' : ''}`);
  eq(Math.abs(R.k.cost - R.k.printedTotal) < 1, true, 'real: ties to printed total');
}

console.log(`${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
