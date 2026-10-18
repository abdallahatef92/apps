import ExcelJS from 'exceljs';
import { fixSheetPrOrder } from './xlsxFix';
import { getDb } from '../db';
import { SC_UNIT_SQL } from '../db/systemQueries';
import { runStoredQuery } from './queryRunner';
import { buildModel, buildReportWorkbook, ckey, normTow, lastDay, r2, tally, top } from './subcontractWorkbookV26';

/**
 * The monthly Subcontract Cost Report workbook for one project, in the v2.6 tool's layout
 * (Summary with a live cut date, Coding / Lists, Service Summary with rate analysis, Service
 * and PO per Month, PO Register, Subcontractor Summary, Invoices Register, Checks, Changes,
 * Data, Notes). `subcontractWorkbookV26.ts` is the tool's model and writer, ported nearly
 * verbatim; this file is the typed adapter that feeds it from the database.
 *
 * Every rule the report depends on is read from the views and stored queries the Subcontractor
 * Analysis page shows, so the page and the workbook cannot disagree:
 *   - lines                 v_service_line (line_class, report_qty, rate_used, pend_reason, tow,
 *                           certificate_id, report_month, cutoff_date ...)
 *   - PO quantities / units v_po_service_line, SC_UNIT_SQL
 *   - checks                SC_CHECKS (+ SC_CHECK_ROWS for the ones that list rows)
 *   - changes               SC_LOAD_HISTORY, SC_CHANGES
 *   - DIV                   service_work_package > dim_work_package (code)
 *   - PKG, Cost element     left blank: the user's own catalogue codes, not stored in the app
 *   - MNL                   dim_cost_type.mnl of SUBCONTRACT (SUB)
 * What happens here is only arranging those rows into the shape the writer expects.
 */

const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());
const numOr0 = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
const ymNum = (s: string): number => Number(s.slice(0, 4)) * 100 + Number(s.slice(5, 7));
const isoToDate = (s: string): Date => new Date(Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10))));

const MNL_NAMES: Array<[string, string]> = [
  ['MAT', 'Material'], ['SUB', 'Subcontract'], ['EQU', 'Equipment'], ['LAB', 'Labour'], ['OTHER', 'Other resources'],
];

/** SC_CHECKS rows that have a row list (SC_CHECK_ROWS) worth printing on the Checks sheet. */
const CHECKS_WITH_ROWS = ['NOT_APPROVED', 'NO_DATE', 'CONTRACT_TYPE', 'NO_TOW', 'NEG_TODATE', 'NO_UNIT',
  'LINE_CONFLICT', 'NO_PO_LINE', 'VAT_UNKNOWN'];

export interface SubcontractReport {
  buffer: Uint8Array;
  /** `<project code>_SC_Report_<yyyy-mm>.xlsx` (report month) */
  fileName: string;
}

/** The built workbook before it is written: the export writes it, the Subcontractor page shows it (workbookView.ts). */
export interface SubcontractWorkbook {
  workbook: ExcelJS.Workbook;
  /** `<project code>_SC_Report_<yyyy-mm>.xlsx` (report month) */
  fileName: string;
  /** e.g. `P-200 · Subcontract Cost Report · Aug-26` */
  title: string;
}

/** sc:exportReport: the workbook, written, with ExcelJS's sheetPr order repaired. */
export async function buildSubcontractReport(projectKey: number): Promise<SubcontractReport> {
  const { workbook, fileName } = await buildSubcontractWorkbook(projectKey);
  const buffer = await fixSheetPrOrder(await workbook.xlsx.writeBuffer());
  return { buffer: buffer as Uint8Array, fileName };
}

export async function buildSubcontractWorkbook(projectKey: number): Promise<SubcontractWorkbook> {
  const db = getDb();
  const project = db.prepare(`SELECT p.project_code, c.iso_code AS currency_code
                              FROM dim_project p LEFT JOIN dim_currency c ON c.currency_key = p.currency_key
                              WHERE p.project_key = ?`).get(projectKey) as
    { project_code: string; currency_code: string | null } | undefined;
  if (!project) throw new Error('Project not found.');

  const rows = db.prepare('SELECT * FROM v_service_line WHERE project_key = ?').all(projectKey) as any[];
  if (rows.length === 0) throw new Error('No certificate lines (ZSCPROG01) are loaded for this project.');

  // ---- report month and cut date: the project cut-off, else the latest counted month's end
  let reportMonth: number | null = null;
  const rmText = rows.find((r) => r.report_month)?.report_month as string | undefined;
  if (rmText) reportMonth = ymNum(rmText);
  const cutoffIso = (rows.find((r) => r.cutoff_date)?.cutoff_date as string | undefined) ?? null;
  if (!reportMonth && cutoffIso) reportMonth = ymNum(cutoffIso);
  if (!reportMonth) {
    const dated = rows.map((r) => (r.eff_date ? ymNum(r.eff_date) : 0)).filter((m) => m > 0);
    reportMonth = dated.length ? Math.max(...dated) : ymNum(new Date().toISOString().slice(0, 7) + '-01');
  }
  const cutDate = cutoffIso ? isoToDate(cutoffIso) : lastDay(reportMonth);

  // ---- tax rates, units, groups
  const vatr: Record<string, number> = Object.fromEntries(
    (db.prepare('SELECT code, vat_rate FROM dim_tax_code ORDER BY code').all() as any[]).map((t) => [t.code, t.vat_rate]));
  const unitRows = db.prepare(`
    WITH u AS (SELECT service_code, MAX(uom) AS uom FROM v_po_service_line
               WHERE project_key = :pk AND uom IS NOT NULL AND uom <> '' GROUP BY service_code)
    SELECT sv.service_code AS svc, sv.service_text AS txt,
           ${SC_UNIT_SQL('sv.service_code', 'sv.service_text', 'u.uom')} AS unit
    FROM (SELECT DISTINCT COALESCE(service_code,'') AS service_code, COALESCE(service_text,'') AS service_text
          FROM v_service_line WHERE project_key = :pk) sv
    LEFT JOIN u ON u.service_code = sv.service_code`).all({ pk: projectKey }) as any[];
  const unitMap = new Map<string, string>(unitRows.filter((u) => u.unit).map((u) => [u.svc + '\u0001' + u.txt, u.unit as string]));
  const unitOf = (svc: string, txt: string): string => unitMap.get(svc + '\u0001' + txt) ?? '';

  // ---- ZSCSRV1: PO quantities per PO + service + description, service groups
  const psl = db.prepare('SELECT po_no, service_code, service_text, contract_qty, material_group_desc FROM v_po_service_line WHERE project_key = ?')
    .all(projectKey) as any[];
  const poQty = new Map<string, { q: number; unl: boolean }>();
  const groupT = new Map<string, Map<string, number>>();
  for (const p of psl) {
    const k = text(p.po_no) + '\u0001' + ckey(text(p.service_code), text(p.service_text));
    const x = poQty.get(k) ?? { q: 0, unl: false };
    x.q += numOr0(p.contract_qty); poQty.set(k, x);
    tally(groupT, text(p.service_code), text(p.material_group_desc));
  }
  const group = new Map<string, string>();
  for (const [svc, t] of groupT) group.set(svc, top(t));
  const serv = psl.length
    ? { unit: new Map(), group, poType: new Map(), poTitle: new Map(), poQty, plant: '', lines: psl.length }
    : null;

  // ---- certificate lines, in the engine's shape
  const seenLid = new Map<string, number>();
  const lines = rows.map((s) => {
    const approved = s.is_approved !== 0;
    const opening = s.is_opening === 1;
    const month = s.period_key ? ymNum(s.period_key) : s.eff_date ? ymNum(s.eff_date) : null;
    const date = s.eff_date ? isoToDate(s.eff_date) : null;
    const pend = s.pend_reason ? String(s.pend_reason) : '';
    const bucket = pend ? 'Pending' : opening ? 'Opening' : mkKey(month!);
    const po = text(s.po_no);
    const serial = text(s.invoice_serial) || text(s.invoice_no);
    const base = [po, serial, text(s.item_no), text(s.package_no), text(s.line_no)].join('|');
    const n = (seenLid.get(base) ?? 0) + 1; seenLid.set(base, n);
    const tow = text(s.tow) === '(no type of works)' ? '' : normTow(s.tow);
    const ltype = s.line_class === 'Qty only' ? 'Qty only' : s.line_class;
    const net = numOr0(s.net_rate);
    return {
      date, month, po, serial, item: text(s.item_no), pkg: text(s.package_no), line: text(s.line_no),
      svc: text(s.service_code), text: text(s.service_text).replace(/\s+/g, ' '),
      supCode: text(s.vendor_code), supName: text(s.vendor_name),
      appr: approved ? 'X' : '', flag: opening ? 'X' : '', approved, opening, pend, bucket,
      docNo: text(s.invoice_no), es: text(s.entry_sheet_no), certText: '', wbs: text(s.wbs_code),
      ctype: text(s.contract_type), tax: text(s.tax_code), price: numOr0(s.unit_rate),
      qty: numOr0(s.quantity_current), paid: numOr0(s.progress_pct), vat: numOr0(s.amount_vat), amt: numOr0(s.amount_net),
      vatRate: vatr[text(s.tax_code)] ?? 0, net, ltype,
      pol: base.replace(/^[^|]*\|[^|]*\|/, po + '|'),   // placeholder, replaced below
      tow, rateUsed: ltype === 'Normal' ? net : numOr0(s.rate_used) || net,
      rq: numOr0(s.report_qty),
      lid: n > 1 ? `${base}#${n}` : base,
      wbsRows: s.split_count > 1 ? s.split_count : 1,
      wp: text(s.work_package),
      info: null as any, ckey: '',
    };
  });
  // the PO service line key the tool uses for the certified rate: PO | item | number | line
  for (const l of lines) l.pol = [l.po, l.item, l.pkg, l.line].join('|');

  // ---- WBS-split repeats and the SAP footer (latest upload), the way SC_CHECKS reads them
  const latestBatch = db.prepare(`SELECT MAX(s.import_batch_id) AS id FROM service_line_snapshot s
                                  JOIN import_batch b ON b.import_batch_id = s.import_batch_id AND b.status = 'POSTED'
                                  WHERE s.project_key = ?`).get(projectKey) as { id: number | null };
  const snap = latestBatch.id
    ? db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount_net), 0) AS total,
                         COALESCE(SUM(split_count - 1), 0) AS dup_rows,
                         COALESCE(SUM(amount_net * (split_count - 1)), 0) AS dup_amt,
                         COALESCE(SUM(CASE WHEN split_count > 1 THEN 1 ELSE 0 END), 0) AS dup_lines
                  FROM service_line_snapshot WHERE project_key = ? AND import_batch_id = ?`).get(projectKey, latestBatch.id) as any
    : { n: 0, total: 0, dup_rows: 0, dup_amt: 0, dup_lines: 0 };
  const latest = latestBatch.id
    ? db.prepare('SELECT control_total, row_count_file, file_name FROM import_batch WHERE import_batch_id = ?').get(latestBatch.id) as any
    : undefined;
  const prog = {
    footer: latest?.control_total ?? null,
    rawRows: Math.max(numOr0(latest?.row_count_file), snap.n + snap.dup_rows),
    summaryRows: 0,
    rawSum: r2(snap.total + snap.dup_amt),
    dupRows: snap.dup_rows, dupAmt: r2(snap.dup_amt), dupLines: snap.dup_lines,
  };

  const mainPc = (rows.find((r) => r.profit_center && r.is_other_pc === 0)?.profit_center as string | undefined) ?? '';

  // ---- coding: DIV from the work package; PKG and Cost element are left blank for the user to fill
  // (their own catalogue codes, not stored in the app); MNL from the cost type
  const wps = db.prepare(`SELECT code, label, group_label FROM dim_work_package ORDER BY sort_order, code`).all() as any[];
  const mnlSub = (db.prepare(`SELECT COALESCE(mnl, 'OTHER') AS mnl FROM dim_cost_type WHERE code = 'SUBCONTRACT'`).get() as any)?.mnl ?? 'SUB';

  const rowInfo = new Map<string, { svc: string; desc: string; wp: Map<string, number> }>();
  for (const l of lines) {
    if (l.amt === 0) continue;
    const k = ckey(l.svc, l.text);
    let x = rowInfo.get(k);
    if (!x) { x = { svc: l.svc, desc: l.text, wp: new Map() }; rowInfo.set(k, x); }
    if (l.wp) x.wp.set(l.wp, (x.wp.get(l.wp) ?? 0) + Math.abs(l.amt));
  }
  const best = (m: Map<string, number>): string => {
    let b = '', bw = -Infinity;
    for (const [k, w] of m) if (w > bw || (w === bw && k < b)) { b = k; bw = w; }
    return b;
  };
  const codes = new Map<string, any>();
  for (const [k, x] of rowInfo) {
    const wp = best(x.wp);
    codes.set(k, { svc: x.svc, desc: x.desc, div: wp, pkg: '', mnl: mnlSub, ce: '' });
  }
  const towOrder = (db.prepare('SELECT tow FROM dim_tow_order WHERE project_key = ? ORDER BY sort_order').all(projectKey) as any[])
    .map((t) => normTow(t.tow));
  const cstate = {
    codes,
    lists: {
      div: wps.map((w) => [w.code, w.label]),
      pkg: [],
      mnl: MNL_NAMES.map((m) => [...m]),
      ce: [],
    },
    legacy: new Map(), fileKeys: new Set(), added: [], towOrder: [...new Set(towOrder)],
    hasFile: false, format: null, plant: '', saved: null,
  };

  // ---- checks: SC_CHECKS, with the row lists SC_CHECK_ROWS gives for the ones that have them
  const checkRows = runStoredQuery('SC_CHECKS', { project_key: projectKey }).rows as any[];
  const statusOf = (s: string) => (s === 'ok' ? 'ok' : s === 'warn' || s === 'mismatch' ? 'warn' : 'info');
  const checks = checkRows.map((c) => {
    const cnt = c.count == null ? null : numOr0(c.count);
    let list: any[] | null = null;
    if (CHECKS_WITH_ROWS.includes(c.check_code) && cnt && cnt > 0) {
      const rr = runStoredQuery('SC_CHECK_ROWS', { project_key: projectKey, check_code: c.check_code }).rows as any[];
      list = rr.map((r) => [text(r.note), text(r.vendor_name), text(r.po_no), r.amount == null ? '' : r2(numOr0(r.amount)),
        text(r.service_code), text(r.certificate), text(r.service_text), '']);
    }
    const notChecked = c.status === 'not checked';
    return {
      status: statusOf(c.status), title: c.check,
      detail: [notChecked ? 'Not checked. ' : '', text(c.detail)].join('').trim(),
      count: cnt, amount: c.amount == null ? null : r2(numOr0(c.amount)),
      rows: list && list.length ? list : null,
      cols: list && list.length ? ['Note', 'Subcontractor', 'PO', 'Amount', 'Service', 'Certificate', 'Description', ''] : null,
    };
  });

  // ---- changes since the previous certificate upload
  const loads = runStoredQuery('SC_LOAD_HISTORY', { project_key: projectKey }).rows as any[];
  let changes: any;
  if (loads.length < 2) {
    changes = { label: 'only one upload', none: true, rows: [], monthTable: [], total: 0 };
  } else {
    const was = loads[loads.length - 2], is = loads[loads.length - 1];
    const row = (label: string, k: string) => ({ bucket: '', label, was: r2(numOr0(was[k])), is: r2(numOr0(is[k])),
      diff: r2(numOr0(is[k]) - numOr0(was[k])) });
    const monthTable = [row('Lines', 'lines'), row('Total certified', 'total_amount'), row('Approved', 'approved_amount'),
      row('Opening', 'opening_amount'), row('Pending (not approved)', 'pending_amount')];
    const changeRows = (runStoredQuery('SC_CHANGES', { project_key: projectKey }).rows as any[]).map((c) => ({
      type: text(c.change_type), bucket: '', lid: '', po: text(c.po_no), sup: text(c.vendor_name),
      svc: text(c.service_code), text: text(c.service_text), was: r2(numOr0(c.before)), is: r2(numOr0(c.now)),
      diff: r2(numOr0(c.difference)),
    }));
    changes = { label: `${text(was.data_date)} → ${text(is.data_date)}`, rows: changeRows, monthTable,
      total: r2(changeRows.reduce((a, c) => a + c.diff, 0)) };
  }

  const M = buildModel({
    plant: project.project_code, pc: mainPc, currency: project.currency_code ?? 'EGP',
    files: { prog: latest?.file_name ?? '', serv: serv ? 'ZSCSRV1 (in the app)' : '' },
    cutDate, reportMonth, rollYears: true, lines, prog, serv, unitOf, cstate, vat: vatr, checks, changes,
  });

  const workbook = await buildReportWorkbook(M, ExcelJS) as ExcelJS.Workbook;
  const mm = String(reportMonth % 100).padStart(2, '0');
  const safeCode = project.project_code.replace(/[^\w\-]/g, '_');
  return { workbook, fileName: `${safeCode}_SC_Report_${Math.floor(reportMonth / 100)}-${mm}.xlsx`,
    title: `${project.project_code} · Subcontract Cost Report · ${M.label}` };
}

function mkKey(k: number): string {
  return Math.floor(k / 100) + '-' + String(k % 100).padStart(2, '0');
}
