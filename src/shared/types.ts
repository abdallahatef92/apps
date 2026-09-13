export type Module = 'ACTUAL' | 'BUDGET' | 'FORECAST' | 'COMMITMENT' | 'MASTER';

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
  amountTotal: number;
  issues: ValidationIssue[];
  /** Distinct source values that did not resolve to a dimension member. */
  unresolved: { dimension: string; values: string[] }[];
}

export interface PostResult {
  importBatchId: number;
  posted: number;
  rejected: number;
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
  amount_total: number | null;
  imported_at: string;
  notes: string | null;
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string };
