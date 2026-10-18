// @ts-nocheck
/**
 * The v2.6 Subcontract Cost Report workbook (live cut date in Summary!B4, SUMIFS on the Data sheet,
 * Coding / Lists drop-downs, Invoices Register, Checks, Changes ...).
 *
 * This file is a PORT of the standalone tool's engine model and Excel writer
 * ("Subcontract_Cost_Report_v2.6.html": SCEngine + SCWriter), kept close to the original on purpose,
 * the same way subcontractWorkbook.ts was. Do not rewrite its formulas.
 *
 * What differs from the tool, and only this:
 *   - The tool parsed ZSCPRG01 / ZSCSRV1 and classified every line itself. Here the classification
 *     (line type, report qty, rate used, Pending reason, bucket, type of works) is read from
 *     v_service_line by subcontractReport.ts and handed in, so the page and the workbook cannot disagree.
 *     buildModel() starts where the tool's build() starts pivoting.
 *   - Coding comes from the app (service_work_package, cost type MNL; PKG and Cost element are left blank for the user), not from a
 *     coding file; there is no automatic DIV fill, no "New" rows and no suggestions.
 *   - Checks and Changes are the app's SC_CHECKS / SC_CHANGES, supplied by the adapter.
 *   - Wording that told the user to drop the workbook back into the tool is changed to say the app.
 */
// ---------------------------------------------------------------- engine helpers (ported)
const VERSION = '2.6';
  const str = (v) => (v == null ? '' : String(v).trim());
  const num = (v) => {
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    const s = str(v).replace(/,/g, '');
    return s !== '' && isFinite(+s) ? +s : 0;
  };
  const r2 = (x) => Math.round(x * 100) / 100;
  const r3 = (x) => Math.round(x * 1000) / 1000;
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const mLabel = (k) => MON[(k % 100) - 1] + '-' + String(Math.floor(k / 100)).slice(2);   // 202608 -> Aug-26
  const mKey = (k) => Math.floor(k / 100) + '-' + String(k % 100).padStart(2, '0');           // 202608 -> 2026-08
  const keyToM = (s) => +s.replace('-', '');
  const nextM = (k) => (k % 100 === 12 ? k + 89 : k + 1);
  const prevM = (k) => (k % 100 === 1 ? k - 89 : k - 1);
  const lastDay = (k) => new Date(Date.UTC(Math.floor(k / 100), k % 100, 0));                 // day 0 of next month
  const ymOf = (d) => d.getUTCFullYear() * 100 + d.getUTCMonth() + 1;
  const fmtDate = (d) => d ? `${String(d.getUTCDate()).padStart(2, '0')}-${MON[d.getUTCMonth()]}-${d.getUTCFullYear()}` : '';
  function tally(map, key, val, w = undefined) { if (!key) return; let t = map.get(key); if (!t) map.set(key, t = new Map()); t.set(val, (t.get(val) || 0) + (w == null ? 1 : w)); }
  function top(t) { if (!t) return ''; let best = '', bw = -Infinity; for (const [k, w] of t) if (w > bw && k !== '') { best = k; bw = w; } return best; }
const RES = { S: 'Subcontract', L: 'Labour', P: 'Plant' };
const NO_TOW = '(no type of works)', NOT_CODED = '(not coded)';
const resOf = (svc) => { const c = svc.charAt(0).toUpperCase(); return RES[c] ? c : 'Other'; };
  const FIELDS = ['div', 'pkg', 'mnl', 'ce'];
  const FIELD_NAME = { div: 'DIV', pkg: 'PKG', mnl: 'MNL', ce: 'Cost element' };
  function normText(t) {
    return str(t).replace(/[ً-ْـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
      .replace(/\s*([-+*/()])\s*/g, '$1').replace(/\s+/g, ' ').trim().toLowerCase();
  }
  const ckey = (svc, text) => str(svc) + '\u0001' + normText(text);
  // codes are what the user types (spaces tidied); "conc" and "Conc" are one code – the spelling already on the list wins
  const normCode = (c) => str(c).replace(/\s+/g, ' ');
  const normDiv = (c) => { const t = normCode(c), m = /^DIV\s*(\d{1,4})$/i.exec(t); return m ? 'DIV ' + m[1].padStart(m[1].length > 2 ? 4 : 2, '0') : t; };
  const normField = (f, v) => (f === 'div' ? normDiv(v) : normCode(v));
  const sameCode = (a, b) => String(a).toUpperCase() === String(b).toUpperCase();
  function canon(list, code) {                         // the list's spelling of a code; a new code joins the list (the list = every code in use)
    if (!code) return ''; const x = list.find((y) => sameCode(y[0], code)); if (x) return x[0]; list.push([code, '']); return code;
  }
  const codeOf = (cst, key) => cst.codes.get(key) || {};
  const normTow = (t) => str(t).replace(/\s+/g, ' ').replace(/\s*-\s*/, '-');     // "مقاولين - إيجار" and "مقاولين-إيجار" are one type
  // ---- pivot: per group, qty, amount and certificates per bucket, then Previous / This month / To date / Pending
  // (a certificate = PO + invoice serial: one date, one approval, one subcontractor – so it sits in one bucket)
  const certOf = (l) => l.po + '|' + l.serial;
  function pivotLines(lines, curKey, keyFn, makeFn) {
    const m = new Map();
    for (const l of lines) {
      const k = keyFn(l); let g = m.get(k);
      if (!g) { g = makeFn(l); g.b = new Map(); g.n = 0; m.set(k, g); }
      let c = g.b.get(l.bucket); if (!c) g.b.set(l.bucket, (c = { q: 0, a: 0, cs: new Set() })); c.q += l.rq; c.a += l.amt; c.cs.add(certOf(l)); g.n++;
      if (g.tally) g.tally(l);
    }
    const out = [...m.values()];
    for (const g of out) {
      const pick = (f) => { let q = 0, a = 0, n = 0; for (const [b, c] of g.b) if (f(b)) { q += c.q; a += c.a; n += c.cs.size; } return { q: r3(q), a: r2(a), n }; };
      g.prev = pick((b) => b === 'Opening' || (b !== 'Pending' && b < curKey));
      g.cur = pick((b) => b === curKey);
      g.td = { q: r3(g.prev.q + g.cur.q), a: r2(g.prev.a + g.cur.a), n: g.prev.n + g.cur.n };
      g.pend = pick((b) => b === 'Pending');
      g.at = (b) => { const c = g.b.get(b); return c ? { q: r3(c.q), a: r2(c.a), n: c.cs.size } : { q: 0, a: 0, n: 0 }; };
      // the first bucket with cost (Opening before the months; Pending never counts)
      g.firstB = [...g.b.keys()].filter((b) => b !== 'Pending' && Math.abs(g.b.get(b).a) > 0.005).sort((x, y) => (x === 'Opening' ? -1 : y === 'Opening' ? 1 : x < y ? -1 : x > y ? 1 : 0))[0] || null;
      delete g.tally;
    }
    return out;
  }
  const weigh = () => { const t = new Map(); return { t, add: (k, w) => t.set(k, (t.get(k) || 0) + Math.abs(w)) }; };
  const split = (t) => { const e = [...t].filter(([k]) => k).sort((a, b) => b[1] - a[1]), all = e.reduce((s, [, w]) => s + w, 0) || 1; return e.map(([k, w]) => [k, w / all]); };
  function applyCoding(M) {
    const cst = M.cstate, L = cst.lists, nm = {}, ord = {};
    for (const f of FIELDS) { nm[f] = new Map(L[f]); ord[f] = new Map(L[f].map((x, i) => [x[0], i])); }
    for (const l of M.lines) { const c = codeOf(cst, l.ckey); for (const f of FIELDS) l[f] = c[f] || ''; }
    const pv = (keyFn, makeFn) => pivotLines(M.lines, M.curKey, keyFn, makeFn);
    const byOrder = (f) => (a, b) => (a.code ? 0 : 1) - (b.code ? 0 : 1) || (ord[f].has(a.code) ? ord[f].get(a.code) : 1e6) - (ord[f].has(b.code) ? ord[f].get(b.code) : 1e6) || b.td.a - a.td.a;
    M.items = pv((l) => l.ckey, (l) => { const r = M.cIndex.get(l.ckey);
      return { key: r.key, svc: r.svc, desc: r.desc, group: r.group, res: r.res, resName: r.resName, unit: r.unit, tow: r.towMain, towSplit: r.towSplit, div: l.div, pkg: l.pkg, mnl: l.mnl, ce: l.ce,
        startKey: r.startKey, firstM: r.firstM, poCount: r.poCount }; });
    // one order everywhere: type of works (user order) → service (largest within the type) → description (largest)
    const tIdx = new Map(cst.towOrder.map((t, i) => [t, i])), ti = (t) => (t && tIdx.has(t) ? tIdx.get(t) : 1e6);
    M.towIndex = ti;
    const svcW = new Map(); for (const r of M.crows) { const k = r.towMain + '' + r.svc; svcW.set(k, (svcW.get(k) || 0) + r.w); }
    const sw = (r) => svcW.get(r.towMain + '' + r.svc) || 0;
    M.crows.sort((a, b) => (a.inData ? 0 : 1) - (b.inData ? 0 : 1) || ti(a.towMain) - ti(b.towMain) || sw(b) - sw(a) || (a.svc < b.svc ? -1 : a.svc > b.svc ? 1 : 0) || b.w - a.w);
    const pos = new Map(M.crows.map((r, i) => [r.key, i]));
    M.items.sort((a, b) => pos.get(a.key) - pos.get(b.key));
    M.tows.sort((a, b) => ti(a.code) - ti(b.code) || b.td.a - a.td.a);
    M.suppliers.sort((a, b) => ti(a.tow) - ti(b.tow) || b.td.a - a.td.a || b.pend.a - a.pend.a);
    M.pos.sort((a, b) => ti(a.tow) - ti(b.tow) || b.td.a - a.td.a || b.pend.a - a.pend.a);
    M.groups = {};
    for (const f of FIELDS) { const g = pv((l) => l[f], (l) => ({ code: l[f], name: l[f] ? nm[f].get(l[f]) || '' : NOT_CODED })); g.sort(byOrder(f)); M.groups[f] = g; }
    M.groups.tow = M.tows;

    // progress: share of rows and of amount that carry each code
    const rows = M.crows.filter((r) => r.inData), W = rows.reduce((s, r) => s + r.w, 0) || 1;
    const has = (r, f) => !!codeOf(cst, r.key)[f];
    M.progress = FIELDS.map((f) => { const d = rows.filter((r) => has(r, f)); return { f, name: FIELD_NAME[f], rows: rows.length, done: d.length, pct: d.reduce((s, r) => s + r.w, 0) / W }; });
    const full = rows.filter((r) => FIELDS.every((f) => has(r, f)));
    M.progressAll = { rows: rows.length, done: full.length, pct: full.reduce((s, r) => s + r.w, 0) / W };

    // coding checks
    const cc = []; const add = (status, title, detail, count, amount, list, cols) => cc.push({ status, title, detail, count, amount, rows: list || null, cols: cols || null });
    const open = rows.filter((r) => !FIELDS.every((f) => has(r, f))).sort((a, b) => b.w - a.w);
    add(open.length ? 'warn' : 'ok', 'Coding complete', open.length ? M.progress.filter((p) => p.done < p.rows).map((p) => `${p.name} missing on ${p.rows - p.done} services (${Math.round((1 - p.pct) * 1000) / 10}% of the amount)`).join(' · ') + '. Uncoded amounts are reported as "(not coded)" – the totals still tie. Code them on the Work packages page of the app (DIV).' : `All ${rows.length} Service + Description rows have DIV, PKG, MNL and Cost element.`,
      open.length, r2(open.reduce((s, r) => s + r.td.a, 0)));     // no list: the Coding sheet and tab show what is missing
    M.codingChecks = cc;
    return M;
  }
  // ================================================================ RATES (Service Summary rate analysis – the workbook uses the same rules)
  // A rate change is only read when both rates are positive and within 3× of each other: a bigger jump is a placeholder price
  // (e.g. qty = amount at rate 1) or another unit, not a price change – it shows "check" and stays out of the totals.
  const rateOf = (o) => (o && Math.abs(o.q) > 1e-6 ? o.a / o.q : null);
  function rateChange(from, to) {                                   // → { d, pct } · 'check' · null (a rate is missing)
    if (from == null || to == null) return null;
    if (!(from > 0 && to > 0 && to / from <= 3 && to / from >= 1 / 3)) return 'check';
    const d = Math.abs(to - from) < 0.005 ? 0 : to - from; return { d, pct: d / from };
  }
  // the start rate: the row's rate in its first period with quantity (Opening or a month) – none while the cut date is before it
  function startOf(x, reportMonth) {
    if (x.startKey == null || x.startKey > reportMonth) return null;
    return { key: x.startKey, label: x.startKey === 0 ? 'Opening' : mLabel(x.startKey), rate: rateOf(x.at(x.startKey === 0 ? 'Opening' : mKey(x.startKey))) };
  }
  // this month against the previous rate (to last month) · to date against the start rate; Value = qty × the change
  function rates(x, reportMonth) {
    const pr = rateOf(x.prev), cr = rateOf(x.cur), tr = rateOf(x.td), st = startOf(x, reportMonth), sr = st ? st.rate : null;
    const mv = rateChange(pr, cr), sv = rateChange(sr, tr);
    // value = qty × the change (= amount − qty at the earlier rate); a change under half a piastre per unit is no change: value 0
    return { pr, cr, tr, st, sr, mv, sv, mValue: mv && mv !== 'check' ? r2(x.cur.q * mv.d) : null, sValue: sv && sv !== 'check' ? r2(x.td.q * sv.d) : null };
  }
  // colour per type of works (by its place in the order): golden-angle hues, so neighbours always differ
  const towHue = (i) => Math.round((i * 137.508 + 205) % 360);
  function hslHex(h, sat, lig) { sat /= 100; lig /= 100; const k = (n) => (n + h / 30) % 12, a = sat * Math.min(lig, 1 - lig);
    const f = (n) => lig - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))); return [f(0), f(8), f(4)].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('').toUpperCase(); }

// ================================================================ MODEL (the tool's build(), from 'months shown' on)
// input: { plant, pc, files, cutDate (Date, UTC midnight), reportMonth (yyyymm), currency, rollYears,
//          lines: [engine-shaped, already classified], prog: { footer, rawRows, summaryRows, rawSum, dupRows, dupAmt, dupLines },
//          serv: { unit, group, poType, poTitle, poQty, plant, lines } | null, unitOf(svc, text), cstate, vat, checks, changes }
function buildModel(input) {
  const { prog, serv } = input;
  const cst = input.cstate;
  const reportMonth = input.reportMonth, curKey = mKey(reportMonth), cutDate = input.cutDate;
  const plant = input.plant;
  const vat = input.vat || {};
  const svcInfo = new Map();
  const infoOf = (svc, text) => {
    const k = svc + '\u0001' + text; let s = svcInfo.get(k); if (s) return s;
    const res = resOf(svc), unit = input.unitOf ? input.unitOf(svc, text) || '' : '';
    s = { svc, res, resName: RES[res] || 'Other', group: serv ? serv.group.get(svc) || '' : '', unit, unitSrc: unit ? 'app' : '' };
    svcInfo.set(k, s); return s;
  };
  const coll = new Intl.Collator('en', { numeric: true }), dn = (d) => (d ? +d : 9e15);
  const all = input.lines;
  all.sort((a, b) => dn(a.date) - dn(b.date) || coll.compare(a.po, b.po) || coll.compare(a.serial, b.serial) || coll.compare(a.item, b.item) || coll.compare(a.pkg, b.pkg) || coll.compare(a.line, b.line) || coll.compare(a.lid, b.lid));
  for (const l of all) { l.info = infoOf(l.svc, l.text); l.ckey = ckey(l.svc, l.text); }
  const lines = all.filter((l) => l.amt !== 0);
  const zeroLines = all.length - lines.length;
  const qtyOnly = all.filter((l) => l.ltype === 'Qty only').length;
  const notes = [];

    // months shown: first month with an amount up to the report month, no gaps
    let first = reportMonth;
    for (const l of lines) if (l.bucket !== 'Pending' && l.bucket !== 'Opening' && l.month < first) first = l.month;
    const months = []; for (let m = first; m <= reportMonth; m = nextM(m)) months.push(m);
    const hasOpening = lines.some((l) => l.bucket === 'Opening');
    const pv = (keyFn, makeFn) => pivotLines(lines, curKey, keyFn, makeFn);

    // ---- coding rows: one per Service + Description, with reference data only (the codes live in the coding state)
    const crows = pv((l) => l.ckey, (l) => {
      const texts = weigh(), tows = weigh(), subs = weigh(), pos = new Set();
      return Object.assign({ key: l.ckey, inData: true, w: 0, firstM: null, lastM: null, _t: texts, _w: tows, _s: subs, _p: pos,
        tally: (x) => { texts.add(x.text, x.amt); tows.add(x.tow, x.amt); subs.add(x.supName, x.amt); pos.add(x.po); } }, l.info);
    });
    const cIndex = new Map(crows.map((r) => [r.key, r]));            // weight (|amount|) and first / last month per row
    for (const l of lines) { const r = cIndex.get(l.ckey); r.w += Math.abs(l.amt); if (l.ltype === 'Normal' && l.bucket !== 'Pending') { r.rMin = r.rMin == null ? l.net : Math.min(r.rMin, l.net); r.rMax = r.rMax == null ? l.net : Math.max(r.rMax, l.net); }
      if (l.month && l.bucket !== 'Pending') { if (!r.firstM || l.month < r.firstM) r.firstM = l.month; if (!r.lastM || l.month > r.lastM) r.lastM = l.month; }
      // start period (for the start rate): the first period with quantity among ALL approved, dated lines – whatever the cut date,
      // so the live workbook can use it at any cut (Opening 0 · month yyyymm)
      if (l.approved && l.month && Math.abs(l.rq) > 1e-9) { const k = l.opening ? 0 : l.month; if (r.startKey == null || k < r.startKey) r.startKey = k; } }
    for (const r of crows) {
      r.desc = top(r._t.t); const t = split(r._w.t), s = split(r._s.t);
      r.towCount = t.length; r.towMain = t.length ? t[0][0] : ''; r.towList = t.map(([k]) => k); r.towSplit = t.map(([k, p]) => (t.length > 1 ? `${k} ${p < 0.01 ? '<1' : Math.round(p * 100)}%` : k)).join(' · ');
      r.subCount = s.length; r.subs = s.slice(0, 2).map(([k]) => k).join(' · ') + (s.length > 2 ? ` +${s.length - 2}` : '');
      r.isNew = cst.hasFile && cst.format === 'item' && !cst.fileKeys.has(r.key);
      r.poCount = r._p.size; delete r._t; delete r._w; delete r._s; delete r._p;
    }
    for (const [k, c] of cst.codes) if (!cIndex.has(k)) {            // rows kept from the coding file that are not in this data
      const r = Object.assign({ key: k, inData: false, w: 0, desc: c.desc, towSplit: '', towMain: '', towList: [], towCount: 0, subs: '', subCount: 0, isNew: false,
        prev: { q: 0, a: 0, n: 0 }, cur: { q: 0, a: 0, n: 0 }, td: { q: 0, a: 0, n: 0 }, pend: { q: 0, a: 0, n: 0 }, at: () => ({ q: 0, a: 0, n: 0 }) }, infoOf(c.svc, c.desc));
      crows.push(r); cIndex.set(k, r);
    }
    // type-of-works order: the saved order first; types new to it are added largest first
    const towAmt = new Map(); for (const l of lines) if (l.tow) towAmt.set(l.tow, (towAmt.get(l.tow) || 0) + Math.abs(l.amt));
    cst.towOrder.push(...[...towAmt.keys()].filter((t) => !cst.towOrder.includes(t)).sort((a, b) => towAmt.get(b) - towAmt.get(a)));
    let nid = 0; for (const r of crows) r.id = ++nid;

    // ---- reference pivots (no coding needed)
    const services = pv((l) => l.svc, (l) => { const t = weigh(); return Object.assign({ tally: (x) => t.add(x.text, x.amt), _t: t }, l.info); });
    for (const s of services) { s.desc = top(s._t.t); delete s._t; }
    const tows = pv((l) => l.tow, (l) => ({ code: l.tow, name: l.tow || NO_TOW }));
    tows.sort((a, b) => (a.code ? 0 : 1) - (b.code ? 0 : 1) || b.td.a - a.td.a || b.pend.a - a.pend.a);
    const suppliers = pv((l) => l.supCode, (l) => {
      const names = new Map(), tw = new Map(), pos = new Set();
      return { code: l.supCode, names, tw, pos, tally: (x) => { names.set(x.supName, (names.get(x.supName) || 0) + 1); tw.set(x.tow, (tw.get(x.tow) || 0) + Math.abs(x.amt)); pos.add(x.po); } };
    });
    for (const s of suppliers) { s.name = top(s.names); s.tow = top(s.tw); s.poCount = s.pos.size; delete s.names; delete s.tw; delete s.pos; }
    suppliers.sort((a, b) => b.td.a - a.td.a || b.pend.a - a.pend.a);
    // ---- PO register: every PO with its Service + Description rows (from the certificate lines). PO qty from ZSCSRV1 where the PO line is limited.
    const certs = (o) => Object.assign(o, { _ser: new Set(), last: null, tally(x) { this._ser.add(x.serial); if (x.date && (!this.last || x.date > this.last)) this.last = x.date; } });
    const pos = pv((l) => l.po, (l) => certs({ po: l.po, tow: l.tow, supCode: l.supCode, supName: l.supName, title: serv ? serv.poTitle.get(l.po) || '' : '', items: [] }));
    const poRows = pv((l) => l.po + '' + l.ckey, (l) => certs({ po: l.po, key: l.ckey }));
    const poIdx = new Map(pos.map((x) => [x.po, x]));
    for (const x of pos.concat(poRows)) { x.certs = x._ser.size; delete x._ser; }
    for (const x of poRows) {
      const r = cIndex.get(x.key), q = serv ? serv.poQty.get(x.po + '' + x.key) : null;
      Object.assign(x, { svc: r.svc, desc: r.desc, unit: r.unit, poQty: q ? (q.unl ? 'Unlimited' : r3(q.q)) : null });
      poIdx.get(x.po).items.push(x);
    }
    for (const x of pos) x.items.sort((a, b) => b.td.a - a.td.a || b.pend.a - a.pend.a);

    // ---- month table: one row per bucket shown (Opening, months), amount by resource type
    const buckets = (hasOpening ? ['Opening'] : []).concat(months.map(mKey));
    const monthRows = []; let cum = 0;
    for (const b of buckets) {
      const ls = lines.filter((l) => l.bucket === b);
      const row = { bucket: b, label: b === 'Opening' ? 'Opening' : mLabel(keyToM(b)), S: 0, L: 0, P: 0, Other: 0, total: 0, certs: new Set(ls.map(certOf)).size };
      for (const l of ls) { row[l.info.res] += l.amt; row.total += l.amt; }
      const bySup = new Map(); for (const l of ls) bySup.set(l.supCode, (bySup.get(l.supCode) || 0) + l.amt);
      row.suppliers = [...bySup.values()].filter((v) => Math.abs(v) > 0.005).length;
      cum += row.total; row.cum = cum;
      for (const k of ['S', 'L', 'P', 'Other', 'total', 'cum']) row[k] = r2(row[k]);
      monthRows.push(row);
    }

    // ---- totals
    const S = (f) => r2(lines.filter(f).reduce((s, l) => s + l.amt, 0));
    const T = {
      footer: prog.footer, rawSum: r2(prog.rawSum), dupAmt: r2(prog.dupAmt), certified: S(() => true),
      opening: S((l) => l.bucket === 'Opening'), prev: S((l) => l.bucket === 'Opening' || (l.bucket !== 'Pending' && l.bucket < curKey)),
      cur: S((l) => l.bucket === curKey), pendNA: S((l) => l.pend === 'Not approved'), pendAfter: S((l) => l.pend === 'After cut date'),
      pendNoDate: S((l) => l.pend === 'No date'), adjCur: S((l) => l.ltype === 'Adjustment' && l.bucket === curKey),
      adjTd: S((l) => l.ltype === 'Adjustment' && l.bucket !== 'Pending'),
    };
    T.td = r2(T.prev + T.cur); T.pending = r2(T.pendNA + T.pendAfter + T.pendNoDate);
    const prevMonthRow = monthRows.find((r) => r.bucket === mKey(prevM(reportMonth))), curRow = monthRows.find((r) => r.bucket === curKey) || {};
    const K = { activeSup: curRow.suppliers || 0, certs: curRow.certs || 0, lines: lines.length,
      services: services.length, rows: crows.filter((r) => r.inData).length, suppliers: suppliers.length, lastMonth: prevMonthRow ? prevMonthRow.total : null,
      lastSup: prevMonthRow ? prevMonthRow.suppliers : null, lastCerts: prevMonthRow ? prevMonthRow.certs : null };

  const olderYears = lines.some((l) => l.approved && l.month && !l.opening && l.month < Math.floor(reportMonth / 100) * 100 + 1);
  const M = {
    version: VERSION, plant, pc: input.pc, currency: input.currency || 'EGP', reportMonth, curKey, label: mLabel(reportMonth), cutDate, generated: new Date(), files: input.files || {},
    olderYears, rollYears: input.rollYears == null ? true : !!input.rollYears,
    months, buckets, hasOpening, lines, services, crows, cIndex, suppliers, pos, tows, monthRows, T, K, checks: input.checks || [], changes: input.changes || null, notes, cstate: cst, fromReport: false,
    vat, counts: { rawRows: prog.rawRows, summaryRows: prog.summaryRows, dupRows: prog.dupRows, dupLines: prog.dupLines, zeroLines, qtyOnly, servLines: serv ? serv.lines : 0 },
  };
  return applyCoding(M);
}

const E = { FIELDS, FIELD_NAME, NOT_CODED, towHue, hslHex, applyCoding, codeOf, certOf, rates,
  util: { mLabel, mKey, keyToM, fmtDate, r2, r3, prevM, nextM, str, num } };

// ================================================================ EXCEL WRITER (the tool's SCWriter)
function makeWriter(E) {
  const { mLabel, mKey, keyToM, fmtDate, r2, r3 } = E.util;
  const C = { navy: '1F3864', blue: '2F5597', gold: 'BF8F00', light: 'DDEBF7', cur: 'FFF2CC', pend: 'EDEDED', grid: 'BFBFBF', edit: 'FFFFCC', ok: 'E2EFDA', warn: 'FCE4D6', info: 'DEEAF6', muted: '595959', off: 'A6A6A6' };
  const TAB = { report: '1F3864', sub: '1A7F77', coding: 'BF8F00', review: 'C55A11', data: '7F7F7F' };
  const SUBT = { head: '115E59', band: '2C8C84', light: 'DCEFEC' };     // the subcontractor sheets (teal): headers, bands, TOTAL row
  const F = { amt: '#,##0;[Red]-#,##0;"-"', qty: '#,##0.00;[Red]-#,##0.00;"-"', rate: '#,##0.00;[Red]-#,##0.00;""', pct: '0.0%;[Red]-0.0%;"-"', date: 'dd-mmm-yyyy', int: '#,##0;-#,##0;"-"',
    chg: '+#,##0.00;[Red]-#,##0.00;"-"', chgPct: '+0.0%;[Red]-0.0%;"-"', chgAmt: '+#,##0;[Red]-#,##0;"-"' };     // changes: + up, red − down, "-" none
  const font = (o) => Object.assign({ name: 'Arial', size: 10 }, o || {});
  const FONT = font(), FONT_B = font({ bold: true }), FONT_PEND = font({ italic: true, color: { argb: 'FF' + C.muted } }), FONT_KEY = font({ size: 9, color: { argb: 'FF' + C.muted } });
  const fill = (c) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + c } });
  const cfFill = (c) => ({ type: 'pattern', pattern: 'solid', bgColor: { argb: 'FF' + c } });
  const thin = { style: 'thin', color: { argb: 'FF' + C.grid } };
  const box = { top: thin, left: thin, bottom: thin, right: thin };
  const col = (n) => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
  const nz = (x) => (x ? x : null);                   // write blanks instead of zeros in report tables
  const rate = (o) => (Math.abs(o.q) > 1e-9 ? r2(o.a / o.q) : null);
  const q = (s) => String(s).replace(/"/g, '""');     // text inside a formula
  const PEND = 999999;                                // period key: Opening 0 · a month yyyymm · Pending 999999
  const nextM = (k) => (k % 100 === 12 ? k + 89 : k + 1);
  const keyOf = (b) => (b === 'Opening' ? 0 : b === 'Pending' ? PEND : keyToM(b));

  function title(ws, t, sub, color) {
    ws.getCell('A1').value = t; ws.getCell('A1').font = font({ size: 14, bold: true, color: { argb: 'FF' + (color || C.navy) } });
    if (sub) { ws.getCell('A2').value = sub; ws.getCell('A2').font = font({ size: 9, color: { argb: 'FF' + C.muted } }); }
    ws.getRow(1).height = 22;
  }
  function headCell(c, text, bg) { c.value = text; c.font = font({ bold: true, color: { argb: 'FFFFFFFF' } }); c.fill = fill(bg || C.navy); c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }; c.border = box; }

  // Rows grouped under one header row per type of works (and, on the PO Register, per PO): entries { hdr, lvl, d }.
  // A header row carries the type's subtotals (SUBTOTAL, which Excel skips inside other SUBTOTALs, so totals never double).
  function byType(rows, towOf, sub) {
    const out = []; let cur = null;
    for (const r of rows) {
      const t = towOf(r) || '';
      if (!cur || cur.d.tow !== t) { cur = { hdr: true, lvl: 0, d: { tow: t, n: 0, kids: 0 } }; out.push(cur); }
      cur.d.n++;
      if (sub) { out.push({ hdr: true, lvl: 1, d: r }); cur.d.kids++; for (const k of sub(r)) out.push({ lvl: 2, d: k }); }
      else out.push({ lvl: 1, d: r });
    }
    return out;
  }

  // A report table: optional group-header row, header row, a TOTAL row above the headers that follows the filter, then data.
  // cols: [{ h, hF (formula header), w, v(row, excelRow), hv(headerData, level, excelRow), fmt, group, groupF, sum, hl, b, fill(row) → hex, hide }]
  function table(ws, cols, entries, o) {
    const top = o.top || 3, hasGroups = cols.some((c) => c.group), TH = Object.assign({ head: C.navy, band: C.blue, light: C.light }, o.theme || {});
    const totalRow = top, groupRow = top + 1, headRow = hasGroups ? top + 2 : top + 1, first = headRow + 1, last = first + entries.length - 1;
    cols.forEach((c, i) => { ws.getColumn(i + 1).width = c.w || 12; if (c.hide) ws.getColumn(i + 1).hidden = true; });
    if (hasGroups) {
      let i = 0;
      while (i < cols.length) {
        let j = i; while (j + 1 < cols.length && cols[j + 1].group === cols[i].group) j++;
        const cell = ws.getCell(groupRow, i + 1);
        if (cols[i].group) { if (j > i) ws.mergeCells(groupRow, i + 1, groupRow, j + 1); headCell(cell, cols[i].group, cols[i].gbg || (cols[i].hl === 'cur' ? C.gold : cols[i].hl === 'pend' ? '7F7F7F' : cols[i].hl === 'code' ? C.gold : TH.band));
          if (cols[i].groupF) cell.value = cols[i].groupF; }
        i = j + 1;
      }
      ws.getRow(groupRow).height = 30;                  // room for two lines: the band titles always show in full
    }
    cols.forEach((c, i) => { const cell = ws.getCell(headRow, i + 1); headCell(cell, c.h, c.hl === 'cur' || c.hl === 'code' ? C.gold : c.hl === 'pend' ? '7F7F7F' : TH.head); if (c.hF) cell.value = c.hF; if (c.note) cell.note = c.note; });
    ws.getRow(headRow).height = 30;
    const BL = { style: 'medium', color: { argb: 'FF' + TH.head } }, edge = (cell, c) => { if (c.bl) cell.border = Object.assign({}, cell.border || {}, { left: BL }); };
    let colLvl = 0; cols.forEach((c, i) => { if (c.olvl) { ws.getColumn(i + 1).outlineLevel = c.olvl; colLvl = Math.max(colLvl, c.olvl); } });
    cols.forEach((c, i) => { if (c.bl) { edge(ws.getCell(headRow, i + 1), c); if (hasGroups) edge(ws.getCell(groupRow, i + 1), c); } });
    // each header row covers the rows below it that sit one level deeper or more
    const end = entries.map(() => 0), open = [];
    entries.forEach((e, i) => { while (open.length && entries[open[open.length - 1]].lvl >= e.lvl) end[open.pop()] = i - 1; if (e.hdr) open.push(i); });
    while (open.length) end[open.pop()] = entries.length - 1;
    const val = (c, e) => (e.hdr ? 0 : +c.v(e.d, 0) || 0);
    let maxLvl = 0;
    entries.forEach((e, k) => {
      const n = first + k, row = ws.getRow(n);
      if (e.lvl) { row.outlineLevel = e.lvl; maxLvl = Math.max(maxLvl, e.lvl); }
      if (e.hdr) {
        const style = o.hdrStyle(e), f1 = first + k + 1, f2 = first + end[k];
        cols.forEach((c, i) => {
          const cell = row.getCell(i + 1);
          if (c.sum && end[k] > k) { const L = col(i + 1); let res = 0; for (let j = k + 1; j <= end[k]; j++) res += val(c, entries[j]); cell.value = { formula: `SUBTOTAL(9,${L}${f1}:${L}${f2})`, result: r2(res) }; }
          else { const v = c.hv ? c.hv(e.d, e.lvl, n) : null; cell.value = v == null || v === '' ? null : v; }
          if (c.fmt) cell.numFmt = c.fmt;
          cell.font = font({ bold: true }); cell.fill = fill(style.fill);
          if (e.lvl === 0) cell.border = { top: { style: 'medium', color: { argb: 'FF' + TH.head } } };
          edge(cell, c);
        });
        if (style.first) row.getCell(1).fill = fill(style.first);
        return;
      }
      cols.forEach((c, i) => {
        const cell = row.getCell(i + 1); const v = c.v(e.d, n);
        cell.value = v == null || v === '' ? null : v;
        if (c.fmt) cell.numFmt = c.fmt;
        cell.font = c.b ? FONT_B : FONT;
        if (c.hl === 'cur') cell.fill = fill(C.cur); else if (c.hl === 'pend') { cell.fill = fill(C.pend); cell.font = FONT_PEND; }
        if (c.fill) { const f = c.fill(e.d); if (f) cell.fill = fill(f); }
        if (c.tint && !c.hl && !cell.fill) cell.fill = fill(c.tint);
        edge(cell, c);
      });
    });
    const details = entries.filter((e) => !e.hdr);
    const lab = ws.getCell(totalRow, o.totalLabelCol || 1); lab.value = o.totalLabel || `TOTAL · ${details.length.toLocaleString('en-US')} rows · follows the filter`;
    lab.font = font({ bold: true, color: { argb: 'FF' + TH.head } });
    cols.forEach((c, i) => {
      if (!c.sum) return; const cell = ws.getCell(totalRow, i + 1); const L = col(i + 1);
      const res = r2(details.reduce((s, e) => s + val(c, e), 0));
      cell.value = entries.length ? { formula: `SUBTOTAL(9,${L}${first}:${L}${last})`, result: res } : 0;
      cell.numFmt = c.fmt || F.amt; cell.font = font({ bold: true, color: { argb: 'FF' + TH.head } }); cell.fill = fill(TH.light); cell.border = box;
    });
    if (maxLvl || colLvl) ws.properties.outlineProperties = { summaryBelow: false, summaryRight: !!o.summaryRight };   // type rows above their rows; summary columns to the right
    if (maxLvl) ws.properties.outlineLevelRow = maxLvl + 1;
    if (colLvl) ws.properties.outlineLevelCol = colLvl + 1;
    ws.views = [{ state: 'frozen', xSplit: o.freezeCol || 0, ySplit: headRow }];
    if (entries.length) ws.autoFilter = { from: { row: headRow, column: 1 }, to: { row: last, column: cols.filter((c) => !c.hide).length } };
    return { headRow, first, last };
  }
  const plural = (n, w) => `${n.toLocaleString('en-US')} ${w}${n === 1 ? '' : 's'}`;
  const bucketLabel = (b) => (b === 'Opening' ? 'Opening' : mLabel(keyToM(b)));
  function landscape(ws, titleRows, foot) {
    ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9, margins: { left: 0.3, right: 0.3, top: 0.5, bottom: 0.6, header: 0.2, footer: 0.25 } };
    if (titleRows) ws.pageSetup.printTitlesRow = titleRows;                       // the header rows repeat on every printed page
    if (foot) ws.headerFooter = { oddFooter: `&L&8${foot.replace(/&/g, '&&')} · &A&R&8Page &P of &N` };
  }
  // a live column: a formula for Excel (n = the Excel row) and the same figure, worked out here, as its cached result
  const live = (o) => Object.assign({}, o, { v: (r, n) => { const x = o.res(r); return n ? { formula: o.f(n, r), result: x == null ? '' : x } : x; } });

  // ================================================================ REPORT (with the coding inside)
  // buildReportWorkbook returns the ExcelJS workbook before it is written, so the export (writeReport) and the
  // in-app workbook view read one and the same workbook
  async function buildReportWorkbook(M, ExcelJS) {
    E.applyCoding(M);                                   // the report always reflects the coding as it is now
    const cst = M.cstate, F4 = E.FIELDS;
    const wb = new ExcelJS.Workbook(); wb.creator = 'Cost Intelligence – Subcontract Cost Report v' + M.version; wb.created = new Date();
    const foot = `${M.plant} · Subcontract Cost Report`;
    const towColor = (t, strong) => { const i = cst.towOrder.indexOf(t); return t && i >= 0 ? E.hslHex(E.towHue(i), strong ? 62 : 70, strong ? 78 : 88) : null; };

    // ---- the one input: the cut date (Summary!B4 = CutDate); RepKey = its month (yyyymm). A line's period key is a formula on
    //      the Data sheet (Opening 0 · month · Pending 999999), so every SUMIFS below follows the cut date.
    const PK = { prev: 'D_PK,"<"&RepKey', cur: 'D_PK,RepKey', td: 'D_PK,"<="&RepKey', pend: `D_PK,${PEND}` };
    // Excel takes at most 255 characters in one text literal of a formula: longer text goes in pieces joined with &
    const lit = (s) => { const parts = []; for (let i = 0; i < s.length; i += 200) parts.push(`"${q(s.slice(i, i + 200))}"`); return parts.length ? parts.join('&') : '""'; };
    const subF = (extra) => ({ formula: `${lit(M.plant + ' · report month ')}&TEXT(CutDate,"mmm-yy")&" · cut date "&TEXT(CutDate,"dd-mmm-yyyy")&${lit(' · amounts in ' + M.currency + ' excl. VAT' + (extra || ''))}`,
      result: `${M.plant} · report month ${M.label} · cut date ${fmtDate(M.cutDate)} · amounts in ${M.currency} excl. VAT${extra || ''}` });
    const monF = (pre) => ({ formula: `"${q(pre)}"&TEXT(CutDate,"mmm-yy")`, result: pre + M.label });
    // the months a cut date can reach: the first counted month … the last month in the data (later months fill in as the cut moves)
    let lastMonth = M.reportMonth; for (const l of M.lines) if (l.approved && l.month && l.month > lastMonth) lastMonth = l.month;
    const months = []; for (let m = M.months[0] || M.reportMonth; m <= lastMonth; m = nextM(m)) months.push(m);
    const hasOpening = M.lines.some((l) => l.opening && l.approved);
    const periods = (hasOpening ? [{ key: 0, label: 'Opening', b: 'Opening' }] : []).concat(months.map((m) => ({ key: m, label: mLabel(m), b: mKey(m) })));
    const inCut = (p) => p.key <= M.reportMonth;        // a period the generation cut date already reaches (cached results)
    // the period blocks of the per-month sheets: Opening · Previous years (the earlier years rolled into one block, when chosen in
    // the app) · the months · To date. There are no year totals, so a sheet copied and added up never counts a month twice.
    const pyEnd = (Math.floor(M.reportMonth / 100) - 1) * 100 + 12;             // December of the year before the report year
    const pyMonths = periods.filter((p) => p.key && p.key <= pyEnd);
    const roll = !!M.rollYears && pyMonths.length > 0;
    const PY = { py: true, key: null, id: 'py', label: `Previous years (to ${mLabel(pyEnd)})` };
    const colPeriods = (roll ? periods.filter((p) => !p.key).concat([PY], periods.filter((p) => p.key > pyEnd)) : periods).map((p) => Object.assign({ id: 'm' + p.key }, p));
    const perCrit = (p) => (p.py ? `D_PK,">0",D_PK,"<="&MIN(RepKey,${pyEnd})` : `D_PK,${p.key}`);
    const perOff = (p, f) => (p.key ? `IF(${p.key}>RepKey,"",${f})` : f);        // months after the cut date stay blank
    const perRes = (x, p, f) => { if (!p.py) return inCut(p) ? f(x.at(p.b)) : null; let v = 0; for (const m of pyMonths) if (inCut(m)) v += f(x.at(m.b)); return v; };
    let minDate = null, maxDate = null; for (const l of M.lines) if (l.date) { if (!minDate || l.date < minDate) minDate = l.date; if (!maxDate || l.date > maxDate) maxDate = l.date; }
    // the cut dates on offer: every month end from the first to the last month in the data, newest first (hidden sheet _Cal)
    let calFrom = M.reportMonth, calTo = M.reportMonth; for (const l of M.lines) if (l.month) { if (l.month < calFrom) calFrom = l.month; if (l.month > calTo) calTo = l.month; }
    const cutList = []; for (let m = calFrom; m <= calTo; m = nextM(m)) cutList.unshift(new Date(Date.UTC(Math.floor(m / 100), m % 100, 0)));

    // ---- the Coding sheet layout (other sheets point at it): a plain list in the type-of-works order (Excel can sort it)
    const crows = M.crows;
    const codingTow = (r) => (r.inData ? r.towMain || '(no type of works)' : 'Kept from your coding – not in this data');
    const CH = 4, CF0 = CH + 1;                         // the Coding header row (under the KPI band) and its first data row
    const cEntries = crows.map((r) => ({ lvl: 0, d: r })), cLast = CF0 + cEntries.length - 1;
    const CODING = [
      ['Type of works (SAP)', 26, 'ref', (r) => codingTow(r)], ['Service', 11, 'ref', (r) => r.svc], ['Description', 46, 'ref', (r) => r.desc], ['Unit', 7, 'ref', (r) => r.unit],
      ['DIV', 11, 'div'], ['PKG', 11, 'pkg'], ['MNL', 9, 'mnl'], ['Cost element', 14, 'ce'],
      ['Status', 13, 'status'], ['Qty to date', 12, 'live', null, false, 'tdq'], ['Rate', 11, 'live', null, false, 'tdr'], ['To date', 14, 'live', null, true, 'tda'], ['This month', 14, 'live', null, false, 'cma'],
      ['New', 6, 'info', (r) => (r.isNew ? 'New' : '')], ['POs', 6, 'cnt', (r) => r.poCount || null], ['Subcontractors', 30, 'info', (r) => r.subs],
      ['First certified', 10, 'info', (r) => (r.firstM ? mLabel(r.firstM) : '')], ['Last certified', 10, 'info', (r) => (r.lastM ? mLabel(r.lastM) : '')], ['ID', 6, 'id', (r) => r.id]];
    const cAt = (h) => CODING.findIndex((c) => c[0] === h) + 1;
    const codeCol = { div: col(cAt('DIV')), pkg: col(cAt('PKG')), mnl: col(cAt('MNL')), ce: col(cAt('Cost element')) }, idCol = col(cAt('ID'));
    const cRng = (L) => `Coding!$${L}$${CF0}:$${L}$${cLast}`;        // one Coding column, data rows only
    const lookup = (f, rowRef) => `IFERROR(INDEX(${cRng(codeCol[f])},${rowRef})&"","")`;   // a code of one coding row, "" when blank
    const match = (idRef) => `MATCH(${idRef},${cRng(idCol)},0)`;
    const rowNo = new Map(); cEntries.forEach((e, i) => rowNo.set(e.d.key, i + 1));   // place in the Coding range (MATCH results)
    const towHead = (what) => (d, lvl) => (lvl === 0 ? plural(d.n, what) : null);
    const typeStyle = (e) => (e.lvl === 0 ? { fill: towColor(e.d.tow, true) || 'E7E6E6' } : { fill: 'EAF1FC', first: towColor(e.d.tow) });
    // per sheet: the letters of its columns by key (filled once its columns are laid out), the codes and the hidden link columns
    const lettersOf = (cols) => { const L = {}; cols.forEach((c, i) => { if (c.k) L[c.k] = col(i + 1); }); return L; };
    const codeCols = (L) => F4.map((f) => ({ h: E.FIELD_NAME[f], hl: 'code', w: f === 'ce' ? 12 : 9, k: f, v: (r, n) => (n ? { formula: lookup(f, `$${L.crow}${n}`), result: r[f] || '' } : r[f]) }));
    const linkCols = (L, getKey, withRow) => [{ h: 'Coding ID', k: 'id', v: (r) => M.cIndex.get(getKey(r)).id, w: 6, hide: true }]
      .concat(withRow ? [{ h: 'Coding row', k: 'crow', w: 6, hide: true, v: (r, n) => ({ formula: match(`$${L.id}${n}`), result: rowNo.get(getKey(r)) }) }] : []);
    const rateF = (L, qk, ak) => (n) => `IF(ABS(${L[qk]}${n})<0.000001,"",${L[ak]}${n}/${L[qk]}${n})`;
    // current-month highlight and greyed months after the cut date, for a sheet with one column block per period
    const colNo = (L) => L.split('').reduce((s, ch) => s * 26 + ch.charCodeAt(0) - 64, 0);
    const periodCF = (ws, L, keyCol, first, last, sfx) => {
      let pri = 1;
      for (const p of colPeriods) {
        if (!p.key) continue;                           // Opening and Previous years are never after the cut date
        const nums = sfx.map((s) => L[p.id + s]).filter(Boolean).map(colNo); if (!nums.length) continue;
        const from = col(Math.min(...nums)), to = col(Math.max(...nums));
        ws.addConditionalFormatting({ ref: `${from}4:${to}5`, rules: [
          { type: 'expression', priority: pri++, formulae: [`RepKey=${p.key}`], style: { fill: cfFill(C.gold) } },
          { type: 'expression', priority: pri++, formulae: [`RepKey<${p.key}`], style: { fill: cfFill(C.off) } }] });
        ws.addConditionalFormatting({ ref: `${from}${first}:${to}${last}`, rules: [
          { type: 'expression', priority: pri++, formulae: [`AND(RepKey=${p.key},$${keyCol}${first}<>"")`], style: { fill: cfFill(C.cur) } }] });
      }
    };

    // ---- Service Summary: Previous | This month | To date | Pending | Rate analysis – live SUMIFS on the Data sheet by Coding ID
    const SL = {};
    const smId = (n) => `$${SL.id}${n}`;
    // rate analysis (same rules as the app, E.rates): a change is only read when both rates are positive and within 3× of each
    // other – a bigger jump is a placeholder price (e.g. qty = amount at rate 1) or another unit: it shows "check", out of the totals
    const RT = new Map(M.items.map((r) => [r.key, E.rates(r, M.reportMonth)])), rt = (r) => RT.get(r.key);
    const dOf = (v) => (v === 'check' ? 'check' : v ? r2(v.d) : null), pOf = (v) => (v && v !== 'check' ? v.pct : null);
    const guard = (a, b) => `IF(OR(${a}="",${b}=""),"",IF(AND(${a}>0,${b}>0,${b}<=3*${a},3*${b}>=${a}),IF(ABS(${b}-${a})<0.005,0,${b}-${a}),"check"))`;
    const VG1 = 'Rate – this month vs previous (to last month)', VG2 = 'Rate – since the start (first month → to date)', RB1 = '7030A0', RB2 = '4B2D73';
    const startQ = (r, n) => `SUMIFS(D_Qty,D_ID,${smId(n)},D_PK,${r.startKey})`;
    const SMC = [
      { h: 'Type of works (SAP)', v: (r) => r.tow, hv: (d, lvl) => (lvl === 0 ? d.tow || '(no type of works)' : null), w: 24, fill: (r) => towColor(r.tow) }, { h: 'Service', v: (r) => r.svc, w: 11 },
      { h: 'Description', v: (r) => r.desc, hv: towHead('row'), w: 44 }, { h: 'Unit', v: (r) => r.unit, w: 7 }];
    const svcCols = SMC.concat(codeCols(SL), [
      live({ group: 'Previous (last month)', h: 'Qty', k: 'pq', fmt: F.qty, w: 12, bl: true, f: (n) => `SUMIFS(D_Qty,D_ID,${smId(n)},${PK.prev})`, res: (r) => r.prev.q }),
      live({ group: 'Previous (last month)', h: 'Rate', k: 'pr', fmt: F.rate, w: 10, f: rateF(SL, 'pq', 'pa'), res: (r) => rate(r.prev) }),
      live({ group: 'Previous (last month)', h: 'Amount', k: 'pa', fmt: F.amt, w: 14, sum: true, f: (n) => `SUMIFS(D_Amt,D_ID,${smId(n)},${PK.prev})`, res: (r) => r.prev.a }),
      live({ group: 'This month', groupF: monF('This month · '), h: 'Qty', k: 'cq', hl: 'cur', fmt: F.qty, w: 12, bl: true, f: (n) => `SUMIFS(D_Qty,D_ID,${smId(n)},${PK.cur})`, res: (r) => r.cur.q }),
      live({ group: 'This month', groupF: monF('This month · '), h: 'Rate', k: 'cr', hl: 'cur', fmt: F.rate, w: 10, f: rateF(SL, 'cq', 'ca'), res: (r) => rate(r.cur) }),
      live({ group: 'This month', groupF: monF('This month · '), h: 'Amount', k: 'ca', hl: 'cur', fmt: F.amt, w: 14, sum: true, f: (n) => `SUMIFS(D_Amt,D_ID,${smId(n)},${PK.cur})`, res: (r) => r.cur.a }),
      live({ group: 'To date', h: 'Qty', k: 'tq', fmt: F.qty, w: 12, bl: true, f: (n) => `${SL.pq}${n}+${SL.cq}${n}`, res: (r) => r.td.q }),
      live({ group: 'To date', h: 'Rate', k: 'tr', fmt: F.rate, w: 10, f: rateF(SL, 'tq', 'ta'), res: (r) => rate(r.td) }),
      live({ group: 'To date', h: 'Amount', k: 'ta', fmt: F.amt, w: 15, sum: true, b: true, f: (n) => `${SL.pa}${n}+${SL.ca}${n}`, res: (r) => r.td.a }),
      live({ group: 'Pending – not in To date', h: 'Qty', k: 'nq', hl: 'pend', fmt: F.qty, w: 11, bl: true, f: (n) => `SUMIFS(D_Qty,D_ID,${smId(n)},${PK.pend})`, res: (r) => r.pend.q }),
      live({ group: 'Pending – not in To date', h: 'Rate', k: 'nr', hl: 'pend', fmt: F.rate, w: 10, f: rateF(SL, 'nq', 'na'), res: (r) => rate(r.pend) }),
      live({ group: 'Pending – not in To date', h: 'Amount', k: 'na', hl: 'pend', fmt: F.amt, w: 13, sum: true, f: (n) => `SUMIFS(D_Amt,D_ID,${smId(n)},${PK.pend})`, res: (r) => r.pend.a }),
      // this month against the previous rate (the Previous band: everything to last month)
      live({ group: VG1, gbg: RB1, h: 'Previous', k: 'mpr', fmt: F.rate, w: 10, bl: true, note: 'The rate to last month (Previous band) = Previous amount ÷ Previous qty.', f: (n) => `IF(${SL.pr}${n}="","",${SL.pr}${n})`, res: (r) => rt(r).pr }),
      live({ group: VG1, gbg: RB1, h: 'This month', k: 'mcr', fmt: F.rate, w: 10, f: (n) => `IF(${SL.cr}${n}="","",${SL.cr}${n})`, res: (r) => rt(r).cr }),
      live({ group: VG1, gbg: RB1, h: 'Change', k: 'mvr', fmt: F.chg, w: 10, note: 'This month’s rate − the previous rate (per unit). Blank when either has no quantity. "check" when the two rates differ more than 3 times (or one is not positive): usually a placeholder price, e.g. qty = amount at rate 1, or another unit – look at the lines on the Data sheet.',
        f: (n) => guard(`${SL.mpr}${n}`, `${SL.mcr}${n}`), res: (r) => dOf(rt(r).mv) }),
      live({ group: VG1, gbg: RB1, h: 'Change %', k: 'mvp', fmt: F.chgPct, w: 9, f: (n) => `IF(ISNUMBER(${SL.mvr}${n}),${SL.mvr}${n}/${SL.mpr}${n},"")`, res: (r) => pOf(rt(r).mv) }),
      live({ group: VG1, gbg: RB1, h: 'Value', k: 'mva', fmt: F.chgAmt, w: 12, sum: true, b: true, note: 'This month’s qty × the change = This month’s amount − this month’s qty at the previous rate: what this month cost more (+) or less (−) because the rate moved. Rows marked "check" are left out.',
        f: (n) => `IF(ISNUMBER(${SL.mvr}${n}),ROUND(${SL.cq}${n}*${SL.mvr}${n},2),"")`, res: (r) => rt(r).mValue }),
      // to date against the start rate (the rate in the row's first month with quantity)
      live({ group: VG2, gbg: RB2, h: 'First month', k: 'sfm', w: 9, bl: true, note: 'The first month this Service + Description was certified with quantity (Opening = the initial invoice at go-live).',
        f: (n, r) => (r.startKey == null ? '""' : `IF(${r.startKey}>RepKey,"","${r.startKey ? mLabel(r.startKey) : 'Opening'}")`), res: (r) => (rt(r).st ? rt(r).st.label : null) }),
      live({ group: VG2, gbg: RB2, h: 'Start rate', k: 'ssr', fmt: F.rate, w: 10, note: 'The rate in the first month = that month’s amount ÷ its qty.',
        f: (n, r) => (r.startKey == null ? '""' : `IF(${r.startKey}>RepKey,"",IF(ABS(${startQ(r, n)})<0.000001,"",SUMIFS(D_Amt,D_ID,${smId(n)},D_PK,${r.startKey})/${startQ(r, n)}))`), res: (r) => (rt(r).st ? rt(r).sr : null) }),
      live({ group: VG2, gbg: RB2, h: 'To date rate', k: 'str', fmt: F.rate, w: 10, f: (n) => `IF(${SL.tr}${n}="","",${SL.tr}${n})`, res: (r) => rt(r).tr }),
      live({ group: VG2, gbg: RB2, h: 'Change', k: 'svr', fmt: F.chg, w: 10, note: 'To date rate − start rate (per unit): how the average rate moved since the first month. "check" as on the left.', f: (n) => guard(`${SL.ssr}${n}`, `${SL.str}${n}`), res: (r) => dOf(rt(r).sv) }),
      live({ group: VG2, gbg: RB2, h: 'Change %', k: 'svp', fmt: F.chgPct, w: 9, f: (n) => `IF(ISNUMBER(${SL.svr}${n}),${SL.svr}${n}/${SL.ssr}${n},"")`, res: (r) => pOf(rt(r).sv) }),
      live({ group: VG2, gbg: RB2, h: 'Value', k: 'sva', fmt: F.chgAmt, w: 13, sum: true, b: true, note: 'To date qty × the change = To date amount − to date qty at the start rate: what the work to date cost more (+) or less (−) than at the first month’s rate.',
        f: (n) => `IF(ISNUMBER(${SL.svr}${n}),ROUND(${SL.tq}${n}*${SL.svr}${n},2),"")`, res: (r) => rt(r).sValue })],
      linkCols(SL, (r) => r.key, true));
    Object.assign(SL, lettersOf(svcCols));
    const smEntries = byType(M.items, (r) => r.tow);
    const smFirst = 6, smLast = 5 + smEntries.length;
    const smRange = (L) => `'Service Summary'!$${L}$${smFirst}:$${L}$${smLast}`;
    const smDetail = (L) => `SUMIFS(${smRange(L)},${smRange(SL.id)},">0")`;   // detail rows only (they carry a Coding ID; type rows do not)
    const smAmt = { prev: SL.pa, cur: SL.ca, td: SL.ta, pend: SL.na };

    // ---- Subcontractor Summary layout: certificates and amount per band (the Summary counts active subcontractors on it).
    //      A certificate = PO + invoice serial, counted once with the Data column "Cert. count" (named range D_Cert).
    const UL = {};
    const supEntries = byType(M.suppliers, (x) => x.tow);
    const spFirst = 6, spLast = 5 + supEntries.length;
    const spRange = (L) => `'Subcontractor Summary'!$${L}$${spFirst}:$${L}$${spLast}`;
    const CERT_NOTE = 'Certificates = PO + invoice serial, each counted once – approved and dated up to the cut date (the others are under Pending).';
    const supHead = () => [{ h: 'Type of works (main)', v: (x) => x.tow, hv: (d, lvl) => (lvl === 0 ? d.tow || '(no type of works)' : null), w: 24, fill: (x) => towColor(x.tow) },
      { h: 'Supplier code', k: 'code', v: (x) => x.code, w: 12 }, { h: 'Subcontractor', v: (x) => x.name, hv: towHead('subcontractor'), w: 38 }, { h: 'POs', v: (x) => x.poCount, w: 6, fmt: F.int }];
    const bySup = (n) => `D_Sup,$${UL.code}${n}`, detTotal = (L) => `SUMIFS(${spRange(L)},${spRange(UL.code)},"<>")`;
    const supCols = supHead().concat([
      live({ group: 'Previous (last month)', h: 'Certificates', k: 'pn', fmt: F.int, sum: true, w: 12, bl: true, note: CERT_NOTE, f: (n) => `SUMIFS(D_Cert,${bySup(n)},${PK.prev})`, res: (x) => x.prev.n }),
      live({ group: 'Previous (last month)', h: 'Amount', k: 'pa', fmt: F.amt, sum: true, w: 14, f: (n) => `SUMIFS(D_Amt,${bySup(n)},${PK.prev})`, res: (x) => x.prev.a }),
      live({ group: 'This month', groupF: monF('This month · '), h: 'Certificates', k: 'cn', hl: 'cur', fmt: F.int, sum: true, w: 12, bl: true, f: (n) => `SUMIFS(D_Cert,${bySup(n)},${PK.cur})`, res: (x) => x.cur.n }),
      live({ group: 'This month', groupF: monF('This month · '), h: 'Amount', k: 'ca', hl: 'cur', fmt: F.amt, sum: true, w: 14, f: (n) => `SUMIFS(D_Amt,${bySup(n)},${PK.cur})`, res: (x) => x.cur.a }),
      live({ group: 'To date', h: 'Certificates', k: 'tn', fmt: F.int, sum: true, w: 12, bl: true, f: (n) => `${UL.pn}${n}+${UL.cn}${n}`, res: (x) => x.td.n }),
      live({ group: 'To date', h: 'Amount', k: 'ta', fmt: F.amt, sum: true, w: 15, b: true, f: (n) => `${UL.pa}${n}+${UL.ca}${n}`, res: (x) => x.td.a }),
      live({ group: 'To date', h: '% of all', k: 'tp', fmt: F.pct, w: 8, note: 'Share of the To date of all subcontractors.', f: (n) => `IF(${detTotal(UL.ta)}=0,"",${UL.ta}${n}/${detTotal(UL.ta)})`, res: (x) => (M.T.td ? x.td.a / M.T.td : null) }),
      live({ group: 'Pending – not in To date', h: 'Certificates', k: 'nn', hl: 'pend', fmt: F.int, sum: true, w: 12, bl: true, f: (n) => `SUMIFS(D_Cert,${bySup(n)},${PK.pend})`, res: (x) => x.pend.n }),
      live({ group: 'Pending – not in To date', h: 'Amount', k: 'na', hl: 'pend', fmt: F.amt, sum: true, w: 14, f: (n) => `SUMIFS(D_Amt,${bySup(n)},${PK.pend})`, res: (x) => x.pend.a })]);
    Object.assign(UL, lettersOf(supCols));
    const activeF = (L) => `COUNTIFS(${spRange(L)},">0.005",${spRange(UL.code)},"<>")+COUNTIFS(${spRange(L)},"<-0.005",${spRange(UL.code)},"<>")`;
    // active subcontractors in any period (cost ≠ 0), straight from the Data sheet – whether or not the month has its own column
    const activeAt = (keyRef) => `SUMPRODUCT((${spRange(UL.code)}<>"")*(ABS(SUMIFS(D_Amt,D_Sup,${spRange(UL.code)},D_PK,${keyRef}))>0.005))`;

    // ---- Invoices Register layout: certificates and certified amount per period block, per subcontractor; the TOTAL row = all subcontractors
    const VL = {};
    const volCols = supHead();
    { let tint = false; const vId = (n) => `$${VL.code}${n}`;
      const add = (cols) => { cols[0].bl = true; if (tint) cols.forEach((c) => { c.tint = 'F4F6FA'; }); tint = !tint; volCols.push(...cols); };
      colPeriods.forEach((p, i) => {
        const crit = perCrit(p), off = (f) => perOff(p, f), gbg = p.py ? '44546A' : undefined;
        add([live({ group: p.label, gbg, h: 'Certs', k: p.id + 'n', fmt: F.int, sum: true, w: 7, olvl: 1, note: i ? null : CERT_NOTE, f: (n) => off(`SUMIFS(D_Cert,D_Sup,${vId(n)},${crit})`), res: (x) => perRes(x, p, (o) => o.n) }),
          live({ group: p.label, gbg, h: 'Amount', k: p.id + 'a', fmt: F.amt, sum: true, w: 12, f: (n) => off(`SUMIFS(D_Amt,D_Sup,${vId(n)},${crit})`), res: (x) => perRes(x, p, (o) => o.a) })]);
      });
      add([live({ group: 'To date', gbg: SUBT.head, h: 'Certs', k: 'tn', fmt: F.int, sum: true, w: 8, olvl: 1, f: (n) => `SUMIFS(D_Cert,D_Sup,${vId(n)},${PK.td})`, res: (x) => x.td.n }),
        live({ group: 'To date', gbg: SUBT.head, h: 'Amount', k: 'ta', fmt: F.amt, sum: true, w: 14, b: true, f: (n) => `SUMIFS(D_Amt,D_Sup,${vId(n)},${PK.td})`, res: (x) => x.td.a })]);
    }
    Object.assign(VL, lettersOf(volCols));
    const vpRange = (L) => `'Invoices Register'!$${L}$${spFirst}:$${L}$${spLast}`;

    // ---- Data columns: what the reader needs first – what (type, service, description, unit) · coding · when · who · Qty, Rate,
    //      AMOUNT – then how each figure was calculated, then the keys the app and the formulas use (far right, grey)
    const D = [
      ['Type of works', 22, (l) => l.tow || null], ['Service', 11, (l) => l.svc], ['Description', 40, (l) => l.text], ['Unit', 6, (l) => l.info.unit || null],
      ['DIV', 9, null, null, 'code'], ['PKG', 9, null, null, 'code'], ['MNL', 7, null, null, 'code'], ['Cost element', 12, null, null, 'code'],
      ['Period', 9, null], ['Cert. date', 12, (l) => l.date, F.date], ['Subcontractor', 30, (l) => l.supName], ['PO', 11, (l) => l.po], ['Cert. serial', 8, (l) => l.serial],
      ['Qty', 11, null, F.qty], ['Rate', 11, null, F.rate], ['Amount', 14, (l) => l.amt, F.amt, 'amt'],
      ['Line type', 11, (l) => l.ltype], ['Pending reason', 13, null], ['Approved', 10, (l) => l.appr || null], ['Opening (Flag)', 9, (l) => l.flag || null], ['Cert. month', 9, (l) => (l.month ? mKey(l.month) : null)],
      ['Subcontractor code', 12, (l) => l.supCode], ['SAP qty', 11, (l) => l.qty, F.qty], ['Gross price', 11, (l) => l.price, F.rate], ['Contract type', 9, (l) => l.ctype], ['Tax code', 7, (l) => l.tax], ['VAT rate', 7, (l) => l.vatRate, '0%'],
      ['Net rate', 11, null, F.rate], ['Progress %', 9, (l) => l.paid, '0.00'], ['VAT', 11, (l) => l.vat, F.amt], ['Resource', 11, (l) => l.info.resName], ['Service group', 20, (l) => l.info.group || null],
      ['Certificate text', 30, (l) => l.certText || null], ['Entry sheet', 11, (l) => l.es || null], ['WBS element', 20, (l) => l.wbs || null],
      ['Month key', 8, (l) => l.month || null, '0', 'key'], ['Period key', 8, null, '0', 'key'], ['Cert. count', 7, (l) => (certFirst.has(l) ? 1 : null), '0', 'key'],
      ['WBS rows', 7, (l) => (l.wbsRows > 1 ? l.wbsRows : null), null, 'key'], ['PO item', 7, (l) => l.item, null, 'key'], ['PO line', 24, (l) => l.pol, null, 'key'], ['Line ID', 26, (l) => l.lid, null, 'key'],
      ['Coding ID', 8, (l) => M.cIndex.get(l.ckey).id, null, 'key'], ['Coding row', 8, null, null, 'key']];
    const certFirst = new Set();                        // one line per certificate carries Cert. count = 1 (filled with the Data rows below)
    const ix = (h) => D.findIndex((d) => d[0] === h) + 1, dc = (h) => col(ix(h));
    const nData = M.lines.length + 1;
    const NAMES = { D_ID: 'Coding ID', D_PK: 'Period key', D_Qty: 'Qty', D_Amt: 'Amount', D_Sup: 'Subcontractor code', D_PO: 'PO', D_Tow: 'Type of works', D_Res: 'Resource', D_Appr: 'Approved', D_Date: 'Cert. date', D_MK: 'Month key', D_Cert: 'Cert. count' };

    // ================= 1. Summary
    const ws = wb.addWorksheet('Summary', { properties: { tabColor: { argb: 'FF' + TAB.report } }, views: [{ showGridLines: false }] });
    ws.getCell('A1').value = 'Subcontract Cost Report'; ws.getCell('A1').font = font({ size: 16, bold: true, color: { argb: 'FF' + C.navy } });
    ws.getCell('A2').value = `${M.plant}${M.pc ? ' (' + M.pc + ')' : ''} · ${M.currency} excl. VAT`; ws.getCell('A2').font = font({ size: 11, bold: true });
    const p = M.progressAll;
    ws.getCell('A3').value = `Made ${fmtDate(new Date(Date.UTC(M.generated.getFullYear(), M.generated.getMonth(), M.generated.getDate())))} by Cost Intelligence (Subcontract Cost Report v${M.version} layout) from ${[M.files.prog, M.files.serv].filter(Boolean).join(' + ')}${M.files.via ? ' (kept in ' + M.files.via + ')' : ''} · coding ${Math.round(p.pct * 1000) / 10}% of the amount complete when made · every figure below is live: it follows the cut date in B4 and the Coding sheet`; ws.getCell('A3').font = font({ size: 9, color: { argb: 'FF' + C.muted } });
    [44, 16, 16, 16, 16, 16, 16, 14, 13].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
    // the input
    { const a = ws.getCell('A4'), b = ws.getCell('B4'), c = ws.getCell('C4'), d = ws.getCell('E4');      // D4 stays empty: the report month spills into it
      a.value = 'Cut date  ▸'; a.font = font({ size: 12, bold: true, color: { argb: 'FF' + C.navy } }); a.alignment = { horizontal: 'right', vertical: 'middle' };
      b.value = M.cutDate; b.numFmt = F.date; b.font = font({ size: 12, bold: true }); b.fill = fill(C.edit); b.alignment = { horizontal: 'center', vertical: 'middle' };
      b.border = { top: { style: 'medium', color: { argb: 'FF' + C.gold } }, left: { style: 'medium', color: { argb: 'FF' + C.gold } }, bottom: { style: 'medium', color: { argb: 'FF' + C.gold } }, right: { style: 'medium', color: { argb: 'FF' + C.gold } } };
      b.dataValidation = { type: 'list', allowBlank: false, formulae: [`_Cal!$A$2:$A$${cutList.length + 1}`], showErrorMessage: true, errorStyle: 'warning', errorTitle: 'Cut date', error: 'This date is not a month end from the list. Keep it as a mid-month cut date?', showInputMessage: true, promptTitle: 'Cut date', prompt: 'Pick a month end from the list – every sheet follows. You can also type another date, e.g. 25-Aug-2026 for a mid-month cut.' };
      b.note = 'The one input of this workbook. Change it and every sheet follows: Previous = before this month, This month = the month of this date up to this date, Pending = not approved or dated later.';
      c.value = monF('Report month '); c.font = font({ size: 12, bold: true, color: { argb: 'FF' + C.navy } }); c.alignment = { vertical: 'middle' };
      d.value = `Pick the cut date from the list (▼) – every sheet follows. A mid-month date can also be typed. Certificates in the data: ${fmtDate(minDate)} to ${fmtDate(maxDate)}.`; d.font = font({ size: 9, italic: true, color: { argb: 'FF' + C.muted } }); d.alignment = { vertical: 'middle' };
      ws.getRow(4).height = 24; }
    const cellAt = (row, c) => { const x = ws.getCell(row, c); x.font = FONT; return x; };
    const kpis = [['Previous (last month)', `SUMIFS(D_Amt,${PK.prev})`, M.T.prev], [monF('This month · '), `SUMIFS(D_Amt,${PK.cur})`, M.T.cur], ['To date', 'A7+B7', M.T.td],
      ['Pending – not in To date', `SUMIFS(D_Amt,${PK.pend})`, M.T.pending], ['Active subcontractors this month', activeF(UL.ca), M.K.activeSup], ['Certificates this month', `SUMIFS(D_Cert,${PK.cur})`, M.K.certs]];
    kpis.forEach(([h, f, v], i) => {
      const a = ws.getCell(6, i + 1), b = ws.getCell(7, i + 1);
      a.value = h; a.font = font({ size: 9, bold: true, color: { argb: 'FFFFFFFF' } }); a.fill = fill(i === 1 ? C.gold : C.navy); a.alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' };
      b.value = { formula: f, result: v }; b.numFmt = i >= 4 ? F.int : F.amt; b.font = font({ size: 14, bold: true, color: { argb: 'FF' + C.navy } }); b.alignment = { horizontal: 'center' }; b.border = box; b.fill = fill(i === 1 ? C.cur : 'FFFFFF');
    });
    ws.getRow(6).height = 40; ws.getRow(7).height = 24;
    let r = 9;
    const section = (t, note) => { const c = ws.getCell(r, 1); c.value = t; c.font = font({ size: 12, bold: true, color: { argb: 'FF' + C.navy } });
      if (note) { const d = ws.getCell(r, 2); d.value = note; d.font = font({ size: 9, italic: true, color: { argb: 'FF' + C.muted } }); } r += 1; };
    const hdr = (arr) => { arr.forEach((h, i) => headCell(ws.getCell(r, i + 1), h)); ws.getRow(r).height = 28; r++; };
    // 1. per month – a row for every month the cut date can reach (blank after it); the key in hidden column J
    section('1. Cost per month', 'live – months after the cut date stay blank');
    const hasOther = M.lines.some((l) => l.info.res === 'Other');
    const RES = [['Subcontract (S)', 'Subcontract', 'S'], ['Labour (L)', 'Labour', 'L'], ['Plant (P)', 'Plant', 'P']].concat(hasOther ? [['Other', 'Other', 'Other']] : []);
    const mh = ['Month'].concat(RES.map((x) => x[0]), ['Total', 'Cumulative', 'Active subcontractors', 'Certificates']);
    hdr(mh); const m0 = r, KC = 'J', totC = col(RES.length + 2);
    ws.getColumn(10).hidden = true;
    for (const per of periods) {
      const row = M.monthRows.find((x) => x.bucket === per.b), on = inCut(per) && row, key = `$${KC}${r}`, off = (f) => (per.key ? `IF(${key}>RepKey,"",${f})` : f);
      ws.getCell(r, 10).value = per.key;
      cellAt(r, 1).value = per.label; ws.getCell(r, 1).border = box;
      RES.forEach(([, res, k], j) => { const c = cellAt(r, j + 2); c.value = { formula: off(`SUMIFS(D_Amt,D_PK,${key},D_Res,"${res}")`), result: on ? row[k] : '' }; c.numFmt = F.amt; c.border = box; });
      { const c = cellAt(r, RES.length + 2); c.value = { formula: off(`SUMIFS(D_Amt,D_PK,${key})`), result: on ? row.total : '' }; c.numFmt = F.amt; c.border = box; }
      { const c = cellAt(r, RES.length + 3); c.value = { formula: off(`SUM(${totC}$${m0}:${totC}${r})`), result: on ? row.cum : '' }; c.numFmt = F.amt; c.border = box; }
      { const c = cellAt(r, RES.length + 4); c.value = { formula: off(activeAt(key)), result: on ? row.suppliers : '' }; c.numFmt = F.int; c.border = box; }
      { const c = cellAt(r, RES.length + 5); c.value = { formula: off(`SUMIFS(D_Cert,D_PK,${key})`), result: on ? row.certs : '' }; c.numFmt = F.int; c.border = box; }
      r++;
    }
    const mLastRow = r - 1;
    ws.addConditionalFormatting({ ref: `A${m0}:${col(RES.length + 5)}${mLastRow}`, rules: [
      { type: 'expression', priority: 1, formulae: [`$${KC}${m0}=RepKey`], style: { fill: cfFill(C.cur), font: { bold: true } } },
      { type: 'expression', priority: 2, formulae: [`$${KC}${m0}>RepKey`], style: { font: { color: { argb: 'FF' + C.off } } } }] });
    { const T = M.T, tot = ['Total'].concat(RES.map(([, , k]) => r2(M.monthRows.reduce((s, x) => s + x[k], 0))), [T.td]);
      tot.forEach((v, i) => { const c = ws.getCell(r, i + 1); c.value = i ? { formula: `SUM(${col(i + 1)}${m0}:${col(i + 1)}${mLastRow})`, result: v } : v; c.font = font({ bold: true }); c.fill = fill(C.light); c.border = box; if (i) c.numFmt = F.amt; });
      { const L = col(RES.length + 5), c = ws.getCell(r, RES.length + 5); c.value = { formula: `SUM(${L}${m0}:${L}${mLastRow})`, result: M.monthRows.reduce((s, x) => s + x.certs, 0) }; c.numFmt = F.int; c.font = font({ bold: true }); c.fill = fill(C.light); c.border = box; }
      r += 2; }
    const monthTotRow = r - 2;
    // 2. by DIV: LIVE – SUMIFS on Service Summary, whose codes come from the Coding sheet. Whatever is not coded yet is one line, so nothing is missed.
    const AMT = [['prev', 'Previous'], ['cur', 'This month'], ['td', 'To date'], ['pend', 'Pending']];
    const liveTable = (titleTxt, f) => {
      section(titleTxt, 'live – follows the Coding sheet and the cut date');
      hdr([E.FIELD_NAME[f], 'Previous', 'This month', 'To date', '% of to date', 'Pending']);
      const groups = new Map(M.groups[f].map((g) => [g.code, g])), d0 = r;
      const list = cst.lists[f].filter(([code]) => { const g = groups.get(code); return g && (g.prev.a || g.cur.a || g.td.a || g.pend.a); });   // codes with cost only
      const totRow = d0 + list.length + 1;
      for (const [code, name] of list) {
        const g = groups.get(code), lab = name && name !== code ? `${code} · ${name}` : code;
        cellAt(r, 1).value = lab; ws.getCell(r, 1).border = box;
        AMT.forEach(([k], j) => { const c = cellAt(r, [2, 3, 4, 6][j]); c.value = { formula: `SUMIFS(${smRange(smAmt[k])},${smRange(SL[f])},"${q(code)}")`, result: g ? g[k].a : 0 }; c.numFmt = F.amt; c.border = box; if (k === 'cur') c.fill = fill(C.cur); });
        const pc = cellAt(r, 5); pc.value = { formula: `IF($D$${totRow}=0,"",D${r}/$D$${totRow})`, result: M.T.td ? (g ? g.td.a : 0) / M.T.td : 0 }; pc.numFmt = F.pct; pc.border = box;
        r++;
      }
      const ncG = groups.get('') || { prev: { a: 0 }, cur: { a: 0 }, td: { a: 0 }, pend: { a: 0 } };
      cellAt(r, 1).value = 'Not coded, or a code without a line here yet'; ws.getCell(r, 1).font = font({ italic: true, color: { argb: 'FF' + C.muted } }); ws.getCell(r, 1).border = box;
      AMT.forEach(([k], j) => { const L = col([2, 3, 4, 6][j]), c = cellAt(r, [2, 3, 4, 6][j]); c.value = { formula: list.length ? `${L}${totRow}-SUM(${L}${d0}:${L}${r - 1})` : `${L}${totRow}`, result: ncG[k].a }; c.numFmt = F.amt; c.border = box; c.font = font({ italic: true, color: { argb: 'FF' + C.muted } }); });
      { const pc = cellAt(r, 5); pc.value = { formula: `IF($D$${totRow}=0,"",D${r}/$D$${totRow})`, result: M.T.td ? ncG.td.a / M.T.td : 0 }; pc.numFmt = F.pct; pc.border = box; }
      r++;
      const tc = ws.getCell(r, 1); tc.value = 'Total'; tc.font = font({ bold: true }); tc.fill = fill(C.light); tc.border = box;
      AMT.forEach(([k], j) => { const c = ws.getCell(r, [2, 3, 4, 6][j]); c.value = { formula: smDetail(smAmt[k]), result: M.T[k === 'pend' ? 'pending' : k] }; c.numFmt = F.amt; c.font = font({ bold: true }); c.fill = fill(C.light); c.border = box; });
      { const c = ws.getCell(r, 5); c.value = 1; c.numFmt = F.pct; c.font = font({ bold: true }); c.fill = fill(C.light); c.border = box; }
      r += 2;
    };
    liveTable('2. Cost by DIV', 'div');
    // 3. type of works (split exactly by each line's PO), in the report order – live SUMIFS on the Data sheet
    ws.getRow(r - 1).addPageBreak();                  // printed: KPIs, months and DIV on page 1; types, reconciliation and checks on page 2
    section('3. Cost by type of works', 'live – SAP: each line by its PO · in your type-of-works order');
    hdr(['Type of works', 'Previous', 'This month', 'To date', '% of to date', 'Pending']); { const d0 = r, tr0 = d0 + M.groups.tow.length;
      for (const d of M.groups.tow) {
        const crit = `D_Tow,"${q(d.code)}"`;
        cellAt(r, 1).value = d.name; ws.getCell(r, 1).border = box;
        [[2, `SUMIFS(D_Amt,${crit},${PK.prev})`, d.prev.a], [3, `SUMIFS(D_Amt,${crit},${PK.cur})`, d.cur.a], [4, `B${r}+C${r}`, d.td.a], [5, `IF($D$${tr0}=0,"",D${r}/$D$${tr0})`, M.T.td ? d.td.a / M.T.td : 0], [6, `SUMIFS(D_Amt,${crit},${PK.pend})`, d.pend.a]]
          .forEach(([c, f, v]) => { const x = cellAt(r, c); x.value = { formula: f, result: v }; x.numFmt = c === 5 ? F.pct : F.amt; x.border = box; if (c === 3) x.fill = fill(C.cur); if (c === 4) x.font = FONT_B; });
        const tcol = towColor(d.code); if (tcol) ws.getCell(r, 1).fill = fill(tcol);
        r++;
      }
      ['Total', M.T.prev, M.T.cur, M.T.td, 1, M.T.pending].forEach((v, i) => { const c = ws.getCell(r, i + 1); c.value = i >= 1 && i !== 4 && r > d0 ? { formula: `SUM(${col(i + 1)}${d0}:${col(i + 1)}${r - 1})`, result: v } : v; c.font = font({ bold: true }); c.fill = fill(C.light); c.border = box; if (i >= 1) c.numFmt = i === 4 ? F.pct : F.amt; });
      r += 2; }
    // 4. reconciliation – the SAP total and the cleaning are facts of the data; the Pending lines follow the cut date
    section('4. From the SAP total to this report');
    hdr(['Step', 'Amount', 'Lines / rows', 'Note']); ws.mergeCells(r - 1, 4, r - 1, 8);
    const hasNoDate = M.lines.some((l) => l.approved && !l.month);
    const recon = [
      ['SAP grand total (last row of ZSCPRG01)', M.T.footer, M.counts.rawRows, 'SC Work Current Cost, as SAP adds it'],
      ['Less: WBS repeat rows', -M.T.dupAmt, -M.counts.dupRows, 'SAP repeats a line on every WBS it is split over – counted once here'],
      ['= Certified (all lines)', M.T.certified, M.lines.length, `${M.counts.zeroLines.toLocaleString('en-US')} zero-amount lines also left out (no effect)`],
      ['Less: Pending – not approved', { formula: '-SUMIFS(D_Amt,D_Appr,"<>X")', result: -M.T.pendNA }, null, 'Character 1 ≠ X'],
      ['Less: Pending – dated after the cut date', { formula: '-SUMIFS(D_Amt,D_Appr,"X",D_Date,">"&CutDate)', result: -M.T.pendAfter }, null, 'Certificate date after the cut date (B4)'],
    ];
    if (hasNoDate) recon.push(['Less: Pending – no date', { formula: '-SUMIFS(D_Amt,D_Appr,"X",D_MK,"")', result: -M.T.pendNoDate }, null, '']);
    const certRow = r + 2;
    recon.push([monF('= To date (Opening + months to '), { formula: `B${certRow}+SUM(B${certRow + 1}:B${certRow + recon.length - 3})`, result: M.T.td }, null, 'The To date of every report sheet']);
    recon[recon.length - 1][0] = { formula: `"= To date (Opening + months to "&TEXT(CutDate,"mmm-yy")&")"`, result: `= To date (Opening + months to ${M.label})` };
    for (const [lab, v, n, note] of recon) {
      const bold = typeof lab === 'string' ? lab.startsWith('=') : true;
      [lab, v, n].forEach((x, i) => { const c = cellAt(r, i + 1); c.value = x; c.border = box; if (i) c.numFmt = i === 1 ? F.amt : F.int; if (bold) { c.font = font({ bold: true }); c.fill = fill(C.light); } });
      ws.mergeCells(r, 4, r, 8); const c = ws.getCell(r, 4); c.value = note; c.font = font({ size: 9, color: { argb: 'FF' + C.muted } }); c.border = box;
      r++;
    }
    const tdRow = r - 1;
    r++;
    section('Live checks (formulas – they must show 0)');
    const checksF = [
      ['Service Summary To date − above', `ROUND(${smDetail(smAmt.td)}-B${tdRow},2)`],
      ['PO Register To date − above', null],             // filled in once the PO Register is laid out
      ['PO per Month To date − above', null],
      ['Subcontractor Summary To date − above', `ROUND(${detTotal(UL.ta)}-B${tdRow},2)`],
      ['Invoices Register To date − above', `ROUND(SUMIFS(${vpRange(VL.ta)},${vpRange(VL.code)},"<>")-B${tdRow},2)`],
      ['Data sheet (lines up to the cut date) − above', `ROUND(SUMIFS(D_Amt,${PK.td})-B${tdRow},2)`],
      ['Cost per month total − above', `ROUND(${totC}${monthTotRow}-B${tdRow},2)`],
    ];
    const checkCells = [];
    for (const [lab, f] of checksF) { cellAt(r, 1).value = lab; ws.getCell(r, 1).border = box; const c = ws.getCell(r, 2); checkCells.push([c, f]); c.numFmt = '#,##0.00;[Red]-#,##0.00;"✔ 0"'; c.border = box; c.font = font({ bold: true, color: { argb: 'FF375623' } }); r++; }
    landscape(ws, null, foot); ws.pageSetup.orientation = 'portrait';

    // ================= 2. Coding (the codes live here; edit the yellow cells, the report follows)
    const cs = wb.addWorksheet('Coding', { properties: { tabColor: { argb: 'FF' + TAB.coding } } });
    CODING.forEach(([h, w], j) => { cs.getColumn(j + 1).width = w; cs.getCell(CH, j + 1).value = h; });
    // any code is accepted. The drop-down of each code column = the codes on the Lists sheet + every code already typed in that
    // column, unique and live (hidden _Codes sheet), so a code typed once is offered on every other row at once.
    const LIST = { div: 'A', pkg: 'D', mnl: 'G', ce: 'J' }, CODES = { div: 'A', pkg: 'B', mnl: 'C', ce: 'D' };
    const nLists = Math.max(1, ...F4.map((f) => cst.lists[f].length)), lRows = nLists + 60, kRows = nLists + 80;
    const dropList = (f) => `OFFSET(_Codes!$${CODES[f]}$2,0,0,MAX(1,COUNTIF(_Codes!$${CODES[f]}$2:$${CODES[f]}$${kRows + 1},"?*")),1)`;
    const CL = {}; CODING.forEach(([, , , , , k], i) => { if (k) CL[k] = col(i + 1); });
    const codingLive = {
      tdq: [(n) => `SUMIFS(D_Qty,D_ID,$${idCol}${n},${PK.td})`, (x) => x.td.q, F.qty], tda: [(n) => `SUMIFS(D_Amt,D_ID,$${idCol}${n},${PK.td})`, (x) => x.td.a, F.amt],
      tdr: [(n) => `IF(ABS(${CL.tdq}${n})<0.000001,"",${CL.tda}${n}/${CL.tdq}${n})`, (x) => rate(x.td), F.rate], cma: [(n) => `SUMIFS(D_Amt,D_ID,$${idCol}${n},${PK.cur})`, (x) => x.cur.a, F.amt] };
    const stL = col(cAt('Status'));
    // each service and each unit its own colour (golden-angle hues in list order, so neighbours always differ) – easy to spot down the list
    const svcColor = new Map([...new Set(crows.map((x) => x.svc))].map((s, i) => [s, E.hslHex(Math.round((i * 137.508 + 20) % 360), 75, 86)]));
    const unitN = new Map(); for (const x of crows) if (x.unit) unitN.set(x.unit, (unitN.get(x.unit) || 0) + 1);
    const unitColor = new Map([...unitN.keys()].sort((a, b) => unitN.get(b) - unitN.get(a)).map((u, i) => [u, E.hslHex(Math.round((i * 137.508 + 300) % 360), 60, 80)]));
    cEntries.forEach((e, i) => {
      const n = i + CF0, row = cs.getRow(n);
      const x = e.d, c = E.codeOf(cst, x.key);
      CODING.forEach(([, , kind, v, bold, k], j) => {
        const cell = row.getCell(j + 1);
        if (F4.includes(kind)) { cell.value = c[kind] || null; cell.fill = fill(C.edit); cell.border = box; cell.font = font({ bold: true });
          cell.dataValidation = { type: 'list', allowBlank: true, formulae: [dropList(kind)], showErrorMessage: false }; }
        else if (kind === 'status') { const kk = F4.filter((f) => c[f]).length;
          cell.value = x.inData ? { formula: `IF(COUNTA(${codeCol.div}${n}:${codeCol.ce}${n})=4,"Coded",IF(COUNTA(${codeCol.div}${n}:${codeCol.ce}${n})=0,"Not coded","Partly coded"))`, result: kk === 4 ? 'Coded' : kk ? 'Partly coded' : 'Not coded' } : 'Not in this data'; cell.font = FONT; }
        else if (kind === 'live') { const [f, res, fmt] = codingLive[k], y = res(x); cell.value = { formula: f(n), result: y == null ? '' : y }; cell.numFmt = fmt; cell.font = bold ? FONT_B : FONT; }
        else { const y = v(x); cell.value = y === '' || y == null || (y === 0 && kind !== 'id') ? null : y; cell.font = kind === 'info' ? font({ color: { argb: 'FF' + C.muted } }) : kind === 'cnt' && y > 1 ? FONT_B : FONT;
          if (kind === 'cnt') { cell.numFmt = F.int; cell.alignment = { horizontal: 'center' }; } }
      });
      const tc = towColor(x.towMain); if (tc) row.getCell(cAt('Type of works (SAP)')).fill = fill(tc);
      const sc = svcColor.get(x.svc), uc = unitColor.get(x.unit || '');
      if (sc) row.getCell(cAt('Service')).fill = fill(sc); if (uc) row.getCell(cAt('Unit')).fill = fill(uc);
      if (x.isNew) row.getCell(cAt('New')).fill = fill(C.warn);
      if (i && codingTow(cEntries[i - 1].d) !== codingTow(x)) for (let j = 1; j <= CODING.length; j++) row.getCell(j).border = Object.assign({}, row.getCell(j).border || {}, { top: { style: 'medium', color: { argb: 'FF' + C.navy } } });
    });
    const colBg = (j) => (F4.includes(CODING[j - 1][2]) ? C.gold : CODING[j - 1][2] === 'info' ? '7F7F7F' : C.navy);
    cs.getRow(CH).eachCell((c, i) => headCell(c, c.value, colBg(i)));
    cs.getCell(CH, cAt('This month')).value = monF('This month · ');
    cs.getRow(CH).height = 30;
    // the KPI band above the header – live: it follows the codes typed below (a service = one Service + Description row)
    { const rg = (h) => `$${col(cAt(h))}$${CF0}:$${col(cAt(h))}$${cLast}`, ST = rg('Status');
      const inRows = crows.filter((x) => x.inData), has = (x, f) => !!E.codeOf(cst, x.key)[f], full = (x) => F4.every((f) => has(x, f));
      const sum = (arr, g) => r2(arr.reduce((t, x) => t + g(x), 0)), open = inRows.filter((x) => !full(x)), done = inRows.length - open.length, tdAll = sum(inRows, (x) => x.td.a);
      const TOT = `(COUNTIF(${ST},"Coded")+COUNTIF(${ST},"Partly coded")+COUNTIF(${ST},"Not coded"))`, notFull = (h) => `SUMIFS(${rg(h)},${ST},"Partly coded")+SUMIFS(${rg(h)},${ST},"Not coded")`;
      const KPI = [
        [1, 1, 'Services still to code', `COUNTIF(${ST},"Not coded")+COUNTIF(${ST},"Partly coded")`, open.length, F.int, 'todo'],
        [2, 3, 'Fully coded', `COUNTIF(${ST},"Coded")&" of "&${TOT}&" services"`, `${done} of ${inRows.length} services`, null],
        ...F4.map((f) => [cAt(E.FIELD_NAME[f]), cAt(E.FIELD_NAME[f]), `${E.FIELD_NAME[f]} missing`, `COUNTIFS(${rg(E.FIELD_NAME[f])},"",${ST},"<>Not in this data")`, inRows.filter((x) => !has(x, f)).length, F.int, 'todo']),
        [cAt('Status'), cAt('Status'), 'Coded – share of To date', `IFERROR(SUMIFS(${rg('To date')},${ST},"Coded")/SUMIFS(${rg('To date')},${ST},"<>Not in this data"),0)`, tdAll ? sum(inRows.filter(full), (x) => x.td.a) / tdAll : 0, F.pct],
        [cAt('To date'), cAt('To date'), 'To date not fully coded', notFull('To date'), sum(open, (x) => x.td.a), F.amt],
        [cAt('This month'), cAt('This month'), 'This month not fully coded', notFull('This month'), sum(open, (x) => x.cur.a), F.amt],
        [cAt('New'), cAt('New'), 'New', `COUNTIF(${rg('New')},"New")`, inRows.filter((x) => x.isNew).length, F.int],
        [cAt('POs'), cAt('POs'), '2+ POs', `COUNTIF(${rg('POs')},">1")`, crows.filter((x) => x.poCount > 1).length, F.int]];
      let cfp = 20;                                   // unique priorities for the band's conditional formats
      for (const [c1, c2, cap, f, res, fmt, kind] of KPI) {
        if (c2 > c1) { cs.mergeCells(1, c1, 1, c2); cs.mergeCells(2, c1, 2, c2); }
        const a = cs.getCell(1, c1), b = cs.getCell(2, c1);
        a.value = cap; a.font = font({ size: 9, bold: true, color: { argb: 'FFFFFFFF' } }); a.fill = fill(colBg(c1)); a.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }; a.border = box;
        b.value = { formula: f, result: res }; if (fmt) b.numFmt = fmt; b.font = font({ size: 13, bold: true, color: { argb: 'FF' + C.navy } }); b.alignment = { horizontal: 'center', vertical: 'middle', shrinkToFit: true }; b.border = box;   // big totals shrink, never ####
        if (kind === 'todo') cs.addConditionalFormatting({ ref: b.address, rules: [{ type: 'cellIs', operator: 'greaterThan', priority: cfp++, formulae: ['0'], style: { fill: cfFill(C.warn) } },
          { type: 'cellIs', operator: 'equal', priority: cfp++, formulae: ['0'], style: { fill: cfFill(C.ok) } }] });
      }
      cs.getCell(1, cAt('POs')).note = 'Services certified on two or more POs (shared across POs) – bold in the POs column below.';
      cs.getCell(1, 1).note = 'A service = one Service + Description row. Still to code = Not coded + Partly coded (any of DIV, PKG, MNL, Cost element empty). Live: the band follows the codes typed below.';
      const nt = cs.getCell(3, 1); nt.value = 'Live – the band follows the codes typed below · a service = one Service + Description row · an orange code cell is still empty · per type of works: the Lists sheet';
      nt.font = font({ size: 9, italic: true, color: { argb: 'FF' + C.muted } });
      cs.getRow(1).height = 30; cs.getRow(2).height = 24; }
    cs.getCell(CH, cAt('Rate')).note = 'Average certified rate = To date ÷ Qty to date (EGP excl. VAT per unit). Live: follows the cut date on the Summary.';
    cs.getCell(CH, cAt('POs')).note = 'How many POs this Service + Description is certified on (bold = more than one, i.e. shared across POs). The PO Register lists them.';
    cs.getCell(CH, cAt('Service')).note = 'Each service has its own colour, so the same service is easy to spot down the list (also after sorting).';
    cs.getCell(CH, cAt('Unit')).note = 'Each unit has its own colour, so rows with the same unit stand out.';
    for (const f of F4) cs.getCell(CH, cAt(E.FIELD_NAME[f])).note = `Type any ${E.FIELD_NAME[f]} code, or pick one. The drop-down lists the codes on the Lists sheet and every code already typed in this column (a code typed in another case, e.g. "conc" for "Conc", is the same code). The app does not read this file back.`;
    cs.getColumn(cAt('ID')).hidden = true;
    cs.addConditionalFormatting({ ref: `${codeCol.div}${CF0}:${codeCol.ce}${cLast}`, rules: [
      { type: 'expression', priority: 1, formulae: [`AND($${idCol}${CF0}<>"",LEN(TRIM(${codeCol.div}${CF0}))=0)`], style: { fill: cfFill('F8CBAD') } }] });
    cs.addConditionalFormatting({ ref: `${stL}${CF0}:${stL}${cLast}`, rules: [
      { type: 'cellIs', operator: 'equal', priority: 2, formulae: ['"Coded"'], style: { fill: cfFill(C.ok) } },
      { type: 'cellIs', operator: 'equal', priority: 3, formulae: ['"Partly coded"'], style: { fill: cfFill(C.cur) } },
      { type: 'cellIs', operator: 'equal', priority: 4, formulae: ['"Not coded"'], style: { fill: cfFill(C.warn) } }] });
    cs.views = [{ state: 'frozen', xSplit: 4, ySplit: CH }];        // the KPI band and the header stay in view
    cs.autoFilter = { from: { row: CH, column: 1 }, to: { row: cLast, column: CODING.length - 1 } };
    landscape(cs, `${CH}:${CH}`, foot);

    // ================= 2b. Lists (code names; codes typed on the Coding sheet join it next month) + type-of-works order
    const li = wb.addWorksheet('Lists', { properties: { tabColor: { argb: 'FF' + TAB.coding } } });
    li.columns = [{ header: 'DIV code', width: 12 }, { header: 'DIV name', width: 30 }, { header: '', width: 3 }, { header: 'PKG code', width: 12 }, { header: 'PKG name', width: 30 }, { header: '', width: 3 },
      { header: 'MNL code', width: 10 }, { header: 'MNL name', width: 22 }, { header: '', width: 3 }, { header: 'Cost element code', width: 16 }, { header: 'Cost element name', width: 30 }, { header: '', width: 3 },
      { header: 'Type of works (report order)', width: 40 }];
    const Ls = cst.lists, nL = Math.max(1, ...F4.map((f) => Ls[f].length), cst.towOrder.length);
    for (let i = 0; i < nL; i++) { const g = (f, j) => (Ls[f][i] ? Ls[f][i][j] || null : null);
      li.addRow([g('div', 0), g('div', 1), null, g('pkg', 0), g('pkg', 1), null, g('mnl', 0), g('mnl', 1), null, g('ce', 0), g('ce', 1), null, cst.towOrder[i] || null]); }
    li.getRow(1).eachCell((c) => { if (c.value) headCell(c, c.value); });
    cst.towOrder.forEach((t, i) => { li.getRow(i + 2).getCell(13).fill = fill(E.hslHex(E.towHue(i), 70, 88)); });
    { const rg = (h) => cRng(col(cAt(h))), T = 'INDEX($M:$M,ROW())', last = cst.towOrder.length + 1;
      const STATS = [['Services', 9, F.int, 'Service + Description rows of this type of works on the Coding sheet (live).'], ['Service codes', 9, F.int, 'Different service codes among them.'],
        ['Coded', 8, F.int, 'Services of this type with DIV, PKG, MNL and Cost element.'], ['To code', 8, F.int, 'Services of this type still to code (Not coded or Partly coded).'],
        ['To date', 14, F.amt, 'To date of this type’s services (follows the cut date on the Summary).'], ['% of all', 8, F.pct, 'Share of the To date of all types in this list.']];
      STATS.forEach(([h, w, , note], j) => { li.getColumn(14 + j).width = w; const c = li.getCell(1, 14 + j); headCell(c, h, '7F7F7F'); c.note = note; });
      li.getRow(1).height = 30;
      const rows = crows.filter((x) => x.inData), tdAll = r2(rows.reduce((t, x) => t + x.td.a, 0)) || 0;
      cst.towOrder.forEach((t, i) => {
        const r = i + 2, mine = rows.filter((x) => x.towMain === t), coded = mine.filter((x) => F4.every((f) => E.codeOf(cst, x.key)[f])).length, td = r2(mine.reduce((s2, x) => s2 + x.td.a, 0));
        const vals = [
          [`IF(${T}="","",COUNTIF(${rg('Type of works (SAP)')},${T}))`, mine.length],
          [`IF(${T}="","",SUMPRODUCT((${rg('Type of works (SAP)')}=${T})/COUNTIFS(${rg('Type of works (SAP)')},${rg('Type of works (SAP)')},${rg('Service')},${rg('Service')})))`, new Set(mine.map((x) => x.svc)).size],
          [`IF(${T}="","",COUNTIFS(${rg('Type of works (SAP)')},${T},${rg('Status')},"Coded"))`, coded],
          [`IF(${T}="","",N${r}-P${r})`, mine.length - coded],
          [`IF(${T}="","",SUMIFS(${rg('To date')},${rg('Type of works (SAP)')},${T}))`, td],
          [`IF(OR(${T}="",SUM($R$2:$R$${last})=0),"",R${r}/SUM($R$2:$R$${last}))`, tdAll ? td / tdAll : '']];
        vals.forEach(([f, res], j) => { const c = li.getCell(r, 14 + j); c.value = { formula: f, result: res }; c.numFmt = STATS[j][2]; c.font = j === 3 ? FONT_B : FONT; c.border = box; });
      });
      if (cst.towOrder.length) li.addConditionalFormatting({ ref: `Q2:Q${last}`, rules: [{ type: 'cellIs', operator: 'greaterThan', priority: 1, formulae: ['0'], style: { fill: cfFill(C.warn) } },
        { type: 'expression', priority: 2, formulae: ['AND(ISNUMBER(N2),N2>0,Q2=0)'], style: { fill: cfFill(C.ok) } }] }); }
    li.views = [{ state: 'frozen', ySplit: 1 }];
    li.getCell('A1').note = 'The codes and their names. Add a code here or simply type it on the Coding sheet – both appear in the Coding drop-downs at once. The app does not read this file back.';
    // hidden _Codes: the live drop-down lists (Lists codes first, then codes typed on the Coding sheet that are not on the Lists sheet)
    const cx = wb.addWorksheet('_Codes', { state: 'hidden' });
    F4.forEach((f, j) => {
      const L = CODES[f], lr = `Lists!$${LIST[f]}$2:$${LIST[f]}$${lRows + 1}`, cr = cRng(codeCol[f]);
      cx.getCell(1, j + 1).value = `${E.FIELD_NAME[f]} drop-down (live)`; cx.getColumn(j + 1).width = 18;
      const seen = new Set(), vals = [], push = (v) => { if (v == null || v === '') return; const k = String(v).toUpperCase(); if (!seen.has(k)) { seen.add(k); vals.push(v); } };
      for (const [c] of cst.lists[f]) push(c); for (const e of cEntries) push(E.codeOf(cst, e.d.key)[f]);
      for (let k = 1; k <= kRows; k++) {
        const above = `${L}$1:${L}${k}`, pick = (rng) => `INDEX(${rng},MATCH(0,INDEX(COUNTIF(${above},${rng})+(${rng}=""),0,0),0))`;
        cx.getCell(k + 1, j + 1).value = { formula: `IFERROR(${pick(lr)},IFERROR(${pick(cr)},""))`, result: vals[k - 1] != null ? vals[k - 1] : '' };
      }
    });

    // ================= 3. Service Summary (live from the Data sheet; codes live from Coding)
    const sv = wb.addWorksheet('Service Summary', { properties: { tabColor: { argb: 'FF' + TAB.report } } });
    title(sv, 'Service Summary – cost by type of works › service › description', subF(' · − / + at the left folds a type of works · live: follows the cut date on the Summary and the Coding sheet · Rate = Amount ÷ Qty · rate analysis (right): this month against the previous rate, and to date against the first month’s rate – change, % and value'));
    const st = table(sv, svcCols, smEntries, { top: 3, freezeCol: 4, totalLabelCol: 3, hdrStyle: typeStyle });
    if (st.first !== smFirst || st.last !== smLast) throw new Error('Service Summary layout changed – update the Summary formulas.');
    landscape(sv, '4:5', foot);

    // ================= 4. Service per Month (codes, then qty, rate and amount per period block – every month the cut date can reach)
    const TL = {};
    const tr = wb.addWorksheet('Service per Month', { properties: { tabColor: { argb: 'FF' + TAB.report } } });
    title(tr, 'Service per Month – qty, rate and amount per month', subF(` · approved lines; Pending not included · months after the cut date stay blank${roll ? ` · earlier years in one block: Previous years (to ${mLabel(pyEnd)})` : ''} · the 1 / 2 buttons above the columns: 1 = amounts, 2 = qty, rate and amount · − / + at the left folds a type of works`));
    const trendCols = SMC.map((c) => Object.assign({}, c)).concat(codeCols(TL));
    const tId = (n) => `$${TL.id}${n}`;
    { let tint = false;
      const block = (cols) => { cols[0].bl = true; if (tint) cols.forEach((c) => { c.tint = 'F4F6FA'; }); tint = !tint; trendCols.push(...cols); };
      for (const p of colPeriods) {
        const crit = perCrit(p), off = (f) => perOff(p, f), qk = p.id + 'q', ak = p.id + 'a', gbg = p.py ? '44546A' : undefined;
        block([live({ group: p.label, gbg, h: 'Qty', k: qk, fmt: F.qty, w: 10, olvl: 1, f: (n) => off(`SUMIFS(D_Qty,D_ID,${tId(n)},${crit})`), res: (x) => perRes(x, p, (o) => o.q) }),
          live({ group: p.label, gbg, h: 'Rate', k: p.id + 'r', fmt: F.rate, w: 9, olvl: 1, f: (n) => `IF(ABS(N(${TL[qk]}${n}))<0.000001,"",${TL[ak]}${n}/${TL[qk]}${n})`,
            res: (x) => { const qq = perRes(x, p, (o) => o.q), aa = perRes(x, p, (o) => o.a); return qq != null && Math.abs(qq) > 1e-9 ? r2(aa / qq) : null; } }),
          live({ group: p.label, gbg, h: 'Amount', k: ak, fmt: F.amt, sum: true, w: 12, f: (n) => off(`SUMIFS(D_Amt,D_ID,${tId(n)},${crit})`), res: (x) => perRes(x, p, (o) => o.a) })]);
      }
      block([live({ group: 'To date', gbg: C.navy, h: 'Qty', k: 'tq', fmt: F.qty, w: 12, olvl: 1, f: (n) => `SUMIFS(D_Qty,D_ID,${tId(n)},${PK.td})`, res: (x) => x.td.q }),
        live({ group: 'To date', gbg: C.navy, h: 'Rate', k: 'tr', fmt: F.rate, w: 10, olvl: 1, f: rateF(TL, 'tq', 'ta'), res: (x) => rate(x.td) }),
        live({ group: 'To date', gbg: C.navy, h: 'Amount', k: 'ta', fmt: F.amt, sum: true, w: 14, b: true, f: (n) => `SUMIFS(D_Amt,D_ID,${tId(n)},${PK.td})`, res: (x) => x.td.a })]);
    }
    trendCols.push(...linkCols(TL, (r) => r.key, true));
    Object.assign(TL, lettersOf(trendCols));
    const tt = table(tr, trendCols, smEntries, { top: 3, freezeCol: 4, totalLabelCol: 3, hdrStyle: typeStyle, summaryRight: true });
    periodCF(tr, TL, TL.id, tt.first, tt.last, ['q', 'r', 'a']);
    landscape(tr, '4:5', foot);

    // ================= 5. PO Register (every PO, its Service + Description rows underneath; live from the Data sheet)
    const PL = {};
    const po = wb.addWorksheet('PO Register', { properties: { tabColor: { argb: 'FF' + TAB.report } } });
    title(po, 'PO Register – every PO with its services', subF(' · type of works › PO › service + description (− / + at the left folds them) · live: follows the cut date · PO qty from ZSCSRV1; "Unlimited" PO lines hold an estimate only, so no % is shown for them'));
    const poKey = (n) => `D_PO,$${PL.po}${n},D_ID,$${PL.id}${n}`;
    const poCols = [
      { h: 'Type of works (SAP)', v: (x) => x.tow, hv: (d, lvl) => (lvl === 0 ? d.tow || '(no type of works)' : d.tow), w: 22, fill: (x) => towColor(x.tow) },
      { h: 'PO', k: 'po', v: (x) => x.po, hv: (d, lvl) => (lvl === 0 ? plural(d.n, 'PO') : d.po), w: 11 },
      { h: 'Subcontractor', v: (x) => x.supName, hv: (d, lvl) => (lvl === 1 ? d.supName : null), w: 28 },
      { h: 'Service', v: (x) => x.svc, hv: (d, lvl) => (lvl === 1 ? plural(d.items.length, 'row') : null), w: 11 },
      { h: 'Description', v: (x) => x.desc, hv: (d, lvl) => (lvl === 1 ? d.title || null : null), w: 40 }, { h: 'Unit', v: (x) => x.unit, w: 6 }]
      .concat(codeCols(PL), [
        { h: 'PO qty (SAP)', k: 'poq', v: (x) => x.poQty, fmt: F.qty, w: 11 },
        live({ group: 'Previous (last month)', h: 'Qty', k: 'pq', fmt: F.qty, w: 11, f: (n) => `SUMIFS(D_Qty,${poKey(n)},${PK.prev})`, res: (x) => x.prev.q }),
        live({ group: 'Previous (last month)', h: 'Rate', k: 'pr', fmt: F.rate, w: 10, f: rateF(PL, 'pq', 'pa'), res: (x) => rate(x.prev) }),
        live({ group: 'Previous (last month)', h: 'Amount', k: 'pa', fmt: F.amt, sum: true, w: 13, f: (n) => `SUMIFS(D_Amt,${poKey(n)},${PK.prev})`, res: (x) => x.prev.a }),
        live({ group: 'This month', groupF: monF('This month · '), h: 'Qty', k: 'cq', hl: 'cur', fmt: F.qty, w: 11, f: (n) => `SUMIFS(D_Qty,${poKey(n)},${PK.cur})`, res: (x) => x.cur.q }),
        live({ group: 'This month', groupF: monF('This month · '), h: 'Rate', k: 'cr', hl: 'cur', fmt: F.rate, w: 10, f: rateF(PL, 'cq', 'ca'), res: (x) => rate(x.cur) }),
        live({ group: 'This month', groupF: monF('This month · '), h: 'Amount', k: 'ca', hl: 'cur', fmt: F.amt, sum: true, w: 13, f: (n) => `SUMIFS(D_Amt,${poKey(n)},${PK.cur})`, res: (x) => x.cur.a }),
        live({ group: 'To date', h: 'Qty', k: 'tq', fmt: F.qty, w: 11, f: (n) => `${PL.pq}${n}+${PL.cq}${n}`, res: (x) => x.td.q }),
        live({ group: 'To date', h: 'Rate', k: 'tr', fmt: F.rate, w: 10, f: rateF(PL, 'tq', 'ta'), res: (x) => rate(x.td) }),
        live({ group: 'To date', h: 'Amount', k: 'ta', fmt: F.amt, sum: true, w: 14, b: true, f: (n) => `${PL.pa}${n}+${PL.ca}${n}`, res: (x) => x.td.a }),
        live({ group: 'To date', h: '% of PO qty', k: 'pct', fmt: F.pct, w: 9, f: (n) => `IF(ISNUMBER(${PL.poq}${n}),IF(${PL.poq}${n}=0,"",${PL.tq}${n}/${PL.poq}${n}),"")`,
          res: (x) => (typeof x.poQty === 'number' && x.poQty ? x.td.q / x.poQty : null) }),
        live({ group: 'Pending – not in To date', h: 'Amount', k: 'na', hl: 'pend', fmt: F.amt, sum: true, w: 13, f: (n) => `SUMIFS(D_Amt,${poKey(n)},${PK.pend})`, res: (x) => x.pend.a }),
        { h: 'Certificates (all)', v: (x) => x.certs, hv: (d, lvl) => (lvl === 1 ? d.certs : null), fmt: F.int, w: 12, note: 'Certificates in the data for this PO / row, whatever the cut date.' },
        { h: 'Last cert. (all)', v: (x) => x.last, hv: (d, lvl) => (lvl === 1 ? d.last : null), fmt: F.date, w: 12, note: 'The newest certificate date in the data, whatever the cut date.' }],
      linkCols(PL, (x) => x.key, true));
    Object.assign(PL, lettersOf(poCols));
    for (const x of M.pos) for (const k of x.items) { k.tow = x.tow; k.supName = x.supName; }   // repeated on every row, so filters keep them
    const poEntries = byType(M.pos, (x) => x.tow, (x) => x.items);
    const pt = table(po, poCols, poEntries, { top: 3, freezeCol: 3, totalLabelCol: 3, totalLabel: `TOTAL · ${plural(M.pos.length, 'PO')} · follows the filter`, hdrStyle: typeStyle });
    checkCells[1][1] = `ROUND(SUMIFS('PO Register'!$${PL.ta}$${pt.first}:$${PL.ta}$${pt.last},'PO Register'!$${PL.id}$${pt.first}:$${PL.id}$${pt.last},">0")-B${tdRow},2)`;
    landscape(po, '4:5', foot);

    // ================= 5b. PO per Month (the PO Register rows, with qty, rate and amount per period block – like Service per Month)
    const QL = {};
    const pm = wb.addWorksheet('PO per Month', { properties: { tabColor: { argb: 'FF' + TAB.report } } });
    title(pm, 'PO per Month – qty, rate and amount per month, by PO', subF(` · type of works › PO › service + description (− / + at the left folds them) · approved lines; Pending not included · months after the cut date stay blank${roll ? ` · earlier years in one block: Previous years (to ${mLabel(pyEnd)})` : ''} · the 1 / 2 buttons above the columns: 1 = amounts, 2 = qty, rate and amount`));
    const pmKey = (n) => `D_PO,$${QL.po}${n},D_ID,$${QL.id}${n}`;
    const pmCols = poCols.slice(0, 6).map((c) => Object.assign({}, c)).concat(codeCols(QL), [{ h: 'PO qty (SAP)', k: 'poq', v: (x) => x.poQty, fmt: F.qty, w: 11 }]);
    { let tint = false;
      const block = (cols) => { cols[0].bl = true; if (tint) cols.forEach((c) => { c.tint = 'F4F6FA'; }); tint = !tint; pmCols.push(...cols); };
      for (const p of colPeriods) {
        const crit = perCrit(p), off = (f) => perOff(p, f), qk = p.id + 'q', ak = p.id + 'a', gbg = p.py ? '44546A' : undefined;
        block([live({ group: p.label, gbg, h: 'Qty', k: qk, fmt: F.qty, w: 10, olvl: 1, f: (n) => off(`SUMIFS(D_Qty,${pmKey(n)},${crit})`), res: (x) => perRes(x, p, (o) => o.q) }),
          live({ group: p.label, gbg, h: 'Rate', k: p.id + 'r', fmt: F.rate, w: 9, olvl: 1, f: (n) => `IF(ABS(N(${QL[qk]}${n}))<0.000001,"",${QL[ak]}${n}/${QL[qk]}${n})`,
            res: (x) => { const qq = perRes(x, p, (o) => o.q), aa = perRes(x, p, (o) => o.a); return qq != null && Math.abs(qq) > 1e-9 ? r2(aa / qq) : null; } }),
          live({ group: p.label, gbg, h: 'Amount', k: ak, fmt: F.amt, sum: true, w: 12, f: (n) => off(`SUMIFS(D_Amt,${pmKey(n)},${crit})`), res: (x) => perRes(x, p, (o) => o.a) })]);
      }
      block([live({ group: 'To date', gbg: C.navy, h: 'Qty', k: 'tq', fmt: F.qty, w: 12, olvl: 1, f: (n) => `SUMIFS(D_Qty,${pmKey(n)},${PK.td})`, res: (x) => x.td.q }),
        live({ group: 'To date', gbg: C.navy, h: 'Rate', k: 'tr', fmt: F.rate, w: 10, olvl: 1, f: rateF(QL, 'tq', 'ta'), res: (x) => rate(x.td) }),
        live({ group: 'To date', gbg: C.navy, h: 'Amount', k: 'ta', fmt: F.amt, sum: true, w: 14, b: true, f: (n) => `SUMIFS(D_Amt,${pmKey(n)},${PK.td})`, res: (x) => x.td.a }),
        live({ group: 'To date', gbg: C.navy, h: '% of PO qty', k: 'pct', fmt: F.pct, w: 9, f: (n) => `IF(ISNUMBER(${QL.poq}${n}),IF(${QL.poq}${n}=0,"",${QL.tq}${n}/${QL.poq}${n}),"")`,
          res: (x) => (typeof x.poQty === 'number' && x.poQty ? x.td.q / x.poQty : null) })]);
    }
    pmCols.push(...linkCols(QL, (x) => x.key, true));
    Object.assign(QL, lettersOf(pmCols));
    const pmt = table(pm, pmCols, poEntries, { top: 3, freezeCol: 3, totalLabelCol: 3, totalLabel: `TOTAL · ${plural(M.pos.length, 'PO')} · follows the filter`, hdrStyle: typeStyle, summaryRight: true });
    periodCF(pm, QL, QL.id, pmt.first, pmt.last, ['q', 'r', 'a']);
    landscape(pm, '4:5', foot);
    checkCells[2][1] = `ROUND(SUMIFS('PO per Month'!$${QL.ta}$${pmt.first}:$${QL.ta}$${pmt.last},'PO per Month'!$${QL.id}$${pmt.first}:$${QL.id}$${pmt.last},">0")-B${tdRow},2)`;
    for (const [c, f] of checkCells) c.value = { formula: f, result: 0 };

    // ================= 6. Subcontractor Summary (certificates and amount per band – amounts only: qty of different services does not add up)
    const sp = wb.addWorksheet('Subcontractor Summary', { properties: { tabColor: { argb: 'FF' + TAB.sub } } });
    title(sp, 'Subcontractor Summary – certificates and cost by subcontractor', subF(' · grouped by each subcontractor’s main type of works (− / + folds a type) · live: follows the cut date · a certificate = PO + invoice serial · amounts only (quantities of different services do not add up) · per month: the Invoices Register sheet'), SUBT.head);
    const spt = table(sp, supCols, supEntries, { top: 3, freezeCol: 3, totalLabelCol: 3, hdrStyle: typeStyle, theme: SUBT });
    if (spt.first !== spFirst || spt.last !== spLast) throw new Error('Subcontractor Summary layout changed – update the Summary formulas.');
    landscape(sp, '4:5', foot);

    // ================= 7. Invoices Register (the certified volume: certificates and amount per month, per subcontractor and in total)
    const vp = wb.addWorksheet('Invoices Register', { properties: { tabColor: { argb: 'FF' + TAB.sub } } });
    title(vp, 'Invoices Register – certificates and certified amount per month, by subcontractor', subF(` · the TOTAL row = all subcontractors per month (follows the filter) · approved certificates; Pending not included · months after the cut date stay blank${roll ? ` · earlier years in one block: Previous years (to ${mLabel(pyEnd)})` : ''} · the 1 / 2 buttons above the columns: 1 = amounts, 2 = certificates and amounts`), SUBT.head);
    const vpt = table(vp, volCols, supEntries, { top: 3, freezeCol: 3, totalLabelCol: 3, totalLabel: `TOTAL · all ${plural(M.suppliers.length, 'subcontractor')} · follows the filter`, hdrStyle: typeStyle, summaryRight: true, theme: SUBT });
    if (vpt.first !== spFirst || vpt.last !== spLast) throw new Error('Invoices Register layout changed – update the Summary formulas.');
    periodCF(vp, VL, VL.code, vpt.first, vpt.last, ['n', 'a']);
    landscape(vp, '4:5', foot);

    // ================= 8. Checks (review – as made: the app redoes them)
    const ck = wb.addWorksheet('Checks', { properties: { tabColor: { argb: 'FF' + TAB.review } }, views: [{ showGridLines: false }] });
    title(ck, 'Checks – what to look at before sending the report', `${M.plant} · as made for the cut date ${fmtDate(M.cutDate)} – not live: the app redoes these checks · none of these change a figure; they explain it`);
    // one 8-column grid for the summary and every list: A date/unit · B who · C PO/DIV/qty · D amount · E service · F line ID · G description · H serial
    [12, 34, 12, 15, 12, 28, 46, 9].forEach((w, i) => { ck.getColumn(i + 1).width = w; });
    let k = 4; ['Status', 'Check', 'Count', 'Amount', 'What it means'].forEach((h, i) => headCell(ck.getCell(k, i + 1), h)); ck.mergeCells(k, 5, k, 8); k++;
    const ST = { ok: ['✔ OK', C.ok], warn: ['⚠ Check', C.warn], info: ['ℹ Info', C.info] };
    const allChecks = M.codingChecks.concat(M.checks);
    for (const c of allChecks) {
      const vals = [ST[c.status][0], c.title, c.count, c.amount, c.detail];
      ck.mergeCells(k, 5, k, 8);
      vals.forEach((v, i) => { const x = ck.getCell(k, i + 1); x.value = v == null ? null : v; x.border = box; x.font = FONT; x.alignment = { vertical: 'top', wrapText: i === 4 || i === 1 };
        if (i === 0) { x.fill = fill(ST[c.status][1]); x.font = font({ bold: true }); } if (i === 2) x.numFmt = F.int; if (i === 3) x.numFmt = F.amt; });
      ck.getRow(k).height = Math.max(15, Math.ceil(String(c.detail || '').length / 95) * 13, Math.ceil(String(c.title || '').length / 30) * 13);
      k++;
    }
    const MAXL = 200;
    for (const c of allChecks.filter((x) => x.rows && x.rows.length)) {
      k += 1; ck.getCell(k, 1).value = `${c.title} (${c.rows.length})`; ck.getCell(k, 1).font = font({ size: 11, bold: true, color: { argb: 'FF' + C.navy } }); k++;
      c.cols.forEach((h, i) => { if (h) headCell(ck.getCell(k, i + 1), h, C.blue); }); k++;
      for (const row of c.rows.slice(0, MAXL)) { row.forEach((v, i) => { const x = ck.getCell(k, i + 1); x.value = v === '' ? null : v; x.font = FONT; if (typeof v === 'number') x.numFmt = i === 3 ? F.amt : i === 2 ? F.qty : F.int; }); k++; }
      if (c.rows.length > MAXL) { ck.getCell(k, 1).value = `… ${c.rows.length - MAXL} more – see the Coding or Data sheet`; ck.getCell(k, 1).font = FONT_PEND; k++; }
    }
    landscape(ck, null, foot);

    // ================= 9. Changes (review; only with the last report – as made)
    {
      const ch = wb.addWorksheet('Changes', { properties: { tabColor: { argb: 'FF' + TAB.review } }, views: [{ showGridLines: false }] });
      title(ch, `Changes since the previous load (${M.changes.label})`, 'The two latest certificate uploads compared line by line (a newly approved line counts at its full amount). As made – not live.');
      [30, 10, 14, 14, 14, 12, 30, 12, 40, 26].forEach((w, i) => { ch.getColumn(i + 1).width = w; });
      let qq = 4; ch.mergeCells(qq, 1, qq, 2); [[1, 'Measure'], [3, 'Previous load'], [4, 'Latest load'], [5, 'Difference']].forEach(([c, h]) => headCell(ch.getCell(qq, c), h)); qq++;
      for (const m of M.changes.monthTable) {
        ch.mergeCells(qq, 1, qq, 2);
        [[1, m.label], [3, m.was], [4, m.is], [5, m.diff]].forEach(([c, v]) => { const x = ch.getCell(qq, c); x.value = v; x.border = box; x.font = c === 5 ? FONT_B : FONT; if (c > 1) x.numFmt = F.amt; if (c === 5 && Math.abs(v) > 0.5) x.fill = fill(C.warn); });
        qq++;
      }
      qq += 2; ['Change', 'Month', 'Previous load', 'Latest load', 'Difference', 'PO', 'Subcontractor', 'Service', 'Description', 'Line ID'].forEach((h, i) => headCell(ch.getCell(qq, i + 1), h, i === 9 ? '7F7F7F' : C.navy)); const h0 = qq; qq++;
      for (const x of M.changes.rows) {
        [x.type, x.bucket ? bucketLabel(x.bucket) : '', x.was, x.is, x.diff, x.po, x.sup, x.svc, x.text, x.lid].forEach((v, i) => { const c = ch.getCell(qq, i + 1); c.value = v === '' ? null : v; c.font = i === 4 ? FONT_B : i === 9 ? FONT_KEY : FONT; if (i >= 2 && i <= 4) c.numFmt = F.amt; });
        qq++;
      }
      if (M.changes.rows.length) ch.autoFilter = { from: { row: h0, column: 1 }, to: { row: qq - 1, column: 10 } };
      else ch.getCell(qq, 1).value = M.changes.none ? 'Only one certificate upload is loaded, so there is nothing to compare yet.' : 'No line changed between the two latest uploads.';
      landscape(ch, null, foot);
    }

    // ================= 10. Data (one row per certificate line with an amount; every report figure is SUMIFS on it)
    const da = wb.addWorksheet('Data', { properties: { tabColor: { argb: 'FF' + TAB.data } } });
    da.columns = D.map(([h, w, , fmt, kind]) => ({ header: h, width: w, style: Object.assign(fmt ? { numFmt: fmt } : {}, { font: kind === 'amt' ? FONT_B : kind === 'key' ? FONT_KEY : FONT }) }));
    const cCt = dc('Contract type'), cVr = dc('VAT rate'), cGp = dc('Gross price'), cNr = dc('Net rate'), cSq = dc('SAP qty'), cAm = dc('Amount'), cRu = dc('Rate'), cPl = dc('PO line'), cLt = dc('Line type');
    const cId = dc('Coding ID'), cRow = dc('Coding row'), cAp = dc('Approved'), cFl = dc('Opening (Flag)'), cMk = dc('Month key'), cDt = dc('Cert. date'), cPk = dc('Period key');
    const iNr = ix('Net rate'), iQ = ix('Qty'), iRu = ix('Rate'), iRow = ix('Coding row'), iPk = ix('Period key'), iPer = ix('Period'), iWhy = ix('Pending reason');
    // rows in the report's order (type of works › service › description), each Service + Description by period, date, PO, certificate
    const cPos = new Map(crows.map((x, i) => [x.key, i])), pOrd = (b) => (b === 'Opening' ? 0 : b === 'Pending' ? 2 : 1);
    const nat = (a, b) => String(a || '').localeCompare(String(b || ''), 'en', { numeric: true });
    const dLines = M.lines.slice().sort((a, b) => cPos.get(a.ckey) - cPos.get(b.ckey) || pOrd(a.bucket) - pOrd(b.bucket) || nat(a.bucket, b.bucket) ||
      (a.date ? +a.date : 0) - (b.date ? +b.date : 0) || nat(a.po, b.po) || nat(a.serial, b.serial) || nat(a.item, b.item) || nat(a.pkg, b.pkg) || nat(a.line, b.line));
    { const seen = new Set(); for (const l of dLines) { const k = E.certOf(l); if (!seen.has(k)) { seen.add(k); certFirst.add(l); } } }
    dLines.forEach((l, k2) => {
      const n = k2 + 2; const vals = D.map(([, , f]) => (f ? f(l) : null));
      vals[iNr - 1] = { formula: `IF(${cCt}${n}="A2",${cGp}${n}/(1+${cVr}${n}),${cGp}${n})`, result: r2(l.net * 1e4) / 1e4 };
      // Rate: a normal line's own net rate; an adjustment uses the rate its PO line was certified at (its normal lines)
      vals[iRu - 1] = l.ltype === 'Normal' ? { formula: `${cNr}${n}`, result: r2(l.net * 1e4) / 1e4 }
        : { formula: `IFERROR(SUMIFS(${cAm}$2:${cAm}$${nData},${cPl}$2:${cPl}$${nData},${cPl}${n},${cLt}$2:${cLt}$${nData},"Normal")/SUMIFS(${cSq}$2:${cSq}$${nData},${cPl}$2:${cPl}$${nData},${cPl}${n},${cLt}$2:${cLt}$${nData},"Normal"),${cNr}${n})`, result: r2(l.rateUsed * 1e4) / 1e4 };
      vals[iQ - 1] = { formula: `IF(${cLt}${n}="Normal",${cSq}${n},IF(${cRu}${n}=0,${cSq}${n},${cAm}${n}/${cRu}${n}))`, result: r3(l.rq) };
      // the period follows the cut date: not approved, no date or dated after it → Pending (999999); Flag X → Opening (0); else its month
      vals[iPk - 1] = { formula: `IF(OR(${cAp}${n}<>"X",${cMk}${n}="",${cDt}${n}>CutDate),${PEND},IF(${cFl}${n}="X",0,${cMk}${n}))`, result: keyOf(l.bucket) };
      vals[iPer - 1] = { formula: `IF(${cPk}${n}=${PEND},"Pending",IF(${cPk}${n}=0,"Opening",INT(${cPk}${n}/100)&"-"&TEXT(MOD(${cPk}${n},100),"00")))`, result: l.bucket };
      vals[iWhy - 1] = { formula: `IF(${cAp}${n}<>"X","Not approved",IF(${cMk}${n}="","No date",IF(${cDt}${n}>CutDate,"After cut date","")))`, result: l.pend || '' };
      vals[iRow - 1] = { formula: match(`${cId}${n}`), result: rowNo.get(l.ckey) };
      for (const f of F4) vals[ix(E.FIELD_NAME[f]) - 1] = { formula: lookup(f, `$${cRow}${n}`), result: l[f] || '' };
      da.addRow(vals);
    });
    da.getRow(1).eachCell((c, i) => headCell(c, c.value, D[i - 1][4] === 'code' ? C.gold : D[i - 1][4] === 'key' ? '7F7F7F' : C.navy)); da.getRow(1).height = 30;
    const dNote = { Period: 'Live: where the line counts for the cut date on the Summary – Opening (initial invoice, Flag = X), its month (YYYY-MM), or Pending (not approved, no date, or dated after the cut date – never in To date).',
      Rate: 'Net rate for a normal line. For an adjustment (paid-% change, reversal, re-price): the rate its PO line was certified at = Σ Amount ÷ Σ SAP qty of the normal lines of the same PO line.',
      Qty: 'SAP qty for a normal line; Amount ÷ Rate for an adjustment – so qty always moves with the money.', Amount: 'SC Work Current Cost from ZSCPRG01, EGP excl. VAT.',
      'Period key': 'The number behind Period (Opening 0 · month yyyymm · Pending 999999). Every report figure is SUMIFS on it (named range D_PK), compared with RepKey = the month of the cut date.',
      'Line ID': 'SAP key of the line: PO | invoice serial | item | number | line. The app uses it to compare this report with the next one.', 'PO line': 'PO | item | number | line – the PO service line (used for the certified rate).',
      'Cert. count': '1 on one line of each certificate (PO + invoice serial), blank on its other lines – so SUMIFS on it (named range D_Cert) counts certificates: the subcontractor sheets and the Summary use it.',
      'Coding ID': 'The row of this Service + Description on the Coding sheet (the codes on the left come from there).' };
    for (const [h, t] of Object.entries(dNote)) da.getRow(1).getCell(ix(h)).note = t;
    da.views = [{ state: 'frozen', xSplit: 3, ySplit: 1 }];
    landscape(da, '1:1', foot);
    da.autoFilter = { from: { row: 1, column: 1 }, to: { row: nData, column: D.length } };

    // ================= 11. Notes
    const no = wb.addWorksheet('Notes', { properties: { tabColor: { argb: 'FF' + TAB.data } }, views: [{ showGridLines: false }] });
    no.getColumn(1).width = 4; no.getColumn(2).width = 130;
    no.getCell('B1').value = 'How this report is built – you can redo every step by hand'; no.getCell('B1').font = font({ size: 14, bold: true, color: { argb: 'FF' + C.navy } });
    const notes = [
      ['h', 'A live workbook'],
      ['', 'The one input is the cut date on the Summary (cell B4). Pick a month end from its list (▼) – or type another date, e.g. 25-Aug-2026 for a mid-month cut – and every sheet follows: the report month is the month of that date, This month = that month up to the cut date, Previous = everything before that month, To date = Previous + This month, Pending = not approved, no date, or dated after the cut date. No need to go back to the app.'],
      ['', 'How: on the Data sheet each line’s Period key is a formula on the cut date (Opening 0 · its month yyyymm · Pending 999999). Every report figure is SUMIFS on the Data sheet with named ranges – e.g. To date of a row = SUMIFS(D_Amt, D_ID, its Coding ID, D_PK, "<="&RepKey). Certificates are counted the same way on the Data column Cert. count (D_Cert: 1 on one line of each certificate). Select a cell to read its formula.'],
      ['', 'Not live: the Checks and Changes sheets (as made – the app redoes them when it exports again) and the list of rows (every Service + Description, subcontractor and PO in the data, whatever the cut date). New SAP data still comes in through the app (Upload).'],
      ['h', 'Inputs – every month'],
      ['', 'ZSCPRG01 (SAP certificate lines) and ZSCSRV1 (SAP PO service lines: unit, type of works, PO quantities) – the new data. The coding is kept in the app, not in this file (see Coding).'],
      ['', 'Everything on the Data sheet comes from the app’s certificate lines; the Changes sheet compares the app’s two latest certificate uploads.'],
      ['h', 'Coding (the Coding sheet)'],
      ['', 'The coding comes from the app: DIV = the service’s work package (Work packages page), PKG and Cost element are left blank for you to fill (your own catalogue codes, which the app does not store), MNL = the Subcontract cost type’s code (SUB, Cost types page). Typing here changes this file only – the app does not read it back. One row per Service + Description, in the type-of-works order (your order) › service (largest first) › description (largest first); each service and each unit has its own colour. The yellow cells are the coding: DIV, PKG, MNL, Cost element. Type any code or pick one from the drop-down – it lists the codes on the Lists sheet plus every code already typed in that column, so a code typed once is offered on every row. Empty yellow cells turn orange. The band above the header counts, live, the services still to code (a service = one Service + Description row), the services missing each code, the coded share of To date and the amount not yet fully coded. The Lists sheet shows the same per type of works: services, service codes, coded, to code, To date.'],
      ['', 'Service Summary, Service per Month, PO Register, Data and the Summary DIV table read the Coding sheet live: code here and they update at once. Whatever is not coded yet is shown on one "Not coded" line, so nothing is missing. Code services in the app and export again.'],
      ['', 'Reference data comes from SAP and is never typed: unit from ZSCSRV1, type of works from each line’s PO. A row used on POs of different types is grouped under its main type (the PO Register shows each PO); the POs column counts the POs a row is certified on. Summary table 3 splits exactly by PO.'],
      ['h', 'Grouping and sorting'],
      ['', 'Every report sheet is grouped by type of works, in your order: the type row carries its subtotals, and the − / + at the left (or the 1 / 2 / 3 buttons above it) folds a type to that one row. The PO Register has a second level: type of works › PO › service + description. The TOTAL row at the top follows the filter and never double counts the type rows.'],
      ['', 'Service per Month: the codes (live from the Coding sheet), then one block per period – Qty, Rate, Amount. When the data spans more than one year the earlier years can be rolled into one block, Previous years (when the data spans more than one year), so the current year stays month by month. There are no year totals: a sheet copied elsewhere and added up never counts a month twice. The 1 / 2 buttons above the columns: 1 = amounts, 2 = qty, rate and amount.'],
      ['', 'Subcontractor Summary: per subcontractor, certificates and amount for Previous, This month, To date (with its share of all) and Pending. A certificate = PO + invoice serial, counted once. Invoices Register: the certified volume – certificates and certified amount per month for each subcontractor; the TOTAL row at the top is all subcontractors per month (it follows the filter). Earlier years are rolled like Service per Month.'],
      ['', 'Sorting: Excel cannot sort a list that holds subtotal rows (it offers to remove them). On the grouped report sheets use the filters – they work as usual. The Coding and Data sheets are plain lists: sort and filter them freely; the links to the report stay right whatever the order.'],
      ['', 'PO per Month: the PO Register rows (type of works › PO › service + description) with qty, rate and amount per month, like Service per Month – earlier years rolled the same way, To date with % of PO qty.'],
      ['', 'PO Register: PO qty is the ZSCSRV1 quantity of the PO lines with that service and description. Lines SAP marks "Unlimited" hold an estimate only (often a placeholder), so they show "Unlimited" and no % of PO qty.'],
      ['', 'Service Summary – rate analysis (right of Pending). This month vs previous: the previous rate (to last month) and this month’s rate, Change per unit, Change % and Value = this month’s qty × the change, i.e. this month’s amount − its qty at the previous rate. Since the start: First month (the first month with quantity; Opening = the go-live invoice), Start rate (that month’s rate), To date rate, Change, Change % and Value = to-date qty × the change, i.e. what the work to date cost more (+) or less (−) than at the first month’s rate. When two rates differ more than 3 times (or one is not positive) the row shows "check" and is left out of the totals: a placeholder price (e.g. qty = amount at rate 1) or another unit, not a price change.'],
      ['h', 'Steps (the Data sheet is the result of steps 1–8; every other sheet is SUMIFS on it)'],
      ['1', 'In ZSCPRG01 delete the rows with an empty "Pur. Doc." – they are SAP subtotals ("C1 (17)") and the grand total.'],
      ['2', 'WBS repeats: when SAP splits a certificate line over several WBS elements it repeats the line, with the FULL amount, on every WBS row. Rows with the same PO + Invoice serial + Item + Number + Line are one line – keep one. (This is why SAP’s grand total is higher than the report.)'],
      ['3', 'Delete rows whose "SC Work Current Cost" is 0 – SAP lists every PO line on each certificate, also when nothing was certified.'],
      ['4', 'Net rate = Gross price, or Gross price ÷ (1 + VAT rate) when the contract type (نوع العقد) is A2 (price includes VAT). VAT rates: ' + Object.keys(M.vat).sort().map((kk) => `${kk} ${Math.round(M.vat[kk] * 100)}%`).join(', ') + '.'],
      ['5', 'Line type: Normal when Amount = SAP Current Quantity × Net rate (within 1 EGP). Anything else is an Adjustment: Progress % below 100, a hold or its release, a reversal to 0 %, a re-price, or an amount on a placeholder 0.01 quantity.'],
      ['6', 'Qty: a Normal line keeps SAP’s Current Quantity. An Adjustment is turned into quantity at the rate its PO line was certified at: Σ Amount ÷ Σ SAP qty of the Normal lines with the same PO line (PO + Item + Number + Line); with no Normal line, its own net rate. So a reversal takes back exactly the quantity it reverses, even when SAP re-set the price (e.g. to 0.10).'],
      ['7', 'Period (live): Character 1 ≠ X (not approved) → Pending. No certificate date, or a date after the cut date (Summary B4) → Pending. Flag = X → Opening (initial invoice entered at go-live). Otherwise the month of the certificate date.'],
      ['8', 'Coding: each line takes DIV, PKG, MNL and Cost element from its Service + Description row on the Coding sheet (Data columns "Coding ID" / "Coding row" show the link).'],
      ['9', 'Pivot or SUMIFS the Data sheet: rows = Service + Description (or DIV, PKG, MNL, Cost element, Type of works), columns = Period, values = Sum of Qty and Sum of Amount. Previous = Opening + months before the report month; This month = the report month; To date = Previous + This month; Pending is shown but never added to To date.'],
      ['h', 'The Data sheet'],
      ['', 'One row per certificate line with an amount, sorted like the report (type of works › service › description), each Service + Description by period and certificate date. Columns from left to right: what (type of works, service, description, unit) · coding (from the Coding sheet) · when (period, certificate date) · who (subcontractor, PO, certificate serial) · Qty, Rate and Amount (bold) · how each figure was calculated (line type, approval, SAP qty, gross price, contract type, VAT, net rate…) · and at the far right, in grey, the keys the formulas and the app use (Month key, Period key, Cert. count, PO line, Line ID, Coding ID). Hover over a header with a red corner for its meaning.'],
      ['h', 'Sheets'],
      ['', 'Report (blue): Summary · Service Summary · Service per Month · PO Register · PO per Month. Subcontractors (teal): Subcontractor Summary · Invoices Register. Coding (gold): Coding · Lists (code names; codes you type on the Coding sheet join it). Review (orange): Checks · Changes. Data (grey): Data · Notes. Every sheet follows the type-of-works order on the Lists sheet.'],
      ['h', 'Good to know'],
      ['', 'SAP labels "Account Number of Supplier" (it holds the NAME) and "Supplier" (it holds the CODE) the wrong way round – the report uses them correctly.'],
      ['', 'The cost of a month can still change after it was reported: a certificate dated in that month may be approved later. The Changes sheet lists such changes.'],
    ];
    let n = 3;
    for (const [t, s] of notes) {
      const c = no.getCell(n, 2);
      if (t === 'h') { n++; c.value = s; c.font = font({ size: 11, bold: true, color: { argb: 'FF' + C.navy } }); }
      else { c.value = t ? `${t}.  ${s}` : s; c.alignment = { wrapText: true, vertical: 'top' }; c.font = FONT; no.getRow(n).height = Math.max(15, Math.ceil(c.value.length / 140) * 13.5 + 3); }
      n++;
    }

    // ================= hidden: _Legacy (older service-level coding, still offered as suggestions), _Meta, _Ref
    if (cst.legacy.size) {
      const lg = wb.addWorksheet('_Legacy', { state: 'hidden' }); lg.addRow(['Service', 'DIV', 'PKG', 'MNL', 'Cost element']);
      for (const [svc, v] of cst.legacy) lg.addRow([svc, v.div || null, v.pkg || null, v.mnl || null, v.ce || null]);
    }
    const me = wb.addWorksheet('_Meta', { state: 'hidden' });
    // 'Report month' (row 4, name RepKey) and 'Cut date' follow the Summary input, so the app reads back what the user last set
    [['Tool', 'Subcontract Cost Report'], ['Version', M.version], ['Plant', M.plant], ['Report month', { formula: 'YEAR(CutDate)*100+MONTH(CutDate)', result: M.reportMonth }], ['Cut date', { formula: 'CutDate', result: M.cutDate }],
      ['Generated', M.generated], ['Saved', new Date().toISOString()],
      ['ZSCPRG01', M.files.prog || ''], ['ZSCSRV1', M.files.serv || ''], ['Coding from', M.files.coding || M.files.prev || ''], ['Last report', M.files.prev || ''],
      ['Profit centre', M.pc || ''], ['SAP grand total', M.T.footer == null ? '' : M.T.footer], ['ZSCPRG01 rows', M.counts.rawRows], ['Summary rows', M.counts.summaryRows || 0],
      ['Zero lines', M.counts.zeroLines], ['Qty-only lines', M.counts.qtyOnly], ['ZSCSRV1 lines', M.counts.servLines || 0], ['WBS repeat rows', M.counts.dupRows || 0], ['WBS split lines', M.counts.dupLines || 0], ['Changes vs', M.changes ? M.changes.month : ''],
      ['Data from', M.fromReport ? 'report ' + (M.files.via || '') : 'SAP files'], ['Older years', M.olderYears ? (roll ? 'Rolled into Previous years' : 'Every month') : '']].forEach((x) => me.addRow(x));
    me.getCell('B5').numFmt = F.date;
    const calWs = wb.addWorksheet('_Cal', { state: 'hidden' });         // the cut dates of the drop-down on the Summary (B4)
    calWs.getCell('A1').value = 'Cut date (month end)'; calWs.getColumn(1).width = 16;
    cutList.forEach((d, i) => { const c = calWs.getCell(i + 2, 1); c.value = d; c.numFmt = F.date; });
    const rf = wb.addWorksheet('_Ref', { state: 'hidden' });         // ZSCSRV1 facts the Data sheet does not hold
    rf.addRow(['PO', 'Type of works', 'PO title', 'Service', 'Description', 'PO qty']);
    for (const x of M.pos) { rf.addRow([x.po, x.tow || null, x.title || null]); for (const kk of x.items) if (kk.poQty != null) rf.addRow([x.po, null, null, kk.svc, kk.desc, kk.poQty]); }

    // the names the formulas use
    wb.definedNames.add('Summary!$B$4', 'CutDate');
    wb.definedNames.add('_Meta!$B$4', 'RepKey');
    for (const [name, h] of Object.entries(NAMES)) wb.definedNames.add(`Data!$${dc(h)}$2:$${dc(h)}$${nData}`, name);

    wb.views = [{ activeTab: 0 }];
    wb.calcProperties = { fullCalcOnLoad: true };
    return wb;
  }
  async function writeReport(M, ExcelJS) {
    return (await buildReportWorkbook(M, ExcelJS)).xlsx.writeBuffer();
  }

  return { writeReport, buildReportWorkbook };
}

const W = makeWriter(E);

export const writeReport = W.writeReport;
export const buildReportWorkbook = W.buildReportWorkbook;
export { buildModel, mKey, mLabel, keyToM, nextM, prevM, ckey, normText, normTow, tally, top, r2, r3, lastDay, ymOf };
