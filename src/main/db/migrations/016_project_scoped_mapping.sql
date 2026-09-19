-- =============================================================================
-- Work-package mapping becomes project-scoped.
--
-- material_work_package / cost_element_work_package / service_work_package
-- carried no project_key at all, so an assignment made while coding one
-- project silently applied to every project in the database — wrong: two
-- projects routinely code the exact same material or GL account into
-- different packages, and the whole workflow is "code one project's cost
-- register at a time," never "code the warehouse."
--
-- dim_work_package (the package catalog itself — DIV03 Concrete, INDIRECT,
-- ...) stays a shared, global taxonomy, unaffected here; only the three
-- mapping tables that decide which package a given material/cost element/
-- service item resolves to are being re-keyed by project.
--
-- Existing assignments are carried forward to EVERY project already in the
-- database rather than dropped, so nothing already coded is lost — each
-- project starts from today's shared mapping as its own baseline and
-- diverges from there as it's coded going forward.
--
-- This rebuilds three tables and every view that resolves a work package
-- off them, so it manages its own transaction (see MIGRATIONS in
-- src/main/db/index.ts).
-- =============================================================================

PRAGMA foreign_keys = OFF;

BEGIN;

DROP VIEW IF EXISTS v_revenue;
DROP VIEW IF EXISTS v_actual;
DROP VIEW IF EXISTS v_posting;
DROP VIEW IF EXISTS v_service_line;
DROP VIEW IF EXISTS v_accrual;

CREATE TABLE material_work_package_new (
  project_key   INTEGER NOT NULL REFERENCES dim_project(project_key),
  material_code TEXT NOT NULL REFERENCES dim_material(material_code),
  work_package  TEXT NOT NULL REFERENCES dim_work_package(code),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_key, material_code)
);
INSERT INTO material_work_package_new (project_key, material_code, work_package, created_at)
  SELECT p.project_key, m.material_code, m.work_package, m.created_at
  FROM material_work_package m CROSS JOIN dim_project p;
DROP TABLE material_work_package;
ALTER TABLE material_work_package_new RENAME TO material_work_package;

CREATE TABLE cost_element_work_package_new (
  project_key       INTEGER NOT NULL REFERENCES dim_project(project_key),
  cost_element_code TEXT NOT NULL REFERENCES dim_cost_element(cost_element_code),
  work_package      TEXT NOT NULL REFERENCES dim_work_package(code),
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_key, cost_element_code)
);
INSERT INTO cost_element_work_package_new (project_key, cost_element_code, work_package, created_at)
  SELECT p.project_key, m.cost_element_code, m.work_package, m.created_at
  FROM cost_element_work_package m CROSS JOIN dim_project p;
DROP TABLE cost_element_work_package;
ALTER TABLE cost_element_work_package_new RENAME TO cost_element_work_package;

CREATE TABLE service_work_package_new (
  project_key  INTEGER NOT NULL REFERENCES dim_project(project_key),
  service_code TEXT NOT NULL DEFAULT '',
  service_text TEXT NOT NULL DEFAULT '',
  work_package TEXT NOT NULL REFERENCES dim_work_package(code),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_key, service_code, service_text)
);
INSERT INTO service_work_package_new (project_key, service_code, service_text, work_package, created_at)
  SELECT p.project_key, m.service_code, m.service_text, m.work_package, m.created_at
  FROM service_work_package m CROSS JOIN dim_project p;
DROP TABLE service_work_package;
ALTER TABLE service_work_package_new RENAME TO service_work_package;

-- Identical to 014_material.sql's v_posting, except both correlated
-- work_package subqueries now also match on project_key.
CREATE VIEW v_posting AS
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

-- Identical to 013_work_package_rework.sql's v_service_line, except the
-- work_package subquery now also matches on project_key.
CREATE VIEW v_service_line AS
SELECT
  f.service_line_id, f.import_batch_id, b.data_date,
  rd.report_definition_id, rd.code AS report_code, rd.name AS report_name,
  p.project_key, p.project_code, p.project_name,
  w.wbs_key, w.wbs_code, w.wbs_name, w.wbs_path,
  ce.cost_element_key, ce.cost_element_code, ce.cost_element_name,
  CASE
    WHEN COALESCE(ce.posting_nature,'COST') = 'REVENUE' THEN NULL
    WHEN ce.cost_type IS NOT NULL AND ce.cost_type <> 'OTHER' THEN ce.cost_type
    ELSE COALESCE(
      (SELECT r.cost_type FROM cost_type_rule r
        WHERE r.is_active = 1
          AND r.document_type_glob IS NULL
          AND (r.cost_element_glob IS NULL OR ce.cost_element_code GLOB r.cost_element_glob)
        ORDER BY r.priority, r.rule_id
        LIMIT 1),
      ce.cost_type)
  END AS cost_type,
  (SELECT m.work_package FROM service_work_package m
    WHERE m.project_key = p.project_key
      AND m.service_code = COALESCE(f.service_code,'')
      AND m.service_text = COALESCE(f.service_text,'')) AS work_package,
  v.vendor_key, v.vendor_code, v.vendor_name,
  f.period_key, f.po_no, f.invoice_no, f.entry_sheet_no, f.invoice_serial,
  f.item_no, f.line_no, f.service_code, f.service_text, f.category, f.contract_type,
  f.uom, f.unit_rate, f.quantity_total, f.quantity_previous, f.quantity_current,
  f.progress_pct, f.amount_net, f.amount_vat, f.amount_gross
FROM fact_service_line f
JOIN import_batch b ON b.import_batch_id = f.import_batch_id
JOIN report_definition rd ON rd.report_definition_id = b.report_definition_id
JOIN dim_project p  ON p.project_key = f.project_key
LEFT JOIN dim_wbs w ON w.wbs_key = f.wbs_key
LEFT JOIN dim_cost_element ce ON ce.cost_element_key = f.cost_element_key
LEFT JOIN dim_vendor v ON v.vendor_key = f.vendor_key
WHERE b.status = 'POSTED';

-- Identical to 013_work_package_rework.sql's v_accrual, except the
-- work_package subquery now also matches on project_key.
CREATE VIEW v_accrual AS
SELECT
  f.accrual_id, f.import_batch_id, b.data_date,
  p.project_key, p.project_code, p.project_name,
  w.wbs_key, w.wbs_code, w.wbs_name, w.wbs_path, w.discipline, w.package,
  ce.cost_element_key, ce.cost_element_code, ce.cost_element_name, ce.cost_type,
  COALESCE(
    (SELECT m.work_package FROM cost_element_work_package m
      WHERE m.project_key = p.project_key AND m.cost_element_code = ce.cost_element_code),
    CASE WHEN ce.cost_type <> 'MATERIAL' THEN 'INDIRECT' ELSE NULL END) AS work_package,
  f.period_key, f.accrual_type, f.amount, f.description
FROM fact_accrual f
JOIN import_batch b ON b.import_batch_id = f.import_batch_id
JOIN dim_project p  ON p.project_key = f.project_key
LEFT JOIN dim_wbs w ON w.wbs_key = f.wbs_key
LEFT JOIN dim_cost_element ce ON ce.cost_element_key = f.cost_element_key
WHERE b.status = 'POSTED';

COMMIT;

PRAGMA foreign_keys = ON;
