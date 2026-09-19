/**
 * System query library.
 *
 * These are real SQL statements stored in the `query_library` table and executed
 * by the read-only runner. Aggregation, grouping and joining all happen in SQLite —
 * the UI only renders the result set.
 *
 * Parameters use SQLite named binding (`:name`). Every declared parameter is always
 * bound, with NULL when the user leaves it empty, so a query must tolerate NULLs
 * (the `(:p IS NULL OR col = :p)` idiom).
 */

export interface QueryParamDef {
  name: string;
  type: 'project' | 'period' | 'int' | 'text' | 'date' | 'scenario';
  label: string;
  required?: boolean;
  default?: string | number;
  /**
   * Set on a period param whose absence makes the query scan unbounded
   * history — Analysis.tsx won't auto-run the query until it's filled (or
   * the user explicitly asks to run anyway), so opening a heavy cross-module
   * report doesn't itself trigger a full-history scan.
   */
  warnUnbounded?: boolean;
}

/**
 * How to draw a result set. Held with the query so a report is one object, and so
 * a user-written query can describe its own chart without a code change.
 */
export interface VizSpec {
  kind?: 'line' | 'bar' | 'treemap' | 'heatmap' | 'table';
  /** line */
  x?: string;
  series?: { column: string; label: string }[];
  area?: boolean;
  /** Per-period measure drawn as columns in a panel below the lines. */
  bars?: { column: string; label: string; seriesIndex?: number };
  /** bar / treemap */
  label?: string;
  value?: string;
  reference?: string;
  referenceLabel?: string;
  diverging?: boolean;
  /** treemap fill */
  color?: string;
  /** heatmap */
  row?: string;
  col?: string;
  /** Another stored query, run with the same parameters, supplying the KPI row. */
  headline?: string;
}

export interface SystemQuery {
  code: string;
  name: string;
  module: 'ACTUAL' | 'BUDGET' | 'FORECAST' | 'SERVICE' | 'CROSS' | 'ADMIN';
  category: string;
  description: string;
  sql: string;
  params: QueryParamDef[];
  viz?: VizSpec;
}

const P_PROJECT: QueryParamDef = { name: 'project_key', type: 'project', label: 'Project', required: true };

export const SYSTEM_QUERIES: SystemQuery[] = [
  {
    code: 'ACT_BY_WBS',
    name: 'Actuals by WBS',
    module: 'ACTUAL',
    category: 'Aggregation',
    description: 'Actual cost rolled up per WBS element, optionally limited to a period range.',
    params: [P_PROJECT,
      { name: 'period_from', type: 'period', label: 'Period from' },
      { name: 'period_to', type: 'period', label: 'Period to' }],
    viz: { kind: 'bar', label: 'wbs_name', value: 'actual_amount', headline: 'KPI_PROJECT' },
    sql: `
SELECT
  a.wbs_code,
  a.wbs_name,
  a.discipline,
  COUNT(*)        AS line_count,
  SUM(a.quantity) AS total_quantity,
  SUM(a.amount)   AS actual_amount,
  MAX(a.data_date) AS data_date
FROM v_actual a
WHERE a.project_key = :project_key
  AND (:period_from IS NULL OR a.period_key >= :period_from)
  AND (:period_to   IS NULL OR a.period_key <= :period_to)
GROUP BY a.wbs_code, a.wbs_name, a.discipline
ORDER BY actual_amount DESC`,
  },
  {
    code: 'ACT_BY_COST_TYPE',
    name: 'Actuals by cost type',
    module: 'ACTUAL',
    category: 'Aggregation',
    description: 'Actual cost split by cost type (labor, material, subcontract, ...) with share of total.',
    params: [P_PROJECT, { name: 'period_to', type: 'period', label: 'Up to period' }],
    viz: { kind: 'bar', label: 'cost_type', value: 'actual_amount', headline: 'KPI_PROJECT' },
    sql: `
SELECT
  COALESCE(a.cost_type,'UNMAPPED') AS cost_type,
  SUM(a.amount)                    AS actual_amount,
  ROUND(100.0 * SUM(a.amount) / NULLIF(SUM(SUM(a.amount)) OVER (), 0), 2) AS pct_of_total,
  COUNT(*)                         AS line_count
FROM v_actual a
WHERE a.project_key = :project_key
  AND (:period_to IS NULL OR a.period_key <= :period_to)
GROUP BY COALESCE(a.cost_type,'UNMAPPED')
ORDER BY actual_amount DESC`,
  },
  {
    code: 'ACT_MONTHLY_TREND',
    name: 'Monthly actual trend',
    module: 'ACTUAL',
    category: 'Trend',
    description: 'Actual spend per month with a running cumulative total.',
    params: [P_PROJECT],
    viz: { kind: 'line', x: 'period_key', area: true,
      series: [{ column: 'period_amount', label: 'Spend in period' }],
      headline: 'KPI_PROJECT' },
    sql: `
SELECT
  a.period_key,
  SUM(a.amount) AS period_amount,
  SUM(SUM(a.amount)) OVER (ORDER BY a.period_key
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cumulative_amount
FROM v_actual a
WHERE a.project_key = :project_key
GROUP BY a.period_key
ORDER BY a.period_key`,
  },
  {
    code: 'ACT_BY_VENDOR',
    name: 'Actuals by vendor',
    module: 'ACTUAL',
    category: 'Aggregation',
    description: 'Top vendors by actual spend.',
    params: [P_PROJECT, { name: 'top_n', type: 'int', label: 'Top N', default: 25 }],
    viz: { kind: 'bar', label: 'vendor_name', value: 'actual_amount' },
    sql: `
SELECT
  COALESCE(a.vendor_name,'(no vendor)') AS vendor_name,
  a.vendor_code,
  COUNT(DISTINCT a.document_no) AS documents,
  SUM(a.amount)                 AS actual_amount
FROM v_actual a
WHERE a.project_key = :project_key
GROUP BY COALESCE(a.vendor_name,'(no vendor)'), a.vendor_code
ORDER BY actual_amount DESC
LIMIT COALESCE(:top_n, 25)`,
  },
  {
    code: 'ACT_DETAIL',
    name: 'Actual line items',
    module: 'ACTUAL',
    category: 'Detail',
    description: 'Full posting detail with lineage — use this to drill into any aggregate.',
    params: [P_PROJECT,
      { name: 'period_from', type: 'period', label: 'Period from' },
      { name: 'period_to', type: 'period', label: 'Period to' }],
    viz: { kind: 'table' },
    sql: `
SELECT
  a.period_key, a.document_no, a.document_type, a.wbs_code, a.wbs_name,
  a.cost_element_code, a.cost_element_name, a.cost_type, a.vendor_name,
  a.description, a.quantity, a.uom, a.amount, a.data_date,
  a.partner_object_type, a.partner_object, a.partner_object_name
FROM v_actual a
WHERE a.project_key = :project_key
  AND (:period_from IS NULL OR a.period_key >= :period_from)
  AND (:period_to   IS NULL OR a.period_key <= :period_to)
ORDER BY a.period_key, a.wbs_code, a.document_no`,
  },
  {
    code: 'BVA_BY_WBS',
    name: 'Budget vs Actual by WBS',
    module: 'CROSS',
    category: 'Variance',
    description: 'Current budget against actuals per WBS, with variance and a status flag. A WBS present on either side appears exactly once.',
    params: [P_PROJECT, { name: 'period_to', type: 'period', label: 'Actuals up to period' }],
    viz: { kind: 'bar', label: 'wbs_name', value: 'actual_amount',
      reference: 'budget_amount', referenceLabel: 'Budget', headline: 'KPI_PROJECT' },
    sql: `
WITH bud AS (
  SELECT wbs_key, wbs_code, wbs_name, discipline, SUM(budget_amount) AS budget_amount
  FROM v_budget
  WHERE project_key = :project_key AND is_current = 1
  GROUP BY wbs_key, wbs_code, wbs_name, discipline
),
act AS (
  SELECT wbs_key, wbs_code, wbs_name, discipline, SUM(amount) AS actual_amount
  FROM v_actual
  WHERE project_key = :project_key
    AND (:period_to IS NULL OR period_key <= :period_to)
  GROUP BY wbs_key, wbs_code, wbs_name, discipline
),
keys AS (
  SELECT wbs_key, wbs_code, wbs_name, discipline FROM bud
  UNION
  SELECT wbs_key, wbs_code, wbs_name, discipline FROM act
)
SELECT
  k.wbs_code,
  k.wbs_name,
  k.discipline,
  COALESCE(b.budget_amount,0) AS budget_amount,
  COALESCE(a.actual_amount,0) AS actual_amount,
  COALESCE(b.budget_amount,0) - COALESCE(a.actual_amount,0) AS variance_amount,
  ROUND(100.0 * COALESCE(a.actual_amount,0) / NULLIF(b.budget_amount,0), 1) AS pct_spent,
  CASE
    WHEN b.budget_amount IS NULL THEN 'NO BUDGET'
    WHEN a.actual_amount IS NULL THEN 'NOT STARTED'
    WHEN a.actual_amount > b.budget_amount THEN 'OVER'
    WHEN a.actual_amount > 0.9 * b.budget_amount THEN 'AT RISK'
    ELSE 'OK'
  END AS status
FROM keys k
LEFT JOIN bud b ON b.wbs_key IS k.wbs_key
LEFT JOIN act a ON a.wbs_key IS k.wbs_key
ORDER BY variance_amount ASC`,
  },
  {
    code: 'BVA_BY_COST_ELEMENT',
    name: 'Budget vs Actual by cost element',
    module: 'CROSS',
    category: 'Variance',
    description: 'The same comparison at cost element grain — shows which accounts are eroding the budget.',
    params: [P_PROJECT],
    viz: { kind: 'bar', label: 'cost_element_name', value: 'actual_amount',
      reference: 'budget_amount', referenceLabel: 'Budget', headline: 'KPI_PROJECT' },
    sql: `
WITH bud AS (
  SELECT cost_element_code, cost_element_name, cost_type, SUM(budget_amount) AS budget_amount
  FROM v_budget WHERE project_key = :project_key AND is_current = 1
  GROUP BY cost_element_code, cost_element_name, cost_type
),
act AS (
  SELECT cost_element_code, cost_element_name, cost_type, SUM(amount) AS actual_amount
  FROM v_actual WHERE project_key = :project_key
  GROUP BY cost_element_code, cost_element_name, cost_type
),
keys AS (
  SELECT cost_element_code, cost_element_name, cost_type FROM bud
  UNION
  SELECT cost_element_code, cost_element_name, cost_type FROM act
)
SELECT
  k.cost_element_code, k.cost_element_name, k.cost_type,
  COALESCE(b.budget_amount,0) AS budget_amount,
  COALESCE(a.actual_amount,0) AS actual_amount,
  COALESCE(b.budget_amount,0) - COALESCE(a.actual_amount,0) AS variance_amount,
  ROUND(100.0 * COALESCE(a.actual_amount,0) / NULLIF(b.budget_amount,0), 1) AS pct_spent
FROM keys k
LEFT JOIN bud b ON b.cost_element_code IS k.cost_element_code
LEFT JOIN act a ON a.cost_element_code IS k.cost_element_code
ORDER BY variance_amount ASC`,
  },
  {
    code: 'EAC_SUMMARY',
    name: 'EAC vs Budget summary',
    module: 'FORECAST',
    category: 'Variance',
    description: 'Budget, actual to date, ETC and EAC per WBS with variance at completion (VAC).',
    params: [P_PROJECT],
    viz: { kind: 'bar', label: 'wbs_name', value: 'vac_amount', diverging: true,
      headline: 'KPI_PROJECT' },
    sql: `
WITH bud AS (
  SELECT wbs_key, wbs_code, wbs_name, SUM(budget_amount) AS budget_amount
  FROM v_budget WHERE project_key = :project_key AND is_current = 1
  GROUP BY wbs_key, wbs_code, wbs_name
),
act AS (
  SELECT wbs_key, SUM(amount) AS actual_amount
  FROM v_actual WHERE project_key = :project_key
  GROUP BY wbs_key
),
fct AS (
  SELECT wbs_key, SUM(forecast_amount) AS etc_amount
  FROM v_forecast WHERE project_key = :project_key AND is_current = 1
  GROUP BY wbs_key
)
SELECT
  b.wbs_code,
  b.wbs_name,
  b.budget_amount,
  COALESCE(a.actual_amount,0) AS actual_to_date,
  COALESCE(f.etc_amount,0)    AS etc_amount,
  COALESCE(a.actual_amount,0) + COALESCE(f.etc_amount,0) AS eac_amount,
  b.budget_amount - (COALESCE(a.actual_amount,0) + COALESCE(f.etc_amount,0)) AS vac_amount,
  ROUND(100.0 * (b.budget_amount - (COALESCE(a.actual_amount,0) + COALESCE(f.etc_amount,0)))
        / NULLIF(b.budget_amount,0), 1) AS vac_pct
FROM bud b
LEFT JOIN act a ON a.wbs_key IS b.wbs_key
LEFT JOIN fct f ON f.wbs_key IS b.wbs_key
ORDER BY vac_amount ASC`,
  },
  {
    code: 'S_CURVE',
    name: 'S-curve: budget / actual / forecast',
    module: 'CROSS',
    category: 'Trend',
    description: 'The cost S-curve: cumulative budget, actual and forecast by period, over columns '
      + 'of what was actually spent in each month. A budget that is not time-phased is shown as a '
      + 'flat budget-at-completion line.',
    params: [P_PROJECT],
    viz: { kind: 'line', x: 'period_key',
      series: [{ column: 'budget_cum', label: 'Budget' },
               { column: 'actual_cum', label: 'Actual (cum.)' },
               { column: 'forecast_cum', label: 'Actual + forecast' }],
      // Same hue as the cumulative actual line: colour follows the entity, and
      // these columns are that same actual, just not yet added up.
      bars: { column: 'actual_period', label: 'Actual in month', seriesIndex: 1 },
      headline: 'KPI_PROJECT' },
    sql: `
WITH periods AS (
  SELECT period_key FROM v_budget   WHERE project_key = :project_key AND period_key IS NOT NULL
  UNION
  SELECT period_key FROM v_actual   WHERE project_key = :project_key
  UNION
  SELECT period_key FROM v_forecast WHERE project_key = :project_key AND period_key IS NOT NULL
),
b AS (SELECT period_key, SUM(budget_amount) AS amt FROM v_budget
      WHERE project_key = :project_key AND is_current = 1 AND period_key IS NOT NULL
      GROUP BY period_key),
bac AS (SELECT COALESCE(SUM(budget_amount),0) AS total FROM v_budget
        WHERE project_key = :project_key AND is_current = 1),
phased AS (SELECT COALESCE(SUM(amt),0) AS total FROM b),
a AS (SELECT period_key, SUM(amount)          AS amt FROM v_actual   WHERE project_key = :project_key GROUP BY period_key),
f AS (SELECT period_key, SUM(forecast_amount) AS amt FROM v_forecast WHERE project_key = :project_key AND is_current = 1 GROUP BY period_key)
SELECT
  p.period_key,
  COALESCE(b.amt,0) AS budget_period,
  COALESCE(a.amt,0) AS actual_period,
  COALESCE(f.amt,0) AS forecast_period,
  CASE WHEN (SELECT total FROM phased) = 0
       THEN (SELECT total FROM bac)
       ELSE SUM(COALESCE(b.amt,0)) OVER (ORDER BY p.period_key) END AS budget_cum,
  SUM(COALESCE(a.amt,0)) OVER (ORDER BY p.period_key) AS actual_cum,
  SUM(COALESCE(a.amt,0)) OVER (ORDER BY p.period_key)
    + SUM(COALESCE(f.amt,0)) OVER (ORDER BY p.period_key) AS forecast_cum,
  (SELECT total FROM bac) AS bac
FROM periods p
LEFT JOIN b ON b.period_key = p.period_key
LEFT JOIN a ON a.period_key = p.period_key
LEFT JOIN f ON f.period_key = p.period_key
ORDER BY p.period_key`,
  },
  {
    code: 'TOP_OVERRUNS',
    name: 'Top overruns',
    module: 'CROSS',
    category: 'Variance',
    description: 'WBS elements where actual cost has passed the current budget, worst first.',
    params: [P_PROJECT, { name: 'top_n', type: 'int', label: 'Top N', default: 20 }],
    viz: { kind: 'bar', label: 'wbs_name', value: 'overrun_amount', diverging: true },
    sql: `
WITH bud AS (
  SELECT wbs_key, wbs_code, wbs_name, SUM(budget_amount) AS budget_amount
  FROM v_budget WHERE project_key = :project_key AND is_current = 1
  GROUP BY wbs_key, wbs_code, wbs_name
),
act AS (
  SELECT wbs_key, SUM(amount) AS actual_amount
  FROM v_actual WHERE project_key = :project_key GROUP BY wbs_key
)
SELECT
  b.wbs_code, b.wbs_name,
  b.budget_amount,
  a.actual_amount,
  a.actual_amount - b.budget_amount AS overrun_amount,
  ROUND(100.0 * (a.actual_amount - b.budget_amount) / NULLIF(b.budget_amount,0), 1) AS overrun_pct
FROM bud b
JOIN act a ON a.wbs_key IS b.wbs_key
WHERE a.actual_amount > b.budget_amount
ORDER BY overrun_amount DESC
LIMIT COALESCE(:top_n, 20)`,
  },
  {
    code: 'PROJECT_SUMMARY',
    name: 'Portfolio summary',
    module: 'CROSS',
    category: 'Overview',
    description: 'One row per project: budget, actual, EAC and VAC across the portfolio.',
    params: [],
    viz: { kind: 'bar', label: 'project_name', value: 'actual_amount',
      reference: 'budget_amount', referenceLabel: 'Budget' },
    sql: `
SELECT
  p.project_code,
  p.project_name,
  p.status,
  COALESCE(b.budget_amount,0)  AS budget_amount,
  COALESCE(a.actual_amount,0)  AS actual_amount,
  COALESCE(f.etc_amount,0)     AS etc_amount,
  COALESCE(a.actual_amount,0) + COALESCE(f.etc_amount,0) AS eac_amount,
  COALESCE(b.budget_amount,0) - (COALESCE(a.actual_amount,0) + COALESCE(f.etc_amount,0)) AS vac_amount,
  ROUND(100.0 * COALESCE(a.actual_amount,0) / NULLIF(b.budget_amount,0), 1) AS pct_spent,
  a.last_data_date
FROM dim_project p
LEFT JOIN (SELECT project_key, SUM(budget_amount) budget_amount FROM v_budget WHERE is_current = 1 GROUP BY project_key) b
       ON b.project_key = p.project_key
LEFT JOIN (SELECT project_key, SUM(amount) actual_amount, MAX(data_date) last_data_date FROM v_actual GROUP BY project_key) a
       ON a.project_key = p.project_key
LEFT JOIN (SELECT project_key, SUM(forecast_amount) etc_amount FROM v_forecast WHERE is_current = 1 GROUP BY project_key) f
       ON f.project_key = p.project_key
WHERE p.is_active = 1
ORDER BY p.project_code`,
  },
  {
    code: 'PKG_SUMMARY',
    name: 'Cost by work package',
    module: 'CROSS',
    category: 'Overview',
    description: 'Budget vs. actual + accrued cost per work package (masonry, concrete, earthwork, ...), '
      + 'with an (unallocated) row for cost nobody has coded yet — the coding work still to do. '
      + 'Subcontract cost is pulled from the PO detail report, not the CJI3 posting, the same '
      + 'detail-substitution rule UNIFIED_COST_REGISTER uses, since that is where subcontract '
      + 'package coding actually lives; a PO with no detail loaded yet falls into (unallocated) '
      + 'rather than being silently dropped.',
    params: [P_PROJECT],
    viz: { kind: 'bar', label: 'work_package', value: 'variance_amount', diverging: true,
      headline: 'COST_REPORT_SUMMARY' },
    sql: `
WITH bud AS (
  SELECT COALESCE(work_package,'(unallocated)') AS work_package, SUM(budget_amount) AS budget_amount
  FROM v_budget WHERE project_key = :project_key AND is_current = 1
  GROUP BY COALESCE(work_package,'(unallocated)')
),
po_with_detail AS (
  SELECT DISTINCT po_no FROM v_service_line
  WHERE project_key = :project_key AND po_no IS NOT NULL AND po_no <> ''
),
mat_other_act AS (
  -- Material and "other" cost types resolve directly off the cost element.
  -- Subcontract is excluded here — its package coding lives on the PO's
  -- own detail report, picked up by sub_detail/sub_missing below instead.
  SELECT COALESCE(work_package,'(unallocated)') AS work_package, SUM(amount) AS actual_amount
  FROM v_actual WHERE project_key = :project_key AND cost_type <> 'SUBCONTRACT'
  GROUP BY COALESCE(work_package,'(unallocated)')
),
sub_detail AS (
  -- The subcontract package split, from the PO's own detail report.
  SELECT COALESCE(work_package,'(unallocated)') AS work_package, SUM(amount_net) AS actual_amount
  FROM v_service_line WHERE project_key = :project_key
  GROUP BY COALESCE(work_package,'(unallocated)')
),
sub_missing AS (
  -- A subcontract PO with no detail report loaded yet can't be package-coded —
  -- keep its cost visible as unallocated rather than dropping it.
  SELECT '(unallocated)' AS work_package, SUM(amount) AS actual_amount
  FROM v_actual
  WHERE project_key = :project_key AND cost_type = 'SUBCONTRACT'
    AND (po_no IS NULL OR po_no = '' OR po_no NOT IN (SELECT po_no FROM po_with_detail))
),
act AS (
  SELECT work_package, SUM(actual_amount) AS actual_amount FROM (
    SELECT * FROM mat_other_act
    UNION ALL SELECT * FROM sub_detail
    UNION ALL SELECT * FROM sub_missing
  ) GROUP BY work_package
),
acc AS (
  SELECT COALESCE(work_package,'(unallocated)') AS work_package, SUM(amount) AS accrual_amount
  FROM v_accrual WHERE project_key = :project_key
  GROUP BY COALESCE(work_package,'(unallocated)')
),
pkgs AS (
  SELECT work_package FROM bud
  UNION SELECT work_package FROM act
  UNION SELECT work_package FROM acc
)
SELECT
  p.work_package,
  wp.label AS work_package_label,
  wp.group_label AS work_package_group,
  COALESCE(b.budget_amount,0)   AS budget_amount,
  COALESCE(a.actual_amount,0)   AS actual_amount,
  COALESCE(c.accrual_amount,0)  AS accrual_amount,
  COALESCE(a.actual_amount,0) + COALESCE(c.accrual_amount,0) AS committed_amount,
  COALESCE(b.budget_amount,0) - (COALESCE(a.actual_amount,0) + COALESCE(c.accrual_amount,0)) AS variance_amount
FROM pkgs p
LEFT JOIN bud b ON b.work_package = p.work_package
LEFT JOIN act a ON a.work_package = p.work_package
LEFT JOIN acc c ON c.work_package = p.work_package
LEFT JOIN dim_work_package wp ON wp.code = p.work_package
ORDER BY (p.work_package = '(unallocated)'), variance_amount ASC`,
  },
  {
    code: 'INDIRECT_SUMMARY',
    name: 'Indirect cost vs. plan',
    module: 'CROSS',
    category: 'Overview',
    description: 'Indirect budget vs. actual + accrued indirect cost per WBS — indirect cost is never '
      + 'coded to a work package, so this compares against the indirect plan instead.',
    params: [P_PROJECT],
    viz: { kind: 'bar', label: 'wbs_name', value: 'variance_amount', diverging: true,
      headline: 'COST_REPORT_SUMMARY' },
    sql: `
WITH bud AS (
  SELECT wbs_key, wbs_code, wbs_name, SUM(budget_amount) AS budget_amount
  FROM v_budget WHERE project_key = :project_key AND is_current = 1 AND cost_type = 'INDIRECT'
  GROUP BY wbs_key, wbs_code, wbs_name
),
act AS (
  SELECT wbs_key, SUM(amount) AS actual_amount
  FROM v_actual WHERE project_key = :project_key AND cost_type = 'INDIRECT'
  GROUP BY wbs_key
),
acc AS (
  SELECT wbs_key, SUM(amount) AS accrual_amount
  FROM v_accrual WHERE project_key = :project_key AND cost_type = 'INDIRECT'
  GROUP BY wbs_key
)
SELECT
  b.wbs_code, b.wbs_name,
  b.budget_amount,
  COALESCE(a.actual_amount,0)  AS actual_amount,
  COALESCE(c.accrual_amount,0) AS accrual_amount,
  COALESCE(a.actual_amount,0) + COALESCE(c.accrual_amount,0) AS committed_amount,
  b.budget_amount - (COALESCE(a.actual_amount,0) + COALESCE(c.accrual_amount,0)) AS variance_amount
FROM bud b
LEFT JOIN act a ON a.wbs_key IS b.wbs_key
LEFT JOIN acc c ON c.wbs_key IS b.wbs_key
ORDER BY variance_amount ASC`,
  },
  {
    code: 'COST_REPORT_SUMMARY',
    name: 'Cost report headline figures',
    module: 'CROSS',
    category: 'Headline',
    description: 'The Summary node of the cost-report flow: BAC, actual cost, accrued cost, EAC and '
      + 'VAC across the whole project — reuses the same EAC/BAC math as the Dashboard, plus accrual.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
WITH b AS (SELECT SUM(budget_amount) AS total FROM v_budget
           WHERE project_key = :project_key AND is_current = 1),
     a AS (SELECT COALESCE(SUM(amount),0) AS total FROM v_actual WHERE project_key = :project_key),
     c AS (SELECT COALESCE(SUM(amount),0) AS total FROM v_accrual WHERE project_key = :project_key),
     f AS (SELECT COALESCE(SUM(forecast_amount),0) AS total FROM v_forecast
           WHERE project_key = :project_key AND is_current = 1)
SELECT
  (SELECT total FROM b) AS bac,
  (SELECT total FROM a) AS actual_cost,
  (SELECT total FROM c) AS accrued_cost,
  (SELECT total FROM f) AS etc,
  (SELECT total FROM a) + (SELECT total FROM c) + (SELECT total FROM f) AS eac,
  CASE WHEN (SELECT total FROM b) IS NULL THEN NULL
       ELSE (SELECT total FROM b)
         - ((SELECT total FROM a) + (SELECT total FROM c) + (SELECT total FROM f)) END AS vac`,
  },
  {
    code: 'COST_VS_REVENUE',
    name: 'Cost vs revenue by period',
    module: 'CROSS',
    category: 'Overview',
    description: 'Actual cost against revenue billed, per period, with the running margin. '
      + 'A CJI3 export carries income on 4xxxxxxx accounts as negative amounts; this keeps the two apart.',
    params: [P_PROJECT],
    viz: { kind: 'line', x: 'period_key',
      series: [{ column: 'revenue_cum', label: 'Revenue (cum.)' },
               { column: 'cost_cum', label: 'Cost (cum.)' },
               { column: 'margin_cum', label: 'Margin (cum.)' }],
      headline: 'KPI_PROJECT' },
    sql: `
WITH periods AS (
  SELECT period_key FROM v_actual  WHERE project_key = :project_key
  UNION
  SELECT period_key FROM v_revenue WHERE project_key = :project_key
),
c AS (SELECT period_key, SUM(amount) AS amt FROM v_actual  WHERE project_key = :project_key GROUP BY period_key),
r AS (SELECT period_key, SUM(amount) AS amt FROM v_revenue WHERE project_key = :project_key GROUP BY period_key)
SELECT
  p.period_key,
  COALESCE(r.amt,0) AS revenue,
  COALESCE(c.amt,0) AS cost,
  COALESCE(r.amt,0) - COALESCE(c.amt,0) AS margin,
  SUM(COALESCE(r.amt,0)) OVER (ORDER BY p.period_key) AS revenue_cum,
  SUM(COALESCE(c.amt,0)) OVER (ORDER BY p.period_key) AS cost_cum,
  SUM(COALESCE(r.amt,0)) OVER (ORDER BY p.period_key)
    - SUM(COALESCE(c.amt,0)) OVER (ORDER BY p.period_key) AS margin_cum,
  ROUND(100.0 * (SUM(COALESCE(r.amt,0)) OVER (ORDER BY p.period_key)
    - SUM(COALESCE(c.amt,0)) OVER (ORDER BY p.period_key))
    / NULLIF(SUM(COALESCE(r.amt,0)) OVER (ORDER BY p.period_key), 0), 1) AS margin_pct
FROM periods p
LEFT JOIN c ON c.period_key = p.period_key
LEFT JOIN r ON r.period_key = p.period_key
ORDER BY p.period_key`,
  },
  {
    code: 'WBS_ROLLUP',
    name: 'WBS tree with rolled-up actuals',
    module: 'ACTUAL',
    category: 'Aggregation',
    description: 'The cost breakdown structure down to a chosen level, with actual cost rolled up '
      + 'from every descendant. Uses the materialised path, so no recursion is needed.',
    params: [P_PROJECT, { name: 'max_level', type: 'int', label: 'Down to level', default: 3 }],
    viz: { kind: 'bar', label: 'wbs_name', value: 'actual_rollup',
      reference: 'budget_rollup', referenceLabel: 'Budget' },
    sql: `
SELECT
  w.wbs_level,
  w.wbs_code,
  w.wbs_name,
  w.is_leaf,
  (SELECT COALESCE(SUM(a.amount),0) FROM v_actual a
     JOIN dim_wbs d ON d.wbs_key = a.wbs_key
    WHERE d.wbs_path LIKE w.wbs_path || '%') AS actual_rollup,
  (SELECT COALESCE(SUM(b.budget_amount),0) FROM v_budget b
     JOIN dim_wbs d ON d.wbs_key = b.wbs_key
    WHERE b.is_current = 1 AND d.wbs_path LIKE w.wbs_path || '%') AS budget_rollup,
  w.planned_start,
  w.planned_finish
FROM dim_wbs w
WHERE w.project_key = :project_key
  AND w.wbs_level <= COALESCE(:max_level, 3)
ORDER BY w.wbs_path`,
  },
  {
    code: 'SC_PO_RECONCILIATION',
    name: 'PO reconciliation: actuals vs service lines',
    module: 'SERVICE',
    category: 'Reconciliation',
    description: 'Per purchase order, actual cost posted in SAP against the subcontractor service '
      + 'lines behind it. A difference means the sub-ledger and the ledger disagree — or that a '
      + 'certificate has not been loaded yet.',
    params: [P_PROJECT, { name: 'tolerance', type: 'int', label: 'Tolerance', default: 1 }],
    viz: { kind: 'bar', label: 'po_no', value: 'difference', diverging: true,
      headline: 'KPI_SUBCONTRACT' },
    sql: `
WITH act AS (
  SELECT po_no, SUM(amount) AS amount, COUNT(*) AS posting_lines
  FROM v_actual WHERE project_key = :project_key AND po_no IS NOT NULL AND po_no <> ''
  GROUP BY po_no
),
sl AS (
  SELECT po_no, SUM(amount_net) AS amount, COUNT(*) AS service_lines,
         MAX(vendor_name) AS vendor_name, COUNT(DISTINCT invoice_no) AS certificates
  FROM v_service_line WHERE project_key = :project_key
  GROUP BY po_no
),
keys AS (SELECT po_no FROM act UNION SELECT po_no FROM sl)
SELECT
  k.po_no,
  sl.vendor_name,
  COALESCE(act.amount,0)        AS actual_amount,
  COALESCE(sl.amount,0)         AS service_line_amount,
  COALESCE(act.amount,0) - COALESCE(sl.amount,0) AS difference,
  act.posting_lines,
  sl.service_lines,
  sl.certificates,
  CASE
    WHEN sl.amount IS NULL THEN 'NO SERVICE DETAIL'
    WHEN act.amount IS NULL THEN 'NOT POSTED'
    WHEN ABS(COALESCE(act.amount,0) - COALESCE(sl.amount,0)) <= COALESCE(:tolerance,1) THEN 'RECONCILED'
    ELSE 'DIFFERENCE'
  END AS status
FROM keys k
LEFT JOIN act ON act.po_no = k.po_no
LEFT JOIN sl  ON sl.po_no  = k.po_no
ORDER BY ABS(COALESCE(act.amount,0) - COALESCE(sl.amount,0)) DESC, k.po_no`,
  },
  {
    code: 'SC_BY_SUPPLIER',
    name: 'Subcontractors by value',
    module: 'SERVICE',
    category: 'Aggregation',
    description: 'Certified work per subcontractor, net and gross, with the number of certificates.',
    params: [P_PROJECT],
    viz: { kind: 'bar', label: 'supplier', value: 'work_done_net', headline: 'KPI_SUBCONTRACT' },
    sql: `
SELECT
  COALESCE(vendor_name, vendor_code, '(unknown)') AS supplier,
  COUNT(DISTINCT po_no)      AS purchase_orders,
  COUNT(DISTINCT invoice_no) AS certificates,
  COUNT(*)                   AS service_lines,
  SUM(amount_net)            AS work_done_net,
  SUM(COALESCE(amount_vat,0)) AS vat,
  SUM(COALESCE(amount_gross, amount_net + COALESCE(amount_vat,0))) AS work_done_gross,
  ROUND(100.0 * SUM(amount_net) / NULLIF(SUM(SUM(amount_net)) OVER (), 0), 1) AS pct_of_total
FROM v_service_line
WHERE project_key = :project_key
GROUP BY COALESCE(vendor_name, vendor_code, '(unknown)')
ORDER BY work_done_net DESC`,
  },
  {
    code: 'SC_BY_CATEGORY',
    name: 'Subcontract work by category',
    module: 'SERVICE',
    category: 'Aggregation',
    description: 'Certified work grouped by the work category on the certificate (concrete, '
      + 'equipment rent, finishes …), with the WBS elements it touches.',
    params: [P_PROJECT],
    viz: { kind: 'treemap', label: 'category', value: 'work_done_net',
      headline: 'KPI_SUBCONTRACT' },
    sql: `
SELECT
  COALESCE(category,'(uncategorised)') AS category,
  COUNT(DISTINCT wbs_code)  AS wbs_elements,
  COUNT(DISTINCT vendor_name) AS suppliers,
  COUNT(*)                  AS service_lines,
  SUM(amount_net)           AS work_done_net,
  ROUND(100.0 * SUM(amount_net) / NULLIF(SUM(SUM(amount_net)) OVER (), 0), 1) AS pct_of_total
FROM v_service_line
WHERE project_key = :project_key
GROUP BY COALESCE(category,'(uncategorised)')
ORDER BY work_done_net DESC`,
  },
  {
    code: 'SC_LINE_DETAIL',
    name: 'Service line detail',
    module: 'SERVICE',
    category: 'Detail',
    description: 'Every certified service line. Filter by purchase order to drill from an actual '
      + 'cost posting into exactly what was certified against it.',
    params: [P_PROJECT, { name: 'po_no', type: 'text', label: 'Purchase order' }],
    viz: { kind: 'table' },
    sql: `
SELECT
  po_no, invoice_serial, invoice_no, period_key, vendor_name,
  wbs_code, wbs_name, cost_element_code, category, service_code, service_text,
  uom, unit_rate, quantity_previous, quantity_current, quantity_total, progress_pct,
  amount_net, amount_vat, amount_gross
FROM v_service_line
WHERE project_key = :project_key
  AND (:po_no IS NULL OR po_no = :po_no)
ORDER BY po_no, invoice_no, item_no, line_no`,
  },
  {
    code: 'SC_COVERAGE',
    name: 'Subcontract coverage of actuals',
    module: 'SERVICE',
    category: 'Reconciliation',
    description: 'How much of actual cost is explained by loaded service-line detail, split by '
      + 'whether the posting carries a purchase order at all.',
    params: [P_PROJECT],
    viz: { kind: 'bar', label: 'bucket', value: 'amount' },
    sql: `
WITH a AS (
  SELECT
    CASE WHEN po_no IS NULL OR po_no = '' THEN 'No purchase order' ELSE 'On a purchase order' END AS bucket,
    SUM(amount) AS amount, COUNT(*) AS lines
  FROM v_actual WHERE project_key = :project_key
  GROUP BY 1
)
SELECT bucket, lines, amount,
       ROUND(100.0 * amount / NULLIF(SUM(amount) OVER (), 0), 1) AS pct_of_actual,
       (SELECT COALESCE(SUM(amount_net),0) FROM v_service_line WHERE project_key = :project_key) AS service_lines_loaded
FROM a
ORDER BY amount DESC`,
  },
  {
    code: 'SC_MONTHLY_TREND',
    name: 'Certified vs actual, by month',
    module: 'SERVICE',
    category: 'Trend',
    description: 'Certified subcontract work against the matching actual cost (postings carrying a '
      + 'PO), month by month, cumulative — a gap that widens over time is a certificate not yet '
      + 'loaded, or actual cost posted ahead of certification.',
    params: [P_PROJECT],
    viz: { kind: 'line', x: 'period_key',
      series: [{ column: 'actual_cum', label: 'Actual (PO postings, cum.)' },
               { column: 'certified_cum', label: 'Certified (cum.)' }],
      headline: 'KPI_SUBCONTRACT' },
    sql: `
WITH act AS (
  SELECT period_key, SUM(amount) AS actual_amount
  FROM v_actual WHERE project_key = :project_key AND po_no IS NOT NULL AND po_no <> ''
  GROUP BY period_key
),
sl AS (
  SELECT period_key, SUM(amount_net) AS certified_amount
  FROM v_service_line WHERE project_key = :project_key
  GROUP BY period_key
),
periods AS (
  SELECT period_key FROM act UNION SELECT period_key FROM sl
)
SELECT
  p.period_key,
  COALESCE(a.actual_amount,0)     AS actual_amount,
  COALESCE(s.certified_amount,0)  AS certified_amount,
  SUM(COALESCE(a.actual_amount,0))    OVER (ORDER BY p.period_key) AS actual_cum,
  SUM(COALESCE(s.certified_amount,0)) OVER (ORDER BY p.period_key) AS certified_cum
FROM periods p
LEFT JOIN act a ON a.period_key = p.period_key
LEFT JOIN sl  s ON s.period_key = p.period_key
ORDER BY p.period_key`,
  },
  {
    code: 'SC_RECONCILIATION_STATUS',
    name: 'PO reconciliation status summary',
    module: 'SERVICE',
    category: 'Reconciliation',
    description: 'How many purchase orders fall into each reconciliation status, and how much money '
      + 'each status accounts for — the same classification as SC_PO_RECONCILIATION, rolled up.',
    params: [P_PROJECT],
    viz: { kind: 'bar', label: 'status', value: 'pos' },
    sql: `
WITH act AS (
  SELECT po_no, SUM(amount) AS amount FROM v_actual
  WHERE project_key = :project_key AND po_no IS NOT NULL AND po_no <> '' GROUP BY po_no
),
sl AS (
  SELECT po_no, SUM(amount_net) AS amount FROM v_service_line
  WHERE project_key = :project_key GROUP BY po_no
),
keys AS (SELECT po_no FROM act UNION SELECT po_no FROM sl),
scored AS (
  SELECT
    COALESCE(act.amount,0) AS actual_amount, COALESCE(sl.amount,0) AS service_line_amount,
    CASE
      WHEN sl.amount IS NULL THEN 'NO SERVICE DETAIL'
      WHEN act.amount IS NULL THEN 'NOT POSTED'
      WHEN ABS(COALESCE(act.amount,0) - COALESCE(sl.amount,0)) <= 1 THEN 'RECONCILED'
      ELSE 'DIFFERENCE'
    END AS status
  FROM keys k
  LEFT JOIN act ON act.po_no = k.po_no
  LEFT JOIN sl  ON sl.po_no  = k.po_no
)
SELECT status, COUNT(*) AS pos, SUM(actual_amount) AS actual_amount, SUM(service_line_amount) AS service_line_amount
FROM scored
GROUP BY status
ORDER BY pos DESC`,
  },
  {
    // The PO-level reconciliation (SC_PO_RECONCILIATION) can look "RECONCILED"
    // while hiding a real timing gap: CJI3 is a batch extract and can lag the
    // certificate register by a cycle, so the newest certificate under a PO
    // is often the one not posted yet, not the PO as a whole. Rolling the
    // certified amount up per invoice, in submission order, and comparing
    // that running total against the PO's actual cost to date localises the
    // gap to the specific certificate causing it.
    code: 'SC_INVOICE_RECONCILIATION',
    name: 'PO vs invoice reconciliation',
    module: 'SERVICE',
    category: 'Reconciliation',
    description: 'Every certificate (invoice serial) under every PO, with its own certified value, '
      + 'the running certified total for that PO up to and including it, and whether that running '
      + 'total is still within what CJI3 has posted for the PO so far. A certificate flagged "not yet '
      + 'in actual cost" is the one actually causing the PO-level gap, not the PO as a whole.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
WITH po_actual AS (
  SELECT po_no, SUM(amount) AS po_actual_amount
  FROM v_actual
  WHERE project_key = :project_key AND po_no IS NOT NULL AND po_no <> ''
  GROUP BY po_no
),
invoices AS (
  SELECT
    po_no, vendor_name,
    COALESCE(NULLIF(invoice_serial,''), invoice_no, '(no serial)') AS invoice_serial,
    invoice_no, period_key,
    SUM(amount_net)     AS certified_amount,
    COUNT(*)            AS lines,
    MAX(progress_pct)   AS progress_pct
  FROM v_service_line
  WHERE project_key = :project_key
  GROUP BY po_no, vendor_name,
           COALESCE(NULLIF(invoice_serial,''), invoice_no, '(no serial)'), invoice_no, period_key
),
running AS (
  SELECT
    i.*,
    SUM(i.certified_amount) OVER (
      PARTITION BY i.po_no ORDER BY i.period_key, i.invoice_serial
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS certified_cumulative
  FROM invoices i
)
SELECT
  r.po_no, r.vendor_name, r.invoice_serial, r.invoice_no, r.period_key,
  r.lines, r.progress_pct, r.certified_amount, r.certified_cumulative,
  COALESCE(pa.po_actual_amount,0) AS po_actual_amount,
  CASE WHEN r.certified_cumulative > COALESCE(pa.po_actual_amount,0) + 1 THEN 1 ELSE 0 END AS not_yet_posted,
  CASE WHEN r.certified_cumulative > COALESCE(pa.po_actual_amount,0) + 1
       THEN 'Not yet in actual cost (CJI3 lag)'
       ELSE 'Posted' END AS status
FROM running r
LEFT JOIN po_actual pa ON pa.po_no = r.po_no
ORDER BY r.po_no, r.period_key, r.invoice_serial`,
  },
  {
    code: 'REVENUE_BY_WBS',
    name: 'Revenue by WBS',
    module: 'CROSS',
    category: 'Overview',
    description: 'Income posted to the project, by WBS element and period.',
    params: [P_PROJECT],
    viz: { kind: 'bar', label: 'wbs_name', value: 'revenue' },
    sql: `
SELECT
  wbs_code, wbs_name, period_key,
  cost_element_code, cost_element_name,
  COUNT(*) AS postings,
  SUM(amount) AS revenue
FROM v_revenue
WHERE project_key = :project_key
GROUP BY wbs_code, wbs_name, period_key, cost_element_code, cost_element_name
ORDER BY revenue DESC`,
  },
  {
    code: 'ACT_BY_DOC_TYPE',
    name: 'Actuals by document type',
    module: 'ACTUAL',
    category: 'Data quality',
    description: 'Cost split by SAP document type — useful for spotting reversals and journal '
      + 'corrections hiding inside the actuals.',
    params: [P_PROJECT],
    viz: { kind: 'bar', label: 'document_type', value: 'net_amount', diverging: true },
    sql: `
SELECT
  COALESCE(NULLIF(document_type,''),'(none)') AS document_type,
  COUNT(*)   AS postings,
  SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS debits,
  SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END) AS credits,
  SUM(amount) AS net_amount
FROM v_actual
WHERE project_key = :project_key
GROUP BY COALESCE(NULLIF(document_type,''),'(none)')
ORDER BY ABS(SUM(amount)) DESC`,
  },
  {
    code: 'GL_DOC_TYPE_MATRIX',
    name: 'GL × document type',
    module: 'ACTUAL',
    category: 'Data quality',
    description: 'Spend by document type against the biggest cost elements, by description — an '
      + 'illustration of which document types actually post against which GLs, not a full report.',
    params: [P_PROJECT, { name: 'top_n', type: 'int', label: 'Top N GLs', default: 12 }],
    viz: { kind: 'heatmap', row: 'cost_element', col: 'document_type', value: 'amount' },
    sql: `
WITH gl_totals AS (
  SELECT
    cost_element_code,
    CASE WHEN cost_element_name IS NOT NULL AND cost_element_name <> ''
         THEN cost_element_name || ' (' || cost_element_code || ')'
         ELSE cost_element_code END AS gl_label,
    SUM(amount) AS total_amount
  FROM v_actual
  WHERE project_key = :project_key
  GROUP BY cost_element_code, gl_label
),
top_gl AS (
  SELECT cost_element_code, gl_label
  FROM gl_totals
  ORDER BY ABS(total_amount) DESC
  LIMIT COALESCE(:top_n, 12)
)
SELECT
  t.gl_label                                    AS cost_element,
  COALESCE(NULLIF(a.document_type,''),'(none)') AS document_type,
  SUM(a.amount)                                  AS amount
FROM v_actual a
JOIN top_gl t ON t.cost_element_code = a.cost_element_code
WHERE a.project_key = :project_key
GROUP BY t.gl_label, COALESCE(NULLIF(a.document_type,''),'(none)')
ORDER BY t.gl_label`,
  },
  {
    // Detail Substitution, the Reports-page cut: the same merge
    // UNIFIED_COST_REGISTER performs (a CJI3 posting is left out once a PO or
    // settled order has its own detail loaded, so nothing is counted twice),
    // grouped down to cost type / GL / month instead of listed line by line.
    // The po_with_detail / order_with_detail CTEs are duplicated from
    // UNIFIED_COST_REGISTER rather than shared — system queries are
    // independent stored SQL, the same tradeoff UNIFIED_COST_SUMMARY already
    // makes.
    code: 'COST_BY_TYPE_GL_MONTH',
    name: 'Actuals by cost type, GL and month',
    module: 'ACTUAL',
    category: 'Detail',
    description: 'Actual cost per cost type, GL account, WBS and month, with PO and settled-order '
      + 'detail substituted in where it has been loaded — the source data behind the Reports page '
      + 'pivot, which turns period_key into columns and groups by cost type / GL / WBS in the UI.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
WITH po_with_detail AS (
  SELECT DISTINCT po_no FROM v_service_line
  WHERE project_key = :project_key AND po_no IS NOT NULL AND po_no <> ''
),
order_with_detail AS (
  SELECT DISTINCT order_no FROM v_order_line
  WHERE project_key = :project_key AND category = 'WBS'
    AND order_no IS NOT NULL AND order_no <> ''
),
direct_cost AS (
  SELECT
    COALESCE(a.cost_type,'UNMAPPED') AS cost_type,
    a.cost_element_code, a.cost_element_name, a.wbs_code, a.wbs_name, a.period_key, a.amount
  FROM v_actual a
  WHERE a.project_key = :project_key
    AND (a.po_no IS NULL OR a.po_no = '' OR a.po_no NOT IN (SELECT po_no FROM po_with_detail))
    AND (a.partner_object_type IS NULL OR a.partner_object_type <> 'Order'
         OR a.partner_object IS NULL OR a.partner_object = ''
         OR a.partner_object NOT IN (SELECT order_no FROM order_with_detail))
),
detail_lines AS (
  SELECT
    COALESCE(s.cost_type,'UNMAPPED') AS cost_type,
    s.cost_element_code, s.cost_element_name, s.wbs_code, s.wbs_name, s.period_key, s.amount_net AS amount
  FROM v_service_line s
  WHERE s.project_key = :project_key
),
order_detail AS (
  SELECT
    COALESCE(s.cost_type,'UNMAPPED') AS cost_type,
    s.cost_element_code, s.cost_element_name, s.wbs_code, s.wbs_name, s.period_key, s.amount
  FROM v_order_line s
  WHERE s.project_key = :project_key AND s.category = 'WBS'
),
merged AS (
  SELECT * FROM direct_cost
  UNION ALL SELECT * FROM detail_lines
  UNION ALL SELECT * FROM order_detail
)
SELECT
  cost_type, cost_element_code, cost_element_name, wbs_code, wbs_name, period_key,
  COUNT(*)    AS postings,
  SUM(amount) AS amount
FROM merged
GROUP BY cost_type, cost_element_code, cost_element_name, wbs_code, wbs_name, period_key
ORDER BY cost_type, cost_element_code, wbs_code, period_key`,
  },
  {
    code: 'COST_BY_TYPE_GL_TXN',
    name: 'Actual postings for a GL',
    module: 'ACTUAL',
    category: 'Detail',
    description: 'Every individual posting behind one GL account, merging direct CJI3 postings with '
      + 'PO and settled-order detail the same way COST_BY_TYPE_GL_MONTH does — the transaction-level '
      + 'drill-down under the Reports page pivot. Leave the GL blank to see every posting.',
    params: [P_PROJECT, { name: 'cost_element_code', type: 'text', label: 'GL account' }],
    viz: { kind: 'table' },
    sql: `
WITH po_with_detail AS (
  SELECT DISTINCT po_no FROM v_service_line
  WHERE project_key = :project_key AND po_no IS NOT NULL AND po_no <> ''
),
order_with_detail AS (
  SELECT DISTINCT order_no FROM v_order_line
  WHERE project_key = :project_key AND category = 'WBS'
    AND order_no IS NOT NULL AND order_no <> ''
),
direct_cost AS (
  SELECT
    'ACTUAL' AS source, COALESCE(a.cost_type,'UNMAPPED') AS cost_type,
    a.cost_element_code, a.cost_element_name, a.wbs_code, a.wbs_name,
    a.document_no AS document_no, a.document_type, a.period_key, a.data_date,
    a.vendor_name, a.description, a.quantity, a.uom, a.amount
  FROM v_actual a
  WHERE a.project_key = :project_key
    AND (a.po_no IS NULL OR a.po_no = '' OR a.po_no NOT IN (SELECT po_no FROM po_with_detail))
    AND (a.partner_object_type IS NULL OR a.partner_object_type <> 'Order'
         OR a.partner_object IS NULL OR a.partner_object = ''
         OR a.partner_object NOT IN (SELECT order_no FROM order_with_detail))
),
detail_lines AS (
  SELECT
    'SERVICE' AS source, COALESCE(s.cost_type,'UNMAPPED') AS cost_type,
    s.cost_element_code, s.cost_element_name, s.wbs_code, s.wbs_name,
    s.invoice_no AS document_no, NULL AS document_type, s.period_key, s.data_date,
    s.vendor_name, s.service_text AS description, s.quantity_current AS quantity, s.uom, s.amount_net AS amount
  FROM v_service_line s
  WHERE s.project_key = :project_key
),
order_detail AS (
  SELECT
    'ORDER' AS source, COALESCE(s.cost_type,'UNMAPPED') AS cost_type,
    s.cost_element_code, s.cost_element_name, s.wbs_code, s.wbs_name,
    s.order_no AS document_no, NULL AS document_type, s.period_key, s.data_date,
    s.vendor_name, s.order_description AS description, s.quantity, s.uom, s.amount
  FROM v_order_line s
  WHERE s.project_key = :project_key AND s.category = 'WBS'
),
merged AS (
  SELECT * FROM direct_cost
  UNION ALL SELECT * FROM detail_lines
  UNION ALL SELECT * FROM order_detail
)
SELECT *
FROM merged
WHERE
  -- cost_element_code is text even when every digit looks numeric (e.g. "30301100"),
  -- and the generic query runner binds a numeric-looking parameter as a number, so
  -- a plain text comparison silently fails for those GLs. The second branch recovers
  -- them (round-tripping through INTEGER strips the REAL's trailing ".0"); it is a
  -- no-op for a genuinely alphanumeric code, which the first branch already matches.
  (:cost_element_code IS NULL
   OR cost_element_code = :cost_element_code
   OR cost_element_code = CAST(CAST(:cost_element_code AS INTEGER) AS TEXT))
ORDER BY period_key, document_no`,
  },
  {
    code: 'BUDGET_BY_TYPE_GL_MONTH',
    name: 'Budget by cost type, GL and month',
    module: 'BUDGET',
    category: 'Detail',
    description: 'Current approved budget per cost type, GL account, WBS and month — the same shape '
      + 'as COST_BY_TYPE_GL_MONTH, so the Reports page pivot can show Budget instead of Actual with no '
      + 'change to how it renders.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
SELECT
  COALESCE(cost_type,'UNMAPPED') AS cost_type,
  cost_element_code, cost_element_name, wbs_code, wbs_name, period_key,
  COUNT(*)             AS postings,
  SUM(budget_amount)   AS amount
FROM v_budget
WHERE project_key = :project_key AND is_current = 1
GROUP BY COALESCE(cost_type,'UNMAPPED'), cost_element_code, cost_element_name, wbs_code, wbs_name, period_key
ORDER BY cost_type, cost_element_code, wbs_code, period_key`,
  },
  {
    code: 'FORECAST_BY_TYPE_GL_MONTH',
    name: 'Forecast by cost type, GL and month',
    module: 'FORECAST',
    category: 'Detail',
    description: 'Current ETC/EAC forecast per cost type, GL account, WBS and month — the same shape '
      + 'as COST_BY_TYPE_GL_MONTH, so the Reports page pivot can show Forecast instead of Actual with '
      + 'no change to how it renders.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
SELECT
  COALESCE(cost_type,'UNMAPPED') AS cost_type,
  cost_element_code, cost_element_name, wbs_code, wbs_name, period_key,
  COUNT(*)              AS postings,
  SUM(forecast_amount)  AS amount
FROM v_forecast
WHERE project_key = :project_key AND is_current = 1
GROUP BY COALESCE(cost_type,'UNMAPPED'), cost_element_code, cost_element_name, wbs_code, wbs_name, period_key
ORDER BY cost_type, cost_element_code, wbs_code, period_key`,
  },
  {
    // Anomaly detection stays explainable: every flag is a plain SQL predicate,
    // computed once per posting, never a black-box score. A GL needs at least
    // 5 postings of its own before the "unusually large" check fires, so a
    // thin GL with one big legitimate posting doesn't flag itself.
    code: 'ANOMALY_TRANSACTIONS',
    name: 'Anomaly transactions',
    module: 'ACTUAL',
    category: 'Data quality',
    description: 'Actual postings worth a second look — unclassified cost type, no WBS element, a '
      + 'negative amount, a posting far larger than the GL\'s own average, a subcontract cost with no '
      + 'vendor named, a PO or settled order with no detail loaded yet to verify it, or a likely '
      + 'duplicate (same WBS, GL, vendor, amount and period posted more than once).',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
WITH base AS (
  SELECT
    a.wbs_code, a.wbs_name, COALESCE(a.cost_type,'UNMAPPED') AS cost_type,
    a.cost_element_code, a.cost_element_name,
    a.document_no, a.document_type, a.period_key, a.data_date,
    a.vendor_name, a.description, a.quantity, a.uom, a.amount,
    a.po_no, a.partner_object_type, a.partner_object
  FROM v_actual a
  WHERE a.project_key = :project_key
),
scored AS (
  SELECT *,
    AVG(ABS(amount)) OVER (PARTITION BY cost_element_code) AS gl_avg_abs,
    COUNT(*)         OVER (PARTITION BY cost_element_code) AS gl_n,
    COUNT(*)         OVER (PARTITION BY wbs_code, cost_element_code, vendor_name, amount, period_key) AS dup_n
  FROM base
),
flagged AS (
  SELECT *,
    RTRIM(
      CASE WHEN cost_type = 'UNMAPPED' THEN 'Cost type not classified; ' ELSE '' END ||
      CASE WHEN wbs_code IS NULL OR wbs_code = '' THEN 'No WBS element; ' ELSE '' END ||
      CASE WHEN amount < 0 THEN 'Negative amount; ' ELSE '' END ||
      CASE WHEN gl_n >= 5 AND gl_avg_abs > 0 AND ABS(amount) > 5 * gl_avg_abs
           THEN 'Unusually large for this GL (over 5x its average); ' ELSE '' END ||
      CASE WHEN cost_type = 'SUBCONTRACT' AND (vendor_name IS NULL OR vendor_name = '')
           THEN 'Subcontract cost with no vendor named; ' ELSE '' END ||
      CASE WHEN po_no IS NOT NULL AND po_no <> ''
                AND po_no NOT IN (SELECT DISTINCT po_no FROM v_service_line
                                   WHERE project_key = :project_key AND po_no IS NOT NULL AND po_no <> '')
           THEN 'PO posted, no service-line detail loaded yet; ' ELSE '' END ||
      CASE WHEN partner_object_type = 'Order' AND partner_object IS NOT NULL AND partner_object <> ''
                AND partner_object NOT IN (SELECT DISTINCT order_no FROM v_order_line
                                             WHERE project_key = :project_key AND category = 'WBS'
                                               AND order_no IS NOT NULL AND order_no <> '')
           THEN 'Settled order posting, no order-line detail loaded yet; ' ELSE '' END ||
      CASE WHEN dup_n > 1
           THEN 'Possible duplicate — same WBS, GL, vendor and amount posted more than once this period; '
           ELSE '' END,
      '; ')
    AS reasons
  FROM scored
)
SELECT
  wbs_code, wbs_name, cost_type, cost_element_code, cost_element_name,
  document_no, document_type, period_key, data_date, vendor_name, description,
  quantity, uom, amount, reasons
FROM flagged
WHERE reasons <> ''
ORDER BY period_key DESC, ABS(amount) DESC`,
  },
  {
    code: 'KPI_MATERIAL',
    name: 'Material headline figures',
    module: 'ACTUAL',
    category: 'Material',
    description: 'One row of totals for material cost — spend, share of total actual cost, and how '
      + 'many GLs and vendors it runs through. The Material Analysis page reads its KPI tiles from '
      + 'this rather than summing the detail table in the UI.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
WITH m AS (
  SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS n,
         COUNT(DISTINCT cost_element_code) AS gls, COUNT(DISTINCT vendor_name) AS vendors
  FROM v_actual WHERE project_key = :project_key AND cost_type = 'MATERIAL'
),
a AS (SELECT COALESCE(SUM(amount),0) AS total FROM v_actual WHERE project_key = :project_key)
SELECT
  (SELECT total   FROM m) AS material_amount,
  (SELECT n       FROM m) AS postings,
  (SELECT gls     FROM m) AS gl_count,
  (SELECT vendors FROM m) AS vendor_count,
  (SELECT total   FROM a) AS actual_total,
  ROUND(100.0 * (SELECT total FROM m) / NULLIF((SELECT total FROM a),0), 1) AS pct_of_actual`,
  },
  {
    code: 'MATERIAL_BY_GL',
    name: 'Material spend by GL',
    module: 'ACTUAL',
    category: 'Material',
    description: 'Material cost rolled up per GL account.',
    params: [P_PROJECT],
    viz: { kind: 'bar', label: 'cost_element_name', value: 'amount' },
    sql: `
SELECT cost_element_code, COALESCE(cost_element_name, cost_element_code) AS cost_element_name,
       COUNT(*) AS postings, SUM(amount) AS amount
FROM v_actual
WHERE project_key = :project_key AND cost_type = 'MATERIAL'
GROUP BY cost_element_code, COALESCE(cost_element_name, cost_element_code)
ORDER BY amount DESC`,
  },
  {
    code: 'MATERIAL_BY_WBS',
    name: 'Material spend by WBS',
    module: 'ACTUAL',
    category: 'Material',
    description: 'Material cost rolled up per WBS element — where the material money is going '
      + 'structurally.',
    params: [P_PROJECT],
    viz: { kind: 'treemap', label: 'wbs_name', value: 'amount' },
    sql: `
SELECT COALESCE(wbs_code,'(no WBS)') AS wbs_code, COALESCE(wbs_name, wbs_code, '(no WBS)') AS wbs_name,
       COUNT(*) AS postings, SUM(amount) AS amount
FROM v_actual
WHERE project_key = :project_key AND cost_type = 'MATERIAL'
GROUP BY COALESCE(wbs_code,'(no WBS)'), COALESCE(wbs_name, wbs_code, '(no WBS)')
ORDER BY amount DESC`,
  },
  {
    code: 'MATERIAL_BY_VENDOR',
    name: 'Material spend by vendor',
    module: 'ACTUAL',
    category: 'Material',
    description: 'Material cost rolled up per supplier — concentration risk reads the same way it '
      + 'does for subcontractors.',
    params: [P_PROJECT],
    viz: { kind: 'bar', label: 'vendor_name', value: 'amount' },
    sql: `
SELECT COALESCE(vendor_name,'(no vendor)') AS vendor_name, COUNT(*) AS postings, SUM(amount) AS amount
FROM v_actual
WHERE project_key = :project_key AND cost_type = 'MATERIAL'
GROUP BY COALESCE(vendor_name,'(no vendor)')
ORDER BY amount DESC`,
  },
  {
    code: 'MATERIAL_MONTHLY_TREND',
    name: 'Material spend by month',
    module: 'ACTUAL',
    category: 'Trend',
    description: 'Material cost per month with a running cumulative total.',
    params: [P_PROJECT],
    viz: { kind: 'line', x: 'period_key', area: true,
      series: [{ column: 'period_amount', label: 'Spend in period' }],
      headline: 'KPI_MATERIAL' },
    sql: `
SELECT
  period_key,
  SUM(amount) AS period_amount,
  SUM(SUM(amount)) OVER (ORDER BY period_key
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cumulative_amount
FROM v_actual
WHERE project_key = :project_key AND cost_type = 'MATERIAL'
GROUP BY period_key
ORDER BY period_key`,
  },
  {
    // Same explainable-deviation technique as ANOMALY_TRANSACTIONS, applied to
    // unit rate (amount / quantity) instead of amount — a pricing error or an
    // off-catalogue purchase shows up as a rate outlier even when the total
    // amount on the line looks unremarkable.
    code: 'MATERIAL_RATE_OUTLIERS',
    name: 'Material unit-rate outliers',
    module: 'ACTUAL',
    category: 'Material',
    description: 'Material postings whose unit rate (amount ÷ quantity) is more than 5x its GL\'s own '
      + 'average rate — a likely pricing error, wrong UoM, or a purchase outside the usual supplier '
      + 'agreement. A GL needs at least 5 priced postings before the check applies.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
WITH base AS (
  SELECT wbs_code, wbs_name, cost_element_code, cost_element_name, document_no, document_type,
         period_key, vendor_name, description, quantity, uom, amount,
         amount / quantity AS unit_rate
  FROM v_actual
  WHERE project_key = :project_key AND cost_type = 'MATERIAL'
    AND quantity IS NOT NULL AND quantity <> 0
),
scored AS (
  SELECT *,
    AVG(ABS(unit_rate)) OVER (PARTITION BY cost_element_code) AS gl_avg_rate,
    COUNT(*)             OVER (PARTITION BY cost_element_code) AS gl_n
  FROM base
)
SELECT wbs_code, wbs_name, cost_element_code, cost_element_name, document_no, document_type,
       period_key, vendor_name, description, quantity, uom, amount, unit_rate, gl_avg_rate
FROM scored
WHERE gl_n >= 5 AND gl_avg_rate > 0 AND ABS(unit_rate) > 5 * gl_avg_rate
ORDER BY ABS(unit_rate) DESC`,
  },
  {
    code: 'MATERIAL_RETURNS',
    name: 'Material returns and damages',
    module: 'ACTUAL',
    category: 'Material',
    description: 'Material postings with a negative amount — returns, damages, or a credit against '
      + 'an earlier delivery.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
SELECT wbs_code, wbs_name, cost_element_code, cost_element_name, document_no, document_type,
       period_key, vendor_name, description, quantity, uom, amount
FROM v_actual
WHERE project_key = :project_key AND cost_type = 'MATERIAL' AND amount < 0
ORDER BY amount ASC`,
  },
  {
    code: 'MATERIAL_DETAIL',
    name: 'Material postings',
    module: 'ACTUAL',
    category: 'Detail',
    description: 'Every material posting — the detail table behind the Material Analysis page.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
SELECT wbs_code, wbs_name, cost_element_code, cost_element_name, document_no, document_type,
       period_key, data_date, vendor_name, description, quantity, uom, amount
FROM v_actual
WHERE project_key = :project_key AND cost_type = 'MATERIAL'
ORDER BY period_key DESC, ABS(amount) DESC`,
  },
  {
    code: 'KPI_PROJECT',
    name: 'Project headline figures',
    module: 'CROSS',
    category: 'Headline',
    description: 'One row of totals for a project — budget, cost, revenue, EAC and variance. '
      + 'Analyses point at this for their KPI strip, so headline numbers are SQL like everything else.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
WITH b AS (SELECT SUM(budget_amount) AS total FROM v_budget
           WHERE project_key = :project_key AND is_current = 1),
     a AS (SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS n, MAX(data_date) AS d
           FROM v_actual WHERE project_key = :project_key),
     r AS (SELECT COALESCE(SUM(amount),0) AS total FROM v_revenue WHERE project_key = :project_key),
     f AS (SELECT COALESCE(SUM(forecast_amount),0) AS total FROM v_forecast
           WHERE project_key = :project_key AND is_current = 1)
-- budget and vac stay NULL when nothing is budgeted: a variance against a budget
-- that does not exist would read as an overrun the size of the whole spend.
SELECT
  (SELECT total FROM b)                              AS budget,
  (SELECT total FROM a)                              AS actual_cost,
  (SELECT total FROM r)                              AS revenue,
  (SELECT total FROM f)                              AS etc,
  (SELECT total FROM a) + (SELECT total FROM f)      AS eac,
  CASE WHEN (SELECT total FROM b) IS NULL THEN NULL
       ELSE (SELECT total FROM b) - ((SELECT total FROM a) + (SELECT total FROM f)) END AS vac,
  (SELECT total FROM r) - (SELECT total FROM a)      AS margin,
  (SELECT n FROM a)                                  AS postings,
  (SELECT d FROM a)                                  AS data_date`,
  },
  {
    code: 'KPI_SUBCONTRACT',
    name: 'Subcontract headline figures',
    module: 'SERVICE',
    category: 'Headline',
    description: 'One row of subcontract totals — certified work, VAT, suppliers, and how many '
      + 'purchase orders reconcile against actual cost.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
WITH act AS (
  SELECT po_no, SUM(amount) AS amount FROM v_actual
  WHERE project_key = :project_key AND po_no IS NOT NULL AND po_no <> '' GROUP BY po_no
),
sl AS (
  SELECT po_no, SUM(amount_net) AS amount FROM v_service_line
  WHERE project_key = :project_key GROUP BY po_no
)
SELECT
  (SELECT COALESCE(SUM(amount_net),0) FROM v_service_line WHERE project_key = :project_key) AS work_done_net,
  (SELECT COALESCE(SUM(amount_vat),0) FROM v_service_line WHERE project_key = :project_key) AS vat,
  (SELECT COUNT(DISTINCT vendor_name) FROM v_service_line WHERE project_key = :project_key) AS suppliers,
  (SELECT COUNT(DISTINCT po_no) FROM v_service_line WHERE project_key = :project_key) AS purchase_orders,
  (SELECT COUNT(*) FROM act JOIN sl ON sl.po_no = act.po_no
     WHERE ABS(act.amount - sl.amount) <= 1) AS reconciled_pos,
  (SELECT COUNT(*) FROM act JOIN sl ON sl.po_no = act.po_no
     WHERE ABS(act.amount - sl.amount) > 1) AS differing_pos`,
  },
  {
    code: 'WBS_TREEMAP',
    name: 'Cost map by WBS',
    module: 'CROSS',
    category: 'Structure',
    description: 'Every WBS element sized by actual cost and shaded by budget variance — red is '
      + 'over budget, blue is under, grey where there is no budget to compare against. The whole '
      + 'structure and its problem areas in one view.',
    params: [P_PROJECT, { name: 'max_level', type: 'int', label: 'Level', default: 3 }],
    viz: { kind: 'treemap', label: 'wbs_name', value: 'actual_amount', color: 'variance_amount',
      headline: 'KPI_PROJECT' },
    sql: `
WITH act AS (
  SELECT w.wbs_key, w.wbs_code, w.wbs_name, w.wbs_level,
         COALESCE(SUM(a.amount),0) AS actual_amount
  FROM dim_wbs w
  LEFT JOIN v_actual a ON a.wbs_key = w.wbs_key
  WHERE w.project_key = :project_key AND w.wbs_level <= COALESCE(:max_level, 3)
  GROUP BY w.wbs_key, w.wbs_code, w.wbs_name, w.wbs_level
),
bud AS (
  SELECT wbs_key, SUM(budget_amount) AS budget_amount FROM v_budget
  WHERE project_key = :project_key AND is_current = 1 GROUP BY wbs_key
)
SELECT
  act.wbs_code, act.wbs_name, act.wbs_level,
  act.actual_amount,
  bud.budget_amount,
  -- NULL, not a negative: an element with no budget is uncoloured on the map
  -- rather than shown as an overrun equal to everything spent on it.
  CASE WHEN bud.budget_amount IS NULL THEN NULL
       ELSE bud.budget_amount - act.actual_amount END AS variance_amount
FROM act LEFT JOIN bud ON bud.wbs_key = act.wbs_key
WHERE act.actual_amount <> 0
ORDER BY act.actual_amount DESC`,
  },
  {
    code: 'COST_HEATMAP',
    name: 'Spend heatmap: cost type by month',
    module: 'ACTUAL',
    category: 'Trend',
    description: 'Actual cost per cost type per month. Seasonality, ramp-up and one-off spikes '
      + 'stand out immediately.',
    params: [P_PROJECT],
    viz: { kind: 'heatmap', row: 'cost_type', col: 'period_key', value: 'actual_amount',
      headline: 'KPI_PROJECT' },
    sql: `
SELECT
  COALESCE(cost_type,'UNMAPPED') AS cost_type,
  period_key,
  SUM(amount) AS actual_amount
FROM v_actual
WHERE project_key = :project_key
GROUP BY COALESCE(cost_type,'UNMAPPED'), period_key
ORDER BY cost_type, period_key`,
  },
  {
    // "Detail Substitution": a summary posting in the actual-cost ledger is
    // swapped for its own itemized detail from a secondary report, matched on a
    // shared key. PO number is the key for the subcontractor case; fact_service_line
    // itself carries nothing subcontractor-specific, so a second PO-based detail
    // report — an equipment-rental reconciliation, a materials-delivery report,
    // anything with a PO, a vendor, a description and an amount — loads into the
    // same SERVICE module and joins in here with no new SQL. report_name on each
    // SERVICE row is what keeps two such sources distinguishable once both are
    // loaded. An internal order settling onto a WBS is the same pattern on a
    // different key: CJI3 names the receiver directly (partner_object_type =
    // 'Order', partner_object = the order number), and fact_order_line supplies
    // its line-item detail, joined in the same way.
    code: 'UNIFIED_COST_REGISTER',
    name: 'Unified cost register (detail substitution)',
    module: 'CROSS',
    category: 'Reconciliation',
    description: 'Every cost line, once. Actual postings with no purchase order and no order '
      + 'settlement (direct cost — material, labour, in-house equipment) plus the line-item detail '
      + 'loaded for every PO and every settled internal order. A PO\'s or order\'s CJI3 posting is '
      + 'left out here because its detail lines are that same money at finer grain — vendor, '
      + 'description, quantity — so nothing is counted twice. A PO or order with no detail loaded '
      + 'yet still shows its CJI3 posting, flagged, so the register never silently drops cost.',
    params: [P_PROJECT,
      { name: 'period_from', type: 'period', label: 'Period from', warnUnbounded: true },
      { name: 'period_to', type: 'period', label: 'Period to', warnUnbounded: true },
      { name: 'top_n', type: 'int', label: 'Rows', default: 10000 }],
    viz: { kind: 'table' },
    sql: `
WITH po_with_detail AS (
  -- POs that have at least one detail line loaded — their CJI3 posting is
  -- superseded by that detail below, not by anything shown here.
  SELECT DISTINCT po_no FROM v_service_line
  WHERE project_key = :project_key AND po_no IS NOT NULL AND po_no <> ''
),
order_with_detail AS (
  -- Internal orders settled onto a project WBS with detail loaded for that
  -- settlement. A line still on a cost centre (category = CTR) has not
  -- reached a project yet, so it does not count as "detail loaded" here.
  SELECT DISTINCT order_no FROM v_order_line
  WHERE project_key = :project_key AND category = 'WBS'
    AND order_no IS NOT NULL AND order_no <> ''
),
direct_cost AS (
  -- CJI3 postings with no PO and no settled order with detail loaded yet
  -- (kept so cost is never silently dropped, flagged so it's easy to spot).
  SELECT
    'ACTUAL'                                            AS source,
    NULL                                                 AS report_name,
    a.period_key,
    a.wbs_code, a.wbs_name,
    a.cost_element_code, a.cost_element_name, a.cost_type,
    a.vendor_name,
    a.po_no,
    a.document_no                                       AS reference,
    a.document_type,
    NULL                                                 AS category,
    a.description,
    a.quantity,
    a.uom,
    a.amount,
    CASE
      WHEN a.po_no IS NOT NULL AND a.po_no <> ''
           AND a.po_no NOT IN (SELECT po_no FROM po_with_detail) THEN 1
      WHEN a.partner_object_type = 'Order'
           AND a.partner_object IS NOT NULL AND a.partner_object <> ''
           AND a.partner_object NOT IN (SELECT order_no FROM order_with_detail) THEN 1
      ELSE 0
    END                                                  AS missing_detail
  FROM v_actual a
  WHERE a.project_key = :project_key
    AND (a.po_no IS NULL OR a.po_no = '' OR a.po_no NOT IN (SELECT po_no FROM po_with_detail))
    AND (a.partner_object_type IS NULL OR a.partner_object_type <> 'Order'
         OR a.partner_object IS NULL OR a.partner_object = ''
         OR a.partner_object NOT IN (SELECT order_no FROM order_with_detail))
    AND (:period_from IS NULL OR a.period_key >= :period_from)
    AND (:period_to   IS NULL OR a.period_key <= :period_to)
),
detail_lines AS (
  -- The line-item detail behind every PO — the finer-grained replacement for
  -- that PO's CJI3 posting, from whichever detail report(s) supplied it.
  SELECT
    'SERVICE'                                           AS source,
    s.report_name,
    s.period_key,
    s.wbs_code, s.wbs_name,
    s.cost_element_code, s.cost_element_name, s.cost_type,
    s.vendor_name,
    s.po_no,
    s.invoice_no                                        AS reference,
    NULL                                                 AS document_type,
    s.category,
    s.service_text                                       AS description,
    s.quantity_current                                    AS quantity,
    s.uom,
    s.amount_net                                          AS amount,
    0                                                      AS missing_detail
  FROM v_service_line s
  WHERE s.project_key = :project_key
    AND (:period_from IS NULL OR s.period_key >= :period_from)
    AND (:period_to   IS NULL OR s.period_key <= :period_to)
),
order_detail AS (
  -- The line-item detail behind every settled internal order — the
  -- finer-grained replacement for that order's CJI3 settlement posting.
  -- Only category = 'WBS' lines: a 'CTR' line has not reached a project yet.
  SELECT
    'ORDER'                                             AS source,
    s.report_name,
    s.period_key,
    s.wbs_code, s.wbs_name,
    s.cost_element_code, s.cost_element_name, s.cost_type,
    s.vendor_name,
    NULL                                                 AS po_no,
    s.order_no                                          AS reference,
    NULL                                                 AS document_type,
    s.category,
    s.order_description                                  AS description,
    s.quantity,
    s.uom,
    s.amount,
    0                                                      AS missing_detail
  FROM v_order_line s
  WHERE s.project_key = :project_key
    AND s.category = 'WBS'
    AND (:period_from IS NULL OR s.period_key >= :period_from)
    AND (:period_to   IS NULL OR s.period_key <= :period_to)
)
SELECT * FROM direct_cost
UNION ALL
SELECT * FROM detail_lines
UNION ALL
SELECT * FROM order_detail
-- Caps what better-sqlite3 marshals into JS and ships across IPC. It does not
-- reduce the scan + per-row cost_type resolution the three CTEs above still
-- pay in full — narrow period_from/period_to for that. UNIFIED_COST_SUMMARY
-- deliberately has no LIMIT: its GROUP BY already collapses to a handful of
-- period rows regardless of how many source rows were scanned.
ORDER BY period_key, source, po_no, reference
LIMIT COALESCE(:top_n, 10000)`,
  },
  {
    code: 'UNIFIED_COST_SUMMARY',
    name: 'Unified cost register — monthly total',
    module: 'CROSS',
    category: 'Reconciliation',
    description: 'The same detail-substitution merge, totalled per month, so the direct-cost, PO '
      + 'detail and order-settlement detail halves can be checked against each other and against '
      + 'the plain actual-cost total.',
    params: [P_PROJECT],
    viz: { kind: 'bar', label: 'period_key', value: 'total_amount', headline: 'KPI_PROJECT' },
    sql: `
WITH po_with_detail AS (
  SELECT DISTINCT po_no FROM v_service_line
  WHERE project_key = :project_key AND po_no IS NOT NULL AND po_no <> ''
),
order_with_detail AS (
  SELECT DISTINCT order_no FROM v_order_line
  WHERE project_key = :project_key AND category = 'WBS'
    AND order_no IS NOT NULL AND order_no <> ''
),
merged AS (
  SELECT period_key, amount FROM v_actual
  WHERE project_key = :project_key
    AND (po_no IS NULL OR po_no = '' OR po_no NOT IN (SELECT po_no FROM po_with_detail))
    AND (partner_object_type IS NULL OR partner_object_type <> 'Order'
         OR partner_object IS NULL OR partner_object = ''
         OR partner_object NOT IN (SELECT order_no FROM order_with_detail))
  UNION ALL
  SELECT period_key, amount_net FROM v_service_line WHERE project_key = :project_key
  UNION ALL
  SELECT period_key, amount FROM v_order_line
  WHERE project_key = :project_key AND category = 'WBS'
)
SELECT period_key, SUM(amount) AS total_amount, COUNT(*) AS lines
FROM merged
GROUP BY period_key
ORDER BY period_key`,
  },
  {
    code: 'DETAIL_SOURCES',
    name: 'Detail sources feeding the register',
    module: 'CROSS',
    category: 'Reconciliation',
    description: 'Every report currently supplying PO-level detail for the unified cost register, '
      + 'with how many purchase orders and how much value each contributes. Load a second detail '
      + 'report — a different cost category, same PO-based shape — and it appears here on its own '
      + 'row with no query changes.',
    params: [P_PROJECT],
    viz: { kind: 'bar', label: 'report_name', value: 'amount' },
    sql: `
SELECT
  report_name,
  COUNT(DISTINCT po_no) AS purchase_orders,
  COUNT(*)              AS lines,
  SUM(amount_net)        AS amount
FROM v_service_line
WHERE project_key = :project_key
GROUP BY report_name
ORDER BY amount DESC`,
  },
  {
    code: 'ORDER_SETTLEMENTS',
    name: 'Order settlements in CJI3',
    module: 'ACTUAL',
    category: 'Reconciliation',
    description: 'Actual cost postings that settle from an internal order rather than a purchase '
      + 'order or invoice — identified by CJI3\'s own "Partner Object Type" / "Partner Object" '
      + 'columns, not a guess from a blank document type. detail_loaded shows whether an order-level '
      + 'detail report already covers that order in the unified cost register, or whether it is still '
      + 'showing here as an unreplaced CJI3 posting.',
    params: [P_PROJECT],
    viz: { kind: 'bar', label: 'partner_object', value: 'amount' },
    sql: `
SELECT
  a.partner_object_type, a.partner_object, a.partner_object_name,
  a.cost_element_code, a.cost_element_name, a.cost_type,
  a.wbs_code, a.wbs_name,
  COUNT(*) AS lines, SUM(a.amount) AS amount,
  CASE WHEN EXISTS (
    SELECT 1 FROM v_order_line o
    WHERE o.project_key = a.project_key AND o.category = 'WBS' AND o.order_no = a.partner_object
  ) THEN 1 ELSE 0 END AS detail_loaded
FROM v_actual a
WHERE a.project_key = :project_key
  AND a.partner_object_type IS NOT NULL AND a.partner_object_type <> ''
GROUP BY a.partner_object_type, a.partner_object, a.partner_object_name,
         a.cost_element_code, a.cost_element_name, a.cost_type, a.wbs_code, a.wbs_name
ORDER BY amount DESC`,
  },
  {
    code: 'ORDER_DETAIL_SOURCES',
    name: 'Order detail sources feeding the register',
    module: 'CROSS',
    category: 'Reconciliation',
    description: 'Every report currently supplying order-level detail for the unified cost register '
      + '— the same role DETAIL_SOURCES plays for PO detail, keyed on the internal order number '
      + 'instead. Only category = WBS lines count: a line still on a cost centre has not settled to '
      + 'a project yet.',
    params: [P_PROJECT],
    viz: { kind: 'bar', label: 'report_name', value: 'amount' },
    sql: `
SELECT
  report_name,
  COUNT(DISTINCT order_no) AS orders,
  COUNT(*)                 AS lines,
  SUM(amount)              AS amount
FROM v_order_line
WHERE project_key = :project_key AND category = 'WBS'
GROUP BY report_name
ORDER BY amount DESC`,
  },
  {
    code: 'DATA_FRESHNESS',
    name: 'Data freshness by source',
    module: 'ADMIN',
    category: 'Governance',
    description: 'Latest posted data date per source report, and whether it has gone stale.',
    params: [],
    viz: { kind: 'table' },
    sql: `
SELECT report_code, report_name, module, source_system,
       latest_data_date, latest_period, latest_rows, age_days, freshness_status,
       latest_imported_at
FROM v_data_freshness
ORDER BY CASE freshness_status WHEN 'NO_DATA' THEN 0 WHEN 'STALE' THEN 1 ELSE 2 END, report_name`,
  },
  {
    code: 'BATCH_REGISTER',
    name: 'Import batch register',
    module: 'ADMIN',
    category: 'Governance',
    description: 'Every upload with its data date, status and control totals — the audit trail.',
    params: [{ name: 'top_n', type: 'int', label: 'Rows', default: 200 }],
    viz: { kind: 'table' },
    sql: `
SELECT b.import_batch_id, rd.name AS report_name, b.module, b.data_date, b.period_key,
       b.file_name, b.status, b.row_count_file, b.row_count_posted, b.row_count_rejected,
       b.amount_total, b.imported_at, b.notes
FROM import_batch b
JOIN report_definition rd ON rd.report_definition_id = b.report_definition_id
ORDER BY b.imported_at DESC
LIMIT COALESCE(:top_n, 200)`,
  },
  {
    code: 'UNMAPPED_VALUES',
    name: 'Mapping coverage',
    module: 'ADMIN',
    category: 'Data quality',
    description: 'Actual rows that did not resolve to a WBS or cost element — these need mapping.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
SELECT
  COUNT(*)                                                    AS total_rows,
  SUM(CASE WHEN f.wbs_key IS NULL THEN 1 ELSE 0 END)          AS rows_without_wbs,
  SUM(CASE WHEN f.cost_element_key IS NULL THEN 1 ELSE 0 END) AS rows_without_cost_element,
  SUM(CASE WHEN f.wbs_key IS NULL THEN f.amount ELSE 0 END)   AS amount_without_wbs
FROM fact_actual f
JOIN import_batch b ON b.import_batch_id = f.import_batch_id AND b.status = 'POSTED'
WHERE f.project_key = :project_key`,
  },
];
