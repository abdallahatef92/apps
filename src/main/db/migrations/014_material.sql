-- =============================================================================
-- The real material identity: SAP's material number (MATNR), carried in
-- CJI3's own "Material" column — separate from "Cost Element" (the GL
-- account). This was missing entirely: the target-field list had no
-- canonical field for it, so a real file's Material column was simply left
-- unmapped and dropped on upload, and 013_work_package_rework.sql wrongly
-- assumed "a CO line item carries no separate material number" — several
-- distinct materials commonly post to the same broad GL account (e.g.
-- "Cement & aggregates"), so work-package coding built on the GL account
-- was conflating materials that need to be coded separately.
--
-- dim_material mirrors dim_vendor exactly — a master-data identity with a
-- code and a name, referenced from fact_actual by key. material_work_package
-- is the MATERIAL-cost-type equivalent of service_work_package: one exact
-- row per real material, no GLOB, no priority. cost_element_work_package
-- (from 013) now serves only the Other tab (labor/equipment/indirect/other
-- cost types) — it stops being used for MATERIAL.
--
-- A MATERIAL line with no material_code (an older extract, or the column
-- left blank) still can't be package-coded — it stays unallocated, the same
-- treatment a subcontract PO with no detail loaded already gets. It never
-- falls back to INDIRECT: material must be genuinely coded, not defaulted.
-- =============================================================================

CREATE TABLE dim_material (
  material_key  INTEGER PRIMARY KEY,
  material_code TEXT NOT NULL UNIQUE,
  material_name TEXT NOT NULL
);

ALTER TABLE fact_actual ADD COLUMN material_key INTEGER REFERENCES dim_material(material_key);

CREATE TABLE material_work_package (
  material_code TEXT PRIMARY KEY REFERENCES dim_material(material_code),
  work_package  TEXT NOT NULL REFERENCES dim_work_package(code),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

DROP VIEW IF EXISTS v_revenue;
DROP VIEW IF EXISTS v_actual;
DROP VIEW IF EXISTS v_posting;

CREATE VIEW v_posting AS
SELECT
  p.*,
  CASE
    WHEN p.cost_type = 'SUBCONTRACT' THEN NULL  -- resolved off v_service_line detail instead
    WHEN p.cost_type = 'MATERIAL' THEN
      (SELECT m.work_package FROM material_work_package m WHERE m.material_code = p.material_code)
    ELSE COALESCE(
      (SELECT m.work_package FROM cost_element_work_package m
        WHERE m.cost_element_code = p.cost_element_code),
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
    f.quantity, f.uom, f.amount
  FROM fact_actual f
  JOIN import_batch b   ON b.import_batch_id = f.import_batch_id
  JOIN dim_project p    ON p.project_key = f.project_key
  LEFT JOIN dim_wbs w   ON w.wbs_key = f.wbs_key
  LEFT JOIN dim_cost_element ce ON ce.cost_element_key = f.cost_element_key
  LEFT JOIN dim_material mat ON mat.material_key = f.material_key
  LEFT JOIN dim_vendor v ON v.vendor_key = f.vendor_key
  LEFT JOIN dim_currency cur ON cur.currency_key = f.currency_key
  LEFT JOIN dim_period d ON d.period_key = f.period_key
  WHERE b.status = 'POSTED'
) p;

CREATE VIEW v_actual AS
SELECT * FROM v_posting WHERE posting_nature = 'COST';

CREATE VIEW v_revenue AS
SELECT
  actual_id, import_batch_id, data_date, project_key, project_code, project_name,
  wbs_key, wbs_code, wbs_name, wbs_path,
  cost_element_key, cost_element_code, cost_element_name,
  period_key, year_no, month_no, document_no, document_type, description,
  -amount AS amount
FROM v_posting WHERE posting_nature = 'REVENUE';
