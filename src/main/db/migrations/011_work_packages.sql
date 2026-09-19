-- =============================================================================
-- Work packages: a coding layer over actual/budget, not a WBS attribute.
--
-- dim_wbs.package (a free-text field on the WBS master) turned out to be the
-- wrong idea — the real requirement is that every actual cost line gets
-- individually classified into a named work package (masonry, concrete,
-- earthwork, …), the same "resolved in the view, never baked into the
-- dimension" treatment cost_type already gets via cost_type_rule, and for
-- the same reason: a rule change must correct cost already loaded, with no
-- rebuild step. This is a second, parallel resolution system with the
-- identical shape.
--
-- One deliberate difference from cost_type_rule: no source file ever states
-- a work package directly (unlike dim_cost_element.cost_type, which a file
-- can state and which then outranks a rule), so there is no "explicit value
-- wins" branch here — a work package is 100% rule/allocation-derived. A
-- second difference: a rule can match on wbs_glob as well as
-- cost_element_glob, because real work-package coding depends heavily on
-- *where* the cost sits (the same GL can be "concrete" on one WBS and
-- "earthwork" on another) — first match wins, same precedence model as
-- cost_type_rule.
--
-- Work packages carry no seed rows, unlike the six universal cost types —
-- they are entirely project-specific, so the user defines their own list
-- from the allocation screen (Settings > Work packages).
--
-- This migration only adds tables and touches the two views that need the
-- new resolved column (v_posting, v_budget) — it does not rebuild any
-- existing table, so it does not need PRAGMA foreign_keys handling the way
-- 003/010 did.
-- =============================================================================

CREATE TABLE dim_work_package (
  code        TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  icon        TEXT NOT NULL DEFAULT '📦',
  color       TEXT NOT NULL DEFAULT '#9aa5b1',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_system   INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0,1)),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE work_package_rule (
  rule_id           INTEGER PRIMARY KEY,
  priority          INTEGER NOT NULL,
  cost_element_glob TEXT,
  wbs_glob          TEXT,
  work_package      TEXT NOT NULL REFERENCES dim_work_package(code),
  note              TEXT,
  is_active         INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX ix_work_package_rule_priority ON work_package_rule(is_active, priority, rule_id);

DROP VIEW IF EXISTS v_revenue;
DROP VIEW IF EXISTS v_actual;
DROP VIEW IF EXISTS v_posting;
DROP VIEW IF EXISTS v_budget;

CREATE VIEW v_posting AS
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
  (SELECT r.work_package FROM work_package_rule r
    WHERE r.is_active = 1
      AND (r.cost_element_glob IS NULL OR ce.cost_element_code GLOB r.cost_element_glob)
      AND (r.wbs_glob          IS NULL OR w.wbs_code           GLOB r.wbs_glob)
    ORDER BY r.priority, r.rule_id
    LIMIT 1) AS work_package,
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
WHERE b.status = 'POSTED';

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
  (SELECT r.work_package FROM work_package_rule r
    WHERE r.is_active = 1
      AND (r.cost_element_glob IS NULL OR ce.cost_element_code GLOB r.cost_element_glob)
      AND (r.wbs_glob          IS NULL OR w.wbs_code           GLOB r.wbs_glob)
    ORDER BY r.priority, r.rule_id
    LIMIT 1) AS work_package,
  f.period_key, f.budget_quantity, f.uom, f.unit_rate, f.budget_amount
FROM fact_budget f
JOIN import_batch b ON b.import_batch_id = f.import_batch_id
JOIN dim_scenario s ON s.scenario_key = f.scenario_key
JOIN dim_project p  ON p.project_key = f.project_key
LEFT JOIN dim_wbs w ON w.wbs_key = f.wbs_key
LEFT JOIN dim_cost_element ce ON ce.cost_element_key = f.cost_element_key
WHERE b.status = 'POSTED';
