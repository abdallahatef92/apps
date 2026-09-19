-- =============================================================================
-- Work packages: a coding layer over actual/budget, not a WBS attribute.
--
-- dim_wbs.package (a free-text field on the WBS master) turned out to be the
-- wrong idea — the real requirement is that every actual cost line gets
-- individually classified into a named work package (masonry, concrete,
-- earthwork, …), the same "resolved in the view, never baked into the
-- dimension" treatment cost_type already gets.
--
-- The mapping key is the line's own identity, not its GL account's pattern or
-- its WBS location (an earlier draft of this migration tried a GLOB rule
-- table keyed on cost_element/wbs — wrong; superseded here before it ever
-- shipped anywhere). Concretely, per cost type:
--   - MATERIAL: a CO line item carries no separate material number — the
--     cost element (GL account) itself is the material's identity here — so
--     `cost_element_work_package` maps one exact cost_element_code to a
--     package.
--   - SUBCONTRACT: the GL account a PO posts to is usually one generic
--     subcontract account shared by many different service items, so the
--     package identity lives one level down, on the PO's own detail report —
--     `service_work_package` maps the unique (service_code, service_text)
--     pair from `fact_service_line`, not the cost element.
--   - Everything else (labor, equipment, indirect, other) defaults to the
--     seeded `INDIRECT` work package — the same undeletable catch-all role
--     `cost_type`'s `OTHER` plays — but stays reviewable via
--     `cost_element_work_package` too, so a line that's really package work
--     miscoded under another cost type can still be pulled out.
--   - BUDGET already carries its own package code column in the source file
--     (the same "Cost Code" column that sits next to "Package" in the
--     workbook) — it is mapped directly on upload, not resolved by a lookup.
--
-- Work packages carry no seed rows except the INDIRECT catch-all — real
-- packages are entirely project-specific, defined by the user on the
-- dedicated Work packages page (not Settings — this is a recurring
-- classification workflow, not an admin setting).
--
-- This migration adds tables, an ALTER TABLE column on fact_budget, and
-- touches the views that need the new resolved column — it does not rebuild
-- any existing table, so it does not need PRAGMA foreign_keys handling the
-- way 003/010 did.
-- =============================================================================

CREATE TABLE dim_work_package (
  code        TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  group_label TEXT,
  icon        TEXT NOT NULL DEFAULT '📦',
  color       TEXT NOT NULL DEFAULT '#9aa5b1',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_system   INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0,1)),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO dim_work_package (code, label, group_label, icon, color, sort_order, is_system) VALUES
  ('INDIRECT', 'Indirect', NULL, '🗂️', '#9aa5b1', 999, 1);

-- One exact row per material (or "other") cost element — no GLOB, no
-- priority: a cost element either has an answer or it doesn't.
CREATE TABLE cost_element_work_package (
  cost_element_code TEXT PRIMARY KEY REFERENCES dim_cost_element(cost_element_code),
  work_package      TEXT NOT NULL REFERENCES dim_work_package(code),
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One exact row per unique subcontract service item.
CREATE TABLE service_work_package (
  service_code TEXT NOT NULL DEFAULT '',
  service_text TEXT NOT NULL DEFAULT '',
  work_package TEXT NOT NULL REFERENCES dim_work_package(code),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (service_code, service_text)
);

-- Budget states its own package code directly (mapped on upload), the same
-- way it states wbs_code/cost_element_code — no lookup needed.
ALTER TABLE fact_budget ADD COLUMN work_package TEXT;

DROP VIEW IF EXISTS v_revenue;
DROP VIEW IF EXISTS v_actual;
DROP VIEW IF EXISTS v_posting;
DROP VIEW IF EXISTS v_budget;
DROP VIEW IF EXISTS v_service_line;

-- v_posting is built as an outer SELECT over an inner one so work_package can
-- reference the already-resolved cost_type column (a flat SELECT can't
-- reference a sibling computed alias from within the same SELECT list).
CREATE VIEW v_posting AS
SELECT
  p.*,
  CASE
    WHEN p.cost_type = 'SUBCONTRACT' THEN NULL  -- resolved off v_service_line detail instead
    ELSE COALESCE(
      (SELECT m.work_package FROM cost_element_work_package m
        WHERE m.cost_element_code = p.cost_element_code),
      CASE WHEN p.cost_type <> 'MATERIAL' THEN 'INDIRECT' ELSE NULL END)
  END AS work_package
FROM (
  SELECT
    f.actual_id, f.import_batch_id, f.line_uid, b.data_date, b.report_definition_id,
    p.project_key, p.project_code, p.project_name,
    w.wbs_key, w.wbs_code, w.wbs_name, w.wbs_path, w.wbs_level,
    w.discipline, w.package, w.control_account,
    ce.cost_element_key, ce.cost_element_code, ce.cost_element_name,
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

CREATE VIEW v_budget AS
SELECT
  f.budget_id, f.import_batch_id, b.data_date,
  s.scenario_key, s.scenario_code, s.scenario_name, s.version_no, s.is_current, s.is_baseline,
  p.project_key, p.project_code, p.project_name,
  w.wbs_key, w.wbs_code, w.wbs_name, w.wbs_path, w.discipline, w.package,
  ce.cost_element_key, ce.cost_element_code, ce.cost_element_name, ce.cost_type,
  f.work_package,
  f.period_key, f.budget_quantity, f.uom, f.unit_rate, f.budget_amount
FROM fact_budget f
JOIN import_batch b ON b.import_batch_id = f.import_batch_id
JOIN dim_scenario s ON s.scenario_key = f.scenario_key
JOIN dim_project p  ON p.project_key = f.project_key
LEFT JOIN dim_wbs w ON w.wbs_key = f.wbs_key
LEFT JOIN dim_cost_element ce ON ce.cost_element_key = f.cost_element_key
WHERE b.status = 'POSTED';

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
    WHERE m.service_code = COALESCE(f.service_code,'')
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
