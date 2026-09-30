/* Subcontract report engine.
 * Turns SAP ZSCPROG01 (certificates) + ZSCSRV1 (PO service lines) into the monthly
 * service report workbook, optionally carrying history forward from the previous
 * report. Pure logic: the page passes in ExcelJS / JSZip; Node tests do the same. */
(function (root) {
  'use strict';

  // ------------------------------------------------------------------ helpers
  const L = (n) => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
  const str = (v) => (v === null || v === undefined) ? '' : String(v);
  const num = (v) => (typeof v === 'number' && isFinite(v)) ? v : (v === '' || v == null ? 0 : (isFinite(+v) ? +v : 0));
  const blank = (v) => v === '' || v === null || v === undefined;
  const esc = (s) => str(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function serialToYMD(v) {                       // Excel serial (1900 system) -> {y,m,d}
    if (v instanceof Date) return { y: v.getUTCFullYear(), m: v.getUTCMonth() + 1, d: v.getUTCDate() };
    const ms = Math.round((num(v) - 25569) * 86400000);
    const dt = new Date(ms); return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
  }
  const ymdDate = (o) => new Date(Date.UTC(o.y, o.m - 1, o.d));
  const mlabel = (m) => MON[(m % 100) - 1] + '-' + String(Math.floor(m / 100)).slice(2);
  const countBy = (arr, f) => { const m = new Map(); for (const x of arr) { const k = f(x); m.set(k, (m.get(k) || 0) + 1); } return m; };
  const sumBy = (arr, f, v) => { const m = new Map(); for (const x of arr) { const k = f(x); m.set(k, (m.get(k) || 0) + v(x)); } return m; };
  const mostCommon = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]);
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const cmpTuple = (a, b) => { for (let i = 0; i < a.length; i++) { const c = cmp(a[i], b[i]); if (c) return c; } return 0; };

  // --------------------------------------------------------- input layout
  // ZSCPROG01 column positions (identical in every project seen). Checked by header name.
  const P = { plant: 0, pc: 1, serial: 2, date: 3, po: 4, supName: 5, supCode: 6, appr: 11, flag: 12, docno: 13,
    item: 16, pkg: 18, line: 19, price: 20, svc: 22, text: 23, tax: 24, ctype: 25, totq: 26, prevq: 28, qty: 30,
    paid: 32, vat: 33, amt: 35, es: 38, esText: 39, doctype: 40, gl: 42, wbs: 43, wbsDesc: 55 };
  const P_NAMES = { plant: 'Plnt', pc: 'Profit Ctr', serial: 'Invoice Serial (new)', date: 'Date', po: 'Pur. Doc.', supName: 'Account Number of Supplier',
    supCode: 'Supplier', appr: 'Character 1', flag: 'Flag', docno: 'DocumentNo', item: 'Item', pkg: 'Number', line: 'Line', price: 'Gross Price',
    svc: 'Service', text: 'Short Text 1', tax: 'Tx', ctype: 'نوع العقد', totq: 'Total Quantity', prevq: 'Previous Quantity', qty: 'Current Quantity',
    paid: 'Progress %', vat: 'VAT Current', amt: 'SC Work Current Cost', es: 'Entry Sh.', esText: 'Short Text', doctype: 'Document Type',
    gl: 'G/L Acct', wbs: 'WBS Element', wbsDesc: 'Description' };
  const SERV_NEEDS = ['Purchase Order', 'PO item', 'PO Service Line no.', 'PO Service Code', 'Service Short Text', 'Service Unit Price', 'PO Service UOM',
    'PO Service Material Group', 'PO Service Material Group Description', 'Subcontractor', 'Subcontractor Name', 'Type of Works for PO',
    'Type of Contract (Include/Exclude VAT)', 'PO Service Qty', 'PO Service Price', 'Total Qty Received', 'Total Qty Accepted', 'Total Cost'];

  function checkProgHeader(h) {
    const bad = Object.entries(P).filter(([k, i]) => str(h[i]).trim() !== P_NAMES[k]).map(([k, i]) => `column ${L(i + 1)} should be "${P_NAMES[k]}" but is "${str(h[i])}"`);
    return bad;
  }
  function detectKind(aoa) {
    const h = (aoa[0] || []).map((x) => str(x).trim());
    if (h.includes('Purchase Order') && h.includes('PO Service Code')) return 'serv';
    if (h[4] === 'Pur. Doc.' && h[35] === 'SC Work Current Cost') return 'prog';
    return null;
  }

  // -------------------------------------------------------- coding defaults
  const TRADES = [['03', '03 Concrete'], ['04', '04 Masonry'], ['09', '09 Finishes (plaster)'], ['L', 'Labour supply'], ['P', 'Plant & logistics'],
    ['01', '01 General requirements'], ['07', '07 Thermal & moisture'], ['06', '06 Wood / formwork'], ['10', '10 Specialties'], ['31', '31 Earthwork'],
    ['05', '05 Metals'], ['08', '08 Doors & windows'], ['21', '21 Fire fighting'], ['22', '22 Plumbing & drainage'], ['26', '26 Electrical'],
    ['32', '32 Exterior works'], ['34', '34 Transportation'], ['23', '23 HVAC']];
  const RESOURCES = [['S', 'Subcontract works'], ['L', 'Labour supply'], ['P', 'Plant & logistics']];
  const VATR = { P0: 0, P2: 0.10, P3: 0.14 };
  const trade = (s) => s.slice(0, 1) === 'S' ? s.slice(1, 3) : s.slice(0, 1);
  const tradeName = (c) => (TRADES.find((t) => t[0] === c) || [c, 'UNMAPPED'])[1];

  // Shared coding is keyed per Service + Service text.
  const codingKey = (svc, text) => svc + '\u0001' + text;

  // ================================================================== ANALYSE
  function analyse(progAOA, servAOA, opts) {
    opts = opts || {};
    const warnings = [];
    const hdr = progAOA[0];
    const badH = checkProgHeader(hdr);
    if (badH.length) throw new Error('This ZSCPROG01 file has a different column layout: ' + badH.slice(0, 3).join('; '));
    const rawRows = progAOA.slice(1);
    let det = rawRows.filter((r) => !blank(r[P.po]))
      .map((r) => {
        const o = {}; for (const k in P) o[k] = r[P[k]];
        o.po = str(o.po).trim(); o.serial = str(o.serial).trim(); o.item = str(o.item).trim(); o.pkg = str(o.pkg).trim(); o.line = str(o.line).trim();
        o.svc = str(o.svc).trim(); o.text = str(o.text).trim(); o.supCode = str(o.supCode).trim(); o.supName = str(o.supName).trim();
        o.plant = str(o.plant).trim(); o.pc = str(o.pc).trim(); o.appr = str(o.appr).trim(); o.flag = str(o.flag).trim(); o.tax = str(o.tax).trim(); o.ctype = str(o.ctype).trim();
        for (const k of ['price', 'totq', 'prevq', 'qty', 'paid', 'vat', 'amt']) o[k] = num(o[k]);
        o.ymd = serialToYMD(o.date); o.month = o.ymd.y * 100 + o.ymd.m; o.dateObj = ymdDate(o.ymd);
        o.dateKey = o.ymd.y * 10000 + o.ymd.m * 100 + o.ymd.d;
        return o;
      });
    const RAWN = det.length;
    if (!RAWN) throw new Error('No certificate lines found in the ZSCPROG01 file.');
    const PLANT = mostCommon(countBy(det, (r) => r.plant))[0][0];
    const MAINPC = mostCommon(countBy(det, (r) => r.pc))[0][0];
    const footer = rawRows.find((r) => str(r[0]).startsWith(PLANT + ' ('));
    const gt = footer ? num(footer[P.amt]) : null;
    if (!footer) warnings.push('The SAP grand-total row was not found, so the file total could not be checked against it.');

    // ---- line identity; collapse WBS splits (one certificate line repeated on several WBS rows)
    const lid = (r) => [r.po, r.serial, r.item, r.pkg, r.line].join('|');
    const groups = new Map();
    for (const r of det) { const k = lid(r); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
    let splitAmt = 0, splitLines = 0, keyConflicts = 0; const keep = [];
    for (const r of det) {
      const g = groups.get(lid(r));
      if (g.length === 1) { keep.push(r); continue; }
      const same = new Set(g.map((x) => x.amt + '|' + x.qty + '|' + x.vat)).size === 1;
      if (same) { if (g[0] === r) { r.split = g.length; keep.push(r); splitAmt += r.amt * (g.length - 1); splitLines++; } }
      else { keep.push(r); keyConflicts++; }
    }
    det = keep;
    for (const r of det) r.lid = lid(r);

    // ---- ZSCSRV1
    const sh = servAOA[0].map((x) => str(x).trim()); const SI = {};
    sh.forEach((n, i) => { if (!(n in SI)) SI[n] = i; });
    const missing = SERV_NEEDS.filter((n) => !(n in SI));
    if (missing.length) throw new Error('The ZSCSRV1 file is missing columns: ' + missing.join(', '));
    const g = (x, n) => x[SI[n]];
    const sv = servAOA.slice(1).filter((x) => !blank(g(x, 'PO Service Code')));
    const svu = new Map(); for (const x of sv) svu.set(str(g(x, 'PO Service Code')).trim(), str(g(x, 'PO Service UOM')).trim());
    const ref = (x) => `PO${str(g(x, 'Purchase Order')).trim()}_I${str(g(x, 'PO item')).trim()}_L${str(g(x, 'PO Service Line no.')).trim()}`;
    const M5 = new Map(), M4 = new Map(), M3 = new Map();
    const push = (M, k, x) => { if (!M.has(k)) M.set(k, []); M.get(k).push(x); };
    for (const x of sv) {
      const b = [str(g(x, 'Purchase Order')).trim(), str(g(x, 'PO item')).trim(), str(g(x, 'PO Service Code')).trim()].join('\u0001');
      const t = str(g(x, 'Service Short Text')).trim();
      push(M5, b + '\u0001' + t + '\u0001' + num(g(x, 'Service Unit Price')), x); push(M4, b + '\u0001' + t, x); push(M3, b, x);
    }
    for (const r of det) {
      const b = [r.po, r.item, r.svc].join('\u0001');
      const tries = [['Exact', M5.get(b + '\u0001' + r.text + '\u0001' + r.price)], ['Text (price differs)', M4.get(b + '\u0001' + r.text)], ['Service code only', M3.get(b)]];
      r.match = null; r.matchLvl = 'Not found';
      for (const [lvl, hit] of tries) if (hit && hit.length) { r.match = hit[0]; r.matchLvl = hit.length === 1 ? lvl : lvl + ' – first of ' + hit.length; break; }
      r.poref = r.match ? ref(r.match) : null;
      r.mg = r.match ? str(g(r.match, 'PO Service Material Group')).trim() : null;
      r.mgd = r.match ? str(g(r.match, 'PO Service Material Group Description')).trim() : null;
    }

    // ---- report month: the user picks a month; the cut date is its last day. The certificate Date decides the month
    // (ZSCPROG01 has no separate posting date); a line dated after the cut date, or not approved, is Pending – not in Total.
    const newestMonth = det.reduce((m, r) => Math.max(m, r.month), 0);
    const CUT = opts.cutMonth && /^\d{6}$/.test(String(opts.cutMonth)) ? +opts.cutMonth : newestMonth;
    const cutDate = new Date(Date.UTC(Math.floor(CUT / 100), CUT % 100, 0));          // day 0 of next month = last day of CUT
    // ---- line classification
    const netp = (r) => r.ctype === 'A2' ? r.price / (1 + (VATR[r.tax] || 0)) : r.price;
    for (const r of det) {
      const q = r.qty, a = r.amt;
      r.isadj = !a ? false : (!q ? true : (Math.abs(q) <= 0.01 && Math.abs(a - q * netp(r)) > Math.max(1, 0.001 * Math.abs(a))));
      r.isqo = !!q && !a;
      r.lt = r.isadj ? 'Adjustment' : (r.isqo ? 'Qty only (excluded)' : 'Normal');
      r.othpc = r.pc !== MAINPC;
      r.net = netp(r);
      // report qty keeps every rate at the net contract rate: equivalent qty where the amount is not qty × net,
      // and adjustments (amount without a real qty) count amount ÷ net rate, so a −ve adjustment nets the qty off too
      r.repq = r.lt === 'Adjustment' ? (r.net !== 0 ? r.amt / r.net : 0)
        : r.lt !== 'Normal' ? 0 : (r.net !== 0 && Math.abs(r.amt - r.qty * r.net) > 1 ? r.amt / r.net : r.qty);
      r.equiv = r.lt === 'Normal' && r.net !== 0 && Math.abs(r.amt - r.qty * r.net) > 1;
      r.approved = r.appr === 'X'; r.initial = r.flag === 'X';
      r.pendWhy = !r.approved ? 'Not approved' : (r.month > CUT ? 'After cut date' : null);
      r.bucket = r.pendWhy ? 'PENDING' : (r.initial ? 'OPENING' : r.month);
      r.trade = trade(r.svc); r.res = r.svc.slice(0, 1);
    }
    // ---- qty check on adjustments: the equivalent qty is kept, but flagged when the PO service line has no normal qty
    // to net against, or when it would take that line's quantity below zero (e.g. a deduction on a placeholder-priced line)
    { const g = new Map(); const gk = (r) => [r.po, r.svc, r.text].join('\u0001');
      for (const r of det) { if (r.isqo) continue; const x = g.get(gk(r)) || { n: 0, a: 0 }; if (r.isadj) x.a += r.repq; else x.n += r.repq; g.set(gk(r), x); }
      for (const r of det) { r.qcheck = null; if (!r.isadj) continue; const x = g.get(gk(r));
        if (Math.abs(x.n) < 1e-9) r.qcheck = 'Check – no normal qty on this PO service line';
        else if (x.n + x.a < -0.01) r.qcheck = 'Check – takes the PO service qty below zero'; } }
    // ---- keys
    const svcKeys = [...new Set(det.map((r) => codingKey(r.svc, r.text)))].sort((a, b) => cmp(a, b));
    const svcId = new Map(svcKeys.map((k, i) => [k, i + 1]));
    for (const r of det) r.sid = svcId.get(codingKey(r.svc, r.text));
    const rkT = (r) => [r.svc, r.text, r.isadj ? 1 : 0, r.supCode, r.price, r.ctype, r.tax, r.pc, r.po];
    const rows = det.filter((r) => !r.isqo).map((r) => ({ r, t: rkT(r) })).sort((a, b) => cmpTuple(a.t, b.t));
    const key = new Map(); const keyTuples = [];
    for (const { r, t } of rows) { const k = JSON.stringify(t); if (!key.has(k)) { key.set(k, key.size + 1); keyTuples.push(t); } r.rk = key.get(k); }
    const months = [...new Set(det.filter((r) => !r.initial && r.month <= CUT).map((r) => r.month).concat([CUT]))].sort((a, b) => a - b);
    const omonths = [...new Set(det.filter((r) => typeof r.bucket === 'number').map((r) => r.month))].sort((a, b) => a - b);
    const allMonths = [...new Set(months.concat(det.filter((r) => !r.initial && r.approved && r.month > CUT).map((r) => r.month)))].sort((a, b) => a - b);

    // ---- coding (shared store + previous workbook), unit from SAP otherwise
    const coding = opts.coding || new Map();       // codingKey -> {unit,csi,mnl,cec}
    const unitGuess = (svc, text) => {
      if (svu.has(svc)) { const sfx = svc.includes('-') ? svc.split('-').slice(1).join('-').trim() : null; const u = svu.get(svc);
        return [u, 'ZSCSRV1 PO service UOM' + (sfx && sfx !== u ? ` (code suffix says ${sfx})` : '')]; }
      if (svc.includes('-')) return [svc.split('-').slice(1).join('-'), 'Service code suffix'];
      for (const [pat, u] of [['م3', 'M3'], ['م2', 'M2'], ['يومية', 'DAY'], ['ساعة', 'H'], ['ساعه', 'H'], ['شهر', 'MON'], ['بالعدد', 'EA'], ['مقط', 'LS']])
        if (text.includes(pat)) return [u, 'Service text (' + pat + ')'];
      return [null, null];
    };
    const services = svcKeys.map((k) => {
      const [svc, text] = k.split('\u0001'); const [u, src] = unitGuess(svc, text); const c = coding.get(k) || {};
      return { id: svcId.get(k), key: k, svc, text, unit: c.unit || u, unitSrc: c.unit ? (c.unit === u ? src : 'Your entry (shared coding)') : (src || 'unknown – please fill'),
        sapUnit: u, csi: c.csi || '', mnl: c.mnl || '', cec: c.cec || '' };
    });

    // ---- history (previous report)
    const hist = opts.history || null;             // {loads:[...], lines: Map lid -> {amt,appr,flag,first}}
    const loadNo = hist && hist.loads.length ? Math.max(...hist.loads.map((l) => l.no)) + 1 : 1;
    const newestDate = det.reduce((m, r) => (r.dateKey > m.dateKey ? r : m), det[0]).dateObj, dataDate = cutDate;
    const lastLoad = hist && hist.loads.length ? hist.loads[hist.loads.length - 1] : null;
    const prevCut = lastLoad && lastLoad.dataDate instanceof Date ? lastLoad.dataDate.getUTCFullYear() * 100 + lastLoad.dataDate.getUTCMonth() + 1 : null;
    const changes = [];
    if (hist && hist.lines && hist.lines.size) {
      const seen = new Set();
      for (const r of det) {
        const p = hist.lines.get(r.lid); seen.add(r.lid);
        const reported = prevCut && typeof r.bucket === 'number' && r.month <= prevCut;     // a month the last report already showed
        if (!p) { changes.push({ type: 'New', r, prev: 0, now: r.amt }); r.first = loadNo; if (reported) r.late = 'Added to a reported month'; continue; }
        r.first = p.first;
        if (reported && p.appr !== 'X' && r.approved) r.late = 'Approved after the month was reported';
        if (Math.abs(p.amt - r.amt) > 0.005) changes.push({ type: 'Amount changed', r, prev: p.amt, now: r.amt });
        else if (p.appr !== 'X' && r.approved) changes.push({ type: 'Approved since last load', r, prev: p.amt, now: r.amt });
      }
      for (const [k, p] of hist.lines) if (!seen.has(k)) changes.push({ type: 'Removed', lid: k, p, prev: p.amt, now: 0 });
    } else for (const r of det) r.first = loadNo;
    // months already reported: last report's amount per month, so every change can be tied to lines added since
    let prevByMonth = null;
    if (hist && hist.lines && hist.lines.size && [...hist.lines.values()].some((p) => p.bucket != null)) {
      prevByMonth = new Map(); for (const p of hist.lines.values()) if (typeof p.bucket === 'number') prevByMonth.set(p.bucket, (prevByMonth.get(p.bucket) || 0) + p.amt); }

    // ---- permanent Row IDs: a Service Monthly row keeps its ID from load to load (stored in the hidden _Rows sheet);
    // new rows take the next free number. r.rk carries the ID, so Detail and every SUMIFS match on it.
    const prevRows = (hist && hist.rows) || new Map();
    let nextNo = 0; for (const v of prevRows.values()) nextNo = Math.max(nextNo, +(String(v.id).match(/(\d+)$/) || [0, 0])[1]);
    const rowIds = [], rowFirst = [], rowPrevOrder = [];
    for (const t of keyTuples) { const k = JSON.stringify(t), p = prevRows.get(k);
      const useSheet = !!(hist && hist.smOrder && hist.smOrder.size);   // the sheet as saved (after any Excel sort) wins over _Rows
      if (p) { rowIds.push(p.id); rowFirst.push(p.first || loadNo); rowPrevOrder.push(useSheet ? (hist.smOrder.get(p.id) ?? null) : p.order); }
      else { nextNo++; rowIds.push(`${PLANT}-${String(nextNo).padStart(5, '0')}`); rowFirst.push(loadNo); rowPrevOrder.push(null); } }
    for (const r of det) if (r.rk) r.rk = rowIds[r.rk - 1];

    return { det, RAWN, PLANT, MAINPC, gt, splitAmt, splitLines, keyConflicts, sv, g, ref, svu, SI, months, omonths, key, keyTuples, rowIds, rowFirst, rowPrevOrder, rowsCarried: prevRows.size > 0,
      services, svcId, warnings, hist, loadNo, allMonths, dataDate, newestDate, CUT, cutDate, newestMonth, prevCut, prevByMonth, changes, opts, rawRowCount: rawRows.length, files: opts.files || {} };
  }

  // ================================================================== SUMMARY (on-screen dashboard)
  function summarize(A) {
    const det = A.det, T = det.reduce((s, r) => s + r.amt, 0);
    const k = {
      total: T,
      approved: det.filter((r) => typeof r.bucket === 'number').reduce((s, r) => s + r.amt, 0),
      opening: det.filter((r) => r.bucket === 'OPENING').reduce((s, r) => s + r.amt, 0),
      pending: det.filter((r) => r.bucket === 'PENDING').reduce((s, r) => s + r.amt, 0),
      notApproved: det.filter((r) => !r.approved).reduce((s, r) => s + r.amt, 0),
      afterCut: det.filter((r) => r.pendWhy === 'After cut date').reduce((s, r) => s + r.amt, 0),
      late: det.filter((r) => r.late).reduce((s, r) => s + r.amt, 0), lateLines: det.filter((r) => r.late).length,
      adjustments: det.filter((r) => r.isadj).reduce((s, r) => s + r.amt, 0),
      otherPc: det.filter((r) => r.othpc).reduce((s, r) => s + r.amt, 0),
      vat: det.reduce((s, r) => s + r.vat, 0),
      subs: new Set(det.filter((r) => r.amt).map((r) => r.supCode)).size,
      pos: new Set(det.map((r) => r.po)).size,
      lines: det.length, rawLines: A.RAWN, splitAmt: A.splitAmt, splitLines: A.splitLines, gt: A.gt,
    };
    const tradeTot = mostCommon(sumBy(det, (r) => r.trade, (r) => r.amt)).map(([t, v]) => ({ code: t, name: tradeName(t), total: v }));
    for (const t of tradeTot) {
      const rs = det.filter((r) => r.trade === t.code);
      t.byMonth = A.months.map((m) => rs.filter((r) => r.bucket === m).reduce((s, r) => s + r.amt, 0));
      t.opening = rs.filter((r) => r.bucket === 'OPENING').reduce((s, r) => s + r.amt, 0);
      t.pending = rs.filter((r) => r.bucket === 'PENDING').reduce((s, r) => s + r.amt, 0);
      const bySup = sumBy(rs, (r) => r.supCode, (r) => r.amt);
      t.subs = [...bySup.values()].filter((v) => Math.abs(v) > 1e-9).length;
    }
    const svcTot = mostCommon(sumBy(det, (r) => r.sid, (r) => r.amt)).slice(0, 15).map(([sid, v]) => {
      const s = A.services[sid - 1]; const nr = det.filter((r) => r.sid === sid && r.lt !== 'Qty only (excluded)');
      const q = nr.reduce((a, r) => a + r.repq, 0), am = nr.reduce((a, r) => a + r.amt, 0);
      return { svc: s.svc, text: s.text, unit: s.unit, trade: tradeName(trade(s.svc)), qty: q, rate: q ? am / q : null, total: v };
    });
    const active = A.omonths.map((m) => new Set(det.filter((r) => r.bucket === m && r.amt).map((r) => r.supCode)));
    const activeByMonth = A.omonths.map((m) => {
      const s = sumBy(det.filter((r) => r.bucket === m), (r) => r.supCode, (r) => r.amt);
      return [...s.values()].filter((v) => Math.abs(v) > 1e-9).length;
    });
    const ch = { New: [0, 0], 'Amount changed': [0, 0], 'Approved since last load': [0, 0], Removed: [0, 0] };
    for (const c of A.changes) { ch[c.type][0]++; ch[c.type][1] += (c.now - c.prev) || (c.type === 'Approved since last load' ? c.now : 0); }
    return { k, tradeTot, svcTot, months: A.months, omonths: A.omonths, activeByMonth, active, changes: ch, hasHistory: !!(A.hist && A.hist.loads.length),
      loads: histLoads(A, k), PLANT: A.PLANT, MAINPC: A.MAINPC, dataDate: A.dataDate, warnings: A.warnings };
  }
  function histLoads(A, k) {
    const prev = (A.hist && A.hist.loads) || [];
    return prev.concat([{ no: A.loadNo, run: new Date(), dataDate: A.dataDate, file: A.files.prog || '', lines: k.lines, total: k.total,
      approved: k.approved, opening: k.opening, pending: k.pending, adjustments: k.adjustments, subs: k.subs, pos: k.pos }]);
  }

  // ================================================================== READ PREVIOUS REPORT
  // aoaBySheet: {sheetName: aoa} from the previous workbook (values only).
  function readPrevious(aoaBySheet) {
    const out = { loads: [], lines: new Map(), coding: new Map(), project: null };
    const h = aoaBySheet['_History'];
    const asDate = (v) => v instanceof Date ? v : (typeof v === 'number' && v > 0 ? new Date(Math.round((v - 25569) * 86400000)) : null);
    if (h) for (const r of h.slice(1)) if (!blank(r[0])) out.loads.push({ no: num(r[0]), run: asDate(r[1]), dataDate: asDate(r[2]), file: str(r[3]), lines: num(r[4]), total: num(r[5]),
      approved: num(r[6]), opening: num(r[7]), pending: num(r[8]), adjustments: num(r[9]), subs: num(r[10]), pos: num(r[11]), project: str(r[12]) });
    const ln = aoaBySheet['_Lines'];
    if (ln) for (const r of ln.slice(1)) if (!blank(r[0])) out.lines.set(str(r[0]), { amt: num(r[1]), appr: str(r[2]), flag: str(r[3]), first: num(r[4]), po: str(r[5]), sup: str(r[6]), svc: str(r[7]), text: str(r[8]),
      bucket: blank(r[9]) ? null : (isFinite(+r[9]) ? +r[9] : str(r[9])), month: num(r[10]) || null });
    out.rows = new Map();                            // row identity -> { id, first, order }
    out.smOrder = new Map();                         // Row ID -> position in last report's Service Monthly, as the user left it
    const smv = aoaBySheet['Service Monthly'];
    if (smv) { const hr = smv.findIndex((r) => r.some((v) => str(v).trim() === 'Row ID'));
      if (hr >= 0) { const c = smv[hr].findIndex((v) => str(v).trim() === 'Row ID'); let n = 0;
        for (const r of smv.slice(hr + 1)) { const id = str(r[c]).trim(); if (id && !out.smOrder.has(id)) out.smOrder.set(id, ++n); } } }
    const rw = aoaBySheet['_Rows'];
    if (rw) for (const r of rw.slice(1)) if (!blank(r[0]) && !blank(r[1])) out.rows.set(str(r[1]), { id: str(r[0]), first: num(r[2]), order: num(r[3]) });
    const sc = aoaBySheet['Service Coding'];
    if (sc) {
      const H = sc[0].map((x) => str(x).trim()); const ix = (n) => H.indexOf(n);
      for (const r of sc.slice(1)) {
        const svc = str(r[ix('Service')]).trim(); if (!svc) continue;
        const e = { unit: str(r[ix('Unit')]).trim(), csi: normPkg(r[ix('Package') >= 0 ? ix('Package') : ix('CSI')]),   // "CSI" in older reports
          mnl: str(r[ix('MNL')]).trim(), cec: str(r[ix('Cost Element Code')]).trim(),
          unitSrc: str(r[ix('Unit source')]) };
        out.coding.set(codingKey(svc, str(r[ix('Service text')]).trim()), e);
      }
    }
    if (out.loads.length) out.project = out.loads[out.loads.length - 1].project || null;
    return out;
  }

  // ================================================================== WORKBOOK
  const FONT = { name: 'Arial', size: 10 };
  const st = {
    F: { ...FONT, color: { argb: 'FF111C2E' } }, B: { ...FONT, bold: true, color: { argb: 'FF0F2A52' } }, H: { ...FONT, bold: true, color: { argb: 'FFFFFFFF' } }, HB: { ...FONT, bold: true, color: { argb: 'FF0F2A52' } },
    BIG: { name: 'Arial', size: 16, bold: true, color: { argb: 'FFFFFFFF' } }, SMALL: { name: 'Arial', size: 9, color: { argb: 'FF66748C' } },
    T1: { name: 'Arial', size: 14, bold: true, color: { argb: 'FF0F2A52' } }, BLUE: { ...FONT, color: { argb: 'FF0000FF' } },
    IT: { name: 'Arial', size: 9, italic: true, color: { argb: 'FF66748C' } }, RED: { ...FONT, color: { argb: 'FFB4413C' } },
    // title band
    EYE: { name: 'Arial', size: 9, bold: true, color: { argb: 'FFC8A45C' } }, TITLE: { name: 'Arial', size: 18, bold: true, color: { argb: 'FFFFFFFF' } },
    SUB: { name: 'Arial', size: 9, color: { argb: 'FFB9C6DD' } }, KLAB: { name: 'Arial', size: 8, bold: true, color: { argb: 'FFC8A45C' } },
    KSUB: { name: 'Arial', size: 8, color: { argb: 'FFB9C6DD' } }, CTRL: { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } },
  };
  const fill = (c) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + c } });
  const tint = (hex, k) => { const c = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)); return c.map((v) => Math.round(v + (255 - v) * k).toString(16).padStart(2, '0')).join('').toUpperCase(); };   // mix with white
  const FILL = { HF: fill('0F2A52'), H2: fill('1F3E6B'), OPF: fill('9C7A38'), PF: fill('8E3B37'), TF: fill('FBF4E3'), YF: fill('FFFF00'),
    KF: fill('1F3E6B'), AF: fill('FBEEEE'), PCF: fill('EAF1FC'), NEWF: fill('E2EFDA'), BAND: fill('0F2A52'), GOLD: fill('C8A45C') };
  const NUM = '#,##0;[Red](#,##0);"–"', QTY = '#,##0.00;[Red](#,##0.00);"–"', PCT = '0.0%;[Red](0.0%);"–"';
  const BRAND = '1F3E6B';   // single-series charts
  const GOLDLINE = { style: 'thin', color: { argb: 'FFC8A45C' } };
  // tab groups: log / file history & transactions / reports
  const TAB_GROUPS = [['0F2A52', ['Dashboard', 'Service Monthly', 'Service Quarterly', 'Package Monthly', 'Service Coding']], ['C8A45C', ['Changes', 'Detail']],
    ['4A6FA5', ['PO Register', 'By Supplier', 'Subcontractor x Trade', 'Subcontractors over time', 'Qty Reconciliation', 'Coding', 'Notes']]];
  const NOTES_RECON_ROW = 32;   // fixed so the Dashboard control strip can point at it
  const PAL = ['2A78D6', 'EB6834', '1BAF7A', 'EDA100', 'E87BA4', '008300', '4A3AA7', 'A6A6A0'];

  function makeSheetApi(ws) {
    return {
      ws,
      set(r, c, v, o) {
        const cell = ws.getCell(r, c);
        if (typeof v === 'string' && v.startsWith('=')) cell.value = { formula: v.slice(1) };
        else if (v !== undefined) cell.value = (v === '' ? null : v);
        if (o) { if (o.font) cell.font = o.font; if (o.fill) cell.fill = o.fill; if (o.fmt) cell.numFmt = o.fmt; if (o.align) cell.alignment = o.align; if (o.border) cell.border = o.border; if (o.note) cell.note = o.note; }
        return cell;
      },
      hdr(r, c, v, f, font) { return this.set(r, c, v, { font: font || st.H, fill: f || FILL.HF, align: { horizontal: 'center', vertical: 'middle', wrapText: true } }); },
      width(c, w) { ws.getColumn(c).width = w; },
    };
  }
  const lk = (sheet, kc, vc, cell, dflt, n) => `IFERROR(INDEX('${sheet}'!$${vc}$2:$${vc}$${n || 50},MATCH(${cell},'${sheet}'!$${kc}$2:$${kc}$${n || 50},0)),${dflt === undefined ? '"UNMAPPED"' : dflt})`;

  // charts are added after ExcelJS writes the file (ExcelJS cannot create charts)
  function chartTitle(t) { return `<title><tx><rich><a:bodyPr/><a:p><a:pPr><a:defRPr sz="1100" b="1"/></a:pPr><a:r><a:rPr sz="1100" b="1"/><a:t>${esc(t)}</a:t></a:r></a:p></rich></tx><overlay val="0"/></title>`; }
  const grid = '<majorGridlines><spPr><a:ln><a:solidFill><a:srgbClr val="E7E6E6"/></a:solidFill></a:ln></spPr></majorGridlines>';
  function dLbls(fmt) { return `<dLbls>${fmt ? `<numFmt formatCode="${esc(fmt)}" sourceLinked="0"/>` : ''}<spPr><a:noFill/><a:ln><a:noFill/></a:ln></spPr><dLblPos val="outEnd"/><showLegendKey val="0"/><showVal val="1"/><showCatName val="0"/><showSerName val="0"/><showPercent val="0"/><showBubbleSize val="0"/></dLbls>`; }
  function serXml(s, i, kind) {
    const tx = s.name ? `<tx><strRef><f>${esc(s.name)}</f></strRef></tx>` : '';
    const sp = kind === 'line'
      ? `<spPr><a:ln w="25400"><a:solidFill><a:srgbClr val="${s.color}"/></a:solidFill></a:ln></spPr><marker><symbol val="circle"/><size val="6"/><spPr><a:solidFill><a:srgbClr val="${s.color}"/></a:solidFill><a:ln><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:ln></spPr></marker>`
      : `<spPr><a:solidFill><a:srgbClr val="${s.color}"/></a:solidFill>${s.gap ? '<a:ln w="19050"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:ln>' : ''}</spPr><invertIfNegative val="0"/>`;
    const cat = s.catDate ? `<cat><numRef><f>${esc(s.cat)}</f></numRef></cat>` : `<cat><strRef><f>${esc(s.cat)}</f></strRef></cat>`;
    return `<ser><idx val="${i}"/><order val="${i}"/>${tx}${sp}${cat}<val><numRef><f>${esc(s.val)}</f></numRef></val>${kind === 'line' ? '<smooth val="0"/>' : ''}</ser>`;
  }
  function chartXml(c) {
    const kind = c.kind; // 'bar' | 'col' | 'line'
    const series = c.series.map((s, i) => serXml(s, i, kind)).join('');
    const catAx = `<catAx><axId val="10"/><scaling><orientation val="${c.reverse ? 'maxMin' : 'minMax'}"/></scaling><delete val="0"/><axPos val="${kind === 'bar' ? 'l' : 'b'}"/>${c.catFmt ? `<numFmt formatCode="${esc(c.catFmt)}" sourceLinked="0"/>` : ''}<majorTickMark val="none"/><minorTickMark val="none"/><tickLblPos val="nextTo"/><crossAx val="100"/><crosses val="autoZero"/><auto val="1"/><lblAlgn val="ctr"/><lblOffset val="100"/><tickLblSkip val="1"/><noMultiLvlLbl val="0"/></catAx>`;
    const valAx = `<valAx><axId val="100"/><scaling><orientation val="minMax"/></scaling><delete val="0"/><axPos val="${kind === 'bar' ? 'b' : 'l'}"/>${grid}${c.valTitle ? `<title><tx><rich><a:bodyPr rot="-5400000" vert="horz"/><a:p><a:pPr><a:defRPr sz="900" b="0"/></a:pPr><a:r><a:rPr sz="900" b="0"/><a:t>${esc(c.valTitle)}</a:t></a:r></a:p></rich></tx><overlay val="0"/></title>` : ''}<numFmt formatCode="${esc(c.valFmt || 'General')}" sourceLinked="0"/><majorTickMark val="none"/><minorTickMark val="none"/><tickLblPos val="nextTo"/><spPr><a:ln><a:noFill/></a:ln></spPr><crossAx val="10"/><crosses val="${c.reverse ? 'max' : 'autoZero'}"/><crossBetween val="between"/></valAx>`;
    let plot;
    if (kind === 'line') plot = `<lineChart><grouping val="standard"/><varyColors val="0"/>${series}<marker val="1"/><axId val="10"/><axId val="100"/></lineChart>`;
    else plot = `<barChart><barDir val="${kind === 'bar' ? 'bar' : 'col'}"/><grouping val="${c.stacked ? 'stacked' : 'clustered'}"/><varyColors val="0"/>${series}${c.labels ? dLbls(c.labelFmt) : ''}<gapWidth val="${c.gap || 60}"/>${c.stacked ? '<overlap val="100"/>' : ''}<axId val="10"/><axId val="100"/></barChart>`;
    const legend = c.legend ? `<legend><legendPos val="${c.legend}"/><overlay val="0"/></legend>` : '';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><chartSpace xmlns="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><roundedCorners val="0"/><chart>${chartTitle(c.title)}<autoTitleDeleted val="0"/><plotArea><layout/>${plot}${catAx}${valAx}</plotArea>${legend}<plotVisOnly val="1"/><dispBlanksAs val="gap"/></chart><txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="900"><a:latin typeface="Arial"/></a:defRPr></a:pPr><a:endParaRPr lang="en-US"/></a:p></txPr></chartSpace>`;
  }
  async function injectCharts(buf, charts, sheetNames, JSZip, extra) {
    const z = await JSZip.loadAsync(buf);
    let ct = await z.file('[Content_Types].xml').async('string');
    const bySheet = new Map();
    charts.forEach((c) => { if (!bySheet.has(c.sheet)) bySheet.set(c.sheet, []); bySheet.get(c.sheet).push(c); });
    let n = 0, d = 0; const EMU = 360000;
    for (const [sheet, list] of bySheet) {
      const si = sheetNames.indexOf(sheet) + 1; d++;
      const drawRels = []; let anchors = '';
      for (const c of list) {
        n++; z.file(`xl/charts/chart${n}.xml`, chartXml(c));
        ct = ct.replace('</Types>', `<Override PartName="/xl/charts/chart${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>`);
        drawRels.push(`<Relationship Id="rId${drawRels.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart${n}.xml"/>`);
anchors += `<xdr:oneCellAnchor><xdr:from><xdr:col>${c.col}</xdr:col><xdr:colOff>${c.colOff || 0}</xdr:colOff><xdr:row>${c.row}</xdr:row><xdr:rowOff>${c.rowOff || 0}</xdr:rowOff></xdr:from><xdr:ext cx="${Math.round(c.w * EMU)}" cy="${Math.round(c.h * EMU)}"/><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${n + 1}" name="Chart ${n}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId${drawRels.length}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:oneCellAnchor>`;
      }
      z.file(`xl/drawings/chartdrawing${d}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${anchors}</xdr:wsDr>`);
      z.file(`xl/drawings/_rels/chartdrawing${d}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${drawRels.join('')}</Relationships>`);
      ct = ct.replace('</Types>', `<Override PartName="/xl/drawings/chartdrawing${d}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>`);
      const relPath = `xl/worksheets/_rels/sheet${si}.xml.rels`;
      let rels = z.file(relPath) ? await z.file(relPath).async('string') : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
      rels = rels.replace('</Relationships>', `<Relationship Id="rIdChartDrawing" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/chartdrawing${d}.xml"/></Relationships>`);
      z.file(relPath, rels);
      const shPath = `xl/worksheets/sheet${si}.xml`;
      let x = await z.file(shPath).async('string');
      const tag = '<drawing r:id="rIdChartDrawing"/>';
      // <drawing> goes after page setup and before the sheet-level extLst – not inside a conditional format's own extLst
      const from = Math.max(0, x.lastIndexOf('</conditionalFormatting>'), x.lastIndexOf('<pageSetup'), x.lastIndexOf('</headerFooter>'));
      const at = ['<legacyDrawing', '<legacyDrawingHF', '<picture', '<oleObjects', '<controls', '<webPublishItems', '<tableParts', '<extLst'].map((t) => x.indexOf(t, from)).filter((i) => i >= 0);
      const pos = at.length ? Math.min(...at) : x.lastIndexOf('</worksheet>');
      x = x.slice(0, pos) + tag + x.slice(pos);
      z.file(shPath, x);
    }
    z.file('[Content_Types].xml', ct);
    // ExcelJS writes <pageSetUpPr> before <outlinePr> when a sheet has both fit-to-page and outline settings; Excel requires
    // tabColor → outlinePr → pageSetUpPr and refuses the file otherwise. Put the children of <sheetPr> in schema order.
    for (const name of Object.keys(z.files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))) {
      const x = await z.file(name).async('string');
      const m = x.match(/<sheetPr([^>]*)>([\s\S]*?)<\/sheetPr>/); if (!m) continue;
      const kids = m[2].match(/<(tabColor|outlinePr|pageSetUpPr)\b[^>]*\/>/g) || [];
      const rank = (t) => ['tabColor', 'outlinePr', 'pageSetUpPr'].findIndex((k) => t.startsWith('<' + k));
      const sorted = kids.slice().sort((a, b) => rank(a) - rank(b)).join('');
      if (sorted !== m[2]) z.file(name, x.replace(m[0], `<sheetPr${m[1]}>${sorted}</sheetPr>`));
    }
    // Service Monthly: save the sort by Order inside its AutoFilter, so Data › Reapply re-groups the rows (ExcelJS cannot write sortState)
    if (extra && extra.sort) { const name = `xl/worksheets/sheet${extra.sort.sheet}.xml`, f = z.file(name);
      if (f) { const x = await f.async('string');
        z.file(name, x.replace(/<autoFilter ref="([^"]+)"\/>/, (m, ref) => `<autoFilter ref="${ref}"><sortState ref="${extra.sort.ref}"><sortCondition ref="${extra.sort.key}"/></sortState></autoFilter>`)); } }
    // Excel's background checks flag the month-to-total sums ("formula omits adjacent cells"), codes kept as text and
    // column-consistent formulas that differ on header rows – all intended here, so each sheet ignores those checks
    for (const name of Object.keys(z.files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))) {
      let x = await z.file(name).async('string'); const dim = (x.match(/<dimension ref="([^"]+)"/) || [])[1];
      if (!dim || x.includes('<ignoredErrors')) continue;
      const tag = `<ignoredErrors><ignoredError sqref="${dim.includes(':') ? dim : dim + ':' + dim}" numberStoredAsText="1" formula="1" formulaRange="1"/></ignoredErrors>`;
      const at = ['<smartTags', '<drawing', '<legacyDrawing', '<legacyDrawingHF', '<picture', '<oleObjects', '<controls', '<webPublishItems', '<tableParts'].map((t) => x.indexOf(t)).filter((i) => i >= 0);
      const ext = x.lastIndexOf('<extLst'), pos = at.length ? Math.min(...at) : (ext > x.lastIndexOf('</conditionalFormatting>') && ext > 0 ? ext : x.lastIndexOf('</worksheet>'));
      z.file(name, x.slice(0, pos) + tag + x.slice(pos));
    }
    // a grouped column that is shown must not carry collapsed="1" (Excel then offers to repair the file)
    for (const name of Object.keys(z.files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))) {
      const x = await z.file(name).async('string');
      const y = x.replace(/<col\b[^>]*\/>/g, (t) => (/collapsed="1"/.test(t) && !/hidden="1"/.test(t) ? t.replace(/\s*collapsed="1"/, '') : t));
      if (y !== x) z.file(name, y); }
    { // ExcelJS writes every border side in a conditional-format style; an empty side would switch that line off, so drop them
      const f = z.file('xl/styles.xml');
      if (f) { const st0 = await f.async('string');
        z.file('xl/styles.xml', st0.replace(/<dxfs[\s\S]*?<\/dxfs>/, (d) => d.replace(/<(left|right|top|bottom|diagonal)\/>/g, ''))); }
    }
    return z.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  }

  async function buildWorkbook(A, libs, progress) {
    const { ExcelJS, JSZip } = libs; const say = progress || (() => {});
    const det = A.det, MAINPC = A.MAINPC, months = A.months, omonths = A.omonths;
    const wb = new ExcelJS.Workbook(); wb.creator = 'Subcontract report'; wb.calcProperties.fullCalcOnLoad = true;
    const ORDER = ['Dashboard', 'Service Monthly', 'Service Quarterly', 'Package Monthly', 'Service Coding', 'Changes', 'Detail', 'PO Register', 'By Supplier', 'Subcontractor x Trade',
      'Subcontractors over time', 'Qty Reconciliation', 'Coding', 'Notes', '_History', '_Lines', '_Rows', '_Chart'];
    const S = {}; for (const n of ORDER) S[n] = makeSheetApi(wb.addWorksheet(n, n === 'Dashboard' || n === 'Subcontractor x Trade' || n === 'Subcontractors over time' || n === 'Changes' || n === 'Package Monthly' ? { views: [{ showGridLines: false }] } : {}));
    const charts = [];
    for (const [color, names] of TAB_GROUPS) for (const n of names) S[n].ws.properties.tabColor = { argb: 'FF' + color };

    // ---------------- Coding
    await say('Coding'); const cd = S['Coding'];
    const tabs = [[1, 'Resource code', 'Resource name', RESOURCES], [4, 'Trade code', 'Trade name', TRADES], [7, 'Tax code', 'VAT rate', Object.entries(VATR)],
      [10, 'Contract type code', 'Contract type name', [['A1', 'غير شامل – price excludes VAT'], ['A2', 'شامل – price includes VAT']]]];
    for (const [c, h1, h2, data] of tabs) {
      cd.hdr(1, c, h1); cd.hdr(1, c + 1, h2);
      data.forEach(([k, v], i) => { cd.set(i + 2, c, k, { font: st.BLUE, fmt: '@' }); cd.set(i + 2, c + 1, v, { font: st.BLUE, fill: FILL.YF, fmt: h2 === 'VAT rate' ? '0%' : undefined }); });
      cd.width(c, 12); cd.width(c + 1, h2 === 'VAT rate' ? 10 : 32);
    }
    cd.ws.getCell('H1').note = 'Inferred from the exports: VAT Current ÷ SC Work Current Cost is 0% for P0, 10% for P2, 14% for P3.';
    cd.ws.getCell('K1').note = 'A2 (شامل): SAP pays Qty × Gross price ÷ (1 + VAT). A1 (غير شامل): SAP pays Qty × Gross price.';
    cd.hdr(1, 13, 'Setting'); cd.hdr(1, 14, 'Value');
    cd.set(2, 13, 'Cut date (last day of the report month, chosen in the web tool)', { font: st.F });
    cd.set(2, 14, A.cutDate, { font: st.B, fmt: 'dd-mmm-yyyy', align: { horizontal: 'center' } });
    cd.set(3, 13, 'Report month (YYYYMM)', { font: st.F }); cd.set(3, 14, '=YEAR(N2)*100+MONTH(N2)', { font: st.F, fmt: '0', align: { horizontal: 'center' } });
    cd.set(4, 13, 'A line dated after the cut date, or not approved, is Pending: shown in its own block, not in Total. Rebuild in the web tool to change the month.', { font: st.IT });
    cd.width(13, 58); cd.width(14, 13);
    cd.set(22, 1, 'Yellow cells are editable. New codes can be added below a table (up to row 50).', { font: st.IT });
    const pkgs = (A.opts.master && A.opts.master.packages) || PACKAGES, mnls = (A.opts.master && A.opts.master.mnl) || MNLS;
    cd.hdr(1, 16, 'Package'); cd.hdr(1, 17, 'Package name'); cd.hdr(1, 18, 'Group');
    pkgs.forEach((p, i) => { cd.set(i + 2, 16, p.code, { font: st.F }); cd.set(i + 2, 17, `${p.icon ? p.icon + ' ' : ''}${p.label}`, { font: st.F }); cd.set(i + 2, 18, p.group, { font: st.F }); });
    cd.hdr(1, 20, 'MNL'); cd.hdr(1, 21, 'MNL name'); mnls.forEach((m, i) => { cd.set(i + 2, 20, m.code, { font: st.F }); cd.set(i + 2, 21, m.label, { font: st.F }); });
    [11, 30, 10].forEach((w, j) => cd.width(16 + j, w)); cd.width(20, 8); cd.width(21, 16);
    cd.ws.getCell('P1').note = 'Work package catalogue (from the work package master). Edit it in the master, not here.';

    // ---------------- Service Coding
    await say('Service Coding'); const sc = S['Service Coding'];
    ['Svc ID', 'Service', 'Service text', 'Unit', 'Unit source', 'Package', 'MNL', 'Cost Element Code', 'Lines', 'Total amount'].forEach((v, j) => {
      const y = ['Unit', 'Package', 'MNL', 'Cost Element Code'].includes(v); sc.hdr(1, j + 1, v, y ? FILL.YF : FILL.HF, y ? st.HB : st.H); });
    const linesBy = countBy(det, (r) => r.sid); const NSC = A.services.length + 1;
    for (const s of A.services) {
      const i = s.id + 1;
      [s.id, s.svc, s.text, s.unit || null, s.unitSrc, s.csi || null, s.mnl || null, s.cec || null, linesBy.get(s.id) || 0].forEach((v, j) => sc.set(i, j + 1, v, { font: st.F }));
      for (const j of [4, 6, 7, 8]) sc.set(i, j, undefined, { fill: FILL.YF, font: st.BLUE });
      sc.set(i, 2, undefined, { fmt: '@' });
      if (!s.unit) sc.set(i, 5, undefined, { font: st.RED });
    }
    [7, 11, 46, 8, 26, 12, 12, 18, 7, 15].forEach((w, j) => sc.width(j + 1, w));
    sc.ws.views = [{ state: 'frozen', xSplit: 3, ySplit: 1 }]; sc.ws.autoFilter = `A1:J${NSC}`;
    sc.ws.getCell('D1').note = 'Filled from the shared coding when someone has entered it, otherwise from ZSCSRV1 (PO Service UOM). Editable.';
    sc.ws.getCell('F1').note = 'Package (CSI division), MNL and Cost Element for this project, one row per Service + Service text, from the work package master. Blank = not coded.';

    // ---------------- Detail
    await say('Detail'); const dt = S['Detail'];
    const cols = ['Row key', 'Svc ID', 'Cert. date', 'Month', 'Report bucket', 'Approved (Character 1)', 'Initial invoice (Flag)', 'Cert. serial', 'PO', 'Supplier code', 'Supplier name',
      'Invoice doc.', 'Entry sheet', 'Doc type', 'PO item', 'Service', 'Service text', 'Line type', 'Unit', 'Contract type', 'Tax code', 'VAT rate', 'Gross price', 'Net rate',
      'Total qty', 'Previous qty', 'Current qty', 'Paid % (Progress %)', 'Cost (excl VAT)', 'VAT current', 'Resource', 'Trade', 'Resource name', 'Trade name',
      'G/L acct', 'WBS element (ref. only)', 'WBS description (ref. only)', 'PO line ref', 'PO line match', 'Material group', 'Material group description', 'Profit centre',
      'Other profit centre', 'Report qty', 'Qty basis', 'Approval note', 'Line ID', 'WBS rows (split)', 'First seen (load)', 'Qty check', 'Pending reason', 'Reported-month flag', 'Include in this report'];
    const C = {}; cols.forEach((n, j) => { C[n] = L(j + 1); dt.hdr(1, j + 1, n); }); const INC = C['Include in this report'];
    dt.ws.getCell(C['Report qty'] + '1').note = 'Quantity used in the report. Equals SAP Current qty unless the line was not paid at qty × net rate (paid % below 100, a catch-up, a re-price): then amount ÷ net rate, so the rate stays the contract rate. Adjustment lines also get amount ÷ net rate (negative for a deduction), so the service quantity accumulates correctly. SAP qty stays in Current qty and feeds Qty Reconciliation.';
    dt.ws.getCell(C['Other profit centre'] + '1').note = `X = charged to a profit centre other than the project's main one (${MAINPC}).`;
    dt.ws.getCell('E1').note = `PENDING = not approved (Character 1 blank) or dated after the cut date ${A.cutDate.toISOString().slice(0, 10)} (Coding!N2) – see Pending reason. OPENING = approved initial invoice (Flag X). Otherwise the certificate month.`;
    dt.ws.getCell(1, cols.length).note = 'Added to a reported month = a line dated in a month the last report already showed, but not among its lines (late / back-dated). Approved after the month was reported = it was in the last report as not approved.';
    dt.ws.getCell('R1').note = 'Adjustment = amount with zero quantity, or a ≤ 0.01 placeholder quantity that does not explain the amount: payment-% changes, re-pricing, reversals. Qty only (excluded) = quantity with zero amount – no row key, never in Service Monthly or the Dashboard.';
    const sorted = det.slice().sort((a, b) => cmpTuple([a.dateKey, a.po, a.serial, a.svc], [b.dateKey, b.po, b.serial, b.svc]));
    const dtRows = [];
    sorted.forEach((r, n) => {
      const i = n + 2;
      const eq = `AND(X${i}<>0,ABS(AC${i}-AA${i}*X${i})>1)`;
      dtRows.push([r.isqo ? null : r.rk, r.sid, r.dateObj, { formula: `YEAR(C${i})*100+MONTH(C${i})` },
        { formula: `IF(OR(F${i}<>"X",AND(D${i}>Coding!$N$3,${INC}${i}<>"Include")),"PENDING",IF(G${i}="X","OPENING",D${i}))` }, r.appr || null, r.flag || null,
        r.serial, r.po, r.supCode, r.supName, str(r.docno).trim() || null, str(r.es).trim() || null, str(r.doctype).trim(), r.item, r.svc, r.text, r.lt,
        { formula: lk('Service Coding', 'A', 'D', `B${i}`, '""', NSC) }, r.ctype, r.tax, { formula: lk('Coding', 'G', 'H', `U${i}`, '0') }, r.price, { formula: `IF(T${i}="A2",W${i}/(1+V${i}),W${i})` },
        r.totq, r.prevq, r.qty, r.paid / 100, r.amt, r.vat, r.res, r.trade,
        { formula: lk('Coding', 'A', 'B', `AE${i}`) }, { formula: lk('Coding', 'D', 'E', `AF${i}`) }, str(r.gl).trim(), str(r.wbs).trim(), str(r.wbsDesc).trim(),
        r.poref, r.matchLvl, r.mg || null, r.mgd || null, r.pc, r.othpc ? 'X' : null,
        { formula: `IF(R${i}="Normal",IF(${eq},AC${i}/X${i},AA${i}),IF(AND(R${i}="Adjustment",X${i}<>0),AC${i}/X${i},0))` },
        { formula: `IF(R${i}="Adjustment",IF(X${i}<>0,"Adjustment (amount ÷ net rate)","Adjustment – no net rate"),IF(R${i}<>"Normal","",IF(${eq},"Equivalent (amount ÷ net rate)","SAP qty")))` },
        (r.initial && !r.approved) ? 'Opening – not approved' : null, r.lid, r.split || null, r.first, r.qcheck,
        { formula: `IF(F${i}<>"X","Not approved",IF(D${i}>Coding!$N$3,IF(${INC}${i}="Include","","After cut date"),""))` }, r.late || null,
        r.approved && r.month > A.CUT ? 'Not included' : null]);
    });
    dt.ws.addRows(dtRows);
    { // after-cut lines: a drop-down lets the user count the line in this report, in its own month (Service Monthly adapts live)
      const ic = cols.length;
      dt.ws.getCell(1, ic).note = `Lines dated after the cut date (${A.cutDate.toISOString().slice(0, 10)}) are Pending. Pick "Include" to count one in this report: it leaves Pending and joins its month on Service Monthly, Package Monthly and the Dashboard at once. Service Quarterly holds values – its row 2 check shows the difference until the report is rebuilt. Not-approved lines stay Pending.`;
      sorted.forEach((r, n) => { if (!(r.approved && r.month > A.CUT)) return; const x = dt.ws.getCell(n + 2, ic);
        x.dataValidation = { type: 'list', allowBlank: true, formulae: ['"Include,Not included"'] }; }); }
    { const qc = cols.indexOf('Qty check') + 1; dt.ws.getCell(1, qc).note = 'Adjustment lines only. The report qty (amount ÷ net rate) is kept; "Check" means the PO service line has no normal qty to net it against, or the adjustment takes that line\'s qty below zero – usually a deduction booked on a placeholder-priced line. Review the qty before using it.';
      sorted.forEach((r, n) => { if (!r.qcheck) return; const i = n + 2; dt.ws.getCell(i, qc).font = { ...st.RED, bold: true }; dt.ws.getCell(i, qc).fill = FILL.AF;
        dt.ws.getCell(i, cols.indexOf('Report qty') + 1).font = { ...st.RED, bold: true }; }); }
    const textCols = [8, 9, 10, 12, 13, 15, 16, 20, 21, 31, 32, 35, 42];
    const colFmt = { 3: 'yyyy-mm-dd', 4: '0', 22: '0%', 28: '0%', 23: QTY, 24: QTY, 25: QTY, 26: QTY, 27: QTY, 29: QTY, 30: QTY, 44: QTY };
    cols.forEach((_, j) => { const col = dt.ws.getColumn(j + 1); col.font = st.F; if (colFmt[j + 1]) col.numFmt = colFmt[j + 1]; if (textCols.includes(j + 1)) col.numFmt = '@'; });
    dt.ws.getRow(1).eachCell((c) => { c.font = st.H; });
    sorted.forEach((r, n) => { if (r.othpc) { dt.ws.getCell(n + 2, 42).fill = FILL.PCF; dt.ws.getCell(n + 2, 43).fill = FILL.PCF; } });
    [13, 6, 11, 8, 10, 9, 9, 7, 12, 11, 28, 12, 12, 8, 6, 10, 38, 10, 6, 8, 6, 6, 10, 10, 10, 10, 10, 8, 13, 11, 6, 6, 16, 22, 10, 20, 26, 22, 16, 10, 22, 10, 8, 11, 26, 20, 30, 9, 9, 30, 14, 30, 16].forEach((w, j) => dt.width(j + 1, w));
    const NR = det.length + 1;
    dt.ws.views = [{ state: 'frozen', xSplit: 6, ySplit: 1 }];                     // Row key … Approved stay in view dt.ws.autoFilter = `A1:${L(cols.length)}${NR}`;
    const R = (n) => `Detail!$${C[n]}$2:$${C[n]}$${NR}`;

    let SM_ORDER, SM_TOTAL, SM_PEND, SM_COLS; const supName = new Map(); for (const r of det) supName.set(r.supCode, r.supName);   // also used by By Supplier
    const PM = {};                                              // Package Monthly layout, read by the Dashboard
    { // own scope: the sheet's local names stay apart from the other sheets'
    // ---------------- Service Monthly / Service Quarterly: one flat table each (same rows, same order), laid out like Material Monthly.
    //   rows 1 TOTAL (SUBTOTAL, follows filters) · 2 check against Detail · 3 year · 4 month / quarter · 5 column names · data from 6
    //   columns Identity (11) → Opening → one Qty / Rate / Amount block per period → Total (Price, Qty, Avg rate, Amount) → Pending → reference (folded)
    //   Service Monthly figures are live SUMIFS on Detail; Service Quarterly figures are values with a live check per quarter.
    //   Package / MNL / Cost element / Unit are live lookups on both, so re-coding changes a row where it stands.
    await say('Service Monthly');
    const mgrp = new Map(), chk = new Set();
    for (const r of det) { if (r.isqo) continue; if (!mgrp.has(r.rk)) mgrp.set(r.rk, new Map()); if (r.mg || r.mgd) mgrp.get(r.rk).set(r.mg + '\u0001' + r.mgd, [r.mg, r.mgd]); if (r.qcheck) chk.add(r.rk); }
    const grouped = (a, b) => { const ta = A.keyTuples[a], tb = A.keyTuples[b];
      return cmp(ta[0], tb[0]) || cmp(ta[1], tb[1]) || cmp(ta[8], tb[8]) || ta[2] - tb[2] || cmpTuple(ta, tb); };   // service → text → PO → normal before adjustment
    const all = A.keyTuples.map((_, i) => i);
    // build order: work package (catalogue order, UNALLOCATED last) → service → text → PO. No header or blank rows, so sort / filter / copy never break.
    const cod = A.opts.coding || new Map(), cat = (A.opts.master && A.opts.master.packages) || PACKAGES;
    const pkgOf = (i) => { const c = normPkg((cod.get(codingKey(A.keyTuples[i][0], A.keyTuples[i][1])) || {}).csi || ''); return cat.some((p) => p.code === c) ? c : ''; };
    SM_ORDER = [...cat.map((p) => p.code), ''].flatMap((code) => all.filter((i) => pkgOf(i) === code).sort(grouped));
    const agg = new Map();                                     // Row ID -> bucket -> [report qty, amount]
    for (const r of det) { if (r.isqo || !r.rk) continue; let m = agg.get(r.rk); if (!m) agg.set(r.rk, (m = new Map()));
      const x = m.get(r.bucket) || [0, 0]; x[0] += r.repq; x[1] += r.amt; m.set(r.bucket, x); }
    const ID = ['Row ID', 'Package', 'MNL', 'Cost element', 'Service', 'Description', 'PO', 'Supplier code', 'Supplier', 'Line type', 'Unit'];
    const REF = ['Rate check', 'First seen (load)', 'Svc ID', 'Contract type', 'Tax code', 'Gross price', 'Resource', 'Trade', 'Material group', 'Material group description', 'Profit centre'];
    const AMTF = '#,##0;[Red]-#,##0;;@', QTYF = '#,##0.00;[Red]-#,##0.00;;@', R1 = 6, RN = R1 + SM_ORDER.length - 1;
    const DTR = (n) => `Detail!$${C[n]}$2:$${C[n]}$${NR}`;
    // periods: [{ label, year, fill, keys: [buckets], crit: SUMIFS criteria on Detail → Report bucket }]
    // live = true (Service Monthly): every Qty / Amount cell is a SUMIFS on Detail by Row ID and bucket; otherwise values (Service Quarterly)
    function flatSheet(sh, periods, what, live) {
      const nI = ID.length, O0 = nI + 1, P0 = O0 + 3, T0 = P0 + 3 * periods.length, PE = T0 + 4, RF = PE + 3, LASTC = RF + REF.length - 1;
      const rc = (n) => RF + REF.indexOf(n);
      const blocks = [{ label: 'Opening', keys: ['OPENING'], crit: ['"OPENING"'], col: O0, fill: '9C7A38' },
        ...periods.map((p, i) => ({ ...p, col: P0 + 3 * i })), { label: 'Pending – not in Total', keys: ['PENDING'], crit: ['"PENDING"'], col: PE, fill: '8E3B37' }];
      const hd = (r, c, v, f, al) => sh.set(r, c, v, { font: { ...st.H, size: 9.5 }, fill: fill(f), fmt: 'General', align: { horizontal: al || 'center', vertical: 'middle', wrapText: al !== 'centerContinuous' } });
      // header rows 3–5; labels spanning several columns are centred across the selection, never merged
      for (let c = 1; c <= LASTC; c++) for (const r of [3, 4, 5]) hd(r, c, null, c < O0 ? '0F2A52' : c >= RF ? '6B7280' : '1F3E6B');
      ID.forEach((h, j) => hd(5, 1 + j, h, '0F2A52'));
      const span = (r, c1, c2, v, f) => { for (let c = c1; c <= c2; c++) hd(r, c, c === c1 ? v : null, f, 'centerContinuous'); };
      for (const b of blocks) { span(4, b.col, b.col + 2, b.label, b.fill); span(3, b.col, b.col + 2, null, b.fill); ['Qty', 'Rate', 'Amount'].forEach((t, o) => hd(5, b.col + o, t, b.fill)); }
      let y0 = 0; periods.forEach((p, i) => { if (i === 0 || periods[i - 1].year !== p.year) y0 = i;
        if (i === periods.length - 1 || periods[i + 1].year !== p.year) span(3, P0 + 3 * y0, P0 + 3 * i + 2, p.year, p.fill); });
      span(3, T0, T0 + 3, null, '7A5C1E'); span(4, T0, T0 + 3, 'Total', '7A5C1E'); ['Price', 'Qty', 'Avg rate', 'Amount'].forEach((t, o) => hd(5, T0 + o, t, '7A5C1E'));
      span(4, RF, LASTC, 'Reference', '6B7280'); REF.forEach((h, j) => hd(5, RF + j, h, '6B7280'));
      // data rows
      let band = 0, prevSvc = null; const DF = fill('F3F6FB'), WF = fill('FFFFFF');
      const rows = SM_ORDER.map((idx, n) => {
        const i = R1 + n, t = A.keyTuples[idx], [svc, text, adj, sup, price, ctype, tax, pc, po] = t, id = A.rowIds[idx];
        const sid = A.svcId.get(codingKey(svc, text)), mg = [...(mgrp.get(id) || new Map()).values()], a = agg.get(id) || new Map();
        const SIDc = `$${L(rc('Svc ID'))}${i}`, code = (col) => `${lk('Service Coding', 'A', col, SIDc, '""', NSC)}&""`;   // &"" keeps an empty code blank, not 0
        const dig = (v) => (/^\d{1,15}$/.test(v) ? Number(v) : v), row = [];
        row[0] = id; row[1] = { formula: `IF(${code('F')}="","UNALLOCATED",${code('F')})` }; row[2] = { formula: code('G') }; row[3] = { formula: code('H') };
        row[4] = svc; row[5] = text; row[6] = dig(po); row[7] = dig(sup); row[8] = supName.get(sup);
        row[9] = adj ? (chk.has(id) ? '⚠ Adjustment – check' : 'Adjustment') : 'Normal'; row[10] = { formula: code('D') };
        const put = (c, q, am) => { if (q) row[c - 1] = q; if (q) row[c] = am / q; if (am) row[c + 1] = am; };
        const sumifs = (col, b) => b.crit.map((cr) => `SUMIFS(${DTR(col)},${DTR('Row key')},$A${i},${DTR('Report bucket')},${cr})`).join('+');
        let tq = 0, ta = 0;
        for (const b of blocks) { let q = 0, am = 0; for (const k of b.keys) { const x = a.get(k); if (x) { q += x[0]; am += x[1]; } }
          if (live) { row[b.col - 1] = { formula: sumifs('Report qty', b) }; row[b.col] = { formula: `IF(${L(b.col)}${i}=0,"",${L(b.col + 2)}${i}/${L(b.col)}${i})` };
            row[b.col + 1] = { formula: sumifs('Cost (excl VAT)', b) }; }
          else put(b.col, q, am);
          if (b.keys[0] !== 'PENDING') { tq += q; ta += am; } }
        const net = ctype === 'A2' ? price / (1 + (VATR[tax] || 0)) : price, inT = blocks.filter((b) => b.keys[0] !== 'PENDING');
        row[T0 - 1] = net;
        if (live) { row[T0] = { formula: inT.map((b) => L(b.col) + i).join('+') }; row[T0 + 2] = { formula: inT.map((b) => L(b.col + 2) + i).join('+') };
          row[T0 + 1] = { formula: `IF(${L(T0 + 1)}${i}=0,"",${L(T0 + 3)}${i}/${L(T0 + 1)}${i})` }; }
        else { if (tq) { row[T0] = tq; row[T0 + 1] = ta / tq; } if (ta) row[T0 + 2] = ta; }
        const refv = { 'Rate check': live ? { formula: `ROUND(${L(T0 + 3)}${i}-${L(T0 + 1)}${i}*${L(T0)}${i},0)` } : (Math.round(ta - tq * net) || null), 'First seen (load)': A.rowFirst[idx], 'Svc ID': sid, 'Contract type': ctype, 'Tax code': tax, 'Gross price': price,
          Resource: { formula: lk('Coding', 'A', 'B', `"${svc.slice(0, 1)}"`) }, Trade: { formula: lk('Coding', 'D', 'E', `"${trade(svc)}"`) },
          'Material group': mg.map((x) => x[0]).sort().join(' / ') || null, 'Material group description': mg.map((x) => x[1]).sort().join(' / ') || null, 'Profit centre': pc };
        REF.forEach((h, j) => { row[RF - 1 + j] = refv[h]; });
        if (svc + '\u0001' + text !== prevSvc) { band ^= 1; prevSvc = svc + '\u0001' + text; }
        return { row, look: adj ? FILL.AF : (pc !== MAINPC ? FILL.PCF : (band ? DF : WF)), isNew: A.rowsCarried && A.rowFirst[idx] === A.loadNo, adj, check: chk.has(id) };
      });
      sh.ws.addRows(new Array(R1 - 1 - sh.ws.rowCount).fill([]));
      sh.ws.addRows(rows.map((x) => x.row));
      rows.forEach((x, n) => { const xr = sh.ws.getRow(R1 + n); xr.height = 17;              // one height for every row: heights stay put when Excel sorts
        for (let c = 1; c <= LASTC; c++) xr.getCell(c).fill = x.look;
        if (x.isNew) for (const c of [1, 5, 6, 7, 9, rc('First seen (load)')]) xr.getCell(c).fill = FILL.NEWF;
        if (x.adj) xr.getCell(10).font = { ...st.F, size: 9.5, bold: true, color: { argb: x.check ? 'FFB4413C' : 'FFB0561F' } }; });
      // column formats, fonts, widths
      const MONO = { ...st.F, name: 'Consolas', size: 9.5 };
      [13, 11, 7, 11, 12, 44, 12, 11, 28, 13, 6].forEach((w, j) => sh.width(1 + j, w));
      for (let c = 1; c <= LASTC; c++) sh.ws.getColumn(c).font = { ...st.F, size: 9.5 };
      for (const c of [1, 5, 7, 8]) { sh.ws.getColumn(c).font = MONO; sh.ws.getColumn(c).alignment = { horizontal: c === 5 || c === 1 ? 'left' : 'center' }; }
      sh.ws.getColumn(6).alignment = { horizontal: 'right', indent: 1 }; sh.ws.getColumn(9).alignment = { horizontal: 'right', readingOrder: 'rtl', indent: 1 };
      sh.ws.getColumn(10).alignment = { horizontal: 'left', indent: 1 };
      for (const c of [1, 5]) sh.ws.getColumn(c).numFmt = '@'; for (const c of [7, 8]) sh.ws.getColumn(c).numFmt = '0';
      for (const b of blocks) { sh.width(b.col, 9); sh.width(b.col + 1, 8.5); sh.width(b.col + 2, 11.5);
        sh.ws.getColumn(b.col).numFmt = QTYF; sh.ws.getColumn(b.col + 1).numFmt = QTYF; sh.ws.getColumn(b.col + 2).numFmt = AMTF;
        sh.ws.getColumn(b.col).outlineLevel = 1; sh.ws.getColumn(b.col + 1).outlineLevel = 1; }        // Qty and Rate fold; "+" sits above the Amount
      [10, 11, 10, 13].forEach((w, j) => { sh.width(T0 + j, w); sh.ws.getColumn(T0 + j).numFmt = j === 3 ? AMTF : QTYF; });
      for (let j = 0; j < 3; j++) sh.ws.getColumn(T0 + j).outlineLevel = 1;
      sh.ws.getColumn(T0 + 3).font = { ...st.B, size: 9.5 };
      REF.forEach((h, j) => { const col = sh.ws.getColumn(RF + j); col.width = [10, 8, 7, 8, 7, 10, 12, 18, 12, 26, 10][j]; col.outlineLevel = 1; col.hidden = true; });
      sh.ws.getColumn(rc('Rate check')).numFmt = AMTF; sh.ws.getColumn(rc('Gross price')).numFmt = QTYF;
      for (const n of ['Svc ID', 'First seen (load)', 'Contract type', 'Tax code']) sh.ws.getColumn(rc(n)).alignment = { horizontal: 'center' };
      sh.ws.getColumn(rc('Material group')).numFmt = '@'; sh.ws.getColumn(rc('Tax code')).numFmt = '@';
      // block edges: plain borders in the same columns on every row, so a sort cannot misplace them
      for (let i = 3; i <= RN; i++) { const g = sh.ws.getCell(i, T0); g.border = { left: { style: 'medium', color: { argb: 'FFC8A45C' } } };
        for (const b of blocks) { const x = sh.ws.getCell(i, b.col); x.border = { left: { style: b.keys[0] === 'PENDING' ? 'medium' : 'thin', color: { argb: b.keys[0] === 'PENDING' ? 'FFC8A45C' : 'FF8EA9DB' } } }; } }
      // row 1 TOTAL (follows the filter) · row 2 check: each Amount column re-added from Detail, ✔ or the difference
      const amtCols = [...blocks.map((b) => b.col + 2), T0 + 3];
      for (const r of [1, 2]) { sh.ws.getRow(r).height = 18; for (let c = 1; c <= LASTC; c++) { const x = sh.ws.getCell(r, c); x.fill = r === 1 ? FILL.TF : fill('F4F6F9'); x.numFmt = 'General';
        x.border = r === 1 ? { top: { style: 'medium', color: { argb: 'FFC8A45C' } }, bottom: { style: 'thin', color: { argb: 'FFC8A45C' } } } : { bottom: { style: 'medium', color: { argb: 'FFC8A45C' } } }; } }
      sh.set(1, 6, `TOTAL · ${SM_ORDER.length} rows · follows the filter`, { font: { ...st.B, size: 9.5 }, align: { horizontal: 'right' } });
      sh.set(2, 6, `CHECK · ${what} re-added from Detail – ✔ = ties`, { font: { ...st.SMALL, size: 9 }, align: { horizontal: 'right' } });
      const AMD = DTR('Cost (excl VAT)'), BKD = DTR('Report bucket');
      for (const c of amtCols) {
        sh.set(1, c, `=SUBTOTAL(9,${L(c)}${R1}:${L(c)}${RN})`, { font: { ...st.B, size: 9.5 }, fmt: AMTF });
        const b = blocks.find((x) => x.col + 2 === c), src = b ? b.crit.map((cr) => `SUMIFS(${AMD},${BKD},${cr})`).join('+') : `SUMIFS(${AMD},${BKD},"<>PENDING")`;
        const d = `ROUND(${src}-SUM(${L(c)}${R1}:${L(c)}${RN}),0)`;
        sh.set(2, c, `=IF(${d}=0,"✔",${d})`, { font: { ...st.B, size: 9.5, color: { argb: 'FF1B7A4A' } }, fmt: '#,##0;[Red]-#,##0', align: { horizontal: 'center' } }); }
      sh.set(RN + 2, 6, 'Qty is not totalled across rows – units differ. Rate = Amount ÷ Qty. Orange = adjustment (qty = amount ÷ net rate), ⚠ = flagged in Detail → Qty check. Blue tint = other profit centre. Green = new row since the last report. Package / MNL / Cost element follow Service Coding live – re-coding changes the row where it stands; sort and filter freely. The Row ID matches a row across months. "+" above an Amount shows its Qty and Rate; "+" at the far right shows the reference columns.', { font: st.IT });
      // the header look goes back on after the column-wide formats (they would otherwise paint over the white header text)
      for (const r of [3, 4, 5]) for (let c = 1; c <= LASTC; c++) { const x = sh.ws.getCell(r, c); x.font = { ...st.H, size: r === 3 ? 10 : 9.5 }; x.numFmt = 'General';
        x.alignment = { horizontal: x.alignment && x.alignment.horizontal === 'centerContinuous' ? 'centerContinuous' : 'center', vertical: 'middle', wrapText: !(x.alignment && x.alignment.horizontal === 'centerContinuous') }; }
      sh.ws.getRow(5).height = 28;
      sh.ws.properties.outlineLevelCol = 1; sh.ws.properties.outlineProperties = { summaryBelow: false, summaryRight: true };
      sh.ws.views = [{ state: 'frozen', xSplit: nI, ySplit: 5, showGridLines: false, zoomScale: 90 }];
      sh.ws.autoFilter = { from: { row: 5, column: 1 }, to: { row: RN, column: LASTC } };
      sh.ws.pageSetup = { paperSize: 8, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:5',
        margins: { left: 0.25, right: 0.25, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 } };
      return { O0, P0, T0, PE, RF, LASTC, blocks, amtCol: (b) => b.col + 2 };
    }
    const yr = (m) => Math.floor(m / 100);
    const MS = flatSheet(S['Service Monthly'], A.allMonths.map((m, i) => ({ label: MON[(m % 100) - 1] + (m === A.CUT ? ' ◂' : m > A.CUT ? ' · after cut' : ''), year: yr(m), keys: [m], crit: [m],
      fill: m > A.CUT ? '8E3B37' : (i % 2 ? '1F3E6B' : '0F2A52') })), 'every Amount', true);
    SM_COLS = { ...MS, R1, RN }; SM_TOTAL = `SUM('Service Monthly'!${L(MS.T0 + 3)}${R1}:${L(MS.T0 + 3)}${RN})`; SM_PEND = `SUM('Service Monthly'!${L(MS.PE + 2)}${R1}:${L(MS.PE + 2)}${RN})`;
    S['Service Monthly'].ws.getCell(5, 1).note = 'Permanent: a row keeps its Row ID in every later report, whatever the sort order. Detail → Row key carries the same ID.';
    S['Service Monthly'].ws.getCell(4, MS.PE).note = `Pending = dated after the cut date (${A.cutDate.toISOString().slice(0, 10)}) or not approved (Detail → Pending reason) – not in Total. A line picked as "Include" on Detail → Include in this report moves into its month block (red "after cut" months) at once.`;
    // quarters (Q1 = Jan–Mar) from the same rows; every figure is a value, row 2 re-adds each quarter from Detail
    await say('Service Quarterly');
    const qk = (m) => yr(m) * 10 + Math.ceil((m % 100) / 3), qs = [...new Set(A.allMonths.map(qk))];
    const QS = flatSheet(S['Service Quarterly'], qs.map((q, i) => { const ms = A.allMonths.filter((m) => qk(m) === q), y = Math.floor(q / 10), n = q % 10, lo = y * 100 + 3 * n - 2, hi = y * 100 + 3 * n;
      const after = ms.every((m) => m > A.CUT);
      return { label: `Q${n}` + (ms.includes(A.CUT) ? ' ◂' : after ? ' · after cut' : ''), year: y, keys: ms, crit: [`">=${lo}",${DTR('Report bucket')},"<=${hi}"`], fill: after ? '8E3B37' : (i % 2 ? '1F3E6B' : '0F2A52') }; }), 'every quarter');
    PM.sq = `SUM('Service Quarterly'!${L(QS.T0 + 3)}${R1}:${L(QS.T0 + 3)}${RN})`;

    // ---------------- Package Monthly: live – the amounts on Service Monthly summed by their current Package. The Dashboard reads this sheet.
    await say('Package Monthly'); const pm = S['Package Monthly'];
    const pcols = [MS.blocks[0], ...MS.blocks.slice(1, -1), null, MS.blocks[MS.blocks.length - 1]];   // Opening, months, Total, Pending
    const SMR = (c) => `'Service Monthly'!$${L(c)}$${R1}:$${L(c)}$${RN}`, SMB = SMR(2);
    ['Code', 'Work package', 'Group'].forEach((h, j) => pm.hdr(2, 1 + j, h));
    pcols.forEach((b, j) => { const x = pm.hdr(2, 4 + j, b ? (b.keys[0] === 'OPENING' ? 'Opening' : b.keys[0] === 'PENDING' ? 'Pending (not in Total)' : mlabel(b.keys[0])) : 'Total', b ? undefined : fill('7A5C1E')); });
    pm.set(1, 1, `Cost by work package and month · EGP excl. VAT · to ${A.cutDate.toISOString().slice(0, 10)} · live from Service Monthly (re-coding moves the amounts at once)`, { font: st.B });
    let r = 3; const pkRows = [];
    for (const p of cat) {
      const spell = /^DIV \d+$/.test(p.code) ? [p.code, p.code.replace(' ', '')] : [p.code];      // "DIV 03" and "DIV03" both count
      pm.set(r, 1, p.code, { font: { ...st.F, name: 'Consolas' } }); pm.set(r, 2, `${p.icon ? p.icon + '  ' : ''}${p.label}`, { font: st.F }); pm.set(r, 3, p.group, { font: st.SMALL });
      pcols.forEach((b, j) => { const c = 4 + j; pm.set(r, c, b ? '=' + spell.map((v) => `SUMIFS(${SMR(MS.amtCol(b))},${SMB},"${v}")`).join('+') : `=SUM(E${r}:${L(3 + pcols.length - 2)}${r})+D${r}`, { font: b ? st.F : st.B, fmt: NUM }); });
      pkRows.push(r); r++; }
    const PUN = r, PTR = r + 1; PM.un = PUN; PM.tot = PTR; PM.rows = pkRows; PM.cols = pcols; PM.first = 3;
    pm.set(PUN, 1, 'UNALLOCATED', { font: { ...st.RED, bold: true } }); pm.set(PUN, 2, 'no work package yet, or a code not in the list', { font: st.IT });
    pm.set(PTR, 1, 'TOTAL', { font: st.B });
    pcols.forEach((b, j) => { const c = 4 + j, cl = L(c);
      pm.set(PTR, c, b ? `=SUM(${SMR(MS.amtCol(b))})` : `=SUM(E${PTR}:${L(3 + pcols.length - 2)}${PTR})+D${PTR}`, { font: st.B, fmt: NUM });
      pm.set(PUN, c, `=${cl}${PTR}-SUM(${cl}3:${cl}${PUN - 1})`, { font: st.RED, fmt: NUM }); });
    for (let c = 1; c <= 3 + pcols.length; c++) { pm.ws.getCell(PTR, c).fill = FILL.TF; pm.ws.getCell(PUN, c).fill = FILL.AF; }
    pm.width(1, 11); pm.width(2, 32); pm.width(3, 9); for (let j = 0; j < pcols.length; j++) pm.width(4 + j, 12.5);
    pm.ws.views = [{ state: 'frozen', xSplit: 3, ySplit: 2, showGridLines: false }];
    PM.totCol = L(4 + pcols.length - 2); PM.pendCol = L(3 + pcols.length); PM.monthCol = (m) => L(4 + pcols.findIndex((b) => b && b.keys[0] === m));
    { // Service Coding: how re-coding reaches the report
      sc.set(1, 12, 'Codes typed in the yellow columns update Service Monthly, Service Quarterly, Package Monthly and the Dashboard at once – no sorting needed.', { font: st.IT });
      sc.width(11, 3); sc.width(12, 60); }
    }
    { const bySvc = sumBy(det, (r) => r.sid, (r) => r.amt);     // per-item totals are values; the Dashboard checks them against Detail
      for (const s of A.services) sc.set(s.id + 1, 10, Math.round((bySvc.get(s.id) || 0) * 100) / 100, { fmt: NUM, font: st.F });
      sc.ws.getCell(1, 10).note = 'All certificate lines of the service (opening, months and pending), written as a value when the report was built. Dashboard → Final control checks the column against Detail.'; }

    // ---------------- By Supplier
    await say('By Supplier'); const bs = S['By Supplier'];
    const supTot = sumBy(det, (r) => r.supCode, (r) => r.amt); const sk = mostCommon(supTot).map((x) => x[0]);
    const bcols = ['OPENING', ...A.allMonths, 'PENDING'];
    ['Supplier code', 'Supplier name', ...bcols, 'Total'].forEach((v, j) => { const x = bs.hdr(1, j + 1, v); x.numFmt = '0'; });
    sk.forEach((k, n) => {
      const i = n + 2; bs.set(i, 1, k, { fmt: '@', font: st.F }); bs.set(i, 2, supName.get(k), { font: st.F });
      bcols.forEach((_, bi) => bs.set(i, 3 + bi, `=SUMIFS(${R('Cost (excl VAT)')},${R('Supplier code')},$A${i},${R('Report bucket')},${L(3 + bi)}$1)`, { fmt: NUM, font: st.F }));
      bs.set(i, 3 + bcols.length, `=SUM(C${i}:${L(2 + bcols.length)}${i})`, { fmt: NUM, font: st.B });
    });
    { const t = sk.length + 2; bs.set(t, 1, 'Total', { font: st.B });
      for (let c = 3; c <= 3 + bcols.length; c++) bs.set(t, c, `=SUM(${L(c)}2:${L(c)}${t - 1})`, { font: st.B, fmt: NUM });
      for (let j = 1; j <= 3 + bcols.length; j++) bs.ws.getCell(t, j).fill = FILL.TF; }
    bs.width(1, 13); bs.width(2, 36); for (let c = 3; c <= 3 + bcols.length; c++) bs.width(c, 12);
    bs.ws.views = [{ state: 'frozen', xSplit: 2, ySplit: 1 }];

    // ---------------- PO Register
    await say('PO Register'); const po = S['PO Register'];
    ['PO', 'Supplier code', 'Supplier name', 'Lines', 'Certificates', 'First cert.', 'Last cert.', 'Opening (pre go-live)', 'Approved since go-live', 'Not approved', 'Total (excl VAT)', 'VAT', 'Total incl VAT']
      .forEach((v, j) => po.hdr(1, j + 1, v));
    const pinfo = new Map();
    for (const r of det) { if (!pinfo.has(r.po)) pinfo.set(r.po, { s: r.supCode, n: r.supName, c: new Set(), v: 0 }); const p = pinfo.get(r.po); p.c.add(r.serial); p.v += r.amt; }
    const order = [...pinfo.keys()].sort((a, b) => pinfo.get(b).v - pinfo.get(a).v);
    const POR = R('PO'), AM = R('Cost (excl VAT)');
    order.forEach((k, n) => {
      const i = n + 2, p = pinfo.get(k);
      [k, p.s, p.n, `=COUNTIFS(${POR},A${i})`, p.c.size, `=_xlfn.MINIFS(${R('Cert. date')},${POR},A${i})`, `=_xlfn.MAXIFS(${R('Cert. date')},${POR},A${i})`,
        `=SUMIFS(${AM},${POR},A${i},${R('Initial invoice (Flag)')},"X",${R('Approved (Character 1)')},"X")`, `=K${i}-H${i}-J${i}`,
        `=SUMIFS(${AM},${POR},A${i},${R('Approved (Character 1)')},"<>X")`, `=SUMIFS(${AM},${POR},A${i})`, `=SUMIFS(${R('VAT current')},${POR},A${i})`, `=K${i}+L${i}`]
        .forEach((v, j) => po.set(i, j + 1, v, { font: st.F, fmt: j < 2 ? '@' : (j === 5 || j === 6 ? 'yyyy-mm-dd' : (j >= 7 ? NUM : undefined)) }));
    });
    { const t = order.length + 2; po.set(t, 1, 'Total', { font: st.B });
      for (const j of [4, 8, 9, 10, 11, 12, 13]) po.set(t, j, `=SUM(${L(j)}2:${L(j)}${t - 1})`, { font: st.B, fmt: NUM });
      for (let j = 1; j <= 13; j++) po.ws.getCell(t, j).fill = FILL.TF; }
    [13, 12, 32, 7, 11, 11, 11, 14, 14, 13, 15, 13, 15].forEach((w, j) => po.width(j + 1, w)); po.ws.views = [{ state: 'frozen', ySplit: 1 }];

    // ---------------- Qty Reconciliation
    await say('Qty Reconciliation'); const qr = S['Qty Reconciliation']; const g = A.g;
    ['PO line ref', 'PO', 'Supplier code', 'Supplier name', 'Type of works (PO)', 'PO item', 'Service line', 'Service', 'Service short text', 'UOM', 'Contract type', 'Unit price',
      'Contract qty', 'Contract value', 'Material group', 'Material group description', 'SAP qty received', 'SAP qty accepted',
      'Certified qty (this report)', 'Excluded qty-only lines', 'Difference (received − certified)', 'Explained', 'Certified amount (excl VAT)', '% of contract qty received']
      .forEach((v, j) => qr.hdr(1, j + 1, v));
    qr.ws.getCell('S1').note = 'SAP Current Quantity on Detail lines matched to this PO service line (not the equivalent report qty), excluding qty-only lines. WBS-split lines are counted once.';
    qr.ws.getCell('V1').note = '"Excluded lines" = SAP counts the quantity of qty-only lines this report excludes. Otherwise the difference is quantity received in SAP but not certified in ZSCPROG01.';
    const PLR = R('PO line ref'), LT = R('Line type');
    const svs = A.sv.slice().sort((a, b) => cmpTuple([str(g(a, 'Purchase Order')), num(g(a, 'PO item')), num(g(a, 'PO Service Line no.'))], [str(g(b, 'Purchase Order')), num(g(b, 'PO item')), num(g(b, 'PO Service Line no.'))]));
    const qrRows = svs.map((x, n) => { const i = n + 2; return [A.ref(x), str(g(x, 'Purchase Order')).trim(), str(g(x, 'Subcontractor')).trim(), str(g(x, 'Subcontractor Name')).trim(), str(g(x, 'Type of Works for PO')).trim(),
      str(g(x, 'PO item')).trim(), str(g(x, 'PO Service Line no.')).trim(), str(g(x, 'PO Service Code')).trim(), str(g(x, 'Service Short Text')).trim(), str(g(x, 'PO Service UOM')).trim(),
      str(g(x, 'Type of Contract (Include/Exclude VAT)')).trim(), num(g(x, 'Service Unit Price')), num(g(x, 'PO Service Qty')), num(g(x, 'PO Service Price')),
      str(g(x, 'PO Service Material Group')).trim(), str(g(x, 'PO Service Material Group Description')).trim(), num(g(x, 'Total Qty Received')), num(g(x, 'Total Qty Accepted')),
      { formula: `SUMIFS(${R('Current qty')},${PLR},$A${i})-SUMIFS(${R('Current qty')},${PLR},$A${i},${LT},"Qty only (excluded)")` },
      { formula: `SUMIFS(${R('Current qty')},${PLR},$A${i},${LT},"Qty only (excluded)")` }, { formula: `ROUND(Q${i}-S${i},3)` },
      { formula: `IF(ABS(U${i})<0.001,"",IF(ABS(U${i}-T${i})<0.001,"Excluded lines","Not certified"))` },
      { formula: `SUMIFS(${R('Cost (excl VAT)')},${PLR},$A${i})` }, { formula: `IF(M${i}=0,"",Q${i}/M${i})` }]; });
    qr.ws.addRows(qrRows);
    for (let j = 1; j <= 24; j++) { const col = qr.ws.getColumn(j); col.font = st.F; if ([1, 2, 3, 6, 7, 8, 15].includes(j)) col.numFmt = '@'; if ([12, 13, 17, 18, 19, 20, 21].includes(j)) col.numFmt = QTY; if ([14, 23].includes(j)) col.numFmt = NUM; if (j === 24) col.numFmt = '0%'; }
    qr.ws.getRow(1).eachCell((c) => { c.font = st.H; c.numFmt = 'General'; });
    { const QN = svs.length + 1; qr.set(QN + 1, 1, 'Total', { font: st.B }); for (const j of [14, 23]) qr.set(QN + 1, j, `=SUM(${L(j)}2:${L(j)}${QN})`, { font: st.B, fmt: NUM });
      for (let j = 1; j <= 24; j++) qr.ws.getCell(QN + 1, j).fill = FILL.TF; qr.ws.autoFilter = `A1:X${QN}`; }
    [22, 12, 11, 26, 24, 6, 7, 10, 36, 6, 7, 10, 11, 13, 9, 20, 12, 12, 12, 11, 13, 13, 15, 10].forEach((w, j) => qr.width(j + 1, w));
    qr.ws.views = [{ state: 'frozen', xSplit: 9, ySplit: 1 }];

    // ---------------- Subcontractor x Trade
    await say('Subcontractor x Trade'); const xt = S['Subcontractor x Trade'];
    const tcodes = mostCommon(sumBy(det, (r) => r.trade, (r) => r.amt)).map((x) => x[0]);
    const pair = sumBy(det, (r) => r.supCode + '\u0001' + r.trade, (r) => r.amt);
    const xs = sk; const NT = tcodes.length, NS = xs.length;
    xt.set(1, 2, 'Subcontractors by trade', { font: st.T1 });
    xt.set(2, 2, 'Amounts excl. VAT, all certificates (opening + approved + pending). Full matrix at the bottom of this sheet – click + to expand.', { font: st.SMALL });
    const multi = xs.filter((k) => tcodes.filter((t) => Math.abs(pair.get(k + '\u0001' + t) || 0) > 1e-9).length > 1);
    const S0 = 4, ST_ = S0 + 2 + NT, T0 = ST_ + 4, T10 = T0 + 12, U0 = T10 + 3;
    const MR = Math.max(130, U0 + multi.length + 8), MT = MR + 1, M0 = MR + 2, M1 = M0 + NS - 1, MA = M1 + 1, MC = M1 + 2;
    xt.set(MR - 1, 2, 'Detail matrix – amount per subcontractor and trade', { font: st.B });
    xt.hdr(MR, 2, 'Supplier code'); xt.hdr(MR, 3, 'Supplier name'); xt.hdr(MT, 2, 'Trade code →', FILL.H2); xt.hdr(MT, 3, null, FILL.H2);
    tcodes.forEach((tcode, j) => { xt.hdr(MR, 4 + j, '=' + lk('Coding', 'D', 'E', `"${tcode}"`)); xt.hdr(MT, 4 + j, tcode, FILL.H2); });
    const XT = 4 + NT; xt.hdr(MR, XT, 'Total'); xt.hdr(MR, XT + 1, 'No. of trades'); xt.hdr(MR, XT + 2, 'Main trade');
    for (const c of [XT, XT + 1, XT + 2]) xt.hdr(MT, c, null, FILL.H2);
    xs.forEach((k, n) => {
      const i = M0 + n; xt.set(i, 2, k, { fmt: '@', font: st.F }); xt.set(i, 3, supName.get(k), { font: st.F });
      for (let j = 0; j < NT; j++) xt.set(i, 4 + j, `=SUMIFS(${R('Cost (excl VAT)')},${R('Supplier code')},$B${i},${R('Trade')},${L(4 + j)}$${MT})`, { fmt: NUM, font: st.F });
      xt.set(i, XT, `=SUM(D${i}:${L(XT - 1)}${i})`, { fmt: NUM, font: st.F });
      xt.set(i, XT + 1, `=COUNTIF(D${i}:${L(XT - 1)}${i},"<>0")`, { font: st.F });
      xt.set(i, XT + 2, `=INDEX($D$${MR}:$${L(XT - 1)}$${MR},MATCH(MAX(D${i}:${L(XT - 1)}${i}),D${i}:${L(XT - 1)}${i},0))`, { font: st.F });
    });
    xt.set(MA, 2, 'Total amount', { font: st.B }); xt.set(MC, 2, 'No. of subcontractors', { font: st.B });
    for (let j = 4; j <= XT; j++) { xt.set(MA, j, `=SUM(${L(j)}${M0}:${L(j)}${M1})`, { font: st.B, fmt: NUM }); xt.set(MC, j, `=COUNTIF(${L(j)}${M0}:${L(j)}${M1},"<>0")`, { font: st.B }); }
    for (const rr of [MA, MC]) for (let j = 2; j <= XT + 2; j++) xt.ws.getCell(rr, j).fill = FILL.TF;
    for (let rr = MT; rr <= MC; rr++) { const row = xt.ws.getRow(rr); row.outlineLevel = 1; row.hidden = true; }
    xt.ws.properties.outlineProperties = { summaryBelow: false };
    const NAMES = `$C$${M0}:$C$${M1}`;
    xt.set(S0, 2, '1. Summary by trade', { font: st.B });
    ['Trade', 'Subcontractors', 'Total amount', 'Avg per subcontractor', 'Largest subcontractor', 'Largest share', 'Top-3 share'].forEach((h, j) => xt.hdr(S0 + 1, 2 + j, h));
    tcodes.forEach((tcode, n) => {
      const rr = S0 + 2 + n, cc = L(4 + n), rng = `${cc}$${M0}:${cc}$${M1}`;
      ['=' + lk('Coding', 'D', 'E', `"${tcode}"`), `=${cc}${MC}`, `=${cc}${MA}`, `=IFERROR(D${rr}/C${rr},0)`, `=INDEX(${NAMES},MATCH(MAX(${rng}),${rng},0))`,
        `=IFERROR(MAX(${rng})/D${rr},0)`, `=IFERROR((LARGE(${rng},1)+LARGE(${rng},2)+LARGE(${rng},3))/D${rr},0)`]
        .forEach((v, j) => xt.set(rr, 2 + j, v, { font: st.F, fmt: j === 2 || j === 3 ? NUM : (j >= 5 ? PCT : undefined), align: j === 1 ? { horizontal: 'center' } : undefined }));
    });
    { const TOT = `${L(XT)}${M0}:${L(XT)}${M1}`;
      xt.set(ST_, 2, 'All trades (each subcontractor once)', { font: st.B });
      xt.set(ST_, 3, `=COUNTIF(${TOT},"<>0")`, { font: st.B, align: { horizontal: 'center' } });
      xt.set(ST_, 4, `=${L(XT)}${MA}`, { font: st.B, fmt: NUM }); xt.set(ST_, 5, `=IFERROR(D${ST_}/C${ST_},0)`, { font: st.B, fmt: NUM });
      xt.set(ST_, 6, `=INDEX(${NAMES},MATCH(MAX(${TOT}),${TOT},0))`, { font: st.B });
      xt.set(ST_, 7, `=IFERROR(MAX(${TOT})/D${ST_},0)`, { font: st.B, fmt: PCT });
      xt.set(ST_, 8, `=IFERROR((LARGE(${TOT},1)+LARGE(${TOT},2)+LARGE(${TOT},3))/D${ST_},0)`, { font: st.B, fmt: PCT });
      for (let j = 2; j <= 8; j++) xt.ws.getCell(ST_, j).fill = FILL.TF; }
    xt.set(ST_ + 1, 2, "Trade counts overlap: one subcontractor can work in several trades. Top-3 share = the 3 largest subcontractors' share of the trade – high means the trade depends on few firms.", { font: st.IT });
    xt.set(T0, 2, '2. Top 10 subcontractors', { font: st.B });
    ['Supplier code', 'Supplier name', 'Total amount', 'Share', 'No. of trades', 'Main trade'].forEach((h, j) => xt.hdr(T0 + 1, 2 + j, h));
    const top10 = Math.min(10, NS);
    for (let n = 0; n < top10; n++) { const rr = T0 + 2 + n, m = M0 + n;
      [`=B${m}`, `=C${m}`, `=${L(XT)}${m}`, `=IFERROR(D${rr}/$D$${ST_},0)`, `=${L(XT + 1)}${m}`, `=${L(XT + 2)}${m}`]
        .forEach((v, j) => xt.set(rr, 2 + j, v, { font: st.F, fmt: j === 2 ? NUM : (j === 3 ? PCT : undefined), align: j === 4 ? { horizontal: 'center' } : undefined })); }
    xt.set(T10, 2, 'Top 10 together', { font: st.B }); xt.set(T10, 4, `=SUM(D${T0 + 2}:D${T0 + 11})`, { font: st.B, fmt: NUM });
    xt.set(T10, 5, `=IFERROR(D${T10}/$D$${ST_},0)`, { font: st.B, fmt: PCT }); for (let j = 2; j <= 7; j++) xt.ws.getCell(T10, j).fill = FILL.TF;
    xt.set(U0, 2, `3. Subcontractors working in more than one trade (${multi.length} at build time)`, { font: st.B });
    ['Supplier code', 'Supplier name', 'No. of trades', 'Main trade', 'Total amount'].forEach((h, j) => xt.hdr(U0 + 1, 2 + j, h));
    multi.forEach((k, n) => { const rr = U0 + 2 + n, m = M0 + xs.indexOf(k);
      [`=B${m}`, `=C${m}`, `=${L(XT + 1)}${m}`, `=${L(XT + 2)}${m}`, `=${L(XT)}${m}`].forEach((v, j) => xt.set(rr, 2 + j, v, { font: st.F, fmt: j === 4 ? NUM : undefined, align: j === 2 ? { horizontal: 'center' } : undefined })); });
    xt.set(U0 + 2 + multi.length, 2, 'List fixed when the workbook was built; the counts and amounts are live.', { font: st.IT });
    charts.push({ sheet: 'Subcontractor x Trade', col: 9, row: S0 - 1, w: 15, h: 7.5, kind: 'bar', reverse: true, title: 'Subcontractors per trade', labels: true, labelFmt: '0', gap: 50,
      series: [{ cat: `'Subcontractor x Trade'!$B$${S0 + 2}:$B$${S0 + 1 + NT}`, val: `'Subcontractor x Trade'!$C$${S0 + 2}:$C$${S0 + 1 + NT}`, color: BRAND }] });
    charts.push({ sheet: 'Subcontractor x Trade', col: 9, row: T0 - 1, w: 15, h: 7.5, kind: 'bar', reverse: true, title: 'Top 10 subcontractors – total amount', labels: true, labelFmt: '#,##0.0,,"M"', valFmt: '#,##0,,"M"', gap: 50,
      series: [{ cat: `'Subcontractor x Trade'!$C$${T0 + 2}:$C$${T0 + 1 + top10}`, val: `'Subcontractor x Trade'!$D$${T0 + 2}:$D$${T0 + 1 + top10}`, color: BRAND }] });
    ['', 30, 32, 15, 15, 30, 11, 11].forEach((w, j) => { if (j) xt.width(j + 1, w); }); xt.width(1, 2);
    for (let j = 9; j <= XT + 2; j++) xt.width(j, 13);
    const TCNT = new Map(tcodes.map((t, n) => [t, `='Subcontractor x Trade'!C${S0 + 2 + n}`])); const SUBTOT = `='Subcontractor x Trade'!C${ST_}`;

    // ---------------- Subcontractors over time
    await say('Subcontractors over time'); const ot = S['Subcontractors over time']; const XS = "'Subcontractor x Trade'!";
    ot.set(1, 2, 'Subcontractors over time', { font: st.T1 });
    ot.set(2, 2, 'Approved amount in each report month (opening and pending excluded, same as the Dashboard monthly chart). Months start at the first month with approved certificates.', { font: st.SMALL });
    const V0 = 4; ot.set(V0, 2, '1. Active subcontractors per month – a subcontractor is active when it has approved amount in that month', { font: st.B });
    ot.hdr(V0 + 1, 2, 'Trade');
    omonths.forEach((m, j) => { const x = ot.hdr(V0 + 1, 3 + j, new Date(Date.UTC(Math.floor(m / 100), (m % 100) - 1, 1))); x.numFmt = 'mmm-yy'; });
    const SUPS = `${XS}$B$${M0}:$B$${M1}`, AMT = R('Cost (excl VAT)'), SUPC = R('Supplier code'), TRC = R('Trade'), BKT = R('Report bucket');
    tcodes.forEach((tcode, n) => { const rr = V0 + 2 + n; ot.set(rr, 2, `=${XS}B${S0 + 2 + n}`, { font: st.F });
      omonths.forEach((_, j) => { const hc = `${L(3 + j)}$${V0 + 1}`;
        ot.set(rr, 3 + j, `=SUMPRODUCT(--(SUMIFS(${AMT},${SUPC},${SUPS},${TRC},"${tcode}",${BKT},YEAR(${hc})*100+MONTH(${hc}))<>0))`, { font: st.F, align: { horizontal: 'center' } }); }); });
    const VT = V0 + 2 + NT; ot.set(VT, 2, 'All trades (each subcontractor once)', { font: st.B });
    omonths.forEach((_, j) => { const hc = `${L(3 + j)}$${V0 + 1}`;
      ot.set(VT, 3 + j, `=SUMPRODUCT(--(SUMIFS(${AMT},${SUPC},${SUPS},${BKT},YEAR(${hc})*100+MONTH(${hc}))<>0))`, { font: st.B, align: { horizontal: 'center' } }); });
    for (let j = 2; j < 3 + omonths.length; j++) ot.ws.getCell(VT, j).fill = FILL.TF;
    const lastM = L(2 + omonths.length);
    if (omonths.length) {
      charts.push({ sheet: 'Subcontractors over time', col: 1, row: VT + 1, w: 26, h: 9, kind: 'line', title: 'Active subcontractors per month – top 5 trades', valTitle: 'Subcontractors', legend: 'b', catFmt: 'mmm-yy',
        series: tcodes.slice(0, 5).map((t, n) => ({ name: `'Subcontractors over time'!$B$${V0 + 2 + n}`, cat: `'Subcontractors over time'!$C$${V0 + 1}:$${lastM}$${V0 + 1}`, catDate: true,
          val: `'Subcontractors over time'!$C$${V0 + 2 + n}:$${lastM}$${V0 + 2 + n}`, color: PAL[n] })) });
      ot.set(VT + 20, 2, '2. Active subcontractors per month – all trades', { font: st.B });
      charts.push({ sheet: 'Subcontractors over time', col: 1, row: VT + 20, w: 18, h: 9, kind: 'col', title: 'Active subcontractors per month – all trades', labels: true, labelFmt: '0', catFmt: 'mmm-yy',
        series: [{ cat: `'Subcontractors over time'!$C$${V0 + 1}:$${lastM}$${V0 + 1}`, catDate: true, val: `'Subcontractors over time'!$C$${VT}:$${lastM}$${VT}`, color: BRAND }] });
    }
    const W0 = VT + 40; ot.set(W0, 2, '3. Top 10 subcontractors – approved amount per month (darker = larger)', { font: st.B });
    ot.hdr(W0 + 1, 2, 'Supplier name');
    omonths.forEach((m, j) => { const x = ot.hdr(W0 + 1, 3 + j, new Date(Date.UTC(Math.floor(m / 100), (m % 100) - 1, 1))); x.numFmt = 'mmm-yy'; });
    ot.hdr(W0 + 1, 3 + omonths.length, 'Total in months');
    for (let n = 0; n < top10; n++) { const rr = W0 + 2 + n, m = M0 + n; ot.set(rr, 2, `=${XS}C${m}`, { font: st.F });
      omonths.forEach((_, j) => { const hc = `${L(3 + j)}$${W0 + 1}`;
        ot.set(rr, 3 + j, `=SUMIFS(${AMT},${SUPC},${XS}$B$${m},${BKT},YEAR(${hc})*100+MONTH(${hc}))`, { font: st.F, fmt: '#,##0,"K";(#,##0,"K");-' }); });
      ot.set(rr, 3 + omonths.length, `=SUM(C${rr}:${lastM}${rr})`, { font: st.B, fmt: NUM }); }
    if (omonths.length) ot.ws.addConditionalFormatting({ ref: `C${W0 + 2}:${lastM}${W0 + 1 + top10}`, rules: [{ type: 'colorScale', priority: 1,
      cfvo: [{ type: 'num', value: 0 }, { type: 'percentile', value: 50 }, { type: 'max' }], color: [{ argb: 'FFFFFFFF' }, { argb: 'FF86B6EF' }, { argb: 'FF5598E7' }] }] });
    ot.set(W0 + 12, 2, 'Amounts in thousands (K). Opening and pending amounts are not in the months, so "Total in months" can be below the subcontractor total.', { font: st.IT });
    ot.width(1, 2); ot.width(2, 34); for (let j = 3; j <= 3 + omonths.length; j++) ot.width(j, 11); ot.width(3 + omonths.length, 15);
    ot.ws.views = [{ state: 'frozen', xSplit: 2, ySplit: 3, showGridLines: false }];

    let DASH_TOTAL;
    { // block keeps the dashboard's local names apart from the other sheets'
    // ---------------- Dashboard: one A3 landscape page. Work package × MNL leads; monthly cost and top services follow.
    await say('Dashboard'); const db = S['Dashboard'];
    const minD = det.reduce((m, r) => (r.dateKey < m.dateKey ? r : m), det[0]).dateObj, maxD = A.dataDate;
    const fmtD = (d) => MON[d.getUTCMonth()] + '-' + String(d.getUTCFullYear()).slice(2);
    const pk = (A.opts.master && A.opts.master.packages) || PACKAGES, mn = (A.opts.master && A.opts.master.mnl) || MNLS;
    // package × MNL reads Service Monthly (Total amount, live Package / MNL) – a few hundred rows, not every Detail line
    const smr = (c) => `'Service Monthly'!$${L(c)}$${SM_COLS.R1}:$${L(c)}$${SM_COLS.RN}`, SMT = smr(SM_COLS.T0 + 3), SMP = smr(2), SMM = smr(3);
    const MCOL = ['2A78D6', 'EB6834', '1BAF7A', 'EDA100', 'E87BA4', '008300'], NOSET = 'A6A6A0';   // MNL series colours, fixed order
    // column grid: left block = package table, right block = 8 equal columns
    const nM = mn.length, cB = 2, cPk = 3, cM = 4, cNS = 4 + nM, cTot = cNS + 1, cSh = cTot + 1, DR0 = cSh + 2, DRE = DR0 + 7, DLAST = DRE + 1;
    db.width(1, 2); db.width(cB, 14); db.width(cPk, 30); for (let j = 0; j < nM; j++) db.width(cM + j, 12.5);
    db.width(cNS, 12.5); db.width(cTot, 14); db.width(cSh, 9); db.width(cSh + 1, 3); for (let c = DR0; c <= DRE; c++) db.width(c, 12.5); db.width(DLAST, 2);
    // chart size from the grid it covers (Excel: column px = width·7+5, row pt = height), in cm for the anchor
    const colPx = (c) => Math.round((db.ws.getColumn(c).width || 9) * 7 + 5), rowPt = (r) => db.ws.getRow(r).height || 15;
    const place = (c1, r1, c2, r2) => { let px = 0, pt = 0; for (let c = c1; c <= c2; c++) px += colPx(c); for (let r = r1; r <= r2; r++) pt += rowPt(r);
      return { col: c1 - 1, row: r1 - 1, colOff: 50000, rowOff: 50000, w: px * 9525 / 360000 - 0.3, h: pt * 12700 / 360000 - 0.3 }; };
    const merge = (r1, c1, r2, c2) => { if (r1 !== r2 || c1 !== c2) db.ws.mergeCells(r1, c1, r2, c2); };
    const box = (r1, c1, r2, c2, side) => { for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) { const b = {};
      if (r === r1) b.top = side; if (r === r2) b.bottom = side; if (c === c1) b.left = side; if (c === c2) b.right = side; db.ws.getCell(r, c).border = b; } };
    const band = (r, c1, c2, f) => { for (let c = c1; c <= c2; c++) db.ws.getCell(r, c).fill = f; };
    const SEC = { name: 'Arial', size: 13, bold: true, color: { argb: 'FFFFFFFF' } }, SECS = { name: 'Arial', size: 9, color: { argb: 'FFC8A45C' } };
    const SECL = { ...SEC, size: 15 };                                 // the two lead sections read first
    const section = (r, c1, c2, title, sub, lead) => { band(r, c1, c2, FILL.BAND); db.set(r, c1, title, { font: lead ? SECL : SEC, align: { vertical: 'middle', indent: 1 } });
      if (sub) db.set(r, c2, sub, { font: SECS, align: { horizontal: 'right', vertical: 'middle' } }); for (let c = c1; c <= c2; c++) db.ws.getCell(r, c).border = { bottom: { style: 'medium', color: { argb: 'FFC8A45C' } } }; };
    const rowH = (r, h) => { db.ws.getRow(r).height = h; };

    // title band (rows 1–5)
    for (let r = 1; r <= 5; r++) band(r, 1, DLAST, FILL.BAND);
    [6, 16, 26, 16, 8].forEach((h, i) => rowH(i + 1, h));
    db.set(2, 2, `${A.PLANT} PROJECT · SUBCONTRACT COST`, { font: st.EYE });
    db.set(3, 2, 'Cost by Work Package & MNL', { font: st.TITLE });
    db.set(4, 2, `SAP ZSCPROG01 + ZSCSRV1 · certificates ${fmtD(minD)} to ${fmtD(maxD)} · EGP excl. VAT · load ${A.loadNo}`, { font: st.SUB });
    db.set(3, DRE, `Data date ${maxD.toISOString().slice(0, 10)}`, { font: st.SUB, align: { horizontal: 'right', vertical: 'bottom' } });

    // KPI tiles (rows 7–9): three over the package table, four over the right block
    rowH(6, 8); rowH(7, 15); rowH(8, 28); rowH(9, 15); rowH(10, 10);
    const AP = R('Approved (Character 1)'), FL = R('Initial invoice (Flag)'), BK = R('Report bucket'), lastMo = months[months.length - 1];
    const DTOT = `$${L(cB)}$8`;
    const PKG_UN = { r: 0 };                                          // filled once the package table is laid out
    const tiles = [
      [cB, cPk, `Total to ${A.cutDate.getUTCDate()}-${MON[A.cutDate.getUTCMonth()]}-${String(A.cutDate.getUTCFullYear()).slice(2)}`, `=SUMIFS(${AM},${BK},"<>PENDING")`, null],
      [cM, cM + Math.max(0, nM - 1), 'Approved since go-live', `=SUMIFS(${AM},${BK},">0")`, 'share'],
      [cNS, cSh, 'Opening (pre go-live)', `=SUMIFS(${AM},${BK},"OPENING")`, 'share'],
      [DR0, DR0 + 1, 'Pending – not in total', `=SUMIFS(${AM},${BK},"PENDING")`, 'share'],
      [DR0 + 2, DR0 + 3, `${mlabel(A.CUT)} (report month)`, `=SUMIFS(${AM},${BK},${A.CUT})`, 'share'],
      [DR0 + 4, DR0 + 5, 'Subcontractors', SUBTOT, 'count'],
      [DR0 + 6, DR0 + 7, 'Cost with a package', null, 'coded']];
    const MFMT = '#,##0.0,,"M";(#,##0.0,,"M");"–"';
    for (const [c1, c2, lab, f, kind] of tiles) {
      for (let r = 7; r <= 9; r++) { band(r, c1, c2, FILL.KF); merge(r, c1, r, c2); }
      db.set(7, c1, lab.toUpperCase(), { font: st.KLAB, align: { indent: 1, vertical: 'bottom' } });
      db.set(8, c1, f, { font: st.BIG, fmt: kind === 'count' ? '0' : MFMT, align: { horizontal: 'left', indent: 1, vertical: 'middle' } });
      db.set(9, c1, kind === 'share' ? `=IFERROR(${L(c1)}8/${DTOT},0)` : (kind === 'count' ? 'on the certificates' : (kind === 'coded' ? null : 'EGP excl. VAT')),
        { font: st.KSUB, fmt: '0.0% "of total"', align: { horizontal: 'left', indent: 1, vertical: 'top' } });
      box(7, c1, 9, c2, GOLDLINE);
    }

    // ---- COST BY WORK PACKAGE (left) with its MNL split
    const WT0 = 11; rowH(WT0, 28); section(WT0, cB, cSh, 'COST BY WORK PACKAGE', 'split by MNL · EGP', true);
    rowH(WT0 + 1, 18);
    ['Code', 'Work package', ...mn.map((m) => m.code), 'MNL not set', 'Total', 'Share'].forEach((h, j) => db.hdr(WT0 + 1, cB + j, h));
    // every package of the catalogue gets a live row (a template): coding in Service Coding fills it without a rebuild
    const listed = pk;
    const groups = [...new Set(pk.map((p) => p.group))];
    let r = WT0 + 2; const groupRows = [], pkgRows = [];
    const numCols = [...mn.map((_, j) => cM + j), cNS, cTot];
    for (const gname of groups) {
      const gi = r, gc = GROUP_COLOR[gname] || '6B7280', gf = fill(tint(gc, 0.82)); rowH(r, 23);
      band(r, cB, cSh, gf); db.set(r, cB, gname.toUpperCase(), { font: { name: 'Arial', size: 10, bold: true, color: { argb: 'FF' + gc } } }); r++;
      const members = listed.filter((p) => p.group === gname);
      for (const p of members) {
        rowH(r, 22); db.set(r, cB, p.code, { font: { ...st.F, name: 'Consolas', size: 9.5 } });
        db.set(r, cPk, `${p.icon ? p.icon + '  ' : ''}${p.label}`, { font: st.F });
        const spell = /^DIV \d+$/.test(p.code) ? [p.code, p.code.replace(' ', '')] : [p.code];      // "DIV 03" and "DIV03" both count
        const sumPk = (extra) => '=' + spell.map((v) => `SUMIFS(${SMT},${SMP},"${v}"${extra})`).join('+');
        mn.forEach((m, j) => db.set(r, cM + j, sumPk(`,${SMM},"${m.code}"`), { font: st.F, fmt: NUM }));
        db.set(r, cTot, sumPk(''), { font: st.B, fmt: NUM });
        db.set(r, cNS, `=${L(cTot)}${r}-SUM(${L(cM)}${r}:${L(cNS - 1)}${r})`, { font: st.SMALL, fmt: NUM });
        db.set(r, cSh, `=IFERROR(${L(cTot)}${r}/${DTOT},0)`, { font: st.F, fmt: PCT });
        for (let c = cB; c <= cSh; c++) db.ws.getCell(r, c).border = { bottom: { style: 'hair', color: { argb: 'FFD9DEE7' } } };
        pkgRows.push(r); r++;
      }
      for (const c of numCols) db.set(gi, c, `=SUM(${L(c)}${gi + 1}:${L(c)}${r - 1})`, { font: { ...st.B, color: { argb: 'FF' + gc } }, fmt: NUM });
      db.set(gi, cSh, `=IFERROR(${L(cTot)}${gi}/${DTOT},0)`, { font: { ...st.B, color: { argb: 'FF' + gc } }, fmt: PCT });
      groupRows.push([gname, gi, gc]);
    }
    const DUN = r; rowH(DUN, 21); band(DUN, cB, cSh, FILL.AF); PKG_UN.r = DUN;
    db.set(DUN, cB, 'UNALLOCATED', { font: { ...st.RED, bold: true } }); db.set(DUN, cPk, 'no work package yet', { font: st.IT });
    // unallocated = everything the package rows do not catch (no package, or a code not in the list)
    const coded = (c) => groupRows.length ? groupRows.map(([, gi]) => L(c) + gi).join('+') : '0';
    mn.forEach((m, j) => db.set(DUN, cM + j, `=SUMIFS(${SMT},${SMM},"${m.code}")-(${coded(cM + j)})`, { font: st.RED, fmt: NUM }));
    db.set(DUN, cTot, `=SUM(${SMT})-(${coded(cTot)})`, { font: { ...st.RED, bold: true }, fmt: NUM });
    db.set(DUN, cNS, `=${L(cTot)}${DUN}-SUM(${L(cM)}${DUN}:${L(cNS - 1)}${DUN})`, { font: st.RED, fmt: NUM });
    db.set(DUN, cSh, `=IFERROR(${L(cTot)}${DUN}/${DTOT},0)`, { font: { ...st.RED, bold: true }, fmt: PCT });
    const DTR = DUN + 1; rowH(DTR, 22); band(DTR, cB, cSh, FILL.TF);
    db.set(DTR, cB, 'TOTAL', { font: st.B });
    for (const c of numCols) db.set(DTR, c, `=${groupRows.length ? groupRows.map(([, gi]) => L(c) + gi).join('+') + '+' : ''}${L(c)}${DUN}`, { font: st.B, fmt: NUM });
    db.set(DTR, cSh, `=IFERROR(${L(cTot)}${DTR}/${DTOT},0)`, { font: st.B, fmt: PCT });
    for (let c = cB; c <= cSh; c++) db.ws.getCell(DTR, c).border = { top: { style: 'thin', color: { argb: 'FF0F2A52' } }, bottom: { style: 'double', color: { argb: 'FF0F2A52' } } };
    if (pkgRows.length) db.ws.addConditionalFormatting({ ref: pkgRows.map((x) => L(cTot) + x).join(' '),
      rules: [{ type: 'dataBar', priority: 1, gradient: false, cfvo: [{ type: 'num', value: 0 }, { type: 'max' }], color: { argb: 'FF9DB7DE' } }] });
    db.set(8, DR0 + 6, `=IFERROR(1-${L(cTot)}${DUN}/${DTOT},0)`, { font: st.BIG, fmt: '0.0%', align: { horizontal: 'left', indent: 1, vertical: 'middle' } });
    db.set(9, DR0 + 6, `=${L(cTot)}${DUN}`, { font: st.KSUB, fmt: '#,##0.0,,"M unallocated";(#,##0.0,,"M");"nothing unallocated"', align: { horizontal: 'left', indent: 1, vertical: 'top' } });

    // ---- COST BY MNL (right): one tile per MNL + not set, then work package groups split by MNL
    section(WT0, DR0, DRE, 'COST BY MNL', 'material · subcontract · equipment', true);
    const mt = [...mn.map((m, j) => ({ code: m.code, label: m.label, col: j < nM ? L(cM + j) : null, color: MCOL[j % MCOL.length] })), { code: 'NOT SET', label: 'MNL not coded', col: L(cNS), color: NOSET }];
    // tiles in rows of three (spans 3·3·2 of the eight columns); two rows hold MAT SUB EQU / LAB OTHER NOT SET
    const spans = [[0, 2], [3, 5], [6, 7]], TR0 = WT0 + 1, nTileRows = Math.ceil(mt.length / 3);
    // the tiles share rows with the package table, so they keep the table's even row heights
    mt.forEach((m, j) => { const r0 = TR0 + 3 * Math.floor(j / 3), [a1, a2] = spans[j % 3], c1 = DR0 + a1, c2 = DR0 + a2;
      for (let rr = r0; rr <= r0 + 2; rr++) { merge(rr, c1, rr, c2); for (let c = c1; c <= c2; c++) db.ws.getCell(rr, c).fill = fill(tint(m.color, 0.88)); }
      db.set(r0, c1, `${m.code} · ${m.label}`, { font: { name: 'Arial', size: 9, bold: true, color: { argb: 'FF' + m.color } }, align: { indent: 1, vertical: 'bottom' } });
      db.set(r0 + 1, c1, `=${m.col}${DTR}`, { font: { name: 'Arial', size: 15, bold: true, color: { argb: 'FF0F2A52' } }, fmt: MFMT, align: { horizontal: 'left', indent: 1, vertical: 'middle' } });
      db.set(r0 + 2, c1, `=IFERROR(${m.col}${DTR}/${DTOT},0)`, { font: st.SMALL, fmt: '0.0% "of total"', align: { horizontal: 'left', indent: 1, vertical: 'top' } });
      for (let rr = r0; rr <= r0 + 2; rr++) db.ws.getCell(rr, c1).border = { left: { style: 'thick', color: { argb: 'FF' + m.color } } }; });
    const CH0 = TR0 + 3 * nTileRows + 1;                       // the group × MNL chart starts under the tiles

    // chart data lives on the hidden _Chart sheet so the dashboard prints clean
    const cx = S['_Chart']; cx.set(1, 1, 'Dashboard chart data (formulas point at the Dashboard)', { font: st.SMALL });
    const cats = [...groupRows.map(([g, gi]) => [g, gi]), ['Unallocated', DUN]];
    cx.set(2, 1, 'Group'); mt.forEach((m, j) => cx.set(2, 2 + j, m.code === 'NOT SET' ? 'MNL not set' : m.code));
    cats.forEach(([g, gi], n) => { cx.set(3 + n, 1, g); mt.forEach((m, j) => cx.set(3 + n, 2 + j, `=Dashboard!${m.col}${gi}`, { fmt: NUM })); });
    const DG1 = 2 + cats.length;
    charts.push({ sheet: 'Dashboard', ...place(DR0, CH0, DRE, DTR), kind: 'bar', stacked: true, reverse: true, legend: 'b', gap: 45,
      title: 'Work package groups by MNL', valFmt: '#,##0,,"M"',
      series: mt.map((m, j) => ({ name: `'_Chart'!$${L(2 + j)}$2`, cat: `'_Chart'!$A$3:$A$${DG1}`, val: `'_Chart'!$${L(2 + j)}$3:$${L(2 + j)}$${DG1}`, color: m.color, gap: true })) });
    const DM0 = DG1 + 3; cx.set(DM0, 1, 'Month'); cx.set(DM0, 2, 'Approved cost');
    A.allMonths.forEach((m, j) => { cx.set(DM0 + 1 + j, 1, mlabel(m) + (m > A.CUT ? ' (after cut)' : '')); cx.set(DM0 + 1 + j, 2, `='Package Monthly'!${PM.monthCol(m)}${PM.tot}`, { fmt: NUM }); });
    const DM1 = DM0 + A.allMonths.length; cx.width(1, 16); for (let j = 2; j <= 8; j++) cx.width(j, 14);

    // ---- lower half: monthly cost (left) and top services (right)
    const DB0 = DTR + 2; rowH(DB0 - 1, 12); rowH(DB0, 24);
    section(DB0, cB, cSh, 'MONTHLY CERTIFIED COST', `approved, by certificate month to ${A.cutDate.toISOString().slice(0, 10)} · opening & pending not in months`);
    section(DB0, DR0, DRE, 'TOP 15 SERVICES', 'all suppliers · EGP');
    const DNB = 16;                                                     // header + top 15 services; the monthly chart spans the same rows
    for (let x = DB0 + 1; x <= DB0 + DNB + 1; x++) rowH(x, 23);
    if (months.length) charts.push({ sheet: 'Dashboard', ...place(cB, DB0 + 1, cSh, DB0 + DNB + 1), kind: 'col', title: 'Approved cost per month', labels: true,
      labelFmt: '#,##0.0,,"M"', valFmt: '#,##0,,"M"', gap: 45,
      series: [{ cat: `'_Chart'!$A$${DM0 + 1}:$A$${DM1}`, val: `'_Chart'!$B$${DM0 + 1}:$B$${DM1}`, color: BRAND }] });
    [['Service', DR0, DR0], ['Description', DR0 + 1, DR0 + 3], ['Unit', DR0 + 4, DR0 + 4], ['Qty', DR0 + 5, DR0 + 5], ['Avg rate', DR0 + 6, DR0 + 6], ['Amount', DR0 + 7, DR0 + 7]]
      .forEach(([h, c1, c2]) => { db.hdr(DB0 + 1, c1, h); for (let c = c1 + 1; c <= c2; c++) db.ws.getCell(DB0 + 1, c).fill = FILL.HF; merge(DB0 + 1, c1, DB0 + 1, c2); });
    const top10 = mostCommon(sumBy(det.filter((x) => x.bucket !== 'PENDING'), (x) => x.sid, (x) => x.amt)).slice(0, DNB - 1).map((x) => x[0]); const SID = R('Svc ID');
    top10.forEach((sid, n) => { const rr = DB0 + 2 + n, sr = sid + 1;
      db.set(rr, DR0, `='Service Coding'!B${sr}`, { font: { ...st.F, name: 'Consolas', size: 9.5 } });
      merge(rr, DR0 + 1, rr, DR0 + 3); db.set(rr, DR0 + 1, `='Service Coding'!C${sr}`, { font: st.F, align: { horizontal: 'right', readingOrder: 'rtl', shrinkToFit: true } });
      db.set(rr, DR0 + 4, `='Service Coding'!D${sr}`, { font: st.SMALL, align: { horizontal: 'center' } });
      db.set(rr, DR0 + 5, `=SUMIFS(${R('Report qty')},${SID},${sid},${BK},"<>PENDING")`, { font: st.F, fmt: '#,##0;[Red](#,##0);"–"' });
      db.set(rr, DR0 + 6, `=IFERROR(${L(DR0 + 7)}${rr}/${L(DR0 + 5)}${rr},"")`, { font: st.F, fmt: '#,##0.00' });
      db.set(rr, DR0 + 7, `=SUMIFS(${AM},${SID},${sid},${BK},"<>PENDING")`, { font: st.B, fmt: NUM });
      for (let c = DR0; c <= DRE; c++) db.ws.getCell(rr, c).border = { bottom: { style: 'hair', color: { argb: 'FFD9DEE7' } } }; });
    const top10Sum = `SUM(${L(DRE)}${DB0 + 2}:${L(DRE)}${DB0 + 1 + top10.length})`;
    db.set(DB0 + DNB + 1, DRE, `="Top ${top10.length} services = "&TEXT(IFERROR(${top10Sum}/${DTOT},0),"0.0%")&" of certified cost"`, { font: st.IT, align: { horizontal: 'right' } });

    // ---- final control + control figures
    const DFC = DB0 + DNB + 3; rowH(DFC - 1, 10); rowH(DFC, 22); band(DFC, 1, DLAST, FILL.BAND);
    db.set(DFC, 2, 'FINAL CONTROL', { font: st.EYE, align: { vertical: 'middle' } });
    db.set(DFC, 3, `="Total "&TEXT(${DTOT},"#,##0")&"  =  Opening "&TEXT(${L(cNS)}8,"#,##0")&"  +  Approved months "&TEXT(${L(cM)}8,"#,##0")&"     |     Pending, not in total "&TEXT(${L(DR0)}8,"#,##0")&"     |     Work package table vs total: "&TEXT(${L(cTot)}${DTR}-${DTOT},"#,##0")&"     |     Report vs SAP (after WBS splits): "&TEXT(Notes!B${NOTES_RECON_ROW + 8},"#,##0")&"     |     Per-service totals vs Detail: "&IF(ROUND(SUM('Service Coding'!$J$2:$J$${NSC})-SUM(Detail!$${C['Cost (excl VAT)']}:$${C['Cost (excl VAT)']}),0)=0,"✔",TEXT(SUM('Service Coding'!$J$2:$J$${NSC})-SUM(Detail!$${C['Cost (excl VAT)']}:$${C['Cost (excl VAT)']}),"#,##0"))`,
      { font: st.CTRL, align: { vertical: 'middle' } });
    db.set(DFC + 1, 2, `="Also certified: VAT "&TEXT(SUM(Detail!$${C['VAT current']}:$${C['VAT current']}),"#,##0")&"  ·  adjustments "&TEXT(SUMIFS(${AM},${R('Line type')},"Adjustment"),"#,##0")&"  ·  other profit centres (not ${MAINPC}) "&TEXT(SUMIFS(${AM},${R('Other profit centre')},"X"),"#,##0")`, { font: st.SMALL });
    db.set(DFC + 2, 2, `Cut date ${A.cutDate.toISOString().slice(0, 10)} (end of the report month). Months = approved certificates by certificate date · Opening = approved initial invoices (Flag X) · Pending = not approved or dated after the cut date – shown, not in the total. Work package and MNL come from Service Coding via Service Monthly / Package Monthly.`, { font: st.IT });
    const PEND = DFC + 2;
    // ---- MONTHLY ACTIVITY (below the printed page): what each certificate month holds, what is still pending, what arrived late,
    // and – for months the last report already showed – whether every change is explained by lines added since
    const MA0 = PEND + 3, acols = [cB, cPk, ...Array.from({ length: cSh - cM + 1 }, (_, j) => cM + j), ...Array.from({ length: DRE - DR0 + 1 }, (_, j) => DR0 + j)];
    const allMonths = [...new Set(det.filter((x) => !x.initial).map((x) => x.month))].sort((a, b) => a - b);
    const prevM = A.prevByMonth, hasPrev = !!prevM;
    section(MA0, cB, DRE, 'MONTHLY ACTIVITY', `certificate lines by certificate month · report month ${mlabel(A.CUT)} · cut ${A.cutDate.toISOString().slice(0, 10)}`);
    const AH = ['Month', 'Status', 'Lines', 'Approved cost', 'Not approved lines', 'Not approved amount', 'Added late – lines', 'Added late – amount',
      'In last report', 'Change', 'Explained by late lines', 'Check'];
    rowH(MA0 + 1, 30); AH.forEach((h, j) => db.hdr(MA0 + 1, acols[j], h));
    const DM = R('Month'), DF = R('Initial invoice (Flag)'), DLate = R('Reported-month flag');
    const ar = (j) => L(acols[j]);
    let rr = MA0 + 2; const mRows = [];
    for (const m of allMonths) {
      const inRep = m <= A.CUT, reported = A.prevCut && m <= A.prevCut;
      const status = m === A.CUT ? 'Report month' : (!inRep ? { formula: `IF(SUMIFS(${AM},${BK},${m})=0,"After cut – Pending","After cut – "&TEXT(SUMIFS(${AM},${BK},${m}),"#,##0")&" included")` } : (reported ? 'Reported before' : (A.prevCut ? 'New since last report' : 'In report')));
      const f = { font: inRep ? st.F : { ...st.F, italic: true, color: { argb: 'FF8E3B37' } } };
      db.set(rr, acols[0], mlabel(m), { font: { ...f.font, bold: m === A.CUT } }); db.set(rr, acols[1], status, f);
      db.set(rr, acols[2], `=COUNTIFS(${DM},${m},${DF},"<>X")`, { ...f, fmt: '#,##0' });
      db.set(rr, acols[3], inRep ? `=SUMIFS(${AM},${BK},${m})` : `=SUMIFS(${AM},${DM},${m},${AP},"X",${DF},"<>X")`, { ...f, fmt: NUM });
      db.set(rr, acols[4], `=COUNTIFS(${DM},${m},${DF},"<>X",${AP},"<>X")`, { ...f, fmt: '#,##0;;"–"' });
      db.set(rr, acols[5], `=SUMIFS(${AM},${DM},${m},${DF},"<>X",${AP},"<>X")`, { ...f, fmt: NUM });
      db.set(rr, acols[6], `=COUNTIFS(${DM},${m},${DLate},"<>")`, { ...f, fmt: '#,##0;;"–"' });
      db.set(rr, acols[7], `=SUMIFS(${AM},${DM},${m},${DLate},"<>")`, { ...f, fmt: NUM });
      if (reported && hasPrev) {
        db.set(rr, acols[8], prevM.get(m) || 0, { ...f, fmt: NUM });
        db.set(rr, acols[9], `=${ar(3)}${rr}-${ar(8)}${rr}`, { ...f, fmt: NUM });
        db.set(rr, acols[10], `=SUMIFS(${AM},${BK},${m},${DLate},"<>")`, { ...f, fmt: NUM });
        db.set(rr, acols[11], `=IF(ROUND(${ar(9)}${rr}-${ar(10)}${rr},0)=0,"✔",ROUND(${ar(9)}${rr}-${ar(10)}${rr},0))`, { font: { ...st.B, color: { argb: 'FF1B7A4A' } }, fmt: '#,##0;[Red]-#,##0', align: { horizontal: 'center' } });
      } else if (reported) db.set(rr, acols[8], 'last report has no month detail', { font: st.SMALL });
      if (m === A.CUT) for (const c of acols) db.ws.getCell(rr, c).fill = fill('FBF1DC');
      if (!inRep) for (const c of acols) db.ws.getCell(rr, c).fill = FILL.AF;
      for (const c of acols) db.ws.getCell(rr, c).border = { bottom: { style: 'hair', color: { argb: 'FFD9DEE7' } } };
      rowH(rr, 18); mRows.push([m, rr]); rr++;
    }
    const inR = mRows.filter(([m]) => m <= A.CUT).map(([, x]) => x), rng = (j, rows) => rows.map((x) => ar(j) + x).join(',');
    const TOTR = rr, AVGR = rr + 1; rowH(TOTR, 20); rowH(AVGR, 20);
    db.set(TOTR, acols[0], 'Total', { font: st.B }); db.set(TOTR, acols[1], 'all months shown, incl. after the cut', { font: st.SMALL });
    db.set(AVGR, acols[0], 'Average', { font: st.B }); db.set(AVGR, acols[1], `per month to the cut (${inR.length})`, { font: st.SMALL });
    for (const j of [2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      if (!mRows.length) break;
      db.set(TOTR, acols[j], `=SUM(${ar(j)}${mRows[0][1]}:${ar(j)}${mRows[mRows.length - 1][1]})`, { font: st.B, fmt: j === 2 || j === 4 || j === 6 ? '#,##0' : NUM });
      if (j <= 7 && inR.length) db.set(AVGR, acols[j], `=AVERAGE(${rng(j, inR)})`, { font: st.F, fmt: j === 2 || j === 4 || j === 6 ? '#,##0' : NUM }); }
    for (const x of [TOTR, AVGR]) for (const c of acols) db.ws.getCell(x, c).fill = FILL.TF;
    db.set(AVGR + 1, cB, `Lines = certificate lines dated in the month (initial invoices are Opening, not counted). Approved cost to the cut is the month on Service Monthly; after the cut it is Pending. Added late = dated in a month the last report already showed but not among its lines, or approved since (Detail → Reported-month flag). Check (months reported before): the change since the last report must equal the late lines – ✔, or the unexplained amount (a changed or removed line).`, { font: st.IT });
    db.ws.getRow(AVGR + 1).height = 30; db.ws.getCell(AVGR + 1, cB).alignment = { wrapText: true, vertical: 'top' }; merge(AVGR + 1, cB, AVGR + 1, DRE);
    // page 1 = the dashboard, page 2 on = Monthly activity (it grows by a row a month); one page wide, manual break between them
    db.ws.pageSetup = { paperSize: 8, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, horizontalCentered: true,
      margins: { left: 0.3, right: 0.3, top: 0.35, bottom: 0.35, header: 0.15, footer: 0.15 }, printArea: `A1:${L(DLAST)}${AVGR + 1}` };
    db.ws.getRow(MA0 - 1).addPageBreak();
    db.ws.headerFooter = { oddFooter: `&L&8${A.PLANT} · Subcontract cost dashboard&R&8Page &P of &N` };
    db.ws.views = [{ showGridLines: false, zoomScale: 90 }];
    DASH_TOTAL = `Dashboard!${L(cTot)}${DTR}`;
    }

    // ---------------- Changes (history)
    await say('Changes'); const chs = S['Changes'];
    const loads = histLoads(A, summarize(A).k);
    chs.set(1, 2, 'Changes and load history', { font: st.T1 });
    chs.set(2, 2, A.hist && A.hist.loads.length ? `This load (${A.loadNo}) compared with load ${A.loadNo - 1}. Lines are matched by Line ID (PO | cert serial | PO item | package | line).`
      : 'First load – there is no previous report to compare with. Next month, give the web tool this workbook together with the new SAP files.', { font: st.SMALL });
    chs.set(4, 2, '1. Load history', { font: st.B });
    const lh = ['Load', 'Run on', 'Data date', 'ZSCPROG01 file', 'Lines', 'Certified cost', 'Approved', 'Opening', 'Not approved', 'Adjustments', 'Subcontractors', 'POs'];
    lh.forEach((h, j) => chs.hdr(5, 2 + j, h));
    loads.forEach((l, n) => { const rr = 6 + n;
      [l.no, l.run instanceof Date ? l.run : null, l.dataDate instanceof Date ? l.dataDate : null, l.file, l.lines, l.total, l.approved, l.opening, l.pending, l.adjustments, l.subs, l.pos]
        .forEach((v, j) => chs.set(rr, 2 + j, v, { font: n === loads.length - 1 ? st.B : st.F, fmt: j === 1 || j === 2 ? 'yyyy-mm-dd' : (j >= 5 && j <= 9 ? NUM : undefined) })); });
    const LH1 = 6 + loads.length;
    if (loads.length > 1) charts.push({ sheet: 'Changes', col: 14, row: 3, w: 16, h: 7.5, kind: 'col', title: 'Certified cost by load', labels: true, labelFmt: '#,##0.0,,"M"', valFmt: '#,##0,,"M"',
      series: [{ cat: `'Changes'!$B$6:$B$${LH1 - 1}`, val: `'Changes'!$G$6:$G$${LH1 - 1}`, color: BRAND }] });
    const C0 = Math.max(LH1 + 2, 22);
    chs.set(C0, 2, '2. What changed since the previous load', { font: st.B });
    ['Change', 'Lines', 'Amount effect'].forEach((h, j) => chs.hdr(C0 + 1, 2 + j, h));
    const types = ['New', 'Amount changed', 'Approved since last load', 'Removed'];
    const eff = { New: (c) => c.now, 'Amount changed': (c) => c.now - c.prev, 'Approved since last load': (c) => c.now, Removed: (c) => -c.prev };
    types.forEach((t, n) => { const cs = A.changes.filter((c) => c.type === t);
      chs.set(C0 + 2 + n, 2, t, { font: st.F }); chs.set(C0 + 2 + n, 3, cs.length, { font: st.F }); chs.set(C0 + 2 + n, 4, cs.reduce((s, c) => s + eff[t](c), 0), { font: st.F, fmt: NUM }); });
    chs.set(C0 + 6, 2, 'New and Amount changed move the certified total; Approved moves money from Not approved to Approved; Removed lines were in the previous export and are gone now.', { font: st.IT });
    const D0 = C0 + 9; chs.set(D0, 2, '3. Changed lines', { font: st.B });
    const dh = ['Change', 'Line ID', 'Cert. date', 'PO', 'Supplier', 'Service', 'Service text', 'Previous amount', 'Amount now', 'Difference', 'Approved now'];
    dh.forEach((h, j) => chs.hdr(D0 + 1, 2 + j, h));
    const chRows = A.changes.slice().sort((a, b) => Math.abs(b.now - b.prev || b.now) - Math.abs(a.now - a.prev || a.now)).map((c) => c.r
      ? [c.type, c.r.lid, c.r.dateObj, c.r.po, c.r.supName, c.r.svc, c.r.text, c.prev, c.now, c.now - c.prev, c.r.approved ? 'X' : '']
      : [c.type, c.lid, null, c.p.po, c.p.sup, c.p.svc, c.p.text, c.prev, 0, -c.prev, '']);
    chRows.forEach((row, n) => row.forEach((v, j) => chs.set(D0 + 2 + n, 2 + j, v, { font: st.F, fmt: j === 2 ? 'yyyy-mm-dd' : (j >= 7 && j <= 9 ? NUM : undefined) })));
    if (!chRows.length) chs.set(D0 + 2, 2, A.hist && A.hist.loads.length ? 'No line changed.' : 'Nothing to compare yet.', { font: st.IT });
    chs.width(1, 2); [22, 30, 11, 12, 30, 11, 36, 14, 14, 14, 11, 12].forEach((w, j) => chs.width(2 + j, w));

    // ---------------- hidden history store (read back by the web tool next month)
    const hs = S['_History'];
    hs.ws.addRow(['Load', 'Run on', 'Data date', 'File', 'Lines', 'Certified cost', 'Approved', 'Opening', 'Not approved', 'Adjustments', 'Subcontractors', 'POs', 'Project']);
    for (const l of loads) hs.ws.addRow([l.no, l.run instanceof Date ? l.run : null, l.dataDate instanceof Date ? l.dataDate : null, l.file, l.lines, l.total, l.approved, l.opening, l.pending, l.adjustments, l.subs, l.pos, A.PLANT]);
    const ls = S['_Lines'];
    ls.ws.addRow(['Line ID', 'Amount', 'Approved', 'Flag', 'First seen', 'PO', 'Supplier', 'Service', 'Service text', 'Report bucket', 'Month']);
    ls.ws.addRows(det.map((r) => [r.lid, r.amt, r.appr, r.flag, r.first, r.po, r.supName, r.svc, r.text, r.bucket, r.month]));
    const rs = S['_Rows']; rs.ws.addRow(['Row ID', 'Identity', 'First seen (load)', 'Order', 'Service', 'Service text', 'PO', 'Supplier']);
    SM_ORDER.forEach((idx, n) => { const t = A.keyTuples[idx]; rs.ws.addRow([A.rowIds[idx], JSON.stringify(t), A.rowFirst[idx], n + 1, t[0], t[1], t[8], t[3]]); });
    hs.ws.state = 'hidden'; ls.ws.state = 'hidden'; rs.ws.state = 'hidden'; S['_Chart'].ws.state = 'hidden';

    // ---------------- Notes
    await say('Notes'); const ws = S['Notes'];
    const sumIf = (f) => det.filter(f).reduce((s, r) => s + r.amt, 0);
    const fmtN = (v) => Math.round(v).toLocaleString('en-US');
    const unk = A.services.filter((s) => !s.unit).length;
    const notes = [['How this workbook is built', st.B], ['', st.F],
      [`Source: SAP ZSCPROG01 export (${A.files.prog || 'ZSCPROG01'}), plant ${A.PLANT}, main profit centre ${MAINPC}. ${det.length} certificate lines kept; ${A.rawRowCount - A.RAWN} SAP subtotal/total rows removed.`, st.F],
      ['Amount = "SC Work Current Cost" (excl. VAT); Qty = "Current Quantity"; month = certificate "Date".', st.F],
      ['Flag = X → initial invoice entered before go-live → OPENING block, never a month. If it is not yet approved it goes to PENDING instead, marked "Opening – not approved" on Detail.', st.F],
      [`Report month ${mlabel(A.CUT)}, cut date ${A.cutDate.toISOString().slice(0, 10)} (Coding!N2). Character 1 = X → approved. Not approved, or dated after the cut date → PENDING block (Detail → Pending reason) – shown, not in Total. ${det.filter((r) => r.late).length} lines fall in a month the last report already showed (Detail → Reported-month flag).`, st.F],
      [`Service Monthly row = Service + Service text + Line type + Supplier + Gross price + Contract type (نوع العقد) + Tax code (Tx) + Profit centre + PO: ${A.keyTuples.length} rows. Each row has a permanent Row ID (stored in the hidden _Rows sheet) that it keeps in every later load; ${A.rowFirst.filter((f) => f === A.loadNo).length} rows are new in load ${A.loadNo}. Row order: grouped under a header row per work package, sorted by service → service text → PO inside each (rebuilt every load – compare months by Row ID).`, st.F],
      [`Line type "Adjustment" = amount with zero quantity, or with a ≤ 0.01 placeholder quantity that does not explain the amount (${det.filter((r) => r.isadj).length} lines, net ${fmtN(sumIf((r) => r.isadj))}): payment-% changes, re-pricing, reversals – own orange row; report qty = amount ÷ net rate (SAP's placeholder qty is ignored), so the service quantity nets off with the amount. ${det.filter((r) => r.qcheck).length} of them are marked "Check" in Detail → Qty check (no normal qty on that PO service line, or the qty would go below zero).`, st.F],
      ['Report qty: where a line was not paid at qty × net rate (paid % below 100, catch-up to 100 %, re-price) the report uses equivalent qty = amount ÷ net rate, so every rate equals the contract rate. SAP qty stays on Detail and feeds Qty Reconciliation.', st.F],
      [`Profit centre: lines not on ${MAINPC} (${det.filter((r) => r.othpc).length} lines, ${fmtN(sumIf((r) => r.othpc))}) stay in the report, on their own purple rows, flagged on Detail and as a Dashboard figure.`, st.F],
      [`Line type "Qty only (excluded)" = quantity with zero amount (${det.filter((r) => r.isqo).length} lines): repeats of quantity already certified on another line (re-pricing) or 0.01 placeholders. No cost impact; excluded so quantities are not double-counted. Kept on Detail.`, st.F],
      ['Net rate: A2 (شامل) gross prices include VAT → SAP pays Gross ÷ (1 + VAT); A1 (غير شامل) pays Gross. VAT per tax code on Coding.', st.F],
      [`Service Coding holds Unit, Package (CSI division), MNL, Cost Element Code per Service + text (${A.services.length} rows), taken from the shared coding in the web tool and the previous report. ${unk} units unknown (red).`, st.F],
      [`ZSCSRV1 (PO service lines, ${A.sv.length} lines): Unit per service code, Material group per PO service line, contract and received qty on Qty Reconciliation. Lines are matched by PO + item + service code + text + price, then text only, then service code only (Detail "PO line match").`, st.F],
      [`WBS splits: ${A.splitLines} certificate lines appear on several WBS rows with the same amount, qty and VAT (SAP repeats the whole line per WBS). Each is counted once – ${fmtN(A.splitAmt)} of repeated amount removed.` + (A.keyConflicts ? ` ${A.keyConflicts} rows share a Line ID but differ in amount – kept as they are.` : ''), st.F],
      [`History: load ${A.loadNo}. Each load stores its lines in the hidden _Lines sheet so the next load can list what changed (sheet Changes).`, st.F],
      ['WBS is kept on Detail for reference only. "ZNET_FINL" and "SC Work Current + Vat" are certificate-header values repeated per line – not used.', st.F],
      ['SAP labels "Account Number of Supplier" (holds the NAME) and "Supplier" (holds the CODE) the wrong way round – fixed on Detail.', st.F],
      ['', st.F], ['Reconciliation', st.B]];
    notes.forEach(([t, f], n) => ws.set(n + 1, 1, t, { font: f }));
    if (notes.length >= NOTES_RECON_ROW) throw new Error('Notes grew past the reconciliation block');
    const n0 = NOTES_RECON_ROW;
    ws.set(n0, 1, 'SAP grand total, SC Work Current Cost (source file footer row)', { font: st.F });
    ws.set(n0, 2, A.gt, { font: st.BLUE, note: `From the SAP export grand-total row "${A.PLANT} (${A.RAWN.toLocaleString('en-US')})".` });
    ws.set(n0 + 1, 1, 'Less: amounts repeated on extra WBS rows of split lines (counted once in this report)', { font: st.F });
    ws.set(n0 + 1, 2, -A.splitAmt, { font: st.BLUE, note: `${A.splitLines} certificate lines were split across several WBS elements; SAP repeats the full amount on every WBS row.` });
    ws.set(n0 + 2, 1, 'Certified cost (report basis)', { font: st.B }); ws.set(n0 + 2, 2, `=B${n0}+B${n0 + 1}`, { font: st.B });
    ws.set(n0 + 3, 1, 'Detail total', { font: st.F }); ws.set(n0 + 3, 2, `=SUM(Detail!${C['Cost (excl VAT)']}:${C['Cost (excl VAT)']})`);
    ws.set(n0 + 4, 1, 'Pending (not approved or after the cut date) – not in Total', { font: st.F }); ws.set(n0 + 4, 2, `=${SM_PEND}`);
    ws.set(n0 + 5, 1, 'Service Monthly Total + Pending', { font: st.F }); ws.set(n0 + 5, 2, `=${SM_TOTAL}+B${n0 + 4}`);
    ws.set(n0 + 6, 1, 'Service Quarterly Total + Pending', { font: st.F }); ws.set(n0 + 6, 2, `=${PM.sq}+B${n0 + 4}`);
    ws.set(n0 + 7, 1, 'Dashboard work package table (= Package Monthly) + Pending', { font: st.F }); ws.set(n0 + 7, 2, `=${DASH_TOTAL}+B${n0 + 4}`);
    ws.set(n0 + 6, 1, 'Service Quarterly Total + Pending (values as built – differs only after lines are included on Detail; rebuild to refresh)', { font: st.F });
    ws.set(n0 + 8, 1, 'Largest difference (must be 0)', { font: st.B }); ws.set(n0 + 8, 2, `=MAX(ABS(B${n0 + 3}-B${n0 + 2}),ABS(B${n0 + 5}-B${n0 + 2}),ABS(B${n0 + 7}-B${n0 + 2}),ABS('Package Monthly'!${PM.totCol}${PM.tot}+'Package Monthly'!${PM.pendCol}${PM.tot}-B${n0 + 2}))`);
    for (let r = n0; r <= n0 + 8; r++) ws.ws.getCell(r, 2).numFmt = NUM;
    ws.width(1, 130); ws.width(2, 18);

    await say('Writing the Excel file');
    const buf = await wb.xlsx.writeBuffer();
    await say('Adding charts');
    return injectCharts(buf, charts, ORDER, JSZip, {});
  }

  // ================================================================== CODING MASTER
  // One shared file (e.g. on the team drive) holding Unit / CSI / MNL / Cost Element Code per Service + text.
  const MASTER_SHEET = 'Coding Master';
  const MASTER_COLS = ['Service', 'Service text', 'SAP unit', 'Unit', 'CSI', 'MNL', 'Cost Element Code', 'Seen in projects', 'Updated'];
  function readCodingMaster(aoa) {
    const H = (aoa[0] || []).map((x) => str(x).trim()); const ix = (n) => H.indexOf(n);
    if (ix('Service') < 0 || ix('Service text') < 0) throw new Error('The coding master needs "Service" and "Service text" columns.');
    const m = new Map();
    for (const r of aoa.slice(1)) {
      const svc = str(r[ix('Service')]).trim(); if (!svc) continue;
      const text = str(r[ix('Service text')]).trim();
      const upd = r[ix('Updated')];
      m.set(codingKey(svc, text), { svc, text, sapUnit: str(r[ix('SAP unit')]).trim(), unit: str(r[ix('Unit')]).trim(), csi: str(r[ix('CSI')]).trim(),
        mnl: str(r[ix('MNL')]).trim(), cec: str(r[ix('Cost Element Code')]).trim(),
        projects: str(r[ix('Seen in projects')]).split(/[,;]\s*/).map((x) => x.trim()).filter(Boolean),
        updated: upd instanceof Date ? upd : (typeof upd === 'number' && upd > 0 ? new Date(Math.round((upd - 25569) * 86400000)) : null) });
    }
    return m;
  }
  // master: Map from readCodingMaster (may be empty); A: analysis of this load; edits: Map codingKey -> {unit,csi,mnl,cec} typed on the page
  function mergeCodingMaster(master, A, edits) {
    const out = new Map(); for (const [k, v] of master) out.set(k, { ...v, projects: v.projects.slice() });
    const now = new Date(); let added = 0, changed = 0;
    if (A) for (const s of A.services) {
      let e = out.get(s.key); if (!e) { e = { svc: s.svc, text: s.text, sapUnit: '', unit: '', csi: '', mnl: '', cec: '', projects: [], updated: null }; out.set(s.key, e); added++; }
      if (s.sapUnit) e.sapUnit = s.sapUnit;
      if (!e.projects.includes(A.PLANT)) e.projects.push(A.PLANT);
    }
    if (edits) for (const [k, v] of edits) {
      const e = out.get(k); if (!e) continue;
      let hit = false; for (const f of ['unit', 'csi', 'mnl', 'cec']) if (v[f] !== undefined && (v[f] || '') !== (e[f] || '')) { e[f] = v[f] || ''; hit = true; }
      if (hit) { e.updated = now; changed++; }
    }
    return { map: out, added, changed };
  }
  async function buildCodingMaster(map, libs) {
    const wb = new libs.ExcelJS.Workbook(); wb.creator = 'Subcontract report';
    const ws = wb.addWorksheet(MASTER_SHEET);
    ws.addRow(MASTER_COLS);
    const rows = [...map.values()].sort((a, b) => cmpTuple([a.svc, a.text], [b.svc, b.text]));
    for (const e of rows) ws.addRow([e.svc, e.text, e.sapUnit || null, e.unit || null, e.csi || null, e.mnl || null, e.cec || null, e.projects.join(', '), e.updated || null]);
    ws.getRow(1).eachCell((c, j) => { const y = [4, 5, 6, 7].includes(j); c.font = y ? st.HB : st.H; c.fill = y ? FILL.YF : FILL.HF; c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }; });
    [12, 50, 9, 9, 14, 14, 18, 22, 12].forEach((w, j) => { ws.getColumn(j + 1).width = w; });
    for (let j = 1; j <= 9; j++) ws.getColumn(j).font = st.F;
    ws.getRow(1).eachCell((c, j) => { c.font = [4, 5, 6, 7].includes(j) ? st.HB : st.H; });
    for (const j of [1, 5, 6, 7]) ws.getColumn(j).numFmt = '@';
    ws.getColumn(9).numFmt = 'yyyy-mm-dd';
    for (let i = 2; i <= rows.length + 1; i++) for (const j of [4, 5, 6, 7]) ws.getCell(i, j).fill = FILL.YF;
    ws.getRow(1).eachCell((c, j) => { c.fill = [4, 5, 6, 7].includes(j) ? FILL.YF : FILL.HF; });
    ws.views = [{ state: 'frozen', xSplit: 2, ySplit: 1 }]; ws.autoFilter = `A1:I${rows.length + 1}`;
    const rm = wb.addWorksheet('Read me');
    ['Service coding master', '', 'One row per SAP service code + service text. Fill the yellow columns: Unit (only to override the SAP unit), CSI, MNL, Cost Element Code.',
      'The report tool reads this file every month and writes the codes into each report. Keep one copy on the shared drive.',
      'After editing codes in the tool, save the updated master it offers over this file. New services are added automatically; nothing is ever deleted.',
      '"Seen in projects" lists the plants whose SAP exports contained the service.']
      .forEach((t, i) => { rm.getCell(i + 1, 1).value = t || null; rm.getCell(i + 1, 1).font = i === 0 ? st.T1 : st.F; });
    rm.getColumn(1).width = 120;
    return wb.xlsx.writeBuffer();
  }

  // ================================================================== WORK PACKAGE CODING (v2)
  // Three dimensions on one key (project + service code + service text):
  //   package  = CSI division (shared catalogue), mnl = MAT/SUB/EQU (shared catalogue),
  //   cec      = cost element (catalogue per project, created by the user).
  // Keys match exactly; suggestions are only ever proposals until someone accepts them.
  const GROUP_COLOR = { General: '6B7280', Civil: '2A5CAA', Arch: 'B07D2B', MEP: '1B8A6B' };
  // CSI MasterFormat 2004 divisions used by the company, plus INDIRECT
  const PACKAGES = [
    ['DIV 03', 'Concrete', 'Civil', '🏗️'], ['DIV 0302', 'Reinforcement Steel', 'Civil', '⛓️', 2], ['DIV 04', 'Masonry', 'Civil', '🧱'], ['DIV 05', 'Metals', 'Civil', '🔩'],
    ['DIV 06', 'Wood, Plastics and Composites', 'Arch', '🪵'], ['DIV 07', 'Thermal and Moisture Protection', 'Arch', '💧'], ['DIV 08', 'Openings', 'Arch', '🚪'],
    ['DIV 09', 'Finishes', 'Arch', '🎨'], ['DIV 10', 'Specialties', 'Arch', '🧰'],
    ['DIV 21', 'Fire Suppression', 'MEP', '🧯'], ['DIV 22', 'Plumbing', 'MEP', '🚰'], ['DIV 23', 'HVAC', 'MEP', '❄️'], ['DIV 26', 'Electrical', 'MEP', '⚡'], ['DIV 27', 'Communications', 'MEP', '📡'],
    ['DIV 31', 'Earthwork', 'Civil', '🚜'], ['DIV 32', 'Exterior Improvements', 'Civil', '🌳'], ['DIV 33', 'Utilities', 'Civil', '🛢️'],
    ['INDIRECT', 'Indirect', 'General', '🗂️']]
    .map(([code, label, group, icon, since], i) => ({ code, label, group, icon, color: GROUP_COLOR[group], sort: i + 1, system: true, since: since || 1 }));
  // catalogue version: a master saved before a predefined package existed still gets it (one saved later and missing it has deleted it)
  const CATALOGUE_VERSION = Math.max(...PACKAGES.map((p) => p.since));
  // lists saved into the tool itself (Save tool) replace the built-in ones; their version is a time stamp, so whichever
  // of tool and master was saved later decides the lists
  let BASE_VER = CATALOGUE_VERSION, BASE_CE = [];
  const listStamp = () => { const d = new Date(), p = (n) => String(n).padStart(2, '0');
    return +`${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };
  function setBase(b) {
    if (!b) return;
    if (b.packages && b.packages.length) PACKAGES.splice(0, PACKAGES.length, ...b.packages.map((p, i) => ({ code: p.code, label: p.label || p.code, group: p.group || 'General',
      icon: p.icon || '', color: p.color || GROUP_COLOR[p.group] || '6B7280', sort: i + 1, system: !!p.system, since: p.since || 1 })));
    if (b.mnl && b.mnl.length) MNLS.splice(0, MNLS.length, ...b.mnl.map((x) => ({ code: x.code, label: x.label || x.code, system: !!x.system })));
    BASE_CE = b.costElements || []; BASE_VER = Math.max(CATALOGUE_VERSION, +b.version || 0);
  }
  function listsOf(master) {       // what Save tool writes into the page
    return { version: master.version || listStamp(), packages: master.packages.map(({ code, label, group, icon, color, system, since }) => ({ code, label, group, icon, color, system: !!system, since: since || 1 })),
      mnl: master.mnl.map(({ code, label, system }) => ({ code, label, system: !!system })), costElements: [...master.costElements].map(([pr, m]) => [pr, [...m]]) };
  }
  const MNLS = [['MAT', 'Material'], ['SUB', 'Subcontract'], ['EQU', 'Equipment'], ['LAB', 'Labor'], ['OTHER', 'Others Resources']].map(([code, label]) => ({ code, label, system: true }));
  const DIMS = { package: 'Package', mnl: 'MNL', cec: 'Cost element' };
  // service-code division (MasterFormat 2004 numbering in SAP) -> 16-division package
  // SAP service codes carry the same 2004 division digits (S0303 -> 03); divisions outside the catalogue suggest INDIRECT
  const DIV_FROM_SERVICE = { '03': 'DIV 03', '04': 'DIV 04', '05': 'DIV 05', '06': 'DIV 06', '07': 'DIV 07', '08': 'DIV 08', '09': 'DIV 09', '10': 'DIV 10',
    '21': 'DIV 21', '22': 'DIV 22', '23': 'DIV 23', '25': 'DIV 27', '26': 'DIV 26', '27': 'DIV 27', '28': 'DIV 27', '31': 'DIV 31', '32': 'DIV 32', '33': 'DIV 33',
    '01': 'INDIRECT', '02': 'INDIRECT', '34': 'INDIRECT' };
  // codes from the first catalogue (1995 16-division numbering) and where they go now
  const OLD_PACKAGES = { 'DIV 01': 'INDIRECT', 'DIV 02': 'DIV 31', 'DIV 16': 'DIV 26', 'DIV 15': null, 'DIV 11': null, 'DIV 12': null, 'DIV 13': null, 'DIV 14': null };
  // package codes are written "DIV 03"; "DIV03" / "div 3" from older files or typing are read as the same code
  const normPkg = (c) => { const t = str(c).trim(), m = /^DIV\s*(\d{1,4})$/i.exec(t); return m ? 'DIV ' + m[1].padStart(m[1].length > 2 ? 4 : 2, '0') : t; };
  const mkey = (project, svc, text) => project + '\u0001' + svc + '\u0001' + text;
  function defaultMaster() {
    return { packages: PACKAGES.map((p) => ({ ...p })), mnl: MNLS.map((m) => ({ ...m })), costElements: new Map(BASE_CE.map(([pr, l]) => [pr, new Map(l)])), mapping: new Map(), migrated: 0, version: BASE_VER };
  }
  const asDateV = (v) => v instanceof Date ? v : (typeof v === 'number' && v > 0 ? new Date(Math.round((v - 25569) * 86400000)) : null);
  const sheetRows = (aoa) => { const H = (aoa[0] || []).map((x) => str(x).trim().toLowerCase()); const ix = (n) => H.indexOf(n.toLowerCase());
    return { ix, rows: aoa.slice(1) }; };
  // sheets: { sheetName: aoa } of a master file (v2), or of the older single-sheet "Coding Master"
  function readMaster(sheets) {
    const m = defaultMaster();
    { const hv = Math.max(1, ...((sheets['Packages'] || [])[0] || []).map((h) => +((/^catalogue v(\d+)$/i.exec(str(h).trim()) || [])[1] || 0)));
      m.toolLists = BASE_VER > CATALOGUE_VERSION && hv < BASE_VER;          // the lists saved in this tool are newer than the master's
      m.version = Math.max(hv, BASE_VER);
      if (m.toolLists) { const ce = sheets['Cost Elements'];
        sheets = Object.assign({}, sheets); delete sheets['Packages']; delete sheets['MNL']; delete sheets['Cost Elements'];
        if (ce) { const { ix, rows } = sheetRows(ce); for (const r of rows) { const pr = str(r[ix('Project')]).trim(), code = str(r[ix('Code')]).trim();   // projects the tool has no list for
          if (!pr || !code || BASE_CE.some((x) => x[0] === pr)) continue; if (!m.costElements.has(pr)) m.costElements.set(pr, new Map()); m.costElements.get(pr).set(code, str(r[ix('Label')]).trim()); } } } }
    // Packages sheet = the catalogue: rename = edit Label, add = new row, delete = remove the row (its codings become unallocated).
    // A sheet from the first (1995-numbered) catalogue is only migrated, never read as deletions.
    let listed = null, oldCatalogue = false, ver = 1;
    if (sheets['Packages']) { const { ix, rows } = sheetRows(sheets['Packages']); listed = new Set();
      ver = Math.max(1, ...(sheets['Packages'][0] || []).map((h) => +((/^catalogue v(\d+)$/i.exec(str(h).trim()) || [])[1] || 0)));
      for (const r of rows) { const code = normPkg(r[ix('Code')]); if (!code) continue;
        const sys = /^y/i.test(str(r[ix('System')]).trim());
        if (sys && code in OLD_PACKAGES && !PACKAGES.some((q) => q.code === code)) { oldCatalogue = true; continue; }   // retired system code
        listed.add(code);
        const cur = m.packages.find((p) => p.code === code); const rec = { code, label: str(r[ix('Label')]).trim() || code, group: str(r[ix('Group')]).trim() || 'General',
          icon: str(r[ix('Icon')]).trim(), color: str(r[ix('Color')]).trim().replace('#', '') || GROUP_COLOR[str(r[ix('Group')]).trim()] || '6B7280',
          sort: num(r[ix('Sort')]) || (m.packages.length + 1), system: cur ? cur.system : false };
        if (cur) Object.assign(cur, rec); else m.packages.push(rec); }
      m.packages.sort((a, b) => a.sort - b.sort); }
    if (listed && !oldCatalogue) m.packages = m.packages.filter((p) => listed.has(p.code) || (p.system && p.since > ver));
    if (listed) for (const p of m.packages) if (!listed.has(p.code) && p.since > ver) {        // newly predefined: place it after its neighbour in the default list
      const before = PACKAGES[PACKAGES.findIndex((q) => q.code === p.code) - 1], nb = before && m.packages.find((q) => q.code === before.code);
      p.sort = nb ? nb.sort + 0.5 : 0.5; }
    m.packages.sort((a, b) => a.sort - b.sort); m.packages.forEach((p, i) => { p.sort = i + 1; });
    if (sheets['MNL']) { const { ix, rows } = sheetRows(sheets['MNL']);
      for (const r of rows) { const code = str(r[ix('Code')]).trim(); if (!code) continue; const cur = m.mnl.find((x) => x.code === code);
        if (cur) cur.label = str(r[ix('Label')]).trim() || cur.label; else m.mnl.push({ code, label: str(r[ix('Label')]).trim() || code, system: false }); }
      // the sheet is the list: a code removed from it is deleted (sheets from before LAB / OTHER existed only add them)
      const had = new Set(rows.map((r) => str(r[ix('Code')]).trim()).filter(Boolean)), older = !had.has('LAB') && !had.has('OTHER') && had.has('MAT');
      if (!older) m.mnl = m.mnl.filter((x) => had.has(x.code)); }
    if (sheets['Cost Elements']) { const { ix, rows } = sheetRows(sheets['Cost Elements']); m.costElements = new Map();   // the master's sheet is the list
      for (const r of rows) { const pr = str(r[ix('Project')]).trim(), code = str(r[ix('Code')]).trim(); if (!pr || !code) continue;
        if (!m.costElements.has(pr)) m.costElements.set(pr, new Map()); m.costElements.get(pr).set(code, str(r[ix('Label')]).trim()); } }
    if (sheets['Service Mapping']) { const { ix, rows } = sheetRows(sheets['Service Mapping']);
      for (const r of rows) { const pr = str(r[ix('Project')]).trim(), svc = str(r[ix('Service')]).trim(); if (!pr || !svc) continue;
        const e = { package: normPkg(r[ix('Package')]), mnl: str(r[ix('MNL')]).trim(), cec: str(r[ix('Cost Element')]).trim(), unit: str(r[ix('Unit override')]).trim(), updated: asDateV(r[ix('Updated')]) };
        if (e.package || e.mnl || e.cec || e.unit) m.mapping.set(mkey(pr, svc, str(r[ix('Service text')]).trim()), e); } }
    m.remapped = 0;
    const inCat = (c) => m.packages.some((p) => p.code === c);
    for (const [k, v] of m.mapping) if (v.package && v.package in OLD_PACKAGES && !inCat(v.package)) {
      const svc = k.split('\u0001')[1]; const d = svc[0] === 'S' ? DIV_FROM_SERVICE[svc.slice(1, 3)] : null;
      v.package = OLD_PACKAGES[v.package] || (d && d !== 'INDIRECT' ? d : ''); m.remapped++;
      if (!(v.package || v.mnl || v.cec || v.unit)) m.mapping.delete(k); }
    if (sheets[MASTER_SHEET] && !sheets['Service Mapping']) {           // older master: bring its codes forward where they fit the catalogues
      const old = readCodingMaster(sheets[MASTER_SHEET]);
      for (const e of old.values()) {
        const pk = (/^(?:DIV|S)?\s*0?(\d{1,2})$/i.exec(e.csi || '') || [])[1]; const pkg = pk ? (DIV_FROM_SERVICE[pk.padStart(2, '0')] || '') : (m.packages.some((p) => p.code === e.csi) ? e.csi : '');
        const mn = m.mnl.some((x) => x.code === e.mnl) ? e.mnl : '';
        for (const pr of e.projects) {
          const rec = { package: pkg, mnl: mn, cec: e.cec || '', unit: e.unit || '', updated: e.updated };
          if (rec.package || rec.mnl || rec.cec || rec.unit) { m.mapping.set(mkey(pr, e.svc, e.text), rec); m.migrated++; }
          if (e.cec) { if (!m.costElements.has(pr)) m.costElements.set(pr, new Map()); if (!m.costElements.get(pr).has(e.cec)) m.costElements.get(pr).set(e.cec, ''); }
        } } }
    // codings on a package that is no longer in the catalogue go back to unallocated (the service keeps its MNL / cost element)
    m.dropped = 0;
    for (const [k, v] of m.mapping) if (v.package && !inCat(v.package)) { v.package = ''; m.dropped++; if (!(v.mnl || v.cec || v.unit)) m.mapping.delete(k); }
    for (const [k, v] of m.mapping) if (v.mnl && !m.mnl.some((x) => x.code === v.mnl)) { v.mnl = ''; m.dropped++; if (!(v.package || v.cec || v.unit)) m.mapping.delete(k); }
    return m;
  }
  // coding map for one project, in the shape analyse() expects (csi = package)
  function codingFor(master, project) {
    const out = new Map(); const pre = project + '\u0001';
    for (const [k, v] of master.mapping) if (k.startsWith(pre)) out.set(k.slice(pre.length), { csi: v.package || '', mnl: v.mnl || '', cec: v.cec || '', unit: v.unit || '' });
    return out;
  }
  // proposals for uncoded dimensions: same service coded in another project first, then the service code itself
  function suggest(A, master) {
    const out = new Map(); const other = new Map();   // codingKey -> {package, mnl, cec, from}
    for (const [k, v] of master.mapping) { const [pr, svc, text] = k.split('\u0001'); if (pr === A.PLANT) continue;
      const ck = codingKey(svc, text); const o = other.get(ck) || {};
      for (const f of ['package', 'mnl']) if (v[f] && !o[f]) { o[f] = v[f]; o[f + 'From'] = pr; }
      other.set(ck, o); }
    for (const s of A.services) {
      const cur = master.mapping.get(mkey(A.PLANT, s.svc, s.text)) || {}; const o = other.get(s.key) || {}; const g = {};
      if (!cur.package) { if (o.package) g.package = [o.package, 'coded in ' + o.packageFrom];
        else { const pre = s.svc.slice(0, 1), d = s.svc.slice(1, 3);
          if (pre === 'S' && DIV_FROM_SERVICE[d]) g.package = [DIV_FROM_SERVICE[d], 'from service code S' + d];
          else if (pre === 'L' || pre === 'P') g.package = ['INDIRECT', pre === 'L' ? 'labour supply' : 'plant & logistics']; } }
      if (!cur.mnl) { if (o.mnl) g.mnl = [o.mnl, 'coded in ' + o.mnlFrom];
        else if (s.svc[0] === 'L') g.mnl = ['LAB', 'labour service code'];          // before the supply rule: "توريد عامل" is labour supply
        else if (/توريد/.test(s.text) && !/تركيب/.test(s.text)) g.mnl = ['MAT', 'text says supply (توريد)'];
        else if (s.svc[0] === 'P') g.mnl = ['EQU', 'plant service code'];
        else if (s.svc[0] === 'S') g.mnl = ['SUB', 'subcontract service code']; }
      if (Object.keys(g).length) out.set(s.key, g);
    }
    return out;
  }
  // bring the codes typed in last month's report (Service Coding sheet) into the work package coding of this project.
  // The report wins over the master unless the master's entry was changed after the report file was saved.
  function adoptPrevious(master, project, prevCoding, savedAt) {
    const res = { added: 0, changed: 0, keptNewer: 0, unknown: 0, unknownCodes: new Set() };
    if (!project || !prevCoding) return res;
    const okPkg = (c) => master.packages.some((p) => p.code === c), okMnl = (c) => master.mnl.some((x) => x.code === c);
    for (const [ck, v] of prevCoding) {
      const [svc, text] = ck.split('\u0001'); const k = mkey(project, svc, text);
      const want = { package: v.csi || '', mnl: v.mnl || '', cec: v.cec || '' };
      if (want.package && !okPkg(want.package)) { res.unknown++; res.unknownCodes.add(want.package); want.package = ''; }
      if (want.mnl && !okMnl(want.mnl)) { res.unknown++; res.unknownCodes.add(want.mnl); want.mnl = ''; }
      if (!(want.package || want.mnl || want.cec)) continue;
      const cur = master.mapping.get(k); const e = Object.assign({ package: '', mnl: '', cec: '', unit: '' }, cur || {});
      const newer = cur && cur.updated instanceof Date && savedAt && cur.updated > savedAt;
      let touched = false;
      for (const d of ['package', 'mnl', 'cec']) { if (!want[d] || want[d] === e[d]) continue;
        if (!e[d]) { e[d] = want[d]; res.added++; touched = true; }
        else if (newer) res.keptNewer++;
        else { e[d] = want[d]; res.changed++; touched = true; } }
      if (want.cec) { if (!master.costElements.has(project)) master.costElements.set(project, new Map());
        if (!master.costElements.get(project).has(want.cec)) master.costElements.get(project).set(want.cec, ''); }
      if (touched) { e.updated = savedAt || new Date(); master.mapping.set(k, e); }
    }
    return res;
  }
  // value: code, or '' to remove; keys: [codingKey]; returns number of rows changed
  function assign(master, project, keys, dim, value) {
    let n = 0; const now = new Date();
    for (const ck of keys) { const [svc, text] = ck.split('\u0001'); const k = mkey(project, svc, text);
      const e = Object.assign({ package: '', mnl: '', cec: '', unit: '' }, master.mapping.get(k) || {});
      if ((e[dim] || '') === (value || '')) continue; e[dim] = value || ''; e.updated = now; n++;
      if (e.package || e.mnl || e.cec || e.unit) master.mapping.set(k, e); else master.mapping.delete(k); }
    return n;
  }
  async function buildMaster(master, libs) {
    const wb = new libs.ExcelJS.Workbook(); wb.creator = 'Subcontract report';
    const head = (ws, cols, widths, edit) => { ws.addRow(cols); ws.getRow(1).eachCell((c, j) => { const y = edit.includes(j); c.font = y ? st.HB : st.H; c.fill = y ? FILL.YF : FILL.HF;
      c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }; }); widths.forEach((w, j) => { ws.getColumn(j + 1).width = w; }); ws.views = [{ state: 'frozen', ySplit: 1 }]; };
    const pk = wb.addWorksheet('Packages'); head(pk, ['Code', 'Label', 'Group', 'Icon', 'Color', 'Sort', 'System', 'Catalogue v' + (master.version || CATALOGUE_VERSION)], [12, 32, 12, 7, 10, 7, 8, 13], [2, 3, 4, 5, 6]);
    for (const p of master.packages) pk.addRow([p.code, p.label, p.group, p.icon, '#' + p.color, p.sort, p.system ? 'yes' : '']);
    const mn = wb.addWorksheet('MNL'); head(mn, ['Code', 'Label', 'System'], [10, 24, 8], [2]);
    for (const x of master.mnl) mn.addRow([x.code, x.label, x.system ? 'yes' : '']);
    const ce = wb.addWorksheet('Cost Elements'); head(ce, ['Project', 'Code', 'Label'], [12, 16, 40], [2, 3]);
    for (const [pr, m] of [...master.costElements].sort()) for (const [code, label] of [...m].sort()) ce.addRow([pr, code, label || null]);
    const sm = wb.addWorksheet('Service Mapping'); head(sm, ['Project', 'Service', 'Service text', 'Package', 'MNL', 'Cost Element', 'Unit override', 'Updated'], [10, 12, 50, 11, 8, 16, 10, 12], [4, 5, 6, 7]);
    const rows = [...master.mapping].map(([k, v]) => { const [pr, svc, text] = k.split('\u0001'); return [pr, svc, text, v.package || null, v.mnl || null, v.cec || null, v.unit || null, v.updated || null]; })
      .sort((a, b) => cmpTuple(a.slice(0, 3), b.slice(0, 3)));
    for (const r of rows) sm.addRow(r); sm.getColumn(8).numFmt = 'yyyy-mm-dd'; for (const j of [2, 4, 5, 6]) sm.getColumn(j).numFmt = '@';
    sm.getRow(1).eachCell((c) => { c.numFmt = 'General'; });
    const rm = wb.addWorksheet('Read me');
    ['Work package master', '',
      'Codes every subcontract service (SAP service code + service text) on three dimensions, per project: Package (CSI division), MNL (MAT / SUB / EQU) and Cost Element.',
      'Packages and MNL are shared catalogues: add rows to extend them; system rows can be relabelled but should not be deleted.',
      'Cost Elements are per project: each project keeps its own list (the report tool adds them when you create one on the coding page).',
      'Service Mapping holds one row per project + service + text. Blank means not coded. Keys match exactly – no patterns.',
      'Keep one copy on the shared drive. After coding in the tool, save the downloaded master over it.']
      .forEach((t, i) => { rm.getCell(i + 1, 1).value = t || null; rm.getCell(i + 1, 1).font = i === 0 ? st.T1 : st.F; });
    rm.getColumn(1).width = 130;
    return wb.xlsx.writeBuffer();
  }

  const api = { analyse, summarize, readPrevious, buildWorkbook, detectKind, codingKey, tradeName, TRADES, mlabel, VATR,
    readCodingMaster, mergeCodingMaster, buildCodingMaster, MASTER_SHEET,
    PACKAGES, MNLS, DIMS, GROUP_COLOR, defaultMaster, readMaster, buildMaster, codingFor, suggest, assign, mkey, adoptPrevious, setBase, listsOf, listStamp };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.SubcontractEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
