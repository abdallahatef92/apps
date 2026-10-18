// @ts-nocheck
/*
 * Port of the Material Cost Report 1.2 Excel writer (DesktopMaterail ReportMaterial_Cost_Report_v1.2.html, L1309-2213) -
 * the Subcontract Cost Report 2.6 workbook, for material. Kept nearly verbatim on purpose (like subcontractWorkbook.ts):
 * sheets, headers, formulas, number formats, drop-downs and notes are the tool's own. A standalone, LIVE workbook - one
 * input, the cut date on Summary!B4 (name CutDate) - fed by materialReport.ts with the tool's M object (see materialEngine.ts).
 *
 * Changes against the tool's writer, all deliberate:
 *   - createWriter(E) takes the engine as an argument instead of the browser global.
 *   - the hidden round-trip sheets _Ref (ME2N lines) and _Mvt (movements left out) are not written, nor the _Meta rows
 *     only the "drop the last report back in" flow read: the database is the history, nothing reads the workbook back.
 *     _Meta stays (RepKey = _Meta!B4 is a named range), as do _Cal and _Codes (the drop-downs).
 *   - the currency label comes from the project (M.currency) instead of the literal "EGP".
 *   - the Changes sheet is only written when M.changes is set; the app does not keep material-line snapshots yet.
 */
export function createWriter(E) {

  const { mLabel, mKey, keyToM, fmtDate, r2, r3 } = E.util;
  const C = { navy: '1F3864', blue: '2F5597', gold: 'BF8F00', light: 'DDEBF7', cur: 'FFF2CC', pend: 'EDEDED', grid: 'BFBFBF', edit: 'FFFFCC', ok: 'E2EFDA', warn: 'FCE4D6', info: 'DEEAF6', muted: '595959', off: 'A6A6A6' };
  const TAB = { report: '1F3864', coding: 'BF8F00', review: 'C55A11', data: '7F7F7F' };
  const FAM_FILL = 'D6DCE4';                          // a family row (the top level of the group tree)
  const F = { amt: '#,##0;[Red]-#,##0;"-"', qty: '#,##0.00;[Red]-#,##0.00;"-"', rate: '#,##0.00;[Red]-#,##0.00;""', pct: '0.0%;[Red]-0.0%;"-"', date: 'dd-mmm-yyyy', int: '#,##0;-#,##0;"-"',
    chg: '+#,##0.00;[Red]-#,##0.00;"-"', chgPct: '+0.0%;[Red]-0.0%;"-"', chgAmt: '+#,##0;[Red]-#,##0;"-"' };     // changes: + up, red − down, "-" none
  const font = (o) => Object.assign({ name: 'Arial', size: 10 }, o || {});
  const FONT = font(), FONT_B = font({ bold: true }), FONT_PEND = font({ italic: true, color: { argb: 'FF' + C.muted } }), FONT_KEY = font({ size: 9, color: { argb: 'FF' + C.muted } });
  const fill = (c) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + c } });
  const cfFill = (c) => ({ type: 'pattern', pattern: 'solid', bgColor: { argb: 'FF' + c } });
  const thin = { style: 'thin', color: { argb: 'FF' + C.grid } };
  const box = { top: thin, left: thin, bottom: thin, right: thin };
  const col = (n) => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
  const rate = (o) => (Math.abs(o.q) > 1e-9 ? r2(o.a / o.q) : null);
  const r4 = (x) => Math.round(x * 1e4) / 1e4;
  const q = (s) => String(s).replace(/"/g, '""');     // text inside a formula
  const PEND = 999999;                                // period key: a month yyyymm · Pending 999999
  const nextM = (k) => (k % 100 === 12 ? k + 89 : k + 1);
  const keyOf = (b) => (b === 'Pending' ? PEND : keyToM(b));

  function title(ws, t, sub, color) {
    ws.getCell('A1').value = t; ws.getCell('A1').font = font({ size: 14, bold: true, color: { argb: 'FF' + (color || C.navy) } });
    if (sub) { ws.getCell('A2').value = sub; ws.getCell('A2').font = font({ size: 9, color: { argb: 'FF' + C.muted } }); }
    ws.getRow(1).height = 22;
  }
  function headCell(c, text, bg) { c.value = text; c.font = font({ bold: true, color: { argb: 'FFFFFFFF' } }); c.fill = fill(bg || C.navy); c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }; c.border = box; }

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
    const ownAt = (c, e) => !!(e.hdr && c.own && c.own(e.lvl)), res0 = (x) => (x && typeof x === 'object' && 'result' in x ? x.result : x);
    const val = (c, e) => (ownAt(c, e) ? +res0(c.hv(e.d, e.lvl, 0)) || 0 : e.hdr ? 0 : +c.v(e.d, 0) || 0);
    let maxLvl = 0;
    entries.forEach((e, k) => {
      const n = first + k, row = ws.getRow(n);
      if (e.lvl) { row.outlineLevel = e.lvl; maxLvl = Math.max(maxLvl, e.lvl); }
      if (e.hdr) {
        const style = o.hdrStyle(e), f1 = first + k + 1, f2 = first + end[k];
        cols.forEach((c, i) => {
          const cell = row.getCell(i + 1);
          if (c.sum && end[k] > k && !ownAt(c, e) && !(c.sumLvl && e.lvl < c.sumLvl)) { const L = col(i + 1); let res = 0; for (let j = k + 1; j <= end[k]; j++) res += val(c, entries[j]); cell.value = { formula: `SUBTOTAL(9,${L}${f1}:${L}${f2})`, result: r2(res) }; }
          else { const v = c.hv ? c.hv(e.d, e.lvl, n) : null; cell.value = v == null || v === '' ? null : v; }
          if (c.fmt) cell.numFmt = c.fmt;
          cell.font = font({ bold: true }); cell.fill = fill(style.fill);
          if (e.lvl === 0) cell.border = { top: { style: 'medium', color: { argb: 'FF' + TH.head } } };
          if (i === 0 && o.indent) cell.alignment = { indent: e.lvl };
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
        if (i === 0 && o.indent) cell.alignment = { indent: e.lvl };
        edge(cell, c);
      });
    });
    const details = entries.filter((e) => !e.hdr);
    const lab = ws.getCell(totalRow, o.totalLabelCol || 1); lab.value = o.totalLabel || `TOTAL · ${details.length.toLocaleString('en-US')} rows · follows the filter`;
    lab.font = font({ bold: true, color: { argb: 'FF' + TH.head } });
    cols.forEach((c, i) => {
      if (!c.sum || c.sumLvl) return; const cell = ws.getCell(totalRow, i + 1); const L = col(i + 1);
      const res = r2(entries.reduce((s, e) => s + val(c, e), 0));
      cell.value = entries.length ? { formula: `SUBTOTAL(9,${L}${first}:${L}${last})`, result: res } : 0;
      cell.numFmt = c.fmt || F.amt; cell.font = font({ bold: true, color: { argb: 'FF' + TH.head } }); cell.fill = fill(TH.light); cell.border = box;
    });
    if (maxLvl || colLvl) ws.properties.outlineProperties = { summaryBelow: false, summaryRight: !!o.summaryRight };   // group rows above their rows; summary columns to the right
    if (maxLvl) ws.properties.outlineLevelRow = maxLvl + 1;
    if (colLvl) ws.properties.outlineLevelCol = colLvl + 1;
    ws.views = [{ state: 'frozen', xSplit: o.freezeCol || 0, ySplit: headRow }];
    if (entries.length) ws.autoFilter = { from: { row: headRow, column: 1 }, to: { row: last, column: cols.filter((c) => !c.hide).length } };
    return { headRow, first, last };
  }
  const plural = (n, w) => `${n.toLocaleString('en-US')} ${w}${n === 1 ? '' : 's'}`;
  const bucketLabel = (b) => (b === 'Pending' ? 'Pending' : mLabel(keyToM(b)));
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
    const wb = new ExcelJS.Workbook(); wb.creator = 'Material Cost Report ' + M.version; wb.created = new Date();
    const CUR = M.currency || 'EGP';                     // the project's currency (the tool printed a literal EGP)
    const foot = `${M.plant} · Material Cost Report`;
    const gl = (g) => E.grpLabel(g), gk = (g) => g || E.NO_GRP;                 // a group (code · SAP description) · as written on the Data sheet
    const divIdx = new Map(M.divs.filter((d) => d.code).map((d, i) => [d.code, i]));
    const divColor = (d, strong) => (d && divIdx.has(d) ? E.hslHex(E.towHue(divIdx.get(d)), strong ? 62 : 70, strong ? 78 : 88) : null);
    const grpColor = (g, strong) => divColor(E.divOf(g), strong);

    // ---- the one input: the cut date (Summary!B4 = CutDate); RepKey = its month (yyyymm). A line's period key is a formula on
    //      the Data sheet (month yyyymm · Pending 999999), so every SUMIFS below follows the cut date.
    const PK = { prev: 'D_PK,"<"&RepKey', cur: 'D_PK,RepKey', td: 'D_PK,"<="&RepKey', pend: `D_PK,${PEND}` };
    // Excel takes at most 255 characters in one text literal of a formula: longer text goes in pieces joined with &
    const lit = (s) => { const parts = []; for (let i = 0; i < s.length; i += 200) parts.push(`"${q(s.slice(i, i + 200))}"`); return parts.length ? parts.join('&') : '""'; };
    const subF = (extra) => ({ formula: `${lit(M.plant + ' · report month ')}&TEXT(CutDate,"mmm-yy")&" · cut date "&TEXT(CutDate,"dd-mmm-yyyy")&${lit(' · amounts in ' + CUR + ' (MB51 value)' + (extra || ''))}`,
      result: `${M.plant} · report month ${M.label} · cut date ${fmtDate(M.cutDate)} · amounts in ${CUR} (MB51 value)${extra || ''}` });
    const monF = (pre) => ({ formula: `"${q(pre)}"&TEXT(CutDate,"mmm-yy")`, result: pre + M.label });
    // the months a cut date can reach: the first counted month … the last month in the data (later months fill in as the cut moves)
    let lastMonth = M.reportMonth; for (const l of M.lines) if (l.month && l.month > lastMonth) lastMonth = l.month;
    const months = []; for (let m = M.months[0] || M.reportMonth; m <= lastMonth; m = nextM(m)) months.push(m);
    const periods = months.map((m) => ({ key: m, label: mLabel(m), b: mKey(m) }));
    const inCut = (p) => p.key <= M.reportMonth;        // a month the generation cut date already reaches (cached results)
    // the period blocks of the per-month sheets: Previous years (the earlier years rolled into one block, when chosen in the
    // tool) · the months · To date. There are no year totals, so a sheet copied and added up never counts a month twice.
    const pyEnd = (Math.floor(M.reportMonth / 100) - 1) * 100 + 12;             // December of the year before the report year
    const pyMonths = periods.filter((p) => p.key <= pyEnd);
    const roll = !!M.rollYears && pyMonths.length > 0;
    const PY = { py: true, key: null, id: 'py', label: `Previous years (to ${mLabel(pyEnd)})` };
    const colPeriods = (roll ? [PY].concat(periods.filter((p) => p.key > pyEnd)) : periods).map((p) => Object.assign({ id: 'm' + p.key }, p));
    const perCrit = (p) => (p.py ? `D_PK,"<="&MIN(RepKey,${pyEnd})` : `D_PK,${p.key}`);
    const perOff = (p, f) => (p.key ? `IF(${p.key}>RepKey,"",${f})` : f);        // months after the cut date stay blank
    const perRes = (x, p, f) => { if (!p.py) return inCut(p) ? f(x.at(p.b)) : null; let v = 0; for (const m of pyMonths) if (inCut(m)) v += f(x.at(m.b)); return v; };
    let minDate = null, maxDate = null; for (const l of M.lines) if (l.date) { if (!minDate || l.date < minDate) minDate = l.date; if (!maxDate || l.date > maxDate) maxDate = l.date; }
    // the cut dates on offer: every month end from the first to the last month in the data, newest first (hidden sheet _Cal)
    let calFrom = M.reportMonth, calTo = M.reportMonth; for (const l of M.lines) if (l.month) { if (l.month < calFrom) calFrom = l.month; if (l.month > calTo) calTo = l.month; }
    const cutList = []; for (let m = calFrom; m <= calTo; m = nextM(m)) cutList.unshift(new Date(Date.UTC(Math.floor(m / 100), m % 100, 0)));

    // ---- the Coding sheet layout (other sheets point at it): a KPI band (rows 1–2), a note (row 3), the header (row 4), then one row
    //      per material from row 5 in the tree order (family › division › group › material) – a plain list: Excel can sort and filter it
    const crows = M.crows, CR = 5;
    const codingGrp = (r) => (r.inData ? gl(r.group) : 'Kept from your coding – not in this data');
    const cEntries = crows.map((r) => ({ lvl: 0, d: r })), cLast = Math.max(CR, CR + cEntries.length - 1);
    const CODING = [
      ['Family', 15, 'ref', (r) => (r.inData ? E.famLabel(r.group) : null)], ['Division', 22, 'ref', (r) => (r.inData ? E.divLabel(r.group) : null)],
      ['Material group (SAP)', 30, 'ref', (r) => codingGrp(r)], ['Material', 11, 'ref', (r) => r.mat], ['Description', 46, 'ref', (r) => r.desc], ['Unit', 7, 'ref', (r) => r.unit],
      ['PKG', 12, 'pkg'], ['MNL', 9, 'mnl'], ['Cost element', 14, 'ce'],
      ['Status', 13, 'status'], ['Qty to date', 12, 'live', null, false, 'tdq'], ['Rate', 11, 'live', null, false, 'tdr'], ['To date', 14, 'live', null, true, 'tda'], ['This month', 14, 'live', null, false, 'cma'],
      ['New', 6, 'info', (r) => (r.isNew ? 'New' : '')], ['POs', 6, 'cnt', (r) => r.poCount || null], ['Suppliers', 30, 'info', (r) => r.subs],
      ['First issued', 10, 'info', (r) => (r.firstM ? mLabel(r.firstM) : '')], ['Last issued', 10, 'info', (r) => (r.lastM ? mLabel(r.lastM) : '')],
      ['Family key', 7, 'key', (r) => (r.inData ? E.famOf(r.group) || E.NO_GRP : null)], ['Division key', 7, 'key', (r) => (r.inData ? E.realDiv(r.group) || null : null)],
      ['Group key', 9, 'key', (r) => (r.inData ? r.group || E.NO_GRP : null)], ['ID', 6, 'id', (r) => r.id]];
    const cAt = (h) => CODING.findIndex((c) => c[0] === h) + 1;
    const codeCol = { pkg: col(cAt('PKG')), mnl: col(cAt('MNL')), ce: col(cAt('Cost element')) }, idCol = col(cAt('ID')), rateCol = col(cAt('Rate'));
    const keyCol = { fam: col(cAt('Family key')), div: col(cAt('Division key')), grp: col(cAt('Group key')) };
    const lookup = (f, rowRef) => `IFERROR(INDEX(Coding!$${codeCol[f]}$${CR}:$${codeCol[f]}$${cLast},${rowRef})&"","")`;   // a code of one coding row, "" when blank
    const match = (idRef) => `MATCH(${idRef},Coding!$${idCol}$${CR}:$${idCol}$${cLast},0)`;
    const rowNo = new Map(); cEntries.forEach((e, i) => rowNo.set(e.d.key, i + 1));   // place in the Coding range (MATCH results)
    // report sheets: a flat list in the tree order, grouped by division only (one header row per division, with its subtotals) –
    // every row shows its Family, Division and Material group in their own columns (a tabular view, so the list filters and copies cleanly).
    // A family without divisions in SAP (SP, SC …) is one block, "no SAP division". sub: rows that head lines (PO Register: PO › lines)
    const divEntries = (rows, grpOf, sub) => { const out = []; let d0 = null;
      for (const r of rows) { const g = grpOf(r) || '', dk = g ? E.realDiv(g) || (E.famOf(g) || g) + '/' : '';
        if (!d0 || d0.d.dk !== dk) { d0 = { hdr: true, lvl: 0, d: { dk, g, n: 0, grps: new Set() } }; out.push(d0); }
        d0.d.n++; d0.d.grps.add(g);
        if (sub) { out.push({ hdr: true, lvl: 1, d: r }); for (const k of sub(r)) out.push({ lvl: 2, d: k }); } else out.push({ lvl: 1, d: r });
      }
      return out; };
    const famCol = (get) => ({ h: 'Family', v: (r) => E.famLabel(get(r)), hv: (d, lvl) => (lvl === 0 ? E.famLabel(d.g) : null), w: 15 });
    const divCol = (get) => ({ h: 'Division', v: (r) => E.divLabel(get(r)), hv: (d, lvl) => (lvl === 0 ? E.divLabel(d.g) : null), w: 22, fill: (r) => grpColor(get(r), true) });
    const grpCol = (get, h) => ({ h: h || 'Material group (SAP)', v: (r) => gl(get(r)), hv: (d, lvl) => (lvl === 0 ? plural(d.grps.size, 'group') : null), w: 30, fill: (r) => grpColor(get(r)) });
    const typeStyle = (e) => (e.lvl === 0 ? { fill: grpColor(e.d.g, true) || 'E7E6E6' } : { fill: 'F2F2F2' });
    // per sheet: the letters of its columns by key (filled once its columns are laid out), the codes and the hidden link columns
    const lettersOf = (cols) => { const L = {}; cols.forEach((c, i) => { if (c.k) L[c.k] = col(i + 1); }); return L; };
    // the codes of a row, looked up live on the Coding sheet (a material that is not on it – a PO line never issued – has none)
    const codeCols = (L, keyOf) => F4.map((f) => ({ h: E.FIELD_NAME[f], hl: 'code', w: f === 'ce' ? 12 : f === 'pkg' ? 12 : 9, k: f,
      v: (r, n) => { const res = E.codeOf(cst, keyOf(r))[f] || ''; if (!n) return res; return rowNo.has(keyOf(r)) ? { formula: lookup(f, `$${L.crow}${n}`), result: res } : null; } }));
    const linkCols = (L, getKey) => [{ h: 'Coding ID', k: 'id', w: 6, hide: true, v: (r) => { const x = M.cIndex.get(getKey(r)); return x ? x.id : null; } },
      { h: 'Coding row', k: 'crow', w: 6, hide: true, v: (r, n) => (rowNo.has(getKey(r)) ? { formula: match(`$${L.id}${n}`), result: rowNo.get(getKey(r)) } : null) }];
    const rateF = (L, qk, ak) => (n) => `IF(ABS(${L[qk]}${n})<0.000001,"",${L[ak]}${n}/${L[qk]}${n})`;
    // current-month highlight and greyed months after the cut date, for a sheet with one column block per month
    const colNo = (L) => L.split('').reduce((s, ch) => s * 26 + ch.charCodeAt(0) - 64, 0);
    const periodCF = (ws, L, keyCol, first, last, sfx) => {
      let pri = 1;
      for (const p of colPeriods) {
        if (!p.key) continue;                           // Previous years is never after the cut date
        const nums = sfx.map((s) => L[p.id + s]).filter(Boolean).map(colNo); if (!nums.length) continue;
        const from = col(Math.min(...nums)), to = col(Math.max(...nums));
        ws.addConditionalFormatting({ ref: `${from}4:${to}5`, rules: [
          { type: 'expression', priority: pri++, formulae: [`RepKey=${p.key}`], style: { fill: cfFill(C.gold) } },
          { type: 'expression', priority: pri++, formulae: [`RepKey<${p.key}`], style: { fill: cfFill(C.off) } }] });
        ws.addConditionalFormatting({ ref: `${from}${first}:${to}${last}`, rules: [
          { type: 'expression', priority: pri++, formulae: [`AND(RepKey=${p.key},$${keyCol}${first}<>"")`], style: { fill: cfFill(C.cur) } }] });
      }
    };

    // ---- Material Summary: Previous | This month | To date | Pending | Rate analysis | PO price – live SUMIFS on the Data sheet by Coding ID
    const SL = {};
    const smId = (n) => `$${SL.id}${n}`;
    // rate analysis (same rules as the tool, E.rates): a change is only read when both rates are positive and within 3× of each
    // other – a bigger jump is a unit mix-up or a placeholder value: it shows "check", out of the totals
    const RT = new Map(M.items.map((r) => [r.key, E.rates(r, M.reportMonth)])), rt = (r) => RT.get(r.key);
    const dOf = (v) => (v === 'check' ? 'check' : v ? r2(v.d) : null), pOf = (v) => (v && v !== 'check' ? v.pct : null);
    const guard = (a, b) => `IF(OR(${a}="",${b}=""),"",IF(AND(${a}>0,${b}>0,${b}<=3*${a},3*${b}>=${a}),IF(ABS(${b}-${a})<0.005,0,${b}-${a}),"check"))`;
    const VG1 = 'Rate – this month vs previous (to last month)', VG2 = 'Rate – since the start (first month → to date)', VG3 = 'PO price (ME2N purchase lines)', RB1 = '7030A0', RB2 = '4B2D73', RB3 = '375623';
    const startQ = (r, n) => `SUMIFS(D_Qty,D_ID,${smId(n)},D_PK,${r.startKey})`;
    const SMC = [
      famCol((r) => r.group), divCol((r) => r.group), grpCol((r) => r.group), { h: 'Material', v: (r) => r.mat, w: 11 },
      { h: 'Description', v: (r) => r.desc, hv: (d, lvl) => (lvl === 0 ? plural(d.n, 'material') : null), w: 44 }, { h: 'Unit', v: (r) => r.unit, w: 7 }];
    const svcCols = SMC.concat(codeCols(SL, (r) => r.key), [
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
      live({ group: VG1, gbg: RB1, h: 'Change', k: 'mvr', fmt: F.chg, w: 10, note: 'This month’s rate − the previous rate (per unit). Blank when either has no quantity. "check" when the two rates differ more than 3 times (or one is not positive): usually a unit mix-up or a placeholder value – look at the lines on the Data sheet.',
        f: (n) => guard(`${SL.mpr}${n}`, `${SL.mcr}${n}`), res: (r) => dOf(rt(r).mv) }),
      live({ group: VG1, gbg: RB1, h: 'Change %', k: 'mvp', fmt: F.chgPct, w: 9, f: (n) => `IF(ISNUMBER(${SL.mvr}${n}),${SL.mvr}${n}/${SL.mpr}${n},"")`, res: (r) => pOf(rt(r).mv) }),
      live({ group: VG1, gbg: RB1, h: 'Value', k: 'mva', fmt: F.chgAmt, w: 12, sum: true, b: true, note: 'This month’s qty × the change = This month’s amount − this month’s qty at the previous rate: what this month cost more (+) or less (−) because the rate moved. Rows marked "check" are left out.',
        f: (n) => `IF(ISNUMBER(${SL.mvr}${n}),ROUND(${SL.cq}${n}*${SL.mvr}${n},2),"")`, res: (r) => rt(r).mValue }),
      // to date against the start rate (the rate in the material's first month with quantity)
      live({ group: VG2, gbg: RB2, h: 'First month', k: 'sfm', w: 9, bl: true, note: 'The first month this material was issued with quantity.',
        f: (n, r) => (r.startKey == null ? '""' : `IF(${r.startKey}>RepKey,"","${mLabel(r.startKey)}")`), res: (r) => (rt(r).st ? rt(r).st.label : null) }),
      live({ group: VG2, gbg: RB2, h: 'Start rate', k: 'ssr', fmt: F.rate, w: 10, note: 'The rate in the first month = that month’s amount ÷ its qty.',
        f: (n, r) => (r.startKey == null ? '""' : `IF(${r.startKey}>RepKey,"",IF(ABS(${startQ(r, n)})<0.000001,"",SUMIFS(D_Amt,D_ID,${smId(n)},D_PK,${r.startKey})/${startQ(r, n)}))`), res: (r) => (rt(r).st ? rt(r).sr : null) }),
      live({ group: VG2, gbg: RB2, h: 'To date rate', k: 'str', fmt: F.rate, w: 10, f: (n) => `IF(${SL.tr}${n}="","",${SL.tr}${n})`, res: (r) => rt(r).tr }),
      live({ group: VG2, gbg: RB2, h: 'Change', k: 'svr', fmt: F.chg, w: 10, note: 'To date rate − start rate (per unit): how the average issue rate moved since the first month. "check" as on the left.', f: (n) => guard(`${SL.ssr}${n}`, `${SL.str}${n}`), res: (r) => dOf(rt(r).sv) }),
      live({ group: VG2, gbg: RB2, h: 'Change %', k: 'svp', fmt: F.chgPct, w: 9, f: (n) => `IF(ISNUMBER(${SL.svr}${n}),${SL.svr}${n}/${SL.ssr}${n},"")`, res: (r) => pOf(rt(r).sv) }),
      live({ group: VG2, gbg: RB2, h: 'Value', k: 'sva', fmt: F.chgAmt, w: 13, sum: true, b: true, note: 'To date qty × the change = To date amount − to date qty at the start rate: what the material issued to date cost more (+) or less (−) than at the first month’s rate.',
        f: (n) => `IF(ISNUMBER(${SL.svr}${n}),ROUND(${SL.tq}${n}*${SL.svr}${n},2),"")`, res: (r) => rt(r).sValue }),
      // the price on the purchase orders (ME2N, purchase lines with a price – stock transfers from own stores carry none)
      { group: VG3, gbg: RB3, h: 'Weighted', k: 'pow', fmt: F.rate, w: 11, bl: true, v: (r) => (r.wavg ? r4(r.wavg) : null),
        note: 'The weighted unit price on the material’s purchase lines in ME2N (Net price ÷ Price unit, weighted by order qty; deleted lines and stock transfers left out).' },
      { group: VG3, gbg: RB3, h: 'Last', k: 'pol', fmt: F.rate, w: 11, v: (r) => (r.last ? r4(r.last.price) : null), note: 'The unit price on the newest purchase line (by PO date).' },
      live({ group: VG3, gbg: RB3, h: 'To date rate vs PO', k: 'pov', fmt: F.chgPct, w: 10, note: 'To date rate ÷ weighted PO price − 1: the material is issued above (+) or below (−) the price it was bought at.',
        f: (n) => `IF(OR(N(${SL.pow}${n})=0,NOT(ISNUMBER(${SL.tr}${n}))),"",${SL.tr}${n}/${SL.pow}${n}-1)`, res: (r) => (r.wavg && Math.abs(r.td.q) > 1e-9 ? r.td.a / r.td.q / r4(r.wavg) - 1 : null) })],
      linkCols(SL, (r) => r.key));
    Object.assign(SL, lettersOf(svcCols));
    const smEntries = divEntries(M.items, (r) => r.group);
    const smFirst = 6, smLast = 5 + smEntries.length;
    const smRange = (L) => `'Material Summary'!$${L}$${smFirst}:$${L}$${smLast}`;
    const smDetail = (L) => `SUMIFS(${smRange(L)},${smRange(SL.id)},">0")`;   // detail rows only (they carry a Coding ID; group rows do not)
    const smAmt = { prev: SL.pa, cur: SL.ca, td: SL.ta, pend: SL.na };

    // ---- Data columns: what the reader needs first – what (group, material, description, unit) · coding · when · where · Qty, Rate,
    //      AMOUNT – then how each figure was calculated, then the keys the tool and the formulas use (far right, grey)
    const docFirst = new Set(), matFirst = new Set();   // one line carries the count: per document, per material × month
    { const a = new Set(), c = new Set();                // M.lines are in date order, so the first line of a material × month is its earliest
      for (const l of M.lines) { const d = E.docOf(l), mm = l.material + '|' + (l.month || '');
        if (!a.has(d)) { a.add(d); docFirst.add(l); } if (!c.has(mm)) { c.add(mm); matFirst.add(l); } } }
    const D = [
      ['Family', 8, (l) => l.fam || E.NO_GRP], ['Division', 9, (l) => l.dv || E.NO_GRP], ['Material group', 12, (l) => gk(l.group)], ['Material', 11, (l) => l.material], ['Description', 40, (l) => l.desc], ['Unit', 6, (l) => l.info.unit || null],
      ['PKG', 9, null, null, 'code'], ['MNL', 7, null, null, 'code'], ['Cost element', 12, null, null, 'code'],
      ['Period', 9, null], ['Posting date', 12, (l) => l.date, F.date], ['WBS element', 24, (l) => l.wbs || E.NO_WBS], ['Issue type', 15, (l) => l.itype], ['Material doc.', 12, (l) => l.doc],
      ['Qty', 11, (l) => r3(l.rq), F.qty], ['Rate', 11, null, F.rate], ['Amount', 14, (l) => l.amt, F.amt, 'amt'],
      ['Pending reason', 13, null], ['Movement type', 9, (l) => l.mvt], ['Movement text', 18, (l) => l.mvtText || null], ['SAP qty', 11, (l) => l.sapQty, F.qty], ['SAP amount', 13, (l) => l.sapAmt, F.amt],
      ['Unit of entry', 7, (l) => l.unit || null], ['Entry date', 12, (l) => l.edate, F.date], ['Subcontractor (SAP code)', 13, (l) => l.supplier || null], ['Reservation', 10, (l) => l.resv || null],
      ['User', 10, (l) => l.user || null], ['Text', 30, (l) => l.text || null], ['Header text', 20, (l) => l.hdr || null], ['Valuation type', 10, (l) => l.val || null], ['Storage location', 8, (l) => l.sloc || null],
      ['Order', 11, (l) => l.order || null], ['Material type', 9, (l) => l.info.type || null],
      ['Month key', 8, (l) => l.month || null, '0', 'key'], ['Period key', 8, null, '0', 'key'], ['Doc count', 7, (l) => (docFirst.has(l) ? 1 : null), '0', 'key'],
      ['Material count', 8, (l) => (matFirst.has(l) ? 1 : null), '0', 'key'], ['Doc. year', 7, (l) => l.year, null, 'key'], ['Doc. item', 6, (l) => l.item, null, 'key'],
      ['Line ID', 22, (l) => l.lid, null, 'key'], ['Coding ID', 8, (l) => M.cIndex.get(l.ckey).id, null, 'key'], ['Coding row', 8, null, null, 'key']];
    const ix = (h) => D.findIndex((d) => d[0] === h) + 1, dc = (h) => col(ix(h));
    const nData = M.lines.length + 1;
    const NAMES = { D_ID: 'Coding ID', D_PK: 'Period key', D_Qty: 'Qty', D_Amt: 'Amount', D_Grp: 'Material group', D_Div: 'Division', D_Fam: 'Family', D_Typ: 'Issue type', D_WBS: 'WBS element', D_Date: 'Posting date',
      D_MK: 'Month key', D_Doc: 'Doc count', D_MatN: 'Material count' };

    // PO type names (Lists sheet, columns T:U): the name the user gave, else a hint for types that are transfers only
    const PT_ROWS = 60, ptName = (t) => (cst.poTypes.has(t) ? cst.poTypes.get(t) : (M.poTypes.find((x) => x.type === t) || {}).transfer ? 'Stores transfer (no value)' : '');
    // ================= 1. Summary
    const ws = wb.addWorksheet('Summary', { properties: { tabColor: { argb: 'FF' + TAB.report } }, views: [{ showGridLines: false }] });
    ws.getCell('A1').value = 'Material Cost Report'; ws.getCell('A1').font = font({ size: 16, bold: true, color: { argb: 'FF' + C.navy } });
    ws.getCell('A2').value = `${M.plant} · ${CUR} (MB51 value)`; ws.getCell('A2').font = font({ size: 11, bold: true });
    const p = M.progressAll;
    ws.getCell('A3').value = `Made ${fmtDate(new Date(Date.UTC(M.generated.getFullYear(), M.generated.getMonth(), M.generated.getDate())))} with Material Cost Report ${M.version} from ${[M.files.mb, M.files.me, M.files.master].filter(Boolean).join(' + ')}${M.files.via ? ' (kept in ' + M.files.via + ')' : ''} · coding ${Math.round(p.pct * 1000) / 10}% of the amount complete when made · every figure below is live: it follows the cut date in B4 and the Coding sheet`; ws.getCell('A3').font = font({ size: 9, color: { argb: 'FF' + C.muted } });
    [44, 16, 16, 16, 16, 16, 16, 14, 13].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
    // the input
    { const a = ws.getCell('A4'), b = ws.getCell('B4'), c = ws.getCell('C4'), d = ws.getCell('E4');      // D4 stays empty: the report month spills into it
      a.value = 'Cut date  ▸'; a.font = font({ size: 12, bold: true, color: { argb: 'FF' + C.navy } }); a.alignment = { horizontal: 'right', vertical: 'middle' };
      b.value = M.cutDate; b.numFmt = F.date; b.font = font({ size: 12, bold: true }); b.fill = fill(C.edit); b.alignment = { horizontal: 'center', vertical: 'middle' };
      b.border = { top: { style: 'medium', color: { argb: 'FF' + C.gold } }, left: { style: 'medium', color: { argb: 'FF' + C.gold } }, bottom: { style: 'medium', color: { argb: 'FF' + C.gold } }, right: { style: 'medium', color: { argb: 'FF' + C.gold } } };
      b.dataValidation = { type: 'list', allowBlank: false, formulae: [`_Cal!$A$2:$A$${cutList.length + 1}`], showErrorMessage: true, errorStyle: 'warning', errorTitle: 'Cut date', error: 'This date is not a month end from the list. Keep it as a mid-month cut date?', showInputMessage: true, promptTitle: 'Cut date', prompt: 'Pick a month end from the list – every sheet follows. You can also type another date, e.g. 25-Aug-2026 for a mid-month cut.' };
      b.note = 'The one input of this workbook. Change it and every sheet follows: Previous = before this month, This month = the month of this date up to this date, Pending = posted later.';
      c.value = monF('Report month '); c.font = font({ size: 12, bold: true, color: { argb: 'FF' + C.navy } }); c.alignment = { vertical: 'middle' };
      d.value = `Pick the cut date from the list (▼) – every sheet follows. A mid-month date can also be typed. Issues in the data: ${fmtDate(minDate)} to ${fmtDate(maxDate)}.`; d.font = font({ size: 9, italic: true, color: { argb: 'FF' + C.muted } }); d.alignment = { vertical: 'middle' };
      ws.getRow(4).height = 24; }
    const cellAt = (row, c) => { const x = ws.getCell(row, c); x.font = FONT; return x; };
    const kpis = [['Previous (last month)', `SUMIFS(D_Amt,${PK.prev})`, M.T.prev], [monF('This month · '), `SUMIFS(D_Amt,${PK.cur})`, M.T.cur], ['To date', 'A7+B7', M.T.td],
      ['Pending – not in To date', `SUMIFS(D_Amt,${PK.pend})`, M.T.pending], ['Materials issued this month', `SUMIFS(D_MatN,${PK.cur})`, M.K.activeMat], ['Issue documents this month', `SUMIFS(D_Doc,${PK.cur})`, M.K.docs]];
    kpis.forEach(([h, f, v], i) => {
      const a = ws.getCell(6, i + 1), b = ws.getCell(7, i + 1);
      a.value = h; a.font = font({ size: 9, bold: true, color: { argb: 'FFFFFFFF' } }); a.fill = fill(i === 1 ? C.gold : C.navy); a.alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' };
      b.value = { formula: f, result: v }; b.numFmt = i >= 4 ? F.int : F.amt; b.font = font({ size: 14, bold: true, color: { argb: 'FF' + C.navy } }); b.alignment = { horizontal: 'center' }; b.border = box; b.fill = fill(i === 1 ? C.cur : 'FFFFFF');
    });
    ws.getRow(6).height = 40; ws.getRow(7).height = 24;
    let r = 9, famTotRow = 0;
    const section = (t, note) => { const c = ws.getCell(r, 1); c.value = t; c.font = font({ size: 12, bold: true, color: { argb: 'FF' + C.navy } });
      if (note) { const d = ws.getCell(r, 2); d.value = note; d.font = font({ size: 9, italic: true, color: { argb: 'FF' + C.muted } }); } r += 1; };
    const hdr = (arr) => { arr.forEach((h, i) => headCell(ws.getCell(r, i + 1), h)); ws.getRow(r).height = 28; r++; };
    // 1. per month – a row for every month the cut date can reach (blank after it); the key in hidden column J
    section('1. Cost per month', 'live – months after the cut date stay blank');
    const RES = [['Project (221/222)', 'Project', 'P'], ['To subcontractors (Z21/Z22)', 'To subcontractors', 'S'], ['Scrap (551/552)', 'Scrap', 'X']];
    const mh = ['Month'].concat(RES.map((x) => x[0]), ['Total', 'Cumulative', 'Materials issued', 'Issue documents']);
    hdr(mh); const m0 = r, KC = 'J', totC = col(RES.length + 2);
    ws.getColumn(10).hidden = true;
    for (const per of periods) {
      const row = M.monthRows.find((x) => x.bucket === per.b), on = inCut(per) && row, key = `$${KC}${r}`, off = (f) => `IF(${key}>RepKey,"",${f})`;
      ws.getCell(r, 10).value = per.key;
      cellAt(r, 1).value = per.label; ws.getCell(r, 1).border = box;
      RES.forEach(([, res, k], j) => { const c = cellAt(r, j + 2); c.value = { formula: off(`SUMIFS(D_Amt,D_PK,${key},D_Typ,"${res}")`), result: on ? row[k] : '' }; c.numFmt = F.amt; c.border = box; });
      { const c = cellAt(r, RES.length + 2); c.value = { formula: off(`SUMIFS(D_Amt,D_PK,${key})`), result: on ? row.total : '' }; c.numFmt = F.amt; c.border = box; }
      { const c = cellAt(r, RES.length + 3); c.value = { formula: off(`SUM(${totC}$${m0}:${totC}${r})`), result: on ? row.cum : '' }; c.numFmt = F.amt; c.border = box; }
      { const c = cellAt(r, RES.length + 4); c.value = { formula: off(`SUMIFS(D_MatN,D_PK,${key})`), result: on ? row.mats : '' }; c.numFmt = F.int; c.border = box; }
      { const c = cellAt(r, RES.length + 5); c.value = { formula: off(`SUMIFS(D_Doc,D_PK,${key})`), result: on ? row.docs : '' }; c.numFmt = F.int; c.border = box; }
      r++;
    }
    const mLastRow = r - 1;
    ws.addConditionalFormatting({ ref: `A${m0}:${col(RES.length + 5)}${mLastRow}`, rules: [
      { type: 'expression', priority: 1, formulae: [`$${KC}${m0}=RepKey`], style: { fill: cfFill(C.cur), font: { bold: true } } },
      { type: 'expression', priority: 2, formulae: [`$${KC}${m0}>RepKey`], style: { font: { color: { argb: 'FF' + C.off } } } }] });
    { const T = M.T, tot = ['Total'].concat(RES.map(([, , k]) => r2(M.monthRows.reduce((s, x) => s + x[k], 0))), [T.td]);
      tot.forEach((v, i) => { const c = ws.getCell(r, i + 1); c.value = i ? { formula: `SUM(${col(i + 1)}${m0}:${col(i + 1)}${mLastRow})`, result: v } : v; c.font = font({ bold: true }); c.fill = fill(C.light); c.border = box; if (i) c.numFmt = F.amt; });
      { const L = col(RES.length + 5), c = ws.getCell(r, RES.length + 5); c.value = { formula: `SUM(${L}${m0}:${L}${mLastRow})`, result: M.monthRows.reduce((s, x) => s + x.docs, 0) }; c.numFmt = F.int; c.font = font({ bold: true }); c.fill = fill(C.light); c.border = box; }
      r += 2; }
    const monthTotRow = r - 2;
    // 2–4. by PKG, MNL, Cost element: LIVE – SUMIFS on Material Summary, whose codes come from the Coding sheet. Whatever is not coded yet is one line, so nothing is missed.
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
    liveTable('2. Cost by PKG', 'pkg');
    liveTable('3. Cost by MNL', 'mnl');
    liveTable('4. Cost by cost element', 'ce');
    // 5. family › division › group (each material by its SAP group), in tree order, grouped: − / + folds a family or a division –
    //    live SUMIFS on the Data sheet
    ws.getRow(r - 1).addPageBreak();                  // printed: KPIs, months and the coding tables on page 1; the tree, purchasing, reconciliation and checks on page 2
    section('5. Cost by family › division › group', 'live – SAP: each material by its material group · − / + at the left folds a family or a division');
    hdr(['Family › division › group', 'Previous', 'This month', 'To date', '% of to date', 'Pending']); { const d0 = r;
      const rows5 = [];
      for (const fm of M.fams) {
        rows5.push({ x: fm, crit: `D_Fam,"${q(fm.code || E.NO_GRP)}"`, lvl: 0, lab: fm.code ? E.grpLabel(fm.code) : E.NO_GRP });
        if (!fm.code) continue;
        const gs = M.grps.filter((g) => g.code && E.famOf(g.code) === fm.code);
        for (const g of gs.filter((g2) => !E.realDiv(g2.code))) rows5.push({ x: g, crit: `D_Grp,"${q(g.code)}"`, lvl: 1, grp: true, lab: g.name });
        for (const d of M.divs) if (d.code && E.famOf(d.code) === fm.code && d.code !== fm.code) {
          rows5.push({ x: d, crit: `D_Div,"${q(d.code)}"`, lvl: 1, lab: d.name });
          for (const g of gs.filter((g2) => E.realDiv(g2.code) === d.code)) rows5.push({ x: g, crit: `D_Grp,"${q(g.code)}"`, lvl: 2, grp: true, lab: g.name });
        }
      }
      const tr0 = d0 + rows5.length; let maxL = 0;
      for (const { x, crit, lvl, grp, lab } of rows5) {
        const top = lvl === 0;
        cellAt(r, 1).value = lab; ws.getCell(r, 1).border = box; ws.getCell(r, 1).alignment = { indent: lvl * 2 };
        [[2, `SUMIFS(D_Amt,${crit},${PK.prev})`, x.prev.a], [3, `SUMIFS(D_Amt,${crit},${PK.cur})`, x.cur.a], [4, `B${r}+C${r}`, x.td.a], [5, `IF($D$${tr0}=0,"",D${r}/$D$${tr0})`, M.T.td ? x.td.a / M.T.td : 0], [6, `SUMIFS(D_Amt,${crit},${PK.pend})`, x.pend.a]]
          .forEach(([c, f, v]) => { const y = cellAt(r, c); y.value = { formula: f, result: v }; y.numFmt = c === 5 ? F.pct : F.amt; y.border = box; if (c === 3) y.fill = fill(C.cur); if (c === 4 || !grp) y.font = FONT_B; });
        if (top) { ws.getCell(r, 1).font = FONT_B; [1, 2, 4, 5, 6].forEach((c) => { ws.getCell(r, c).fill = fill(FAM_FILL); }); }
        else { if (!grp) ws.getCell(r, 1).font = FONT_B; const tcol = grpColor(x.code, !grp); if (tcol) ws.getCell(r, 1).fill = fill(tcol); }
        if (lvl) { ws.getRow(r).outlineLevel = lvl; maxL = Math.max(maxL, lvl); }
        r++;
      }
      if (maxL) { ws.properties.outlineProperties = { summaryBelow: false, summaryRight: false }; ws.properties.outlineLevelRow = maxL + 1; }
      const totF = { 2: [`SUMIFS(D_Amt,${PK.prev})`, M.T.prev], 3: [`SUMIFS(D_Amt,${PK.cur})`, M.T.cur], 4: [`B${r}+C${r}`, M.T.td], 6: [`SUMIFS(D_Amt,${PK.pend})`, M.T.pending] };
      ['Total', 0, 0, 0, 1, 0].forEach((v, i) => { const c = ws.getCell(r, i + 1); c.value = totF[i + 1] ? { formula: totF[i + 1][0], result: totF[i + 1][1] } : v; c.font = font({ bold: true }); c.fill = fill(C.light); c.border = box; if (i >= 1) c.numFmt = i === 4 ? F.pct : F.amt; });
      famTotRow = r; r += 2; }
    // 4. reconciliation – the MB51 total and what is left out are facts of the data; the Pending lines follow the cut date
    // 6. purchasing – ME2N as exported, per PO type (the first two digits of the PO number); committed = To date (live) + still to deliver
    if (M.poTypes.length) {
      section('6. Purchasing (ME2N)', 'as exported – not live (only To date in Committed follows the cut date) · per PO type: name them on the Lists sheet');
      hdr(['PO type', 'Lines', 'POs', 'PO value', 'Delivered', 'Still to deliver', 'Open > 90 days', 'Still to invoice']); const p0 = r;
      const pts = M.poTypes.filter((t) => t.transfer < t.lines);
      for (const t of pts) { const nm0 = ptName(t.type);
        const lab = { formula: `"${t.type}"&IFERROR(IF(VLOOKUP("${t.type}",Lists!$T$2:$U$${PT_ROWS + 1},2,FALSE)="",""," · "&VLOOKUP("${t.type}",Lists!$T$2:$U$${PT_ROWS + 1},2,FALSE)),"")`, result: t.type + (nm0 ? ' · ' + nm0 : '') };
        [lab, t.lines, t.pos, t.value, r2(t.delivered), t.openVal, t.old, t.invVal].forEach((v, i) => { const c = cellAt(r, i + 1); c.value = v; c.border = box; if (i) c.numFmt = i <= 2 ? F.int : F.amt; if (i === 5) c.font = FONT_B; });
        r++; }
      const pt0 = r; ['Total purchases'].concat([2, 3, 4, 5, 6, 7, 8].map((c) => ({ formula: `SUM(${col(c)}${p0}:${col(c)}${r - 1})`, result: [0, 0, 'lines', 'pos', 'value', 'delivered', 'openVal', 'old', 'invVal'][c] ? r2(pts.reduce((s2, t) => s2 + t[['', '', 'lines', 'pos', 'value', 'delivered', 'openVal', 'old', 'invVal'][c]], 0)) : 0 })))
        .forEach((v, i) => { const c = ws.getCell(r, i + 1); c.value = v; c.font = FONT_B; c.fill = fill(C.light); c.border = box; if (i) c.numFmt = i <= 2 ? F.int : F.amt; });
      r++;
      const st = M.poTypes.filter((t) => t.transfer), stL = st.reduce((s2, t) => s2 + t.transfer, 0);
      if (stL) { const c0 = cellAt(r, 1); c0.value = `Stores transfers (no value) – ${plural(stL, 'line')}, ${plural(st.reduce((s2, t) => s2 + t.openN, 0), 'line')} still open (Stores Transfers sheet)`; c0.font = font({ italic: true, color: { argb: 'FF' + C.muted } }); r++; }
      { const c0 = cellAt(r, 1); c0.value = 'Committed = To date (MB51, live) + still to deliver'; c0.font = FONT_B; c0.border = box;
        const c1 = ws.getCell(r, 4); c1.value = { formula: `SUMIFS(D_Amt,${PK.td})+F${pt0}`, result: r2(M.T.td + pts.reduce((s2, t) => s2 + t.openVal, 0)) }; c1.numFmt = F.amt; c1.font = FONT_B; c1.fill = fill(C.light); c1.border = box;
        const c2 = ws.getCell(r, 5); c2.value = 'what the material will have cost once the open POs arrive and are issued'; c2.font = font({ size: 9, italic: true, color: { argb: 'FF' + C.muted } }); r += 2; }
    }
    section('7. From the MB51 total to this report');
    hdr(['Step', 'Amount', 'Lines / rows', 'Note']); ws.mergeCells(r - 1, 4, r - 1, 8);
    const T = M.T, cn = M.counts, hasNoDate = M.lines.some((l) => !l.month);
    const recon = [['MB51 total – every row, as SAP signs it', T.rawSum, cn.rawRows, T.footer == null ? 'The export has no SAP total row' : `SAP's total row: ${Math.round(T.footer).toLocaleString('en-US')}${Math.abs(T.footer - T.rawSum) < 1 ? ' – the rows add up to it' : ' – the rows do NOT add up to it (Checks)'}`]];
    if (cn.dupRows) recon.push(['Less: the same document line twice', -T.dupAmt, -cn.dupRows, 'Counted once']);
    recon.push(['Less: movements that are not material cost', -T.outsideSum, -cn.outsideRows, 'Receipts, transfers, issues to orders or cost centres … – the Checks sheet lists them'],
      ['= Issues to the project, as SAP signs them', T.issuedSap, cn.costRows, 'GI/RE for project, to subcontractors (Z21/Z22), scrap – SAP signs an issue negative'],
      ['= Material cost (the sign turned: an issue is a cost)', T.certified, M.lines.length, `${cn.zeroLines.toLocaleString('en-US')} zero-value lines also left out (no effect)`]);
    const costIdx = recon.length - 1;
    recon.push(['Less: Pending – posted after the cut date', { formula: '-SUMIFS(D_Amt,D_Date,">"&CutDate)', result: -T.pendAfter }, null, 'Posting date after the cut date (B4)']);
    if (hasNoDate) recon.push(['Less: Pending – no date', { formula: '-SUMIFS(D_Amt,D_MK,"")', result: -T.pendNoDate }, null, '']);
    const r0 = r, costRow = r0 + costIdx;
    recon.push([{ formula: `"= To date (months to "&TEXT(CutDate,"mmm-yy")&")"`, result: `= To date (months to ${M.label})` }, { formula: `B${costRow}+SUM(B${costRow + 1}:B${r0 + recon.length - 1})`, result: T.td }, null, 'The To date of every report sheet']);
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
      ['Material Summary To date − above', `ROUND(${smDetail(smAmt.td)}-B${tdRow},2)`],
      ['Family › division total − above', `ROUND(D${famTotRow}-B${tdRow},2)`],
      ['Data sheet (lines up to the cut date) − above', `ROUND(SUMIFS(D_Amt,${PK.td})-B${tdRow},2)`],
      ['Cost per month total − above', `ROUND(${totC}${monthTotRow}-B${tdRow},2)`],
    ];
    for (const [lab, f] of checksF) { cellAt(r, 1).value = lab; ws.getCell(r, 1).border = box; const c = ws.getCell(r, 2); c.value = { formula: f, result: 0 }; c.numFmt = '#,##0.00;[Red]-#,##0.00;"✔ 0"'; c.border = box; c.font = font({ bold: true, color: { argb: 'FF375623' } }); r++; }
    landscape(ws, null, foot); ws.pageSetup.orientation = 'portrait';

    // ================= 2. Coding (one row per material: type its codes in the yellow cells, the report follows)
    const cs = wb.addWorksheet('Coding', { properties: { tabColor: { argb: 'FF' + TAB.coding } }, views: [{ showGridLines: false }] });
    CODING.forEach(([, w], i) => { cs.getColumn(i + 1).width = w; });
    // any code is accepted. The drop-down of each code column = the codes on the Lists sheet + every code already typed in that
    // column, unique and live (hidden _Codes sheet), so a code typed once is offered on every other row at once.
    const LIST = { pkg: 'A', mnl: 'D', ce: 'G' }, CODES = { pkg: 'A', mnl: 'B', ce: 'C' };
    const nLists = Math.max(1, ...F4.map((f) => cst.lists[f].length)), lRows = nLists + 60, kRows = nLists + 80;
    const dropList = (f) => `OFFSET(_Codes!$${CODES[f]}$2,0,0,MAX(1,COUNTIF(_Codes!$${CODES[f]}$2:$${CODES[f]}$${kRows + 1},"?*")),1)`;
    const CL = {}; CODING.forEach(([, , , , , k], i) => { if (k) CL[k] = col(i + 1); });
    const codingLive = {
      tdq: [(n) => `SUMIFS(D_Qty,D_ID,$${idCol}${n},${PK.td})`, (x) => x.td.q, F.qty], tda: [(n) => `SUMIFS(D_Amt,D_ID,$${idCol}${n},${PK.td})`, (x) => x.td.a, F.amt],
      tdr: [(n) => `IF(ABS(${CL.tdq}${n})<0.000001,"",${CL.tda}${n}/${CL.tdq}${n})`, (x) => rate(x.td), F.rate], cma: [(n) => `SUMIFS(D_Amt,D_ID,$${idCol}${n},${PK.cur})`, (x) => x.cur.a, F.amt] };
    const stL = col(cAt('Status')), HR = CR - 1;
    // each unit its own colour (golden-angle hues, the most used first, so neighbours always differ) – easy to spot down the list
    const unitN = new Map(); for (const x of crows) if (x.unit) unitN.set(x.unit, (unitN.get(x.unit) || 0) + 1);
    const unitColor = new Map([...unitN.keys()].sort((a, b) => unitN.get(b) - unitN.get(a)).map((u, i) => [u, E.hslHex(Math.round((i * 137.508 + 300) % 360), 60, 80)]));
    const famOfRow = (x) => (x.inData ? E.famOf(x.group) || E.NO_GRP : '~'), divOfRow = (x) => (x.inData ? E.divOf(x.group) : '~');
    cEntries.forEach((e, i) => {
      const n = CR + i, row = cs.getRow(n);
      const x = e.d, c = E.codeOf(cst, x.key);
      CODING.forEach(([, , kind, v, bold, k], j) => {
        const cell = row.getCell(j + 1);
        if (F4.includes(kind)) { cell.value = c[kind] || null; cell.fill = fill(C.edit); cell.border = box; cell.font = font({ bold: true });
          cell.dataValidation = { type: 'list', allowBlank: true, formulae: [dropList(kind)], showErrorMessage: false }; }
        else if (kind === 'status') { const kk = F4.filter((f) => c[f]).length, rg = `${codeCol.pkg}${n}:${codeCol.ce}${n}`;
          cell.value = x.inData ? { formula: `IF(COUNTIF(${rg},"?*")=3,"Coded",IF(COUNTIF(${rg},"?*")=0,"Not coded","Partly coded"))`, result: kk === 3 ? 'Coded' : kk ? 'Partly coded' : 'Not coded' } : 'Not in this data'; cell.font = FONT; }
        else if (kind === 'live') { const [f, res, fmt] = codingLive[k], y = res(x); cell.value = { formula: f(n), result: y == null ? '' : y }; cell.numFmt = fmt; cell.font = bold ? FONT_B : FONT; }
        else { const y = v(x); cell.value = y === '' || y == null || (y === 0 && kind !== 'id') ? null : y; cell.font = kind === 'info' ? font({ color: { argb: 'FF' + C.muted } }) : kind === 'key' ? FONT_KEY : kind === 'cnt' && y > 1 ? FONT_B : FONT;
          if (kind === 'cnt') { cell.numFmt = F.int; cell.alignment = { horizontal: 'center' }; } }
      });
      const tc = grpColor(x.group); if (tc && x.inData) { row.getCell(cAt('Division')).fill = fill(tc); row.getCell(cAt('Material group (SAP)')).fill = fill(grpColor(x.group, false)); }
      if (x.inData) row.getCell(cAt('Family')).fill = fill(FAM_FILL);
      const uc = unitColor.get(x.unit || ''); if (uc) row.getCell(cAt('Unit')).fill = fill(uc);
      if (x.isNew) row.getCell(cAt('New')).fill = fill(C.warn);
      // a line above each new group: medium at a new family, thin navy at a new division or group
      if (i) { const p0 = cEntries[i - 1].d, newFam = famOfRow(p0) !== famOfRow(x), newGrp = codingGrp(p0) !== codingGrp(x) || divOfRow(p0) !== divOfRow(x);
        if (newFam || newGrp) for (let j = 1; j <= CODING.length; j++) row.getCell(j).border = Object.assign({}, row.getCell(j).border || {}, { top: { style: newFam ? 'medium' : 'thin', color: { argb: 'FF' + C.navy } } }); }
    });
    CODING.forEach(([h, , kind], i) => headCell(cs.getCell(HR, i + 1), h, F4.includes(kind) ? C.gold : kind === 'info' || kind === 'key' ? '7F7F7F' : C.navy));
    cs.getCell(HR, cAt('This month')).value = monF('This month · ');
    cs.getRow(HR).height = 30;
    const hNote = (h, t) => { cs.getCell(HR, cAt(h)).note = t; };
    hNote('Family', 'The family of the material group on the SAP tree: M Materials, P Plant & tools, SP Spare parts, oils & fuel … The list runs family › division › group › material (largest first within a group).');
    hNote('Division', 'The division of the material group (M03 Concrete, M26 Electrical …). Families without divisions in SAP (SP, SC, MTEX …) show "no SAP division".');
    hNote('Material group (SAP)', 'The SAP material group with its SAP description – from ME2N, else the material list (MB52 / MM60 / master), else an earlier report.');
    hNote('Rate', 'Average issue rate = To date ÷ Qty to date (' + CUR + ' per unit, MB51 value). Live: follows the cut date on the Summary.');
    hNote('POs', 'How many ME2N POs carry this material (deleted lines left out; bold = more than one). The PO Register lists them.');
    hNote('Suppliers', 'The vendors on its purchase lines in ME2N, largest PO value first (stock transfers from own stores are not suppliers).');
    hNote('Unit', 'Each unit has its own colour, so rows with the same unit stand out.');
    hNote('Status', 'Coded = PKG, MNL and Cost element all typed · Partly coded · Not coded. The band on top counts them.');
    for (const f of F4) hNote(E.FIELD_NAME[f], `Type the ${E.FIELD_NAME[f]} of this material, or pick it (Lists sheet + every code already typed in this column; "conc" and "Conc" are one code). An empty cell is orange. Every sheet follows at once.`);
    for (const h of ['Family key', 'Division key', 'Group key', 'ID']) cs.getColumn(cAt(h)).hidden = true;
    for (const f of F4) cs.addConditionalFormatting({ ref: `${codeCol[f]}${CR}:${codeCol[f]}${cLast}`, rules: [
      { type: 'expression', priority: 1, formulae: [`AND($${stL}${CR}<>"Not in this data",LEN(TRIM(${codeCol[f]}${CR}))=0)`], style: { fill: cfFill('F8CBAD') } }] });
    cs.addConditionalFormatting({ ref: `${stL}${CR}:${stL}${cLast}`, rules: [
      { type: 'cellIs', operator: 'equal', priority: 7, formulae: ['"Coded"'], style: { fill: cfFill(C.ok) } },
      { type: 'cellIs', operator: 'equal', priority: 8, formulae: ['"Partly coded"'], style: { fill: cfFill(C.cur) } },
      { type: 'cellIs', operator: 'equal', priority: 9, formulae: ['"Not coded"'], style: { fill: cfFill(C.warn) } }] });
    // the KPI band (rows 1–2, live): what is still to code – each figure above the column it counts
    { const K = M.codingKpi, rg = (L) => `$${L}$${CR}:$${L}$${cLast}`, st = rg(stL), td = rg(CL.tda), cm = rg(CL.cma);
      const open = (r0) => `SUMIFS(${r0},${st},"Partly coded")+SUMIFS(${r0},${st},"Not coded")`;
      const BAND = [
        ['Family', 'Materials still to code', `COUNTIF(${st},"Not coded")+COUNTIF(${st},"Partly coded")`, K.toCode, F.int, true],
        ['Division', 'Fully coded', `COUNTIF(${st},"Coded")&" of "&(COUNTIF(${st},"Coded")+COUNTIF(${st},"Partly coded")+COUNTIF(${st},"Not coded"))&" materials"`, `${K.coded} of ${K.rows} materials`, null, false, 'Material group (SAP)'],
        ...F4.map((f) => [E.FIELD_NAME[f], `${E.FIELD_NAME[f]} missing`, `COUNTIFS(${rg(codeCol[f])},"",${st},"<>Not in this data")`, K.missing[f], F.int, true]),
        ['Status', 'Coded – share of To date', `IFERROR(SUMIFS(${td},${st},"Coded")/SUMIFS(${td},${st},"<>Not in this data"),0)`, K.share, F.pct, false],
        ['To date', 'To date not fully coded', open(td), K.tdOpen, F.amt, true],
        ['This month', 'This month not fully coded', open(cm), K.curOpen, F.amt, true],
        ['New', 'New', `COUNTIF(${rg(col(cAt('New')))},"New")`, K.fresh, F.int, false],
        ['POs', '2+ POs', `COUNTIF(${rg(col(cAt('POs')))},">1")`, K.multiPo, F.int, false]];
      for (const [h, lab, f, res, fmt, warn, to] of BAND) {
        const c0 = cAt(h), a = cs.getCell(1, c0), b = cs.getCell(2, c0);
        if (to) { cs.mergeCells(1, c0, 1, cAt(to)); cs.mergeCells(2, c0, 2, cAt(to)); }
        a.value = lab; a.font = font({ size: 9, bold: true, color: { argb: 'FFFFFFFF' } }); a.fill = fill(warn ? C.gold : C.navy); a.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }; a.border = box;
        b.value = { formula: f, result: res }; if (fmt) b.numFmt = fmt; b.font = font({ size: 13, bold: true, color: { argb: 'FF' + C.navy } }); b.alignment = { horizontal: 'center', vertical: 'middle' }; b.border = box;
        if (warn) cs.addConditionalFormatting({ ref: `${col(c0)}2`, rules: [
          { type: 'expression', priority: 20, formulae: [`ROUND(${col(c0)}2,0)=0`], style: { fill: cfFill(C.ok) } },
          { type: 'expression', priority: 21, formulae: [`ROUND(${col(c0)}2,0)<>0`], style: { fill: cfFill(C.warn) } }] });
      }
      cs.getRow(1).height = 30; cs.getRow(2).height = 24;
      const c3 = cs.getCell(3, 1); c3.value = 'Live – the band follows the codes typed below · one row per material: family › division › group › material, each largest first by To date – sort and filter freely · type PKG, MNL and Cost element in the yellow cells · an orange code cell is still empty · where the most is left: the Lists sheet';
      c3.font = font({ size: 9, italic: true, color: { argb: 'FF' + C.muted } }); }
    cs.views = [{ state: 'frozen', xSplit: 0, ySplit: HR, showGridLines: false }];
    cs.autoFilter = { from: { row: HR, column: 1 }, to: { row: cLast, column: cAt('Last issued') } };
    landscape(cs, `${HR}:${HR}`, foot);

    // ================= 2b. Lists (code names, and the coding by family › division › group – where the most is left)
    const li = wb.addWorksheet('Lists', { properties: { tabColor: { argb: 'FF' + TAB.coding } } });
    const LH = [['PKG code', 12], ['PKG name', 30], ['', 3], ['MNL code', 10], ['MNL name', 22], ['', 3], ['Cost element code', 16], ['Cost element name', 30], ['', 3],
      ['Family › division › group (report order)', 46], ['Level', 9], ['Materials', 10], ['Coded', 9], ['To code', 9], ['To date', 15], ['To date not fully coded', 15], ['% of all', 9], ['Coded % of to date', 10]];
    LH.forEach(([h, w], i) => { li.getColumn(i + 1).width = w; if (h) headCell(li.getCell(1, i + 1), h, i >= 9 && i <= 10 ? C.navy : i >= 11 ? C.blue : C.navy); });
    li.getRow(1).height = 30;
    const Ls = cst.lists, nL = Math.max(1, ...F4.map((f) => Ls[f].length));
    for (let i = 0; i < nL; i++) { const g = (f, j) => (Ls[f][i] ? Ls[f][i][j] || null : null);
      [g('pkg', 0), g('pkg', 1), null, g('mnl', 0), g('mnl', 1), null, g('ce', 0), g('ce', 1)].forEach((v, j) => { if (v != null) { const c = li.getCell(i + 2, j + 1); c.value = v; c.font = FONT; } }); }
    { const T0 = 2, tree = M.codingTree, tLast = T0 + tree.length - 1, totR = tLast + 1, cr = (L) => `Coding!$${L}$${CR}:$${L}$${cLast}`, st = cr(stL), td = cr(CL.tda);
      const LV = { fam: 'Family', div: 'Division', grp: 'Group' };
      tree.forEach((x, i) => {
        const n = T0 + i, kr = cr(keyCol[x.kind]), key = `"${q(x.key)}"`, top = x.kind === 'fam';
        const vals = [[10, x.label], [11, LV[x.kind]],
          [12, { formula: `COUNTIF(${kr},${key})`, result: x.mats }, F.int], [13, { formula: `COUNTIFS(${kr},${key},${st},"Coded")`, result: x.coded }, F.int],
          [14, { formula: `L${n}-M${n}`, result: x.toCode }, F.int], [15, { formula: `SUMIFS(${td},${kr},${key})`, result: x.td }, F.amt],
          [16, { formula: `O${n}-SUMIFS(${td},${kr},${key},${st},"Coded")`, result: x.tdOpen }, F.amt],
          [17, { formula: `IF($O$${totR}=0,"",O${n}/$O$${totR})`, result: M.T.td ? x.td / M.T.td : '' }, F.pct],
          [18, { formula: `IF(O${n}=0,"",1-P${n}/O${n})`, result: x.td ? 1 - x.tdOpen / x.td : '' }, F.pct]];
        for (const [c, v, fmt] of vals) { const cell = li.getCell(n, c); cell.value = v; if (fmt) cell.numFmt = fmt; cell.border = box;
          cell.font = top ? FONT_B : x.kind === 'div' && c === 10 ? FONT_B : c === 11 ? FONT_KEY : FONT; if (top) cell.fill = fill(FAM_FILL); }
        li.getCell(n, 10).alignment = { indent: x.lvl * 2 };
        if (!top) { const dc0 = grpColor(x.key, x.kind === 'div'); if (dc0) li.getCell(n, 10).fill = fill(dc0); }
      });
      const famSum = (L) => `SUMIFS($${L}$${T0}:$${L}$${Math.max(T0, tLast)},$K$${T0}:$K$${Math.max(T0, tLast)},"Family")`, fams = tree.filter((x) => x.kind === 'fam'), fs = (k) => fams.reduce((s2, x) => s2 + x[k], 0);
      [[10, 'Total'], [12, { formula: famSum('L'), result: fs('mats') }, F.int], [13, { formula: famSum('M'), result: fs('coded') }, F.int], [14, { formula: `L${totR}-M${totR}`, result: fs('toCode') }, F.int],
        [15, { formula: famSum('O'), result: r2(fs('td')) }, F.amt], [16, { formula: famSum('P'), result: r2(fs('tdOpen')) }, F.amt], [17, 1, F.pct],
        [18, { formula: `IF(O${totR}=0,"",1-P${totR}/O${totR})`, result: fs('td') ? 1 - fs('tdOpen') / fs('td') : '' }, F.pct]]
        .forEach(([c, v, fmt]) => { const cell = li.getCell(totR, c); cell.value = v; if (fmt) cell.numFmt = fmt; cell.font = FONT_B; cell.fill = fill(C.light); cell.border = box; });
      if (tree.length) li.addConditionalFormatting({ ref: `N${T0}:N${tLast}`, rules: [
        { type: 'expression', priority: 1, formulae: [`AND(ISNUMBER(N${T0}),N${T0}>0)`], style: { fill: cfFill(C.warn) } },
        { type: 'expression', priority: 2, formulae: [`AND(ISNUMBER(L${T0}),L${T0}>0,N${T0}=0)`], style: { fill: cfFill(C.ok) } }] });
      li.getCell(1, 10).note = 'Live – the coding by family › division › group, in the report order: how many materials, how many fully coded (PKG, MNL and Cost element), how many to code, and how much of the To date is not fully coded yet. Start where "To date not fully coded" is largest. Filter Level to see families or divisions only.';
      li.getCell(1, 16).note = 'The To date of the materials of this branch that are not fully coded (Coding sheet, Status not "Coded").';
      li.autoFilter = { from: { row: 1, column: 10 }, to: { row: Math.max(2, tLast), column: 18 } }; }
    { [['', 3], ['PO type', 9], ['PO type name', 30], ['Lines', 9], ['POs', 8], ['PO value', 15], ['Open value', 14]].forEach(([h, w], i) => { li.getColumn(19 + i).width = w; if (h) headCell(li.getCell(1, 19 + i), h, i === 2 ? C.gold : C.navy); });
      M.poTypes.forEach((t, i) => { const n = i + 2;
        [[20, t.type], [21, ptName(t.type) || null], [22, t.lines, F.int], [23, t.pos, F.int], [24, t.value, F.amt], [25, t.openVal, F.amt]].forEach(([c, v, fmt]) => { const x = li.getCell(n, c); x.value = v; if (fmt) x.numFmt = fmt; x.border = box; x.font = c === 21 ? font({ bold: true }) : FONT; if (c === 21) x.fill = fill(C.edit); }); });
      for (let n = M.poTypes.length + 2; n <= Math.max(M.poTypes.length + 4, 6); n++) { const a = li.getCell(n, 20), b = li.getCell(n, 21); a.border = box; b.border = box; b.fill = fill(C.edit); }
      li.getCell(1, 20).note = 'The first two digits of the PO number = its SAP number range (document type). Give each a name – the PO Register, the Stores Transfers sheet and the Summary show it. Lines, POs and values as exported (deleted lines left out).'; }
    li.views = [{ state: 'frozen', ySplit: 1 }];
    li.getCell('A1').note = 'The codes and their names. Add a code here or simply type it on the Coding sheet – both appear in the drop-downs at once. Codes typed there are added to this sheet when the report goes through the tool.';
    // hidden _Codes: the live drop-down lists (Lists codes first, then codes typed on the Coding sheet)
    const cx = wb.addWorksheet('_Codes', { state: 'hidden' });
    F4.forEach((f, j) => {
      const L = CODES[f], lr = `Lists!$${LIST[f]}$2:$${LIST[f]}$${lRows + 1}`, cr = `Coding!$${codeCol[f]}$${CR}:$${codeCol[f]}$${cLast}`;
      cx.getCell(1, j + 1).value = `${E.FIELD_NAME[f]} drop-down (live)`; cx.getColumn(j + 1).width = 18;
      const seen = new Set(), vals = [], push = (v) => { if (v == null || v === '') return; const k = String(v).toUpperCase(); if (!seen.has(k)) { seen.add(k); vals.push(v); } };
      for (const [c] of cst.lists[f]) push(c); for (const e of cEntries) push(E.codeOf(cst, e.d.key)[f]);
      for (let k = 1; k <= kRows; k++) {
        const above = `${L}$1:${L}${k}`, pick = (rng) => `INDEX(${rng},MATCH(0,INDEX(COUNTIF(${above},${rng})+(${rng}=""),0,0),0))`;
        cx.getCell(k + 1, j + 1).value = { formula: `IFERROR(${pick(lr)},IFERROR(${pick(cr)},""))`, result: vals[k - 1] != null ? vals[k - 1] : '' };
      }
    });

    // ================= 3. Material Summary (live from the Data sheet; codes live from Coding)
    const sv = wb.addWorksheet('Material Summary', { properties: { tabColor: { argb: 'FF' + TAB.report } } });
    title(sv, 'Material Summary – cost by family › division › group › material', subF(' · grouped by division: − / + at the left folds one (1 / 2 above it) · live: follows the cut date on the Summary and the Coding sheet · Rate = Amount ÷ Qty (the issue price) · right: this month’s rate against the previous one, to date against the first month’s, and the PO price'));
    const st = table(sv, svcCols, smEntries, { top: 3, freezeCol: 4, totalLabelCol: 5, hdrStyle: typeStyle });
    if (st.first !== smFirst || st.last !== smLast) throw new Error('Material Summary layout changed – update the Summary formulas.');
    landscape(sv, '4:5', foot);

    // ================= 4. Material per Month (codes, then qty, rate and amount per month block – every month the cut date can reach)
    const TL = {};
    const tr = wb.addWorksheet('Material per Month', { properties: { tabColor: { argb: 'FF' + TAB.report } } });
    title(tr, 'Material per Month – qty, rate and amount per month', subF(` · Pending not included · months after the cut date stay blank${roll ? ` · earlier years in one block: Previous years (to ${mLabel(pyEnd)})` : ''} · the 1 / 2 buttons above the columns: 1 = amounts, 2 = qty, rate and amount · − / + at the left folds a division`));
    const trendCols = SMC.map((c) => Object.assign({}, c)).concat(codeCols(TL, (r) => r.key));
    const tId = (n) => `$${TL.id}${n}`;
    { let tint = false;
      const block = (cols) => { cols[0].bl = true; if (tint) cols.forEach((c) => { c.tint = 'F4F6FA'; }); tint = !tint; trendCols.push(...cols); };
      for (const p2 of colPeriods) {
        const crit = perCrit(p2), off = (f) => perOff(p2, f), qk = p2.id + 'q', ak = p2.id + 'a', gbg = p2.py ? '44546A' : undefined;
        block([live({ group: p2.label, gbg, h: 'Qty', k: qk, fmt: F.qty, w: 10, olvl: 1, f: (n) => off(`SUMIFS(D_Qty,D_ID,${tId(n)},${crit})`), res: (x) => perRes(x, p2, (o) => o.q) }),
          live({ group: p2.label, gbg, h: 'Rate', k: p2.id + 'r', fmt: F.rate, w: 9, olvl: 1, f: (n) => `IF(ABS(N(${TL[qk]}${n}))<0.000001,"",${TL[ak]}${n}/${TL[qk]}${n})`,
            res: (x) => { const qq = perRes(x, p2, (o) => o.q), aa = perRes(x, p2, (o) => o.a); return qq != null && Math.abs(qq) > 1e-9 ? r2(aa / qq) : null; } }),
          live({ group: p2.label, gbg, h: 'Amount', k: ak, fmt: F.amt, sum: true, w: 12, f: (n) => off(`SUMIFS(D_Amt,D_ID,${tId(n)},${crit})`), res: (x) => perRes(x, p2, (o) => o.a) })]);
      }
      block([live({ group: 'To date', gbg: C.navy, h: 'Qty', k: 'tq', fmt: F.qty, w: 12, olvl: 1, f: (n) => `SUMIFS(D_Qty,D_ID,${tId(n)},${PK.td})`, res: (x) => x.td.q }),
        live({ group: 'To date', gbg: C.navy, h: 'Rate', k: 'tr', fmt: F.rate, w: 10, olvl: 1, f: rateF(TL, 'tq', 'ta'), res: (x) => rate(x.td) }),
        live({ group: 'To date', gbg: C.navy, h: 'Amount', k: 'ta', fmt: F.amt, sum: true, w: 14, b: true, f: (n) => `SUMIFS(D_Amt,D_ID,${tId(n)},${PK.td})`, res: (x) => x.td.a })]);
    }
    trendCols.push(...linkCols(TL, (r) => r.key));
    Object.assign(TL, lettersOf(trendCols));
    const tt = table(tr, trendCols, smEntries, { top: 3, freezeCol: 4, totalLabelCol: 5, hdrStyle: typeStyle, summaryRight: true });
    periodCF(tr, TL, TL.id, tt.first, tt.last, ['q', 'r', 'a']);
    landscape(tr, '4:5', foot);

    // ================= 5. PO Register (ME2N purchases, by material: division › material › its PO lines, newest first) and
    //                    6. Stores Transfers (stock transport orders from own stores – no value), the same way
    // A material row carries its totals and what MB51 says about it (issued to date, live); its lines carry the PO detail.
    const ptLookup = (ref) => `IFERROR(VLOOKUP(${ref},Lists!$T$2:$U$${PT_ROWS + 1},2,FALSE)&"","")`;
    const at1 = (fn) => (d, lvl, n) => (lvl === 1 ? fn(d, n) : null);
    const fx = (n, f, r) => (n ? { formula: f, result: r == null ? '' : r } : r);
    const isu = (mat) => { const x = M.cIndex.get(mat); return x && x.inData ? x : null; };
    const pctT = (x) => `${Math.round(x * 100)}%`;
    const matCols = (L, what) => [
      { h: 'Family', v: (x) => E.famLabel(x.m.group), hv: (d, lvl) => (lvl === 0 ? E.famLabel(d.g) : lvl === 1 ? E.famLabel(d.group) : null), w: 15 },
      { h: 'Division', v: (x) => E.divLabel(x.m.group), hv: (d, lvl) => (lvl === 0 ? E.divLabel(d.g) : lvl === 1 ? E.divLabel(d.group) : null), w: 22, fill: (x) => grpColor(x.m.group, true) },
      { h: 'Material group (SAP)', v: (x) => gl(x.m.group), hv: (d, lvl) => (lvl === 0 ? plural(d.grps.size, 'group') : lvl === 1 ? gl(d.group) : null), w: 30, fill: (x) => grpColor(x.m.group) },
      { h: 'Material', v: (x) => x.m.mat, hv: at1((d) => d.mat), w: 11 },
      { h: 'Description', v: (x) => x.m.desc, hv: (d, lvl) => (lvl === 0 ? plural(d.n, 'material') : lvl === 1 ? d.desc : null), w: 40 },
      { h: 'Unit', v: (x) => x.unit, hv: at1((d) => d.unit), w: 6 }]
      .concat(F4.map((f) => ({ h: E.FIELD_NAME[f], hl: 'code', w: f === 'mnl' ? 8 : 11,
        v: () => null, hv: at1((d, n) => (rowNo.has(d.mat) ? fx(n, lookup(f, `$${L.crow}${n}`), E.codeOf(cst, d.mat)[f] || '') : null)) })));
    const linkCols1 = (L) => [{ h: 'Coding ID', k: 'id', w: 6, hide: true, v: () => null, hv: at1((d) => (M.cIndex.get(d.mat) ? M.cIndex.get(d.mat).id : null)) },
      { h: 'Coding row', k: 'crow', w: 6, hide: true, v: () => null, hv: at1((d, n) => (rowNo.has(d.mat) ? fx(n, match(`$${L.id}${n}`), rowNo.get(d.mat)) : null)) }];
    // issued to date (MB51, live) on the material row
    const issuedQ = (L) => ({ h: 'Issued qty to date', k: 'iq', fmt: F.qty, w: 11, bl: true, v: () => null, note: 'MB51: the quantity issued to the project up to the cut date (live, Data sheet). In the issue unit – check the Unit if it differs from the order unit.',
      hv: at1((d, n) => { const x = isu(d.mat); return x ? fx(n, `SUMIFS(D_Qty,D_ID,$${L.id}${n},${PK.td})`, x.td.q) : 0; }) });
    const OD = 'Ordered (ME2N)', VL2 = 'Value (ME2N)', PP = 'PO price (purchase lines)', IS = 'Issued (MB51, live)', CM = 'Committed';
    const ptype = (L) => [{ h: 'PO type', k: 'pt', v: (x) => x.type, w: 7, note: 'The first two digits of the PO number – its SAP number range (30… transfers from own stores, 50… vendor POs …). Name the types on the Lists sheet.' },
      { h: 'Type name', v: (x, n) => fx(n, ptLookup(`$${L.pt}${n}`), ptName(x.type)), w: 16 }];
    const lineInfo = (L, who) => [{ h: 'Item', v: (x) => x.item, w: 6 }, { h: who, v: (x) => x.vendor, w: 28 }, { h: 'PO date', k: 'pd', v: (x) => x.date, fmt: F.date, w: 11 },
      { h: 'Age (days)', k: 'age', fmt: F.int, w: 8, note: 'Days from the PO date to the cut date – open lines dated up to the cut date (live: follows the cut date).', v: (x, n) => (x.date ? fx(n, `IF(AND(N($${L.oq2}${n})>0,$${L.pd}${n}<=CutDate),CutDate-$${L.pd}${n},"")`, x.age) : null) },
      { h: 'Status', k: 'st', v: (x) => x.status, w: 13, note: 'As exported: Open (nothing delivered) · Partly delivered · To invoice (delivered, not all invoiced) · Closed · Blocked (deletion indicator S). Deleted lines (L) are left out.' }];
    const qtyCols = () => [{ group: OD, h: 'Order qty', k: 'oq', v: (x) => x.qty, fmt: F.qty, w: 11, bl: true, sum: true, sumLvl: 1 },
      { group: OD, h: 'Delivered', k: 'dq', v: (x) => x.delivered, fmt: F.qty, w: 11, sum: true, sumLvl: 1, note: 'Order qty − Still to be delivered (qty).' },
      { group: OD, h: 'Open qty', k: 'oq2', v: (x) => x.openQty, fmt: F.qty, w: 10, sum: true, sumLvl: 1, note: 'Still to be delivered (qty) in ME2N.' }];

    // ---- 5. PO Register
    const PL = {};
    const po = wb.addWorksheet('PO Register', { properties: { tabColor: { argb: 'FF' + TAB.report } } });
    title(po, 'PO Register – what was bought, material by material', `${M.plant} · ME2N as exported${M.files.me ? ' (' + M.files.me + ')' : ''} – purchases (lines with a value), deleted lines left out; transfers from own stores: the Stores Transfers sheet · division › material › its PO lines (newest first) – − / + folds them · a material row: its totals, its PO prices and what MB51 issued (live) · Flag: what to look at`);
    const poCols = matCols(PL).concat(
      [{ h: 'PO', v: (x) => x.po, hv: at1((d) => plural(new Set(d.lines.map((l) => l.po)).size, 'PO')), w: 11, bl: true }], ptype(PL), lineInfo(PL, 'Supplier'), qtyCols(), [
        { group: VL2, h: 'Unit price', k: 'up', v: (x) => (x.unitPrice ? r4(x.unitPrice) : null), fmt: F.rate, w: 10, bl: true, note: 'Net price ÷ Price unit.' },
        { group: VL2, h: 'PO value', k: 'pv', v: (x) => x.value, fmt: F.amt, sum: true, b: true, w: 13, note: 'Net order value in ME2N.' },
        { group: VL2, h: 'Delivered value', k: 'dv', v: (x) => r2(x.value - x.openVal), fmt: F.amt, sum: true, w: 13, note: 'PO value − Still to be delivered (value).' },
        { group: VL2, h: 'Open value', k: 'ov', v: (x) => x.openVal, fmt: F.amt, sum: true, w: 12, note: 'Still to be delivered (value) in ME2N.' },
        { group: VL2, h: 'To invoice', k: 'inv', v: (x) => x.invVal, fmt: F.amt, sum: true, w: 12, note: 'Still to be invoiced (value) in ME2N: delivered (or prepaid) but not invoiced yet.' },
        { group: PP, gbg: RB3, h: 'vs lowest', k: 'vl', fmt: F.chgPct, w: 9, bl: true, note: 'A PO line: its unit price against the lowest price this material was bought at (+20% = 1.2 × the lowest). A material row: the spread – highest ÷ lowest − 1.',
          v: (x) => (x.vsLow != null ? x.vsLow : null), hv: at1((d) => (d.spread != null ? d.spread : null)) },
        { group: PP, gbg: RB3, h: 'Lowest', k: 'lo', fmt: F.rate, w: 10, v: () => null, hv: at1((d) => (d.low ? r4(d.low) : null)) },
        { group: PP, gbg: RB3, h: 'Last', fmt: F.rate, w: 10, v: () => null, hv: at1((d) => (d.lastPrice ? r4(d.lastPrice) : null)), note: 'The unit price on the newest PO line.' },
        { group: PP, gbg: RB3, h: 'Weighted', k: 'wa', fmt: F.rate, w: 10, v: () => null, hv: at1((d) => (d.wavg ? r4(d.wavg) : null)), note: 'The unit prices weighted by order qty.' },
        Object.assign(issuedQ(PL), { group: IS, gbg: C.blue }),
        { group: IS, gbg: C.blue, h: 'Delivered − issued', k: 'di', fmt: F.qty, w: 11, v: () => null, note: 'Delivered on the purchase lines − issued to date: received and not issued (yet) – on site or in the store. Transfers from own stores are not in it (Stores Transfers sheet). Check the units.',
          hv: at1((d, n) => { const x = isu(d.mat); return fx(n, `N($${PL.dq}${n})-N($${PL.iq}${n})`, r3(d.delivered - (x ? x.td.q : 0))); }) },
        { group: IS, gbg: C.blue, h: 'Issue rate', k: 'ir', fmt: F.rate, w: 10, v: () => null, note: 'MB51 to date: amount ÷ qty (live).',
          hv: at1((d, n) => { const x = isu(d.mat); return fx(n, `IF(ABS(N($${PL.iq}${n}))<0.000001,"",$${PL.ia}${n}/$${PL.iq}${n})`, x && Math.abs(x.td.q) > 1e-9 ? x.td.a / x.td.q : null); }) },
        { group: IS, gbg: C.blue, h: 'vs weighted PO', fmt: F.chgPct, w: 10, v: () => null, note: 'Issue rate ÷ weighted PO price − 1: issued above (+) or below (−) the price it was bought at.',
          hv: at1((d, n) => { const x = isu(d.mat), wa = d.wavg ? r4(d.wavg) : 0; return fx(n, `IF(OR(N($${PL.wa}${n})=0,NOT(ISNUMBER($${PL.ir}${n}))),"",$${PL.ir}${n}/$${PL.wa}${n}-1)`, x && wa && Math.abs(x.td.q) > 1e-9 ? x.td.a / x.td.q / wa - 1 : null); }) },
        { group: IS, gbg: C.blue, h: 'Issued to date', k: 'ia', fmt: F.amt, w: 13, sum: true, own: (l) => l === 1, v: () => null, note: 'MB51: the cost issued to the project up to the cut date (live).',
          hv: at1((d, n) => { const x = isu(d.mat); return x ? fx(n, `SUMIFS(D_Amt,D_ID,$${PL.id}${n},${PK.td})`, x.td.a) : 0; }) },
        { group: CM, gbg: '7030A0', h: 'Issued + open', k: 'cm', fmt: F.amt, w: 14, b: true, bl: true, sum: true, own: (l) => l === 1, v: () => null, note: 'Committed: issued to date (MB51) + still to be delivered on its POs (ME2N) – what this material will have cost once the open POs arrive and are issued.',
          hv: at1((d, n) => { const x = isu(d.mat); return fx(n, `N($${PL.ia}${n})+N($${PL.ov}${n})`, r2((x ? x.td.a : 0) + d.openVal)); }) },
        { h: 'Flag', w: 22, bl: true, note: 'A PO line: Blocked · Open > 90 days · Price > 20% above the lowest · To invoice (first that applies). A material row: Delivered, not issued (nothing issued to date) · Price spread > 20%. Filter on it.',
          v: (x, n) => fx(n, `IF($${PL.st}${n}="Blocked","Blocked",IF(N($${PL.age}${n})>90,"Open > 90 days",IF(N($${PL.vl}${n})>0.2,"Price +"&TEXT($${PL.vl}${n},"0%")&" vs lowest",IF(N($${PL.inv}${n})>0.5,"To invoice",""))))`,
            x.status === 'Blocked' ? 'Blocked' : x.age > 90 ? 'Open > 90 days' : x.vsLow > 0.2 ? `Price +${pctT(x.vsLow)} vs lowest` : x.invVal > 0.5 ? 'To invoice' : ''),
          hv: at1((d, n) => { const x = isu(d.mat), q0 = x ? x.td.q : 0;
            return fx(n, `IF(N($${PL.iq}${n})=0,IF(N($${PL.dq}${n})>0,"Delivered, not issued","Not issued yet"),IF(N($${PL.vl}${n})>0.2,"Price spread "&TEXT($${PL.vl}${n},"0%"),""))`,
              Math.abs(q0) < 1e-12 ? (d.delivered > 0 ? 'Delivered, not issued' : 'Not issued yet') : d.spread > 0.2 ? `Price spread ${pctT(d.spread)}` : ''); }) }],
      linkCols1(PL));
    Object.assign(PL, lettersOf(poCols));
    const withM = (m) => m.lines.map((l) => Object.assign({ m }, l));
    const matStyle = (e) => (e.lvl === 0 ? { fill: grpColor(e.d.g, true) || 'E7E6E6' } : { fill: 'EAF1FC', first: grpColor(e.d.group) });
    const poEntries = divEntries(M.purMats, (m) => m.group, withM);
    const nLines = M.purMats.reduce((s2, m) => s2 + m.lines.length, 0);
    table(po, poCols, poEntries, { top: 3, freezeCol: 4, totalLabelCol: 5, totalLabel: `TOTAL · ${plural(M.purMats.length, 'material')} · ${plural(nLines, 'PO line')} · follows the filter`, hdrStyle: matStyle });
    if (!M.purMats.length) po.getCell('A6').value = M.meLines.length ? 'ME2N has no purchase line (with a value).' : 'ME2N was not loaded – no purchase orders to list.';
    landscape(po, '4:5', foot);

    // ---- 6. Stores Transfers
    const SL2 = {};
    const so = wb.addWorksheet('Stores Transfers', { properties: { tabColor: { argb: 'FF' + TAB.report } } });
    title(so, 'Stores Transfers – material sent from own stores (no value)', `${M.plant} · ME2N as exported – stock transport orders from own stores and plants (SBD1, KNDA, SUTH …): they carry no price, so they are not in the PO Register · division › material › its transfer lines (newest first) · issued qty is live (MB51)`);
    const soCols = matCols(SL2).concat(
      [{ h: 'Transfer (PO)', v: (x) => x.po, hv: at1((d) => plural(new Set(d.lines.map((l) => l.po)).size, 'transfer')), w: 12, bl: true }], ptype(SL2), lineInfo(SL2, 'From (store / plant)'), qtyCols(),
      [Object.assign(issuedQ(SL2), { group: IS, gbg: C.blue }),
        { h: 'Flag', w: 20, bl: true, note: 'A line: Open > 90 days. A material row: Not issued yet (nothing issued to date).',
          v: (x, n) => fx(n, `IF(N($${SL2.age}${n})>90,"Open > 90 days","")`, x.age > 90 ? 'Open > 90 days' : ''),
          hv: at1((d, n) => { const x = isu(d.mat); return fx(n, `IF(N($${SL2.iq}${n})=0,"Not issued yet","")`, x && Math.abs(x.td.q) > 1e-12 ? '' : 'Not issued yet'); }) }],
      linkCols1(SL2));
    Object.assign(SL2, lettersOf(soCols));
    const nSto = M.stoMats.reduce((s2, m) => s2 + m.lines.length, 0);
    table(so, soCols, divEntries(M.stoMats, (m) => m.group, withM), { top: 3, freezeCol: 4, totalLabelCol: 5, totalLabel: `TOTAL · ${plural(M.stoMats.length, 'material')} · ${plural(nSto, 'transfer line')} · follows the filter`, hdrStyle: matStyle });
    if (!M.stoMats.length) so.getCell('A6').value = 'No transfer from own stores in ME2N.';
    landscape(so, '4:5', foot);

    // ================= 8. Checks (review – as made: the tool redoes them)
    const ck = wb.addWorksheet('Checks', { properties: { tabColor: { argb: 'FF' + TAB.review } }, views: [{ showGridLines: false }] });
    title(ck, 'Checks – what to look at before sending the report', `${M.plant} · as made for the cut date ${fmtDate(M.cutDate)} – not live: the tool redoes these checks · none of these change a figure; they explain it`);
    // one 8-column grid for the summary and every list: A date/unit · B who · C doc/qty · D amount · E material · F line ID · G description · H WBS
    [12, 34, 12, 15, 12, 26, 46, 22].forEach((w, i) => { ck.getColumn(i + 1).width = w; });
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
    if (M.changes) {
      const ch = wb.addWorksheet('Changes', { properties: { tabColor: { argb: 'FF' + TAB.review } }, views: [{ showGridLines: false }] });
      title(ch, `Changes since the last report (${mLabel(M.changes.month)})`, 'Months the last report already showed, compared line by line. New lines in the report month are normal and not listed. As made – not live.');
      [30, 10, 14, 14, 14, 12, 24, 11, 40, 22].forEach((w, i) => { ch.getColumn(i + 1).width = w; });
      if (M.changes.carried) { ch.getCell('A2').value = 'Months the last report already showed, compared line by line (kept from the report this one was saved from – drop the SAP files to compare again).'; }
      let qq = 4; ch.mergeCells(qq, 1, qq, 2); [[1, 'Month'], [3, 'Last report'], [4, 'This report'], [5, 'Difference']].forEach(([c, h]) => headCell(ch.getCell(qq, c), h)); qq++;
      for (const m of M.changes.monthTable) {
        ch.mergeCells(qq, 1, qq, 2);
        [[1, m.label], [3, m.was], [4, m.is], [5, m.diff]].forEach(([c, v]) => { const x = ch.getCell(qq, c); x.value = v; x.border = box; x.font = c === 5 ? FONT_B : FONT; if (c > 1) x.numFmt = F.amt; if (c === 5 && Math.abs(v) > 0.5) x.fill = fill(C.warn); });
        qq++;
      }
      qq += 2; ['Change', 'Month', 'In last report', 'In this report', 'Difference', 'Material doc.', 'WBS element', 'Material', 'Description', 'Line ID'].forEach((h, i) => headCell(ch.getCell(qq, i + 1), h, i === 9 ? '7F7F7F' : C.navy)); const h0 = qq; qq++;
      for (const x of M.changes.rows) {
        [x.type, bucketLabel(x.bucket), x.was, x.is, x.diff, x.doc, x.wbs, x.mat, x.text, x.lid].forEach((v, i) => { const c = ch.getCell(qq, i + 1); c.value = v === '' ? null : v; c.font = i === 4 ? FONT_B : i === 9 ? FONT_KEY : FONT; if (i >= 2 && i <= 4) c.numFmt = F.amt; });
        qq++;
      }
      if (M.changes.rows.length) ch.autoFilter = { from: { row: h0, column: 1 }, to: { row: qq - 1, column: 10 } };
      else ch.getCell(qq, 1).value = 'No line in an already reported month has changed.';
      landscape(ch, null, foot);
    }

    // ================= 10. Data (one row per issue line with an amount; every report figure is SUMIFS on it)
    const da = wb.addWorksheet('Data', { properties: { tabColor: { argb: 'FF' + TAB.data } } });
    da.columns = D.map(([h, w, , fmt, kind]) => ({ header: h, width: w, style: Object.assign(fmt ? { numFmt: fmt } : {}, { font: kind === 'amt' ? FONT_B : kind === 'key' ? FONT_KEY : FONT }) }));
    const cQ = dc('Qty'), cAm = dc('Amount'), cId = dc('Coding ID'), cRow = dc('Coding row'), cMk = dc('Month key'), cDt = dc('Posting date'), cPk = dc('Period key');
    const iRu = ix('Rate'), iRow = ix('Coding row'), iPk = ix('Period key'), iPer = ix('Period'), iWhy = ix('Pending reason');
    // rows in the report's order (family › division › group › material), each material by period, date, document, item
    const cPos = new Map(crows.map((x, i) => [x.key, i])), pOrd = (b) => (b === 'Pending' ? 1 : 0);
    const nat = (a, b) => String(a || '').localeCompare(String(b || ''), 'en', { numeric: true });
    const dLines = M.lines.slice().sort((a, b) => cPos.get(a.ckey) - cPos.get(b.ckey) || pOrd(a.bucket) - pOrd(b.bucket) || nat(a.bucket, b.bucket) ||
      (a.date ? +a.date : 0) - (b.date ? +b.date : 0) || nat(a.doc, b.doc) || nat(a.year, b.year) || nat(a.item, b.item));
    dLines.forEach((l, k2) => {
      const n = k2 + 2; const vals = D.map(([, , f]) => (f ? f(l) : null));
      vals[iRu - 1] = { formula: `IF(ABS(${cQ}${n})<0.000001,"",${cAm}${n}/${cQ}${n})`, result: Math.abs(l.rq) > 1e-9 ? l.amt / l.rq : '' };
      // the period follows the cut date: no date or posted after it → Pending (999999); else its month
      vals[iPk - 1] = { formula: `IF(OR(${cMk}${n}="",${cDt}${n}>CutDate),${PEND},${cMk}${n})`, result: keyOf(l.bucket) };
      vals[iPer - 1] = { formula: `IF(${cPk}${n}=${PEND},"Pending",INT(${cPk}${n}/100)&"-"&TEXT(MOD(${cPk}${n},100),"00"))`, result: l.bucket };
      vals[iWhy - 1] = { formula: `IF(${cMk}${n}="","No date",IF(${cDt}${n}>CutDate,"After cut date",""))`, result: l.pend || '' };
      vals[iRow - 1] = { formula: match(`${cId}${n}`), result: rowNo.get(l.ckey) };
      for (const f of F4) vals[ix(E.FIELD_NAME[f]) - 1] = { formula: lookup(f, `$${cRow}${n}`), result: l[f] || '' };
      da.addRow(vals);
    });
    da.getRow(1).eachCell((c, i) => headCell(c, c.value, D[i - 1][4] === 'code' ? C.gold : D[i - 1][4] === 'key' ? '7F7F7F' : C.navy)); da.getRow(1).height = 30;
    const dNote = { Period: 'Live: where the line counts for the cut date on the Summary – its month (YYYY-MM), or Pending (no posting date, or posted after the cut date – never in To date).',
      Qty: '− SAP qty: SAP signs an issue negative (it leaves the stock) and a return positive; here an issue is a positive quantity.', Rate: 'Amount ÷ Qty – the price the material was issued at (its moving average price in SAP).',
      Amount: '− Amt.in Loc.Cur. from MB51: an issue is a positive cost, a return (222, Z22, 552) a negative one. ' + CUR + '.', 'Issue type': 'Project = 221/222 GI/RE for project (281/282 network) · To subcontractors = Z21/Z22 GI with deduction (recoverable) · Scrap = 551–556.',
      'SAP qty': 'Qty in unit of entry, as SAP signs it.', 'SAP amount': 'Amt.in Loc.Cur., as SAP signs it.', 'Subcontractor (SAP code)': 'For Z21/Z22: the subcontractor the material was issued to (to deduct from his certificate).',
      'Period key': 'The number behind Period (month yyyymm · Pending 999999). Every report figure is SUMIFS on it (named range D_PK), compared with RepKey = the month of the cut date.',
      'Doc count': '1 on one line of each material document, blank on its other lines – so SUMIFS on it (named range D_Doc) counts issue documents.',
      'Material count': '1 on the first line of each material in each posting month (named range D_MatN) – the Summary counts the materials issued with it.',
      'Line ID': 'SAP key of the line: material document | year | item. The tool uses it to compare this report with the next one.',
      'Coding ID': 'The row of this material on the Coding sheet (the codes on the left come from there).',
      Family: 'The family of the material group on the SAP tree (M Materials, P Plant & tools, SP Spare parts …) – named range D_Fam.', Division: 'The division of the material group (M03 Concrete …); a family without divisions in SAP shows the family – named range D_Div.' };
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
      ['', 'The one input is the cut date on the Summary (cell B4). Pick a month end from its list (▼) – or type another date, e.g. 25-Aug-2026 for a mid-month cut – and every sheet follows: the report month is the month of that date, This month = that month up to the cut date, Previous = everything before that month, To date = Previous + This month, Pending = posted after the cut date. No need to go back to the tool.'],
      ['', 'How: on the Data sheet each line’s Period key is a formula on the cut date (its month yyyymm, or Pending 999999). Every report figure is SUMIFS on the Data sheet with named ranges – e.g. To date of a material = SUMIFS(D_Amt, D_ID, its Coding ID, D_PK, "<="&RepKey). Issue documents are counted the same way on the Data column Doc count (D_Doc: 1 on one line of each document). Select a cell to read its formula.'],
      ['', 'Not live: the Checks and Changes sheets (as made – the tool redoes them), the PO Register (ME2N as exported – its codes and issue rate are live) and the list of rows (every material and PO in the data, whatever the cut date). New SAP data comes in through the Upload page of the app.'],
      ['h', 'Inputs – every month'],
      ['', 'MB51 (SAP material movements: every issue to the project, with its value) – the cost. ME2N (SAP purchase order lines: material group, unit, supplier, price, what is still to be delivered) – the reference. MB52 / MM60 / the material master – optional, the group of materials ME2N does not have. The coding lives in the app (Work packages page).'],
      ['', 'MB51: the project plant, from the project start, with at least the movements 221/222, Z21/Z22 and 551/552 – any other movement type may be in it: it is listed on the Checks sheet and left out. ME2N: every PO of the plant, from the project start.'],
      ['h', 'Coding (the Coding sheet)'],
      ['', 'The coding is PKG, MNL and Cost element, typed per material on the Coding sheet, here in Excel (the tool only builds and checks the report): what a material is – its description and its material number – decides its code. One row per material in the order family › division › group (largest first), so similar materials sit together; it is a plain list – sort and filter it freely. Type in the yellow cells or pick from the drop-down: it lists the codes on the Lists sheet plus every code already typed, so a code typed once is offered on every row. An empty code cell is orange.'],
      ['', 'The band on top of the Coding sheet is live: materials still to code, fully coded, PKG / MNL / Cost element missing, the share of the To date fully coded, and the To date and This month not fully coded yet. The Lists sheet shows the same by family › division › group – materials, coded, to code, To date and the To date not fully coded – so you start where the most is left.'],
      ['', 'Material Summary, Material per Month, the PO Register, the Data sheet and the Summary PKG / MNL / Cost element tables follow the coding live: code and they update at once. Whatever is not coded yet is shown on one "Not coded" line, so nothing is missing. The app keeps the coding, not this file: PKG is the work package coded on the Work packages page of the app, MNL the code of the MATERIAL cost type (MAT), Cost element is left blank for you to fill (your own catalogue codes, which the app does not store). Codes typed here are for your own use - they are not read back.'],
      ['', 'Reference data comes from SAP and is never typed: the material group from ME2N, else the material list (optional input: MB52 stock list, MM60 or the material master – any SAP list with Material, Material Type and Material Group), else an earlier report – a material with none sits under "(no material group)"; the group names are SAP\'s descriptions; the unit and description from MB51. The material type (Z0xx) comes from the material list: it is also the first two digits of the material number (13… = Z003 Concrete, 29… = Z019 Spare parts & liquids …).'],
      ['h', 'Grouping and sorting'],
      ['', 'Every sheet follows the SAP group tree: family (M Materials, P Plant & tools, SP Spare parts …) › division (M03 Concrete) › group (M030201 Steel Bars) › material. Families keep a fixed order (M, P, SP, SM …); divisions, groups and materials are each largest first by To date at the cut date the report was made with (moving the cut date in Excel updates the figures, not the order). Material Summary, Material per Month and the PO Register are flat lists in that order with Family, Division and Material group in their own columns, grouped by division: each division row carries its subtotals, and the − / + at the left (or the 1 / 2 buttons above it) folds it. A family without divisions in SAP (SP, SC, MTEX …) is one block, "no SAP division". The Summary (section 5) groups family › division › group the same way as the Lists sheet. The TOTAL row at the top follows the filter and never double counts the group rows.'],
      ['', 'Material per Month: the codes (live from the Coding sheet), then one block per month – Qty, Rate, Amount. When the data spans more than one year the earlier years can be rolled into one block, Previous years (chosen in the tool when the report is built), so the current year stays month by month. There are no year totals: a sheet copied elsewhere and added up never counts a month twice. The 1 / 2 buttons above the columns: 1 = amounts, 2 = qty, rate and amount.'],
      ['', 'Sorting: Excel cannot sort a list that holds subtotal rows (it offers to remove them). On the grouped report sheets use the filters – they work as usual. The Coding and Data sheets are plain lists: sort and filter them freely; the links to the report stay right whatever the order.'],
      ['', 'PO Register: what was bought, material by material – ME2N purchase lines (with a value), deleted lines left out, grouped by division › material › its PO lines (newest first). A material row: ordered, delivered and open qty, PO value, delivered and open value, still to invoice, its PO prices (lowest, last, weighted, spread) and what MB51 issued to date (live): issued qty, delivered − issued (received, not issued yet), issue rate against the weighted PO price, issued amount and Committed = issued + open value. A PO line: PO type, supplier, date, age (open lines, live), status and a Flag (Blocked · Open > 90 days · Price > 20% above the lowest · To invoice). Filter on Flag or Status to act.'],
      ['', 'Stores Transfers: stock transport orders from own stores and plants (no price, so not in the PO Register), the same way – ordered, delivered, open qty and the qty issued. PO type = the first two digits of the PO number (its SAP number range); name the types on the Lists sheet. The Summary (section 6) adds up the purchases per type: PO value, delivered, still to deliver, open more than 90 days, still to invoice, and Committed = To date + still to deliver.'],
      ['', 'Material Summary – rate analysis (right of Pending). This month vs previous: the previous rate (to last month) and this month’s rate, Change per unit, Change % and Value = this month’s qty × the change, i.e. this month’s amount − its qty at the previous rate. Since the start: First month (the first month with quantity), Start rate (that month’s rate), To date rate, Change, Change % and Value = to-date qty × the change. When two rates differ more than 3 times (or one is not positive) the row shows "check" and is left out of the totals: a unit mix-up or a placeholder value, not a price change. PO price: the weighted and the last unit price on the material’s purchase lines in ME2N, and how far the to-date issue rate is from the weighted one.'],
      ['h', 'Steps (the Data sheet is the result of steps 1–5; every other sheet is SUMIFS on it)'],
      ['1', 'In MB51 delete the rows with an empty Material – SAP’s total row.'],
      ['2', 'Keep the movements that put material cost on the project: 221 GI for project and 222 its return (281/282 for a network), Z21 GI to a subcontractor with deduction and Z22 its reversal (recoverable from the subcontractor), 551–556 scrapping. Every other movement – receipts (101 …), transfers (301 …, 351 …), issues to orders (261) or cost centres (201), subcontractor stock (541) … – is not project cost: the Checks sheet lists them.'],
      ['3', 'Delete lines whose "Amt.in Loc.Cur." is 0 – owner-supplied material (valuation type CUSTOMER) and scrap are issued at no value.'],
      ['4', 'Cost = − Amt.in Loc.Cur. and Qty = − Qty in unit of entry: SAP signs an issue negative (it leaves the stock) and a return positive; in this report an issue is a positive cost. Rate = Amount ÷ Qty – the price the material was issued at (its moving average price).'],
      ['5', 'Period (live): no posting date, or a posting date after the cut date (Summary B4) → Pending. Otherwise the month of the posting date.'],
      ['6', 'Coding: each line takes PKG, MNL and Cost element from its material’s row on the Coding sheet (Data columns "Coding ID" / "Coding row" show the link).'],
      ['7', 'Pivot or SUMIFS the Data sheet: rows = Material (or PKG, MNL, Cost element, Family, Division, Material group, WBS element), columns = Period, values = Sum of Qty and Sum of Amount. Previous = the months before the report month; This month = the report month; To date = Previous + This month; Pending is shown but never added to To date.'],
      ['h', 'The Data sheet'],
      ['', 'One row per issue line with an amount, sorted like the report (family › division › group › material), each material by period and posting date. Columns from left to right: what (family, division, material group, material, description, unit) · coding (from the Coding sheet) · when (period, posting date) · where (WBS element, issue type, material document) · Qty, Rate and Amount (bold) · how each figure was calculated (movement type, SAP qty and amount as SAP signs them, unit of entry, entry date, subcontractor, reservation, user, texts) · and at the far right, in grey, the keys the formulas and the tool use (Month key, Period key, Doc count, Material count, Line ID, Coding ID). Hover over a header with a red corner for its meaning.'],
      ['h', 'Sheets'],
      ['', 'Report (blue): Summary · Material Summary · Material per Month · PO Register · Stores Transfers. Coding (gold): Coding (one row per material, KPI band on top) · Lists (code names – codes you type join it – and the coding by family › division › group). Review (orange): Checks · Changes. Data (grey): Data (with the WBS element of every line) · Notes.'],
      ['h', 'Good to know'],
      ['', 'Issues to subcontractors (Z21) are project cost here and should come back as a deduction on the subcontractor’s certificate – the Checks sheet lists them by subcontractor, and the Data sheet keeps the subcontractor’s SAP code on each line.'],
      ['', 'The cost of a month can still change after it was reported: an issue can be posted later with a date in that month. The Changes sheet lists such lines.'],
    ];
    let n = 3;
    for (const [t, s] of notes) {
      const c = no.getCell(n, 2);
      if (t === 'h') { n++; c.value = s; c.font = font({ size: 11, bold: true, color: { argb: 'FF' + C.navy } }); }
      else { c.value = t ? `${t}.  ${s}` : s; c.alignment = { wrapText: true, vertical: 'top' }; c.font = FONT; no.getRow(n).height = Math.max(15, Math.ceil(c.value.length / 140) * 13.5 + 3); }
      n++;
    }

    // ================= hidden: _Meta, _Cal (_Mvt and _Ref - the report-alone round trip - are not written)
    const me = wb.addWorksheet('_Meta', { state: 'hidden' });
    // 'Report month' (row 4, name RepKey) and 'Cut date' follow the Summary input, so the tool reads back what the user last set
    [['Tool', E.TOOL], ['Version', M.version], ['Plant', M.plant], ['Report month', { formula: 'YEAR(CutDate)*100+MONTH(CutDate)', result: M.reportMonth }], ['Cut date', { formula: 'CutDate', result: M.cutDate }],
      ['Generated', M.generated], ['Saved', new Date().toISOString()],
      ['MB51', M.files.mb || ''], ['ME2N', M.files.me || ''],
      ['SAP grand total', M.T.footer == null ? '' : M.T.footer], ['MB51 rows', M.counts.rawRows], ['MB51 total', M.T.rawSum], ['Summary rows', M.counts.summaryRows || 0],
      ['Duplicate rows', M.counts.dupRows || 0], ['Duplicate amount', M.T.dupAmt || 0], ['Zero lines', M.counts.zeroLines], ['Owner-supplied zero lines', M.counts.zeroOwner],
      ['ME2N lines', M.counts.meLines || 0], ['ME2N plant', M.mePlant || '']].forEach((x) => me.addRow(x));
    me.getCell('B5').numFmt = F.date;
    const calWs = wb.addWorksheet('_Cal', { state: 'hidden' });         // the cut dates of the drop-down on the Summary (B4)
    calWs.getCell('A1').value = 'Cut date (month end)'; calWs.getColumn(1).width = 16;
    cutList.forEach((d, i) => { const c = calWs.getCell(i + 2, 1); c.value = d; c.numFmt = F.date; });

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
