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
}

export interface SystemQuery {
  code: string;
  name: string;
  module: 'ACTUAL' | 'BUDGET' | 'FORECAST' | 'CROSS' | 'ADMIN';
  category: string;
  description: string;
  sql: string;
  params: QueryParamDef[];
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
    sql: `
SELECT
  a.period_key, a.document_no, a.document_type, a.wbs_code, a.wbs_name,
  a.cost_element_code, a.cost_element_name, a.cost_type, a.vendor_name,
  a.description, a.quantity, a.uom, a.amount, a.data_date
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
    description: 'Cumulative budget, actual and forecast by period — the cost S-curve. '
      + 'A budget that is not time-phased is shown as a flat budget-at-completion line.',
    params: [P_PROJECT],
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
    code: 'DATA_FRESHNESS',
    name: 'Data freshness by source',
    module: 'ADMIN',
    category: 'Governance',
    description: 'Latest posted data date per source report, and whether it has gone stale.',
    params: [],
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
