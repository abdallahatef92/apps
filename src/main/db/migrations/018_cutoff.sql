-- =============================================================================
-- Project cut-off date (docs/flow-redesign.md, "Cut-off date").
--
-- One cut-off per project. A posted actual line counts when its SAP posting
-- date is on or before the cut-off; a line without a posting date falls back
-- to its period's end date. No row / NULL cut-off = everything counts.
--
-- The cut-off is applied inside v_posting, so v_actual, v_revenue and every
-- report reading them respect it with no query changes. Lines after the
-- cut-off stay in fact_actual untouched. v_posting_all is the same view
-- without the cut-off, for status queries that count what is held back —
-- reports never read it. v_posting is defined as a filter over v_posting_all
-- so the two can never drift apart.
--
-- Not cut off (yet): v_service_line, v_order_line, v_accrual, budget/forecast.
--
-- The only views that read v_posting are v_actual and v_revenue (checked
-- across every migration through 017); both are recreated unchanged.
-- =============================================================================

CREATE TABLE project_cutoff (
  project_key INTEGER PRIMARY KEY REFERENCES dim_project(project_key),
  cutoff_date TEXT,                                   -- ISO 'YYYY-MM-DD'
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

DROP VIEW IF EXISTS v_revenue;
DROP VIEW IF EXISTS v_actual;
DROP VIEW IF EXISTS v_posting;
DROP VIEW IF EXISTS v_posting_all;

-- Identical to 016_project_scoped_mapping.sql's v_posting, except it also
-- exposes posting_date (ISO, NULL when the line has none) and
-- period_end_date (the line's period end), the two inputs of the cut-off.
CREATE VIEW v_posting_all AS
SELECT
  p.*,
  CASE
    WHEN p.cost_type = 'SUBCONTRACT' THEN NULL  -- resolved off v_service_line detail instead
    WHEN p.cost_type = 'MATERIAL' THEN
      (SELECT m.work_package FROM material_work_package m
        WHERE m.project_key = p.project_key AND m.material_code = p.material_code)
    ELSE COALESCE(
      (SELECT m.work_package FROM cost_element_work_package m
        WHERE m.project_key = p.project_key AND m.cost_element_code = p.cost_element_code),
      CASE WHEN p.cost_type IS NOT NULL THEN 'INDIRECT' ELSE NULL END)
  END AS work_package
FROM (
  SELECT
    f.actual_id, f.import_batch_id, f.line_uid, b.data_date, b.report_definition_id,
    p.project_key, p.project_code, p.project_name,
    w.wbs_key, w.wbs_code, w.wbs_name, w.wbs_path, w.wbs_level,
    w.discipline, w.package, w.control_account,
    ce.cost_element_key, ce.cost_element_code, ce.cost_element_name,
    mat.material_key, mat.material_code, mat.material_name,
    CASE
      WHEN COALESCE(ce.posting_nature,'COST') = 'REVENUE' THEN NULL
      WHEN ce.cost_type IS NOT NULL AND ce.cost_type <> 'OTHER' THEN ce.cost_type
      ELSE COALESCE(
        (SELECT r.cost_type FROM cost_type_rule r
          WHERE r.is_active = 1
            AND (r.cost_element_glob  IS NULL OR ce.cost_element_code        GLOB r.cost_element_glob)
            AND (r.document_type_glob IS NULL OR COALESCE(f.document_type,'') GLOB r.document_type_glob)
          ORDER BY r.priority, r.rule_id
          LIMIT 1),
        ce.cost_type)
    END AS cost_type,
    COALESCE(ce.posting_nature,'COST') AS posting_nature,
    v.vendor_key, v.vendor_code, v.vendor_name,
    cur.iso_code AS currency_code,
    f.period_key, f.fiscal_year, d.year_no, d.month_no,
    f.document_no, f.document_line, f.document_type, f.reference_no, f.po_no, f.description,
    f.partner_object_type, f.partner_object, f.partner_object_name,
    f.quantity, f.uom, f.amount,
    COALESCE(pd.full_date,
      CASE WHEN f.posting_date_key IS NOT NULL THEN
        printf('%04d-%02d-%02d', f.posting_date_key / 10000,
               (f.posting_date_key / 100) % 100, f.posting_date_key % 100)
      END) AS posting_date,
    d.end_date AS period_end_date
  FROM fact_actual f
  JOIN import_batch b   ON b.import_batch_id = f.import_batch_id
  JOIN dim_project p    ON p.project_key = f.project_key
  LEFT JOIN dim_wbs w   ON w.wbs_key = f.wbs_key
  LEFT JOIN dim_cost_element ce ON ce.cost_element_key = f.cost_element_key
  LEFT JOIN dim_material mat ON mat.material_key = f.material_key
  LEFT JOIN dim_vendor v ON v.vendor_key = f.vendor_key
  LEFT JOIN dim_currency cur ON cur.currency_key = f.currency_key
  LEFT JOIN dim_period d ON d.period_key = f.period_key
  LEFT JOIN dim_date pd  ON pd.date_key = f.posting_date_key
  WHERE b.status = 'POSTED'
) p;

-- The reporting view: v_posting_all held to the project's cut-off.
CREATE VIEW v_posting AS
SELECT a.*
FROM v_posting_all a
LEFT JOIN project_cutoff pc ON pc.project_key = a.project_key
WHERE pc.cutoff_date IS NULL
   OR COALESCE(a.posting_date, a.period_end_date) <= pc.cutoff_date;

-- Unchanged from 016_project_scoped_mapping.sql.
CREATE VIEW v_actual AS
SELECT * FROM v_posting WHERE posting_nature = 'COST';

-- Unchanged from 016_project_scoped_mapping.sql.
CREATE VIEW v_revenue AS
SELECT
  actual_id, import_batch_id, data_date, project_key, project_code, project_name,
  wbs_key, wbs_code, wbs_name, wbs_path,
  cost_element_key, cost_element_code, cost_element_name,
  period_key, year_no, month_no, document_no, document_type, description,
  -amount AS amount
FROM v_posting WHERE posting_nature = 'REVENUE';
