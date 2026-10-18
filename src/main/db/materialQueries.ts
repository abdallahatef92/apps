/**
 * Stored queries for the material data layer (MB51 / ME2N / MATLIST,
 * migration 021). Kept apart from systemQueries.ts so the material report
 * can grow its queries without touching the subcontract ones; spread into
 * SYSTEM_QUERIES by one import there.
 *
 * Material issue figures come from v_material_issue (POSTED, cut off by the
 * project's cut-off). CJI3 material cost is v_actual with cost_type = MATERIAL -
 * deliberately NOT v_actual_cost, which already swaps it for MB51.
 */
import type { QueryParamDef, SystemQuery } from './systemQueries';

const P_PROJECT: QueryParamDef = { name: 'project_key', type: 'project', label: 'Project', required: true };

/*
 * Shared CTE fragments of the MAT_* report queries (docs/port/material-gap.md).
 *
 *   rm  the report month: the month of the project's cut-off, else the latest
 *       month with counted issues (PLAN.md decision 3); last_pk = the month before.
 *   mm  one row per material: previous (months before the report month), this
 *       month and to date, as quantity and amount.
 *   rt  mm plus the rates: previous (to last month), this month, to date, and the
 *       start rate (the material's first month with a quantity).
 *   rc  rt plus the rate changes. "A rate change is only read when both rates are
 *       positive and within 3x of each other: a bigger jump is a unit mix-up, not
 *       a price change" - that is m_check / s_check = 1 and m_d / s_d stay NULL.
 *       A change under half a piastre per unit is no change: 0.
 *   mt  the SAP material-group tree per material: family > division > group.
 *       A group whose family is not in dim_material_family (S&A) falls back to the
 *       leading letters of its code; a family that is still unknown sorts last.
 */
const RM = `rm AS (
  SELECT x.pk, SUBSTR(DATE(x.pk || '-01', '-1 month'), 1, 7) AS last_pk
  FROM (SELECT COALESCE(
          (SELECT SUBSTR(cutoff_date, 1, 7) FROM project_cutoff
            WHERE project_key = :project_key AND cutoff_date IS NOT NULL),
          (SELECT MAX(period_key) FROM v_material_issue WHERE project_key = :project_key)) AS pk) x
)`;

const MM = `mm AS (
  SELECT l.material_key, l.material_code, MAX(l.material_name) AS material_name,
         MAX(l.material_group) AS material_group, MAX(l.uom) AS unit,
         SUM(CASE WHEN l.period_key < rm.pk THEN l.amount END)   AS p_amt,
         SUM(CASE WHEN l.period_key < rm.pk THEN l.quantity END) AS p_qty,
         SUM(CASE WHEN l.period_key = rm.pk THEN l.amount END)   AS c_amt,
         SUM(CASE WHEN l.period_key = rm.pk THEN l.quantity END) AS c_qty,
         SUM(l.amount) AS t_amt, SUM(l.quantity) AS t_qty,
         MIN(l.period_key) AS first_key,
         MIN(CASE WHEN l.quantity <> 0 THEN l.period_key END) AS start_key
  FROM v_material_issue l, rm
  WHERE l.project_key = :project_key
  GROUP BY l.material_key, l.material_code
)`;

const RT = `rt AS (
  SELECT mm.*,
    CASE WHEN ABS(p_qty) > 1e-6 THEN p_amt / p_qty END AS pr,
    CASE WHEN ABS(c_qty) > 1e-6 THEN c_amt / c_qty END AS cr,
    CASE WHEN ABS(t_qty) > 1e-6 THEN t_amt / t_qty END AS tr,
    (SELECT CASE WHEN ABS(SUM(s.quantity)) > 1e-6 THEN SUM(s.amount) / SUM(s.quantity) END
       FROM v_material_issue s
      WHERE s.project_key = :project_key AND s.material_key = mm.material_key
        AND s.period_key = mm.start_key) AS sr
  FROM mm
)`;

const RC = `rc AS (
  SELECT rt.*,
    CASE WHEN pr > 0 AND cr > 0 AND cr / pr <= 3 AND cr / pr >= 1.0 / 3
         THEN CASE WHEN ABS(cr - pr) < 0.005 THEN 0 ELSE cr - pr END END AS m_d,
    CASE WHEN pr IS NOT NULL AND cr IS NOT NULL
          AND NOT (pr > 0 AND cr > 0 AND cr / pr <= 3 AND cr / pr >= 1.0 / 3) THEN 1 ELSE 0 END AS m_check,
    CASE WHEN sr > 0 AND tr > 0 AND tr / sr <= 3 AND tr / sr >= 1.0 / 3
         THEN CASE WHEN ABS(tr - sr) < 0.005 THEN 0 ELSE tr - sr END END AS s_d,
    CASE WHEN sr IS NOT NULL AND tr IS NOT NULL
          AND NOT (sr > 0 AND tr > 0 AND tr / sr <= 3 AND tr / sr >= 1.0 / 3) THEN 1 ELSE 0 END AS s_check
  FROM rt
)`;

/** Leading letters of a code (up to four), NULL when it starts with a digit. */
const letters = (x: string) => `NULLIF(SUBSTR(${x}, 1, CASE WHEN SUBSTR(${x}, 1, 1) GLOB '[A-Za-z]' THEN
    CASE WHEN SUBSTR(${x}, 2, 1) GLOB '[A-Za-z]' THEN
      CASE WHEN SUBSTR(${x}, 3, 1) GLOB '[A-Za-z]' THEN
        CASE WHEN SUBSTR(${x}, 4, 1) GLOB '[A-Za-z]' THEN 4 ELSE 3 END
      ELSE 2 END
    ELSE 1 END
  ELSE 0 END), '')`;

const FAMILY_NAMES = `CASE t.family
      WHEN 'M' THEN 'M Materials' WHEN 'P' THEN 'P Plant & tools' WHEN 'SP' THEN 'SP Spare parts, oils, fuel'
      WHEN 'SM' THEN 'SM Safety' WHEN 'SH' THEN 'SH Site housing' WHEN 'CS' THEN 'CS Consumables'
      WHEN 'OS' THEN 'OS Office' WHEN 'IT' THEN 'IT' WHEN 'G' THEN 'G General hardware'
      WHEN 'A' THEN 'A Assets' WHEN 'SR' THEN 'SR Survey spares' WHEN 'SC' THEN 'SC Scrap'
      WHEN 'S' THEN 'S Services' WHEN 'MTEX' THEN 'MTEX Vehicle maintenance' WHEN 'L' THEN 'L Labour'
      WHEN 'OVM' THEN 'OVM Overhead' WHEN 'WST' THEN 'WST Wastage' ELSE t.family END`;

const MT = `mt AS (
  SELECT t.*,
    COALESCE((SELECT f.sort_order FROM dim_material_family f WHERE f.family = t.family), 999) AS fam_sort,
    ${FAMILY_NAMES} AS family_label,
    COALESCE(t.division, 'No SAP division') AS division_key,
    COALESCE(t.division || ' ' || (SELECT d.name FROM dim_material_group d WHERE d.code = t.division),
             ${FAMILY_NAMES}) AS division_label
  FROM (
    SELECT m.material_key, m.material_code, m.material_name, m.material_group AS grp_code, g.name AS grp_name,
           CASE WHEN m.material_group IS NULL THEN '(no group)'
                WHEN fk.family IS NOT NULL THEN fk.family
                ELSE COALESCE(${letters('m.material_group')}, '(no group)') END AS family,
           CASE WHEN fk.family IS NOT NULL THEN g.division END AS division,
           CASE WHEN m.material_group IS NULL THEN '(no group)'
                WHEN g.code IS NULL THEN m.material_group || ' (not in the catalogue)'
                ELSE g.code || ' ' || g.name END AS grp_label,
           COALESCE(g.sort_order, 999999) AS grp_sort
    FROM dim_material m
    LEFT JOIN dim_material_group g  ON g.code = m.material_group
    LEFT JOIN dim_material_family fk ON fk.family = g.family
  ) t
)`;

/** The group-tree CTE (`mt`), for the Work packages Materials tab (ipc.ts). */
export const MATERIAL_TREE_CTE = MT;

const WITH_MM = `WITH ${RM}, ${MM}`;
const WITH_RC = `WITH ${RM}, ${MM}, ${RT}, ${RC}`;

/** n scalar sub-selects naming the 1st..nth row of a CTE as <prefix>1_label, <prefix>1_amount ... */
const pick = (cte: string, label: string, value: string, where: string, order: string, prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => {
    const sel = (what: string) =>
      `(SELECT ${what} FROM ${cte} WHERE ${where} ORDER BY ${order}, ${label} LIMIT 1 OFFSET ${i})`;
    return `${sel(label)} AS ${prefix}${i + 1}_label,\n  ${sel(value)} AS ${prefix}${i + 1}_amount`;
  }).join(',\n  ');

// ---------------------------------------------------------------------------
// The native Material page's sheet queries (docs/port/native-report.md): one per workbook sheet,
// all SQL over the same views the MAT_* queries read. Every one takes the same optional filters
// (:family :division :pkg :month :q), written (:p IS NULL OR ...), so filtering is SQL. :month holds
// issue lines to that posting month (a PO line to its PO month); the KPI strip above the tabs and the
// Coding tree / Checks are the whole project and ignore the filters.
// ---------------------------------------------------------------------------
const P_FILT: QueryParamDef[] = [
  P_PROJECT,
  { name: 'family', type: 'text', label: 'Family' },
  { name: 'division', type: 'text', label: 'Division' },
  { name: 'pkg', type: 'text', label: 'Work package' },
  { name: 'month', type: 'text', label: 'Month (YYYY-MM)' },
  { name: 'q', type: 'text', label: 'Search' },
];

/** :q as text: the runner binds a numeric-looking string as a number, which would read back as '123.0'. */
const QTXT = `(CASE WHEN typeof(:q) = 'real' AND :q = CAST(:q AS INTEGER) THEN CAST(CAST(:q AS INTEGER) AS TEXT) ELSE CAST(:q AS TEXT) END)`;

/** The shared filter, over any CTE with these columns (lx / pxa). */
const FILT = `(:family IS NULL OR family = :family)
    AND (:division IS NULL OR division_key = :division)
    AND (:pkg IS NULL OR pkg_code = :pkg)
    AND (:month IS NULL OR period_key = :month)
    AND (:q IS NULL OR INSTR(LOWER(material_code || ' ' || COALESCE(material_name, '') || ' ' || grp_label), LOWER(${QTXT})) > 0)`;

/** lx: every issue line of the project (counted and pending) with its group tree and work package. */
const LX = `lx AS (
  SELECT l.material_key, l.material_code, l.material_name, l.uom, l.period_key, l.posting_date, l.issue_type, l.issue_type_name,
         l.amount, l.quantity, l.pending_reason, l.document_no, l.fiscal_year, l.document_line, l.wbs_code,
         l.movement_type, l.movement_text, l.sap_amount, l.sap_quantity, l.entry_date, l.vendor_code, l.reservation_no,
         l.user_name, l.header_text, l.item_text, l.valuation_type, l.storage_location,
         mt.family, mt.family_label, mt.fam_sort, mt.division_key, mt.division_label, mt.grp_label, mt.grp_sort,
         COALESCE(mw.work_package, '(none)') AS pkg_code,
         COALESCE(wp.code || ' ' || wp.label, '(not coded)') AS pkg_label,
         COALESCE(wp.sort_order, 99999) AS pkg_sort
  FROM v_material_issue_all l
  JOIN mt ON mt.material_key = l.material_key
  LEFT JOIN material_work_package mw ON mw.project_key = l.project_key AND mw.material_code = l.material_code
  LEFT JOIN dim_work_package wp ON wp.code = mw.work_package
  WHERE l.project_key = :project_key
)`;
const LN = `ln AS (SELECT * FROM lx WHERE ${FILT})`;
const LC = `lc AS (SELECT * FROM ln WHERE pending_reason IS NULL)`;
const MNL = `(SELECT COALESCE(mnl, 'MAT') FROM dim_cost_type WHERE code = 'MATERIAL')`;
const TREE_ORDER = `fam_sort, family, division_key, grp_sort`;

/** The report's cut date: the project cut-off, else the end of the report month. */
const CUT = `cut AS (
  SELECT COALESCE((SELECT cutoff_date FROM project_cutoff WHERE project_key = :project_key),
                  DATE((SELECT pk FROM rm) || '-01', '+1 month', '-1 day'), DATE('now')) AS d
)`;

/** pxa: the non-deleted ME2N lines of the project with the same tree and work package. */
const PXA = `pxa AS (
  SELECT pl.po_no, pl.po_item, pl.material_key, pl.material_code, pl.material_name, pl.order_unit, pl.supplier_text, pl.kind,
         pl.document_date, SUBSTR(pl.document_date, 1, 7) AS period_key,
         COALESCE(pl.order_qty, 0) AS order_qty, COALESCE(pl.net_value, 0) AS net_value, COALESCE(pl.unit_price, 0) AS unit_price,
         COALESCE(pl.open_qty, 0) AS open_qty, COALESCE(pl.open_value, 0) AS open_value, COALESCE(pl.invoice_value, 0) AS invoice_value,
         (pl.kind = 'STO' AND COALESCE(pl.net_value, 0) = 0) AS is_transfer,
         mt.family, mt.family_label, mt.fam_sort, mt.division_key, mt.division_label, mt.grp_label, mt.grp_sort,
         COALESCE(mw.work_package, '(none)') AS pkg_code
  FROM v_po_material_line pl
  JOIN mt ON mt.material_key = pl.material_key
  LEFT JOIN material_work_package mw ON mw.project_key = pl.project_key AND mw.material_code = pl.material_code
  WHERE pl.project_key = :project_key AND pl.is_deleted = 0
)`;
const PX = `px AS (SELECT * FROM pxa WHERE ${FILT})`;
const PO_STATUS = `CASE WHEN open_qty > 0.000000001 THEN CASE WHEN order_qty - open_qty > 0.000000001 THEN 'Partly delivered' ELSE 'Open' END
       WHEN is_transfer = 0 AND invoice_value > 0.5 THEN 'To invoice' ELSE 'Closed' END`;
const PO_AGE = `CASE WHEN open_qty > 0.000000001 AND document_date IS NOT NULL AND document_date <= (SELECT d FROM cut)
       THEN CAST(julianday((SELECT d FROM cut)) - julianday(document_date) AS INTEGER) END`;

/** Per-material rates over the filtered lines (the same rules as RT / RC, on ln / lc). */
const SHEET_RATES = `mm AS (
  SELECT n.material_key, n.material_code, MAX(n.material_name) AS description, MAX(n.uom) AS unit,
         MAX(n.family_label) AS family_label, MAX(n.family) AS family, MAX(n.fam_sort) AS fam_sort,
         MAX(n.division_key) AS division_key, MAX(n.division_label) AS division_label,
         MAX(n.grp_label) AS grp_label, MAX(n.grp_sort) AS grp_sort, MAX(n.pkg_code) AS pkg_code,
         SUM(CASE WHEN n.pending_reason IS NULL AND n.period_key < rm.pk THEN n.amount END)   AS p_amt,
         SUM(CASE WHEN n.pending_reason IS NULL AND n.period_key < rm.pk THEN n.quantity END) AS p_qty,
         SUM(CASE WHEN n.pending_reason IS NULL AND n.period_key = rm.pk THEN n.amount END)   AS c_amt,
         SUM(CASE WHEN n.pending_reason IS NULL AND n.period_key = rm.pk THEN n.quantity END) AS c_qty,
         SUM(CASE WHEN n.pending_reason IS NULL THEN n.amount END)   AS t_amt,
         SUM(CASE WHEN n.pending_reason IS NULL THEN n.quantity END) AS t_qty,
         SUM(CASE WHEN n.pending_reason IS NOT NULL THEN n.amount END) AS pend_amt,
         MIN(CASE WHEN n.pending_reason IS NULL AND n.quantity <> 0 THEN n.period_key END) AS start_key
  FROM ln n, rm
  GROUP BY n.material_key, n.material_code
),
rt AS (
  SELECT mm.*,
    CASE WHEN ABS(p_qty) > 1e-6 THEN p_amt / p_qty END AS pr,
    CASE WHEN ABS(c_qty) > 1e-6 THEN c_amt / c_qty END AS cr,
    CASE WHEN ABS(t_qty) > 1e-6 THEN t_amt / t_qty END AS tr,
    (SELECT CASE WHEN ABS(SUM(s.quantity)) > 1e-6 THEN SUM(s.amount) / SUM(s.quantity) END
       FROM lc s WHERE s.material_key = mm.material_key AND s.period_key = mm.start_key) AS sr
  FROM mm
),
rc AS (
  SELECT rt.*,
    CASE WHEN pr > 0 AND cr > 0 AND cr / pr <= 3 AND cr / pr >= 1.0 / 3
         THEN CASE WHEN ABS(cr - pr) < 0.005 THEN 0 ELSE cr - pr END END AS m_d,
    CASE WHEN pr IS NOT NULL AND cr IS NOT NULL
          AND NOT (pr > 0 AND cr > 0 AND cr / pr <= 3 AND cr / pr >= 1.0 / 3) THEN 1 ELSE 0 END AS m_check,
    CASE WHEN sr > 0 AND tr > 0 AND tr / sr <= 3 AND tr / sr >= 1.0 / 3
         THEN CASE WHEN ABS(tr - sr) < 0.005 THEN 0 ELSE tr - sr END END AS s_d,
    CASE WHEN sr IS NOT NULL AND tr IS NOT NULL
          AND NOT (sr > 0 AND tr > 0 AND tr / sr <= 3 AND tr / sr >= 1.0 / 3) THEN 1 ELSE 0 END AS s_check
  FROM rt
)`;

const HEAD_PO = `WITH ${RM}, ${MT}`;
const HEAD_LINES = `${HEAD_PO}, ${LX}, ${LN}, ${LC}`;
const sheet = (code: string, name: string, description: string, sql: string, extra: QueryParamDef[] = []): SystemQuery => ({
  code, name, module: 'ACTUAL', category: 'Material report', description,
  params: [...P_FILT, ...extra], viz: { kind: 'table' }, sql,
});

const MATERIAL_SHEET_QUERIES: SystemQuery[] = [
  {
    code: 'MAT_FILTER_OPTIONS',
    name: 'Material report: filter options',
    module: 'ACTUAL',
    category: 'Material report',
    description: 'The values behind the Material page\'s filter bar: kind = family | division | pkg | month, '
      + 'with the value a tab query takes and a label to show. Only what the project\'s issue lines use.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
WITH ${MT},
iss AS (
  SELECT DISTINCT l.material_key, l.period_key, COALESCE(mw.work_package, '(none)') AS pkg_code
  FROM v_material_issue_all l
  LEFT JOIN material_work_package mw ON mw.project_key = l.project_key AND mw.material_code = l.material_code
  WHERE l.project_key = :project_key
)
SELECT 'family' AS kind, family AS value, family_label AS label, MIN(fam_sort) AS sort_order
FROM (SELECT DISTINCT material_key FROM iss) i JOIN mt ON mt.material_key = i.material_key GROUP BY family, family_label
UNION ALL
SELECT 'division', division_key, division_label, MIN(fam_sort)
FROM (SELECT DISTINCT material_key FROM iss) i JOIN mt ON mt.material_key = i.material_key GROUP BY division_key, division_label
UNION ALL
SELECT 'pkg', x.pkg_code, COALESCE(wp.code || ' ' || wp.label, '(not coded)'), COALESCE(wp.sort_order, 99999)
FROM (SELECT DISTINCT pkg_code FROM iss) x LEFT JOIN dim_work_package wp ON wp.code = x.pkg_code
UNION ALL
SELECT 'month', period_key, period_key, 0 FROM (SELECT DISTINCT period_key FROM iss WHERE period_key IS NOT NULL)
ORDER BY 1, 4, 3`,
  },
  sheet('MAT_SHEET_TOTALS', 'Material sheet: totals that follow the filter',
    'One row: Previous, This month, To date and Pending of the lines the filter leaves, and how many materials - the workbook\'s TOTAL row. '
    + 'Previous / This month / To date are counted issues only; Pending is never part of To date.',
    `${HEAD_LINES}
SELECT
  COALESCE(SUM(CASE WHEN pending_reason IS NULL AND period_key < rm.pk THEN amount END), 0) AS previous,
  COALESCE(SUM(CASE WHEN pending_reason IS NULL AND period_key = rm.pk THEN amount END), 0) AS this_month,
  COALESCE(SUM(CASE WHEN pending_reason IS NULL THEN amount END), 0) AS to_date,
  COALESCE(SUM(CASE WHEN pending_reason IS NOT NULL THEN amount END), 0) AS pending,
  COUNT(DISTINCT material_key) AS materials
FROM ln, rm`),
  sheet('MAT_SHEET_MONTH_TYPE', 'Material sheet: cost per month by issue type (filtered)',
    'MAT_MONTH_BY_TYPE with the filter applied: long format, every issue type on every month so a type keeps its colour slot '
    + '(series_order), plus the running cumulative.',
    `${HEAD_LINES},
months AS (SELECT DISTINCT period_key FROM lc),
types(issue_type, issue_type_name, series_order) AS (
  VALUES ('P', 'Project', 1), ('S', 'To subcontractors', 2), ('X', 'Scrap', 3)
),
m AS (SELECT period_key, issue_type, SUM(amount) AS amount FROM lc GROUP BY period_key, issue_type),
cum AS (SELECT period_key, SUM(SUM(amount)) OVER (ORDER BY period_key) AS cumulative FROM lc GROUP BY period_key)
SELECT mo.period_key, t.issue_type_name AS issue_type, t.series_order, COALESCE(m.amount, 0) AS amount, cum.cumulative
FROM months mo CROSS JOIN types t
LEFT JOIN m ON m.period_key = mo.period_key AND m.issue_type = t.issue_type
JOIN cum ON cum.period_key = mo.period_key
ORDER BY mo.period_key, t.series_order`),
  sheet('MAT_SHEET_MONTH_TABLE', 'Material sheet: cost per month (filtered table)',
    'The Summary\'s "Cost per month" table with the filter applied: one column per issue type, total, cumulative, materials and documents.',
    `${HEAD_LINES}
SELECT period_key AS month,
       SUM(CASE WHEN issue_type = 'P' THEN amount ELSE 0 END) AS project,
       SUM(CASE WHEN issue_type = 'S' THEN amount ELSE 0 END) AS to_subcontractors,
       SUM(CASE WHEN issue_type = 'X' THEN amount ELSE 0 END) AS scrap,
       SUM(amount) AS total,
       SUM(SUM(amount)) OVER (ORDER BY period_key) AS cumulative,
       COUNT(DISTINCT material_key) AS materials,
       COUNT(DISTINCT document_no || '/' || COALESCE(fiscal_year, '')) AS documents
FROM lc GROUP BY period_key ORDER BY period_key`),
  sheet('MAT_SHEET_BY_DIM', 'Material sheet: cost by family, division or work package',
    'The Summary\'s cost tables: Previous, This month, To date, share of To date and Pending, by :dim = family | division | pkg '
    + '(default pkg; uncoded materials are one "(not coded)" line so the total ties).',
    `${HEAD_LINES},
x AS (
  SELECT CASE :dim WHEN 'family' THEN family_label WHEN 'division' THEN division_label ELSE pkg_label END AS label,
         MIN(CASE :dim WHEN 'family' THEN fam_sort WHEN 'division' THEN fam_sort ELSE pkg_sort END) AS sort_key,
         SUM(CASE WHEN pending_reason IS NULL AND period_key < rm.pk THEN amount ELSE 0 END) AS previous,
         SUM(CASE WHEN pending_reason IS NULL AND period_key = rm.pk THEN amount ELSE 0 END) AS this_month,
         SUM(CASE WHEN pending_reason IS NULL THEN amount ELSE 0 END) AS to_date,
         SUM(CASE WHEN pending_reason IS NOT NULL THEN amount ELSE 0 END) AS pending
  FROM ln, rm GROUP BY 1
)
SELECT label, previous, this_month, to_date,
       ROUND(100.0 * to_date / NULLIF((SELECT SUM(to_date) FROM x), 0), 1) AS share_pct, pending
FROM x ORDER BY to_date DESC, sort_key, label`,
    [{ name: 'dim', type: 'text', label: 'Dimension (family | division | pkg)', default: 'pkg' }]),
  sheet('MAT_SHEET_MATERIALS', 'Material sheet: Material Summary',
    'Per material, in the SAP group tree order (family > division > group, largest first): Previous / This month / To date as '
    + 'quantity, rate and amount, Pending, the rate against the previous rate and against the start rate, and against the weighted '
    + 'ME2N price. A rate change is read only when both rates are positive and within 3x ("Check" otherwise).',
    `${HEAD_LINES},
${SHEET_RATES}
SELECT family_label AS family, division_label AS division, grp_label AS material_group, rc.material_code, description, unit,
       pkg_code AS pkg, ${MNL} AS mnl,
       p_qty AS previous_qty, pr AS previous_rate, p_amt AS previous_amount,
       c_qty AS this_month_qty, cr AS this_month_rate, c_amt AS this_month_amount,
       t_qty AS to_date_qty, tr AS to_date_rate, t_amt AS to_date_amount,
       pend_amt AS pending_amount,
       CASE WHEN m_check = 1 THEN 'Check' WHEN m_d > 0 THEN 'Up' WHEN m_d < 0 THEN 'Down' WHEN m_d = 0 THEN 'Same' ELSE '' END AS vs_previous,
       ROUND(100.0 * m_d / pr, 1) AS vs_previous_pct,
       ROUND(c_qty * m_d, 2) AS vs_previous_value,
       start_key AS start_month, sr AS start_rate,
       CASE WHEN s_check = 1 THEN 'Check' WHEN s_d > 0 THEN 'Up' WHEN s_d < 0 THEN 'Down' WHEN s_d = 0 THEN 'Same' ELSE '' END AS vs_start,
       ROUND(100.0 * s_d / sr, 1) AS vs_start_pct,
       ROUND(t_qty * s_d, 2) AS vs_start_value,
       pp.weighted_price AS po_price,
       CASE WHEN tr > 0 AND pp.weighted_price > 0 THEN ROUND(100.0 * (tr / pp.weighted_price - 1), 1) END AS vs_po_pct
FROM rc
LEFT JOIN v_po_material_price pp ON pp.project_key = :project_key AND pp.material_key = rc.material_key
ORDER BY ${TREE_ORDER}, COALESCE(ABS(t_amt), 0) DESC, rc.material_code`),
  sheet('MAT_SHEET_MATERIAL_MONTH', 'Material sheet: Material per Month (long format)',
    'One row per material and month (counted issues only), plus a "To date" row per material: quantity, rate and amount. '
    + 'Long format - the page lays the months out as columns.',
    `${HEAD_LINES},
ma AS (
  SELECT material_key, MAX(material_code) AS material_code, MAX(material_name) AS description, MAX(uom) AS unit,
         MAX(family_label) AS family_label, MAX(family) AS family, MAX(fam_sort) AS fam_sort,
         MAX(division_key) AS division_key, MAX(division_label) AS division_label,
         MAX(grp_label) AS grp_label, MAX(grp_sort) AS grp_sort, MAX(pkg_code) AS pkg_code
  FROM lc GROUP BY material_key
),
u AS (
  SELECT material_key, period_key AS period, SUM(quantity) AS qty, SUM(amount) AS amount FROM lc GROUP BY material_key, period_key
  UNION ALL
  SELECT material_key, 'To date', SUM(quantity), SUM(amount) FROM lc GROUP BY material_key
)
SELECT ma.family_label AS family, ma.division_label AS division, ma.grp_label AS material_group, ma.material_code, ma.description, ma.unit,
       ma.pkg_code AS pkg, u.period, u.qty, CASE WHEN ABS(u.qty) > 1e-6 THEN u.amount / u.qty END AS rate, u.amount
FROM u JOIN ma ON ma.material_key = u.material_key
ORDER BY ma.fam_sort, ma.family, ma.division_key, ma.grp_sort, ma.material_code, u.period`),
  sheet('MAT_SHEET_CODING', 'Material sheet: Coding status per material',
    'One row per material issued: the group tree, the work package it is coded to (material_work_package; the MNL code is the '
    + 'MATERIAL cost type\'s), Coded / To code, quantity, rate, To date and This month, how many POs and which suppliers ME2N shows, '
    + 'first and last month issued. to_code = 1 marks a material still to code.',
    `${HEAD_LINES},
mat AS (
  SELECT n.material_key, MAX(n.material_code) AS material_code, MAX(n.material_name) AS description, MAX(n.uom) AS unit,
         MAX(n.family_label) AS family_label, MAX(n.family) AS family, MAX(n.fam_sort) AS fam_sort,
         MAX(n.division_key) AS division_key, MAX(n.division_label) AS division_label,
         MAX(n.grp_label) AS grp_label, MAX(n.grp_sort) AS grp_sort, MAX(n.pkg_code) AS pkg_code,
         SUM(CASE WHEN n.pending_reason IS NULL THEN n.quantity END) AS t_qty,
         SUM(CASE WHEN n.pending_reason IS NULL THEN n.amount END) AS t_amt,
         SUM(CASE WHEN n.pending_reason IS NULL AND n.period_key = rm.pk THEN n.amount END) AS c_amt,
         MIN(CASE WHEN n.pending_reason IS NULL THEN n.period_key END) AS first_key,
         MAX(CASE WHEN n.pending_reason IS NULL THEN n.period_key END) AS last_key
  FROM ln n, rm GROUP BY n.material_key
)
SELECT family_label AS family, division_label AS division, grp_label AS material_group, material_code, description, unit,
       pkg_code AS pkg, ${MNL} AS mnl,
       CASE WHEN pkg_code = '(none)' THEN 'To code' ELSE 'Coded' END AS status,
       CASE WHEN pkg_code = '(none)' THEN 1 ELSE 0 END AS to_code,
       t_qty AS to_date_qty, CASE WHEN ABS(t_qty) > 1e-6 THEN t_amt / t_qty END AS rate, t_amt AS to_date, c_amt AS this_month,
       (SELECT COUNT(DISTINCT p.po_no) FROM v_po_material_line p
         WHERE p.project_key = :project_key AND p.material_key = mat.material_key AND p.is_deleted = 0) AS pos,
       (SELECT GROUP_CONCAT(DISTINCT p.supplier_text) FROM v_po_material_line p
         WHERE p.project_key = :project_key AND p.material_key = mat.material_key AND p.is_deleted = 0 AND p.kind = 'PUR') AS suppliers,
       first_key AS first_issued, last_key AS last_issued
FROM mat
ORDER BY ${TREE_ORDER}, COALESCE(ABS(t_amt), 0) DESC, material_code`),
  sheet('MAT_SHEET_PO_REGISTER', 'Material sheet: PO Register (one row per ME2N purchase line)',
    'ME2N purchase lines (deleted lines left out, stock transfers kept apart): ordered, delivered and still open quantity, value, '
    + 'delivered and open value, still to invoice, the status (Open / Partly delivered / To invoice / Closed), the age of an open '
    + 'line at the cut date, the price against the material\'s lowest PO price, and a flag (Open > 90 days, Price > 20% above the '
    + 'lowest, To invoice - first that applies). The filter month is the PO month.',
    `${HEAD_PO}, ${CUT}, ${PXA}, ${PX},
q AS (
  SELECT px.*, ${PO_STATUS} AS status, ${PO_AGE} AS age_days,
         CASE WHEN px.kind = 'PUR' AND px.unit_price > 0 AND pp.lowest_price > 0
              THEN ROUND(100.0 * (px.unit_price / pp.lowest_price - 1), 1) END AS vs_lowest_pct
  FROM px LEFT JOIN (SELECT material_key, lowest_price FROM v_po_material_price WHERE project_key = :project_key) pp
         ON pp.material_key = px.material_key
  WHERE px.is_transfer = 0
)
SELECT family_label AS family, division_label AS division, grp_label AS material_group, material_code, material_name AS description,
       order_unit AS unit, pkg_code AS pkg, po_no, SUBSTR(po_no, 1, 2) AS po_type, po_item, supplier_text AS supplier,
       document_date AS po_date, age_days, status,
       order_qty, order_qty - open_qty AS delivered_qty, open_qty, unit_price,
       net_value AS po_value, net_value - open_value AS delivered_value, open_value, invoice_value AS to_invoice,
       vs_lowest_pct,
       CASE WHEN age_days > 90 THEN 'Open > 90 days'
            WHEN vs_lowest_pct > 20 THEN 'Price +' || CAST(ROUND(vs_lowest_pct) AS INTEGER) || '% vs lowest'
            WHEN invoice_value > 0.5 THEN 'To invoice' ELSE '' END AS flag
FROM q
ORDER BY ${TREE_ORDER}, material_code, document_date DESC, po_no DESC, po_item`),
  sheet('MAT_SHEET_PO_MATERIALS', 'Material sheet: PO Register by material',
    'The PO Register\'s material rows: ordered, delivered and open quantity and value, still to invoice, the material\'s PO prices '
    + '(lowest, last, weighted, spread), what MB51 issued to date (quantity, delivered minus issued, issue rate against the weighted '
    + 'PO price, amount) and Committed = issued + open value.',
    `${HEAD_PO}, ${PXA}, ${PX},
a AS (
  SELECT material_key, MAX(material_code) AS material_code, MAX(material_name) AS description, MAX(order_unit) AS unit,
         MAX(family_label) AS family_label, MAX(family) AS family, MAX(fam_sort) AS fam_sort,
         MAX(division_key) AS division_key, MAX(division_label) AS division_label,
         MAX(grp_label) AS grp_label, MAX(grp_sort) AS grp_sort, MAX(pkg_code) AS pkg_code,
         COUNT(*) AS po_lines, COUNT(DISTINCT po_no) AS pos,
         SUM(order_qty) AS order_qty, SUM(order_qty - open_qty) AS delivered_qty, SUM(open_qty) AS open_qty,
         SUM(net_value) AS po_value, SUM(net_value - open_value) AS delivered_value, SUM(open_value) AS open_value,
         SUM(invoice_value) AS to_invoice
  FROM px WHERE is_transfer = 0 GROUP BY material_key
),
iss AS (
  SELECT material_key, SUM(quantity) AS q, SUM(amount) AS amt FROM v_material_issue WHERE project_key = :project_key GROUP BY material_key
),
b AS (
  SELECT a.*, pp.lowest_price, pp.weighted_price, pp.highest_price,
         (SELECT l.unit_price FROM v_po_material_line l
           WHERE l.project_key = :project_key AND l.material_key = a.material_key AND l.kind = 'PUR' AND l.is_deleted = 0 AND l.unit_price > 0
           ORDER BY l.document_date DESC, l.po_no DESC, l.po_item DESC LIMIT 1) AS last_price,
         COALESCE(iss.q, 0) AS issued_qty, COALESCE(iss.amt, 0) AS issued_amount
  FROM a LEFT JOIN v_po_material_price pp ON pp.project_key = :project_key AND pp.material_key = a.material_key
         LEFT JOIN iss ON iss.material_key = a.material_key
)
SELECT family_label AS family, division_label AS division, grp_label AS material_group, material_code, description, unit, pkg_code AS pkg,
       po_lines, pos, order_qty, delivered_qty, open_qty, po_value, delivered_value, open_value, to_invoice,
       lowest_price, last_price, weighted_price,
       CASE WHEN lowest_price > 0 THEN ROUND(100.0 * (highest_price / lowest_price - 1), 1) END AS spread_pct,
       issued_qty, delivered_qty - issued_qty AS delivered_minus_issued,
       CASE WHEN ABS(issued_qty) > 1e-6 THEN issued_amount / issued_qty END AS issue_rate,
       CASE WHEN ABS(issued_qty) > 1e-6 AND weighted_price > 0
            THEN ROUND(100.0 * (issued_amount / issued_qty / weighted_price - 1), 1) END AS vs_weighted_pct,
       issued_amount, issued_amount + open_value AS committed,
       CASE WHEN ABS(issued_qty) < 1e-9 THEN CASE WHEN delivered_qty > 0 THEN 'Delivered, not issued' ELSE 'Not issued yet' END
            WHEN lowest_price > 0 AND highest_price / lowest_price - 1 > 0.2
              THEN 'Price spread ' || CAST(ROUND(100.0 * (highest_price / lowest_price - 1)) AS INTEGER) || '%' ELSE '' END AS flag
FROM b
ORDER BY ${TREE_ORDER}, COALESCE(ABS(issued_amount), 0) DESC, material_code`),
  sheet('MAT_SHEET_STO', 'Material sheet: Stores Transfers',
    'Stock transport orders from own stores and plants (an ME2N line with a plant-code supplier and no value): ordered, delivered '
    + 'and open quantity, status, age of an open line and Open > 90 days. The filter month is the PO month.',
    `${HEAD_PO}, ${CUT}, ${PXA}, ${PX},
q AS (SELECT px.*, ${PO_STATUS} AS status, ${PO_AGE} AS age_days FROM px WHERE px.is_transfer = 1)
SELECT family_label AS family, division_label AS division, grp_label AS material_group, material_code, material_name AS description,
       order_unit AS unit, pkg_code AS pkg, po_no AS transfer_po, SUBSTR(po_no, 1, 2) AS po_type, po_item, supplier_text AS from_store,
       document_date AS po_date, age_days, status, order_qty, order_qty - open_qty AS delivered_qty, open_qty,
       CASE WHEN age_days > 90 THEN 'Open > 90 days' ELSE '' END AS flag
FROM q
ORDER BY ${TREE_ORDER}, material_code, document_date DESC, po_no DESC, po_item`),
  sheet('MAT_SHEET_LINES', 'Material sheet: Data (every issue line)',
    'Every counted issue line (v_material_issue) with the group tree, the work package, the period, WBS element, issue type, material '
    + 'document, quantity, rate, amount and how SAP printed it. include_pending = 1 adds the lines held back as Pending (with the reason). '
    + 'material_code narrows to one material - the drill-down.',
    `${HEAD_LINES}
SELECT family_label AS family, division_label AS division, grp_label AS material_group, material_code, material_name AS description,
       uom AS unit, pkg_code AS pkg, COALESCE(period_key, 'Pending') AS period, posting_date, wbs_code,
       issue_type_name AS issue_type, document_no || '/' || COALESCE(fiscal_year, '') || '/' || COALESCE(document_line, '') AS material_doc,
       quantity AS qty, CASE WHEN ABS(quantity) > 1e-6 THEN amount / quantity END AS rate, amount, pending_reason,
       movement_type, movement_text, sap_quantity AS sap_qty, sap_amount, entry_date, vendor_code AS subcontractor_sap_code,
       reservation_no, user_name, header_text, item_text, valuation_type, storage_location
FROM ln
WHERE (COALESCE(:include_pending, 0) = 1 OR pending_reason IS NULL)
  AND (:material_code IS NULL
       -- '~' prefix: the page sends '~'+code so the query runner keeps a digit code (e.g. 000123) as TEXT
       OR material_code = CASE WHEN SUBSTR(:material_code, 1, 1) = '~' THEN SUBSTR(:material_code, 2) ELSE :material_code END
       OR material_code = CAST(CAST(:material_code AS INTEGER) AS TEXT))
ORDER BY ${TREE_ORDER}, material_code, posting_date, document_no`,
    [{ name: 'material_code', type: 'text', label: 'Material' }, { name: 'include_pending', type: 'int', label: 'Include pending lines (1)' }]),
];

/** The CTEs of MAT_CHECKS (ending in `c`), shared with the build workspace's readiness count. */
export const MAT_CHECKS_CTE = `lb AS (
  SELECT MAX(f.import_batch_id) AS id
  FROM fact_material_issue f JOIN import_batch b ON b.import_batch_id = f.import_batch_id AND b.status = 'POSTED'
  WHERE f.project_key = :project_key
),
ft AS (
  SELECT (SELECT control_total FROM import_batch WHERE import_batch_id = (SELECT id FROM lb)) AS footer,
         (SELECT COALESCE(SUM(amount), 0) FROM fact_material_issue
           WHERE project_key = :project_key AND import_batch_id = (SELECT id FROM lb)) AS loaded,
         (SELECT COUNT(*) FROM stg_row WHERE import_batch_id = (SELECT id FROM lb) AND status = 'SKIPPED'
             AND message LIKE 'Repeat of the document line%') AS dup_rows,
         (SELECT COALESCE(SUM(CAST(json_extract(raw_json, '$.mapped.amount') AS REAL)), 0) FROM stg_row
           WHERE import_batch_id = (SELECT id FROM lb) AND status = 'SKIPPED'
             AND message LIKE 'Repeat of the document line%') AS dup_amt,
         (SELECT COUNT(*) FROM fact_material_issue
           WHERE project_key = :project_key AND import_batch_id = (SELECT id FROM lb)) AS loaded_rows
),
ia AS (SELECT * FROM v_material_issue_all WHERE project_key = :project_key),
mv AS (SELECT * FROM v_material_movement WHERE project_key = :project_key),
mats AS (
  SELECT material_key, MAX(material_group) AS grp, COUNT(DISTINCT uom) AS units, SUM(amount) AS td
  FROM v_material_issue WHERE project_key = :project_key GROUP BY material_key
),
cut AS (SELECT COALESCE((SELECT cutoff_date FROM project_cutoff WHERE project_key = :project_key), DATE('now')) AS d),
c AS (
  SELECT 1 AS ord, 'footer' AS check_code, 'MB51 rows add up to the SAP total row' AS check_name,
    CASE WHEN footer IS NULL THEN 'not checked' WHEN ABS(footer - loaded - dup_amt) < 1 THEN 'ok' ELSE 'warn' END AS status,
    loaded_rows AS lines, CASE WHEN footer IS NOT NULL THEN footer - loaded - dup_amt END AS amount,
    CASE WHEN footer IS NULL THEN 'The latest MB51 file has no total row, so it could not be checked against SAP''s own total. Export MB51 with the total on the amount to get this check.'
         WHEN ABS(footer - loaded - dup_amt) < 1 THEN 'The rows (and repeated document lines counted once) equal SAP''s total row.'
         ELSE 'The rows add up to ' || ROUND(loaded + dup_amt, 2) || ' but the total row says ' || ROUND(footer, 2) || '. The export may be cut off.' END AS detail
  FROM ft
  UNION ALL SELECT 2, 'duplicates', 'The same document line twice',
    CASE WHEN dup_rows > 0 THEN 'warn' ELSE 'ok' END, dup_rows, dup_amt,
    CASE WHEN dup_rows > 0 THEN 'Rows repeat a material document + year + item already in the file. Each is counted once - check that the export was not pasted twice.'
         ELSE 'No document line is repeated in the latest file.' END FROM ft
  UNION ALL SELECT 3, 'unknown_mvt', 'Movement types not in the rules - left out',
    CASE WHEN COUNT(*) > 0 THEN 'warn' ELSE 'ok' END, COUNT(*), COALESCE(SUM(sap_amount), 0),
    CASE WHEN COUNT(*) > 0 THEN 'Movement types ' || GROUP_CONCAT(DISTINCT movement_type)
         || ' are neither an issue to the project nor a known receipt or transfer, so they are not cost. If one is project cost, add it to the movement-type rules.'
         ELSE 'Every movement type is covered by the rules.' END
  FROM mv WHERE movement_kind = 'UNKNOWN'
  UNION ALL SELECT 4, 'outside', 'Movements that are not material cost (left out)', 'info', COUNT(*), COALESCE(SUM(sap_amount), 0),
    'Receipts, transfers, issues to orders and cost centres, subcontractor stock ... move material but put no cost on the project. Amounts as SAP signs them.'
  FROM mv WHERE movement_kind = 'OUTSIDE'
  UNION ALL SELECT 5, 'after_cut', 'Posted after the cut-off - Pending',
    CASE WHEN COUNT(*) > 0 THEN 'info' ELSE 'ok' END, COUNT(*), COALESCE(SUM(amount), 0),
    CASE WHEN COUNT(*) > 0 THEN 'They belong to a later month and count when the cut-off moves on.' ELSE 'No line is posted after the cut-off.' END
  FROM ia WHERE pending_reason = 'After cut-off'
  UNION ALL SELECT 6, 'no_date', 'Lines without a posting date - Pending',
    CASE WHEN COUNT(*) > 0 THEN 'warn' ELSE 'ok' END, COUNT(*), COALESCE(SUM(amount), 0),
    CASE WHEN COUNT(*) > 0 THEN 'The posting date is empty, so the month is unknown and the line never counts.' ELSE 'Every line has a posting date.' END
  FROM ia WHERE pending_reason = 'No posting date'
  UNION ALL SELECT 7, 'no_group', 'Every material has a material group',
    CASE WHEN COUNT(*) > 0 THEN 'warn' ELSE 'ok' END, COUNT(*), COALESCE(SUM(td), 0),
    CASE WHEN COUNT(*) > 0 THEN 'These materials are on no ME2N PO line and not in the material list, so their group is unknown. Load ME2N or the material list (MM60).'
         ELSE 'Every material issued has its SAP material group.' END
  FROM mats WHERE grp IS NULL
  UNION ALL SELECT 8, 'multi_unit', 'One unit per material',
    CASE WHEN COUNT(*) > 0 THEN 'warn' ELSE 'ok' END, COUNT(*), COALESCE(SUM(td), 0),
    CASE WHEN COUNT(*) > 0 THEN 'These materials are issued in more than one unit, so their quantities (and rates) mix units.'
         ELSE 'Every material is issued in one unit.' END
  FROM mats WHERE units > 1
  UNION ALL SELECT 9, 'negative_td', 'No material with a negative to-date',
    CASE WHEN COUNT(*) > 0 THEN 'warn' ELSE 'ok' END, COUNT(*), COALESCE(SUM(td), 0),
    CASE WHEN COUNT(*) > 0 THEN 'Returns outweigh the issues of these materials - usually a return posted without its issue in this file.'
         ELSE 'No material has returned more than it was issued.' END
  FROM mats WHERE td < -0.005
  UNION ALL SELECT 10, 'z21', 'Issued to subcontractors (recoverable)', 'info', COUNT(*), COALESCE(SUM(amount), 0),
    'Z21/Z22 goods issues to subcontractors, to be deducted from what they are paid. Rows are listed per SAP supplier.'
  FROM v_material_issue WHERE project_key = :project_key AND issue_type = 'S'
  UNION ALL SELECT 11, 'zero_lines', 'Lines left out (no value)', 'info', COUNT(*), 0,
    'Issues with no value - owner-supplied material (valuation type CUSTOMER) and scrap at no price - are not cost.'
  FROM mv WHERE movement_kind = 'ISSUE' AND amount = 0
  UNION ALL SELECT 12, 'ties', 'Report total ties (issued = To date + Pending)',
    CASE WHEN ABS(a.issued - a.td - a.pend) < 0.01 THEN 'ok' ELSE 'warn' END, a.n, a.issued - a.td - a.pend,
    'Every issue is either in To date or Pending. Difference shown.'
  FROM (SELECT (SELECT COALESCE(SUM(amount), 0) FROM ia) AS issued,
               (SELECT COALESCE(SUM(amount), 0) FROM v_material_issue WHERE project_key = :project_key) AS td,
               (SELECT COALESCE(SUM(amount), 0) FROM ia WHERE pending_reason IS NOT NULL) AS pend,
               (SELECT COUNT(*) FROM ia) AS n) a
  UNION ALL SELECT 13, 'recon', 'MB51 against CJI3 material cost',
    CASE WHEN r.cj_lines = 0 THEN 'not checked' WHEN ABS(r.mb - r.cj) < 1 THEN 'ok' ELSE 'warn' END,
    r.cj_lines, CASE WHEN r.cj_lines > 0 THEN r.mb - r.cj END,
    CASE WHEN r.cj_lines = 0 THEN 'No CJI3 material postings are loaded for this project, so there is nothing to compare MB51 with.'
         WHEN ABS(r.mb - r.cj) < 1 THEN 'MB51 goods issues and CJI3 material postings give the same cost.'
         ELSE 'MB51 gives ' || ROUND(r.mb, 2) || ', CJI3 material postings ' || ROUND(r.cj, 2) || '. Cost is taken from MB51; the months differ below.' END
  FROM (SELECT (SELECT COALESCE(SUM(amount), 0) FROM v_material_issue WHERE project_key = :project_key) AS mb,
               (SELECT COALESCE(SUM(amount), 0) FROM v_actual WHERE project_key = :project_key AND cost_type = 'MATERIAL') AS cj,
               (SELECT COUNT(*) FROM v_actual WHERE project_key = :project_key AND cost_type = 'MATERIAL') AS cj_lines) r
  UNION ALL SELECT 14, 'me2n', 'ME2N PO lines loaded',
    CASE WHEN COUNT(*) = 0 THEN 'info' ELSE 'ok' END, COUNT(*), COALESCE(SUM(open_value), 0),
    CASE WHEN COUNT(*) = 0 THEN 'ME2N is not loaded: PO prices and the group of materials come from nowhere. Load ME2N for complete reference data.'
         ELSE 'PO lines for this project are loaded; the amount is their open value.' END
  FROM v_po_material_line WHERE project_key = :project_key
  UNION ALL SELECT 15, 'old_po', 'Open PO lines older than 90 days',
    CASE WHEN COUNT(*) > 0 THEN 'info' ELSE 'ok' END, COUNT(*), COALESCE(SUM(open_value), 0),
    CASE WHEN COUNT(*) > 0 THEN 'Purchase lines still to be delivered more than 90 days after their PO date - to receive, or to close in SAP.'
         ELSE 'No purchase line has been open more than 90 days.' END
  FROM v_po_material_line, cut
  WHERE project_key = :project_key AND kind = 'PUR' AND is_deleted = 0 AND open_qty > 0
    AND document_date IS NOT NULL AND document_date < DATE(cut.d, '-90 days')
)`;

export const MATERIAL_QUERIES: SystemQuery[] = [
  ...MATERIAL_SHEET_QUERIES,
  {
    code: 'MAT_RECON',
    name: 'Material: MB51 issues vs CJI3 material cost, by month',
    module: 'ACTUAL',
    category: 'Reconciliation',
    description: 'Per month, the material cost the MB51 goods issues give (221/222, Z21/Z22, 551-556, '
      + 'cut off by posting date) against the CJI3 postings with cost type MATERIAL. The headline '
      + 'actual uses MB51 where it is loaded (v_actual_cost); this is the check that the two sources '
      + 'tell the same story. Both are shown, never added.',
    params: [{ name: 'project_key', type: 'project', label: 'Project', required: true }],
    viz: { kind: 'table' },
    sql: `
WITH mb AS (
  SELECT period_key, SUM(amount) AS amt, COUNT(*) AS n
  FROM v_material_issue WHERE project_key = :project_key GROUP BY period_key
),
cj AS (
  SELECT period_key, SUM(amount) AS amt, COUNT(*) AS n
  FROM v_actual WHERE project_key = :project_key AND cost_type = 'MATERIAL' GROUP BY period_key
),
periods AS (SELECT period_key FROM mb UNION SELECT period_key FROM cj)
SELECT
  p.period_key,
  COALESCE(mb.amt, 0) AS mb51_amount,
  COALESCE(mb.n, 0)   AS mb51_lines,
  COALESCE(cj.amt, 0) AS cji3_amount,
  COALESCE(cj.n, 0)   AS cji3_lines,
  COALESCE(mb.amt, 0) - COALESCE(cj.amt, 0) AS difference,
  -- no CJI3 material in the month: a percentage of nothing is not 0 %, it is unknown
  ROUND(100.0 * (COALESCE(mb.amt, 0) - COALESCE(cj.amt, 0)) / NULLIF(cj.amt, 0), 2) AS difference_pct
FROM periods p
LEFT JOIN mb ON mb.period_key = p.period_key
LEFT JOIN cj ON cj.period_key = p.period_key
ORDER BY p.period_key`,
  },
  {
    code: 'MAT_PO_PRICE',
    name: 'Material: issue rate vs weighted PO price',
    module: 'ACTUAL',
    category: 'Rates',
    description: 'Per material, the rate it is issued at to date (MB51 amount / quantity) against the '
      + 'weighted unit price on its ME2N purchase lines (deleted lines and stock transfers left out). '
      + 'A unit mix-up shows as a ratio far from 1, not as a price change.',
    params: [{ name: 'project_key', type: 'project', label: 'Project', required: true }],
    viz: { kind: 'table' },
    sql: `
WITH iss AS (
  SELECT material_key, material_code, MAX(material_name) AS material_name,
         MAX(material_group) AS material_group,
         SUM(quantity) AS issued_qty, SUM(amount) AS issued_amount
  FROM v_material_issue WHERE project_key = :project_key
  GROUP BY material_key, material_code
)
SELECT
  i.material_code, i.material_name, i.material_group,
  i.issued_qty, i.issued_amount,
  i.issued_amount / NULLIF(i.issued_qty, 0)                       AS issue_rate,
  pp.weighted_price                                               AS po_price,
  pp.lowest_price, pp.highest_price, pp.price_lines,
  -- NULL (not 0) when either side is missing
  ROUND(100.0 * ((i.issued_amount / NULLIF(i.issued_qty, 0)) / NULLIF(pp.weighted_price, 0) - 1), 1)
                                                                  AS vs_po_pct
FROM iss i
LEFT JOIN v_po_material_price pp
  ON pp.project_key = :project_key AND pp.material_key = i.material_key
ORDER BY ABS(i.issued_amount) DESC`,
  },
  // ---------------------------------------------------------------------------
  // Material report (MB51 / ME2N). Every figure below is SQL over v_material_issue
  // (POSTED, cut off by posting date); the page only lays the result sets out.
  // ---------------------------------------------------------------------------
  {
    code: 'MAT_SOURCE',
    name: 'Material report: what is loaded',
    module: 'ACTUAL',
    category: 'Material report',
    description: 'One row: whether the project has MB51 goods issues (then the material report reads them), '
      + 'how many ME2N PO lines are loaded, and the report month. Without MB51 the page falls back to '
      + 'CJI3 material postings.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
WITH ${RM}
SELECT
  EXISTS (SELECT 1 FROM v_mb51_project WHERE project_key = :project_key) AS has_mb51,
  (SELECT COUNT(*) FROM v_material_issue_all WHERE project_key = :project_key) AS mb51_lines,
  (SELECT COUNT(*) FROM v_po_material_line WHERE project_key = :project_key) AS po_lines,
  (SELECT cutoff_date FROM project_cutoff WHERE project_key = :project_key) AS cutoff_date,
  (SELECT pk FROM rm) AS report_month`,
  },
  {
    code: 'MAT_KPI',
    name: 'Material report: KPI strip',
    module: 'ACTUAL',
    category: 'Material report',
    description: 'Material cost from MB51 goods issues: Previous (months before the report month), This month, '
      + 'To date (= Previous + This month), Pending (posted after the cut-off, or with no posting date - '
      + 'never part of To date), the materials issued and issue documents of the report month. The report '
      + 'month is the month of the project cut-off, else the latest month with issues.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
WITH ${RM},
c AS (
  SELECT
    SUM(CASE WHEN l.period_key < rm.pk THEN l.amount END)  AS prev,
    SUM(CASE WHEN l.period_key = rm.pk THEN l.amount END)  AS cur,
    SUM(CASE WHEN l.period_key = rm.last_pk THEN l.amount END) AS lst,
    SUM(l.amount) AS td,
    COUNT(DISTINCT CASE WHEN l.period_key = rm.pk THEN l.material_key END) AS mats,
    COUNT(DISTINCT CASE WHEN l.period_key = rm.pk THEN l.document_no || '/' || COALESCE(l.fiscal_year, '') END) AS docs
  FROM v_material_issue l, rm WHERE l.project_key = :project_key
),
p AS (
  SELECT COALESCE(SUM(amount), 0) AS pend,
         COALESCE(SUM(CASE WHEN pending_reason = 'No posting date' THEN amount END), 0) AS no_date,
         COALESCE(SUM(CASE WHEN pending_reason = 'After cut-off'   THEN amount END), 0) AS after_cut
  FROM v_material_issue_all WHERE project_key = :project_key AND pending_reason IS NOT NULL
)
SELECT
  COALESCE(c.prev, 0) AS previous,
  COALESCE(c.cur, 0)  AS this_month,
  COALESCE(c.td, 0)   AS to_date,
  p.pend              AS pending,
  COALESCE(c.mats, 0) AS materials_issued,
  COALESCE(c.lst, 0)  AS last_month,
  -- NULL (not 0) when last month has nothing to compare against
  ROUND(100.0 * (COALESCE(c.cur, 0) - c.lst) / NULLIF(ABS(c.lst), 0), 1) AS mom_pct,
  COALESCE(c.docs, 0) AS documents,
  p.no_date           AS pending_no_date,
  p.after_cut         AS pending_after_cut,
  (SELECT pk FROM rm) AS report_month
FROM c, p`,
  },
  {
    code: 'MAT_MONTH_BY_TYPE',
    name: 'Material report: cost per month by issue type',
    module: 'ACTUAL',
    category: 'Material report',
    description: 'Issue cost per posting month, stacked by issue type: Project (221/222), To subcontractors '
      + '(Z21/Z22, recoverable), Scrap (551-556). series_order fixes each type\'s colour slot; the '
      + 'running cumulative is a column. A return makes a month negative - it stacks below the axis.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
WITH months AS (SELECT DISTINCT period_key FROM v_material_issue WHERE project_key = :project_key),
types(issue_type, issue_type_name, series_order) AS (
  VALUES ('P', 'Project', 1), ('S', 'To subcontractors', 2), ('X', 'Scrap', 3)
),
m AS (
  SELECT period_key, issue_type, SUM(amount) AS amount
  FROM v_material_issue WHERE project_key = :project_key GROUP BY period_key, issue_type
),
cum AS (
  SELECT period_key, SUM(SUM(amount)) OVER (ORDER BY period_key) AS cumulative
  FROM m GROUP BY period_key
)
-- every type on every month (0 when absent), so a type keeps its fixed colour slot
SELECT mo.period_key, t.issue_type_name AS issue_type, t.series_order,
       COALESCE(m.amount, 0) AS amount, cum.cumulative
FROM months mo CROSS JOIN types t
LEFT JOIN m ON m.period_key = mo.period_key AND m.issue_type = t.issue_type
JOIN cum ON cum.period_key = mo.period_key
ORDER BY mo.period_key, t.series_order`,
  },
  {
    code: 'MAT_MONTH_TABLE',
    name: 'Material report: cost per month (table)',
    module: 'ACTUAL',
    category: 'Material report',
    description: 'The month-by-month table behind the chart: one column per issue type, the total, the '
      + 'cumulative, and the materials and documents of the month.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
SELECT period_key AS month,
       SUM(CASE WHEN issue_type = 'P' THEN amount ELSE 0 END) AS project,
       SUM(CASE WHEN issue_type = 'S' THEN amount ELSE 0 END) AS to_subcontractors,
       SUM(CASE WHEN issue_type = 'X' THEN amount ELSE 0 END) AS scrap,
       SUM(amount) AS total,
       SUM(SUM(amount)) OVER (ORDER BY period_key) AS cumulative,
       COUNT(DISTINCT material_key) AS materials,
       COUNT(DISTINCT document_no || '/' || COALESCE(fiscal_year, '')) AS documents
FROM v_material_issue WHERE project_key = :project_key
GROUP BY period_key ORDER BY period_key`,
  },
  {
    code: 'MAT_TOP_MONTH',
    name: 'Material report: top materials this month',
    module: 'ACTUAL',
    category: 'Material report',
    description: 'The ten materials with the largest issue cost in the report month, with quantity, rate '
      + '(amount / quantity) and the rate against the previous rate (to last month). A change counts '
      + 'only when both rates are positive and within 3x; otherwise it reads "Check" (a unit mix-up, '
      + 'not a price change).',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
${WITH_RC}
SELECT material_code, material_name AS description, material_group, c_qty AS quantity, unit,
       cr AS rate,
       ROUND(100.0 * m_d / pr, 1) AS rate_vs_previous_pct,
       CASE WHEN m_check = 1 THEN 'Check' WHEN m_d > 0 THEN 'Up' WHEN m_d < 0 THEN 'Down'
            WHEN m_d = 0 THEN 'Same' ELSE '' END AS rate_change,
       c_amt AS amount
FROM rc WHERE c_amt IS NOT NULL
ORDER BY c_amt DESC, material_code LIMIT 10`,
  },
  {
    code: 'MAT_COST_BY_FAMILY',
    name: 'Material report: cost by material family',
    module: 'ACTUAL',
    category: 'Material report',
    description: 'This month and to date by SAP material family (M Materials, P Plant & tools ...), with the '
      + 'share of the to-date total.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
WITH ${RM}, ${MT},
x AS (
  SELECT mt.family_label AS label, mt.family AS code, mt.fam_sort AS sort,
         SUM(CASE WHEN l.period_key = rm.pk THEN l.amount ELSE 0 END) AS this_month, SUM(l.amount) AS to_date
  FROM v_material_issue l JOIN mt ON mt.material_key = l.material_key, rm
  WHERE l.project_key = :project_key GROUP BY mt.family_label, mt.family, mt.fam_sort
)
SELECT label, code, this_month, to_date,
       ROUND(100.0 * to_date / NULLIF((SELECT SUM(to_date) FROM x), 0), 1) AS share_pct
FROM x ORDER BY to_date DESC, sort`,
  },
  {
    code: 'MAT_COST_BY_DIVISION',
    name: 'Material report: cost by material division',
    module: 'ACTUAL',
    category: 'Material report',
    description: 'This month and to date by SAP material division (M03 Concrete ...); a family without '
      + 'divisions shows as itself.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
WITH ${RM}, ${MT},
x AS (
  SELECT mt.division_label AS label, COALESCE(mt.division, mt.family) AS code, MIN(mt.fam_sort) AS sort,
         SUM(CASE WHEN l.period_key = rm.pk THEN l.amount ELSE 0 END) AS this_month, SUM(l.amount) AS to_date
  FROM v_material_issue l JOIN mt ON mt.material_key = l.material_key, rm
  WHERE l.project_key = :project_key GROUP BY mt.division_label, COALESCE(mt.division, mt.family)
)
SELECT label, code, this_month, to_date,
       ROUND(100.0 * to_date / NULLIF((SELECT SUM(to_date) FROM x), 0), 1) AS share_pct
FROM x ORDER BY to_date DESC, sort`,
  },
  {
    code: 'MAT_COST_BY_PKG',
    name: 'Material report: cost by work package',
    module: 'ACTUAL',
    category: 'Material report',
    description: 'This month and to date by the work package each material is coded to '
      + '(material_work_package, per project); uncoded materials are one "(not coded)" line so the '
      + 'total still ties.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
WITH ${RM},
x AS (
  SELECT COALESCE(wp.code || ' ' || wp.label, '(not coded)') AS label, COALESCE(wp.code, '') AS code,
         COALESCE(wp.sort_order, 99999) AS sort,
         SUM(CASE WHEN l.period_key = rm.pk THEN l.amount ELSE 0 END) AS this_month, SUM(l.amount) AS to_date
  FROM v_material_issue l
  LEFT JOIN material_work_package mw ON mw.project_key = l.project_key AND mw.material_code = l.material_code
  LEFT JOIN dim_work_package wp ON wp.code = mw.work_package, rm
  WHERE l.project_key = :project_key GROUP BY 1, 2, 3
)
SELECT label, code, this_month, to_date,
       ROUND(100.0 * to_date / NULLIF((SELECT SUM(to_date) FROM x), 0), 1) AS share_pct
FROM x ORDER BY to_date DESC, sort`,
  },
  {
    code: 'MAT_COD_TREE',
    name: 'Material report: coding status by family > division > group',
    module: 'ACTUAL',
    category: 'Material report',
    description: 'The SAP material-group tree (family > division > group) with, per node, the materials '
      + 'issued, how many are coded to a work package (a row in material_work_package for the project), '
      + 'how many are still to code, their to-date cost, the cost of the materials not yet coded, the node\'s '
      + 'share of all to-date cost and the coded share. level 0 is the total.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
WITH ${MT},
mat AS (
  SELECT l.material_key, l.material_code, SUM(l.amount) AS td,
         EXISTS (SELECT 1 FROM material_work_package w
                  WHERE w.project_key = l.project_key AND w.material_code = l.material_code) AS coded
  FROM v_material_issue l WHERE l.project_key = :project_key
  GROUP BY l.material_key, l.material_code, l.project_key
),
x AS (
  SELECT mt.family, mt.family_label, mt.fam_sort, mt.division_key, mt.division_label,
         mt.grp_code, mt.grp_label, mt.grp_sort, mat.td, mat.coded
  FROM mat JOIN mt ON mt.material_key = mat.material_key
),
tot AS (SELECT SUM(td) AS td FROM x),
n AS (
  SELECT 0 AS level, 'Total' AS family, '' AS division, '' AS material_group, 'All materials' AS label,
         -1 AS fam_sort, '' AS division_key, -1 AS grp_sort,
         COUNT(*) AS materials, SUM(coded) AS coded, SUM(td) AS to_date,
         SUM(CASE WHEN coded = 0 THEN td ELSE 0 END) AS open_amount FROM x
  UNION ALL
  SELECT 1, family, '', '', family_label, fam_sort, '', -1,
         COUNT(*), SUM(coded), SUM(td), SUM(CASE WHEN coded = 0 THEN td ELSE 0 END)
  FROM x GROUP BY family, family_label, fam_sort
  UNION ALL
  SELECT 2, family, division_key, '', division_label, fam_sort, division_key, -1,
         COUNT(*), SUM(coded), SUM(td), SUM(CASE WHEN coded = 0 THEN td ELSE 0 END)
  FROM x GROUP BY family, division_key, division_label, fam_sort
  UNION ALL
  SELECT 3, family, division_key, grp_code, grp_label, fam_sort, division_key, grp_sort,
         COUNT(*), SUM(coded), SUM(td), SUM(CASE WHEN coded = 0 THEN td ELSE 0 END)
  FROM x GROUP BY family, division_key, grp_code, grp_label, fam_sort, grp_sort
)
SELECT level, family, division, material_group, label,
       materials, coded, materials - coded AS to_code, to_date,
       open_amount AS not_fully_coded,
       ROUND(100.0 * to_date / NULLIF((SELECT td FROM tot), 0), 1) AS pct_of_all,
       ROUND(100.0 * coded / NULLIF(materials, 0), 1) AS coded_pct
FROM n
ORDER BY fam_sort, family, division_key, grp_sort, level`,
  },
  {
    code: 'MAT_TO_CODE',
    name: 'Material report: largest materials still to code',
    module: 'ACTUAL',
    category: 'Material report',
    description: 'The ten materials with no work package yet that carry the most cost to date.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
${WITH_MM}, ${MT}
SELECT mm.material_code, mm.material_name AS description, mt.grp_label AS material_group,
       COALESCE(mm.c_amt, 0) AS this_month, mm.t_amt AS to_date
FROM mm JOIN mt ON mt.material_key = mm.material_key
WHERE NOT EXISTS (SELECT 1 FROM material_work_package w
                   WHERE w.project_key = :project_key AND w.material_code = mm.material_code)
ORDER BY ABS(mm.t_amt) DESC, mm.material_code LIMIT 10`,
  },
  {
    code: 'MAT_RATES',
    name: 'Material report: rate analysis',
    module: 'ACTUAL',
    category: 'Material report',
    description: 'Per material: this month\'s rate against the previous rate (to last month), the to-date rate '
      + 'against the start rate (the material\'s first month with a quantity), and the to-date rate '
      + 'against the weighted ME2N price (purchase lines; Above/Below when more than 10% apart). '
      + 'Value = quantity x rate change. Rates more than 3x apart read "Check" (a unit mix-up, not a '
      + 'price change), stay out of the value totals and set needs_check.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
${WITH_RC},
pr2 AS (
  SELECT rc.*, pp.weighted_price AS po_price,
         CASE WHEN rc.tr > 0 AND pp.weighted_price > 0
                   AND NOT (rc.tr / pp.weighted_price <= 3 AND rc.tr / pp.weighted_price >= 1.0 / 3) THEN 1 ELSE 0 END AS po_check
  FROM rc LEFT JOIN v_po_material_price pp
    ON pp.project_key = :project_key AND pp.material_key = rc.material_key
)
SELECT material_code, material_name AS description, material_group, unit,
       pr AS previous_rate, cr AS this_month_rate,
       ROUND(100.0 * m_d / pr, 1) AS vs_previous_pct,
       CASE WHEN m_check = 1 THEN 'Check' WHEN m_d > 0 THEN 'Up' WHEN m_d < 0 THEN 'Down'
            WHEN m_d = 0 THEN 'Same' ELSE '' END AS vs_previous,
       ROUND(c_qty * m_d, 2) AS value_this_month,
       start_key AS start_month, sr AS start_rate, tr AS to_date_rate,
       ROUND(100.0 * s_d / sr, 1) AS vs_start_pct,
       CASE WHEN s_check = 1 THEN 'Check' WHEN s_d > 0 THEN 'Up' WHEN s_d < 0 THEN 'Down'
            WHEN s_d = 0 THEN 'Same' ELSE '' END AS vs_start,
       ROUND(t_qty * s_d, 2) AS value_since_start,
       po_price,
       CASE WHEN tr > 0 AND po_price > 0 THEN ROUND(100.0 * (tr / po_price - 1), 1) END AS vs_po_pct,
       CASE WHEN po_check = 1 THEN 'Check'
            WHEN tr > 0 AND po_price > 0 AND tr / po_price - 1 > 0.10 THEN 'Above +10%'
            WHEN tr > 0 AND po_price > 0 AND tr / po_price - 1 < -0.10 THEN 'Below -10%'
            WHEN tr > 0 AND po_price > 0 THEN 'Within 10%' ELSE '' END AS vs_po,
       t_qty AS to_date_qty, t_amt AS to_date_amount,
       CASE WHEN m_check = 1 OR s_check = 1 OR po_check = 1 THEN 1 ELSE 0 END AS needs_check
FROM pr2
ORDER BY ABS(t_amt) DESC, material_code`,
  },
  {
    code: 'MAT_CHECKS',
    name: 'Material report: checks',
    module: 'ACTUAL',
    category: 'Material report',
    description: 'What to look at in the MB51 / ME2N data. None of these changes a figure. The MB51 file\'s own '
      + 'total row is compared with the loaded lines (a file with no total row reads "not checked", never '
      + '"ok"); movements left out, lines held back as Pending, materials without a group, mixed units, '
      + 'a negative to-date, issues to subcontractors, and MB51 against CJI3 material cost. '
      + 'check_code feeds MAT_CHECK_ROWS.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
WITH ${MAT_CHECKS_CTE}
SELECT check_code, check_name, status, lines, amount, detail,
       CASE WHEN status IN ('warn') THEN 1 ELSE 0 END AS needs_attention
FROM c ORDER BY ord`,
  },
  {
    code: 'MAT_CHECK_ROWS',
    name: 'Material report: rows behind a check',
    module: 'ACTUAL',
    category: 'Material report',
    description: 'The lines (first 100, largest first) behind one MAT_CHECKS row, picked by check_code.',
    params: [P_PROJECT, { name: 'check_code', type: 'text', label: 'Check', required: true }],
    viz: { kind: 'table' },
    sql: `
WITH cut AS (SELECT COALESCE((SELECT cutoff_date FROM project_cutoff WHERE project_key = :project_key), DATE('now')) AS d),
r AS (
  SELECT posting_date, movement_type || ' ' || COALESCE(movement_text, '') AS movement,
         document_no || '/' || COALESCE(fiscal_year, '') || '/' || COALESCE(document_line, '') AS document,
         material_code, material_name AS description, quantity, amount, 'SAP signed ' || ROUND(sap_amount, 2) AS detail
  FROM v_material_movement
  WHERE project_key = :project_key AND (
        (:check_code = 'unknown_mvt' AND movement_kind = 'UNKNOWN')
     OR (:check_code = 'outside' AND movement_kind = 'OUTSIDE')
     OR (:check_code = 'zero_lines' AND movement_kind = 'ISSUE' AND amount = 0))
  UNION ALL
  SELECT posting_date, movement_type || ' ' || COALESCE(movement_text, ''),
         document_no || '/' || COALESCE(fiscal_year, '') || '/' || COALESCE(document_line, ''),
         material_code, material_name, quantity, amount, pending_reason
  FROM v_material_issue_all
  WHERE project_key = :project_key AND (
        (:check_code = 'after_cut' AND pending_reason = 'After cut-off')
     OR (:check_code = 'no_date' AND pending_reason = 'No posting date'))
  UNION ALL
  SELECT posting_date, movement_type || ' ' || COALESCE(movement_text, ''),
         document_no || '/' || COALESCE(fiscal_year, '') || '/' || COALESCE(document_line, ''),
         material_code, material_name, quantity, amount,
         'Supplier ' || COALESCE(vendor_code, '(none)') || ' ' || COALESCE(vendor_name, '')
  FROM v_material_issue WHERE project_key = :project_key AND :check_code = 'z21' AND issue_type = 'S'
  UNION ALL
  SELECT NULL, 'Document line ' || row_no, NULL, NULL, NULL, NULL,
         CAST(json_extract(raw_json, '$.mapped.amount') AS REAL), message
  FROM stg_row
  WHERE :check_code = 'duplicates' AND status = 'SKIPPED' AND message LIKE 'Repeat of the document line%'
    AND import_batch_id = (SELECT MAX(f.import_batch_id) FROM fact_material_issue f WHERE f.project_key = :project_key)
  UNION ALL
  SELECT NULL, NULL, NULL, material_code, MAX(material_name), SUM(quantity), SUM(amount),
         CASE :check_code WHEN 'multi_unit' THEN 'Units ' || GROUP_CONCAT(DISTINCT uom)
                          WHEN 'no_group' THEN 'No material group' ELSE 'Net negative' END
  FROM v_material_issue
  WHERE project_key = :project_key AND :check_code IN ('no_group', 'multi_unit', 'negative_td')
  GROUP BY material_key, material_code
  HAVING (:check_code = 'no_group' AND MAX(material_group) IS NULL)
      OR (:check_code = 'multi_unit' AND COUNT(DISTINCT uom) > 1)
      OR (:check_code = 'negative_td' AND SUM(amount) < -0.005)
  UNION ALL
  SELECT m.posting_period, 'Month ' || m.posting_period, NULL, NULL, 'MB51 ' || ROUND(m.mb, 2) || ' / CJI3 ' || ROUND(m.cj, 2),
         NULL, m.mb - m.cj, 'MB51 minus CJI3 material cost'
  FROM (SELECT p.period_key AS posting_period,
               (SELECT COALESCE(SUM(amount), 0) FROM v_material_issue WHERE project_key = :project_key AND period_key = p.period_key) AS mb,
               (SELECT COALESCE(SUM(amount), 0) FROM v_actual WHERE project_key = :project_key AND cost_type = 'MATERIAL' AND period_key = p.period_key) AS cj
        FROM (SELECT period_key FROM v_material_issue WHERE project_key = :project_key
              UNION SELECT period_key FROM v_actual WHERE project_key = :project_key AND cost_type = 'MATERIAL') p) m
  WHERE :check_code = 'recon' AND ABS(m.mb - m.cj) >= 0.01
  UNION ALL
  SELECT document_date, 'PO ' || po_no || '/' || COALESCE(po_item, ''), po_no, material_code, material_name, open_qty, open_value,
         'Open ' || CAST(julianday((SELECT d FROM cut)) - julianday(document_date) AS INTEGER) || ' days'
  FROM v_po_material_line
  WHERE :check_code = 'old_po' AND project_key = :project_key AND kind = 'PUR' AND is_deleted = 0 AND open_qty > 0
    AND document_date IS NOT NULL AND document_date < DATE((SELECT d FROM cut), '-90 days')
)
SELECT * FROM r ORDER BY ABS(COALESCE(amount, 0)) DESC LIMIT 100`,
  },

  // ---- At a glance: one row per card (docs/port/material-gap.md 1.4 #6, P2-1) ----
  {
    code: 'MAT_INSIGHT_MOM',
    name: 'Material report card: this month against last',
    module: 'ACTUAL',
    category: 'Material report',
    description: 'This month\'s issue cost against last month\'s, and the two divisions that moved it most '
      + 'up and down (a division shows as its family where the family has none).',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
WITH ${RM}, ${MT},
dv AS (
  SELECT mt.division_label AS lbl,
         SUM(CASE WHEN l.period_key = rm.pk THEN l.amount ELSE 0 END) AS cur,
         SUM(CASE WHEN l.period_key = rm.last_pk THEN l.amount ELSE 0 END) AS lst
  FROM v_material_issue l JOIN mt ON mt.material_key = l.material_key, rm
  WHERE l.project_key = :project_key GROUP BY mt.division_label
),
t AS (SELECT COALESCE(SUM(cur), 0) AS cur, COALESCE(SUM(lst), 0) AS lst FROM dv)
SELECT (SELECT pk FROM rm) AS report_month, (SELECT last_pk FROM rm) AS last_month_key,
       t.cur AS this_month, t.lst AS last_month, t.cur - t.lst AS change,
       ROUND(100.0 * (t.cur - t.lst) / NULLIF(ABS(t.lst), 0), 1) AS change_pct,
  ${pick('dv', 'lbl', 'cur - lst', 'cur - lst > 0.5', 'cur - lst DESC', 'up', 2)},
  ${pick('dv', 'lbl', 'cur - lst', 'cur - lst < -0.5', 'cur - lst', 'down', 2)}
FROM t`,
  },
  {
    code: 'MAT_INSIGHT_MIX',
    name: 'Material report card: where this month went',
    module: 'ACTUAL',
    category: 'Material report',
    description: 'The four divisions with the largest issue cost this month, and everything else as one line.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
WITH ${RM}, ${MT},
dv AS (
  SELECT mt.division_label AS lbl, SUM(l.amount) AS cur
  FROM v_material_issue l JOIN mt ON mt.material_key = l.material_key, rm
  WHERE l.project_key = :project_key AND l.period_key = rm.pk GROUP BY mt.division_label
),
t AS (SELECT COALESCE(SUM(cur), 0) AS cur FROM dv)
SELECT t.cur AS this_month,
  ${pick('dv', 'lbl', 'cur', 'ABS(cur) > 0.5', 'cur DESC', 'd', 4)},
  t.cur - COALESCE((SELECT SUM(cur) FROM (SELECT cur FROM dv WHERE ABS(cur) > 0.5 ORDER BY cur DESC, lbl LIMIT 4)), 0) AS other_amount
FROM t`,
  },
  {
    code: 'MAT_INSIGHT_CODING',
    name: 'Material report card: coding still to do',
    module: 'ACTUAL',
    category: 'Material report',
    description: 'How many materials have no work package yet and what they cost to date, with the two '
      + 'divisions holding the most uncoded cost.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
WITH ${MT},
mat AS (
  SELECT l.material_key, SUM(l.amount) AS td,
         EXISTS (SELECT 1 FROM material_work_package w
                  WHERE w.project_key = l.project_key AND w.material_code = l.material_code) AS coded
  FROM v_material_issue l WHERE l.project_key = :project_key GROUP BY l.material_key, l.material_code, l.project_key
),
op AS (SELECT mt.division_label AS lbl, SUM(mat.td) AS open_amt
       FROM mat JOIN mt ON mt.material_key = mat.material_key WHERE mat.coded = 0 GROUP BY mt.division_label)
SELECT COUNT(*) AS materials, COALESCE(SUM(1 - coded), 0) AS to_code,
       COALESCE(SUM(CASE WHEN coded = 0 THEN td ELSE 0 END), 0) AS to_code_amount,
       COALESCE(SUM(td), 0) AS to_date,
       ROUND(100.0 * SUM(CASE WHEN coded = 0 THEN td ELSE 0 END) / NULLIF(SUM(td), 0), 1) AS open_pct,
       ROUND(100.0 * SUM(coded) / NULLIF(COUNT(*), 0), 1) AS coded_pct,
  ${pick('op', 'lbl', 'open_amt', 'open_amt > 0.5', 'open_amt DESC', 'top', 2)}
FROM mat`,
  },
  {
    code: 'MAT_INSIGHT_DOCS',
    name: 'Material report card: issue documents',
    module: 'ACTUAL',
    category: 'Material report',
    description: 'Issue documents this month (material document + year): how many, the average, the largest, '
      + 'and the material issued to subcontractors (Z21/Z22) that is recoverable.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
WITH ${RM},
d AS (
  SELECT l.document_no || '/' || COALESCE(l.fiscal_year, '') AS doc, l.period_key, SUM(l.amount) AS amt
  FROM v_material_issue l WHERE l.project_key = :project_key GROUP BY 1, 2
)
SELECT (SELECT COUNT(*) FROM d, rm WHERE d.period_key = rm.pk) AS documents,
       (SELECT COUNT(*) FROM d, rm WHERE d.period_key = rm.last_pk) AS documents_last_month,
       (SELECT AVG(amt) FROM d, rm WHERE d.period_key = rm.pk) AS average_amount,
       (SELECT doc FROM d, rm WHERE d.period_key = rm.pk ORDER BY amt DESC, doc LIMIT 1) AS largest_document,
       (SELECT amt FROM d, rm WHERE d.period_key = rm.pk ORDER BY amt DESC, doc LIMIT 1) AS largest_amount,
       (SELECT COALESCE(SUM(l.amount), 0) FROM v_material_issue l, rm
         WHERE l.project_key = :project_key AND l.issue_type = 'S' AND l.period_key = rm.pk) AS subcontractors_this_month,
       (SELECT COALESCE(SUM(amount), 0) FROM v_material_issue
         WHERE project_key = :project_key AND issue_type = 'S') AS subcontractors_to_date`,
  },
  {
    code: 'MAT_INSIGHT_RATES',
    name: 'Material report card: rates this month against previous',
    module: 'ACTUAL',
    category: 'Material report',
    description: 'How many materials got dearer, cheaper, stayed the same or need a check (rates more than 3x '
      + 'apart) this month against their previous rate, the value of the change (quantity x rate change), '
      + 'the largest single effect, and the same since each material\'s start rate.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
${WITH_RC}
SELECT COALESCE(SUM(m_d > 0), 0) AS dearer, COALESCE(SUM(m_d < 0), 0) AS cheaper,
       COALESCE(SUM(m_d = 0), 0) AS same_rate, COALESCE(SUM(m_check), 0) AS to_check,
       COALESCE(ROUND(SUM(c_qty * m_d), 2), 0) AS value_effect,
       ROUND(100.0 * SUM(c_qty * m_d) / NULLIF(SUM(CASE WHEN m_d IS NOT NULL THEN c_qty * pr END), 0), 2) AS value_pct,
       (SELECT material_name FROM rc WHERE c_qty * m_d > 0.5 ORDER BY c_qty * m_d DESC, material_code LIMIT 1) AS top_material,
       (SELECT ROUND(c_qty * m_d, 2) FROM rc WHERE c_qty * m_d > 0.5 ORDER BY c_qty * m_d DESC, material_code LIMIT 1) AS top_effect,
       COALESCE(SUM(s_d > 0), 0) AS dearer_since_start, COALESCE(SUM(s_d < 0), 0) AS cheaper_since_start,
       COALESCE(ROUND(SUM(t_qty * s_d), 2), 0) AS since_start_effect
FROM rc`,
  },
  {
    code: 'MAT_INSIGHT_NEW',
    name: 'Material report card: new materials',
    module: 'ACTUAL',
    category: 'Material report',
    description: 'Materials issued for the first time this month: how many, what they cost, their share of '
      + 'the month, and the two largest.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
${WITH_MM},
nw AS (SELECT material_name AS lbl, c_amt AS amt FROM mm, rm WHERE mm.first_key = rm.pk)
SELECT COUNT(*) AS new_materials, COALESCE(SUM(amt), 0) AS new_amount,
       ROUND(100.0 * SUM(amt) / NULLIF((SELECT SUM(c_amt) FROM mm), 0), 1) AS share_pct,
  ${pick('nw', 'lbl', 'amt', '1 = 1', 'amt DESC', 'top', 2)}
FROM nw`,
  },
  {
    code: 'MAT_INSIGHT_PENDING',
    name: 'Material report card: pending',
    module: 'ACTUAL',
    category: 'Material report',
    description: 'Issue lines held back from the figures: posted after the cut-off, or with no posting date.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
WITH p AS (SELECT * FROM v_material_issue_all WHERE project_key = :project_key AND pending_reason IS NOT NULL),
pm AS (SELECT material_name AS lbl, SUM(amount) AS amt FROM p GROUP BY material_key, material_name)
SELECT COALESCE((SELECT SUM(amount) FROM p), 0) AS pending,
       COALESCE((SELECT SUM(amount) FROM p WHERE pending_reason = 'After cut-off'), 0) AS after_cut,
       COALESCE((SELECT SUM(amount) FROM p WHERE pending_reason = 'No posting date'), 0) AS no_date,
       (SELECT COUNT(*) FROM pm) AS materials,
  ${pick('pm', 'lbl', 'amt', '1 = 1', 'ABS(amt) DESC', 'top', 1)}`,
  },
  {
    code: 'MAT_INSIGHT_PO',
    name: 'Material report card: issue rate against PO price',
    module: 'ACTUAL',
    category: 'Material report',
    description: 'The rate each material is issued at to date against its weighted ME2N price: how many are '
      + 'more than 10% above or below, and the one with the largest excess cost.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
${WITH_MM},
x AS (
  SELECT mm.material_name AS lbl, mm.t_amt AS amt, (mm.t_amt / mm.t_qty) / pp.weighted_price - 1 AS pct
  FROM mm JOIN v_po_material_price pp ON pp.project_key = :project_key AND pp.material_key = mm.material_key
  WHERE ABS(mm.t_qty) > 1e-6 AND mm.t_amt > 0 AND pp.weighted_price > 0 AND mm.t_amt / mm.t_qty > 0
)
SELECT COUNT(*) AS materials_compared, COALESCE(SUM(pct > 0.10), 0) AS above_10, COALESCE(SUM(pct < -0.10), 0) AS below_10,
       ROUND(100.0 * SUM(amt) / NULLIF((SELECT SUM(t_amt) FROM mm), 0), 1) AS share_of_to_date_pct,
  ${pick('x', 'lbl', 'ROUND(100.0 * pct, 1)', 'pct > 0.10', 'pct * amt DESC', 'top', 1)}
FROM x`,
  },
  {
    code: 'MAT_INSIGHT_PURCHASING',
    name: 'Material report card: purchasing (ME2N)',
    module: 'ACTUAL',
    category: 'Material report',
    description: 'Purchase lines of the material POs as exported: ordered value, still to be delivered, '
      + 'still to be invoiced, open more than 90 days at the cut-off, and committed = to date + still to be delivered.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
WITH cut AS (SELECT COALESCE((SELECT cutoff_date FROM project_cutoff WHERE project_key = :project_key), DATE('now')) AS d),
l AS (SELECT * FROM v_po_material_line WHERE project_key = :project_key AND kind = 'PUR' AND is_deleted = 0)
SELECT COUNT(*) AS po_lines, COUNT(DISTINCT po_no) AS purchase_orders,
       COALESCE(SUM(net_value), 0) AS ordered_value, COALESCE(SUM(open_value), 0) AS open_value,
       COALESCE(SUM(invoice_value), 0) AS to_invoice_value,
       COALESCE(SUM(CASE WHEN open_qty > 0 AND document_date < DATE((SELECT d FROM cut), '-90 days') THEN open_value END), 0) AS open_over_90_value,
       COALESCE(SUM(CASE WHEN open_qty > 0 AND document_date < DATE((SELECT d FROM cut), '-90 days') THEN 1 END), 0) AS open_over_90_lines,
       (SELECT COALESCE(SUM(amount), 0) FROM v_material_issue WHERE project_key = :project_key) + COALESCE(SUM(open_value), 0) AS committed
FROM l`,
  },
];
