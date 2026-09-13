import { getDb } from '../db';
import { readSheetRows } from './workbook';
import { toDate, toNumber, toPeriod, toText } from './coerce';
import type {
  ColumnMappingEntry, Module, PostResult, StageRequest, StageResult, ValidationIssue,
} from '../../shared/types';

type Canonical = Record<string, unknown>;

const TRANSFORMS: Record<string, (v: unknown) => unknown> = {
  TRIM: (v) => toText(v),
  UPPER: (v) => toText(v)?.toUpperCase() ?? null,
  LOWER: (v) => toText(v)?.toLowerCase() ?? null,
  NEGATE: (v) => { const n = toNumber(v); return n === null ? null : -n; },
  ABS: (v) => { const n = toNumber(v); return n === null ? null : Math.abs(n); },
};

function applyMapping(row: Record<string, unknown>, mapping: ColumnMappingEntry[]): Canonical {
  const out: Canonical = {};
  for (const m of mapping) {
    let value: unknown = m.source_column ? row[m.source_column] : null;
    if ((value === null || value === undefined || value === '') && m.default_value != null) {
      value = m.default_value;
    }
    if (m.transform && TRANSFORMS[m.transform]) value = TRANSFORMS[m.transform](value);
    out[m.target_field] = value ?? null;
  }
  return out;
}

/** Required target fields per module, checked before anything is written. */
const REQUIRED: Record<string, string[]> = {
  ACTUAL: ['wbs_code', 'amount'],
  BUDGET: ['wbs_code', 'budget_amount'],
  FORECAST: ['wbs_code', 'forecast_amount'],
  COMMITMENT: ['wbs_code', 'amount'],
  SERVICE: ['wbs_code', 'po_no', 'amount_net'],
  MASTER: ['wbs_code'],
};

const AMOUNT_FIELD: Record<string, string> = {
  ACTUAL: 'amount', BUDGET: 'budget_amount', FORECAST: 'forecast_amount',
  COMMITMENT: 'amount', SERVICE: 'amount_net', MASTER: '',
};

/**
 * A subtotal row leaves the report's key fields blank while still carrying an
 * amount. Loading one would count the same money twice, so such rows are
 * recognised, staged as SKIPPED and reported back to the user.
 */
function isSubtotalRow(c: Canonical, detailKeyFields: string[]): boolean {
  if (detailKeyFields.length === 0) return false;
  return detailKeyFields.every((f) => {
    const v = c[f];
    return v === null || v === undefined || String(v).trim() === '';
  });
}

function validateRow(module: Module, c: Canonical, rowNo: number, batchPeriod: string | null,
                     batchProject: number | null): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const f of REQUIRED[module] ?? []) {
    const v = c[f];
    if (v === null || v === undefined || String(v).trim() === '') {
      issues.push({ rowNo, severity: 'ERROR', message: `Missing required field "${f}".` });
    }
  }

  const amountField = AMOUNT_FIELD[module];
  if (amountField && c[amountField] !== null && c[amountField] !== undefined) {
    if (toNumber(c[amountField]) === null) {
      issues.push({ rowNo, severity: 'ERROR', message: `"${c[amountField]}" is not a number (${amountField}).` });
    }
  }

  if (!batchProject && !toText(c.project_code)) {
    issues.push({ rowNo, severity: 'ERROR', message: 'No project on the row and none chosen for the file.' });
  }

  if (module === 'ACTUAL' || module === 'COMMITMENT') {
    const fromPostingDate = toDate(c.posting_date)?.slice(0, 7) ?? null;
    const period = toPeriod(c.period_key) ?? fromPostingDate ?? batchPeriod;
    if (!period) {
      issues.push({ rowNo, severity: 'ERROR', message: 'Period could not be determined (no period, no posting date, none set for the file).' });
    }
  }
  return issues;
}

/**
 * Read the file, apply the column mapping, validate every row and write the
 * result to staging. Nothing reaches the fact tables until postBatch() is called,
 * so the user can review the outcome first.
 */
export async function stageFile(req: StageRequest, importedBy: string | null): Promise<StageResult> {
  const db = getDb();

  const duplicate = db.prepare(
    `SELECT import_batch_id, data_date FROM import_batch
     WHERE file_hash = ? AND status IN ('STAGED','POSTED') ORDER BY import_batch_id DESC LIMIT 1`,
  ).get(req.fileHash) as { import_batch_id: number; data_date: string } | undefined;

  const { rows } = await readSheetRows(req.filePath, req.sheetName, req.headerRow);

  const info = db.prepare(`
    INSERT INTO import_batch
      (report_definition_id, module, data_date, period_key, project_key, file_name, file_path,
       file_hash, file_size, sheet_name, status, row_count_file, imported_by, notes)
    VALUES (@rd, @module, @dataDate, @periodKey, @projectKey, @fileName, @filePath,
            @fileHash, @fileSize, @sheetName, 'STAGED', @rowCount, @importedBy, @notes)`)
    .run({
      rd: req.reportDefinitionId, module: req.module, dataDate: req.dataDate,
      periodKey: req.periodKey, projectKey: req.projectKey, fileName: req.fileName,
      filePath: req.filePath, fileHash: req.fileHash, fileSize: req.fileSize,
      sheetName: req.sheetName, rowCount: rows.length, importedBy,
      notes: duplicate
        ? `${req.notes ?? ''}\nNOTE: same file content was already imported as batch ${duplicate.import_batch_id} (data date ${duplicate.data_date}).`.trim()
        : req.notes,
    });
  const batchId = Number(info.lastInsertRowid);

  const insStg = db.prepare(
    `INSERT INTO stg_row (import_batch_id, row_no, raw_json, status, message) VALUES (?,?,?,?,?)`);

  // A detail-key rule can only be judged on fields the file actually supplies.
  // Without this, a report whose key column is missing would have every row read
  // as a subtotal and nothing would import.
  const mappedFields = new Set(req.mapping.filter((m) => m.source_column).map((m) => m.target_field));
  const detailKeyFields = (req.detailKeyFields ?? loadDetailKeyFields(req.reportDefinitionId))
    .filter((f) => mappedFields.has(f));

  const issues: ValidationIssue[] = [];
  let valid = 0, warn = 0, error = 0, skipped = 0, amountTotal = 0;
  const unresolvedWbs = new Set<string>();
  const unresolvedCe = new Set<string>();

  const amountField = AMOUNT_FIELD[req.module];

  const write = db.transaction(() => {
    rows.forEach((raw, i) => {
      const rowNo = i + 1;
      const mapped = applyMapping(raw, req.mapping);

      if (isSubtotalRow(mapped, detailKeyFields)) {
        skipped++;
        insStg.run(batchId, rowNo, JSON.stringify({ raw, mapped }), 'SKIPPED',
          `Subtotal or non-data row: ${detailKeyFields.join(', ')} empty.`);
        return;
      }

      const rowIssues = validateRow(req.module, mapped, rowNo, req.periodKey, req.projectKey);
      const hasError = rowIssues.some((x) => x.severity === 'ERROR');

      if (hasError) error++; else valid++;
      if (rowIssues.some((x) => x.severity === 'WARN')) warn++;
      if (!hasError && amountField) amountTotal += toNumber(mapped[amountField]) ?? 0;

      const wbs = toText(mapped.wbs_code);
      if (wbs) unresolvedWbs.add(wbs);
      const ce = toText(mapped.cost_element_code);
      if (ce) unresolvedCe.add(ce);

      if (rowIssues.length && issues.length < 500) issues.push(...rowIssues);

      insStg.run(batchId, rowNo, JSON.stringify({ raw, mapped }),
        hasError ? 'ERROR' : 'VALID',
        rowIssues.map((x) => x.message).join(' ') || null);
    });

    db.prepare(`UPDATE import_batch
                SET row_count_rejected = ?, row_count_skipped = ?, amount_total = ?,
                    status = 'MAPPED'
                WHERE import_batch_id = ?`)
      .run(error, skipped, amountTotal, batchId);

    if (req.saveMapping) saveColumnMapping(req.reportDefinitionId, req.mapping);
  });
  write();

  // Report which codes are new to the warehouse, so the user knows what will be created.
  const newWbs = filterUnknown([...unresolvedWbs], 'SELECT 1 FROM dim_wbs WHERE wbs_code = ?');
  const newCe = filterUnknown([...unresolvedCe], 'SELECT 1 FROM dim_cost_element WHERE cost_element_code = ?');

  return {
    importBatchId: batchId,
    rowCount: rows.length,
    validCount: valid,
    warnCount: warn,
    errorCount: error,
    skippedCount: skipped,
    amountTotal,
    issues: issues.slice(0, 200),
    unresolved: [
      { dimension: 'WBS', values: newWbs.slice(0, 100) },
      { dimension: 'COST_ELEMENT', values: newCe.slice(0, 100) },
    ].filter((u) => u.values.length > 0),
  };
}

/** The report's declared detail-key fields, used to recognise subtotal rows. */
export function loadDetailKeyFields(reportDefinitionId: number): string[] {
  const row = getDb().prepare('SELECT detail_key_fields FROM report_definition WHERE report_definition_id = ?')
    .get(reportDefinitionId) as { detail_key_fields: string } | undefined;
  if (!row?.detail_key_fields) return [];
  try {
    const parsed = JSON.parse(row.detail_key_fields);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function filterUnknown(values: string[], sql: string): string[] {
  const stmt = getDb().prepare(sql);
  return values.filter((v) => !stmt.get(v));
}

export function saveColumnMapping(reportDefinitionId: number, mapping: ColumnMappingEntry[]): void {
  const db = getDb();
  const run = db.transaction(() => {
    db.prepare('DELETE FROM column_mapping WHERE report_definition_id = ?').run(reportDefinitionId);
    const ins = db.prepare(`INSERT INTO column_mapping
      (report_definition_id, source_column, target_field, transform, default_value)
      VALUES (?,?,?,?,?)`);
    for (const m of mapping) {
      if (!m.source_column && m.default_value == null) continue;
      ins.run(reportDefinitionId, m.source_column ?? '', m.target_field, m.transform ?? null, m.default_value ?? null);
    }
  });
  run();
}

export function loadColumnMapping(reportDefinitionId: number): ColumnMappingEntry[] {
  return getDb().prepare(
    `SELECT target_field, source_column, transform, default_value
     FROM column_mapping WHERE report_definition_id = ?`,
  ).all(reportDefinitionId) as ColumnMappingEntry[];
}

// ---------------------------------------------------------------------------
// Dimension resolution — codes seen in a file are created on first sight.
// ---------------------------------------------------------------------------

class DimCache {
  private readonly revenue = revenueAccountPattern();
  private project = new Map<string, number>();
  private wbs = new Map<string, number>();
  private costElement = new Map<string, number>();
  private vendor = new Map<string, number>();
  private currency = new Map<string, number>();

  projectKey(code: string, name?: string | null): number {
    const hit = this.project.get(code);
    if (hit) return hit;
    const db = getDb();
    const row = db.prepare('SELECT project_key FROM dim_project WHERE project_code = ?').get(code) as any;
    const key = row?.project_key ?? Number(
      db.prepare('INSERT INTO dim_project (project_code, project_name) VALUES (?,?)')
        .run(code, name || code).lastInsertRowid);
    this.project.set(code, key);
    return key;
  }

  wbsKey(projectKey: number, code: string, extra: Partial<Record<string, string | null>>): number {
    const ck = `${projectKey}|${code}`;
    const hit = this.wbs.get(ck);
    if (hit) return hit;
    const db = getDb();
    const row = db.prepare('SELECT wbs_key FROM dim_wbs WHERE project_key = ? AND wbs_code = ?')
      .get(projectKey, code) as any;
    let key: number;
    if (row) {
      key = row.wbs_key;
      // Backfill descriptive attributes if the first sighting had none.
      db.prepare(`UPDATE dim_wbs SET
                    wbs_name = COALESCE(NULLIF(wbs_name, wbs_code), ?, wbs_name),
                    discipline = COALESCE(discipline, ?),
                    package = COALESCE(package, ?),
                    csi_code = COALESCE(csi_code, ?)
                  WHERE wbs_key = ?`)
        .run(extra.wbs_name ?? null, extra.discipline ?? null, extra.package ?? null, extra.csi_code ?? null, key);
    } else {
      key = Number(db.prepare(`INSERT INTO dim_wbs
        (project_key, wbs_code, wbs_name, wbs_level, wbs_path, discipline, package, csi_code)
        VALUES (?,?,?,?,?,?,?,?)`)
        .run(projectKey, code, extra.wbs_name || code, code.split(/[.\-/]/).length,
          `/${code}/`, extra.discipline ?? null, extra.package ?? null, extra.csi_code ?? null)
        .lastInsertRowid);
    }
    this.wbs.set(ck, key);
    return key;
  }

  costElementKey(code: string, name?: string | null, costType?: unknown): number | null {
    if (!code) return null;
    const hit = this.costElement.get(code);
    if (hit) return hit;
    const db = getDb();
    const row = db.prepare('SELECT cost_element_key FROM dim_cost_element WHERE cost_element_code = ?')
      .get(code) as any;
    const nature = classifyNature(code, name, this.revenue);
    // A column such as SAP's "Object Type" reads as a cost type but says nothing
    // useful, so a vague OTHER never beats what the account range tells us.
    const stated = normaliseCostType(costType);
    const type = nature === 'REVENUE'
      ? null
      : (stated && stated !== 'OTHER' ? stated : costTypeFromCode(code) ?? stated);
    const key = row?.cost_element_key ?? Number(
      db.prepare(`INSERT INTO dim_cost_element
        (cost_element_code, cost_element_name, cost_type, posting_nature) VALUES (?,?,?,?)`)
        .run(code, name || code, type, nature).lastInsertRowid);
    if (row) {
      db.prepare(`UPDATE dim_cost_element
                  SET cost_element_name = COALESCE(NULLIF(cost_element_name, cost_element_code), ?, cost_element_name),
                      cost_type = COALESCE(cost_type, ?),
                      posting_nature = ?
                  WHERE cost_element_key = ?`)
        .run(name ?? null, type, nature, key);
    }
    this.costElement.set(code, key);
    return key;
  }

  vendorKey(code: string | null, name: string | null): number | null {
    const c = code || name;
    if (!c) return null;
    const hit = this.vendor.get(c);
    if (hit) return hit;
    const db = getDb();
    const row = db.prepare('SELECT vendor_key FROM dim_vendor WHERE vendor_code = ?').get(c) as any;
    const key = row?.vendor_key ?? Number(
      db.prepare('INSERT INTO dim_vendor (vendor_code, vendor_name) VALUES (?,?)')
        .run(c, name || c).lastInsertRowid);
    this.vendor.set(c, key);
    return key;
  }

  currencyKey(iso: string | null): number | null {
    if (!iso) return null;
    const code = iso.toUpperCase();
    const hit = this.currency.get(code);
    if (hit) return hit;
    const db = getDb();
    const row = db.prepare('SELECT currency_key FROM dim_currency WHERE iso_code = ?').get(code) as any;
    const key = row?.currency_key ?? Number(
      db.prepare('INSERT INTO dim_currency (iso_code, name) VALUES (?,?)').run(code, code).lastInsertRowid);
    this.currency.set(code, key);
    return key;
  }
}

const COST_TYPES = ['LABOR', 'MATERIAL', 'SUBCONTRACT', 'EQUIPMENT', 'INDIRECT', 'OTHER'];

function normaliseCostType(v: unknown): string | null {
  const s = toText(v);
  if (!s) return null;
  const u = s.toUpperCase();
  if (COST_TYPES.includes(u)) return u;
  if (/LAB|MANPOWER|STAFF|SALAR|WAGE/.test(u)) return 'LABOR';
  if (/MAT|SUPPL|PROCURE/.test(u)) return 'MATERIAL';
  if (/SUB|CONTRACT/.test(u)) return 'SUBCONTRACT';
  if (/EQUIP|PLANT|MACHIN|RENTAL/.test(u)) return 'EQUIPMENT';
  if (/INDIRECT|OVERHEAD|GENERAL|PRELIM/.test(u)) return 'INDIRECT';
  return 'OTHER';
}

/** Default account pattern for income, matching the usual SAP operating chart. */
export const DEFAULT_REVENUE_ACCOUNT_PATTERN = '^4';

/**
 * The account pattern that marks a cost element as income.
 *
 * Chart of accounts differ between installations, so this is a setting rather
 * than a constant. Settings › Cost classification exposes it.
 */
export function revenueAccountPattern(): RegExp {
  const row = getDb().prepare("SELECT value FROM app_setting WHERE key = 'revenue_account_pattern'")
    .get() as { value: string } | undefined;
  try {
    return new RegExp(row?.value || DEFAULT_REVENUE_ACCOUNT_PATTERN);
  } catch {
    return new RegExp(DEFAULT_REVENUE_ACCOUNT_PATTERN);
  }
}

/**
 * Cost or revenue?
 *
 * A CJI3 export contains both, with income posted as a negative amount, so
 * treating the file total as "actual cost" understates cost by the revenue
 * billed. Marking the cost element is what lets `v_actual` hold cost alone.
 */
function classifyNature(code: string, name: string | null | undefined, revenue: RegExp): 'COST' | 'REVENUE' {
  if (revenue.test(code)) return 'REVENUE';
  if (name && /\b(income|revenue|billing|turnover|sales)\b/i.test(name)) return 'REVENUE';
  return 'COST';
}

/** Cost type inferred from the SAP account range when the file does not say. */
function costTypeFromCode(code: string): string | null {
  if (/^301/.test(code)) return 'EQUIPMENT';   // equipment rent, spares, fuel, in-house plant
  if (/^302/.test(code)) return 'MATERIAL';    // main and consumable material
  if (/^303/.test(code)) return 'LABOR';       // salaries and wages
  if (/^305/.test(code)) return 'SUBCONTRACT'; // subcontractor cost, casual labour
  if (/^30[467]/.test(code)) return 'INDIRECT';// site overheads, fees, charges
  if (/^3/.test(code)) return 'OTHER';
  return null;
}

function ensurePeriod(periodKey: string): string {
  const db = getDb();
  const exists = db.prepare('SELECT 1 FROM dim_period WHERE period_key = ?').get(periodKey);
  if (!exists) {
    const [y, m] = periodKey.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    db.prepare(`INSERT INTO dim_period
      (period_key, year_no, month_no, quarter_no, label, start_date, end_date, period_index)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(periodKey, y, m, Math.ceil(m / 3), periodKey,
        `${periodKey}-01`, `${periodKey}-${String(lastDay).padStart(2, '0')}`, y * 12 + m);
  }
  return periodKey;
}

/**
 * Move a staged batch into the fact tables.
 *
 * Any earlier POSTED batch from the same report covering the same project and
 * period is marked SUPERSEDED — the reporting views only read POSTED batches, so
 * re-uploading a refreshed extract replaces the old numbers instead of doubling
 * them, while the superseded rows stay in the database for audit.
 */
export function postBatch(batchId: number): PostResult {
  const db = getDb();
  const batch = db.prepare('SELECT * FROM import_batch WHERE import_batch_id = ?').get(batchId) as any;
  if (!batch) throw new Error(`Batch ${batchId} not found.`);
  if (batch.status === 'POSTED') throw new Error(`Batch ${batchId} is already posted.`);

  // Only VALID rows post. ERROR rows failed validation and SKIPPED rows are the
  // report's own subtotals — posting either would corrupt the numbers.
  const staged = db.prepare(
    `SELECT stg_row_id, row_no, raw_json FROM stg_row
     WHERE import_batch_id = ? AND status = 'VALID' ORDER BY row_no`).all(batchId) as any[];

  const dims = new DimCache();
  let posted = 0;
  const rejected = db.prepare(
    `SELECT COUNT(*) AS n FROM stg_row WHERE import_batch_id = ? AND status = 'ERROR'`)
    .get(batchId) as { n: number };

  const run = db.transaction(() => {
    for (const s of staged) {
      const { mapped } = JSON.parse(s.raw_json) as { mapped: Canonical };

      const projectCode = toText(mapped.project_code);
      const projectKey = batch.project_key
        ?? (projectCode ? dims.projectKey(projectCode) : null);
      if (!projectKey) continue;

      const wbsCode = toText(mapped.wbs_code);
      const wbsKey = wbsCode
        ? dims.wbsKey(projectKey, wbsCode, {
            wbs_name: toText(mapped.wbs_name),
            discipline: toText(mapped.discipline),
            package: toText(mapped.package),
            csi_code: toText(mapped.csi_code),
          })
        : null;

      const ceKey = dims.costElementKey(
        toText(mapped.cost_element_code) ?? '',
        toText(mapped.cost_element_name),
        mapped.cost_type);
      const currencyKey = dims.currencyKey(toText(mapped.currency_code));

      if (batch.module === 'ACTUAL' || batch.module === 'COMMITMENT') {
        const postingDate = toDate(mapped.posting_date);
        const docDate = toDate(mapped.document_date);
        const period = ensurePeriod(
          toPeriod(mapped.period_key) ?? postingDate?.slice(0, 7) ?? batch.period_key);

        db.prepare(`INSERT INTO fact_actual
          (import_batch_id, project_key, wbs_key, cost_element_key, vendor_key, currency_key,
           posting_date_key, document_date_key, period_key, document_no, document_type,
           reference_no, po_no, description, quantity, uom, amount, source_row_no)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          batchId, projectKey, wbsKey, ceKey,
          dims.vendorKey(toText(mapped.vendor_code), toText(mapped.vendor_name)), currencyKey,
          postingDate ? Number(postingDate.replace(/-/g, '')) : null,
          docDate ? Number(docDate.replace(/-/g, '')) : null,
          period,
          toText(mapped.document_no), toText(mapped.document_type),
          toText(mapped.reference_no), toText(mapped.po_no),
          toText(mapped.description), toNumber(mapped.quantity), toText(mapped.uom),
          toNumber(mapped.amount) ?? 0, s.row_no);
        posted++;
      } else if (batch.module === 'BUDGET') {
        const scenarioKey = ensureScenario(projectKey, 'BUDGET', batch.data_date);
        const period = toPeriod(mapped.period_key) ?? batch.period_key;
        if (period) ensurePeriod(period);
        db.prepare(`INSERT INTO fact_budget
          (import_batch_id, scenario_key, project_key, wbs_key, cost_element_key, currency_key,
           period_key, budget_quantity, uom, unit_rate, budget_amount, description, source_row_no)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          batchId, scenarioKey, projectKey, wbsKey, ceKey, currencyKey, period,
          toNumber(mapped.budget_quantity), toText(mapped.uom), toNumber(mapped.unit_rate),
          toNumber(mapped.budget_amount) ?? 0, toText(mapped.description), s.row_no);
        posted++;
      } else if (batch.module === 'SERVICE') {
        const certDate = toDate(mapped.invoice_date);
        const period = toPeriod(mapped.period_key) ?? certDate?.slice(0, 7) ?? batch.period_key;
        if (period) ensurePeriod(period);
        db.prepare(`INSERT INTO fact_service_line
          (import_batch_id, project_key, wbs_key, cost_element_key, vendor_key, currency_key,
           period_key, po_no, invoice_no, entry_sheet_no, invoice_serial, invoice_date_key,
           item_no, line_no, service_code, service_text, category, contract_type, uom,
           unit_rate, quantity_total, quantity_previous, quantity_current, progress_pct,
           amount_net, amount_vat, amount_gross, source_row_no)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          batchId, projectKey, wbsKey, ceKey,
          dims.vendorKey(toText(mapped.vendor_code), toText(mapped.vendor_name)), currencyKey,
          period, toText(mapped.po_no), toText(mapped.invoice_no), toText(mapped.entry_sheet_no),
          toText(mapped.invoice_serial), certDate ? Number(certDate.replace(/-/g, '')) : null,
          toText(mapped.item_no), toText(mapped.line_no), toText(mapped.service_code),
          toText(mapped.service_text), toText(mapped.category), toText(mapped.contract_type),
          toText(mapped.uom), toNumber(mapped.unit_rate), toNumber(mapped.quantity_total),
          toNumber(mapped.quantity_previous), toNumber(mapped.quantity_current),
          toNumber(mapped.progress_pct), toNumber(mapped.amount_net) ?? 0,
          toNumber(mapped.amount_vat), toNumber(mapped.amount_gross), s.row_no);
        posted++;
      } else if (batch.module === 'MASTER') {
        // Handled after the row loop, because the hierarchy needs the whole file.
      } else if (batch.module === 'FORECAST') {
        const scenarioKey = ensureScenario(projectKey, 'FORECAST', batch.data_date);
        const period = toPeriod(mapped.period_key) ?? batch.period_key;
        if (period) ensurePeriod(period);
        db.prepare(`INSERT INTO fact_forecast
          (import_batch_id, scenario_key, project_key, wbs_key, cost_element_key, currency_key,
           period_key, forecast_amount, etc_amount, eac_amount, committed_amount,
           forecast_method, description, source_row_no)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          batchId, scenarioKey, projectKey, wbsKey, ceKey, currencyKey, period,
          toNumber(mapped.forecast_amount) ?? 0, toNumber(mapped.etc_amount),
          toNumber(mapped.eac_amount), toNumber(mapped.committed_amount),
          toText(mapped.forecast_method), toText(mapped.description), s.row_no);
        posted++;
      }
    }

    if (batch.module === 'MASTER') {
      posted = postWbsMaster(batchId, batch, staged);
    }

    supersedePrevious(batchId, batch);

    db.prepare(`UPDATE import_batch
                SET status = 'POSTED', posted_at = datetime('now'), row_count_posted = ?
                WHERE import_batch_id = ?`).run(posted, batchId);
    db.prepare(`UPDATE stg_row SET status = 'POSTED' WHERE import_batch_id = ? AND status = 'VALID'`)
      .run(batchId);
  });
  run();

  return { importBatchId: batchId, posted, rejected: rejected.n };
}

/**
 * Rebuild the cost breakdown structure from a project structure export.
 *
 * The file gives a level per row and lists rows in outline order, so the parent
 * of a row is the nearest row above it one level shallower. That yields
 * parent_wbs_key, wbs_level, a materialised wbs_path and the leaf flag — which is
 * what makes a rollup a single indexed prefix match instead of a recursive query.
 *
 * This updates dimension rows rather than writing facts, so it is idempotent: a
 * re-issued structure re-parents and renames in place and existing postings keep
 * pointing at the same wbs_key.
 */
function postWbsMaster(batchId: number, batch: any, staged: any[]): number {
  const db = getDb();
  const projectKey: number | null = batch.project_key;
  if (!projectKey) throw new Error('A WBS structure import needs a project selected for the file.');

  interface Node { code: string; name: string | null; level: number; key: number;
                   path: string; parent: number | null }
  const stack: Node[] = [];
  let written = 0;

  for (const s of staged) {
    const { mapped } = JSON.parse(s.raw_json) as { mapped: Canonical };
    const code = toText(mapped.wbs_code);
    if (!code) continue;

    // Fall back to the code's own punctuation depth when the file has no level.
    const declared = toNumber(mapped.wbs_level);
    const level = declared === null ? code.split(/[.\-/]/).length - 1 : declared;

    while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
    const parent = stack.length > 0 ? stack[stack.length - 1] : null;

    // The root of an SAP structure export is often repeated at level 00 and 01.
    if (parent && parent.code === code) continue;

    const existing = db.prepare('SELECT wbs_key FROM dim_wbs WHERE project_key = ? AND wbs_code = ?')
      .get(projectKey, code) as any;

    const name = toText(mapped.wbs_name) ?? code;
    const path = `${parent ? parent.path : '/'}${code}/`;
    const attrs = [name, parent?.key ?? null, level, path,
      toDate(mapped.planned_start), toDate(mapped.planned_finish),
      toDate(mapped.actual_start), toDate(mapped.actual_finish),
      toText(mapped.discipline), toText(mapped.package), written];

    let key: number;
    if (existing) {
      key = existing.wbs_key;
      db.prepare(`UPDATE dim_wbs SET
          wbs_name = ?, parent_wbs_key = ?, wbs_level = ?, wbs_path = ?,
          planned_start = ?, planned_finish = ?, actual_start = ?, actual_finish = ?,
          discipline = COALESCE(?, discipline), package = COALESCE(?, package),
          sort_order = ?
        WHERE wbs_key = ?`).run(...attrs, key);
    } else {
      key = Number(db.prepare(`INSERT INTO dim_wbs
        (project_key, wbs_code, wbs_name, parent_wbs_key, wbs_level, wbs_path,
         planned_start, planned_finish, actual_start, actual_finish,
         discipline, package, sort_order)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(projectKey, code, ...attrs).lastInsertRowid);
    }

    stack.push({ code, name, level, key, path, parent: parent?.key ?? null });
    written++;
  }

  // A node is a leaf when nothing in this project names it as a parent.
  db.prepare(`UPDATE dim_wbs SET is_leaf =
      CASE WHEN EXISTS (SELECT 1 FROM dim_wbs c WHERE c.parent_wbs_key = dim_wbs.wbs_key)
           THEN 0 ELSE 1 END
    WHERE project_key = ?`).run(projectKey);

  db.prepare(`UPDATE stg_row SET status = 'POSTED' WHERE import_batch_id = ? AND status = 'VALID'`)
    .run(batchId);
  return written;
}

function supersedePrevious(batchId: number, batch: any): void {
  const db = getDb();
  db.prepare(`UPDATE import_batch
              SET status = 'SUPERSEDED', superseded_by = @new
              WHERE import_batch_id <> @new
                AND status = 'POSTED'
                AND report_definition_id = @rd
                AND module = @module
                AND IFNULL(period_key,'~') = IFNULL(@period,'~')
                AND IFNULL(project_key,-1) = IFNULL(@project,-1)`)
    .run({ new: batchId, rd: batch.report_definition_id, module: batch.module,
           period: batch.period_key, project: batch.project_key });
}

/**
 * Every budget/forecast upload becomes a new version, and the newest one is the
 * current version used by the reporting views.
 */
function ensureScenario(projectKey: number, type: 'BUDGET' | 'FORECAST', dataDate: string): number {
  const db = getDb();
  const code = `${type}-${dataDate}`;
  const existing = db.prepare('SELECT scenario_key FROM dim_scenario WHERE project_key = ? AND scenario_code = ?')
    .get(projectKey, code) as any;
  if (existing) return existing.scenario_key;

  const next = db.prepare(
    'SELECT COALESCE(MAX(version_no),0) + 1 AS v FROM dim_scenario WHERE project_key = ? AND scenario_type = ?')
    .get(projectKey, type) as { v: number };

  db.prepare('UPDATE dim_scenario SET is_current = 0 WHERE project_key = ? AND scenario_type = ?')
    .run(projectKey, type);

  return Number(db.prepare(`INSERT INTO dim_scenario
    (project_key, scenario_code, scenario_name, scenario_type, version_no, data_date, is_current, is_baseline)
    VALUES (?,?,?,?,?,?,1,?)`)
    .run(projectKey, code, `${type === 'BUDGET' ? 'Budget' : 'Forecast'} v${next.v} (${dataDate})`,
      type, next.v, dataDate, next.v === 1 && type === 'BUDGET' ? 1 : 0)
    .lastInsertRowid);
}

/** Discard a batch and everything it produced. Only unposted batches can be deleted outright. */
export function deleteBatch(batchId: number): void {
  const db = getDb();
  const run = db.transaction(() => {
    db.prepare('DELETE FROM fact_actual WHERE import_batch_id = ?').run(batchId);
    db.prepare('DELETE FROM fact_budget WHERE import_batch_id = ?').run(batchId);
    db.prepare('DELETE FROM fact_forecast WHERE import_batch_id = ?').run(batchId);
    db.prepare('DELETE FROM fact_service_line WHERE import_batch_id = ?').run(batchId);
    db.prepare('DELETE FROM stg_row WHERE import_batch_id = ?').run(batchId);
    db.prepare('UPDATE import_batch SET superseded_by = NULL WHERE superseded_by = ?').run(batchId);
    db.prepare('DELETE FROM import_batch WHERE import_batch_id = ?').run(batchId);
  });
  run();
}
