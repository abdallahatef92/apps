// Reopen a report on its own: the rebuilt analysis matches the one from the SAP files, line for line and number for number
const E = require('../engine.js'), X = require('xlsx'), ExcelJS = require('exceljs'), JSZip = require('jszip'), assert = require('assert'), fs = require('fs');
const PROG = process.env.SUBCON_PROG, SERV = process.env.SUBCON_SERV;   // real extracts are never committed
if (!PROG || !SERV) { console.log('SKIPPED – set SUBCON_PROG and SUBCON_SERV to the TRAZ ZSCPRG01 and ZSCSRV1 exports'); process.exit(0); }
const tmp = (n) => require('path').join(require('os').tmpdir(), n);
const rd = (f) => { const w = X.readFile(f); return X.utils.sheet_to_json(w.Sheets[w.SheetNames[0]], { header: 1, raw: true, defval: '' }); };
const sheets = (buf) => { const w = X.read(buf); const o = {}; for (const n of w.SheetNames) o[n] = X.utils.sheet_to_json(w.Sheets[n], { header: 1, raw: true, defval: '' }); return o; };
const near = (a, b, m) => assert.ok(Math.abs(a - b) < 0.01, `${m}: ${a} ≠ ${b}`);
(async () => {
  const prog = rd(PROG), serv = rd(SERV);
  // load 1 (Jul) → load 2 (Aug) with load 1 as the last report: load 2 has history, changes and late lines
  const jul = prog.map((r, i) => [r, i]).filter(([r]) => r[4] !== '' && typeof r[3] === 'number' && r[3] >= 46204 && r[3] <= 46234 && r[11] === 'X' && Math.abs(r[35]) > 1000);
  const drop = new Set(jul.slice(0, 5).map(([, i]) => i)), unap = new Set(jul.slice(5, 8).map(([, i]) => i));
  const prog1 = prog.map((r, i) => (unap.has(i) ? Object.assign([...r], { 11: '' }) : r)).filter((_, i) => !drop.has(i));
  const A1 = E.analyse(prog1, serv, { cutMonth: 202607 }); const b1 = Buffer.from(await E.buildWorkbook(A1, { ExcelJS, JSZip }));
  const A2 = E.analyse(prog, serv, { cutMonth: 202608, history: E.readPrevious(sheets(b1)) });
  const b2 = Buffer.from(await E.buildWorkbook(A2, { ExcelJS, JSZip })); fs.writeFileSync(tmp('reopen_src.xlsx'), b2);
  // reopen load 2 from its own file
  const R = E.fromReport(sheets(b2));
  assert.strictEqual(R.cutMonth, 202608, 'report month comes back'); assert.strictEqual(R.plant, A2.PLANT);
  assert.deepStrictEqual(R.warnings, [], 'a current report reopens without warnings');
  const B = E.analyse(R.prog, R.serv, { cutMonth: R.cutMonth, history: R.history, reopen: R.reopen });
  const k2 = E.summarize(A2).k, kb = E.summarize(B).k;
  for (const f of ['total', 'approved', 'opening', 'pending', 'notApproved', 'afterCut', 'late', 'adjustments', 'vat', 'otherPc']) near(kb[f], k2[f], f);
  for (const f of ['subs', 'pos', 'lines', 'lateLines']) assert.strictEqual(kb[f], k2[f], f);
  assert.strictEqual(B.gt, A2.gt, 'SAP grand total'); near(B.splitAmt, A2.splitAmt, 'WBS splits');
  assert.strictEqual(B.loadNo, A2.loadNo, 'same load number');
  const key = (r) => [r.lid, r.bucket, r.amt, r.repq, r.rk, r.first, r.late || '', r.lt, r.matchLvl, r.mg || ''].join('|');
  assert.deepStrictEqual(B.det.map(key).sort(), A2.det.map(key).sort(), 'every line identical: bucket, amount, report qty, Row ID, first seen, late flag, line type, PO line match');
  assert.strictEqual(B.changes.length, A2.changes.length, 'changes reproduced'); assert.ok(A2.changes.length > 0);
  // and the workbook built from it carries the same Service Monthly rows
  const b3 = Buffer.from(await E.buildWorkbook(B, { ExcelJS, JSZip })); fs.writeFileSync(tmp('reopen_out.xlsx'), b3);
  const s2 = sheets(b2), s3 = sheets(b3);
  assert.deepStrictEqual(s3['_Rows'], s2['_Rows'], 'Row IDs and order'); const srt = (a) => [a[0], ...a.slice(1).map((r) => JSON.stringify(r)).sort()]; assert.deepStrictEqual(srt(s3['_Lines']), srt(s2['_Lines']), 'lines store (any order)');
  // another month from the same report
  const C = E.analyse(R.prog, R.serv, { cutMonth: 202609, history: R.history, reopen: R.reopen });
  near(E.summarize(C).k.afterCut, 0, 'Sep cut: nothing after the cut');
  // an older report (no _Serv / _LinesPrev): still opens, with the two warnings, same figures
  const old = sheets(b2); delete old['_Serv']; delete old['_LinesPrev'];
  const O = E.fromReport(old); assert.strictEqual(O.warnings.length, 2, 'older report warns twice');
  const D = E.analyse(O.prog, O.serv, { cutMonth: O.cutMonth, history: O.history, reopen: O.reopen }), kd = E.summarize(D).k;
  for (const f of ['total', 'approved', 'opening', 'pending', 'late']) near(kd[f], k2[f], 'older report ' + f);
  assert.deepStrictEqual(D.det.map((r) => [r.lid, r.bucket, r.rk, r.first, r.late || ''].join('|')).sort(), A2.det.map((r) => [r.lid, r.bucket, r.rk, r.first, r.late || ''].join('|')).sort(), 'older report: buckets, Row IDs, flags');
  console.log(`reopen ok · ${B.det.length} lines · total ${Math.round(kb.total)} · pending ${Math.round(kb.pending)} · late ${kb.lateLines} · changes ${B.changes.length}`);
})().catch((e) => { console.error(e); process.exit(1); });
