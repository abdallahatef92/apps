export type Module = 'ACTUAL' | 'BUDGET' | 'FORECAST' | 'COMMITMENT' | 'SERVICE' | 'MASTER' | 'ORDER' | 'ACCRUAL';

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  ms: number;
}

export interface StoredQuery {
  query_id: number;
  code: string;
  name: string;
  module: string;
  category: string | null;
  description: string | null;
  sql_text: string;
  params_json: string;
  viz_json: string;
  is_system: number;
  is_active: number;
}

export interface Project {
  project_key: number;
  project_code: string;
  project_name: string;
  client_name: string | null;
  currency_key: number | null;
  contract_value: number | null;
  status: string;
}

export interface ReportDefinition {
  report_definition_id: number;
  code: string;
  name: string;
  module: Module;
  source_system: string;
  description: string | null;
  expected_frequency: string | null;
  staleness_days: number;
  /** JSON array of canonical fields identifying a real data row. */
  detail_key_fields: string;
}

export interface FreshnessRow {
  report_definition_id: number;
  report_code: string;
  report_name: string;
  module: Module;
  source_system: string;
  latest_batch_id: number | null;
  latest_data_date: string | null;
  latest_period: string | null;
  latest_imported_at: string | null;
  latest_rows: number | null;
  age_days: number | null;
  freshness_status: 'NO_DATA' | 'STALE' | 'CURRENT';
}

/** A worksheet as read from an uploaded workbook, before any mapping. */
export interface SheetPreview {
  sheetName: string;
  headerRow: number;
  columns: string[];
  rows: Record<string, unknown>[];
  totalRows: number;
}

export interface FilePreview {
  filePath: string;
  fileName: string;
  fileSize: number;
  fileHash: string;
  sheets: SheetPreview[];
  /** Date the parser guessed from the file content or name; user confirms it. */
  detectedDataDate: string | null;
}

/** Canonical target fields a source column can be mapped onto. */
export interface TargetField {
  field: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'period';
  required: boolean;
  description: string;
}

export interface ColumnMappingEntry {
  target_field: string;
  source_column: string | null;
  transform?: string | null;
  default_value?: string | null;
}

export interface StageRequest {
  filePath: string;
  fileName: string;
  fileHash: string;
  fileSize: number;
  sheetName: string;
  headerRow: number;
  module: Module;
  reportDefinitionId: number;
  dataDate: string;
  periodKey: string | null;
  projectKey: number | null;
  scenarioKey: number | null;
  notes: string | null;
  mapping: ColumnMappingEntry[];
  saveMapping: boolean;
  /**
   * Canonical fields that must be non-empty for a row to count as data. SAP
   * exports interleave subtotal rows, which leave these blank; such rows are
   * staged as SKIPPED rather than rejected, and never posted.
   */
  detailKeyFields?: string[];
}

export interface ValidationIssue {
  rowNo: number;
  severity: 'ERROR' | 'WARN';
  message: string;
}

export interface StageResult {
  importBatchId: number;
  rowCount: number;
  validCount: number;
  warnCount: number;
  errorCount: number;
  /** Subtotal / non-data rows recognised and left out. */
  skippedCount: number;
  amountTotal: number;
  issues: ValidationIssue[];
  /** Distinct source values that did not resolve to a dimension member. */
  unresolved: { dimension: string; values: string[] }[];
  /** Set when a batch with byte-identical file content already exists. */
  duplicateOf: { importBatchId: number; fileName: string; dataDate: string; status: string } | null;
  /**
   * Whether the file carries an identity per line. With one, re-importing an
   * overlapping extract replaces those lines; without one, rows can only be added.
   */
  lineKey: {
    /** Fields that would identify a line for this module. */
    expected: string[];
    /** Of those, the ones this file supplies. */
    used: string[];
    usable: boolean;
    duplicatesInFile: number;
    willReplace: number;
  };
}

export interface PostResult {
  importBatchId: number;
  /** Rows written: new lines plus lines replaced in place. */
  posted: number;
  /** Of those, how many replaced a line already in the warehouse. */
  replaced: number;
  rejected: number;
  /** True when replacement was by line identity rather than by superseding the batch. */
  byLineKey: boolean;
}

export interface BatchRow {
  import_batch_id: number;
  report_name: string;
  module: Module;
  data_date: string;
  period_key: string | null;
  file_name: string;
  status: string;
  row_count_file: number;
  row_count_posted: number;
  row_count_rejected: number;
  row_count_skipped: number;
  amount_total: number | null;
  imported_at: string;
  notes: string | null;
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string };

export interface PivotField { key: string; label: string; column: string }
export interface PivotMeasure { key: string; label: string; expr: string; format?: 'money' | 'count' }
export interface PivotSource {
  key: string;
  label: string;
  view: string;
  description: string;
  dimensions: PivotField[];
  measures: PivotMeasure[];
  scope?: string;
  periodColumn?: string;
}

/** How an analysis should be drawn; stored with the query in the library. */
export interface VizSpec {
  kind?: 'line' | 'bar' | 'treemap' | 'heatmap' | 'table';
  x?: string;
  series?: { column: string; label: string }[];
  area?: boolean;
  /** Per-period measure drawn as columns in a panel below the lines. */
  bars?: { column: string; label: string; seriesIndex?: number };
  label?: string;
  value?: string;
  reference?: string;
  referenceLabel?: string;
  diverging?: boolean;
  color?: string;
  row?: string;
  col?: string;
  headline?: string;
}

/**
 * A cost type is a row in dim_cost_type, not a fixed union — the user adds and
 * renames them from the Allocate cost types screen. The code (e.g. 'LABOR') is
 * what everything else stores; label/icon/color are display only.
 */
export type CostType = string;

export interface CostTypeDef {
  code: string;
  label: string;
  icon: string;
  color: string;
  sort_order: number;
  /** Built-in types (the original six) can be renamed but not deleted. */
  is_system: number;
}

/**
 * One (cost element, document type) pair that actually occurs in posted cost,
 * with what the rules currently make of it. This is the allocation screen's
 * unit of work: the combinations are derived from the data rather than typed in,
 * so the list is exactly what needs an answer — nothing hypothetical.
 */
export interface CostTypeCombination {
  cost_element_code: string;
  cost_element_name: string | null;
  /** '' when the posting carries no document type. */
  document_type: string;
  postings: number;
  amount: number;
  /** What v_posting resolves today, whether from an assignment or a pattern. */
  resolved_cost_type: string | null;
  /** Set only when an exact rule names this pair; null means inherited. */
  assigned_cost_type: CostType | null;
}

/** `cost_type: null` removes the assignment and lets the patterns decide again. */
export interface CostTypeAssignment {
  cost_element_code: string;
  document_type: string;
  cost_type: CostType | null;
}

/**
 * A work package is a row in dim_work_package — entirely project-specific
 * (masonry/concrete/earthwork for one project, something else entirely for
 * another), so unlike cost type there is no seeded default set except the
 * INDIRECT catch-all. `code` is the package's own short code (e.g. "S.03"),
 * typed directly rather than derived from the label.
 */
export type WorkPackage = string;

export interface WorkPackageDef {
  code: string;
  label: string;
  group_label: string | null;
  icon: string;
  color: string;
  sort_order: number;
  is_system: number;
}

/**
 * One cost element (GL account) that actually occurs in posted actual cost
 * under a cost type other than MATERIAL/SUBCONTRACT, with what
 * cost_element_work_package resolves it to. These default to the INDIRECT
 * catch-all but stay reviewable here in case one is really package work
 * miscoded under the wrong cost type.
 */
export interface ElementPackageCombination {
  cost_element_code: string;
  cost_element_name: string | null;
  postings: number;
  amount: number;
  resolved_work_package: string | null;
  assigned_work_package: WorkPackage | null;
}

export interface OtherPackageCombination extends ElementPackageCombination {
  cost_type: string | null;
}

/** `work_package: null` removes the assignment, leaving the cost element unallocated. */
export interface ElementPackageAssignment {
  cost_element_code: string;
  work_package: WorkPackage | null;
}

/**
 * One real material (SAP material number, cost type MATERIAL) that
 * actually occurs in posted actual cost, with what material_work_package
 * resolves it to. This is the true material identity — several different
 * materials commonly share one GL account, so the cost element is not it.
 */
export interface MaterialPackageCombination {
  material_code: string | null;
  material_name: string | null;
  postings: number;
  amount: number;
  resolved_work_package: string | null;
  assigned_work_package: WorkPackage | null;
}

/**
 * One (service code, service text) pair that actually occurs in subcontract
 * PO detail (fact_service_line) — the unit of work for subcontract package
 * coding, since the PO's own GL account is usually one generic subcontract
 * account shared by many different service items.
 */
export interface ServicePackageCombination {
  service_code: string;
  service_text: string;
  postings: number;
  amount: number;
  resolved_work_package: string | null;
  assigned_work_package: WorkPackage | null;
}

/** `work_package: null` removes the assignment, leaving the material unallocated. */
export interface MaterialPackageAssignment {
  material_code: string;
  work_package: WorkPackage | null;
}

/** `work_package: null` removes the assignment, leaving the service item unallocated. */
export interface ServicePackageAssignment {
  service_code: string;
  service_text: string;
  work_package: WorkPackage | null;
}

export interface SchemaColumn {
  name: string;
  type: string;
  notNull: boolean;
  isPk: boolean;
}

export interface SchemaForeignKey {
  column: string;
  refTable: string;
  refColumn: string;
}

export interface SchemaTable {
  name: string;
  columns: SchemaColumn[];
  foreignKeys: SchemaForeignKey[];
}

/** Base-table introspection (via sqlite_master + PRAGMA), for the schema diagram page. */
export interface SchemaDescription {
  tables: SchemaTable[];
}

export interface LineageView {
  name: string;
  /** The fact table or view this one was found reading from — the edge to draw. */
  from: string;
}

export interface LineageQueryRef {
  code: string;
  name: string;
  category: string | null;
  description: string | null;
  /** Which fact table / view names this query's SQL actually references, of the ones in scope. */
  sources: string[];
}

export interface LineageResult {
  report: { report_definition_id: number; name: string; module: string; description: string | null; source_system: string };
  latestBatch: { import_batch_id: number; status: string; data_date: string; imported_at: string; row_count_posted: number } | null;
  fact: { name: string; isDimension: boolean } | null;
  views: LineageView[];
  queries: LineageQueryRef[];
}

export interface ExportDiagramRequest {
  format: 'svg' | 'png';
  /** Raw SVG markup for 'svg'; base64-encoded PNG bytes (no data: prefix) for 'png'. */
  data: string;
  suggestedName: string;
}
