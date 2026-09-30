// Rev08 checks on the TRAZ extracts: node rev08test.js   (run under several TZ values)
const E = require('../engine.js'), X = require('xlsx'), ExcelJS = require('exceljs'), JSZip = require('jszip'), assert = require('assert');
// real extracts are never committed: point SUBCON_PROG / SUBCON_SERV at the TRAZ ZSCPROG01 / ZSCSRV1 exports
const PROG = process.env.SUBCON_PROG, SERV = process.env.SUBCON_SERV;
if (!PROG || !SERV) { console.log('SKIPPED – set SUBCON_PROG and SUBCON_SERV to the TRAZ ZSCPROG01 and ZSCSRV1 exports'); process.exit(0); }
const rd = (f) => { const w = X.readFile(f); return X.utils.sheet_to_json(w.Sheets[w.SheetNames[0]], { header: 1, raw: true, defval: '' }); };
const prog = rd(PROG), serv = rd(SERV);
const near = (a, b, m) => assert.ok(Math.abs(a - b) < 0.01, `${m}: ${a} vs ${b}`);
const sum = (rs) => rs.reduce((s, r) => s + r.amt, 0);
(async () => {
  // 1. cut date = last day of the month, in any time zone; a line dated on the last day belongs to that month
  const A8 = E.analyse(prog, serv, { cutMonth: 202608 });
  assert.strictEqual(A8.cutDate.toISOString().slice(0, 10), '2026-08-31');
  assert.strictEqual(E.analyse(prog, serv, { cutMonth: 202602 }).cutDate.toISOString().slice(0, 10), '2026-02-28');
  const on31 = A8.det.filter((r) => r.dateKey === 20260831);
  assert.ok(on31.length > 0, 'fixture has lines dated 31-Aug-26');
  assert.ok(on31.every((r) => r.month === 202608 && (r.bucket === 202608 || r.bucket === 'OPENING' || r.pendWhy === 'Not approved')), '31-Aug lines stay in Aug');
  const d1 = Math.min(...A8.det.filter((r) => r.dateKey > 20260831).map((r) => r.dateKey)), on1 = A8.det.filter((r) => r.dateKey === d1 && r.approved);
  assert.ok(on1.length && on1.every((r) => r.pendWhy === 'After cut date'), '1-Sep lines are after the cut');
  // 2. the three buckets always add up to the SAP grand total (73,923,142.32), whatever the month
  for (const cut of [202607, 202608, 202609]) {
    const A = E.analyse(prog, serv, { cutMonth: cut }), k = E.summarize(A).k;
    near(k.opening + k.approved + k.pending, 73923142.32, `buckets add up (${cut})`);
    near(k.total, A.gt, `detail = SAP grand total (${cut})`);
    near(k.afterCut, sum(A.det.filter((r) => r.approved && r.month > cut)), `after-cut amount (${cut})`);
    assert.ok(A.months[A.months.length - 1] === cut && A.months.every((m) => m <= cut), 'no month after the cut');
  }
  const k9 = E.summarize(E.analyse(prog, serv, {})).k, k8 = E.summarize(A8).k;
  near(k9.pending, 1338130.91, 'Sep pending = not approved only'); near(k8.pending, 3064142.07, 'Aug pending'); near(k8.afterCut, 1726011.16, 'Aug after-cut');
  near(k8.pending, k8.notApproved + k8.afterCut, 'pending = not approved + after cut');
  // 3. late lines: last report cut at Jul-26 without 5 July lines and with 3 July lines not yet approved
  const H = prog[0], iDate = 3, iAppr = 11, iPo = 4;
  const jul = prog.map((r, i) => [r, i]).filter(([r]) => r[iPo] !== '' && typeof r[iDate] === 'number' && r[iDate] >= 46204 && r[iDate] <= 46234 && r[iAppr] === 'X' && Math.abs(r[35]) > 1000);
  const drop = new Set(jul.slice(0, 5).map(([, i]) => i)), unap = new Set(jul.slice(5, 8).map(([, i]) => i));
  const prevProg = prog.filter((_, i) => !drop.has(i)).map((r, i0) => r);
  const prevProg2 = prog.map((r, i) => (unap.has(i) ? Object.assign([...r], { [iAppr]: '' }) : r)).filter((_, i) => !drop.has(i));
  const P = E.analyse(prevProg2, serv, { cutMonth: 202607 });
  const pbuf = await E.buildWorkbook(P, { ExcelJS, JSZip }); const pw = X.read(Buffer.from(pbuf)); const by = {};
  for (const n of ['_History', '_Lines', '_Rows', 'Service Coding', 'Service Monthly']) by[n] = X.utils.sheet_to_json(pw.Sheets[n], { header: 1, raw: true, defval: '' });
  const hist = E.readPrevious(by);
  assert.strictEqual(hist.loads[hist.loads.length - 1].dataDate.toISOString().slice(0, 10), '2026-07-31', 'history keeps the cut date');
  const N = E.analyse(prog, serv, { cutMonth: 202608, history: hist });
  const late = N.det.filter((r) => r.late);
  const expAdded = sum(jul.slice(0, 5).map(([r]) => ({ amt: r[35] }))), expAppr = sum(jul.slice(5, 8).map(([r]) => ({ amt: r[35] })));
  assert.strictEqual(late.filter((r) => r.late === 'Added to a reported month').length, 5);
  assert.strictEqual(late.filter((r) => r.late === 'Approved after the month was reported').length, 3);
  near(sum(late.filter((r) => r.late === 'Added to a reported month')), expAdded, 'added amount');
  near(sum(late.filter((r) => r.late === 'Approved after the month was reported')), expAppr, 'approved-late amount');
  // months already reported: last report's month + late lines = this month's amount (nothing else changed in this fixture)
  assert.ok(N.prevByMonth, 'a Rev08 report carries month detail');
  for (const m of [202605, 202606, 202607]) near(N.prevByMonth.get(m) + sum(late.filter((r) => r.month === m)), sum(N.det.filter((r) => r.bucket === m)), `month ${m} explained`);
  near(N.prevByMonth.get(202607), sum(P.det.filter((r) => r.bucket === 202607)), 'last report Jul amount');
  // 4. Service Monthly: values match the detail per row and bucket
  const buf = await E.buildWorkbook(A8, { ExcelJS, JSZip }); const w = X.read(Buffer.from(buf));
  const sm = X.utils.sheet_to_json(w.Sheets['Service Monthly'], { header: 1, raw: true, defval: '' });
  assert.deepStrictEqual(sm[4].slice(0, 11), ['Row ID', 'Package', 'MNL', 'Cost element', 'Service', 'Description', 'PO', 'Supplier code', 'Supplier', 'Line type', 'Unit']);
  const hdr = sm[3], tcol = hdr.indexOf('Total') + 3, pcol = hdr.findIndex((v) => String(v).startsWith('Pending')) + 2;
  const data = sm.slice(5).filter((r) => /^TRAZ-\d{5}$/.test(r[0]));
  assert.strictEqual(data.length, A8.keyTuples.length, 'one row per Row ID');
  near(data.reduce((s, r) => s + (+r[tcol] || 0), 0), k8.opening + k8.approved, 'SM Total');
  near(data.reduce((s, r) => s + (+r[pcol] || 0), 0), k8.pending, 'SM Pending');
  const augCol = hdr.indexOf('Aug ◂') + 2; near(data.reduce((s, r) => s + (+r[augCol] || 0), 0), sum(A8.det.filter((r) => r.bucket === 202608)), 'SM Aug');
  assert.ok(!(w.Sheets['Service Monthly']['!merges'] || []).length, 'no merged cells');
  const sq = X.utils.sheet_to_json(w.Sheets['Service Quarterly'], { header: 1, raw: true, defval: '' });
  const q3 = sq[3].indexOf('Q3 ◂') + 2, qd = sq.slice(5).filter((r) => /^TRAZ-\d{5}$/.test(r[0]));
  near(qd.reduce((s, r) => s + (+r[q3] || 0), 0), sum(A8.det.filter((r) => [202607, 202608].includes(r.bucket))), 'SQ Q3 = Jul + Aug');
  console.log(`ok · TZ=${process.env.TZ || 'default'} · Aug cut: total ${Math.round(k8.opening + k8.approved)}, pending ${Math.round(k8.pending)}, late 5 + 3 lines (${Math.round(expAdded)} + ${Math.round(expAppr)})`);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
