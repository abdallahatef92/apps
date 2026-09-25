import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { getDb } from '../db';
import { SC_UNIT_SQL } from '../db/systemQueries';
import { runStoredQuery } from './queryRunner';
import { buildWorkbook } from './subcontractWorkbook';

/**
 * The monthly Subcontract Cost Report workbook for one project — the same
 * workbook the standalone ZSCPROG01 + ZSCSRV1 tool produced (live formulas,
 * cross-sheet lookups, native charts), built from the database instead of
 * from two files held in memory.
 *
 * Every rule the report depends on (net rate, line class, report qty, trade,
 * PO line matching, split count, load history, changes) is read from the
 * views and stored queries the Subcontractor Analysis page shows, so the page
 * and the workbook cannot disagree. What happens here is only arranging those
 * rows into the shape the workbook builder expects: line identity, the
 * Service Monthly row keys, the month list.
 */

/** Resource codes are the first character of a service code; not project data. */
const RESOURCES = [['S', 'Subcontract works'], ['L', 'Labour supply'], ['P', 'Plant & logistics']];

/** ZSCSRV1 captions the workbook's Qty Reconciliation sheet reads a PO line by. */
const PO_CAPTIONS: Record<string, string> = {
  po_no: 'Purchase Order', po_item: 'PO item', po_line_no: 'PO Service Line no.',
  service_code: 'PO Service Code', service_text: 'Service Short Text', unit_price: 'Service Unit Price',
  uom: 'PO Service UOM', material_group: 'PO Service Material Group',
  material_group_desc: 'PO Service Material Group Description', vendor_code: 'Subcontractor',
  vendor_name: 'Subcontractor Name', works_type: 'Type of Works for PO',
  contract_terms: 'Type of Contract (Include/Exclude VAT)', contract_qty: 'PO Service Qty',
  contract_price: 'PO Service Price', qty_received: 'Total Qty Received',
  qty_accepted: 'Total Qty Accepted', total_cost: 'Total Cost',
};

const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());
const numOr0 = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
const cmp = (a: unknown, b: unknown) => ((a as any) < (b as any) ? -1 : (a as any) > (b as any) ? 1 : 0);
const cmpTuple = (a: unknown[], b: unknown[]) => {
  for (let i = 0; i < a.length; i++) { const c = cmp(a[i], b[i]); if (c) return c; }
  return 0;
};

export interface SubcontractReport {
  buffer: Uint8Array;
  /** `<project code>_service_report_<data date>.xlsx` */
  fileName: string;
}

export async function buildSubcontractReport(projectKey: number): Promise<SubcontractReport> {
  const db = getDb();
  const project = db.prepare(`SELECT p.project_code, c.iso_code AS currency_code
                              FROM dim_project p LEFT JOIN dim_currency c ON c.currency_key = p.currency_key
                              WHERE p.project_key = ?`).get(projectKey) as
    { project_code: string; currency_code: string | null } | undefined;
  if (!project) throw new Error('Project not found.');

  const lines = db.prepare(`
    SELECT s.*, m.match_level, po.po_line_ref, po.material_group, po.material_group_desc,
           (SELECT MIN(sn.import_batch_id) FROM service_line_snapshot sn
             WHERE sn.project_key = s.project_key AND sn.line_uid = s.line_uid) AS first_batch
    FROM v_service_line s
    LEFT JOIN v_service_line_po_match m ON m.service_line_id = s.service_line_id
    LEFT JOIN v_po_service_line po ON po.po_service_line_id = m.po_service_line_id
    WHERE s.project_key = ?`).all(projectKey) as any[];
  if (lines.length === 0) throw new Error('No certificate lines (ZSCPROG01) are loaded for this project.');

  const loads = runStoredQuery('SC_LOAD_HISTORY', { project_key: projectKey }).rows as any[];
  const changeSummary = runStoredQuery('SC_CHANGES_SUMMARY', { project_key: projectKey }).rows[0] ?? {};
  const changeRows = runStoredQuery('SC_CHANGES', { project_key: projectKey }).rows;
  const batchOrder = new Map<number, number>(
    (db.prepare(`SELECT DISTINCT s.import_batch_id FROM service_line_snapshot s
                 JOIN import_batch b ON b.import_batch_id = s.import_batch_id AND b.status IN ('POSTED','SUPERSEDED')
                 WHERE s.project_key = ? ORDER BY s.import_batch_id`).all(projectKey) as any[])
      .map((r, i) => [r.import_batch_id as number, i + 1]));
  const latest = db.prepare(`SELECT b.control_total, b.row_count_file, b.file_name, b.data_date
                             FROM import_batch b WHERE b.import_batch_id =
                               (SELECT MAX(s.import_batch_id) FROM service_line_snapshot s WHERE s.project_key = ?)`)
    .get(projectKey) as any | undefined;

  const mainPc = (db.prepare(`SELECT profit_center FROM v_service_line
                              WHERE project_key = ? AND profit_center IS NOT NULL AND is_other_pc = 0 LIMIT 1`)
    .get(projectKey) as any)?.profit_center ?? '';

  // ---- certificate lines, in the engine's shape
  const det = lines.map((s) => {
    const dateKey = s.invoice_date_key
      ? Number(s.invoice_date_key)
      : s.period_key ? Number(String(s.period_key).replace('-', '')) * 100 + 1 : 19000101;
    const y = Math.floor(dateKey / 10000), mo = Math.floor(dateKey / 100) % 100, d = dateKey % 100;
    const approved = s.is_approved !== 0;
    const initial = s.is_opening === 1;
    const lt = s.line_class === 'Qty only' ? 'Qty only (excluded)' : s.line_class;
    return {
      dateKey, dateObj: new Date(Date.UTC(y, mo - 1, d)), month: y * 100 + mo,
      po: text(s.po_no), serial: text(s.invoice_serial), item: text(s.item_no),
      svc: text(s.service_code), text: text(s.service_text),
      supCode: text(s.vendor_code), supName: text(s.vendor_name),
      appr: approved ? 'X' : '', flag: initial ? 'X' : '', approved, initial,
      docno: text(s.invoice_no), es: text(s.entry_sheet_no), doctype: '',
      lt, isadj: lt === 'Adjustment', isqo: lt === 'Qty only (excluded)',
      ctype: text(s.contract_type), tax: text(s.tax_code), price: numOr0(s.unit_rate),
      totq: numOr0(s.quantity_total), prevq: numOr0(s.quantity_previous), qty: numOr0(s.quantity_current),
      paid: numOr0(s.progress_pct), amt: numOr0(s.amount_net), vat: numOr0(s.amount_vat),
      res: text(s.resource_code), trade: text(s.trade),
      gl: text(s.cost_element_code), wbs: text(s.wbs_code), wbsDesc: text(s.wbs_name),
      poref: s.po_line_ref ?? null, matchLvl: s.match_level ?? 'Not found',
      mg: s.material_group ?? null, mgd: s.material_group_desc ?? null,
      pc: text(s.profit_center), othpc: s.is_other_pc === 1,
      lid: s.line_uid ?? `row ${s.service_line_id}`,
      split: s.split_count > 1 ? s.split_count : null,
      first: batchOrder.get(s.first_batch) ?? batchOrder.size,
      sid: 0, rk: 0 as number | null,
    };
  });

  // ---- Service Coding rows: one per service code + text; CSI is the app's work package
  const services = (db.prepare(`
    WITH u AS (SELECT service_code, MAX(uom) AS uom FROM v_po_service_line
               WHERE project_key = :pk AND uom IS NOT NULL AND uom <> '' GROUP BY service_code)
    SELECT COALESCE(s.service_code,'') AS svc, COALESCE(s.service_text,'') AS text,
           ${SC_UNIT_SQL('s.service_code', 's.service_text', 'u.uom')} AS unit,
           CASE WHEN u.uom IS NOT NULL THEN 'ZSCSRV1 PO service UOM'
                WHEN INSTR(s.service_code, '-') > 0 THEN 'Service code suffix'
                WHEN ${SC_UNIT_SQL('s.service_code', 's.service_text', 'NULL')} IS NOT NULL THEN 'Service text'
                ELSE 'unknown – please fill' END AS unit_source,
           MAX(s.work_package) AS csi
    FROM v_service_line s LEFT JOIN u ON u.service_code = s.service_code
    WHERE s.project_key = :pk
    GROUP BY 1, 2`).all({ pk: projectKey }) as any[])
    .sort((a, b) => cmpTuple([a.svc + '\u0001' + a.text], [b.svc + '\u0001' + b.text]))
    .map((s, i) => ({ id: i + 1, key: s.svc + '\u0001' + s.text, svc: s.svc, text: s.text, unit: s.unit ?? null,
      unitSrc: s.unit_source, csi: s.csi ?? '', mnl: '', cec: '' }));
  const svcId = new Map(services.map((s) => [s.key, s.id]));
  for (const r of det) r.sid = svcId.get(r.svc + '\u0001' + r.text) ?? 0;

  // ---- Service Monthly row keys: the engine's own grouping of certificate lines
  const rkT = (r: typeof det[number]) => [r.svc, r.text, r.isadj ? 1 : 0, r.supCode, r.price, r.ctype, r.tax, r.pc];
  const keyed = det.filter((r) => !r.isqo).map((r) => ({ r, t: rkT(r) })).sort((a, b) => cmpTuple(a.t, b.t));
  const key = new Map<string, number>(); const keyTuples: unknown[][] = [];
  for (const { r, t } of keyed) {
    const k = JSON.stringify(t);
    if (!key.has(k)) { key.set(k, key.size + 1); keyTuples.push(t); }
    r.rk = key.get(k)!;
  }
  for (const r of det) if (r.isqo) r.rk = null;
  const months = [...new Set(det.filter((r) => !r.initial).map((r) => r.month))].sort((a, b) => a - b);
  const omonths = [...new Set(det.filter((r) => !r.initial && r.approved).map((r) => r.month))].sort((a, b) => a - b);

  // ---- ZSCSRV1 rows, addressed by their original captions
  const sv = (db.prepare('SELECT * FROM v_po_service_line WHERE project_key = ?').all(projectKey) as any[])
    .map((p) => {
      const o: Record<string, unknown> = { __ref: p.po_line_ref };
      for (const [col, caption] of Object.entries(PO_CAPTIONS)) o[caption] = p[col] ?? '';
      return o;
    });

  const trades = (db.prepare('SELECT code, label FROM dim_sc_trade ORDER BY sort_order, code').all() as any[])
    .map((t) => [t.code, t.label]);
  const vatr = Object.fromEntries((db.prepare('SELECT code, vat_rate FROM dim_tax_code ORDER BY code').all() as any[])
    .map((t) => [t.code, t.vat_rate]));

  const splitLines = det.filter((r) => r.split).length;
  const splitAmt = det.reduce((a, r) => a + (r.split ? r.amt * (r.split - 1) : 0), 0);
  const dataDate = det.reduce((m, r) => (r.dateKey > m.dateKey ? r : m), det[0]).dateObj;

  const A = {
    det, MAINPC: mainPc, PLANT: project.project_code, currency: project.currency_code ?? '',
    months, omonths, keyTuples, services, svcId,
    sv, g: (x: Record<string, unknown>, n: string) => x[n], ref: (x: Record<string, unknown>) => x.__ref,
    gt: latest?.control_total ?? null, splitAmt, splitLines, keyConflicts: 0,
    RAWN: det.length + det.reduce((a, r) => a + (r.split ? r.split - 1 : 0), 0),
    rawRowCount: Math.max(numOr0(latest?.row_count_file),
      det.length + det.reduce((a, r) => a + (r.split ? r.split - 1 : 0), 0)),
    loadNo: Math.max(loads.length, 1), dataDate, loads, changeSummary, changeRows,
    opts: { pendingInMonth: false }, files: { prog: latest?.file_name ?? '' },
    resources: RESOURCES, trades, vatr,
  };

  const buffer = await buildWorkbook(A, { ExcelJS, JSZip }, async () => {});
  const stamp = latest?.data_date ?? new Date().toISOString().slice(0, 10);
  const safeCode = project.project_code.replace(/[^\w\-]/g, '_');
  return { buffer, fileName: `${safeCode}_service_report_${stamp}.xlsx` };
}
