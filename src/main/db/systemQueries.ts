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

import { MATERIAL_QUERIES } from './materialQueries';

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
  /** bar fill for a one-sided chart, e.g. 'var(--div-neg)' for overruns */
  fill?: string;
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

/**
 * A service's unit, in the order the standalone subcontract report used: the
 * ZSCSRV1 PO service UOM for that service code, then a code suffix after "-"
 * ("S0302-M3"), then a unit named in the Arabic service text.
 */
export const SC_UNIT_SQL = (code: string, text: string, poUom: string) => `COALESCE(
    ${poUom},
    CASE WHEN INSTR(${code}, '-') > 0 THEN SUBSTR(${code}, INSTR(${code}, '-') + 1) END,
    CASE
      WHEN ${text} LIKE '%م3%' THEN 'M3'
      WHEN ${text} LIKE '%م2%' THEN 'M2'
      WHEN ${text} LIKE '%يومية%' THEN 'DAY'
      WHEN ${text} LIKE '%ساعة%' OR ${text} LIKE '%ساعه%' THEN 'H'
      WHEN ${text} LIKE '%شهر%' THEN 'MON'
      WHEN ${text} LIKE '%بالعدد%' THEN 'EA'
      WHEN ${text} LIKE '%مقط%' THEN 'LS'
    END)`;

/** Top 7 trades by total certified value keep their own series; the rest fold into "Other trades". */
const SC_TRADE_RANK_SQL = `trade_rank AS (
  SELECT trade, ROW_NUMBER() OVER (ORDER BY SUM(amount_net) DESC, trade) AS rn
  FROM v_service_line WHERE project_key = :project_key GROUP BY trade
)`;

/**
 * Each certificate upload's lines as posted (service_line_snapshot), numbered
 * newest first per project, and the latest two compared line by line. A
 * newly approved line counts at its full amount, not its movement — the same
 * rule the monthly workbook uses. With only one load there is nothing to
 * compare, so no rows come out.
 */
const SC_CHANGES_SQL = `loads AS (
  SELECT s.import_batch_id, ROW_NUMBER() OVER (ORDER BY s.import_batch_id DESC) AS rn
  FROM service_line_snapshot s
  JOIN import_batch b ON b.import_batch_id = s.import_batch_id AND b.status IN ('POSTED','SUPERSEDED')
  WHERE s.project_key = :project_key
  GROUP BY s.import_batch_id
),
cur AS (SELECT s.* FROM service_line_snapshot s JOIN loads l ON l.import_batch_id = s.import_batch_id
        WHERE l.rn = 1 AND s.project_key = :project_key),
prev AS (SELECT s.* FROM service_line_snapshot s JOIN loads l ON l.import_batch_id = s.import_batch_id
         WHERE l.rn = 2 AND s.project_key = :project_key),
changes AS (
  SELECT * FROM (
    SELECT CASE
             WHEN p.line_uid IS NULL THEN 'New'
             WHEN COALESCE(p.is_approved, 1) = 0 AND COALESCE(c.is_approved, 1) = 1 THEN 'Approved since last load'
             WHEN ABS(c.amount_net - p.amount_net) > 0.005 THEN 'Amount changed'
           END AS change_type,
           c.po_no, c.vendor_name, c.service_code, c.service_text,
           p.amount_net AS before, c.amount_net AS now,
           CASE
             WHEN p.line_uid IS NULL THEN c.amount_net
             WHEN COALESCE(p.is_approved, 1) = 0 AND COALESCE(c.is_approved, 1) = 1 THEN c.amount_net
             ELSE c.amount_net - p.amount_net
           END AS difference
    FROM cur c LEFT JOIN prev p ON p.line_uid = c.line_uid
    WHERE EXISTS (SELECT 1 FROM prev)
    UNION ALL
    SELECT 'Removed', p.po_no, p.vendor_name, p.service_code, p.service_text,
           p.amount_net, NULL, -p.amount_net
    FROM prev p WHERE NOT EXISTS (SELECT 1 FROM cur c WHERE c.line_uid = p.line_uid)
  ) WHERE change_type IS NOT NULL
)`;

/** "Sep 2026" from a 'YYYY-MM' expression, so the cards never format a date in the UI. */
const SC_MONTH_NAME_SQL = (m: string) => `(SUBSTR('JanFebMarAprMayJunJulAugSepOctNovDec', (CAST(SUBSTR(${m}, 6, 2) AS INTEGER) - 1) * 3 + 1, 3) || ' ' || SUBSTR(${m}, 1, 4))`;

/** The report month (month of the cut-off) and the calendar month before it. */
const SC_RM_SQL = `rm AS (
  SELECT MAX(report_month) AS m, strftime('%Y-%m', MAX(report_month) || '-01', '-1 month') AS last_m
  FROM v_service_line WHERE project_key = :project_key
)`;

/** The n-th ranked value of \`col\` in a ranked CTE (one-row insight queries). */
const scPick = (rn: number, col: string) => `MAX(CASE WHEN rn = ${rn} THEN ${col} END)`;

/**
 * Cost per month by resource type (S Subcontract / L Labour / P Plant / Other)
 * — Opening first, then the months up to the report month. CTE \`mw\`: one row
 * per bucket, wide, with total, cumulative and active subcontractors.
 */
const scMonthWide = (f = '') => `mw0 AS (
  SELECT CASE WHEN report_bucket = 'OPENING' THEN 'Opening' ELSE period_key END AS period_key,
         CASE WHEN report_bucket = 'OPENING' THEN 0 ELSE CAST(REPLACE(period_key, '-', '') AS INTEGER) END AS sort_key,
         CASE resource_code WHEN 'S' THEN 1 WHEN 'L' THEN 2 WHEN 'P' THEN 3 ELSE 4 END AS series_order,
         vendor_key, certificate_id, a
  FROM v_service_line
  WHERE project_key = :project_key AND report_bucket <> 'PENDING'
    AND (report_bucket = 'OPENING' OR period_key IS NOT NULL)${f}
),
mw_cert AS (
  SELECT period_key, COUNT(DISTINCT certificate_id) AS certs FROM mw0 GROUP BY period_key
),
mw_subs AS (
  SELECT period_key, COUNT(*) AS subs FROM (
    SELECT period_key, vendor_key FROM mw0 GROUP BY period_key, vendor_key HAVING ABS(SUM(a)) > 1e-9)
  GROUP BY period_key
),
mw AS (
  SELECT m.period_key, m.sort_key,
         SUM(CASE WHEN m.series_order = 1 THEN m.a ELSE 0 END) AS subcontract,
         SUM(CASE WHEN m.series_order = 2 THEN m.a ELSE 0 END) AS labour,
         SUM(CASE WHEN m.series_order = 3 THEN m.a ELSE 0 END) AS plant,
         SUM(CASE WHEN m.series_order = 4 THEN m.a ELSE 0 END) AS other,
         SUM(m.a) AS total,
         SUM(SUM(m.a)) OVER (ORDER BY m.sort_key) AS cumulative,
         COALESCE(MAX(su.subs), 0) AS subcontractors,
         COALESCE(MAX(ce.certs), 0) AS certificates
  FROM mw0 m LEFT JOIN mw_subs su ON su.period_key = m.period_key
             LEFT JOIN mw_cert ce ON ce.period_key = m.period_key
  GROUP BY m.period_key, m.sort_key
)`;
const SC_MONTH_WIDE_SQL = scMonthWide();

/**
 * Rate analysis per Service + normalised Description (the tool's coding key).
 * rt_cur: this month and everything before it (Opening + Previous), counted lines.
 * rt_first: the row's first period with qty, over every approved, dated line
 * regardless of the cut date. rx: rates, changes and effects; a pair of rates
 * more than 3x apart (or either <= 0) is "check" and carries no change/effect, so
 * it drops out of every total.
 */
const scRates = (f = '') => `rt_cur AS (
  SELECT service_code, service_text_norm, MAX(service_text) AS service_text,
         SUM(CASE WHEN report_bucket = 'THIS_MONTH' THEN a ELSE 0 END) AS cur_a,
         SUM(CASE WHEN report_bucket = 'THIS_MONTH' THEN report_qty ELSE 0 END) AS cur_q,
         SUM(CASE WHEN report_bucket IN ('OPENING','PREVIOUS') THEN a ELSE 0 END) AS prev_a,
         SUM(CASE WHEN report_bucket IN ('OPENING','PREVIOUS') THEN report_qty ELSE 0 END) AS prev_q,
         SUM(CASE WHEN report_bucket IN ('OPENING','PREVIOUS') AND a <> 0 THEN 1 ELSE 0 END) AS prev_n
  FROM v_service_line
  WHERE project_key = :project_key AND report_bucket <> 'PENDING'${f}
  GROUP BY service_code, service_text_norm
),
rt_first AS (
  SELECT service_code, service_text_norm, a / q AS start_rate, first_bucket FROM (
    SELECT service_code, service_text_norm, SUM(a) AS a, SUM(report_qty) AS q, bucket AS first_bucket,
           ROW_NUMBER() OVER (PARTITION BY service_code, service_text_norm
                              ORDER BY CASE WHEN bucket = 'OPENING' THEN '0' ELSE bucket END) AS rn
    FROM v_service_line_all
    WHERE project_key = :project_key AND pend_reason IS NULL${f}
    GROUP BY service_code, service_text_norm, bucket
    HAVING ABS(SUM(report_qty)) > 1e-9
  ) WHERE rn = 1
),
rt1 AS (
  SELECT c.service_code, c.service_text, c.service_text_norm, c.cur_a, c.cur_q, c.prev_a, c.prev_q, c.prev_n,
         c.cur_a + c.prev_a AS td_a, c.cur_q + c.prev_q AS td_q,
         CASE WHEN ABS(c.cur_q) > 1e-9 THEN c.cur_a / c.cur_q END AS this_rate,
         CASE WHEN ABS(c.prev_q) > 1e-9 THEN c.prev_a / c.prev_q END AS prev_rate,
         CASE WHEN ABS(c.cur_q + c.prev_q) > 1e-9 THEN (c.cur_a + c.prev_a) / (c.cur_q + c.prev_q) END AS td_rate,
         f.start_rate, f.first_bucket
  FROM rt_cur c
  LEFT JOIN rt_first f ON f.service_code IS c.service_code AND f.service_text_norm IS c.service_text_norm
),
rt AS (
  SELECT r.*,
    CASE WHEN this_rate IS NOT NULL AND prev_rate IS NOT NULL
          AND (this_rate <= 0 OR prev_rate <= 0 OR this_rate / prev_rate > 3 OR this_rate / prev_rate < 1.0 / 3)
         THEN 1 ELSE 0 END AS chk_mv,
    CASE WHEN td_rate IS NOT NULL AND start_rate IS NOT NULL
          AND (td_rate <= 0 OR start_rate <= 0 OR td_rate / start_rate > 3 OR td_rate / start_rate < 1.0 / 3)
         THEN 1 ELSE 0 END AS chk_sv
  FROM rt1 r
),
rx AS (
  SELECT rt.*,
    CASE WHEN chk_mv = 0 AND this_rate IS NOT NULL AND prev_rate IS NOT NULL THEN this_rate - prev_rate END AS d_mv,
    CASE WHEN chk_sv = 0 AND td_rate IS NOT NULL AND start_rate IS NOT NULL THEN td_rate - start_rate END AS d_sv
  FROM rt
),
rx2 AS (
  SELECT rx.*,
    cur_q * d_mv AS eff_mv,
    CASE WHEN d_mv IS NOT NULL THEN cur_q * prev_rate END AS base_mv,
    td_q * d_sv AS eff_sv,
    CASE WHEN d_sv IS NOT NULL THEN td_q * start_rate END AS base_sv,
    CASE WHEN chk_mv = 1 THEN 'check'
         WHEN d_mv IS NULL THEN CASE WHEN this_rate IS NOT NULL THEN 'new' ELSE '' END
         WHEN ABS(d_mv) < 0.005 THEN 'same'
         WHEN d_mv > 0 THEN 'dearer' ELSE 'cheaper' END AS status_mv,
    CASE WHEN d_sv IS NULL THEN ''
         WHEN ABS(d_sv) < 0.005 THEN 'same'
         WHEN d_sv > 0 THEN 'dearer' ELSE 'cheaper' END AS status_sv
  FROM rx
)`;
const SC_RATES_SQL = scRates();

// ---------------------------------------------------------------------------
// Filter bar + sheet helpers for the native Subcontract report page
// (docs/port/native-report.md). Every SC_SHEET_* query takes the same optional
// params, written as `(:p IS NULL OR col = :p)`, so filtering is SQL.
// ---------------------------------------------------------------------------

/**
 * A text parameter that may carry a leading "~": the query runner binds a numeric-looking string as a
 * number, which never equals a TEXT column holding the same digits (PO numbers, '03' work packages,
 * '020212' service codes). The page prefixes such keys with "~"; the prefix is stripped here.
 */
const scParam = (p: string) => `CASE WHEN SUBSTR(:${p}, 1, 1) = '~' THEN SUBSTR(:${p}, 2) ELSE :${p} END`;

/** Optional filter params as a predicate over v_service_line columns. `a` is a column prefix such as 's.'. */
export const scFilter = (a = '') => `(:tow IS NULL OR ${a}tow = ${scParam('tow')})
  AND (:vendor IS NULL OR ${a}vendor_key = :vendor)
  AND (:pkg IS NULL OR COALESCE(${a}work_package, '(not coded)') = ${scParam('pkg')})
  AND (:month IS NULL OR ${a}period_key = :month)
  AND (:q IS NULL OR INSTR(LOWER(COALESCE(${a}service_code, '') || ' ' || COALESCE(${a}service_text, '') || ' '
        || COALESCE(${a}vendor_name, '') || ' ' || COALESCE(${a}po_no, '') || ' ' || COALESCE(${a}tow, '')), LOWER(:q)) > 0)`;

/** The report filter params, declared for the query library UI. */
const P_SC_FILTERS: QueryParamDef[] = [
  { name: 'tow', type: 'text', label: 'Type of works' },
  { name: 'vendor', type: 'int', label: 'Subcontractor (vendor key)' },
  { name: 'pkg', type: 'text', label: 'DIV (work package)' },
  { name: 'month', type: 'text', label: 'Month (YYYY-MM)' },
  { name: 'q', type: 'text', label: 'Search' },
];

/** The drill-down keys: one service (code + normalised text), one PO. */
/**
 * The Actual cost register (simplification step 3): v_actual_cost by category and row, one month per
 * column. :rows_by picks the row — 'item' (GL / PO / material / service / order, the default),
 * 'package' or 'wbs'. Shared by REG_MONTHLY and REG_LINES so a drill-down matches its row exactly.
 */
const REG_BASE_SQL = `reg AS MATERIALIZED (
  SELECT c.*, COALESCE(t.label, c.cost_type, '(no cost type)') AS category,
         COALESCE(t.sort_order, 999) AS category_order, t.color AS category_color,
         CASE COALESCE(:rows_by, 'item')
           WHEN 'package' THEN COALESCE(c.work_package, '(unallocated)')
           WHEN 'wbs'     THEN COALESCE(c.wbs_code, '(no WBS)')
           -- code + name: one service code can carry several service texts, each its own item (the coding key)
           ELSE COALESCE(c.item_code, '(none)') || ' | ' || COALESCE(c.item_name, '') END AS item_key,
         CASE COALESCE(:rows_by, 'item')
           WHEN 'package' THEN COALESCE(c.work_package || COALESCE(' ' || wp.label, ''), '(unallocated)')
           WHEN 'wbs'     THEN COALESCE(c.wbs_code || COALESCE(' ' || c.wbs_name, ''), '(no WBS)')
           ELSE COALESCE(c.item_code, '(none)') || COALESCE(' ' || c.item_name, '') END AS item
  FROM v_actual_cost c
  LEFT JOIN dim_cost_type t ON t.code = c.cost_type
  LEFT JOIN dim_work_package wp ON wp.code = c.work_package
  WHERE c.project_key = :project_key AND (:source IS NULL OR c.source = :source)
)`;
const P_REG: QueryParamDef[] = [
  { name: 'rows_by', type: 'text', label: 'Rows (item / package / wbs)' },
  { name: 'source', type: 'text', label: 'Source (CJI3 / MB51 / CERT / ORDER)' },
];

const P_SC_DRILL: QueryParamDef[] = [
  { name: 'service_code', type: 'text', label: 'Service code' },
  { name: 'service_norm', type: 'text', label: 'Normalised service text' },
  { name: 'po_no', type: 'text', label: 'PO' },
];

/**
 * The tool's normText over a text expression — the same chain v_service_line_core applies (019_sc_port.sql),
 * so a PO-side description (v_po_service_line) can be joined to a certificate line's service_text_norm.
 */
export const scNorm = (col: string) => {
  let e = `COALESCE(${col}, '')`;
  for (const c of [1600, 1611, 1612, 1613, 1614, 1615, 1616, 1617, 1618]) e = `REPLACE(${e}, char(${c}), '')`;
  for (const [x, y] of [[1571, 1575], [1573, 1575], [1570, 1575], [1577, 1607], [1609, 1610]]) e = `REPLACE(${e}, char(${x}), char(${y}))`;
  for (const c of [9, 10, 11, 12, 13, 160]) e = `REPLACE(${e}, char(${c}), ' ')`;
  for (let i = 0; i < 7; i++) e = `REPLACE(${e}, '  ', ' ')`;
  for (const [x, y] of [[' -', '-'], ['- ', '-'], [' +', '+'], ['+ ', '+'], [' *', '*'], ['* ', '*'],
                        [' /', '/'], ['/ ', '/'], [' (', '('], ['( ', '('], [' )', ')'], [') ', ')']]) {
    e = `REPLACE(${e}, '${x}', '${y}')`;
  }
  return `lower(TRIM(${e}, ' '))`;
};

/** Qty / amount of the lines in a report bucket, 0 when there are none. */
const scQ = (cond: string) => `COALESCE(SUM(CASE WHEN ${cond} THEN report_qty END), 0)`;
const scA = (cond: string) => `COALESCE(SUM(CASE WHEN ${cond} THEN a END), 0)`;
const SC_PREV = `report_bucket IN ('OPENING','PREVIOUS')`;
const SC_CUR = `report_bucket = 'THIS_MONTH'`;
const SC_TD = `report_bucket <> 'PENDING'`;
const SC_PEND = `report_bucket = 'PENDING'`;
const scRate = (a: string, q: string) => `CASE WHEN ABS(${q}) > 1e-9 THEN ${a} / ${q} END`;

/** Period label + sort key of a line for the by-month sheets: Opening, each month, Pending. */
const SC_PERIOD_LABEL_SQL = `CASE report_bucket WHEN 'OPENING' THEN 'Opening' WHEN 'PENDING' THEN 'Pending'
       ELSE ${SC_MONTH_NAME_SQL('period_key')} END`;
const SC_PERIOD_ORDER_SQL = `CASE report_bucket WHEN 'OPENING' THEN 0 WHEN 'PENDING' THEN 999999
       ELSE CAST(REPLACE(period_key, '-', '') AS INTEGER) END`;

/**
 * One row per Service + Description (CTEs svc0 → svc) over a filtered line set `src`: the raw text, the work
 * package (DIV), the main type of works (largest To date) and the unit. Needs `u` = SC_PO_UOM_SQL.
 */
const scSvcMeta = (src: string) => `svc0 AS (
  SELECT service_code, service_text_norm, tow,
         MAX(service_text) AS service_text, MAX(work_package) AS work_package,
         SUM(CASE WHEN report_bucket <> 'PENDING' THEN a ELSE 0 END) AS tow_td
  FROM ${src} GROUP BY service_code, service_text_norm, tow
),
svc AS (
  SELECT x.service_code, x.service_text_norm, x.service_text, x.work_package, x.tow,
         ${SC_UNIT_SQL('x.service_code', 'x.service_text', 'u.uom')} AS unit
  FROM (SELECT service_code, service_text_norm, tow,
               MAX(service_text) OVER (PARTITION BY service_code, service_text_norm) AS service_text,
               MAX(work_package) OVER (PARTITION BY service_code, service_text_norm) AS work_package,
               ROW_NUMBER() OVER (PARTITION BY service_code, service_text_norm ORDER BY tow_td DESC, tow) AS rn
        FROM svc0) x
  LEFT JOIN u ON u.service_code = x.service_code
  WHERE x.rn = 1
)`;

/** The project's user-set order of Type of works (default: largest To date first, see ORDER BY at the use). */
const SC_TOW_ORDER_SQL = `tow_ord AS (SELECT tow, sort_order FROM dim_tow_order WHERE project_key = :project_key)`;

/** MNL code of the Subcontract cost type (dim_cost_type.mnl), the Coding sheet's MNL column. */
const SC_MNL_SQL = `(SELECT COALESCE(mnl, 'OTHER') FROM dim_cost_type WHERE code = 'SUBCONTRACT')`;

/** PO service UOM per service code, for SC_UNIT_SQL. */
const SC_PO_UOM_SQL = `(SELECT service_code, MAX(uom) AS uom FROM v_po_service_line
      WHERE project_key = :project_key AND uom IS NOT NULL AND uom <> '' GROUP BY service_code)`;

/** Each customer-facing check once (CTE \`chk\`), shared by SC_CHECKS and the To review card. */
const SC_CHECKS_SQL = `lb AS (
  SELECT MAX(s.import_batch_id) AS id FROM service_line_snapshot s
  JOIN import_batch b ON b.import_batch_id = s.import_batch_id AND b.status = 'POSTED'
  WHERE s.project_key = :project_key
),
snap AS (SELECT * FROM service_line_snapshot WHERE project_key = :project_key AND import_batch_id = (SELECT id FROM lb)),
f AS (SELECT
  (SELECT control_total FROM import_batch WHERE import_batch_id = (SELECT id FROM lb)) AS footer,
  (SELECT COALESCE(SUM(amount_net * (split_count - 1)), 0) FROM snap) AS split_amt,
  (SELECT COALESCE(SUM(split_count - 1), 0) FROM snap) AS split_rows,
  (SELECT COALESCE(SUM(amount_net), 0) FROM snap) AS file_total,
  (SELECT COUNT(*) FROM snap) AS file_lines),
v AS (SELECT COALESCE(SUM(amount_net), 0) AS total, COUNT(*) AS lines,
             COALESCE(SUM(line_class = 'Adjustment'), 0) AS adj,
             COALESCE(SUM(CASE WHEN line_class = 'Adjustment' THEN a END), 0) AS adj_a,
             COALESCE(SUM(line_class = 'Qty only'), 0) AS qo,
             COALESCE(SUM(rate_src = 'PO line'), 0) AS eq,
             COALESCE(SUM(is_other_pc), 0) AS other_pc,
             COALESCE(SUM(CASE WHEN is_other_pc = 1 THEN a END), 0) AS other_pc_a,
             COALESCE(SUM(pend_reason = 'Not approved'), 0) AS na_n,
             COALESCE(SUM(CASE WHEN pend_reason = 'Not approved' THEN a END), 0) AS na_a,
             COALESCE(SUM(pend_reason = 'After cut date'), 0) AS ac_n,
             COALESCE(SUM(CASE WHEN pend_reason = 'After cut date' THEN a END), 0) AS ac_a,
             COALESCE(SUM(pend_reason = 'No date'), 0) AS nd_n,
             COALESCE(SUM(CASE WHEN pend_reason = 'No date' THEN a END), 0) AS nd_a,
             COALESCE(SUM(contract_type IS NULL OR contract_type NOT IN ('A1','A2')), 0) AS ct_n,
             COALESCE(SUM(CASE WHEN contract_type IS NULL OR contract_type NOT IN ('A1','A2') THEN a END), 0) AS ct_a,
             COALESCE(SUM(tow = '(no type of works)'), 0) AS tw_n,
             COALESCE(SUM(CASE WHEN tow = '(no type of works)' THEN a END), 0) AS tw_a,
             COALESCE(SUM(contract_type = 'A2' AND (tax_code IS NULL OR tax_code NOT IN (SELECT code FROM dim_tax_code))), 0) AS vat_n,
             COALESCE(SUM(CASE WHEN contract_type = 'A2' AND (tax_code IS NULL OR tax_code NOT IN (SELECT code FROM dim_tax_code)) THEN a END), 0) AS vat_a,
             COALESCE(SUM(line_class = 'Normal' AND a = 0 AND q = 0), 0) AS zero_n,
             COALESCE(SUM(CASE WHEN report_bucket <> 'PENDING' THEN a END), 0) AS to_date,
             COALESCE(SUM(CASE WHEN report_bucket = 'PENDING' THEN a END), 0) AS pending
      FROM v_service_line WHERE project_key = :project_key),
allv AS (SELECT COALESCE(SUM(a), 0) AS total FROM v_service_line_all WHERE project_key = :project_key),
mt AS (SELECT COUNT(*) AS unmatched FROM v_service_line_po_match
       WHERE project_key = :project_key AND match_level = 'Not found'),
pl AS (SELECT COUNT(*) AS n FROM v_po_service_line WHERE project_key = :project_key),
nu AS (
  SELECT COUNT(*) AS n FROM (
    SELECT s.service_code, s.service_text,
           ${SC_UNIT_SQL('s.service_code', 's.service_text', 'u.uom')} AS unit
    FROM (SELECT DISTINCT service_code, service_text FROM v_service_line WHERE project_key = :project_key) s
    LEFT JOIN ${SC_PO_UOM_SQL} u ON u.service_code = s.service_code)
  WHERE unit IS NULL
),
ng AS (
  SELECT COUNT(*) AS n, COALESCE(SUM(td), 0) AS amt FROM (
    SELECT SUM(a) AS td FROM v_service_line
    WHERE project_key = :project_key AND report_bucket <> 'PENDING'
    GROUP BY service_code, service_text_norm HAVING SUM(a) < -0.5)
),
cf AS (
  SELECT COUNT(*) AS n, COALESCE(SUM(amt), 0) AS amt FROM (
    SELECT SUM(a) AS amt FROM v_service_line WHERE project_key = :project_key
    GROUP BY certificate_id, item_no, package_no, line_no
    HAVING COUNT(*) > 1 AND MAX(a) <> MIN(a))
),
vr AS (
  SELECT COUNT(*) AS n,
         COALESCE(group_concat(code || ' ' || ROUND(vat_rate * 100) || '%', ', '), '') AS txt
  FROM dim_tax_code WHERE code IN (SELECT DISTINCT tax_code FROM v_service_line WHERE project_key = :project_key)
),
c AS (
  SELECT 1 AS sort, 'FOOTER' AS check_code, 'SAP grand total (file footer)' AS check_name, NULL AS cnt, f.footer AS amt, f.footer AS value,
         CASE WHEN f.footer IS NULL THEN 'The latest upload has no grand-total row to check against' ELSE '' END AS detail,
         CASE WHEN f.footer IS NULL THEN 'not checked' ELSE 'info' END AS status FROM f
  UNION ALL SELECT 2, 'SPLITS', 'Repeated on WBS splits (counted once)', f.split_rows, -f.split_amt, -f.split_amt,
         f.split_rows || ' repeated row(s) skipped', 'info' FROM f
  UNION ALL SELECT 3, 'FILE_LINES', 'Lines in the latest upload', f.file_lines, f.file_total, f.file_total, f.file_lines || ' line(s)', 'info' FROM f
  UNION ALL SELECT 4, 'FOOTER_DIFF', 'Difference: footer − splits − lines', NULL,
         CASE WHEN f.footer IS NOT NULL THEN f.footer - f.split_amt - f.file_total END,
         CASE WHEN f.footer IS NOT NULL THEN f.footer - f.split_amt - f.file_total END,
         CASE WHEN f.footer IS NULL THEN 'No footer in the file'
              WHEN ABS(f.footer - f.split_amt - f.file_total) < 0.01 THEN 'The loaded lines reproduce SAP''s own total'
              ELSE 'The loaded lines do not reproduce SAP''s own total' END,
         CASE WHEN f.footer IS NULL THEN 'not checked'
              WHEN ABS(f.footer - f.split_amt - f.file_total) < 0.01 THEN 'ok' ELSE 'mismatch' END FROM f
  UNION ALL SELECT 5, 'REPORT_TOTAL', 'Report total (every loaded line)', v.lines, v.total, v.total,
         CASE WHEN ABS(v.total - f.file_total) > 0.01
              THEN 'Differs from the latest upload — some lines were only in an earlier upload'
              ELSE 'Same as the latest upload' END,
         CASE WHEN ABS(v.total - f.file_total) > 0.01 THEN 'warn' ELSE 'ok' END FROM v, f
  UNION ALL SELECT 6, 'ADJUSTMENTS', 'Adjustment lines (amount is not qty × rate)', v.adj, v.adj_a, v.adj,
         'Paid-% change, hold release, reversal or re-price; reported at amount ÷ rate', 'info' FROM v
  UNION ALL SELECT 7, 'QTY_ONLY', 'Qty-only lines (qty, no amount)', v.qo, 0, v.qo, 'Excluded from report qty', 'info' FROM v
  UNION ALL SELECT 8, 'ADJ_PO_RATE', 'Adjustments at the PO line''s certified rate', v.eq, NULL, v.eq,
         'Qty = amount ÷ the rate the PO line''s Normal lines were certified at (else own net rate)', 'info' FROM v
  UNION ALL SELECT 9, 'OTHER_PC', 'Lines on another profit centre', v.other_pc, v.other_pc_a, v.other_pc, 'Kept in the report, flagged', 'info' FROM v
  UNION ALL SELECT 10, 'NO_PO_LINE', 'Certificate lines with no PO service line', mt.unmatched, NULL, mt.unmatched,
         CASE WHEN pl.n = 0 THEN 'No ZSCSRV1 (PO service lines) loaded for this project' ELSE '' END,
         CASE WHEN pl.n = 0 THEN 'not checked' WHEN mt.unmatched > 0 THEN 'warn' ELSE 'ok' END FROM mt, pl
  UNION ALL SELECT 11, 'NO_UNIT', 'Services with no unit', nu.n, NULL, nu.n,
         'No PO service UOM, code suffix or unit word in the text',
         CASE WHEN nu.n > 0 THEN 'warn' ELSE 'ok' END FROM nu
  UNION ALL SELECT 12, 'NOT_APPROVED', 'Not approved: pending', v.na_n, v.na_a, v.na_n,
         'Not approved yet, so not in To date', 'info' FROM v
  UNION ALL SELECT 13, 'AFTER_CUT', 'Dated after the cut date: pending', v.ac_n, v.ac_a, v.ac_n,
         'Approved but certified after the cut-off, so not in To date', 'info' FROM v
  UNION ALL SELECT 14, 'NO_DATE', 'No certificate date: pending', v.nd_n, v.nd_a, v.nd_n,
         'Without a date the line cannot be put in a month', CASE WHEN v.nd_n > 0 THEN 'warn' ELSE 'ok' END FROM v
  UNION ALL SELECT 15, 'CONTRACT_TYPE', 'Contract type is not A1 or A2', v.ct_n, v.ct_a, v.ct_n,
         'A2 means the price includes VAT; any other type is read as A1 (price excludes VAT)',
         CASE WHEN v.ct_n > 0 THEN 'warn' ELSE 'ok' END FROM v
  UNION ALL SELECT 16, 'NO_TOW', 'Lines with no type of works', v.tw_n, v.tw_a, v.tw_n,
         CASE WHEN pl.n = 0 THEN 'Type of works comes from ZSCSRV1, which is not loaded' ELSE 'PO has no type of works in ZSCSRV1' END,
         CASE WHEN pl.n = 0 THEN 'not checked' WHEN v.tw_n > 0 THEN 'warn' ELSE 'ok' END FROM v, pl
  UNION ALL SELECT 17, 'NEG_TODATE', 'Service rows with a negative To date', ng.n, ng.amt, ng.n,
         'Reversals or credits larger than the work certified for that Service + Description',
         CASE WHEN ng.n > 0 THEN 'warn' ELSE 'ok' END FROM ng
  UNION ALL SELECT 18, 'VAT_RATES', 'VAT rates used', vr.n, NULL, vr.n, vr.txt, 'info' FROM vr
  UNION ALL SELECT 19, 'VAT_UNKNOWN', 'A2 lines with an unknown VAT rate', v.vat_n, v.vat_a, v.vat_n,
         'Tax code missing from the VAT table, so gross price is read as net (rate 0)',
         CASE WHEN v.vat_n > 0 THEN 'warn' ELSE 'ok' END FROM v
  UNION ALL SELECT 20, 'LINE_CONFLICT', 'Same line number with different amounts', cf.n, cf.amt, cf.n,
         'One certificate line number printed more than once with different amounts',
         CASE WHEN cf.n > 0 THEN 'warn' ELSE 'ok' END FROM cf
  UNION ALL SELECT 21, 'ZERO_LINES', 'Zero lines left out', v.zero_n, 0, v.zero_n,
         'No amount and no qty: SAP lists every PO line on each certificate', 'info' FROM v
  UNION ALL SELECT 22, 'CERT_TIES', 'Certified = To date + Pending', NULL, allv.total - (v.to_date + v.pending),
         allv.total - (v.to_date + v.pending),
         CASE WHEN ABS(allv.total - (v.to_date + v.pending)) < 0.01 THEN 'Every certified line is either in To date or Pending'
              ELSE 'Certified total does not equal To date + Pending' END,
         CASE WHEN ABS(allv.total - (v.to_date + v.pending)) < 0.01 THEN 'ok' ELSE 'mismatch' END FROM v, allv
),
chk AS (
  SELECT sort, check_code, check_name, cnt, amt, value, detail, status,
         CASE WHEN status IN ('mismatch','warn') THEN 1 ELSE 0 END AS needs_attention
  FROM c
)`;

/**
 * The work-package split of actual cost (CTE `act`: work_package, actual_amount),
 * shared by PKG_SUMMARY and FLOW_STATUS so the coding figures on Home and the
 * package report can never disagree. Reads v_actual_cost, which already swaps each
 * category's CJI3 lines for its loaded detail (certificates, MB51, order detail);
 * a subcontract PO with no certificates keeps its CJI3 posting as (unallocated).
 * Expects :project_key.
 */
const PKG_ACT_SQL = `act AS (
  -- v_actual_cost already substitutes the detail sources (rev. 4): subcontract cost is the
  -- certificate lines (CERT, coded by service_work_package) for every PO that has
  -- certificates, a PO with none keeps its CJI3 posting (work_package NULL -> unallocated,
  -- never dropped), material is MB51 where loaded, settled orders are their ORDER detail.
  -- One read of it, so the package split can never add a certificate and its CJI3 posting.
  SELECT COALESCE(work_package,'(unallocated)') AS work_package, SUM(amount) AS actual_amount
  FROM v_actual_cost WHERE project_key = :project_key
  GROUP BY COALESCE(work_package,'(unallocated)')
)`;

/**
 * The step status engine of the build workspace (Project_Build_Workspace_Plan.md).
 * CTEs ending in `bs_final` (one row per build_step), shared by BUILD_STATUS,
 * BUILD_CHECKS and REPORT_READINESS so the three can never disagree. Expects
 * :project_key. Every name is prefixed bs_ so it can sit beside PKG_ACT_SQL.
 *
 * A step's status, before dependencies (status0):
 *   upload steps  a newer STAGED batch -> Needs action; nothing posted ->
 *                 Optional (is_optional) or Ready to load; posted -> Behind
 *                 cut-off when its latest posting date is in a month before the
 *                 reference month (the cut-off's month, else the newest month
 *                 across the project's cost steps B04/B06/B07), else Complete.
 *   B05           settled orders with no detail -> Needs action; detail loaded
 *                 -> Complete; no settlements -> Optional.
 *   B11 / B12     Needs action while a GL resolves to Other / cost is
 *   / B18         unallocated / a certificate service has no MNL decision.
 * Waiting is applied last, and only to a step that has nothing yet (Ready to
 * load / Optional): some dependency is neither Complete nor Behind cut-off (for
 * an any_of set: none of them is).
 */
const BUILD_STATUS_SQL = `bs_cut AS (SELECT cutoff_date AS d FROM project_cutoff WHERE project_key = :project_key),
bs_proj AS (SELECT project_key, project_code, project_name FROM dim_project WHERE project_key = :project_key),
bs_pb AS (
  SELECT sr.step_code, b.import_batch_id, b.data_date, b.row_count_posted
  FROM build_step_report sr
  JOIN import_batch b ON b.report_definition_id = sr.report_definition_id AND b.status = 'POSTED'
  JOIN v_project_batch pb ON pb.import_batch_id = b.import_batch_id AND pb.project_key = :project_key
),
bs_last AS MATERIALIZED (
  SELECT step_code, MAX(data_date) AS data_date, MAX(import_batch_id) AS last_id, SUM(row_count_posted) AS posted_rows
  FROM bs_pb GROUP BY step_code
),
bs_staged AS (
  SELECT sr.step_code, COUNT(*) AS n
  FROM build_step_report sr
  JOIN import_batch b ON b.report_definition_id = sr.report_definition_id AND b.status IN ('STAGED','MAPPED')
  WHERE b.project_key = :project_key
    AND b.import_batch_id > COALESCE((SELECT l.last_id FROM bs_last l WHERE l.step_code = sr.step_code), 0)
  GROUP BY sr.step_code
),
bs_fa AS MATERIALIZED (
  SELECT f.amount, COALESCE(ce.posting_nature, 'COST') AS nature,
         COALESCE(pd.full_date,
           CASE WHEN f.posting_date_key IS NOT NULL THEN
             printf('%04d-%02d-%02d', f.posting_date_key / 10000, (f.posting_date_key / 100) % 100, f.posting_date_key % 100) END,
           d.end_date) AS dt
  FROM fact_actual f
  JOIN import_batch b ON b.import_batch_id = f.import_batch_id AND b.status = 'POSTED'
  LEFT JOIN dim_cost_element ce ON ce.cost_element_key = f.cost_element_key
  LEFT JOIN dim_period d ON d.period_key = f.period_key
  LEFT JOIN dim_date pd ON pd.date_key = f.posting_date_key
  WHERE f.project_key = :project_key
),
bs_held AS (
  SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amt FROM bs_fa
  WHERE nature = 'COST' AND (SELECT d FROM bs_cut) IS NOT NULL
    AND NOT COALESCE(dt <= (SELECT d FROM bs_cut), 0)
),
bs_lines AS MATERIALIZED (
  SELECT 'B04' AS step_code, COUNT(*) AS lines, MAX(dt) AS latest FROM bs_fa
  UNION ALL SELECT 'B05', COUNT(*), MAX(period_key) FROM v_order_line WHERE project_key = :project_key
  UNION ALL SELECT 'B06', COUNT(*), MAX(posting_date) FROM v_material_issue_all WHERE project_key = :project_key
  UNION ALL SELECT 'B07', COUNT(*), MAX(eff_date) FROM v_service_line_all WHERE project_key = :project_key
  UNION ALL SELECT 'B08', COUNT(*), NULL FROM v_po_service_line WHERE project_key = :project_key
  UNION ALL SELECT 'B09', COUNT(*), NULL FROM v_po_material_line WHERE project_key = :project_key
  -- dim_wbs also holds elements CJI3 auto-creates, so count them only once a WBS tree was actually uploaded
  UNION ALL SELECT 'B02', CASE WHEN EXISTS (SELECT 1 FROM bs_last WHERE step_code = 'B02')
                              THEN (SELECT COUNT(*) FROM dim_wbs WHERE project_key = :project_key) ELSE 0 END, NULL
  UNION ALL SELECT 'B03', COUNT(*), NULL FROM v_budget WHERE project_key = :project_key
  UNION ALL SELECT 'B10', COALESCE((SELECT posted_rows FROM bs_last WHERE step_code = 'B10'), 0), NULL
),
bs_ref AS (
  SELECT COALESCE(SUBSTR((SELECT d FROM bs_cut), 1, 7),
                  (SELECT MAX(SUBSTR(latest, 1, 7)) FROM bs_lines WHERE step_code IN ('B04','B06','B07'))) AS m
),
bs_orders AS MATERIALIZED (
  SELECT COUNT(DISTINCT a.partner_object) AS orders,
         COUNT(DISTINCT CASE WHEN NOT EXISTS (
           SELECT 1 FROM v_order_line o
           WHERE o.project_key = :project_key AND o.category = 'WBS' AND o.order_no = a.partner_object)
           THEN a.partner_object END) AS missing,
         COALESCE(SUM(CASE WHEN NOT EXISTS (
           SELECT 1 FROM v_order_line o
           WHERE o.project_key = :project_key AND o.category = 'WBS' AND o.order_no = a.partner_object)
           THEN a.amount END), 0) AS missing_amt
  FROM v_actual a
  WHERE a.project_key = :project_key AND a.partner_object_type IS NOT NULL AND a.partner_object_type <> ''
),
bs_other AS MATERIALIZED (
  SELECT COUNT(DISTINCT cost_element_code) AS gls, COALESCE(SUM(amount), 0) AS amt
  FROM v_actual WHERE project_key = :project_key AND (cost_type IS NULL OR cost_type = 'OTHER')
),
bs_other_list AS (
  SELECT GROUP_CONCAT(cost_element_code, ', ') AS codes FROM (
    SELECT DISTINCT cost_element_code FROM v_actual
    WHERE project_key = :project_key AND (cost_type IS NULL OR cost_type = 'OTHER')
    ORDER BY cost_element_code LIMIT 5)
),
${PKG_ACT_SQL},
bs_code AS MATERIALIZED (
  SELECT COALESCE(SUM(CASE WHEN work_package <> '(unallocated)' THEN actual_amount END), 0) AS coded,
         COALESCE(SUM(CASE WHEN work_package =  '(unallocated)' THEN actual_amount END), 0) AS unalloc
  FROM act
),
bs_svc AS MATERIALIZED (
  SELECT COUNT(*) AS services,
         COALESCE(SUM(CASE WHEN sm.mnl IS NULL THEN 1 ELSE 0 END), 0) AS unreviewed
  FROM (SELECT DISTINCT COALESCE(service_code, '') AS c, COALESCE(service_text, '') AS t
        FROM v_service_line_all WHERE project_key = :project_key) s
  LEFT JOIN service_mnl sm ON sm.project_key = :project_key AND sm.service_code = s.c AND sm.service_text = s.t
),
bs_base AS MATERIALIZED (
  SELECT s.code AS step_code, s.name, s.group_label, s.sort_order, s.kind, s.is_optional, s.is_conditional,
         s.is_planned, s.action_label, s.action_target,
         l.data_date, ln.latest AS latest_posting, COALESCE(ln.lines, 0) AS lines,
         (l.step_code IS NOT NULL) AS has_posted,
         COALESCE(st.n, 0) AS staged,
         CASE
           WHEN s.is_planned = 1 THEN 'Not available'
           WHEN s.code = 'B01' THEN CASE WHEN EXISTS (SELECT 1 FROM bs_proj) THEN 'Complete' ELSE 'Needs action' END
           WHEN s.code = 'B05' THEN
             CASE WHEN (SELECT missing FROM bs_orders) > 0 OR COALESCE(st.n, 0) > 0 THEN 'Needs action'
                  WHEN l.step_code IS NOT NULL THEN 'Complete'
                  ELSE 'Optional' END
           WHEN s.code = 'B11' THEN
             CASE WHEN (SELECT lines FROM bs_lines WHERE step_code = 'B04') = 0 THEN 'Ready to load'
                  WHEN (SELECT gls FROM bs_other) > 0 THEN 'Needs action'
                  ELSE 'Complete' END
           WHEN s.code = 'B12' THEN
             CASE WHEN (SELECT SUM(lines) FROM bs_lines WHERE step_code IN ('B04','B06','B07')) = 0 THEN 'Ready to load'
                  WHEN (SELECT unalloc FROM bs_code) > 0.005 THEN 'Needs action'
                  ELSE 'Complete' END
           WHEN s.code = 'B18' THEN
             CASE WHEN (SELECT services FROM bs_svc) = 0 THEN 'Ready to load'
                  WHEN (SELECT unreviewed FROM bs_svc) > 0 THEN 'Needs action'
                  ELSE 'Complete' END
           WHEN s.kind = 'upload' THEN
             CASE WHEN COALESCE(st.n, 0) > 0 THEN 'Needs action'
                  WHEN l.step_code IS NULL THEN CASE WHEN s.is_optional = 1 THEN 'Optional' ELSE 'Ready to load' END
                  WHEN ln.latest IS NOT NULL AND s.code IN ('B04','B06','B07')
                       AND SUBSTR(ln.latest, 1, 7) < (SELECT m FROM bs_ref) THEN 'Behind cut-off'
                  ELSE 'Complete' END
           ELSE 'Ready to load'
         END AS status0
  FROM build_step s
  LEFT JOIN bs_last l ON l.step_code = s.code
  LEFT JOIN bs_lines ln ON ln.step_code = s.code
  LEFT JOIN bs_staged st ON st.step_code = s.code
),
bs_dep AS MATERIALIZED (
  SELECT s.step_code,
    (SELECT GROUP_CONCAT(d.depends_on_code, ', ') FROM build_step_dependency d
       JOIN bs_base x ON x.step_code = d.depends_on_code
      WHERE d.step_code = s.step_code AND d.any_of = 0 AND x.status0 NOT IN ('Complete','Behind cut-off')) AS unmet_all,
    (SELECT COUNT(*) FROM build_step_dependency d WHERE d.step_code = s.step_code AND d.any_of = 1) AS any_n,
    (SELECT COUNT(*) FROM build_step_dependency d
       JOIN bs_base x ON x.step_code = d.depends_on_code
      WHERE d.step_code = s.step_code AND d.any_of = 1 AND x.status0 IN ('Complete','Behind cut-off')) AS any_met,
    (SELECT GROUP_CONCAT(d.depends_on_code, ' / ') FROM build_step_dependency d
      WHERE d.step_code = s.step_code AND d.any_of = 1) AS any_list,
    (SELECT GROUP_CONCAT(d.depends_on_code, ', ') FROM build_step_dependency d
      WHERE d.step_code = s.step_code) AS depends_on
  FROM bs_base s
),
bs_final AS MATERIALIZED (
  SELECT b.step_code, b.name, b.group_label, b.sort_order, b.kind, b.is_optional, b.is_conditional, b.is_planned,
         b.action_label, b.action_target, b.data_date, b.latest_posting, b.lines, b.staged,
         d.depends_on,
         (SELECT GROUP_CONCAT(DISTINCT ri.report_page) FROM report_input ri WHERE ri.step_code = b.step_code) AS feeds,
         x.status,
         CASE WHEN b.kind = 'upload' THEN b.has_posted
              WHEN b.kind = 'coding' THEN (x.status NOT IN ('Waiting','Ready to load'))
              ELSE 1 END AS has_data,
         CASE
           WHEN b.step_code = 'B01' THEN
             COALESCE((SELECT project_code || ' · ' || project_name FROM bs_proj), 'No project selected')
               || CASE WHEN (SELECT d FROM bs_cut) IS NOT NULL THEN ' · cut-off ' || (SELECT d FROM bs_cut)
                       ELSE ' · no cut-off set' END
           WHEN b.is_planned = 1 THEN 'SAP report in development - not available yet'
           WHEN x.status = 'Waiting' THEN 'Waiting for ' || COALESCE(d.unmet_all, d.any_list)
           WHEN b.step_code = 'B05' AND (SELECT missing FROM bs_orders) > 0 THEN
             (SELECT missing FROM bs_orders) || ' of ' || (SELECT orders FROM bs_orders)
               || ' settled orders have no detail loaded'
           WHEN b.step_code = 'B05' AND b.has_posted = 0 THEN 'No order settlements in the project - not needed'
           WHEN b.step_code = 'B11' THEN
             CASE WHEN x.status = 'Needs action' THEN (SELECT gls FROM bs_other) || ' GL accounts resolve to Other'
                  ELSE 'Every GL account has a cost type' END
           WHEN b.step_code = 'B12' THEN
             CASE WHEN x.status = 'Needs action' THEN
                    ROUND(100.0 * (SELECT coded FROM bs_code) / NULLIF((SELECT coded + unalloc FROM bs_code), 0), 1)
                      || '% coded · ' || printf('%,d', CAST(ROUND((SELECT unalloc FROM bs_code), 0) AS INTEGER)) || ' unallocated'
                  ELSE 'All loaded cost is coded to a work package' END
           WHEN b.step_code = 'B18' THEN
             CASE WHEN x.status = 'Needs action'
                    THEN (SELECT unreviewed FROM bs_svc) || ' of ' || (SELECT services FROM bs_svc) || ' services not reviewed'
                  ELSE 'Every service has an MNL decision' END
           WHEN b.staged > 0 THEN 'A file is staged and not posted'
           WHEN b.has_posted = 1 THEN
             b.lines || ' lines · data date ' || b.data_date
               || CASE WHEN x.status = 'Behind cut-off'
                       THEN ' · latest ' || b.latest_posting || ' is before ' || (SELECT m FROM bs_ref)
                       WHEN b.latest_posting IS NOT NULL THEN ' · latest ' || b.latest_posting ELSE '' END
           WHEN b.is_optional = 1 THEN 'Optional - not loaded'
           ELSE 'Not loaded'
         END AS summary
  FROM bs_base b
  JOIN bs_dep d ON d.step_code = b.step_code
  JOIN (SELECT bb.step_code,
          CASE WHEN bb.status0 IN ('Ready to load','Optional')
                    AND (dd.unmet_all IS NOT NULL OR (dd.any_n > 0 AND dd.any_met = 0))
               THEN 'Waiting' ELSE bb.status0 END AS status
        FROM bs_base bb JOIN bs_dep dd ON dd.step_code = bb.step_code) x ON x.step_code = b.step_code
)`;

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
FROM v_actual_cost a
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
FROM v_actual_cost a
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
  a.cost_element_code, a.cost_element_name, a.material_code, a.material_name,
  a.cost_type, a.vendor_name,
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
  SELECT period_key FROM v_actual_cost WHERE project_key = :project_key AND period_key IS NOT NULL
  UNION
  SELECT period_key FROM v_forecast WHERE project_key = :project_key AND period_key IS NOT NULL
),
b AS (SELECT period_key, SUM(budget_amount) AS amt FROM v_budget
      WHERE project_key = :project_key AND is_current = 1 AND period_key IS NOT NULL
      GROUP BY period_key),
bac AS (SELECT COALESCE(SUM(budget_amount),0) AS total FROM v_budget
        WHERE project_key = :project_key AND is_current = 1),
phased AS (SELECT COALESCE(SUM(amt),0) AS total FROM b),
a AS (SELECT period_key, SUM(amount)          AS amt FROM v_actual_cost WHERE project_key = :project_key GROUP BY period_key),
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
    viz: { kind: 'bar', label: 'wbs_name', value: 'overrun_amount', fill: 'var(--div-neg)' },
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
      + 'Actual cost is v_actual_cost: subcontract cost is the certificate lines (coded by service), '
      + 'not the CJI3 posting of a PO that has certificates, so nothing is counted twice; a PO with '
      + 'no certificates loaded yet falls into (unallocated) rather than being silently dropped.',
    params: [P_PROJECT],
    viz: { kind: 'bar', label: 'work_package', value: 'variance_amount', diverging: true,
      headline: 'COST_REPORT_SUMMARY' },
    sql: `
WITH bud AS (
  SELECT COALESCE(work_package,'(unallocated)') AS work_package, SUM(budget_amount) AS budget_amount
  FROM v_budget WHERE project_key = :project_key AND is_current = 1
  GROUP BY COALESCE(work_package,'(unallocated)')
),
${PKG_ACT_SQL},
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
         MAX(vendor_name) AS vendor_name, COUNT(DISTINCT certificate_id) AS certificates
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
  COUNT(DISTINCT certificate_id) AS certificates,
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
    code: 'MATERIAL_BY_MATERIAL',
    name: 'Material spend by material',
    module: 'ACTUAL',
    category: 'Material',
    description: 'Material cost rolled up per real material (SAP material number) — the actual '
      + 'material identity, not the GL account several different materials commonly share. A '
      + 'posting with no material number (an older extract, or the column left blank) rolls up '
      + 'under "(no material code)".',
    params: [P_PROJECT],
    viz: { kind: 'bar', label: 'material_name', value: 'amount' },
    sql: `
SELECT COALESCE(material_code,'(no material code)') AS material_code,
       COALESCE(material_name, material_code, '(no material code)') AS material_name,
       COUNT(*) AS postings, SUM(amount) AS amount
FROM v_actual
WHERE project_key = :project_key AND cost_type = 'MATERIAL'
GROUP BY COALESCE(material_code,'(no material code)'), COALESCE(material_name, material_code, '(no material code)')
ORDER BY amount DESC`,
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
  SELECT wbs_code, wbs_name, cost_element_code, cost_element_name, material_code, material_name,
         document_no, document_type,
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
SELECT wbs_code, wbs_name, cost_element_code, cost_element_name, material_code, material_name,
       document_no, document_type,
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
SELECT wbs_code, wbs_name, cost_element_code, cost_element_name, material_code, material_name,
       document_no, document_type,
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
SELECT wbs_code, wbs_name, cost_element_code, cost_element_name, material_code, material_name,
       document_no, document_type,
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
           FROM v_actual_cost WHERE project_key = :project_key),
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
    code: 'CUTOFF_STATUS',
    name: 'Cut-off status',
    module: 'ACTUAL',
    category: 'Headline',
    description: 'The project\'s cut-off date, the newest and oldest posting dates loaded (the cut-off dropdown spans them), and the posted cost '
      + 'lines the cut-off is holding back (a line counts when its posting date, or its period end '
      + 'when it has none, is on or before the cut-off). Reads v_posting_all, the only query family '
      + 'allowed to look past the cut-off.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
WITH cut AS (SELECT cutoff_date FROM project_cutoff WHERE project_key = :project_key),
lines AS (
  SELECT a.posting_date, a.period_end_date, a.amount,
         -- the exact negation of v_posting's filter, NULL dates included
         CASE WHEN c.cutoff_date IS NOT NULL
               AND NOT COALESCE(COALESCE(a.posting_date, a.period_end_date) <= c.cutoff_date, 0)
              THEN 1 ELSE 0 END AS held_back
  FROM v_posting_all a
  LEFT JOIN cut c ON 1 = 1
  WHERE a.project_key = :project_key AND a.posting_nature = 'COST'
)
SELECT
  (SELECT cutoff_date FROM cut)                                AS cutoff_date,
  (SELECT MAX(posting_date) FROM lines)                        AS latest_posting_date,
  (SELECT MIN(COALESCE(posting_date, period_end_date)) FROM lines) AS earliest_posting_date,
  (SELECT COALESCE(SUM(held_back),0) FROM lines)               AS lines_after_cutoff,
  (SELECT COALESCE(SUM(CASE WHEN held_back = 1 THEN amount ELSE 0 END),0) FROM lines)
                                                               AS amount_after_cutoff`,
  },
  {
    code: 'FLOW_STATUS',
    name: 'Input / coding / reports status',
    module: 'CROSS',
    category: 'Headline',
    description: 'One row for the Home step cards: data freshness, actual cost to the cut-off and in '
      + 'the cut-off month, how much of that cost is coded to a work package (PKG_SUMMARY\'s rules, '
      + 'subcontract cost from the PO detail report), and the current budget.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
WITH cut AS (SELECT cutoff_date FROM project_cutoff WHERE project_key = :project_key),
fresh AS (
  SELECT COALESCE(SUM(CASE WHEN freshness_status = 'STALE' THEN 1 ELSE 0 END),0) AS stale,
         COUNT(*) AS total
  FROM v_data_freshness
),
month_key AS (
  SELECT COALESCE(SUBSTR((SELECT cutoff_date FROM cut), 1, 7),
                  (SELECT MAX(period_key) FROM v_actual_cost WHERE project_key = :project_key)) AS pk
),
${PKG_ACT_SQL},
coding AS (
  SELECT COALESCE(SUM(CASE WHEN work_package <> '(unallocated)' THEN actual_amount END),0) AS coded,
         COALESCE(SUM(CASE WHEN work_package =  '(unallocated)' THEN actual_amount END),0) AS unallocated
  FROM act
)
SELECT
  (SELECT cutoff_date FROM cut)                                           AS cutoff_date,
  (SELECT MAX(b.data_date) FROM import_batch b
    WHERE b.status = 'POSTED' AND b.module = 'ACTUAL'
      AND EXISTS (SELECT 1 FROM fact_actual f
                  WHERE f.import_batch_id = b.import_batch_id AND f.project_key = :project_key))
                                                                          AS latest_data_date,
  (SELECT stale FROM fresh)                                               AS stale_sources,
  (SELECT total FROM fresh)                                               AS total_sources,
  (SELECT COALESCE(SUM(amount),0) FROM v_actual_cost WHERE project_key = :project_key)
                                                                          AS actual_to_cutoff,
  (SELECT COALESCE(SUM(amount),0) FROM v_actual_cost
    WHERE project_key = :project_key AND period_key = (SELECT pk FROM month_key))
                                                                          AS actual_cutoff_month,
  (SELECT coded FROM coding)                                              AS coded_amount,
  (SELECT unallocated FROM coding)                                        AS unallocated_amount,
  ROUND(100.0 * (SELECT coded FROM coding)
        / NULLIF((SELECT coded FROM coding) + (SELECT unallocated FROM coding), 0), 1) AS coded_pct,
  (SELECT SUM(budget_amount) FROM v_budget WHERE project_key = :project_key AND is_current = 1)
                                                                          AS budget`,
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
    description: 'Every WBS element sized by actual cost and shaded by budget variance — orange is '
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
FROM v_actual_cost
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
    a.cost_element_code, a.cost_element_name, a.material_code, a.material_name, a.cost_type,
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
    s.cost_element_code, s.cost_element_name, NULL AS material_code, NULL AS material_name, s.cost_type,
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
    s.cost_element_code, s.cost_element_name, NULL AS material_code, NULL AS material_name, s.cost_type,
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
    code: 'REG_KPI',
    name: 'Actual cost register: headline',
    module: 'CROSS',
    category: 'Register',
    description: 'The register\'s KPI strip, off v_actual_cost: actual to the cut-off, the report month (month of the '
      + 'cut-off, else the latest month) and its amount, the share that comes from detail sources (MB51 / '
      + 'certificates / orders) rather than CJI3, and the amount with no work package.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
WITH a AS (SELECT * FROM v_actual_cost WHERE project_key = :project_key),
m AS (SELECT COALESCE((SELECT SUBSTR(cutoff_date, 1, 7) FROM project_cutoff WHERE project_key = :project_key),
                      (SELECT MAX(period_key) FROM a)) AS rm)
SELECT COALESCE(SUM(amount), 0)                                                    AS actual_to_cutoff,
       (SELECT rm FROM m)                                                          AS report_month,
       COALESCE(SUM(CASE WHEN period_key = (SELECT rm FROM m) THEN amount END), 0) AS report_month_amount,
       ROUND(100.0 * SUM(CASE WHEN source <> 'CJI3' THEN amount END) / NULLIF(SUM(amount), 0), 1) AS from_detail_pct,
       COALESCE(SUM(CASE WHEN work_package IS NULL THEN amount END), 0)            AS unallocated,
       COUNT(*)                                                                    AS lines
FROM a`,
  },
  {
    code: 'REG_MONTHLY',
    name: 'Actual cost register: per month',
    module: 'CROSS',
    category: 'Register',
    description: 'Long format for the register\'s month table: one row per category, row (item / package / WBS, '
      + 'see :rows_by) and month, with the sources the row comes from, its unit and quantity (meaningful per item; '
      + 'units differ between rows, so a quantity is never summed across them). Rows are ordered by category, then by '
      + 'their total, largest first. Filter by :source.',
    params: [P_PROJECT, ...P_REG],
    viz: { kind: 'table' },
    sql: `
WITH ${REG_BASE_SQL}
-- unit and sources are properties of the row (all its months), so they are taken once per row, not per month
, u AS (SELECT category, item_key,
             GROUP_CONCAT(DISTINCT CASE WHEN COALESCE(unit, '') <> '' THEN unit END) AS unit,
             GROUP_CONCAT(DISTINCT source) AS src
      FROM reg GROUP BY category, item_key)
SELECT r.category, r.category_order, r.category_color, r.cost_type, r.item_key, r.item,
       u.src,
       u.unit,
       COALESCE(r.period_key, '(no period)') AS period_key,
       COALESCE(CAST(REPLACE(r.period_key, '-', '') AS INTEGER), 999999) AS period_order,
       SUM(r.amount) AS amount,
       SUM(r.quantity) AS qty,
       SUM(SUM(r.amount)) OVER (PARTITION BY r.category, r.item_key) AS item_total
FROM reg r
LEFT JOIN u ON u.category = r.category AND u.item_key = r.item_key
GROUP BY r.category, r.category_order, r.category_color, r.cost_type, r.item_key, r.item, u.unit, u.src, r.period_key
ORDER BY r.category_order, r.category, ABS(item_total) DESC, r.item_key, period_order`,
  },
  {
    code: 'REG_LINES',
    name: 'Actual cost register: lines',
    module: 'CROSS',
    category: 'Register',
    description: 'The lines behind the register: every v_actual_cost line of the project, or of one row when '
      + ':cost_type and :item_key are given (the row key of REG_MONTHLY for the same :rows_by; a "~" prefix is '
      + 'stripped). At most 20,000 lines, newest first.',
    params: [P_PROJECT, ...P_REG,
      { name: 'cost_type', type: 'text', label: 'Cost type' }, { name: 'item_key', type: 'text', label: 'Row key' }],
    viz: { kind: 'table' },
    sql: `
WITH ${REG_BASE_SQL}
SELECT posting_date, period_key, source, category, item, wbs_code, work_package, vendor_name, quantity, unit, amount
FROM reg
WHERE (:cost_type IS NULL OR COALESCE(cost_type, '') = ${scParam('cost_type')})
  AND (:item_key IS NULL OR item_key = ${scParam('item_key')})
ORDER BY COALESCE(posting_date, period_key) DESC
LIMIT 20000`,
  },
  {
    code: 'COST_SOURCE_RECON',
    name: 'Cost source reconciliation',
    module: 'CROSS',
    category: 'Reconciliation',
    description: 'Per detail source and cost type: the CJI3 amount set aside (replaced by the detail) '
      + 'against the detail amount now in the headline actual (v_actual_cost). difference = detail - CJI3; '
      + 'a non-zero difference is timing or not yet in the detail, never an addition. Row level TOTAL is the '
      + 'source as a whole (the per-type rows can differ when a certificate service is coded LAB/EQU or an '
      + 'order settles into several types). detail_loaded = 0 means the source is not loaded for this project, '
      + 'so CJI3 stays the actual (cji3_kept).',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
WITH aside AS (
  SELECT aside_source AS source, COALESCE(cost_type,'UNMAPPED') AS cost_type,
         SUM(amount) AS amt, COUNT(*) AS n
  FROM v_actual_set_aside WHERE project_key = :project_key
  GROUP BY aside_source, COALESCE(cost_type,'UNMAPPED')
),
det AS (
  SELECT source, COALESCE(cost_type,'UNMAPPED') AS cost_type, SUM(amount) AS amt, COUNT(*) AS n
  FROM v_actual_cost WHERE project_key = :project_key AND source <> 'CJI3'
  GROUP BY source, COALESCE(cost_type,'UNMAPPED')
),
loaded AS (
  SELECT 'CERT' AS source, EXISTS (SELECT 1 FROM v_cost_cert_po WHERE project_key = :project_key) AS yes
  UNION ALL SELECT 'MB51', EXISTS (SELECT 1 FROM v_mb51_project WHERE project_key = :project_key)
  UNION ALL SELECT 'ORDER', EXISTS (SELECT 1 FROM v_cost_order_detail WHERE project_key = :project_key)
),
src_type AS (
  SELECT source, cost_type FROM aside
  UNION SELECT source, cost_type FROM det
  UNION SELECT r.source, r.cost_type FROM cost_source_rule r
        WHERE r.is_active = 1 AND r.cost_type <> '*' AND r.source IN (SELECT source FROM loaded)
),
typed AS (
  SELECT st.source, st.cost_type, 'TYPE' AS level,
         COALESCE(a.amt, 0) AS cji3_set_aside, COALESCE(d.amt, 0) AS detail_amount,
         COALESCE(a.n, 0) AS cji3_lines, COALESCE(d.n, 0) AS detail_lines
  FROM src_type st
  LEFT JOIN aside a ON a.source = st.source AND a.cost_type = st.cost_type
  LEFT JOIN det d   ON d.source = st.source AND d.cost_type = st.cost_type
),
totals AS (
  SELECT source, 'TOTAL' AS cost_type, 'TOTAL' AS level,
         SUM(cji3_set_aside) AS cji3_set_aside, SUM(detail_amount) AS detail_amount,
         SUM(cji3_lines) AS cji3_lines, SUM(detail_lines) AS detail_lines
  FROM typed GROUP BY source
),
u AS (SELECT * FROM typed UNION ALL SELECT * FROM totals)
SELECT
  u.source, u.cost_type, u.level,
  l.yes AS detail_loaded,
  u.cji3_set_aside, u.detail_amount,
  u.detail_amount - u.cji3_set_aside AS difference,
  u.cji3_lines, u.detail_lines,
  CASE u.source
    WHEN 'CERT' THEN (SELECT COALESCE(SUM(amount),0) FROM v_actual_cost
                       WHERE project_key = :project_key AND source = 'CJI3' AND cost_type = 'SUBCONTRACT')
    WHEN 'MB51' THEN (SELECT COALESCE(SUM(amount),0) FROM v_actual_cost
                       WHERE project_key = :project_key AND source = 'CJI3' AND cost_type = 'MATERIAL')
    ELSE NULL END AS cji3_kept,
  CASE WHEN ABS(u.detail_amount - u.cji3_set_aside) < 0.01 THEN 'ok' ELSE 'differs' END AS status
FROM u JOIN loaded l ON l.source = u.source
ORDER BY u.source, CASE u.level WHEN 'TOTAL' THEN 1 ELSE 0 END, u.cost_type`,
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
  // ---------------------------------------------------------------------------
  // The monthly subcontract cost report (ZSCPROG01 certificates + ZSCSRV1 PO
  // service lines). Every rule — line class, report qty, trade, bucket — is a
  // column of v_service_line; these queries only aggregate it.
  // ---------------------------------------------------------------------------
  {
    code: 'SC_REPORT_KPI',
    name: 'Subcontract report headline',
    module: 'SERVICE',
    category: 'Headline',
    description: 'The monthly service report\'s headline. The report month is the month of the project '
      + 'cut-off (else the latest month with counted data). Previous = Opening + the months before it; '
      + 'To date = Previous + This month; Pending (not approved, dated after the cut-off, or undated) '
      + 'is never in To date. Also: subcontractors active this month and to date, certificates '
      + '(PO + invoice serial), POs, lines on another profit centre, and the amount SAP repeated on WBS splits.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
WITH s AS (SELECT * FROM v_service_line WHERE project_key = :project_key),
${SC_RM_SQL},
subs AS (SELECT vendor_key FROM s GROUP BY vendor_key HAVING ABS(SUM(amount_net)) > 1e-9),
subs_td AS (SELECT vendor_key FROM s WHERE report_bucket <> 'PENDING' GROUP BY vendor_key HAVING ABS(SUM(a)) > 1e-9),
subs_m AS (SELECT vendor_key FROM s WHERE report_bucket = 'THIS_MONTH' GROUP BY vendor_key HAVING ABS(SUM(a)) > 1e-9),
k AS (
  SELECT
    (SELECT m FROM rm)                                                                AS report_month,
    COALESCE(SUM(CASE WHEN report_bucket IN ('OPENING','PREVIOUS') THEN a END), 0)    AS previous_amount,
    COALESCE(SUM(CASE WHEN report_bucket = 'THIS_MONTH' THEN a END), 0)               AS this_month_amount,
    COALESCE(SUM(CASE WHEN report_bucket <> 'PENDING' AND bucket = (SELECT last_m FROM rm) THEN a END), 0) AS last_month_amount,
    COALESCE(SUM(CASE WHEN report_bucket <> 'PENDING' THEN a END), 0)                 AS to_date_amount,
    COALESCE(SUM(CASE WHEN report_bucket = 'PENDING' THEN a END), 0)                  AS pending_amount,
    COALESCE(SUM(CASE WHEN pend_reason = 'Not approved' THEN a END), 0)               AS pending_not_approved_amount,
    COALESCE(SUM(CASE WHEN pend_reason = 'After cut date' THEN a END), 0)             AS pending_after_cut_amount,
    COALESCE(SUM(CASE WHEN pend_reason = 'No date' THEN a END), 0)                    AS pending_no_date_amount,
    (SELECT COUNT(*) FROM subs_m)                                                     AS active_subs_month,
    COUNT(DISTINCT CASE WHEN report_bucket = 'THIS_MONTH' THEN certificate_id END)    AS certificates_month,
    (SELECT COUNT(*) FROM subs_td)                                                    AS subs_to_date,
    COALESCE(SUM(amount_net), 0)                                                      AS certified_amount,
    COALESCE(SUM(CASE WHEN bucket NOT IN ('OPENING','PENDING') THEN amount_net END), 0) AS approved_amount,
    COALESCE(SUM(CASE WHEN bucket = 'OPENING' THEN amount_net END), 0)                AS opening_amount,
    COALESCE(SUM(CASE WHEN line_class = 'Adjustment' THEN amount_net END), 0)         AS adjustments_amount,
    COALESCE(SUM(amount_vat), 0)                                                      AS vat,
    (SELECT COUNT(*) FROM subs)                                                       AS subcontractors,
    COUNT(DISTINCT po_no)                                                             AS purchase_orders,
    COUNT(DISTINCT CASE WHEN bucket <> 'PENDING' THEN certificate_id END)             AS certificates,
    COALESCE(SUM(CASE WHEN is_other_pc = 1 THEN amount_net END), 0)                   AS other_profit_centre_amount,
    COALESCE(SUM(amount_net * (split_count - 1)), 0)                                  AS repeated_on_wbs_splits_amount
  FROM s
)
SELECT report_month, previous_amount, this_month_amount, last_month_amount,
       CASE WHEN ABS(last_month_amount) > 1e-9
            THEN ROUND(100.0 * (this_month_amount - last_month_amount) / ABS(last_month_amount), 1) END AS mom_pct,
       to_date_amount, pending_amount, pending_not_approved_amount, pending_after_cut_amount,
       pending_no_date_amount, active_subs_month, certificates_month, subs_to_date,
       certified_amount, approved_amount, opening_amount, adjustments_amount, vat, subcontractors,
       purchase_orders, certificates, other_profit_centre_amount, repeated_on_wbs_splits_amount
FROM k`,
  },
  {
    code: 'SC_MONTH_BY_TRADE',
    name: 'Approved subcontract value per month by trade',
    module: 'SERVICE',
    category: 'Trend',
    description: 'Approved certified value per month, one series per trade — the seven largest trades '
      + 'by total value, the rest folded into "Other trades". Opening and pending lines are excluded.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
WITH ${SC_TRADE_RANK_SQL}
SELECT s.bucket AS period_key,
       CASE WHEN r.rn <= 7 THEN s.trade_label ELSE 'Other trades' END AS trade,
       MIN(r.rn, 8) AS series_order,
       SUM(s.amount_net) AS amount
FROM v_service_line s JOIN trade_rank r ON r.trade = s.trade
WHERE s.project_key = :project_key AND s.bucket NOT IN ('OPENING','PENDING')
GROUP BY s.bucket, 2, 3
ORDER BY s.bucket, series_order`,
  },
  {
    code: 'SC_TRADE_SUMMARY',
    name: 'Subcontract value by trade',
    module: 'SERVICE',
    category: 'Breakdown',
    description: 'Per trade: opening balance, approved months, pending approval, total, share, and how '
      + 'many subcontractors have a non-zero total in it (a subcontractor can work in several trades).',
    params: [P_PROJECT],
    viz: { kind: 'bar', label: 'trade', value: 'total_amount' },
    sql: `
WITH t AS (
  SELECT trade, trade_label,
         COALESCE(SUM(CASE WHEN bucket = 'OPENING' THEN amount_net END), 0) AS opening_amount,
         COALESCE(SUM(CASE WHEN bucket NOT IN ('OPENING','PENDING') THEN amount_net END), 0) AS approved_amount,
         COALESCE(SUM(CASE WHEN bucket = 'PENDING' THEN amount_net END), 0) AS pending_amount,
         SUM(amount_net) AS total_amount
  FROM v_service_line WHERE project_key = :project_key GROUP BY trade, trade_label
),
subs AS (
  SELECT trade, COUNT(*) AS n FROM (
    SELECT trade, vendor_key FROM v_service_line WHERE project_key = :project_key
    GROUP BY trade, vendor_key HAVING ABS(SUM(amount_net)) > 1e-9)
  GROUP BY trade
)
SELECT t.trade_label AS trade, t.opening_amount, t.approved_amount, t.pending_amount, t.total_amount,
       ROUND(100.0 * t.total_amount / NULLIF(SUM(t.total_amount) OVER (), 0), 1) AS pct_of_total,
       COALESCE(subs.n, 0) AS subcontractors
FROM t LEFT JOIN subs ON subs.trade = t.trade
ORDER BY t.total_amount DESC`,
  },
  {
    code: 'SC_ACTIVE_SUBS_BY_MONTH',
    name: 'Active subcontractors per month',
    module: 'SERVICE',
    category: 'Trend',
    description: 'How many subcontractors have a non-zero approved amount in each month.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
SELECT period_key, COUNT(*) AS active_subcontractors FROM (
  SELECT bucket AS period_key, vendor_key FROM v_service_line
  WHERE project_key = :project_key AND bucket NOT IN ('OPENING','PENDING')
  GROUP BY bucket, vendor_key HAVING ABS(SUM(amount_net)) > 1e-9)
GROUP BY period_key ORDER BY period_key`,
  },
  {
    code: 'SC_TOP_SERVICES',
    name: 'Top subcontract services',
    module: 'SERVICE',
    category: 'Breakdown',
    description: 'The 15 services (code + text) with the largest certified value. Qty and average rate '
      + 'are report qty over every line (an adjustment counts at amount ÷ the rate its PO line was '
      + 'certified at) and the average rate is amount ÷ qty.',
    params: [P_PROJECT],
    viz: { kind: 'bar', label: 'service_text', value: 'amount' },
    sql: `
WITH s AS (
  SELECT service_code, service_text, trade_label,
         SUM(amount_net) AS amount,
         SUM(report_qty) AS qty,
         SUM(amount_net) AS normal_amount
  FROM v_service_line WHERE project_key = :project_key
  GROUP BY service_code, service_text, trade_label
),
u AS (SELECT service_code, MAX(uom) AS uom FROM v_po_service_line
      WHERE project_key = :project_key AND uom IS NOT NULL AND uom <> '' GROUP BY service_code)
SELECT s.service_code, s.service_text,
       ${SC_UNIT_SQL('s.service_code', 's.service_text', 'u.uom')} AS unit,
       s.trade_label AS trade, s.qty,
       CASE WHEN s.qty <> 0 THEN s.normal_amount / s.qty END AS avg_rate,
       s.amount,
       ROUND(100.0 * s.amount / NULLIF((SELECT SUM(amount_net) FROM v_service_line
                                        WHERE project_key = :project_key), 0), 1) AS pct_of_total
FROM s LEFT JOIN u ON u.service_code = s.service_code
ORDER BY s.amount DESC
LIMIT 15`,
  },
  {
    code: 'SC_QTY_RECONCILIATION',
    name: 'PO service line quantity reconciliation',
    module: 'SERVICE',
    category: 'Reconciliation',
    description: 'Per ZSCSRV1 PO service line: contract qty and value, qty received and accepted, and the '
      + 'qty certified against it (certificate lines matched to that PO line, qty-only lines shown '
      + 'separately). The difference is received − certified; when it equals the qty-only lines it is '
      + 'explained by them.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
WITH m AS (
  SELECT m.po_service_line_id,
         SUM(CASE WHEN s.line_class <> 'Qty only' THEN COALESCE(s.quantity_current, 0) ELSE 0 END) AS certified_qty,
         SUM(CASE WHEN s.line_class = 'Qty only' THEN COALESCE(s.quantity_current, 0) ELSE 0 END) AS excluded_qty,
         SUM(s.amount_net) AS certified_amount
  FROM v_service_line_po_match m
  JOIN v_service_line s ON s.service_line_id = m.service_line_id
  WHERE s.project_key = :project_key AND m.po_service_line_id IS NOT NULL
  GROUP BY m.po_service_line_id
),
r AS (
  SELECT p.po_line_ref, p.po_no, p.po_item, p.po_line_no, p.vendor_name, p.service_code, p.service_text,
         p.uom, p.contract_qty, p.contract_price AS contract_value, p.qty_received, p.qty_accepted,
         COALESCE(m.certified_qty, 0) AS certified_qty, COALESCE(m.excluded_qty, 0) AS excluded_qty,
         ROUND(COALESCE(p.qty_received, 0) - COALESCE(m.certified_qty, 0), 3) AS difference,
         COALESCE(m.certified_amount, 0) AS certified_amount,
         CASE WHEN COALESCE(p.contract_qty, 0) <> 0
              THEN ROUND(100.0 * COALESCE(p.qty_received, 0) / p.contract_qty, 1) END AS pct_received
  FROM v_po_service_line p LEFT JOIN m ON m.po_service_line_id = p.po_service_line_id
  WHERE p.project_key = :project_key
)
SELECT po_line_ref, po_no, po_item, po_line_no, vendor_name, service_code, service_text, uom,
       contract_qty, contract_value, qty_received, qty_accepted, certified_qty, excluded_qty, difference,
       CASE WHEN ABS(difference) < 0.001 THEN ''
            WHEN ABS(difference - excluded_qty) < 0.001 THEN 'Excluded lines'
            ELSE 'Not certified' END AS explained,
       certified_amount, pct_received,
       CASE WHEN ABS(difference) >= 0.001 AND ABS(difference - excluded_qty) >= 0.001 THEN 1 ELSE 0 END AS unexplained
FROM r
ORDER BY po_no, CAST(po_item AS INTEGER), CAST(po_line_no AS INTEGER)`,
  },
  {
    code: 'SC_CHECKS',
    name: 'Subcontract report checks',
    module: 'SERVICE',
    category: 'Reconciliation',
    description: 'The latest certificate upload against its own SAP grand-total footer (less the amount '
      + 'SAP repeated on WBS splits), plus count and amount for each line type the report treats '
      + 'specially: pending (not approved / after the cut date / undated), contract type, missing type '
      + 'of works, negative To date, VAT, conflicting line numbers, zero lines, and certified = To date '
      + '+ Pending. A missing footer reads "not checked", never as a match. check_code feeds SC_CHECK_ROWS.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
WITH ${SC_CHECKS_SQL}
SELECT check_name AS "check", cnt AS "count", amt AS amount, value, detail, status, check_code, needs_attention
FROM chk ORDER BY sort`,
  },
  {
    code: 'SC_CHECK_ROWS',
    name: 'Subcontract check — the rows behind a check',
    module: 'SERVICE',
    category: 'Reconciliation',
    description: 'The first 100 certificate lines (or service rows) behind one SC_CHECKS row, largest first. '
      + 'Pass the check_code shown in SC_CHECKS.',
    params: [P_PROJECT, { name: 'check_code', type: 'text', label: 'Check code', required: true }],
    viz: { kind: 'table' },
    sql: `
WITH s AS (SELECT * FROM v_service_line WHERE project_key = :project_key)
SELECT po_no, certificate, vendor_name, service_code, service_text, amount, note FROM (
  SELECT po_no, certificate_id AS certificate, vendor_name, service_code, service_text, a AS amount, note FROM (
    SELECT s.*, CASE :check_code
        WHEN 'ADJUSTMENTS' THEN CASE WHEN line_class = 'Adjustment' THEN 'Reported at ' || COALESCE(rate_src, '') END
        WHEN 'QTY_ONLY' THEN CASE WHEN line_class = 'Qty only' THEN 'Qty ' || COALESCE(quantity_current, 0) END
        WHEN 'ADJ_PO_RATE' THEN CASE WHEN rate_src = 'PO line' THEN 'Rate ' || ROUND(rate_used, 4) END
        WHEN 'OTHER_PC' THEN CASE WHEN is_other_pc = 1 THEN 'Profit centre ' || COALESCE(profit_center, '') END
        WHEN 'NOT_APPROVED' THEN CASE WHEN pend_reason = 'Not approved' THEN 'Not approved' END
        WHEN 'AFTER_CUT' THEN CASE WHEN pend_reason = 'After cut date' THEN 'Dated ' || COALESCE(eff_date, '') END
        WHEN 'NO_DATE' THEN CASE WHEN pend_reason = 'No date' THEN 'No certificate date' END
        WHEN 'CONTRACT_TYPE' THEN CASE WHEN contract_type IS NULL OR contract_type NOT IN ('A1','A2')
                                       THEN 'Contract type ' || COALESCE(contract_type, '(blank)') END
        WHEN 'NO_TOW' THEN CASE WHEN tow = '(no type of works)' THEN 'PO has no type of works' END
        WHEN 'VAT_UNKNOWN' THEN CASE WHEN contract_type = 'A2' AND (tax_code IS NULL OR tax_code NOT IN (SELECT code FROM dim_tax_code))
                                     THEN 'Tax code ' || COALESCE(tax_code, '(blank)') END
        WHEN 'ZERO_LINES' THEN CASE WHEN line_class = 'Normal' AND a = 0 AND q = 0 THEN 'No amount, no qty' END
        WHEN 'NO_PO_LINE' THEN CASE WHEN service_line_id IN (SELECT service_line_id FROM v_service_line_po_match
                                                              WHERE project_key = :project_key AND match_level = 'Not found')
                                    THEN 'No PO service line in ZSCSRV1' END
        WHEN 'LINE_CONFLICT' THEN CASE WHEN (certificate_id, item_no, package_no, line_no) IN (
                                       SELECT certificate_id, item_no, package_no, line_no FROM s
                                       GROUP BY certificate_id, item_no, package_no, line_no
                                       HAVING COUNT(*) > 1 AND MAX(a) <> MIN(a))
                                     THEN 'Item ' || COALESCE(item_no, '') || ' line ' || COALESCE(line_no, '') END
      END AS note
    FROM s
  ) WHERE note IS NOT NULL
  UNION ALL
  SELECT NULL, NULL, NULL, service_code, service_text, td, 'To date ' || ROUND(td, 2) FROM (
    SELECT service_code, MAX(service_text) AS service_text, SUM(a) AS td FROM s
    WHERE :check_code = 'NEG_TODATE' AND report_bucket <> 'PENDING'
    GROUP BY service_code, service_text_norm HAVING SUM(a) < -0.5)
  UNION ALL
  SELECT NULL, NULL, NULL, service_code, service_text, NULL, 'No unit' FROM (
    SELECT sv.service_code, sv.service_text,
           ${SC_UNIT_SQL('sv.service_code', 'sv.service_text', 'u.uom')} AS unit
    FROM (SELECT DISTINCT service_code, service_text FROM s WHERE :check_code = 'NO_UNIT') sv
    LEFT JOIN ${SC_PO_UOM_SQL} u ON u.service_code = sv.service_code)
  WHERE unit IS NULL
)
ORDER BY ABS(COALESCE(amount, 0)) DESC
LIMIT 100`,
  },
  {
    code: 'SC_MONTH_BY_RESOURCE',
    name: 'Cost per month by resource type',
    module: 'SERVICE',
    category: 'Trend',
    description: 'Certified value net of VAT per month, stacked by resource type (the first letter of the '
      + 'service code: S Subcontract, L Labour, P Plant, anything else Other). Opening first, then each '
      + 'month up to the report month; Pending is not included. Negatives (credits) are kept. Each row '
      + 'also carries the month\'s total, the cumulative total and the active subcontractors.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
WITH ${SC_MONTH_WIDE_SQL}
SELECT period_key, sort_key, resource, series_order, amount, month_total, cumulative, subcontractors FROM (
  SELECT period_key, sort_key, 'Subcontract' AS resource, 1 AS series_order, subcontract AS amount, total AS month_total, cumulative, subcontractors FROM mw
  UNION ALL SELECT period_key, sort_key, 'Labour', 2, labour, total, cumulative, subcontractors FROM mw
  UNION ALL SELECT period_key, sort_key, 'Plant', 3, plant, total, cumulative, subcontractors FROM mw
  UNION ALL SELECT period_key, sort_key, 'Other', 4, other, total, cumulative, subcontractors FROM mw
) WHERE ABS(amount) > 1e-9
ORDER BY sort_key, series_order`,
  },
  {
    code: 'SC_MONTH_TABLE',
    name: 'Cost per month (table)',
    module: 'SERVICE',
    category: 'Trend',
    description: 'The same months as SC_MONTH_BY_RESOURCE, one row per month with a column per resource '
      + 'type, the total, the cumulative total and the number of active subcontractors.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
WITH ${SC_MONTH_WIDE_SQL}
SELECT period_key AS month, subcontract, labour, plant, other, total, cumulative, subcontractors
FROM mw ORDER BY sort_key`,
  },
  {
    code: 'SC_TOP_SERVICES_MONTH',
    name: 'Top services this month',
    module: 'SERVICE',
    category: 'Breakdown',
    description: 'The 10 Service + Description rows with the largest value in the report month: qty, '
      + 'this month\'s rate (amount ÷ report qty) and how it moved against the previous rate '
      + '(Opening + earlier months). A rate pair more than 3x apart, or either rate <= 0, reads "check".',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
WITH ${SC_RATES_SQL},
u AS ${SC_PO_UOM_SQL}
SELECT r.service_code, r.service_text AS description,
       ${SC_UNIT_SQL('r.service_code', 'r.service_text', 'u.uom')} AS unit,
       r.cur_q AS qty, r.this_rate AS rate,
       CASE r.status_mv
         WHEN 'check' THEN 'check'
         WHEN 'same' THEN 'same'
         WHEN 'new' THEN 'new'
         WHEN '' THEN ''
         ELSE printf('%+.1f%%', 100.0 * r.d_mv / r.prev_rate) END AS vs_previous,
       r.cur_a AS amount
FROM rx2 r LEFT JOIN u ON u.service_code = r.service_code
WHERE ABS(r.cur_a) >= 0.5
ORDER BY r.cur_a DESC
LIMIT 10`,
  },
  {
    code: 'SC_COST_BY_TOW',
    name: 'Cost by type of works',
    module: 'SERVICE',
    category: 'Breakdown',
    description: 'This month and To date per type of works (each line takes its PO\'s type from ZSCSRV1), '
      + 'with the share of To date. Ordered as set in dim_tow_order, else largest To date first.',
    params: [P_PROJECT],
    viz: { kind: 'bar', label: 'group_name', value: 'to_date' },
    sql: `
SELECT g.tow AS group_name, g.this_month, g.to_date,
       ROUND(100.0 * g.to_date / NULLIF(SUM(g.to_date) OVER (), 0), 1) AS share_pct
FROM (
  SELECT tow, SUM(CASE WHEN report_bucket = 'THIS_MONTH' THEN a ELSE 0 END) AS this_month, SUM(a) AS to_date
  FROM v_service_line WHERE project_key = :project_key AND report_bucket <> 'PENDING'
  GROUP BY tow HAVING ABS(SUM(a)) > 1e-9
) g LEFT JOIN dim_tow_order o ON o.project_key = :project_key AND o.tow = g.tow
ORDER BY COALESCE(o.sort_order, 1000000), g.to_date DESC`,
  },
  {
    code: 'SC_COST_BY_CODING',
    name: 'Cost by work package',
    module: 'SERVICE',
    category: 'Breakdown',
    description: 'This month and To date per work package (service_work_package coding of the Service + '
      + 'Description), with the share of To date. Rows not coded yet are one "(not coded)" line, so '
      + 'the totals still tie.',
    params: [P_PROJECT],
    viz: { kind: 'bar', label: 'group_name', value: 'to_date' },
    sql: `
SELECT COALESCE(work_package, '(not coded)') AS group_name,
       SUM(CASE WHEN report_bucket = 'THIS_MONTH' THEN a ELSE 0 END) AS this_month,
       SUM(a) AS to_date,
       ROUND(100.0 * SUM(a) / NULLIF(SUM(SUM(a)) OVER (), 0), 1) AS share_pct
FROM v_service_line WHERE project_key = :project_key AND report_bucket <> 'PENDING'
GROUP BY COALESCE(work_package, '(not coded)') HAVING ABS(SUM(a)) > 1e-9
ORDER BY (COALESCE(work_package, '(not coded)') = '(not coded)'), SUM(a) DESC`,
  },
  {
    code: 'SC_TOP_SUBS_MONTH',
    name: 'Top subcontractors this month',
    module: 'SERVICE',
    category: 'Breakdown',
    description: 'The 10 subcontractors with the largest value in the report month: main type of works '
      + '(largest To date), certificates this month (PO + invoice serial, counted once), this month, '
      + 'To date and Pending.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
WITH s AS (SELECT * FROM v_service_line WHERE project_key = :project_key),
vt AS (
  SELECT vendor_key, tow, ROW_NUMBER() OVER (PARTITION BY vendor_key ORDER BY SUM(a) DESC, tow) AS rn
  FROM s WHERE report_bucket <> 'PENDING' GROUP BY vendor_key, tow
),
g AS (
  SELECT vendor_key, MAX(vendor_name) AS vendor_name, MAX(vendor_code) AS vendor_code,
         COUNT(DISTINCT po_no) AS pos,
         COUNT(DISTINCT CASE WHEN report_bucket = 'THIS_MONTH' THEN certificate_id END) AS certificates,
         SUM(CASE WHEN report_bucket = 'THIS_MONTH' THEN a ELSE 0 END) AS this_month,
         SUM(CASE WHEN report_bucket <> 'PENDING' THEN a ELSE 0 END) AS to_date,
         SUM(CASE WHEN report_bucket = 'PENDING' THEN a ELSE 0 END) AS pending
  FROM s GROUP BY vendor_key
)
SELECT g.vendor_name AS subcontractor, g.vendor_code AS code, g.pos AS purchase_orders,
       vt.tow AS type_of_works, g.certificates, g.this_month, g.to_date, g.pending
FROM g LEFT JOIN vt ON vt.vendor_key = g.vendor_key AND vt.rn = 1
WHERE ABS(g.this_month) >= 0.5
ORDER BY g.this_month DESC
LIMIT 10`,
  },
  {
    code: 'SC_RATES',
    name: 'Rate analysis',
    module: 'SERVICE',
    category: 'Breakdown',
    description: 'Per Service + Description row with activity this month: this month\'s rate against the '
      + 'previous rate (Opening + earlier months), and the to-date rate against the start rate (the '
      + 'row\'s first period with qty, over every approved dated line regardless of the cut-off). '
      + 'Change = rate difference, effect = qty × change. A rate pair more than 3x apart, or with a '
      + 'rate <= 0, is flagged "check" and carries no change or effect, so it stays out of every total.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
WITH ${SC_RATES_SQL},
u AS ${SC_PO_UOM_SQL}
SELECT r.service_code AS service, r.service_text AS description,
       ${SC_UNIT_SQL('r.service_code', 'r.service_text', 'u.uom')} AS unit,
       r.cur_q AS qty_this_month, r.prev_rate AS previous_rate, r.this_rate AS this_month_rate,
       r.d_mv AS change,
       CASE WHEN r.d_mv IS NOT NULL AND r.prev_rate <> 0 THEN ROUND(100.0 * r.d_mv / r.prev_rate, 1) END AS change_pct,
       r.eff_mv AS effect,
       r.status_mv AS status,
       r.td_q AS qty_to_date, r.start_rate, r.td_rate AS to_date_rate,
       r.d_sv AS change_since_start,
       CASE WHEN r.d_sv IS NOT NULL AND r.start_rate <> 0 THEN ROUND(100.0 * r.d_sv / r.start_rate, 1) END AS change_since_start_pct,
       r.eff_sv AS effect_since_start,
       CASE WHEN r.chk_mv = 1 OR r.chk_sv = 1 THEN 1 ELSE 0 END AS needs_check
FROM rx2 r LEFT JOIN u ON u.service_code = r.service_code
WHERE ABS(r.cur_a) >= 0.5 OR ABS(r.cur_q) > 1e-9
ORDER BY (r.chk_mv = 1 OR r.chk_sv = 1) DESC, ABS(COALESCE(r.eff_mv, 0)) DESC, ABS(r.cur_a) DESC`,
  },
  {
    code: 'SC_INVOICES_REGISTER',
    name: 'Invoices register',
    module: 'SERVICE',
    category: 'Breakdown',
    description: 'Long format: subcontractor × bucket (Opening, each month, optionally earlier years rolled '
      + 'into "Previous years", then To date) with the certified amount and the number of certificates '
      + '(PO + invoice serial, counted once). Row 0 is "All subcontractors"; others are largest To date '
      + 'first. Approved and dated up to the cut-off only — Pending is not included.',
    params: [P_PROJECT, { name: 'roll_years', type: 'int', label: 'Roll earlier years (1 = yes)', default: 0 }, ...P_SC_FILTERS],
    viz: { kind: 'table' },
    sql: `
WITH c AS (
  SELECT vendor_key, vendor_name, vendor_code, certificate_id, a,
         CASE WHEN report_bucket = 'OPENING' THEN 'Opening'
              WHEN COALESCE(:roll_years, 0) = 1 AND CAST(SUBSTR(period_key, 1, 4) AS INTEGER) < CAST(SUBSTR(report_month, 1, 4) AS INTEGER)
                THEN 'Previous years'
              ELSE period_key END AS bucket,
         CASE WHEN report_bucket = 'OPENING' THEN 0
              WHEN COALESCE(:roll_years, 0) = 1 AND CAST(SUBSTR(period_key, 1, 4) AS INTEGER) < CAST(SUBSTR(report_month, 1, 4) AS INTEGER)
                THEN 1
              ELSE CAST(REPLACE(period_key, '-', '') AS INTEGER) END AS col_order
  FROM v_service_line
  WHERE project_key = :project_key AND report_bucket <> 'PENDING'
    AND (report_bucket = 'OPENING' OR period_key IS NOT NULL)
    AND ${scFilter()}
),
vr AS (
  SELECT vendor_key, ROW_NUMBER() OVER (ORDER BY SUM(a) DESC, vendor_key) AS row_order
  FROM c GROUP BY vendor_key
)
SELECT vendor, vendor_code, bucket, amount, certificates, row_order, col_order FROM (
  SELECT MAX(c.vendor_name) AS vendor, MAX(c.vendor_code) AS vendor_code, c.bucket, SUM(c.a) AS amount,
         COUNT(DISTINCT c.certificate_id) AS certificates, vr.row_order, MIN(c.col_order) AS col_order
  FROM c JOIN vr ON vr.vendor_key = c.vendor_key GROUP BY c.vendor_key, c.bucket
  UNION ALL
  SELECT MAX(c.vendor_name), MAX(c.vendor_code), 'To date', SUM(c.a), COUNT(DISTINCT c.certificate_id), vr.row_order, 100000000
  FROM c JOIN vr ON vr.vendor_key = c.vendor_key GROUP BY c.vendor_key
  UNION ALL
  SELECT 'All subcontractors', NULL, c.bucket, SUM(c.a), COUNT(DISTINCT c.certificate_id), 0, MIN(c.col_order)
  FROM c GROUP BY c.bucket
  UNION ALL
  SELECT 'All subcontractors', NULL, 'To date', SUM(c.a), COUNT(DISTINCT c.certificate_id), 0, 100000000 FROM c
) WHERE amount IS NOT NULL
ORDER BY row_order, col_order`,
  },
  // ---- "At a glance" cards: one row each, numbers only (the card composes the sentence) ----
  {
    code: 'SC_INSIGHT_MOM',
    name: 'At a glance: this month vs last month',
    module: 'SERVICE',
    category: 'Insight',
    description: 'This month against the month before, with the two types of works that moved most up and down.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
WITH ${SC_RM_SQL},
d AS (
  SELECT tow,
         SUM(CASE WHEN report_bucket = 'THIS_MONTH' THEN a ELSE 0 END) AS cur,
         SUM(CASE WHEN report_bucket <> 'PENDING' AND bucket = (SELECT last_m FROM rm) THEN a ELSE 0 END) AS last
  FROM v_service_line WHERE project_key = :project_key AND report_bucket <> 'PENDING' GROUP BY tow
),
u AS (SELECT tow, cur - last AS delta, ROW_NUMBER() OVER (ORDER BY cur - last DESC, tow) AS rn_up,
             ROW_NUMBER() OVER (ORDER BY cur - last, tow) AS rn_dn FROM d WHERE ABS(cur - last) >= 0.5),
t AS (SELECT COALESCE(SUM(cur), 0) AS cur, COALESCE(SUM(last), 0) AS last FROM d)
SELECT ${SC_MONTH_NAME_SQL('(SELECT m FROM rm)')} AS this_label,
       ${SC_MONTH_NAME_SQL('(SELECT last_m FROM rm)')} AS last_label,
       t.cur AS this_amount, t.last AS last_amount,
       CASE WHEN ABS(t.last) > 1e-9 THEN ROUND(100.0 * (t.cur - t.last) / ABS(t.last), 1) END AS change_pct,
       (SELECT tow FROM u WHERE rn_up = 1 AND delta > 0) AS up1_name, (SELECT delta FROM u WHERE rn_up = 1 AND delta > 0) AS up1_amount,
       (SELECT tow FROM u WHERE rn_up = 2 AND delta > 0) AS up2_name, (SELECT delta FROM u WHERE rn_up = 2 AND delta > 0) AS up2_amount,
       (SELECT tow FROM u WHERE rn_dn = 1 AND delta < 0) AS down1_name, (SELECT -delta FROM u WHERE rn_dn = 1 AND delta < 0) AS down1_amount,
       (SELECT tow FROM u WHERE rn_dn = 2 AND delta < 0) AS down2_name, (SELECT -delta FROM u WHERE rn_dn = 2 AND delta < 0) AS down2_amount,
       0 AS flag
FROM t`,
  },
  {
    code: 'SC_INSIGHT_MIX',
    name: 'At a glance: where this month went',
    module: 'SERVICE',
    category: 'Insight',
    description: 'This month\'s value by type of works: the four largest with their share, the rest as one.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
WITH t AS (
  SELECT tow, SUM(a) AS amt FROM v_service_line
  WHERE project_key = :project_key AND report_bucket = 'THIS_MONTH' GROUP BY tow HAVING ABS(SUM(a)) >= 0.5
),
r AS (SELECT tow, amt, ROW_NUMBER() OVER (ORDER BY amt DESC, tow) AS rn, SUM(amt) OVER () AS total FROM t)
SELECT COALESCE(MAX(total), 0) AS total, COUNT(*) AS types,
  ${[1, 2, 3, 4].map((i) => `${scPick(i, 'tow')} AS name${i}, ${scPick(i, 'amt')} AS amount${i},
  ROUND(100.0 * ${scPick(i, 'amt')} / NULLIF(MAX(total), 0), 1) AS share${i}`).join(',\n  ')},
  COALESCE(SUM(CASE WHEN rn > 4 THEN amt END), 0) AS other_amount,
  ROUND(100.0 * COALESCE(SUM(CASE WHEN rn > 4 THEN amt END), 0) / NULLIF(MAX(total), 0), 1) AS other_share,
  0 AS flag
FROM r`,
  },
  {
    code: 'SC_INSIGHT_SUBS',
    name: 'At a glance: subcontractors',
    module: 'SERVICE',
    category: 'Insight',
    description: 'Active subcontractors this month and last, the share of the top three, new ones (first '
      + 'value this month) and stopped ones (value last month of at least 1,000, none this month).',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
WITH ${SC_RM_SQL},
v AS (
  SELECT vendor_key, MAX(vendor_name) AS vendor_name,
         SUM(CASE WHEN report_bucket = 'THIS_MONTH' THEN a ELSE 0 END) AS cur,
         SUM(CASE WHEN bucket = (SELECT last_m FROM rm) THEN a ELSE 0 END) AS last,
         SUM(CASE WHEN report_bucket IN ('OPENING','PREVIOUS') AND a <> 0 THEN 1 ELSE 0 END) AS prior_lines
  FROM v_service_line WHERE project_key = :project_key AND report_bucket <> 'PENDING' GROUP BY vendor_key
),
rk AS (SELECT vendor_name, cur, ROW_NUMBER() OVER (ORDER BY cur DESC, vendor_key) AS rn FROM v WHERE cur > 0),
nw AS (SELECT vendor_name, cur, ROW_NUMBER() OVER (ORDER BY cur DESC, vendor_key) AS rn FROM v WHERE ABS(cur) >= 0.5 AND prior_lines = 0),
st AS (SELECT vendor_name, last, ROW_NUMBER() OVER (ORDER BY last DESC, vendor_key) AS rn FROM v WHERE ABS(cur) < 1e-9 AND last >= 1000)
SELECT (SELECT COUNT(*) FROM v WHERE ABS(cur) > 1e-9) AS active,
       (SELECT COUNT(*) FROM v WHERE ABS(last) > 1e-9) AS last_active,
       ${SC_MONTH_NAME_SQL('(SELECT last_m FROM rm)')} AS last_label,
       (SELECT vendor_name FROM rk WHERE rn = 1) AS top1_name,
       (SELECT vendor_name FROM rk WHERE rn = 2) AS top2_name,
       (SELECT vendor_name FROM rk WHERE rn = 3) AS top3_name,
       ROUND(100.0 * (SELECT COALESCE(SUM(cur), 0) FROM rk WHERE rn <= 3)
             / NULLIF((SELECT SUM(cur) FROM v WHERE cur > 0), 0), 1) AS top3_share,
       (SELECT COUNT(*) FROM nw) AS new_count,
       (SELECT vendor_name FROM nw WHERE rn = 1) AS new1_name, (SELECT cur FROM nw WHERE rn = 1) AS new1_amount,
       (SELECT vendor_name FROM nw WHERE rn = 2) AS new2_name, (SELECT cur FROM nw WHERE rn = 2) AS new2_amount,
       (SELECT COUNT(*) FROM st) AS stopped_count,
       (SELECT vendor_name FROM st WHERE rn = 1) AS stopped1_name, (SELECT last FROM st WHERE rn = 1) AS stopped1_amount,
       0 AS flag`,
  },
  {
    code: 'SC_INSIGHT_CERTS',
    name: 'At a glance: certificates this month',
    module: 'SERVICE',
    category: 'Insight',
    description: 'Certificates (PO + invoice serial) in the report month: count, last month\'s count, average '
      + 'and largest, plus the certificates still waiting for approval.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
WITH ${SC_RM_SQL},
c AS (
  SELECT certificate_id, MAX(vendor_name) AS vendor_name, MAX(po_no) AS po_no,
         MAX(COALESCE(NULLIF(invoice_serial, ''), invoice_no)) AS serial, SUM(a) AS amt
  FROM v_service_line WHERE project_key = :project_key AND report_bucket = 'THIS_MONTH' GROUP BY certificate_id
),
big AS (SELECT * FROM c ORDER BY amt DESC LIMIT 1)
SELECT (SELECT COUNT(*) FROM c) AS certificates,
       (SELECT COUNT(DISTINCT certificate_id) FROM v_service_line
         WHERE project_key = :project_key AND report_bucket <> 'PENDING' AND bucket = (SELECT last_m FROM rm)) AS last_certificates,
       ${SC_MONTH_NAME_SQL('(SELECT last_m FROM rm)')} AS last_label,
       (SELECT AVG(amt) FROM c) AS average_amount,
       (SELECT vendor_name FROM big) AS largest_vendor, (SELECT po_no FROM big) AS largest_po,
       (SELECT serial FROM big) AS largest_serial, (SELECT amt FROM big) AS largest_amount,
       (SELECT COUNT(DISTINCT certificate_id) FROM v_service_line
         WHERE project_key = :project_key AND pend_reason = 'Not approved') AS waiting_certificates,
       (SELECT COALESCE(SUM(a), 0) FROM v_service_line
         WHERE project_key = :project_key AND pend_reason = 'Not approved') AS waiting_amount,
       0 AS flag`,
  },
  {
    code: 'SC_INSIGHT_RATES',
    name: 'At a glance: rates this month vs previous',
    module: 'SERVICE',
    category: 'Insight',
    description: 'The rate effect of this month (qty × rate change against the previous rate) and since the '
      + 'start; how many rows are dearer, cheaper, the same or need a check; the single largest effect. '
      + 'Check rows are counted but kept out of the values. Flagged when any row needs a check.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
WITH ${SC_RATES_SQL},
act AS (SELECT * FROM rx2 WHERE ABS(cur_a) >= 0.5 OR ABS(cur_q) > 1e-9),
big AS (SELECT * FROM act WHERE eff_mv IS NOT NULL ORDER BY ABS(eff_mv) DESC LIMIT 1)
SELECT COALESCE((SELECT SUM(eff_mv) FROM act), 0) AS effect,
       ROUND(100.0 * (SELECT SUM(eff_mv) FROM act) / NULLIF((SELECT SUM(base_mv) FROM act), 0), 2) AS effect_pct,
       (SELECT COUNT(*) FROM act WHERE status_mv = 'dearer') AS dearer,
       (SELECT COUNT(*) FROM act WHERE status_mv = 'cheaper') AS cheaper,
       (SELECT COUNT(*) FROM act WHERE status_mv = 'same') AS same,
       (SELECT COUNT(*) FROM act WHERE chk_mv = 1 OR chk_sv = 1) AS to_check,
       (SELECT service_code FROM big) AS top_service, (SELECT service_text FROM big) AS top_description,
       (SELECT prev_rate FROM big) AS top_from, (SELECT this_rate FROM big) AS top_to,
       (SELECT ROUND(100.0 * d_mv / prev_rate, 1) FROM big) AS top_pct, (SELECT eff_mv FROM big) AS top_effect,
       COALESCE((SELECT SUM(eff_sv) FROM act), 0) AS since_start_effect,
       ROUND(100.0 * (SELECT SUM(eff_sv) FROM act) / NULLIF((SELECT SUM(base_sv) FROM act), 0), 2) AS since_start_pct,
       (SELECT COUNT(*) FROM act WHERE status_sv = 'dearer') AS since_start_dearer,
       (SELECT COUNT(*) FROM act WHERE status_sv = 'cheaper') AS since_start_cheaper,
       CASE WHEN (SELECT COUNT(*) FROM act WHERE chk_mv = 1 OR chk_sv = 1) > 0 THEN 1 ELSE 0 END AS flag`,
  },
  {
    code: 'SC_INSIGHT_NEWWORK',
    name: 'At a glance: new work this month',
    module: 'SERVICE',
    category: 'Insight',
    description: 'Service + Description rows whose first counted value is in the report month: how many, '
      + 'their value and share of the month, and the two largest.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
WITH ${SC_RATES_SQL},
nw AS (
  SELECT service_code, service_text, cur_a, ROW_NUMBER() OVER (ORDER BY cur_a DESC, service_code) AS rn
  FROM rt_cur WHERE prev_n = 0 AND ABS(cur_a) >= 0.5
)
SELECT (SELECT COUNT(*) FROM nw) AS new_rows,
       COALESCE((SELECT SUM(cur_a) FROM nw), 0) AS new_amount,
       ROUND(100.0 * (SELECT SUM(cur_a) FROM nw) / NULLIF((SELECT SUM(cur_a) FROM rt_cur), 0), 1) AS share_pct,
       (SELECT service_code FROM nw WHERE rn = 1) AS top1_service, (SELECT service_text FROM nw WHERE rn = 1) AS top1_description,
       (SELECT cur_a FROM nw WHERE rn = 1) AS top1_amount,
       (SELECT service_code FROM nw WHERE rn = 2) AS top2_service, (SELECT service_text FROM nw WHERE rn = 2) AS top2_description,
       (SELECT cur_a FROM nw WHERE rn = 2) AS top2_amount,
       0 AS flag`,
  },
  {
    code: 'SC_INSIGHT_PENDING',
    name: 'At a glance: pending',
    module: 'SERVICE',
    category: 'Insight',
    description: 'Value that is not in To date, split by reason (not approved, dated after the cut-off, no '
      + 'date), the subcontractors involved and the largest.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
WITH p AS (SELECT * FROM v_service_line WHERE project_key = :project_key AND report_bucket = 'PENDING'),
pv AS (SELECT vendor_key, MAX(vendor_name) AS vendor_name, SUM(a) AS amt,
              ROW_NUMBER() OVER (ORDER BY SUM(a) DESC, vendor_key) AS rn
       FROM p GROUP BY vendor_key HAVING ABS(SUM(a)) >= 0.5)
SELECT COALESCE(SUM(a), 0) AS pending_amount,
       COALESCE(SUM(CASE WHEN pend_reason = 'Not approved' THEN a END), 0) AS not_approved_amount,
       COUNT(DISTINCT CASE WHEN pend_reason = 'Not approved' THEN certificate_id END) AS not_approved_certificates,
       COALESCE(SUM(CASE WHEN pend_reason = 'After cut date' THEN a END), 0) AS after_cut_amount,
       COALESCE(SUM(CASE WHEN pend_reason = 'No date' THEN a END), 0) AS no_date_amount,
       (SELECT COUNT(*) FROM pv) AS subcontractors,
       (SELECT vendor_name FROM pv WHERE rn = 1) AS top_name, (SELECT amt FROM pv WHERE rn = 1) AS top_amount,
       0 AS flag
FROM p`,
  },
  {
    code: 'SC_INSIGHT_POQTY',
    name: 'At a glance: PO quantities',
    module: 'SERVICE',
    category: 'Insight',
    description: 'Qty certified to date ÷ PO qty (ZSCSRV1) per PO service line: how many lines are over '
      + '100.05% and how many are at 90 to 100.05%, and the worst one. ZSCSRV1 does not say which PO lines '
      + 'are unlimited, so a line with a contract qty is always compared. Flagged when any line is over.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
WITH m AS (
  SELECT m.po_service_line_id, SUM(s.report_qty) AS cert_q
  FROM v_service_line_po_match m JOIN v_service_line s ON s.service_line_id = m.service_line_id
  WHERE s.project_key = :project_key AND s.report_bucket <> 'PENDING' AND m.po_service_line_id IS NOT NULL
  GROUP BY m.po_service_line_id
),
r AS (
  SELECT p.po_no, p.service_code, p.service_text, p.uom, p.contract_qty, COALESCE(m.cert_q, 0) AS cert_q,
         COALESCE(m.cert_q, 0) / p.contract_qty AS ratio
  FROM v_po_service_line p LEFT JOIN m ON m.po_service_line_id = p.po_service_line_id
  WHERE p.project_key = :project_key AND p.contract_qty > 0
),
worst AS (SELECT * FROM r ORDER BY ratio DESC LIMIT 1)
SELECT (SELECT COUNT(*) FROM r) AS po_rows,
       (SELECT COUNT(*) FROM r WHERE ratio > 1.0005) AS over_count,
       (SELECT COUNT(*) FROM r WHERE ratio >= 0.9 AND ratio <= 1.0005) AS near_count,
       (SELECT po_no FROM worst) AS worst_po, (SELECT service_code FROM worst) AS worst_service,
       (SELECT service_text FROM worst) AS worst_description,
       (SELECT ROUND(100.0 * ratio, 0) FROM worst) AS worst_pct,
       (SELECT cert_q FROM worst) AS worst_certified_qty, (SELECT contract_qty FROM worst) AS worst_po_qty,
       (SELECT uom FROM worst) AS worst_unit,
       CASE WHEN (SELECT COUNT(*) FROM r WHERE ratio > 1.0005) > 0 THEN 1 ELSE 0 END AS flag`,
  },
  {
    code: 'SC_INSIGHT_REVIEW',
    name: 'At a glance: to review',
    module: 'SERVICE',
    category: 'Insight',
    description: 'Checks that need attention (first three named), lines changed since the previous load '
      + 'and what is still to code. Flagged when any check needs attention.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
WITH ${SC_CHANGES_SQL},
${SC_CHECKS_SQL},
w AS (SELECT check_name, ROW_NUMBER() OVER (ORDER BY sort) AS rn FROM chk WHERE needs_attention = 1),
cd AS (
  SELECT service_code, service_text_norm, MAX(work_package) AS wp, SUM(ABS(a)) AS amt
  FROM v_service_line WHERE project_key = :project_key GROUP BY service_code, service_text_norm
)
SELECT (SELECT COUNT(*) FROM w) AS warn_checks,
       (SELECT check_name FROM w WHERE rn = 1) AS warn1, (SELECT check_name FROM w WHERE rn = 2) AS warn2,
       (SELECT check_name FROM w WHERE rn = 3) AS warn3,
       (SELECT COUNT(*) FROM loads) AS loads,
       (SELECT COUNT(*) FROM changes) AS changed_lines,
       COALESCE((SELECT SUM(difference) FROM changes), 0) AS changed_net,
       (SELECT COUNT(*) FROM cd WHERE wp IS NULL) AS services_to_code,
       ROUND(100.0 * (SELECT COALESCE(SUM(amt), 0) FROM cd WHERE wp IS NOT NULL) / NULLIF((SELECT SUM(amt) FROM cd), 0), 1) AS coded_pct,
       CASE WHEN (SELECT COUNT(*) FROM w) > 0 THEN 1 ELSE 0 END AS flag`,
  },
  {
    code: 'SC_LOAD_HISTORY',
    name: 'Subcontract certificate load history',
    module: 'SERVICE',
    category: 'Trend',
    description: 'One row per certificate upload for the project, as it was posted: lines, total, and '
      + 'the approved / opening / pending split, subcontractors and POs.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
WITH per_vendor AS (
  SELECT s.import_batch_id, s.vendor_name, SUM(s.amount_net) AS amount
  FROM service_line_snapshot s WHERE s.project_key = :project_key
  GROUP BY s.import_batch_id, s.vendor_name
)
SELECT b.data_date, b.file_name, b.posted_at,
       COUNT(*)                                                                    AS lines,
       SUM(s.amount_net)                                                           AS total_amount,
       SUM(CASE WHEN COALESCE(s.is_approved, 1) = 1 AND COALESCE(s.is_opening, 0) = 0
                THEN s.amount_net ELSE 0 END)                                      AS approved_amount,
       SUM(CASE WHEN COALESCE(s.is_approved, 1) = 1 AND s.is_opening = 1
                THEN s.amount_net ELSE 0 END)                                      AS opening_amount,
       SUM(CASE WHEN s.is_approved = 0 THEN s.amount_net ELSE 0 END)               AS pending_amount,
       (SELECT COUNT(*) FROM per_vendor v
         WHERE v.import_batch_id = s.import_batch_id AND ABS(v.amount) > 1e-9)     AS subcontractors,
       COUNT(DISTINCT s.po_no)                                                     AS purchase_orders
FROM service_line_snapshot s
JOIN import_batch b ON b.import_batch_id = s.import_batch_id AND b.status IN ('POSTED','SUPERSEDED')
WHERE s.project_key = :project_key
GROUP BY s.import_batch_id
ORDER BY s.import_batch_id`,
  },
  {
    code: 'SC_CHANGES_SUMMARY',
    name: 'Subcontract changes since last load (headline)',
    module: 'SERVICE',
    category: 'Headline',
    description: 'Count and amount of each kind of change between the two latest certificate uploads.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
WITH ${SC_CHANGES_SQL}
SELECT
  (SELECT COUNT(*) FROM loads)                                                      AS loads,
  COALESCE(SUM(change_type = 'New'), 0)                                             AS new_lines,
  COALESCE(SUM(CASE WHEN change_type = 'New' THEN difference END), 0)               AS new_amount,
  COALESCE(SUM(change_type = 'Amount changed'), 0)                                  AS changed_lines,
  COALESCE(SUM(CASE WHEN change_type = 'Amount changed' THEN difference END), 0)    AS changed_amount,
  COALESCE(SUM(change_type = 'Approved since last load'), 0)                        AS newly_approved_lines,
  COALESCE(SUM(CASE WHEN change_type = 'Approved since last load' THEN difference END), 0) AS newly_approved_amount,
  COALESCE(SUM(change_type = 'Removed'), 0)                                         AS removed_lines,
  COALESCE(SUM(CASE WHEN change_type = 'Removed' THEN difference END), 0)           AS removed_amount
FROM changes`,
  },
  {
    code: 'SC_CHANGES',
    name: 'Subcontract changes since last load',
    module: 'SERVICE',
    category: 'Reconciliation',
    description: 'Certificate lines that are new, changed amount, became approved or disappeared between '
      + 'the two latest uploads. A newly approved line counts at its full amount. The optional search '
      + 'param :q matches PO, subcontractor, service code and text (a snapshot holds no other filter column).',
    params: [P_PROJECT, { name: 'q', type: 'text', label: 'Search' }],
    viz: { kind: 'table' },
    sql: `
WITH ${SC_CHANGES_SQL}
SELECT change_type, po_no, vendor_name, service_code, service_text, before, now, difference
FROM changes
WHERE :q IS NULL OR INSTR(LOWER(COALESCE(po_no, '') || ' ' || COALESCE(vendor_name, '') || ' '
      || COALESCE(service_code, '') || ' ' || COALESCE(service_text, '')), LOWER(:q)) > 0
ORDER BY CASE change_type WHEN 'New' THEN 1 WHEN 'Approved since last load' THEN 2
                          WHEN 'Amount changed' THEN 3 ELSE 4 END,
         ABS(difference) DESC`,
  },
  // ---------------------------------------------------------------------------
  // Native Subcontract report page (docs/port/native-report.md): one stored query per
  // workbook sheet, all taking the filter bar's optional params (:tow :vendor :pkg
  // :month :q). Drill-down keys: :service_code + :service_norm, :po_no, :vendor.
  // ---------------------------------------------------------------------------
  {
    code: 'SC_FILTER_TOW',
    name: 'Filter list: type of works',
    module: 'SERVICE',
    category: 'Filter',
    description: 'Every type of works on the project\'s subcontract POs, in the user\'s order (else largest To date first), for the filter bar.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
SELECT g.tow AS value, g.tow AS label, g.to_date AS amount
FROM (SELECT tow, SUM(CASE WHEN report_bucket <> 'PENDING' THEN a ELSE 0 END) AS to_date
      FROM v_service_line WHERE project_key = :project_key GROUP BY tow) g
LEFT JOIN dim_tow_order o ON o.project_key = :project_key AND o.tow = g.tow
ORDER BY COALESCE(o.sort_order, 1000000), g.to_date DESC, g.tow`,
  },
  {
    code: 'SC_FILTER_VENDOR',
    name: 'Filter list: subcontractor',
    module: 'SERVICE',
    category: 'Filter',
    description: 'Every subcontractor with certificate lines (value = vendor key), for the filter bar.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
SELECT vendor_key AS value, COALESCE(MAX(vendor_name), MAX(vendor_code), '(unknown)') AS label,
       SUM(CASE WHEN report_bucket <> 'PENDING' THEN a ELSE 0 END) AS amount
FROM v_service_line WHERE project_key = :project_key AND vendor_key IS NOT NULL
GROUP BY vendor_key ORDER BY label`,
  },
  {
    code: 'SC_FILTER_PKG',
    name: 'Filter list: DIV (work package)',
    module: 'SERVICE',
    category: 'Filter',
    description: 'The work packages (DIV) the project\'s services are coded to, plus "(not coded)", for the filter bar.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
SELECT COALESCE(s.work_package, '(not coded)') AS value,
       COALESCE(MAX(w.code || ' · ' || w.label), COALESCE(s.work_package, '(not coded)')) AS label,
       SUM(CASE WHEN s.report_bucket <> 'PENDING' THEN s.a ELSE 0 END) AS amount
FROM v_service_line s LEFT JOIN dim_work_package w ON w.code = s.work_package
WHERE s.project_key = :project_key
GROUP BY COALESCE(s.work_package, '(not coded)')
ORDER BY (s.work_package IS NULL), COALESCE(s.work_package, '')`,
  },
  {
    code: 'SC_FILTER_MONTH',
    name: 'Filter list: month',
    module: 'SERVICE',
    category: 'Filter',
    description: 'Every certificate month in the data, newest first, for the filter bar.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
SELECT period_key AS value, ${SC_MONTH_NAME_SQL('period_key')} AS label
FROM v_service_line WHERE project_key = :project_key AND period_key IS NOT NULL
GROUP BY period_key ORDER BY period_key DESC`,
  },
  {
    code: 'SC_SHEET_MONTHS',
    name: 'Summary: cost per month by resource type (filtered)',
    module: 'SERVICE',
    category: 'Sheet',
    description: 'The Summary sheet\'s table 1 in long format for the stacked chart: certified value per month and resource '
      + 'type (S Subcontract / L Labour / P Plant / Other), Opening first, Pending not included. Takes the filter bar params.',
    params: [P_PROJECT, ...P_SC_FILTERS],
    viz: { kind: 'table' },
    sql: `
WITH ${scMonthWide(' AND ' + scFilter())}
SELECT CASE WHEN period_key = 'Opening' THEN 'Opening' ELSE ${SC_MONTH_NAME_SQL('period_key')} END AS month,
       sort_key, resource, series_order, amount, month_total, cumulative, subcontractors, certificates FROM (
  SELECT period_key, sort_key, 'Subcontract' AS resource, 1 AS series_order, subcontract AS amount, total AS month_total, cumulative, subcontractors, certificates FROM mw
  UNION ALL SELECT period_key, sort_key, 'Labour', 2, labour, total, cumulative, subcontractors, certificates FROM mw
  UNION ALL SELECT period_key, sort_key, 'Plant', 3, plant, total, cumulative, subcontractors, certificates FROM mw
  UNION ALL SELECT period_key, sort_key, 'Other', 4, other, total, cumulative, subcontractors, certificates FROM mw
) WHERE ABS(amount) > 1e-9
ORDER BY sort_key, series_order`,
  },
  {
    code: 'SC_SHEET_MONTHS_TABLE',
    name: 'Summary: cost per month (filtered table)',
    module: 'SERVICE',
    category: 'Sheet',
    description: 'The Summary sheet\'s table 1: one row per month with a column per resource type, the total, the cumulative '
      + 'total, active subcontractors and certificates. Takes the filter bar params.',
    params: [P_PROJECT, ...P_SC_FILTERS],
    viz: { kind: 'table' },
    sql: `
WITH ${scMonthWide(' AND ' + scFilter())}
SELECT CASE WHEN period_key = 'Opening' THEN 'Opening' ELSE ${SC_MONTH_NAME_SQL('period_key')} END AS month,
       subcontract, labour, plant, other, total, cumulative, subcontractors, certificates, sort_key
FROM mw ORDER BY sort_key`,
  },
  {
    code: 'SC_SHEET_DIV',
    name: 'Summary: cost by DIV',
    module: 'SERVICE',
    category: 'Sheet',
    description: 'The Summary sheet\'s table 2: Previous, This month, To date, share and Pending per work package (DIV). '
      + 'Services not coded yet are one "(not coded)" line, so the totals tie. Takes the filter bar params.',
    params: [P_PROJECT, ...P_SC_FILTERS],
    viz: { kind: 'bar', label: 'div', value: 'to_date' },
    sql: `
WITH b AS (SELECT * FROM v_service_line WHERE project_key = :project_key AND ${scFilter()}),
g AS (
  SELECT work_package, ${scA(SC_PREV)} AS previous, ${scA(SC_CUR)} AS this_month, ${scA(SC_TD)} AS to_date,
         ${scA(SC_PEND)} AS pending
  FROM b GROUP BY work_package
  HAVING ABS(${scA(SC_TD)}) > 1e-9 OR ABS(${scA(SC_PEND)}) > 1e-9
)
SELECT COALESCE(w.code || ' · ' || w.label, g.work_package, '(not coded)') AS div,
       g.previous, g.this_month, g.to_date,
       ROUND(100.0 * g.to_date / NULLIF(SUM(g.to_date) OVER (), 0), 1) AS pct_of_to_date,
       g.pending
FROM g LEFT JOIN dim_work_package w ON w.code = g.work_package
ORDER BY (g.work_package IS NULL), g.to_date DESC`,
  },
  {
    code: 'SC_SHEET_TOW',
    name: 'Summary: cost by type of works',
    module: 'SERVICE',
    category: 'Sheet',
    description: 'The Summary sheet\'s table 3: Previous, This month, To date, share and Pending per type of works '
      + '(each line takes its PO\'s type), in the user\'s order. Takes the filter bar params.',
    params: [P_PROJECT, ...P_SC_FILTERS],
    viz: { kind: 'bar', label: 'type_of_works', value: 'to_date' },
    sql: `
WITH b AS (SELECT * FROM v_service_line WHERE project_key = :project_key AND ${scFilter()}),
${SC_TOW_ORDER_SQL},
g AS (
  SELECT tow, ${scA(SC_PREV)} AS previous, ${scA(SC_CUR)} AS this_month, ${scA(SC_TD)} AS to_date,
         ${scA(SC_PEND)} AS pending
  FROM b GROUP BY tow
  HAVING ABS(${scA(SC_TD)}) > 1e-9 OR ABS(${scA(SC_PEND)}) > 1e-9
)
SELECT g.tow AS type_of_works, g.previous, g.this_month, g.to_date,
       ROUND(100.0 * g.to_date / NULLIF(SUM(g.to_date) OVER (), 0), 1) AS pct_of_to_date,
       g.pending
FROM g LEFT JOIN tow_ord o ON o.tow = g.tow
ORDER BY COALESCE(o.sort_order, 1000000), g.to_date DESC`,
  },
  {
    code: 'SC_SAP_RECON',
    name: 'Summary: from the SAP total to this report',
    module: 'SERVICE',
    category: 'Sheet',
    description: 'The Summary sheet\'s table 4: the latest upload\'s SAP grand total, less the WBS repeat rows, = certified, '
      + 'less each kind of Pending, = To date. A missing footer leaves the first line empty ("not checked"). Not filtered.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
WITH ${SC_CHECKS_SQL},
td AS (SELECT COALESCE(SUM(CASE WHEN report_bucket <> 'PENDING' THEN a END), 0) AS to_date,
              COUNT(CASE WHEN report_bucket <> 'PENDING' THEN 1 END) AS n,
              MAX(report_month) AS m
       FROM v_service_line WHERE project_key = :project_key)
SELECT step, amount, "lines", note FROM (
  SELECT 1 AS sort, 'SAP grand total (last row of the upload)' AS step, amt AS amount, NULL AS "lines",
         CASE WHEN amt IS NULL THEN 'Not checked: the upload has no grand-total row' ELSE 'SC Work Current Cost, as SAP adds it' END AS note
    FROM chk WHERE check_code = 'FOOTER'
  UNION ALL SELECT 2, 'Less: WBS repeat rows', amt, cnt, 'SAP repeats a line on every WBS element it is split over; it is counted once here'
    FROM chk WHERE check_code = 'SPLITS'
  UNION ALL SELECT 3, '= Certified (all lines)', amt, cnt, 'Every loaded line, approved or not'
    FROM chk WHERE check_code = 'REPORT_TOTAL'
  UNION ALL SELECT 4, 'Less: Pending – not approved', -amt, cnt, 'Not approved yet'
    FROM chk WHERE check_code = 'NOT_APPROVED'
  UNION ALL SELECT 5, 'Less: Pending – dated after the cut date', -amt, cnt, 'Certificate date after the cut-off'
    FROM chk WHERE check_code = 'AFTER_CUT'
  UNION ALL SELECT 6, 'Less: Pending – no certificate date', -amt, cnt, 'Without a date the line has no month'
    FROM chk WHERE check_code = 'NO_DATE'
  UNION ALL SELECT 7, '= To date (Opening + months to ' || COALESCE(${SC_MONTH_NAME_SQL('td.m')}, '—') || ')', td.to_date, td.n,
         'The To date of every report sheet'
    FROM td
) ORDER BY sort`,
  },
  {
    code: 'SC_SHEET_CODING',
    name: 'Coding: coding status per service',
    module: 'SERVICE',
    category: 'Sheet',
    description: 'The Coding sheet: one row per Service + Description with its DIV (work package), MNL, coding status, '
      + 'To date qty / rate / amount, this month, POs and subcontractors. PKG and Cost element are the user\'s own '
      + 'catalogue codes, which the app does not store, so they are not shown. Takes the filter bar params.',
    params: [P_PROJECT, ...P_SC_FILTERS],
    viz: { kind: 'table' },
    sql: `
WITH u AS ${SC_PO_UOM_SQL},
b AS (SELECT * FROM v_service_line WHERE project_key = :project_key AND ${scFilter()}),
${scSvcMeta('b')},
${SC_TOW_ORDER_SQL},
g AS (
  SELECT service_code, service_text_norm, ${scQ(SC_TD)} AS td_q, ${scA(SC_TD)} AS td_a, ${scA(SC_CUR)} AS cur_a,
         COUNT(DISTINCT po_no) AS pos, COUNT(DISTINCT vendor_key) AS subs
  FROM b GROUP BY service_code, service_text_norm
)
SELECT svc.tow AS type_of_works, svc.service_code AS service, svc.service_text AS description, svc.unit,
       svc.work_package AS div, ${SC_MNL_SQL} AS mnl,
       CASE WHEN svc.work_package IS NULL THEN 'Not coded' ELSE 'Coded' END AS status,
       g.td_q AS qty_to_date, ${scRate('g.td_a', 'g.td_q')} AS rate, g.td_a AS to_date, g.cur_a AS this_month,
       g.pos AS purchase_orders, g.subs AS subcontractors,
       CASE WHEN svc.work_package IS NULL THEN 1 ELSE 0 END AS not_coded,
       svc.service_code AS service_code, svc.service_text_norm AS service_norm
FROM svc JOIN g ON g.service_code IS svc.service_code AND g.service_text_norm IS svc.service_text_norm
LEFT JOIN tow_ord o ON o.tow = svc.tow
ORDER BY COALESCE(o.sort_order, 1000000), SUM(g.td_a) OVER (PARTITION BY svc.tow) DESC, svc.tow,
         (svc.work_package IS NOT NULL), ABS(g.td_a) DESC, svc.service_code`,
  },
  {
    code: 'SC_SHEET_CODING_STATUS',
    name: 'Coding: how much is coded',
    module: 'SERVICE',
    category: 'Sheet',
    description: 'One row for the Coding tab\'s band: services (Service + Description rows), how many are coded to a DIV and '
      + 'how many still to code, the coded share of To date, and the To date / this month amount not coded. '
      + 'Takes the filter bar params.',
    params: [P_PROJECT, ...P_SC_FILTERS],
    viz: { kind: 'table' },
    sql: `
WITH b AS (SELECT * FROM v_service_line WHERE project_key = :project_key AND ${scFilter()}),
g AS (
  SELECT service_code, service_text_norm, MAX(work_package) AS work_package,
         ${scA(SC_TD)} AS td_a, ${scA(SC_CUR)} AS cur_a
  FROM b GROUP BY service_code, service_text_norm
)
SELECT COUNT(*) AS services,
       COALESCE(SUM(work_package IS NOT NULL), 0) AS coded_services,
       COALESCE(SUM(work_package IS NULL), 0) AS services_to_code,
       ROUND(100.0 * SUM(CASE WHEN work_package IS NOT NULL THEN td_a ELSE 0 END) / NULLIF(SUM(td_a), 0), 1) AS coded_pct_of_to_date,
       COALESCE(SUM(CASE WHEN work_package IS NULL THEN td_a END), 0) AS not_coded_to_date,
       COALESCE(SUM(CASE WHEN work_package IS NULL THEN cur_a END), 0) AS not_coded_this_month
FROM g`,
  },
  {
    code: 'SC_SHEET_SERVICES',
    name: 'Services: service summary',
    module: 'SERVICE',
    category: 'Sheet',
    description: 'The Service Summary sheet: per Service + Description — Previous, This month, To date and Pending as qty / rate / '
      + 'amount, then the rate analysis (this month vs previous, and since the start). Rows are in the type-of-works order. '
      + 'A rate pair more than 3x apart, or with a rate <= 0, reads "check" and carries no change or value. '
      + 'Takes the filter bar params; service_code + service_norm are the drill-down key.',
    params: [P_PROJECT, ...P_SC_FILTERS],
    viz: { kind: 'table' },
    sql: `
WITH ${scRates(' AND ' + scFilter())},
u AS ${SC_PO_UOM_SQL},
b AS (SELECT * FROM v_service_line WHERE project_key = :project_key AND ${scFilter()}),
${scSvcMeta('b')},
${SC_TOW_ORDER_SQL},
p AS (SELECT service_code, service_text_norm, SUM(report_qty) AS pq, SUM(a) AS pa
      FROM b WHERE report_bucket = 'PENDING' GROUP BY service_code, service_text_norm)
SELECT svc.tow AS type_of_works, svc.service_code AS service, svc.service_text AS description, svc.unit,
       svc.work_package AS div, ${SC_MNL_SQL} AS mnl,
       COALESCE(x.prev_q, 0) AS previous_qty, x.prev_rate AS previous_rate, COALESCE(x.prev_a, 0) AS previous_amount,
       COALESCE(x.cur_q, 0) AS month_qty, x.this_rate AS month_rate, COALESCE(x.cur_a, 0) AS month_amount,
       COALESCE(x.td_q, 0) AS todate_qty, x.td_rate AS todate_rate, COALESCE(x.td_a, 0) AS todate_amount,
       COALESCE(p.pq, 0) AS pending_qty, ${scRate('p.pa', 'p.pq')} AS pending_rate, COALESCE(p.pa, 0) AS pending_amount,
       x.prev_rate AS rate_previous, x.this_rate AS rate_this_month, x.d_mv AS rate_change,
       CASE WHEN x.d_mv IS NOT NULL AND x.prev_rate <> 0 THEN ROUND(100.0 * x.d_mv / x.prev_rate, 1) END AS rate_change_pct,
       x.eff_mv AS rate_value, x.status_mv AS rate_status,
       CASE WHEN x.first_bucket = 'OPENING' THEN 'Opening'
            WHEN x.first_bucket IS NOT NULL THEN ${SC_MONTH_NAME_SQL('x.first_bucket')} END AS first_month,
       x.start_rate AS start_rate, x.td_rate AS start_to_date_rate, x.d_sv AS start_change,
       CASE WHEN x.d_sv IS NOT NULL AND x.start_rate <> 0 THEN ROUND(100.0 * x.d_sv / x.start_rate, 1) END AS start_change_pct,
       x.eff_sv AS start_value, x.status_sv AS start_status,
       CASE WHEN x.chk_mv = 1 OR x.chk_sv = 1 THEN 1 ELSE 0 END AS needs_check,
       svc.service_code AS service_code, svc.service_text_norm AS service_norm
FROM svc
LEFT JOIN rx2 x ON x.service_code IS svc.service_code AND x.service_text_norm IS svc.service_text_norm
LEFT JOIN p ON p.service_code IS svc.service_code AND p.service_text_norm IS svc.service_text_norm
LEFT JOIN tow_ord o ON o.tow = svc.tow
ORDER BY COALESCE(o.sort_order, 1000000), SUM(COALESCE(x.td_a, 0)) OVER (PARTITION BY svc.tow) DESC, svc.tow,
         ABS(COALESCE(x.td_a, 0)) DESC, svc.service_code`,
  },
  {
    code: 'SC_SHEET_SERVICE_MONTH',
    name: 'Services by month (long)',
    module: 'SERVICE',
    category: 'Sheet',
    description: 'The Service per Month sheet in long format: one row per Service + Description and period (Opening, each month, '
      + 'Pending) with qty and amount; the page pivots it. Takes the filter bar params.',
    params: [P_PROJECT, ...P_SC_FILTERS],
    viz: { kind: 'table' },
    sql: `
WITH u AS ${SC_PO_UOM_SQL},
b AS (SELECT * FROM v_service_line WHERE project_key = :project_key AND ${scFilter()}),
${scSvcMeta('b')},
${SC_TOW_ORDER_SQL},
g AS (
  SELECT service_code, service_text_norm, ${SC_PERIOD_LABEL_SQL} AS period, ${SC_PERIOD_ORDER_SQL} AS col_order,
         SUM(report_qty) AS qty, SUM(a) AS amount
  FROM b GROUP BY service_code, service_text_norm, 3, 4
)
SELECT svc.tow AS type_of_works, svc.service_code AS service, svc.service_text AS description, svc.unit,
       svc.work_package AS div, g.period, g.col_order, g.qty, g.amount,
       svc.service_code AS service_code, svc.service_text_norm AS service_norm
FROM g JOIN svc ON svc.service_code IS g.service_code AND svc.service_text_norm IS g.service_text_norm
LEFT JOIN tow_ord o ON o.tow = svc.tow
ORDER BY COALESCE(o.sort_order, 1000000),
         SUM(CASE WHEN g.col_order < 999999 THEN g.amount ELSE 0 END) OVER (PARTITION BY svc.tow) DESC, svc.tow,
         SUM(CASE WHEN g.col_order < 999999 THEN g.amount ELSE 0 END) OVER (PARTITION BY svc.service_code, svc.service_text_norm) DESC,
         svc.service_code, svc.service_text_norm, g.col_order`,
  },
  {
    code: 'SC_SHEET_PO_REGISTER',
    name: 'PO register',
    module: 'SERVICE',
    category: 'Sheet',
    description: 'The PO Register sheet: per PO + Service + Description — the ZSCSRV1 PO qty, then Previous / This month / To date / '
      + 'Pending as qty / rate / amount, % of PO qty used, certificates and the last certificate date, plus a status '
      + '(No PO line, Over PO qty, Pending). Takes the filter bar params; po + service_code + service_norm are the drill-down key.',
    params: [P_PROJECT, ...P_SC_FILTERS],
    viz: { kind: 'table' },
    sql: `
WITH u AS ${SC_PO_UOM_SQL},
b AS (SELECT * FROM v_service_line WHERE project_key = :project_key AND ${scFilter()}),
${SC_TOW_ORDER_SQL},
pq AS (
  SELECT po_no, service_code, ${scNorm('service_text')} AS service_text_norm, SUM(contract_qty) AS po_qty
  FROM v_po_service_line WHERE project_key = :project_key GROUP BY 1, 2, 3
),
g AS (
  SELECT po_no, service_code, service_text_norm, MAX(service_text) AS service_text, MAX(vendor_name) AS vendor_name,
         MAX(vendor_key) AS vendor_key, MAX(tow) AS tow, MAX(work_package) AS work_package,
         ${scQ(SC_PREV)} AS prev_q, ${scA(SC_PREV)} AS prev_a,
         ${scQ(SC_CUR)} AS cur_q, ${scA(SC_CUR)} AS cur_a,
         ${scQ(SC_TD)} AS td_q, ${scA(SC_TD)} AS td_a,
         ${scQ(SC_PEND)} AS pend_q, ${scA(SC_PEND)} AS pend_a,
         COUNT(DISTINCT certificate_id) AS certificates, MAX(SUBSTR(eff_date, 1, 10)) AS last_cert
  FROM b GROUP BY po_no, service_code, service_text_norm
)
SELECT g.tow AS type_of_works, g.po_no AS po, g.vendor_name AS subcontractor, g.service_code AS service,
       g.service_text AS description, ${SC_UNIT_SQL('g.service_code', 'g.service_text', 'u.uom')} AS unit,
       g.work_package AS div, ${SC_MNL_SQL} AS mnl, pq.po_qty AS po_qty,
       g.prev_q AS previous_qty, ${scRate('g.prev_a', 'g.prev_q')} AS previous_rate, g.prev_a AS previous_amount,
       g.cur_q AS month_qty, ${scRate('g.cur_a', 'g.cur_q')} AS month_rate, g.cur_a AS month_amount,
       g.td_q AS todate_qty, ${scRate('g.td_a', 'g.td_q')} AS todate_rate, g.td_a AS todate_amount,
       CASE WHEN pq.po_qty > 0 THEN ROUND(100.0 * g.td_q / pq.po_qty, 1) END AS pct_of_po_qty,
       g.pend_q AS pending_qty, g.pend_a AS pending_amount,
       g.certificates AS certificates_all, g.last_cert AS last_certificate,
       CASE WHEN pq.po_qty IS NULL THEN 'No PO line'
            WHEN pq.po_qty > 0 AND g.td_q > pq.po_qty * 1.0001 THEN 'Over PO qty'
            WHEN ABS(g.pend_a) > 1e-9 THEN 'Pending'
            ELSE '' END AS status,
       CASE WHEN pq.po_qty IS NULL OR (pq.po_qty > 0 AND g.td_q > pq.po_qty * 1.0001) THEN 1 ELSE 0 END AS needs_check,
       g.po_no AS po_no, g.service_code AS service_code, g.service_text_norm AS service_norm, g.vendor_key AS vendor_key
FROM g LEFT JOIN u ON u.service_code = g.service_code
       LEFT JOIN pq ON pq.po_no = g.po_no AND pq.service_code IS g.service_code AND pq.service_text_norm = g.service_text_norm
       LEFT JOIN tow_ord o ON o.tow = g.tow
ORDER BY COALESCE(o.sort_order, 1000000), SUM(g.td_a) OVER (PARTITION BY g.tow) DESC, g.tow,
         g.po_no, ABS(g.td_a) DESC, g.service_code`,
  },
  {
    code: 'SC_SHEET_PO_MONTH',
    name: 'PO by month (long)',
    module: 'SERVICE',
    category: 'Sheet',
    description: 'The PO per Month sheet in long format: one row per PO + Service + Description and period (Opening, each month, '
      + 'Pending) with qty and amount; the page pivots it. Takes the filter bar params.',
    params: [P_PROJECT, ...P_SC_FILTERS],
    viz: { kind: 'table' },
    sql: `
WITH u AS ${SC_PO_UOM_SQL},
b AS (SELECT * FROM v_service_line WHERE project_key = :project_key AND ${scFilter()}),
${SC_TOW_ORDER_SQL},
g AS (
  SELECT po_no, service_code, service_text_norm, MAX(service_text) AS service_text, MAX(vendor_name) AS vendor_name,
         MAX(tow) AS tow, MAX(work_package) AS work_package,
         ${SC_PERIOD_LABEL_SQL} AS period, ${SC_PERIOD_ORDER_SQL} AS col_order,
         SUM(report_qty) AS qty, SUM(a) AS amount
  FROM b GROUP BY po_no, service_code, service_text_norm, 8, 9
)
SELECT g.tow AS type_of_works, g.po_no AS po, g.vendor_name AS subcontractor, g.service_code AS service,
       g.service_text AS description, ${SC_UNIT_SQL('g.service_code', 'g.service_text', 'u.uom')} AS unit,
       g.work_package AS div, g.period, g.col_order, g.qty, g.amount,
       g.po_no AS po_no, g.service_code AS service_code, g.service_text_norm AS service_norm
FROM g LEFT JOIN u ON u.service_code = g.service_code
       LEFT JOIN tow_ord o ON o.tow = g.tow
ORDER BY COALESCE(o.sort_order, 1000000),
         SUM(CASE WHEN g.col_order < 999999 THEN g.amount ELSE 0 END) OVER (PARTITION BY g.tow) DESC, g.tow,
         g.po_no, SUM(CASE WHEN g.col_order < 999999 THEN g.amount ELSE 0 END) OVER (PARTITION BY g.po_no, g.service_code, g.service_text_norm) DESC,
         g.service_code, g.service_text_norm, g.col_order`,
  },
  {
    code: 'SC_SHEET_SUBS',
    name: 'Subcontractors: subcontractor summary',
    module: 'SERVICE',
    category: 'Sheet',
    description: 'The Subcontractor Summary sheet: per subcontractor — main type of works (largest To date), POs, and certificates '
      + '(PO + invoice serial, counted once) and amount for Previous, This month, To date (with its share of all) and Pending. '
      + 'Takes the filter bar params; vendor_key is the drill-down key.',
    params: [P_PROJECT, ...P_SC_FILTERS],
    viz: { kind: 'table' },
    sql: `
WITH b AS (SELECT * FROM v_service_line WHERE project_key = :project_key AND ${scFilter()}),
${SC_TOW_ORDER_SQL},
vt AS (
  SELECT vendor_key, tow,
         ROW_NUMBER() OVER (PARTITION BY vendor_key ORDER BY SUM(CASE WHEN report_bucket <> 'PENDING' THEN a ELSE 0 END) DESC, tow) AS rn
  FROM b GROUP BY vendor_key, tow
),
g AS (
  SELECT vendor_key, MAX(vendor_name) AS vendor_name, MAX(vendor_code) AS vendor_code, COUNT(DISTINCT po_no) AS pos,
         COUNT(DISTINCT CASE WHEN ${SC_PREV} THEN certificate_id END) AS prev_c, ${scA(SC_PREV)} AS prev_a,
         COUNT(DISTINCT CASE WHEN ${SC_CUR} THEN certificate_id END) AS cur_c, ${scA(SC_CUR)} AS cur_a,
         COUNT(DISTINCT CASE WHEN ${SC_TD} THEN certificate_id END) AS td_c, ${scA(SC_TD)} AS td_a,
         COUNT(DISTINCT CASE WHEN ${SC_PEND} THEN certificate_id END) AS pend_c, ${scA(SC_PEND)} AS pend_a
  FROM b GROUP BY vendor_key
)
SELECT vt.tow AS type_of_works, g.vendor_code AS supplier_code, g.vendor_name AS subcontractor, g.pos AS purchase_orders,
       g.prev_c AS previous_certificates, g.prev_a AS previous_amount,
       g.cur_c AS month_certificates, g.cur_a AS month_amount,
       g.td_c AS todate_certificates, g.td_a AS todate_amount,
       ROUND(100.0 * g.td_a / NULLIF(SUM(g.td_a) OVER (), 0), 1) AS pct_of_all,
       g.pend_c AS pending_certificates, g.pend_a AS pending_amount,
       g.vendor_key AS vendor_key
FROM g LEFT JOIN vt ON vt.vendor_key IS g.vendor_key AND vt.rn = 1
       LEFT JOIN tow_ord o ON o.tow = vt.tow
ORDER BY COALESCE(o.sort_order, 1000000), SUM(g.td_a) OVER (PARTITION BY vt.tow) DESC, vt.tow, g.td_a DESC, g.vendor_name`,
  },
  {
    code: 'SC_SHEET_LINES',
    name: 'Lines: every certificate line',
    module: 'SERVICE',
    category: 'Sheet',
    description: 'The Data sheet: every certificate line (counted and pending), with the cut-off bucket, pending reason, line type, '
      + 'report qty / rate / amount and the SAP figures it was derived from. Takes the filter bar params plus the drill-down '
      + 'keys :service_code + :service_norm and :po_no (a "~" prefix is stripped). At most 20,000 rows.',
    params: [P_PROJECT, ...P_SC_FILTERS, ...P_SC_DRILL],
    viz: { kind: 'table' },
    sql: `
WITH u AS ${SC_PO_UOM_SQL},
${SC_TOW_ORDER_SQL}
SELECT s.tow AS type_of_works, s.service_code AS service, s.service_text AS description,
       ${SC_UNIT_SQL('s.service_code', 's.service_text', 'u.uom')} AS unit,
       s.work_package AS div,
       ${SC_PERIOD_LABEL_SQL.replace(/report_bucket/g, 's.report_bucket').replace(/period_key/g, 's.period_key')} AS period,
       SUBSTR(s.eff_date, 1, 10) AS cert_date, s.vendor_name AS subcontractor, s.po_no AS po,
       COALESCE(NULLIF(s.invoice_serial, ''), s.invoice_no) AS certificate,
       s.report_qty AS qty, ${scRate('s.a', 's.report_qty')} AS rate, s.a AS amount,
       s.line_class AS line_type, s.pend_reason AS pending_reason,
       CASE WHEN COALESCE(s.is_approved, 1) = 0 THEN 'No' ELSE 'Yes' END AS approved,
       s.vendor_code AS supplier_code, s.q AS sap_qty, s.unit_rate AS gross_price, s.contract_type,
       s.tax_code, s.net_rate, s.progress_pct, s.amount_vat AS vat,
       CASE s.resource_code WHEN 'S' THEN 'Subcontract' WHEN 'L' THEN 'Labour' WHEN 'P' THEN 'Plant' ELSE 'Other' END AS resource,
       s.wbs_code, s.profit_center
FROM v_service_line s
LEFT JOIN u ON u.service_code = s.service_code
LEFT JOIN tow_ord o ON o.tow = s.tow
WHERE s.project_key = :project_key AND ${scFilter('s.')}
  AND (:service_code IS NULL OR s.service_code = ${scParam('service_code')})
  AND (:service_norm IS NULL OR s.service_text_norm = ${scParam('service_norm')})
  AND (:po_no IS NULL OR s.po_no = ${scParam('po_no')})
ORDER BY COALESCE(o.sort_order, 1000000), s.tow, s.service_code, s.service_text_norm, COALESCE(s.eff_date, ''), s.service_line_id
LIMIT 20000`,
  },
  {
    code: 'BUILD_STATUS',
    name: 'Build steps: status',
    module: 'CROSS',
    category: 'Build',
    description: 'One row per build step of the project: Complete, Behind cut-off, Needs action, Ready to load, '
      + 'Waiting, Optional or Not available. Steps, dependencies and report inputs are data (build_step, '
      + 'build_step_dependency, report_input); the status is computed here from the batches that landed on '
      + 'the project (v_project_batch), the project cut-off, the settled orders still without detail (B05), '
      + 'GLs resolving to Other (B11), unallocated cost (B12) and services without an MNL decision (B18). '
      + 'Waiting is applied last. depends_on and feeds (report pages) fill the detail panel.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
WITH ${BUILD_STATUS_SQL}
SELECT step_code, name, group_label, sort_order, kind, status, data_date, latest_posting, lines, summary,
       action_label, action_target, is_optional, is_conditional, has_data, depends_on, feeds,
       (SELECT s.module FROM build_step s WHERE s.code = bs_final.step_code) AS module,
       -- the report a Home card opens the upload wizard on (the first one that loads the step)
       (SELECT MIN(r.report_definition_id) FROM build_step_report r WHERE r.step_code = bs_final.step_code) AS report_definition_id
FROM bs_final
ORDER BY sort_order`,
  },
  {
    code: 'BUILD_TIMELINE',
    name: 'Build steps: file timeline',
    module: 'CROSS',
    category: 'Build',
    description: 'One row per posted file of an upload step that landed on the project: the first and last date it '
      + 'covers on the project (posting date, certificate date or document date, else the period start / end) and '
      + 'its line count. A file with no dates inside (WBS, budget, material list, PO service lines) has NULL dates '
      + 'and is drawn at its data date. Posting merges by line identity, so an older file shows only the lines it '
      + 'still owns after a newer, overlapping one. Drawn as the Gantt bars on Home.',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
WITH pb AS (
  SELECT sr.step_code, b.import_batch_id, b.file_name, b.data_date
  FROM build_step_report sr
  JOIN import_batch b ON b.report_definition_id = sr.report_definition_id AND b.status = 'POSTED'
  JOIN v_project_batch v ON v.import_batch_id = b.import_batch_id AND v.project_key = :project_key
),
d AS (
  SELECT f.import_batch_id,
         COALESCE(CASE WHEN f.posting_date_key > 0 THEN printf('%04d-%02d-%02d', f.posting_date_key / 10000, (f.posting_date_key / 100) % 100, f.posting_date_key % 100) END, p.start_date) AS lo,
         COALESCE(CASE WHEN f.posting_date_key > 0 THEN printf('%04d-%02d-%02d', f.posting_date_key / 10000, (f.posting_date_key / 100) % 100, f.posting_date_key % 100) END, p.end_date) AS hi
  FROM fact_actual f LEFT JOIN dim_period p ON p.period_key = f.period_key WHERE f.project_key = :project_key
  UNION ALL
  SELECT f.import_batch_id,
         COALESCE(CASE WHEN f.invoice_date_key > 0 THEN printf('%04d-%02d-%02d', f.invoice_date_key / 10000, (f.invoice_date_key / 100) % 100, f.invoice_date_key % 100) END, p.start_date),
         COALESCE(CASE WHEN f.invoice_date_key > 0 THEN printf('%04d-%02d-%02d', f.invoice_date_key / 10000, (f.invoice_date_key / 100) % 100, f.invoice_date_key % 100) END, p.end_date)
  FROM fact_service_line f LEFT JOIN dim_period p ON p.period_key = f.period_key WHERE f.project_key = :project_key
  UNION ALL
  SELECT f.import_batch_id,
         CASE WHEN f.posting_date_key > 0 THEN printf('%04d-%02d-%02d', f.posting_date_key / 10000, (f.posting_date_key / 100) % 100, f.posting_date_key % 100) END,
         CASE WHEN f.posting_date_key > 0 THEN printf('%04d-%02d-%02d', f.posting_date_key / 10000, (f.posting_date_key / 100) % 100, f.posting_date_key % 100) END
  FROM fact_material_issue f WHERE f.project_key = :project_key
  UNION ALL
  SELECT f.import_batch_id, p.start_date, p.end_date
  FROM fact_order_line f LEFT JOIN dim_period p ON p.period_key = f.period_key WHERE f.project_key = :project_key
  UNION ALL
  SELECT f.import_batch_id,
         CASE WHEN f.document_date_key > 0 THEN printf('%04d-%02d-%02d', f.document_date_key / 10000, (f.document_date_key / 100) % 100, f.document_date_key % 100) END,
         CASE WHEN f.document_date_key > 0 THEN printf('%04d-%02d-%02d', f.document_date_key / 10000, (f.document_date_key / 100) % 100, f.document_date_key % 100) END
  FROM fact_po_material_line f WHERE f.project_key = :project_key
),
rng AS (SELECT import_batch_id, MIN(lo) AS date_from, MAX(hi) AS date_to, COUNT(*) AS lines FROM d GROUP BY import_batch_id)
SELECT pb.step_code, pb.import_batch_id, pb.file_name, pb.data_date, r.date_from, r.date_to, COALESCE(r.lines, 0) AS lines
FROM pb LEFT JOIN rng r ON r.import_batch_id = pb.import_batch_id
ORDER BY pb.step_code, COALESCE(r.date_from, pb.data_date), pb.import_batch_id`,
  },
  {
    code: 'BUILD_CHECKS',
    name: 'Build steps: checks',
    module: 'CROSS',
    category: 'Build',
    description: 'The detail panel of each build step as (step_code, level, message) rows, level ok / warn / todo: '
      + 'the step\'s own status line, then what the app already knows - lines held back by the cut-off, '
      + 'rejected rows, settled orders without detail, GLs resolving to Other, unallocated cost, services '
      + 'without an MNL decision and the CJI3 cost set aside against each detail source. The warnings of '
      + 'SC_CHECKS (B07) and MAT_CHECKS (B06) are fetched by Home only when that step is selected (seconds on real data).',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
WITH ${BUILD_STATUS_SQL},
bs_recon AS MATERIALIZED (
  -- one pass over each view (a read per source cost a second each on real data)
  SELECT x.source, COALESCE(sa.amt, 0) AS aside, COALESCE(dc.amt, 0) AS detail
  FROM (SELECT 'CERT' AS source UNION ALL SELECT 'MB51' UNION ALL SELECT 'ORDER') x
  LEFT JOIN (SELECT aside_source AS source, SUM(amount) AS amt FROM v_actual_set_aside
              WHERE project_key = :project_key GROUP BY aside_source) sa ON sa.source = x.source
  LEFT JOIN (SELECT source, SUM(amount) AS amt FROM v_actual_cost
              WHERE project_key = :project_key GROUP BY source) dc ON dc.source = x.source
),
bchk AS (
  -- the step's own status line
  SELECT step_code,
         CASE status WHEN 'Complete' THEN 'ok' WHEN 'Behind cut-off' THEN 'warn'
                     WHEN 'Optional' THEN 'ok' WHEN 'Not available' THEN 'ok' ELSE 'todo' END AS level,
         summary AS message
  FROM bs_final
  UNION ALL
  SELECT step_code, 'todo', 'A file is staged and not posted - post it from Upload data'
  FROM bs_final WHERE staged > 0 AND status <> 'Waiting'
  UNION ALL
  SELECT 'B04', 'warn', n || ' cost lines (' || printf('%,d', CAST(ROUND(amt, 0) AS INTEGER)) || ') are after the cut-off and not counted'
  FROM bs_held WHERE n > 0
  UNION ALL
  SELECT f.step_code, 'warn', b.row_count_rejected || ' rows of the latest file were rejected'
  FROM bs_final f JOIN bs_last l ON l.step_code = f.step_code
  JOIN import_batch b ON b.import_batch_id = l.last_id
  WHERE b.row_count_rejected > 0
  UNION ALL
  SELECT 'B05', 'todo', (SELECT missing FROM bs_orders) || ' settled orders (' || printf('%,d', CAST(ROUND((SELECT missing_amt FROM bs_orders), 0) AS INTEGER))
         || ') have no order detail - their CJI3 posting stays in the actual'
  WHERE (SELECT missing FROM bs_orders) > 0
  UNION ALL
  SELECT 'B05', 'ok', 'Every settled order has its detail loaded' WHERE (SELECT orders FROM bs_orders) > 0 AND (SELECT missing FROM bs_orders) = 0
  UNION ALL
  SELECT 'B11', 'todo', 'GL accounts resolving to Other: ' || (SELECT codes FROM bs_other_list)
         || CASE WHEN (SELECT gls FROM bs_other) > 5 THEN ' and ' || ((SELECT gls FROM bs_other) - 5) || ' more' ELSE '' END
  WHERE (SELECT gls FROM bs_other) > 0
  UNION ALL
  SELECT 'B12', 'todo', 'Unallocated cost ' || printf('%,d', CAST(ROUND((SELECT unalloc FROM bs_code), 0) AS INTEGER))
         || ' - code materials, service items and GLs in Work packages'
  WHERE (SELECT unalloc FROM bs_code) > 0.005
  UNION ALL
  SELECT 'B18', 'todo', (SELECT unreviewed FROM bs_svc) || ' certificate services have no MNL decision (default SUB)'
  WHERE (SELECT unreviewed FROM bs_svc) > 0
  UNION ALL
  SELECT CASE r.source WHEN 'CERT' THEN 'B07' WHEN 'MB51' THEN 'B06' ELSE 'B05' END,
         CASE WHEN ABS(r.detail - r.aside) < 1 THEN 'ok' ELSE 'warn' END,
         CASE WHEN ABS(r.detail - r.aside) < 1
                THEN 'Detail equals the CJI3 cost it replaces (' || printf('%,d', CAST(ROUND(r.aside, 0) AS INTEGER)) || ')'
              ELSE 'CJI3 cost set aside ' || printf('%,d', CAST(ROUND(r.aside, 0) AS INTEGER)) || ' against detail ' || printf('%,d', CAST(ROUND(r.detail, 0) AS INTEGER))
                   || ' (difference ' || printf('%,d', CAST(ROUND(r.detail - r.aside, 0) AS INTEGER)) || ') - timing or not yet in the detail' END
  FROM bs_recon r WHERE r.aside <> 0 OR r.detail <> 0
)
SELECT step_code, level, message FROM bchk
ORDER BY (SELECT sort_order FROM build_step WHERE code = bchk.step_code),
         CASE level WHEN 'todo' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END`,
  },
  {
    code: 'REPORT_READINESS',
    name: 'Reports: readiness',
    module: 'CROSS',
    category: 'Build',
    description: 'One row per report page that has report_input rows: Ready, Builds with gaps, Behind cut-off or '
      + 'Waiting. Waiting = a required input has nothing loaded; Behind cut-off = a required input is behind; '
      + 'Builds with gaps = a required coding step needs action or an input that improves the report is not '
      + 'loaded (an unavailable or conditional step is never a gap). missing is a plain sentence. (The '
      + 'SC_CHECKS / MAT_CHECKS warning counts were dropped: they cost seconds on real data and no page showed them.)',
    params: [P_PROJECT],
    viz: { kind: 'table' },
    sql: `
WITH ${BUILD_STATUS_SQL},
rs AS (
  SELECT ri.report_page, ri.role, f.step_code, f.name, f.status, f.has_data,
         CASE WHEN ri.role = 'improves' AND f.is_planned = 0 AND f.kind = 'upload' AND f.has_data = 0
                   AND NOT (f.is_conditional = 1 AND f.status = 'Optional') THEN 1 ELSE 0 END AS is_gap
  FROM report_input ri JOIN bs_final f ON f.step_code = ri.step_code
),
pg AS (
  SELECT report_page,
    SUM(CASE WHEN role = 'required' AND has_data = 0 THEN 1 ELSE 0 END) AS n_missing,
    SUM(CASE WHEN role = 'required' AND status = 'Behind cut-off' THEN 1 ELSE 0 END) AS n_behind,
    SUM(CASE WHEN role = 'required' AND has_data = 1 AND status = 'Needs action' THEN 1 ELSE 0 END) AS n_action,
    SUM(is_gap) AS n_gap,
    GROUP_CONCAT(CASE WHEN role = 'required' AND has_data = 0 THEN step_code || ' ' || name END, ', ') AS l_missing,
    GROUP_CONCAT(CASE WHEN role = 'required' AND status = 'Behind cut-off' THEN step_code || ' ' || name END, ', ') AS l_behind,
    GROUP_CONCAT(CASE WHEN role = 'required' AND has_data = 1 AND status = 'Needs action' THEN step_code || ' ' || name END, ', ') AS l_action,
    GROUP_CONCAT(CASE WHEN is_gap = 1 THEN step_code || ' ' || name END, ', ') AS l_gap,
    GROUP_CONCAT(CASE WHEN role = 'required' THEN step_code END, ',') AS required_steps,
    GROUP_CONCAT(CASE WHEN role = 'improves' THEN step_code END, ',') AS improves_steps
  FROM rs GROUP BY report_page
),
st AS (
  SELECT report_page,
    CASE WHEN n_missing > 0 THEN 'Waiting'
         WHEN n_behind > 0 THEN 'Behind cut-off'
         WHEN n_action > 0 OR n_gap > 0 THEN 'Builds with gaps'
         ELSE 'Ready' END AS status,
    TRIM(
      CASE WHEN n_missing > 0 THEN 'Needs ' || l_missing || '. ' ELSE '' END
      || CASE WHEN n_behind > 0 THEN 'Behind the cut-off: ' || l_behind || '. ' ELSE '' END
      || CASE WHEN n_action > 0 THEN 'Needs action: ' || l_action || '. ' ELSE '' END
      || CASE WHEN n_gap > 0 THEN 'Improves with ' || l_gap || '.' ELSE '' END) AS missing,
    required_steps, improves_steps
  FROM pg
)
SELECT report_page,
       CASE report_page WHEN 'dashboard' THEN 'Project dashboard' WHEN 'reports' THEN 'Actual cost'
            WHEN 'costreport' THEN 'Cost report' WHEN 'subcontractor' THEN 'Subcontractors'
            WHEN 'material' THEN 'Materials' ELSE report_page END AS label,
       status, missing, required_steps, improves_steps
FROM st
ORDER BY CASE report_page WHEN 'dashboard' THEN 0 WHEN 'reports' THEN 1 WHEN 'costreport' THEN 2
                          WHEN 'subcontractor' THEN 3 WHEN 'material' THEN 4 ELSE 9 END`,
  },
  ...MATERIAL_QUERIES,
];
