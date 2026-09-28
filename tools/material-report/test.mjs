// Fixture tests for the material report engine. Small SAP-shaped extracts that reproduce the real traps:
// subtotal rows, the second "Posting Row" column, 222 reversals, Z21 / Z52 / 261, stock-transport receipts,
// deleted PO items, price units of 1000, a cost line with no movement, a non-WA line – and the monthly loop.
// Optional: MCR_REAL=<dir with the three exports> also runs the real files and prints the reconciliation.
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const E = require('./engine.js');
const ExcelJS = require('exceljs');
const JSZip = require('jszip');
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
const buf = await E.buildWorkbook(A, { ExcelJS, JSZip });
const wb = XLSX.read(buf, { cellDates: true });
// every sheet's <sheetPr> children in schema order – Excel rejects the file otherwise
{ const z = await JSZip.loadAsync(buf); let bad = 0;
  for (const n of Object.keys(z.files).filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f))) {
    const pr = (/<sheetPr[^>]*>([\s\S]*?)<\/sheetPr>/.exec(await z.file(n).async('string')) || [])[1] || '';
    const tags = [...pr.matchAll(/<(\w+)/g)].map((m) => m[1]).filter((t) => ['tabColor', 'outlinePr', 'pageSetUpPr'].includes(t));
    if (tags.join() !== ['tabColor', 'outlinePr', 'pageSetUpPr'].filter((t) => tags.includes(t)).join()) bad++; }
  eq(bad, 0, 'sheetPr children in schema order');
  const mmx = await z.file('xl/worksheets/sheet2.xml').async('string');
  eq((mmx.match(/<col [^>]*outlineLevel="1"[^>]*>/g) || []).filter((c) => /collapsed="1"/.test(c) && !/hidden="1"/.test(c)).length, 0, 'open month groups are not marked collapsed');
  eq((mmx.match(/<col [^>]*outlineLevel="1"[^>]*>/g) || []).length > 0, true, 'month groups exist'); }
eq(E.orderSheetPr('<sheetPr><tabColor rgb="1"/><pageSetUpPr fitToPage="1"/><outlinePr summaryBelow="0"/></sheetPr>'),
  '<sheetPr><tabColor rgb="1"/><outlinePr summaryBelow="0"/><pageSetUpPr fitToPage="1"/></sheetPr>', 'orderSheetPr reorders');
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
{ const mmS = aoa['Material Monthly']; const ids = mmS.slice(3).map((r) => r[mmS[2].indexOf('Row ID')]).filter((x) => typeof x === 'number');
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

// ================================================================ cut-off
// MB51 entry stamps are the posting date at 10:00 (see mv); CJI3 lines take their movement's stamp.
{
  const cut = (d, t) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10), ...(t || '23:59:59').split(':').map(Number));
  // 1. Feb report, cut-off 25 Feb noon: A06 (no movement → its posting day, 28 Feb) and the 26 Feb movement wait
  const C1 = E.analyse({ me: ME, mb: MB, cji: CJ }, { reportMonth: 202602, cutoff: cut('2026-02-25', '12:00:00') });
  eq(C1.k.pending, 777 + 66000, 'after the cut-off or after the report month → pending'); eq(C1.pending.map((l) => l.docNo).sort(), ['A06', 'A10'], 'A06 (late entry) and A10 (March) pending');
  eq(C1.pending.find((l) => l.docNo === 'A10').why, 'posted in Mar-26, after the report month', 'reason given');
  eq([C1.costAll.find((l) => l.docNo === 'A01').status, C1.pending.find((l) => l.docNo === 'A06').status, C1.pending.find((l) => l.docNo === 'A10').status],
    ['In report', 'Pending – entered after cut-off', 'Pending – next month, already entered'], 'each CJI3 line is marked (A10 was entered 10 Feb, posted March)');
  // suggested cut-off: Created on of lines posted in the month, up to 10 days past month end
  const CJs = CJ.map((r) => r.slice()); CJs.find((r) => r[17] === 'A05')[30] = D('2026-03-02');   // a Feb line entered 2 Mar
  const info = E.periodInfo({ cji: CJs, mb: MB });
  eq(E.cutText(E.suggestCutoff(info, 202602).cutoff), '2026-03-02', 'suggestion = the day posting into Feb stopped');
  eq(E.cutText(E.suggestCutoff(info, 202601).cutoff), '2026-01-31', 'nothing late for Jan → month end');
  eq(E.suggestCutoff(info, 202603).early, true, 'file ends inside the month → early export flagged');
  // an afternoon entry keeps its own day in the workbook (no rounding into the next day)
  const MB3 = MB.map((r) => r.slice()); MB3.find((r) => r[7] === '4900000005')[17] = '23:30:00';
  const C6 = E.analyse({ me: ME, mb: MB3, cji: CJ }, { reportMonth: 202602, cutoff: cut('2026-02-20') });
  const w6 = XLSX.read(await E.buildWorkbook(C6, { ExcelJS, JSZip }), { cellDates: false }); const cd6 = XLSX.utils.sheet_to_json(w6.Sheets['Cost Detail'], { header: 1, raw: false, defval: '' });
  const h6 = cd6[3], a05 = cd6.find((r) => r[h6.indexOf('CO document')] === 'A05');
  eq([a05[h6.indexOf('Created on')], a05[h6.indexOf('Cut-off status')]], ['2026-02-20', 'In report'], 'entered 20 Feb 23:30 shows 20 Feb and counts for a 20 Feb cut-off');
  eq(C1.k.cost, cost - 777, 'cost to the cut-off');
  eq(C1.mats.get('11000001').qty.OTHER || 0, 0, 'movement after the cut-off is out of the quantity chain');
  eq(C1.months, [202601, 202602], 'report months');
  // 2. history: Jan reported with cut-off 3 Feb. A01 (posted 28 Jan) entered 10 Feb → too late for Jan → counted in Feb, flagged late
  const MB2 = MB.map((r) => r.slice()); const row = MB2.find((r) => r[7] === '4900000001'); row[16] = D('2026-02-10');
  const C2 = E.analyse({ me: ME, mb: MB2, cji: CJ }, { reportMonth: 202602, cutoff: cut('2026-03-05'), history: [{ reportMonth: 202601, cutoff: cut('2026-02-03') }] });
  const a01 = C2.cost.find((l) => l.docNo === 'A01');
  eq([a01.bucket, a01.late], [202602, true], 'back-dated line lands in the first open month');
  eq(C2.byBucket[202601] || 0, 0, 'closed January stays empty'); eq(C2.k.lateLines, 1, 'one late posting');
  eq(C2.checks.find((c) => c.id === 'late').count, 1, 'late check lists it');
  // same line entered before the Jan cut-off is simply January
  const C3 = E.analyse({ me: ME, mb: MB, cji: CJ }, { reportMonth: 202602, cutoff: cut('2026-03-05'), history: [{ reportMonth: 202601, cutoff: cut('2026-02-03') }] });
  eq(C3.cost.find((l) => l.docNo === 'A01').bucket, 202601, 'on-time line keeps its posting month');
  // 3. Opening roll-up: everything before Feb in Opening
  const C4 = E.analyse({ me: ME, mb: MB, cji: CJ }, { reportMonth: 202602, cutoff: cut('2026-03-05'), openingBefore: 202602 });
  eq(C4.byBucket.OPENING, 1800000, 'January rolled into Opening'); eq(C4.months, [202602], 'months start after Opening');
  // 4. workbook: cut-off stored, read back as history, closed months unchanged next month
  const b4 = await E.buildWorkbook(C3, { ExcelJS, JSZip }); const w4 = XLSX.read(b4, { cellDates: true }); const a4 = {};
  for (const n of w4.SheetNames) a4[n] = XLSX.utils.sheet_to_json(w4.Sheets[n], { header: 1, raw: true, defval: '' });
  const P4 = E.readPrevious(a4);
  eq([P4.loads[0].reportMonth, P4.loads[0].cutoff], [202602, cut('2026-03-05')], 'report month and cut-off carried');
  eq(P4.months.get('2026-01'), 1800000, 'month totals carried');
  const C5 = E.analyse({ me: ME, mb: MB, cji: CJ }, { reportMonth: 202603, cutoff: cut('2026-04-03'), prev: P4, history: P4.loads });
  eq(C5.checks.find((c) => c.id === 'frozen').level, 'good', 'closed months unchanged');
  eq(C5.cost.find((l) => l.docNo === 'A10').bucket, 202603, 'March line counted in March');
  const mm = a4['Material Monthly'], hdr = mm[2];
  eq([hdr[11], hdr[14], hdr[hdr.indexOf('Total Price') - 1]], ['Opening Qty', 'Jan-26 Qty', 'Feb-26 Amount'], 'Material Monthly: Opening at L, first month at O, Total right after the last month');
  eq(hdr.includes('Pending Amount') && hdr.indexOf('Pending Amount') > hdr.indexOf('Total Amount'), true, 'Pending after Total');
}

// ================================================================ window exports merged with the carried lines
{
  const cut = (d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10), 23, 59, 59);
  const run = (src, prev, M, c) => { const m = E.mergeSources(src, prev ? prev.carried : null);
    return E.analyse({ me: m.me, cji: m.cji, mb: m.mb }, { reportMonth: M, cutoff: cut(c), prev, history: prev ? prev.loads : [], exportCheck: m.exportCheck, carryStats: m.stats }); };
  const back = async (A) => { const w = XLSX.read(await E.buildWorkbook(A, { ExcelJS, JSZip }), { cellDates: true }); const a = {};
    for (const n of w.SheetNames) a[n] = XLSX.utils.sheet_to_json(w.Sheets[n], { header: 1, raw: true, defval: '' }); return E.readPrevious(a); };
  const J1 = run({ me: ME, mb: MB, cji: CJ }, null, 202601, '2026-02-03');
  eq([J1.exportCheck.lines, J1.exportCheck.printed], [CJ.slice(1).filter((r) => r[17]).length, all], 'printed-total check reads the export itself, not the merged lines');
  const P1 = await back(J1);
  eq([P1.carried.cji.length - 1, P1.carried.mb.length - 1], [CJ.slice(1).filter((r) => r[17]).length, MB.length - 1], 'every CJI3 line and movement carried');
  // February window: posting date from 01-Jan (the last reported month); the A02 amount was corrected in SAP
  const inWin = (r, i) => i === 0 || (r[27] instanceof Date && r[27] >= D('2026-01-01'));
  const CJw = CJ.filter(inWin).map((r) => r.slice()); CJw.find((r) => r[17] === 'A02')[9] = 1300001;
  const MBw = MB.filter((r, i) => i === 0 || r[9] >= D('2026-01-01'));
  const F1 = run({ me: ME, mb: MBw, cji: CJw }, P1, 202602, '2026-03-05');
  const F2 = run({ me: ME, mb: MB, cji: CJw.concat([]) }, P1, 202602, '2026-03-05');
  eq(F1.carryStats.cji.changed, 1, 'a line changed in SAP is noticed'); eq(F1.costAll.find((l) => l.docNo === 'A02').amt, 1300001, "the export's version wins");
  eq(F1.costAll.length, J1.costAll.length, 'overlap counted once');
  eq(Math.abs(F1.k.cost - F2.k.cost) < 0.01, true, 'window + carried = full');
  // a window that drops a carried line inside its range: kept, and reported
  const CJm = CJw.filter((r) => r[17] !== 'A03');
  const F3 = run({ me: ME, mb: MBw, cji: CJm }, P1, 202602, '2026-03-05');
  eq([F3.carryStats.cji.missing, F3.costAll.some((l) => l.docNo === 'A03')], [1, true], 'missing carried line kept and reported');
  eq(F3.checks.find((c) => c.id === 'carry-cji').level, 'warn', 'carry check warns');
}

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
