/**
 * The pivot builder.
 *
 * Turns a few picks into a real SQL statement against the reporting views, so
 * ad-hoc exploration produces the same kind of artefact as a curated analysis —
 * inspectable, exportable, and savable into the query library.
 *
 * Every identifier comes from the whitelist below and is never taken from user
 * text, so the generated SQL cannot be injected into; values stay bound.
 */

export interface PivotField { key: string; label: string; column: string }
export interface PivotMeasure { key: string; label: string; expr: string; format?: 'money' | 'count' }

export interface PivotSource {
  key: string;
  label: string;
  view: string;
  description: string;
  dimensions: PivotField[];
  measures: PivotMeasure[];
  /** Extra predicate always applied, e.g. only the current budget version. */
  scope?: string;
  periodColumn?: string;
}

const WBS_DIMS: PivotField[] = [
  { key: 'wbs_code', label: 'WBS code', column: 'wbs_code' },
  { key: 'wbs_name', label: 'WBS name', column: 'wbs_name' },
  { key: 'discipline', label: 'Discipline', column: 'discipline' },
  { key: 'package', label: 'Package', column: 'package' },
];
const CE_DIMS: PivotField[] = [
  { key: 'cost_element_code', label: 'Cost element', column: 'cost_element_code' },
  { key: 'cost_element_name', label: 'Cost element name', column: 'cost_element_name' },
  { key: 'cost_type', label: 'Cost type', column: 'cost_type' },
];
const PERIOD_DIMS: PivotField[] = [
  { key: 'period_key', label: 'Month', column: 'period_key' },
  { key: 'year_no', label: 'Year', column: 'year_no' },
];

export const PIVOT_SOURCES: PivotSource[] = [
  {
    key: 'ACTUAL', label: 'Actual cost', view: 'v_actual', periodColumn: 'period_key',
    description: 'Posted cost from SAP. Income is excluded.',
    dimensions: [...WBS_DIMS, ...CE_DIMS, ...PERIOD_DIMS,
      { key: 'vendor_name', label: 'Vendor', column: 'vendor_name' },
      { key: 'document_type', label: 'Document type', column: 'document_type' },
      { key: 'po_no', label: 'Purchase order', column: 'po_no' }],
    measures: [
      { key: 'amount', label: 'Actual cost', expr: 'SUM(amount)', format: 'money' },
      { key: 'quantity', label: 'Quantity', expr: 'SUM(quantity)' },
      { key: 'postings', label: 'Postings', expr: 'COUNT(*)', format: 'count' },
      { key: 'documents', label: 'Documents', expr: 'COUNT(DISTINCT document_no)', format: 'count' },
    ],
  },
  {
    key: 'REVENUE', label: 'Revenue', view: 'v_revenue', periodColumn: 'period_key',
    description: 'Income billed to the project, shown positive.',
    dimensions: [{ key: 'wbs_code', label: 'WBS code', column: 'wbs_code' },
      { key: 'wbs_name', label: 'WBS name', column: 'wbs_name' },
      { key: 'cost_element_name', label: 'Account', column: 'cost_element_name' },
      ...PERIOD_DIMS],
    measures: [
      { key: 'amount', label: 'Revenue', expr: 'SUM(amount)', format: 'money' },
      { key: 'postings', label: 'Postings', expr: 'COUNT(*)', format: 'count' },
    ],
  },
  {
    key: 'BUDGET', label: 'Budget', view: 'v_budget', scope: 'is_current = 1', periodColumn: 'period_key',
    description: 'The current approved budget version.',
    dimensions: [...WBS_DIMS, ...CE_DIMS, { key: 'period_key', label: 'Month', column: 'period_key' }],
    measures: [
      { key: 'budget_amount', label: 'Budget', expr: 'SUM(budget_amount)', format: 'money' },
      { key: 'budget_quantity', label: 'Budget quantity', expr: 'SUM(budget_quantity)' },
    ],
  },
  {
    key: 'FORECAST', label: 'Forecast', view: 'v_forecast', scope: 'is_current = 1', periodColumn: 'period_key',
    description: 'The current forecast version.',
    dimensions: [...WBS_DIMS, ...CE_DIMS, { key: 'period_key', label: 'Month', column: 'period_key' }],
    measures: [
      { key: 'forecast_amount', label: 'Forecast', expr: 'SUM(forecast_amount)', format: 'money' },
      { key: 'etc_amount', label: 'ETC', expr: 'SUM(etc_amount)', format: 'money' },
    ],
  },
  {
    key: 'SERVICE', label: 'Subcontract service lines', view: 'v_service_line', periodColumn: 'period_key',
    description: 'Certified subcontractor detail behind each PO.',
    dimensions: [
      { key: 'vendor_name', label: 'Supplier', column: 'vendor_name' },
      { key: 'category', label: 'Category', column: 'category' },
      { key: 'po_no', label: 'Purchase order', column: 'po_no' },
      { key: 'service_code', label: 'Service code', column: 'service_code' },
      { key: 'wbs_code', label: 'WBS code', column: 'wbs_code' },
      { key: 'wbs_name', label: 'WBS name', column: 'wbs_name' },
      { key: 'period_key', label: 'Month', column: 'period_key' }],
    measures: [
      { key: 'amount_net', label: 'Work done (net)', expr: 'SUM(amount_net)', format: 'money' },
      { key: 'amount_vat', label: 'VAT', expr: 'SUM(amount_vat)', format: 'money' },
      { key: 'quantity_current', label: 'Quantity this period', expr: 'SUM(quantity_current)' },
      { key: 'lines', label: 'Service lines', expr: 'COUNT(*)', format: 'count' },
    ],
  },
];

export interface PivotRequest {
  source: string;
  dimensions: string[];
  measures: string[];
  limit?: number;
  /** Sort by this measure key, descending. Defaults to the first measure. */
  sortBy?: string;
}

export function pivotMeta(): PivotSource[] {
  return PIVOT_SOURCES;
}

/** Compose the statement. Throws rather than silently dropping an unknown field. */
export function buildPivotSql(req: PivotRequest): string {
  const source = PIVOT_SOURCES.find((s) => s.key === req.source);
  if (!source) throw new Error(`Unknown pivot source "${req.source}".`);

  const dims = req.dimensions.map((k) => {
    const d = source.dimensions.find((x) => x.key === k);
    if (!d) throw new Error(`"${k}" is not a dimension of ${source.label}.`);
    return d;
  });
  const measures = req.measures.map((k) => {
    const m = source.measures.find((x) => x.key === k);
    if (!m) throw new Error(`"${k}" is not a measure of ${source.label}.`);
    return m;
  });
  if (measures.length === 0) throw new Error('Pick at least one measure.');

  const selectDims = dims.map((d) => `  COALESCE(CAST(${d.column} AS TEXT), '(none)') AS ${d.key}`);
  const selectMeasures = measures.map((m) => `  ${m.expr} AS ${m.key}`);
  const where = [
    'project_key = :project_key',
    ...(source.scope ? [source.scope] : []),
    ...(source.periodColumn
      ? [`(:period_from IS NULL OR ${source.periodColumn} >= :period_from)`,
         `(:period_to IS NULL OR ${source.periodColumn} <= :period_to)`]
      : []),
  ];

  const sortKey = req.sortBy && measures.some((m) => m.key === req.sortBy)
    ? req.sortBy : measures[0].key;

  return [
    'SELECT',
    [...selectDims, ...selectMeasures].join(',\n'),
    `FROM ${source.view}`,
    `WHERE ${where.join('\n  AND ')}`,
    dims.length > 0 ? `GROUP BY ${dims.map((_, i) => i + 1).join(', ')}` : '',
    `ORDER BY ${sortKey} DESC`,
    `LIMIT COALESCE(:row_limit, ${req.limit ?? 200})`,
  ].filter(Boolean).join('\n');
}
