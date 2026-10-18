import ExcelJS from 'exceljs';
import { fixSheetPrOrder } from './xlsxFix';
import { getDb } from '../db';
import { runStoredQuery } from './queryRunner';
import * as E from './materialEngine';
import { createWriter } from './materialWorkbook';

/**
 * The monthly Material Cost Report workbook for one project - the workbook the
 * standalone MB51 + ME2N tool (Material Cost Report v1.2) produced, built from the
 * database instead of from files held in memory. A sibling of subcontractReport.ts.
 *
 * Where each part of the tool's input comes from:
 *   MB51 lines        v_material_movement (ISSUE movements; zero-value ones too - the
 *                     tool counts them as "left out"), signs and cut-off handled by
 *                     the engine exactly as the views do; the movements that are not
 *                     material cost are summed from the same view.
 *   ME2N lines        v_po_material_line
 *   material group    dim_material.material_group; the catalogue is dim_material_group
 *   PKG               material_work_package (project) -> dim_work_package
 *   MNL               dim_cost_type.mnl of MATERIAL (migration 023), 'MAT' without it
 *   Cost element      left blank: the user's own catalogue codes, not stored in the app
 *   cut date          project_cutoff, else the end of the latest month with counted issues
 *   Checks sheet      MAT_CHECKS / MAT_CHECK_ROWS - the rows the page's Checks tab shows
 *
 * The figures are computed by materialEngine.ts (the tool's own build()) over the same
 * v_material_movement rows the MAT_* queries read, and the report asserts that its
 * To date equals MAT_KPI's, so the page and the workbook cannot drift silently.
 */

export interface MaterialReport {
  buffer: Uint8Array;
  /** `<plant>_Material_Report_<yyyy-mm>.xlsx` */
  fileName: string;
}

/** The built workbook before it is written: the export writes it, the Material page shows it (workbookView.ts). */
export interface MaterialWorkbook {
  workbook: ExcelJS.Workbook;
  /** `<plant>_Material_Report_<yyyy-mm>.xlsx` */
  fileName: string;
  /** e.g. `P1 · Material Cost Report · Mar-26` */
  title: string;
}

const text =(v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());
const numOr0 = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
const toDate = (iso: unknown): Date | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text(iso));
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
};
const lastDayOf = (ym: string): Date => {
  const m = /^(\d{4})-(\d{2})/.exec(ym)!;
  return new Date(Date.UTC(+m[1], +m[2], 0));
};

/** MAT_CHECKS status -> the workbook's ok / warn / info. A check with nothing to compare reads info, never ok. */
const checkStatus = (s: string): 'ok' | 'warn' | 'info' => (s === 'ok' ? 'ok' : s === 'warn' ? 'warn' : 'info');

/** material:exportReport: the workbook, written, with ExcelJS's sheetPr order repaired. */
export async function buildMaterialReport(projectKey: number): Promise<MaterialReport> {
  const { workbook, fileName } = await buildMaterialWorkbook(projectKey);
  const buffer = await fixSheetPrOrder(await workbook.xlsx.writeBuffer());
  return { buffer, fileName };
}

export async function buildMaterialWorkbook(projectKey: number): Promise<MaterialWorkbook> {
  const db = getDb();
  const project = db.prepare(`SELECT p.project_code, c.iso_code AS currency_code
                              FROM dim_project p LEFT JOIN dim_currency c ON c.currency_key = p.currency_key
                              WHERE p.project_key = ?`).get(projectKey) as
    { project_code: string; currency_code: string | null } | undefined;
  if (!project) throw new Error('Project not found.');

  const movements = db.prepare(`SELECT * FROM v_material_movement WHERE project_key = ?`).all(projectKey) as any[];
  const issueRows = movements.filter((m) => m.movement_kind === 'ISSUE');
  if (issueRows.length === 0) throw new Error('No MB51 goods issues are loaded for this project.');

  // ---- the SAP material-group catalogue (names, family, division) - reference data from the database
  E.setGroupCatalogue((db.prepare('SELECT code, name FROM dim_material_group').all() as any[]).map((g) => [g.code, g.name]));

  // ---- cut date: the project cut-off, else the end of the latest month with a counted (dated, valued) issue
  const cutoff = (db.prepare('SELECT cutoff_date FROM project_cutoff WHERE project_key = ?').get(projectKey) as any)?.cutoff_date;
  let cutDate = cutoff ? toDate(cutoff) : null;
  if (!cutDate) {
    const latest = (db.prepare(`SELECT MAX(period_key) pk FROM v_material_issue_all WHERE project_key = ? AND period_key IS NOT NULL`)
      .get(projectKey) as any)?.pk as string | null;
    if (!latest) throw new Error('No MB51 issue with a posting date and an amount is loaded for this project.');
    cutDate = lastDayOf(latest);
  }

  // ---- MB51, in the tool's line shape
  const lines = issueRows.map((m) => E.mkLine({
    lid: [text(m.document_no), text(m.fiscal_year), text(m.document_line)].join('|'),
    material: text(m.material_code), plant: text(m.plant), sloc: text(m.storage_location),
    mvt: text(m.movement_type).toUpperCase(), mvtText: text(m.movement_text),
    doc: text(m.document_no), year: text(m.fiscal_year), item: text(m.document_line),
    date: toDate(m.posting_date), desc: text(m.material_name).replace(/\s+/g, ' '),
    sapQty: numOr0(m.sap_quantity), sapAmt: numOr0(m.sap_amount), unit: text(m.uom), edate: toDate(m.entry_date),
    supplier: text(m.vendor_code), wbs: text(m.wbs_code), order: text(m.order_no),
    resv: text(m.reservation_no) === '0' ? '' : text(m.reservation_no), user: text(m.user_name),
    hdr: text(m.header_text), text: text(m.item_text), val: text(m.valuation_type),
  }));
  const plantTally = new Map<string, number>();
  for (const l of lines) if (l.plant) plantTally.set(l.plant, (plantTally.get(l.plant) ?? 0) + 1);
  const plant = [...plantTally].sort((a, b) => b[1] - a[1])[0]?.[0] || project.project_code;

  // ---- what MB51 held besides the issues (the Summary's reconciliation, the Checks)
  const outsideMap = new Map<string, any>();
  for (const m of movements) {
    if (m.movement_kind === 'ISSUE') continue;
    const k = `${m.movement_type}\u0001${m.movement_text ?? ''}`;
    let o = outsideMap.get(k);
    if (!o) outsideMap.set(k, o = { mvt: text(m.movement_type).toUpperCase(), text: text(m.movement_text),
      group: m.movement_kind === 'OUTSIDE' ? text(m.movement_group) : '', n: 0, q: 0, a: 0 });
    o.n++; o.q += numOr0(m.sap_quantity); o.a += numOr0(m.sap_amount);
  }
  const outside = [...outsideMap.values()].sort((x, y) => (x.group ? 0 : 1) - (y.group ? 0 : 1) || x.mvt.localeCompare(y.mvt));

  const lastBatch = (db.prepare(`SELECT MAX(f.import_batch_id) id FROM fact_material_issue f
                                 JOIN import_batch b ON b.import_batch_id = f.import_batch_id AND b.status = 'POSTED'
                                 WHERE f.project_key = ?`).get(projectKey) as any)?.id as number | null;
  const batch = lastBatch ? db.prepare('SELECT file_name, control_total FROM import_batch WHERE import_batch_id = ?').get(lastBatch) as any : null;
  const dup = lastBatch ? db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(CAST(json_extract(raw_json, '$.mapped.amount') AS REAL)), 0) a
                                       FROM stg_row WHERE import_batch_id = ? AND status = 'SKIPPED' AND message LIKE 'Repeat of the document line%'`)
    .get(lastBatch) as any : { n: 0, a: 0 };
  const skipped = lastBatch ? Number((db.prepare(`SELECT COUNT(*) n FROM stg_row WHERE import_batch_id = ? AND status = 'SKIPPED'
                                                    AND message NOT LIKE 'Repeat of the document line%'`).get(lastBatch) as any).n) : 0;
  const mb = {
    lines, outside, plant, footer: batch?.control_total ?? null,
    rawRows: movements.length + numOr0(dup.n), rawSum: movements.reduce((s, m) => s + numOr0(m.sap_amount), 0) + numOr0(dup.a),
    summaryRows: skipped, dupRows: numOr0(dup.n), dupAmt: numOr0(dup.a), zeroLines: null, zeroOwner: null,
  };

  // ---- ME2N, indexed the tool's way; a material's group is the database's (ME2N first, then the material list)
  const poRows = db.prepare('SELECT * FROM v_po_material_line WHERE project_key = ?').all(projectKey) as any[];
  const mats = db.prepare(`SELECT material_code, material_group, material_type FROM dim_material
                           WHERE material_code IN (SELECT material_code FROM v_material_movement WHERE project_key = :pk
                                                   UNION SELECT material_code FROM v_po_material_line WHERE project_key = :pk)`)
    .all({ pk: projectKey }) as any[];
  const groups = new Map<string, string>(), types = new Map<string, string>();
  for (const m of mats) { if (m.material_group) groups.set(m.material_code, m.material_group); if (m.material_type) types.set(m.material_code, m.material_type); }
  let me: any = null;
  if (poRows.length) {
    me = E.meIndex({
      skipped: 0,
      lines: poRows.map((p) => E.meLine({
        po: text(p.po_no), item: text(p.po_item), date: toDate(p.document_date), vendor: text(p.supplier_text).replace(/\s+/g, ' '),
        plant: text(p.plant), material: text(p.material_code), group: text(p.material_group), text: text(p.short_text).replace(/\s+/g, ' '),
        unit: text(p.order_unit), del: p.is_deleted ? 'L' : '', qty: numOr0(p.order_qty), priceUnit: numOr0(p.price_unit),
        netPrice: numOr0(p.net_price), value: numOr0(p.net_value), openQty: numOr0(p.open_qty), openVal: numOr0(p.open_value),
        invQty: numOr0(p.invoice_qty), invVal: numOr0(p.invoice_value),
      })),
    });
    for (const [mat, info] of me.info) if (groups.has(mat)) info.group = groups.get(mat);   // the database's group wins
  }

  // ---- coding: PKG = work package (left blank for the user to fill if unmapped); MNL = the MATERIAL cost type's code
  // (MAT); Cost element is left blank for the user to fill (their own catalogue codes, not stored in the app)
  let mnl = 'MAT';
  try {
    mnl = (db.prepare(`SELECT COALESCE(mnl, 'OTHER') AS mnl FROM dim_cost_type WHERE code = 'MATERIAL'`).get() as any)?.mnl || 'MAT';
  } catch { /* migration 023 not applied: the MATERIAL cost type is MAT anyway */ }
  const pkgByMat = new Map((db.prepare('SELECT material_code, work_package FROM material_work_package WHERE project_key = ?')
    .all(projectKey) as any[]).map((r) => [r.material_code, r.work_package]));
  const packages = db.prepare('SELECT code, label FROM dim_work_package ORDER BY sort_order, code').all() as any[];
  const issued = [...new Set(lines.map((l) => l.material))];
  const descOf = new Map<string, string>();
  for (const l of lines) if (l.desc && !descOf.has(l.material)) descOf.set(l.material, l.desc);
  const codingFile = {
    rows: issued.map((mat) => ({ mat, desc: descOf.get(mat) ?? '', pkg: text(pkgByMat.get(mat)), mnl, ce: '' })),
    lists: {
      pkg: packages.map((p) => [p.code, p.label]),
      mnl: [['MAT', 'Material'], ['SUB', 'Subcontract'], ['EQU', 'Equipment'], ['LAB', 'Labour'], ['OTHER', 'Other resources']],
      ce: [],
    },
    poTypes: new Map<string, string>(), plant, saved: null,
  };

  const dataFiles = db.prepare(`SELECT b.module AS code, b.file_name FROM import_batch b
                                WHERE b.status = 'POSTED' AND b.module IN ('MATISSUE','MATPO')
                                  AND b.import_batch_id = (SELECT MAX(b2.import_batch_id) FROM import_batch b2
                                    WHERE b2.status = 'POSTED' AND b2.module = b.module AND b2.project_key IS b.project_key)
                                  AND b.project_key = ?`).all(projectKey) as any[];
  const fileOf = (code: string) => dataFiles.find((f) => f.code === code)?.file_name ?? '';

  const M = E.build({
    mb, me, groups, types, cstate: E.codingState(codingFile), cutDate, rollYears: true,
    files: { mb: batch?.file_name || fileOf('MATISSUE'), me: fileOf('MATPO') },
  });
  M.currency = project.currency_code ?? '';
  M.plant = plant;

  // ---- the Checks sheet is the page's Checks tab (MAT_CHECKS, the rows behind each from MAT_CHECK_ROWS)
  const P = { project_key: projectKey };
  const checks = (runStoredQuery('MAT_CHECKS', P).rows as any[]).map((c) => {
    const entry: any = { status: checkStatus(String(c.status)), title: c.check_name, detail: c.detail, count: c.lines ?? null, amount: c.amount ?? null, rows: null, cols: null };
    if (['unknown_mvt', 'outside', 'after_cut', 'no_date', 'z21', 'duplicates', 'no_group', 'multi_unit', 'negative_td', 'recon', 'old_po']
      .includes(c.check_code) && Number(c.lines) > 0) {
      const rows = runStoredQuery('MAT_CHECK_ROWS', { ...P, check_code: c.check_code }).rows as any[];
      if (rows.length) {
        entry.cols = ['Posting date', 'Movement', 'Document', 'Amount', 'Material', '', 'Description', 'Detail'];
        entry.rows = rows.map((r) => [text(r.posting_date), text(r.movement), text(r.document), r.amount == null ? '' : r.amount,
          text(r.material_code), '', text(r.description), text(r.detail)]);
      }
    }
    return entry;
  });
  M.checks = checks;

  // ---- the page and the workbook must give the same To date
  const kpi = runStoredQuery('MAT_KPI', P).rows[0] as any;
  if (kpi && Math.abs(numOr0(kpi.to_date) - M.T.td) > 0.5) {
    M.checks.push({ status: 'warn', title: 'To date differs from the Material page', count: null, amount: Math.round((M.T.td - numOr0(kpi.to_date)) * 100) / 100,
      detail: `This workbook's To date is ${Math.round(M.T.td).toLocaleString('en-US')} but MAT_KPI (the Material page) gives ${Math.round(numOr0(kpi.to_date)).toLocaleString('en-US')}. Please report it.`,
      rows: null, cols: null });
  }

  const workbook = await createWriter(E).buildReportWorkbook(M, ExcelJS) as ExcelJS.Workbook;
  const safe = (s: string) => s.replace(/[^\w\-]/g, '_');
  return { workbook, fileName: `${safe(plant)}_Material_Report_${E.util.mKey(M.reportMonth)}.xlsx`,
    title: `${plant} · Material Cost Report · ${M.label}` };
}
