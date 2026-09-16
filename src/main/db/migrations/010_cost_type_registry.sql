-- =============================================================================
-- Cost type becomes data, not a CHECK constraint.
--
-- The six cost types were pinned into dim_cost_element and cost_type_rule by a
-- CHECK constraint, so adding one meant a migration — the same problem module
-- CHECK constraints had before module_type (see 003_sap_reality). The user
-- needs to add and rename cost types from the Allocate cost types screen
-- itself, so the six become seed rows in dim_cost_type, an ordinary table, and
-- two more are seeded alongside them: Asset Depreciation and Revenue.
--
-- dim_cost_type also carries the icon and colour the allocation picker uses,
-- so a renamed or newly added type shows up with its own look with no code
-- change — that used to live in a hard-coded map in Settings.tsx.
--
-- This migration rebuilds dim_cost_element and cost_type_rule, so it manages
-- its own transaction (see MIGRATIONS in src/main/db/index.ts). Every view
-- that joins either table has to be dropped first and recreated after — an
-- ALTER TABLE ... RENAME re-parses every view mid-transaction (see
-- 003_sap_reality), and a view referencing a table that is mid-rebuild cannot
-- be parsed.
-- =============================================================================

PRAGMA foreign_keys = OFF;

BEGIN;

DROP VIEW IF EXISTS v_revenue;
DROP VIEW IF EXISTS v_actual;
DROP VIEW IF EXISTS v_posting;
DROP VIEW IF EXISTS v_budget;
DROP VIEW IF EXISTS v_forecast;
DROP VIEW IF EXISTS v_service_line;
DROP VIEW IF EXISTS v_order_line;

CREATE TABLE dim_cost_type (
  code        TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  icon        TEXT NOT NULL DEFAULT '❓',
  color       TEXT NOT NULL DEFAULT '#9aa5b1',
  sort_order  INTEGER NOT NULL,
  -- The six original types can be renamed and re-iconed like any other, but
  -- not deleted — cost_type_rule's fallback ranges and a lot of history name
  -- them by code, and "OTHER" is the catch-all the resolver falls back to.
  is_system   INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0,1)),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO dim_cost_type (code, label, icon, color, sort_order, is_system) VALUES
  ('LABOR',              'Labor',              '👷', '#e08fd0', 10, 1),
  ('MATERIAL',           'Material',           '📦', '#5ac8fa', 20, 1),
  ('SUBCONTRACT',        'Subcontract',        '🔨', '#f5c15a', 30, 1),
  ('EQUIPMENT',          'Equipment',          '🔧', '#ff9f5a', 40, 1),
  ('INDIRECT',           'Indirect',           '💼', '#7fd9c4', 50, 1),
  ('OTHER',              'Other',              '❓', '#9aa5b1', 60, 1),
  ('ASSET_DEPRECIATION', 'Asset Depreciation', '📉', '#b98ff0', 70, 0),
  ('REVENUE',            'Revenue',            '💰', '#6fcf97', 80, 0);

-- ---------------------------------------------------------------------------
-- dim_cost_element.cost_type — FK to dim_cost_type instead of a CHECK list
-- ---------------------------------------------------------------------------
CREATE TABLE dim_cost_element_new (
  cost_element_key  INTEGER PRIMARY KEY,
  cost_element_code TEXT NOT NULL UNIQUE,
  cost_element_name TEXT NOT NULL,
  cost_type         TEXT REFERENCES dim_cost_type(code),
  cost_category     TEXT,
  gl_account        TEXT,
  is_capex          INTEGER NOT NULL DEFAULT 0,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  posting_nature    TEXT NOT NULL DEFAULT 'COST'
);
INSERT INTO dim_cost_element_new
  (cost_element_key, cost_element_code, cost_element_name, cost_type,
   cost_category, gl_account, is_capex, sort_order, posting_nature)
  SELECT cost_element_key, cost_element_code, cost_element_name, cost_type,
         cost_category, gl_account, is_capex, sort_order, posting_nature
  FROM dim_cost_element;
DROP TABLE dim_cost_element;
ALTER TABLE dim_cost_element_new RENAME TO dim_cost_element;

-- ---------------------------------------------------------------------------
-- cost_type_rule.cost_type — same change
-- ---------------------------------------------------------------------------
CREATE TABLE cost_type_rule_new (
  rule_id            INTEGER PRIMARY KEY,
  priority           INTEGER NOT NULL,
  cost_element_glob  TEXT,
  document_type_glob TEXT,
  cost_type          TEXT NOT NULL REFERENCES dim_cost_type(code),
  note               TEXT,
  is_active          INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO cost_type_rule_new
  (rule_id, priority, cost_element_glob, document_type_glob, cost_type, note, is_active, created_at)
  SELECT rule_id, priority, cost_element_glob, document_type_glob, cost_type, note, is_active, created_at
  FROM cost_type_rule;
DROP TABLE cost_type_rule;
ALTER TABLE cost_type_rule_new RENAME TO cost_type_rule;

CREATE INDEX ix_cost_type_rule_priority ON cost_type_rule(is_active, priority, rule_id);

-- ---------------------------------------------------------------------------
-- Views, unchanged in substance, recreated because the tables underneath were
-- rebuilt.
-- ---------------------------------------------------------------------------
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
  f.period_key, f.budget_quantity, f.uom, f.unit_rate, f.budget_amount
FROM fact_budget f
JOIN import_batch b ON b.import_batch_id = f.import_batch_id
JOIN dim_scenario s ON s.scenario_key = f.scenario_key
JOIN dim_project p  ON p.project_key = f.project_key
LEFT JOIN dim_wbs w ON w.wbs_key = f.wbs_key
LEFT JOIN dim_cost_element ce ON ce.cost_element_key = f.cost_element_key
WHERE b.status = 'POSTED';

CREATE VIEW v_forecast AS
SELECT
  f.forecast_id, f.import_batch_id, b.data_date,
  s.scenario_key, s.scenario_code, s.scenario_name, s.version_no, s.is_current,
  p.project_key, p.project_code, p.project_name,
  w.wbs_key, w.wbs_code, w.wbs_name, w.wbs_path, w.discipline, w.package,
  ce.cost_element_key, ce.cost_element_code, ce.cost_element_name, ce.cost_type,
  f.period_key, f.forecast_amount, f.etc_amount, f.eac_amount, f.committed_amount, f.forecast_method
FROM fact_forecast f
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

CREATE VIEW v_order_line AS
SELECT
  f.order_line_id, f.import_batch_id, b.data_date,
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
  v.vendor_key, v.vendor_code, v.vendor_name,
  f.period_key, f.order_no, f.order_description, f.order_type,
  f.category, f.cost_center_code, f.cost_center_name, f.po_no,
  f.quantity, f.uom, f.amount
FROM fact_order_line f
JOIN import_batch b ON b.import_batch_id = f.import_batch_id
JOIN report_definition rd ON rd.report_definition_id = b.report_definition_id
JOIN dim_project p  ON p.project_key = f.project_key
LEFT JOIN dim_wbs w ON w.wbs_key = f.wbs_key
LEFT JOIN dim_cost_element ce ON ce.cost_element_key = f.cost_element_key
LEFT JOIN dim_vendor v ON v.vendor_key = f.vendor_key
WHERE b.status = 'POSTED';

COMMIT;

PRAGMA foreign_keys = ON;
