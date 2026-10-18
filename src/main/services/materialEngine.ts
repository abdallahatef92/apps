// @ts-nocheck
/*
 * Port of the Material Cost Report 1.2 engine (DesktopMaterail ReportMaterial_Cost_Report_v1.2.html, engine L459-1308) -
 * only what the Excel report needs: the SAP material-group tree helpers, the line model (mkLine), the ME2N index
 * (meLine / meIndex), the coding state, build() with applyCoding(), and the rate rules. Copied nearly verbatim, so the
 * workbook builder (materialWorkbook.ts, the tool's writer) sees exactly the M object it was written for.
 *
 * What is NOT ported, because the database replaces it: the file parsers (parseMB51, parseME2N, parseMaster), file
 * detection, the "last report" / report-alone round trip (parsePrevious, fromReport, parseChanges) and insights().
 * The group catalogue is read from dim_material_group (setGroupCatalogue) instead of being baked in.
 */
const VERSION = '1.2';
const TOOL = 'Material Cost Report';

  // ---------------------------------------------------------------- helpers
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
  function readDate(v) {                          // Excel serial, Date or text -> UTC midnight Date
    if (v instanceof Date) return isNaN(v) ? null : new Date(Date.UTC(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate()));
    if (typeof v === 'number' && v > 0) { const d = new Date(Math.round((v - 25569) * 864e5)); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); }
    const s = str(v); let m;
    if ((m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/.exec(s))) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
    if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s))) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return null;
  }
  function tally(map, key, val, w) { if (!key) return; let t = map.get(key); if (!t) map.set(key, t = new Map()); t.set(val, (t.get(val) || 0) + (w == null ? 1 : w)); }
  function top(t) { if (!t) return ''; let best = '', bw = -Infinity; for (const [k, w] of t) if (w > bw && k !== '') { best = k; bw = w; } return best; }
  const header = (aoa) => (aoa && aoa[0] ? aoa[0].map((x) => str(x)) : []);
  function findCols(hdr, spec, optional, label) {
    const low = hdr.map((h) => h.toLowerCase()), C = {}, missing = [];
    for (const [k, name] of Object.entries(spec)) {
      const i = low.indexOf(name.toLowerCase());
      if (i >= 0) C[k] = i; else if (!optional.includes(k)) missing.push(`"${name}"`);
    }
    if (missing.length) throw new Error(`${label}: the file has no ${missing.join(', ')} column${missing.length > 1 ? 's' : ''}. Export it again with the standard layout.`);
    return C;
  }
  const coll = new Intl.Collator('en', { numeric: true });
  const zero = (v) => (v === '0' ? '' : v);           // SAP writes 0 for an empty reservation / PO item
  // --------------------------------------------------------- movement rules
  // The movements that are material cost on the project, and the issue type each one is (the "resource" of this report)
  const ISSUE = { '221': 'P', '222': 'P', '281': 'P', '282': 'P', Z21: 'S', Z22: 'S', '551': 'X', '552': 'X', '553': 'X', '554': 'X', '555': 'X', '556': 'X' };
  const ITYPE = { P: 'Project', S: 'To subcontractors', X: 'Scrap' };
  // Every other movement is not project cost. The known ones are listed for information; a type not in these rules is flagged.
  const OUTSIDE = [
    [/^(101|102|103|104|105|106|122|123|124|125|161|162)$/, 'Receipts, and returns to the vendor'],
    [/^(301|302|303|304|305|306|309|310|311|312|313|314|315|316|351|352|641|642|643|644)$/, 'Transfers between plants and storage locations'],
    [/^(601|602|651|652|653|654)$/, 'Deliveries'],
    [/^(261|262)$/, 'Issued to orders – not project cost'],
    [/^(201|202)$/, 'Issued to cost centres – not project cost'],
    [/^(241|242|291|292)$/, 'Issued to assets or other objects – not project cost'],
    [/^(541|542|543|544)$/, 'Provided to subcontractor stock (not consumed yet)'],
    [/^(561|562|563|564|565|566)$/, 'Initial entry of stock balances'],
    [/^(701|702|707|708|711|712|717|718)$/, 'Inventory differences'],
    [/^Z5\d$/, 'Owner-supplied (customer) stock'],
    [/^Z8\d$/, 'Scrap taken back from the project'],
  ];
  const outsideOf = (mvt) => { for (const [re, g] of OUTSIDE) if (re.test(mvt)) return g; return ''; };

// ---- the SAP material-group tree: the catalogue (code -> description) comes from dim_material_group
const GN = new Map();
export function setGroupCatalogue(rows) { GN.clear(); treeCache.clear(); for (const [k, v] of rows) if (str(k)) GN.set(str(k), str(v)); }

  // the families (the letters of a group code): what kind of resource it is, in this order on every sheet
  const FAMILY = [['M', 'Materials'], ['P', 'Plant & tools'], ['SP', 'Spare parts, oils & fuel'], ['SM', 'Safety'], ['SH', 'Site housing'], ['CS', 'Consumables & buffet'],
    ['OS', 'Office supplies'], ['IT', 'IT'], ['G', 'General hardware'], ['A', 'Assets'], ['SR', 'Survey spares'], ['SC', 'Scrap'], ['S', 'Services'], ['MTEX', 'Vehicle maintenance'],
    ['L', 'Labour'], ['OVM', 'Overhead'], ['WST', 'Wastage']];
  const FAM_NAME = new Map(FAMILY), FAM_RANK = new Map(FAMILY.map(([k], i) => [k, i]));
  const MNLS = [['MAT', 'Material'], ['SUB', 'Subcontract'], ['EQU', 'Equipment'], ['LAB', 'Labour'], ['OTHER', 'Other resources']];
  const NO_GRP = '(no material group)', NO_WBS = '(no WBS)', NOT_CODED = '(not coded)';
  const famOf = (g) => { const m = /^[A-Z&]+/.exec(str(g)); return m ? m[0] : ''; };
  // the branch of a group, top first: family, then every code of the catalogue that the group code starts with, then the group
  // (M030201 -> M · M03 · M0302 · M030201). One-digit nodes such as M0 "Complex Resources" span every division and are left out.
  const treeCache = new Map();
  function treeOf(g) {
    g = str(g); if (!g) return [];
    let t = treeCache.get(g); if (t) return t;
    const f = famOf(g); t = [f || g];
    for (let n = f.length + 2; n < g.length; n++) { const k = g.slice(0, n); if (GN.has(k)) t.push(k); }
    if (g !== t[0]) t.push(g);
    treeCache.set(g, t); return t;
  }
  // the division of a group: the family + two digits when the catalogue has it (M03, P04), else the family itself (SP012 -> SP)
  const divOf = (g) => { const t = treeOf(g); return t.length > 1 && /^[A-Z]+\d{2}$/.test(t[1]) ? t[1] : t[0] || ''; };
  const nodeName = (k) => GN.get(k) || FAM_NAME.get(k) || '';
  const grpLabel = (k) => (!k ? NO_GRP : nodeName(k) ? `${k} · ${nodeName(k)}` : k);
  // the three levels every sheet groups on: family › division › group. A family with no two-digit divisions in SAP (SP, SC, MTEX …)
  // has its groups straight under it: its division level reads "no SAP division"
  const realDiv = (g) => { const d = divOf(g); return d && d !== famOf(g) ? d : ''; };
  const famLabel = (g) => (!g ? NO_GRP : grpLabel(famOf(g) || g));
  const divLabel = (g) => (!g ? NO_GRP : realDiv(g) ? grpLabel(realDiv(g)) : `${famOf(g) || g} · no SAP division`);
  // tree order: family (in the order above), then the codes – a parent before its children, CSI order within
  const treeKey = (g) => { const f = famOf(g); return [FAM_RANK.has(f) ? FAM_RANK.get(f) : 99, f, str(g)]; };
  function treeCmp(a, b) {
    if (!a || !b) return (a ? 0 : 1) - (b ? 0 : 1);
    const x = treeKey(a), y = treeKey(b); return x[0] - y[0] || (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0) || (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0);
  }
  // WBS group = the element two levels down (C-DIST.01-03-3-08-BULD -> C-DIST.01-03); a shorter element is its own group
  const wbsGroup = (w) => { w = str(w); if (!w || w === NO_WBS) return NO_WBS; const m = /^([^.]+\.[^-]+-[^-]+)/.exec(w); return m ? m[1] : w; };
  const vendorName = (v) => { const c = str(v).split(' ')[0] || ''; return str(v).slice(c.length).trim() || c; };
  function mkLine(o) { o.rq = o.sapQty ? -o.sapQty : 0; o.amt = o.sapAmt ? -o.sapAmt : 0; o.cls = ISSUE[o.mvt] || 'P'; return o; }
  // a supplying plant or storage location (SBD1, C002) instead of a vendor number = a stock transport order from own stores
  function meLine(x) { x.vcode = x.vendor.split(' ')[0] || ''; x.kind = /^\d+$/.test(x.vcode) ? 'PUR' : 'STO'; x.unitPrice = x.netPrice ? x.netPrice / (x.priceUnit || 1) : 0; return x; }
  // what ME2N tells about each material (also rebuilt from a saved report): group, unit, POs, suppliers, PO prices
  function meIndex(me) {
    const grp = new Map(), unit = new Map(), sup = new Map(), pos = new Map(), priced = new Map(), pl = new Map();
    for (const l of me.lines) {
      tally(grp, l.material, l.group); tally(unit, l.material, l.unit); tally(pl, 'p', l.plant);
      if (l.del === 'L') continue;                     // deleted items are neither ordered nor open
      tally(pos, l.material, l.po);
      if (l.kind !== 'PUR') continue;                  // stock transfers from own stores carry no price
      tally(sup, l.material, l.vendor, Math.abs(l.value) + 1);
      if (l.unitPrice > 0) { const a = priced.get(l.material); if (a) a.push(l); else priced.set(l.material, [l]); }
    }
    const info = new Map();
    for (const [m, t] of grp) {
      const pl2 = (priced.get(m) || []).sort((a, b) => (a.date ? +a.date : 0) - (b.date ? +b.date : 0) || coll.compare(a.po, b.po) || coll.compare(a.item, b.item));
      const q = pl2.reduce((s, l) => s + l.qty, 0), last = pl2[pl2.length - 1];
      const s = sup.get(m), sl = s ? [...s].sort((a, b) => b[1] - a[1]).map(([k]) => k) : [];
      info.set(m, { group: top(t), unit: top(unit.get(m)), poCount: pos.get(m) ? pos.get(m).size : 0, suppliers: sl,
        wavg: pl2.length ? (q > 0 ? pl2.reduce((s2, l) => s2 + l.unitPrice * l.qty, 0) / q : pl2.reduce((s2, l) => s2 + l.unitPrice, 0) / pl2.length) : null,
        last: last ? { price: last.unitPrice, date: last.date, po: last.po, vendor: last.vendor } : null, nPrice: pl2.length });
    }
    return Object.assign(me, { info, plant: top(pl.get('p')), pos: new Set(me.lines.map((l) => l.po)).size });
  }
  const FIELDS = ['pkg', 'mnl', 'ce'];
  const FIELD_NAME = { pkg: 'PKG', mnl: 'MNL', ce: 'Cost element' };
  // codes are what the user types (spaces tidied); "conc" and "Conc" are one code – the spelling already on the list wins
  const normCode = (c) => str(c).replace(/\s+/g, ' ');
  const normField = (f, v) => normCode(v);
  const sameCode = (a, b) => String(a).toUpperCase() === String(b).toUpperCase();
  function canon(list, code) {                         // the list's spelling of a code; a new code joins the list (the list = every code in use)
    if (!code) return ''; const x = list.find((y) => sameCode(y[0], code)); if (x) return x[0]; list.push([code, '']); return code;
  }
  // the coding being worked on: the codes of each material, the code lists
  function codingState(file) {
    const lists = { pkg: [], mnl: MNLS.map((x) => x.slice()), ce: [] };
    if (file) for (const f of FIELDS) if (file.lists[f].length) lists[f] = file.lists[f].map((x) => x.slice());
    const codes = new Map(), fileKeys = new Set(), added = [];
    const ensure = (f, code) => { const n = lists[f].length, c = canon(lists[f], code); if (lists[f].length > n) added.push(`${FIELD_NAME[f]} ${c}`); return c; };
    if (file) for (const r of file.rows) {
      fileKeys.add(r.mat);
      const c = { mat: r.mat, desc: r.desc }; for (const f of FIELDS) c[f] = ensure(f, r[f]);
      if (FIELDS.some((f) => c[f])) codes.set(r.mat, c);
    }
    return { codes, lists, poTypes: new Map(file && file.poTypes ? file.poTypes : []), fileKeys, added, hasFile: !!file, old: !!(file && file.old), v10: !!(file && file.v10), v11: !!(file && file.v11),
      plant: file ? file.plant : '', saved: file ? file.saved : null };
  }
  // the codes of a material ('' where none)
  function codeOf(cst, mat) { const o = cst.codes.get(mat) || {}, out = {}; for (const f of FIELDS) out[f] = o[f] || ''; return out; }
  // ------------------------------------------------------- month choices
  // months a report can be made for, and the default: the newest month in the data, but not one that has not ended yet
  function monthChoices(mb, today) {
    const ms = new Set(); for (const l of mb.lines) if (l.date && l.amt) ms.add(ymOf(l.date));
    const list = [...ms].sort((a, b) => a - b);
    if (!list.length) return { list: [], def: null };
    const full = []; for (let m = list[0]; m <= list[list.length - 1]; m = nextM(m)) full.push(m);
    const t = today || new Date(); const lastClosed = prevM(t.getFullYear() * 100 + t.getMonth() + 1);
    const newest = list[list.length - 1];
    return { list: full, def: newest <= lastClosed ? newest : Math.max(list[0], Math.min(newest, lastClosed)) };
  }

  // ---- pivot: per group, qty, amount and issue documents per bucket, then Previous / This month / To date / Pending
  // (an issue document = material document + year: one posting date – so it sits in one bucket)
  const docOf = (l) => l.doc + '|' + l.year;
  function pivotLines(lines, curKey, keyFn, makeFn) {
    const m = new Map();
    for (const l of lines) {
      const k = keyFn(l); let g = m.get(k);
      if (!g) { g = makeFn(l); g.b = new Map(); g.n = 0; m.set(k, g); }
      let c = g.b.get(l.bucket); if (!c) g.b.set(l.bucket, (c = { q: 0, a: 0, cs: new Set() })); c.q += l.rq; c.a += l.amt; c.cs.add(docOf(l)); g.n++;
      if (g.tally) g.tally(l);
    }
    const out = [...m.values()];
    for (const g of out) {
      const pick = (f) => { let q = 0, a = 0, n = 0; for (const [b, c] of g.b) if (f(b)) { q += c.q; a += c.a; n += c.cs.size; } return { q: r3(q), a: r2(a), n }; };
      g.prev = pick((b) => b !== 'Pending' && b < curKey);
      g.cur = pick((b) => b === curKey);
      g.td = { q: r3(g.prev.q + g.cur.q), a: r2(g.prev.a + g.cur.a), n: g.prev.n + g.cur.n };
      g.pend = pick((b) => b === 'Pending');
      g.at = (b) => { const c = g.b.get(b); return c ? { q: r3(c.q), a: r2(c.a), n: c.cs.size } : { q: 0, a: 0, n: 0 }; };
      // the first month with cost (Pending never counts)
      g.firstB = [...g.b.keys()].filter((b) => b !== 'Pending' && Math.abs(g.b.get(b).a) > 0.005).sort()[0] || null;
      delete g.tally;
    }
    return out;
  }
  const weigh = () => { const t = new Map(); return { t, add: (k, w) => t.set(k, (t.get(k) || 0) + Math.abs(w)) }; };
  const split = (t) => { const e = [...t].filter(([k]) => k).sort((a, b) => b[1] - a[1]), all = e.reduce((s, [, w]) => s + w, 0) || 1; return e.map(([k, w]) => [k, w / all]); };
  // ================================================================ BUILD (SAP data → lines, reference data, checks)
  function build(input) {
    const { mb, me, prev, master } = input;
    const cst = input.cstate || codingState(input.coding || null);
    const cutIn = input.cutDate ? readDate(input.cutDate) : null;
    const reportMonth = cutIn ? ymOf(cutIn) : input.reportMonth || monthChoices(mb, input.today).def;
    if (!reportMonth) throw new Error('MB51 has no dated issue with an amount.');
    const curKey = mKey(reportMonth), cutDate = cutIn || lastDay(reportMonth);      // default: the last day of the report month
    const plant = mb.plant;
    const notes = [];

    // reference data per material (from SAP – never typed by the user): group from ME2N, else the material master, else the last
    // report; material type from the master (else the last report); unit and description from MB51 (unit: else ME2N); POs,
    // suppliers and PO prices from ME2N
    const knownGrp = (prev && prev.groups) || input.groups || new Map(), knownType = (prev && prev.types) || input.types || new Map();
    const mm = master ? master.map : new Map();
    const units = new Map(), descs = new Map();
    for (const l of mb.lines) { tally(units, l.material, l.unit); tally(descs, l.material, l.desc); }
    const matInfo = new Map();
    const infoOf = (mat, desc) => {
      let s = matInfo.get(mat); if (s) return s;
      const mi = me ? me.info.get(mat) : null, ms = mm.get(mat) || null, mbUnit = top(units.get(mat));
      const group = (mi && mi.group) || (ms && ms.group) || knownGrp.get(mat) || '';
      s = { mat, group, grpSrc: mi && mi.group ? 'ME2N' : ms && ms.group ? 'Material list' : group ? 'Last report' : '', type: (ms && ms.type) || knownType.get(mat) || '',
        fam: famOf(group), dv: divOf(group), unit: mbUnit || (mi ? mi.unit : '') || (ms ? ms.unit : ''), meUnit: mi ? mi.unit : '', units: units.get(mat) ? [...units.get(mat).keys()].filter(Boolean) : [],
        desc: top(descs.get(mat)) || desc || (ms ? ms.desc : ''), poCount: mi ? mi.poCount : 0, suppliers: mi ? mi.suppliers : [], wavg: mi ? mi.wavg : null, last: mi ? mi.last : null };
      matInfo.set(mat, s); return s;
    };

    // one fixed order for every line (date, document, item), so the same data always gives the same report – whether it came from
    // the SAP files or from a saved report – and every list is chronological
    const dn = (d) => (d ? +d : 9e15);
    mb.lines.sort((a, b) => dn(a.date) - dn(b.date) || coll.compare(a.doc, b.doc) || coll.compare(a.year, b.year) || coll.compare(a.item, b.item) || coll.compare(a.lid, b.lid));
    for (const l of mb.lines) {
      l.month = l.date ? ymOf(l.date) : null;
      l.pend = !l.month ? 'No date' : l.date > cutDate ? 'After cut date' : '';
      l.bucket = l.pend ? 'Pending' : mKey(l.month);
      l.itype = ITYPE[l.cls] || 'Project';
      l.info = infoOf(l.material);
      l.ckey = l.material;                                        // the coding row of this line
      l.group = l.info.group;                                     // Material group: from the material (reference)
      l.fam = l.info.fam;                                         // its family on the group tree (M, P, SP …)
      l.dv = l.info.dv;                                           // its division (M03, P04 – or the family when SAP has none)
    }
    const lines = mb.lines.filter((l) => l.amt !== 0);
    const zeroLines = mb.zeroLines != null ? mb.zeroLines : mb.lines.length - lines.length;
    const zeroOwner = mb.zeroOwner != null ? mb.zeroOwner : mb.lines.filter((l) => !l.amt && /customer/i.test(l.val)).length;

    // months shown: first month with an amount up to the report month, no gaps
    let first = reportMonth;
    for (const l of lines) if (l.bucket !== 'Pending' && l.month < first) first = l.month;
    const months = []; for (let m = first; m <= reportMonth; m = nextM(m)) months.push(m);
    const pv = (keyFn, makeFn) => pivotLines(lines, curKey, keyFn, makeFn);

    // ---- coding rows: one per material, with reference data only (the codes live in the coding state)
    const crows = pv((l) => l.ckey, (l) => Object.assign({ key: l.ckey, inData: true, w: 0, firstM: null, lastM: null }, l.info));
    const cIndex = new Map(crows.map((r) => [r.key, r]));            // weight (|amount|) and first / last month per row
    // weight = the net amount (issues less returns – a material issued and returned in bulk is not a large one), as a size
    for (const l of lines) { const r = cIndex.get(l.ckey); r.w += l.amt;
      if (l.bucket !== 'Pending' && Math.abs(l.rq) > 1e-9) { const rt = l.amt / l.rq; r.rMin = r.rMin == null ? rt : Math.min(r.rMin, rt); r.rMax = r.rMax == null ? rt : Math.max(r.rMax, rt); }
      if (l.month && l.bucket !== 'Pending') { if (!r.firstM || l.month < r.firstM) r.firstM = l.month; if (!r.lastM || l.month > r.lastM) r.lastM = l.month; }
      // start month (for the start rate): the first month with quantity among ALL dated lines – whatever the cut date,
      // so the live workbook can use it at any cut
      if (l.month && Math.abs(l.rq) > 1e-9 && (r.startKey == null || l.month < r.startKey)) r.startKey = l.month; }
    for (const r of crows) {
      r.w = Math.abs(r.w); const s = r.suppliers.map(vendorName);
      r.subCount = s.length; r.subs = s.slice(0, 2).join(' · ') + (s.length > 2 ? ` +${s.length - 2}` : '');
      r.isNew = cst.hasFile && !cst.fileKeys.has(r.key);
    }
    for (const [k, c] of cst.codes) if (!cIndex.has(k)) {            // rows kept from the coding file that are not in this data
      const r = Object.assign({}, infoOf(k, c.desc), { key: k, inData: false, w: 0, subs: '', subCount: 0, isNew: false,
        prev: { q: 0, a: 0, n: 0 }, cur: { q: 0, a: 0, n: 0 }, td: { q: 0, a: 0, n: 0 }, pend: { q: 0, a: 0, n: 0 }, at: () => ({ q: 0, a: 0, n: 0 }) });
      crows.push(r); cIndex.set(k, r);
    }
    let nid = 0; for (const r of crows) r.id = ++nid;

    // ---- reference pivots (no coding needed)
    const grps = pv((l) => l.group, (l) => ({ code: l.group, name: grpLabel(l.group), dv: l.dv }));
    const divs = pv((l) => l.dv, (l) => ({ code: l.dv, name: grpLabel(l.dv) }));
    const fams = pv((l) => l.fam, (l) => ({ code: l.fam, name: grpLabel(l.fam) }));
    // ---- PO register: every PO of ME2N (deleted items left out) with its lines; a PO sits under its main material group
    const pos = [];
    if (me) {
      const byPo = new Map();
      for (const x of me.lines) {
        if (x.del === 'L') continue;
        let p = byPo.get(x.po);
        if (!p) byPo.set(x.po, (p = { po: x.po, date: x.date, vendor: x.vendor, kind: x.kind, gw: new Map(), items: [], value: 0, openVal: 0, invVal: 0 }));
        if (x.date && (!p.date || x.date < p.date)) p.date = x.date;
        p.gw.set(x.group, (p.gw.get(x.group) || 0) + Math.abs(x.value) + 1);
        p.items.push(x); p.value += x.value; p.openVal += x.openVal; p.invVal += x.invVal;
      }
      for (const p of byPo.values()) { p.group = top(p.gw); delete p.gw; p.items.sort((a, b) => coll.compare(a.item, b.item)); for (const k of ['value', 'openVal', 'invVal']) p[k] = r2(p[k]); pos.push(p); }
    }

    // ---- purchasing (ME2N as exported, deleted lines left out): every PO line under its material, with its status and age at the
    //      cut date. Purchases (a value) and transfers from own stores (a stock transport order: no value) are kept apart.
    //      PO type = the first two digits of the PO number (its SAP number range: 30 … transfers, 50 … vendor POs …).
    const purM = new Map(), stoM = new Map(), poTypes = new Map();
    if (me) for (const x of me.lines) {
      if (x.del === 'L') continue;
      const transfer = x.kind === 'STO' && !x.value, delivered = r3(x.qty - x.openQty), open = x.openQty > 1e-9;
      const status = x.del === 'S' ? 'Blocked' : open ? (delivered > 1e-9 ? 'Partly delivered' : 'Open') : !transfer && x.invVal > 0.5 ? 'To invoice' : 'Closed';
      const ln = Object.assign({}, x, { type: x.po.slice(0, 2), transfer, delivered, status, age: open && x.date && x.date <= cutDate ? Math.round((cutDate - x.date) / 864e5) : null });
      const map = transfer ? stoM : purM; let m = map.get(x.material);
      if (!m) { const inf = infoOf(x.material, x.text); map.set(x.material, (m = { mat: x.material, group: inf.group, desc: inf.desc || x.text, unit: inf.meUnit || x.unit || inf.unit, lines: [], qty: 0, delivered: 0, open: 0, value: 0, openVal: 0, invVal: 0 })); }
      m.lines.push(ln); m.qty += x.qty; m.delivered += delivered; m.open += x.openQty; m.value += x.value; m.openVal += x.openVal; m.invVal += x.invVal;
      let t = poTypes.get(ln.type); if (!t) poTypes.set(ln.type, (t = { type: ln.type, transfer: 0, lines: 0, pos: new Set(), value: 0, delivered: 0, openVal: 0, old: 0, oldN: 0, invVal: 0, openN: 0 }));
      t.lines++; t.pos.add(x.po); if (transfer) t.transfer++; t.value += x.value; t.delivered += x.value - x.openVal; t.openVal += x.openVal; t.invVal += x.invVal;
      if (open) t.openN++; if (ln.age > 90) { t.old += x.openVal; t.oldN++; }
    }
    for (const m of [...purM.values(), ...stoM.values()]) {
      for (const k of ['qty', 'delivered', 'open']) m[k] = r3(m[k]); for (const k of ['value', 'openVal', 'invVal']) m[k] = r2(m[k]);
      m.lines.sort((a, b) => (b.date ? +b.date : 0) - (a.date ? +a.date : 0) || coll.compare(b.po, a.po) || coll.compare(a.item, b.item));   // newest PO first
      const pr = m.lines.filter((l) => !l.transfer && l.unitPrice > 0);
      if (pr.length) { const ps = pr.map((l) => l.unitPrice), q = pr.reduce((s2, l) => s2 + l.qty, 0);
        m.low = Math.min(...ps); m.high = Math.max(...ps); m.lastPrice = pr[0].unitPrice; m.wavg = q > 0 ? pr.reduce((s2, l) => s2 + l.unitPrice * l.qty, 0) / q : ps.reduce((a, b) => a + b, 0) / ps.length;
        m.spread = m.high / m.low - 1; for (const l of pr) l.vsLow = l.unitPrice / m.low - 1; }
    }
    for (const t of poTypes.values()) { t.pos = t.pos.size; for (const k of ['value', 'delivered', 'openVal', 'invVal', 'old']) t[k] = r2(t[k]); }
    const purMats = [...purM.values()], stoMats = [...stoM.values()];

    // ---- month table: one row per month shown, amount by issue type
    const buckets = months.map(mKey);
    const monthRows = []; let cum = 0;
    for (const b of buckets) {
      const ls = lines.filter((l) => l.bucket === b);
      const row = { bucket: b, label: mLabel(keyToM(b)), P: 0, S: 0, X: 0, total: 0, docs: new Set(ls.map(docOf)).size, mats: new Set(ls.map((l) => l.material)).size };
      for (const l of ls) { row[l.cls] += l.amt; row.total += l.amt; }
      cum += row.total; row.cum = cum;
      for (const k of ['P', 'S', 'X', 'total', 'cum']) row[k] = r2(row[k]);
      monthRows.push(row);
    }

    // ---- totals
    const S = (f) => r2(lines.filter(f).reduce((s, l) => s + l.amt, 0));
    const outsideSum = r2(mb.outside.reduce((s, o) => s + o.a, 0)), outsideRows = mb.outside.reduce((s, o) => s + o.n, 0);
    const T = {
      footer: mb.footer, rawSum: r2(mb.rawSum), dupAmt: r2(mb.dupAmt), outsideSum, issuedSap: r2(-lines.reduce((s, l) => s + l.amt, 0)), certified: S(() => true),
      prev: S((l) => l.bucket !== 'Pending' && l.bucket < curKey), cur: S((l) => l.bucket === curKey),
      pendAfter: S((l) => l.pend === 'After cut date'), pendNoDate: S((l) => l.pend === 'No date'),
      subCur: S((l) => l.cls === 'S' && l.bucket === curKey), subTd: S((l) => l.cls === 'S' && l.bucket !== 'Pending'),
    };
    T.td = r2(T.prev + T.cur); T.pending = r2(T.pendAfter + T.pendNoDate);
    const prevMonthRow = monthRows.find((r) => r.bucket === mKey(prevM(reportMonth))), curRow = monthRows.find((r) => r.bucket === curKey) || {};
    const K = { activeMat: curRow.mats || 0, docs: curRow.docs || 0, lines: lines.length,
      rows: crows.filter((r) => r.inData).length, fams: fams.filter((g) => g.code).length, groups: grps.filter((g) => g.code).length, divs: divs.filter((g) => g.code).length, lastMonth: prevMonthRow ? prevMonthRow.total : null,
      lastMats: prevMonthRow ? prevMonthRow.mats : null, lastDocs: prevMonthRow ? prevMonthRow.docs : null, pos: pos.length };

    // ---- checks on the data (what to look at; none of them changes a figure)
    const checks = [];
    const add = (status, title, detail, count, amount, rows, cols) => checks.push({ status, title, detail, count, amount, rows: rows || null, cols: cols || null });
    // detail rows share one 8-column grid so every list lines up in Excel: date/unit | who | doc/qty | amount | material | line ID | description | WBS
    const lineCols = ['Posting date', 'Issue type', 'Material doc.', 'Amount', 'Material', 'Line ID', 'Description', 'WBS element'];
    const lineRow = (l) => [fmtDate(l.date), l.itype, l.doc, r2(l.amt), l.material, l.lid, l.desc, l.wbs];
    if (mb.footer == null) add('info', 'MB51 has no SAP total row', mb.fromReport ? 'This report was rebuilt from a saved report; the MB51 it was made from had no total row.' : 'The export has no total row, so the file could not be checked against SAP\'s own total. Export MB51 with the total (Σ on the amount) to get this check.', null, null);
    else { const d = r2(mb.footer - mb.rawSum);
      add(Math.abs(d) < 1 ? 'ok' : 'warn', 'MB51 rows add up to the SAP total row', Math.abs(d) < 1 ? `${mb.rawRows.toLocaleString('en-US')} rows = SAP total ${fmtN(mb.footer)}.` : `Rows add up to ${fmtN(mb.rawSum)} but SAP's total row says ${fmtN(mb.footer)} (difference ${fmtN(d)}). The export may be cut off.`, mb.rawRows, d); }
    if (mb.dupRows) add('warn', 'The same document line twice', `${mb.dupRows.toLocaleString('en-US')} rows repeat a material document + year + item already in the file (${fmtN(mb.dupAmt)}). Each is counted once – check that the export was not pasted twice.`, mb.dupRows, r2(mb.dupAmt));
    const known = mb.outside.filter((o) => o.group), unknown = mb.outside.filter((o) => !o.group);
    const oRows = (list) => list.map((o) => [o.n, o.text, o.mvt, r2(o.a), '', '', o.group || 'Not in the rules', '']), oCols = ['Lines', 'Movement text', 'Movement', 'Amount (SAP)', '', '', 'Group', ''];
    if (unknown.length) add('warn', 'Movement types not in the rules – left out', `Movement types ${[...new Set(unknown.map((o) => o.mvt))].join(', ')} are neither an issue to the project nor a known receipt or transfer, so they are not in the report. If one of them is project cost, tell whoever keeps this tool.`,
      unknown.reduce((s, o) => s + o.n, 0), r2(unknown.reduce((s, o) => s + o.a, 0)), oRows(unknown), oCols);
    add('info', 'Movements that are not material cost (left out)', known.length ? 'Receipts, transfers, issues to orders and cost centres, subcontractor stock … move material but put no cost on the project WBS. Amounts as SAP signs them (a receipt +, an issue −).' : 'MB51 holds issues to the project only.',
      known.reduce((s, o) => s + o.n, 0), r2(known.reduce((s, o) => s + o.a, 0)), oRows(known), oCols);
    const ac = lines.filter((l) => l.pend === 'After cut date');
    add(ac.length ? 'info' : 'ok', `Posted after the cut date (${fmtDate(cutDate)}) → Pending`, ac.length ? 'They belong to a later month and will appear in that month\'s report. To see them: Data sheet, filter Pending reason = After cut date.' : 'No line is posted after the cut date.', ac.length, T.pendAfter);
    const nd = lines.filter((l) => l.pend === 'No date');
    if (nd.length) add('warn', 'Lines without a posting date → Pending', 'The Posting Date column is empty, so the month is unknown.', nd.length, T.pendNoDate, nd.map(lineRow), lineCols);
    if (me) { const old = purMats.flatMap((m) => m.lines.filter((l) => l.age > 90).map((l) => Object.assign({ m }, l))).sort((a, b) => b.openVal - a.openVal);
      add(old.length ? 'info' : 'ok', 'Open PO lines older than 90 days', old.length ? `${old.length} purchase lines are still to be delivered more than 90 days after their PO date (${fmtN(old.reduce((s2, l) => s2 + l.openVal, 0))} open) – to receive, or to close in SAP. PO Register: Flag = Open > 90 days.` : 'No purchase line is open more than 90 days.',
        old.length, r2(old.reduce((s2, l) => s2 + l.openVal, 0)), old.map((l) => [fmtDate(l.date), vendorName(l.vendor), l.po + '/' + l.item, r2(l.openVal), l.material, l.type, l.m.desc, l.age]), ['PO date', 'Supplier', 'PO / item', 'Open value', 'Material', 'PO type', 'Description', 'Age (days)']); }
    if (!me) add('warn', 'ME2N not loaded', 'Suppliers and PO prices are missing, and material groups come ' + (master ? 'from the material list' : knownGrp.size ? 'from the last report only' : 'from nowhere') + '. Load ME2N for complete reference data.', null, null);
    else if (me.plant && plant && me.plant !== plant) add('warn', 'ME2N is for another project', `MB51 is plant ${plant} but ME2N is plant ${me.plant}. Material groups and PO prices may be wrong.`, null, null);
    else add('ok', 'ME2N matches the project', `${me.lines.length.toLocaleString('en-US')} PO lines on ${me.pos.toLocaleString('en-US')} POs, plant ${me.plant || plant}.`, null, null);
    const inRows = crows.filter((r) => r.inData);
    const noGrp = inRows.filter((r) => !r.group).sort((a, b) => b.w - a.w), viaMaster = inRows.filter((r) => r.grpSrc === 'Material list');
    if (master) add('ok', 'Material list (MB52 / MM60 / master)', `${master.count.toLocaleString('en-US')} materials` + (viaMaster.length ? ` – it gave their group to ${viaMaster.length} materials that are on no PO line in ME2N (${fmtN(viaMaster.reduce((s, r) => s + r.td.a, 0))} to date).` : '; every material issued already had its group from ME2N.'), viaMaster.length, null);
    add(noGrp.length ? 'warn' : 'ok', 'Every material has a material group', !noGrp.length ? 'Every material issued has its SAP material group' + (inRows.some((r) => r.grpSrc === 'Last report') ? ' (some kept from the last report).' : '.')
      : `These materials are on no PO line in ME2N${master ? ' and not in the material list' : ''}, so their group is unknown and they sit under "${NO_GRP}" (they can still be coded on the Coding sheet). ` + (master ? 'Check them in SAP.' : 'Drop MB52 (stock list) or MM60 / the material master – any SAP list with Material, Material Type and Material Group – with MB51: the report keeps the groups it learns, so it is needed only when new materials appear.'),
      noGrp.length, r2(noGrp.reduce((s, r) => s + r.td.a, 0)), noGrp.map((r) => [r.unit, '', '', r.td.a, r.mat, '', r.desc, '']), ['Unit', '', '', 'To date', 'Material', '', 'Description', '']);
    const multi = inRows.filter((r) => r.units.length > 1 || (r.meUnit && r.unit && r.meUnit !== r.unit)).sort((a, b) => b.w - a.w);
    add(multi.length ? 'warn' : 'ok', 'One unit per material', multi.length ? 'These materials are issued in more than one unit, or ordered in another unit than they are issued in. Their quantities (and so their rates) mix units – check the lines on the Data sheet (column Unit of entry).' : 'Every material is issued and ordered in one unit.',
      multi.length, null, multi.map((r) => [r.unit, `MB51: ${r.units.join(', ') || '–'} · ME2N: ${r.meUnit || '–'}`, '', r.td.a, r.mat, '', r.desc, '']), ['Unit', 'Units', '', 'To date', 'Material', '', 'Description', '']);
    const neg = inRows.filter((r) => r.td.a < -0.5);
    add(neg.length ? 'warn' : 'ok', 'Materials with a negative To date', neg.length ? 'More was returned than issued on these materials. Usually a return (222) booked on a material other than the one issued, or the issue posted before the MB51 date range.' : 'No material is negative to date.', neg.length, r2(neg.reduce((s, x) => s + x.td.a, 0)), neg.map((r) => [r.unit, r.group, r.td.q, r.td.a, r.mat, '', r.desc, '']), ['Unit', 'Material group', 'Qty to date', 'To date', 'Material', '', 'Description', '']);
    const sub = lines.filter((l) => l.cls === 'S' && l.bucket !== 'Pending');
    if (sub.length) { const bs = new Map(); for (const l of sub) { const x = bs.get(l.supplier) || { n: 0, a: 0, w: new Set() }; x.n++; x.a += l.amt; x.w.add(l.wbs); bs.set(l.supplier, x); }
      add('info', 'Issued to subcontractors (Z21) – to recover', `${bs.size} subcontractors received material with deduction (movement Z21): ${fmtN(T.subTd)} to date, ${fmtN(T.subCur)} this month. It is project cost here and should come back as a deduction on their certificates.`,
        sub.length, T.subTd, [...bs].sort((a, b) => b[1].a - a[1].a).map(([s, x]) => [x.n, s || '(no code)', '', r2(x.a), '', '', [...x.w].filter(Boolean).slice(0, 3).join(' · '), '']), ['Lines', 'Subcontractor (SAP code)', '', 'Amount', '', '', 'WBS elements', '']); }
    add('info', 'Lines left out (no amount)', `${zeroLines.toLocaleString('en-US')} issue lines have a quantity but no value, so they are not in the report` + (zeroOwner ? ` – ${zeroOwner.toLocaleString('en-US')} of them owner-supplied material (valuation type CUSTOMER), the rest mostly scrap at no price.` : ' (scrap or free material at no price).'), zeroLines, 0);
    const idOk = Math.abs(T.certified - T.td - T.pending) < 0.5;
    add(idOk ? 'ok' : 'warn', 'Report total ties', `Issued ${fmtN(T.certified)} = To date ${fmtN(T.td)} + Pending ${fmtN(T.pending)}.`, null, r2(T.certified - T.td - T.pending));

    // ---- changes against the last report
    let changes = !prev && input.changes ? input.changes : null;      // the report alone: keep the changes it already showed
    if (prev && prev.lines.size) {
      if (prev.plant && plant && prev.plant !== plant) notes.push(`The last report is for ${prev.plant}, this data is ${plant} – changes were not compared.`);
      else {
        const P = prev.month || prevM(reportMonth), pKey = mKey(P);
        const reported = (b) => b !== 'Pending' && b <= pKey;
        const now = new Map(lines.map((l) => [l.lid, l])); const rows = [];
        for (const l of lines) {
          const p = prev.lines.get(l.lid); const was = p && p.amt ? (reported(p.bucket) ? p.amt : 0) : 0, is = reported(l.bucket) ? l.amt : 0;
          if (!reported(l.bucket) && !(p && reported(p.bucket))) continue;          // only lines that touch a month the last report showed
          let type = null;
          if (!p || !p.amt) type = 'New line in a reported month';
          else if (Math.abs(p.amt - l.amt) > 0.005) type = 'Amount changed';
          else if (!reported(p.bucket) && reported(l.bucket)) type = 'Pending in the last report, counted now';
          else if (reported(p.bucket) && !reported(l.bucket)) type = l.bucket === 'Pending' ? 'Moved to Pending' : 'Moved to a later month';
          else if (p.bucket !== l.bucket) type = 'Moved to another month';
          if (type) rows.push({ type, bucket: l.bucket, lid: l.lid, doc: l.doc, wbs: l.wbs, mat: l.material, text: l.desc, was: r2(was), is: r2(is) });
        }
        for (const [id, p] of prev.lines) if (!now.has(id) && p.amt && reported(p.bucket))
          rows.push({ type: 'Removed from SAP', bucket: p.bucket, lid: id, doc: p.doc, wbs: p.wbs === NO_WBS ? '' : p.wbs, mat: p.mat, text: p.desc, was: r2(p.amt), is: 0 });
        for (const r of rows) r.diff = r2(r.is - r.was);
        const keys = months.filter((m) => m <= P).map(mKey);
        const monthTable = keys.map((k) => {
          let was = 0, is = 0; for (const p of prev.lines.values()) if (p.bucket === k) was += p.amt; for (const l of lines) if (l.bucket === k) is += l.amt;
          return { bucket: k, label: mLabel(keyToM(k)), was: r2(was), is: r2(is), diff: r2(is - was) };
        }).filter((r) => r.was || r.is);
        changes = { month: P, rows: rows.filter((r) => Math.abs(r.diff) > 0.005 || r.type === 'Moved to another month'), monthTable,
          total: r2(monthTable.reduce((s, r) => s + r.diff, 0)) };
      }
    }
    if (cst.hasFile && cst.plant && plant && cst.plant !== plant) notes.push(`The coding was saved for ${cst.plant}, this data is ${plant}.`);

    // months of earlier years (before January of the report year): the per-month sheets can roll them into one "Previous years" block
    const olderYears = lines.some((l) => l.month && l.month < Math.floor(reportMonth / 100) * 100 + 1);
    const M = {
      version: VERSION, plant, reportMonth, curKey, label: mLabel(reportMonth), cutDate, generated: new Date(), files: input.files || {},
      olderYears, rollYears: input.rollYears == null ? true : !!input.rollYears,
      months, buckets, lines, crows, cIndex, pos, purMats, stoMats, poTypes: [...poTypes.values()].sort((a, b) => b.value - a.value || coll.compare(a.type, b.type)), grps, divs, fams, monthRows, T, K, checks, changes, notes, cstate: cst, fromReport: !!mb.fromReport,
      outside: mb.outside, meLines: me ? me.lines : [], mePlant: me ? me.plant : '', masterCount: master ? master.count : 0,
      counts: { rawRows: mb.rawRows, summaryRows: mb.summaryRows, dupRows: mb.dupRows, outsideRows, costRows: mb.lines.length, zeroLines, zeroOwner, meLines: me ? me.lines.length : 0, meSkipped: me ? me.skipped || 0 : 0 },
    };
    return applyCoding(M);
  }

  // ================================================================ CODING → report groupings, progress, coding checks
  // Called after every coding change; cheap (a few thousand lines).
  function applyCoding(M) {
    const cst = M.cstate, L = cst.lists, nm = {}, ord = {};
    for (const f of FIELDS) { nm[f] = new Map(L[f]); ord[f] = new Map(L[f].map((x, i) => [x[0], i])); }
    for (const l of M.lines) { const c = codeOf(cst, l.ckey); for (const f of FIELDS) l[f] = c[f]; }
    const pv = (keyFn, makeFn) => pivotLines(M.lines, M.curKey, keyFn, makeFn);
    const byOrder = (f) => (a, b) => (a.code ? 0 : 1) - (b.code ? 0 : 1) || (ord[f].has(a.code) ? ord[f].get(a.code) : 1e6) - (ord[f].has(b.code) ? ord[f].get(b.code) : 1e6) || b.td.a - a.td.a;
    M.items = pv((l) => l.ckey, (l) => { const r = M.cIndex.get(l.ckey);
      return { key: r.key, mat: r.mat, desc: r.desc, group: r.group, fam: r.fam, dv: r.dv, type: r.type, unit: r.unit, pkg: l.pkg, mnl: l.mnl, ce: l.ce,
        startKey: r.startKey, firstM: r.firstM, poCount: r.poCount, wavg: r.wavg, last: r.last }; });
    // one order everywhere: family in its fixed order (M, P, SP, SM …) › division › group › material – each of the last three
    // largest first by To date at the cut date (ties: SAP code / material number), so the money is at the top of every sheet
    const tdOf = new Map(); for (const x of M.divs) tdOf.set('d|' + x.code, x.td.a); for (const x of M.grps) tdOf.set('g|' + x.code, x.td.a);
    const famK = (g) => { const f = famOf(g); return g ? (FAM_RANK.has(f) ? FAM_RANK.get(f) : 99) : 999; };
    const byTree = (ga, gb) => famK(ga) - famK(gb) || coll.compare(famOf(ga), famOf(gb))
      || (tdOf.get('d|' + divOf(gb)) || 0) - (tdOf.get('d|' + divOf(ga)) || 0) || coll.compare(divOf(ga), divOf(gb))
      || (tdOf.get('g|' + gb) || 0) - (tdOf.get('g|' + ga) || 0) || coll.compare(str(ga), str(gb));
    M.crows.sort((a, b) => (a.inData ? 0 : 1) - (b.inData ? 0 : 1) || byTree(a.group, b.group) || b.td.a - a.td.a || coll.compare(a.mat, b.mat));
    const pos = new Map(M.crows.map((r, i) => [r.key, i]));
    M.items.sort((a, b) => pos.get(a.key) - pos.get(b.key));
    M.grps.sort((a, b) => byTree(a.code, b.code));
    M.divs.sort((a, b) => famK(a.code) - famK(b.code) || coll.compare(famOf(a.code), famOf(b.code)) || b.td.a - a.td.a || coll.compare(str(a.code), str(b.code)));
    M.fams.sort((a, b) => famK(a.code) - famK(b.code) || coll.compare(str(a.code), str(b.code)));
    M.pos.sort((a, b) => byTree(a.group, b.group) || b.value - a.value || coll.compare(a.po, b.po));
    const tdMat = (m) => { const r = M.cIndex.get(m); return r && r.inData ? r.td.a : 0; };
    for (const list of [M.purMats, M.stoMats]) list.sort((a, b) => byTree(a.group, b.group) || tdMat(b.mat) - tdMat(a.mat) || b.value - a.value || b.qty - a.qty || coll.compare(a.mat, b.mat));
    M.groups = {};
    for (const f of FIELDS) { const g = pv((l) => l[f], (l) => ({ code: l[f], name: l[f] ? nm[f].get(l[f]) || '' : NOT_CODED })); g.sort(byOrder(f)); M.groups[f] = g; }
    M.groups.grp = M.grps; M.groups.div = M.divs; M.groups.fam = M.fams;

    // progress: share of rows and of amount that carry each code
    const rows = M.crows.filter((r) => r.inData), W = rows.reduce((s, r) => s + r.w, 0) || 1;
    const cOf = new Map(rows.map((r) => [r.key, codeOf(cst, r.key)]));
    const has = (r, f) => !!cOf.get(r.key)[f], full = (r) => FIELDS.every((f) => has(r, f));
    M.progress = FIELDS.map((f) => { const d = rows.filter((r) => has(r, f)); return { f, name: FIELD_NAME[f], rows: rows.length, done: d.length, pct: d.reduce((s, r) => s + r.w, 0) / W }; });
    const done = rows.filter(full);
    M.progressAll = { rows: rows.length, done: done.length, pct: done.reduce((s, r) => s + r.w, 0) / W };
    // the coding KPIs (the band on top of the Coding sheet, as made): what is still to code, in count and in amount
    const sumA = (list, k) => r2(list.reduce((s, r) => s + r[k].a, 0)), open = rows.filter((r) => !full(r));
    const tdAll = sumA(rows, 'td');
    M.codingKpi = { rows: rows.length, coded: done.length, toCode: open.length, missing: Object.fromEntries(FIELDS.map((f) => [f, rows.filter((r) => !has(r, f)).length])),
      share: tdAll ? sumA(done, 'td') / tdAll : 0, tdOpen: sumA(open, 'td'), curOpen: sumA(open, 'cur'),
      fresh: rows.filter((r) => r.isNew).length, multiPo: rows.filter((r) => r.poCount > 1).length };
    // the coding by family › division › group (the Lists sheet table, the tool's Coding status tab): which branch holds the most still to code
    const tree = [], node = new Map();
    const at = (key, lvl, kind, label) => { let x = node.get(kind + '|' + key); if (!x) { node.set(kind + '|' + key, (x = { key, lvl, kind, label, mats: 0, coded: 0, td: 0, tdOpen: 0, cur: 0 })); tree.push(x); } return x; };
    for (const r of rows) {
      const g = r.group, path = !g ? [at(NO_GRP, 0, 'fam', NO_GRP)]
        : [at(famOf(g), 0, 'fam', famLabel(g))].concat(realDiv(g) ? [at(realDiv(g), 1, 'div', divLabel(g))] : [], [at(g, 2, 'grp', grpLabel(g))]);
      for (const x of path) { x.mats++; x.td += r.td.a; x.cur += r.cur.a; if (full(r)) x.coded++; else x.tdOpen += r.td.a; }
    }
    for (const x of tree) { x.td = r2(x.td); x.tdOpen = r2(x.tdOpen); x.cur = r2(x.cur); x.toCode = x.mats - x.coded; }
    M.codingTree = tree;

    // coding checks
    const cc = []; const add = (status, title, detail, count, amount, list, cols) => cc.push({ status, title, detail, count, amount, rows: list || null, cols: cols || null });
    open.sort((a, b) => b.w - a.w);
    add(open.length ? 'warn' : 'ok', 'Coding complete', open.length ? M.progress.filter((p) => p.done < p.rows).map((p) => `${p.name} missing on ${p.rows - p.done} materials (${Math.round((1 - p.pct) * 1000) / 10}% of the amount)`).join(' · ') + '. Uncoded amounts are reported as "(not coded)" – the totals still tie. The Coding sheet shows what is left (the band on top), the Lists sheet where (by family › division › group).' : `All ${rows.length} materials have PKG, MNL and Cost element.`,
      open.length, r2(open.reduce((s, r) => s + r.td.a, 0)));     // no list: the Coding sheet shows what is missing
    const fresh = rows.filter((r) => r.isNew);
    if (cst.hasFile) add(fresh.length ? 'info' : 'ok', 'New materials (not in the last coding)', fresh.length ? `${fresh.length} materials were issued for the first time since the last report – marked New on the Coding sheet.` : 'Every material is in the last coding.', fresh.length, null);
    if (cst.old) add('info', 'Coding from the old material tool', 'Its MNL and Cost element came in as the codes of each material; its Package was a DIV and is not used. From now on the coding lives in this report.', cst.codes.size, null);
    if (cst.v10) add('info', 'Coding from a v1.0 report', 'Its PKG, MNL and Cost element came in as they were; its DIV is not used any more.', cst.codes.size, null);
    if (cst.v11) add('info', 'Coding from a v1.1 report', 'The code each material ended up with (from the Rules sheet or its own) is now its code on the Coding sheet. Codes are typed per material from now on.', cst.codes.size, null);
    if (cst.added.length) add('info', 'New codes added to the lists', `${cst.added.join(', ')} – typed on the Coding sheet; give them a name on the Lists sheet if you like.`, cst.added.length, null);
    if (!cst.hasFile) add('info', 'No coding loaded', 'Code on the Coding sheet of the Excel report – one row per material, in the order family › division › group – then drop that report in next month: the coding comes with it.', null, null);
    M.codingChecks = cc;
    return M;
  }
  function fmtN(x) { return x == null ? '' : (Math.round(x)).toLocaleString('en-US'); }
  // ================================================================ RATES (Material Summary rate analysis – the workbook uses the same rules)
  // A rate change is only read when both rates are positive and within 3× of each other: a bigger jump is a unit mix-up or a
  // placeholder value, not a price change – it shows "check" and stays out of the totals.
  const rateOf = (o) => (o && Math.abs(o.q) > 1e-6 ? o.a / o.q : null);
  function rateChange(from, to) {                                   // → { d, pct } · 'check' · null (a rate is missing)
    if (from == null || to == null) return null;
    if (!(from > 0 && to > 0 && to / from <= 3 && to / from >= 1 / 3)) return 'check';
    const d = Math.abs(to - from) < 0.005 ? 0 : to - from; return { d, pct: d / from };
  }
  // the start rate: the material's rate in its first month with quantity – none while the cut date is before it
  function startOf(x, reportMonth) {
    if (x.startKey == null || x.startKey > reportMonth) return null;
    return { key: x.startKey, label: mLabel(x.startKey), rate: rateOf(x.at(mKey(x.startKey))) };
  }
  // this month against the previous rate (to last month) · to date against the start rate; Value = qty × the change
  function rates(x, reportMonth) {
    const pr = rateOf(x.prev), cr = rateOf(x.cur), tr = rateOf(x.td), st = startOf(x, reportMonth), sr = st ? st.rate : null;
    const mv = rateChange(pr, cr), sv = rateChange(sr, tr);
    // value = qty × the change (= amount − qty at the earlier rate); a change under half a piastre per unit is no change: value 0
    return { pr, cr, tr, st, sr, mv, sv, mValue: mv && mv !== 'check' ? r2(x.cur.q * mv.d) : null, sValue: sv && sv !== 'check' ? r2(x.td.q * sv.d) : null };
  }
  // colour per material group (by its place in the order): golden-angle hues, so neighbours always differ
  const towHue = (i) => Math.round((i * 137.508 + 205) % 360);
  function hslHex(h, sat, lig) { sat /= 100; lig /= 100; const k = (n) => (n + h / 30) % 12, a = sat * Math.min(lig, 1 - lig);
    const f = (n) => lig - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))); return [f(0), f(8), f(4)].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('').toUpperCase(); }

export const util = { mLabel, mKey, keyToM, fmtDate, fmtN, readDate, str, num, r2, r3, prevM, nextM };
export { VERSION, TOOL, FIELDS, FIELD_NAME, NOT_CODED, NO_GRP, NO_WBS, ITYPE, ISSUE, towHue, hslHex, build, codingState, applyCoding, codeOf,
  grpLabel, famLabel, divLabel, realDiv, famOf, nodeName, treeOf, divOf, treeCmp, FAMILY, rates, rateChange, startOf, docOf, meLine, meIndex, mkLine, outsideOf };
