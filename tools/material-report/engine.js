/* Material report engine.
 * Turns SAP ME2N (purchase order lines) + MB51 (material movements) + CJI3 (actual cost, document type WA)
 * into the monthly material cost report, optionally carrying coding and history forward from the previous
 * report. Pure logic: the page passes in the sheets as arrays of rows and ExcelJS; Node tests do the same.
 *
 * The three sources never add up to one another – each answers its own question:
 *   ME2N  what was ordered, from whom, at what price, and what is still open     (key: PO + item)
 *   MB51  what physically moved, and where to                                     (key: material doc + year + item)
 *   CJI3  what the project paid                                                   (key: CO doc + posting row + year)
 * Cost is CJI3 only. Every WA line carries its material document in "Ref. document number" and the item in the
 * second "Posting Row" column, so each cost line is tied to exactly one MB51 movement. */
(function (root) {
  'use strict';
  // ------------------------------------------------------------------ helpers
  const str = (v) => (v === null || v === undefined) ? '' : (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).trim());
  const num = (v) => {
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    const t = str(v).replace(/,/g, ''); if (!t) return 0;
    const neg = /-$/.test(t);                        // SAP writes 1.234- for negatives in some exports
    const n = +(neg ? t.slice(0, -1) : t); return isFinite(n) ? (neg ? -n : n) : 0;
  };
  const code = (v) => { const t = str(v); return /^\d+\.0+$/.test(t) ? t.replace(/\.0+$/, '') : t; };
  const esc = (s) => str(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function toDate(v) {
    if (v instanceof Date) return isNaN(v) ? null : v;
    if (typeof v === 'number' && v > 0) return new Date(Math.round((v - 25569) * 86400000));
    const t = str(v); let m;
    if ((m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t))) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if ((m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(t))) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
    return null;
  }
  // dates from SheetJS (cellDates) are local midnight, sometimes a few seconds short; serials and ISO text are UTC midnight.
  // Reading the local calendar day at noon puts both on the right day in any time zone.
  const ymd = (d) => { const x = new Date(d.getTime() + 43200000); return { y: x.getFullYear(), m: x.getMonth() + 1, d: x.getDate() }; };
  const monthKey = (d) => { if (!d) return 0; const o = ymd(d); return o.y * 100 + o.m; };
  const mlabel = (m) => m ? MON[(m % 100) - 1] + '-' + String(Math.floor(m / 100)).slice(2) : '';
  const mtext = (m) => m ? `${Math.floor(m / 100)}-${String(m % 100).padStart(2, '0')}` : '';
  const dtext = (d) => { if (!d) return ''; const o = ymd(d); return `${o.y}-${String(o.m).padStart(2, '0')}-${String(o.d).padStart(2, '0')}`; };
  // Entry timestamps are wall-clock times kept as Date.UTC numbers, so no time zone ever shifts a cut-off.
  // SAP stamps "Created on" + "Time of Entry" when the document is saved; unlike the posting date it cannot be back-dated.
  function secondsOf(v) {
    if (typeof v === 'number') return Math.round((v - Math.floor(v)) * 86400);        // Excel time fraction
    if (v instanceof Date) return v.getHours() * 3600 + v.getMinutes() * 60 + v.getSeconds();
    const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(str(v)); return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+(m[3] || 0)) : null;
  }
  function stamp(dateV, timeV) {
    const d = toDate(dateV); if (!d) return null; const o = ymd(d), sec = secondsOf(timeV);
    return Date.UTC(o.y, o.m - 1, o.d) + (sec === null ? 86399 : sec) * 1000;      // no time → end of that day
  }
  const tsText = (t) => { if (t === null || t === undefined || !isFinite(t)) return ''; const d = new Date(t), p = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`; };
  // the calendar day of a wall-clock stamp, as a UTC-midnight Date (ymd() must not see the time of day: it would round afternoons up)
  const dayOf = (t) => new Date(Math.floor(t / 86400000) * 86400000);
  const cutText = (t) => (t === null || t === undefined || !isFinite(t)) ? '' : tsText(t).slice(0, 10);   // cut-offs are whole days
  const tsParse = (t) => { const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(str(t)); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 23), +(m[5] || 59), +(m[6] || (m[4] ? 0 : 59))) : null; };
  const endOfMonth = (mk) => Date.UTC(Math.floor(mk / 100), mk % 100, 1) - 1000;         // last second of month mk
  const monthOfTs = (t) => { const d = new Date(t); return d.getUTCFullYear() * 100 + d.getUTCMonth() + 1; };
  const nextMonth = (mk) => (mk % 100 === 12 ? mk + 89 : mk + 1);
  const bucketText = (b) => typeof b === 'number' ? mtext(b) : b;
  const bucketLabel = (b) => typeof b === 'number' ? mlabel(b) : (b === 'OPENING' ? 'Opening' : 'Pending');
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const add = (o, k, v) => { o[k] = (o[k] || 0) + v; };
  const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
  const round2 = (v) => Math.round(v * 100) / 100;
  const q6 = (v) => Math.round(v * 1e6) / 1e6;

  // --------------------------------------------------------- input layout
  // Columns are found by header text, never by position, so a changed layout variant still reads – or says what is missing.
  // [after] picks the first column of that name to the right of another one (CJI3 has two "Posting Row" columns:
  // the CO posting row, and the reference document's item, which is the MB51 material document item).
  const LAYOUT = {
    cji: {
      title: 'CJI3 actual cost',
      cols: { docNo: 'Document Number', postRow: 'Posting Row', fy: 'Fiscal Year', ce: 'Cost Element', ceName: 'Cost element name',
        amt: 'Val/COArea Crcy', wbs: 'WBS Element', coName: 'CO Object Name', pdate: 'Posting Date', docType: 'Document Type',
        refDoc: 'Ref. document number', refItem: ['Posting Row', 'Ref. document number'], refFy: 'Ref. Fiscal Year',
        material: 'Material', matDesc: 'Material Description', qty: 'Total quantity', uom: 'Posted unit of meas.',
        revDoc: 'Reversal document', reversed: 'Reversed', project: 'Project definition', plant: 'Plant', user: 'User Name',
        created: 'Created on', ctime: 'Time of Entry' },
      need: ['docNo', 'fy', 'ce', 'amt', 'wbs', 'pdate', 'docType', 'refDoc', 'refItem', 'refFy', 'material'],
    },
    mb: {
      title: 'MB51 material movements',
      cols: { material: 'Material', plant: 'Plant', sloc: 'Storage Location', mvt: 'Movement Type', mvtText: 'Movement Type Text',
        doc: 'Material Document', item: 'Material Doc.Item', pdate: 'Posting Date', desc: 'Material Description', year: 'Material Doc. Year',
        qty: 'Qty in unit of entry', amt: 'Amt.in Loc.Cur.', uom: 'Unit of Entry', po: 'Purchase order', poItem: ['Item', 'Purchase order'],
        supplier: 'Supplier', ref: 'Reference', wbs: 'WBS Element', order: 'Order', text: 'Text', headerText: 'Document Header Text', user: 'User Name',
        edate: 'Entry Date', etime: 'Time of Entry' },
      need: ['material', 'mvt', 'doc', 'item', 'year', 'pdate', 'qty', 'amt'],
    },
    me: {
      title: 'ME2N purchase orders',
      cols: { po: 'Purchasing Document', item: 'Item', date: 'Document Date', vendor: 'Supplier/Supplying Plant', issSloc: 'Issuing Storage Loc.',
        plant: 'Plant', sloc: 'Storage Location', material: 'Material', group: 'Material Group', text: 'Short Text', unit: 'Order Unit',
        del: 'Deletion Indicator', qty: 'Order Quantity', priceUnit: 'Price Unit', netPrice: 'Net Price', value: 'Net Order Value',
        openQty: 'Still to be delivered (qty)', openVal: 'Still to be delivered (value)', invQty: 'Still to be invoiced (qty)',
        invVal: 'Still to be invoiced (val.)', pr: 'Purchase Requisition' },
      need: ['po', 'item', 'material', 'group', 'qty', 'netPrice'],
    },
  };
  function headerAt(aoa) {                          // SAP exports sometimes carry a title block above the header
    for (let r = 0; r < Math.min(15, aoa.length); r++) {
      const h = (aoa[r] || []).map(str);
      if (h.includes('Material Document') || h.includes('Purchasing Document') || h.includes('Ref. document number') || h.includes('Material')) return r;
    }
    return 0;
  }
  function locate(h, name) {
    const H = h.map(str); let after = null;
    if (Array.isArray(name)) { after = name[1]; name = name[0]; }
    let start = 0;
    if (after) { const a = locate(h, after); if (a < 0) return -1; start = a + 1; }
    for (let i = start; i < H.length; i++) if (H[i] === name) return i;
    const lo = name.toLowerCase();
    for (let i = start; i < H.length; i++) if (H[i].toLowerCase() === lo) return i;
    return -1;
  }
  function mapColumns(kind, aoa) {
    const L = LAYOUT[kind], hr = headerAt(aoa), h = aoa[hr] || [], ix = {};
    for (const [k, n] of Object.entries(L.cols)) ix[k] = locate(h, n);
    const missing = L.need.filter((k) => ix[k] < 0).map((k) => Array.isArray(L.cols[k]) ? `${L.cols[k][0]} (after ${L.cols[k][1]})` : L.cols[k]);
    return { ix, hr, missing };
  }
  function detectKind(aoa) {
    const h = (aoa[headerAt(aoa)] || []).map(str);
    if (h.includes('Ref. document number') && h.includes('Cost Element')) return 'cji';
    if (h.includes('Material Document') && h.includes('Movement Type')) return 'mb';
    if (h.includes('Purchasing Document') && h.includes('Material Group')) return 'me';
    return null;
  }
  const getter = (row, ix) => (k) => (ix[k] >= 0 ? row[ix[k]] : undefined);

  // --------------------------------------------------------- movement classes
  // Every MB51 movement lands in one class. The quantity chain is these classes side by side; the stock balance
  // is the signed sum of the classes that move own stock at the plant.
  const CLASSES = [
    { code: 'RCV_V', label: 'Received – vendor', short: 'From vendors', stock: true, dir: 'in' },
    { code: 'RCV_S', label: 'Received – stores transfer', short: 'From stores', stock: true, dir: 'in' },
    { code: 'OWNER', label: 'Owner supplied', short: 'Owner supplied', stock: true, dir: 'in' },
    { code: 'RET_P', label: 'Returned from project', short: 'Returned', stock: true, dir: 'in' },
    { code: 'ISS_P', label: 'Issued to project', short: 'To project', stock: true, dir: 'out', cost: true },
    { code: 'ISS_S', label: 'Issued to subcontractors (recoverable)', short: 'To subcontractors', stock: true, dir: 'out', cost: true },
    { code: 'SCRAP', label: 'Scrapped', short: 'Scrap', stock: true, dir: 'out', cost: true },
    { code: 'ISS_O', label: 'Issued to orders (outside project cost)', short: 'To orders', stock: true, dir: 'out' },
    { code: 'ISS_K', label: 'Issued to cost centre', short: 'To cost centre', stock: true, dir: 'out' },
    { code: 'TRF_O', label: 'Transferred out / delivered', short: 'Transferred out', stock: true, dir: 'out' },
    { code: 'SUBC', label: 'Provided to subcontractor stock', short: 'Sub-con stock', stock: true, dir: 'out' },
    { code: 'ADJ', label: 'Transfer postings / inventory differences', short: 'Adjustments', stock: true, dir: 'both' },
    { code: 'DIRECT', label: 'Received direct to order / asset (not stock)', short: 'Direct / asset', stock: false, dir: 'in' },
    { code: 'OTHER', label: 'Other – movement type not in the rules', short: 'Other', stock: true, dir: 'both' },
  ];
  const CLASS = Object.fromEntries(CLASSES.map((c) => [c.code, c]));
  // movement type -> class. Receipts (101 family) need a second look: the same type covers vendor receipts,
  // stock transport receipts, account-assigned receipts and asset receipts, told apart by their text and the PO.
  const MVT = {
    '221': 'ISS_P', '222': 'ISS_P', 'Z21': 'ISS_S', 'Z22': 'ISS_S', '261': 'ISS_O', '262': 'ISS_O', '201': 'ISS_K', '202': 'ISS_K',
    '551': 'SCRAP', '552': 'SCRAP', '553': 'SCRAP', '554': 'SCRAP', '555': 'SCRAP', '556': 'SCRAP',
    'Z52': 'OWNER', 'Z53': 'OWNER', 'Z84': 'RET_P', 'Z85': 'RET_P',
    '351': 'TRF_O', '352': 'TRF_O', '601': 'TRF_O', '602': 'TRF_O', '641': 'TRF_O', '642': 'TRF_O', '643': 'TRF_O', '644': 'TRF_O', '303': 'TRF_O', '304': 'TRF_O',
    '541': 'SUBC', '542': 'SUBC', '543': 'SUBC', '544': 'SUBC',
    '309': 'ADJ', '310': 'ADJ', '311': 'ADJ', '312': 'ADJ', '411': 'ADJ', '412': 'ADJ', '701': 'ADJ', '702': 'ADJ', '711': 'ADJ', '712': 'ADJ', '561': 'ADJ', '562': 'ADJ',
  };
  const RECEIPT = new Set(['101', '102', '103', '104', '105', '106', '122', '123', '161', '162']);
  function classify(m, poKind) {
    if (RECEIPT.has(m.mvt)) {
      if (/asset/i.test(m.mvtText)) return 'DIRECT';
      if (m.order || /acct|acc\.?\s*ass/i.test(m.mvtText)) return 'DIRECT';
      if (/transit/i.test(m.mvtText) || poKind.get(m.po) === 'STO') return 'RCV_S';
      return 'RCV_V';
    }
    return MVT[m.mvt] || 'OTHER';
  }
  const COST_CLASS = { ISS_P: 'Project consumption', ISS_S: 'Issued to subcontractors (recoverable)', SCRAP: 'Scrap / damages' };
  // Material Monthly line type: what the issue was for (Service Monthly splits Normal / Adjustment the same way)
  const LINE_TYPE = { ISS_P: 'Project', ISS_S: 'To subcontractors', SCRAP: 'Scrap' };
  const LINE_ORDER = { Project: 0, 'To subcontractors': 1, Scrap: 2 };
  const costClassOf = (cls) => COST_CLASS[cls] || (cls ? 'Other movement (' + cls + ')' : 'No MB51 movement');

  // -------------------------------------------------------- coding catalogue
  // Same package and MNL catalogue as the subcontract report, so material and subcontract cost roll up to the same packages.
  const GROUP_COLOR = { General: '6B7280', Civil: '2A5CAA', Arch: 'B07D2B', MEP: '1B8A6B' };
  const PACKAGES = [
    ['DIV 03', 'Concrete', 'Civil'], ['DIV 0302', 'Reinforcement Steel', 'Civil'], ['DIV 04', 'Masonry', 'Civil'], ['DIV 05', 'Metals', 'Civil'],
    ['DIV 06', 'Wood, Plastics and Composites', 'Arch'], ['DIV 07', 'Thermal and Moisture Protection', 'Arch'], ['DIV 08', 'Openings', 'Arch'],
    ['DIV 09', 'Finishes', 'Arch'], ['DIV 10', 'Specialties', 'Arch'],
    ['DIV 21', 'Fire Suppression', 'MEP'], ['DIV 22', 'Plumbing', 'MEP'], ['DIV 23', 'HVAC', 'MEP'], ['DIV 26', 'Electrical', 'MEP'], ['DIV 27', 'Communications', 'MEP'],
    ['DIV 31', 'Earthwork', 'Civil'], ['DIV 32', 'Exterior Improvements', 'Civil'], ['DIV 33', 'Utilities', 'Civil'],
    ['INDIRECT', 'Indirect', 'General']].map(([c, label, group], i) => ({ code: c, label, group, color: GROUP_COLOR[group], sort: i + 1 }));
  const MNLS = [['MAT', 'Material'], ['SUB', 'Subcontract'], ['EQU', 'Equipment'], ['LAB', 'Labor'], ['OTHER', 'Others Resources']].map(([c, label]) => ({ code: c, label }));
  const normPkg = (c) => { const t = str(c), m = /^DIV\s*(\d{1,4})$/i.exec(t); return m ? 'DIV ' + m[1].padStart(m[1].length > 2 ? 4 : 2, '0') : t; };
  // SAP material groups carry the MasterFormat division: M030201 = reinforcement, M0402 = masonry, M26013 = electrical cable
  const DIV_FROM_GROUP = { '03': 'DIV 03', '04': 'DIV 04', '05': 'DIV 05', '06': 'DIV 06', '07': 'DIV 07', '08': 'DIV 08', '09': 'DIV 09', '10': 'DIV 10',
    '21': 'DIV 21', '22': 'DIV 22', '23': 'DIV 23', '25': 'DIV 27', '26': 'DIV 26', '27': 'DIV 27', '28': 'DIV 27', '31': 'DIV 31', '32': 'DIV 32', '33': 'DIV 33' };
  const INDIRECT_GROUP = { SM: 'safety', SH: 'site housing', CS: 'camp supplies', OS: 'office supplies', IT: 'IT', P0: 'plant & tools', SP: 'spare parts & fuel',
    A0: 'site assets', G0: 'general hardware', SR: 'survey', SC: 'scrap' };
  function suggestFor(group, packages) {
    const g = str(group), has = (c) => !packages || packages.some((p) => p.code === c), out = {};
    let m;
    if ((m = /^M(\d{2})(\d{2})?/.exec(g))) {
      const d = m[1];
      if (d === '03' && m[2] === '02' && has('DIV 0302')) out.package = ['DIV 0302', `material group ${g} (03 02 reinforcement)`];
      else if (d === '00' && g.length > 3) out.package = ['DIV 03', `material group ${g} (basic building materials)`];
      else if (DIV_FROM_GROUP[d]) out.package = [DIV_FROM_GROUP[d], `material group ${g} (division ${d})`];
      out.mnl = ['MAT', 'M material group'];
    } else {
      const p = g.slice(0, 2).toUpperCase();
      if (INDIRECT_GROUP[p]) out.package = ['INDIRECT', `material group ${g} (${INDIRECT_GROUP[p]})`];
      out.mnl = /^(SP|P0|SR)/i.test(g) ? ['EQU', `material group ${g} (${INDIRECT_GROUP[p]})`] : ['MAT', 'material'];
    }
    if (out.package && !has(out.package[0])) delete out.package;
    return out;
  }

  // ================================================================== PARSE
  function parseME2N(aoa) {
    const { ix, hr, missing } = mapColumns('me', aoa); if (missing.length) return { error: missing };
    const lines = []; let skipped = 0;
    for (const row of aoa.slice(hr + 1)) {
      const g = getter(row || [], ix), po = code(g('po'));
      if (!po || !code(g('material'))) { skipped++; continue; }
      const vendor = str(g('vendor')), first = vendor.split(/\s+/)[0] || '';
      const pu = num(g('priceUnit')), np = num(g('netPrice'));
      lines.push({ po, item: code(g('item')), key: po + '/' + code(g('item')), date: toDate(g('date')), vendor, vendorCode: first,
        // a supplying plant / storage location (SBD1, C002) rather than a vendor number means a stock transport order from own stores
        kind: /^\d+$/.test(first) ? 'PUR' : 'STO', material: code(g('material')), group: str(g('group')), text: str(g('text')), unit: str(g('unit')),
        del: str(g('del')), qty: num(g('qty')), priceUnit: pu, netPrice: np, unitPrice: np ? np / (pu || 1) : 0, value: num(g('value')),
        openQty: num(g('openQty')), openVal: num(g('openVal')), invQty: num(g('invQty')), invVal: num(g('invVal')), pr: code(g('pr')), issSloc: str(g('issSloc')) });
    }
    return { lines, skipped };
  }
  function parseMB51(aoa) {
    const { ix, hr, missing } = mapColumns('mb', aoa); if (missing.length) return { error: missing };
    const rows = []; let skipped = 0;
    for (const row of aoa.slice(hr + 1)) {
      const g = getter(row || [], ix), doc = code(g('doc'));
      if (!doc || !code(g('material'))) { skipped++; continue; }
      const date = toDate(g('pdate'));
      rows.push({ material: code(g('material')), plant: str(g('plant')), sloc: str(g('sloc')), mvt: str(g('mvt')).toUpperCase(), mvtText: str(g('mvtText')),
        doc, item: code(g('item')), year: code(g('year')), key: doc + '/' + code(g('year')) + '/' + code(g('item')), date, month: monthKey(date),
        desc: str(g('desc')), qty: num(g('qty')), amt: num(g('amt')), uom: str(g('uom')), po: code(g('po')), poItem: code(g('poItem')),
        ts: ix.edate >= 0 ? stamp(g('edate'), g('etime')) : null,
        supplier: code(g('supplier')), wbs: str(g('wbs')), order: code(g('order')), text: str(g('text')), headerText: str(g('headerText')) });
    }
    return { rows, skipped, hasTs: ix.edate >= 0 };
  }
  function parseCJI3(aoa) {
    const { ix, hr, missing } = mapColumns('cji', aoa); if (missing.length) return { error: missing };
    const lines = []; let skipped = 0, printedTotal = null;
    for (const row of aoa.slice(hr + 1)) {
      const g = getter(row || [], ix), docNo = str(g('docNo'));
      if (!docNo) {                                   // SAP subtotal row: the grand total has neither cost element nor object
        skipped++;
        if (!str(g('ce')) && !str(g('wbs')) && (row || []).some((v) => str(v) !== '')) { const a = num(g('amt')); if (printedTotal === null || Math.abs(a) > Math.abs(printedTotal)) printedTotal = a; }
        continue;
      }
      const date = toDate(g('pdate'));
      lines.push({ docNo, postRow: code(g('postRow')), fy: code(g('fy')), key: docNo + '/' + code(g('postRow')) + '/' + code(g('fy')),
        ce: code(g('ce')), ceName: str(g('ceName')), amt: num(g('amt')), wbs: str(g('wbs')), coName: str(g('coName')), date, month: monthKey(date),
        docType: str(g('docType')), refDoc: code(g('refDoc')), refItem: code(g('refItem')), refFy: code(g('refFy')),
        refKey: code(g('refDoc')) + '/' + code(g('refFy')) + '/' + code(g('refItem')),
        material: code(g('material')), matDesc: str(g('matDesc')), qty: num(g('qty')), uom: str(g('uom')),
        reversal: str(g('revDoc')) === 'X', reversed: str(g('reversed')) === 'X', project: str(g('project')), plant: str(g('plant')),
        ts: ix.created >= 0 ? stamp(g('created'), g('ctime')) : null });
    }
    return { lines, skipped, printedTotal, hasTs: ix.created >= 0 };
  }

  // ================================================================== ANALYSE
  // src: { me: aoa, mb: aoa, cji: aoa }  opts: { coding: Map(material -> {package, mnl, cec}), prev, dataDate, packages, mnl, files }
  function analyse(src, opts) {
    opts = opts || {};
    const warnings = [], errors = [];
    const ME = parseME2N(src.me || [[]]), MB = parseMB51(src.mb || [[]]), CJ = parseCJI3(src.cji || [[]]);
    for (const [k, P] of [['me', ME], ['mb', MB], ['cji', CJ]]) if (P.error) errors.push(`${LAYOUT[k].title}: missing column${P.error.length > 1 ? 's' : ''} ${P.error.map((x) => '"' + x + '"').join(', ')}`);
    if (errors.length) return { errors };
    const packages = opts.packages || PACKAGES, mnls = opts.mnl || MNLS;

    // ---- ME2N: material master (group, text, unit) and PO kind
    const poKind = new Map(); const matME = new Map();
    for (const l of ME.lines) {
      if (!poKind.has(l.po)) poKind.set(l.po, l.kind);
      const cur = matME.get(l.material);
      if (!cur || (l.date && (!cur.date || l.date > cur.date))) matME.set(l.material, { group: l.group, text: l.text, unit: l.unit, date: l.date });
    }
    // ---- MB51: classify
    const movByKey = new Map(); let dupMov = 0;
    for (const m of MB.rows) { m.cls = classify(m, poKind); if (movByKey.has(m.key)) dupMov++; else movByKey.set(m.key, m); }
    if (dupMov) warnings.push(`${dupMov} MB51 lines repeat a material document + item already seen – the second copy is ignored for matching.`);
    // ---- CJI3: WA only, tie each line to its movement
    const nonWA = CJ.lines.filter((l) => l.docType !== 'WA');
    const costAll = CJ.lines.filter((l) => l.docType === 'WA');
    const dupCost = costAll.length - new Set(costAll.map((l) => l.key)).size;
    if (dupCost) warnings.push(`${dupCost} CJI3 lines repeat a document + posting row + year. Check that the extract was not pasted twice.`);
    for (const l of costAll) {
      const m = movByKey.get(l.refKey);
      l.mov = m || null; l.cls = m ? m.cls : null; l.costClass = costClassOf(l.cls);
      l.mqty = m ? -m.qty : 0;                        // consumption quantity (MB51 issues are negative)
      if (m) m.costLine = l;
      // a cost line and its movement are one save in SAP (their stamps differ by a second at most); the movement's stamp decides,
      // so quantity and cost always fall on the same side of the cut-off
      l.entry = (m && m.ts !== null) ? m.ts : (l.ts !== null ? l.ts : (l.date ? stamp(l.date, null) : null));
    }
    const plants = [...new Set(MB.rows.map((m) => m.plant).concat(costAll.map((l) => l.plant)).filter(Boolean))];
    const PLANT = plants.length === 1 ? plants[0] : (plants.sort().join('+') || '');
    const PROJECT = [...new Set(costAll.map((l) => l.project).filter(Boolean))].join(', ');

    // ---- report period: report month + cut-off (a moment in time), and the cut-offs of the reports before this one
    const postMonths = [...new Set(costAll.map((l) => l.month).filter(Boolean))].sort((a, b) => a - b);
    const maxEntry = costAll.reduce((a, l) => (l.entry !== null && l.entry > a ? l.entry : a), -Infinity);
    const reportMonth = opts.reportMonth || postMonths[postMonths.length - 1] || 0;
    const cutoff = (opts.cutoff !== undefined && opts.cutoff !== null) ? opts.cutoff : Infinity;
    const openingBefore = opts.openingBefore || 0;
    if (!CJ.hasTs) warnings.push('CJI3 has no "Created on" column – the cut-off falls back to the posting date, so back-dated postings cannot be caught.');
    // reports already issued, oldest first; a re-run of this month (or an earlier one) is not history
    const history = (opts.history || []).filter((h) => h.reportMonth && h.cutoff && h.reportMonth < reportMonth && h.cutoff < cutoff)
      .sort((a, b) => a.reportMonth - b.reportMonth);
    const periods = history.concat([{ reportMonth, cutoff, current: true }]);
    // A line belongs to the first report whose cut-off it was entered before and whose month it has reached. In that report
    // it sits in its posting month if that month was still open, else in the report month (a late posting). Months already
    // reported never change: a back-dated line entered after their cut-off lands in the first report that sees it.
    const place = (entry, month) => {
      const t = entry === null ? endOfMonth(month) : entry;
      let closed = 0;
      for (const p of periods) {
        if (t <= p.cutoff && month <= p.reportMonth) return { bucket: month > closed ? month : p.reportMonth, late: !(month > closed), in: p.reportMonth, now: !!p.current };
        closed = p.reportMonth;
      }
      return { bucket: 'PENDING', late: false, in: null, now: false };
    };
    for (const l of costAll) {
      const x = place(l.entry, l.month); l.bucket = x.bucket; l.late = x.late; l.reportedIn = x.in;
      if (typeof l.bucket === 'number' && openingBefore && l.bucket < openingBefore) l.bucket = 'OPENING';
      // the four boxes: posting month (in / after the report month) × Created on (up to / after the cut-off)
      const inMonth = l.month <= reportMonth, known = (l.entry === null ? endOfMonth(l.month) : l.entry) <= cutoff;
      l.status = l.bucket !== 'PENDING' ? (l.late ? 'Late posting' : 'In report')
        : (inMonth ? 'Pending – entered after cut-off' : (known ? 'Pending – next month, already entered' : 'Pending – next month'));
      l.why = l.bucket === 'PENDING' ? (l.month > reportMonth ? `posted in ${mlabel(l.month)}, after the report month` : `entered ${cutText(l.entry)}, after the cut-off – counted in the next report`)
        : (l.late ? `posted ${dtext(l.date)} but entered ${cutText(l.entry)}, after ${mlabel(l.month)} was reported – counted in ${mlabel(l.reportedIn)}` : '');
    }
    for (const m of MB.rows) { const x = place(m.ts !== null ? m.ts : (m.date ? stamp(m.date, null) : null), m.month); m.pending = x.bucket === 'PENDING'; }
    const cost = costAll.filter((l) => l.bucket !== 'PENDING'), pending = costAll.filter((l) => l.bucket === 'PENDING');
    const movIn = MB.rows.filter((m) => !m.pending);
    const dataDate = isFinite(cutoff) ? dayOf(cutoff) : (opts.dataDate || [...costAll.map((l) => l.date)].filter(Boolean).reduce((a, b) => (b > a ? b : a), null));
    const first = cost.reduce((a, l) => (typeof l.bucket === 'number' && l.bucket < a ? l.bucket : a), reportMonth || Infinity);
    const months = []; if (reportMonth) for (let mk = first; mk <= reportMonth; mk = nextMonth(mk)) months.push(mk);   // contiguous, oldest first
    const hasOpening = cost.some((l) => l.bucket === 'OPENING');
    const curMonth = reportMonth;

    // ---- materials: every material that has cost, a movement, or an open PO line
    const mats = new Map();
    const mat = (id) => {
      let r = mats.get(id);
      if (!r) { const me = matME.get(id);
        r = { material: id, desc: me ? me.text : '', group: me ? me.group : '', unit: '', poUnit: me ? me.unit : '', qty: {}, val: {}, ordered: 0, orderedVal: 0,
          openQty: 0, openVal: 0, stoOrdered: 0, stoOpen: 0, cost: 0, pendingCost: 0, costBy: {}, costQty: 0, consQty: 0, byMonth: {}, qtyByMonth: {}, issCostByMonth: {}, wbs: new Set(),
          po: [], cjiUnit: '', lastMove: null, pendingMov: 0 };
        mats.set(id, r); }
      return r;
    };
    for (const m of MB.rows) {
      const r = mat(m.material);
      if (!r.desc) r.desc = m.desc; if (!r.unit) r.unit = m.uom;
      if (m.pending) { r.pendingMov++; continue; }     // after the cut-off: next report's movement
      add(r.qty, m.cls, m.qty); add(r.val, m.cls, m.amt);
      if (m.date && (!r.lastMove || m.date > r.lastMove)) r.lastMove = m.date;
    }
    for (const l of ME.lines) {
      const r = mat(l.material); if (!r.unit) r.unit = l.unit;
      r.po.push(l);
      if (l.del === 'L') continue;                      // deleted items are neither ordered nor open
      if (l.kind === 'PUR') { r.ordered += l.qty; r.orderedVal += l.value; r.openQty += l.openQty; r.openVal += l.openVal; }
      else { r.stoOrdered += l.qty; r.stoOpen += l.openQty; }
    }
    for (const l of costAll) {
      const r = mat(l.material); if (!r.desc) r.desc = l.matDesc; if (!r.cjiUnit) r.cjiUnit = l.uom; if (!r.unit) r.unit = l.uom;
      if (l.bucket === 'PENDING') { r.pendingCost += l.amt; continue; }
      r.cost += l.amt; add(r.costBy, l.costClass, l.amt); add(r.byMonth, l.bucket, l.amt);
      if (l.cls === 'ISS_P' || l.cls === 'ISS_S') { r.consQty += l.mqty; add(r.qtyByMonth, l.bucket, l.mqty); add(r.issCostByMonth, l.bucket, l.amt); r.costQty += l.amt; }
      if (l.wbs) r.wbs.add(l.wbs);
    }
    // coding: what was coded, else nothing (suggestions are only proposals until someone accepts them)
    const coding = opts.coding || new Map();
    for (const r of mats.values()) {
      const c = coding.get(r.material) || {};
      r.package = normPkg(c.package || ''); r.mnl = c.mnl || ''; r.cec = c.cec || '';
      r.sugg = suggestFor(r.group, packages);
      for (const c of Object.keys(r.qty)) r.qty[c] = q6(r.qty[c]);
      r.consQty = q6(r.consQty); r.ordered = q6(r.ordered); r.openQty = q6(r.openQty);
      r.balance = q6(CLASSES.filter((c) => c.stock).reduce((s, c) => s + (r.qty[c.code] || 0), 0));
      r.issuePrice = r.consQty > 1e-9 ? r.costQty / r.consQty : null;
      // price: purchase lines only, priced, not deleted
      const byDate = (a, b) => cmp(a.date ? a.date.getTime() : 0, b.date ? b.date.getTime() : 0) || cmp(a.key, b.key);
      const pl = r.po.filter((l) => l.kind === 'PUR' && l.unitPrice > 0 && l.del !== 'L').sort(byDate);
      if (pl.length) {
        const q = sum(pl, (l) => l.qty);
        r.price = { n: pl.length, vendors: new Set(pl.map((l) => l.vendor)).size, min: Math.min(...pl.map((l) => l.unitPrice)), max: Math.max(...pl.map((l) => l.unitPrice)),
          last: pl[pl.length - 1], wavg: q ? sum(pl, (l) => l.unitPrice * l.qty) / q : sum(pl, (l) => l.unitPrice) / pl.length };
        r.price.spread = r.price.min ? r.price.max / r.price.min - 1 : null;
      } else r.price = null;
      // last vendor: the latest purchase line (issues from stock carry no vendor)
      const lv = r.po.filter((l) => l.kind === 'PUR').sort(byDate).pop();
      r.lastVendorCode = lv ? lv.vendorCode : ''; r.lastVendorName = lv ? lv.vendor.slice(lv.vendorCode.length).trim() : '';
      r.priceVar = r.price && r.issuePrice !== null && r.price.wavg ? r.issuePrice / r.price.wavg - 1 : null;
      if (!r.unit) r.unit = r.poUnit;
    }
    const list = [...mats.values()].sort((a, b) => b.cost - a.cost || cmp(a.material, b.material));
    const loadNo = ((opts.prev && opts.prev.loads && opts.prev.loads.length) ? Math.max(...opts.prev.loads.map((l) => l.no || 0)) : 0) + 1;

    // ---- Material Monthly rows: one per material × line type, like Service Monthly's service × PO line.
    // Each row keeps a permanent Row ID from load to load (hidden _Rows sheet); new rows take the next free number.
    const prevRows = (opts.prev && opts.prev.rows) || new Map();
    const mm = new Map();
    for (const l of costAll) {
      l.lineType = LINE_TYPE[l.cls] || (l.cls ? 'Other (' + l.cls + ')' : 'No MB51 movement');
      const key = l.material + '|' + l.lineType, q = l.mov ? l.mqty : l.qty; l.rowKey = key;
      let o = mm.get(key);
      if (!o) { o = { key, material: l.material, lineType: l.lineType, amt: 0, qty: 0, byMonth: {}, qtyByMonth: {} }; mm.set(key, o); }
      if (l.bucket !== 'PENDING') { o.amt += l.amt; o.qty += q; }
      add(o.byMonth, l.bucket, l.amt); add(o.qtyByMonth, l.bucket, q);
    }
    let nextId = Math.max(0, ...[...prevRows.values()].map((x) => x.id || 0));
    const rowIds = new Map(prevRows);                 // rows that went away keep their number, so an ID is never reused
    for (const key of [...mm.keys()].filter((k) => !prevRows.has(k)).sort()) rowIds.set(key, { id: ++nextId, first: loadNo });
    for (const o of mm.values()) { const x = rowIds.get(o.key); o.id = x.id; o.first = x.first; o.isNew = !!opts.prev && x.first === loadNo; }
    const monthlyRows = [...mm.values()];

    // ---- totals (reported = up to the cut-off; pending is shown, never added)
    const T = sum(cost, (l) => l.amt);
    const byClassCost = {}; for (const l of cost) add(byClassCost, l.costClass, l.amt);
    const val = (cls) => sum(movIn.filter((m) => m.cls === cls), (m) => m.amt);
    const lateL = cost.filter((l) => l.late);
    const boxes = {}; for (const l of costAll) { const b = boxes[l.status] || (boxes[l.status] = { n: 0, amt: 0 }); b.n++; b.amt += l.amt; }
    const k = {
      cost: T, costLines: cost.length, costAll: sum(costAll, (l) => l.amt), printedTotal: CJ.printedTotal, skippedCji: CJ.skipped,
      pending: sum(pending, (l) => l.amt), pendingLines: pending.length, late: sum(lateL, (l) => l.amt), lateLines: lateL.length,
      pendingMov: MB.rows.length - movIn.length, maxEntry: isFinite(maxEntry) ? maxEntry : null,
      project: byClassCost[COST_CLASS.ISS_P] || 0, subcon: byClassCost[COST_CLASS.ISS_S] || 0, scrap: byClassCost[COST_CLASS.SCRAP] || 0,
      unmatched: sum(cost.filter((l) => !l.mov), (l) => l.amt), opening: sum(cost.filter((l) => l.bucket === 'OPENING'), (l) => l.amt),
      thisMonth: sum(cost.filter((l) => l.bucket === reportMonth), (l) => l.amt), curMonth,
      receivedVendor: val('RCV_V'), ownerSupplied: val('OWNER'), toOrders: -val('ISS_O'),
      openPO: sum(ME.lines.filter((l) => l.kind === 'PUR' && l.del !== 'L'), (l) => l.openVal),
      orderedVal: sum(ME.lines.filter((l) => l.kind === 'PUR' && l.del !== 'L'), (l) => l.value),
      materials: list.filter((r) => Math.abs(r.cost) > 1e-9).length, materialsAll: list.length,
      pos: new Set(ME.lines.filter((l) => l.kind === 'PUR').map((l) => l.po)).size,
      vendors: new Set(ME.lines.filter((l) => l.kind === 'PUR').map((l) => l.vendor)).size,
      groups: new Set(list.filter((r) => Math.abs(r.cost) > 1e-9).map((r) => r.group)).size,
      movements: movIn.length, poLines: ME.lines.length, wbs: new Set(cost.map((l) => l.wbs)).size,
    };

    // ---- roll-ups (cost by report bucket by group / package)
    const roll = (keyOf) => {
      const m = new Map();
      for (const l of cost) { const r = mats.get(l.material), key = keyOf(r);
        let o = m.get(key); if (!o) { o = { key, total: 0, byMonth: {}, materials: new Set() }; m.set(key, o); }
        o.total += l.amt; add(o.byMonth, l.bucket, l.amt); o.materials.add(l.material); }
      return [...m.values()].sort((a, b) => b.total - a.total || cmp(a.key, b.key));
    };
    const byGroup = roll((r) => r.group || '(no group)');
    const byPackage = roll((r) => r.package || 'UNALLOCATED');
    const byClassMonth = {};
    for (const l of cost) { byClassMonth[l.costClass] = byClassMonth[l.costClass] || {}; add(byClassMonth[l.costClass], l.bucket, l.amt); }
    const byBucket = {}; for (const l of cost) add(byBucket, l.bucket, l.amt);

    // ---- movement type summary (what the rules did, up to the cut-off)
    const mvtSum = new Map();
    for (const m of movIn) { const kk = m.mvt + '\u0001' + m.mvtText + '\u0001' + m.cls;
      const o = mvtSum.get(kk) || { mvt: m.mvt, text: m.mvtText, cls: m.cls, n: 0, qty: 0, amt: 0, cost: 0, costN: 0 };
      o.n++; o.qty += m.qty; o.amt += m.amt; if (m.costLine && m.costLine.bucket !== 'PENDING') { o.cost += m.costLine.amt; o.costN++; } mvtSum.set(kk, o); }
    const mvtTypes = [...mvtSum.values()].sort((a, b) => cmp(a.mvt, b.mvt) || cmp(a.text, b.text));

    const A = { PLANT, PROJECT, dataDate, months, curMonth, reportMonth, cutoff, openingBefore, hasOpening, history, postMonths,
      boxes, exportCheck: opts.exportCheck || null, carryStats: opts.carryStats || null, carry: { cji: src.cji, mb: src.mb }, files: opts.files || {}, me: ME, mb: MB, cji: CJ, cost, costAll, pending, nonWA, mats, list, k, monthlyRows, rowIds, loadNo, byBucket,
      byGroup, byPackage, byClassMonth, mvtTypes, warnings, packages, mnls, prev: opts.prev || null };
    A.checks = runChecks(A);
    A.changes = diffPrevious(A);
    return A;
  }

  // Suggested cut-off for report month M: the day posting into M stopped = the latest Created on date of lines posted in M
  // or earlier, looking no further than 10 days into the next month (later stragglers become late postings next time).
  // If the file does not reach the next month yet (an early export), the latest Created on date in the file, with a warning.
  const DAY = 86400000;
  function suggestCutoff(info, M, prevCutoff) {
    if (!info || !M) return null;
    const endM = endOfMonth(M), window = endM + 10 * DAY, dayEnd = (t) => Math.floor(t / DAY) * DAY + DAY - 1000;
    if (info.maxEntry === null) return { cutoff: endM, why: 'No Created on dates in the file – suggesting the month end.', early: true };
    if (info.maxEntry <= endM) return { cutoff: dayEnd(info.maxEntry), early: true,
      why: `The file ends on ${cutText(info.maxEntry)}, inside ${mlabel(M)} – postings into ${mlabel(M)} may still come. Suggested: the last Created on date in the file.` };
    let last = endM, n = 0, nAfter = 0;
    for (const x of info.lines) { if (x.month > M || x.entry === null) continue;
      if (x.entry > endM && x.entry <= window) { n++; if (x.entry > last) last = x.entry; } else if (x.entry > window && (!prevCutoff || x.entry > prevCutoff)) nAfter++; }
    let cut = dayEnd(last); if (prevCutoff && cut <= prevCutoff) cut = dayEnd(prevCutoff + DAY);
    return { cutoff: cut, early: false, n, stragglers: nAfter,
      why: n ? `Postings into ${mlabel(M)} stopped on ${cutText(cut)}: the last of ${n} ${mlabel(M)}-or-earlier lines entered after the month end.`
        : `Nothing posted into ${mlabel(M)} was entered after the month end – the month end is enough.` };
  }
  // What the page needs to offer a report period before building: posting months and the latest entry stamp.
  function periodInfo(src) {
    const CJ = parseCJI3(src.cji || [[]]), MB = parseMB51(src.mb || [[]]);
    if (CJ.error || MB.error) return null;
    const wa = CJ.lines.filter((l) => l.docType === 'WA');
    const months = [...new Set(wa.map((l) => l.month).filter(Boolean))].sort((a, b) => a - b);
    const stamps = wa.map((l) => l.ts).concat(MB.rows.map((m) => m.ts)).filter((t) => t !== null);
    return { months, maxEntry: stamps.length ? Math.max(...stamps) : null, hasTs: CJ.hasTs, lines: wa.map((l) => ({ month: l.month, entry: l.ts !== null ? l.ts : (l.date ? stamp(l.date, null) : null) })), lastPosting: wa.reduce((a, l) => (l.date && (!a || l.date > a) ? l.date : a), null) };
  }

  // ================================================================== CARRY-FORWARD (window exports)
  // The report keeps every CJI3 line and MB51 movement it has seen, in hidden sheets with SAP's own headers, so next month
  // SAP only has to export a posting-date window (from the 1st of the previous month). Carried + new are merged on SAP's
  // line key; a line in both counts once and the new export wins (SAP is the truth).
  const canonHeader = (kind) => { const cols = LAYOUT[kind].cols, out = [];
    for (const n of Object.values(cols)) out.push(Array.isArray(n) ? n[0] : n); return out; };   // key order keeps "Posting Row" after "Ref. document number"
  const CANON = { cji: canonHeader('cji'), mb: canonHeader('mb') };
  function toCanon(kind, aoa) {
    const { ix, hr, missing } = mapColumns(kind, aoa); if (missing.length) return { error: missing };
    const keys = Object.keys(LAYOUT[kind].cols), rows = [];
    for (const row of aoa.slice(hr + 1)) { const r = row || [];
      const idKey = kind === 'cji' ? 'docNo' : 'doc'; if (!str(r[ix[idKey]])) continue;           // subtotal rows are not lines
      rows.push(keys.map((k) => (ix[k] >= 0 && r[ix[k]] !== undefined ? r[ix[k]] : ''))); }
    return { rows };
  }
  const canonKey = (kind) => { const ks = Object.keys(LAYOUT[kind].cols), at = (k) => ks.indexOf(k);
    return kind === 'cji' ? (r) => [code(r[at('docNo')]), code(r[at('postRow')]), code(r[at('fy')])].join('/')
      : (r) => [code(r[at('doc')]), code(r[at('year')]), code(r[at('item')])].join('/'); };
  const canonDate = (kind) => { const i = Object.keys(LAYOUT[kind].cols).indexOf('pdate'); return (r) => toDate(r[i]); };
  // newSrc: this month's exports; carried: { cji: aoa, mb: aoa } from the last report (or null for a first report)
  function mergeSources(newSrc, carried) {
    const out = { me: newSrc.me, stats: {}, errors: [] };
    for (const kind of ['cji', 'mb']) {
      const N = toCanon(kind, newSrc[kind] || [[]]); if (N.error) { out.errors.push(`${LAYOUT[kind].title}: missing column${N.error.length > 1 ? 's' : ''} ${N.error.map((x) => '"' + x + '"').join(', ')}`); continue; }
      const C = carried && carried[kind] ? toCanon(kind, carried[kind]) : { rows: [] };
      const key = canonKey(kind), pd = canonDate(kind);
      const dates = N.rows.map(pd).filter(Boolean), from = dates.length ? dates.reduce((a, b) => (b < a ? b : a)) : null;
      const byKey = new Map(); for (const r of C.rows || []) byKey.set(key(r), r);
      const newKeys = new Set(); let replaced = 0, changed = 0, added = 0;
      for (const r of N.rows) { const k = key(r); newKeys.add(k);
        if (byKey.has(k)) { replaced++; if (JSON.stringify(byKey.get(k).map(str)) !== JSON.stringify(r.map(str))) changed++; } else added++;
        byKey.set(k, r); }
      // carried lines inside the new export's window that the export does not contain: kept, but reported
      const missing = from ? (C.rows || []).filter((r) => { const d = pd(r); return d && d >= from && !newKeys.has(key(r)); }) : [];
      out[kind] = [CANON[kind]].concat([...byKey.values()]);
      out.stats[kind] = { carried: (C.rows || []).length, exported: N.rows.length, added, replaced, changed, missing: missing.length, missingRows: missing, from,
        to: dates.length ? dates.reduce((a, b) => (b > a ? b : a)) : null, window: !!(carried && carried[kind]) };
    }
    const E0 = parseCJI3(newSrc.cji || [[]]);
    if (!E0.error) out.exportCheck = { printed: E0.printedTotal, detail: sum(E0.lines, (l) => l.amt), lines: E0.lines.length, skipped: E0.skipped };
    return out;
  }

  // ================================================================== CHECKS
  function runChecks(A) {
    const out = [], k = A.k, tol = 1;
    const push = (c) => out.push(Object.assign({ rows: [], cols: [] }, c));
    // 1. the file ties to its own printed total
    const X = A.exportCheck || { printed: k.printedTotal, detail: sum(A.cji.lines, (l) => l.amt), lines: A.cji.lines.length, skipped: k.skippedCji };
    if (X.printed !== null && X.printed !== undefined) {
      const d = X.detail - X.printed;
      push({ id: 'total', level: Math.abs(d) <= tol ? 'good' : 'bad', title: 'CJI3 export ties to the grand total printed in the file',
        detail: `${X.lines.toLocaleString('en-US')} detail lines of this month's export sum to ${fmt(X.detail)}; the file prints ${fmt(X.printed)} (difference ${fmt(d)}). ${X.skipped} subtotal rows were skipped.`, amount: d });
    } else push({ id: 'total', level: 'warn', title: 'CJI3 has no printed grand total', detail: 'The export carries no total row, so the detail cannot be tied to SAP’s own total. Export with totals to get this check.' });
    // carry-forward: what came from the last report, what from this export, and anything missing from the window
    const cs = A.carryStats;
    if (cs && cs.cji && cs.cji.window) for (const kind of ['cji', 'mb']) { const t = cs[kind]; if (!t) continue;
      const name = kind === 'cji' ? 'CJI3 lines' : 'MB51 movements';
      push({ id: 'carry-' + kind, level: t.missing ? 'warn' : 'good', title: `${kind === 'cji' ? 'CJI3' : 'MB51'} export window merged with the last report`, count: t.missing,
        detail: `${t.carried.toLocaleString('en-US')} ${name} carried from the last report + ${t.exported.toLocaleString('en-US')} in this export (posting dates ${dtext(t.from)} → ${dtext(t.to)}): `
          + `${t.added.toLocaleString('en-US')} new, ${t.replaced.toLocaleString('en-US')} already known${t.changed ? ` (${t.changed} changed in SAP – the export's version is used)` : ''}.`
          + (t.missing ? ` ${t.missing} carried ${name} posted inside this window are NOT in the export – kept as they were. Check that the export used the same selection (project / WBS / plant).` : ''),
        cols: kind === 'cji' ? ['Document', 'Row', 'Year', 'Posting date', 'Material', 'Amount'] : ['Material doc', 'Item', 'Year', 'Posting date', 'Material', 'Qty'],
        rows: t.missingRows.slice(0, 300).map((r) => { const ks = Object.keys(LAYOUT[kind].cols), g = (x) => r[ks.indexOf(x)];
          return kind === 'cji' ? [str(g('docNo')), code(g('postRow')), code(g('fy')), dtext(toDate(g('pdate'))), code(g('material')), num(g('amt'))]
            : [code(g('doc')), code(g('item')), code(g('year')), dtext(toDate(g('pdate'))), code(g('material')), num(g('qty'))]; }) }); }
    // 2. other document types
    if (A.nonWA.length) {
      const by = {}; for (const l of A.nonWA) add(by, l.docType || '(blank)', l.amt);
      push({ id: 'nonwa', level: 'warn', title: 'CJI3 lines with a document type other than WA are left out', count: A.nonWA.length, amount: sum(A.nonWA, (l) => l.amt),
        detail: 'Material cost is taken from goods issues (WA). Excluded: ' + Object.entries(by).map(([t, v]) => `${t} ${fmt(v)}`).join(', ') + '.',
        cols: ['Doc type', 'Document', 'Posting date', 'WBS', 'Cost element', 'Material', 'Amount'], rows: A.nonWA.slice(0, 500).map((l) => [l.docType, l.docNo, dtext(l.date), l.wbs, l.ce, l.material, l.amt]) });
    }
    // 3. cost lines with no movement behind them
    const un = A.costAll.filter((l) => !l.mov);
    push({ id: 'unmatched', level: un.length ? 'bad' : 'good', title: 'Every WA cost line has its MB51 movement', count: un.length, amount: sum(un, (l) => l.amt),
      detail: un.length ? `${un.length} CJI3 lines (${fmt(sum(un, (l) => l.amt))}) point to a material document that is not in MB51. Widen the MB51 date range or plant selection.`
        : `All ${A.costAll.length.toLocaleString('en-US')} lines found their movement (material document + year + item).`,
      cols: ['Ref. document', 'Year', 'Item', 'Posting date', 'Material', 'Description', 'WBS', 'Amount'],
      rows: un.slice(0, 500).map((l) => [l.refDoc, l.refFy, l.refItem, dtext(l.date), l.material, l.matDesc, l.wbs, l.amt]) });
    // 4. matched, but disagreeing
    const dis = [];
    for (const l of A.costAll) { const m = l.mov; if (!m) continue; const why = [];
      if (m.material !== l.material) why.push(`material ${m.material} in MB51`);
      if (Math.abs(m.amt + l.amt) > 0.01) why.push(`MB51 value ${fmt(-m.amt)}`);
      if (m.wbs && l.wbs && m.wbs !== l.wbs) why.push(`MB51 WBS ${m.wbs}`);
      if (Math.abs(l.qty) > 1e-9 && Math.abs(Math.abs(l.qty) - Math.abs(m.qty)) > 1e-6) why.push(`CJI3 qty ${l.qty} vs MB51 ${m.qty}`);
      if (why.length) dis.push([l.docNo, l.refDoc, dtext(l.date), l.material, l.wbs, l.amt, why.join('; ')]); }
    push({ id: 'disagree', level: dis.length ? 'warn' : 'good', title: 'CJI3 and MB51 agree on material, value, WBS and quantity', count: dis.length,
      detail: dis.length ? `${dis.length} matched lines differ in at least one field (a zero CJI3 quantity is not counted as a difference).` : 'No differences on any matched line.',
      cols: ['CO document', 'Material doc', 'Posting date', 'Material', 'WBS', 'Amount', 'Difference'], rows: dis.slice(0, 500) });
    // 5. issues to the project with no cost line
    const nc = A.mb.rows.filter((m) => CLASS[m.cls].cost && !m.costLine && !m.pending);
    const ncv = sum(nc, (m) => m.amt);
    push({ id: 'nocost', level: !nc.length ? 'good' : (Math.abs(ncv) > tol ? 'warn' : 'info'), title: 'MB51 issues to the project that have no CJI3 cost line', count: nc.length, amount: -ncv,
      detail: nc.length ? `${nc.length} issue / scrap movements (value ${fmt(-ncv)}) are not in CJI3. Zero-value lines are usually scrap without a price; others may be outside the CJI3 date range or posted to another WBS.` : 'Every issue to the project reached CJI3.',
      cols: ['Material doc', 'Item', 'Mvt', 'Posting date', 'Material', 'Description', 'WBS', 'Qty', 'Value'],
      rows: nc.slice(0, 500).map((m) => [m.doc, m.item, m.mvt, dtext(m.date), m.material, m.desc, m.wbs, m.qty, m.amt]) });
    // 6. issues to orders – outside project cost, listed so they are seen
    const io = A.mb.rows.filter((m) => m.cls === 'ISS_O');
    if (io.length) { const byO = new Map(); for (const m of io) { const o = byO.get(m.order) || { n: 0, qty: 0, amt: 0 }; o.n++; o.amt += m.amt; byO.set(m.order, o); }
      push({ id: 'orders', level: 'info', title: 'Material issued to orders (261/262) – outside project cost', count: io.length, amount: -sum(io, (m) => m.amt),
        detail: `${fmt(-sum(io, (m) => m.amt))} of material went to ${byO.size} order${byO.size > 1 ? 's' : ''}. It is not in the CJI3 WBS extract and is not counted as project cost.`,
        cols: ['Order', 'Lines', 'Value issued'], rows: [...byO].sort((a, b) => a[1].amt - b[1].amt).map(([o, v]) => [o || '(blank)', v.n, -v.amt]) }); }
    // 7. negative stock
    const neg = A.list.filter((r) => r.balance < -1e-6);
    push({ id: 'negstock', level: neg.length ? 'warn' : 'good', title: 'No material is issued beyond what was received', count: neg.length,
      detail: neg.length ? `${neg.length} materials show more going out than coming in. Either the MB51 extract starts after the first receipts, or receipts are on another plant / storage location.` : 'Every material balance is zero or positive.',
      cols: ['Material', 'Description', 'Unit', 'In', 'Out', 'Balance'],
      rows: neg.sort((a, b) => a.balance - b.balance).slice(0, 500).map((r) => { const inn = CLASSES.filter((c) => c.stock).reduce((s, c) => s + Math.max(0, r.qty[c.code] || 0), 0);
        return [r.material, r.desc, r.unit, inn, r.balance - inn, r.balance]; }) });
    // 8. no material group
    const ng = A.list.filter((r) => !r.group);
    push({ id: 'nogroup', level: ng.length ? (ng.some((r) => Math.abs(r.cost) > tol) ? 'warn' : 'info') : 'good', title: 'Every material has a material group from ME2N', count: ng.length, amount: sum(ng, (r) => r.cost),
      detail: ng.length ? `${ng.length} materials never appear in the ME2N extract, so their group is unknown (cost ${fmt(sum(ng, (r) => r.cost))}). Widen the ME2N selection to include their POs.` : 'All materials are grouped.',
      cols: ['Material', 'Description', 'Cost', 'Last movement'], rows: ng.map((r) => [r.material, r.desc, r.cost, dtext(r.lastMove)]) });
    // 9. unit of measure
    const uu = A.list.filter((r) => (r.poUnit && r.unit && r.poUnit !== r.unit) || (r.cjiUnit && r.unit && r.cjiUnit !== r.unit));
    push({ id: 'unit', level: uu.length ? 'warn' : 'good', title: 'ME2N, MB51 and CJI3 use the same unit per material', count: uu.length,
      detail: uu.length ? `${uu.length} materials are ordered or costed in a different unit from the one they move in. Quantities in the chain are not comparable for them.` : 'One unit per material across all three sources.',
      cols: ['Material', 'Description', 'MB51 unit', 'ME2N order unit', 'CJI3 unit'], rows: uu.map((r) => [r.material, r.desc, r.unit, r.poUnit, r.cjiUnit]) });
    // 10. movement types outside the rules
    const ot = A.mvtTypes.filter((t) => t.cls === 'OTHER');
    push({ id: 'mvt', level: ot.length ? 'warn' : 'good', title: 'Every movement type is in the classification rules', count: sum(ot, (t) => t.n),
      detail: ot.length ? `Movement types ${ot.map((t) => t.mvt).join(', ')} are not classified; they count toward the stock balance under "Other".` : `${A.mvtTypes.length} movement type variants, all classified.`,
      cols: ['Movement', 'Text', 'Lines', 'Qty', 'Value'], rows: ot.map((t) => [t.mvt, t.text, t.n, t.qty, t.amt]) });
    // 11. the cut-off: what waits for the next report, and what arrived late for a month already reported
    push({ id: 'cutoff', level: 'info', title: `Cut-off ${isFinite(A.cutoff) ? cutText(A.cutoff) : '(none – everything counted)'} for ${mlabel(A.reportMonth)}`,
      count: A.pending.length, amount: A.k.pending,
      detail: `${A.pending.length.toLocaleString('en-US')} cost lines (${fmt(A.k.pending)}) were entered after the cut-off or posted after ${mlabel(A.reportMonth)}: they are Pending here and count in the next report. `
        + `${A.k.pendingMov.toLocaleString('en-US')} MB51 movements are outside the quantity chain for the same reason. Latest Created on date in the files: ${cutText(A.k.maxEntry)}.`,
      cols: ['Posting date', 'Created on', 'Status', 'Material', 'Description', 'WBS', 'Amount'],
      rows: A.pending.slice().sort((a, b) => a.entry - b.entry).slice(0, 500).map((l) => [dtext(l.date), cutText(l.entry), l.status, l.material, l.matDesc, l.wbs, l.amt]) });
    const late = A.cost.filter((l) => l.late);
    if (A.history.length) push({ id: 'late', level: late.length ? 'warn' : 'good', title: 'Late postings into months already reported', count: late.length, amount: A.k.late,
      detail: late.length ? `${late.length} lines (${fmt(A.k.late)}) were posted in a month that an earlier report had already closed. Closed months stay as reported; these lines are counted in the month of the report that first saw them.`
        : 'No back-dated postings reached a closed month.',
      cols: ['Posting date', 'Created on', 'Material', 'Description', 'Counted in', 'Amount'],
      rows: late.slice(0, 500).map((l) => [dtext(l.date), cutText(l.entry), l.material, l.matDesc, mlabel(l.bucket), l.amt]) });
    // 12. closed months must not move: every month an earlier report showed should come out the same
    const snapM = A.prev && A.prev.months;
    if (snapM && snapM.size && A.history.length) {
      const lastRM = A.history[A.history.length - 1].reportMonth, diffs = [];
      for (const [b, v] of snapM) { if (b === 'PENDING' || (b === 'OPENING' && (A.prev.meta.openingBefore || 0) !== (A.openingBefore || 0))) continue; const mk = /^\d{4}-\d{2}$/.test(b) ? +b.replace('-', '') : b;
        if (typeof mk === 'number' && mk > lastRM) continue;
        const now = typeof mk === 'number' && A.openingBefore && mk < A.openingBefore ? null : (A.byBucket[mk] || 0);
        if (now !== null && Math.abs(now - v) > 1) diffs.push([bucketLabel(mk), v, now, now - v]); }
      push({ id: 'frozen', level: diffs.length ? 'bad' : 'good', title: 'Months already reported are unchanged', count: diffs.length,
        detail: diffs.length ? 'These months differ from the last report. Check that the CJI3 extract covers the whole project period and that the last report was loaded.' : 'Every month the last report showed comes out the same.',
        cols: ['Month', 'Last report', 'Now', 'Difference'], rows: diffs });
    }
    // 13. price variance
    const pv = A.list.filter((r) => r.priceVar !== null && Math.abs(r.priceVar) > 0.10 && Math.abs(r.cost) > 1000);
    push({ id: 'price', level: pv.length ? 'info' : 'good', title: 'Issue price within ±10% of the weighted PO price', count: pv.length,
      detail: pv.length ? `${pv.length} materials with more than 1,000 of cost are issued at a price more than 10% away from what they were bought for (stock bought earlier, owner-supplied stock, or price changes).` : 'All issue prices sit within 10% of the PO price.',
      cols: ['Material', 'Description', 'Unit', 'Weighted PO price', 'Avg issue price', 'Variance', 'Cost'],
      rows: pv.sort((a, b) => Math.abs(b.priceVar) - Math.abs(a.priceVar)).map((r) => [r.material, r.desc, r.unit, r.price.wavg, r.issuePrice, r.priceVar, r.cost]) });
    return out;
  }
  const fmt = (v) => { if (v === null || v === undefined) return '–'; const r = Math.round(Number(v)); return (r === 0 ? 0 : r).toLocaleString('en-US'); };

  // ================================================================== CHANGES vs previous report
  function diffPrevious(A) {
    const P = A.prev; if (!P || !P.snap || !P.snap.size) return { has: false, rows: [], newPO: [] };
    const rows = [];
    for (const r of A.list) {
      const p = P.snap.get(r.material);
      const now = { cost: r.cost, cons: r.consQty, bal: r.balance, open: r.openQty };
      if (!p) { if (Math.abs(r.cost) > 1e-9 || Math.abs(r.consQty) > 1e-9) rows.push({ type: 'New', r, prev: null, now }); continue; }
      const dc = r.cost - p.cost, dq = r.consQty - p.cons, db = r.balance - p.bal;
      if (Math.abs(dc) > 0.5) rows.push({ type: 'Cost moved', r, prev: p, now });
      else if (Math.abs(db) > 1e-6 || Math.abs(dq) > 1e-6 || Math.abs(r.openQty - p.open) > 1e-6) rows.push({ type: 'Qty moved', r, prev: p, now });
    }
    for (const [id, p] of P.snap) if (!A.mats.has(id) && (Math.abs(p.cost) > 1e-9)) rows.push({ type: 'Gone', r: { material: id, desc: p.desc, group: p.group, unit: p.unit }, prev: p, now: { cost: 0, cons: 0, bal: 0, open: 0 } });
    const known = P.poKeys || new Set();
    const newPO = known.size ? A.me.lines.filter((l) => !known.has(l.key)) : [];
    rows.sort((a, b) => Math.abs(b.now.cost - (b.prev ? b.prev.cost : 0)) - Math.abs(a.now.cost - (a.prev ? a.prev.cost : 0)));
    const count = {}; for (const x of rows) { count[x.type] = count[x.type] || [0, 0]; count[x.type][0]++; count[x.type][1] += x.now.cost - (x.prev ? x.prev.cost : 0); }
    return { has: true, rows, newPO, count, prevDate: P.meta && P.meta.dataDate, prevLoad: P.meta && P.meta.loadNo };
  }

  // ================================================================== READ PREVIOUS REPORT
  // aoaBySheet: {sheetName: aoa} from the previous workbook (values only)
  function readPrevious(aoaBySheet) {
    const P = { coding: new Map(), loads: [], snap: new Map(), poKeys: new Set(), rows: new Map(), meta: {} };
    const idx = (aoa, hr) => { const h = (aoa[hr] || []).map(str); return (n) => h.indexOf(n); };
    const meta = aoaBySheet['_Meta'];
    if (meta) for (const r of meta) if (str(r[0])) P.meta[str(r[0])] = r[1];
    if (!meta && !aoaBySheet['Material Coding']) return null;
    const mc = aoaBySheet['Material Coding'];
    if (mc) { const hr = mc.findIndex((r) => (r || []).map(str).includes('Material') && (r || []).map(str).includes('Package')); const i = idx(mc, hr);
      for (const r of mc.slice(hr + 1)) { const m = code(r[i('Material')]); if (!m) continue;
        const pk = normPkg(r[i('Package')]), mn = str(r[i('MNL')]), ce = str(r[i('Cost element')]);
        if (pk || mn || ce) P.coding.set(m, { package: pk, mnl: mn, cec: ce }); } }
    const lh = aoaBySheet['Load history'];
    if (lh) { const hr = lh.findIndex((r) => (r || []).map(str).includes('Load')); const i = idx(lh, hr);
      for (const r of lh.slice(hr + 1)) { if (!num(r[i('Load')])) continue;
        P.loads.push({ no: num(r[i('Load')]), run: toDate(r[i('Run on')]), dataDate: toDate(r[i('Data date')]), files: str(r[i('Files')]), cost: num(r[i('Material cost')]),
          project: num(r[i('Project consumption')]), subcon: num(r[i('To subcontractors')]), openPO: num(r[i('Open PO value')]), materials: num(r[i('Materials with cost')]), lines: num(r[i('Cost lines')]),
          reportMonth: /^\d{4}-\d{2}$/.test(str(r[i('Report month')])) ? +str(r[i('Report month')]).replace('-', '') : 0, cutoff: tsParse(r[i('Cut-off')]), pending: num(r[i('Pending')]) }); } }
    const mo = aoaBySheet['_Months'];
    if (mo) { P.months = new Map(); for (const r of mo.slice(1)) if (str(r[0])) P.months.set(str(r[0]), num(r[1])); }
    const sn = aoaBySheet['_Snap'];
    if (sn) { const i = idx(sn, 0);
      for (const r of sn.slice(1)) { const m = code(r[i('Material')]); if (!m) continue;
        P.snap.set(m, { desc: str(r[i('Description')]), group: str(r[i('Group')]), unit: str(r[i('Unit')]), cost: num(r[i('Cost')]), cons: num(r[i('Consumed')]), bal: num(r[i('Balance')]), open: num(r[i('Open PO')]) }); } }
    if (aoaBySheet['_CJI3'] && aoaBySheet['_MB51']) P.carried = { cji: aoaBySheet['_CJI3'], mb: aoaBySheet['_MB51'] };
    const pk = aoaBySheet['_POs'];
    if (pk) for (const r of pk.slice(1)) if (str(r[0])) P.poKeys.add(str(r[0]));
    const rw = aoaBySheet['_Rows'];
    if (rw) for (const r of rw.slice(1)) if (str(r[0]) && num(r[1])) P.rows.set(str(r[0]), { id: num(r[1]), first: num(r[2]) || 1 });
    P.meta.dataDate = toDate(P.meta.dataDate);
    P.meta.cutoff = tsParse(P.meta.cutoff); P.meta.reportMonth = /^\d{4}-\d{2}$/.test(str(P.meta.reportMonth)) ? +str(P.meta.reportMonth).replace('-', '') : 0;
    P.meta.openingBefore = /^\d{4}-\d{2}$/.test(str(P.meta.openingBefore)) ? +str(P.meta.openingBefore).replace('-', '') : 0;
    P.project = str(P.meta.plant);
    return P;
  }

  // ================================================================== SUMMARY for the page
  function summarize(A) {
    const top = (arr, n) => arr.slice(0, n);
    return { k: A.k, months: A.months, byGroup: A.byGroup, byPackage: A.byPackage, top: top(A.list.filter((r) => Math.abs(r.cost) > 1e-9), 15), checks: A.checks,
      loads: (A.prev && A.prev.loads ? A.prev.loads : []).concat([loadRow(A)]) };
  }
  const loadRow = (A) => ({ no: A.loadNo, run: new Date(), dataDate: A.dataDate, reportMonth: A.reportMonth, cutoff: A.cutoff, pending: A.k.pending, files: Object.values(A.files || {}).filter(Boolean).join(' · '), cost: A.k.cost,
    project: A.k.project, subcon: A.k.subcon, openPO: A.k.openPO, materials: A.k.materials, lines: A.k.costLines });

  // ================================================================== WORKBOOK
  const st = {
    T1: { name: 'Arial', size: 14, bold: true, color: { argb: 'FF15223A' } }, T2: { name: 'Arial', size: 10, color: { argb: 'FF5A6678' } },
    H: { name: 'Arial', size: 9, bold: true, color: { argb: 'FFFFFFFF' } }, HB: { name: 'Arial', size: 9, bold: true, color: { argb: 'FF15223A' } },
    F: { name: 'Arial', size: 9 }, FB: { name: 'Arial', size: 9, bold: true },
  };
  const solid = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
  const FILL = { HF: solid('FF1F4E9A'), YF: solid('FFFFF2CC'), TOT: solid('FFE6EEFA'), SUB: solid('FFF3F5F8'), GOOD: solid('FFE3F3EA'), WARN: solid('FFFCF1DC'), BAD: solid('FFFDE8E6') };
  const NF = { amt: '#,##0;[Red]-#,##0;"–"', amt2: '#,##0.00;[Red]-#,##0.00;"–"', qty: '#,##0.###;[Red]-#,##0.###;"–"', pct: '0.0%;[Red]-0.0%;"–"', date: 'yyyy-mm-dd' };
  const colL = (n) => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

  function table(ws, top, cols, rows, o) {
    o = o || {};
    // cols: [{h, w, nf, key?, edit?, f?(rowNo) formula, res?}] rows: arrays aligned to cols (value or {formula,result})
    const hr = ws.getRow(top);
    cols.forEach((c, j) => { const cell = hr.getCell(j + 1); cell.value = c.h; cell.font = c.edit ? st.HB : st.H; cell.fill = c.edit ? FILL.YF : FILL.HF;
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }; if (c.w) ws.getColumn(j + 1).width = c.w; });
    hr.height = 30;
    rows.forEach((r, i) => { const row = ws.getRow(top + 1 + i);
      r.forEach((v, j) => { const cell = row.getCell(j + 1); cell.value = v === '' || v === undefined ? null : v; const c = cols[j];
        if (c.nf) cell.numFmt = c.nf; if (c.text) cell.numFmt = '@'; cell.font = st.F; if (c.edit) cell.fill = FILL.YF; }); });
    if (o.filter !== false && rows.length) ws.autoFilter = { from: { row: top, column: 1 }, to: { row: top + rows.length, column: cols.length } };
    ws.views = [{ state: 'frozen', xSplit: o.xSplit || 0, ySplit: top }];
    return top + rows.length;
  }
  function titleBand(ws, A, title, sub) {
    ws.getCell('A1').value = title; ws.getCell('A1').font = st.T1;
    ws.getCell('A2').value = sub || `${A.PLANT}${A.PROJECT ? ' · ' + A.PROJECT : ''} · report ${mlabel(A.reportMonth)} · cut-off ${isFinite(A.cutoff) ? cutText(A.cutoff) : 'none'} · load ${A.loadNo}`; ws.getCell('A2').font = st.T2;
  }

  async function buildWorkbook(A, libs) {
    const wb = new libs.ExcelJS.Workbook(); wb.creator = 'Material cost report'; wb.created = new Date();
    wb.calcProperties = { fullCalcOnLoad: true };
    const nM = A.list.length, nC = A.cost.length;
    const months = A.months;
    // ---------------- sheet order: reports first, then files, then the hidden machinery
    const wsDash = wb.addWorksheet('Dashboard', { properties: { tabColor: { argb: 'FF1F4E9A' } } });
    const wsMM = wb.addWorksheet('Material Monthly', { properties: { tabColor: { argb: 'FF1F4E9A' } } });
    const wsPM = wb.addWorksheet('Package Monthly', { properties: { tabColor: { argb: 'FF1F4E9A' } } });
    const wsMat = wb.addWorksheet('Materials', { properties: { tabColor: { argb: 'FF1F4E9A' } } });
    const wsPrice = wb.addWorksheet('Price', { properties: { tabColor: { argb: 'FF1F4E9A' } } });
    const wsCode = wb.addWorksheet('Material Coding', { properties: { tabColor: { argb: 'FFEDA100' } } });
    const wsChg = wb.addWorksheet('Changes', { properties: { tabColor: { argb: 'FF1BAF7A' } } });
    const wsChk = wb.addWorksheet('Checks', { properties: { tabColor: { argb: 'FF1BAF7A' } } });
    const wsHist = wb.addWorksheet('Load history', { properties: { tabColor: { argb: 'FF1BAF7A' } } });
    const wsCost = wb.addWorksheet('Cost Detail', { properties: { tabColor: { argb: 'FF7C7C77' } } });
    const wsMov = wb.addWorksheet('Movements', { properties: { tabColor: { argb: 'FF7C7C77' } } });
    const wsPO = wb.addWorksheet('PO Lines', { properties: { tabColor: { argb: 'FF7C7C77' } } });
    const wsRules = wb.addWorksheet('Movement Rules', { properties: { tabColor: { argb: 'FF7C7C77' } } });
    const wsLists = wb.addWorksheet('Lists', { properties: { tabColor: { argb: 'FF7C7C77' } } });
    const wsMeta = wb.addWorksheet('_Meta', { state: 'hidden' });
    const wsSnap = wb.addWorksheet('_Snap', { state: 'hidden' });
    const wsPOs = wb.addWorksheet('_POs', { state: 'hidden' });

    // ---------------- Material Coding (the editable heart: Package / MNL / Cost element per material)
    titleBand(wsCode, A, 'Material coding', 'Fill the yellow columns. Package and MNL come from the Lists sheet. Codes typed here are read back by next month’s load.');
    const codeRows = A.list.map((r) => [r.material, r.desc, r.group, r.unit, r.package || null, r.mnl || null, r.cec || null,
      r.sugg.package ? r.sugg.package[0] : null, r.sugg.package ? r.sugg.package[1] : null, r.cost]);
    const CT = 4;
    table(wsCode, CT, [{ h: 'Material', w: 12, text: true }, { h: 'Description', w: 42 }, { h: 'Group', w: 10, text: true }, { h: 'Unit', w: 7 },
      { h: 'Package', w: 11, edit: true }, { h: 'MNL', w: 8, edit: true }, { h: 'Cost element', w: 14, edit: true },
      { h: 'Suggested package', w: 12 }, { h: 'Why', w: 36 }, { h: 'Cost', w: 14, nf: NF.amt }], codeRows, { xSplit: 2 });
    const cEnd = CT + Math.max(1, nM);
    const pkgList = `Lists!$A$2:$A$${A.packages.length + 1}`, mnlList = `Lists!$D$2:$D$${A.mnls.length + 1}`;
    for (let i = CT + 1; i <= cEnd; i++) {
      wsCode.getCell(i, 5).dataValidation = { type: 'list', allowBlank: true, formulae: [pkgList], showErrorMessage: true, errorTitle: 'Package', error: 'Pick a package from the Lists sheet.' };
      wsCode.getCell(i, 6).dataValidation = { type: 'list', allowBlank: true, formulae: [mnlList] };
    }
    const lk = (col, cell, dflt) => `IFERROR(IF(INDEX('Material Coding'!$${col}$${CT + 1}:$${col}$${cEnd},MATCH(${cell},'Material Coding'!$A$${CT + 1}:$A$${cEnd},0))="",${dflt},INDEX('Material Coding'!$${col}$${CT + 1}:$${col}$${cEnd},MATCH(${cell},'Material Coding'!$A$${CT + 1}:$A$${cEnd},0))),${dflt})`;
    // ---------------- Lists
    table(wsLists, 1, [{ h: 'Package', w: 11 }, { h: 'Label', w: 32 }, { h: 'Group', w: 10 }, { h: 'MNL', w: 8 }, { h: 'Label', w: 20 }, { h: 'Order key', w: 11 }],
      Array.from({ length: Math.max(A.packages.length, A.mnls.length) }, (_, i) => [A.packages[i] ? A.packages[i].code : null, A.packages[i] ? A.packages[i].label : null,
        A.packages[i] ? A.packages[i].group : null, A.mnls[i] ? A.mnls[i].code : null, A.mnls[i] ? A.mnls[i].label : null, A.packages[i] ? A.packages[i].code.replace(/\s/g, '').toUpperCase() : null]), { filter: false });

    // ---------------- Cost Detail (CJI3 WA, one row per CO line; package / MNL looked up live from the coding)
    const costCols = [{ h: 'Posting date', w: 11, nf: NF.date }, { h: 'Month', w: 9, text: true }, { h: 'Material', w: 11, text: true }, { h: 'Description', w: 36 },
      { h: 'Group', w: 10, text: true }, { h: 'Package', w: 11 }, { h: 'MNL', w: 7 }, { h: 'Cost class', w: 26 }, { h: 'WBS', w: 24 }, { h: 'WBS name', w: 22 },
      { h: 'Cost element', w: 11, text: true }, { h: 'Cost element name', w: 20 }, { h: 'Qty', w: 11, nf: NF.qty }, { h: 'Unit', w: 6 }, { h: 'Amount', w: 14, nf: NF.amt2 },
      { h: 'Movement', w: 8 }, { h: 'Material doc', w: 12, text: true }, { h: 'Item', w: 5 }, { h: 'CO document', w: 12, text: true }, { h: 'Row', w: 5 }, { h: 'Fiscal year', w: 7 }, { h: 'Row ID', w: 7 }, { h: 'Created on', w: 11, nf: NF.date }, { h: 'Report bucket', w: 10, text: true }, { h: 'Cut-off status', w: 30 }, { h: 'Note', w: 60 }];
    const costSorted = A.costAll.slice().sort((a, b) => cmp(a.date ? a.date.getTime() : 0, b.date ? b.date.getTime() : 0) || cmp(a.key, b.key));
    const CD = 4;
    titleBand(wsCost, A, 'Cost detail – CJI3 goods issues (WA)', `One row per CO line item. Posting date decides the month; Created on decides the report: entered on or before the cut-off ${cutText(A.cutoff)} counts, later waits (PENDING). Cut-off status marks each line. Package and MNL are looked up from Material Coding.`);
    table(wsCost, CD, costCols, costSorted.map((l, i) => { const r = A.mats.get(l.material), n = CD + 1 + i;
      return [l.date ? ymdDate(l.date) : null, mtext(l.month), l.material, l.matDesc || r.desc, r.group || '(no group)',
        { formula: lk('E', `C${n}`, '"UNALLOCATED"'), result: r.package || 'UNALLOCATED' }, { formula: lk('F', `C${n}`, '""'), result: r.mnl || '' },
        l.costClass, l.wbs, l.coName, l.ce, l.ceName, l.mov ? l.mqty : (l.qty || null), l.uom || r.unit, l.amt, l.mov ? l.mov.mvt : '', l.refDoc, l.refItem, l.docNo, l.postRow, l.fy, A.rowIds.get(l.rowKey).id, l.entry === null ? null : dayOf(l.entry), bucketText(l.bucket), l.status, l.why || null]; }), { xSplit: 3 });
    { const SF = { 'In report': FILL.GOOD, 'Late posting': FILL.WARN, 'Pending – entered after cut-off': FILL.BAD, 'Pending – next month, already entered': FILL.SUB, 'Pending – next month': FILL.SUB };
      costSorted.forEach((l, i) => { const c = wsCost.getCell(CD + 1 + i, 25); c.fill = SF[l.status]; }); }
    const cdEnd = CD + Math.max(1, A.costAll.length);
    const CDR = (col) => `'Cost Detail'!$${col}$${CD + 1}:$${col}$${cdEnd}`;
    const cdTot = CD + A.costAll.length + 1;
    wsCost.getCell(cdTot, 1).value = 'Total (follows the filter)'; wsCost.getCell(cdTot, 15).value = { formula: `SUBTOTAL(9,O${CD + 1}:O${cdEnd})`, result: A.k.costAll };
    for (const j of [1, 15]) { wsCost.getCell(cdTot, j).font = st.FB; wsCost.getCell(cdTot, j).fill = FILL.TOT; } wsCost.getCell(cdTot, 15).numFmt = NF.amt2;

    const MMX = materialMonthly(wsMM, A, CDR, lk), MM_TOTAL = MMX.total;
    packageMonthly(wsPM, A, MMX);

    // ---------------- Movements (MB51 with its class)
    titleBand(wsMov, A, 'Movements – MB51', 'Every movement with the class the rules gave it (see Movement Rules). Cost line = the CJI3 amount tied to this movement.');
    const movSorted = A.mb.rows.slice().sort((a, b) => cmp(a.date ? a.date.getTime() : 0, b.date ? b.date.getTime() : 0) || cmp(a.key, b.key));
    table(wsMov, 4, [{ h: 'Posting date', w: 11, nf: NF.date }, { h: 'Month', w: 9, text: true }, { h: 'Material', w: 11, text: true }, { h: 'Description', w: 34 },
      { h: 'Group', w: 10, text: true }, { h: 'Mvt', w: 6 }, { h: 'Movement text', w: 20 }, { h: 'Class', w: 26 }, { h: 'Qty', w: 11, nf: NF.qty }, { h: 'Unit', w: 6 },
      { h: 'Value (MB51)', w: 13, nf: NF.amt2 }, { h: 'Cost line (CJI3)', w: 13, nf: NF.amt2 }, { h: 'WBS', w: 22 }, { h: 'Order', w: 11, text: true }, { h: 'PO', w: 11, text: true },
      { h: 'PO item', w: 6 }, { h: 'Supplier', w: 10, text: true }, { h: 'Material doc', w: 12, text: true }, { h: 'Item', w: 5 }, { h: 'Year', w: 6 }, { h: 'Text', w: 16 }],
    movSorted.map((m) => { const r = A.mats.get(m.material); return [m.date ? ymdDate(m.date) : null, mtext(m.month), m.material, m.desc, r.group || '(no group)', m.mvt, m.mvtText,
      CLASS[m.cls].label, m.qty, m.uom, m.amt, m.costLine ? m.costLine.amt : null, m.wbs, m.order, m.po, m.poItem, m.supplier, m.doc, m.item, m.year, m.text]; }), { xSplit: 3 });

    // ---------------- PO Lines (ME2N)
    titleBand(wsPO, A, 'PO lines – ME2N', 'Unit price = Net price ÷ Price unit. Kind STO = stock transport from own stores (no price); deleted items (L) are neither ordered nor open.');
    const poSorted = A.me.lines.slice().sort((a, b) => cmp(a.material, b.material) || cmp(a.date ? a.date.getTime() : 0, b.date ? b.date.getTime() : 0) || cmp(a.key, b.key));
    table(wsPO, 4, [{ h: 'PO', w: 11, text: true }, { h: 'Item', w: 5 }, { h: 'Date', w: 11, nf: NF.date }, { h: 'Kind', w: 5 }, { h: 'Supplier / supplying plant', w: 30 },
      { h: 'Material', w: 11, text: true }, { h: 'Short text', w: 34 }, { h: 'Group', w: 10, text: true }, { h: 'Unit', w: 6 }, { h: 'Deleted', w: 7 },
      { h: 'Order qty', w: 11, nf: NF.qty }, { h: 'Net price', w: 11, nf: NF.amt2 }, { h: 'Price unit', w: 7 }, { h: 'Unit price', w: 11, nf: NF.amt2 }, { h: 'Net value', w: 13, nf: NF.amt },
      { h: 'Open qty', w: 11, nf: NF.qty }, { h: 'Open value', w: 13, nf: NF.amt }, { h: 'To invoice qty', w: 11, nf: NF.qty }, { h: 'To invoice value', w: 13, nf: NF.amt }],
    poSorted.map((l) => [l.po, l.item, l.date ? ymdDate(l.date) : null, l.kind, l.vendor, l.material, l.text, l.group, l.unit, l.del, l.qty, l.netPrice, l.priceUnit || null,
      l.unitPrice || null, l.value, l.openQty, l.openVal, l.invQty, l.invVal]), { xSplit: 2 });

    // ---------------- Materials (quantity chain + cost)
    const chain = ['RCV_V', 'RCV_S', 'OWNER', 'RET_P', 'ISS_P', 'ISS_S', 'SCRAP', 'ISS_O', 'ISS_K', 'TRF_O', 'SUBC', 'ADJ', 'OTHER'].filter((c) => A.list.some((r) => Math.abs(r.qty[c] || 0) > 1e-9));
    const matCols = [{ h: 'Material', w: 11, text: true }, { h: 'Description', w: 36 }, { h: 'Group', w: 10, text: true }, { h: 'Package', w: 11 }, { h: 'Unit', w: 6 },
      { h: 'Ordered (PO)', w: 11, nf: NF.qty }]
      .concat(chain.map((c) => ({ h: CLASS[c].short, w: 11, nf: NF.qty })))
      .concat([{ h: 'Stock balance', w: 11, nf: NF.qty }, { h: 'Open on PO', w: 11, nf: NF.qty }, { h: 'Direct / asset', w: 10, nf: NF.qty },
        { h: 'Cost (CJI3)', w: 14, nf: NF.amt }, { h: 'Qty consumed', w: 11, nf: NF.qty }, { h: 'Avg issue price', w: 11, nf: NF.amt2 },
        { h: 'Weighted PO price', w: 11, nf: NF.amt2 }, { h: 'Last PO price', w: 11, nf: NF.amt2 }, { h: 'Issue vs PO', w: 9, nf: NF.pct }]);
    const MT = 4, c0 = 7, cBal = c0 + chain.length, cCost = cBal + 3, cCons = cCost + 1, cIss = cCons + 1, cW = cIss + 1;
    titleBand(wsMat, A, 'Materials – quantity chain and cost', 'Quantities in the material’s MB51 unit, signed as they move stock (in +, out −). Stock balance = sum of the chain. Cost is summed live from Cost Detail.');
    table(wsMat, MT, matCols, A.list.map((r, i) => { const n = MT + 1 + i;
      const chainV = chain.map((c) => r.qty[c] || 0);
      return [r.material, r.desc, r.group || '(no group)', { formula: lk('E', `A${n}`, '"UNALLOCATED"'), result: r.package || 'UNALLOCATED' }, r.unit, r.ordered]
        .concat(chainV)
        .concat([{ formula: `SUM(${colL(c0)}${n}:${colL(cBal - 1)}${n})`, result: r.balance }, r.openQty, r.qty.DIRECT || 0,
          { formula: `SUMIFS(${CDR('O')},${CDR('C')},A${n},${CDR('X')},"<>PENDING")`, result: r.cost }, r.consQty || 0,
          { formula: `IF(${colL(cCons)}${n}<=0,"",(SUMIFS(${CDR('O')},${CDR('C')},A${n},${CDR('H')},"${COST_CLASS.ISS_P}",${CDR('X')},"<>PENDING")+SUMIFS(${CDR('O')},${CDR('C')},A${n},${CDR('H')},"${COST_CLASS.ISS_S}",${CDR('X')},"<>PENDING"))/${colL(cCons)}${n})`, result: r.issuePrice === null ? '' : r.issuePrice },
          r.price ? r.price.wavg : null, r.price ? r.price.last.unitPrice : null,
          { formula: `IF(OR(${colL(cIss)}${n}="",${colL(cW)}${n}=""),"",${colL(cIss)}${n}/${colL(cW)}${n}-1)`, result: r.priceVar === null ? '' : r.priceVar }]); }), { xSplit: 2 });
    const mEnd = MT + nM, mTot = mEnd + 1;
    wsMat.getCell(mTot, 1).value = 'Total'; wsMat.getCell(mTot, cCost).value = { formula: `SUBTOTAL(9,${colL(cCost)}${MT + 1}:${colL(cCost)}${mEnd})`, result: A.k.cost };
    for (const j of [1, cCost]) { wsMat.getCell(mTot, j).font = st.FB; wsMat.getCell(mTot, j).fill = FILL.TOT; } wsMat.getCell(mTot, cCost).numFmt = NF.amt;

    // ---------------- Price
    titleBand(wsPrice, A, 'Price analysis', 'PO prices across POs and vendors (purchase lines, not deleted) against the price the material was issued at (CJI3 cost ÷ quantity), by report month.');
    const priced = A.list.filter((r) => r.price || r.issuePrice !== null);
    const pCols = [{ h: 'Material', w: 11, text: true }, { h: 'Description', w: 34 }, { h: 'Group', w: 10, text: true }, { h: 'Unit', w: 6 }, { h: 'PO lines', w: 6 },
      { h: 'Vendors', w: 6 }, { h: 'Min PO price', w: 11, nf: NF.amt2 }, { h: 'Max PO price', w: 11, nf: NF.amt2 }, { h: 'Spread', w: 8, nf: NF.pct },
      { h: 'Weighted PO price', w: 11, nf: NF.amt2 }, { h: 'Last PO price', w: 11, nf: NF.amt2 }, { h: 'Last PO date', w: 11, nf: NF.date }, { h: 'Last vendor', w: 24 },
      { h: 'Avg issue price', w: 11, nf: NF.amt2 }, { h: 'Issue vs PO', w: 9, nf: NF.pct }, { h: 'Cost', w: 13, nf: NF.amt }]
      .concat(months.map((m) => ({ h: 'Issue ' + mlabel(m), w: 10, nf: NF.amt2 })));
    table(wsPrice, 4, pCols, priced.map((r) => { const p = r.price;
      return [r.material, r.desc, r.group, r.unit, p ? p.n : null, p ? p.vendors : null, p ? p.min : null, p ? p.max : null, p ? p.spread : null, p ? p.wavg : null,
        p ? p.last.unitPrice : null, p && p.last.date ? ymdDate(p.last.date) : null, p ? p.last.vendor : null, r.issuePrice, r.priceVar, r.cost]
        .concat(months.map((m) => (r.qtyByMonth[m] || 0) > 1e-9 ? (r.issCostByMonth[m] || 0) / r.qtyByMonth[m] : null)); }), { xSplit: 2 });

    // ---------------- Dashboard
    titleBand(wsDash, A, 'Material cost report');
    const kp = [[`Material cost to the cut-off (${cutText(A.cutoff)})`, { formula: `SUMIFS(${CDR('O')},${CDR('X')},"<>PENDING")`, result: A.k.cost }],
      ['  Project consumption', { formula: `SUMIFS(${CDR('O')},${CDR('H')},"${COST_CLASS.ISS_P}",${CDR('X')},"<>PENDING")`, result: A.k.project }],
      ['  Issued to subcontractors (recoverable)', { formula: `SUMIFS(${CDR('O')},${CDR('H')},"${COST_CLASS.ISS_S}",${CDR('X')},"<>PENDING")`, result: A.k.subcon }],
      ['  Scrap / damages', { formula: `SUMIFS(${CDR('O')},${CDR('H')},"${COST_CLASS.SCRAP}",${CDR('X')},"<>PENDING")`, result: A.k.scrap }],
      ['Pending – entered after the cut-off (next report)', { formula: `SUMIFS(${CDR('O')},${CDR('X')},"PENDING")`, result: A.k.pending }],
      ['Late postings counted in this report', A.k.late],
      ['  With no MB51 movement', A.k.unmatched],
      ['Material Monthly total (must equal the cost)', { formula: MM_TOTAL, result: A.k.cost }],
      [`Cost in ${mlabel(A.reportMonth)}`, { formula: `SUMIFS(${CDR('O')},${CDR('X')},"${mtext(A.reportMonth)}")`, result: A.k.thisMonth }],
      ['Received from vendors (MB51 value)', A.k.receivedVendor], ['Owner supplied (MB51 value)', A.k.ownerSupplied],
      ['Issued to orders – outside project cost', A.k.toOrders], ['Ordered value (purchase POs)', A.k.orderedVal], ['Still to be delivered (value)', A.k.openPO],
      ['Materials with cost', A.k.materials], ['Material groups with cost', A.k.groups], ['Purchase orders', A.k.pos], ['Vendors', A.k.vendors]];
    wsDash.getCell('A4').value = 'Headline'; wsDash.getCell('A4').font = st.FB;
    kp.forEach(([l, v], i) => { const c = wsDash.getCell(5 + i, 1); c.value = l; c.font = /^ {2}/.test(l) ? st.F : st.FB;
      const x = wsDash.getCell(5 + i, 2); x.value = v; x.numFmt = NF.amt; x.font = st.FB; });
    wsDash.getColumn(1).width = 40; wsDash.getColumn(2).width = 16;
    // monthly matrices by material group and by package: live SUMIFS on Cost Detail by report bucket
    const bks = (A.hasOpening ? ['OPENING'] : []).concat(months);
    const matrix = (top, title, keys, keyCol) => {
      wsDash.getCell(top, 1).value = title; wsDash.getCell(top, 1).font = st.FB;
      const hr = top + 1; const heads = [keyCol === 'E' ? 'Material group' : 'Package', 'Total'].concat(bks.map(bucketText));
      heads.forEach((h, j) => { const c = wsDash.getCell(hr, j + 1); c.value = h; c.font = st.H; c.fill = FILL.HF; c.alignment = { horizontal: 'center' }; if (j >= 2) wsDash.getColumn(j + 1).width = Math.max(wsDash.getColumn(j + 1).width || 0, 12); });
      keys.forEach((o, i) => { const n = hr + 1 + i; wsDash.getCell(n, 1).value = o.key; wsDash.getCell(n, 1).font = st.F;
        wsDash.getCell(n, 2).value = { formula: `SUM(C${n}:${colL(2 + bks.length)}${n})`, result: o.total }; wsDash.getCell(n, 2).numFmt = NF.amt; wsDash.getCell(n, 2).font = st.FB;
        bks.forEach((m, j) => { const c = wsDash.getCell(n, 3 + j); c.value = { formula: `SUMIFS(${CDR('O')},${CDR(keyCol)},$A${n},${CDR('X')},${colL(3 + j)}$${hr})`, result: o.byMonth[m] || 0 }; c.numFmt = NF.amt; c.font = st.F; }); });
      const tn = hr + 1 + keys.length; wsDash.getCell(tn, 1).value = 'Total'; wsDash.getCell(tn, 1).font = st.FB;
      for (let j = 2; j <= 2 + bks.length; j++) { const c = wsDash.getCell(tn, j); c.value = { formula: `SUM(${colL(j)}${hr + 1}:${colL(j)}${tn - 1})`, result: j === 2 ? A.k.cost : sum(keys, (o) => o.byMonth[bks[j - 3]] || 0) };
        c.numFmt = NF.amt; c.font = st.FB; c.fill = FILL.TOT; }
      wsDash.getCell(tn, 1).fill = FILL.TOT;
      return tn + 2;
    };
    let nx = 5 + kp.length + 2;
    // packages: every catalogue package plus UNALLOCATED, so coding in Excel has a row to land on
    const pkRows = A.packages.map((p) => A.byPackage.find((o) => o.key === p.code) || { key: p.code, total: 0, byMonth: {} })
      .concat([A.byPackage.find((o) => o.key === 'UNALLOCATED') || { key: 'UNALLOCATED', total: 0, byMonth: {} }]);
    nx = matrix(nx, 'Cost by package and month (live from Material Coding)', pkRows, 'F');
    nx = matrix(nx, 'Cost by material group and month', A.byGroup, 'E');
    wsDash.views = [{ state: 'frozen', ySplit: 3 }];

    // ---------------- Changes
    titleBand(wsChg, A, 'Changes since the last report', A.changes.has ? `Against load ${A.changes.prevLoad || '?'} (data to ${dtext(A.changes.prevDate)})` : 'No previous report was loaded – the next load will compare against this one.');
    if (A.changes.has) {
      const end = table(wsChg, 4, [{ h: 'Change', w: 11 }, { h: 'Material', w: 11, text: true }, { h: 'Description', w: 34 }, { h: 'Group', w: 10 }, { h: 'Unit', w: 6 },
        { h: 'Cost before', w: 13, nf: NF.amt }, { h: 'Cost now', w: 13, nf: NF.amt }, { h: 'Δ cost', w: 13, nf: NF.amt }, { h: 'Consumed before', w: 11, nf: NF.qty },
        { h: 'Consumed now', w: 11, nf: NF.qty }, { h: 'Balance before', w: 11, nf: NF.qty }, { h: 'Balance now', w: 11, nf: NF.qty }, { h: 'Open PO before', w: 11, nf: NF.qty }, { h: 'Open PO now', w: 11, nf: NF.qty }],
      A.changes.rows.map((x) => [x.type, x.r.material, x.r.desc, x.r.group, x.r.unit, x.prev ? x.prev.cost : null, x.now.cost, x.now.cost - (x.prev ? x.prev.cost : 0),
        x.prev ? x.prev.cons : null, x.now.cons, x.prev ? x.prev.bal : null, x.now.bal, x.prev ? x.prev.open : null, x.now.open]));
      if (A.changes.newPO.length) {
        const t = end + 3; wsChg.getCell(t - 1, 1).value = `New PO lines since the last report (${A.changes.newPO.length})`; wsChg.getCell(t - 1, 1).font = st.FB;
        const hr = wsChg.getRow(t); ['PO', 'Item', 'Date', 'Kind', 'Supplier', 'Material', 'Short text', 'Qty', 'Unit price', 'Value'].forEach((h, j) => { const c = hr.getCell(j + 1); c.value = h; c.font = st.H; c.fill = FILL.HF; });
        A.changes.newPO.forEach((l, i) => { const r = wsChg.getRow(t + 1 + i); [l.po, l.item, l.date ? ymdDate(l.date) : null, l.kind, l.vendor, l.material, l.text, l.qty, l.unitPrice || null, l.value]
          .forEach((v, j) => { const c = r.getCell(j + 1); c.value = v; c.font = st.F; if (j === 2) c.numFmt = NF.date; if (j >= 7) c.numFmt = j === 8 ? NF.amt2 : NF.amt; }); });
      }
    }

    // ---------------- Checks
    titleBand(wsChk, A, 'Reconciliation and data checks');
    let cr = 4;
    for (const c of A.checks) {
      const h = wsChk.getCell(cr, 1); h.value = ({ good: '✓ ', warn: '! ', bad: '✗ ', info: 'i ' })[c.level] + c.title; h.font = st.FB;
      h.fill = ({ good: FILL.GOOD, warn: FILL.WARN, bad: FILL.BAD, info: FILL.SUB })[c.level];
      wsChk.getCell(cr + 1, 1).value = c.detail; wsChk.getCell(cr + 1, 1).font = st.F; cr += 2;
      if (c.rows.length) { const hr = wsChk.getRow(cr); c.cols.forEach((t, j) => { const x = hr.getCell(j + 1); x.value = t; x.font = st.H; x.fill = FILL.HF; });
        c.rows.slice(0, 200).forEach((r, i) => { const row = wsChk.getRow(cr + 1 + i); r.forEach((v, j) => { const x = row.getCell(j + 1); x.value = v === '' ? null : v; x.font = st.F;
          if (typeof v === 'number') x.numFmt = (c.cols[j] || '').match(/Variance|vs PO/) ? NF.pct : (Math.abs(v) < 1000 && !Number.isInteger(v) ? NF.amt2 : NF.amt); }); });
        cr += Math.min(200, c.rows.length) + 1 + (c.rows.length > 200 ? 1 : 0);
        if (c.rows.length > 200) wsChk.getCell(cr - 1, 1).value = `… ${c.rows.length - 200} more rows – see the page.`; }
      cr += 1;
    }
    wsChk.getColumn(1).width = 16; for (let j = 2; j <= 9; j++) wsChk.getColumn(j).width = 16;

    // ---------------- Movement Rules
    titleBand(wsRules, A, 'Movement rules', 'How each MB51 movement type was classified in this load. Receipts (101 family) are split by text and PO: asset / account-assigned receipts are not stock; transit or stock-transport POs are receipts from own stores.');
    table(wsRules, 4, [{ h: 'Mvt', w: 6 }, { h: 'Movement text', w: 24 }, { h: 'Class', w: 40 }, { h: 'Counts in stock', w: 9 }, { h: 'Lines', w: 8, nf: NF.amt },
      { h: 'Qty', w: 13, nf: NF.qty }, { h: 'Value (MB51)', w: 15, nf: NF.amt }, { h: 'Cost in CJI3', w: 15, nf: NF.amt }],
    A.mvtTypes.map((t) => [t.mvt, t.text, CLASS[t.cls].label, CLASS[t.cls].stock ? 'yes' : 'no', t.n, t.qty, t.amt, t.costN ? t.cost : null]));

    // ---------------- Load history
    const loads = (A.prev && A.prev.loads ? A.prev.loads : []).concat([loadRow(A)]);
    titleBand(wsHist, A, 'Load history');
    table(wsHist, 4, [{ h: 'Load', w: 6 }, { h: 'Run on', w: 11, nf: NF.date }, { h: 'Report month', w: 9, text: true }, { h: 'Cut-off', w: 18, text: true }, { h: 'Data date', w: 11, nf: NF.date },
      { h: 'Material cost', w: 15, nf: NF.amt }, { h: 'Pending', w: 13, nf: NF.amt }, { h: 'Project consumption', w: 15, nf: NF.amt }, { h: 'To subcontractors', w: 14, nf: NF.amt },
      { h: 'Open PO value', w: 14, nf: NF.amt }, { h: 'Materials with cost', w: 10 }, { h: 'Cost lines', w: 9 }, { h: 'Files', w: 60 }],
    loads.map((l) => [l.no, l.run ? ymdDate(l.run) : null, l.reportMonth ? mtext(l.reportMonth) : null, l.cutoff && isFinite(l.cutoff) ? cutText(l.cutoff) : null,
      l.dataDate ? ymdDate(l.dataDate) : null, l.cost, l.pending || null, l.project, l.subcon, l.openPO, l.materials, l.lines, l.files]));
    wsHist.getCell(3, 1).value = 'Each load keeps its report month and cut-off: the next report uses them to keep closed months exactly as they were reported.'; wsHist.getCell(3, 1).font = st.T2;

    // ---------------- machinery for next month
    [['plant', A.PLANT], ['project', A.PROJECT], ['dataDate', dtext(A.dataDate)], ['loadNo', A.loadNo], ['reportMonth', mtext(A.reportMonth)],
      ['cutoff', isFinite(A.cutoff) ? cutText(A.cutoff) : ''], ['openingBefore', A.openingBefore ? mtext(A.openingBefore) : ''], ['tool', 'Material cost report Rev02'], ['saved', new Date().toISOString()]]
      .forEach((r) => wsMeta.addRow(r));
    const wsMonths = wb.addWorksheet('_Months', { state: 'hidden' });
    wsMonths.addRow(['Bucket', 'Amount']); for (const [b, v] of Object.entries(A.byBucket)) wsMonths.addRow([bucketText(isNaN(+b) ? b : +b), round2(v)]);
    wsMonths.getColumn(1).numFmt = '@';
    wsSnap.addRow(['Material', 'Description', 'Group', 'Unit', 'Cost', 'Consumed', 'Balance', 'Open PO']);
    for (const r of A.list) wsSnap.addRow([r.material, r.desc, r.group, r.unit, round2(r.cost), r.consQty, r.balance, r.openQty]);
    wsPOs.addRow(['PO/item']); for (const l of A.me.lines) wsPOs.addRow([l.key]);
    // every line seen so far, with SAP's headers: next month's window export is merged with these
    for (const [name, aoa] of [['_CJI3', A.carry.cji], ['_MB51', A.carry.mb]]) {
      const ws = wb.addWorksheet(name, { state: 'hidden' });
      const canon = aoa && aoa.length ? (aoa[0].join('|') === CANON[name === '_CJI3' ? 'cji' : 'mb'].join('|') ? aoa : null) : null;
      const rows = canon || [CANON[name === '_CJI3' ? 'cji' : 'mb']].concat((toCanon(name === '_CJI3' ? 'cji' : 'mb', aoa || [[]]).rows) || []);
      for (const r of rows) ws.addRow(r.map((v) => (v instanceof Date ? new Date(Date.UTC(ymd(v).y, ymd(v).m - 1, ymd(v).d)) : v)));
    }
    const wsRows = wb.addWorksheet('_Rows', { state: 'hidden' });
    wsRows.addRow(['Row key', 'Row ID', 'First seen (load)']);
    for (const [k, v] of [...A.rowIds].sort((a, b) => a[1].id - b[1].id)) wsRows.addRow([k, v.id, v.first]);
    wsRows.getColumn(1).numFmt = '@';
    for (const ws of [wsSnap, wsPOs]) ws.getColumn(1).numFmt = '@';
    return fixSheetXml(await wb.xlsx.writeBuffer(), libs.JSZip);
  }
  // ExcelJS writes <pageSetUpPr> before <outlinePr> when a sheet has both fit-to-page and column grouping (Material Monthly).
  // The schema wants tabColor → outlinePr → pageSetUpPr, and Excel refuses the sheet ("found a problem with some content")
  // otherwise. Put the children of <sheetPr> in schema order in every sheet.
  const SHEETPR_ORDER = ['tabColor', 'outlinePr', 'pageSetUpPr'];
  function orderSheetPr(xml) {
    const m = /<sheetPr([^>]*)>([\s\S]*?)<\/sheetPr>/.exec(xml); if (!m) return xml;
    const kids = m[2].match(/<(\w+)[^>]*?(?:\/>|>[\s\S]*?<\/\1>)/g) || [];
    const rank = (k) => { const i = SHEETPR_ORDER.indexOf(/^<(\w+)/.exec(k)[1]); return i < 0 ? 99 : i; };
    const sorted = kids.slice().sort((a, b) => rank(a) - rank(b)).join('');
    return sorted === m[2] ? xml : xml.replace(m[0], `<sheetPr${m[1]}>${sorted}</sheetPr>`);
  }
  // ExcelJS marks every grouped column collapsed="1" even when it is shown, so Excel draws "+" over an open group and the
  // first click seems to do nothing. A shown column is not collapsed: drop the flag where the column is not hidden.
  const openColumns = (xml) => xml.replace(/<col [^>]*>/g, (c) => (/hidden="1"/.test(c) ? c : c.replace(/ collapsed="1"/, '')));
  async function fixSheetXml(buf, JSZip) {
    if (!JSZip) throw new Error('JSZip is needed to write a valid workbook');
    const z = await JSZip.loadAsync(buf);
    for (const name of Object.keys(z.files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))) {
      const x = await z.file(name).async('string'), y = openColumns(orderSheetPr(x));
      if (y !== x) z.file(name, y);
    }
    return z.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  }
  // ================================================================== MATERIAL MONTHLY
  // The main sheet, and the block people copy (Paste Special › Values) into their cost report every month.
  // One flat table – one header row, no merged cells, no header or blank rows between data – so sorting, filtering and
  // copying never break it. Column layout shared with Service Monthly (Rev08):
  //   Identity (11) | Opening (3) | month 1 … month n (3 each) | Total (4) | Pending (3, not in Total) | reference (hidden)
  // CSI / MNL / Cost element are live lookups from Material Coding; Qty and Amount are SUMIFS on Cost Detail by Row ID and
  // Report bucket, so re-coding changes a row where it stands and closed months stay exactly as reported.
  const MM_ID = ['Row ID', 'CSI', 'MNL', 'Cost element', 'Material', 'Description', 'Material group', 'Last vendor code', 'Last vendor name', 'Line type', 'Unit'];
  function materialMonthly(ws, A, CDR, lk) {
    const L = colL, cat = A.packages;
    const blocks = [{ key: 'OPENING', label: 'Opening', fill: '7A5C1E' }]
      .concat(A.months.map((m, i) => ({ key: m, label: mlabel(m), fill: i % 2 ? '1F3E6B' : '0F2A52' })));
    const nI = MM_ID.length, B0 = nI + 1;                       // first time block starts in column L
    const T0 = B0 + 3 * blocks.length, P0 = T0 + 4, RF = P0 + 3;
    const REF = ['First seen (load)', 'Last PO price', 'Issue vs PO', 'Stock balance', 'Open on PO'];
    const LASTC = RF + REF.length - 1;
    const pkOrder = (c) => { const i = cat.findIndex((p) => p.code === c); return i < 0 ? cat.length : i; };
    const rows = A.monthlyRows.slice().sort((a, b) => { const ra = A.mats.get(a.material), rb = A.mats.get(b.material);
      return pkOrder(ra.package) - pkOrder(rb.package) || cmp(ra.group || '~', rb.group || '~') || cmp(a.material, b.material)
        || (LINE_ORDER[a.lineType] ?? 9) - (LINE_ORDER[b.lineType] ?? 9) || cmp(a.lineType, b.lineType); });
    const R1 = 4, RN = R1 + Math.max(1, rows.length) - 1, HR = 3;
    const AMTF = '#,##0;[Red]-#,##0;"–"', QTYF = '#,##0.00;[Red]-#,##0.00;"–"', PRF = '#,##0.00;[Red]-#,##0.00;""';
    const H = { ...st.H, size: 9.5 };
    // header: one row, one cell per column
    const head = (c, v, f) => { const x = ws.getCell(HR, c); x.value = v; x.font = H; x.fill = solid('FF' + f); x.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }; };
    MM_ID.forEach((h, j) => head(1 + j, h, '0F2A52'));
    blocks.forEach((b, i) => ['Qty', 'Rate', 'Amount'].forEach((t, o) => head(B0 + 3 * i + o, `${b.label} ${t}`, b.fill)));
    ['Total Price', 'Total Qty', 'Total Avg rate', 'Total Amount'].forEach((t, o) => head(T0 + o, t, 'A07A2C'));
    ['Pending Qty', 'Pending Rate', 'Pending Amount'].forEach((t, o) => head(P0 + o, t, '8E3B37'));
    REF.forEach((h, j) => head(RF + j, h, '6B7280'));
    ws.getRow(HR).height = 30;
    const bt = (b) => `"${bucketText(b)}"`;
    const DF = solid('FFF3F6FB'), WF = solid('FFFFFFFF'), NEWF = solid('FFE2EFDA'), SUBF = solid('FFFDF3E1'), SCRF = solid('FFFDE8E6');
    let band = 0, prevGroup = null;
    rows.forEach((o, n) => {
      const i = R1 + n, r = A.mats.get(o.material), row = ws.getRow(i), v = [];
      if (r.group !== prevGroup) { band ^= 1; prevGroup = r.group; }
      const pk = r.package && cat.some((p) => p.code === r.package) ? r.package : '';
      v[0] = o.id;
      v[1] = { formula: lk('E', `$E${i}`, '"UNALLOCATED"'), result: pk || 'UNALLOCATED' };
      v[2] = { formula: lk('F', `$E${i}`, '""'), result: r.mnl || '' };
      v[3] = { formula: lk('G', `$E${i}`, '""'), result: r.cec || '' };
      v[4] = o.material; v[5] = r.desc; v[6] = r.group || '(no group)'; v[7] = r.lastVendorCode || null; v[8] = r.lastVendorName || null; v[9] = o.lineType; v[10] = r.unit;
      const q = (b) => o.qtyByMonth[b] || 0, a = (b) => o.byMonth[b] || 0;
      const trio = (c, b) => {                                  // Qty / Rate / Amount of one bucket
        v[c - 1] = { formula: `SUMIFS(${CDR('M')},${CDR('V')},$A${i},${CDR('X')},${bt(b)})`, result: q(b) };
        v[c] = { formula: `IF(${L(c)}${i}=0,"",${L(c + 2)}${i}/${L(c)}${i})`, result: q(b) ? a(b) / q(b) : '' };
        v[c + 1] = { formula: `SUMIFS(${CDR('O')},${CDR('V')},$A${i},${CDR('X')},${bt(b)})`, result: a(b) };
      };
      blocks.forEach((b, bi) => trio(B0 + 3 * bi, b.key));
      v[T0 - 1] = r.price ? round2(r.price.wavg) : null;
      v[T0] = { formula: blocks.map((_, bi) => L(B0 + 3 * bi) + i).join('+'), result: o.qty };
      v[T0 + 2] = { formula: blocks.map((_, bi) => L(B0 + 3 * bi + 2) + i).join('+'), result: o.amt };
      v[T0 + 1] = { formula: `IF(${L(T0 + 1)}${i}=0,"",${L(T0 + 3)}${i}/${L(T0 + 1)}${i})`, result: o.qty ? o.amt / o.qty : '' };
      trio(P0, 'PENDING');
      const ref = [o.first, r.price ? round2(r.price.last.unitPrice) : null,
        { formula: `IF(OR(${L(T0)}${i}="",${L(T0 + 2)}${i}=""),"",${L(T0 + 2)}${i}/${L(T0)}${i}-1)`, result: r.price && o.qty ? (o.amt / o.qty) / r.price.wavg - 1 : '' },
        r.balance, r.openQty];
      ref.forEach((x, j) => { v[RF - 1 + j] = x; });
      row.values = v; row.height = 17;
      const base = o.lineType === 'To subcontractors' ? SUBF : o.lineType === 'Project' ? (band ? DF : WF) : SCRF;
      for (let c = 1; c <= LASTC; c++) row.getCell(c).fill = base;
      if (o.isNew) for (const c of [5, 6]) row.getCell(c).fill = NEWF;
    });
    // formats, widths, fold buttons
    [7, 11, 7, 12, 11, 40, 11, 12, 26, 16, 6].forEach((w, j) => { ws.getColumn(1 + j).width = w; });
    for (let c = 1; c <= LASTC; c++) ws.getColumn(c).font = { ...st.F, size: 9.5 };
    for (const c of [5, 7, 8]) { ws.getColumn(c).font = { ...st.F, name: 'Consolas', size: 9.5 }; ws.getColumn(c).numFmt = '@'; }
    ws.getColumn(6).alignment = { horizontal: 'right', readingOrder: 'rtl' }; ws.getColumn(9).alignment = { horizontal: 'right', readingOrder: 'rtl' };
    ws.getColumn(1).hidden = true;
    const trioFmt = (c, fold) => { ws.getColumn(c).numFmt = QTYF; ws.getColumn(c + 1).numFmt = PRF; ws.getColumn(c + 2).numFmt = AMTF;
      ws.getColumn(c).width = 10; ws.getColumn(c + 1).width = 10; ws.getColumn(c + 2).width = 13;
      if (fold) { ws.getColumn(c).outlineLevel = 1; ws.getColumn(c + 1).outlineLevel = 1; } };   // "+" sits over the Amount column
    blocks.forEach((_, bi) => trioFmt(B0 + 3 * bi, true));
    trioFmt(P0, true);
    ws.getColumn(T0).numFmt = PRF; ws.getColumn(T0 + 1).numFmt = QTYF; ws.getColumn(T0 + 2).numFmt = PRF; ws.getColumn(T0 + 3).numFmt = AMTF;
    [11, 11, 11, 14].forEach((w, j) => { ws.getColumn(T0 + j).width = w; });
    for (let j = 0; j < 3; j++) ws.getColumn(T0 + j).outlineLevel = 1;
    ws.getColumn(T0 + 3).font = { ...st.FB, size: 9.5 };
    REF.forEach((h, j) => { const col = ws.getColumn(RF + j); col.width = [9, 11, 9, 11, 11][j]; col.outlineLevel = 1; col.hidden = true; });
    ws.getColumn(RF + 1).numFmt = PRF; ws.getColumn(RF + 2).numFmt = NF.pct; ws.getColumn(RF + 3).numFmt = QTYF; ws.getColumn(RF + 4).numFmt = QTYF;
    for (let i = HR; i <= RN; i++) { ws.getCell(i, B0).border = { left: { style: 'medium', color: { argb: 'FFC8A45C' } } };
      for (let bi = 1; bi < blocks.length; bi++) ws.getCell(i, B0 + 3 * bi).border = { left: { style: 'thin', color: { argb: 'FF8EA9DB' } } };
      ws.getCell(i, T0).border = { left: { style: 'medium', color: { argb: 'FFC8A45C' } } }; ws.getCell(i, P0).border = { left: { style: 'medium', color: { argb: 'FF8E3B37' } } }; }
    // TOTAL row (follows the filter) and the tie-out check, above the header so a filter never hides them
    const amtCols = blocks.map((_, bi) => B0 + 3 * bi + 2).concat([T0 + 3, P0 + 2]);
    for (let c = 1; c <= LASTC; c++) { const x = ws.getCell(1, c); x.fill = solid('FFFBF4E3'); x.font = { ...st.FB, size: 9.5 };
      x.border = { top: { style: 'medium', color: { argb: 'FFC8A45C' } }, bottom: { style: 'thin', color: { argb: 'FFC8A45C' } } }; }
    ws.getCell(1, 6).value = { formula: `"TOTAL · "&SUBTOTAL(3,$E$${R1}:$E$${RN})&" of ${rows.length} rows shown"`, result: `TOTAL · ${rows.length} of ${rows.length} rows shown` };
    ws.getCell(1, 6).alignment = { horizontal: 'right' };
    for (const c of amtCols) { const res = c === T0 + 3 ? A.k.cost : c === P0 + 2 ? A.k.pending : (A.byBucket[blocks[(c - B0 - 2) / 3].key] || 0);
      const x = ws.getCell(1, c); x.value = { formula: `SUBTOTAL(9,${L(c)}${R1}:${L(c)}${RN})`, result: res }; x.numFmt = AMTF; }
    const tie = `SUM(${L(T0 + 3)}${R1}:${L(T0 + 3)}${RN})-SUMIFS(${CDR('O')},${CDR('X')},"<>PENDING")`;
    const c2 = ws.getCell(2, 6);
    c2.value = { formula: `IF(ABS(${tie})<1,"✔ Total = CJI3 cost to the cut-off ${cutText(A.cutoff)}","✗ Total differs from Cost Detail by "&TEXT(${tie},"#,##0"))`, result: `✔ Total = CJI3 cost to the cut-off ${cutText(A.cutoff)}` };
    c2.font = { ...st.FB, size: 9.5, color: { argb: 'FF1B7F4B' } }; c2.alignment = { horizontal: 'right' };
    const c2b = ws.getCell(2, B0); c2b.value = `Report ${mlabel(A.reportMonth)} · Pending = entered after the cut-off, counted next month, not in Total`;
    c2b.font = { ...st.F, size: 9, italic: true, color: { argb: 'FF5A6678' } };
    ws.properties.outlineLevelCol = 1;
    ws.views = [{ state: 'frozen', xSplit: nI, ySplit: HR, showGridLines: false, zoomScale: 90 }];
    ws.autoFilter = { from: { row: HR, column: 1 }, to: { row: RN, column: LASTC } };
    ws.pageSetup = { paperSize: 8, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: `${HR}:${HR}`,
      margins: { left: 0.25, right: 0.25, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 } };
    return { total: `SUM('Material Monthly'!${L(T0 + 3)}${R1}:${L(T0 + 3)}${RN})`, R1, RN, blocks, amt: (bi) => L(B0 + 3 * bi + 2), totalAmt: L(T0 + 3), pendingAmt: L(P0 + 2) };
  }
  // Package Monthly: CSI × report month, summed from Material Monthly's CSI column – right whatever order the rows are in
  function packageMonthly(ws, A, X) {
    titleBand(ws, A, 'Package monthly', 'Cost per CSI package and month, summed from Material Monthly (live: re-coding a material in Material Coding moves its cost here at once).');
    const MM = (c) => `'Material Monthly'!$${c}$${X.R1}:$${c}$${X.RN}`;
    const cols = [{ h: 'CSI', w: 11 }, { h: 'Package', w: 30 }].concat(X.blocks.map((b) => ({ h: b.label, w: 13, nf: NF.amt })))
      .concat([{ h: 'Total', w: 15, nf: NF.amt }, { h: 'Pending', w: 13, nf: NF.amt }]);
    const keys = A.packages.map((p) => [p.code, p.label]).concat([['UNALLOCATED', 'No package yet']]);
    const top = 4, nB = X.blocks.length;
    const byPk = new Map(A.byPackage.map((o) => [o.key, o]));
    const pend = {}; for (const l of A.pending) { const k = A.mats.get(l.material).package || 'UNALLOCATED'; pend[k] = (pend[k] || 0) + l.amt; }
    table(ws, top, cols, keys.map(([c, label], i) => { const n = top + 1 + i, o = byPk.get(c) || { total: 0, byMonth: {} };
      return [c, label].concat(X.blocks.map((b, bi) => ({ formula: `SUMIFS(${MM(X.amt(bi))},${MM('B')},$A${n})`, result: o.byMonth[b.key] || 0 })))
        .concat([{ formula: `SUM(C${n}:${colL(2 + nB)}${n})`, result: o.total }, { formula: `SUMIFS(${MM(X.pendingAmt)},${MM('B')},$A${n})`, result: pend[c] || 0 }]); }),
    { filter: false, xSplit: 2 });
    const tn = top + keys.length + 1; ws.getCell(tn, 1).value = 'Total';
    for (let j = 3; j <= 4 + nB; j++) { const c = ws.getCell(tn, j); c.value = { formula: `SUM(${colL(j)}${top + 1}:${colL(j)}${tn - 1})` }; c.numFmt = NF.amt; }
    for (let j = 1; j <= 4 + nB; j++) { const c = ws.getCell(tn, j); c.font = st.FB; c.fill = FILL.TOT; }
  }
  const ymdDate = (d) => { const o = ymd(d); return new Date(Date.UTC(o.y, o.m - 1, o.d)); };
  const api = { mergeSources, toCanon, CANON, suggestCutoff, cutText, openColumns, periodInfo, tsText, tsParse, nextMonth, bucketLabel, orderSheetPr, analyse, summarize, readPrevious, buildWorkbook, detectKind, parseME2N, parseMB51, parseCJI3, classify, suggestFor, normPkg,
    CLASSES, CLASS, MVT, COST_CLASS, PACKAGES, MNLS, LAYOUT, mlabel, mtext, dtext, monthKey, esc, fmt, str, num, code };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.MaterialEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
