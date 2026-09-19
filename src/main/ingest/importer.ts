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
  // wbs_code is deliberately not required here: a line still sitting on a cost
  // centre (category = CTR) has no WBS yet and is still a real, valid row.
  ORDER: ['order_no', 'amount'],
};

const AMOUNT_FIELD: Record<string, string> = {
  ACTUAL: 'amount', BUDGET: 'budget_amount', FORECAST: 'forecast_amount',
  COMMITMENT: 'amount', SERVICE: 'amount_net', MASTER: '', ORDER: 'amount',
};

/**
 * The fields that identify one row of source data, per module.
 *
 * A CO line item is keyed by document number + posting row + fiscal year, which
 * is SAP's own key (BELNR + BUZEI + GJAHR); a subcontractor service line by
 * PO + invoice + item + line. Holding that identity makes re-import an upsert, so
 * two extracts that overlap — a report split by month, or re-run over a wider
 * period — merge instead of accumulating.
 */
const NATURAL_KEY: Record<string, string[]> = {
  ACTUAL: ['document_no', 'document_line', 'fiscal_year'],
  COMMITMENT: ['document_no', 'document_line', 'fiscal_year'],
  SERVICE: ['po_no', 'invoice_no', 'item_no', 'line_no'],
  // Budget and forecast arrive as whole versions, not amendable lines, and master
  // data writes dimensions. Those keep batch-level replacement.
  BUDGET: [],
  FORECAST: [],
  MASTER: [],
  // No column in an order-detail export identifies a line uniquely — two
  // genuinely different postings can share order, cost element and period —
  // so this also keeps batch-level replacement rather than trust a false key.
  ORDER: [],
};

/**
 * Build the line identity for a row, scoped to its project so two projects can
 * never collide. Returns null when no key field carries a value.
 */
function lineUid(module: string, projectKey: number | null, c: Canonical,
                 available: string[]): string | null {
  if (available.length === 0) return null;
  const parts = available.map((f) => toText(c[f]) ?? '');
  if (parts.every((p) => p === '')) return null;
  return [module === 'COMMITMENT' ? 'ACTUAL' : module, projectKey ?? 0, ...parts].join('\u0001');
}

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
    `SELECT import_batch_id, file_name, data_date, status FROM import_batch
     WHERE file_hash = ? AND status IN ('STAGED','MAPPED','POSTED')
     ORDER BY import_batch_id DESC LIMIT 1`,
  ).get(req.fileHash) as
    { import_batch_id: number; file_name: string; data_date: string; status: string } | undefined;

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

  // The identity fields this file actually supplies.
  const keyFields = (NATURAL_KEY[req.module] ?? []).filter((f) => mappedFields.has(f));

  const issues: ValidationIssue[] = [];
  let valid = 0, warn = 0, error = 0, skipped = 0, amountTotal = 0;
  const unresolvedWbs = new Set<string>();
  const unresolvedCe = new Set<string>();
  const seenUids = new Map<string, number>();

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

      if (!hasError) {
        const uid = lineUid(req.module, req.projectKey, mapped, keyFields);
        if (uid) {
          seenUids.set(uid, (seenUids.get(uid) ?? 0) + 1);
          mapped.__line_uid = uid;
        }
      }

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

  const duplicateKeys = duplicateUidCount(batchId);
  const keyUsable = keyFields.length > 0 && seenUids.size > 0 && duplicateKeys === 0;
  const expectedKey = NATURAL_KEY[req.module] ?? [];

  if (expectedKey.length > 0 && !keyUsable) {
    issues.unshift({
      rowNo: 0,
      severity: 'WARN',
      message: duplicateKeys > 0
        ? `The line identity (${keyFields.join(' + ')}) repeats on ${duplicateKeys} row(s), so it `
          + 'cannot tell one posting from another. Rows will be added without duplicate protection — '
          + `map the remaining identity columns (${expectedKey.join(', ')}) to enable it.`
        : `No line identity available: map ${expectedKey.join(', ')} so that re-importing an `
          + 'overlapping extract replaces these rows instead of adding to them.',
    });
  }

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
    duplicateOf: duplicate
      ? { importBatchId: duplicate.import_batch_id, fileName: duplicate.file_name,
          dataDate: duplicate.data_date, status: duplicate.status }
      : null,
    lineKey: {
      expected: expectedKey,
      used: keyFields,
      usable: keyUsable,
      duplicatesInFile: duplicateKeys,
      /** Rows already in the warehouse that this file will replace rather than add. */
      willReplace: keyUsable ? countExistingUids(batchId, req.module) : 0,
    },
    unresolved: [
      { dimension: 'WBS', values: newWbs.slice(0, 100) },
      { dimension: 'COST_ELEMENT', values: newCe.slice(0, 100) },
    ].filter((u) => u.values.length > 0),
  };
}

/**
 * How many line identities repeat inside one batch.
 *
 * A key that repeats does not identify a line, so it must not be used to
 * deduplicate — doing so would silently drop real rows. Reading it back out of
 * staging keeps stage and post to one definition.
 */
export function duplicateUidCount(batchId: number): number {
  const row = getDb().prepare(`
    SELECT COALESCE(SUM(n - 1), 0) AS extra FROM (
      SELECT COUNT(*) AS n FROM stg_row
      WHERE import_batch_id = ? AND status IN ('VALID','POSTED')
        AND json_extract(raw_json, '$.mapped.__line_uid') IS NOT NULL
      GROUP BY json_extract(raw_json, '$.mapped.__line_uid')
    )`).get(batchId) as { extra: number };
  return row.extra;
}

/** Whether a batch carries usable line identities at all. */
export function hasLineKeys(batchId: number): boolean {
  const row = getDb().prepare(`
    SELECT COUNT(*) AS n FROM stg_row
    WHERE import_batch_id = ? AND status IN ('VALID','POSTED')
      AND json_extract(raw_json, '$.mapped.__line_uid') IS NOT NULL`)
    .get(batchId) as { n: number };
  return row.n > 0;
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

const FACT_FOR_UPSERT: Record<string, string> = {
  ACTUAL: 'fact_actual', COMMITMENT: 'fact_actual', SERVICE: 'fact_service_line',
};

/** How many of a staged batch's lines already exist in the warehouse. */
function countExistingUids(batchId: number, module: string): number {
  const table = FACT_FOR_UPSERT[module];
  if (!table) return 0;
  const row = getDb().prepare(`
    SELECT COUNT(*) AS n FROM stg_row s
    JOIN ${table} f ON f.line_uid = json_extract(s.raw_json, '$.mapped.__line_uid')
    WHERE s.import_batch_id = ? AND s.status = 'VALID'`).get(batchId) as { n: number };
  return row.n;
}

/** A different batch, already posted, holding byte-identical file content. */
export function findPostedDuplicate(batchId: number, fileHash: string | null):
  { import_batch_id: number; file_name: string; data_date: string; posted_at: string | null } | undefined {
  if (!fileHash) return undefined;
  return getDb().prepare(
    `SELECT import_batch_id, file_name, data_date, posted_at FROM import_batch
     WHERE file_hash = ? AND status = 'POSTED' AND import_batch_id <> ?
     ORDER BY import_batch_id DESC LIMIT 1`)
    .get(fileHash, batchId) as any;
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
    // Cost type is no longer decided here. It is resolved per posting row by
    // cost_type_rule inside v_posting (migration 007), so it can depend on the
    // document type — which lives on the fact, not on the cost element — and so
    // that correcting a rule fixes history instead of only the next import.
    //
    // The dimension keeps only what the source file itself stated, which still
    // outranks a rule. A column such as SAP's "Object Type" reads as a cost type
    // but says nothing useful, so a vague OTHER is stored without winning: the
    // view treats it as "no answer" and falls through to the rules.
    const stated = normaliseCostType(costType);
    const type = nature === 'REVENUE' ? null : stated;
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
export function postBatch(batchId: number, options: { allowDuplicate?: boolean } = {}): PostResult {
  const db = getDb();
  const batch = db.prepare('SELECT * FROM import_batch WHERE import_batch_id = ?').get(batchId) as any;
  if (!batch) throw new Error(`Batch ${batchId} not found.`);
  if (batch.status === 'POSTED') throw new Error(`Batch ${batchId} is already posted.`);

  // Byte-identical re-upload. Superseding would handle the arithmetic, but a
  // second copy of the same file is nearly always a mistake, so it is refused
  // outright unless the user says otherwise.
  // Without a line identity a second copy of the same file really would double
  // the cost, so it is refused. With one, re-posting simply rewrites the same
  // lines and is harmless, so it is allowed through.
  if (!options.allowDuplicate && !(hasLineKeys(batchId) && duplicateUidCount(batchId) === 0)) {
    const twin = findPostedDuplicate(batchId, batch.file_hash);
    if (twin) {
      throw new Error(
        `This is the same file as batch #${twin.import_batch_id} ("${twin.file_name}", ` +
        `data date ${twin.data_date}), which is already posted, and it carries no line identity ` +
        'to merge on. Posting it again would count the same cost twice. Delete that batch first, ' +
        'or confirm posting anyway.');
    }
  }

  // Only VALID rows post. ERROR rows failed validation and SKIPPED rows are the
  // report's own subtotals — posting either would corrupt the numbers.
  const staged = db.prepare(
    `SELECT stg_row_id, row_no, raw_json FROM stg_row
     WHERE import_batch_id = ? AND status = 'VALID' ORDER BY row_no`).all(batchId) as any[];

  // Line identity is only trusted when it actually distinguishes the rows.
  const useLineKeys = hasLineKeys(batchId) && duplicateUidCount(batchId) === 0;

  const dims = new DimCache();
  let posted = 0;
  let replaced = 0;
  const rejected = db.prepare(
    `SELECT COUNT(*) AS n FROM stg_row WHERE import_batch_id = ? AND status = 'ERROR'`)
    .get(batchId) as { n: number };

  const existsActual = db.prepare('SELECT 1 FROM fact_actual WHERE line_uid = ?');
  const existsService = db.prepare('SELECT 1 FROM fact_service_line WHERE line_uid = ?');

  // ON CONFLICT on line_uid turns a re-import into a replacement of that exact
  // line. A NULL uid never conflicts, so keyless rows still simply insert.
  const upsertActual = db.prepare(`INSERT INTO fact_actual
    (import_batch_id, project_key, wbs_key, cost_element_key, vendor_key, currency_key,
     posting_date_key, document_date_key, period_key, document_no, document_line, document_type,
     reference_no, po_no, fiscal_year, description, quantity, uom, amount, source_row_no, line_uid,
     partner_object_type, partner_object, partner_object_name)
    VALUES (@batch, @project, @wbs, @ce, @vendor, @currency, @postingDateKey, @docDateKey,
            @period, @documentNo, @documentLine, @documentType, @referenceNo, @poNo, @fiscalYear,
            @description, @quantity, @uom, @amount, @rowNo, @uid,
            @partnerObjectType, @partnerObject, @partnerObjectName)
    ON CONFLICT(line_uid) DO UPDATE SET
      import_batch_id = excluded.import_batch_id, project_key = excluded.project_key,
      wbs_key = excluded.wbs_key, cost_element_key = excluded.cost_element_key,
      vendor_key = excluded.vendor_key, currency_key = excluded.currency_key,
      posting_date_key = excluded.posting_date_key, document_date_key = excluded.document_date_key,
      period_key = excluded.period_key, document_no = excluded.document_no,
      document_line = excluded.document_line, document_type = excluded.document_type,
      reference_no = excluded.reference_no, po_no = excluded.po_no,
      fiscal_year = excluded.fiscal_year, description = excluded.description,
      quantity = excluded.quantity, uom = excluded.uom, amount = excluded.amount,
      source_row_no = excluded.source_row_no,
      partner_object_type = excluded.partner_object_type, partner_object = excluded.partner_object,
      partner_object_name = excluded.partner_object_name`);

  const upsertService = db.prepare(`INSERT INTO fact_service_line
    (import_batch_id, project_key, wbs_key, cost_element_key, vendor_key, currency_key,
     period_key, po_no, invoice_no, entry_sheet_no, invoice_serial, invoice_date_key,
     item_no, line_no, service_code, service_text, category, contract_type, uom,
     unit_rate, quantity_total, quantity_previous, quantity_current, progress_pct,
     amount_net, amount_vat, amount_gross, source_row_no, line_uid)
    VALUES (@batch, @project, @wbs, @ce, @vendor, @currency, @period, @poNo, @invoiceNo,
            @entrySheet, @serial, @invoiceDateKey, @itemNo, @lineNo, @serviceCode, @serviceText,
            @category, @contractType, @uom, @unitRate, @qtyTotal, @qtyPrev, @qtyCurrent,
            @progress, @net, @vat, @gross, @rowNo, @uid)
    ON CONFLICT(line_uid) DO UPDATE SET
      import_batch_id = excluded.import_batch_id, project_key = excluded.project_key,
      wbs_key = excluded.wbs_key, cost_element_key = excluded.cost_element_key,
      vendor_key = excluded.vendor_key, currency_key = excluded.currency_key,
      period_key = excluded.period_key, po_no = excluded.po_no, invoice_no = excluded.invoice_no,
      entry_sheet_no = excluded.entry_sheet_no, invoice_serial = excluded.invoice_serial,
      invoice_date_key = excluded.invoice_date_key, item_no = excluded.item_no,
      line_no = excluded.line_no, service_code = excluded.service_code,
      service_text = excluded.service_text, category = excluded.category,
      contract_type = excluded.contract_type, uom = excluded.uom, unit_rate = excluded.unit_rate,
      quantity_total = excluded.quantity_total, quantity_previous = excluded.quantity_previous,
      quantity_current = excluded.quantity_current, progress_pct = excluded.progress_pct,
      amount_net = excluded.amount_net, amount_vat = excluded.amount_vat,
      amount_gross = excluded.amount_gross, source_row_no = excluded.source_row_no`);

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

        const uid = useLineKeys ? (toText(mapped.__line_uid) ?? null) : null;
        if (uid && existsActual.get(uid)) replaced++;

        upsertActual.run({
          batch: batchId, project: projectKey, wbs: wbsKey, ce: ceKey,
          vendor: dims.vendorKey(toText(mapped.vendor_code), toText(mapped.vendor_name)),
          currency: currencyKey,
          postingDateKey: postingDate ? Number(postingDate.replace(/-/g, '')) : null,
          docDateKey: docDate ? Number(docDate.replace(/-/g, '')) : null,
          period,
          documentNo: toText(mapped.document_no),
          documentLine: toText(mapped.document_line),
          documentType: toText(mapped.document_type),
          referenceNo: toText(mapped.reference_no),
          poNo: toText(mapped.po_no),
          fiscalYear: toText(mapped.fiscal_year),
          description: toText(mapped.description),
          quantity: toNumber(mapped.quantity),
          uom: toText(mapped.uom),
          amount: toNumber(mapped.amount) ?? 0,
          rowNo: s.row_no,
          uid,
          partnerObjectType: toText(mapped.partner_object_type),
          partnerObject: toText(mapped.partner_object),
          partnerObjectName: toText(mapped.partner_object_name),
        });
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
      } else if (batch.module === 'ACCRUAL') {
        // No scenario — an accrual is one running set of estimates, not
        // multiple named versions the way budget/forecast are.
        const period = toPeriod(mapped.period_key) ?? batch.period_key;
        if (period) ensurePeriod(period);
        db.prepare(`INSERT INTO fact_accrual
          (import_batch_id, project_key, wbs_key, cost_element_key, currency_key,
           period_key, accrual_type, amount, description, source_row_no)
          VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
          batchId, projectKey, wbsKey, ceKey, currencyKey, period,
          toText(mapped.accrual_type), toNumber(mapped.amount) ?? 0,
          toText(mapped.description), s.row_no);
        posted++;
      } else if (batch.module === 'SERVICE') {
        const certDate = toDate(mapped.invoice_date);
        const period = toPeriod(mapped.period_key) ?? certDate?.slice(0, 7) ?? batch.period_key;
        if (period) ensurePeriod(period);
        const uid = useLineKeys ? (toText(mapped.__line_uid) ?? null) : null;
        if (uid && existsService.get(uid)) replaced++;

        upsertService.run({
          batch: batchId, project: projectKey, wbs: wbsKey, ce: ceKey,
          vendor: dims.vendorKey(toText(mapped.vendor_code), toText(mapped.vendor_name)),
          currency: currencyKey, period,
          poNo: toText(mapped.po_no), invoiceNo: toText(mapped.invoice_no),
          entrySheet: toText(mapped.entry_sheet_no), serial: toText(mapped.invoice_serial),
          invoiceDateKey: certDate ? Number(certDate.replace(/-/g, '')) : null,
          itemNo: toText(mapped.item_no), lineNo: toText(mapped.line_no),
          serviceCode: toText(mapped.service_code), serviceText: toText(mapped.service_text),
          category: toText(mapped.category), contractType: toText(mapped.contract_type),
          uom: toText(mapped.uom), unitRate: toNumber(mapped.unit_rate),
          qtyTotal: toNumber(mapped.quantity_total), qtyPrev: toNumber(mapped.quantity_previous),
          qtyCurrent: toNumber(mapped.quantity_current), progress: toNumber(mapped.progress_pct),
          net: toNumber(mapped.amount_net) ?? 0, vat: toNumber(mapped.amount_vat),
          gross: toNumber(mapped.amount_gross), rowNo: s.row_no, uid,
        });
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
      } else if (batch.module === 'ORDER') {
        // No single period column here — the report gives fiscal year and
        // posting month separately, so the period is built rather than read.
        const fy = toText(mapped.fiscal_year);
        const monthRaw = toText(mapped.period_month);
        const month = monthRaw ? String(parseInt(monthRaw, 10)).padStart(2, '0') : null;
        const period = (fy && month && !Number.isNaN(Number(month))) ? ensurePeriod(`${fy}-${month}`) : null;

        db.prepare(`INSERT INTO fact_order_line
          (import_batch_id, project_key, wbs_key, cost_element_key, vendor_key, currency_key,
           period_key, order_no, order_description, order_type, category, cost_center_code,
           cost_center_name, po_no, quantity, uom, amount, source_row_no)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          batchId, projectKey, wbsKey, ceKey,
          dims.vendorKey(toText(mapped.vendor_code), toText(mapped.vendor_name)),
          currencyKey, period,
          toText(mapped.order_no), toText(mapped.order_description), toText(mapped.order_type),
          toText(mapped.category), toText(mapped.cost_center_code), toText(mapped.cost_center_name),
          toText(mapped.po_no), toNumber(mapped.quantity), toText(mapped.uom),
          toNumber(mapped.amount) ?? 0, s.row_no);
        posted++;
      }
    }

    if (batch.module === 'MASTER') {
      posted = postWbsMaster(batchId, batch, staged);
    }

    // Superseding is the fallback for sources with no line identity. Where lines
    // merge on their own key, replacing whole batches would throw away the months
    // an overlapping extract did not cover.
    if (!useLineKeys) supersedePrevious(batchId, batch);

    db.prepare(`UPDATE import_batch
                SET status = 'POSTED', posted_at = datetime('now'), row_count_posted = ?
                WHERE import_batch_id = ?`).run(posted, batchId);
    db.prepare(`UPDATE stg_row SET status = 'POSTED' WHERE import_batch_id = ? AND status = 'VALID'`)
      .run(batchId);
  });
  run();

  return { importBatchId: batchId, posted, replaced, rejected: rejected.n, byLineKey: useLineKeys };
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

/**
 * Which fact table a module writes to. Fixed map — never user input.
 * Exported as the authoritative report→fact edge for the Lineage page
 * (`src/main/services/lineage.ts`) — a new module updates this one map and
 * the lineage graph picks it up with no other change.
 */
export const FACT_TABLE: Record<string, string | null> = {
  ACTUAL: 'fact_actual',
  COMMITMENT: 'fact_actual',
  BUDGET: 'fact_budget',
  FORECAST: 'fact_forecast',
  SERVICE: 'fact_service_line',
  ORDER: 'fact_order_line',
  ACCRUAL: 'fact_accrual',
  MASTER: null, // writes dimensions, not facts
};

/** The projects a batch's posted rows actually belong to. */
function projectsTouchedBy(batchId: number, module: string): number[] {
  const table = FACT_TABLE[module];
  if (!table) return [];
  return (getDb().prepare(`SELECT DISTINCT project_key FROM ${table} WHERE import_batch_id = ?`)
    .all(batchId) as { project_key: number }[]).map((r) => r.project_key);
}

/**
 * Mark earlier postings of the same report, module and period as superseded.
 *
 * Scope is decided by the projects the rows actually landed on, not by the
 * project chosen in the wizard. That choice is only a hint for files with no
 * project column, and it differs between uploads of the very same file — the
 * first import of a fresh database has no project to pick yet, later ones do.
 * Keying on it let an identical re-upload sit alongside the original and double
 * the cost.
 */
function supersedePrevious(batchId: number, batch: any): void {
  const db = getDb();
  const projects = projectsTouchedBy(batchId, batch.module);

  const candidates = db.prepare(`
    SELECT import_batch_id, project_key FROM import_batch
    WHERE import_batch_id <> @new
      AND status = 'POSTED'
      AND report_definition_id = @rd
      AND module = @module
      AND IFNULL(period_key,'~') = IFNULL(@period,'~')`)
    .all({ new: batchId, rd: batch.report_definition_id, module: batch.module,
           period: batch.period_key }) as { import_batch_id: number; project_key: number | null }[];

  const overlapping = candidates.filter((c) => {
    if (projects.length === 0) {
      // Master data writes no facts, so fall back to the declared project.
      return (c.project_key ?? -1) === (batch.project_key ?? -1);
    }
    return projectsTouchedBy(c.import_batch_id, batch.module).some((p) => projects.includes(p));
  });

  if (overlapping.length === 0) return;
  const upd = db.prepare(
    `UPDATE import_batch SET status = 'SUPERSEDED', superseded_by = ? WHERE import_batch_id = ?`);
  for (const c of overlapping) upd.run(batchId, c.import_batch_id);
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

/**
 * Discard a batch and everything it produced.
 *
 * Anything this batch superseded is restored to POSTED, so deleting a mistaken
 * import puts the previous position back rather than leaving a hole. Dimension
 * members the batch created are left alone: postings from other batches may
 * point at them, and an unused dimension row is harmless.
 */
export function deleteBatch(batchId: number): void {
  const db = getDb();
  const run = db.transaction(() => {
    db.prepare('DELETE FROM fact_actual WHERE import_batch_id = ?').run(batchId);
    db.prepare('DELETE FROM fact_budget WHERE import_batch_id = ?').run(batchId);
    db.prepare('DELETE FROM fact_forecast WHERE import_batch_id = ?').run(batchId);
    db.prepare('DELETE FROM fact_service_line WHERE import_batch_id = ?').run(batchId);
    db.prepare('DELETE FROM stg_row WHERE import_batch_id = ?').run(batchId);
    db.prepare(`UPDATE import_batch SET status = 'POSTED', superseded_by = NULL
                WHERE superseded_by = ? AND status = 'SUPERSEDED'`).run(batchId);
    db.prepare('UPDATE import_batch SET superseded_by = NULL WHERE superseded_by = ?').run(batchId);
    db.prepare('DELETE FROM import_batch WHERE import_batch_id = ?').run(batchId);
  });
  run();
}
