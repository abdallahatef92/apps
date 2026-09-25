// @ts-nocheck — a close port of the standalone Subcontract Cost Report's
// untyped workbook engine (engine.js buildWorkbook / injectCharts). Kept
// verbatim so its live formulas, styling and chart XML stay exactly what the
// report's users already rely on; the typed side is subcontractReport.ts,
// which builds this module's input from the database views.
/* eslint-disable */

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
  const trade = (s) => s.slice(0, 1) === 'S' ? s.slice(1, 3) : s.slice(0, 1);
  const codingKey = (svc, text) => svc + '\u0001' + text;

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
  const FILL = { HF: fill('0F2A52'), H2: fill('1F3E6B'), OPF: fill('9C7A38'), PF: fill('8E3B37'), TF: fill('FBF4E3'), YF: fill('FFFF00'),
    KF: fill('1F3E6B'), AF: fill('FBEEEE'), PCF: fill('EAF1FC'), NEWF: fill('E2EFDA'), BAND: fill('0F2A52'), GOLD: fill('C8A45C') };
  const NUM = '#,##0;[Red](#,##0);"–"', QTY = '#,##0.00;[Red](#,##0.00);"–"', PCT = '0.0%;[Red](0.0%);"–"';
  const BRAND = '1F3E6B';   // single-series charts
  const GOLDLINE = { style: 'thin', color: { argb: 'FFC8A45C' } };
  // tab groups: log / file history & transactions / reports
  const TAB_GROUPS = [['0F2A52', ['Dashboard', 'Service Monthly', 'Service Coding']], ['C8A45C', ['Changes', 'Detail']],
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
  async function injectCharts(buf, charts, sheetNames, JSZip) {
    if (!charts.length) return buf;
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
        anchors += `<xdr:oneCellAnchor><xdr:from><xdr:col>${c.col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${c.row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="${Math.round(c.w * EMU)}" cy="${Math.round(c.h * EMU)}"/><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${n + 1}" name="Chart ${n}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId${drawRels.length}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:oneCellAnchor>`;
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
      const at = ['<legacyDrawing', '<legacyDrawingHF', '<picture', '<oleObjects', '<controls', '<webPublishItems', '<tableParts', '<extLst'].map((t) => x.indexOf(t)).filter((i) => i >= 0);
      const pos = at.length ? Math.min(...at) : x.lastIndexOf('</worksheet>');
      x = x.slice(0, pos) + tag + x.slice(pos);
      z.file(shPath, x);
    }
    z.file('[Content_Types].xml', ct);
    return z.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  }

  export async function buildWorkbook(A, libs, progress) {
    const { ExcelJS, JSZip } = libs; const say = progress || (() => {});
    const det = A.det, MAINPC = A.MAINPC, months = A.months, omonths = A.omonths;
    const wb = new ExcelJS.Workbook(); wb.creator = 'Subcontract report'; wb.calcProperties.fullCalcOnLoad = true;
    const ORDER = ['Dashboard', 'Service Monthly', 'Service Coding', 'Changes', 'Detail', 'PO Register', 'By Supplier', 'Subcontractor x Trade',
      'Subcontractors over time', 'Qty Reconciliation', 'Coding', 'Notes'];
    const S = {}; for (const n of ORDER) S[n] = makeSheetApi(wb.addWorksheet(n, n === 'Dashboard' || n === 'Subcontractor x Trade' || n === 'Subcontractors over time' || n === 'Changes' ? { views: [{ showGridLines: false }] } : {}));
    const charts = [];
    for (const [color, names] of TAB_GROUPS) for (const n of names) S[n].ws.properties.tabColor = { argb: 'FF' + color };

    // ---------------- Coding
    await say('Coding'); const cd = S['Coding'];
    const tabs = [[1, 'Resource code', 'Resource name', A.resources], [4, 'Trade code', 'Trade name', A.trades], [7, 'Tax code', 'VAT rate', Object.entries(A.vatr)],
      [10, 'Contract type code', 'Contract type name', [['A1', 'غير شامل – price excludes VAT'], ['A2', 'شامل – price includes VAT']]]];
    for (const [c, h1, h2, data] of tabs) {
      cd.hdr(1, c, h1); cd.hdr(1, c + 1, h2);
      data.forEach(([k, v], i) => { cd.set(i + 2, c, k, { font: st.BLUE, fmt: '@' }); cd.set(i + 2, c + 1, v, { font: st.BLUE, fill: FILL.YF, fmt: h2 === 'VAT rate' ? '0%' : undefined }); });
      cd.width(c, 12); cd.width(c + 1, h2 === 'VAT rate' ? 10 : 32);
    }
    cd.ws.getCell('H1').note = 'Inferred from the exports: VAT Current ÷ SC Work Current Cost is 0% for P0, 10% for P2, 14% for P3.';
    cd.ws.getCell('K1').note = 'A2 (شامل): SAP pays Qty × Gross price ÷ (1 + VAT). A1 (غير شامل): SAP pays Qty × Gross price.';
    cd.hdr(1, 13, 'Setting'); cd.hdr(1, 14, 'Value');
    cd.set(2, 13, 'Show PENDING (not approved) lines in their month? (Y/N)', { font: st.F });
    cd.set(2, 14, A.opts.pendingInMonth ? 'Y' : 'N', { font: st.BLUE, fill: FILL.YF, align: { horizontal: 'center' } });
    cd.ws.getCell('N2').dataValidation = { type: 'list', allowBlank: false, formulae: ['"Y,N"'] };
    cd.set(3, 13, 'N = pending lines go to the separate "Pending approval" block. Y = they sit in their certificate month like approved lines.', { font: st.IT });
    cd.width(13, 52); cd.width(14, 8);
    cd.set(22, 1, 'Yellow cells are editable. New codes can be added below a table (up to row 50).', { font: st.IT });

    // ---------------- Service Coding
    await say('Service Coding'); const sc = S['Service Coding'];
    ['Svc ID', 'Service', 'Service text', 'Unit', 'Unit source', 'CSI', 'MNL', 'Cost Element Code', 'Lines', 'Total amount'].forEach((v, j) => {
      const y = ['Unit', 'CSI', 'MNL', 'Cost Element Code'].includes(v); sc.hdr(1, j + 1, v, y ? FILL.YF : FILL.HF, y ? st.HB : st.H); });
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
    sc.ws.getCell('D1').note = 'From ZSCSRV1 (PO Service UOM), else the service code suffix, else a unit named in the service text. Editable.';
    sc.ws.getCell('F1').note = 'CSI = the work package this service is coded to in the app (Work packages › Subcontractors). MNL and Cost Element Code are not kept in the app – fill them here if you use them.';

    // ---------------- Detail
    await say('Detail'); const dt = S['Detail'];
    const cols = ['Row key', 'Svc ID', 'Cert. date', 'Month', 'Report bucket', 'Approved (Character 1)', 'Initial invoice (Flag)', 'Cert. serial', 'PO', 'Supplier code', 'Supplier name',
      'Invoice doc.', 'Entry sheet', 'Doc type', 'PO item', 'Service', 'Service text', 'Line type', 'Unit', 'Contract type', 'Tax code', 'VAT rate', 'Gross price', 'Net rate',
      'Total qty', 'Previous qty', 'Current qty', 'Paid % (Progress %)', 'Cost (excl VAT)', 'VAT current', 'Resource', 'Trade', 'Resource name', 'Trade name',
      'G/L acct', 'WBS element (ref. only)', 'WBS description (ref. only)', 'PO line ref', 'PO line match', 'Material group', 'Material group description', 'Profit centre',
      'Other profit centre', 'Report qty', 'Qty basis', 'Approval note', 'Line ID', 'WBS rows (split)', 'First seen (load)'];
    const C = {}; cols.forEach((n, j) => { C[n] = L(j + 1); dt.hdr(1, j + 1, n); });
    dt.ws.getCell(C['Report qty'] + '1').note = 'Quantity used in the report. Equals SAP Current qty unless the line was not paid at qty × net rate (paid % below 100, a catch-up, a re-price): then amount ÷ net rate, so the rate stays the contract rate. SAP qty stays in Current qty and feeds Qty Reconciliation.';
    dt.ws.getCell(C['Other profit centre'] + '1').note = `X = charged to a profit centre other than the project's main one (${MAINPC}).`;
    dt.ws.getCell('E1').note = 'PENDING = not approved (Character 1 blank), unless Coding!N2 = Y – includes initial invoices not yet approved ("Opening – not approved" in Approval note). OPENING = approved initial invoice (Flag X). Otherwise the certificate month.';
    dt.ws.getCell('R1').note = 'Adjustment = amount with zero quantity, or a ≤ 0.01 placeholder quantity that does not explain the amount: payment-% changes, re-pricing, reversals. Qty only (excluded) = quantity with zero amount – no row key, never in Service Monthly or the Dashboard.';
    const sorted = det.slice().sort((a, b) => cmpTuple([a.dateKey, a.po, a.serial, a.svc], [b.dateKey, b.po, b.serial, b.svc]));
    const dtRows = [];
    sorted.forEach((r, n) => {
      const i = n + 2;
      const eq = `AND(X${i}<>0,ABS(AC${i}-AA${i}*X${i})>1)`;
      dtRows.push([r.isqo ? null : r.rk, r.sid, r.dateObj, { formula: `YEAR(C${i})*100+MONTH(C${i})` },
        { formula: `IF(AND(F${i}<>"X",Coding!$N$2<>"Y"),"PENDING",IF(G${i}="X","OPENING",D${i}))` }, r.appr || null, r.flag || null,
        r.serial, r.po, r.supCode, r.supName, str(r.docno).trim() || null, str(r.es).trim() || null, str(r.doctype).trim(), r.item, r.svc, r.text, r.lt,
        { formula: lk('Service Coding', 'A', 'D', `B${i}`, '""', NSC) }, r.ctype, r.tax, { formula: lk('Coding', 'G', 'H', `U${i}`, '0') }, r.price, { formula: `IF(T${i}="A2",W${i}/(1+V${i}),W${i})` },
        r.totq, r.prevq, r.qty, r.paid / 100, r.amt, r.vat, r.res, r.trade,
        { formula: lk('Coding', 'A', 'B', `AE${i}`) }, { formula: lk('Coding', 'D', 'E', `AF${i}`) }, str(r.gl).trim(), str(r.wbs).trim(), str(r.wbsDesc).trim(),
        r.poref, r.matchLvl, r.mg || null, r.mgd || null, r.pc, r.othpc ? 'X' : null,
        { formula: `IF(R${i}="Normal",IF(${eq},AC${i}/X${i},AA${i}),0)` }, { formula: `IF(R${i}<>"Normal","",IF(${eq},"Equivalent (amount ÷ net rate)","SAP qty"))` },
        (r.initial && !r.approved) ? 'Opening – not approved' : null, r.lid, r.split || null, r.first]);
    });
    dt.ws.addRows(dtRows);
    const textCols = [8, 9, 10, 12, 13, 15, 16, 20, 21, 31, 32, 35, 42];
    const colFmt = { 3: 'yyyy-mm-dd', 4: '0', 22: '0%', 28: '0%', 23: QTY, 24: QTY, 25: QTY, 26: QTY, 27: QTY, 29: QTY, 30: QTY, 44: QTY };
    cols.forEach((_, j) => { const col = dt.ws.getColumn(j + 1); col.font = st.F; if (colFmt[j + 1]) col.numFmt = colFmt[j + 1]; if (textCols.includes(j + 1)) col.numFmt = '@'; });
    dt.ws.getRow(1).eachCell((c) => { c.font = st.H; });
    sorted.forEach((r, n) => { if (r.othpc) { dt.ws.getCell(n + 2, 42).fill = FILL.PCF; dt.ws.getCell(n + 2, 43).fill = FILL.PCF; } });
    [6, 6, 11, 8, 10, 9, 9, 7, 12, 11, 28, 12, 12, 8, 6, 10, 38, 10, 6, 8, 6, 6, 10, 10, 10, 10, 10, 8, 13, 11, 6, 6, 16, 22, 10, 20, 26, 22, 16, 10, 22, 10, 8, 11, 26, 20, 30, 9, 9].forEach((w, j) => dt.width(j + 1, w));
    const NR = det.length + 1;
    dt.ws.views = [{ state: 'frozen', xSplit: 2, ySplit: 1 }]; dt.ws.autoFilter = `A1:${L(cols.length)}${NR}`;
    const R = (n) => `Detail!$${C[n]}$2:$${C[n]}$${NR}`;

    // ---------------- Service Monthly
    await say('Service Monthly'); const sm = S['Service Monthly'];
    const fixed = ['Key', 'Svc ID', 'Service', 'Service text', 'Line type', 'Supplier code', 'Supplier name', 'Unit', 'Contract type', 'Tax code', 'Gross price', 'Net rate',
      'CSI', 'MNL', 'Cost Element Code', 'Resource', 'Trade', 'Material group', 'Material group description', 'PO', 'Profit centre'];
    fixed.forEach((v, j) => { sm.hdr(1, j + 1, v); sm.ws.mergeCells(1, j + 1, 2, j + 1); });
    sm.ws.getCell('H1').note = 'Unit, CSI, MNL and Cost Element Code are read from the Service Coding sheet.';
    sm.ws.getCell('L1').note = 'Rate SAP actually pays: Gross price ÷ (1 + VAT) on A2 (شامل) contracts, Gross price on A1.';
    const FX = fixed.length;
    const blocks = [['OPENING', 'Opening (pre go-live)', FILL.OPF]].concat(months.map((m, i) => [m, m, i % 2 ? FILL.H2 : FILL.HF])).concat([['PENDING', 'Pending approval', FILL.PF]]);
    const bstart = new Map();
    blocks.forEach(([crit, lab, f], bi) => {
      const c0 = FX + 1 + 3 * bi; bstart.set(crit, c0);
      const x = sm.hdr(1, c0, lab, f); sm.ws.mergeCells(1, c0, 1, c0 + 2); if (typeof crit === 'number') x.numFmt = '0';
      ['Qty', 'Rate', 'Amount'].forEach((t, o) => sm.hdr(2, c0 + o, t, f));
    });
    const tc = FX + 1 + 3 * blocks.length;
    ['Total qty', 'Avg rate', 'Total amount', 'Rate check'].forEach((t, o) => { sm.hdr(1, tc + o, t); sm.ws.mergeCells(1, tc + o, 2, tc + o); });
    sm.ws.getCell(1, tc + 3).note = 'Total amount − Total qty × Net rate. Normal rows should be 0. On Adjustment rows it equals the adjustment itself.';
    const posn = new Map(), mgrp = new Map(), supName = new Map();
    for (const r of det) { supName.set(r.supCode, r.supName); if (r.isqo) continue;
      if (!posn.has(r.rk)) { posn.set(r.rk, new Set()); mgrp.set(r.rk, new Map()); }
      posn.get(r.rk).add(r.po); if (r.mg || r.mgd) mgrp.get(r.rk).set(r.mg + '\u0001' + r.mgd, [r.mg, r.mgd]); }
    const r0 = 3; const smRows = [];
    A.keyTuples.forEach((t, idx) => {
      const k = idx + 1, i = r0 + k - 1; const [svc, text, adj, sup, price, ctype, tax, pc] = t;
      const sid = A.svcId.get(codingKey(svc, text)); const mg = [...(mgrp.get(k) || new Map()).values()];
      const row = [k, sid, svc, text, adj ? 'Adjustment' : 'Normal', sup, supName.get(sup),
        { formula: lk('Service Coding', 'A', 'D', `B${i}`, '""', NSC) }, ctype, tax, price,
        { formula: `IF(I${i}="A2",K${i}/(1+${lk('Coding', 'G', 'H', `J${i}`, '0')}),K${i})` },
        { formula: lk('Service Coding', 'A', 'F', `B${i}`, '""', NSC) }, { formula: lk('Service Coding', 'A', 'G', `B${i}`, '""', NSC) }, { formula: lk('Service Coding', 'A', 'H', `B${i}`, '""', NSC) },
        { formula: lk('Coding', 'A', 'B', `"${svc.slice(0, 1)}"`) }, { formula: lk('Coding', 'D', 'E', `"${trade(svc)}"`) },
        mg.map((x) => x[0]).sort().join(' / ') || null, mg.map((x) => x[1]).sort().join(' / ') || null, [...(posn.get(k) || [])].sort().join(', '), pc];
      for (const [crit, c0] of bstart) {
        const cr = typeof crit === 'string' ? `"${crit}"` : `${L(c0)}$1`;
        row[c0 - 1] = { formula: `SUMIFS(${R('Report qty')},${R('Row key')},$A${i},${R('Report bucket')},${cr})` };
        row[c0] = { formula: `IF(${L(c0)}${i}=0,"",${L(c0 + 2)}${i}/${L(c0)}${i})` };
        row[c0 + 1] = { formula: `SUMIFS(${R('Cost (excl VAT)')},${R('Row key')},$A${i},${R('Report bucket')},${cr})` };
      }
      const qc = [...bstart.values()];
      row[tc - 1] = { formula: qc.map((c0) => `${L(c0)}${i}`).join('+') };
      row[tc] = { formula: `IF(${L(tc)}${i}=0,"",${L(tc + 2)}${i}/${L(tc)}${i})` };
      row[tc + 1] = { formula: qc.map((c0) => `${L(c0 + 2)}${i}`).join('+') };
      row[tc + 2] = { formula: `ROUND(${L(tc + 2)}${i}-${L(tc)}${i}*L${i},0)` };
      smRows.push({ row, adj, pc });
    });
    smRows.forEach(({ row }) => { sm.ws.addRow(row); });
    for (let j = 1; j <= tc + 3; j++) sm.ws.getColumn(j).font = st.F;
    sm.ws.getRow(1).eachCell((c) => { c.font = st.H; }); sm.ws.getRow(2).eachCell((c) => { c.font = st.H; });
    for (const c0 of bstart.values()) { sm.ws.getColumn(c0).numFmt = QTY; sm.ws.getColumn(c0 + 1).numFmt = QTY; sm.ws.getColumn(c0 + 2).numFmt = NUM;
      sm.ws.getColumn(c0).border = { left: { style: 'thin', color: { argb: 'FF8EA9DB' } } }; }
    sm.ws.getColumn(tc).numFmt = QTY; sm.ws.getColumn(tc + 1).numFmt = QTY; sm.ws.getColumn(tc + 2).numFmt = NUM; sm.ws.getColumn(tc + 3).numFmt = NUM;
    for (const j of [tc, tc + 1, tc + 2, tc + 3]) sm.ws.getColumn(j).font = st.B;
    sm.ws.getColumn(11).numFmt = QTY; sm.ws.getColumn(12).numFmt = QTY; for (const j of [3, 6, 18, 20]) sm.ws.getColumn(j).numFmt = '@';
    smRows.forEach(({ adj, pc }, n) => { if (adj || pc !== MAINPC) for (let j = 1; j <= FX; j++) sm.ws.getCell(r0 + n, j).fill = pc !== MAINPC ? FILL.PCF : FILL.AF; });
    // header rows keep their own formats
    for (let j = 1; j <= tc + 3; j++) { sm.ws.getCell(1, j).numFmt = typeof blocks[Math.floor((j - FX - 1) / 3)]?.[0] === 'number' && j > FX && j < tc && (j - FX - 1) % 3 === 0 ? '0' : 'General'; sm.ws.getCell(2, j).numFmt = 'General'; }
    const last = r0 + A.keyTuples.length - 1, ST = last + 1;
    sm.set(ST, 4, 'Total amount', { font: st.B });
    for (const c of [...[...bstart.values()].map((c0) => c0 + 2), tc + 2, tc + 3]) sm.set(ST, c, `=SUM(${L(c)}${r0}:${L(c)}${last})`, { font: st.B, fmt: NUM });
    for (let j = 1; j <= tc + 3; j++) sm.ws.getCell(ST, j).fill = FILL.TF;
    sm.set(ST + 2, 4, 'Qty is not totalled – rows have different units. Rate = Amount ÷ Qty (blank when no quantity). Orange rows = amount-only adjustments. Purple rows = other profit centre. Qty = Report qty (equivalent qty where a line was not paid at qty × net rate).', { font: st.IT });
    [5, 5, 10, 40, 10, 11, 26, 6, 7, 6, 10, 10, 10, 10, 12, 16, 20, 10, 20, 12, 10].forEach((w, j) => sm.width(j + 1, w));
    for (let j = FX + 1; j <= tc + 3; j++) sm.width(j, 11); sm.width(tc + 2, 14);
    sm.ws.views = [{ state: 'frozen', xSplit: 4, ySplit: 2 }]; sm.ws.autoFilter = `A2:${L(tc + 3)}${last}`;
    const AMT_TOT = L(tc + 2);
    for (let i = 2; i <= NSC; i++) sc.set(i, 10, `=SUMIFS(${R('Cost (excl VAT)')},${R('Svc ID')},A${i})`, { fmt: NUM, font: st.F });

    // ---------------- By Supplier
    await say('By Supplier'); const bs = S['By Supplier'];
    const supTot = sumBy(det, (r) => r.supCode, (r) => r.amt); const sk = mostCommon(supTot).map((x) => x[0]);
    const bcols = ['OPENING', ...months, 'PENDING'];
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

    // ---------------- Dashboard
    await say('Dashboard'); const db = S['Dashboard'];
    const minD = det.reduce((m, r) => (r.dateKey < m.dateKey ? r : m), det[0]).dateObj, maxD = A.dataDate;
    const fmtD = (d) => MON[d.getUTCMonth()] + '-' + String(d.getUTCFullYear()).slice(2);
    const BW = Math.max(months.length + 8, 19);            // band spans the trade table
    for (let rr = 1; rr <= 8; rr++) for (let c = 1; c <= BW; c++) db.ws.getCell(rr, c).fill = FILL.BAND;
    [6, 16, 26, 16, 14, 30, 14, 8].forEach((h, i) => { db.ws.getRow(i + 1).height = h; });
    db.set(2, 2, `${A.PLANT} PROJECT`, { font: st.EYE });
    db.set(3, 2, 'Subcontractor Cost Report', { font: st.TITLE });
    db.set(4, 2, `SAP ZSCPROG01 + ZSCSRV1 · certificates ${fmtD(minD)} to ${fmtD(maxD)} · ${A.currency} excl. VAT · load ${A.loadNo}`, { font: st.SUB });
    const AP = R('Approved (Character 1)'), FL = R('Initial invoice (Flag)');
    const kp = [['Total certified', `=SUM(Detail!$${C['Cost (excl VAT)']}:$${C['Cost (excl VAT)']})`], ['Approved since go-live', `=SUMIFS(${AM},${AP},"X",${FL},"<>X")`],
      ['Opening (pre go-live)', `=SUMIFS(${AM},${FL},"X",${AP},"X")`], ['Not approved', `=SUMIFS(${AM},${AP},"<>X")`],
      [`${mlabel(months[months.length - 1])} in report`, `=SUMIFS(${AM},${R('Report bucket')},${months[months.length - 1]})`],
      ['VAT certified', `=SUM(Detail!$${C['VAT current']}:$${C['VAT current']})`], ['No. of subcontractors', SUBTOT],
      ['Adjustments (amount-only)', `=SUMIFS(${AM},${R('Line type')},"Adjustment")`], [`Other profit centres (not ${MAINPC})`, `=SUMIFS(${AM},${R('Other profit centre')},"X")`]];
    kp.forEach(([lab, f], n) => { const c = 2 + 2 * n;
      db.set(5, c, lab.toUpperCase(), { font: st.KLAB, fill: FILL.KF });
      db.set(6, c, f, { font: st.BIG, fill: FILL.KF, fmt: lab.startsWith('No.') ? '0' : (lab.startsWith('Other') ? '#,##0,"K";(#,##0,"K");"–"' : '#,##0.0,,"M";(#,##0.0,,"M");"–"') });
      db.set(7, c, [1, 2, 3].includes(n) ? `=IFERROR(${L(c)}6/$B$6,0)` : null, { font: st.KSUB, fill: FILL.KF, fmt: '0.0% "of total"' });
      for (const rr of [5, 6, 7]) { db.ws.getCell(rr, c + 1).fill = FILL.KF;
        db.ws.getCell(rr, c).border = { left: GOLDLINE, top: rr === 5 ? GOLDLINE : undefined, bottom: rr === 7 ? GOLDLINE : undefined };
        db.ws.getCell(rr, c + 1).border = { right: GOLDLINE, top: rr === 5 ? GOLDLINE : undefined, bottom: rr === 7 ? GOLDLINE : undefined }; } });
    db.set(9, 2, 'Approved = Character 1 X without the initial-invoice Flag · Opening = Flag X and approved · Not approved = Character 1 blank (incl. initial invoices not yet approved). Pending placement is set on Coding!N2.', { font: st.IT });
    const TR0 = 11; db.set(TR0, 2, 'Amount by trade', { font: st.B });
    ['Trade', 'Opening', ...months.map(mlabel), 'Pending', 'Total', 'Share', 'Subcontractors'].forEach((h, j) => db.hdr(TR0 + 1, 2 + j, h));
    const crit = ['"OPENING"', ...months.map(String), '"PENDING"']; const ct = 3 + crit.length;
    tcodes.forEach((tcode, n) => { const rr = TR0 + 2 + n;
      db.set(rr, 2, '=' + lk('Coding', 'D', 'E', `"${tcode}"`), { font: st.F });
      crit.forEach((cr, j) => db.set(rr, 3 + j, `=SUMIFS(${AM},${R('Trade')},"${tcode}",${R('Report bucket')},${cr})`, { font: st.F, fmt: NUM }));
      db.set(rr, ct, `=SUM(C${rr}:${L(ct - 1)}${rr})`, { font: st.B, fmt: NUM });
      db.set(rr, ct + 1, `=IFERROR(${L(ct)}${rr}/${L(ct)}$${TR0 + 2 + NT},0)`, { font: st.F, fmt: PCT });
      db.set(rr, ct + 2, TCNT.get(tcode), { font: st.F, align: { horizontal: 'center' } }); });
    const TT = TR0 + 2 + NT; db.set(TT, 2, 'Total', { font: st.B });
    for (let j = 3; j <= 4 + crit.length; j++) db.set(TT, j, `=SUM(${L(j)}${TR0 + 2}:${L(j)}${TT - 1})`, { font: st.B, fmt: j < 4 + crit.length ? NUM : PCT });
    db.set(TT, 5 + crit.length, SUBTOT, { font: st.B, align: { horizontal: 'center' } });
    for (let j = 2; j <= 5 + crit.length; j++) db.ws.getCell(TT, j).fill = FILL.TF;
    db.set(TT + 1, 2, 'Subcontractors per trade overlap – one subcontractor can work in several trades; the Total row counts each once.', { font: st.IT });
    const CD0 = TT + 3; db.set(CD0, 2, 'Chart data – amount per month in report, top 7 trades + other', { font: st.SMALL });
    db.set(CD0 + 1, 2, 'Trade', { font: st.B }); months.forEach((m, j) => db.set(CD0 + 1, 3 + j, mlabel(m), { font: st.B }));
    const top = tcodes.slice(0, 7);
    top.forEach((_, n) => { const rr = CD0 + 2 + n, src = TR0 + 2 + n; db.set(rr, 2, `=B${src}`, { font: st.F });
      months.forEach((_, j) => db.set(rr, 3 + j, `=${L(4 + j)}${src}`, { font: st.F, fmt: NUM })); });
    const oth = CD0 + 2 + top.length; db.set(oth, 2, 'Other trades', { font: st.F });
    months.forEach((_, j) => db.set(oth, 3 + j, `=${L(4 + j)}${TT}-SUM(${L(3 + j)}${CD0 + 2}:${L(3 + j)}${oth - 1})`, { font: st.F, fmt: NUM }));
    const lastDM = L(2 + months.length);
    charts.push({ sheet: 'Dashboard', col: 1, row: oth + 2, w: 24, h: 9, kind: 'col', stacked: true, title: 'Amount per month by trade (excl. opening & pending block)', valTitle: A.currency, valFmt: '#,##0,,"M"', legend: 'r', gap: 60,
      series: [...top.map((_, n) => CD0 + 2 + n), oth].map((rr, n) => ({ name: `'Dashboard'!$B$${rr}`, cat: `'Dashboard'!$C$${CD0 + 1}:$${lastDM}$${CD0 + 1}`, val: `'Dashboard'!$C$${rr}:$${lastDM}$${rr}`, color: n < top.length ? PAL[n] : PAL[7], gap: true })) });
    const TS0 = oth + 23; db.set(TS0, 2, 'Top 15 services by total amount (all suppliers)', { font: st.B });
    ['Service', 'Service text', 'Unit', 'Trade', 'Qty (normal lines)', 'Avg rate', 'Total amount', 'Share'].forEach((h, j) => db.hdr(TS0 + 1, 2 + j, h));
    const top15 = mostCommon(sumBy(det, (r) => r.sid, (r) => r.amt)).slice(0, 15).map((x) => x[0]); const SID = R('Svc ID'), NORM = R('Line type');
    top15.forEach((sid, n) => { const rr = TS0 + 2 + n, s = sid + 1; const svc = A.services[sid - 1].svc;
      [`='Service Coding'!B${s}`, `='Service Coding'!C${s}`, `='Service Coding'!D${s}`, '=' + lk('Coding', 'D', 'E', `"${trade(svc)}"`),
        `=SUMIFS(${R('Report qty')},${SID},${sid},${NORM},"Normal")`, `=IFERROR(SUMIFS(${AM},${SID},${sid},${NORM},"Normal")/F${rr},"")`, `=SUMIFS(${AM},${SID},${sid})`, `=IFERROR(H${rr}/$B$6,0)`]
        .forEach((v, j) => db.set(rr, 2 + j, v, { font: st.F, fmt: j === 4 || j === 5 ? QTY : (j === 6 ? NUM : (j === 7 ? PCT : undefined)) })); });
    const TSL = TS0 + 1 + top15.length;
    charts.push({ sheet: 'Dashboard', col: 1, row: TSL + 2, w: 24, h: 13, kind: 'bar', reverse: true, title: 'Top 15 services – total amount', labels: true, labelFmt: '#,##0.0,,"M"', valFmt: '#,##0,,"M"', gap: 50,
      series: [{ cat: `'Dashboard'!$C$${TS0 + 2}:$C$${TSL}`, val: `'Dashboard'!$H$${TS0 + 2}:$H$${TSL}`, color: BRAND }] });
    const FC = TSL + 30;
    for (let c = 1; c <= BW; c++) db.ws.getCell(FC, c).fill = FILL.BAND; db.ws.getRow(FC).height = 22;
    db.set(FC, 2, 'FINAL CONTROL', { font: st.EYE, align: { vertical: 'middle' } });
    db.set(FC, 3, `="Certified "&TEXT(B6,"#,##0")&"  =  Approved "&TEXT(D6,"#,##0")&"  +  Opening "&TEXT(F6,"#,##0")&"  +  Not approved "&TEXT(H6,"#,##0")&"     |     Report vs SAP (after WBS splits): "&TEXT(Notes!B${NOTES_RECON_ROW + 6},"#,##0")`,
      { font: st.CTRL, align: { vertical: 'middle' } });
    db.width(1, 2); db.width(2, 26); db.width(3, 36); for (let j = 4; j <= 22; j++) db.width(j, 12);

    // ---------------- Changes (history)
    await say('Changes'); const chs = S['Changes'];
    const loads = A.loads;   // SC_LOAD_HISTORY rows, oldest first
    chs.set(1, 2, 'Changes and load history', { font: st.T1 });
    chs.set(2, 2, loads.length > 1 ? `Load ${loads.length} compared with load ${loads.length - 1}. Lines are matched by their SAP line identity.`
      : 'First load – there is no previous certificate upload to compare with yet.', { font: st.SMALL });
    chs.set(4, 2, '1. Load history', { font: st.B });
    const lh = ['Load', 'Posted on', 'Data date', 'ZSCPROG01 file', 'Lines', 'Certified cost', 'Approved', 'Opening', 'Not approved', 'Subcontractors', 'POs'];
    lh.forEach((h, j) => chs.hdr(5, 2 + j, h));
    loads.forEach((l, n) => { const rr = 6 + n;
      [n + 1, l.posted_at ? new Date(String(l.posted_at).replace(' ', 'T') + 'Z') : null, l.data_date ? new Date(l.data_date + 'T00:00:00Z') : null, l.file_name,
        l.lines, l.total_amount, l.approved_amount, l.opening_amount, l.pending_amount, l.subcontractors, l.purchase_orders]
        .forEach((v, j) => chs.set(rr, 2 + j, v, { font: n === loads.length - 1 ? st.B : st.F, fmt: j === 1 || j === 2 ? 'yyyy-mm-dd' : (j >= 5 && j <= 8 ? NUM : undefined) })); });
    const LH1 = 6 + loads.length;
    if (loads.length > 1) charts.push({ sheet: 'Changes', col: 14, row: 3, w: 16, h: 7.5, kind: 'col', title: 'Certified cost by load', labels: true, labelFmt: '#,##0.0,,"M"', valFmt: '#,##0,,"M"',
      series: [{ cat: `'Changes'!$B$6:$B$${LH1 - 1}`, val: `'Changes'!$G$6:$G$${LH1 - 1}`, color: BRAND }] });
    const C0 = Math.max(LH1 + 2, 22);
    chs.set(C0, 2, '2. What changed since the previous load', { font: st.B });
    ['Change', 'Lines', 'Amount effect'].forEach((h, j) => chs.hdr(C0 + 1, 2 + j, h));
    const cs = A.changeSummary || {};
    [['New', 'new'], ['Amount changed', 'changed'], ['Approved since last load', 'newly_approved'], ['Removed', 'removed']].forEach(([t, k], n) => {
      chs.set(C0 + 2 + n, 2, t, { font: st.F }); chs.set(C0 + 2 + n, 3, num(cs[k + '_lines']), { font: st.F }); chs.set(C0 + 2 + n, 4, num(cs[k + '_amount']), { font: st.F, fmt: NUM }); });
    chs.set(C0 + 6, 2, 'New and Amount changed move the certified total; Approved moves money from Not approved to Approved (counted at its full amount); Removed lines were in the previous upload and are gone now.', { font: st.IT });
    const D0 = C0 + 9; chs.set(D0, 2, '3. Changed lines', { font: st.B });
    ['Change', 'PO', 'Supplier', 'Service', 'Service text', 'Previous amount', 'Amount now', 'Difference'].forEach((h, j) => chs.hdr(D0 + 1, 2 + j, h));
    A.changeRows.forEach((c, n) => [c.change_type, c.po_no, c.vendor_name, c.service_code, c.service_text, c.before, c.now, c.difference]
      .forEach((v, j) => chs.set(D0 + 2 + n, 2 + j, v, { font: st.F, fmt: j >= 5 ? NUM : undefined })));
    if (!A.changeRows.length) chs.set(D0 + 2, 2, loads.length > 1 ? 'No line changed.' : 'Nothing to compare yet.', { font: st.IT });
    chs.width(1, 2); [26, 12, 30, 11, 36, 14, 14, 14, 12, 14, 8].forEach((w, j) => chs.width(2 + j, w));

    // ---------------- Notes
    await say('Notes'); const ws = S['Notes'];
    const sumIf = (f) => det.filter(f).reduce((s, r) => s + r.amt, 0);
    const fmtN = (v) => Math.round(v).toLocaleString('en-US');
    const unk = A.services.filter((s) => !s.unit).length;
    const notes = [['How this workbook is built', st.B], ['', st.F],
      [`Source: SAP ZSCPROG01 export (${A.files.prog || 'ZSCPROG01'}), plant ${A.PLANT}, main profit centre ${MAINPC}. ${det.length} certificate lines kept; ${A.rawRowCount - A.RAWN} SAP subtotal/total rows removed.`, st.F],
      ['Amount = "SC Work Current Cost" (excl. VAT); Qty = "Current Quantity"; month = certificate "Date".', st.F],
      ['Flag = X → initial invoice entered before go-live → OPENING block, never a month. If it is not yet approved it goes to PENDING instead, marked "Opening – not approved" on Detail.', st.F],
      ['Character 1 = X → approved. Blank → not approved → PENDING block (or its month if Coding!N2 = Y).', st.F],
      [`Service Monthly row = Service + Service text + Line type + Supplier + Gross price + Contract type (نوع العقد) + Tax code (Tx) + Profit centre: ${A.keyTuples.length} rows.`, st.F],
      [`Line type "Adjustment" = amount with zero quantity, or with a ≤ 0.01 placeholder quantity that does not explain the amount (${det.filter((r) => r.isadj).length} lines, net ${fmtN(sumIf((r) => r.isadj))}): payment-% changes, re-pricing, reversals – own orange row, quantity ignored.`, st.F],
      ['Report qty: where a line was not paid at qty × net rate (paid % below 100, catch-up to 100 %, re-price) the report uses equivalent qty = amount ÷ net rate, so every rate equals the contract rate. SAP qty stays on Detail and feeds Qty Reconciliation.', st.F],
      [`Profit centre: lines not on ${MAINPC} (${det.filter((r) => r.othpc).length} lines, ${fmtN(sumIf((r) => r.othpc))}) stay in the report, on their own purple rows, flagged on Detail and as a Dashboard figure.`, st.F],
      [`Line type "Qty only (excluded)" = quantity with zero amount (${det.filter((r) => r.isqo).length} lines): repeats of quantity already certified on another line (re-pricing) or 0.01 placeholders. No cost impact; excluded so quantities are not double-counted. Kept on Detail.`, st.F],
      ['Net rate: A2 (شامل) gross prices include VAT → SAP pays Gross ÷ (1 + VAT); A1 (غير شامل) pays Gross. VAT per tax code on Coding.', st.F],
      [`Service Coding holds Unit, CSI, MNL, Cost Element Code per Service + text (${A.services.length} rows). CSI is the work package coded in the app; MNL and Cost Element Code are yours to fill. ${unk} units unknown (red).`, st.F],
      [`ZSCSRV1 (PO service lines, ${A.sv.length} lines): Unit per service code, Material group per PO service line, contract and received qty on Qty Reconciliation. Lines are matched by PO + item + service code + text + price, then text only, then service code only (Detail "PO line match").`, st.F],
      [`WBS splits: ${A.splitLines} certificate lines appear on several WBS rows with the same amount, qty and VAT (SAP repeats the whole line per WBS). Each is counted once – ${fmtN(A.splitAmt)} of repeated amount removed.` + (A.keyConflicts ? ` ${A.keyConflicts} rows share a Line ID but differ in amount – kept as they are.` : ''), st.F],
      [`History: load ${A.loadNo}. Every certificate upload is kept in the app's database, which is what the Changes sheet compares.`, st.F],
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
    ws.set(n0 + 4, 1, 'Service Monthly total', { font: st.F }); ws.set(n0 + 4, 2, `='Service Monthly'!${AMT_TOT}${ST}`);
    ws.set(n0 + 5, 1, 'Dashboard trade table total', { font: st.F }); ws.set(n0 + 5, 2, `=Dashboard!${L(3 + crit.length)}${TT}`);
    ws.set(n0 + 6, 1, 'Largest difference (must be 0)', { font: st.B }); ws.set(n0 + 6, 2, `=MAX(ABS(B${n0 + 3}-B${n0 + 2}),ABS(B${n0 + 4}-B${n0 + 2}),ABS(B${n0 + 5}-B${n0 + 2}))`);
    for (let r = n0; r <= n0 + 6; r++) ws.ws.getCell(r, 2).numFmt = NUM;
    ws.width(1, 130); ws.width(2, 18);

    await say('Writing the Excel file');
    const buf = await wb.xlsx.writeBuffer();
    await say('Adding charts');
    return injectCharts(buf, charts, ORDER, JSZip);
  }
